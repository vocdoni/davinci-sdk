import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });

import { DavinciSDK, DavinciSDKConfig } from "../../../src/core/DavinciSDK";
import { QuadraticElection } from "../../../src/core/QuadraticElection";
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

describe("QuadraticElection Integration Tests", () => {
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

    describe("QuadraticElection Configuration", () => {
        let quadraticElection: QuadraticElection;

        beforeEach(() => {
            quadraticElection = new QuadraticElection(sdk, {
                title: "Budget Allocation - Quadratic Voting",
                description: "Distribute credits among budget categories using quadratic voting",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });
        });

        it("should create a QuadraticElection instance", () => {
            expect(quadraticElection).toBeInstanceOf(QuadraticElection);
        });

        it("should add choices to the election", () => {
            quadraticElection
                .addChoice("Education Funding")
                .addChoice("Healthcare Funding")
                .addChoice("Infrastructure Funding")
                .addChoice("Environmental Programs")
                .addChoice("Arts and Culture");

            const choices = quadraticElection.getChoices();
            expect(choices).toHaveLength(5);
            expect(choices[0].title).toBe("Education Funding");
            expect(choices[0].value).toBe(0);
            expect(choices[4].title).toBe("Arts and Culture");
            expect(choices[4].value).toBe(4);
        });

        it("should configure quadratic voting parameters", () => {
            quadraticElection
                .addChoice("Project A")
                .addChoice("Project B")
                .addChoice("Project C")
                .setTotalCredits(16)
                .setMinStep(2)
                .requireFullBudget()
                .enableCensusWeightAsBudget();

            const config = quadraticElection.getQuadraticConfig();
            expect(config.totalCredits).toBe(16);
            expect(config.minStep).toBe(2);
            expect(config.forceFullBudget).toBe(true);
            expect(config.useCensusWeightAsBudget).toBe(true);
            expect(config.maxVotePerChoice).toBe(4); // floor(sqrt(16)) = 4
        });

        it("should validate quadratic parameter constraints", () => {
            quadraticElection
                .addChoice("Project A")
                .addChoice("Project B");

            expect(() => {
                quadraticElection.setTotalCredits(-5);
            }).toThrow("Total credits cannot be negative");

            expect(() => {
                quadraticElection.setMinStep(0);
            }).toThrow("Minimum step must be positive");

            expect(() => {
                quadraticElection.setMinStep(-1);
            }).toThrow("Minimum step must be positive");
        });

        it("should validate budget feasibility", async () => {
            quadraticElection
                .addChoice("Project A")
                .addChoice("Project B")
                .setTotalCredits(1)
                .setMinStep(2)
                .requireFullBudget();

            // Should throw error if impossible to spend credits with given constraints
            await expect(quadraticElection.build()).rejects.toThrow("Cannot spend 1 credits with minimum step 2");
        });
    });

    describe("QuadraticElection Vote Validation", () => {
        let quadraticElection: QuadraticElection;

        beforeEach(() => {
            quadraticElection = new QuadraticElection(sdk, {
                title: "Test Quadratic Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            quadraticElection
                .addChoice("Option 1")
                .addChoice("Option 2")
                .addChoice("Option 3")
                .addChoice("Option 4")
                .addChoice("Option 5")
                .setTotalCredits(12);
        });

        it("should validate correct quadratic votes", () => {
            // Cost: 1² + 1² + 2² + 0² + 0² = 1 + 1 + 4 + 0 + 0 = 6 credits
            const validVote = [1, 1, 2, 0, 0];
            const result = quadraticElection.validateVote(validVote);
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            // All zeros (spend no credits)
            const allZeros = [0, 0, 0, 0, 0];
            const result2 = quadraticElection.validateVote(allZeros);
            expect(result2.valid).toBe(true);
            expect(result2.errors).toHaveLength(0);

            // Mixed positive votes within budget
            const mixedVote = [2, 1, 1, 0, 0];
            // Cost: 2² + 1² + 1² + 0² + 0² = 4 + 1 + 1 + 0 + 0 = 6 credits
            const result3 = quadraticElection.validateVote(mixedVote);
            expect(result3.valid).toBe(true);
            expect(result3.errors).toHaveLength(0);
        });

        it("should reject invalid vote formats", () => {
            // Wrong number of votes
            const invalidVote1 = [1, 1, 2];
            const result1 = quadraticElection.validateVote(invalidVote1);
            expect(result1.valid).toBe(false);
            expect(result1.errors[0]).toContain("exactly 5 votes");

            // Exceeds credit limit
            const invalidVote2 = [3, 3, 0, 0, 0];
            // Cost: 3² + 3² + 0² + 0² + 0² = 9 + 9 = 18 credits (exceeds 12)
            const result2 = quadraticElection.validateVote(invalidVote2);
            expect(result2.valid).toBe(false);
            expect(result2.errors[0]).toContain("Cannot spend more than 12 credits");

            // Negative votes (not allowed)
            const invalidVote3 = [2, -1, 0, 0, 0];
            const result3 = quadraticElection.validateVote(invalidVote3);
            expect(result3.valid).toBe(false);
            expect(result3.errors[0]).toContain("cannot be negative");
        });

        it("should enforce minimum step constraints", () => {
            quadraticElection.setMinStep(2);

            // Invalid - not a multiple of minStep
            const invalidVote = [1, 2, 0, 0, 0]; // 1 is not a multiple of 2
            const result = quadraticElection.validateVote(invalidVote);
            expect(result.valid).toBe(false);
            expect(result.errors[0]).toContain("must be a multiple of 2");

            // Valid - all multiples of minStep
            const validVote = [2, 0, 2, 0, 0];
            // Cost: 2² + 0² + 2² + 0² + 0² = 4 + 0 + 4 + 0 + 0 = 8 credits
            const result2 = quadraticElection.validateVote(validVote);
            expect(result2.valid).toBe(true);
            expect(result2.errors).toHaveLength(0);
        });

        it("should enforce full budget requirement", () => {
            quadraticElection
                .setTotalCredits(9)
                .requireFullBudget();

            // Invalid - doesn't spend all credits
            const invalidVote = [2, 0, 0, 0, 0]; // Only spends 4 credits
            const result = quadraticElection.validateVote(invalidVote);
            expect(result.valid).toBe(false);
            expect(result.errors[0]).toContain("Must spend exactly 9 credits");

            // Valid - spends exactly all credits
            const validVote = [3, 0, 0, 0, 0]; // Spends exactly 9 credits (3² = 9)
            const result2 = quadraticElection.validateVote(validVote);
            expect(result2.valid).toBe(true);
            expect(result2.errors).toHaveLength(0);
        });

        it("should allow partial budget spending", () => {
            quadraticElection
                .setTotalCredits(12)
                .allowPartialBudget();

            // Valid - spend less than full budget
            const validVote = [1, 1, 0, 0, 0]; // Spends 2 credits
            const result = quadraticElection.validateVote(validVote);
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            // Valid - spend full budget
            const validVote2 = [2, 2, 2, 0, 0]; // Spends 12 credits
            const result2 = quadraticElection.validateVote(validVote2);
            expect(result2.valid).toBe(true);
            expect(result2.errors).toHaveLength(0);
        });
    });

    describe("QuadraticElection Cost Calculations", () => {
        let quadraticElection: QuadraticElection;

        beforeEach(() => {
            quadraticElection = new QuadraticElection(sdk, {
                title: "Test Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            quadraticElection.setTotalCredits(16);
        });

        it("should calculate vote costs correctly", () => {
            expect(quadraticElection.calculateVoteCost(0)).toBe(0);
            expect(quadraticElection.calculateVoteCost(1)).toBe(1);
            expect(quadraticElection.calculateVoteCost(2)).toBe(4);
            expect(quadraticElection.calculateVoteCost(3)).toBe(9);
            expect(quadraticElection.calculateVoteCost(4)).toBe(16);
            expect(quadraticElection.calculateVoteCost(2)).toBe(4); // 2² = 4
        });

        it("should calculate maximum vote for given cost", () => {
            expect(quadraticElection.calculateMaxVoteForCost(0)).toBe(0);
            expect(quadraticElection.calculateMaxVoteForCost(1)).toBe(1);
            expect(quadraticElection.calculateMaxVoteForCost(4)).toBe(2);
            expect(quadraticElection.calculateMaxVoteForCost(9)).toBe(3);
            expect(quadraticElection.calculateMaxVoteForCost(16)).toBe(4);
            expect(quadraticElection.calculateMaxVoteForCost(15)).toBe(3); // floor(sqrt(15)) = 3
        });

        it("should provide correct total credits", () => {
            expect(quadraticElection.getTotalCredits()).toBe(16);
        });

        it("should provide correct configuration flags", () => {
            expect(quadraticElection.isUsingCensusWeightAsBudget()).toBe(false);
            expect(quadraticElection.isFullBudgetRequired()).toBe(false);
            expect(quadraticElection.getMinStep()).toBe(1);

            quadraticElection
                .enableCensusWeightAsBudget()
                .requireFullBudget()
                .setMinStep(2);

            expect(quadraticElection.isUsingCensusWeightAsBudget()).toBe(true);
            expect(quadraticElection.isFullBudgetRequired()).toBe(true);
            expect(quadraticElection.getMinStep()).toBe(2);
        });
    });

    describe("QuadraticElection On-Chain Creation and Retrieval", () => {
        it("should create a quadratic election on-chain and retrieve it for vote validation", async () => {
            const quadraticElection = new QuadraticElection(sdk, {
                title: "Community Budget Allocation",
                description: "Use quadratic voting to allocate community budget across different projects",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            quadraticElection
                .addChoice("Education Programs")
                .addChoice("Healthcare Initiatives")
                .addChoice("Infrastructure Projects")
                .addChoice("Environmental Programs")
                .addChoice("Arts and Culture")
                .setTotalCredits(25)
                .allowPartialBudget()
                .setMinStep(1);

            const result = await quadraticElection.build();

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
            expect(result.metadata.title.default).toBe("Community Budget Allocation");
            expect(result.metadata.description.default).toBe("Use quadratic voting to allocate community budget across different projects");
            expect(result.metadata.questions).toHaveLength(1);
            expect(result.metadata.questions[0].choices).toHaveLength(5);
            expect(result.metadata.type.name).toBe("quadratic");

            // Verify quadratic-specific metadata
            const quadraticProperties = result.metadata.type.properties as any;
            expect(quadraticProperties.useCensusWeightAsBudget).toBe(false);
            expect(quadraticProperties.maxBudget).toBe(25);
            expect(quadraticProperties.minStep).toBe(1);
            expect(quadraticProperties.forceFullBudget).toBe(false);
            expect(quadraticProperties.quadraticCost).toBe(2);

            expect(result.metadata.meta?.quadraticElection).toBeDefined();
            const quadraticMeta = result.metadata.meta?.quadraticElection as any;
            expect(quadraticMeta.totalCredits).toBe(25);
            expect(quadraticMeta.maxVotePerChoice).toBe(5); // floor(sqrt(25)) = 5

            // Verify choices
            const choices = result.metadata.questions[0].choices;
            expect(choices[0].title.default).toBe("Education Programs");
            expect(choices[0].value).toBe(0);
            expect(choices[4].title.default).toBe("Arts and Culture");
            expect(choices[4].value).toBe(4);

        }, parseInt(process.env.TIMEOUT || "30000"));

        it("should retrieve election by processId and validate votes", async () => {
            // Create election
            const quadraticElection = new QuadraticElection(sdk, {
                title: "Budget Allocation - Retrieval Test",
                description: "Test election retrieval and vote validation",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            quadraticElection
                .addChoice("Education")
                .addChoice("Healthcare")
                .addChoice("Infrastructure")
                .setTotalCredits(16)
                .allowPartialBudget()
                .setMinStep(1);

            const result = await quadraticElection.build();
            const processId = result.processId;

            // Retrieve election by processId
            const retrievedElection = await sdk.getElection(processId);
            
            expect(retrievedElection).not.toBeNull();
            expect(retrievedElection).toBeInstanceOf(QuadraticElection);

            if (retrievedElection instanceof QuadraticElection) {
                // Verify configuration was restored
                const config = retrievedElection.getQuadraticConfig();
                expect(config.totalCredits).toBe(16);
                expect(config.forceFullBudget).toBe(false);
                expect(config.minStep).toBe(1);
                expect(config.useCensusWeightAsBudget).toBe(false);
                expect(config.maxVotePerChoice).toBe(4); // floor(sqrt(16)) = 4

                const choices = retrievedElection.getChoices();
                expect(choices).toHaveLength(3);
                expect(choices[0].title).toBe("Education");
                expect(choices[1].title).toBe("Healthcare");
                expect(choices[2].title).toBe("Infrastructure");

                // Test vote validation on retrieved election
                const validVote1 = [3, 2, 1]; // Costs: 9 + 4 + 1 = 14 credits (within 16 limit)
                const validResult1 = retrievedElection.validateVote(validVote1);
                expect(validResult1.valid).toBe(true);
                expect(validResult1.errors).toHaveLength(0);

                const validVote2 = [0, 0, 0]; // No credits spent (partial budget allowed)
                const validResult2 = retrievedElection.validateVote(validVote2);
                expect(validResult2.valid).toBe(true);
                expect(validResult2.errors).toHaveLength(0);

                const validVote3 = [2, 2, 0]; // Positive votes: 4 + 4 + 0 = 8 credits
                const validResult3 = retrievedElection.validateVote(validVote3);
                expect(validResult3.valid).toBe(true);
                expect(validResult3.errors).toHaveLength(0);

                // Test invalid votes
                const invalidVote1 = [4, 1, 0]; // Costs: 16 + 1 + 0 = 17 credits (exceeds 16)
                const invalidResult1 = retrievedElection.validateVote(invalidVote1);
                expect(invalidResult1.valid).toBe(false);
                expect(invalidResult1.errors[0]).toContain("Cannot spend more than 16 credits");

                // Test cost calculations
                expect(retrievedElection.calculateVoteCost(3)).toBe(9);
                expect(retrievedElection.calculateVoteCost(2)).toBe(4);
                expect(retrievedElection.calculateMaxVoteForCost(16)).toBe(4);
            }

        }, parseInt(process.env.TIMEOUT || "45000"));

        it("should create a quadratic election with census weight as budget", async () => {
            const quadraticElection = new QuadraticElection(sdk, {
                title: "Weighted Budget Allocation",
                description: "Budget allocation using census weight as individual budgets",
                duration: 7200, // 2 hours
                censusRoot: censusRoot,
                maxVotes: "50"
            });

            quadraticElection
                .addChoice("Project Alpha")
                .addChoice("Project Beta")
                .addChoice("Project Gamma")
                .enableCensusWeightAsBudget()
                .requireFullBudget()
                .setMinStep(2)
                .setMedia("https://example.com/quadratic-header.jpg", "https://example.com/quadratic-logo.png");

            const result = await quadraticElection.build();

            expect(result.metadata.media.header).toBe("https://example.com/quadratic-header.jpg");
            expect(result.metadata.media.logo).toBe("https://example.com/quadratic-logo.png");
            expect(result.metadata.questions[0].choices).toHaveLength(3);

            // Verify census weight configuration
            const quadraticProperties = result.metadata.type.properties as any;
            expect(quadraticProperties.useCensusWeightAsBudget).toBe(true);
            expect(quadraticProperties.forceFullBudget).toBe(true);
            expect(quadraticProperties.minStep).toBe(2);

        }, parseInt(process.env.TIMEOUT || "30000"));

        it("should handle validation errors during build", async () => {
            const quadraticElection = new QuadraticElection(sdk, {
                title: "",  // Invalid: empty title
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            await expect(quadraticElection.build()).rejects.toThrow("Election title is required");
        });

        it("should handle insufficient choices", async () => {
            const quadraticElection = new QuadraticElection(sdk, {
                title: "Test Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            // No choices added
            await expect(quadraticElection.build()).rejects.toThrow("At least one choice is required");
        });

        it("should handle invalid credit configuration", async () => {
            const quadraticElection = new QuadraticElection(sdk, {
                title: "Test Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            quadraticElection
                .addChoice("Project A")
                .setTotalCredits(0); // Invalid: zero credits

            await expect(quadraticElection.build()).rejects.toThrow("Total credits must be positive");
        });
    });

    describe("QuadraticElection Ballot Mode Generation", () => {
        it("should generate correct ballot mode parameters", () => {
            const quadraticElection = new QuadraticElection(sdk, {
                title: "Test Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            quadraticElection
                .addChoice("Option 1")
                .addChoice("Option 2")
                .addChoice("Option 3")
                .addChoice("Option 4")
                .addChoice("Option 5")
                .setTotalCredits(16)
                .allowPartialBudget();

            const ballotMode = (quadraticElection as any).generateBallotMode();
            
            expect(ballotMode.maxCount).toBe(5);
            expect(ballotMode.maxValue).toBe("4"); // floor(sqrt(16)) = 4
            expect(ballotMode.minValue).toBe("0"); // Only allow non-negative votes
            expect(ballotMode.forceUniqueness).toBe(false);
            expect(ballotMode.costFromWeight).toBe(false);
            expect(ballotMode.costExponent).toBe(2); // Quadratic cost
            expect(ballotMode.maxTotalCost).toBe("16");
            expect(ballotMode.minTotalCost).toBe("0"); // Partial budget allowed
        });

        it("should handle full budget requirement", () => {
            const quadraticElection = new QuadraticElection(sdk, {
                title: "Test Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            quadraticElection
                .addChoice("Option 1")
                .addChoice("Option 2")
                .addChoice("Option 3")
                .setTotalCredits(9)
                .requireFullBudget();

            const ballotMode = (quadraticElection as any).generateBallotMode();
            
            expect(ballotMode.maxValue).toBe("3"); // floor(sqrt(9)) = 3
            expect(ballotMode.minValue).toBe("0");
            expect(ballotMode.maxTotalCost).toBe("9");
            expect(ballotMode.minTotalCost).toBe("9"); // Full budget required
        });

        it("should handle census weight as budget", () => {
            const quadraticElection = new QuadraticElection(sdk, {
                title: "Test Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            quadraticElection
                .addChoice("Option 1")
                .addChoice("Option 2")
                .enableCensusWeightAsBudget()
                .setTotalCredits(25); // This becomes the default/fallback

            const ballotMode = (quadraticElection as any).generateBallotMode();
            
            expect(ballotMode.costFromWeight).toBe(true);
            expect(ballotMode.maxValue).toBe("5"); // floor(sqrt(25)) = 5
            expect(ballotMode.maxTotalCost).toBe("25");
        });
    });
});
