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
//!   (`GET /jobs/{id}/snark`); every job kind serves the same value.
//! - `ZISK_VERIFIER_CODEHASH`: after a ZisK snark setup change, `forge build`
//!   in davinci-contracts and take the keccak256 of `ZiskVerifier`'s
//!   `deployedBytecode` (it has no immutables, so it equals `eth_getCode`).
//!
//! A host that accepts a snark should compare its `program_vk` and
//! `root_c_vadcop_final` against these pins rather than trust the values the
//! service returns.

/// Vote-batch ELF program vk (`circuit/elf/circuit.elf`), go-sdk
/// `CircuitRelease.BatchVK`. The `program_vk` of every per-batch PLONK.
pub const BATCH_PROGRAM_VK: [u8; 32] = [
    0x6c, 0xfc, 0x89, 0xd5, 0x62, 0xd0, 0xb2, 0x2f, 0x04, 0x47, 0x8a, 0x5c, 0x15, 0xb3, 0x90, 0x43,
    0x3e, 0xb5, 0x2f, 0x1b, 0x03, 0x14, 0x70, 0x30, 0xb1, 0x83, 0x07, 0x62, 0x60, 0xda, 0x7a, 0x10,
];

/// circuit-results ELF program vk (`circuit-results/elf/results.elf`), go-sdk
/// `CircuitRelease.ResultsVK`. Checked on a GPU `/results` job.
pub const RESULTS_PROGRAM_VK: [u8; 32] = [
    0x7b, 0xc8, 0xc5, 0xe9, 0x23, 0x55, 0x48, 0x38, 0x6a, 0x44, 0xb1, 0x88, 0x57, 0x32, 0xa2, 0xa7,
    0xff, 0xb1, 0xba, 0xdd, 0xdc, 0x8c, 0x7f, 0xba, 0x59, 0x9d, 0x07, 0xec, 0xe4, 0x7b, 0xe7, 0x94,
];

/// VADCOP-final root of the installed ZisK 1.3 snark setup, as served in
/// `root_c_vadcop_final` by every PLONK job (batch, finalize and results).
pub const ROOT_C_VADCOP_FINAL: [u8; 32] = [
    0x05, 0x00, 0x65, 0x17, 0xb6, 0xcc, 0xde, 0x5d, 0xa4, 0xd8, 0x90, 0x58, 0x7b, 0xa6, 0x28, 0x45,
    0xb5, 0xaf, 0x8a, 0x30, 0x7c, 0x00, 0xe8, 0x7d, 0x4b, 0x9d, 0x05, 0x09, 0x9b, 0x16, 0xdc, 0x80,
];

/// keccak256 of the runtime code of davinci-contracts' `ZiskVerifier`, built
/// with its foundry.toml (solc 0.8.28, via-ir). Same bytes as the Gnosis
/// deployment `0x78CD792CB3754aF5Fd371732a7a73D713bf23961`.
pub const ZISK_VERIFIER_CODEHASH: [u8; 32] = [
    0x82, 0x38, 0x5a, 0x40, 0x5b, 0x73, 0x01, 0x34, 0x5d, 0x7e, 0x24, 0x60, 0x17, 0x84, 0x6c, 0xa3,
    0x22, 0x8a, 0xae, 0xa3, 0x49, 0xcb, 0x68, 0xb1, 0x16, 0xd7, 0x6e, 0x0e, 0x77, 0x05, 0x65, 0x66,
];

/// The davinci-circom ballot proof verification key the sequencer accepts
/// (davinci-circom `artifacts/ballot_proof_vkey.json`).
pub fn ballot_vk_json() -> &'static str {
    include_str!("../assets/ballot_proof_vkey.json")
}
