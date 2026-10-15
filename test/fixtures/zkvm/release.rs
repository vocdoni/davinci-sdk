//! Pinned release values, like go-sdk `chain/release.go`. The program vks
//! change with the guest source (`scripts/build-guests.sh` builds are path
//! independent); `ROOT_C_VADCOP_FINAL` changes with the ZisK snark setup.
//!
//! Refreezing:
//! - `BATCH_PROGRAM_VK` / `RESULTS_PROGRAM_VK`: run
//!   `cargo-zisk setup -e <elf> -k ~/.zisk/provingKey` on the tracked ELF with
//!   an empty `ZISK_CACHE_DIR` (a warm cache skips the print). It prints
//!   `Root hash: [w0, w1, w2, w3]`; the pin is those four u64 words as
//!   big-endian bytes, concatenated. Update go-sdk `CircuitRelease` in the
//!   same change.
//! - `ROOT_C_VADCOP_FINAL`: after a ZisK release or snark setup change, copy
//!   `root_c_vadcop_final` from any PLONK job's `snark.json`
//!   (`GET /jobs/{id}/snark`); every job kind serves the same value. Without a
//!   prover, `provingKeySnark/vadcop_final.verkey.json` holds the same four u64
//!   words (big-endian, concatenated), as do the snark setup's
//!   `ZiskVerifier.getRootCVadcopFinal()` and the aggregator's `SETUP_VK`.
//! - `ZISK_VERIFIER_CODEHASH`: after a ZisK snark setup change, vendor the
//!   setup's verifier into davinci-contracts as its `docs/development.md`
//!   ("Vendoring the ZisK verifier") describes, `forge build`, and take the
//!   keccak256 of `ZiskVerifier`'s `deployedBytecode` (it has no immutables, so
//!   it equals `eth_getCode`). All three files come from
//!   `provingKeySnark/final/`: `PlonkVerifier.sol` to `src/verifiers/`,
//!   `IZiskVerifier.sol` to `src/interfaces/`, and `ZiskVerifier.sol` to
//!   `src/verifiers/` with its import rewritten to
//!   `../interfaces/IZiskVerifier.sol`. Skipping or editing any of them moves
//!   the hash.
//!
//! A host that accepts a snark should compare its `program_vk` and
//! `root_c_vadcop_final` against these pins rather than trust the values the
//! service returns.

/// Vote-batch ELF program vk (`circuit/elf/circuit.elf`), go-sdk
/// `CircuitRelease.BatchVK`. The `program_vk` of every per-batch PLONK.
pub const BATCH_PROGRAM_VK: [u8; 32] = [
    0xe3, 0x9e, 0x46, 0x00, 0x85, 0xec, 0xdd, 0xec, 0xf3, 0x65, 0x64, 0x9a, 0x61, 0x18, 0x3a, 0x71,
    0xc0, 0xfe, 0x77, 0x8a, 0xa9, 0xc0, 0x6f, 0xd2, 0xaa, 0x1a, 0x6c, 0x43, 0xcd, 0xdb, 0x98, 0x8b,
];

/// circuit-results ELF program vk (`circuit-results/elf/results.elf`), go-sdk
/// `CircuitRelease.ResultsVK`. Checked on a GPU `/results` job.
pub const RESULTS_PROGRAM_VK: [u8; 32] = [
    0x39, 0x46, 0x94, 0x55, 0x8f, 0x39, 0xd0, 0xb2, 0xda, 0x0b, 0xbb, 0x09, 0x32, 0x23, 0x33, 0xa0,
    0xf5, 0x67, 0xee, 0x8d, 0x16, 0xbe, 0xa2, 0xf3, 0x54, 0x54, 0x3a, 0x08, 0x65, 0x87, 0xd1, 0x67,
];

/// VADCOP-final root of the ZisK 1.3.2-alpha snark setup, as served in
/// `root_c_vadcop_final` by every PLONK job (batch, finalize and results).
pub const ROOT_C_VADCOP_FINAL: [u8; 32] = [
    0x6b, 0x24, 0x90, 0xfb, 0xa3, 0x36, 0xfb, 0x00, 0xf0, 0xc8, 0x71, 0x9a, 0x96, 0x1d, 0xe3, 0x09,
    0xa8, 0xdb, 0x6f, 0x43, 0xa9, 0xbf, 0xb7, 0x57, 0x5c, 0xa5, 0xf0, 0x14, 0xd6, 0x09, 0xb2, 0x65,
];

/// keccak256 of the runtime code of davinci-contracts' `ZiskVerifier`, built
/// with its foundry.toml (solc 0.8.28, via-ir) from the 1.3.2-alpha snark
/// setup's verifier files.
pub const ZISK_VERIFIER_CODEHASH: [u8; 32] = [
    0xad, 0xab, 0x57, 0x0d, 0x3e, 0x3a, 0x4c, 0x17, 0x2d, 0x0c, 0x75, 0xe5, 0xae, 0xf5, 0xd0, 0x60,
    0x98, 0xb9, 0x4d, 0x70, 0xa9, 0xc8, 0xff, 0x76, 0xaf, 0x23, 0x9a, 0x90, 0xfd, 0xca, 0xdc, 0xc1,
];

/// The davinci-circom ballot proof verification key the sequencer accepts
/// (davinci-circom `artifacts/ballot_proof_vkey.json`).
pub fn ballot_vk_json() -> &'static str {
    include_str!("../assets/ballot_proof_vkey.json")
}
