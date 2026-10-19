/**
 * @fileoverview Pinned values of the davinci-zkvm release the SDK trusts, from
 * davinci-zkvm `rust-sdk/src/release.rs` (ZisK 1.3.2-alpha, davinci-zkvm
 * branch feat/protocol-v5 at 867316b). A deployment is only trusted when its registry immutables
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
  '0x1e4a74a1c6fb1cd1874d80895e1e075930837955efb4a135539016f7cdead2a8';

/** Results guest program vk: registry `resultsProgramVK()`. */
export const RESULTS_PROGRAM_VK =
  '0xde55d751582e510bf378d4eec0d98ee3fa5817a50b77bc0e5ce560035e29e4e9';

/** ZisK vadcop-final setup root: registry `rootCVadcopFinal()` and verifier `getRootCVadcopFinal()`. */
export const ROOT_C_VADCOP_FINAL =
  '0x6b2490fba336fb00f0c8719a961de309a8db6f43a9bfb7575ca5f014d609b265';

/** keccak256 of the `ZiskVerifier` runtime code the registry's `ziskVerifier()` must carry. */
export const ZISK_VERIFIER_CODEHASH =
  '0xadab570d3e3a4c172d0c75e5aef5d06098b94d70a9c8ff76af239a90fdcadcc1';

/**
 * sha256 of the ballot proof VK wire bytes (see `ballotVkHash`): registry
 * `ballotVKHash()` and state leaf 0x07. The key is davinci-circom
 * `artifacts/ballot_proof_vkey.json` of davinci-circom v1.2.0, its
 * pre-production phase-2 ceremony key (`CEREMONY.md`, `artifacts/VK_HASH`); a
 * public ceremony replaces it before public production.
 */
export const BALLOT_VK_HASH = '0x7caffddcd7ea38439cbb45789b810d8eafceca65cff93dbeaae409b2bf64e219';

/** The pins a deployment is checked against, by registry getter name. */
export const RELEASE_PINS = {
  batchProgramVK: BATCH_PROGRAM_VK,
  resultsProgramVK: RESULTS_PROGRAM_VK,
  rootCVadcopFinal: ROOT_C_VADCOP_FINAL,
  ziskVerifierCodeHash: ZISK_VERIFIER_CODEHASH,
  ballotVKHash: BALLOT_VK_HASH,
} as const;
