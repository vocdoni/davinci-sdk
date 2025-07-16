import { Signer, Provider } from "ethers";
import { VocdoniApiService } from "./api/ApiService";
import { ProcessRegistryService, OrganizationRegistryService, deployedAddresses, ProcessStatus } from "../contracts";
import { ElectionMetadata, getElectionMetadataTemplate, BallotMode } from "./types";
import { ElectionBuilder } from "../election";

/**
 * Custom error for missing contract addresses
 */
export class MissingContractAddressesError extends Error {
    constructor(chain: string, availableChains: string[]) {
        super(`No contract addresses found for chain '${chain}'. Available chains with default addresses: ${availableChains.join(', ')}. Please provide contract addresses manually.`);
        this.name = 'MissingContractAddressesError';
    }
}

/**
 * Configuration interface for the DavinciSDK
 */
export interface DavinciSDKConfig {
    /** Ethers.js Signer (can be from MetaMask, Wallet, or any other provider) */
    signer: Signer;
    /** Sequencer API URL for Vocdoni services (optional) */
    sequencerUrl?: string;
    /** Census API URL for census management (optional) */
    censusUrl?: string;
    /** Chain name (optional, defaults to mainnet) */
    chain?: string;
    /** Custom contract addresses (optional, uses defaults if not provided) */
    contractAddresses?: {
        processRegistry?: string;
        organizationRegistry?: string;
        stateTransitionVerifier?: string;
        resultsVerifier?: string;
        sequencerRegistry?: string;
    };
}

/**
 * Simplified interface for creating a process
 */
export interface CreateProcessParams {
    /** Title of the election */
    title: string;
    /** Description of the election */
    description: string;
    /** Census root hash from the census service */
    censusRoot: string;
    /** Maximum number of votes allowed */
    maxVotes: string;
    /** Duration of the election in seconds */
    duration: number;
    /** Start time as Unix timestamp (optional, defaults to now) */
    startTime?: number;
    /** Election questions and choices (optional, uses default Yes/No if not provided) */
    questions?: Array<{
        title: string;
        description?: string;
        choices: Array<{
            title: string;
            value: number;
        }>;
    }>;
    /** Media URLs for the election */
    media?: {
        header?: string;
        logo?: string;
    };
}

/**
 * Response from creating a process
 */
export interface ProcessCreationResult {
    /** The process ID */
    processId: string;
    /** Transaction hash from the on-chain process creation */
    transactionHash: string;
    /** Encryption public key for the process */
    encryptionPubKey: [string, string];
    /** Initial state root */
    stateRoot: string;
    /** Metadata hash */
    metadataHash: string;
}

/**
 * Main DavinciSDK class that simplifies interaction with the Vocdoni voting protocol
 */
export class DavinciSDK {
    private provider: Provider;
    private signer: Signer;
    private api: VocdoniApiService;
    private processRegistry?: ProcessRegistryService;
    private organizationRegistry?: OrganizationRegistryService;
    private chain: string;
    private contractAddresses: {
        processRegistry?: string;
        organizationRegistry?: string;
        stateTransitionVerifier?: string;
        resultsVerifier?: string;
        sequencerRegistry?: string;
    };

    constructor(config: DavinciSDKConfig) {
        // Validate that at least one URL is provided
        if (!config.sequencerUrl && !config.censusUrl) {
            throw new Error('At least one of sequencerUrl or censusUrl must be provided');
        }

        // Use the provided signer directly
        this.signer = config.signer;
        
        // Get provider from signer
        if (!config.signer.provider) {
            throw new Error('Signer must have a provider attached');
        }
        this.provider = config.signer.provider;

        // Set chain - try to get from signer's provider first, then default to mainnet
        this.chain = config.chain || this.getChainFromProvider() || 'mainnet';

        // Set contract addresses
        this.contractAddresses = this.initializeContractAddresses(config.contractAddresses);

        // Initialize API service
        this.api = new VocdoniApiService({
            sequencerURL: config.sequencerUrl,
            censusURL: config.censusUrl
        });

        // Initialize contract services (only if addresses are provided)
        if (this.contractAddresses.processRegistry) {
            this.processRegistry = new ProcessRegistryService(this.contractAddresses.processRegistry, this.signer);
        }
        if (this.contractAddresses.organizationRegistry) {
            this.organizationRegistry = new OrganizationRegistryService(this.contractAddresses.organizationRegistry, this.signer);
        }
    }

    /**
     * Get chain name from provider network
     */
    private getChainFromProvider(): string | null {
        try {
            // Try to get network info from provider
            const network = (this.provider as any)._network;
            if (network?.name && network.name !== 'unknown') {
                return network.name;
            }
        } catch (error) {
            // If we can't get network info, return null to fall back to default
        }
        return null;
    }

    /**
     * Initialize contract addresses
     */
    private initializeContractAddresses(customAddresses?: DavinciSDKConfig['contractAddresses']) {
        const addresses: typeof customAddresses = {};

        // If custom addresses are provided, use them
        if (customAddresses) {
            return { ...customAddresses };
        }

        // Otherwise, try to use default addresses for the chain (if available)
        const defaultAddresses = deployedAddresses;
        const chainKey = this.chain as keyof typeof defaultAddresses.processRegistry;
        
        if (defaultAddresses.processRegistry[chainKey]) {
            addresses.processRegistry = defaultAddresses.processRegistry[chainKey];
        }
        if (defaultAddresses.organizationRegistry[chainKey]) {
            addresses.organizationRegistry = defaultAddresses.organizationRegistry[chainKey];
        }
        if (defaultAddresses.stateTransitionVerifierGroth16[chainKey]) {
            addresses.stateTransitionVerifier = defaultAddresses.stateTransitionVerifierGroth16[chainKey];
        }
        if (defaultAddresses.resultsVerifierGroth16[chainKey]) {
            addresses.resultsVerifier = defaultAddresses.resultsVerifierGroth16[chainKey];
        }
        if (defaultAddresses.sequencerRegistry[chainKey]) {
            addresses.sequencerRegistry = defaultAddresses.sequencerRegistry[chainKey];
        }

        // Check if we have any addresses at all
        const hasAnyAddress = Object.values(addresses).some(address => address !== undefined);
        
        if (!hasAnyAddress) {
            // No custom addresses provided and no default addresses for this chain
            const availableChains = Object.keys(defaultAddresses.processRegistry);
            throw new MissingContractAddressesError(this.chain, availableChains);
        }

        return addresses;
    }

    /**
     * Get the signer address
     */
    async getAddress(): Promise<string> {
        return await this.signer.getAddress();
    }

    /**
     * Get the current network
     */
    getNetwork(): string {
        return this.chain;
    }

    /**
     * Get contract addresses being used
     */
    getContractAddresses() {
        return { ...this.contractAddresses };
    }

    /**
     * Ping the API to check connectivity
     */
    async ping(): Promise<void> {
        if (!this.api.sequencer) {
            throw new Error('Sequencer service is not available. Please provide a sequencerUrl in the configuration.');
        }
        await this.api.sequencer.ping();
    }

    /**
     * Create a new voting process with simplified parameters
     */
    async createProcess(params: CreateProcessParams): Promise<ProcessCreationResult> {
        // Validate required services
        if (!this.api.sequencer) {
            throw new Error('Sequencer service is not available. Please provide a sequencerUrl in the configuration.');
        }
        if (!this.processRegistry) {
            throw new Error('Process registry is not available. Please ensure contract addresses are configured.');
        }

        // Create metadata
        const metadata = this.buildMetadata(params);
        
        // Upload metadata to sequencer
        const metadataHash = await this.api.sequencer.pushMetadata(metadata);

        // Get next process ID
        const organizationId = await this.getAddress();
        const processId = await this.processRegistry.getNextProcessId(organizationId);

        // Create default ballot mode (single choice)
        const ballotMode: BallotMode = {
            maxCount: 1,
            maxValue: "1",
            minValue: "0",
            forceUniqueness: true,
            costFromWeight: false,
            costExponent: 1,
            maxTotalCost: "1",
            minTotalCost: "0"
        };

        // Create census object
        const census = {
            censusOrigin: 1, // Off-chain census
            maxVotes: params.maxVotes,
            censusRoot: params.censusRoot,
            censusURI: "" // Empty for off-chain census
        };

        // Create encryption key (placeholder - in real implementation this would come from the sequencer)
        const encryptionKey = {
            x: "0x0000000000000000000000000000000000000000000000000000000000000000",
            y: "0x0000000000000000000000000000000000000000000000000000000000000000"
        };

        const startTime = params.startTime || Math.floor(Date.now() / 1000);
        const initStateRoot = BigInt(0); // Initial state root

        // Create process on-chain
        const txStream = this.processRegistry.newProcess(
            ProcessStatus.READY,
            startTime,
            params.duration,
            ballotMode,
            census,
            metadataHash,
            encryptionKey,
            initStateRoot
        );

        // Wait for transaction to complete and get transaction hash
        let transactionHash = '';
        let txResult: any;
        
        for await (const event of txStream) {
            if (event.status === 'pending') {
                transactionHash = event.hash;
            } else if (event.status === 'completed') {
                txResult = event.response;
                break;
            } else if (event.status === 'failed') {
                throw event.error;
            } else if (event.status === 'reverted') {
                throw new Error(`Transaction reverted: ${event.reason || 'unknown reason'}`);
            }
        }

        // Sign the process creation for sequencer
        const signature = await this.signProcessCreation(processId);

        // Register process with sequencer
        const sequencerResponse = await this.api.sequencer.createProcess({
            processId,
            censusRoot: params.censusRoot,
            ballotMode,
            signature
        });

        return {
            processId,
            transactionHash,
            encryptionPubKey: sequencerResponse.encryptionPubKey,
            stateRoot: sequencerResponse.stateRoot,
            metadataHash
        };
    }

    /**
     * Build election metadata from simplified parameters
     */
    private buildMetadata(params: CreateProcessParams): ElectionMetadata {
        const metadata = getElectionMetadataTemplate();
        
        metadata.title.default = params.title;
        metadata.description.default = params.description;
        
        if (params.media) {
            metadata.media.header = params.media.header || '';
            metadata.media.logo = params.media.logo || '';
        }

        if (params.questions && params.questions.length > 0) {
            metadata.questions = params.questions.map(q => ({
                title: { default: q.title },
                description: { default: q.description || '' },
                meta: {},
                choices: q.choices.map(c => ({
                    title: { default: c.title },
                    value: c.value,
                    meta: {}
                }))
            }));
        }

        return metadata;
    }

    /**
     * Create a new election using the fluent builder API
     */
    createElection(): ElectionBuilder {
        return new ElectionBuilder(this);
    }

    /**
     * Sign process creation for sequencer authentication
     */
    private async signProcessCreation(processId: string): Promise<string> {
        const message = `Create process: ${processId}`;
        return await this.signer.signMessage(message);
    }

    /**
     * Get access to the underlying API services for advanced usage
     */
    getApiServices() {
        return {
            api: this.api,
            processRegistry: this.processRegistry,
            organizationRegistry: this.organizationRegistry,
            provider: this.provider,
            signer: this.signer
        };
    }
}
