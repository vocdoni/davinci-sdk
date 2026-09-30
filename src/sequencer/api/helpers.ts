import type { OnchainProcess } from '../../contracts/types';
import type { BallotModeValues } from '../../crypto/ballot';
import { VOTE_ID_MIN } from '../../protocol/limits';
import { SequencerDecodeError } from '../errors';
import type { ProcessView } from './types';

/**
 * Validates that a process ID is a valid 62-character hex string (31 bytes).
 * @param processId - The process ID to validate
 * @returns True if valid, false otherwise
 */
export function validateProcessId(processId: string): boolean {
  // Check if it's a valid 62-character hex string (31 bytes)
  const cleanId = processId.replace(/^0x/, '');
  return /^[0-9a-fA-F]{62}$/.test(cleanId);
}

/**
 * A process id as the API writes it: `0x` + 62 lowercase hex digits.
 *
 * @throws TypeError unless `processId` is 31 bytes of hex (`0x` optional)
 */
export function normalizeProcessId(processId: string): string {
  if (!validateProcessId(processId)) {
    throw new TypeError('Invalid processId format. Must be a 62-character hex string (31 bytes)');
  }
  return `0x${processId.replace(/^0x/, '').toLowerCase()}`;
}

/**
 * A vote id as the API writes it: `0x` + exactly 16 hex digits.
 *
 * @throws RangeError unless the id is in `[2^63, 2^64)`
 *
 * @example
 * ```typescript
 * formatVoteId(0x80000000000000ffn); // '0x80000000000000ff'
 * ```
 */
export function formatVoteId(voteId: bigint): string {
  if (voteId < VOTE_ID_MIN || voteId >= 1n << 64n) {
    throw new RangeError('vote id not in [2^63, 2^64)');
  }
  return `0x${voteId.toString(16).padStart(16, '0')}`;
}

/**
 * Inverse of {@link formatVoteId}; `0x` is optional, the 16 digits are not,
 * and the value must be a vote id (at least 2^63).
 *
 * @throws RangeError for anything else
 */
export function parseVoteId(voteId: string): bigint {
  const h = voteId.startsWith('0x') ? voteId.slice(2) : voteId;
  if (!/^[0-9a-fA-F]{16}$/.test(h)) throw new RangeError('vote id must be 8 bytes of hex');
  const v = BigInt(`0x${h}`);
  if (v < VOTE_ID_MIN) throw new RangeError('vote id below 2^63');
  return v;
}

/** A vote id given as a bigint or as its hex form, checked. */
export function toVoteId(voteId: bigint | string): bigint {
  return typeof voteId === 'bigint' ? BigInt(formatVoteId(voteId)) : parseVoteId(voteId);
}

/** An address as the API writes it in a path: `0x` + 40 lowercase hex digits. */
export function normalizeAddress(address: string): string {
  const h = address.startsWith('0x') ? address.slice(2) : address;
  if (!/^[0-9a-fA-F]{40}$/.test(h)) throw new TypeError(`${address} is not an address`);
  return `0x${h.toLowerCase()}`;
}

/**
 * Checks the election parameters a voter relies on (process id, key, ballot
 * mode, census origin and root) in a node's view against the registry's
 * process. Status, counters and the state root may lag the chain and are not
 * compared. A node that differs could hand out its own key or census.
 *
 * @throws SequencerDecodeError naming the first field that differs
 */
export function checkProcessView(view: ProcessView, onchain: OnchainProcess): void {
  const mode = (m: BallotModeValues) =>
    [
      m.numFields,
      m.groupSize,
      m.uniqueValues,
      m.costExponent,
      m.maxValue,
      m.minValue,
      m.maxValueSum,
      m.minValueSum,
    ].join(',');
  let differs: string | null = null;
  if (view.id !== onchain.processId.toLowerCase()) differs = 'process id';
  else if (
    view.encryptionKey.x !== onchain.encryptionKey.x ||
    view.encryptionKey.y !== onchain.encryptionKey.y
  ) {
    differs = 'encryption key';
  } else if (mode(view.ballotMode) !== mode(onchain.ballotMode)) differs = 'ballot mode';
  else if (view.census.censusOrigin !== Number(onchain.census.origin)) differs = 'census origin';
  else if (view.census.censusRoot !== BigInt(onchain.census.root)) differs = 'census root';
  if (differs) {
    throw new SequencerDecodeError(`process view differs from the registry: ${differs}`);
  }
}
