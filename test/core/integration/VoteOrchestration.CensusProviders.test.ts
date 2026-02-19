// test/core/integration/VoteOrchestration.CensusProviders.test.ts
import { JsonRpcProvider, Wallet } from 'ethers';
import { DavinciSDK, CensusOrigin, ProcessConfig, OffchainDynamicCensus } from '../../../src';
import { VoteConfig, VoteResult } from '../../../src/core/vote/VoteOrchestrationService';
import { VoteStatus } from '../../../src/sequencer/api/types';
import {
  CensusProviders,
  MerkleCensusProofProvider,
  CSPCensusProofProvider,
} from '../../../src/census/types';
import { DavinciCSP } from '../../../src/sequencer/DavinciCSP';
import { createIntegrationProvider, createIntegrationWallet, getApiUrls } from '../../helpers/integrationRuntime';
const { sequencerUrl, censusUrl } = getApiUrls();
const provider: JsonRpcProvider = createIntegrationProvider();
const organizerWallet: Wallet = createIntegrationWallet().connect(provider);

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
      sequencerUrl,
      censusUrl,
    });

    await organizerSdk.init();

    // Create multiple voter wallets and SDK instances for testing
    const numVoters = 10; // Create enough voters for all tests
    for (let i = 0; i < numVoters; i++) {
      const voter = new Wallet(Wallet.createRandom().privateKey, provider);
      voters.push(voter);

      const voterSdk = new DavinciSDK({
        signer: voter,
        sequencerUrl,
        censusUrl,
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
          sequencerUrl: sequencerUrl,
          censusUrl: censusUrl,
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
      let davinciCSP: DavinciCSP;

      beforeAll(async () => {
        // Initialize CSP helper for CSP operations
        davinciCSP = new DavinciCSP();
        await davinciCSP.init();

        // Generate CSP process ID and census root
        const registry = organizerSdk.processes;
        cspProcessId = await registry.getNextProcessId(organizerWallet.address);

        cspCensusRoot = await davinciCSP.cspCensusRoot(
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
        // Create a custom CSP provider
        const customCSPProvider: CSPCensusProofProvider = async ({ processId, address }) => {
          // Generate CSP proof using the dummy CSP
          const cspProofData = await davinciCSP.cspSign(
            CensusOrigin.CSP,
            CSP_PRIVATE_KEY,
            processId,
            address,
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
          sequencerUrl: sequencerUrl,
          censusUrl: censusUrl,
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
          sequencerUrl: sequencerUrl,
          censusUrl: censusUrl,
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
          sequencerUrl: sequencerUrl,
          censusUrl: censusUrl,
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
        sequencerUrl: sequencerUrl,
        censusUrl: censusUrl,
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
        sequencerUrl: sequencerUrl,
        censusUrl: censusUrl,
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
