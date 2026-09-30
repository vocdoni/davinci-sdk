import { Interface, Signer, getAddress } from 'ethers';
import { VocdoniApiService } from '../api/ApiService';
import { ProcessRegistryService } from '../../contracts/ProcessRegistryService';
import {
  CensusNotUpdatable,
  ContractServiceError,
  DkgDisabledError,
  ProcessCensusError,
  ProcessCreateError,
  ProcessDurationError,
  ProcessGraceError,
  ProcessKeyRevealError,
  ProcessMaxVotersError,
  ProcessMetadataError,
  ProcessStatusError,
  WrongProcessIdError,
} from '../../contracts/errors';
import {
  DAVINCI_ERRORS_ABI,
  decodeDavinciError,
  type DavinciErrorDescription,
} from '../../contracts/abis';
import { RESULT_CAP } from '../../contracts/params';
import {
  KeyMode,
  ProcessStatus,
  type GraceParams,
  type OnchainDkg,
  type OnchainProcess,
  type RegistryCensus,
} from '../../contracts/types';
import { BJJ_SUBGROUP_ORDER, type BjjPoint } from '../../crypto/babyjubjub';
import type { BallotModeValues } from '../../crypto/ballot';
import { VALUE_SUM_BITS } from '../../protocol/limits';
import { computeProcessId } from '../../networks';
import { BallotMode } from '../types';
import {
  BallotModeError,
  ElectionPreset,
  ballotModeValues,
  parseElectionPresetFromMetadata,
  resolveElectionPreset,
} from '../types/ballot';
import { CensusOrigin } from '../../census/types';
import { CensusError } from '../../census/errors';
import { publishCensus, verifyCensusUrl } from '../../census/publish';
import {
  buildElectionMetadata,
  fetchMetadataHash,
  localizedText,
  publishMetadata,
  readMetadata,
  type MetadataStatus,
  type PublishedMetadata,
} from '../metadata';
import type {
  ElectionMetadata,
  ElectionMetadataConfig,
  LocalizedText,
  QuestionConfig,
} from '../types/metadata';
import type { DocumentOptions, Uploader } from '../types/uploader';
import {
  SmartContractService,
  TxStatusEvent,
  TxStatus,
} from '../../contracts/SmartContractService';
import { Census } from '../../census/classes/Census';
import { MerkleCensus } from '../../census/classes/MerkleCensus';
import { OnchainCensus } from '../../census/classes/OnchainCensus';
import { PublishedCensus } from '../../census/classes/PublishedCensus';
import { OffchainDynamicCensus } from '../../census/classes/OffchainDynamicCensus';
import { graceEndOf, processPhase, type ProcessPhase } from './lifecycle';
import { serialized } from './signerLock';

/**
 * Base interface with shared fields between ProcessConfig and ProcessInfo
 */
export interface BaseProcess {
  /** Process title */
  title: string;

  /** Process description (optional) */
  description?: string;

  /** Census configuration */
  census: {
    /** Census origin */
    type: CensusOrigin;
    /** Census root, `bytes32` hex: the lean-IMT root, or the CSP address */
    root: string;
    /** Census URI */
    uri: string;
    /** The census contract of an on-chain census */
    contractAddress?: string;
  };

  /** Ballot configuration */
  ballot: BallotMode;

  /** Election questions and choices (required) */
  questions: Array<ProcessQuestion>;
}

/**
 * A question as `getProcess` reads it from the metadata: its text in the
 * default language, and each choice's ballot field (`value`).
 */
export type ProcessQuestion = {
  title: string;
  description?: string;
  choices: Array<{
    title: string;
    value: number;
  }>;
};

/**
 * A census given by hand: what the registry stores. Prefer a census object,
 * which the SDK publishes and checks.
 */
export interface CensusConfig {
  /** Census origin */
  type: CensusOrigin;
  /** Lean-IMT root, CSP address, or zero for an on-chain census; `bytes32` hex */
  root: string;
  /** Census URI */
  uri: string;
  /** The census contract (origin 3 only) */
  contractAddress?: string;
  /** @deprecated Ignored; give `maxVoters`. */
  size?: number;
}

/**
 * Who holds a new process's election key, by name (the registry's
 * {@link KeyMode} works too):
 *
 * - `'sequencer'`: the key node issues it for the id the registry assigns
 *   next. Only that node can publish the results, and it could open every
 *   ballot.
 * - `'dkg'` (DKG_AUTOMATIC): a davinci-dkg committee key. No single party
 *   holds the secret; the committee decrypts the final tally after the grace
 *   window.
 * - `'dkg-locked'` (DKG_LOCKED): a committee key plus an organizer key. The
 *   creation returns the organizer secret, and nothing is decrypted until it
 *   is revealed (`revealProcessKey`).
 */
export type ProcessKeyMode = 'sequencer' | 'dkg' | 'dkg-locked';

/**
 * Base configuration shared by both process creation variants
 */
interface BaseProcessConfig {
  /**
   * The census: a census object, or its registry form. A Merkle census
   * object not yet published is uploaded through the SDK's uploader and
   * checked as nodes will read it. A Merkle census URL given by hand is
   * checked the same way (unless `documents.verify` is false), since a
   * census the nodes cannot load leaves the process ignored.
   */
  census: Census | CensusConfig;

  /**
   * Ballot configuration. Mutually exclusive with `electionPreset`:
   * provide one or the other.
   *
   * For common voting modes, prefer `electionPreset` — it derives the
   * raw `BallotMode` from a friendly typed shape. Use this field when
   * you need to express a ballot that does not map to a preset. It must
   * fit the registry and the ballot circuit (`ballotModeValues`). A
   * `maxValueSum` of 0 makes each voter's census weight the budget: the
   * circuit compares it in 63 bits, so no weight may reach 2^63.
   */
  ballot?: BallotMode;

  /**
   * Election preset configuration (alternative to `ballot`).
   *
   * Pass a discriminated value like `{ type: 'rating', maxValue: 5 }`
   * and the SDK resolves it to a `BallotMode` using
   * `questions[0].choices.length` (at most 16) as `numFields`. Mutually
   * exclusive with `ballot`. Requires the metadata-driven config variant
   * (`questions` must be present); not usable with `metadataUri`.
   */
  electionPreset?: ElectionPreset;

  /**
   * Process timing: a duration or an end date. Times are checked against the
   * chain clock (the latest block), which is what the registry uses.
   */
  timing: {
    /**
     * Start (Date, ISO string or unix timestamp). Omitted or 0: the process
     * starts in the block that creates it. A start must be after the chain
     * head's time, with room for the transaction to land, or the registry
     * refuses it (`InvalidStartTime`).
     */
    startDate?: Date | string | number;
    /** Duration in seconds (required if endDate is not provided) */
    duration?: number;
    /**
     * End (Date, ISO string or unix timestamp), instead of `duration`. With no
     * `startDate` the duration runs from the chain head's time, so the end
     * falls as much later as the transaction takes to land.
     */
    endDate?: Date | string | number;
  };

  /**
   * Maximum number of voters allowed for this process. Defaults to the
   * member count of a Merkle census object; required for every other census.
   * The registry caps `maxValue * maxVoters` at 1e12 (`RESULT_CAP`).
   */
  maxVoters?: number;

  /** Who holds the election key; `'sequencer'` by default. See {@link ProcessKeyMode}. */
  keyMode?: KeyMode | ProcessKeyMode;

  /**
   * The grace window, in seconds, instead of the registry's `defaultGrace`:
   * the idle time after the last landing that closes the window and unlocks
   * the results. It must be within `graceFloor..graceCeil` (see
   * `getGraceParams`), checked before anything is created; `setProcessGrace`
   * sends it right after the creation. A live meeting uses the floor (150 s
   * on the production registry) so results follow the close within minutes.
   */
  grace?: number;

  /**
   * Create the process PAUSED instead of READY (the registry takes either).
   * Nodes take its votes once it starts but settle none until
   * `resumeProcess`; still paused at its end, it settles through the grace
   * window like an ended one. `getProcess` reports the phase `paused` until
   * then.
   */
  paused?: boolean;
}

/**
 * Process configuration with the metadata fields: the SDK builds the
 * metadata document (`buildElectionMetadata`), publishes it through its
 * uploader and registers its URL and hash.
 */
export interface ProcessConfigWithMetadata extends BaseProcessConfig {
  /** Process title, plain or in several languages */
  title: LocalizedText;

  /** Process description (optional) */
  description?: LocalizedText;

  /** Election questions and choices (at least one required) */
  questions: [QuestionConfig, ...QuestionConfig[]];

  /** Header and logo image URLs */
  media?: { header?: string; logo?: string };
}

/**
 * Process configuration with a metadata document already served: no upload
 * happens.
 */
export interface ProcessConfigWithMetadataUri extends BaseProcessConfig {
  /** Where the metadata document is served */
  metadataUri: string;
  /**
   * SHA-256 of the exact bytes served at `metadataUri` (`metadataHash()`);
   * computed by downloading the URI when omitted.
   */
  metadataHash?: string;
}

/**
 * Configuration for creating a process
 * Use either metadata fields (title, questions) or a pre-existing metadataUri
 */
export type ProcessConfig = ProcessConfigWithMetadata | ProcessConfigWithMetadataUri;

/**
 * Result of process creation
 */
export interface ProcessCreationResult {
  /** The created process ID, from the receipt's `ProcessCreated` event */
  processId: string;
  /** Transaction hash of the on-chain process creation */
  transactionHash: string;
  /**
   * `'dkg-locked'` processes only: the organizer secret `revealProcessKey`
   * needs to unlock the results. The SDK keeps no copy and never logs it:
   * store it safely, or the results never unlock.
   */
  organizerSecret?: bigint;
  /** With `grace`: the grace window set after the creation, and its transaction. */
  grace?: { seconds: number; transactionHash: string };
  /**
   * With `grace`, when its transaction failed after the process was created:
   * the process exists with the registry's default grace window. Retry with
   * `setProcessGrace`.
   */
  graceError?: Error;
}

/**
 * What `updateCensus` moves an updatable (origin 2) process to: a census
 * object (published first when needed), or the root and URL of a census
 * file already served.
 */
export type CensusUpdate = OffchainDynamicCensus | PublishedCensus | { root: string; uri: string };

/**
 * What `updateMetadata` moves a process to: a document to publish (built
 * from a config, a document, or exact bytes), or one already served, with
 * its hash or to be hashed from the URL.
 */
export type MetadataUpdate =
  | ElectionMetadataConfig
  | ElectionMetadata
  | Uint8Array
  | { uri: string; hash?: string };

/** What the process orchestration needs besides the registry and the nodes. */
export interface ProcessOrchestrationOptions {
  /** Publishes census files and metadata documents. */
  uploader?: Uploader;
  /** How documents are downloaded and checked. */
  documents?: DocumentOptions;
}

/** Options of `closeProcessIn`. */
export interface CloseProcessOptions {
  /**
   * Seconds added past the notice for the transaction's own inclusion: the
   * registry checks the notice when the transaction lands. Default 45
   * (`SHORTEN_SLACK_SECONDS`, what a live chain needs); a local chain that
   * mines at once can use a few seconds.
   */
  slack?: number;
}

/** Which processes `cancelOpenProcesses` looks at. */
export interface CancelOpenProcessesOptions {
  /** These processes; by default the ones this SDK instance created. */
  processIds?: readonly string[];
  /**
   * Every process the signer ever created on the registry (read by process
   * nonce, one registry read each), instead of this session's.
   */
  all?: boolean;
}

/** What `cancelOpenProcesses` did. */
export interface CancelOpenProcessesResult {
  /** Processes that were READY or PAUSED and are now CANCELED. */
  canceled: string[];
  /** Processes that could not be read or canceled, and why. */
  failed: { processId: string; error: Error }[];
}

/** A change of a process's end: the new duration from its start. */
export interface DurationChange {
  success: boolean;
  /** The new duration, in seconds from the start time. */
  duration: bigint;
}

// A process creation, checked and with its documents published.
interface PreparedCreation {
  status: ProcessStatus.READY | ProcessStatus.PAUSED;
  grace?: number;
  startTime: bigint;
  duration: bigint;
  maxVoters: bigint;
  ballotMode: BallotModeValues;
  keyMode: KeyMode;
  census: RegistryCensus;
  metadata: PublishedMetadata;
}

/**
 * User-friendly process information that extends the base process with additional runtime data
 */
export interface ProcessInfo extends BaseProcess {
  /** The process ID */
  processId: string;

  /** Current process status (the registry's) */
  status: ProcessStatus;

  /**
   * Where the process stands, from its status and the chain clock:
   * `upcoming`, `open`, `paused`, `closing` (past the end, the grace window
   * still records batches), `ended` (results pending), `results` or
   * `canceled`.
   */
  phase: ProcessPhase;

  /** Process creator address */
  creator: string;

  /** Who holds the election key. */
  keyMode: KeyMode;

  /** The DKG side of a DKG-keyed process. */
  dkg?: OnchainDkg;

  /** Start date as Date object */
  startDate: Date;

  /** End date as Date object: voting closes here */
  endDate: Date;

  /** Duration in seconds */
  duration: number;

  /**
   * Seconds to the end while voting runs, 0 from the end on, and minus the
   * seconds to the start before it (chain time).
   */
  timeRemaining: number;

  /** Idle seconds after the last landing that close the grace window. */
  grace: number;

  /** Block time of the latest state transition; null before the first. */
  lastVoteAt: Date | null;

  /**
   * When the grace window closes: `min(end + graceMaxTotal,
   * max(end, lastVoteAt) + grace)`. Batches of votes cast before the end
   * still land until then; results unlock at it. Null when it never closes
   * (an end within `graceMaxTotal` of 2^256, beyond any date).
   */
  graceEnd: Date | null;

  /** The chain head's time `phase` and `timeRemaining` were computed at. */
  chainTime: Date;

  /** Latest state root (raw arbo root, `bytes32` hex). */
  stateRoot: string;

  /** Maximum number of voters allowed */
  maxVoters: number;

  /** Process results (array of BigInt values) */
  result: bigint[];

  /** Number of votes cast */
  votersCount: number;

  /** Number of vote overwrites */
  overwrittenVotesCount: number;

  /** Metadata URI */
  metadataURI: string;

  /** SHA-256 of the metadata document the organizer committed, `bytes32` hex */
  metadataHash: string;

  /**
   * The document at `metadataURI` hashes to `metadataHash`. Title,
   * description, questions and preset come from the document only then.
   */
  metadataVerified: boolean;

  /**
   * `verified`; `mismatch` (the URL serves another document); `unreachable`;
   * or `refused` (not an `http(s)` URL on a public host, so never requested).
   */
  metadataStatus: MetadataStatus;

  /** Why the metadata is not verified, or why the verified document is not JSON. */
  metadataError?: string;

  /** The verified metadata document, with every language. */
  metadata?: ElectionMetadata;

  /** Raw contract data (for advanced users) */
  raw?: OnchainProcess;

  /**
   * Election preset used to create the process, recovered from
   * off-chain metadata. Absent when the process was created with a
   * raw `BallotMode`, when metadata is unavailable, or when the
   * stored value doesn't match a recognized preset shape. The raw
   * `ballot: BallotMode` field is always present regardless.
   */
  electionPreset?: ElectionPreset;
}

type ErrorClass = new (
  message: string,
  operation: string,
  revert?: DavinciErrorDescription,
  cause?: unknown
) => ContractServiceError;

type Done = { success: boolean };

const errorsInterface = new Interface(DAVINCI_ERRORS_ABI);

// The error `ErrorType` raises for a rule the SDK checks before sending,
// carrying the registry error the transaction would revert with.
function refused(
  ErrorType: ErrorClass,
  operation: string,
  message: string,
  revertName?: string
): ContractServiceError {
  const fragment = revertName ? errorsInterface.getError(revertName) : null;
  const revert = fragment
    ? (decodeDavinciError(errorsInterface.encodeErrorResult(fragment, [])) ?? undefined)
    : undefined;
  return new ErrorType(message, operation, revert);
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

// A unix time for messages.
function when(seconds: bigint): string {
  return seconds < 8_640_000_000_000n
    ? new Date(Number(seconds) * 1000).toISOString()
    : `${seconds} (unix)`;
}

const toDate = (seconds: bigint): Date => new Date(Number(seconds) * 1000);

// A registry time as a Date; null beyond the Date range.
const dateOrNull = (seconds: bigint): Date | null =>
  seconds <= 8_640_000_000_000n ? toDate(seconds) : null;

const isOpenStatus = (s: ProcessStatus) => s === ProcessStatus.READY || s === ProcessStatus.PAUSED;

const endOf = (p: OnchainProcess): bigint => p.startTime + p.duration;

// A grace window the registry takes: whole seconds within `graceFloor..graceCeil`.
function checkGrace(grace: number, params: GraceParams): void {
  if (!Number.isInteger(grace) || grace < params.graceFloor || grace > params.graceCeil) {
    throw refused(
      ProcessGraceError,
      'setProcessGrace',
      `grace ${String(grace)} is outside the registry's ${params.graceFloor}..${params.graceCeil} seconds`,
      'InvalidGrace'
    );
  }
}

function keyModeOf(mode: KeyMode | ProcessKeyMode | undefined): KeyMode {
  if (mode === undefined || mode === 'sequencer' || mode === KeyMode.Sequencer) {
    return KeyMode.Sequencer;
  }
  if (mode === 'dkg' || mode === KeyMode.DkgAutomatic) return KeyMode.DkgAutomatic;
  if (mode === 'dkg-locked' || mode === KeyMode.DkgLocked) return KeyMode.DkgLocked;
  throw new ProcessCreateError(`unknown key mode ${String(mode)}`, 'newProcess');
}

// A count given as a JS number: a positive safe integer.
function positiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// A `bytes32` metadata hash; zero is what the registry refuses.
function metadataHashOf(hash: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash) || BigInt(hash) === 0n) {
    throw new Error(`metadataHash ${hash} is not a non-zero 32-byte hex hash`);
  }
  return hash.toLowerCase();
}

// Questions of a verified document, in the default language.
function questionsOf(doc: Record<string, unknown>): ProcessQuestion[] {
  if (!Array.isArray(doc.questions)) return [];
  return doc.questions.filter(isObject).map(q => ({
    title: localizedText(q.title) ?? '',
    description: localizedText(q.description),
    choices: (Array.isArray(q.choices) ? q.choices : [])
      .filter(isObject)
      .filter(c => typeof c.value === 'number')
      .map(c => ({ title: localizedText(c.title) ?? '', value: c.value as number })),
  }));
}

/**
 * Creates processes and runs the organizer controls. Every control reads the
 * process and the chain clock first and refuses what the registry would
 * revert, with the operation's error class and the registry error name in
 * `revertName`; the registry service then simulates the call before signing,
 * which stays the final word.
 */
export class ProcessOrchestrationService {
  private readonly uploader?: Uploader;
  private readonly documents: DocumentOptions;
  private readonly created: string[] = [];
  private graceParams?: Promise<GraceParams>;

  constructor(
    private processRegistry: ProcessRegistryService,
    private apiService: VocdoniApiService,
    private signer: Signer,
    options: ProcessOrchestrationOptions = {}
  ) {
    this.uploader = options.uploader;
    this.documents = options.documents ?? {};
  }

  /**
   * The processes this service created, in order, including one that landed
   * under an unexpected id (`WrongProcessIdError`).
   */
  get createdProcesses(): readonly string[] {
    return [...this.created];
  }

  private requireUploader(what: string): Uploader {
    if (!this.uploader) {
      throw new Error(
        `publishing ${what} needs an uploader: configure \`uploader\` in the SDK, ` +
          'or serve the document yourself and pass its URL'
      );
    }
    return this.uploader;
  }

  /**
   * The registry form of a process's census: a Merkle census object is
   * published when it is not yet, an on-chain one is checked to be a
   * davinci-zkvm census contract, and a Merkle census URL given by hand is
   * checked as nodes read it.
   */
  private async handleCensus(census: ProcessConfig['census']): Promise<RegistryCensus> {
    if (census instanceof Census) {
      if (census instanceof MerkleCensus && !census.isPublished) {
        await publishCensus(census, this.requireUploader('the census file'), this.documents);
      } else if (
        census instanceof PublishedCensus &&
        census.requiresPublishing &&
        this.documents.verify !== false
      ) {
        await verifyCensusUrl(
          census.censusURI as string,
          census.censusRoot as string,
          this.documents
        );
      }
      if (census instanceof OnchainCensus) {
        await census.check(this.signer.provider ?? this.signer);
      }
      return census.toRegistryCensus();
    }
    const { type, root, uri, contractAddress } = census;
    if (
      (type === CensusOrigin.OffchainStatic || type === CensusOrigin.OffchainDynamic) &&
      this.documents.verify !== false
    ) {
      await verifyCensusUrl(uri, root, this.documents);
    }
    return { origin: type, root, uri, ...(contractAddress && { contractAddress }) };
  }

  /** The metadata URL and hash: a document built and published, or one already served. */
  private async handleMetadata(config: ProcessConfig): Promise<PublishedMetadata> {
    if ('metadataUri' in config) {
      const uri = config.metadataUri;
      const hash =
        config.metadataHash !== undefined
          ? metadataHashOf(config.metadataHash)
          : await fetchMetadataHash(uri, this.documents);
      return { uri, hash };
    }
    const document = buildElectionMetadata({
      title: config.title,
      description: config.description,
      questions: config.questions,
      electionPreset: config.electionPreset,
      media: config.media,
    });
    return publishMetadata(document, this.requireUploader('the metadata document'), this.documents);
  }

  // ─── READS ─────────────────────────────────────────────────────────

  /**
   * The registry's grace window immutables (`defaultGrace`, `graceFloor`,
   * `graceCeil`, `graceMaxTotal`, `noticeMin`), read once.
   */
  getGraceParams(): Promise<GraceParams> {
    this.graceParams ??= this.processRegistry.getGraceParams().catch((err: unknown) => {
      this.graceParams = undefined;
      throw err;
    });
    return this.graceParams;
  }

  /**
   * When a process's grace window closes (`getProcessGraceEnd`): batches of
   * votes cast before the end land until then, and results unlock at it.
   * Every landing after the end pushes it out, up to `end + graceMaxTotal`.
   * Null when the registry holds no such process (it answers 0) or the
   * window never closes (an end within `graceMaxTotal` of 2^256).
   */
  async getGraceEnd(processId: string): Promise<Date | null> {
    const end = await this.processRegistry.getProcessGraceEnd(processId);
    return end === 0n ? null : dateOrNull(end);
  }

  /**
   * Gets user-friendly process information by transforming raw contract data.
   * The metadata document is downloaded and checked against the registry's
   * `metadataHash`; title, description, questions and preset are read from it
   * only when it matches (`metadataVerified`). The grace window and the phase
   * are computed from the same registry read and the chain head's time.
   *
   * @param processId - The process ID to fetch
   * @returns Promise resolving to the user-friendly process information
   */
  async getProcess(processId: string): Promise<ProcessInfo> {
    // 1. The process, the chain clock and the grace window cap
    const [rawProcess, now, grace] = await Promise.all([
      this.processRegistry.getProcess(processId),
      this.processRegistry.getChainTime(),
      this.getGraceParams(),
    ]);

    // 2. Fetch the metadata and check it against its on-chain hash
    const read = rawProcess.metadataUri
      ? await readMetadata(rawProcess.metadataUri, rawProcess.metadataHash, this.documents)
      : { status: 'unreachable' as const, error: 'the process has no metadata URI' };
    const doc = read.status === 'verified' && isObject(read.document) ? read.document : undefined;

    // 3. Timing, on the chain clock
    const { startTime, duration } = rawProcess;
    const endTime = startTime + duration;
    const timeRemaining =
      now >= endTime ? 0n : now >= startTime ? endTime - now : -(startTime - now);
    const graceEnd = graceEndOf(rawProcess, grace.graceMaxTotal);

    // 4. Transform census information
    const census: ProcessInfo['census'] = {
      type: rawProcess.census.origin,
      root: rawProcess.census.root,
      uri: rawProcess.census.uri || '',
      ...(rawProcess.census.origin === CensusOrigin.Onchain && {
        contractAddress: rawProcess.census.contractAddress,
      }),
    };

    // 5. Transform ballot mode (convert BigInt fields to appropriate types)
    const ballot: BallotMode = {
      numFields: Number(rawProcess.ballotMode.numFields),
      groupSize: Number(rawProcess.ballotMode.groupSize),
      maxValue: rawProcess.ballotMode.maxValue.toString(),
      minValue: rawProcess.ballotMode.minValue.toString(),
      uniqueValues: rawProcess.ballotMode.uniqueValues,
      costExponent: Number(rawProcess.ballotMode.costExponent),
      maxValueSum: rawProcess.ballotMode.maxValueSum.toString(),
      minValueSum: rawProcess.ballotMode.minValueSum.toString(),
    };

    // 5b. Extract election preset from metadata (if present)
    const electionPreset = parseElectionPresetFromMetadata(
      doc as { meta?: { electionPreset?: unknown } } | undefined
    );

    // 6. Return user-friendly process info
    return {
      processId: rawProcess.processId,
      title: localizedText(doc?.title) ?? '',
      description: localizedText(doc?.description),
      census,
      ballot,
      questions: doc ? questionsOf(doc) : [],
      status: rawProcess.status,
      phase: processPhase(rawProcess, now, graceEnd),
      creator: rawProcess.organizationId,
      keyMode: rawProcess.keyMode,
      ...(rawProcess.dkg && { dkg: rawProcess.dkg }),
      startDate: toDate(startTime),
      endDate: toDate(endTime),
      duration: Number(duration),
      timeRemaining: Number(timeRemaining),
      grace: rawProcess.grace,
      lastVoteAt: rawProcess.lastVoteAt === 0n ? null : toDate(rawProcess.lastVoteAt),
      graceEnd: dateOrNull(graceEnd),
      chainTime: toDate(now),
      stateRoot: rawProcess.latestStateRoot,
      maxVoters: Number(rawProcess.maxVoters),
      result: rawProcess.result,
      votersCount: Number(rawProcess.votersCount),
      overwrittenVotesCount: Number(rawProcess.overwrittenVotesCount),
      metadataURI: rawProcess.metadataUri,
      metadataHash: rawProcess.metadataHash,
      metadataVerified: read.status === 'verified',
      metadataStatus: read.status,
      ...(read.error !== undefined && { metadataError: read.error }),
      ...(doc && { metadata: doc as unknown as ElectionMetadata }),
      raw: rawProcess,
      ...(electionPreset && { electionPreset }),
    };
  }

  // ─── CREATION ──────────────────────────────────────────────────────

  /**
   * Creates a process and yields its transaction's status events.
   *
   * 1. Checks the config against the registry and the circuit: the timing on
   *    the chain clock, the ballot mode, `maxVoters` and the result cap, and
   *    for a `'dkg'`/`'dkg-locked'` key that the registry has a DKG adapter.
   * 2. Publishes the census and the metadata document (or checks the ones
   *    given by URL).
   * 3. Under a lock per account (so concurrent creations from one account
   *    never race for an id), reads the id the registry assigns next; in
   *    `'sequencer'` mode asks the key node for that id's key (a prime-order
   *    point, or the request fails); then simulates and sends `newProcess`.
   *    A `'dkg-locked'` creation draws the organizer secret and proves it for
   *    the registration epoch and the process's DKG application id. A DKG
   *    creation is retried once when the epoch's key pool is exhausted or,
   *    for `'dkg-locked'`, when the registration epoch moved: that yields a
   *    second `Pending`. A `paused` config creates it PAUSED.
   * 4. With `grace` (checked against the registry's bounds in step 1),
   *    `setProcessGrace` follows: a `Pending` event with
   *    `step: 'setProcessGrace'`, then the `Completed` event, which carries
   *    `grace` or, if that transaction failed, `graceError`. The process
   *    exists either way, so the creation still completes.
   *
   * The id comes from the receipt's `ProcessCreated` event. A sequencer-key
   * process created under another id than its key's fails the stream with
   * `WrongProcessIdError`: the process exists but no node can finalize it,
   * so cancel it (`cancelOpenProcesses` finds it). Failures come as `Failed`
   * events: a `ProcessCreateError` (with `revertName` for a rule the registry
   * enforces), `DkgDisabledError`, a census, metadata or sequencer error.
   *
   * @param config - Process configuration
   * @returns AsyncGenerator yielding transaction status events with ProcessCreationResult
   *
   * @example
   * ```typescript
   * for await (const event of orchestrator.createProcessStream({ ...config, keyMode: 'dkg-locked' })) {
   *   if (event.status === TxStatus.Pending) console.log('sent', event.hash);
   *   if (event.status === TxStatus.Completed) {
   *     keep(event.response.processId, event.response.organizerSecret); // needed to unlock the results
   *   }
   *   if (event.status === TxStatus.Failed || event.status === TxStatus.Reverted) {
   *     console.error(event.error);
   *   }
   * }
   * ```
   */
  async *createProcessStream(
    config: ProcessConfig
  ): AsyncGenerator<TxStatusEvent<ProcessCreationResult>> {
    let prepared: PreparedCreation;
    let account: string;
    try {
      prepared = await this.prepareProcessCreation(config);
      account = getAddress(await this.signer.getAddress());
    } catch (err) {
      yield { status: TxStatus.Failed, error: asError(err) };
      return;
    }
    const lock = `${this.processRegistry.address}:${account}`.toLowerCase();
    yield* serialized(lock, () => this.sendCreation(prepared, account));
  }

  /**
   * Creates a process and waits for it: {@link createProcessStream}, drained.
   * For a `'dkg-locked'` process the result carries `organizerSecret`; store
   * it, or the results never unlock.
   *
   * @param config - Process configuration
   * @returns Promise resolving to the process creation result
   * @throws the stream's `Failed` or `Reverted` error
   */
  async createProcess(config: ProcessConfig): Promise<ProcessCreationResult> {
    return SmartContractService.executeTx(this.createProcessStream(config));
  }

  // Everything that can be refused locally, then the documents; no id yet.
  private async prepareProcessCreation(config: ProcessConfig): Promise<PreparedCreation> {
    const create = (message: string, revertName?: string) =>
      refused(ProcessCreateError, 'newProcess', message, revertName);

    const keyMode = keyModeOf(config.keyMode);
    const now = await this.processRegistry.getChainTime();
    const { startTime, duration } = this.calculateTiming(config.timing, now);

    let ballotMode: BallotModeValues;
    try {
      ballotMode = ballotModeValues(this.resolveBallotConfig(config));
    } catch (err) {
      if (err instanceof BallotModeError) throw create(err.message, err.registryError);
      throw err;
    }

    // maxVoters: given, or the members of a Merkle census object
    const census = config.census;
    let maxVoters: number;
    if (config.maxVoters !== undefined) {
      if (!positiveInt(config.maxVoters)) {
        throw create(
          `maxVoters ${String(config.maxVoters)} is not a positive integer`,
          'InvalidMaxVoters'
        );
      }
      maxVoters = config.maxVoters;
    } else if (census instanceof MerkleCensus) {
      if (census.size === 0) throw new CensusError('the census has no members');
      maxVoters = census.size;
    } else {
      throw new Error(
        'maxVoters is required. It can only be omitted for a Merkle census object ' +
          '(OffchainCensus/OffchainDynamicCensus), whose member count it defaults to.'
      );
    }
    const cap = RESULT_CAP / BigInt(maxVoters);
    if (ballotMode.maxValue > cap) {
      throw create(
        `maxValue ${ballotMode.maxValue} with ${maxVoters} voters exceeds the registry's result ` +
          `cap of ${RESULT_CAP}: at most ${cap} per field`,
        'MaxPossibleResultCapExceeded'
      );
    }

    // A zero maxValueSum makes the weight the budget, compared in 63 bits.
    if (ballotMode.maxValueSum === 0n && census instanceof MerkleCensus) {
      const heavy = census.participants.find(
        p => BigInt(p.weight) >> BigInt(VALUE_SUM_BITS) !== 0n
      );
      if (heavy) {
        throw create(
          `${heavy.key} has weight ${heavy.weight}: with maxValueSum 0 the weight is the ` +
            `voter's budget, which the ballot circuit compares in ${VALUE_SUM_BITS} bits, ` +
            `so it must stay below 2^${VALUE_SUM_BITS}`
        );
      }
    }

    // The grace window to set after the creation, within the registry's bounds.
    const grace = config.grace;
    if (grace !== undefined) {
      const params = await this.getGraceParams();
      checkGrace(grace, params);
    }

    if (keyMode !== KeyMode.Sequencer && (await this.processRegistry.getDkgAdapter()) === null) {
      throw new DkgDisabledError(
        'the registry has no DKG adapter: DKG key modes are disabled',
        'newProcess'
      );
    }

    // Census, then metadata: published (or checked) before any id or key.
    const registryCensus = await this.handleCensus(census);
    const metadata = await this.handleMetadata(config);
    return {
      status: config.paused === true ? ProcessStatus.PAUSED : ProcessStatus.READY,
      ...(grace !== undefined && { grace }),
      startTime,
      duration,
      maxVoters: BigInt(maxVoters),
      ballotMode,
      keyMode,
      census: registryCensus,
      metadata,
    };
  }

  // Under the account's lock: the next id, its key, and the transaction.
  private async *sendCreation(
    p: PreparedCreation,
    account: string
  ): AsyncGenerator<TxStatusEvent<ProcessCreationResult>> {
    let processId: string;
    let encryptionKey: BjjPoint | undefined;
    try {
      processId = await this.processRegistry.getNextProcessId(account);
      if (p.keyMode === KeyMode.Sequencer) {
        encryptionKey = await this.apiService.sequencer.getEncryptionKey(processId);
      }
    } catch (err) {
      yield { status: TxStatus.Failed, error: asError(err) };
      return;
    }
    const stream = this.processRegistry.createProcess({
      status: p.status,
      startTime: p.startTime,
      duration: p.duration,
      maxVoters: p.maxVoters,
      ballotMode: p.ballotMode,
      census: p.census,
      metadataUri: p.metadata.uri,
      metadataHash: p.metadata.hash,
      processId,
      keyMode: p.keyMode,
      ...(encryptionKey && { encryptionKey }),
    });
    let created: ProcessCreationResult | undefined;
    for await (const event of stream) {
      if (event.status === TxStatus.Completed) {
        this.created.push(event.response.processId);
        created = event.response;
        if (p.grace !== undefined) continue;
      } else if (event.status === TxStatus.Failed && event.error instanceof WrongProcessIdError) {
        this.created.push(event.error.created);
      }
      yield event;
    }
    if (!created || p.grace === undefined) return;
    yield* this.sendGrace(created, p.grace);
  }

  // The grace window of a process just created: its own transaction, reported
  // as a `setProcessGrace` step. The process exists whatever happens to it.
  private async *sendGrace(
    created: ProcessCreationResult,
    seconds: number
  ): AsyncGenerator<TxStatusEvent<ProcessCreationResult>> {
    let outcome: Pick<ProcessCreationResult, 'grace' | 'graceError'> = {};
    let hash = '';
    for await (const event of this.processRegistry.setProcessGrace(created.processId, seconds)) {
      if (event.status === TxStatus.Pending) {
        hash = event.hash;
        yield { status: TxStatus.Pending, hash, step: 'setProcessGrace' };
      } else if (event.status === TxStatus.Completed) {
        outcome = { grace: { seconds, transactionHash: hash } };
      } else {
        outcome = {
          graceError:
            event.error ?? new ProcessGraceError('setProcessGrace reverted', 'setProcessGrace'),
        };
      }
    }
    yield { status: TxStatus.Completed, response: { ...created, ...outcome } };
  }

  /**
   * Resolve the ballot mode for a process config. Enforces mutual
   * exclusivity between `ballot` and `electionPreset`, and resolves the
   * preset into a raw `BallotMode` when given.
   *
   * @private
   */
  private resolveBallotConfig(config: ProcessConfig): BallotMode {
    const { ballot, electionPreset } = config;

    if (ballot !== undefined && electionPreset !== undefined) {
      throw new Error('Provide ballot OR electionPreset, not both');
    }
    if (electionPreset !== undefined) {
      if (!('questions' in config)) {
        throw new Error(
          'electionPreset requires `questions`; use `ballot` directly for metadataUri configs'
        );
      }
      return resolveElectionPreset(electionPreset, config.questions);
    }
    if (ballot === undefined) {
      throw new Error('Either ballot or electionPreset is required');
    }
    return ballot;
  }

  /**
   * Start and duration on the chain clock: a start of 0 is the creating
   * block's time.
   */
  private calculateTiming(
    timing: ProcessConfig['timing'],
    now: bigint
  ): { startTime: bigint; duration: bigint } {
    const create = (message: string, revertName?: string) =>
      refused(ProcessCreateError, 'newProcess', message, revertName);
    const { startDate, duration, endDate } = timing;

    if (duration !== undefined && endDate !== undefined) {
      throw new Error("Cannot specify both 'duration' and 'endDate'. Use one or the other.");
    }

    const startTime =
      startDate === undefined || startDate === 0 ? 0n : BigInt(this.dateToUnixTimestamp(startDate));
    if (startTime !== 0n && startTime <= now) {
      throw create(
        `startDate ${when(startTime)} is not after the chain time ${when(now)}; ` +
          'omit it to start when the transaction lands',
        'InvalidStartTime'
      );
    }

    if (duration !== undefined) {
      if (!positiveInt(duration)) {
        throw create(`duration ${String(duration)} is not a positive number of seconds`);
      }
      return { startTime, duration: BigInt(duration) };
    }
    if (endDate === undefined) {
      throw new Error("Must specify either 'duration' (in seconds) or 'endDate'.");
    }
    const endTime = BigInt(this.dateToUnixTimestamp(endDate));
    const from = startTime === 0n ? now : startTime;
    if (endTime <= from) {
      throw create(
        `End date must be after start date (${when(endTime)} is not after ${when(from)}).`,
        'InvalidDuration'
      );
    }
    return { startTime, duration: endTime - from };
  }

  /**
   * Converts various date formats to Unix timestamp
   */
  private dateToUnixTimestamp(date: Date | string | number): number {
    if (typeof date === 'number') {
      if (!Number.isFinite(date) || date < 0) {
        throw new Error(`Invalid timestamp: ${date}`);
      }
      // Likely milliseconds above 1e10: convert to seconds
      return Math.floor(date > 1e10 ? date / 1000 : date);
    }

    if (typeof date === 'string') {
      const parsed = new Date(date);
      if (isNaN(parsed.getTime())) {
        throw new Error(`Invalid date string: ${date}`);
      }
      return Math.floor(parsed.getTime() / 1000);
    }

    if (date instanceof Date) {
      if (isNaN(date.getTime())) {
        throw new Error('Invalid Date object provided.');
      }
      return Math.floor(date.getTime() / 1000);
    }

    throw new Error('Invalid date format. Use Date object, ISO string, or Unix timestamp.');
  }

  // ─── ORGANIZER CONTROLS ────────────────────────────────────────────

  // Runs `preflight` (which returns the registry's stream) on the first event
  // request; a failure is the stream's `Failed` event.
  private async *guarded<T>(
    preflight: () => Promise<AsyncGenerator<TxStatusEvent<T>, void, unknown>>
  ): AsyncGenerator<TxStatusEvent<T>> {
    let stream: AsyncGenerator<TxStatusEvent<T>, void, unknown>;
    try {
      stream = await preflight();
    } catch (err) {
      yield { status: TxStatus.Failed, error: asError(err) };
      return;
    }
    yield* stream;
  }

  // The process and the chain clock; the signer must be its organizer.
  private async organizerProcess(
    processId: string,
    ErrorType: ErrorClass,
    operation: string,
    action: string
  ): Promise<{ process: OnchainProcess; now: bigint }> {
    const [process, now, signer] = await Promise.all([
      this.processRegistry.getProcess(processId),
      this.processRegistry.getChainTime(),
      this.signer.getAddress(),
    ]);
    if (process.organizationId !== getAddress(signer)) {
      throw refused(
        ErrorType,
        operation,
        `only the organizer ${process.organizationId} can ${action} process ${process.processId}`,
        'Unauthorized'
      );
    }
    return { process, now };
  }

  // READY or PAUSED and before the end: the window every change but a status one needs.
  private async changeableProcess(
    processId: string,
    ErrorType: ErrorClass,
    operation: string,
    action: string
  ): Promise<{ process: OnchainProcess; now: bigint }> {
    const found = await this.organizerProcess(processId, ErrorType, operation, action);
    const { process, now } = found;
    if (!isOpenStatus(process.status)) {
      throw refused(
        ErrorType,
        operation,
        `cannot ${action} process ${process.processId}: it is ` +
          `${ProcessStatus[process.status]}, and only a READY or PAUSED process changes`,
        'InvalidStatus'
      );
    }
    if (now >= endOf(process)) {
      throw refused(
        ErrorType,
        operation,
        `cannot ${action} process ${process.processId}: it ended at ${when(endOf(process))}, ` +
          'and the registry allows it only before the end',
        'InvalidTimeBounds'
      );
    }
    return found;
  }

  // A status change the registry's transition rules allow from `from`.
  private statusChange(
    processId: string,
    to: ProcessStatus,
    action: string,
    from: readonly ProcessStatus[],
    timeRule?: (p: OnchainProcess, now: bigint) => string | undefined
  ): AsyncGenerator<TxStatusEvent<Done>> {
    return this.guarded(async () => {
      const op = 'setProcessStatus';
      const { process, now } = await this.organizerProcess(
        processId,
        ProcessStatusError,
        op,
        action
      );
      if (!from.includes(process.status)) {
        throw refused(
          ProcessStatusError,
          op,
          `cannot ${action} process ${process.processId}: it is ${ProcessStatus[process.status]}, ` +
            `and only a ${from.map(s => ProcessStatus[s]).join(' or ')} process can`,
          'InvalidStatus'
        );
      }
      const broken = timeRule?.(process, now);
      if (broken) throw refused(ProcessStatusError, op, broken, 'InvalidTimeBounds');
      return this.processRegistry.setProcessStatus(processId, to);
    });
  }

  /**
   * Ends a READY or PAUSED process (`setProcessStatus` ENDED) and yields the
   * transaction's status events. Only the organizer can, and only from the
   * start on: before it the registry refuses (`InvalidTimeBounds`), and
   * cancel is the way to void a process that never opened. Before the end
   * it moves the end to now; votes already admitted still settle through the
   * grace window, and the results follow it.
   *
   * @param processId - The process ID to end
   * @returns AsyncGenerator yielding transaction status events
   * @throws nothing: a refusal is a `Failed` event with a `ProcessStatusError`
   *
   * @example
   * ```typescript
   * for await (const event of orchestrator.endProcessStream(processId)) {
   *   if (event.status === TxStatus.Failed) console.error(event.error);
   * }
   * ```
   */
  endProcessStream(processId: string): AsyncGenerator<TxStatusEvent<Done>> {
    return this.statusChange(
      processId,
      ProcessStatus.ENDED,
      'end',
      [ProcessStatus.READY, ProcessStatus.PAUSED],
      (p, now) =>
        now < p.startTime
          ? `process ${p.processId} starts at ${when(p.startTime)} and cannot end before it ` +
            'starts; cancel it instead'
          : undefined
    );
  }

  /**
   * {@link endProcessStream}, waiting for the transaction.
   *
   * @throws ProcessStatusError, with `revertName` for a rule the registry enforces
   */
  async endProcess(processId: string): Promise<void> {
    await SmartContractService.executeTx(this.endProcessStream(processId));
  }

  /**
   * Pauses a READY process (`setProcessStatus` PAUSED), only before its end:
   * from the end on the registry refuses (`InvalidTimeBounds`), since a pause
   * cannot hold the grace window shut. Nodes still take votes while it is
   * paused but settle nothing until it resumes; a process still paused at
   * its end settles through the grace window like an ended one.
   *
   * @throws nothing: a refusal is a `Failed` event with a `ProcessStatusError`
   */
  pauseProcessStream(processId: string): AsyncGenerator<TxStatusEvent<Done>> {
    return this.statusChange(
      processId,
      ProcessStatus.PAUSED,
      'pause',
      [ProcessStatus.READY],
      (p, now) =>
        now >= endOf(p)
          ? `process ${p.processId} ended at ${when(endOf(p))}; a pause works only before the end`
          : undefined
    );
  }

  /**
   * {@link pauseProcessStream}, waiting for the transaction.
   *
   * @throws ProcessStatusError, with `revertName` for a rule the registry enforces
   */
  async pauseProcess(processId: string): Promise<void> {
    await SmartContractService.executeTx(this.pauseProcessStream(processId));
  }

  /**
   * Cancels a READY or PAUSED process (`setProcessStatus` CANCELED): no
   * results will be set. It works at any time, the grace window included,
   * until a DKG process's decryption was requested (which moves it to ENDED).
   *
   * @throws nothing: a refusal is a `Failed` event with a `ProcessStatusError`
   */
  cancelProcessStream(processId: string): AsyncGenerator<TxStatusEvent<Done>> {
    return this.statusChange(processId, ProcessStatus.CANCELED, 'cancel', [
      ProcessStatus.READY,
      ProcessStatus.PAUSED,
    ]);
  }

  /**
   * {@link cancelProcessStream}, waiting for the transaction.
   *
   * @throws ProcessStatusError, with `revertName` for a rule the registry enforces
   */
  async cancelProcess(processId: string): Promise<void> {
    await SmartContractService.executeTx(this.cancelProcessStream(processId));
  }

  /**
   * Resumes a PAUSED process (`setProcessStatus` READY): nodes settle the
   * votes they took meanwhile.
   *
   * @throws nothing: a refusal is a `Failed` event with a `ProcessStatusError`
   */
  resumeProcessStream(processId: string): AsyncGenerator<TxStatusEvent<Done>> {
    return this.statusChange(processId, ProcessStatus.READY, 'resume', [ProcessStatus.PAUSED]);
  }

  /**
   * {@link resumeProcessStream}, waiting for the transaction.
   *
   * @throws ProcessStatusError, with `revertName` for a rule the registry enforces
   */
  async resumeProcess(processId: string): Promise<void> {
    await SmartContractService.executeTx(this.resumeProcessStream(processId));
  }

  /**
   * Moves the end of a READY or PAUSED process `seconds` later
   * (`setProcessDuration`). Only before the current end: past it the tally
   * may already be public, so the registry refuses (`InvalidTimeBounds`).
   *
   * @param seconds - Seconds to add to the end, a positive integer
   * @throws nothing: a refusal is a `Failed` event with a `ProcessDurationError`
   */
  extendProcessStream(
    processId: string,
    seconds: number
  ): AsyncGenerator<TxStatusEvent<DurationChange>> {
    return this.guarded(async () => {
      const op = 'setProcessDuration';
      if (!positiveInt(seconds)) {
        throw refused(
          ProcessDurationError,
          op,
          `extend by ${String(seconds)} seconds: not a positive integer`,
          'InvalidDuration'
        );
      }
      const { process } = await this.changeableProcess(
        processId,
        ProcessDurationError,
        op,
        'extend'
      );
      const duration = process.duration + BigInt(seconds);
      return withResponse(this.processRegistry.setProcessDuration(processId, duration), {
        success: true,
        duration,
      });
    });
  }

  /**
   * {@link extendProcessStream}, waiting for the transaction.
   *
   * @returns the new duration, from the start
   * @throws ProcessDurationError, with `revertName` for a rule the registry enforces
   */
  async extendProcess(processId: string, seconds: number): Promise<DurationChange> {
    return SmartContractService.executeTx(this.extendProcessStream(processId, seconds));
  }

  /**
   * Shortens a READY or PAUSED process so voting closes `seconds` from the
   * chain head, with notice (`setProcessDuration`): never sooner than the
   * registry's `noticeMin`, plus `slack` for the transaction's inclusion,
   * since the registry checks the notice when the transaction lands. Nodes
   * flush during the notice and results follow the grace window; this is
   * "voting closes in one minute" at a meeting. Only before the current end,
   * and only to an earlier end (use `extendProcess` to extend).
   *
   * @param seconds - Seconds from now; less than `noticeMin` means `noticeMin`
   * @throws nothing: a refusal is a `Failed` event with a `ProcessDurationError`
   */
  closeProcessInStream(
    processId: string,
    seconds: number,
    options: CloseProcessOptions = {}
  ): AsyncGenerator<TxStatusEvent<DurationChange>> {
    return this.guarded(async () => {
      const op = 'setProcessDuration';
      if (!Number.isSafeInteger(seconds) || seconds < 0) {
        throw refused(
          ProcessDurationError,
          op,
          `close in ${String(seconds)} seconds: not a non-negative integer`
        );
      }
      const slack = options.slack;
      if (slack !== undefined && (!Number.isSafeInteger(slack) || slack < 0)) {
        throw refused(
          ProcessDurationError,
          op,
          `slack ${String(slack)} is not a whole number of seconds`
        );
      }
      await this.changeableProcess(processId, ProcessDurationError, op, 'shorten');
      return this.processRegistry.closeProcessIn(processId, seconds, { slack });
    });
  }

  /**
   * {@link closeProcessInStream}, waiting for the transaction.
   *
   * @returns the new duration, from the start
   * @throws ProcessDurationError, with `revertName` for a rule the registry enforces
   */
  async closeProcessIn(
    processId: string,
    seconds: number,
    options: CloseProcessOptions = {}
  ): Promise<DurationChange> {
    return SmartContractService.executeTx(this.closeProcessInStream(processId, seconds, options));
  }

  /**
   * Sets the grace window of a READY or PAUSED process (`setProcessGrace`):
   * the idle seconds after the last landing that close it. Only before the
   * end, since past it the window is already running (`InvalidTimeBounds`),
   * and within the registry's `graceFloor..graceCeil` (`InvalidGrace`). A
   * live meeting sets the floor right after creation, so results follow the
   * close within minutes.
   *
   * @param grace - Seconds
   * @throws nothing: a refusal is a `Failed` event with a `ProcessGraceError`
   *
   * @example
   * ```typescript
   * const { graceFloor } = await orchestrator.getGraceParams();
   * await orchestrator.setProcessGrace(processId, graceFloor);
   * ```
   */
  setProcessGraceStream(processId: string, grace: number): AsyncGenerator<TxStatusEvent<Done>> {
    return this.guarded(async () => {
      const op = 'setProcessGrace';
      const [params] = await Promise.all([
        this.getGraceParams(),
        this.changeableProcess(processId, ProcessGraceError, op, 'set the grace window of'),
      ]);
      checkGrace(grace, params);
      return this.processRegistry.setProcessGrace(processId, grace);
    });
  }

  /**
   * {@link setProcessGraceStream}, waiting for the transaction.
   *
   * @throws ProcessGraceError, with `revertName` for a rule the registry enforces
   */
  async setProcessGrace(processId: string, grace: number): Promise<void> {
    await SmartContractService.executeTx(this.setProcessGraceStream(processId, grace));
  }

  /**
   * Sets max voters of a READY or PAUSED process (`setProcessMaxVoters`).
   * Only before the end, since past it the cap would pick which queued
   * batches still land (`InvalidTimeBounds`); never below the voters already
   * counted (`InvalidMaxVoters`); and within the result cap, `maxValue` at
   * most `1e12 / maxVoters` (`MaxPossibleResultCapExceeded`).
   *
   * @throws nothing: a refusal is a `Failed` event with a `ProcessMaxVotersError`
   */
  setProcessMaxVotersStream(
    processId: string,
    maxVoters: number
  ): AsyncGenerator<TxStatusEvent<Done>> {
    return this.guarded(async () => {
      const op = 'setProcessMaxVoters';
      if (!positiveInt(maxVoters)) {
        throw refused(
          ProcessMaxVotersError,
          op,
          `maxVoters ${String(maxVoters)} is not a positive integer`,
          'InvalidMaxVoters'
        );
      }
      const { process } = await this.changeableProcess(
        processId,
        ProcessMaxVotersError,
        op,
        'set max voters of'
      );
      if (BigInt(maxVoters) < process.votersCount) {
        throw refused(
          ProcessMaxVotersError,
          op,
          `maxVoters ${maxVoters} is below the ${process.votersCount} voters already counted`,
          'InvalidMaxVoters'
        );
      }
      const cap = RESULT_CAP / BigInt(maxVoters);
      if (process.ballotMode.maxValue > cap) {
        throw refused(
          ProcessMaxVotersError,
          op,
          `maxValue ${process.ballotMode.maxValue} with ${maxVoters} voters exceeds the ` +
            `registry's result cap of ${RESULT_CAP}`,
          'MaxPossibleResultCapExceeded'
        );
      }
      return this.processRegistry.setProcessMaxVoters(processId, maxVoters);
    });
  }

  /**
   * {@link setProcessMaxVotersStream}, waiting for the transaction.
   *
   * @throws ProcessMaxVotersError, with `revertName` for a rule the registry enforces
   */
  async setProcessMaxVoters(processId: string, maxVoters: number): Promise<void> {
    await SmartContractService.executeTx(this.setProcessMaxVotersStream(processId, maxVoters));
  }

  /**
   * Publishes the organizer secret of a DKG_LOCKED process
   * (`revealProcessKey`), after which the committee decrypts the tally once
   * the grace window closes. It works at any time and needs only the secret,
   * not the organizer's account; revealing while voting runs drops the
   * process to the DKG_AUTOMATIC trust model. A wrong secret reverts
   * `InvalidOrganizerSecret` in the simulation, before anything is sent.
   *
   * @param secret - `organizerSecret` from the creation, in `[1, L)`
   * @throws nothing: a refusal is a `Failed` event with a `ProcessKeyRevealError`
   */
  revealProcessKeyStream(processId: string, secret: bigint): AsyncGenerator<TxStatusEvent<Done>> {
    return this.guarded(async () => {
      const op = 'revealProcessKey';
      if (typeof secret !== 'bigint' || secret <= 0n || secret >= BJJ_SUBGROUP_ORDER) {
        throw refused(
          ProcessKeyRevealError,
          op,
          'the organizer secret is not a scalar in [1, L)',
          'InvalidOrganizerSecret'
        );
      }
      const process = await this.processRegistry.getProcess(processId);
      if (process.keyMode !== KeyMode.DkgLocked) {
        throw refused(
          ProcessKeyRevealError,
          op,
          `process ${process.processId} is ${KeyMode[process.keyMode]}; only a DkgLocked ` +
            'process has an organizer key',
          'InvalidKeyMode'
        );
      }
      return this.processRegistry.revealProcessKey(processId, secret);
    });
  }

  /**
   * {@link revealProcessKeyStream}, waiting for the transaction.
   *
   * @throws ProcessKeyRevealError, with `revertName` for a rule the registry or the DKG enforces
   */
  async revealProcessKey(processId: string, secret: bigint): Promise<void> {
    await SmartContractService.executeTx(this.revealProcessKeyStream(processId, secret));
  }

  /**
   * Moves an updatable Merkle census (origin 2) to a new version: a census
   * object is published when needed (a URL given by hand is checked as nodes
   * read it), then `setProcessCensus` records the new root and URL. The
   * process is read first: only its organizer may update it, only while it
   * is READY or PAUSED and before its end, and only an origin-2 census, all
   * refused before anything is uploaded. Nodes load the new census in the
   * background and answer votes 429 until then; a pending vote whose member
   * was removed or reweighted fails with `census changed, recast`.
   *
   * @throws nothing: a refusal is a `Failed` event with a `CensusNotUpdatable`,
   *   a `ProcessCensusError` or a census error
   *
   * @example
   * ```typescript
   * census.add(newMembers);
   * for await (const e of orchestrator.updateCensusStream(processId, census)) console.log(e.status);
   * ```
   */
  updateCensusStream(processId: string, census: CensusUpdate): AsyncGenerator<TxStatusEvent<Done>> {
    return this.guarded(async () => {
      const op = 'setProcessCensus';
      const { process } = await this.changeableProcess(
        processId,
        ProcessCensusError,
        op,
        'update the census of'
      );
      if (process.census.origin !== CensusOrigin.OffchainDynamic) {
        throw refused(
          CensusNotUpdatable,
          op,
          `process ${process.processId} has a census of origin ${process.census.origin}; ` +
            'only an updatable Merkle census (origin 2) can be replaced',
          'CensusNotUpdatable'
        );
      }
      if (census instanceof Census && census.censusOrigin !== CensusOrigin.OffchainDynamic) {
        throw new CensusError('the new census must be updatable too (an OffchainDynamicCensus)');
      }
      const registry = await this.handleCensus(
        census instanceof Census
          ? census
          : { type: CensusOrigin.OffchainDynamic, root: census.root, uri: census.uri }
      );
      return this.processRegistry.setProcessCensus(processId, {
        origin: CensusOrigin.OffchainDynamic,
        root: registry.root,
        uri: registry.uri,
      });
    });
  }

  /**
   * {@link updateCensusStream}, waiting for the transaction.
   *
   * @throws CensusNotUpdatable, ProcessCensusError, CensusError, or the registry's revert
   */
  async updateCensus(processId: string, census: CensusUpdate): Promise<void> {
    await SmartContractService.executeTx(this.updateCensusStream(processId, census));
  }

  /**
   * Moves a process to a new metadata document (`setProcessMetadata`): a
   * document to publish through the uploader (a config is built with
   * `buildElectionMetadata`, bytes are published as given), or one already
   * served, with its hash or hashed from the URL. Only the organizer, only
   * while READY or PAUSED and before the end (the meaning of every ballot
   * field is fixed from then on), all checked before anything is uploaded.
   * Readers see the change as a new metadata version.
   *
   * @throws nothing: a refusal is a `Failed` event with a `ProcessMetadataError`
   *   or a metadata error
   *
   * @example
   * ```typescript
   * await orchestrator.updateMetadata(processId, { ...config, description: 'Corrected date' });
   * ```
   */
  updateMetadataStream(
    processId: string,
    metadata: MetadataUpdate
  ): AsyncGenerator<TxStatusEvent<Done>> {
    return this.guarded(async () => {
      const op = 'setProcessMetadata';
      await this.changeableProcess(processId, ProcessMetadataError, op, 'update the metadata of');
      let published: PublishedMetadata;
      if (!(metadata instanceof Uint8Array) && 'uri' in metadata) {
        const uri = metadata.uri;
        if (typeof uri !== 'string' || uri === '') {
          throw refused(ProcessMetadataError, op, 'the metadata URI is empty', 'InvalidMetadata');
        }
        published = {
          uri,
          hash:
            metadata.hash !== undefined
              ? metadataHashOf(metadata.hash)
              : await fetchMetadataHash(uri, this.documents),
        };
      } else {
        const document =
          metadata instanceof Uint8Array || 'version' in metadata
            ? metadata
            : buildElectionMetadata(metadata);
        published = await publishMetadata(
          document,
          this.requireUploader('the metadata document'),
          this.documents
        );
      }
      return this.processRegistry.setProcessMetadata(processId, published.uri, published.hash);
    });
  }

  /**
   * {@link updateMetadataStream}, waiting for the transaction.
   *
   * @throws MetadataError, ProcessMetadataError, or the registry's revert
   */
  async updateMetadata(processId: string, metadata: MetadataUpdate): Promise<void> {
    await SmartContractService.executeTx(this.updateMetadataStream(processId, metadata));
  }

  /**
   * Cancels every process that is still READY or PAUSED among the ones this
   * service created (by default), the ones given, or every process the
   * signer created on the registry (`all`). It tries them all, one
   * transaction each, and reports what it canceled and what failed; a
   * process of another organizer fails with `Unauthorized`. Useful to clean
   * up after tests, and after a `WrongProcessIdError`.
   *
   * @example
   * ```typescript
   * const { canceled, failed } = await orchestrator.cancelOpenProcesses();
   * ```
   */
  async cancelOpenProcesses(
    options: CancelOpenProcessesOptions = {}
  ): Promise<CancelOpenProcessesResult> {
    if (options.processIds && options.all) {
      throw new Error('cancelOpenProcesses: give processIds or all, not both');
    }
    let ids: readonly string[];
    if (options.processIds) {
      ids = options.processIds;
    } else if (options.all) {
      const account = await this.signer.getAddress();
      const [nonce, prefix] = await Promise.all([
        this.processRegistry.getProcessNonce(account),
        this.processRegistry.getPidPrefix(),
      ]);
      ids = Array.from({ length: Number(nonce) }, (_, i) => computeProcessId(account, prefix, i));
    } else {
      ids = this.created;
    }
    const result: CancelOpenProcessesResult = { canceled: [], failed: [] };
    for (const processId of [...new Set(ids.map(id => id.toLowerCase()))]) {
      try {
        const process = await this.processRegistry.getProcess(processId);
        if (!isOpenStatus(process.status)) continue;
        await this.cancelProcess(process.processId);
        result.canceled.push(process.processId);
      } catch (err) {
        result.failed.push({ processId, error: asError(err) });
      }
    }
    return result;
  }
}

// `stream`, with its completion answered by `response`.
async function* withResponse<T>(
  stream: AsyncGenerator<TxStatusEvent<Done>, void, unknown>,
  response: T
): AsyncGenerator<TxStatusEvent<T>, void, unknown> {
  for await (const event of stream) {
    yield event.status === TxStatus.Completed ? { status: TxStatus.Completed, response } : event;
  }
}
