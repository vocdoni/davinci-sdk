// test/core/integration/VoteOrchestration.test.ts
import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });
import { JsonRpcProvider, Wallet } from "ethers";
import { DavinciSDK, CensusOrigin, ProcessConfig } from "../../../src";
import { VoteConfig, VoteResult } from "../../../src/core/vote/VoteOrchestrationService";
import { VoteStatus } from "../../../src/sequencer/api/types";

jest.setTimeout(Number(process.env.TIME_OUT) || 600_000); // 10 minutes for voting tests

const provider = new JsonRpcProvider(process.env.SEPOLIA_RPC!);
const organizerWallet = new Wallet(process.env.PRIVATE_KEY!, provider);

describe("Vote Orchestration Integration (Sepolia)", () => {
    let organizerSdk: DavinciSDK;
    let processId: string;
    let voters: Wallet[] = [];
    let voterSdks: DavinciSDK[] = [];
    let usedVoterIndex = 0;

    // Helper function to get an unused voter SDK
    function getUnusedVoterSdk(): DavinciSDK {
        if (usedVoterIndex >= voterSdks.length) {
            throw new Error("No unused voters available");
        }
        return voterSdks[usedVoterIndex++];
    }

    beforeAll(async () => {
        organizerSdk = new DavinciSDK({
            signer: organizerWallet,
            environment: "dev",
            useSequencerAddresses: true
        });
        
        await organizerSdk.init();

        // Create multiple voter wallets and SDK instances for testing
        const numVoters = 10; // Create enough voters for all tests
        for (let i = 0; i < numVoters; i++) {
            const voter = new Wallet(Wallet.createRandom().privateKey, provider);
            voters.push(voter);
            
            const voterSdk = new DavinciSDK({
                signer: voter,
                environment: "dev",
                useSequencerAddresses: true
            });
            await voterSdk.init();
            voterSdks.push(voterSdk);
        }

        // Create a single census with all voters
        const censusId = await organizerSdk.api.census.createCensus();
        const participants = voters.map(voter => ({ key: voter.address, weight: "1" }));
        await organizerSdk.api.census.addParticipants(censusId, participants);
        const publishResult = await organizerSdk.api.census.publishCensus(censusId);
        const censusSize = await organizerSdk.api.census.getCensusSize(publishResult.root);

        // Create a single process for all voting tests
        const processConfig: ProcessConfig = {
            title: "Vote Test Process",
            description: "A test process for vote integration tests",
            census: {
                type: CensusOrigin.CensusOriginMerkleTree,
                root: publishResult.root,
                size: censusSize,
                uri: publishResult.uri
            },
            ballot: {
                numFields: 2,
                maxValue: "2",
                minValue: "0",
                uniqueValues: false,
                costFromWeight: false,
                costExponent: 1,
                maxValueSum: "4",
                minValueSum: "0"
            },
            timing: {
                startDate: Math.floor(Date.now() / 1000) + 60, // Start in 1 minute
                duration: 7200 // 2 hours - longer duration for all tests
            },
            questions: [
                {
                    title: "What is your favorite color?",
                    choices: [
                        { title: "Red", value: 0 },
                        { title: "Blue", value: 1 },
                        { title: "Green", value: 2 }
                    ]
                },
                {
                    title: "What is your preferred transportation?",
                    choices: [
                        { title: "Car", value: 0 },
                        { title: "Bike", value: 1 },
                        { title: "Walking", value: 2 }
                    ]
                }
            ]
        };

        console.log("Creating test process for voting...");
        const processResult = await organizerSdk.createProcess(processConfig);
        processId = processResult.processId;
        console.log(`Test process created with ID: ${processId}`);

        // Wait for process to be ready to accept votes
        console.log("Waiting for process to be ready to accept votes...");
        let attempts = 0;
        const maxAttempts = 60; // 10 minutes max
        while (attempts < maxAttempts) {
            try {
                const processInfo = await organizerSdk.api.sequencer.getProcess(processId);
                if (processInfo.isAcceptingVotes) {
                    console.log("Process is ready to accept votes");
                    break;
                }
            } catch (error) {
                // Process might not be available yet
            }
            
            attempts++;
            if (attempts >= maxAttempts) {
                throw new Error("Process did not become ready within timeout");
            }
            
            console.log(`Process not ready yet, attempt ${attempts}/${maxAttempts}, waiting 10 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    });

    describe("submitVote", () => {
        it("should submit a vote with valid configuration", async () => {
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
            
            console.log(`Vote submitted successfully with ID: ${result.voteId}`);
        });

        it("should submit a vote with different choices", async () => {
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

        it("should throw error for invalid process ID", async () => {
            const voterSdk = getUnusedVoterSdk();
            const voteConfig: VoteConfig = {
                processId: '0xinvalidprocessid1234567890abcdef1234567890abcdef',
                choices: [0, 1],
            };

            await expect(voterSdk.submitVote(voteConfig)).rejects.toThrow();
        });

        it("should throw error for empty choices", async () => {
            const voterSdk = getUnusedVoterSdk();
            const voteConfig: VoteConfig = {
                processId,
                choices: [],
            };

            await expect(voterSdk.submitVote(voteConfig)).rejects.toThrow('Expected 2 choices, got 0');
        });

        it("should throw error for voter not in census", async () => {
            // Create a new SDK with a voter not in the census
            const invalidVoter = new Wallet(Wallet.createRandom().privateKey, provider);
            const invalidVoterSdk = new DavinciSDK({
                signer: invalidVoter,
                environment: "dev",
                useSequencerAddresses: true
            });
            await invalidVoterSdk.init();
            
            const voteConfig: VoteConfig = {
                processId,
                choices: [1, 1],
            };

            await expect(invalidVoterSdk.submitVote(voteConfig)).rejects.toThrow();
        });
    });

    describe("getVoteStatus", () => {
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

        it("should get vote status for existing vote", async () => {
            const status = await testVoterSdk.getVoteStatus(processId, voteId);

            expect(status).toBeDefined();
            expect(status.voteId).toBe(voteId);
            expect(status.processId).toBe(processId);
            expect(Object.values(VoteStatus)).toContain(status.status);
        });

        it("should throw error for non-existent vote", async () => {
            const nonExistentVoteId = '0xnonexistentvoteid1234567890abcdef1234567890abcdef';

            await expect(testVoterSdk.getVoteStatus(processId, nonExistentVoteId)).rejects.toThrow();
        });
    });

    describe("hasAddressVoted", () => {
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
            console.log(`Waiting for vote ${voteId} to be processed...`);
            try {
                await votedVoterSdk.waitForVoteStatus(processId, voteId, VoteStatus.Settled, 500000, 10000);
                console.log(`Vote ${voteId} has been settled`);
            } catch (error) {
                console.log(`Vote ${voteId} did not settle within 30s, checking current status...`);
                try {
                    const currentStatus = await votedVoterSdk.getVoteStatus(processId, voteId);
                    console.log(`Current vote status: ${currentStatus.status}`);
                } catch (statusError) {
                    console.log(`Could not get vote status: ${statusError}`);
                }
                // Continue with test - the vote might still be recorded even if not settled
            }
            
            // Keep one voter unused for testing
            unvotedVoter = voters.find((v, index) => index >= usedVoterIndex)!;
        });

        it("should return true for address that has voted", async () => {
            const hasVoted = await organizerSdk.hasAddressVoted(processId, votedAddress);
            expect(hasVoted).toBe(true);
        });

        it("should return false for address that has not voted", async () => {
            const hasVoted = await organizerSdk.hasAddressVoted(processId, unvotedVoter.address);
            expect(hasVoted).toBe(false);
        });

        it("should throw error for invalid process ID", async () => {
            await expect(organizerSdk.hasAddressVoted('invalid-process-id', votedAddress)).rejects.toThrow();
        });

        it("should throw error for invalid address", async () => {
            await expect(organizerSdk.hasAddressVoted(processId, 'invalid-address')).rejects.toThrow();
        });
    });

    describe("waitForVoteStatus", () => {
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

        it("should wait for vote status (with short timeout)", async () => {
            // Test with a short timeout - should return current status even if not target status
            try {
                const finalStatus = await testVoterSdk.waitForVoteStatus(
                    processId,
                    testVoteId,
                    VoteStatus.Settled,
                    5000, // 5 second timeout
                    1000  // 1 second polling interval
                );

                expect(finalStatus).toBeDefined();
                expect(finalStatus.voteId).toBe(testVoteId);
                expect(Object.values(VoteStatus)).toContain(finalStatus.status);
            } catch (error: any) {
                // Timeout is expected for short timeouts
                expect(error.message).toContain('Vote did not reach status settled within');
            }
        });

        it("should throw error for invalid vote ID", async () => {
            await expect(
                testVoterSdk.waitForVoteStatus(processId, 'invalid-vote-id', VoteStatus.Settled, 1000)
            ).rejects.toThrow();
        });
    });

    describe("VoteOrchestrationService direct access", () => {
        it("should provide access to vote orchestrator", () => {
            const orchestrator = organizerSdk.voteOrchestrator;
            expect(orchestrator).toBeDefined();
            expect(typeof orchestrator.submitVote).toBe('function');
            expect(typeof orchestrator.getVoteStatus).toBe('function');
            expect(typeof orchestrator.hasAddressVoted).toBe('function');
            expect(typeof orchestrator.waitForVoteStatus).toBe('function');
        });

        it("should use the same orchestrator instance", () => {
            const orchestrator1 = organizerSdk.voteOrchestrator;
            const orchestrator2 = organizerSdk.voteOrchestrator;
            expect(orchestrator1).toBe(orchestrator2);
        });
    });

    describe("Configuration validation", () => {
        it("should validate vote configuration", async () => {
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

        it("should handle choice validation based on ballot mode", async () => {
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

    describe("SDK initialization validation", () => {
        it("should validate SDK initialization requirement", async () => {
            const uninitializedSdk = new DavinciSDK({
                signer: organizerWallet,
                environment: "dev"
            });

            const voteConfig: VoteConfig = {
                processId,
                choices: [0, 1],
            };

            await expect(uninitializedSdk.submitVote(voteConfig)).rejects.toThrow(
                "SDK must be initialized before submitting votes. Call sdk.init() first."
            );
        });
    });
});
