import { Signer } from "ethers";
import { VocdoniApiService } from "../api/ApiService";
import { ProcessRegistryService, ProcessStatus } from "../../contracts/ProcessRegistryService";
import { OrganizationRegistryService } from "../../contracts/OrganizationRegistry";
import { DavinciCrypto } from "../../sequencer/DavinciCryptoService";
import { signProcessCreation } from "../../sequencer/api/helpers";
import { BallotMode, Census, EncryptionKey } from "../types";
import { CensusOrigin } from "../../census/types";
import { getElectionMetadataTemplate } from "../types/metadata";

/**
 * Configuration for creating a process
 */
export interface ProcessConfig {
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
    
    /** Process timing - use either duration-based or date-based configuration */
    timing: {
        /** Start date/time (Date object, ISO string, or Unix timestamp, default: now + 60 seconds) */
        startDate?: Date | string | number;
        /** Duration in seconds (required if endDate is not provided) */
        duration?: number;
        /** End date/time (Date object, ISO string, or Unix timestamp, cannot be used with duration) */
        endDate?: Date | string | number;
    };
    
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
 * Result of process creation
 */
export interface ProcessCreationResult {
    /** The created process ID */
    processId: string;
    /** Transaction hash of the on-chain process creation */
    transactionHash: string;
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
     * Creates a complete voting process with minimal configuration
     * This method handles all the complex orchestration internally
     */
    async createProcess(config: ProcessConfig): Promise<ProcessCreationResult> {
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
            censusOrigin: config.census.type
        });

        // 7. Create census object for on-chain call
        const census: Census = {
            censusOrigin: config.census.type,
            maxVotes: config.census.size.toString(),
            censusRoot,
            censusURI: config.census.uri
        };

        // 8. Create encryption key object
        const encryptionKey: EncryptionKey = {
            x: sequencerResult.encryptionPubKey[0],
            y: sequencerResult.encryptionPubKey[1]
        };

        // 9. Submit on-chain transaction
        const txStream = this.processRegistry.newProcess(
            ProcessStatus.READY,
            startTime,
            duration,
            ballotMode,
            census,
            metadataUri,
            encryptionKey,
            BigInt(sequencerResult.stateRoot)
        );

        // Execute the transaction and capture the hash
        let transactionHash = "unknown";
        for await (const event of txStream) {
            if (event.status === "pending") {
                transactionHash = event.hash;
            } else if (event.status === "completed") {
                break;
            } else if (event.status === "failed") {
                throw event.error;
            } else if (event.status === "reverted") {
                throw new Error(`Transaction reverted: ${event.reason || "unknown reason"}`);
            }
        }

        return {
            processId,
            transactionHash
        };
    }

    /**
     * Validates and calculates timing parameters
     */
    private calculateTiming(timing: ProcessConfig['timing']): { startTime: number; duration: number } {
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
        const startTime = startDate ? this.dateToUnixTimestamp(startDate) : Math.floor(Date.now() / 1000) + 60;

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
                throw new Error("End date must be after start date.");
            }
        }

        // Validate that start time is not in the past (with 30 second buffer)
        const now = Math.floor(Date.now() / 1000);
        if (startTime < now - 30) {
            throw new Error("Start date cannot be in the past.");
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
                throw new Error("Invalid Date object provided.");
            }
            return Math.floor(date.getTime() / 1000);
        }

        throw new Error("Invalid date format. Use Date object, ISO string, or Unix timestamp.");
    }

    /**
     * Creates metadata from the simplified configuration
     */
    private createMetadata(config: ProcessConfig) {
        const metadata = getElectionMetadataTemplate();
        
        metadata.title.default = config.title;
        metadata.description.default = config.description || "";

        // Questions are required
        if (!config.questions || config.questions.length === 0) {
            throw new Error("Questions are required. Please provide at least one question with choices.");
        }

        metadata.questions = config.questions.map(q => ({
            title: { default: q.title },
            description: { default: q.description || "" },
            meta: {},
            choices: q.choices.map(c => ({
                title: { default: c.title },
                value: c.value,
                meta: {}
            }))
        }));

        return metadata;
    }
}
