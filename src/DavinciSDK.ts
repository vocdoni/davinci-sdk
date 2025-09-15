import { Signer } from "ethers";
import { VocdoniApiService } from "./core/api/ApiService";
import { ProcessRegistryService } from "./contracts/ProcessRegistryService";
import { OrganizationRegistryService } from "./contracts/OrganizationRegistry";
import { DavinciCrypto } from "./sequencer/DavinciCryptoService";
import { deployedAddresses } from "./contracts/SmartContractService";
import { Environment, EnvironmentOptions, resolveConfiguration } from "./core/config";
import { ProcessOrchestrationService, ProcessConfig, ProcessCreationResult } from "./core/process";

/**
 * Configuration interface for the DavinciSDK
 */
export interface DavinciSDKConfig {
    /** Ethers.js Signer (can be from MetaMask, Wallet, or any other provider) */
    signer: Signer;
    
    /** Environment to use (dev, stg, prod) - used to set default URLs and chain if not explicitly provided */
    environment?: Environment;
    
    /** Sequencer API URL for Vocdoni services (optional, defaults based on environment) */
    sequencerUrl?: string;
    
    /** Census API URL for census management (optional, defaults based on environment) */
    censusUrl?: string;
    
    /** Chain name (optional, defaults based on environment) */
    chain?: 'sepolia' | 'mainnet';
    
    /** Custom contract addresses (optional, uses defaults if not provided) */
    contractAddresses?: {
        processRegistry?: string;
        organizationRegistry?: string;
        stateTransitionVerifier?: string;
        resultsVerifier?: string;
        sequencerRegistry?: string;
    };
    
    /** Whether to force using contract addresses from sequencer info (optional, defaults to false) */
    useSequencerAddresses?: boolean;
}


/**
 * Internal configuration interface (without environment)
 */
interface InternalDavinciSDKConfig {
    signer: Signer;
    sequencerUrl: string;
    censusUrl: string;
    chain: 'sepolia' | 'mainnet';
    contractAddresses: {
        processRegistry?: string;
        organizationRegistry?: string;
        stateTransitionVerifier?: string;
        resultsVerifier?: string;
        sequencerRegistry?: string;
    };
    useSequencerAddresses: boolean;
}

/**
 * Simplified SDK class that encapsulates all Vocdoni DaVinci functionality
 */
export class DavinciSDK {
    private config: InternalDavinciSDKConfig;
    private apiService: VocdoniApiService;
    private _processRegistry?: ProcessRegistryService;
    private _organizationRegistry?: OrganizationRegistryService;
    private _processOrchestrator?: ProcessOrchestrationService;
    private davinciCrypto?: DavinciCrypto;
    private initialized = false;

    constructor(config: DavinciSDKConfig) {
        // Resolve configuration based on environment and custom overrides
        const resolvedConfig = resolveConfiguration({
            environment: config.environment,
            customUrls: {
                sequencer: config.sequencerUrl,
                census: config.censusUrl
            },
            customChain: config.chain
        });

        // Set defaults for optional parameters
        this.config = {
            signer: config.signer,
            sequencerUrl: config.sequencerUrl ?? resolvedConfig.sequencer,
            censusUrl: config.censusUrl ?? resolvedConfig.census,
            chain: config.chain ?? resolvedConfig.chain,
            contractAddresses: config.contractAddresses || {},
            useSequencerAddresses: config.useSequencerAddresses || false
        };

        // Initialize API service
        this.apiService = new VocdoniApiService({
            sequencerURL: this.config.sequencerUrl,
            censusURL: this.config.censusUrl
        });

        // Contract services will be initialized lazily when accessed
    }

    /**
     * Initialize the SDK and all its components
     * This must be called before using any SDK functionality
     */
    async init(): Promise<void> {
        if (this.initialized) return;

        // If useSequencerAddresses is true, fetch sequencer info and update contract addresses
        if (this.config.useSequencerAddresses) {
            await this.updateContractAddressesFromSequencer();
        }

        // Initialize DavinciCrypto if needed (lazy initialization)
        // This will be done when crypto operations are first needed

        this.initialized = true;
    }

    /**
     * Get the API service for direct access to sequencer and census APIs
     */
    get api(): VocdoniApiService {
        return this.apiService;
    }

    /**
     * Get the process registry service for process management
     */
    get processes(): ProcessRegistryService {
        if (!this._processRegistry) {
            const processRegistryAddress = this.resolveContractAddress('processRegistry');
            this._processRegistry = new ProcessRegistryService(processRegistryAddress, this.config.signer);
        }
        return this._processRegistry;
    }

    /**
     * Get the organization registry service for organization management
     */
    get organizations(): OrganizationRegistryService {
        if (!this._organizationRegistry) {
            const organizationRegistryAddress = this.resolveContractAddress('organizationRegistry');
            this._organizationRegistry = new OrganizationRegistryService(organizationRegistryAddress, this.config.signer);
        }
        return this._organizationRegistry;
    }

    /**
     * Get or initialize the DavinciCrypto service for cryptographic operations
     */
    async getCrypto(): Promise<DavinciCrypto> {
        if (!this.davinciCrypto) {
            // Get WASM URLs from sequencer info
            const info = await this.apiService.sequencer.getInfo();
            
            this.davinciCrypto = new DavinciCrypto({
                wasmExecUrl: info.ballotProofWasmHelperExecJsUrl,
                wasmUrl: info.ballotProofWasmHelperUrl
            });

            await this.davinciCrypto.init();
        }

        return this.davinciCrypto;
    }

    /**
     * Get the process orchestration service for simplified process creation
     */
    get processOrchestrator(): ProcessOrchestrationService {
        if (!this._processOrchestrator) {
            this._processOrchestrator = new ProcessOrchestrationService(
                this.processes,
                this.apiService,
                this.organizations,
                () => this.getCrypto(),
                this.config.signer
            );
        }
        return this._processOrchestrator;
    }

    /**
     * Creates a complete voting process with minimal configuration.
     * This is the ultra-easy method for end users that handles all the complex orchestration internally.
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
     * 
     * @example
     * ```typescript
     * // Option 1: Using duration (traditional approach)
     * const result1 = await sdk.createProcess({
     *   title: "My Election",
     *   description: "A simple election",
     *   census: {
     *     type: CensusOrigin.CensusOriginMerkleTree,
     *     root: "0x1234...",
     *     size: 100,
     *     uri: "ipfs://your-census-uri"
     *   },
     *   ballot: {
     *     numFields: 2,
     *     maxValue: "3",
     *     minValue: "0",
     *     uniqueValues: false,
     *     costFromWeight: false,
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
            throw new Error("SDK must be initialized before creating processes. Call sdk.init() first.");
        }
        
        return this.processOrchestrator.createProcess(config);
    }

    /**
     * Resolve contract address based on configuration priority:
     * 1. If useSequencerAddresses is true: addresses from sequencer (highest priority)
     * 2. Custom addresses from config (if provided by user)
     * 3. Default deployed addresses from npm package
     */
    private resolveContractAddress(contractName: keyof NonNullable<DavinciSDKConfig['contractAddresses']>): string {
        // 1. If useSequencerAddresses is true, we'll get addresses from sequencer during init()
        // For now, return default addresses - they will be updated in updateContractAddressesFromSequencer()
        if (this.config.useSequencerAddresses) {
            // Return default for now, will be updated during init()
            return this.getDefaultContractAddress(contractName);
        }

        // 2. Check if custom address is provided by user
        const customAddress = this.config.contractAddresses[contractName];
        if (customAddress) {
            return customAddress;
        }

        // 3. Use default deployed addresses from npm package
        return this.getDefaultContractAddress(contractName);
    }

    /**
     * Get default contract address from deployed addresses
     */
    private getDefaultContractAddress(contractName: keyof NonNullable<DavinciSDKConfig['contractAddresses']>): string {
        const chain = this.config.chain;
        switch (contractName) {
            case 'processRegistry':
                return deployedAddresses.processRegistry[chain];
            case 'organizationRegistry':
                return deployedAddresses.organizationRegistry[chain];
            case 'stateTransitionVerifier':
                return deployedAddresses.stateTransitionVerifierGroth16[chain];
            case 'resultsVerifier':
                return deployedAddresses.resultsVerifierGroth16[chain];
            case 'sequencerRegistry':
                return deployedAddresses.sequencerRegistry[chain];
            default:
                throw new Error(`Unknown contract: ${contractName}`);
        }
    }

    /**
     * Update contract addresses from sequencer info if useSequencerAddresses is enabled
     * Sequencer addresses have priority over user-provided addresses
     */
    private async updateContractAddressesFromSequencer(): Promise<void> {
        try {
            const info = await this.apiService.sequencer.getInfo();
            const contracts = info.contracts;

            // Update process registry with sequencer address (overrides user address)
            if (contracts.process) {
                this._processRegistry = new ProcessRegistryService(contracts.process, this.config.signer);
                this.config.contractAddresses.processRegistry = contracts.process;
            }

            // Update organization registry with sequencer address (overrides user address)
            if (contracts.organization) {
                this._organizationRegistry = new OrganizationRegistryService(contracts.organization, this.config.signer);
                this.config.contractAddresses.organizationRegistry = contracts.organization;
            }

            // Update other contract addresses from sequencer (overrides user addresses)
            if (contracts.stateTransitionVerifier) {
                this.config.contractAddresses.stateTransitionVerifier = contracts.stateTransitionVerifier;
            }

            if (contracts.resultsVerifier) {
                this.config.contractAddresses.resultsVerifier = contracts.resultsVerifier;
            }

            // Note: sequencerRegistry is not provided by the sequencer info endpoint
        } catch (error) {
            console.warn('Failed to fetch contract addresses from sequencer, using defaults:', error);
        }
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
}
