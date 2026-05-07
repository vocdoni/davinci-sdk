import { Signer } from 'ethers';
import { VocdoniApiService } from './core/api/ApiService';
import { ProcessRegistryService } from './contracts/ProcessRegistryService';
import { DavinciCSP } from './sequencer/DavinciCSP';
import { BallotInputGenerator } from './sequencer/BallotInputGenerator';
import {
  ProcessOrchestrationService,
  ProcessConfig,
  ProcessCreationResult,
  ProcessInfo,
} from './core/process';
import { VoteOrchestrationService, VoteConfig, VoteResult, VoteStatusInfo } from './core/vote';
import { VoteStatus } from './sequencer/api/types';
import { CensusProviders } from './census/types';

/**
 * Configuration interface for the DavinciSDK
 */
export interface DavinciSDKConfig {
  /**
   * Ethers.js Signer for signing operations.
   * - For voting only: Can be a bare Wallet (no provider needed)
   * - For process operations: Must be connected to a provider
   */
  signer: Signer;

  /** Sequencer API URL for Vocdoni services (required) */
  sequencerUrl: string;

  /** Census API URL for census management (optional, only needed when creating censuses from scratch) */
  censusUrl?: string;

  /** Custom contract addresses (optional, fetched from sequencer if not provided) */
  addresses?: {
    processRegistry?: string;
  };

  /** Custom census proof providers (optional) */
  censusProviders?: CensusProviders;

  /** Whether to verify downloaded circuit files match expected hashes (optional, defaults to true) */
  verifyCircuitFiles?: boolean;

  /** Whether to verify the generated proof is valid before submission (optional, defaults to true) */
  verifyProof?: boolean;
}

/**
 * Internal configuration interface
 */
interface InternalDavinciSDKConfig {
  signer: Signer;
  sequencerUrl: string;
  censusUrl?: string;
  customAddresses: {
    processRegistry?: string;
  };
  fetchAddressesFromSequencer: boolean;
  verifyCircuitFiles: boolean;
  verifyProof: boolean;
}

/**
 * Simplified SDK class that encapsulates all Vocdoni DaVinci functionality
 */
export class DavinciSDK {
  private config: InternalDavinciSDKConfig;
  private apiService: VocdoniApiService;
  private _processRegistry?: ProcessRegistryService;
  private _processOrchestrator?: ProcessOrchestrationService;
  private processRegistryByChainId = new Map<string, ProcessRegistryService>();
  private processOrchestratorByChainId = new Map<string, ProcessOrchestrationService>();
  private _voteOrchestrator?: VoteOrchestrationService;
  private davinciCSP?: DavinciCSP;
  private ballotInputGenerator?: BallotInputGenerator;
  private initialized = false;
  private censusProviders: CensusProviders;

  constructor(config: DavinciSDKConfig) {
    const hasCustomAddresses = !!config.addresses && Object.keys(config.addresses).length > 0;
    this.config = {
      signer: config.signer,
      sequencerUrl: config.sequencerUrl,
      censusUrl: config.censusUrl,
      customAddresses: config.addresses || {},
      fetchAddressesFromSequencer: !hasCustomAddresses,
      verifyCircuitFiles: config.verifyCircuitFiles ?? true, // Default to true for security
      verifyProof: config.verifyProof ?? true, // Default to true for security
    };

    // Initialize API service
    this.apiService = new VocdoniApiService({
      sequencerURL: this.config.sequencerUrl,
      censusURL: this.config.censusUrl || '', // Use empty string if not provided
    });

    // Store census providers
    this.censusProviders = config.censusProviders || {};

    // Contract services will be initialized lazily when accessed
  }

  /**
   * Initialize the SDK and all its components
   * This must be called before using any SDK functionality
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Validate census URL if needed
    if (!this.config.censusUrl) {
      // Census URL is optional, but we'll check if it's needed later when actually used
    }

    this.initialized = true;
  }

  /**
   * Get the API service for direct access to sequencer and census APIs
   */
  get api(): VocdoniApiService {
    return this.apiService;
  }

  /**
   * Get the process registry service for process management.
   * Requires a signer with a provider for blockchain interactions.
   *
   * @throws Error if signer does not have a provider
   */
  get processes(): ProcessRegistryService {
    this.ensureProvider();
    if (!this._processRegistry) {
      if (!this.config.customAddresses.processRegistry) {
        throw new Error(
          "Contract address for 'processRegistry' not found. " +
            'Use an on-chain SDK method (which resolves by signer chain), or provide addresses.processRegistry explicitly.'
        );
      }
      this._processRegistry = new ProcessRegistryService(
        this.config.customAddresses.processRegistry,
        this.config.signer
      );
    }
    return this._processRegistry;
  }

  /**
   * Get or initialize the DavinciCSP service for CSP cryptographic operations
   */
  async getCSP(): Promise<DavinciCSP> {
    if (!this.davinciCSP) {
      this.davinciCSP = new DavinciCSP();

      await this.davinciCSP.init();
    }

    return this.davinciCSP;
  }

  /**
   * Get or initialize the BallotInputGenerator service for ballot input generation
   */
  async getBallotInputGenerator(): Promise<BallotInputGenerator> {
    if (!this.ballotInputGenerator) {
      this.ballotInputGenerator = new BallotInputGenerator();
      await this.ballotInputGenerator.init();
    }

    return this.ballotInputGenerator;
  }

  /**
   * Get the process orchestration service for simplified process creation.
   * Requires a signer with a provider for blockchain interactions.
   *
   * @throws Error if signer does not have a provider
   */
  get processOrchestrator(): ProcessOrchestrationService {
    this.ensureProvider();
    if (!this._processOrchestrator) {
      const processRegistry = this.processes;
      this._processOrchestrator = new ProcessOrchestrationService(processRegistry, this.apiService, this.config.signer);
    }
    return this._processOrchestrator;
  }

  /**
   * Get the vote orchestration service for simplified voting
   */
  get voteOrchestrator(): VoteOrchestrationService {
    if (!this._voteOrchestrator) {
      this._voteOrchestrator = new VoteOrchestrationService(
        this.apiService,
        () => this.getBallotInputGenerator(),
        this.config.signer,
        this.censusProviders,
        {
          verifyCircuitFiles: this.config.verifyCircuitFiles,
          verifyProof: this.config.verifyProof,
        }
      );
    }
    return this._voteOrchestrator;
  }

  /**
   * Gets user-friendly process information from the blockchain.
   * This method fetches raw contract data and transforms it into a user-friendly format
   * that matches the ProcessConfig interface used for creation, plus additional runtime data.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to fetch
   * @returns Promise resolving to user-friendly process information
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * const processInfo = await sdk.getProcess("0x1234567890abcdef...");
   *
   * // Access the same fields as ProcessConfig
   * console.log("Title:", processInfo.title);
   * console.log("Description:", processInfo.description);
   * console.log("Questions:", processInfo.questions);
   * console.log("Census size:", processInfo.census.size);
   * console.log("Ballot config:", processInfo.ballot);
   *
   * // Plus additional runtime information
   * console.log("Status:", processInfo.status);
   * console.log("Creator:", processInfo.creator);
   * console.log("Start date:", processInfo.startDate);
   * console.log("End date:", processInfo.endDate);
   * console.log("Duration:", processInfo.duration, "seconds");
   * console.log("Time remaining:", processInfo.timeRemaining, "seconds");
   *
   * // Access raw contract data if needed
   * console.log("Raw data:", processInfo.raw);
   * ```
   */
  async getProcess(processId: string): Promise<ProcessInfo> {
    if (!this.initialized) {
      throw new Error('SDK must be initialized before getting processes. Call sdk.init() first.');
    }
    this.ensureProvider();
    const processOrchestrator = await this.getProcessOrchestratorForCurrentChain();
    return processOrchestrator.getProcess(processId);
  }

  /**
   * Creates a complete voting process and returns an async generator that yields transaction status events.
   * This method allows you to monitor the transaction progress in real-time, including pending, completed,
   * failed, and reverted states.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param config - Simplified process configuration
   * @returns AsyncGenerator yielding transaction status events
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * const stream = sdk.createProcessStream({
   *   title: "My Election",
   *   description: "A simple election",
   *   census: {
   *     type: CensusOrigin.OffchainStatic,
   *     root: "0x1234...",
   *     size: 100,
   *     uri: "ipfs://..."
   *   },
   *   ballot: {
   *     numFields: 2,
   *     maxValue: "3",
   *     minValue: "0",
   *     uniqueValues: false,
   *     costExponent: 10000,
   *     maxValueSum: "6",
   *     minValueSum: "0"
   *   },
   *   timing: {
   *     startDate: new Date("2024-12-01T10:00:00Z"),
   *     duration: 3600 * 24
   *   },
   *   questions: [
   *     {
   *       title: "What is your favorite color?",
   *       choices: [
   *         { title: "Red", value: 0 },
   *         { title: "Blue", value: 1 }
   *       ]
   *     }
   *   ]
   * });
   *
   * // Monitor transaction progress
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case TxStatus.Pending:
   *       console.log("Transaction pending:", event.hash);
   *       // Update UI to show pending state
   *       break;
   *     case TxStatus.Completed:
   *       console.log("Process created:", event.response.processId);
   *       console.log("Transaction hash:", event.response.transactionHash);
   *       // Update UI to show success
   *       break;
   *     case TxStatus.Failed:
   *       console.error("Transaction failed:", event.error);
   *       // Update UI to show error
   *       break;
   *     case TxStatus.Reverted:
   *       console.error("Transaction reverted:", event.reason);
   *       // Update UI to show revert reason
   *       break;
   *   }
   * }
   * ```
   */
  createProcessStream(config: ProcessConfig) {
    return this.createProcessStreamInternal(config);
  }

  private async *createProcessStreamInternal(
    config: ProcessConfig
  ): AsyncGenerator<any> {
    if (!this.initialized) {
      throw new Error('SDK must be initialized before creating processes. Call sdk.init() first.');
    }
    this.ensureProvider();
    const processOrchestrator = await this.getProcessOrchestratorForCurrentChain();
    yield* processOrchestrator.createProcessStream(config);
  }

  /**
   * Creates a complete voting process with minimal configuration.
   * This is the ultra-easy method for end users that handles all the complex orchestration internally.
   *
   * For real-time transaction status updates, use createProcessStream() instead.
   *
   * Requires a signer with a provider for blockchain interactions.
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
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * // Option 1: Using duration (traditional approach)
   * const result1 = await sdk.createProcess({
   *   title: "My Election",
   *   description: "A simple election",
   *   census: {
   *     type: CensusOrigin.OffchainStatic,
   *     root: "0x1234...",
   *     size: 100,
   *     uri: "ipfs://your-census-uri"
   *   },
   *   ballot: {
   *     numFields: 2,
   *     maxValue: "3",
   *     minValue: "0",
   *     uniqueValues: false,
   *     costExponent: 10000,
   *     maxValueSum: "6",
   *     minValueSum: "0"
   *   },
   *   timing: {
   *     startDate: new Date("2024-12-01T10:00:00Z"),
   *     duration: 3600 * 24
   *   },
   *   questions: [
   *     {
   *       title: "What is your favorite color?",
   *       choices: [
   *         { title: "Red", value: 0 },
   *         { title: "Blue", value: 1 }
   *       ]
   *     }
   *   ]
   * });
   *
   * // Option 2: Using start and end dates
   * const result2 = await sdk.createProcess({
   *   title: "Weekend Vote",
   *   timing: {
   *     startDate: "2024-12-07T09:00:00Z",
   *     endDate: "2024-12-08T18:00:00Z"
   *   }
   * });
   * ```
   */
  async createProcess(config: ProcessConfig): Promise<ProcessCreationResult> {
    if (!this.initialized) {
      throw new Error('SDK must be initialized before creating processes. Call sdk.init() first.');
    }
    this.ensureProvider();
    const processOrchestrator = await this.getProcessOrchestratorForCurrentChain();
    return processOrchestrator.createProcess(config);
  }

  /**
   * Submit a vote with simplified configuration.
   * This is the ultra-easy method for end users that handles all the complex voting workflow internally.
   *
   * Does NOT require a provider - can be used with a bare Wallet for signing only.
   * IMPORTANT: Requires censusUrl to be configured in the SDK for fetching census proofs (unless using custom census providers).
   *
   * The method automatically:
   * - Fetches process information and validates voting is allowed
   * - Gets census proof (Merkle tree based)
   * - Generates cryptographic proofs and encrypts the vote
   * - Signs and submits the vote to the sequencer
   *
   * @param config - Simplified vote configuration
   * @returns Promise resolving to vote submission result
   * @throws Error if censusUrl is not configured (unless using custom census providers)
   *
   * @example
   * ```typescript
   * // Submit a vote with voter's private key
   * const voteResult = await sdk.submitVote({
   *   processId: "0x1234567890abcdef...",
   *   choices: [1, 0], // Vote for option 1 in question 1, option 0 in question 2
   *   voterKey: "0x1234567890abcdef..." // Voter's private key
   * });
   *
   * console.log("Vote ID:", voteResult.voteId);
   * console.log("Status:", voteResult.status);
   *
   * // Submit a vote with a Wallet instance
   * import { Wallet } from "ethers";
   * const voterWallet = new Wallet("0x...");
   *
   * const voteResult2 = await sdk.submitVote({
   *   processId: "0x1234567890abcdef...",
   *   choices: [2], // Single question vote
   *   voterKey: voterWallet
   * });
   * ```
   */
  async submitVote(config: VoteConfig): Promise<VoteResult> {
    if (!this.initialized) {
      throw new Error('SDK must be initialized before submitting votes. Call sdk.init() first.');
    }

    // Check if censusUrl is configured (unless using custom census providers)
    if (!this.config.censusUrl && !this.censusProviders.merkle && !this.censusProviders.csp) {
      throw new Error(
        'Census URL is required for voting. ' +
          'Provide censusUrl in the SDK constructor config, or use custom census providers.'
      );
    }

    return this.voteOrchestrator.submitVote(config);
  }

  /**
   * Get the status of a submitted vote.
   *
   * Does NOT require a provider - uses API calls only.
   *
   * @param processId - The process ID
   * @param voteId - The vote ID returned from submitVote()
   * @returns Promise resolving to vote status information
   *
   * @example
   * ```typescript
   * const statusInfo = await sdk.getVoteStatus(processId, voteId);
   * console.log("Vote status:", statusInfo.status);
   * // Possible statuses: "pending", "verified", "aggregated", "processed", "settled", "error"
   * ```
   */
  async getVoteStatus(processId: string, voteId: string): Promise<VoteStatusInfo> {
    if (!this.initialized) {
      throw new Error('SDK must be initialized before getting vote status. Call sdk.init() first.');
    }

    return this.voteOrchestrator.getVoteStatus(processId, voteId);
  }

  /**
   * Check if an address has voted in a process.
   *
   * Does NOT require a provider - uses API calls only.
   *
   * @param processId - The process ID
   * @param address - The voter's address
   * @returns Promise resolving to boolean indicating if the address has voted
   *
   * @example
   * ```typescript
   * const hasVoted = await sdk.hasAddressVoted(processId, "0x1234567890abcdef...");
   * if (hasVoted) {
   *   console.log("This address has already voted");
   * }
   * ```
   */
  async hasAddressVoted(processId: string, address: string): Promise<boolean> {
    if (!this.initialized) {
      throw new Error(
        'SDK must be initialized before checking vote status. Call sdk.init() first.'
      );
    }

    return this.voteOrchestrator.hasAddressVoted(processId, address);
  }

  /**
   * Check if an address is able to vote in a process (i.e., is in the census).
   *
   * Does NOT require a provider - uses API calls only.
   *
   * @param processId - The process ID
   * @param address - The voter's address
   * @returns Promise resolving to boolean indicating if the address can vote
   *
   * @example
   * ```typescript
   * const canVote = await sdk.isAddressAbleToVote(processId, "0x1234567890abcdef...");
   * if (canVote) {
   *   console.log("This address can vote");
   * } else {
   *   console.log("This address is not in the census");
   * }
   * ```
   */
  async isAddressAbleToVote(processId: string, address: string): Promise<boolean> {
    if (!this.initialized) {
      throw new Error(
        'SDK must be initialized before checking if address can vote. Call sdk.init() first.'
      );
    }

    return this.apiService.sequencer.isAddressAbleToVote(processId, address);
  }

  /**
   * Get the voting weight for an address in a process.
   *
   * Does NOT require a provider - uses API calls only.
   *
   * @param processId - The process ID
   * @param address - The voter's address
   * @returns Promise resolving to the address weight as a string
   *
   * @example
   * ```typescript
   * const weight = await sdk.getAddressWeight(processId, "0x1234567890abcdef...");
   * console.log("Address weight:", weight);
   * ```
   */
  async getAddressWeight(processId: string, address: string): Promise<string> {
    if (!this.initialized) {
      throw new Error(
        'SDK must be initialized before getting address weight. Call sdk.init() first.'
      );
    }

    return this.apiService.sequencer.getAddressWeight(processId, address);
  }

  /**
   * Watch vote status changes in real-time using an async generator.
   * This method yields each status change as it happens, perfect for showing
   * progress indicators in UI applications.
   *
   * Does NOT require a provider - uses API calls only.
   *
   * @param processId - The process ID
   * @param voteId - The vote ID
   * @param options - Optional configuration
   * @returns AsyncGenerator yielding vote status updates
   *
   * @example
   * ```typescript
   * // Submit vote
   * const voteResult = await sdk.submitVote({
   *   processId: "0x1234567890abcdef...",
   *   choices: [1]
   * });
   *
   * // Watch status changes in real-time
   * for await (const statusInfo of sdk.watchVoteStatus(voteResult.processId, voteResult.voteId)) {
   *   console.log(`Vote status: ${statusInfo.status}`);
   *
   *   switch (statusInfo.status) {
   *     case VoteStatus.Pending:
   *       console.log("⏳ Processing...");
   *       break;
   *     case VoteStatus.Verified:
   *       console.log("✓ Vote verified");
   *       break;
   *     case VoteStatus.Aggregated:
   *       console.log("📊 Vote aggregated");
   *       break;
   *     case VoteStatus.Settled:
   *       console.log("✅ Vote settled");
   *       break;
   *   }
   * }
   * ```
   */
  watchVoteStatus(
    processId: string,
    voteId: string,
    options?: {
      targetStatus?: VoteStatus;
      timeoutMs?: number;
      pollIntervalMs?: number;
    }
  ) {
    if (!this.initialized) {
      throw new Error(
        'SDK must be initialized before watching vote status. Call sdk.init() first.'
      );
    }

    return this.voteOrchestrator.watchVoteStatus(processId, voteId, options);
  }

  /**
   * Wait for a vote to reach a specific status.
   * This is a simpler alternative to watchVoteStatus() that returns only the final status.
   * Useful for waiting for vote confirmation and processing without needing to handle each intermediate status.
   *
   * Does NOT require a provider - uses API calls only.
   *
   * @param processId - The process ID
   * @param voteId - The vote ID
   * @param targetStatus - The target status to wait for (default: "settled")
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 300000 = 5 minutes)
   * @param pollIntervalMs - Polling interval in milliseconds (default: 5000 = 5 seconds)
   * @returns Promise resolving to final vote status
   *
   * @example
   * ```typescript
   * // Submit vote and wait for it to be settled
   * const voteResult = await sdk.submitVote({
   *   processId: "0x1234567890abcdef...",
   *   choices: [1]
   * });
   *
   * // Wait for the vote to be fully processed
   * const finalStatus = await sdk.waitForVoteStatus(
   *   voteResult.processId,
   *   voteResult.voteId,
   *   VoteStatus.Settled, // Wait until vote is settled
   *   300000,    // 5 minute timeout
   *   5000       // Check every 5 seconds
   * );
   *
   * console.log("Vote final status:", finalStatus.status);
   * ```
   */
  async waitForVoteStatus(
    processId: string,
    voteId: string,
    targetStatus: VoteStatus = VoteStatus.Settled,
    timeoutMs: number = 300000,
    pollIntervalMs: number = 5000
  ): Promise<VoteStatusInfo> {
    if (!this.initialized) {
      throw new Error(
        'SDK must be initialized before waiting for vote status. Call sdk.init() first.'
      );
    }

    return this.voteOrchestrator.waitForVoteStatus(
      processId,
      voteId,
      targetStatus,
      timeoutMs,
      pollIntervalMs
    );
  }

  /**
   * Ends a voting process by setting its status to ENDED and returns an async generator
   * that yields transaction status events. This method allows you to monitor the
   * transaction progress in real-time.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to end
   * @returns AsyncGenerator yielding transaction status events
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * const stream = sdk.endProcessStream("0x1234567890abcdef...");
   *
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case TxStatus.Pending:
   *       console.log("Transaction pending:", event.hash);
   *       break;
   *     case TxStatus.Completed:
   *       console.log("Process ended successfully");
   *       break;
   *     case TxStatus.Failed:
   *       console.error("Transaction failed:", event.error);
   *       break;
   *     case TxStatus.Reverted:
   *       console.error("Transaction reverted:", event.reason);
   *       break;
   *   }
   * }
   * ```
   */
  endProcessStream(processId: string) {
    return this.endProcessStreamInternal(processId);
  }

  private async *endProcessStreamInternal(
    processId: string
  ): AsyncGenerator<any> {
    if (!this.initialized) {
      throw new Error('SDK must be initialized before ending processes. Call sdk.init() first.');
    }
    this.ensureProvider();
    const processOrchestrator = await this.getProcessOrchestratorForCurrentChain();
    yield* processOrchestrator.endProcessStream(processId);
  }

  /**
   * Ends a voting process by setting its status to ENDED.
   * This is the simplified method that waits for transaction completion.
   *
   * For real-time transaction status updates, use endProcessStream() instead.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to end
   * @returns Promise resolving when the process is ended
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * await sdk.endProcess("0x1234567890abcdef...");
   * console.log("Process ended successfully");
   * ```
   */
  async endProcess(processId: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('SDK must be initialized before ending processes. Call sdk.init() first.');
    }
    this.ensureProvider();
    const processOrchestrator = await this.getProcessOrchestratorForCurrentChain();
    return processOrchestrator.endProcess(processId);
  }

  /**
   * Pauses a voting process by setting its status to PAUSED and returns an async generator
   * that yields transaction status events. This method allows you to monitor the
   * transaction progress in real-time.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to pause
   * @returns AsyncGenerator yielding transaction status events
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * const stream = sdk.pauseProcessStream("0x1234567890abcdef...");
   *
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case TxStatus.Pending:
   *       console.log("Transaction pending:", event.hash);
   *       break;
   *     case TxStatus.Completed:
   *       console.log("Process paused successfully");
   *       break;
   *     case TxStatus.Failed:
   *       console.error("Transaction failed:", event.error);
   *       break;
   *     case TxStatus.Reverted:
   *       console.error("Transaction reverted:", event.reason);
   *       break;
   *   }
   * }
   * ```
   */
  pauseProcessStream(processId: string) {
    return this.pauseProcessStreamInternal(processId);
  }

  private async *pauseProcessStreamInternal(
    processId: string
  ): AsyncGenerator<any> {
    if (!this.initialized) {
      throw new Error('SDK must be initialized before pausing processes. Call sdk.init() first.');
    }
    this.ensureProvider();
    const processOrchestrator = await this.getProcessOrchestratorForCurrentChain();
    yield* processOrchestrator.pauseProcessStream(processId);
  }

  /**
   * Pauses a voting process by setting its status to PAUSED.
   * This is the simplified method that waits for transaction completion.
   *
   * For real-time transaction status updates, use pauseProcessStream() instead.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to pause
   * @returns Promise resolving when the process is paused
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * await sdk.pauseProcess("0x1234567890abcdef...");
   * console.log("Process paused successfully");
   * ```
   */
  async pauseProcess(processId: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('SDK must be initialized before pausing processes. Call sdk.init() first.');
    }
    this.ensureProvider();
    const processOrchestrator = await this.getProcessOrchestratorForCurrentChain();
    return processOrchestrator.pauseProcess(processId);
  }

  /**
   * Cancels a voting process by setting its status to CANCELED and returns an async generator
   * that yields transaction status events. This method allows you to monitor the
   * transaction progress in real-time.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to cancel
   * @returns AsyncGenerator yielding transaction status events
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * const stream = sdk.cancelProcessStream("0x1234567890abcdef...");
   *
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case TxStatus.Pending:
   *       console.log("Transaction pending:", event.hash);
   *       break;
   *     case TxStatus.Completed:
   *       console.log("Process canceled successfully");
   *       break;
   *     case TxStatus.Failed:
   *       console.error("Transaction failed:", event.error);
   *       break;
   *     case TxStatus.Reverted:
   *       console.error("Transaction reverted:", event.reason);
   *       break;
   *   }
   * }
   * ```
   */
  cancelProcessStream(processId: string) {
    return this.cancelProcessStreamInternal(processId);
  }

  private async *cancelProcessStreamInternal(
    processId: string
  ): AsyncGenerator<any> {
    if (!this.initialized) {
      throw new Error('SDK must be initialized before canceling processes. Call sdk.init() first.');
    }
    this.ensureProvider();
    const processOrchestrator = await this.getProcessOrchestratorForCurrentChain();
    yield* processOrchestrator.cancelProcessStream(processId);
  }

  /**
   * Cancels a voting process by setting its status to CANCELED.
   * This is the simplified method that waits for transaction completion.
   *
   * For real-time transaction status updates, use cancelProcessStream() instead.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to cancel
   * @returns Promise resolving when the process is canceled
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * await sdk.cancelProcess("0x1234567890abcdef...");
   * console.log("Process canceled successfully");
   * ```
   */
  async cancelProcess(processId: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('SDK must be initialized before canceling processes. Call sdk.init() first.');
    }
    this.ensureProvider();
    const processOrchestrator = await this.getProcessOrchestratorForCurrentChain();
    return processOrchestrator.cancelProcess(processId);
  }

  /**
   * Resumes a voting process by setting its status to READY and returns an async generator
   * that yields transaction status events. This is typically used to resume a paused process.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to resume
   * @returns AsyncGenerator yielding transaction status events
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * const stream = sdk.resumeProcessStream("0x1234567890abcdef...");
   *
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case TxStatus.Pending:
   *       console.log("Transaction pending:", event.hash);
   *       break;
   *     case TxStatus.Completed:
   *       console.log("Process resumed successfully");
   *       break;
   *     case TxStatus.Failed:
   *       console.error("Transaction failed:", event.error);
   *       break;
   *     case TxStatus.Reverted:
   *       console.error("Transaction reverted:", event.reason);
   *       break;
   *   }
   * }
   * ```
   */
  resumeProcessStream(processId: string) {
    return this.resumeProcessStreamInternal(processId);
  }

  private async *resumeProcessStreamInternal(
    processId: string
  ): AsyncGenerator<any> {
    if (!this.initialized) {
      throw new Error('SDK must be initialized before resuming processes. Call sdk.init() first.');
    }
    this.ensureProvider();
    const processOrchestrator = await this.getProcessOrchestratorForCurrentChain();
    yield* processOrchestrator.resumeProcessStream(processId);
  }

  /**
   * Resumes a voting process by setting its status to READY.
   * This is typically used to resume a paused process.
   * This is the simplified method that waits for transaction completion.
   *
   * For real-time transaction status updates, use resumeProcessStream() instead.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to resume
   * @returns Promise resolving when the process is resumed
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * await sdk.resumeProcess("0x1234567890abcdef...");
   * console.log("Process resumed successfully");
   * ```
   */
  async resumeProcess(processId: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('SDK must be initialized before resuming processes. Call sdk.init() first.');
    }
    this.ensureProvider();
    const processOrchestrator = await this.getProcessOrchestratorForCurrentChain();
    return processOrchestrator.resumeProcess(processId);
  }

  /**
   * Sets the maximum number of voters for a process and returns an async generator
   * that yields transaction status events. This allows you to change the voter limit
   * after process creation.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID
   * @param maxVoters - The new maximum number of voters
   * @returns AsyncGenerator yielding transaction status events
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * const stream = sdk.setProcessMaxVotersStream("0x1234567890abcdef...", 500);
   *
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case TxStatus.Pending:
   *       console.log("Transaction pending:", event.hash);
   *       break;
   *     case TxStatus.Completed:
   *       console.log("MaxVoters updated successfully");
   *       break;
   *     case TxStatus.Failed:
   *       console.error("Transaction failed:", event.error);
   *       break;
   *     case TxStatus.Reverted:
   *       console.error("Transaction reverted:", event.reason);
   *       break;
   *   }
   * }
   * ```
   */
  setProcessMaxVotersStream(processId: string, maxVoters: number) {
    return this.setProcessMaxVotersStreamInternal(processId, maxVoters);
  }

  private async *setProcessMaxVotersStreamInternal(
    processId: string,
    maxVoters: number
  ): AsyncGenerator<any> {
    if (!this.initialized) {
      throw new Error(
        'SDK must be initialized before setting process maxVoters. Call sdk.init() first.'
      );
    }
    this.ensureProvider();
    const processOrchestrator = await this.getProcessOrchestratorForCurrentChain();
    yield* processOrchestrator.setProcessMaxVotersStream(processId, maxVoters);
  }

  /**
   * Sets the maximum number of voters for a process.
   * This is the simplified method that waits for transaction completion.
   *
   * For real-time transaction status updates, use setProcessMaxVotersStream() instead.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID
   * @param maxVoters - The new maximum number of voters
   * @returns Promise resolving when the maxVoters is updated
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * await sdk.setProcessMaxVoters("0x1234567890abcdef...", 500);
   * console.log("MaxVoters updated successfully");
   * ```
   */
  async setProcessMaxVoters(processId: string, maxVoters: number): Promise<void> {
    if (!this.initialized) {
      throw new Error(
        'SDK must be initialized before setting process maxVoters. Call sdk.init() first.'
      );
    }
    this.ensureProvider();
    const processOrchestrator = await this.getProcessOrchestratorForCurrentChain();
    return processOrchestrator.setProcessMaxVoters(processId, maxVoters);
  }

  /**
   * List process IDs from sequencer. In multichain mode, chainId is required unless signer has a provider.
   */
  async listProcesses(chainId?: number): Promise<string[]> {
    if (!this.initialized) {
      throw new Error('SDK must be initialized before listing processes. Call sdk.init() first.');
    }

    let resolvedChainId = chainId;
    if (resolvedChainId === undefined) {
      if (!this.config.signer.provider) {
        throw new Error(
          'chainId is required for listProcesses when signer has no provider.'
        );
      }
      const network = await this.config.signer.provider.getNetwork();
      resolvedChainId = Number(network.chainId);
    }

    return this.apiService.sequencer.listProcesses(resolvedChainId);
  }

  /**
   * Resolve the process registry for current signer chain.
   */
  private async getProcessRegistryForCurrentChain(): Promise<ProcessRegistryService> {
    if (this.config.customAddresses.processRegistry) {
      if (!this._processRegistry) {
        this._processRegistry = new ProcessRegistryService(
          this.config.customAddresses.processRegistry,
          this.config.signer
        );
      }
      return this._processRegistry;
    }

    this.ensureProvider();
    const provider = this.config.signer.provider;
    if (!provider) {
      throw new Error('Provider required for blockchain operations (process management).');
    }
    const network = await provider.getNetwork();
    const chainId = network.chainId.toString();

    const cached = this.processRegistryByChainId.get(chainId);
    if (cached) return cached;

    const info = await this.apiService.sequencer.getInfo();
    const processRegistryAddress = info.networks[chainId]?.processRegistryContract;
    if (!processRegistryAddress) {
      const availableChainIds = Object.keys(info.networks).join(',');
      throw new Error(
        `Signer chainId ${chainId} is not supported by sequencer. Available chainIds: ${availableChainIds}`
      );
    }

    const processRegistry = new ProcessRegistryService(processRegistryAddress, this.config.signer);
    this.processRegistryByChainId.set(chainId, processRegistry);
    return processRegistry;
  }

  /**
   * Resolve process orchestrator for current signer chain.
   */
  private async getProcessOrchestratorForCurrentChain(): Promise<ProcessOrchestrationService> {
    const processRegistry = await this.getProcessRegistryForCurrentChain();
    if (this.config.customAddresses.processRegistry) {
      if (!this._processOrchestrator) {
        this._processOrchestrator = new ProcessOrchestrationService(
          processRegistry,
          this.apiService,
          this.config.signer
        );
      }
      return this._processOrchestrator;
    }

    const provider = this.config.signer.provider;
    if (!provider) {
      throw new Error('Provider required for blockchain operations (process management).');
    }
    const network = await provider.getNetwork();
    const chainId = network.chainId.toString();
    const cached = this.processOrchestratorByChainId.get(chainId);
    if (cached) return cached;

    const processOrchestrator = new ProcessOrchestrationService(
      processRegistry,
      this.apiService,
      this.config.signer
    );
    this.processOrchestratorByChainId.set(chainId, processOrchestrator);
    return processOrchestrator;
  }

  /**
   * Get the current configuration
   */
  getConfig(): Readonly<InternalDavinciSDKConfig> {
    return { ...this.config };
  }

  /**
   * Check if the SDK has been initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Ensures that the signer has a provider for blockchain operations.
   * @throws Error if the signer does not have a provider
   * @private
   */
  private ensureProvider(): void {
    if (!this.config.signer.provider) {
      throw new Error(
        'Provider required for blockchain operations (process management). ' +
          'The signer must be connected to a provider. ' +
          'Use wallet.connect(provider) or a browser signer like MetaMask. ' +
          'Note: Voting operations do not require a provider.'
      );
    }
  }
}
