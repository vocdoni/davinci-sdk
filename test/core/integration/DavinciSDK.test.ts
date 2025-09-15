import { DavinciSDK, DavinciSDKConfig } from '../../../src/DavinciSDK';
import { Wallet, JsonRpcProvider } from 'ethers';
import { DEFAULT_ENVIRONMENT_URLS } from '../../../src/core/config/urls';

describe('DavinciSDK Integration Tests', () => {
    let mockSigner: Wallet;

    beforeEach(() => {
        // Create a mock provider and signer for testing
        const mockProvider = new JsonRpcProvider('http://localhost:8545'); // Mock RPC endpoint
        mockSigner = new Wallet('0x1234567890123456789012345678901234567890123456789012345678901234', mockProvider);
    });

    describe('Environment Configuration', () => {
        it('should use dev environment URLs and chain', () => {
            const sdk = new DavinciSDK({
                signer: mockSigner,
                environment: 'dev'
            });

            const config = sdk.getConfig();
            
            expect(config.sequencerUrl).toBe(DEFAULT_ENVIRONMENT_URLS.dev.sequencer);
            expect(config.censusUrl).toBe(DEFAULT_ENVIRONMENT_URLS.dev.census);
            expect(config.chain).toBe(DEFAULT_ENVIRONMENT_URLS.dev.chain);
        });

        it('should use stg environment URLs and chain', () => {
            const sdk = new DavinciSDK({
                signer: mockSigner,
                environment: 'stg'
            });

            const config = sdk.getConfig();
            
            expect(config.sequencerUrl).toBe(DEFAULT_ENVIRONMENT_URLS.stg.sequencer);
            expect(config.censusUrl).toBe(DEFAULT_ENVIRONMENT_URLS.stg.census);
            expect(config.chain).toBe(DEFAULT_ENVIRONMENT_URLS.stg.chain);
        });

        it('should use prod environment URLs and chain (default)', () => {
            const sdk = new DavinciSDK({
                signer: mockSigner,
                environment: 'prod'
            });

            const config = sdk.getConfig();
            
            expect(config.sequencerUrl).toBe(DEFAULT_ENVIRONMENT_URLS.prod.sequencer);
            expect(config.censusUrl).toBe(DEFAULT_ENVIRONMENT_URLS.prod.census);
            expect(config.chain).toBe(DEFAULT_ENVIRONMENT_URLS.prod.chain);
        });

        it('should default to prod environment when no environment specified', () => {
            const sdk = new DavinciSDK({
                signer: mockSigner
            });

            const config = sdk.getConfig();
            
            expect(config.sequencerUrl).toBe(DEFAULT_ENVIRONMENT_URLS.prod.sequencer);
            expect(config.censusUrl).toBe(DEFAULT_ENVIRONMENT_URLS.prod.census);
            expect(config.chain).toBe(DEFAULT_ENVIRONMENT_URLS.prod.chain);
        });

        it('should override environment URLs with custom URLs', () => {
            const customSequencerUrl = 'https://custom-sequencer.example.com';
            const customCensusUrl = 'https://custom-census.example.com';

            const sdk = new DavinciSDK({
                signer: mockSigner,
                environment: 'dev',
                sequencerUrl: customSequencerUrl,
                censusUrl: customCensusUrl
            });

            const config = sdk.getConfig();
            
            expect(config.sequencerUrl).toBe(customSequencerUrl);
            expect(config.censusUrl).toBe(customCensusUrl);
            expect(config.chain).toBe('sepolia'); // Should still use environment chain
        });

        it('should override environment chain with custom chain', () => {
            const sdk = new DavinciSDK({
                signer: mockSigner,
                environment: 'dev',
                chain: 'mainnet'
            });

            const config = sdk.getConfig();
            
            expect(config.sequencerUrl).toBe(DEFAULT_ENVIRONMENT_URLS.dev.sequencer);
            expect(config.censusUrl).toBe(DEFAULT_ENVIRONMENT_URLS.dev.census);
            expect(config.chain).toBe('mainnet'); // Should use custom chain
        });
    });

    describe('Contract Addresses Configuration', () => {
        it('should use default contract addresses when no custom addresses provided', () => {
            const sdk = new DavinciSDK({
                signer: mockSigner,
                environment: 'dev' // Uses sepolia chain
            });

            const config = sdk.getConfig();
            
            // Should be empty initially (addresses are resolved internally)
            expect(config.contractAddresses).toEqual({});
            expect(sdk.processes).toBeDefined();
            expect(sdk.organizations).toBeDefined();
        });

        it('should store custom contract addresses when provided', () => {
            const customAddresses = {
                processRegistry: '0xCustomProcessRegistry123456789012345678901234',
                organizationRegistry: '0xCustomOrgRegistry123456789012345678901234567'
            };

            const sdk = new DavinciSDK({
                signer: mockSigner,
                environment: 'dev',
                contractAddresses: customAddresses
            });

            const config = sdk.getConfig();
            
            expect(config.contractAddresses.processRegistry).toBe(customAddresses.processRegistry);
            expect(config.contractAddresses.organizationRegistry).toBe(customAddresses.organizationRegistry);
        });

        it('should set useSequencerAddresses flag correctly', () => {
            const sdk1 = new DavinciSDK({
                signer: mockSigner,
                environment: 'dev'
            });

            const sdk2 = new DavinciSDK({
                signer: mockSigner,
                environment: 'dev',
                useSequencerAddresses: true
            });

            expect(sdk1.getConfig().useSequencerAddresses).toBe(false);
            expect(sdk2.getConfig().useSequencerAddresses).toBe(true);
        });

        it('should handle different chains correctly', () => {
            const sepoliaSDK = new DavinciSDK({
                signer: mockSigner,
                environment: 'dev' // Uses sepolia
            });

            const mainnetSDK = new DavinciSDK({
                signer: mockSigner,
                environment: 'prod' // Uses mainnet
            });

            expect(sepoliaSDK.getConfig().chain).toBe('sepolia');
            expect(mainnetSDK.getConfig().chain).toBe('mainnet');
        });
    });

    describe('SDK Services Initialization', () => {
        it('should initialize all required services', () => {
            const sdk = new DavinciSDK({
                signer: mockSigner,
                environment: 'dev'
            });

            // Check that all services are properly initialized
            expect(sdk.api).toBeDefined();
            expect(sdk.processes).toBeDefined();
            expect(sdk.organizations).toBeDefined();
            
            // Check initialization state
            expect(sdk.isInitialized()).toBe(false);
        });

    });

    describe('Configuration Priority', () => {
        it('should prioritize explicit URLs over environment defaults', () => {
            const explicitSequencerUrl = 'https://explicit-sequencer.example.com';
            const explicitCensusUrl = 'https://explicit-census.example.com';

            const sdk = new DavinciSDK({
                signer: mockSigner,
                environment: 'dev', // Would normally set dev URLs
                sequencerUrl: explicitSequencerUrl,
                censusUrl: explicitCensusUrl
            });

            const config = sdk.getConfig();
            
            expect(config.sequencerUrl).toBe(explicitSequencerUrl);
            expect(config.censusUrl).toBe(explicitCensusUrl);
        });

        it('should prioritize explicit chain over environment default', () => {
            const sdk = new DavinciSDK({
                signer: mockSigner,
                environment: 'dev', // Would normally set sepolia
                chain: 'mainnet'
            });

            const config = sdk.getConfig();
            
            expect(config.chain).toBe('mainnet');
        });

        it('should handle partial overrides correctly', () => {
            const customSequencerUrl = 'https://custom-sequencer.example.com';

            const sdk = new DavinciSDK({
                signer: mockSigner,
                environment: 'dev',
                sequencerUrl: customSequencerUrl
                // censusUrl not provided, should use environment default
            });

            const config = sdk.getConfig();
            
            expect(config.sequencerUrl).toBe(customSequencerUrl);
            expect(config.censusUrl).toBe(DEFAULT_ENVIRONMENT_URLS.dev.census); // Environment default
            expect(config.chain).toBe(DEFAULT_ENVIRONMENT_URLS.dev.chain); // Environment default
        });
    });

    describe('Environment URL Resolution', () => {
        it('should handle empty production URLs correctly', () => {
            const sdk = new DavinciSDK({
                signer: mockSigner,
                environment: 'prod'
            });

            const config = sdk.getConfig();
            
            // Production URLs are empty (TODO), should be empty strings
            expect(config.sequencerUrl).toBe(DEFAULT_ENVIRONMENT_URLS.prod.sequencer);
            expect(config.censusUrl).toBe(DEFAULT_ENVIRONMENT_URLS.prod.census);
            expect(config.chain).toBe(DEFAULT_ENVIRONMENT_URLS.prod.chain);
        });

        it('should fallback to custom URLs when environment URLs are empty', () => {
            const customSequencerUrl = 'https://fallback-sequencer.example.com';
            const customCensusUrl = 'https://fallback-census.example.com';

            const sdk = new DavinciSDK({
                signer: mockSigner,
                environment: 'prod', // Has empty URLs
                sequencerUrl: customSequencerUrl,
                censusUrl: customCensusUrl
            });

            const config = sdk.getConfig();
            
            expect(config.sequencerUrl).toBe(customSequencerUrl);
            expect(config.censusUrl).toBe(customCensusUrl);
            expect(config.chain).toBe('mainnet');
        });
    });
});
