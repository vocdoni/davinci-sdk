import {
  FetchRequest,
  JsonRpcProvider,
  Network,
  getAddress,
  keccak256,
  solidityPacked,
  type JsonRpcError,
  type JsonRpcPayload,
  type JsonRpcResult,
} from 'ethers';
import { isNode } from './core/runtime';

/**
 * A DAVINCI deployment: the chain and its `ProcessRegistry`. Sequencer node
 * URLs are never part of a network; they are always configuration.
 */
export interface DavinciNetwork {
  /** Lowercase name, e.g. `gnosis`. */
  name: string;
  chainId: number;
  /** `ProcessRegistry` address. */
  processRegistry: string;
  /** Block the registry was deployed at: where log scans start. */
  startBlock: number;
  /** Public execution-layer JSON-RPCs, in order of preference. */
  rpcUrls: readonly string[];
  /** Beacon APIs serving the chain's blobs. */
  beaconUrls: readonly string[];
  /** Blocks behind head treated as final. */
  confirmations: number;
}

/**
 * Gnosis Chain, as in davinci-sequencer `client/src/networks.rs`. The DKG
 * adapter, the verifier and the grace window settings are read from the
 * registry, not pinned here.
 */
export const GNOSIS: DavinciNetwork = Object.freeze({
  name: 'gnosis',
  chainId: 100,
  processRegistry: '0x6702e0141B6b72bCF8C1bdff20A82A35C5502E7D',
  startBlock: 48_504_090,
  rpcUrls: Object.freeze([
    'https://gnosis-rpc.publicnode.com',
    'https://gnosis-rpc.blockreq.com/v1/rpc/public',
    'https://rpc.gnosischain.com',
  ]),
  beaconUrls: Object.freeze(['https://rpc-gbc.gnosischain.com']),
  confirmations: 3,
});

/** Every known deployment. */
export const NETWORKS: readonly DavinciNetwork[] = Object.freeze([GNOSIS]);

/**
 * Looks up a known deployment by name (case-insensitive).
 *
 * @example
 * ```typescript
 * getNetwork('gnosis')?.chainId; // 100
 * ```
 */
export function getNetwork(name: string): DavinciNetwork | undefined {
  const n = name.trim().toLowerCase();
  return NETWORKS.find(net => net.name === n);
}

/**
 * The registry's process id prefix, bytes 20..23 of every process id it
 * assigns: the low 4 bytes of `keccak256(abi.encodePacked(uint32 chainId, address registry))`
 * (davinci-contracts `ProcessIdLib`).
 *
 * @returns `0x` + 8 hex digits
 *
 * @example
 * ```typescript
 * processIdPrefix(GNOSIS.chainId, GNOSIS.processRegistry); // '0xf5848002'
 * ```
 */
export function processIdPrefix(chainId: number | bigint, registry: string): string {
  const id = BigInt(chainId);
  if (id < 0n || id >= 1n << 32n) throw new Error(`chain id ${id} does not fit in uint32`);
  const h = keccak256(solidityPacked(['uint32', 'address'], [id, getAddress(registry)]));
  return `0x${h.slice(-8)}`;
}

/**
 * A deployment that is not one of {@link NETWORKS}: a local chain, or a
 * registry this release does not list. A custom network naming a known
 * network's chain and registry takes that network's other settings.
 */
export interface CustomNetwork {
  /** Name used in messages; default the known network's, else `chain <id>`. */
  name?: string;
  chainId: number;
  /** `ProcessRegistry` address. */
  processRegistry: string;
  /** Block the registry was deployed at; event scans need it. */
  startBlock?: number;
  /** JSON-RPCs for reads, in order of preference. */
  rpcUrls?: readonly string[];
}

/** The deployment an SDK instance works with, checked and complete. */
export interface ResolvedNetwork {
  name: string;
  chainId: number;
  /** `ProcessRegistry` address, checksummed. */
  processRegistry: string;
  /** Deployment block of the registry, when known. */
  startBlock?: number;
  /** JSON-RPCs for reads, in order of preference; may be empty for a custom network. */
  rpcUrls: readonly string[];
  /** {@link processIdPrefix} of the registry: bytes 20..23 of its process ids. */
  processIdPrefix: string;
}

/**
 * A known network by name, or a custom deployment, checked: the chain id is
 * a uint32, the registry an address and the start block a block number.
 *
 * @throws Error for an unknown name, RangeError or TypeError for a bad field
 *
 * @example
 * ```typescript
 * resolveNetwork('gnosis').processIdPrefix; // '0xf5848002'
 * resolveNetwork({ chainId: 31337, processRegistry: '0x…', rpcUrls: ['http://127.0.0.1:8545'] });
 * ```
 */
export function resolveNetwork(network: string | CustomNetwork): ResolvedNetwork {
  if (typeof network === 'string') {
    const known = getNetwork(network);
    if (!known) {
      throw new Error(
        `unknown network "${network}"; known: ${NETWORKS.map(n => n.name).join(', ')}`
      );
    }
    return {
      name: known.name,
      chainId: known.chainId,
      processRegistry: getAddress(known.processRegistry),
      startBlock: known.startBlock,
      rpcUrls: known.rpcUrls,
      processIdPrefix: processIdPrefix(known.chainId, known.processRegistry),
    };
  }
  const { chainId, startBlock } = network;
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || chainId >= 2 ** 32) {
    throw new RangeError(`chain id ${chainId} is not a uint32 above 0`);
  }
  if (startBlock !== undefined && (!Number.isSafeInteger(startBlock) || startBlock < 0)) {
    throw new RangeError(`start block ${startBlock} is not a block number`);
  }
  const processRegistry = getAddress(network.processRegistry);
  const known = NETWORKS.find(
    n => n.chainId === chainId && n.processRegistry.toLowerCase() === processRegistry.toLowerCase()
  );
  return {
    name: network.name ?? known?.name ?? `chain ${chainId}`,
    chainId,
    processRegistry,
    startBlock: startBlock ?? known?.startBlock,
    rpcUrls: [...(network.rpcUrls ?? known?.rpcUrls ?? [])],
    processIdPrefix: processIdPrefix(chainId, processRegistry),
  };
}

/**
 * The known network whose registry created `processId`, read from the
 * registry prefix at bytes 20..23.
 *
 * @throws TypeError unless `processId` is 31 bytes of hex (`0x` optional)
 */
export function networkOfProcessId(processId: string): DavinciNetwork | undefined {
  const prefix = processIdPrefixOf(processId);
  return NETWORKS.find(n => processIdPrefix(n.chainId, n.processRegistry) === prefix);
}

/**
 * Bytes 20..23 of a process id: the prefix of the registry that assigned it.
 *
 * @returns `0x` + 8 lowercase hex digits
 * @throws TypeError unless `processId` is 31 bytes of hex (`0x` optional)
 */
export function processIdPrefixOf(processId: string): string {
  const h = processId.startsWith('0x') ? processId.slice(2) : processId;
  if (!/^[0-9a-fA-F]{62}$/.test(h)) throw new TypeError(`${processId} is not a process id`);
  return `0x${h.slice(40, 48).toLowerCase()}`;
}

/** `User-Agent` of RPC requests from Node: some public RPCs answer 403 without one. */
const RPC_USER_AGENT = 'davinci-sdk';
/** Tries of a rate-limited (429) request on an RPC before the next one is asked. */
const RPC_FAILOVER_ATTEMPTS = 4;

// A JSON-RPC answer that means "slow down" rather than a result, as alloy's
// rate-limit policy reads it.
function rateLimited(answer: JsonRpcResult | JsonRpcError): boolean {
  const error = (answer as Partial<JsonRpcError>).error;
  if (!error) return false;
  return (
    error.code === 429 ||
    error.code === -32005 ||
    /rate limit|rate exceeded|too many requests|request limit/i.test(String(error.message))
  );
}

/**
 * A read provider over several JSON-RPC endpoints of one chain. Each request
 * goes to the endpoints in order and the first answer is taken; an endpoint
 * that does not answer, answers with an HTTP error or rate-limits the request
 * hands it to the next. A 429 is retried a few times on the same endpoint
 * first (ethers' backoff), and more times on the last one. Requests from
 * Node carry a `User-Agent`.
 *
 * A JSON-RPC error answer (a revert, an unknown method) is an answer: it is
 * not retried elsewhere.
 */
export class FailoverRpcProvider extends JsonRpcProvider {
  /** The endpoints, in order of preference. */
  readonly urls: readonly string[];

  /**
   * @param urls - JSON-RPC endpoints, in order of preference
   * @param chainId - The chain the endpoints serve; detected (`eth_chainId`) when absent
   */
  constructor(urls: readonly string[], chainId?: number) {
    if (urls.length === 0) throw new Error('at least one RPC URL is required');
    const network = chainId === undefined ? undefined : Network.from(chainId);
    super(urls[0], network, network ? { staticNetwork: network } : {});
    this.urls = [...urls];
  }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    let last: unknown;
    for (const [i, url] of this.urls.entries()) {
      const final = i === this.urls.length - 1;
      const req = new FetchRequest(url);
      if (!final) req.setThrottleParams({ maxAttempts: RPC_FAILOVER_ATTEMPTS });
      if (isNode()) req.setHeader('user-agent', RPC_USER_AGENT);
      req.setHeader('content-type', 'application/json');
      req.body = JSON.stringify(payload);
      try {
        const res = await req.send();
        res.assertOk();
        const json = res.bodyJson as unknown;
        const answers = (Array.isArray(json) ? json : [json]) as (JsonRpcResult | JsonRpcError)[];
        if (!final && answers.some(rateLimited)) continue;
        // Errors travel in the same array as results; ethers types it as results only.
        return answers as JsonRpcResult[];
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }
}
