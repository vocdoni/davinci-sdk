// test/core/integration/VoteOrchestration.test.ts
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });
import { JsonRpcProvider, Wallet } from 'ethers';
import { DavinciSDK, CensusOrigin, ProcessConfig, OffchainDynamicCensus } from '../../../src';
import { VoteConfig, VoteResult } from '../../../src/core/vote/VoteOrchestrationService';
import { VoteStatus } from '../../../src/sequencer/api/types';
import {
  CensusProviders,
  MerkleCensusProofProvider,
  CSPCensusProofProvider,
} from '../../../src/census/types';
import { DavinciCrypto } from '../../../src/sequencer/DavinciCryptoService';

jest.setTimeout(Number(process.env.TIME_OUT) || 600_000); // 10 minutes for voting tests

const provider = new JsonRpcProvider(process.env.RPC_URL);
const organizerWallet = new Wallet(process.env.PRIVATE_KEY!, provider);

describe('Vote Orchestration Integration', () => {
  let organizerSdk: DavinciSDK;
  let processId: string;
  const voters: Wallet[] = [];
  const voterSdks: DavinciSDK[] = [];
  let usedVoterIndex = 0;

  // Helper function to get an unused voter SDK
  function getUnusedVoterSdk(): DavinciSDK {
    if (usedVoterIndex >= voterSdks.length) {
      throw new Error('No unused voters available');
    }
    return voterSdks[usedVoterIndex++];
  }

  beforeAll(async () => {
    organizerSdk = new DavinciSDK({
      signer: organizerWallet,
      sequencerUrl: process.env.SEQUENCER_API_URL!,
      censusUrl: process.env.CENSUS_API_URL,
    });

    await organizerSdk.init();

    // Create multiple voter wallets and SDK instances for testing
    const numVoters = 10; // Create enough voters for all tests
    for (let i = 0; i < numVoters; i++) {
      const voter = new Wallet(Wallet.createRandom().privateKey, provider);
      voters.push(voter);

      const voterSdk = new DavinciSDK({
        signer: voter,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
        censusUrl: process.env.CENSUS_API_URL,
      });
      await voterSdk.init();
      voterSdks.push(voterSdk);
    }

    // Create a single census with all voters
    const censusId = await organizerSdk.api.census.createCensus();
    const participants = voters.map(voter => ({ key: voter.address, weight: '1' }));
    await organizerSdk.api.census.addParticipants(censusId, participants);
    const publishResult = await organizerSdk.api.census.publishCensus(censusId);
    const censusSize = await organizerSdk.api.census.getCensusSize(publishResult.root);

    // Create a single process for all voting tests
    const processConfig: ProcessConfig = {
      title: 'Vote Test Process',
      description: 'A test process for vote integration tests',
      census: {
        type: CensusOrigin.OffchainStatic,
        root: publishResult.root,
        size: censusSize,
        uri: publishResult.uri,
      },
      maxVoters: censusSize,
      ballot: {
        numFields: 2,
        maxValue: '2',
        minValue: '0',
        uniqueValues: false,
        costFromWeight: false,
        costExponent: 1,
        maxValueSum: '4',
        minValueSum: '0',
      },
      timing: {
        startDate: Math.floor(Date.now() / 1000) + 60, // Start in 1 minute
        duration: 7200, // 2 hours - longer duration for all tests
      },
      questions: [
        {
          title: 'What is your favorite color?',
          choices: [
            { title: 'Red', value: 0 },
            { title: 'Blue', value: 1 },
            { title: 'Green', value: 2 },
          ],
        },
        {
          title: 'What is your preferred transportation?',
          choices: [
            { title: 'Car', value: 0 },
            { title: 'Bike', value: 1 },
            { title: 'Walking', value: 2 },
          ],
        },
      ],
    };

    const processResult = await organizerSdk.createProcess(processConfig);
    processId = processResult.processId;

    // Wait for process to be ready to accept votes
    let attempts = 0;
    const maxAttempts = 60; // 10 minutes max
    while (attempts < maxAttempts) {
      try {
        const processInfo = await organizerSdk.api.sequencer.getProcess(processId);
        if (processInfo.isAcceptingVotes) {
          break;
        }
      } catch (error) {
        // Process might not be available yet
      }

      attempts++;
      if (attempts >= maxAttempts) {
        throw new Error('Process did not become ready within timeout');
      }

      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  });

  describe('submitVote', () => {
    it('should submit a vote with valid configuration', async () => {
      const voterSdk = getUnusedVoterSdk();
      const voteConfig: VoteConfig = {
        processId,
        choices: [1, 0], // Blue for color, Car for transportation
      };

      const result: VoteResult = await voterSdk.submitVote(voteConfig);

      expect(result).toBeDefined();
      expect(result.voteId).toBeDefined();
      expect(result.voteId).toMatch(/^0x[a-fA-F0-9]+$/);
      expect(result.signature).toBeDefined();
      expect(result.signature).toMatch(/^0x[a-fA-F0-9]+$/);
      expect(result.voterAddress).toBe(voters[usedVoterIndex - 1].address);
      expect(result.processId).toBe(processId);
      expect(result.status).toBe(VoteStatus.Pending);
    });

    it('should submit a vote with different choices', async () => {
      const voterSdk = getUnusedVoterSdk();
      const voteConfig: VoteConfig = {
        processId,
        choices: [2, 1], // Green for color, Bike for transportation
      };

      const result: VoteResult = await voterSdk.submitVote(voteConfig);

      expect(result).toBeDefined();
      expect(result.voteId).toBeDefined();
      expect(result.voterAddress).toBe(voters[usedVoterIndex - 1].address);
      expect(result.processId).toBe(processId);
      expect(result.status).toBe(VoteStatus.Pending);
    });

    it('should throw error for invalid process ID', async () => {
      const voterSdk = getUnusedVoterSdk();
      const voteConfig: VoteConfig = {
        processId: '0xinvalidprocessid1234567890abcdef1234567890abcdef',
        choices: [0, 1],
      };

      await expect(voterSdk.submitVote(voteConfig)).rejects.toThrow();
    });

    it('should throw error for voter not in census', async () => {
      // Create a new SDK with a voter not in the census
      const invalidVoter = new Wallet(Wallet.createRandom().privateKey, provider);
      const invalidVoterSdk = new DavinciSDK({
        signer: invalidVoter,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
        censusUrl: process.env.CENSUS_API_URL,
      });
      await invalidVoterSdk.init();

      const voteConfig: VoteConfig = {
        processId,
        choices: [1, 1],
      };

      await expect(invalidVoterSdk.submitVote(voteConfig)).rejects.toThrow();
    });
  });

  describe('getVoteStatus', () => {
    let voteId: string;
    let testVoterSdk: DavinciSDK;

    beforeAll(async () => {
      // Submit a vote to get a real vote ID
      testVoterSdk = getUnusedVoterSdk();
      const voteConfig: VoteConfig = {
        processId,
        choices: [0, 2], // Red for color, Walking for transportation
      };

      const voteResult = await testVoterSdk.submitVote(voteConfig);
      voteId = voteResult.voteId;
    });

    it('should get vote status for existing vote', async () => {
      const status = await testVoterSdk.getVoteStatus(processId, voteId);

      expect(status).toBeDefined();
      expect(status.voteId).toBe(voteId);
      expect(status.processId).toBe(processId);
      expect(Object.values(VoteStatus)).toContain(status.status);
    });

    it('should throw error for non-existent vote', async () => {
      const nonExistentVoteId = '0xnonexistentvoteid1234567890abcdef1234567890abcdef';

      await expect(testVoterSdk.getVoteStatus(processId, nonExistentVoteId)).rejects.toThrow();
    });
  });

  describe('hasAddressVoted', () => {
    let votedAddress: string;
    let votedVoterSdk: DavinciSDK;
    let unvotedVoter: Wallet;
    let voteId: string;

    beforeAll(async () => {
      // Submit a vote to have an address that has voted
      votedVoterSdk = getUnusedVoterSdk();
      votedAddress = voters[usedVoterIndex - 1].address;

      const voteConfig: VoteConfig = {
        processId,
        choices: [1, 2], // Blue for color, Walking for transportation
      };

      const voteResult = await votedVoterSdk.submitVote(voteConfig);
      voteId = voteResult.voteId;

      // Wait for the vote to be processed
      try {
        await votedVoterSdk.waitForVoteStatus(processId, voteId, VoteStatus.Settled, 500000, 10000);
      } catch (error) {
        try {
          await votedVoterSdk.getVoteStatus(processId, voteId);
        } catch (statusError) {
          // Ignore status error
        }
        // Continue with test - the vote might still be recorded even if not settled
      }

      // Keep one voter unused for testing
      unvotedVoter = voters.find((v, index) => index >= usedVoterIndex)!;
    });

    it('should return true for address that has voted', async () => {
      const hasVoted = await organizerSdk.hasAddressVoted(processId, votedAddress);
      expect(hasVoted).toBe(true);
    });

    it('should return false for address that has not voted', async () => {
      const hasVoted = await organizerSdk.hasAddressVoted(processId, unvotedVoter.address);
      expect(hasVoted).toBe(false);
    });

    it('should throw error for invalid process ID', async () => {
      await expect(
        organizerSdk.hasAddressVoted('invalid-process-id', votedAddress)
      ).rejects.toThrow();
    });

    it('should throw error for invalid address', async () => {
      await expect(organizerSdk.hasAddressVoted(processId, 'invalid-address')).rejects.toThrow();
    });
  });

  describe('isAddressAbleToVote', () => {
    it('should return true for address in census', async () => {
      const testAddress = voters[0].address;
      
      const isAble = await organizerSdk.isAddressAbleToVote(processId, testAddress);

      expect(typeof isAble).toBe('boolean');
      expect(isAble).toBe(true);
    });

    it('should return false for address not in census', async () => {
      const randomAddress = Wallet.createRandom().address;
      
      const isAble = await organizerSdk.isAddressAbleToVote(processId, randomAddress);
      
      expect(typeof isAble).toBe('boolean');
      expect(isAble).toBe(false);
    });

    it('should throw error for invalid process ID', async () => {
      const testAddress = voters[0].address;
      
      await expect(
        organizerSdk.isAddressAbleToVote('invalid-process-id', testAddress)
      ).rejects.toThrow();
    });

    it('should throw error for invalid address format', async () => {
      await expect(
        organizerSdk.isAddressAbleToVote(processId, 'invalid-address')
      ).rejects.toThrow();
    });
  });

  describe('getAddressWeight', () => {
    it('should get weight for address in census', async () => {
      const testAddress = voters[0].address;
      
      const weight = await organizerSdk.getAddressWeight(processId, testAddress);

      expect(typeof weight).toBe('string');
      expect(BigInt(weight).toString()).toBe(weight);
      expect(weight).toBe('1'); // Weight is 1 for our test census
    });

    it('should throw error for address not in census', async () => {
      const randomAddress = Wallet.createRandom().address;
      
      await expect(
        organizerSdk.getAddressWeight(processId, randomAddress)
      ).rejects.toThrow();
    });

    it('should throw error for invalid process ID', async () => {
      const testAddress = voters[0].address;
      
      await expect(
        organizerSdk.getAddressWeight('invalid-process-id', testAddress)
      ).rejects.toThrow();
    });

    it('should throw error for invalid address format', async () => {
      await expect(
        organizerSdk.getAddressWeight(processId, 'invalid-address')
      ).rejects.toThrow();
    });
  });

  describe('watchVoteStatus', () => {
    let watchTestVoteId: string;
    let watchTestVoterSdk: DavinciSDK;

    beforeAll(async () => {
      // Submit a vote for watch status tests
      watchTestVoterSdk = getUnusedVoterSdk();
      const voteConfig: VoteConfig = {
        processId,
        choices: [0, 1], // Red for color, Bike for transportation
      };

      const voteResult = await watchTestVoterSdk.submitVote(voteConfig);
      watchTestVoteId = voteResult.voteId;
    });

    it('should watch vote status changes and yield each status', async () => {
      const statuses: VoteStatus[] = [];

      try {
        const stream = watchTestVoterSdk.watchVoteStatus(processId, watchTestVoteId, {
          targetStatus: VoteStatus.Settled,
          timeoutMs: 30000, // 30 seconds
          pollIntervalMs: 2000, // 2 seconds
        });

        for await (const statusInfo of stream) {
          expect(statusInfo.voteId).toBe(watchTestVoteId);
          expect(statusInfo.processId).toBe(processId);
          expect(Object.values(VoteStatus)).toContain(statusInfo.status);

          statuses.push(statusInfo.status);

          // Stop if we reach settled or error
          if (statusInfo.status === VoteStatus.Settled || statusInfo.status === VoteStatus.Error) {
            break;
          }
        }
      } catch (error: any) {
        // Timeout is acceptable for this test
        if (!error.message.includes('Vote did not reach status')) {
          throw error;
        }
      }

      // Should have received at least one status
      expect(statuses.length).toBeGreaterThan(0);

      // First status should be Pending
      expect(statuses[0]).toBe(VoteStatus.Pending);

      // Statuses should be unique (no duplicates)
      const uniqueStatuses = new Set(statuses);
      expect(uniqueStatuses.size).toBe(statuses.length);
    });

    it('should stop watching when target status is reached', async () => {
      const stream = watchTestVoterSdk.watchVoteStatus(processId, watchTestVoteId, {
        targetStatus: VoteStatus.Verified,
        timeoutMs: 15000,
        pollIntervalMs: 1000,
      });

      const statuses: VoteStatus[] = [];
      for await (const statusInfo of stream) {
        statuses.push(statusInfo.status);
      }

      // Should receive at least the current status
      expect(statuses.length).toBeGreaterThan(0);
    });

    it('should throw error for invalid vote ID', async () => {
      const stream = watchTestVoterSdk.watchVoteStatus(processId, 'invalid-vote-id', {
        timeoutMs: 1000,
      });

      await expect(async () => {
        for await (const statusInfo of stream) {
          // Should not get here
        }
      }).rejects.toThrow();
    });

    it('should timeout if target status not reached', async () => {
      const stream = watchTestVoterSdk.watchVoteStatus(processId, watchTestVoteId, {
        targetStatus: VoteStatus.Settled,
        timeoutMs: 1000, // Very short timeout
        pollIntervalMs: 500,
      });

      await expect(async () => {
        for await (const statusInfo of stream) {
          // Continue iterating
        }
      }).rejects.toThrow('Vote did not reach status settled within 1000ms');
    });
  });

  describe('waitForVoteStatus', () => {
    let testVoteId: string;
    let testVoterSdk: DavinciSDK;

    beforeAll(async () => {
      // Submit a vote for wait status tests
      testVoterSdk = getUnusedVoterSdk();
      const voteConfig: VoteConfig = {
        processId,
        choices: [2, 0], // Green for color, Car for transportation
      };

      const voteResult = await testVoterSdk.submitVote(voteConfig);
      testVoteId = voteResult.voteId;
    });

    it('should wait for vote status (with short timeout)', async () => {
      // Test with a short timeout - should return current status even if not target status
      try {
        const finalStatus = await testVoterSdk.waitForVoteStatus(
          processId,
          testVoteId,
          VoteStatus.Settled,
          5000, // 5 second timeout
          1000 // 1 second polling interval
        );

        expect(finalStatus).toBeDefined();
        expect(finalStatus.voteId).toBe(testVoteId);
        expect(Object.values(VoteStatus)).toContain(finalStatus.status);
      } catch (error: any) {
        // Timeout is expected for short timeouts
        expect(error.message).toContain('Vote did not reach status settled within');
      }
    });

    it('should throw error for invalid vote ID', async () => {
      await expect(
        testVoterSdk.waitForVoteStatus(processId, 'invalid-vote-id', VoteStatus.Settled, 1000)
      ).rejects.toThrow();
    });
  });

  describe('VoteOrchestrationService direct access', () => {
    it('should provide access to vote orchestrator', () => {
      const orchestrator = organizerSdk.voteOrchestrator;
      expect(orchestrator).toBeDefined();
      expect(typeof orchestrator.submitVote).toBe('function');
      expect(typeof orchestrator.getVoteStatus).toBe('function');
      expect(typeof orchestrator.hasAddressVoted).toBe('function');
      expect(typeof orchestrator.waitForVoteStatus).toBe('function');
    });

    it('should use the same orchestrator instance', () => {
      const orchestrator1 = organizerSdk.voteOrchestrator;
      const orchestrator2 = organizerSdk.voteOrchestrator;
      expect(orchestrator1).toBe(orchestrator2);
    });
  });

  describe('Configuration validation', () => {
    it('should validate vote configuration', async () => {
      const voterSdk = getUnusedVoterSdk();
      const invalidConfigs = [
        { processId: '', choices: [0, 1] },
        { processId, choices: [-1, 0] },
        { processId, choices: [0, 1, 2, 3] }, // Too many choices
      ];

      for (const config of invalidConfigs) {
        await expect(voterSdk.submitVote(config as any)).rejects.toThrow();
      }
    });

    it('should handle choice validation based on ballot mode', async () => {
      const voterSdk = getUnusedVoterSdk();
      // Test choices that exceed the ballot mode limits
      const invalidChoices = [3, 3]; // Max value is 2 according to our ballot mode

      const voteConfig: VoteConfig = {
        processId,
        choices: invalidChoices,
      };

      // This should fail during proof generation due to invalid field values
      await expect(voterSdk.submitVote(voteConfig)).rejects.toThrow();
    });
  });

  describe('SDK initialization validation', () => {
    it('should validate SDK initialization requirement', async () => {
      const uninitializedSdk = new DavinciSDK({
        signer: organizerWallet,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
      });

      const voteConfig: VoteConfig = {
        processId,
        choices: [0, 1],
      };

      await expect(uninitializedSdk.submitVote(voteConfig)).rejects.toThrow(
        'SDK must be initialized before submitting votes. Call sdk.init() first.'
      );
    });
  });

  describe('Custom Census Providers', () => {
    let customProcessId: string;
    const customVoters: Wallet[] = [];
    let customCensusRoot: string;

    beforeAll(async () => {
      // Create voters for custom provider tests
      for (let i = 0; i < 3; i++) {
        const voter = new Wallet(Wallet.createRandom().privateKey, provider);
        customVoters.push(voter);
      }

      // Create a census with custom voters
      const censusId = await organizerSdk.api.census.createCensus();
      const participants = customVoters.map(voter => ({ key: voter.address, weight: '1' }));
      await organizerSdk.api.census.addParticipants(censusId, participants);
      const publishResult = await organizerSdk.api.census.publishCensus(censusId);
      const censusSize = await organizerSdk.api.census.getCensusSize(publishResult.root);
      customCensusRoot = publishResult.root;

      // Create a process for custom provider tests
      const processConfig: ProcessConfig = {
        title: 'Custom Provider Test Process',
        description: 'A test process for custom census provider tests',
        census: {
          type: CensusOrigin.OffchainStatic,
          root: publishResult.root,
          size: censusSize,
          uri: publishResult.uri,
        },
        maxVoters: censusSize,
        ballot: {
          numFields: 2,
          maxValue: '2',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '4',
          minValueSum: '0',
        },
        timing: {
          startDate: Math.floor(Date.now() / 1000) + 60,
          duration: 7200,
        },
        questions: [
          {
            title: 'Custom Question 1?',
            choices: [
              { title: 'Option A', value: 0 },
              { title: 'Option B', value: 1 },
              { title: 'Option C', value: 2 },
            ],
          },
          {
            title: 'Custom Question 2?',
            choices: [
              { title: 'Choice X', value: 0 },
              { title: 'Choice Y', value: 1 },
              { title: 'Choice Z', value: 2 },
            ],
          },
        ],
      };

      const processResult = await organizerSdk.createProcess(processConfig);
      customProcessId = processResult.processId;

      // Wait for process to be ready
      let attempts = 0;
      const maxAttempts = 60;
      while (attempts < maxAttempts) {
        try {
          const processInfo = await organizerSdk.api.sequencer.getProcess(customProcessId);
          if (processInfo.isAcceptingVotes) {
            break;
          }
        } catch (error) {
          // Process might not be available yet
        }

        attempts++;
        if (attempts >= maxAttempts) {
          throw new Error('Custom process did not become ready within timeout');
        }

        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    });

    describe('Custom Merkle Census Provider', () => {
      it('should use custom merkle provider when provided', async () => {
        // Create a custom merkle provider that calls the API but adds custom logic
        const customMerkleProvider: MerkleCensusProofProvider = async ({ censusRoot, address }) => {
          // Call the original API
          const originalProof = await organizerSdk.api.census.getCensusProof(censusRoot, address);

          // Return the proof (in a real scenario, this could be modified or come from a different source)
          return {
            root: originalProof.root,
            address: originalProof.address,
            weight: originalProof.weight,
            censusOrigin: CensusOrigin.OffchainStatic,
            value: (originalProof as any).value,
            siblings: (originalProof as any).siblings,
          };
        };

        const censusProviders: CensusProviders = {
          merkle: customMerkleProvider,
        };

        // Create SDK with custom census provider
        const customVoterSdk = new DavinciSDK({
          signer: customVoters[0],
          sequencerUrl: process.env.SEQUENCER_API_URL!,
          censusUrl: process.env.CENSUS_API_URL,
          censusProviders,
        });
        await customVoterSdk.init();

        const voteConfig: VoteConfig = {
          processId: customProcessId,
          choices: [1, 0],
        };

        const result = await customVoterSdk.submitVote(voteConfig);

        expect(result).toBeDefined();
        expect(result.voteId).toBeDefined();
        expect(result.voterAddress).toBe(customVoters[0].address);
        expect(result.processId).toBe(customProcessId);
        expect(result.status).toBe(VoteStatus.Pending);
      });
    });

    describe('CSP Census Provider', () => {
      let cspProcessId: string;
      let cspCensusRoot: string;
      const CSP_PRIVATE_KEY = Wallet.createRandom().privateKey;

      beforeAll(async () => {
        // Get sequencer info for WASM URLs
        const info = await organizerSdk.api.sequencer.getInfo();

        // Initialize DavinciCrypto for CSP operations
        const davinciCrypto = new DavinciCrypto({
          wasmExecUrl: info.ballotProofWasmHelperExecJsUrl,
          wasmUrl: info.ballotProofWasmHelperUrl,
        });
        await davinciCrypto.init();

        // Generate CSP process ID and census root
        const registry = organizerSdk.processes;
        cspProcessId = await registry.getNextProcessId(organizerWallet.address);

        cspCensusRoot = await davinciCrypto.cspCensusRoot(
          CensusOrigin.CSP,
          CSP_PRIVATE_KEY
        );

        // Create CSP process
        const processConfig: ProcessConfig = {
          title: 'CSP Provider Test Process',
          description: 'A test process for CSP census provider tests',
          census: {
            type: CensusOrigin.CSP,
            root: cspCensusRoot,
            size: customVoters.length,
            uri: 'https://csp.example.com/census',
          },
          maxVoters: customVoters.length,
          ballot: {
            numFields: 2,
            maxValue: '2',
            minValue: '0',
            uniqueValues: false,
            costFromWeight: false,
            costExponent: 1,
            maxValueSum: '4',
            minValueSum: '0',
          },
          timing: {
            startDate: Math.floor(Date.now() / 1000) + 60,
            duration: 7200,
          },
          questions: [
            {
              title: 'CSP Question 1?',
              choices: [
                { title: 'CSP Option A', value: 0 },
                { title: 'CSP Option B', value: 1 },
                { title: 'CSP Option C', value: 2 },
              ],
            },
            {
              title: 'CSP Question 2?',
              choices: [
                { title: 'CSP Choice X', value: 0 },
                { title: 'CSP Choice Y', value: 1 },
                { title: 'CSP Choice Z', value: 2 },
              ],
            },
          ],
        };

        const processResult = await organizerSdk.createProcess(processConfig);
        cspProcessId = processResult.processId;

        // Wait for CSP process to be ready
        let attempts = 0;
        const maxAttempts = 60;
        while (attempts < maxAttempts) {
          try {
            const processInfo = await organizerSdk.api.sequencer.getProcess(cspProcessId);
            if (processInfo.isAcceptingVotes) {
              break;
            }
          } catch (error) {
            // Process might not be available yet
          }

          attempts++;
          if (attempts >= maxAttempts) {
            throw new Error('CSP process did not become ready within timeout');
          }

          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      });

      it('should use custom CSP provider when provided', async () => {
        // Get sequencer info for WASM URLs
        const info = await organizerSdk.api.sequencer.getInfo();

        // Create a custom CSP provider
        const customCSPProvider: CSPCensusProofProvider = async ({ processId, address }) => {
          // Initialize DavinciCrypto
          const davinciCrypto = new DavinciCrypto({
            wasmExecUrl: info.ballotProofWasmHelperExecJsUrl,
            wasmUrl: info.ballotProofWasmHelperUrl,
          });
          await davinciCrypto.init();

          // Generate CSP proof using the dummy CSP
          const cspProofData = await davinciCrypto.cspSign(
            CensusOrigin.CSP,
            CSP_PRIVATE_KEY,
            processId.replace(/^0x/, ''),
            address.replace(/^0x/, ''),
            '100'
          );

          return {
            root: cspProofData.root,
            address: cspProofData.address,
            weight: '100', // Custom weight
            censusOrigin: CensusOrigin.CSP,
            processId: cspProofData.processId,
            publicKey: cspProofData.publicKey,
            signature: cspProofData.signature,
          };
        };

        const censusProviders: CensusProviders = {
          csp: customCSPProvider,
        };

        // Create SDK with custom CSP provider
        const customVoterSdk = new DavinciSDK({
          signer: customVoters[2],
          sequencerUrl: process.env.SEQUENCER_API_URL!,
          censusUrl: process.env.CENSUS_API_URL,
          censusProviders,
        });
        await customVoterSdk.init();

        const voteConfig: VoteConfig = {
          processId: cspProcessId,
          choices: [2, 1],
        };

        const result = await customVoterSdk.submitVote(voteConfig);

        expect(result).toBeDefined();
        expect(result.voteId).toBeDefined();
        expect(result.voterAddress).toBe(customVoters[2].address);
        expect(result.processId).toBe(cspProcessId);
        expect(result.status).toBe(VoteStatus.Pending);
      });

      it('should throw error when CSP provider is not provided for CSP process', async () => {
        // Create SDK without CSP provider (but with censusUrl to get past initial validation)
        const customVoterSdk = new DavinciSDK({
          signer: customVoters[0],
          sequencerUrl: process.env.SEQUENCER_API_URL!,
          censusUrl: process.env.CENSUS_API_URL,
          // No census providers
        });
        await customVoterSdk.init();

        const voteConfig: VoteConfig = {
          processId: cspProcessId,
          choices: [1, 2],
        };

        await expect(customVoterSdk.submitVote(voteConfig)).rejects.toThrow(
          'CSP voting requires a CSP census proof provider. Pass one via VoteOrchestrationService(..., { csp: yourFn }).'
        );
      });

      it('should validate custom CSP provider response', async () => {
        // Create a custom provider that returns invalid data
        const invalidCSPProvider: CSPCensusProofProvider = async ({ processId, address }) => {
          return {
            root: 'invalid-root',
            address: address,
            weight: '100',
            censusOrigin: CensusOrigin.CSP,
            processId: processId,
            publicKey: '', // Missing public key
            signature: 'invalid-signature',
          } as any;
        };

        const censusProviders: CensusProviders = {
          csp: invalidCSPProvider,
        };

        const customVoterSdk = new DavinciSDK({
          signer: customVoters[1],
          sequencerUrl: process.env.SEQUENCER_API_URL!,
          censusUrl: process.env.CENSUS_API_URL,
          censusProviders,
        });
        await customVoterSdk.init();

        const voteConfig: VoteConfig = {
          processId: cspProcessId,
          choices: [0, 2],
        };

        await expect(customVoterSdk.submitVote(voteConfig)).rejects.toThrow('malformed JSON body');
      });
    });
  });

  describe('Census Update and New Voter', () => {
    it('should allow a new voter to vote after census update', async () => {
      // Step 1: Create initial census
      const initialVoter = new Wallet(Wallet.createRandom().privateKey, provider);
      const newVoter = new Wallet(Wallet.createRandom().privateKey, provider);

      const census = new OffchainDynamicCensus();
      census.add(initialVoter.address);

      // Step 2: Create a process with the initial census
      const processConfig: ProcessConfig = {
        title: 'Census Update Test Process',
        description: 'A test process for census update functionality',
        census,
        ballot: {
          numFields: 1,
          maxValue: '2',
          minValue: '0',
          uniqueValues: false,
          costFromWeight: false,
          costExponent: 1,
          maxValueSum: '2',
          minValueSum: '0',
        },
        timing: {
          startDate: Math.floor(Date.now() / 1000) + 60,
          duration: 7200, // 2 hours
        },
        questions: [
          {
            title: 'Do you agree?',
            choices: [
              { title: 'Yes', value: 0 },
              { title: 'No', value: 1 },
              { title: 'Abstain', value: 2 },
            ],
          },
        ],
      };

      const processResult = await organizerSdk.createProcess(processConfig);
      const testProcessId = processResult.processId;

      // Wait for process to be ready
      let attempts = 0;
      const maxAttempts = 60;
      while (attempts < maxAttempts) {
        try {
          const processInfo = await organizerSdk.api.sequencer.getProcess(testProcessId);
          if (processInfo.isAcceptingVotes) {
            break;
          }
        } catch (error) {
          // Process might not be available yet
        }

        attempts++;
        if (attempts >= maxAttempts) {
          throw new Error('Test process did not become ready within timeout');
        }

        await new Promise(resolve => setTimeout(resolve, 10000));
      }

      // Step 3: Initial voter submits a vote
      const initialVoterSdk = new DavinciSDK({
        signer: initialVoter,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
        censusUrl: process.env.CENSUS_API_URL,
      });
      await initialVoterSdk.init();

      const initialVoteConfig: VoteConfig = {
        processId: testProcessId,
        choices: [0], // Vote Yes
      };

      const initialVoteResult = await initialVoterSdk.submitVote(initialVoteConfig);
      expect(initialVoteResult).toBeDefined();
      expect(initialVoteResult.voteId).toBeDefined();
      expect(initialVoteResult.voterAddress).toBe(initialVoter.address);

      // Verify new voter cannot vote yet (not in census)
      const newVoterCanVoteBefore = await organizerSdk.isAddressAbleToVote(testProcessId, newVoter.address);
      expect(newVoterCanVoteBefore).toBe(false);

      // Step 4: Create a new census that includes both voters
      const updatedCensusId = await organizerSdk.api.census.createCensus();
      await organizerSdk.api.census.addParticipants(updatedCensusId, [
        { key: initialVoter.address, weight: '1' },
        { key: newVoter.address, weight: '1' }, // Add new voter
      ]);
      const updatedPublishResult = await organizerSdk.api.census.publishCensus(updatedCensusId);

      // Step 5: Update the process census
      const updatedCensusData = {
        censusOrigin: CensusOrigin.OffchainDynamic,
        censusRoot: updatedPublishResult.root,
        censusURI: updatedPublishResult.uri,
      };

      const updateStream = organizerSdk.processes.setProcessCensus(testProcessId, updatedCensusData);
      
      for await (const event of updateStream) {
        if (event.status === 'completed') {
          expect(event.response).toEqual({ success: true });
        } else if (event.status === 'failed' || event.status === 'reverted') {
          throw new Error(`Census update failed: ${event.status}`);
        }
      }

      await new Promise(resolve => setTimeout(resolve, 60000));

      // Step 6: Verify new voter can now vote
      const newVoterCanVoteAfter = await organizerSdk.isAddressAbleToVote(testProcessId, newVoter.address);
      expect(newVoterCanVoteAfter).toBe(true);

      // Step 7: New voter submits a vote
      const newVoterSdk = new DavinciSDK({
        signer: newVoter,
        sequencerUrl: process.env.SEQUENCER_API_URL!,
        censusUrl: process.env.CENSUS_API_URL,
      });
      await newVoterSdk.init();

      const newVoteConfig: VoteConfig = {
        processId: testProcessId,
        choices: [1], // Vote No
      };

      const newVoteResult = await newVoterSdk.submitVote(newVoteConfig);
      expect(newVoteResult).toBeDefined();
      expect(newVoteResult.voteId).toBeDefined();
      expect(newVoteResult.voterAddress).toBe(newVoter.address);
      expect(newVoteResult.processId).toBe(testProcessId);
      expect(newVoteResult.status).toBe(VoteStatus.Pending);
    }, 600000); // 10 minute timeout for this comprehensive test
  });
});
