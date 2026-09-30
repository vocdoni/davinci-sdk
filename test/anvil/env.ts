/**
 * @fileoverview What the anvil suite's global setup hands the tests, and the
 * settings both sides share.
 */

import { HDNodeWallet } from 'ethers';

/** The chain id of the suite's anvil node (anvil's default). */
export const ANVIL_CHAIN_ID = 31337;

/**
 * The registries' grace window settings, in seconds: the Rust e2e's anvil
 * values (davinci-sequencer `e2e/src/chain.rs` `GRACE_ARGS`).
 */
export const ANVIL_GRACE = {
  defaultGrace: 120,
  graceFloor: 40,
  graceCeil: 180,
  graceMaxTotal: 240,
  noticeMin: 5,
} as const;

/** anvil's dev accounts are derived from this public test mnemonic. */
const MNEMONIC = 'test test test test test test test test test test test junk';

let root: HDNodeWallet | undefined;

/** The private key of anvil dev account `i` (0 deploys the contracts). */
export function devKey(i: number): string {
  root ??= HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0");
  return root.deriveChild(i).privateKey;
}

/** The chain and the contracts deployed on it. */
export interface AnvilEnv {
  rpcUrl: string;
  /** `ProcessRegistry` without a DKG manager. */
  registry: string;
  /** The block it was deployed in. */
  registryBlock: number;
  /** `ProcessRegistry` whose DKG manager is davinci-contracts' `MockDKG`. */
  dkgRegistry: string;
  dkgRegistryBlock: number;
  /** The `MockDKG` behind `dkgRegistry`. */
  mockDkg: string;
  /** Its ABI, as JSON. */
  mockDkgAbi: string;
  /** `OwnedCensus` creation code, linked to the deployed `PoseidonT3`. */
  ownedCensusBytecode: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    anvil: AnvilEnv;
  }
}
