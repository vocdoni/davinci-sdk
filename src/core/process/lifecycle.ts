/**
 * @fileoverview A process's timeline as the registry keeps it: the grace
 * window after the end (davinci-contracts `ProcessRegistry._graceEnd`) and
 * the phase a process is in, from its status and the chain clock.
 */

import { ProcessStatus } from '../../contracts/types';

const UINT256_MAX = (1n << 256n) - 1n;

/**
 * Where a process stands, from its status and the chain clock:
 *
 * - `upcoming`: READY, before the start.
 * - `open`: READY, voting.
 * - `paused`: PAUSED before the end. Nodes still take votes but settle
 *   nothing until it resumes.
 * - `closing`: past the end (READY, PAUSED or ENDED), while the grace window
 *   still records batches of votes cast before the end.
 * - `ended`: the grace window has closed; the results are pending.
 * - `results`: the tally is on-chain.
 * - `canceled`: no results will be set.
 */
export type ProcessPhase =
  | 'upcoming'
  | 'open'
  | 'paused'
  | 'closing'
  | 'ended'
  | 'results'
  | 'canceled';

/** What the grace end depends on, as the registry stores it. */
export interface GraceWindowInput {
  /** Unix seconds. */
  startTime: bigint;
  /** Seconds. */
  duration: bigint;
  /** Idle seconds that close the window. */
  grace: number | bigint;
  /** Block time of the latest transition; 0 before the first. */
  lastVoteAt: bigint;
}

/**
 * The block time the grace window closes at, as `getProcessGraceEnd` returns
 * it: `min(end + graceMaxTotal, max(end, lastVoteAt) + grace)`. Every landing
 * after the end pushes it out, never past `end + graceMaxTotal`; results
 * unlock at it. An end within `graceMaxTotal` of 2^256 never closes (2^256 − 1).
 *
 * @param graceMaxTotal - The registry's `graceMaxTotal` (`getGraceParams`)
 */
export function graceEndOf(p: GraceWindowInput, graceMaxTotal: number | bigint): bigint {
  const end = p.startTime + p.duration;
  const maxTotal = BigInt(graceMaxTotal);
  if (end > UINT256_MAX - maxTotal) return UINT256_MAX;
  const idleEnd = (p.lastVoteAt > end ? p.lastVoteAt : end) + BigInt(p.grace);
  const cap = end + maxTotal;
  return idleEnd < cap ? idleEnd : cap;
}

/**
 * The {@link ProcessPhase} of a process at chain time `now`. Past its end a
 * process is `closing` until `graceEnd`, then `ended`, whether it reads
 * READY, PAUSED or ENDED: a pause does not outlive the end, and the status
 * stays until results are set.
 *
 * @param now - The chain head's time, unix seconds
 * @param graceEnd - {@link graceEndOf} the process
 */
export function processPhase(
  p: { status: ProcessStatus; startTime: bigint; duration: bigint },
  now: bigint,
  graceEnd: bigint
): ProcessPhase {
  if (p.status === ProcessStatus.RESULTS) return 'results';
  if (p.status === ProcessStatus.CANCELED) return 'canceled';
  if (now >= p.startTime + p.duration) return now < graceEnd ? 'closing' : 'ended';
  if (p.status === ProcessStatus.PAUSED) return 'paused';
  // ENDED moves the end to that block: a clock behind it has not caught up.
  if (p.status === ProcessStatus.ENDED) return 'closing';
  return now < p.startTime ? 'upcoming' : 'open';
}
