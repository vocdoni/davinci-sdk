import { Signer } from "ethers";
import { VocdoniApiService } from "../api/ApiService";
import { DavinciCrypto, DavinciCryptoInputs, DavinciCryptoOutput } from "../../sequencer/DavinciCryptoService";
import { CircomProof, Groth16Proof, ProofInputs as Groth16ProofInputs } from "../../sequencer/CircomProofService";
import { CensusOrigin, CensusProof } from "../../census/types";
import { VoteRequest, VoteBallot, VoteProof, VoteStatus } from "../../sequencer/api/types";
import { BallotMode } from "../types";

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
 * Service that orchestrates the complete voting workflow
 * Handles all the complex cryptographic operations and API calls internally
 */
export class VoteOrchestrationService {
    constructor(
        private apiService: VocdoniApiService,
        private getCrypto: () => Promise<DavinciCrypto>,
        private signer: Signer
    ) {}

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
            throw new Error("Process is not currently accepting votes");
        }

        // 2. Get voter address from signer
        const voterAddress = await this.signer.getAddress();

        // 3. Check if voter has already voted
        const hasVoted = await this.apiService.sequencer.hasAddressVoted(config.processId, voterAddress);
        if (hasVoted) {
            throw new Error("This address has already voted in this process");
        }

        // 4. Get census proof (weight will be retrieved from the proof)
        const censusProof = await this.getCensusProof(
            process.census.censusOrigin,
            process.census.censusRoot,
            voterAddress,
            config.processId
        );

        // 5. Generate vote proof inputs
        const { voteId, cryptoOutput, circomInputs } = await this.generateVoteProofInputs(
            config.processId,
            voterAddress,
            process.encryptionKey,
            process.ballotMode,
            config.choices,
            censusProof.weight,
            config.randomness
        );

        // 6. Generate zk-SNARK proof
        const { proof } = await this.generateZkProof(circomInputs);

        // 7. Sign the vote
        const signature = await this.signVote(voteId);

        // 8. Submit the vote
        await this.submitVoteRequest({
            processId: config.processId,
            censusProof,
            ballot: cryptoOutput.ballot,
            ballotProof: proof,
            ballotInputsHash: cryptoOutput.ballotInputsHash,
            address: voterAddress,
            signature,
            voteId
        });

        // 9. Get initial vote status
        const status = await this.apiService.sequencer.getVoteStatus(config.processId, voteId);

        return {
            voteId,
            signature,
            voterAddress,
            processId: config.processId,
            status: status.status
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
            processId
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
     * Wait for a vote to reach a specific status
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
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeoutMs) {
            const statusInfo = await this.getVoteStatus(processId, voteId);
            
            if (statusInfo.status === targetStatus || statusInfo.status === VoteStatus.Error) {
                return statusInfo;
            }
            
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
        
        throw new Error(`Vote did not reach status ${targetStatus} within ${timeoutMs}ms`);
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
        if (censusOrigin === CensusOrigin.CensusOriginMerkleTree) {
            // Get Merkle proof from census API
            return this.apiService.census.getCensusProof(censusRoot, voterAddress);
        } else if (censusOrigin === CensusOrigin.CensusOriginCSP) {
            // Generate CSP proof using DavinciCrypto
            const crypto = await this.getCrypto();
            
            // For CSP, we need the CSP private key - this should be configured in the service
            // For now, we'll throw an error indicating this needs to be configured
            throw new Error("CSP voting requires CSP private key configuration. Please use the full voting workflow for CSP processes.");
        } else {
            throw new Error(`Unsupported census origin: ${censusOrigin}`);
        }
    }

    /**
     * Generate vote proof inputs using DavinciCrypto
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
        cryptoOutput: DavinciCryptoOutput;
        circomInputs: Groth16ProofInputs;
    }> {
        const crypto = await this.getCrypto();

        // Generate randomness for vote encryption
        // TODO: This hardcoded randomness will be replaced with proper random generation in the future
        const randomness = customRandomness || "a1b2c3d4e5f6789a";
        const k = BigInt("0x" + randomness).toString();

        // Validate choices based on ballot mode
        this.validateChoices(choices, ballotMode);
        
        // Use choices directly as field values (no conversion for this version)
        const fieldValues = choices.map(choice => choice.toString());

        const inputs: DavinciCryptoInputs = {
            address: voterAddress.replace(/^0x/, ""),
            processID: processId.replace(/^0x/, ""),
            encryptionKey: [encryptionKey.x, encryptionKey.y],
            k,
            ballotMode,
            weight,
            fieldValues
        };

        const cryptoOutput = await crypto.proofInputs(inputs);

        return {
            voteId: cryptoOutput.voteId,
            cryptoOutput,
            circomInputs: cryptoOutput.circomInputs as Groth16ProofInputs
        };
    }

    /**
     * Validate user choices based on ballot mode
     */
    private validateChoices(choices: number[], ballotMode: BallotMode): void {
        const numFields = ballotMode.numFields;
        const maxValue = parseInt(ballotMode.maxValue);
        const minValue = parseInt(ballotMode.minValue);
        
        if (choices.length !== numFields) {
            throw new Error(`Expected ${numFields} choices, got ${choices.length}`);
        }

        // Validate each choice is within the allowed range
        for (let i = 0; i < choices.length; i++) {
            const choice = choices[i];
            
            if (choice < minValue || choice > maxValue) {
                throw new Error(`Choice ${choice} is out of range [${minValue}, ${maxValue}]`);
            }
        }
    }

    /**
     * Generate zk-SNARK proof using CircomProof
     */
    private async generateZkProof(circomInputs: Groth16ProofInputs): Promise<{
        proof: Groth16Proof;
        publicSignals: string[];
    }> {
        // Get circuit URLs from sequencer info
        const info = await this.apiService.sequencer.getInfo();
        
        const circomProof = new CircomProof({
            wasmUrl: info.circuitUrl,
            zkeyUrl: info.provingKeyUrl,
            vkeyUrl: info.verificationKeyUrl
        });

        const { proof, publicSignals } = await circomProof.generate(circomInputs);
        
        // Verify the proof
        const isValid = await circomProof.verify(proof, publicSignals);
        if (!isValid) {
            throw new Error("Generated proof is invalid");
        }

        return { proof, publicSignals };
    }

    /**
     * Sign the vote using the signer
     */
    private async signVote(voteId: string): Promise<string> {
        const sigBytes = Uint8Array.from(Buffer.from(voteId.replace(/^0x/, ""), "hex"));
        return this.signer.signMessage(sigBytes);
    }

    /**
     * Submit the vote request to the sequencer
     */
    private async submitVoteRequest(voteRequest: VoteRequest): Promise<void> {
        // Convert Groth16Proof to VoteProof format
        const ballotProof: VoteProof = {
            pi_a: voteRequest.ballotProof.pi_a,
            pi_b: voteRequest.ballotProof.pi_b,
            pi_c: voteRequest.ballotProof.pi_c,
            protocol: voteRequest.ballotProof.protocol
        };

        const request: VoteRequest = {
            ...voteRequest,
            ballotProof
        };

        await this.apiService.sequencer.submitVote(request);
    }
}
