import { Signer } from 'ethers';
import { VocdoniApiService } from '../api/ApiService';
import { ProcessRegistryService, ProcessStatus } from '../../contracts/ProcessRegistryService';
import { OrganizationRegistryService } from '../../contracts/OrganizationRegistry';
import { DavinciCrypto } from '../../sequencer/DavinciCryptoService';
import { signProcessCreation } from '../../sequencer/api/helpers';
import { BallotMode, CensusData, EncryptionKey } from '../types';
import { CensusOrigin } from '../../census/types';
import { getElectionMetadataTemplate } from '../types/metadata';
import { TxStatusEvent, TxStatus } from '../../contracts/SmartContractService';

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
    /** Census size */
    size: number;
    /** Census URI */
    uri: string;
  };

  /** Ballot configuration */
  ballot: BallotMode;

  /** Election questions and choices (required) */
  questions: Array<{
    title: string;
    description?: string;
    choices: Array<{
      title: string;
      value: number;
    }>;
  }>;
}

/**
 * Configuration for creating a process
 */
export interface ProcessConfig extends BaseProcess {
  /** Process timing - use either duration-based or date-based configuration */
  timing: {
    /** Start date/time (Date object, ISO string, or Unix timestamp, default: now + 60 seconds) */
    startDate?: Date | string | number;
    /** Duration in seconds (required if endDate is not provided) */
    duration?: number;
    /** End date/time (Date object, ISO string, or Unix timestamp, cannot be used with duration) */
    endDate?: Date | string | number;
  };
}

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
  censusRoot: string;
  ballotMode: BallotMode;
  metadataUri: string;
  sequencerResult: {
    encryptionPubKey: [string, string];
    stateRoot: string;
  };
  census: CensusData;
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

  /** Process results (array of BigInt values) */
  result: bigint[];

  /** Number of votes cast */
  voteCount: number;

  /** Number of vote overwrites */
  voteOverwriteCount: number;

  /** Metadata URI */
  metadataURI: string;

  /** Raw contract data (for advanced users) */
  raw?: any;
}

/**
 * Service that orchestrates the complete process creation workflow
 */
export class ProcessOrchestrationService {
  constructor(
    private processRegistry: ProcessRegistryService,
    private apiService: VocdoniApiService,
    private organizationRegistry: OrganizationRegistryService,
    private getCrypto: () => Promise<DavinciCrypto>,
    private signer: Signer
  ) {}

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
    let questions: ProcessConfig['questions'] = [];

    try {
      if (rawProcess.metadataURI) {
        metadata = await this.apiService.sequencer.getMetadata(rawProcess.metadataURI);
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
      type: Number(rawProcess.census.censusOrigin) as CensusOrigin,
      root: rawProcess.census.censusRoot,
      size: Number(rawProcess.census.maxVotes),
      uri: rawProcess.census.censusURI || '',
    };

    // 5. Transform ballot mode (convert BigInt fields to appropriate types)
    const ballot: BallotMode = {
      numFields: Number(rawProcess.ballotMode.numFields),
      maxValue: rawProcess.ballotMode.maxValue.toString(),
      minValue: rawProcess.ballotMode.minValue.toString(),
      uniqueValues: rawProcess.ballotMode.uniqueValues,
      costFromWeight: rawProcess.ballotMode.costFromWeight,
      costExponent: Number(rawProcess.ballotMode.costExponent),
      maxValueSum: rawProcess.ballotMode.maxValueSum.toString(),
      minValueSum: rawProcess.ballotMode.minValueSum.toString(),
    };

    // 6. Return user-friendly process info
    return {
      processId,
      title: title!,
      description: description!,
      census,
      ballot,
      questions,
      status: Number(rawProcess.status) as ProcessStatus,
      creator: rawProcess.organizationId,
      startDate: new Date(startTime * 1000),
      endDate: new Date(endTime * 1000),
      duration,
      timeRemaining,
      result: rawProcess.result,
      voteCount: Number(rawProcess.voteCount),
      voteOverwriteCount: Number(rawProcess.voteOverwriteCount),
      metadataURI: rawProcess.metadataURI,
      raw: rawProcess,
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
   *   ballot: { ... },
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

    // Create encryption key object
    const encryptionKey: EncryptionKey = {
      x: data.sequencerResult.encryptionPubKey[0],
      y: data.sequencerResult.encryptionPubKey[1],
    };

    // Submit on-chain transaction and yield events
    const txStream = this.processRegistry.newProcess(
      ProcessStatus.READY,
      data.startTime,
      data.duration,
      data.ballotMode,
      data.census,
      data.metadataUri,
      encryptionKey,
      BigInt(data.sequencerResult.stateRoot)
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
            processId: data.processId,
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
   * - Gets encryption keys and initial state root from the sequencer
   * - Handles process creation signatures
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

    // 3. Use provided census values directly
    const censusRoot = config.census.root;

    // 4. Use ballot mode configuration directly
    const ballotMode = config.ballot;

    // 5. Create and push metadata
    const metadata = this.createMetadata(config);
    const metadataHash = await this.apiService.sequencer.pushMetadata(metadata);
    const metadataUri = this.apiService.sequencer.getMetadataUrl(metadataHash);

    // 6. Create process via sequencer API (this gets encryption key and state root)
    const signature = await signProcessCreation(processId, this.signer);
    const sequencerResult = await this.apiService.sequencer.createProcess({
      processId,
      censusRoot,
      ballotMode,
      signature,
      censusOrigin: config.census.type,
    });

    // 7. Create census object for on-chain call
    const census: CensusData = {
      censusOrigin: config.census.type,
      maxVotes: config.census.size.toString(),
      censusRoot,
      censusURI: config.census.uri,
    };

    return {
      processId,
      startTime,
      duration,
      censusRoot,
      ballotMode,
      metadataUri,
      sequencerResult,
      census,
    };
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
   * Creates metadata from the simplified configuration
   */
  private createMetadata(config: ProcessConfig) {
    const metadata = getElectionMetadataTemplate();

    metadata.title.default = config.title;
    metadata.description.default = config.description || '';

    // Questions are required
    if (!config.questions || config.questions.length === 0) {
      throw new Error('Questions are required. Please provide at least one question with choices.');
    }

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
}
