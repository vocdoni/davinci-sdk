/**
 * @fileoverview Pinned values of the davinci-zkvm release the SDK trusts, from
 * davinci-zkvm `rust-sdk/src/release.rs` (ZisK 1.3.2-alpha, davinci-zkvm
 * v0.5.0 at 22dbedf). A deployment is only trusted when its registry immutables
 * equal these; `test/protocol/unit/Protocol.test.ts` checks them against a
 * verbatim copy of `release.rs`.
 *
 * The program vks change with the guest source, `ROOT_C_VADCOP_FINAL` and
 * `ZISK_VERIFIER_CODEHASH` with the ZisK snark setup, and `BALLOT_VK_HASH`
 * with the davinci-circom ballot proof key. Any of them moving needs a new
 * registry.
 */

/** Vote-batch guest program vk: registry `batchProgramVK()`. */
export const BATCH_PROGRAM_VK =
  '0x4b1a527e284af96fa0c3543e9e9b18746a6494edd99c309e58d96a804e3041dc';

/** Results guest program vk: registry `resultsProgramVK()`. */
export const RESULTS_PROGRAM_VK =
  '0xce964acdd53329fc49ede57f5ea288f044950e136be119287fd0021390689dc4';

/** ZisK vadcop-final setup root: registry `rootCVadcopFinal()` and verifier `getRootCVadcopFinal()`. */
export const ROOT_C_VADCOP_FINAL =
  '0x6b2490fba336fb00f0c8719a961de309a8db6f43a9bfb7575ca5f014d609b265';

/** keccak256 of the `ZiskVerifier` runtime code the registry's `ziskVerifier()` must carry. */
export const ZISK_VERIFIER_CODEHASH =
  '0xadab570d3e3a4c172d0c75e5aef5d06098b94d70a9c8ff76af239a90fdcadcc1';

/**
 * sha256 of the ballot proof VK wire bytes (see `ballotVkHash`): registry
 * `ballotVKHash()` and state leaf 0x07. The key is davinci-circom
 * `artifacts/ballot_proof_vkey.json` of davinci-circom v1.3.0, its
 * pre-production phase-2 ceremony key (`CEREMONY.md`, `artifacts/VK_HASH`); a
 * public ceremony replaces it before public production.
 */
export const BALLOT_VK_HASH = '0x67e8e6b47ea32cf144d6e72886f02b95ed068b157f9d4ccc8e97f335858e4963';

/** The pins a deployment is checked against, by registry getter name. */
export const RELEASE_PINS = {
  batchProgramVK: BATCH_PROGRAM_VK,
  resultsProgramVK: RESULTS_PROGRAM_VK,
  rootCVadcopFinal: ROOT_C_VADCOP_FINAL,
  ziskVerifierCodeHash: ZISK_VERIFIER_CODEHASH,
  ballotVKHash: BALLOT_VK_HASH,
} as const;
