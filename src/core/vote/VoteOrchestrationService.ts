import { Signer } from 'ethers';
import { VocdoniApiService } from '../api/ApiService';
import { BallotInputGenerator } from '../../sequencer/BallotInputGenerator';
import { BallotInputsOutput } from '../../crypto/types';
import { ProofInputs as Groth16ProofInputs } from '../../sequencer/CircomProofService';
import {
  CensusOrigin,
  CensusProof,
  CensusProviders,
  assertMerkleCensusProof,
  assertCSPCensusProof,
} from '../../census/types';
import { VoteRequest, VoteBallot, VoteProof, VoteStatus } from '../../sequencer/api/types';
import { BallotMode } from '../types';

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
  private readonly verifyCircuitFiles: boolean;
  private readonly verifyProof: boolean;

  constructor(
    private apiService: VocdoniApiService,
    private getBallotInputGenerator: () => Promise<BallotInputGenerator>,
    private signer: Signer,
    private censusProviders: CensusProviders = {},
    config: VoteOrchestrationConfig = {}
  ) {
    // Default to true - verify circuit files and proof by default for security
    this.verifyCircuitFiles = config.verifyCircuitFiles ?? true;
    this.verifyProof = config.verifyProof ?? true;
  }

  /**
   * Submit a vote with simplified configuration
   * This method handles all the complex orchestration internally:
   * - Fetches process information and encryption keys
   * - Gets census proof (Merkle or CSP)
   * - Generates cryptographic proofs
   * - Signs and submits the vote
   *
   * @param config - Simplified vote configuration
   * @returns Promise resolving to vote submission result
   */
  async submitVote(config: VoteConfig): Promise<VoteResult> {
    // 1. Get process information
    const process = await this.apiService.sequencer.getProcess(config.processId);

    if (!process.isAcceptingVotes) {
      throw new Error('Process is not currently accepting votes');
    }

    // 2. Get voter address from signer
    const voterAddress = await this.signer.getAddress();

    // 3. Get census proof (weight will be retrieved from the proof)
    const censusProof = await this.getCensusProof(
      process.census.censusOrigin,
      process.census.censusRoot,
      voterAddress,
      config.processId
    );

    // 4. Generate vote proof inputs
    const { voteId, cryptoOutput, circomInputs } = await this.generateVoteProofInputs(
      config.processId,
      voterAddress,
      process.encryptionKey,
      process.ballotMode,
      config.choices,
      censusProof.weight,
      config.randomness
    );

    // 5. Sign the vote (no client-side proof generation - sequencer handles it)
    const signature = await this.signVote(voteId);

    // 6. Submit the vote (no proof - sequencer generates it)
    const voteRequest: VoteRequest = {
      processId: config.processId,
      ballot: cryptoOutput.ballot,
      ballotInputsHash: cryptoOutput.ballotInputsHash,
      address: voterAddress,
      signature,
      voteId,
    };

    // Only include censusProof for CSP (not for MerkleTree)
    if (process.census.censusOrigin === CensusOrigin.CSP) {
      voteRequest.censusProof = censusProof;
    }

    await this.apiService.sequencer.submitVote(voteRequest);

    // 8. Get initial vote status
    const status = await this.apiService.sequencer.getVoteStatus(config.processId, voteId);

    return {
      voteId,
      signature,
      voterAddress,
      processId: config.processId,
      status: status.status,
    };
  }

  /**
   * Get the status of a submitted vote
   *
   * @param processId - The process ID
   * @param voteId - The vote ID
   * @returns Promise resolving to vote status information
   */
  async getVoteStatus(processId: string, voteId: string): Promise<VoteStatusInfo> {
    const status = await this.apiService.sequencer.getVoteStatus(processId, voteId);

    return {
      voteId,
      status: status.status,
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
    return this.apiService.sequencer.hasAddressVoted(processId, address);
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
   *     case VoteStatus.Verified:
   *       console.log("✓ Verified");
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

  /**
   * Get census proof based on census origin type
   */
  private async getCensusProof(
    censusOrigin: number,
    censusRoot: string,
    voterAddress: string,
    processId: string
  ): Promise<CensusProof> {
    // Check if it's a Merkle-based census (OffchainStatic, OffchainDynamic, or Onchain)
    if (
      censusOrigin === CensusOrigin.OffchainStatic ||
      censusOrigin === CensusOrigin.OffchainDynamic ||
      censusOrigin === CensusOrigin.Onchain
    ) {
      // Use custom provider if present, otherwise get weight from sequencer
      if (this.censusProviders.merkle) {
        const proof = await this.censusProviders.merkle({
          censusRoot,
          address: voterAddress,
        });
        assertMerkleCensusProof(proof);
        return proof;
      } else {
        // For MerkleTree, only the weight is needed - get it from sequencer
        const weight = await this.apiService.sequencer.getAddressWeight(processId, voterAddress);
        
        // Return minimal census proof with just the weight
        // (full proof is not needed for MerkleTree voting)
        return {
          root: censusRoot,
          address: voterAddress,
          weight: weight,
          censusOrigin: censusOrigin as CensusOrigin.OffchainStatic | CensusOrigin.OffchainDynamic | CensusOrigin.Onchain,
          value: '',
          siblings: '',
        };
      }
    }

    if (censusOrigin === CensusOrigin.CSP) {
      if (!this.censusProviders.csp) {
        throw new Error(
          'CSP voting requires a CSP census proof provider. Pass one via VoteOrchestrationService(..., { csp: yourFn }).'
        );
      }
      const proof = await this.censusProviders.csp({
        processId,
        address: voterAddress,
      });
      assertCSPCensusProof(proof);
      return proof;
    }

    throw new Error(`Unsupported census origin: ${censusOrigin}`);
  }

  /**
   * Generate vote proof inputs using BallotInputGenerator
   */
  private async generateVoteProofInputs(
    processId: string,
    voterAddress: string,
    encryptionKey: { x: string; y: string },
    ballotMode: BallotMode,
    choices: number[],
    weight: string,
    customRandomness?: string
  ): Promise<{
    voteId: string;
    cryptoOutput: BallotInputsOutput;
    circomInputs: Groth16ProofInputs;
  }> {
    const generator = await this.getBallotInputGenerator();

    // Validate choices based on ballot mode
    this.validateChoices(choices, ballotMode);

    // Convert custom randomness if provided
    let k: string | undefined;
    if (customRandomness) {
      const hexRandomness = customRandomness.startsWith('0x')
        ? customRandomness
        : '0x' + customRandomness;
      k = BigInt(hexRandomness).toString();
    }

    // Generate ballot inputs using the new TypeScript implementation
    const result = await generator.generateInputs(
      processId.replace(/^0x/, ''),
      voterAddress.replace(/^0x/, ''),
      encryptionKey,
      ballotMode,
      choices,
      weight,
      k
    );

    return {
      voteId: result.voteId,
      cryptoOutput: result,
      circomInputs: result.circomInputs,
    };
  }

  /**
   * Validate user choices based on ballot mode
   */
  private validateChoices(choices: number[], ballotMode: BallotMode): void {
    const maxValue = parseInt(ballotMode.maxValue);
    const minValue = parseInt(ballotMode.minValue);

    // Validate each choice is within the allowed range
    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i];

      if (choice < minValue || choice > maxValue) {
        throw new Error(`Choice ${choice} is out of range [${minValue}, ${maxValue}]`);
      }
    }
  }

  private hexToBytes(hex: string): Uint8Array {
    const clean = hex.replace(/^0x/, '');
    if (clean.length % 2) throw new Error('Invalid hex length');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }

  /**
   * Sign the vote using the signer
   */
  private async signVote(voteId: string): Promise<string> {
    return this.signer.signMessage(this.hexToBytes(voteId));
  }
}
