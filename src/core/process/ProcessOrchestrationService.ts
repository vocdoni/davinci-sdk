import { Signer } from 'ethers';
import { VocdoniApiService } from '../api/ApiService';
import { ProcessRegistryService } from '../../contracts/ProcessRegistryService';
import { ProcessStatus, type RegistryCensus } from '../../contracts/types';
import { metadataHash as hashMetadata } from '../../contracts/params';
import type { BjjPoint } from '../../crypto/babyjubjub';
import type { BallotModeValues } from '../../crypto/ballot';
import { BallotMode } from '../types';
import {
  ElectionPreset,
  parseElectionPresetFromMetadata,
  resolveElectionPreset,
} from '../types/ballot';
import { CensusOrigin } from '../../census/types';
import { getElectionMetadataTemplate } from '../types/metadata';
import { TxStatusEvent, TxStatus } from '../../contracts/SmartContractService';
import { Census } from '../../census/classes/Census';
import { MerkleCensus } from '../../census/classes/MerkleCensus';
import { CensusOrchestrator } from '../../census/CensusOrchestrator';

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
    /** Census type - MerkleTree or CSP */
    type: CensusOrigin;
    /** Census root */
    root: string;
    /** Census URI */
    uri: string;
  };

  /** Ballot configuration */
  ballot: BallotMode;

  /** Election questions and choices (required) */
  questions: Array<ProcessQuestion>;
}

/**
 * Question structure used in process configuration and metadata
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
 * Base configuration shared by both process creation variants
 */
interface BaseProcessConfig {
  /**
   * Census - either a Census object (PlainCensus, WeightedCensus, CspCensus, PublishedCensus)
   * or manual configuration. If a Census object is provided and not published, it will be
   * automatically published.
   */
  census:
    | Census
    | {
        /** Census type - MerkleTree or CSP */
        type: CensusOrigin;
        /** Census root */
        root: string;
        /** Census size */
        size: number;
        /** Census URI */
        uri: string;
      };

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
   * Maximum number of voters allowed for this process
   * Optional only if census is a published MerkleCensus (OffchainCensus/OffchainDynamicCensus)
   * - defaults to participant count from the census
   * Required in all other cases (OnchainCensus, CspCensus, manual config, unpublished census)
   */
  maxVoters?: number;
}

/**
 * Process configuration with metadata fields (title, description, questions)
 * The metadata will be created and uploaded automatically
 */
export interface ProcessConfigWithMetadata extends BaseProcessConfig {
  /** Process title */
  title: string;

  /** Process description (optional) */
  description?: string;

  /** Election questions and choices (at least one required) */
  questions: [ProcessQuestion, ...ProcessQuestion[]];
}

/**
 * Process configuration with a pre-existing metadata URI
 * No metadata upload will occur - the provided URI will be used directly
 */
export interface ProcessConfigWithMetadataUri extends BaseProcessConfig {
  /** Pre-existing metadata URI to use instead of uploading new metadata */
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
 * Internal data needed during process creation
 */
interface ProcessCreationData {
  processId: string;
  startTime: number;
  duration: number;
  maxVoters: number;
  censusRoot: string;
  ballotMode: BallotMode;
  metadataUri: string;
  metadataHash: string;
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

  /** Raw contract data (for advanced users) */
  raw?: any;

  /**
   * Election preset used to create the process, recovered from
   * off-chain metadata. Absent when the process was created with a
   * raw `BallotMode`, when metadata is unavailable, or when the
   * stored value doesn't match a recognized preset shape. The raw
   * `ballot: BallotMode` field is always present regardless.
   */
  electionPreset?: ElectionPreset;
}

/**
 * Service that orchestrates the complete process creation workflow
 */
export class ProcessOrchestrationService {
  private censusOrchestrator: CensusOrchestrator;

  constructor(
    private processRegistry: ProcessRegistryService,
    private apiService: VocdoniApiService,
    private signer: Signer
  ) {
    // Initialize CensusOrchestrator with VocdoniCensusService from apiService
    this.censusOrchestrator = new CensusOrchestrator(apiService.census);
  }

  /**
   * Handles census - auto-publishes if needed and returns census config
   * @private
   */
  private async handleCensus(census: ProcessConfig['census']): Promise<{
    type: CensusOrigin;
    root: string;
    uri: string;
    contractAddress?: string;
  }> {
    // Check if it's a Census object
    if ('isPublished' in census) {
      // It's a Census object
      // Only Merkle censuses (OffchainCensus, OffchainDynamicCensus) need publishing
      // Onchain and CSP are ready immediately
      if (census.requiresPublishing && !census.isPublished) {
        // Check if census service has a valid base URL configured
        const censusBaseURL = this.apiService.census?.getBaseUrl();
        if (!censusBaseURL || censusBaseURL === '' || censusBaseURL === 'undefined') {
          throw new Error(
            'Census API URL is required to publish Merkle censuses (OffchainCensus, OffchainDynamicCensus). ' +
              'Please provide "censusUrl" when initializing DavinciSDK, or use a pre-published census.'
          );
        }
        // Type guard: if requiresPublishing is true, it must be a MerkleCensus
        await this.censusOrchestrator.publish(census as MerkleCensus);
      }

      // Extract census data (includes contractAddress for onchain censuses)
      return this.censusOrchestrator.getCensusData(census);
    }

    // It's manual config - return as-is (but remove size if present for backward compatibility)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- size is dropped on purpose
    const { size, ...censusWithoutSize } = census;
    return censusWithoutSize;
  }

  /**
   * Gets user-friendly process information by transforming raw contract data
   * @param processId - The process ID to fetch
   * @returns Promise resolving to the user-friendly process information
   */
  async getProcess(processId: string): Promise<ProcessInfo> {
    // 1. Get raw process data from contract
    const rawProcess = await this.processRegistry.getProcess(processId);

    // 2. Fetch and parse metadata
    let metadata: any = null;
    let title: string | undefined;
    let description: string | undefined;
    let questions: Array<ProcessQuestion> = [];

    try {
      if (rawProcess.metadataUri) {
        metadata = await (await this.fetchMetadata(rawProcess.metadataUri)).json();
        title = metadata?.title?.default;
        description = metadata?.description?.default;

        // Transform metadata questions to ProcessConfig format
        if (metadata?.questions) {
          questions = metadata.questions.map((q: any) => ({
            title: q.title?.default,
            description: q.description?.default,
            choices:
              q.choices?.map((c: any) => ({
                title: c.title?.default,
                value: c.value,
              })) || [],
          }));
        }
      }
    } catch (error) {
      console.warn(`Failed to fetch metadata for process ${processId}:`, error);
    }

    // 3. Calculate timing information
    const now = Math.floor(Date.now() / 1000);
    const startTime = Number(rawProcess.startTime);
    const duration = Number(rawProcess.duration);
    const endTime = startTime + duration;

    const timeRemaining = now >= endTime ? 0 : now >= startTime ? endTime - now : startTime - now;

    // 4. Transform census information
    const census = {
      type: rawProcess.census.origin,
      root: rawProcess.census.root,
      uri: rawProcess.census.uri || '',
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
    const electionPreset = parseElectionPresetFromMetadata(metadata);

    // 6. Return user-friendly process info
    return {
      processId,
      title: title || '',
      description: description,
      census,
      ballot,
      questions: questions || [],
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
        metadataUri: data.metadataUri,
        metadataHash: data.metadataHash,
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
   * - Gets encryption keys from the sequencer
   * - Coordinates between sequencer API and on-chain contract calls
   * - Creates and pushes metadata
   * - Submits the on-chain transaction
   *
   * @param config - Simplified process configuration
   * @returns Promise resolving to the process creation result
   */
  async createProcess(config: ProcessConfig): Promise<ProcessCreationResult> {
    // Use the stream internally and consume it to get the final result
    for await (const event of this.createProcessStream(config)) {
      if (event.status === 'completed') {
        return event.response;
      } else if (event.status === 'failed') {
        throw event.error;
      } else if (event.status === 'reverted') {
        throw new Error(`Transaction reverted: ${event.reason || 'unknown reason'}`);
      }
    }

    throw new Error('Process creation stream ended unexpectedly');
  }

  /**
   * Prepares all data needed for process creation
   * @private
   */
  private async prepareProcessCreation(config: ProcessConfig): Promise<ProcessCreationData> {
    // 1. Validate and calculate timing
    const { startTime, duration } = this.calculateTiming(config.timing);

    // 2. Get the next process ID
    const signerAddress = await this.signer.getAddress();
    const processId = await this.processRegistry.getNextProcessId(signerAddress);

    // 3. Handle census (auto-publish if needed)
    const censusConfig = await this.handleCensus(config.census);
    const censusRoot = censusConfig.root;

    // 4. Resolve ballot mode — either raw `ballot` or `electionPreset`
    const ballotMode = this.resolveBallotConfig(config);

    // 5. Metadata: the registry binds its URI and the SHA-256 of the bytes served there
    if (!('metadataUri' in config)) {
      throw new Error(
        'The sequencer does not host metadata: serve the metadata document at a public URL ' +
          'and create the process with `metadataUri` (and optionally `metadataHash`).'
      );
    }
    const metadataUri = config.metadataUri;
    const metadataHash =
      config.metadataHash ??
      hashMetadata(new Uint8Array(await (await this.fetchMetadata(metadataUri)).arrayBuffer()));

    // 6. Get the encryption key the sequencer issues for the predicted process id
    const encryptionKey = await this.apiService.sequencer.getEncryptionKey(processId);

    // 7. Determine maxVoters
    let maxVoters: number;

    if (config.maxVoters !== undefined) {
      // User explicitly provided maxVoters
      maxVoters = config.maxVoters;
    } else if ('isPublished' in config.census && config.census.isPublished) {
      // Census is published - can only use participant count for MerkleCensus
      if ('participants' in config.census) {
        // It's a MerkleCensus with participants
        maxVoters = (config.census as any).participants.length;
      } else {
        throw new Error(
          'maxVoters is required when using OnchainCensus, CspCensus, or PublishedCensus. ' +
            'It can only be auto-calculated for published MerkleCensus (OffchainCensus/OffchainDynamicCensus).'
        );
      }
    } else {
      // Census is not published yet, or it's manual config
      throw new Error(
        'maxVoters is required. It can only be omitted when using a published MerkleCensus ' +
          '(OffchainCensus/OffchainDynamicCensus), in which case it defaults to the participant count.'
      );
    }

    // 8. Create census object for on-chain call
    const census: RegistryCensus = {
      origin: censusConfig.type,
      root: censusRoot,
      contractAddress: censusConfig.contractAddress, // Only set for onchain censuses
      uri: censusConfig.uri,
    };

    return {
      processId,
      startTime,
      duration,
      maxVoters,
      censusRoot,
      ballotMode,
      metadataUri,
      metadataHash,
      encryptionKey,
      census,
    };
  }

  /**
   * Resolve the ballot mode for a process config. Enforces mutual
   * exclusivity between `ballot` and `electionPreset`, and resolves the
   * preset into a raw `BallotMode` when given.
   *
   * @private
   */
  private resolveBallotConfig(config: ProcessConfig): BallotMode {
    const hasBallot = config.ballot !== undefined;
    const hasPreset = config.electionPreset !== undefined;

    if (hasBallot && hasPreset) {
      throw new Error('Provide ballot OR electionPreset, not both');
    }
    if (!hasBallot && !hasPreset) {
      throw new Error('Either ballot or electionPreset is required');
    }

    if (hasPreset) {
      if (!('questions' in config)) {
        throw new Error(
          'electionPreset requires `questions`; use `ballot` directly for metadataUri configs'
        );
      }
      return resolveElectionPreset(config.electionPreset!, config.questions);
    }

    return config.ballot!;
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

    // Ensure at least one of duration or endDate is provided
    if (duration === undefined && endDate === undefined) {
      throw new Error("Must specify either 'duration' (in seconds) or 'endDate'.");
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
    } else {
      // Calculate duration from endDate
      const endTime = this.dateToUnixTimestamp(endDate!);
      calculatedDuration = endTime - startTime;

      if (calculatedDuration <= 0) {
        throw new Error('End date must be after start date.');
      }
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
   * Downloads a metadata document.
   */
  private async fetchMetadata(uri: string): Promise<Response> {
    const response = await fetch(uri);
    if (!response.ok) {
      throw new Error(`Failed to fetch metadata from ${uri}: ${response.status}`);
    }
    return response;
  }

  /**
   * Creates metadata from the configuration with metadata fields
   * This method should only be called with ProcessConfigWithMetadata
   */
  private createMetadata(config: ProcessConfigWithMetadata) {
    const metadata = getElectionMetadataTemplate();

    metadata.title.default = config.title;
    metadata.description.default = config.description || '';

    // TypeScript ensures at least one question exists due to tuple type
    metadata.questions = config.questions.map(q => ({
      title: { default: q.title },
      description: { default: q.description || '' },
      meta: {},
      choices: q.choices.map(c => ({
        title: { default: c.title },
        value: c.value,
        meta: {},
      })),
    }));

    // Round-trip the preset through metadata.meta.electionPreset when
    // present. (We can't use metadata.type — the sequencer reserves it.)
    if (config.electionPreset !== undefined) {
      metadata.meta = { ...metadata.meta, electionPreset: config.electionPreset };
    }

    return metadata;
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
      if (event.status === 'completed') {
        return;
      } else if (event.status === 'failed') {
        throw event.error;
      } else if (event.status === 'reverted') {
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
      if (event.status === 'completed') {
        return;
      } else if (event.status === 'failed') {
        throw event.error;
      } else if (event.status === 'reverted') {
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
      if (event.status === 'completed') {
        return;
      } else if (event.status === 'failed') {
        throw event.error;
      } else if (event.status === 'reverted') {
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
      if (event.status === 'completed') {
        return;
      } else if (event.status === 'failed') {
        throw event.error;
      } else if (event.status === 'reverted') {
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
      if (event.status === 'completed') {
        return;
      } else if (event.status === 'failed') {
        throw event.error;
      } else if (event.status === 'reverted') {
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
