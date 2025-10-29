import type {
  ContractTransactionResponse,
  BaseContract,
  EventFilter,
  Provider,
  ContractEventName,
} from 'ethers';

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
export type TxStatusEvent<T = any> =
  | { status: TxStatus.Pending; hash: string }
  | { status: TxStatus.Completed; response: T }
  | { status: TxStatus.Reverted; reason?: string }
  | { status: TxStatus.Failed; error: Error };

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
  /**
   * Sends a transaction and yields status events during its lifecycle.
   * This method handles the complete transaction flow from submission to completion,
   * including error handling and status updates.
   *
   * @template T - The type of the successful response data
   * @param txPromise - Promise resolving to the transaction response
   * @param responseHandler - Function to process the successful transaction result
   * @returns AsyncGenerator yielding transaction status events
   *
   * @example
   * ```typescript
   * const txStream = await this.sendTx(
   *   contract.someMethod(),
   *   async () => await contract.getUpdatedValue()
   * );
   *
   * for await (const event of txStream) {
   *   switch (event.status) {
   *     case TxStatus.Pending:
   *       console.log(`Transaction pending: ${event.hash}`);
   *       break;
   *     case TxStatus.Completed:
   *       console.log(`Transaction completed:`, event.response);
   *       break;
   *   }
   * }
   * ```
   */
  protected async *sendTx<T>(
    txPromise: Promise<ContractTransactionResponse>,
    responseHandler: () => Promise<T>
  ): AsyncGenerator<TxStatusEvent<T>, void, unknown> {
    try {
      const tx = await txPromise;
      yield { status: TxStatus.Pending, hash: tx.hash };

      const receipt = await tx.wait();

      if (!receipt) {
        yield { status: TxStatus.Reverted, reason: 'Transaction was dropped or not mined.' };
      } else if (receipt.status === 0) {
        yield { status: TxStatus.Reverted, reason: 'Transaction reverted.' };
      } else {
        const result = await responseHandler();
        yield { status: TxStatus.Completed, response: result };
      }
    } catch (err: any) {
      yield {
        status: TxStatus.Failed,
        error: err instanceof Error ? err : new Error('Unknown transaction error'),
      };
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
          throw new Error(`Transaction reverted: ${event.reason || 'unknown reason'}`);
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
  protected normalizeListener<Args extends any[]>(
    callback: (...args: Args) => void
  ): (...listenerArgs: any[]) => void {
    return (...listenerArgs: any[]) => {
      let args: any[];
      if (listenerArgs.length === 1 && listenerArgs[0]?.args) {
        args = listenerArgs[0].args;
      } else {
        args = listenerArgs;
      }
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
   *   this.contract.filters.Transfer(),
   *   (from: string, to: string, amount: bigint) => {
   *     console.log(`Transfer: ${from} -> ${to}: ${amount}`);
   *   }
   * );
   * ```
   */
  protected async setupEventListener<Args extends any[]>(
    contract: BaseContract,
    eventFilter: ContractEventName | EventFilter,
    callback: (...args: Args) => void
  ): Promise<void> {
    const normalizedCallback = this.normalizeListener(callback);

    // First, test if eth_newFilter is supported by trying to create a filter
    const provider = contract.runner?.provider as Provider | undefined;
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
      if ('send' in provider && typeof provider.send === 'function') {
        try {
          // Test both creating the filter AND getting changes to ensure full support
          const filterId = await provider.send('eth_newFilter', [testFilter]);
          
          // Try to get filter changes - this will fail if RPC doesn't maintain filters
          await provider.send('eth_getFilterChanges', [filterId]);
          
          // If we get here, both eth_newFilter and eth_getFilterChanges work
          contract.on(eventFilter as ContractEventName, normalizedCallback);
          return;
        } catch (error: any) {
          if (this.isUnsupportedMethodError(error)) {
            // eth_newFilter or eth_getFilterChanges not working, use polling
            console.warn(
              'RPC does not fully support eth_newFilter/eth_getFilterChanges, falling back to polling for events. ' +
                'This may result in delayed event notifications.'
            );
            this.setupPollingListener(contract, eventFilter, callback);
            return;
          }
          // Other error, try normal approach
        }
      }

      // Default: try to use contract.on()
      // Set up an error handler to catch async errors
      const errorHandler = (error: any) => {
        if (this.isUnsupportedMethodError(error)) {
          // Remove the failing listener
          contract.off(eventFilter as ContractEventName, normalizedCallback);
          contract.off('error', errorHandler);

          console.warn(
            'RPC does not support eth_newFilter, falling back to polling for events. ' +
              'This may result in delayed event notifications.'
          );
          this.setupPollingListener(contract, eventFilter, callback);
        }
      };

      // Listen for errors
      contract.once('error', errorHandler);

      // Set up the listener
      contract.on(eventFilter as ContractEventName, normalizedCallback);
    } catch (error: any) {
      // Fallback to polling on any setup error
      console.warn('Error setting up event listener, falling back to polling:', error.message);
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
  private isUnsupportedMethodError(error: any): boolean {
    // Check for error code -32601 (method not found) - RPC doesn't support eth_newFilter
    const isMethodNotFound =
      error?.code === -32601 ||
      error?.error?.code === -32601 ||
      error?.data?.code === -32601 ||
      (typeof error?.message === 'string' && error.message.includes('unsupported method'));

    // Check for error code -32000 with "filter not found" - RPC supports creating filters but doesn't maintain them
    const isFilterNotFound =
      ((error?.code === -32000 || error?.error?.code === -32000 || (error?.code === 'UNKNOWN_ERROR' && error?.error?.code === -32000)) &&
       (error?.message?.includes('filter not found') || error?.error?.message?.includes('filter not found')));

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
  private setupPollingListener<Args extends any[]>(
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
              callback(...(event.args as any as Args));
            }
          }

          lastProcessedBlock = currentBlock;
        }
      } catch (error) {
        console.error('Error polling for events:', error);
      }
    };

    // Start polling
    const intervalId = setInterval(poll, this.eventPollingInterval);
    this.pollingIntervals.push(intervalId);

    // Do an initial poll
    poll();
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
