/**
 * @fileoverview Pinned values of the davinci-zkvm release the SDK trusts, from
 * davinci-zkvm `rust-sdk/src/release.rs` (davinci-zkvm v0.1.0, ZisK
 * 1.3.0-alpha). A deployment is only trusted when its registry immutables
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
  '0x6cfc89d562d0b22f04478a5c15b390433eb52f1b03147030b183076260da7a10';

/** Results guest program vk: registry `resultsProgramVK()`. */
export const RESULTS_PROGRAM_VK =
  '0x7bc8c5e9235548386a44b1885732a2a7ffb1badddc8c7fba599d07ece47be794';

/** ZisK vadcop-final setup root: registry `rootCVadcopFinal()` and verifier `getRootCVadcopFinal()`. */
export const ROOT_C_VADCOP_FINAL =
  '0x05006517b6ccde5da4d890587ba62845b5af8a307c00e87d4b9d05099b16dc80';

/** keccak256 of the `ZiskVerifier` runtime code the registry's `ziskVerifier()` must carry. */
export const ZISK_VERIFIER_CODEHASH =
  '0x82385a405b7301345d7e246017846ca3228aaea349cb68b116d76e0e77056566';

/**
 * sha256 of the ballot proof VK wire bytes (see `ballotVkHash`): registry
 * `ballotVKHash()` and state leaf 0x07. The key is davinci-circom
 * `artifacts/ballot_proof_vkey.json` at a39a9f9.
 */
export const BALLOT_VK_HASH = '0xbf1e6590bb1ba883d601c4d7d1c6fa2722a78590716874019db6d68fc776bb0e';

/** The pins a deployment is checked against, by registry getter name. */
export const RELEASE_PINS = {
  batchProgramVK: BATCH_PROGRAM_VK,
  resultsProgramVK: RESULTS_PROGRAM_VK,
  rootCVadcopFinal: ROOT_C_VADCOP_FINAL,
  ziskVerifierCodeHash: ZISK_VERIFIER_CODEHASH,
  ballotVKHash: BALLOT_VK_HASH,
} as const;
