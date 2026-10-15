/**
 * @fileoverview Pinned values of the davinci-zkvm release the SDK trusts, from
 * davinci-zkvm `rust-sdk/src/release.rs` (ZisK 1.3.2-alpha, davinci-zkvm
 * branch feat/zisk-1.3.2). A deployment is only trusted when its registry immutables
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
  '0xe39e460085ecddecf365649a61183a71c0fe778aa9c06fd2aa1a6c43cddb988b';

/** Results guest program vk: registry `resultsProgramVK()`. */
export const RESULTS_PROGRAM_VK =
  '0x394694558f39d0b2da0bbb09322333a0f567ee8d16bea2f354543a086587d167';

/** ZisK vadcop-final setup root: registry `rootCVadcopFinal()` and verifier `getRootCVadcopFinal()`. */
export const ROOT_C_VADCOP_FINAL =
  '0x6b2490fba336fb00f0c8719a961de309a8db6f43a9bfb7575ca5f014d609b265';

/** keccak256 of the `ZiskVerifier` runtime code the registry's `ziskVerifier()` must carry. */
export const ZISK_VERIFIER_CODEHASH =
  '0xadab570d3e3a4c172d0c75e5aef5d06098b94d70a9c8ff76af239a90fdcadcc1';

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
