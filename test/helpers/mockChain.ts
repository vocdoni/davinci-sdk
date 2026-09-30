import {
  Interface,
  JsonRpcProvider,
  Network,
  Transaction,
  ZeroAddress,
  ZeroHash,
  toQuantity,
  type InterfaceAbi,
  type JsonRpcError,
  type JsonRpcPayload,
  type JsonRpcResult,
  type Result,
} from 'ethers';

/** A call handler's answer that reverts with this data. */
export class Revert {
  constructor(readonly data: string) {}
}

/** Revert data of the custom error `name` of `abi`. */
export function revertWith(abi: InterfaceAbi, name: string, args: unknown[] = []): Revert {
  return new Revert(new Interface(abi).encodeErrorResult(name, args));
}

/** Answers a contract call: the return values, or a revert. */
export type CallHandler = (args: Result, from: string | null) => unknown[] | Revert;

/** What mining a transaction produced. */
export interface Mined {
  status: 0 | 1;
  logs?: { address: string; topics: readonly string[]; data: string }[];
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: string
  ) {
    super(message);
  }
}

const BLOCK_HASH = `0x${'bb'.repeat(32)}`;

/**
 * A JSON-RPC node in memory behind a real ethers `JsonRpcProvider`: contract
 * calls go to handlers, broadcasts are mined at once, and every request is
 * recorded.
 */
export class MockChain extends JsonRpcProvider {
  readonly requests: JsonRpcPayload[] = [];
  /** Transactions the node took, in order. */
  readonly sent: Transaction[] = [];
  /** Unix time of the head block. */
  headTime = 1_700_000_000;
  /** Answers the next broadcast with this error; `keep` still takes the transaction. */
  broadcastError?: { message: string; keep: boolean };
  /** Receipt of a mined transaction. */
  onMine: (tx: Transaction) => Mined = () => ({ status: 1 });
  /** Logs `eth_getLogs` answers. */
  logs: { address: string; topics: string[]; data: string }[] = [];

  private readonly contracts = new Map<
    string,
    { iface: Interface; calls: Record<string, CallHandler> }
  >();
  private readonly code = new Map<string, string>();
  private readonly known = new Map<string, { tx: Transaction; mined: Mined }>();

  constructor(readonly chainId = 100n) {
    const network = Network.from(chainId);
    // No request cache: tests move the chain between identical requests.
    super('http://mock.invalid', network, {
      staticNetwork: network,
      batchMaxCount: 1,
      cacheTimeout: -1,
    });
  }

  /** Serves `calls` at `address` with `abi`. */
  contract(address: string, abi: InterfaceAbi, calls: Record<string, CallHandler>): void {
    this.contracts.set(address.toLowerCase(), { iface: new Interface(abi), calls });
    this.code.set(address.toLowerCase(), this.code.get(address.toLowerCase()) ?? '0x00');
  }

  /** Runtime code at `address`. */
  setCode(address: string, code: string): void {
    this.code.set(address.toLowerCase(), code);
  }

  /** Requests of one method. */
  calls(method: string): JsonRpcPayload[] {
    return this.requests.filter(r => r.method === method);
  }

  // Errors travel in the same array as results (ethers types it as results only).
  _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const list = Array.isArray(payload) ? payload : [payload];
    return Promise.resolve(list.map(p => this.answer(p)) as JsonRpcResult[]);
  }

  private answer(p: JsonRpcPayload): JsonRpcResult | JsonRpcError {
    this.requests.push(p);
    try {
      return { id: p.id, result: this.handle(p.method, (p.params ?? []) as unknown[]) };
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      return {
        id: p.id,
        error: { code: e.code, message: e.message, ...(e.data && { data: e.data }) },
      };
    }
  }

  private handle(method: string, params: unknown[]): unknown {
    switch (method) {
      case 'eth_chainId':
        return toQuantity(this.chainId);
      case 'eth_blockNumber':
        return '0x10';
      case 'eth_getBlockByNumber':
        return {
          number: '0x10',
          hash: BLOCK_HASH,
          parentHash: ZeroHash,
          timestamp: toQuantity(this.headTime),
          nonce: '0x0000000000000000',
          difficulty: '0x0',
          gasLimit: '0x1c9c380',
          gasUsed: '0x0',
          miner: ZeroAddress,
          extraData: '0x',
          baseFeePerGas: '0x1',
          transactions: [],
        };
      case 'eth_gasPrice':
      case 'eth_maxPriorityFeePerGas':
        return '0x1';
      case 'eth_getTransactionCount':
        return toQuantity(this.sent.length);
      case 'eth_estimateGas':
        this.dispatch(params[0] as { to: string; data: string; from?: string });
        return '0x30000';
      case 'eth_call':
        return this.dispatch(params[0] as { to: string; data: string; from?: string });
      case 'eth_getCode':
        return this.code.get(String(params[0]).toLowerCase()) ?? '0x';
      case 'eth_sendRawTransaction':
        return this.broadcast(String(params[0]));
      case 'eth_getTransactionByHash':
        return this.txJson(String(params[0]));
      case 'eth_getTransactionReceipt':
        return this.receiptJson(String(params[0]));
      case 'eth_getLogs':
        return this.logs.map((l, i) => this.logJson(l, i, `0x${'cc'.repeat(32)}`));
      default:
        throw new RpcError(-32601, `method ${method} not found`);
    }
  }

  private dispatch(tx: { to: string; data: string; from?: string }): string {
    const c = this.contracts.get(tx.to.toLowerCase());
    if (!c) return '0x';
    const parsed = c.iface.parseTransaction({ data: tx.data });
    if (!parsed) throw new RpcError(3, 'execution reverted', '0x');
    const handler = c.calls[parsed.name];
    if (!handler) throw new Error(`no handler for ${parsed.name}`);
    const out = handler(parsed.args, tx.from ?? null);
    if (out instanceof Revert) throw new RpcError(3, 'execution reverted', out.data);
    return c.iface.encodeFunctionResult(parsed.fragment, out);
  }

  private broadcast(raw: string): string {
    const tx = Transaction.from(raw);
    const hash = tx.hash as string;
    const refused = this.broadcastError;
    if (refused) {
      this.broadcastError = undefined;
      if (refused.keep) this.take(hash, tx);
      throw new RpcError(-32000, refused.message);
    }
    this.take(hash, tx);
    return hash;
  }

  private take(hash: string, tx: Transaction): void {
    this.sent.push(tx);
    this.known.set(hash, { tx, mined: this.onMine(tx) });
  }

  private txJson(hash: string): unknown {
    const k = this.known.get(hash);
    if (!k) return null;
    const { tx } = k;
    const sig = tx.signature;
    if (!sig) throw new Error('unsigned transaction');
    return {
      hash,
      type: '0x2',
      from: tx.from,
      to: tx.to,
      nonce: toQuantity(tx.nonce),
      gas: toQuantity(tx.gasLimit),
      maxFeePerGas: toQuantity(tx.maxFeePerGas ?? 0n),
      maxPriorityFeePerGas: toQuantity(tx.maxPriorityFeePerGas ?? 0n),
      value: toQuantity(tx.value),
      input: tx.data,
      chainId: toQuantity(tx.chainId),
      accessList: [],
      v: toQuantity(sig.yParity),
      yParity: toQuantity(sig.yParity),
      r: sig.r,
      s: sig.s,
      blockHash: null,
      blockNumber: null,
      transactionIndex: null,
    };
  }

  private logJson(
    l: { address: string; topics: readonly string[]; data: string },
    i: number,
    txHash: string
  ): unknown {
    return {
      address: l.address,
      topics: l.topics,
      data: l.data,
      blockNumber: '0x11',
      blockHash: BLOCK_HASH,
      transactionHash: txHash,
      transactionIndex: '0x0',
      logIndex: toQuantity(i),
      removed: false,
    };
  }

  private receiptJson(hash: string): unknown {
    const k = this.known.get(hash);
    if (!k) return null;
    return {
      transactionHash: hash,
      transactionIndex: '0x0',
      blockHash: BLOCK_HASH,
      blockNumber: '0x11',
      from: k.tx.from,
      to: k.tx.to,
      contractAddress: null,
      cumulativeGasUsed: '0x5208',
      gasUsed: '0x5208',
      effectiveGasPrice: '0x1',
      logsBloom: `0x${'00'.repeat(256)}`,
      status: k.mined.status ? '0x1' : '0x0',
      type: '0x2',
      logs: (k.mined.logs ?? []).map((l, i) => this.logJson(l, i, hash)),
    };
  }
}
