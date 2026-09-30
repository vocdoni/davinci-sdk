//! Protocol limits, mirrored from `circuit-primitives/src/types.rs` and
//! `go-sdk/types.go`. Single source of truth for the Rust side.

pub const MAX_BATCH_SIZE: usize = 1024;
pub const MAX_REFRESH: usize = 2048;
pub const REFRESH_MIN: usize = 16;
pub const REFRESH_TAU: usize = 2;
pub const REFRESH_KAPPA: usize = 1;
pub const NUM_FIELDS: usize = 16;
/// Flat ballot width: NUM_FIELDS ciphertexts x 4 coordinates.
pub const BALLOT_COORDS: usize = NUM_FIELDS * 4;
pub const SMT_LEVELS: usize = 64;
pub const MAX_BLOBS: usize = 32;
/// EIP-7594 cap on blobs per transaction.
pub const TX_BLOB_CAP: usize = 6;
/// Longest compact lean-IMT path the guest accepts.
pub const MAX_CENSUS_DEPTH: usize = 61;

pub const BALLOT_MIN: u64 = 0x10;
pub const BALLOT_MAX: u64 = VOTE_ID_MIN - 1;
pub const VOTE_ID_MIN: u64 = 1 << 63;

pub const KEY_PROCESS_ID: u64 = 0x00;
pub const KEY_BALLOT_MODE: u64 = 0x02;
pub const KEY_ENC_KEY: u64 = 0x03;
pub const KEY_RESULTS: u64 = 0x04;
pub const KEY_CENSUS_ORIGIN: u64 = 0x06;
pub const KEY_BALLOT_VK: u64 = 0x07;
/// Config keys read by every batch, in the order of `process_smt`.
pub const PROCESS_KEYS: [u64; 5] = [
    KEY_PROCESS_ID,
    KEY_BALLOT_MODE,
    KEY_ENC_KEY,
    KEY_CENSUS_ORIGIN,
    KEY_BALLOT_VK,
];

pub const CENSUS_ORIGIN_MERKLE: u64 = 1;
pub const CENSUS_ORIGIN_CSP: u64 = 4;

/// Silent refreshes the guest asks for:
/// `min(MAX_REFRESH, max(REFRESH_MIN, TAU*w, KAPPA*n))`.
pub fn refresh_target(n: usize, w: usize) -> usize {
    REFRESH_MIN
        .max(REFRESH_TAU.saturating_mul(w))
        .max(REFRESH_KAPPA.saturating_mul(n))
        .min(MAX_REFRESH)
}

/// Minimum refresh count the guest accepts: `min(target, occupied_before - w)`
/// (zero when `w > occupied_before`, which the guest rejects anyway).
pub fn required_refresh(n: usize, w: usize, occupied_before: usize) -> usize {
    refresh_target(n, w).min(occupied_before.saturating_sub(w))
}
