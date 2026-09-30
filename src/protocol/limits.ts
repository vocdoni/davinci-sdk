/**
 * @fileoverview Protocol limits of the zkVM stack, mirrored from davinci-zkvm
 * `rust-sdk/src/limits.rs` (itself mirrored from the guest's
 * `circuit-primitives/src/types.rs`), plus the ballot and census bit widths of
 * `rust-sdk/src/ballot.rs` and `census.rs`. `test/protocol/unit/limits.test.ts`
 * checks them against a verbatim copy of `limits.rs`.
 */

/** Ballot capacity: every ballot carries 16 ElGamal ciphertexts (circuit `BallotProof(16)`). */
export const NUM_FIELDS = 16;
/** Flat ballot width: NUM_FIELDS ciphertexts x 4 coordinates. */
export const BALLOT_COORDS = NUM_FIELDS * 4;
/** Largest batch the vote-batch guest proves. */
export const MAX_BATCH_SIZE = 1024;
/** Most silent refreshes one batch carries. */
export const MAX_REFRESH = 2048;
export const REFRESH_MIN = 16;
export const REFRESH_TAU = 2;
export const REFRESH_KAPPA = 1;
/** Levels of the state tree (arbo, SHA-256, 8-byte keys). */
export const SMT_LEVELS = 64;
/** Most EIP-4844 blobs one transition may carry. */
export const MAX_BLOBS = 32;
/** EIP-7594 cap on blobs per transaction. */
export const TX_BLOB_CAP = 6;
/** Longest compact lean-IMT census proof the guest accepts. */
export const MAX_CENSUS_DEPTH = 61;

/** Ballot slots live in [BALLOT_MIN, BALLOT_MAX]; vote ids in [VOTE_ID_MIN, 2^64). */
export const VOTE_ID_MIN = 1n << 63n;
export const BALLOT_MIN = 0x10n;
export const BALLOT_MAX = VOTE_ID_MIN - 1n;

/** Config keys of the state tree. */
export const STATE_KEY_PROCESS_ID = 0x00n;
export const STATE_KEY_BALLOT_MODE = 0x02n;
export const STATE_KEY_ENCRYPTION_KEY = 0x03n;
export const STATE_KEY_RESULTS = 0x04n;
export const STATE_KEY_CENSUS_ORIGIN = 0x06n;
export const STATE_KEY_BALLOT_VK = 0x07n;

/** Ballot field values and the ballot-mode value bounds are below 2^48. */
export const MAX_VALUE_BITS = 48;
/** The ballot-mode sum bounds are below 2^63. */
export const VALUE_SUM_BITS = 63;
/** A census weight is below 2^88: the leaf is `(address << 88) | weight`. */
export const CENSUS_WEIGHT_BITS = 88;
