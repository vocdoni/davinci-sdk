import { getAddress, type Provider, type Signer } from 'ethers';
import { VocdoniApiService } from '../api/ApiService';
import type { DocumentOptions } from '../types/uploader';
import { ProcessRegistryService } from '../../contracts/ProcessRegistryService';
import { OnchainCensusService } from '../../contracts/OnchainCensusService';
import { SmartContractService } from '../../contracts/SmartContractService';
import { ContractServiceError } from '../../contracts/errors';
import { KeyMode, ProcessStatus, type OnchainProcess } from '../../contracts/types';
import { CensusWitnessError } from '../../census/errors';
import { checkCensusWitness } from '../../census/witness';
import {
  CensusOrigin,
  type CensusProviders,
  type CensusWitness,
  type CensusWitnessRequest,
  type MerkleCensusWitness,
} from '../../census/types';
import { buildBallot } from '../../crypto/ballot';
import { checkBallot } from '../../crypto/ballotChecker';
import { encodeEcdsaSignature, signVoteId } from '../../crypto/ecdsa';
import { randomBallotSecret } from '../../crypto/encryption';
import { assertFieldElement } from '../../crypto/field';
import { verifyTrackerProof, type TrackerProof } from '../../crypto/tracker';
import { BallotProver, type BallotProof, type ProvableBallot } from '../../prover/BallotProver';
import { BallotProofError } from '../../prover/errors';
import {
  checkProcessView,
  formatVoteId,
  normalizeAddress,
  normalizeProcessId,
  toVoteId,
} from '../../sequencer/api/helpers';
import {
  VoteStatus,
  type ParticipantResponse,
  type ProcessView,
  type VoteRequest,
} from '../../sequencer/api/types';
import {
  SequencerApiError,
  SequencerDecodeError,
  SequencerError,
  SequencerErrorCode,
  SequencerNetworkError,
  hasSequencerErrorCode,
} from '../../sequencer/errors';
import type { VocdoniSequencerService } from '../../sequencer/SequencerService';
import { ProcessOrchestrationService } from '../process/ProcessOrchestrationService';
import { graceEndOf, processPhase } from '../process/lifecycle';
import { ResultsError, VoteError, VoteReceiptError, type VoteErrorReason } from './errors';
import { RecentMap } from './recent';
import {
  decodeResults,
  type ProcessResults,
  type ResultsState,
  type ResultsStatus,
} from './results';

/** How often a status wait asks the nodes, by default. */
export const VOTE_STATUS_POLL_MS = 5_000;

/**
 * What a status wait allows past the grace end by default: by then every
 * vote cast before the end is settled or has failed (`process closed`).
 */
export const VOTE_STATUS_MARGIN_MS = 5 * 60_000;

/** How often `waitForResults` reads the chain, by default. */
export const RESULTS_POLL_MS = 10_000;

/**
 * What `waitForResults` allows past the grace end by default: a sequencer
 * key's results land within a couple of minutes, a DKG committee takes 1 to
 * 5 more.
 */
export const RESULTS_MARGIN_MS = 15 * 60_000;

/** How long `waitForResults({ finalize: true })` leaves the nodes to finalize first. */
export const FINALIZE_AFTER_MS = 60_000;

/**
 * How many voters, and how many votes, a service remembers the node of (the
 * most recent ones).
 */
export const NODE_MEMORY = 1_000;

// A ballot secret below this could be searched for.
const MIN_BALLOT_SECRET = 1n << 128n;

/** A vote to cast. */
export interface VoteConfig {
  /** The process to vote in. */
  processId: string;

  /**
   * The voter's value for each ballot field, in field order: at most the
   * ballot mode's `numFields`, missing ones are zero. For a question whose
   * choices map one to one to fields (every preset), `choices[i]` is the
   * value of the choice with metadata `value` i.
   */
  choices: readonly (number | bigint)[];

  /**
   * The ballot secret: it encrypts the ballot and derives the vote id, so
   * whoever knows it can open the ballot with the election key and tie the
   * vote id to the voter. Default a fresh random one (`randomBallotSecret`),
   * returned in {@link VoteResult.k}. A given one must be as secret and as
   * random, a full-width field element: one below 2^128 is refused, and one
   * derived from anything guessable is as weak. The same secret twice gives
   * the same vote id, which nodes refuse as a duplicate.
   */
  k?: bigint;

  /** @deprecated Use `k`, with its rules. The ballot secret as a decimal or `0x` hex field element. */
  randomness?: string;

  /**
   * The node that took the voter's previous ballot in this process
   * ({@link VoteResult.node}), so a revote queues behind it: one node keeps a
   * voter's ballots in order, two nodes do not. Default: the node this
   * service last sent the voter's ballot to, else the voter's own order. A
   * node that is not among the usable ones is passed over for that default.
   *
   * The service remembers nodes in memory only (the latest
   * {@link NODE_MEMORY} voters): an app that reloads, or casts the revote
   * from another tab or device, should store `VoteResult.node` and pass it
   * back here.
   */
  node?: string;
}

/** A vote the nodes took. */
export interface VoteResult {
  /** `0x` + 16 hex digits. */
  voteId: string;

  /** The voter's signature over the vote id, 65 bytes of `0x` hex. */
  signature: string;

  /** The voter's address, checksummed. */
  voterAddress: string;

  /** `0x` + 62 hex digits. */
  processId: string;

  /** `pending`: queued on the node. */
  status: VoteStatus;

  /**
   * The node that took the vote; ask it for the status, and send a revote
   * there. Store it with the vote: a new SDK instance does not know it.
   */
  node: string;

  /** The census weight the vote carries. */
  weight: bigint;

  /**
   * The ballot secret. With the election key it opens the ballot, and it
   * links the vote id to the voter: keep it private.
   */
  k: bigint;
}

/** A vote's status as a node reports it. */
export interface VoteStatusInfo {
  /** `0x` + 16 hex digits. */
  voteId: string;

  /** Where the vote is: `pending`, `aggregated`, `processed`, `settled` or `error`. */
  status: VoteStatus;

  /**
   * Why, for status `error`: a guest check, `process closed` (still queued
   * when the grace window closed, or the process was canceled), `census
   * changed, recast`, a settlement revert or a prover refusal.
   */
  error?: string;

  /** `0x` + 62 hex digits. */
  processId: string;

  /** The node that answered. */
  node: string;
}

/** Options of a vote status wait. */
export interface VoteStatusWaitOptions {
  /** The status to wait for (or any later one); default `settled`. */
  targetStatus?: VoteStatus;
  /**
   * Longest wait. Default: until the process's grace window closes, plus
   * {@link VOTE_STATUS_MARGIN_MS}, following the end and the window as they
   * move. Nodes batch votes every few minutes to a quarter of an hour, and
   * flush them from shortly before the end through the grace window.
   */
  timeoutMs?: number;
  /** Default {@link VOTE_STATUS_POLL_MS}. */
  pollIntervalMs?: number;
  /** The node that took the vote; default the one this service sent it to. */
  node?: string;
}

/**
 * A vote's receipt (recorded-as-cast): a node's tracker proof that the vote
 * id is a leaf of a state root the registry holds, or held.
 */
export interface VoteReceipt {
  /** `0x` + 62 hex digits. */
  processId: string;
  /** `0x` + 16 hex digits. */
  voteId: string;
  /** The on-chain state root the proof reaches, `bytes32` hex. */
  root: string;
  /**
   * The root is the registry's `latestStateRoot`; else a root of an earlier
   * transition of the process, named by `transactionHash` and `blockNumber`.
   */
  latest: boolean;
  transactionHash?: string;
  blockNumber?: number;
  /** The node that gave the proof. */
  node: string;
  proof: TrackerProof;
}

/** Options of {@link VoteOrchestrationService.waitForResults}. */
export interface WaitForResultsOptions {
  /**
   * Longest wait. Default: until the grace window closes, plus
   * {@link RESULTS_MARGIN_MS}, following the end and the window as they move.
   * A COUNCIL process whose ceremony opens decryption later (state
   * `awaiting-opening`, possibly months later) needs a longer one.
   */
  timeoutMs?: number;
  /** Default {@link RESULTS_POLL_MS}. */
  pollIntervalMs?: number;
  /** Called with the status whenever the state changes. */
  onStatus?: (status: ResultsStatus) => void;
  /**
   * A DKG-locked process whose key is still sealed when the grace window
   * closes: wait for the organizer's `revealProcessKey` instead of failing
   * with `ResultsError('locked')`.
   */
  waitForReveal?: boolean;
  /**
   * DKG keys: when the committee's plaintexts are ready and no node has
   * stored them after `finalizeAfterMs`, send `finalizeResultsFromDKG`
   * (permissionless) from the SDK's signer, which pays its gas. Off by
   * default: nodes finalize within seconds, and a browser wallet would ask
   * its user to sign.
   */
  finalize?: boolean;
  /** Default {@link FINALIZE_AFTER_MS}. */
  finalizeAfterMs?: number;
}

/** What the vote orchestration needs besides the registry, the nodes and the signer. */
export interface VoteOrchestrationOptions {
  /**
   * Proves a built ballot under the registry's ballot VK. Default a
   * {@link BallotProver} with the pinned circuit files.
   */
  prove?: (ballot: ProvableBallot) => Promise<BallotProof>;
  /** Reads census contracts (origin 3). Default the signer's provider. */
  provider?: Provider;
  /** Census witness providers: the CSP's attestations, a custom Merkle source. */
  censusProviders?: CensusProviders;
  /** How metadata documents are read for the decoded results. */
  documents?: DocumentOptions;
  /** The registry with a signer, to send `finalizeResultsFromDKG` (see `waitForResults`). */
  writer?: () => ProcessRegistryService;
}

const STATUS_ORDER = [
  VoteStatus.Pending,
  VoteStatus.Aggregated,
  VoteStatus.Processed,
  VoteStatus.Settled,
];

// What a process whose results did not come was still waiting for.
const WAITING_FOR: Record<ResultsState, string> = {
  voting: 'voting has not ended',
  grace: 'the grace window is still open',
  'awaiting-key-holder': 'only the node that issued the election key can publish them',
  'awaiting-request': 'no node has asked the DKG committee to decrypt',
  locked: 'the organizer has not revealed the DKG-locked key',
  'awaiting-opening': 'the Council ceremony has not opened decryption',
  decrypting: 'the DKG committee has not combined its decryption',
  finalizable: 'nobody has stored the decrypted tally (finalizeResultsFromDKG)',
  results: 'the results are on-chain',
  canceled: 'the process was canceled',
};

// What `status` is still waiting for, with the Council opening date if known.
function waitingFor(status: ResultsStatus): string {
  const opening = status.decryptionOpening;
  if (!opening) return WAITING_FOR[status.state];
  const at = opening.opensAt?.toISOString();
  const how =
    opening.mode === 'scheduled'
      ? `it opens on ${at ?? 'its scheduled date'}`
      : at
        ? `its organizer opens it, or it opens on ${at}`
        : 'its organizer opens it';
  return `${WAITING_FOR[status.state]} (${how})`;
}

// `status` is `target` or a later step (an error is reached only as the target).
function reached(status: VoteStatus, target: VoteStatus): boolean {
  if (status === target) return true;
  if (status === VoteStatus.Error || target === VoteStatus.Error) return false;
  return STATUS_ORDER.indexOf(status) >= STATUS_ORDER.indexOf(target);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// A node failure the next node may not share: anything but a malformed request.
const nodeFailure = (err: unknown): boolean =>
  err instanceof SequencerError && !hasSequencerErrorCode(err, SequencerErrorCode.MalformedRequest);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const toDate = (seconds: bigint): Date => new Date(Number(seconds) * 1000);

// A registry time as a Date; null beyond the Date range.
const dateOrNull = (seconds: bigint): Date | null =>
  seconds <= 8_640_000_000_000n ? toDate(seconds) : null;

// Local time at which chain time `at` falls, given the chain head `now`.
function localTime(at: bigint, now: bigint): number {
  if (at > now + 8_640_000_000n) return Infinity;
  return Date.now() + Number(at - now) * 1000;
}

// What a node's refusal of a vote means.
function voteErrorOf(err: unknown): unknown {
  if (err instanceof SequencerNetworkError) {
    return new VoteError('unavailable', `no node took the vote: ${err.message}`, {
      node: err.node,
      cause: err,
    });
  }
  if (!(err instanceof SequencerApiError)) return err;
  const byCode: Partial<Record<number, VoteErrorReason>> = {
    [SequencerErrorCode.InvalidVote]: 'invalid',
    [SequencerErrorCode.BodyTooLarge]: 'invalid',
    [SequencerErrorCode.DuplicateVote]: 'duplicate',
    [SequencerErrorCode.SlotBusy]: 'slot-busy',
    [SequencerErrorCode.NotAcceptingVotes]: 'closed',
    [SequencerErrorCode.MaxVotersReached]: 'max-voters',
    [SequencerErrorCode.NotStarted]: 'not-started',
    [SequencerErrorCode.Busy]: 'busy',
    [SequencerErrorCode.UnknownProcess]: 'unavailable',
    [SequencerErrorCode.ObserverNode]: 'unavailable',
  };
  let reason = err.code === undefined ? undefined : byCode[err.code];
  if (err.code === SequencerErrorCode.MalformedRequest) {
    reason = /not in the census/.test(err.message) ? 'not-in-census' : 'invalid';
  }
  reason ??=
    err.status === 429
      ? 'busy'
      : err.status === 408 || err.status >= 500
        ? 'unavailable'
        : 'invalid';
  const what = reason === 'unavailable' ? 'no node took the vote' : 'the vote was refused';
  return new VoteError(reason, `${what}: ${err.message}`, {
    node: err.node,
    code: err.code,
    cause: err,
  });
}

// A ballot secret given by the caller: a field element too large to search for.
function strongSecret(k: bigint, what: string): bigint {
  assertFieldElement(k, what);
  if (k < MIN_BALLOT_SECRET) {
    throw new RangeError(
      `${what} is below 2^128: a ballot secret must be a random field element ` +
        '(randomBallotSecret), or anyone can search for it and open the ballot'
    );
  }
  return k;
}

// The ballot secret of a vote config.
function secretOf(config: VoteConfig): bigint {
  if (config.k !== undefined) return strongSecret(config.k, 'k');
  if (config.randomness !== undefined) {
    const r = config.randomness.trim();
    if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(r)) {
      throw new RangeError('randomness is not a decimal or 0x hex integer');
    }
    return strongSecret(BigInt(r), 'randomness');
  }
  return randomBallotSecret();
}

/**
 * The voter's side of an election: cast a vote, follow it, get its receipt,
 * check a voter's census membership, and wait for the results.
 *
 * Election parameters come from the registry, never from a node: a node
 * could hand out its own key or census. The node a vote goes to is only
 * cross-checked against it.
 */
export class VoteOrchestrationService {
  private readonly prove: (ballot: ProvableBallot) => Promise<BallotProof>;
  private readonly provider?: Provider;
  private readonly censusProviders: CensusProviders;
  private readonly writer?: () => ProcessRegistryService;
  private readonly reader: ProcessOrchestrationService;
  // The node that took each voter's last ballot, and each vote, from this service.
  private readonly voterNodes = new RecentMap<string, string>(NODE_MEMORY);
  private readonly voteNodes = new RecentMap<string, string>(NODE_MEMORY);

  /**
   * @param registry - The registry for reads (a provider is enough)
   * @param api - The sequencer nodes
   * @param signer - The voter: it signs vote ids, and needs no provider
   * @param options - Prover, census providers, documents and the finalize writer
   */
  constructor(
    private readonly registry: ProcessRegistryService,
    private readonly api: VocdoniApiService,
    private readonly signer: Signer,
    options: VoteOrchestrationOptions = {}
  ) {
    if (options.prove) {
      this.prove = options.prove;
    } else {
      const prover = new BallotProver();
      this.prove = async ballot => prover.prove(ballot, await registry.getBallotVKHash());
    }
    this.provider = options.provider ?? signer.provider ?? undefined;
    this.censusProviders = options.censusProviders ?? {};
    this.writer = options.writer;
    this.reader = new ProcessOrchestrationService(registry, api, signer, {
      documents: options.documents,
    });
  }

  // A node URL this service can send to; undefined for an unknown one.
  private usable(node: string | undefined): string | undefined {
    return node !== undefined && this.api.nodes.urls.includes(node) ? node : undefined;
  }

  // `order` with the node at `url` first.
  private preferring(
    url: string | undefined,
    order: VocdoniSequencerService[]
  ): VocdoniSequencerService[] {
    if (url === undefined) return order;
    const first = this.api.nodes.node(url);
    return [first, ...order.filter(n => n !== first)];
  }

  // ─── VOTING ────────────────────────────────────────────────────────

  /**
   * Casts a vote:
   *
   * 1. Reads the process from the registry and the chain clock, and refuses
   *    a process that does not take votes (`not-started`, `closed`).
   * 2. Cross-checks the process with the view of the voter's node (key,
   *    ballot mode, census).
   * 3. Gets the voter's census witness: the nodes' participant proof (static
   *    and updatable Merkle censuses, root pinned to the registry's), the
   *    census contract's weight (on-chain census), or the CSP's attestation
   *    (`censusProviders.csp`), and checks it is the voter's.
   * 4. Checks the choices against the ballot mode, builds the 16-field
   *    ballot, proves it and signs its vote id.
   * 5. Sends it to the voter's node (`pickNode`), failing over when that is
   *    safe; a revote goes to the node of the voter's previous ballot. That
   *    node is remembered in memory only: across reloads, tabs or devices,
   *    store `VoteResult.node` and pass it back as `VoteConfig.node`.
   *
   * @throws RangeError for a ballot secret `k` below 2^128
   * @throws VoteError for a refusal, with its {@link VoteErrorReason}
   * @throws CensusWitnessError for a witness that is not the voter's
   * @throws ArtifactError or BallotProofError when the ballot cannot be proved
   * @throws SequencerDecodeError when the node's view of the process is not the registry's
   */
  async submitVote(config: VoteConfig): Promise<VoteResult> {
    const processId = normalizeProcessId(config.processId);
    const voter = getAddress(await this.signer.getAddress());
    const nodes = this.api.nodes;
    const k = secretOf(config);

    // 1. The election and the clock
    const [p, now] = await Promise.all([
      this.registry.getProcess(processId),
      this.registry.getChainTime(),
    ]);
    this.checkOpen(p, now);

    // 2. The node's view
    const preferred =
      this.usable(config.node) ?? this.usable(this.voterNodes.get(`${processId}|${voter}`));
    await this.crossCheck(p, this.preferring(preferred, nodes.order(voter, processId)));

    // 3. The census
    const witness = await this.witnessOf(p, voter);
    if (!witness) {
      throw new VoteError('not-in-census', `${voter} is not in the census of ${processId}`);
    }
    const { weight, censusProof } = await checkCensusWitness(p, voter, witness);

    // 4. The ballot, its proof and the signature
    if (!config.choices.every(c => typeof c === 'bigint' || Number.isSafeInteger(c))) {
      throw new VoteError('invalid', 'the choices must be integers');
    }
    const check = checkBallot(config.choices, p.ballotMode, weight);
    if (!check.valid) {
      throw new VoteError('invalid', `the choices do not fit the ballot mode: ${check.error}`);
    }
    const built = await buildBallot({
      processId,
      address: voter,
      encryptionKey: p.encryptionKey,
      ballotMode: p.ballotMode,
      fields: config.choices,
      weight,
      k,
    });
    const { proof, publicSignals } = await this.prove(built);
    if (publicSignals.join() !== built.publicSignals.join()) {
      throw new BallotProofError("the proof's public signals are not the ballot's");
    }
    const signature = encodeEcdsaSignature(await signVoteId(this.signer, built.voteId));

    // 5. Submission. A Merkle proof is left out: nodes derive their own.
    const request: VoteRequest = {
      processId,
      address: voter,
      voteId: built.voteId,
      ballot: built.ballot,
      ballotProof: proof,
      ballotInputsHash: built.inputsHash,
      signature,
      weight,
      ...(censusProof?.type === 'csp' && { censusProof }),
    };
    let node: string;
    try {
      ({ node } = await nodes.submitVote(request, preferred));
    } catch (err) {
      throw voteErrorOf(err);
    }
    const voteId = formatVoteId(built.voteId);
    this.voterNodes.set(`${processId}|${voter}`, node);
    this.voteNodes.set(`${processId}|${voteId}`, node);
    return {
      voteId,
      signature,
      voterAddress: voter,
      processId,
      status: VoteStatus.Pending,
      node,
      weight,
      k,
    };
  }

  // Refuses a process that takes no votes at chain time `now`. A paused
  // process still takes them: they settle once it resumes.
  private checkOpen(p: OnchainProcess, now: bigint): void {
    const end = p.startTime + p.duration;
    if (
      p.status === ProcessStatus.ENDED ||
      p.status === ProcessStatus.CANCELED ||
      p.status === ProcessStatus.RESULTS
    ) {
      throw new VoteError(
        'closed',
        `process ${p.processId} is ${ProcessStatus[p.status]}: it takes no votes`
      );
    }
    if (now >= end) {
      throw new VoteError(
        'closed',
        `voting in process ${p.processId} ended at ${toDate(end).toISOString()}`
      );
    }
    if (now < p.startTime) {
      throw new VoteError(
        'not-started',
        `process ${p.processId} opens at ${toDate(p.startTime).toISOString()}`
      );
    }
  }

  // The first node of `order` that serves the process must report the
  // registry's key, ballot mode and census. An updatable census's root moves
  // with each update, and a node may trail it by a few blocks.
  private async crossCheck(p: OnchainProcess, order: VocdoniSequencerService[]): Promise<void> {
    let last: unknown;
    const notes: string[] = [];
    for (const node of order) {
      let view: ProcessView;
      try {
        view = await node.getProcess(p.processId);
      } catch (err) {
        if (!nodeFailure(err)) throw err;
        last = err;
        continue;
      }
      if (view.ignored) {
        notes.push(`${node.getBaseUrl()} ignores it${view.note ? `: ${view.note}` : ''}`);
        continue;
      }
      const seen =
        p.census.origin === CensusOrigin.OffchainDynamic
          ? { ...view, census: { ...view.census, censusRoot: BigInt(p.census.root) } }
          : view;
      try {
        checkProcessView(seen, p);
      } catch (err) {
        throw new SequencerDecodeError(
          `sequencer ${node.getBaseUrl()}: ${message(err)}`,
          node.getBaseUrl()
        );
      }
      return;
    }
    const why = [...notes, ...(last === undefined ? [] : [message(last)])].join('; ');
    throw new VoteError('unavailable', `no node serves process ${p.processId}: ${why}`, {
      ...(last instanceof SequencerError && { node: last.node }),
      ...(last instanceof SequencerApiError && { code: last.code }),
      cause: last,
    });
  }

  // The voter's census witness for `p`: null when the voter is not a member.
  private async witnessOf(p: OnchainProcess, voter: string): Promise<CensusWitness | null> {
    const origin = p.census.origin;
    const request: CensusWitnessRequest = {
      processId: p.processId,
      address: voter,
      origin,
      censusRoot: p.census.root,
      ...(origin === CensusOrigin.Onchain && { contractAddress: p.census.contractAddress }),
    };
    if (origin === CensusOrigin.CSP) {
      const csp = this.censusProviders.csp;
      if (!csp) {
        throw new CensusWitnessError(
          `process ${p.processId} has a CSP census: set censusProviders.csp to get the voter's attestation`
        );
      }
      return { type: 'csp', attestation: await csp(request) };
    }
    if (
      origin !== CensusOrigin.OffchainStatic &&
      origin !== CensusOrigin.OffchainDynamic &&
      origin !== CensusOrigin.Onchain
    ) {
      throw new CensusWitnessError(`census origin ${String(origin)} is not supported`);
    }
    if (this.censusProviders.merkle) return this.censusProviders.merkle(request);
    if (origin === CensusOrigin.Onchain) {
      if (!this.provider) {
        throw new CensusWitnessError('reading an on-chain census needs a provider');
      }
      const contract = new OnchainCensusService(p.census.contractAddress, this.provider);
      const weight = await contract.weightOf(voter);
      return weight === 0n ? null : { type: 'merkle', weight };
    }
    return this.participantWitness(p, voter);
  }

  // A Merkle member's weight and proof from the nodes, at the registry's
  // census root. Null only when every node answers that there is no such
  // member: one that fails or trails the census may be the one that has it.
  private async participantWitness(
    p: OnchainProcess,
    voter: string
  ): Promise<MerkleCensusWitness | null> {
    const failures: string[] = [];
    let last: unknown;
    for (const node of this.api.nodes.order(voter, p.processId)) {
      let answer: ParticipantResponse;
      try {
        answer = await node.getParticipant(p.processId, voter);
      } catch (err) {
        if (hasSequencerErrorCode(err, SequencerErrorCode.NotFound)) continue;
        if (!nodeFailure(err)) throw err;
        failures.push(message(err));
        last = err;
        continue;
      }
      if (answer.censusProof.root === BigInt(p.census.root)) {
        return { type: 'merkle', weight: answer.weight, proof: answer.censusProof };
      }
      // A node trailing an updated census answers from its previous root.
      last = new CensusWitnessError(
        `sequencer ${node.getBaseUrl()} has census root ${answer.censusProof.root}, ` +
          `the registry ${BigInt(p.census.root)}`
      );
      failures.push((last as Error).message);
    }
    if (failures.length === 0) return null;
    throw new VoteError(
      'unavailable',
      `no node could tell whether ${voter} is in the census of ${p.processId}: ` +
        failures.join('; '),
      {
        ...(last instanceof SequencerError && { node: last.node }),
        ...(last instanceof SequencerApiError && { code: last.code }),
        cause: last,
      }
    );
  }

  // ─── VOTE STATUS AND RECEIPTS ──────────────────────────────────────

  /**
   * The status of a vote, from the node that took it first (`node`, or the
   * one this service sent it to), then the others. A node that never held
   * the vote answers `settled` once the vote id is in its tree.
   *
   * @throws SequencerApiError 40401 when no node knows the vote
   */
  async getVoteStatus(
    processId: string,
    voteId: string | bigint,
    node?: string
  ): Promise<VoteStatusInfo> {
    const pid = normalizeProcessId(processId);
    const id = formatVoteId(toVoteId(voteId));
    const s = await this.api.nodes.getVoteStatus(
      pid,
      id,
      this.usable(node ?? this.voteNodes.get(`${pid}|${id}`))
    );
    return {
      voteId: id,
      status: s.status,
      ...(s.error !== undefined && { error: s.error }),
      processId: pid,
      node: s.node,
    };
  }

  // Local time by which every vote of the process is settled or failed.
  private async voteDeadline(processId: string): Promise<number> {
    const [p, now, grace] = await Promise.all([
      this.registry.getProcess(processId),
      this.registry.getChainTime(),
      this.reader.getGraceParams(),
    ]);
    return localTime(graceEndOf(p, grace.graceMaxTotal), now) + VOTE_STATUS_MARGIN_MS;
  }

  /**
   * Follows a vote's status, yielding each change, until it reaches
   * `targetStatus` (or a later step: `settled` also ends a wait for
   * `processed`) or fails. A vote may go back to `pending` when its batch
   * loses a race or the process is paused.
   *
   * @throws VoteError `timeout` when the wait runs out
   */
  async *watchVoteStatus(
    processId: string,
    voteId: string | bigint,
    options: VoteStatusWaitOptions = {}
  ): AsyncGenerator<VoteStatusInfo> {
    const target = options.targetStatus ?? VoteStatus.Settled;
    const poll = options.pollIntervalMs ?? VOTE_STATUS_POLL_MS;
    const fixed = options.timeoutMs !== undefined;
    let deadline = fixed
      ? Date.now() + (options.timeoutMs as number)
      : await this.voteDeadline(processId);
    let previous: VoteStatus | undefined;
    for (;;) {
      const info = await this.getVoteStatus(processId, voteId, options.node);
      if (info.status !== previous) {
        previous = info.status;
        yield info;
        if (reached(info.status, target) || info.status === VoteStatus.Error) return;
      }
      // The end and the grace window move: read them again before giving up.
      if (Date.now() >= deadline && !fixed) deadline = await this.voteDeadline(processId);
      if (Date.now() >= deadline) {
        throw new VoteError(
          'timeout',
          `vote ${info.voteId} is ${info.status}, not ${target}, after the wait`,
          { node: info.node }
        );
      }
      await sleep(Math.max(0, Math.min(poll, deadline - Date.now())));
    }
  }

  /**
   * {@link watchVoteStatus}, returning the last status: the target (or a
   * later step), or `error` with its reason.
   *
   * @throws VoteError `timeout` when the wait runs out
   */
  async waitForVoteStatus(
    processId: string,
    voteId: string | bigint,
    options: VoteStatusWaitOptions = {}
  ): Promise<VoteStatusInfo> {
    let last: VoteStatusInfo | undefined;
    for await (const info of this.watchVoteStatus(processId, voteId, options)) last = info;
    return last as VoteStatusInfo;
  }

  /**
   * A settled vote's receipt: a node's tracker proof, checked to reach the
   * registry's latest state root, or, when a transition landed in between
   * (or the node trails the chain), the root of one of the process's
   * transitions (`ProcessStateTransitioned`).
   *
   * @throws VoteReceiptError when no node holds the vote yet, or the proof
   *   reaches no state root of the process
   */
  async getVoteReceipt(
    processId: string,
    voteId: string | bigint,
    node?: string
  ): Promise<VoteReceipt> {
    const pid = normalizeProcessId(processId);
    const vid = toVoteId(voteId);
    const id = formatVoteId(vid);
    const nodes = this.api.nodes;
    const order = this.preferring(this.usable(node ?? this.voteNodes.get(`${pid}|${id}`)), [
      ...nodes.nodes,
    ]);
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    let answer: { proof: TrackerProof; node: string };
    let p: OnchainProcess;
    for (let attempt = 0; ; attempt++) {
      try {
        [answer, p] = await Promise.all([
          nodes.firstAnswer(
            async n => ({ proof: await n.getVoteIdProof(pid, vid), node: n.getBaseUrl() }),
            order
          ),
          this.registry.getProcess(pid),
        ]);
      } catch (err) {
        if (!hasSequencerErrorCode(err, SequencerErrorCode.NotFound)) throw err;
        throw new VoteReceiptError(
          `no node holds vote ${id} in its tree yet: it has not settled`,
          undefined,
          err
        );
      }
      if (same(answer.proof.root, p.latestStateRoot)) {
        if (verifyTrackerProof(answer.proof, p.latestStateRoot)) {
          return { processId: pid, voteId: id, root: p.latestStateRoot, latest: true, ...answer };
        }
        break;
      }
      // A transition may have landed between the two reads: once more.
      if (attempt === 1) break;
    }
    const { proof, node: from } = answer;
    // An earlier root of the process (or a later one the read RPC has not seen).
    if (!same(proof.root, p.latestStateRoot) && verifyTrackerProof(proof, proof.root)) {
      // Newest blocks first, in windows public RPCs accept: the root is usually recent.
      for await (const events of this.registry.eventWindows({
        processId: pid,
        fromBlock: Number(p.creationBlock),
      })) {
        const landed = events.find(
          e =>
            e.name === 'ProcessStateTransitioned' &&
            e.processId === pid &&
            same(e.newStateRoot, proof.root)
        );
        if (landed?.name === 'ProcessStateTransitioned') {
          return {
            processId: pid,
            voteId: id,
            root: landed.newStateRoot,
            latest: false,
            transactionHash: landed.transactionHash,
            blockNumber: landed.blockNumber,
            node: from,
            proof,
          };
        }
      }
    }
    throw new VoteReceiptError(
      `the tracker proof of vote ${id} from ${from} does not reach a state root of process ${pid}`,
      from
    );
  }

  // ─── CENSUS AND BALLOTS ────────────────────────────────────────────

  /**
   * Whether a node holds a ballot in `address`'s slot, which happens once a
   * batch with its vote settles. Every node is asked. A Merkle census slot
   * follows from the address, so any node that answers will do; a CSP slot
   * comes from the CSP's index, which only the nodes that took the voter's
   * ballot know, so then every node must answer.
   *
   * @throws the error of a node that did not answer, when the answer depends on it
   */
  async hasAddressVoted(processId: string, address: string): Promise<boolean> {
    const pid = normalizeProcessId(processId);
    const addr = normalizeAddress(address);
    const nodes = this.api.nodes;
    const [p, answers] = await Promise.all([
      this.registry.getProcess(pid),
      Promise.allSettled(nodes.nodes.map(n => n.hasAddressVoted(pid, addr))),
    ]);
    if (answers.some(a => a.status === 'fulfilled' && a.value)) return true;
    const failed = answers.filter((a): a is PromiseRejectedResult => a.status === 'rejected');
    const enough =
      p.census.origin === CensusOrigin.CSP ? failed.length === 0 : failed.length < answers.length;
    if (enough) return false;
    throw failed[0].reason;
  }

  /**
   * Whether `address` can vote: a member of a Merkle census (the nodes'
   * proof at the registry's root, or the census contract's weight), or, for
   * a CSP census, an address the CSP attests (`censusProviders.csp`; its
   * errors propagate). A node that fails or trails the census makes it
   * `VoteError('unavailable')` rather than false.
   */
  async isAddressAbleToVote(processId: string, address: string): Promise<boolean> {
    return (await this.getAddressWeight(processId, address)) > 0n;
  }

  /**
   * The census weight `address` votes with; 0 for a non-member. For a CSP
   * census it is the weight the CSP attests (`censusProviders.csp`).
   *
   * @throws CensusWitnessError for a witness that is not the address's
   * @throws VoteError `unavailable` when no node can tell: a node failed, or
   *   trails an updated census, and none has the member
   */
  async getAddressWeight(processId: string, address: string): Promise<bigint> {
    const pid = normalizeProcessId(processId);
    const voter = getAddress(normalizeAddress(address));
    const p = await this.registry.getProcess(pid);
    const witness = await this.witnessOf(p, voter);
    if (!witness) return 0n;
    return (await checkCensusWitness(p, voter, witness)).weight;
  }

  // ─── RESULTS ───────────────────────────────────────────────────────

  /**
   * Where a process stands on the way to its results (see `ResultsState`),
   * with the decoded tally once it is on-chain.
   */
  async getResultsStatus(processId: string): Promise<ResultsStatus> {
    const pid = normalizeProcessId(processId);
    const [p, now, grace] = await Promise.all([
      this.registry.getProcess(pid),
      this.registry.getChainTime(),
      this.reader.getGraceParams(),
    ]);
    const graceEnd = graceEndOf(p, grace.graceMaxTotal);
    const base = {
      processId: p.processId,
      keyMode: p.keyMode,
      graceEnd: dateOrNull(graceEnd),
      chainTime: toDate(now),
    };
    switch (processPhase(p, now, graceEnd)) {
      case 'results':
        return {
          ...base,
          state: 'results',
          results: decodeResults(await this.reader.getProcess(pid)),
        };
      case 'canceled':
        return { ...base, state: 'canceled' };
      case 'closing':
        return { ...base, state: 'grace' };
      case 'ended':
        break;
      default:
        return { ...base, state: 'voting' };
    }
    const dkg = p.dkg;
    if (p.keyMode === KeyMode.Sequencer || !dkg) return { ...base, state: 'awaiting-key-holder' };
    const gate = await this.registry.getCouncilDecryptionGate(dkg);
    if (!gate.open) {
      return {
        ...base,
        state: 'awaiting-opening',
        decryptionOpening: {
          mode: gate.mode,
          opensAt: gate.opensAt === null ? null : dateOrNull(gate.opensAt),
        },
      };
    }
    if (dkg.locked && !(await this.registry.isProcessKeyRevealed(dkg))) {
      return { ...base, state: 'locked' };
    }
    if (!dkg.resultsRequested) return { ...base, state: 'awaiting-request' };
    const { ready } = await this.registry.getDkgPlaintexts(dkg);
    return { ...base, state: ready ? 'finalizable' : 'decrypting' };
  }

  /**
   * Waits for a process's results and returns them decoded. Results unlock
   * when the grace window after the end closes; then the node holding a
   * sequencer key publishes them, or a DKG committee decrypts them (after
   * the organizer's reveal, for a locked key; for a COUNCIL key, once its
   * ceremony opens decryption). `onStatus` sees each state.
   *
   * @throws ResultsError `canceled`; `locked` when a DKG-locked key is still
   *   sealed after the grace window (unless `waitForReveal`); `timeout`, whose
   *   message says what the process was still waiting for (with the Council
   *   opening date, if any)
   * @throws with `finalize`: an Error when there is no signer to send it, or
   *   the ProcessResultError of a transaction that fails for another reason
   *   than a node finalizing first
   *
   * @example
   * ```typescript
   * const results = await sdk.waitForResults(processId, {
   *   onStatus: s => console.log(s.state, s.graceEnd),
   * });
   * ```
   */
  async waitForResults(
    processId: string,
    options: WaitForResultsOptions = {}
  ): Promise<ProcessResults> {
    const pid = normalizeProcessId(processId);
    const poll = options.pollIntervalMs ?? RESULTS_POLL_MS;
    const fixedDeadline =
      options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;
    let last: ResultsStatus | undefined;
    let finalizableSince: number | undefined;
    for (;;) {
      const status = await this.getResultsStatus(pid);
      if (status.state !== last?.state) options.onStatus?.(status);
      last = status;
      switch (status.state) {
        case 'results':
          return status.results as ProcessResults;
        case 'canceled':
          throw new ResultsError(
            'canceled',
            `process ${pid} was canceled: it has no results`,
            status
          );
        case 'locked':
          if (!options.waitForReveal) {
            throw new ResultsError(
              'locked',
              `process ${pid} has a DKG-locked key that is still sealed: its organizer must ` +
                'call revealProcessKey before the committee decrypts the results',
              status
            );
          }
          break;
        case 'finalizable':
          if (options.finalize) {
            finalizableSince ??= Date.now();
            if (Date.now() - finalizableSince >= (options.finalizeAfterMs ?? FINALIZE_AFTER_MS)) {
              await this.finalize(pid);
              finalizableSince = undefined;
              continue;
            }
          }
          break;
      }
      if (status.state !== 'finalizable') finalizableSince = undefined;
      const deadline =
        fixedDeadline ??
        (status.graceEnd === null
          ? Infinity
          : Date.now() +
            (status.graceEnd.getTime() - status.chainTime.getTime()) +
            RESULTS_MARGIN_MS);
      if (Date.now() >= deadline) {
        throw new ResultsError(
          'timeout',
          `process ${pid} has no results after the wait: ${waitingFor(status)}`,
          status
        );
      }
      await sleep(Math.max(0, Math.min(poll, deadline - Date.now())));
    }
  }

  // The permissionless DKG nudge; a node that got there first is no error.
  private async finalize(processId: string): Promise<void> {
    if (!this.writer) {
      throw new Error('finalizing DKG results needs the registry with a signer (writer)');
    }
    try {
      await SmartContractService.executeTx(this.writer().finalizeResultsFromDKG(processId));
    } catch (err) {
      const race = ['ResultsNotReady', 'InvalidStatus', 'GraceOpen'];
      if (err instanceof ContractServiceError && race.includes(err.revertName ?? '')) return;
      throw err;
    }
  }
}
