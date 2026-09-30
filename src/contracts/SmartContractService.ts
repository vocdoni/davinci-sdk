import {
  BaseWallet,
  keccak256,
  type Interface,
  type BaseContract,
  type Contract,
  type ContractEventName,
  type EventFilter,
  type Provider,
  type Signer,
  type TransactionReceipt,
  type TransactionRequest,
  type TransactionResponse,
} from 'ethers';
import { type DavinciErrorDescription, decodeDavinciError } from './abis';
import type { ContractServiceError } from './errors';

/**
 * Enum representing the possible states of a transaction during its lifecycle.
 * Used to track and report transaction status in the event stream.
 */
export enum TxStatus {
  /** Transaction has been submitted and is waiting to be mined */
  Pending = 'pending',
  /** Transaction has been successfully mined and executed */
  Completed = 'completed',
  /** Transaction was mined but reverted during execution */
  Reverted = 'reverted',
  /** Transaction failed before or during submission */
  Failed = 'failed',
}

/**
 * Union type representing the different events that can occur during a transaction's lifecycle.
 * Each event includes relevant data based on the transaction status.
 *
 * @template T - The type of the successful response data
 */
export type TxStatusEvent<T = unknown> =
  | {
      status: TxStatus.Pending;
      hash: string;
      /**
       * Which transaction this is, in a stream that sends a follow-up one
       * (`setProcessGrace` after a creation with `grace`); absent for the
       * stream's main transaction.
       */
      step?: string;
    }
  | { status: TxStatus.Completed; response: T }
  | { status: TxStatus.Reverted; reason?: string; error?: Error }
  | { status: TxStatus.Failed; error: Error };

/** Default wait for a transaction receipt. */
export const RECEIPT_TIMEOUT_MS = 180_000;

// A send refused because the nonce is taken: by an earlier copy of the same
// transaction (geth "already known", anvil/reth "already imported",
// Nethermind "AlreadyKnown", Besu "Known transaction") or by a mined one.
const REFUSED_RESEND = [
  'nonce too low',
  'already known',
  'already imported',
  'alreadyknown',
  'known transaction',
];

// The messages of an error and of the errors it wraps (ethers nests the
// node's answer under `error`, `info.error` or `cause`).
function errorTexts(err: unknown): string[] {
  const out: string[] = [];
  let e: unknown = err;
  for (let depth = 0; depth < 5 && typeof e === 'object' && e !== null; depth++) {
    const o = e as { message?: unknown; shortMessage?: unknown; code?: unknown };
    for (const v of [o.message, o.shortMessage, o.code]) {
      if (typeof v === 'string') out.push(v);
    }
    const next = e as { error?: unknown; info?: { error?: unknown }; cause?: unknown };
    e = next.error ?? next.info?.error ?? next.cause;
  }
  return out;
}

function isRefusedResend(err: unknown): boolean {
  const text = errorTexts(err).join(' ').toLowerCase();
  return text.includes('nonce_expired') || REFUSED_RESEND.some(p => text.includes(p));
}

/**
 * The revert data of a failed call, wherever the provider put it (ethers
 * `data`, or the node's answer nested under `error`, `info.error` or `cause`).
 */
export function revertData(err: unknown): string | null {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && typeof e === 'object' && e !== null; depth++) {
    const o = e as { data?: unknown; error?: unknown; info?: { error?: unknown }; cause?: unknown };
    const data =
      typeof o.data === 'object' && o.data !== null ? (o.data as { data?: unknown }).data : o.data;
    if (typeof data === 'string' && /^0x([0-9a-fA-F]{2}){4,}$/.test(data)) return data;
    e = o.error ?? o.info?.error ?? o.cause;
  }
  return null;
}

/**
 * The custom error a failed call reverted with: one of `contract`'s own
 * errors when given, else a DAVINCI error (registry, DKG adapter, DKG or
 * verifier, merged as the registry bubbles them up).
 */
export function decodeRevert(err: unknown, contract?: Interface): DavinciErrorDescription | null {
  const data = revertData(err);
  if (!data) return null;
  if (contract) {
    try {
      const e = contract.parseError(data);
      if (e) return { name: e.name, signature: e.signature, selector: e.selector, args: e.args };
    } catch {
      // Not one of the contract's errors.
    }
  }
  return decodeDavinciError(data);
}

/** Builds the typed error of one operation. */
export type ContractErrorFactory = (
  message: string,
  revert?: DavinciErrorDescription,
  cause?: unknown
) => ContractServiceError;

/** A registry write: the method, its arguments and what to make of the receipt. */
export interface ContractWrite<T> {
  contract: Contract;
  method: string;
  /** Builds the arguments when the stream starts; a throw fails the stream. */
  args: () => readonly unknown[];
  error: ContractErrorFactory;
  onReceipt: (receipt: TransactionReceipt) => T | Promise<T>;
}

/**
 * Abstract base class providing common functionality for smart contract interactions.
 * Implements transaction handling, status monitoring, event normalization, and
 * event listener management with automatic fallback for RPCs that don't support eth_newFilter.
 */
export abstract class SmartContractService {
  /** Active polling intervals for event listeners using fallback mode */
  private pollingIntervals: NodeJS.Timeout[] = [];
  /** Default polling interval in milliseconds for event listener fallback */
  protected eventPollingInterval: number = 5000;
  /** Longest wait for a transaction receipt, in milliseconds. */
  protected receiptTimeoutMs: number = RECEIPT_TIMEOUT_MS;

  /**
   * Simulates a write, sends it and waits for its receipt, yielding status
   * events. Nothing happens until the stream is iterated.
   *
   * - The call is simulated first (`staticCall` from the signer), so a revert
   *   fails the stream with the operation's error and the decoded custom error
   *   before anything is signed.
   * - A local wallet (ethers `Wallet`) signs before sending, so the
   *   transaction hash is known. If the node refuses the broadcast as a known
   *   transaction or a used nonce (an RPC retry resending a transaction that
   *   already went in) and the chain has that hash, the transaction counts as
   *   sent. Other signers (browser wallets) send it themselves.
   * - A mined revert is named by replaying the call on the latest state and
   *   comes as a `Reverted` event whose `error` carries the decoded error.
   */
  protected async *sendContractTx<T>(
    write: ContractWrite<T>
  ): AsyncGenerator<TxStatusEvent<T>, void, unknown> {
    const { contract, method, args, error } = write;
    const signer = contract.runner as Signer | null;
    if (!signer || typeof signer.sendTransaction !== 'function' || !signer.provider) {
      yield {
        status: TxStatus.Failed,
        error: error(`${method}: a signer connected to a provider is required`),
      };
      return;
    }
    const fn = contract.getFunction(method);
    let request: TransactionRequest;
    try {
      const built = args();
      await fn.staticCall(...built);
      request = await fn.populateTransaction(...built);
    } catch (err) {
      yield { status: TxStatus.Failed, error: this.callError(error, method, err, contract) };
      return;
    }

    let response: TransactionResponse;
    try {
      response = await this.broadcast(signer, request);
    } catch (err) {
      yield { status: TxStatus.Failed, error: this.callError(error, method, err, contract) };
      return;
    }
    yield { status: TxStatus.Pending, hash: response.hash };

    let receipt: TransactionReceipt;
    try {
      receipt = await this.mined(response);
    } catch (err) {
      yield { status: TxStatus.Failed, error: this.callError(error, method, err, contract) };
      return;
    }
    if (receipt.status === 0) {
      const revert = await this.replayRevert(
        signer.provider,
        { from: receipt.from, to: request.to, data: request.data, value: request.value },
        contract
      );
      const reason = revert?.name ?? 'Transaction reverted.';
      yield {
        status: TxStatus.Reverted,
        reason,
        error: error(`${method} reverted: ${reason}`, revert ?? undefined),
      };
      return;
    }
    try {
      yield { status: TxStatus.Completed, response: await write.onReceipt(receipt) };
    } catch (err) {
      yield {
        status: TxStatus.Failed,
        error: err instanceof Error ? err : error(`${method}: ${String(err)}`),
      };
    }
  }

  // The operation's error for a failed call, with its custom error decoded.
  private callError(
    error: ContractErrorFactory,
    method: string,
    err: unknown,
    contract: Contract
  ): Error {
    const revert = decodeRevert(err, contract.interface);
    if (revert) return error(`${method} reverted: ${revert.name}`, revert, err);
    const o = err as { shortMessage?: unknown; message?: unknown };
    const text =
      typeof o?.shortMessage === 'string'
        ? o.shortMessage
        : typeof o?.message === 'string'
          ? o.message
          : String(err);
    return error(`${method}: ${text}`, undefined, err);
  }

  // Signs first when the signer is a local wallet, so a refused resend of a
  // transaction the chain already has is recognized by its hash.
  private async broadcast(signer: Signer, tx: TransactionRequest): Promise<TransactionResponse> {
    const provider = signer.provider as Provider;
    if (!(signer instanceof BaseWallet)) return signer.sendTransaction(tx);
    const raw = await signer.signTransaction(await signer.populateTransaction(tx));
    const hash = keccak256(raw);
    try {
      return await provider.broadcastTransaction(raw);
    } catch (err) {
      if (isRefusedResend(err)) {
        const known = await provider.getTransaction(hash).catch(() => null);
        if (known) return known;
      }
      throw err;
    }
  }

  // Waits for the receipt, returning it for a mined revert too. A repriced
  // replacement (same call, new fee) stands in for the original.
  private async mined(response: TransactionResponse): Promise<TransactionReceipt> {
    try {
      const receipt = await response.wait(1, this.receiptTimeoutMs);
      if (!receipt) throw new Error(`transaction ${response.hash} was not mined`);
      return receipt;
    } catch (err) {
      const e = err as { code?: unknown; receipt?: TransactionReceipt | null; cancelled?: unknown };
      if (e.code === 'CALL_EXCEPTION' && e.receipt) return e.receipt;
      if (e.code === 'TRANSACTION_REPLACED' && e.cancelled === false && e.receipt) return e.receipt;
      throw err;
    }
  }

  // Names a mined revert by replaying the call on the latest state (a lost
  // race replays the same way); null when the replay passes or says nothing.
  private async replayRevert(
    provider: Provider,
    tx: TransactionRequest,
    contract: Contract
  ): Promise<DavinciErrorDescription | null> {
    try {
      await provider.call(tx);
      return null;
    } catch (err) {
      return decodeRevert(err, contract.interface);
    }
  }
  /**
   * Executes a transaction stream and returns the result or throws an error.
   * This is a convenience method that processes a transaction stream and either
   * returns the successful result or throws an appropriate error.
   *
   * @template T - The type of the successful response data
   * @param stream - AsyncGenerator of transaction status events
   * @returns Promise resolving to the successful response data
   * @throws Error if the transaction fails or reverts
   *
   * @example
   * ```typescript
   * try {
   *   const result = await SmartContractService.executeTx(
   *     contract.someMethod()
   *   );
   *   console.log('Transaction successful:', result);
   * } catch (error) {
   *   console.error('Transaction failed:', error);
   * }
   * ```
   */
  static async executeTx<T>(stream: AsyncGenerator<TxStatusEvent<T>>): Promise<T> {
    for await (const event of stream) {
      switch (event.status) {
        case TxStatus.Completed:
          return event.response;
        case TxStatus.Failed:
          throw event.error;
        case TxStatus.Reverted:
          throw (
            event.error ?? new Error(`Transaction reverted: ${event.reason || 'unknown reason'}`)
          );
      }
    }
    throw new Error('Transaction stream ended unexpectedly');
  }

  /**
   * Normalizes event listener arguments between different ethers.js versions.
   * This helper method ensures consistent event argument handling regardless of
   * whether the event payload follows ethers v5 or v6 format.
   *
   * @template Args - Tuple type representing the expected event arguments
   * @param callback - The event callback function to normalize
   * @returns Normalized event listener function
   *
   * @example
   * ```typescript
   * contract.on('Transfer', this.normalizeListener((from: string, to: string, amount: BigInt) => {
   *   console.log(`Transfer from ${from} to ${to}: ${amount}`);
   * }));
   * ```
   */
  protected normalizeListener<Args extends unknown[]>(
    callback: (...args: Args) => void
  ): (...listenerArgs: unknown[]) => void {
    return (...listenerArgs: unknown[]) => {
      const first = listenerArgs[0] as { args?: unknown[] } | undefined;
      const args = listenerArgs.length === 1 && first?.args ? first.args : listenerArgs;
      callback(...(args as Args));
    };
  }

  /**
   * Sets up an event listener with automatic fallback for RPCs that don't support eth_newFilter.
   * First attempts to use contract.on() which relies on eth_newFilter. If the RPC doesn't support
   * this method (error code -32601), automatically falls back to polling with queryFilter.
   *
   * @template Args - Tuple type representing the event arguments
   * @param contract - The contract instance to listen to
   * @param eventFilter - The event filter to listen for
   * @param callback - The callback function to invoke when the event occurs
   *
   * @example
   * ```typescript
   * this.setupEventListener(
   *   this.contract,
   *   'Transfer',
   *   (from: string, to: string, amount: bigint) => {
   *     console.log(`Transfer: ${from} -> ${to}: ${amount}`);
   *   }
   * );
   * ```
   */
  protected async setupEventListener<Args extends unknown[]>(
    contract: BaseContract,
    eventFilter: ContractEventName | EventFilter,
    callback: (...args: Args) => void
  ): Promise<void> {
    const normalizedCallback = this.normalizeListener(callback);

    // First, test if eth_newFilter is supported by trying to create a filter
    const provider = contract.runner?.provider as
      | (Provider & { send?: (method: string, params: unknown[]) => Promise<unknown> })
      | undefined;
    if (!provider) {
      console.warn('No provider available for event listeners');
      return;
    }

    try {
      // Test if the provider supports eth_newFilter
      // We do this by attempting to get logs with a filter
      // If it fails, we'll catch the error and use polling
      const testFilter = {
        address: await contract.getAddress(),
        topics: [],
      };

      // Try to create a filter - this will fail if eth_newFilter is not supported
      // We use the provider's internal method if available
      if (typeof provider.send === 'function') {
        try {
          // Test both creating the filter AND getting changes to ensure full support
          const filterId = await provider.send('eth_newFilter', [testFilter]);

          // Try to get filter changes - this will fail if RPC doesn't maintain filters
          await provider.send('eth_getFilterChanges', [filterId]);

          // If we get here, both eth_newFilter and eth_getFilterChanges work
          await contract.on(eventFilter as ContractEventName, normalizedCallback);
          return;
        } catch (error) {
          if (this.isUnsupportedMethodError(error)) {
            // eth_newFilter or eth_getFilterChanges not working, use polling
            console.warn(
              'RPC does not fully support eth_newFilter/eth_getFilterChanges, falling back to polling for events. ' +
                'This may result in delayed event notifications.'
            );
            this.setupPollingListener(contract, eventFilter, callback);
            return;
          }
          // Any other probe error: use polling to avoid runtime listener crashes
          console.warn(
            'Could not verify RPC filter support, falling back to polling for events. ' +
              'This may result in delayed event notifications.'
          );
          this.setupPollingListener(contract, eventFilter, callback);
          return;
        }
      }

      // Default: set up contract listener directly
      await contract.on(eventFilter as ContractEventName, normalizedCallback);
    } catch (error) {
      // Fallback to polling on any setup error
      console.warn(
        'Error setting up event listener, falling back to polling:',
        error instanceof Error ? error.message : error
      );
      this.setupPollingListener(contract, eventFilter, callback);
    }
  }

  /**
   * Checks if an error indicates that the RPC method is unsupported or filter operations are not working.
   * This includes:
   * - Method not found (-32601): RPC doesn't support eth_newFilter
   * - Filter not found (-32000): RPC doesn't properly maintain filters
   *
   * @param error - The error to check
   * @returns true if the error indicates unsupported or broken filter functionality
   */
  private isUnsupportedMethodError(error: unknown): boolean {
    type RpcError = { code?: unknown; message?: unknown };
    const e = (error ?? {}) as RpcError & { error?: RpcError; data?: RpcError };
    const includes = (m: unknown, what: string) => typeof m === 'string' && m.includes(what);

    // Check for error code -32601 (method not found) - RPC doesn't support eth_newFilter
    const isMethodNotFound =
      e.code === -32601 ||
      e.error?.code === -32601 ||
      e.data?.code === -32601 ||
      includes(e.message, 'unsupported method');

    // Check for error code -32000 with "filter not found" - RPC supports creating filters but doesn't maintain them
    const isFilterNotFound =
      (e.code === -32000 ||
        e.error?.code === -32000 ||
        (e.code === 'UNKNOWN_ERROR' && e.error?.code === -32000)) &&
      (includes(e.message, 'filter not found') || includes(e.error?.message, 'filter not found'));

    return isMethodNotFound || isFilterNotFound;
  }

  /**
   * Sets up a polling-based event listener as fallback when eth_newFilter is not supported.
   * Periodically queries for new events and invokes the callback for each new event found.
   *
   * @template Args - Tuple type representing the event arguments
   * @param contract - The contract instance to poll
   * @param eventFilter - The event filter to poll for
   * @param callback - The callback function to invoke for each event
   */
  private setupPollingListener<Args extends unknown[]>(
    contract: BaseContract,
    eventFilter: ContractEventName | EventFilter,
    callback: (...args: Args) => void
  ): void {
    let lastProcessedBlock = 0;

    const poll = async () => {
      try {
        const provider = contract.runner?.provider as Provider | undefined;
        if (!provider) {
          console.warn('No provider available for polling events');
          return;
        }

        // Get current block number
        const currentBlock = await provider.getBlockNumber();

        // Initialize lastProcessedBlock on first poll
        if (lastProcessedBlock === 0) {
          lastProcessedBlock = currentBlock - 1;
        }

        // Query for events since last processed block
        if (currentBlock > lastProcessedBlock) {
          const events = await contract.queryFilter(
            eventFilter as ContractEventName,
            lastProcessedBlock + 1,
            currentBlock
          );

          // Process each event - filter to only EventLog types that have args
          for (const event of events) {
            if ('args' in event && event.args) {
              callback(...(event.args as unknown as Args));
            }
          }

          lastProcessedBlock = currentBlock;
        }
      } catch (error) {
        console.error('Error polling for events:', error);
      }
    };

    // Start polling
    const intervalId = setInterval(() => void poll(), this.eventPollingInterval);
    this.pollingIntervals.push(intervalId);

    // Do an initial poll
    void poll();
  }

  /**
   * Clears all active polling intervals.
   * Should be called when removing all listeners or cleaning up the service.
   */
  protected clearPollingIntervals(): void {
    for (const intervalId of this.pollingIntervals) {
      clearInterval(intervalId);
    }
    this.pollingIntervals = [];
  }

  /**
   * Sets the polling interval for event listeners using the fallback mechanism.
   *
   * @param intervalMs - Polling interval in milliseconds
   */
  setEventPollingInterval(intervalMs: number): void {
    this.eventPollingInterval = intervalMs;
  }
}
