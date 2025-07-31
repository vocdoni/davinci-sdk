import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });

import { DavinciSDK, DavinciSDKConfig } from "../../../src/core/DavinciSDK";
import { ApprovalElection } from "../../../src/core/ApprovalElection";
import { VocdoniCensusService } from "../../../src/census";
import { Wallet, JsonRpcProvider } from "ethers";

// Test utilities
const mockProvider = new JsonRpcProvider(process.env.SEPOLIA_RPC);
const mockWallet = new Wallet(process.env.PRIVATE_KEY!, mockProvider);

const generateMockCensusParticipants = (count: number) => {
    return Array.from({ length: count }, (_, i) => ({
        key: Wallet.createRandom().address,
        weight: ((i + 1) * 10).toString(),
    }));
};

const isValidHex = (str: string, length?: number): boolean => {
    const hexRegex = new RegExp(`^0x[a-fA-F0-9]${length ? `{${length}}` : '+'}$`);
    return hexRegex.test(str);
};

describe("ApprovalElection Integration Tests", () => {
    let sdk: DavinciSDK;
    let censusService: VocdoniCensusService;
    let censusId: string;
    let censusRoot: string;
    
    const testParticipants = generateMockCensusParticipants(5);

    beforeAll(async () => {
        // Initialize SDK
        const config: DavinciSDKConfig = {
            signer: mockWallet,
            sequencerUrl: process.env.SEQUENCER_API_URL!,
            censusUrl: process.env.CENSUS_API_URL!,
            chain: "sepolia"
        };
        
        sdk = new DavinciSDK(config);
        
        // Initialize census service
        censusService = new VocdoniCensusService(process.env.CENSUS_API_URL!);
        
        // Create a census for testing
        censusId = await censusService.createCensus();
        await censusService.addParticipants(censusId, testParticipants);
        censusRoot = await censusService.getCensusRoot(censusId);
    }, parseInt(process.env.TIMEOUT || "30000"));

    afterAll(async () => {
        // Clean up the census
        if (censusId) {
            await censusService.deleteCensus(censusId);
        }
    });

    describe("ApprovalElection Configuration", () => {
        let approvalElection: ApprovalElection;

        beforeEach(() => {
            approvalElection = new ApprovalElection(sdk, {
                title: "City Referendum - Multiple Questions",
                description: "Approval voting on multiple city initiatives",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });
        });

        it("should create an ApprovalElection instance", () => {
            expect(approvalElection).toBeInstanceOf(ApprovalElection);
        });

        it("should add choices to the election", () => {
            approvalElection
                .addChoice("Should we build a new library?")
                .addChoice("Should we increase park funding?")
                .addChoice("Should we add bike lanes?")
                .addChoice("Should we extend bus routes?")
                .addChoice("Should we build a community center?");

            const choices = approvalElection.getChoices();
            expect(choices).toHaveLength(5);
            expect(choices[0].title).toBe("Should we build a new library?");
            expect(choices[0].value).toBe(0);
            expect(choices[4].title).toBe("Should we build a community center?");
            expect(choices[4].value).toBe(4);
        });

        it("should configure approval limits", () => {
            approvalElection
                .addChoice("Question 1")
                .addChoice("Question 2")
                .addChoice("Question 3")
                .requireMinimumApprovals(1)
                .limitMaximumApprovals(2);

            const limits = approvalElection.getApprovalLimits();
            expect(limits.min).toBe(1);
            expect(limits.max).toBe(2);
        });

        it("should validate approval limits constraints", () => {
            approvalElection
                .addChoice("Question 1")
                .addChoice("Question 2");

            expect(() => {
                approvalElection
                    .requireMinimumApprovals(3)
                    .limitMaximumApprovals(2);
            }).toThrow("Maximum approvals cannot be less than minimum approvals");

            expect(() => {
                approvalElection.requireMinimumApprovals(5);
            }).toThrow("Minimum approvals cannot exceed the number of choices");
        });
    });

    describe("ApprovalElection Vote Validation", () => {
        let approvalElection: ApprovalElection;

        beforeEach(() => {
            approvalElection = new ApprovalElection(sdk, {
                title: "Test Approval Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            approvalElection
                .addChoice("Question 1")
                .addChoice("Question 2")
                .addChoice("Question 3")
                .addChoice("Question 4")
                .addChoice("Question 5");
        });

        it("should validate correct approval votes", () => {
            const validVote = [0, 1, 0, 1, 1];
            const result = approvalElection.validateVote(validVote);
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            // All disapprove
            const allDisapprove = [0, 0, 0, 0, 0];
            const result2 = approvalElection.validateVote(allDisapprove);
            expect(result2.valid).toBe(true);
            expect(result2.errors).toHaveLength(0);

            // All approve
            const allApprove = [1, 1, 1, 1, 1];
            const result3 = approvalElection.validateVote(allApprove);
            expect(result3.valid).toBe(true);
            expect(result3.errors).toHaveLength(0);
        });

        it("should reject invalid vote formats", () => {
            // Wrong number of votes
            const invalidVote1 = [1, 0, 1];
            const result1 = approvalElection.validateVote(invalidVote1);
            expect(result1.valid).toBe(false);
            expect(result1.errors[0]).toContain("exactly 5 votes");

            // Invalid values (not 0 or 1)
            const invalidVote2 = [0, 2, 0, 1, 1];
            const result2 = approvalElection.validateVote(invalidVote2);
            expect(result2.valid).toBe(false);
            expect(result2.errors[0]).toContain("must be either 0 (disapprove) or 1 (approve)");

            // Invalid values (not 0 or 1)
            const invalidVote3 = [0, 2, 0, 1, 1];
            const result3 = approvalElection.validateVote(invalidVote3);
            expect(result3.valid).toBe(false);
            expect(result3.errors[0]).toContain("must be either 0 (disapprove) or 1 (approve)");
        });

        it("should enforce approval limits", () => {
            approvalElection
                .requireMinimumApprovals(2)
                .limitMaximumApprovals(3);

            // Too few approvals
            const tooFew = [1, 0, 0, 0, 0];
            const result1 = approvalElection.validateVote(tooFew);
            expect(result1.valid).toBe(false);
            expect(result1.errors[0]).toContain("Must approve at least 2");

            // Too many approvals
            const tooMany = [1, 1, 1, 1, 0];
            const result2 = approvalElection.validateVote(tooMany);
            expect(result2.valid).toBe(false);
            expect(result2.errors[0]).toContain("Cannot approve more than 3");

            // Just right
            const justRight = [1, 1, 0, 1, 0];
            const result3 = approvalElection.validateVote(justRight);
            expect(result3.valid).toBe(true);
            expect(result3.errors).toHaveLength(0);
        });
    });

    describe("ApprovalElection On-Chain Creation and Retrieval", () => {
        it("should create an approval election on-chain and retrieve it for vote validation", async () => {
            const approvalElection = new ApprovalElection(sdk, {
                title: "City Referendum - Approval Voting",
                description: "Vote to approve or disapprove multiple city initiatives",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            approvalElection
                .addChoice("Build new library")
                .addChoice("Increase park funding")
                .addChoice("Add bike lanes")
                .addChoice("Extend bus routes")
                .addChoice("Build community center")
                .requireMinimumApprovals(1)
                .limitMaximumApprovals(3);

            const result = await approvalElection.build();

            // Verify the election was created successfully
            expect(result).toHaveProperty("processId");
            expect(result).toHaveProperty("transactionHash");
            expect(result).toHaveProperty("encryptionPubKey");
            expect(result).toHaveProperty("stateRoot");
            expect(result).toHaveProperty("metadataHash");
            expect(result).toHaveProperty("metadata");

            // Verify hex format of returned values
            expect(isValidHex(result.processId, 64)).toBe(true);
            expect(isValidHex(result.transactionHash, 64)).toBe(true);
            expect(Array.isArray(result.encryptionPubKey)).toBe(true);
            expect(result.encryptionPubKey).toHaveLength(2);
            expect(isValidHex(result.stateRoot, 64)).toBe(true);
            expect(isValidHex(result.metadataHash, 64)).toBe(true);

            // Verify metadata content
            expect(result.metadata.title.default).toBe("City Referendum - Approval Voting");
            expect(result.metadata.description.default).toBe("Vote to approve or disapprove multiple city initiatives");
            expect(result.metadata.questions).toHaveLength(1);
            expect(result.metadata.questions[0].choices).toHaveLength(5);
            expect(result.metadata.type.name).toBe("approval");
            
            // Cast to ApprovalProperties to access specific properties
            const approvalProperties = result.metadata.type.properties as any;
            expect(approvalProperties.rejectValue).toBe(0);
            expect(approvalProperties.acceptValue).toBe(1);

            // Verify choices
            const choices = result.metadata.questions[0].choices;
            expect(choices[0].title.default).toBe("Build new library");
            expect(choices[0].value).toBe(0);
            expect(choices[4].title.default).toBe("Build community center");
            expect(choices[4].value).toBe(4);

        }, parseInt(process.env.TIMEOUT || "30000"));

        it("should retrieve election by processId and validate votes", async () => {
            // Create election
            const approvalElection = new ApprovalElection(sdk, {
                title: "Community Referendum - Retrieval Test",
                description: "Test election retrieval and vote validation",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            approvalElection
                .addChoice("Build new library")
                .addChoice("Increase park funding")
                .addChoice("Add bike lanes")
                .requireMinimumApprovals(1)
                .limitMaximumApprovals(2);

            const result = await approvalElection.build();
            const processId = result.processId;

            // Retrieve election by processId
            const retrievedElection = await sdk.getElection(processId);
            
            expect(retrievedElection).not.toBeNull();
            expect(retrievedElection).toBeInstanceOf(ApprovalElection);

            if (retrievedElection instanceof ApprovalElection) {
                // Verify configuration was restored
                const limits = retrievedElection.getApprovalLimits();
                expect(limits.min).toBe(1);
                expect(limits.max).toBe(2);

                const choices = retrievedElection.getChoices();
                expect(choices).toHaveLength(3);
                expect(choices[0].title).toBe("Build new library");
                expect(choices[1].title).toBe("Increase park funding");
                expect(choices[2].title).toBe("Add bike lanes");

                // Test vote validation on retrieved election
                const validVote1 = [1, 0, 1]; // 2 approvals (within limits)
                const validResult1 = retrievedElection.validateVote(validVote1);
                expect(validResult1.valid).toBe(true);
                expect(validResult1.errors).toHaveLength(0);

                const validVote2 = [0, 1, 0]; // 1 approval (minimum met)
                const validResult2 = retrievedElection.validateVote(validVote2);
                expect(validResult2.valid).toBe(true);
                expect(validResult2.errors).toHaveLength(0);

                // Test invalid votes
                const invalidVote1 = [0, 0, 0]; // No approvals (below minimum)
                const invalidResult1 = retrievedElection.validateVote(invalidVote1);
                expect(invalidResult1.valid).toBe(false);
                expect(invalidResult1.errors[0]).toContain("Must approve at least 1");

                const invalidVote2 = [1, 1, 1]; // Too many approvals (above maximum)
                const invalidResult2 = retrievedElection.validateVote(invalidVote2);
                expect(invalidResult2.valid).toBe(false);
                expect(invalidResult2.errors[0]).toContain("Cannot approve more than 2");

                const invalidVote3 = [1, 2, 0]; // Invalid value
                const invalidResult3 = retrievedElection.validateVote(invalidVote3);
                expect(invalidResult3.valid).toBe(false);
                expect(invalidResult3.errors[0]).toContain("must be either 0 (disapprove) or 1 (approve)");
            }

        }, parseInt(process.env.TIMEOUT || "45000"));

        it("should create an approval election with media", async () => {
            const approvalElection = new ApprovalElection(sdk, {
                title: "Environmental Initiatives Referendum",
                description: "Approve environmental initiatives for our city",
                duration: 7200, // 2 hours
                censusRoot: censusRoot,
                maxVotes: "50"
            });

            approvalElection
                .addChoice("Solar panel installation program")
                .addChoice("Electric vehicle charging stations")
                .addChoice("Tree planting initiative")
                .setMedia("https://example.com/env-header.jpg", "https://example.com/env-logo.png");

            const result = await approvalElection.build();

            expect(result.metadata.media.header).toBe("https://example.com/env-header.jpg");
            expect(result.metadata.media.logo).toBe("https://example.com/env-logo.png");
            expect(result.metadata.questions[0].choices).toHaveLength(3);

        }, parseInt(process.env.TIMEOUT || "30000"));

        it("should handle validation errors during build", async () => {
            const approvalElection = new ApprovalElection(sdk, {
                title: "",  // Invalid: empty title
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            await expect(approvalElection.build()).rejects.toThrow("Election title is required");
        });

        it("should handle insufficient choices", async () => {
            const approvalElection = new ApprovalElection(sdk, {
                title: "Test Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            // No choices added
            await expect(approvalElection.build()).rejects.toThrow("At least one choice is required");
        });
    });

    describe("ApprovalElection Ballot Mode Generation", () => {
        it("should generate correct ballot mode parameters", () => {
            const approvalElection = new ApprovalElection(sdk, {
                title: "Test Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            approvalElection
                .addChoice("Question 1")
                .addChoice("Question 2")
                .addChoice("Question 3")
                .addChoice("Question 4")
                .addChoice("Question 5")
                .requireMinimumApprovals(1)
                .limitMaximumApprovals(3);

            const ballotMode = (approvalElection as any).generateBallotMode();
            
            expect(ballotMode.maxCount).toBe(5);
            expect(ballotMode.maxValue).toBe("1");
            expect(ballotMode.minValue).toBe("0");
            expect(ballotMode.forceUniqueness).toBe(false);
            expect(ballotMode.costExponent).toBe(1);
            expect(ballotMode.maxTotalCost).toBe("3");
            expect(ballotMode.minTotalCost).toBe("1");
        });

        it("should handle unlimited approvals", () => {
            const approvalElection = new ApprovalElection(sdk, {
                title: "Test Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            approvalElection
                .addChoice("Question 1")
                .addChoice("Question 2")
                .addChoice("Question 3");

            const ballotMode = (approvalElection as any).generateBallotMode();
            
            expect(ballotMode.maxTotalCost).toBe("3"); // All choices can be approved
            expect(ballotMode.minTotalCost).toBe("0"); // No minimum by default
        });
    });
});
