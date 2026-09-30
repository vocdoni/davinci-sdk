import { getAddress, keccak256, solidityPacked } from 'ethers';

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
