import { Signer, getAddress } from 'ethers';
import { VocdoniApiService } from '../api/ApiService';
import { ProcessRegistryService } from '../../contracts/ProcessRegistryService';
import { CensusNotUpdatable, ProcessMetadataError } from '../../contracts/errors';
import { ProcessStatus, type OnchainProcess, type RegistryCensus } from '../../contracts/types';
import type { BjjPoint } from '../../crypto/babyjubjub';
import type { BallotModeValues } from '../../crypto/ballot';
import { BallotMode } from '../types';
import {
  ElectionPreset,
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
   * you need to express a ballot that does not map to a preset.
   */
  ballot?: BallotMode;

  /**
   * Election preset configuration (alternative to `ballot`).
   *
   * Pass a discriminated value like `{ type: 'rating', maxValue: 5 }`
   * and the SDK resolves it to a `BallotMode` using
   * `questions[0].choices.length` as `numFields`. Mutually exclusive
   * with `ballot`. Requires the metadata-driven config variant
   * (`questions` must be present); not usable with `metadataUri`.
   */
  electionPreset?: ElectionPreset;

  /** Process timing - use either duration-based or date-based configuration */
  timing: {
    /** Start date/time (Date object, ISO string, or Unix timestamp, default: now + 60 seconds) */
    startDate?: Date | string | number;
    /** Duration in seconds (required if endDate is not provided) */
    duration?: number;
    /** End date/time (Date object, ISO string, or Unix timestamp, cannot be used with duration) */
    endDate?: Date | string | number;
  };

  /**
   * Maximum number of voters allowed for this process. Defaults to the
   * member count of a Merkle census object; required for every other census.
   */
  maxVoters?: number;
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
  /** The created process ID */
  processId: string;
  /** Transaction hash of the on-chain process creation */
  transactionHash: string;
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

/**
 * Internal data needed during process creation
 */
interface ProcessCreationData {
  processId: string;
  startTime: number;
  duration: number;
  maxVoters: number;
  ballotMode: BallotMode;
  metadata: PublishedMetadata;
  encryptionKey: BjjPoint;
  census: RegistryCensus;
}

/**
 * User-friendly process information that extends the base process with additional runtime data
 */
export interface ProcessInfo extends BaseProcess {
  /** The process ID */
  processId: string;

  /** Current process status */
  status: ProcessStatus;

  /** Process creator address */
  creator: string;

  /** Start date as Date object */
  startDate: Date;

  /** End date as Date object */
  endDate: Date;

  /** Duration in seconds */
  duration: number;

  /** Time remaining in seconds (0 if ended, negative if not started) */
  timeRemaining: number;

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
 * Service that orchestrates the complete process creation workflow
 */
export class ProcessOrchestrationService {
  private readonly uploader?: Uploader;
  private readonly documents: DocumentOptions;

  constructor(
    private processRegistry: ProcessRegistryService,
    private apiService: VocdoniApiService,
    private signer: Signer,
    options: ProcessOrchestrationOptions = {}
  ) {
    this.uploader = options.uploader;
    this.documents = options.documents ?? {};
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
  private async handleCensus(
    census: ProcessConfig['census']
  ): Promise<{ registry: RegistryCensus; size?: number }> {
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
      return {
        registry: census.toRegistryCensus(),
        ...(census instanceof MerkleCensus && { size: census.size }),
      };
    }
    const { type, root, uri, contractAddress } = census;
    if (
      (type === CensusOrigin.OffchainStatic || type === CensusOrigin.OffchainDynamic) &&
      this.documents.verify !== false
    ) {
      await verifyCensusUrl(uri, root, this.documents);
    }
    return { registry: { origin: type, root, uri, ...(contractAddress && { contractAddress }) } };
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

  /**
   * Gets user-friendly process information by transforming raw contract data.
   * The metadata document is downloaded and checked against the registry's
   * `metadataHash`; title, description, questions and preset are read from it
   * only when it matches (`metadataVerified`).
   *
   * @param processId - The process ID to fetch
   * @returns Promise resolving to the user-friendly process information
   */
  async getProcess(processId: string): Promise<ProcessInfo> {
    // 1. Get raw process data from contract
    const rawProcess = await this.processRegistry.getProcess(processId);

    // 2. Fetch the metadata and check it against its on-chain hash
    const read = rawProcess.metadataUri
      ? await readMetadata(rawProcess.metadataUri, rawProcess.metadataHash, this.documents)
      : { status: 'unreachable' as const, error: 'the process has no metadata URI' };
    const doc = read.status === 'verified' && isObject(read.document) ? read.document : undefined;

    // 3. Calculate timing information
    const now = Math.floor(Date.now() / 1000);
    const startTime = Number(rawProcess.startTime);
    const duration = Number(rawProcess.duration);
    const endTime = startTime + duration;

    const timeRemaining = now >= endTime ? 0 : now >= startTime ? endTime - now : startTime - now;

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
      processId,
      title: localizedText(doc?.title) ?? '',
      description: localizedText(doc?.description),
      census,
      ballot,
      questions: doc ? questionsOf(doc) : [],
      status: rawProcess.status,
      creator: rawProcess.organizationId,
      startDate: new Date(startTime * 1000),
      endDate: new Date(endTime * 1000),
      duration,
      timeRemaining,
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

  /**
   * Creates a complete voting process and returns an async generator that yields transaction status events.
   * This method allows you to monitor the transaction progress in real-time.
   *
   * @param config - Process configuration
   * @returns AsyncGenerator yielding transaction status events with ProcessCreationResult
   *
   * @example
   * ```typescript
   * const stream = sdk.createProcessStream({
   *   title: "My Election",
   *   description: "A simple election",
   *   census: { ... },
   *   electionPreset: { type: 'single_choice' },
   *   timing: { ... },
   *   questions: [ ... ]
   * });
   *
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case "pending":
   *       console.log("Transaction pending:", event.hash);
   *       break;
   *     case "completed":
   *       console.log("Process created:", event.response.processId);
   *       console.log("Transaction hash:", event.response.transactionHash);
   *       break;
   *     case "failed":
   *       console.error("Transaction failed:", event.error);
   *       break;
   *     case "reverted":
   *       console.error("Transaction reverted:", event.reason);
   *       break;
   *   }
   * }
   * ```
   */
  async *createProcessStream(
    config: ProcessConfig
  ): AsyncGenerator<TxStatusEvent<ProcessCreationResult>> {
    // Prepare all data needed for process creation
    const data = await this.prepareProcessCreation(config);

    // Submit on-chain transaction and yield events. The key was issued for
    // the predicted id: another process from this account landing first
    // fails the stream with WrongProcessIdError.
    const txStream = this.processRegistry.newProcess(
      {
        status: ProcessStatus.READY,
        startTime: data.startTime,
        duration: data.duration,
        maxVoters: data.maxVoters,
        ballotMode: toBallotModeValues(data.ballotMode),
        census: data.census,
        metadataUri: data.metadata.uri,
        metadataHash: data.metadata.hash,
        encryptionKey: data.encryptionKey,
      },
      { expectedProcessId: data.processId }
    );

    let transactionHash = 'unknown';

    for await (const event of txStream) {
      if (event.status === TxStatus.Pending) {
        transactionHash = event.hash;
        yield { status: TxStatus.Pending, hash: event.hash };
      } else if (event.status === TxStatus.Completed) {
        yield {
          status: TxStatus.Completed,
          response: {
            processId: event.response.processId,
            transactionHash,
          },
        };
        break;
      } else if (event.status === TxStatus.Failed) {
        yield { status: TxStatus.Failed, error: event.error };
        break;
      } else if (event.status === TxStatus.Reverted) {
        yield { status: TxStatus.Reverted, reason: event.reason };
        break;
      }
    }
  }

  /**
   * Creates a complete voting process with minimal configuration.
   * This is the ultra-easy method for end users that handles all the complex orchestration internally.
   *
   * For real-time transaction status updates, use createProcessStream() instead.
   *
   * The method automatically:
   * - Publishes the census file and the metadata document through the uploader
   * - Gets the encryption key from the key sequencer
   * - Submits the on-chain transaction
   *
   * @param config - Simplified process configuration
   * @returns Promise resolving to the process creation result
   */
  async createProcess(config: ProcessConfig): Promise<ProcessCreationResult> {
    // Use the stream internally and consume it to get the final result
    for await (const event of this.createProcessStream(config)) {
      if (event.status === TxStatus.Completed) {
        return event.response;
      } else if (event.status === TxStatus.Failed) {
        throw event.error;
      } else if (event.status === TxStatus.Reverted) {
        throw new Error(`Transaction reverted: ${event.reason || 'unknown reason'}`);
      }
    }

    throw new Error('Process creation stream ended unexpectedly');
  }

  /**
   * Prepares all data needed for process creation. Everything that can be
   * refused locally is checked first, then the documents are published, and
   * the key is requested last, for the id the registry assigns next.
   * @private
   */
  private async prepareProcessCreation(config: ProcessConfig): Promise<ProcessCreationData> {
    // 1. Validate and calculate timing
    const { startTime, duration } = this.calculateTiming(config.timing);

    // 2. Resolve ballot mode — either raw `ballot` or `electionPreset`
    const ballotMode = this.resolveBallotConfig(config);

    // 3. maxVoters: given, or the members of a Merkle census object
    if (config.maxVoters === undefined && !(config.census instanceof MerkleCensus)) {
      throw new Error(
        'maxVoters is required. It can only be omitted for a Merkle census object ' +
          '(OffchainCensus/OffchainDynamicCensus), whose member count it defaults to.'
      );
    }

    // 4. Census: publish (or check) it; 5. metadata: publish it, or hash the one given
    const census = await this.handleCensus(config.census);
    const metadata = await this.handleMetadata(config);
    const maxVoters = config.maxVoters ?? (census.size as number);

    // 6. The next process id, and the key the sequencer issues for it
    const signerAddress = await this.signer.getAddress();
    const processId = await this.processRegistry.getNextProcessId(signerAddress);
    const encryptionKey = await this.apiService.sequencer.getEncryptionKey(processId);

    return {
      processId,
      startTime,
      duration,
      maxVoters,
      ballotMode,
      metadata,
      encryptionKey,
      census: census.registry,
    };
  }

  // The process, for an update by this signer while it can still change.
  private async updatable(processId: string, what: string): Promise<OnchainProcess> {
    const process = await this.processRegistry.getProcess(processId);
    const signer = getAddress(await this.signer.getAddress());
    if (process.organizationId !== signer) {
      throw new Error(`only the organizer ${process.organizationId} can change the ${what}`);
    }
    if (process.status !== ProcessStatus.READY && process.status !== ProcessStatus.PAUSED) {
      throw new Error(
        `the ${what} of a process can change only while it is READY or PAUSED ` +
          `(status ${ProcessStatus[process.status]})`
      );
    }
    return process;
  }

  /**
   * Moves an updatable Merkle census (origin 2) to a new version: a census
   * object is published when needed (a URL given by hand is checked as nodes
   * read it), then `setProcessCensus` records the new root and URL. The
   * process is read first, so a process of another origin, of another
   * organizer or already closed is refused before anything is uploaded.
   * Nodes load the new census in the background and answer votes 429 until
   * then; a pending vote whose member was removed or reweighted fails with
   * `census changed, recast`.
   *
   * @throws CensusNotUpdatable for a process whose census is not updatable
   *
   * @example
   * ```typescript
   * census.add(newMembers);
   * for await (const e of orchestrator.updateCensusStream(processId, census)) console.log(e.status);
   * ```
   */
  async *updateCensusStream(
    processId: string,
    census: CensusUpdate
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    const process = await this.updatable(processId, 'census');
    if (process.census.origin !== CensusOrigin.OffchainDynamic) {
      throw new CensusNotUpdatable(
        `process ${processId} has a census of origin ${process.census.origin}; ` +
          'only an updatable Merkle census (origin 2) can be replaced',
        'setProcessCensus'
      );
    }
    if (census instanceof Census && census.censusOrigin !== CensusOrigin.OffchainDynamic) {
      throw new CensusError('the new census must be updatable too (an OffchainDynamicCensus)');
    }
    const { registry } = await this.handleCensus(
      census instanceof Census
        ? census
        : { type: CensusOrigin.OffchainDynamic, root: census.root, uri: census.uri }
    );
    yield* this.processRegistry.setProcessCensus(processId, {
      origin: CensusOrigin.OffchainDynamic,
      root: registry.root,
      uri: registry.uri,
    });
  }

  /**
   * {@link updateCensusStream}, waiting for the transaction.
   *
   * @throws CensusNotUpdatable, CensusError, or the registry's revert
   */
  async updateCensus(processId: string, census: CensusUpdate): Promise<void> {
    await SmartContractService.executeTx(this.updateCensusStream(processId, census));
  }

  /**
   * Moves a process to a new metadata document (`setProcessMetadata`,
   * READY or PAUSED, before the end): a document to publish through the
   * uploader (a config is built with `buildElectionMetadata`, bytes are
   * published as given), or one already served, with its hash or hashed
   * from the URL. The process is read first, so a process of another
   * organizer or already closed is refused before anything is uploaded.
   * Readers see the change as a new metadata version.
   *
   * @example
   * ```typescript
   * await orchestrator.updateMetadata(processId, { ...config, description: 'Corrected date' });
   * ```
   */
  async *updateMetadataStream(
    processId: string,
    metadata: MetadataUpdate
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    await this.updatable(processId, 'metadata');
    let published: PublishedMetadata;
    if (!(metadata instanceof Uint8Array) && 'uri' in metadata) {
      const uri = metadata.uri;
      if (typeof uri !== 'string' || uri === '') {
        throw new ProcessMetadataError('the metadata URI is empty', 'setProcessMetadata');
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
    yield* this.processRegistry.setProcessMetadata(processId, published.uri, published.hash);
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
   * Validates and calculates timing parameters
   */
  private calculateTiming(timing: ProcessConfig['timing']): {
    startTime: number;
    duration: number;
  } {
    const { startDate, duration, endDate } = timing;

    // Validate that duration and endDate are not both provided
    if (duration !== undefined && endDate !== undefined) {
      throw new Error("Cannot specify both 'duration' and 'endDate'. Use one or the other.");
    }

    // Calculate start time
    const startTime = startDate
      ? this.dateToUnixTimestamp(startDate)
      : Math.floor(Date.now() / 1000) + 60;

    // Calculate duration
    let calculatedDuration: number;
    if (duration !== undefined) {
      // Duration provided directly
      calculatedDuration = duration;
    } else if (endDate !== undefined) {
      // Calculate duration from endDate
      const endTime = this.dateToUnixTimestamp(endDate);
      calculatedDuration = endTime - startTime;

      if (calculatedDuration <= 0) {
        throw new Error('End date must be after start date.');
      }
    } else {
      throw new Error("Must specify either 'duration' (in seconds) or 'endDate'.");
    }

    // Validate that start time is not in the past (with 30 second buffer)
    const now = Math.floor(Date.now() / 1000);
    if (startTime < now - 30) {
      throw new Error('Start date cannot be in the past.');
    }

    return { startTime, duration: calculatedDuration };
  }

  /**
   * Converts various date formats to Unix timestamp
   */
  private dateToUnixTimestamp(date: Date | string | number): number {
    if (typeof date === 'number') {
      // Already a timestamp - validate it's reasonable (not milliseconds)
      if (date > 1e10) {
        // Likely milliseconds, convert to seconds
        return Math.floor(date / 1000);
      }
      return Math.floor(date);
    }

    if (typeof date === 'string') {
      // ISO string or other parseable date string
      const parsed = new Date(date);
      if (isNaN(parsed.getTime())) {
        throw new Error(`Invalid date string: ${date}`);
      }
      return Math.floor(parsed.getTime() / 1000);
    }

    if (date instanceof Date) {
      // Date object
      if (isNaN(date.getTime())) {
        throw new Error('Invalid Date object provided.');
      }
      return Math.floor(date.getTime() / 1000);
    }

    throw new Error('Invalid date format. Use Date object, ISO string, or Unix timestamp.');
  }

  /**
   * Ends a voting process by setting its status to ENDED.
   * Returns an async generator that yields transaction status events.
   *
   * @param processId - The process ID to end
   * @returns AsyncGenerator yielding transaction status events
   *
   * @example
   * ```typescript
   * const stream = sdk.endProcessStream("0x1234567890abcdef...");
   *
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case "pending":
   *       console.log("Transaction pending:", event.hash);
   *       break;
   *     case "completed":
   *       console.log("Process ended successfully");
   *       break;
   *     case "failed":
   *       console.error("Transaction failed:", event.error);
   *       break;
   *     case "reverted":
   *       console.error("Transaction reverted:", event.reason);
   *       break;
   *   }
   * }
   * ```
   */
  async *endProcessStream(processId: string): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    // Submit on-chain transaction to end the process
    const txStream = this.processRegistry.setProcessStatus(processId, ProcessStatus.ENDED);

    for await (const event of txStream) {
      if (event.status === TxStatus.Pending) {
        yield { status: TxStatus.Pending, hash: event.hash };
      } else if (event.status === TxStatus.Completed) {
        yield {
          status: TxStatus.Completed,
          response: { success: true },
        };
        break;
      } else if (event.status === TxStatus.Failed) {
        yield { status: TxStatus.Failed, error: event.error };
        break;
      } else if (event.status === TxStatus.Reverted) {
        yield { status: TxStatus.Reverted, reason: event.reason };
        break;
      }
    }
  }

  /**
   * Ends a voting process by setting its status to ENDED.
   * This is a simplified method that waits for transaction completion.
   *
   * For real-time transaction status updates, use endProcessStream() instead.
   *
   * @param processId - The process ID to end
   * @returns Promise resolving when the process is ended
   *
   * @example
   * ```typescript
   * await sdk.endProcess("0x1234567890abcdef...");
   * console.log("Process ended successfully");
   * ```
   */
  async endProcess(processId: string): Promise<void> {
    // Use the stream internally and consume it to get the final result
    for await (const event of this.endProcessStream(processId)) {
      if (event.status === TxStatus.Completed) {
        return;
      } else if (event.status === TxStatus.Failed) {
        throw event.error;
      } else if (event.status === TxStatus.Reverted) {
        throw new Error(`Transaction reverted: ${event.reason || 'unknown reason'}`);
      }
    }

    throw new Error('End process stream ended unexpectedly');
  }

  /**
   * Pauses a voting process by setting its status to PAUSED.
   * Returns an async generator that yields transaction status events.
   *
   * @param processId - The process ID to pause
   * @returns AsyncGenerator yielding transaction status events
   *
   * @example
   * ```typescript
   * const stream = sdk.pauseProcessStream("0x1234567890abcdef...");
   *
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case "pending":
   *       console.log("Transaction pending:", event.hash);
   *       break;
   *     case "completed":
   *       console.log("Process paused successfully");
   *       break;
   *     case "failed":
   *       console.error("Transaction failed:", event.error);
   *       break;
   *     case "reverted":
   *       console.error("Transaction reverted:", event.reason);
   *       break;
   *   }
   * }
   * ```
   */
  async *pauseProcessStream(
    processId: string
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    // Submit on-chain transaction to pause the process
    const txStream = this.processRegistry.setProcessStatus(processId, ProcessStatus.PAUSED);

    for await (const event of txStream) {
      if (event.status === TxStatus.Pending) {
        yield { status: TxStatus.Pending, hash: event.hash };
      } else if (event.status === TxStatus.Completed) {
        yield {
          status: TxStatus.Completed,
          response: { success: true },
        };
        break;
      } else if (event.status === TxStatus.Failed) {
        yield { status: TxStatus.Failed, error: event.error };
        break;
      } else if (event.status === TxStatus.Reverted) {
        yield { status: TxStatus.Reverted, reason: event.reason };
        break;
      }
    }
  }

  /**
   * Pauses a voting process by setting its status to PAUSED.
   * This is a simplified method that waits for transaction completion.
   *
   * For real-time transaction status updates, use pauseProcessStream() instead.
   *
   * @param processId - The process ID to pause
   * @returns Promise resolving when the process is paused
   *
   * @example
   * ```typescript
   * await sdk.pauseProcess("0x1234567890abcdef...");
   * console.log("Process paused successfully");
   * ```
   */
  async pauseProcess(processId: string): Promise<void> {
    // Use the stream internally and consume it to get the final result
    for await (const event of this.pauseProcessStream(processId)) {
      if (event.status === TxStatus.Completed) {
        return;
      } else if (event.status === TxStatus.Failed) {
        throw event.error;
      } else if (event.status === TxStatus.Reverted) {
        throw new Error(`Transaction reverted: ${event.reason || 'unknown reason'}`);
      }
    }

    throw new Error('Pause process stream ended unexpectedly');
  }

  /**
   * Cancels a voting process by setting its status to CANCELED.
   * Returns an async generator that yields transaction status events.
   *
   * @param processId - The process ID to cancel
   * @returns AsyncGenerator yielding transaction status events
   *
   * @example
   * ```typescript
   * const stream = sdk.cancelProcessStream("0x1234567890abcdef...");
   *
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case "pending":
   *       console.log("Transaction pending:", event.hash);
   *       break;
   *     case "completed":
   *       console.log("Process canceled successfully");
   *       break;
   *     case "failed":
   *       console.error("Transaction failed:", event.error);
   *       break;
   *     case "reverted":
   *       console.error("Transaction reverted:", event.reason);
   *       break;
   *   }
   * }
   * ```
   */
  async *cancelProcessStream(
    processId: string
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    // Submit on-chain transaction to cancel the process
    const txStream = this.processRegistry.setProcessStatus(processId, ProcessStatus.CANCELED);

    for await (const event of txStream) {
      if (event.status === TxStatus.Pending) {
        yield { status: TxStatus.Pending, hash: event.hash };
      } else if (event.status === TxStatus.Completed) {
        yield {
          status: TxStatus.Completed,
          response: { success: true },
        };
        break;
      } else if (event.status === TxStatus.Failed) {
        yield { status: TxStatus.Failed, error: event.error };
        break;
      } else if (event.status === TxStatus.Reverted) {
        yield { status: TxStatus.Reverted, reason: event.reason };
        break;
      }
    }
  }

  /**
   * Cancels a voting process by setting its status to CANCELED.
   * This is a simplified method that waits for transaction completion.
   *
   * For real-time transaction status updates, use cancelProcessStream() instead.
   *
   * @param processId - The process ID to cancel
   * @returns Promise resolving when the process is canceled
   *
   * @example
   * ```typescript
   * await sdk.cancelProcess("0x1234567890abcdef...");
   * console.log("Process canceled successfully");
   * ```
   */
  async cancelProcess(processId: string): Promise<void> {
    // Use the stream internally and consume it to get the final result
    for await (const event of this.cancelProcessStream(processId)) {
      if (event.status === TxStatus.Completed) {
        return;
      } else if (event.status === TxStatus.Failed) {
        throw event.error;
      } else if (event.status === TxStatus.Reverted) {
        throw new Error(`Transaction reverted: ${event.reason || 'unknown reason'}`);
      }
    }

    throw new Error('Cancel process stream ended unexpectedly');
  }

  /**
   * Resumes a voting process by setting its status to READY.
   * This is typically used to resume a paused process.
   * Returns an async generator that yields transaction status events.
   *
   * @param processId - The process ID to resume
   * @returns AsyncGenerator yielding transaction status events
   *
   * @example
   * ```typescript
   * const stream = sdk.resumeProcessStream("0x1234567890abcdef...");
   *
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case "pending":
   *       console.log("Transaction pending:", event.hash);
   *       break;
   *     case "completed":
   *       console.log("Process resumed successfully");
   *       break;
   *     case "failed":
   *       console.error("Transaction failed:", event.error);
   *       break;
   *     case "reverted":
   *       console.error("Transaction reverted:", event.reason);
   *       break;
   *   }
   * }
   * ```
   */
  async *resumeProcessStream(
    processId: string
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    // Submit on-chain transaction to resume the process
    const txStream = this.processRegistry.setProcessStatus(processId, ProcessStatus.READY);

    for await (const event of txStream) {
      if (event.status === TxStatus.Pending) {
        yield { status: TxStatus.Pending, hash: event.hash };
      } else if (event.status === TxStatus.Completed) {
        yield {
          status: TxStatus.Completed,
          response: { success: true },
        };
        break;
      } else if (event.status === TxStatus.Failed) {
        yield { status: TxStatus.Failed, error: event.error };
        break;
      } else if (event.status === TxStatus.Reverted) {
        yield { status: TxStatus.Reverted, reason: event.reason };
        break;
      }
    }
  }

  /**
   * Resumes a voting process by setting its status to READY.
   * This is typically used to resume a paused process.
   * This is a simplified method that waits for transaction completion.
   *
   * For real-time transaction status updates, use resumeProcessStream() instead.
   *
   * @param processId - The process ID to resume
   * @returns Promise resolving when the process is resumed
   *
   * @example
   * ```typescript
   * await sdk.resumeProcess("0x1234567890abcdef...");
   * console.log("Process resumed successfully");
   * ```
   */
  async resumeProcess(processId: string): Promise<void> {
    // Use the stream internally and consume it to get the final result
    for await (const event of this.resumeProcessStream(processId)) {
      if (event.status === TxStatus.Completed) {
        return;
      } else if (event.status === TxStatus.Failed) {
        throw event.error;
      } else if (event.status === TxStatus.Reverted) {
        throw new Error(`Transaction reverted: ${event.reason || 'unknown reason'}`);
      }
    }

    throw new Error('Resume process stream ended unexpectedly');
  }

  /**
   * Sets the maximum number of voters for a process.
   * Returns an async generator that yields transaction status events.
   *
   * @param processId - The process ID
   * @param maxVoters - The new maximum number of voters
   * @returns AsyncGenerator yielding transaction status events
   *
   * @example
   * ```typescript
   * const stream = sdk.setProcessMaxVotersStream("0x1234567890abcdef...", 500);
   *
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case "pending":
   *       console.log("Transaction pending:", event.hash);
   *       break;
   *     case "completed":
   *       console.log("MaxVoters updated successfully");
   *       break;
   *     case "failed":
   *       console.error("Transaction failed:", event.error);
   *       break;
   *     case "reverted":
   *       console.error("Transaction reverted:", event.reason);
   *       break;
   *   }
   * }
   * ```
   */
  async *setProcessMaxVotersStream(
    processId: string,
    maxVoters: number
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    // Submit on-chain transaction to update maxVoters
    const txStream = this.processRegistry.setProcessMaxVoters(processId, maxVoters);

    for await (const event of txStream) {
      if (event.status === TxStatus.Pending) {
        yield { status: TxStatus.Pending, hash: event.hash };
      } else if (event.status === TxStatus.Completed) {
        yield {
          status: TxStatus.Completed,
          response: { success: true },
        };
        break;
      } else if (event.status === TxStatus.Failed) {
        yield { status: TxStatus.Failed, error: event.error };
        break;
      } else if (event.status === TxStatus.Reverted) {
        yield { status: TxStatus.Reverted, reason: event.reason };
        break;
      }
    }
  }

  /**
   * Sets the maximum number of voters for a process.
   * This is a simplified method that waits for transaction completion.
   *
   * For real-time transaction status updates, use setProcessMaxVotersStream() instead.
   *
   * @param processId - The process ID
   * @param maxVoters - The new maximum number of voters
   * @returns Promise resolving when the maxVoters is updated
   *
   * @example
   * ```typescript
   * await sdk.setProcessMaxVoters("0x1234567890abcdef...", 500);
   * console.log("MaxVoters updated successfully");
   * ```
   */
  async setProcessMaxVoters(processId: string, maxVoters: number): Promise<void> {
    // Use the stream internally and consume it to get the final result
    for await (const event of this.setProcessMaxVotersStream(processId, maxVoters)) {
      if (event.status === TxStatus.Completed) {
        return;
      } else if (event.status === TxStatus.Failed) {
        throw event.error;
      } else if (event.status === TxStatus.Reverted) {
        throw new Error(`Transaction reverted: ${event.reason || 'unknown reason'}`);
      }
    }

    throw new Error('Set process maxVoters stream ended unexpectedly');
  }
}

/** The registry form of a ballot mode (integer bounds; groupSize defaults to numFields). */
function toBallotModeValues(mode: BallotMode): BallotModeValues {
  return {
    numFields: mode.numFields,
    groupSize: mode.groupSize ?? mode.numFields,
    uniqueValues: mode.uniqueValues,
    costExponent: mode.costExponent,
    maxValue: BigInt(mode.maxValue),
    minValue: BigInt(mode.minValue),
    maxValueSum: BigInt(mode.maxValueSum),
    minValueSum: BigInt(mode.minValueSum),
  };
}
