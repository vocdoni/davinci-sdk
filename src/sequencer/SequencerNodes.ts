import type { BaseServiceConfig } from '../core/api/BaseService';
import type { TrackerProof } from '../crypto/tracker';
import { toVoteId } from './api/helpers';
import type { VoteRequest, VoteStatusResponse } from './api/types';
import {
  SequencerApiError,
  SequencerError,
  SequencerErrorCode,
  SequencerNetworkError,
  hasSequencerErrorCode,
} from './errors';
import { pickNode } from './routing';
import { VocdoniSequencerService } from './SequencerService';

/** Where {@link SequencerNodes.submitVote} left a vote. */
export interface SubmittedVote {
  voteId: bigint;
  /** Base URL of the node that took the vote: poll its status there first. */
  node: string;
}

// No answer, a 408 or a 5xx: the node may have admitted the vote anyway.
function unknownOutcome(err: unknown): boolean {
  return (
    err instanceof SequencerNetworkError ||
    (err instanceof SequencerApiError && (err.status === 408 || err.status >= 500))
  );
}

// This node cannot take the vote at all, so it holds none of the voter's
// queued ballots and the next node is safe.
function nodeUnavailable(err: unknown): boolean {
  return (
    hasSequencerErrorCode(err, SequencerErrorCode.UnknownProcess) ||
    hasSequencerErrorCode(err, SequencerErrorCode.ObserverNode)
  );
}

/**
 * Several sequencer nodes of one deployment. Votes are routed with
 * {@link pickNode}, so every ballot of a voter goes through the same node,
 * and fail over down that order only when it is safe:
 *
 * - no answer, a 408 or a 5xx leaves the outcome unknown: the vote is resent
 *   once to the same node, then to the next one; from then on a 409
 *   {@link SequencerErrorCode.DuplicateVote} means the vote is in;
 * - a node that does not serve the process (40402) or is an observer (41203)
 *   is skipped;
 * - anything else is the answer: a protocol refusal is the same on every
 *   node, and a 409 {@link SequencerErrorCode.SlotBusy} or a 429 busy means
 *   retry later on the same node (moving on would let the voter's ballots
 *   settle out of order).
 *
 * One node's slot queue keeps a voter's revotes in order; nodes do not
 * order ballots among themselves. After a failover the voter's ballots sit on
 * two nodes and only the last one to settle counts, whichever was cast last.
 * Keep the node {@link submitVote} returns and pass it back for the voter's
 * next vote, so a revote queues behind the earlier ballot.
 *
 * @example
 * ```typescript
 * const nodes = new SequencerNodes(['https://a.example', 'https://b.example']);
 * const { node } = await nodes.submitVote(vote);
 * const status = await nodes.getVoteStatus(vote.processId, vote.voteId, node);
 * // The voter's revote goes to the node holding its previous ballot.
 * await nodes.submitVote(revote, node);
 * ```
 */
export class SequencerNodes {
  /** One client per distinct URL, in the configured order. */
  readonly nodes: readonly VocdoniSequencerService[];
  private readonly byUrl: Map<string, VocdoniSequencerService>;

  /**
   * @param urls - Node base URLs; duplicates are dropped
   * @param config - Passed to every {@link VocdoniSequencerService}
   */
  constructor(urls: readonly string[], config?: BaseServiceConfig) {
    const distinct = [...new Set(urls)];
    if (distinct.length === 0) throw new Error('at least one sequencer URL is required');
    this.byUrl = new Map(distinct.map(u => [u, new VocdoniSequencerService(u, config)]));
    this.nodes = [...this.byUrl.values()];
  }

  /** The node URLs, as configured. */
  get urls(): string[] {
    return [...this.byUrl.keys()];
  }

  /** The client of the node at `url`. */
  node(url: string): VocdoniSequencerService {
    const n = this.byUrl.get(url);
    if (!n) throw new Error(`unknown sequencer node ${url}`);
    return n;
  }

  /** The nodes in the order `voter` tries them for `processId` ({@link pickNode}). */
  order(voter: string, processId: string): VocdoniSequencerService[] {
    return pickNode(voter, processId, this.urls).map(u => this.node(u));
  }

  /**
   * Submits a vote through the voter's node, failing over as the class
   * describes. After a failover only the voter's last-settled ballot counts,
   * so pass the node that took the voter's previous vote as `node`: it goes
   * first, before the voter's usual order.
   *
   * @param vote - The vote
   * @param node - The node holding the voter's previous ballot, if any
   * @returns The vote id and the node that took it
   * @throws The last node's error when no node took the vote
   */
  async submitVote(vote: VoteRequest, node?: string): Promise<SubmittedVote> {
    let uncertain = false;
    let last: unknown;
    for (const target of this.preferring(node, this.order(vote.address, vote.processId))) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await target.submitVote(vote);
          return { voteId: vote.voteId, node: target.getBaseUrl() };
        } catch (err) {
          last = err;
          if (uncertain && hasSequencerErrorCode(err, SequencerErrorCode.DuplicateVote)) {
            return { voteId: vote.voteId, node: target.getBaseUrl() };
          }
          if (unknownOutcome(err)) {
            uncertain = true;
            continue;
          }
          if (nodeUnavailable(err)) break;
          throw err;
        }
      }
    }
    throw last;
  }

  /**
   * The status of a vote, asking `node` (the one that took it) first and the
   * others after it. A node that never saw the vote answers 404 unless the
   * id is in its tree.
   *
   * @returns The status and the node that answered
   */
  async getVoteStatus(
    processId: string,
    voteId: bigint | string,
    node?: string
  ): Promise<VoteStatusResponse & { node: string }> {
    const vid = toVoteId(voteId);
    return this.firstAnswer(
      async n => ({ ...(await n.getVoteStatus(processId, vid)), node: n.getBaseUrl() }),
      this.preferring(node)
    );
  }

  /** The tracker proof of a vote id from the first node that has it, `node` first. */
  getVoteIdProof(processId: string, voteId: bigint | string, node?: string): Promise<TrackerProof> {
    const vid = toVoteId(voteId);
    return this.firstAnswer(n => n.getVoteIdProof(processId, vid), this.preferring(node));
  }

  /**
   * The first answer of `call` over `order` (default: the configured order).
   * It moves on after any sequencer failure but a malformed request (40001),
   * which every node would refuse the same way.
   *
   * @throws The last node's error when none answered
   */
  async firstAnswer<T>(
    call: (node: VocdoniSequencerService) => Promise<T>,
    order: readonly VocdoniSequencerService[] = this.nodes
  ): Promise<T> {
    let last: unknown = new Error('no sequencer node to ask');
    for (const node of order) {
      try {
        return await call(node);
      } catch (err) {
        if (
          !(err instanceof SequencerError) ||
          hasSequencerErrorCode(err, SequencerErrorCode.MalformedRequest)
        ) {
          throw err;
        }
        last = err;
      }
    }
    throw last;
  }

  // `order` (default: the configured order) with the node at `url` first.
  private preferring(
    url?: string,
    order: readonly VocdoniSequencerService[] = this.nodes
  ): VocdoniSequencerService[] {
    if (url === undefined) return [...order];
    const first = this.node(url);
    return [first, ...order.filter(n => n !== first)];
  }
}
