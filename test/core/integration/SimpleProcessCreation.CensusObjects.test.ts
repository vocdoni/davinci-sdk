// test/core/integration/SimpleProcessCreation.CensusObjects.test.ts
import { JsonRpcProvider, Wallet } from 'ethers';
import { DavinciSDK, CensusOrigin, ProcessConfig, OffchainCensus } from '../../../src';
import { ProcessStatus } from '../../../src/contracts/ProcessRegistryService';
import { getElectionMetadataTemplate } from '../../../src/core/types/metadata';
import { createIntegrationProvider, createIntegrationWallet, getApiUrls } from '../../helpers/integrationRuntime';
const { sequencerUrl, censusUrl } = getApiUrls();
const provider: JsonRpcProvider = createIntegrationProvider();
const wallet: Wallet = createIntegrationWallet().connect(provider);

function randomHex(bytes: number): string {
  let hex = '';
  for (let i = 0; i < bytes * 2; i++) {
    hex += Math.floor(Math.random() * 16).toString(16);
  }
  return '0x' + hex;
}

describe('Simple Process Creation Integration', () => {
  let sdk: DavinciSDK;

  beforeAll(async () => {
    sdk = new DavinciSDK({
      signer: wallet,
      sequencerUrl,
      censusUrl,
    });

    await sdk.init();
  });

  describe('Census Object Support (Auto-Publishing)', () => {
    it('should create a process using OffchainCensus with plain addresses (auto-publishes)', async () => {
      // Create an offchain census with plain addresses
      const census = new OffchainCensus();
      census.add([
        '0x1234567890123456789012345678901234567890',
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        '0x9876543210987654321098765432109876543210',
      ]);

      // Census is NOT published yet - SDK will auto-publish!
      expect(census.isPublished).toBe(false);

      const processConfig: ProcessConfig = {
        title: 'OffchainCensus Test Election',
        description: 'Testing automatic census publishing with OffchainCensus',
        census: census, // Just pass the census object! SDK auto-publishes ✨
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'Do you approve this OffchainCensus test?',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
            ],
          },
        ],
      };

      // Create process - SDK will auto-publish the census
      const result = await sdk.createProcess(processConfig);

      // Verify result
      expect(result).toBeDefined();
      expect(result.processId).toMatch(/^0x[a-fA-F0-9]{62}$/);
      expect(result.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

      // Verify census was published
      expect(census.isPublished).toBe(true);
      expect(census.censusRoot).toBeDefined();
      expect(census.censusURI).toBeDefined();
      expect(census.participants.length).toBe(3);

      // Verify on-chain
      const onChainProcess = await sdk.processes.getProcess(result.processId);
      expect(onChainProcess.census.censusRoot.toLowerCase()).toBe(
        census.censusRoot!.toLowerCase()
      );
    });

    it('should create a process using OffchainCensus with string weights (auto-publishes)', async () => {
      // Create an offchain census with string weights
      const census = new OffchainCensus();
      census.add([
        { key: '0x1234567890123456789012345678901234567890', weight: '1' },
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: '5' },
        { key: '0x9876543210987654321098765432109876543210', weight: '10' },
      ]);

      // Census is NOT published yet
      expect(census.isPublished).toBe(false);

      const processConfig: ProcessConfig = {
        title: 'OffchainCensus String Test',
        description: 'Testing automatic publishing with OffchainCensus (string weights)',
        census: census, // SDK auto-publishes! ✨
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'Do you approve this OffchainCensus test?',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
            ],
          },
        ],
      };

      const result = await sdk.createProcess(processConfig);

      expect(result).toBeDefined();
      expect(result.processId).toMatch(/^0x[a-fA-F0-9]{62}$/);

      // Verify census was published
      expect(census.isPublished).toBe(true);
      expect(census.participants.length).toBe(3);
    });

    it('should create a process using OffchainCensus with number weights (auto-publishes)', async () => {
      // Create an offchain census with number weights
      const census = new OffchainCensus();
      census.add([
        { key: '0x1234567890123456789012345678901234567890', weight: 1 }, // number
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: 5 }, // number
        { key: '0x9876543210987654321098765432109876543210', weight: 10 }, // number
      ]);

      expect(census.isPublished).toBe(false);

      const processConfig: ProcessConfig = {
        title: 'OffchainCensus Number Test',
        description: 'Testing automatic publishing with OffchainCensus (number weights)',
        census: census,
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'Rate this number weight feature',
            choices: [
              { title: 'Excellent', value: 0 },
              { title: 'Good', value: 1 },
            ],
          },
        ],
      };

      const result = await sdk.createProcess(processConfig);

      expect(result).toBeDefined();
      expect(result.processId).toMatch(/^0x[a-fA-F0-9]{62}$/);
      expect(census.isPublished).toBe(true);
    });

    it('should create a process using OffchainCensus with bigint weights (auto-publishes)', async () => {
      // Create an offchain census with bigint weights
      const census = new OffchainCensus();
      census.add([
        { key: '0x1234567890123456789012345678901234567890', weight: 100n }, // bigint
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: 500n }, // bigint
        { key: '0x9876543210987654321098765432109876543210', weight: 1000n }, // bigint
      ]);

      expect(census.isPublished).toBe(false);

      const processConfig: ProcessConfig = {
        title: 'OffchainCensus BigInt Test',
        description: 'Testing automatic publishing with OffchainCensus (bigint weights)',
        census: census,
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'Do you like bigint support?',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
            ],
          },
        ],
      };

      const result = await sdk.createProcess(processConfig);

      expect(result).toBeDefined();
      expect(result.processId).toMatch(/^0x[a-fA-F0-9]{62}$/);
      expect(census.isPublished).toBe(true);
    });

    it('should create a process using OffchainCensus with mixed weight types', async () => {
      // Create an offchain census with mixed weight types
      const census = new OffchainCensus();
      census.add([
        { key: '0x1234567890123456789012345678901234567890', weight: '1' }, // string
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: 10 }, // number
        { key: '0x9876543210987654321098765432109876543210', weight: 100n }, // bigint
      ]);

      expect(census.isPublished).toBe(false);

      const processConfig: ProcessConfig = {
        title: 'OffchainCensus Mixed Types Test',
        description: 'Testing automatic publishing with mixed weight types',
        census: census,
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'Do you like mixed weight types?',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
            ],
          },
        ],
      };

      const result = await sdk.createProcess(processConfig);

      expect(result).toBeDefined();
      expect(result.processId).toMatch(/^0x[a-fA-F0-9]{62}$/);
      expect(census.isPublished).toBe(true);
      expect(census.participants.length).toBe(3);
    });

    it('should work with already published census (no re-publish)', async () => {
      // Create a census
      const census = new OffchainCensus();
      census.add([
        '0x1234567890123456789012345678901234567890',
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      ]);

      expect(census.isPublished).toBe(false);

      // Use it once - SDK will auto-publish
      const processConfig1: ProcessConfig = {
        title: 'First Process with Census',
        description: 'This auto-publishes the census',
        census: census,
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'First process question',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
            ],
          },
        ],
      };

      const result1 = await sdk.createProcess(processConfig1);
      expect(result1).toBeDefined();
      expect(result1.processId).toMatch(/^0x[a-fA-F0-9]{62}$/);

      // Verify census was published
      expect(census.isPublished).toBe(true);
      expect(census.censusRoot).toBeDefined();
      const originalRoot = census.censusRoot;

      // Use same census again - should NOT re-publish (root should stay the same)
      const processConfig2: ProcessConfig = {
        title: 'Second Process with Same Census',
        description: 'Testing reuse of already published census',
        census: census,
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'Second process question',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
            ],
          },
        ],
      };

      const result2 = await sdk.createProcess(processConfig2);
      expect(result2).toBeDefined();
      expect(result2.processId).toMatch(/^0x[a-fA-F0-9]{62}$/);

      // Census root should be the same (not re-published)
      expect(census.censusRoot).toBe(originalRoot);
    });

    it('should still support manual census config (backwards compatible)', async () => {
      // This test verifies that the old way still works
      const censusRoot = randomHex(32);

      const processConfig: ProcessConfig = {
        title: 'Manual Config Test (Backwards Compatible)',
        description: 'Testing backwards compatibility with manual census config',
        census: {
          type: CensusOrigin.OffchainStatic,
          root: censusRoot,
          size: 25,
          uri: `ipfs://manual-census-${Date.now()}`,
        },
        maxVoters: 25,
        ballot: {
          numFields: 1,
          maxValue: '1',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '1',
          minValueSum: '0',
        },
        timing: {
          duration: 3600,
        },
        questions: [
          {
            title: 'Does manual config still work?',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
            ],
          },
        ],
      };

      const result = await sdk.createProcess(processConfig);

      expect(result).toBeDefined();
      expect(result.processId).toMatch(/^0x[a-fA-F0-9]{62}$/);

      // Verify on-chain
      const onChainProcess = await sdk.processes.getProcess(result.processId);
      expect(onChainProcess.census.censusRoot.toLowerCase()).toBe(censusRoot.toLowerCase());
    });
  });


});
