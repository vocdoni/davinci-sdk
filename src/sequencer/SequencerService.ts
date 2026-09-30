import { BaseService, BaseServiceConfig } from '../core/api/BaseService';
import { type BjjPoint, bjjInSubgroup, bjjIsIdentity } from '../crypto/babyjubjub';
import { censusLeaf, verifyLeanIMTProof } from '../crypto/census';
import type { TrackerProof } from '../crypto/tracker';
import {
  BallotResponse,
  ParticipantResponse,
  ProcessView,
  SequencerInfo,
  TransitionView,
  VoteRequest,
  VoteStatusResponse,
} from './api/types';
import { formatVoteId, normalizeAddress, normalizeProcessId, toVoteId } from './api/helpers';
import {
  decodeBallotResponse,
  decodeBlobs,
  decodeEncryptionKey,
  decodeInfo,
  decodeParticipant,
  decodeProcessList,
  decodeProcessView,
  decodeTrackerProof,
  decodeTransitions,
  decodeVoteResponse,
  decodeVoteStatus,
  encodeVoteRequest,
} from './api/wire';
import {
  SequencerApiError,
  SequencerDecodeError,
  SequencerErrorCode,
  SequencerNetworkError,
  hasSequencerErrorCode,
} from './errors';

/** Per-request timeout: the node answers 408 at 60 s. */
export const SEQUENCER_TIMEOUT_MS = 60_000;
/** Largest answer read: six blobs as hex are about 1.6 MB. */
export const SEQUENCER_MAX_RESPONSE_BYTES = 16 << 20;
/** Longest error text kept from an answer. */
const MAX_ERROR_LENGTH = 4096;

/**
 * Client for one DAVINCI sequencer node (davinci-sequencer HTTP API). Every
 * answer is decoded strictly and checked where the client can: the election
 * key must be a prime-order point, a participant proof must be the address's
 * own and verify, a tracker proof and a vote acknowledgement must be for the
 * vote asked about.
 *
 * Failures are {@link SequencerApiError} (an error answer, with its
 * {@link SequencerErrorCode}), {@link SequencerNetworkError} (no answer) or
 * {@link SequencerDecodeError} (an answer that does not check out).
 *
 * For several nodes, {@link SequencerNodes} routes votes and fails over.
 *
 * @example
 * ```typescript
 * const node = new VocdoniSequencerService('https://node.example');
 * const info = await node.getInfo();
 * ```
 */
export class VocdoniSequencerService extends BaseService {
  /**
   * @param baseURL - Node base URL
   * @param config - Headers, `fetchImpl`, and the timeout (default 60 s) and body cap (default 16 MiB)
   */
  constructor(baseURL: string, config: BaseServiceConfig = {}) {
    super(baseURL, {
      timeoutMs: SEQUENCER_TIMEOUT_MS,
      maxResponseBytes: SEQUENCER_MAX_RESPONSE_BYTES,
      ...config,
    });
  }

  protected httpError(status: number, statusText: string, payload: unknown): Error {
    let message = statusText || `HTTP ${status}`;
    let code: number | undefined;
    if (typeof payload === 'object' && payload !== null) {
      const body = payload as { error?: unknown; code?: unknown };
      if (typeof body.error === 'string' && Number.isInteger(body.code)) {
        message = body.error;
        code = body.code as number;
      }
    } else if (typeof payload === 'string' && payload) {
      message = payload;
    }
    return new SequencerApiError(
      message.slice(0, MAX_ERROR_LENGTH),
      status,
      code,
      this.getBaseUrl()
    );
  }

  protected transportError(err: unknown, timedOut: boolean): Error {
    const message = err instanceof Error ? err.message : String(err);
    return new SequencerNetworkError(
      timedOut ? `request timed out: ${message}` : message,
      timedOut,
      err,
      this.getBaseUrl()
    );
  }

  // Decodes an answer, naming this node in the error.
  private decoded<T>(decode: (json: unknown) => T, json: unknown): T {
    try {
      return decode(json);
    } catch (err) {
      if (err instanceof SequencerDecodeError) {
        throw new SequencerDecodeError(err.message, this.getBaseUrl());
      }
      throw err;
    }
  }

  private async get<T>(url: string, decode: (json: unknown) => T): Promise<T> {
    return this.decoded(decode, await this.request<unknown>({ method: 'GET', url }));
  }

  private mismatch(message: string): SequencerDecodeError {
    return new SequencerDecodeError(message, this.getBaseUrl());
  }

  /** `GET /ping`: resolves when the node answers. */
  async ping(): Promise<void> {
    await this.request({ method: 'GET', url: '/ping' });
  }

  /** `GET /info`: the node's chain, registry, pins and whether it is an observer. */
  getInfo(): Promise<SequencerInfo> {
    return this.get('/info', decodeInfo);
  }

  /** `GET /processes`: the process ids this node knows (one deployment per node). */
  listProcesses(): Promise<string[]> {
    return this.get('/processes', decodeProcessList);
  }

  /**
   * `GET /processes/{processId}`: the on-chain parameters plus the node's
   * view. Build ballots from the registry, not from this; see `checkProcessView`.
   */
  getProcess(processId: string): Promise<ProcessView> {
    return this.get(`/processes/${normalizeProcessId(processId)}`, decodeProcessView);
  }

  /**
   * `POST /processes/keys`: this node's election key for `processId`, usually
   * the registry's `getNextProcessId(organizer)`. The same id always gets the
   * same key, and only this node can decrypt the results under it. Rate
   * limited (42901) and refused by observers (41203).
   *
   * @returns The key, checked to be a prime-order, non-identity point
   */
  async getEncryptionKey(processId: string): Promise<BjjPoint> {
    const json = await this.request<unknown>({
      method: 'POST',
      url: '/processes/keys',
      data: { processId: normalizeProcessId(processId) },
    });
    const key = this.decoded(decodeEncryptionKey, json);
    if (bjjIsIdentity(key) || !bjjInSubgroup(key)) {
      throw this.mismatch('encryption key is not a prime-order point');
    }
    return key;
  }

  /**
   * `GET /processes/{processId}/participants/{address}`: the address's weight
   * and Merkle census proof. The proof must be for the address's own leaf and
   * verify; its root is left to the caller to compare with the registry's.
   * 40401 for a non-member and for every CSP census.
   */
  async getParticipant(processId: string, address: string): Promise<ParticipantResponse> {
    const addr = normalizeAddress(address);
    const p = await this.get(
      `/processes/${normalizeProcessId(processId)}/participants/${addr}`,
      decodeParticipant
    );
    let leaf: bigint;
    try {
      leaf = censusLeaf(addr, p.weight);
    } catch {
      throw this.mismatch('participant weight does not fit a census leaf');
    }
    if (
      p.address.toLowerCase() !== addr ||
      p.censusProof.leaf !== leaf ||
      !(await verifyLeanIMTProof(p.censusProof))
    ) {
      throw this.mismatch('participant proof is not for this address');
    }
    return p;
  }

  /** The census weight of `address` (from {@link getParticipant}). */
  async getAddressWeight(processId: string, address: string): Promise<bigint> {
    return (await this.getParticipant(processId, address)).weight;
  }

  /** Whether `address` is in the process's Merkle census on this node; false on 40401. */
  async isAddressAbleToVote(processId: string, address: string): Promise<boolean> {
    try {
      await this.getParticipant(processId, address);
      return true;
    } catch (err) {
      if (hasSequencerErrorCode(err, SequencerErrorCode.NotFound)) return false;
      throw err;
    }
  }

  /** `GET /processes/{processId}/transitions`: the settled transitions this node archived. */
  getTransitions(processId: string): Promise<TransitionView[]> {
    return this.get(`/processes/${normalizeProcessId(processId)}/transitions`, decodeTransitions);
  }

  /** `GET /processes/{processId}/transitions/{index}/blobs`: that transition's raw blobs, `0x` hex. */
  getTransitionBlobs(processId: string, index: number): Promise<string[]> {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new RangeError('transition index must be a non-negative integer');
    }
    return this.get(
      `/processes/${normalizeProcessId(processId)}/transitions/${index}/blobs`,
      decodeBlobs
    );
  }

  /**
   * `POST /votes`. Resolves once the node admitted the vote; the vote id it
   * acknowledges must be the one sent.
   *
   * A 408 or a lost answer does not mean the vote was refused: a retry to the
   * same node then answers 409 {@link SequencerErrorCode.DuplicateVote}.
   * {@link SequencerNodes.submitVote} applies these rules.
   */
  async submitVote(vote: VoteRequest): Promise<void> {
    const json = await this.request<unknown>({
      method: 'POST',
      url: '/votes',
      data: encodeVoteRequest(vote),
    });
    if (this.decoded(decodeVoteResponse, json) !== vote.voteId) {
      throw this.mismatch('sequencer acknowledged another vote id');
    }
  }

  /**
   * `GET /votes/{processId}/voteId/{voteId}`: the status, with the error text
   * of an `error` vote. A node that never stored the vote answers `settled`
   * if the id is in its tree, else 40401.
   */
  getVoteStatus(processId: string, voteId: bigint | string): Promise<VoteStatusResponse> {
    return this.get(
      `/votes/${normalizeProcessId(processId)}/voteId/${formatVoteId(toVoteId(voteId))}`,
      decodeVoteStatus
    );
  }

  /**
   * `GET /votes/{processId}/voteId/{voteId}/proof`: the tracker proof of a
   * settled vote id, checked to be for that vote. Verify it with
   * `verifyTrackerProof` against the registry's `latestStateRoot` (or a root
   * of the process's transition history), never against its own root.
   */
  async getVoteIdProof(processId: string, voteId: bigint | string): Promise<TrackerProof> {
    const pid = normalizeProcessId(processId);
    const vid = toVoteId(voteId);
    const proof = await this.get(
      `/votes/${pid}/voteId/${formatVoteId(vid)}/proof`,
      decodeTrackerProof
    );
    if (proof.voteId !== vid || proof.processId !== pid) {
      throw this.mismatch('tracker proof for another vote');
    }
    return proof;
  }

  /**
   * `GET /votes/{processId}/address/{address}`: the ballot now in the voter's
   * slot, re-encrypted (silent refreshes re-randomize it, so it only shows
   * the slot is taken). For a CSP census only addresses this node served.
   */
  getBallot(processId: string, address: string): Promise<BallotResponse> {
    return this.get(
      `/votes/${normalizeProcessId(processId)}/address/${normalizeAddress(address)}`,
      decodeBallotResponse
    );
  }

  /** Whether this node holds a ballot in the voter's slot; false on 40401. */
  async hasAddressVoted(processId: string, address: string): Promise<boolean> {
    try {
      await this.getBallot(processId, address);
      return true;
    } catch (err) {
      if (hasSequencerErrorCode(err, SequencerErrorCode.NotFound)) return false;
      throw err;
    }
  }
}
