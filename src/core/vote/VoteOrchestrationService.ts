import { Signer } from 'ethers';
import { VocdoniApiService } from '../api/ApiService';
import { BallotInputGenerator } from '../../sequencer/BallotInputGenerator';
import { CensusProviders } from '../../census/types';
import { VoteStatus } from '../../sequencer/api/types';

/**
 * Simplified vote configuration interface for end users
 */
export interface VoteConfig {
  /** The process ID to vote in */
  processId: string;

  /** The voter's choices - array of selected values for each question */
  choices: number[];

  /** Optional: Custom randomness for vote encryption (will be generated if not provided) */
  randomness?: string;
}

/**
 * Result of vote submission
 */
export interface VoteResult {
  /** The unique vote ID */
  voteId: string;

  /** The transaction signature */
  signature: string;

  /** The voter's address */
  voterAddress: string;

  /** The process ID */
  processId: string;

  /** Current vote status */
  status: VoteStatus;
}

/**
 * Vote status information
 */
export interface VoteStatusInfo {
  /** The vote ID */
  voteId: string;

  /** Current status of the vote */
  status: VoteStatus;

  /** Why, for status `error` */
  error?: string;

  /** The process ID */
  processId: string;
}

/**
 * Configuration options for VoteOrchestrationService
 */
export interface VoteOrchestrationConfig {
  /** Whether to verify downloaded circuit files match expected hashes (default: true) */
  verifyCircuitFiles?: boolean;
  /** Whether to verify the generated proof is valid before submission (default: true) */
  verifyProof?: boolean;
}

/**
 * Service that orchestrates the complete voting workflow
 * Handles all the complex cryptographic operations and API calls internally
 */
export class VoteOrchestrationService {
  constructor(
    private apiService: VocdoniApiService,
    private getBallotInputGenerator: () => Promise<BallotInputGenerator>,
    private signer: Signer,
    private censusProviders: CensusProviders = {},
    private config: VoteOrchestrationConfig = {}
  ) {}

  /**
   * Submit a vote with simplified configuration.
   *
   * Not available in this version: ballots are the 16-field zkVM ballots
   * built from the registry, and the sequencer no longer serves the ballot
   * circuit artifacts the previous flow downloaded.
   *
   * @param _config - Simplified vote configuration
   * @returns A rejected promise
   */
  submitVote(_config: VoteConfig): Promise<VoteResult> {
    return Promise.reject(
      new Error(
        'submitVote is not available in this version: the sequencer no longer serves the ' +
          'ballot circuit artifacts, and votes are 16-field zkVM ballots built from the registry.'
      )
    );
  }

  /**
   * Get the status of a submitted vote
   *
   * @param processId - The process ID
   * @param voteId - The vote ID
   * @returns Promise resolving to vote status information, with the error text of an `error` vote
   */
  async getVoteStatus(processId: string, voteId: string): Promise<VoteStatusInfo> {
    const status = await this.apiService.nodes.getVoteStatus(processId, voteId);

    return {
      voteId,
      status: status.status,
      ...(status.error !== undefined && { error: status.error }),
      processId,
    };
  }

  /**
   * Check if an address has voted in a process
   *
   * @param processId - The process ID
   * @param address - The voter's address
   * @returns Promise resolving to boolean indicating if the address has voted
   */
  async hasAddressVoted(processId: string, address: string): Promise<boolean> {
    return this.apiService.nodes.firstAnswer(n => n.hasAddressVoted(processId, address));
  }

  /**
   * Watch vote status changes in real-time using an async generator.
   * Yields each status change as it happens, allowing for reactive UI updates.
   *
   * @param processId - The process ID
   * @param voteId - The vote ID
   * @param options - Optional configuration
   * @returns AsyncGenerator yielding vote status updates
   *
   * @example
   * ```typescript
   * const vote = await sdk.submitVote({ processId, choices: [1] });
   *
   * for await (const statusInfo of sdk.watchVoteStatus(vote.processId, vote.voteId)) {
   *   console.log(`Vote status: ${statusInfo.status}`);
   *
   *   switch (statusInfo.status) {
   *     case VoteStatus.Pending:
   *       console.log("⏳ Processing...");
   *       break;
   *     case VoteStatus.Settled:
   *       console.log("✅ Settled");
   *       break;
   *   }
   * }
   * ```
   */
  async *watchVoteStatus(
    processId: string,
    voteId: string,
    options?: {
      targetStatus?: VoteStatus;
      timeoutMs?: number;
      pollIntervalMs?: number;
    }
  ): AsyncGenerator<VoteStatusInfo> {
    const targetStatus = options?.targetStatus ?? VoteStatus.Settled;
    const timeoutMs = options?.timeoutMs ?? 300000;
    const pollIntervalMs = options?.pollIntervalMs ?? 5000;

    const startTime = Date.now();
    let previousStatus: VoteStatus | null = null;

    while (Date.now() - startTime < timeoutMs) {
      const statusInfo = await this.getVoteStatus(processId, voteId);

      // Only yield if status has changed
      if (statusInfo.status !== previousStatus) {
        previousStatus = statusInfo.status;
        yield statusInfo;

        // Stop if we reached target status or error
        if (statusInfo.status === targetStatus || statusInfo.status === VoteStatus.Error) {
          return;
        }
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Vote did not reach status ${targetStatus} within ${timeoutMs}ms`);
  }

  /**
   * Wait for a vote to reach a specific status.
   * This is a simpler alternative to watchVoteStatus() that returns only the final status.
   *
   * @param processId - The process ID
   * @param voteId - The vote ID
   * @param targetStatus - The target status to wait for (default: "settled")
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 300000 = 5 minutes)
   * @param pollIntervalMs - Polling interval in milliseconds (default: 5000 = 5 seconds)
   * @returns Promise resolving to final vote status
   */
  async waitForVoteStatus(
    processId: string,
    voteId: string,
    targetStatus: VoteStatus = VoteStatus.Settled,
    timeoutMs: number = 300000,
    pollIntervalMs: number = 5000
  ): Promise<VoteStatusInfo> {
    // Use watchVoteStatus internally and return final status
    let finalStatus: VoteStatusInfo | null = null;

    for await (const statusInfo of this.watchVoteStatus(processId, voteId, {
      targetStatus,
      timeoutMs,
      pollIntervalMs,
    })) {
      finalStatus = statusInfo;
    }

    if (!finalStatus) {
      throw new Error(`Vote did not reach status ${targetStatus} within ${timeoutMs}ms`);
    }

    return finalStatus;
  }
}
