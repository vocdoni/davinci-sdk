/**
 * @fileoverview Errors of the vote flow, of vote receipts and of waiting for
 * results.
 */

import type { ResultsStatus } from './results';

/**
 * Why a vote was not taken, or why a wait for its status ended:
 *
 * - `not-in-census`: the voter is not a member (the census holds no weight
 *   for it, or a node answered "address not in the census").
 * - `not-started`, `closed`: the process does not take votes yet, or any
 *   more (ended, canceled, results, or past its end: the grace window only
 *   settles votes taken before the end).
 * - `invalid`: the vote fails a protocol check: choices outside the ballot
 *   mode (found before proving), or the node's 40002 with its reason.
 * - `duplicate`: this vote id is already queued or settled: a ballot of this
 *   voter with this `k` in this process is in. Only that reuse of `k` is
 *   refused, and none is safe (see `VoteConfig.k`).
 * - `slot-busy`: the voter's slot already holds as many queued ballots as the
 *   node keeps; retry once one settles.
 * - `max-voters`: the process has as many voters as it allows.
 * - `busy`: the node is at capacity or still loading the census; retry
 *   shortly, on the same node.
 * - `unavailable`: no node took the vote: none answered, or none serves the
 *   process (a new process takes a few blocks to reach the nodes).
 * - `timeout`: a status wait ran out.
 */
export type VoteErrorReason =
  | 'not-in-census'
  | 'not-started'
  | 'closed'
  | 'invalid'
  | 'duplicate'
  | 'slot-busy'
  | 'max-voters'
  | 'busy'
  | 'unavailable'
  | 'timeout';

/** A vote that was refused, locally or by the nodes, or a status wait that ran out. */
export class VoteError extends Error {
  /** The node that answered, when one did. */
  readonly node?: string;
  /** The node's error code (`SequencerErrorCode`), when a node refused. */
  readonly code?: number;
  /** The underlying error. */
  readonly cause?: unknown;

  /**
   * @param reason - Why, see {@link VoteErrorReason}
   * @param message - What happened, with the node's own text when it refused
   * @param details - The node, its error code and the underlying error
   */
  constructor(
    public readonly reason: VoteErrorReason,
    message: string,
    details: { node?: string; code?: number; cause?: unknown } = {}
  ) {
    super(message);
    this.name = this.constructor.name;
    this.node = details.node;
    this.code = details.code;
    this.cause = details.cause;
  }
}

/**
 * A vote receipt that cannot be had: no node holds the vote in its tree yet
 * (it has not settled), or the tracker proof a node gave does not reach a
 * state root the process ever had on-chain.
 */
export class VoteReceiptError extends Error {
  /**
   * @param message - What went wrong
   * @param node - The node whose proof failed, when one answered
   * @param cause - The underlying error
   */
  constructor(
    message: string,
    public readonly node?: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * Results that will not come, or not in time: the process was canceled
 * (`canceled`), a DKG-locked key is still sealed after the grace window
 * (`locked`: the organizer must call `revealProcessKey`), or the wait ran out
 * (`timeout`). `status` is where the process stood.
 */
export class ResultsError extends Error {
  /**
   * @param reason - `canceled`, `locked` or `timeout`
   * @param message - What happened
   * @param status - The last state read
   */
  constructor(
    public readonly reason: 'canceled' | 'locked' | 'timeout',
    message: string,
    public readonly status: ResultsStatus
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}
