import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });
import { DavinciSDK, DavinciSDKConfig } from '../../../src/DavinciSDK';
import { Wallet, JsonRpcProvider } from 'ethers';

describe('DavinciSDK Integration Tests', () => {
  let mockSigner: Wallet;

  beforeEach(() => {
    // Create a provider with a dummy URL that won't be used for actual network calls
    // This satisfies ethers.js requirements without making real network connections
    const provider = new JsonRpcProvider('http://localhost:8545');
    mockSigner = new Wallet(
      '0x1234567890123456789012345678901234567890123456789012345678901234',
      provider
    );
  });

  describe('Basic Configuration', () => {
    it('should initialize with sequencer URL only', () => {
      const sdk = new DavinciSDK({
        signer: mockSigner,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      const config = sdk.getConfig();

      expect(config.sequencerUrl).toBe(process.env.SEQUENCER_API_URL!);
      expect(config.censusUrl).toBeUndefined();
    });

    it('should initialize with both sequencer and census URLs', () => {
      const sdk = new DavinciSDK({
        signer: mockSigner,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
        censusUrl: process.env.CENSUS_API_URL!,
      });

      const config = sdk.getConfig();

      expect(config.sequencerUrl).toBe(process.env.SEQUENCER_API_URL!);
      expect(config.censusUrl).toBe(process.env.CENSUS_API_URL!);
    });

    it('should accept custom URLs', () => {
      const customSequencerUrl = 'https://custom-sequencer.example.com';
      const customCensusUrl = 'https://custom-census.example.com';

      const sdk = new DavinciSDK({
        signer: mockSigner,
        sequencerUrl: customSequencerUrl,
        censusUrl: customCensusUrl,
      });

      const config = sdk.getConfig();

      expect(config.sequencerUrl).toBe(customSequencerUrl);
      expect(config.censusUrl).toBe(customCensusUrl);
    });
  });

  describe('Contract Addresses Configuration', () => {
    it('should fetch addresses from sequencer when no custom addresses provided', () => {
      const sdk = new DavinciSDK({
        signer: mockSigner,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      const config = sdk.getConfig();

      // Should be empty initially (addresses will be fetched during init)
      expect(config.customAddresses).toEqual({});
      expect(config.fetchAddressesFromSequencer).toBe(true);
    });

    it('should store custom addresses when provided', () => {
      const customAddresses = {
        processRegistry: '0xCustomProcessRegistry123456789012345678901234',
        organizationRegistry: '0xCustomOrgRegistry123456789012345678901234567',
      };

      const sdk = new DavinciSDK({
        signer: mockSigner,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
        addresses: customAddresses,
      });

      const config = sdk.getConfig();

      expect(config.customAddresses.processRegistry).toBe(customAddresses.processRegistry);
      expect(config.customAddresses.organizationRegistry).toBe(
        customAddresses.organizationRegistry
      );
      expect(config.fetchAddressesFromSequencer).toBe(false);
    });

    it('should not fetch from sequencer when custom addresses provided', () => {
      const sdk = new DavinciSDK({
        signer: mockSigner,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
        addresses: {
          processRegistry: '0xCustom123456789012345678901234',
        },
      });

      const config = sdk.getConfig();
      expect(config.fetchAddressesFromSequencer).toBe(false);
    });
  });

  describe('SDK Services Initialization', () => {
    it('should initialize all required services', async () => {
      const sdk = new DavinciSDK({
        signer: mockSigner,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      // Check that API service is available before init
      expect(sdk.api).toBeDefined();

      // Check initialization state
      expect(sdk.isInitialized()).toBe(false);

      // Initialize to fetch addresses
      await sdk.init();

      // After init, process and organization services should be accessible
      expect(sdk.processes).toBeDefined();
      expect(sdk.organizations).toBeDefined();
    });

    it('should initialize SDK and mark as initialized', async () => {
      const sdk = new DavinciSDK({
        signer: mockSigner,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      // Should not be initialized initially
      expect(sdk.isInitialized()).toBe(false);

      // Initialize the SDK
      await sdk.init();

      // Should be initialized after calling init()
      expect(sdk.isInitialized()).toBe(true);

      // Calling init() again should not cause issues
      await sdk.init();
      expect(sdk.isInitialized()).toBe(true);
    });

    it('should not fetch addresses when custom addresses provided', async () => {
      const sdk = new DavinciSDK({
        signer: mockSigner,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
        addresses: {
          processRegistry: '0xCustom123',
        },
      });

      const initialConfig = sdk.getConfig();

      // Initialize with custom addresses
      await sdk.init();

      const finalConfig = sdk.getConfig();

      // Configuration should keep custom addresses
      expect(finalConfig.customAddresses.processRegistry).toBe('0xCustom123');
      expect(finalConfig.fetchAddressesFromSequencer).toBe(false);
      expect(sdk.isInitialized()).toBe(true);
    });

    it('should fetch sequencer addresses when no custom addresses', async () => {
      // Create SDK without custom addresses
      const sdk = new DavinciSDK({
        signer: mockSigner,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      const initialConfig = sdk.getConfig();

      // Should be empty initially
      expect(Object.keys(initialConfig.customAddresses).length).toBe(0);
      expect(initialConfig.fetchAddressesFromSequencer).toBe(true);
      expect(initialConfig.sequencerUrl).toBe(process.env.SEQUENCER_API_URL!);

      // Get sequencer info to know what addresses should be set
      const sequencerInfo = await sdk.api.sequencer.getInfo();

      // Verify sequencer provides contract addresses
      expect(sequencerInfo.contracts).toBeDefined();
      expect(sequencerInfo.contracts).toHaveProperty('process');
      expect(sequencerInfo.contracts).toHaveProperty('organization');

      // Initialize the SDK - this should fetch and apply sequencer addresses
      await sdk.init();

      const finalConfig = sdk.getConfig();

      // Verify that the configuration now contains the sequencer addresses
      expect(finalConfig.customAddresses.processRegistry).toBe(sequencerInfo.contracts.process);
      expect(finalConfig.customAddresses.organizationRegistry).toBe(
        sequencerInfo.contracts.organization
      );

      // Verify other sequencer addresses are also set if available
      if (sequencerInfo.contracts.stateTransitionVerifier) {
        expect(finalConfig.customAddresses.stateTransitionVerifier).toBe(
          sequencerInfo.contracts.stateTransitionVerifier
        );
      }
      if (sequencerInfo.contracts.resultsVerifier) {
        expect(finalConfig.customAddresses.resultsVerifier).toBe(
          sequencerInfo.contracts.resultsVerifier
        );
      }

      expect(sdk.isInitialized()).toBe(true);
    }, 10000); // Increase timeout for network call
  });

  describe('URL Configuration', () => {
    it('should use explicitly provided URLs', () => {
      const explicitSequencerUrl = 'https://explicit-sequencer.example.com';
      const explicitCensusUrl = 'https://explicit-census.example.com';

      const sdk = new DavinciSDK({
        signer: mockSigner,
        sequencerUrl: explicitSequencerUrl,
        censusUrl: explicitCensusUrl,
      });

      const config = sdk.getConfig();

      expect(config.sequencerUrl).toBe(explicitSequencerUrl);
      expect(config.censusUrl).toBe(explicitCensusUrl);
    });

    it('should work with sequencer URL only', () => {
      const customSequencerUrl = 'https://custom-sequencer.example.com';

      const sdk = new DavinciSDK({
        signer: mockSigner,
        sequencerUrl: customSequencerUrl,
      });

      const config = sdk.getConfig();

      expect(config.sequencerUrl).toBe(customSequencerUrl);
      expect(config.censusUrl).toBeUndefined();
    });
  });

  describe('Bare Wallet Support (No Provider)', () => {
    let bareWallet: Wallet;

    beforeEach(() => {
      // Create a wallet without a provider
      bareWallet = new Wallet('0x1234567890123456789012345678901234567890123456789012345678901234');
    });

    it('should accept bare wallet (no provider) during SDK construction', () => {
      expect(() => {
        new DavinciSDK({
          signer: bareWallet,
          sequencerUrl: process.env.SEQUENCER_API_URL!,
        });
      }).not.toThrow();
    });

    it('should allow SDK initialization without provider', async () => {
      const sdk = new DavinciSDK({
        signer: bareWallet,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      await expect(sdk.init()).resolves.not.toThrow();
      expect(sdk.isInitialized()).toBe(true);
    });

    it('should allow access to API service without provider', () => {
      const sdk = new DavinciSDK({
        signer: bareWallet,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      expect(() => sdk.api).not.toThrow();
      expect(sdk.api).toBeDefined();
    });

    it('should allow access to vote orchestrator without provider', () => {
      const sdk = new DavinciSDK({
        signer: bareWallet,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      expect(() => sdk.voteOrchestrator).not.toThrow();
      expect(sdk.voteOrchestrator).toBeDefined();
    });

    it('should throw error when accessing processes getter without provider', () => {
      const sdk = new DavinciSDK({
        signer: bareWallet,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      expect(() => sdk.processes).toThrow(
        'Provider required for blockchain operations (process/organization management)'
      );
    });

    it('should throw error when accessing organizations getter without provider', () => {
      const sdk = new DavinciSDK({
        signer: bareWallet,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      expect(() => sdk.organizations).toThrow(
        'Provider required for blockchain operations (process/organization management)'
      );
    });

    it('should throw error when accessing processOrchestrator getter without provider', () => {
      const sdk = new DavinciSDK({
        signer: bareWallet,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      expect(() => sdk.processOrchestrator).toThrow(
        'Provider required for blockchain operations (process/organization management)'
      );
    });

    it('should throw error when calling getProcess without provider', async () => {
      const sdk = new DavinciSDK({
        signer: bareWallet,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      await sdk.init();

      await expect(sdk.getProcess('0x1234567890abcdef1234567890abcdef12345678')).rejects.toThrow(
        'Provider required for blockchain operations (process/organization management)'
      );
    });

    it('should throw error when calling createProcess without provider', async () => {
      const sdk = new DavinciSDK({
        signer: bareWallet,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      await sdk.init();

      const processConfig = {
        title: 'Test Process',
        description: 'Test',
        census: {
          type: 1,
          root: '0x1234567890abcdef1234567890abcdef12345678',
          size: 100,
          uri: 'ipfs://test',
        },
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 10000,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'Test Question',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
            ],
          },
        ],
      };

      await expect(sdk.createProcess(processConfig as any)).rejects.toThrow(
        'Provider required for blockchain operations (process/organization management)'
      );
    });

    it('should throw error when calling createProcessStream without provider', async () => {
      const sdk = new DavinciSDK({
        signer: bareWallet,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      await sdk.init();

      const processConfig = {
        title: 'Test Process',
        census: {
          type: 1,
          root: '0x1234567890abcdef1234567890abcdef12345678',
          size: 100,
          uri: 'ipfs://test',
        },
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 10000,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'Test Question',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
            ],
          },
        ],
      };

      expect(() => sdk.createProcessStream(processConfig as any)).toThrow(
        'Provider required for blockchain operations (process/organization management)'
      );
    });

    it('should provide helpful error message mentioning wallet.connect(provider)', () => {
      const sdk = new DavinciSDK({
        signer: bareWallet,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      try {
        sdk.processes;
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toContain('wallet.connect(provider)');
        expect(error.message).toContain('MetaMask');
        expect(error.message).toContain('Voting operations do not require a provider');
      }
    });
  });

  describe('Connected Wallet Support (With Provider)', () => {
    let connectedWallet: Wallet;

    beforeEach(() => {
      const provider = new JsonRpcProvider('http://localhost:8545');
      connectedWallet = new Wallet(
        '0x1234567890123456789012345678901234567890123456789012345678901234',
        provider
      );
    });

    it('should accept connected wallet during SDK construction', () => {
      expect(() => {
        new DavinciSDK({
          signer: connectedWallet,
          sequencerUrl: process.env.SEQUENCER_API_URL!,
        });
      }).not.toThrow();
    });

    it('should allow access to all services with connected wallet', async () => {
      const sdk = new DavinciSDK({
        signer: connectedWallet,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      // API and vote services are available before init
      expect(() => sdk.api).not.toThrow();
      expect(() => sdk.voteOrchestrator).not.toThrow();

      // Initialize to fetch addresses
      await sdk.init();

      // After init, all services including blockchain ones should be accessible
      expect(() => sdk.processes).not.toThrow();
      expect(() => sdk.organizations).not.toThrow();
      expect(() => sdk.processOrchestrator).not.toThrow();

      expect(sdk.api).toBeDefined();
      expect(sdk.voteOrchestrator).toBeDefined();
      expect(sdk.processes).toBeDefined();
      expect(sdk.organizations).toBeDefined();
      expect(sdk.processOrchestrator).toBeDefined();
    });

    it('should verify connected wallet has provider', () => {
      expect(connectedWallet.provider).toBeDefined();
      expect(connectedWallet.provider).not.toBeNull();
    });
  });

  describe('Provider Validation Edge Cases', () => {
    it('should handle wallet with undefined provider (bare wallet)', () => {
      const wallet = new Wallet(
        '0x1234567890123456789012345678901234567890123456789012345678901234'
      );

      // Verify wallet has no provider
      expect(wallet.provider).toBeNull();

      const sdk = new DavinciSDK({
        signer: wallet,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      expect(() => sdk.processes).toThrow('Provider required for blockchain operations');
    });

    it('should differentiate between bare and connected wallets', () => {
      const bareWallet = new Wallet(
        '0x1234567890123456789012345678901234567890123456789012345678901234'
      );
      const provider = new JsonRpcProvider('http://localhost:8545');
      const connectedWallet = bareWallet.connect(provider);

      // Verify bare wallet has no provider
      expect(bareWallet.provider).toBeNull();

      // Verify connected wallet has provider
      expect(connectedWallet.provider).toBeDefined();
      expect(connectedWallet.provider).toBe(provider);

      // Create SDKs with custom addresses to avoid needing init()
      const customAddresses = {
        processRegistry: '0xCustom123',
      };

      const sdkBare = new DavinciSDK({
        signer: bareWallet,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
        addresses: customAddresses,
      });

      const sdkConnected = new DavinciSDK({
        signer: connectedWallet,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
        addresses: customAddresses,
      });

      // Bare wallet should fail due to missing provider
      expect(() => sdkBare.processes).toThrow('Provider required for blockchain operations');

      // Connected wallet should work
      expect(() => sdkConnected.processes).not.toThrow();
    });
  });
});
