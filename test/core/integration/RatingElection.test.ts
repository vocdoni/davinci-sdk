import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });

import { DavinciSDK, DavinciSDKConfig } from "../../../src/core/DavinciSDK";
import { RatingElection } from "../../../src/core/RatingElection";
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

describe("RatingElection Integration Tests", () => {
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

    describe("RatingElection Configuration", () => {
        let ratingElection: RatingElection;

        beforeEach(() => {
            ratingElection = new RatingElection(sdk, {
                title: "Service Satisfaction Survey",
                description: "Rate the quality of various city services",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });
        });

        it("should create a RatingElection instance", () => {
            expect(ratingElection).toBeInstanceOf(RatingElection);
        });

        it("should add choices to the election", () => {
            ratingElection
                .addChoice("Public Transportation")
                .addChoice("Parks and Recreation")
                .addChoice("Road Maintenance")
                .addChoice("Emergency Services")
                .addChoice("Public Libraries");

            const choices = ratingElection.getChoices();
            expect(choices).toHaveLength(5);
            expect(choices[0].title).toBe("Public Transportation");
            expect(choices[0].value).toBe(0);
            expect(choices[4].title).toBe("Public Libraries");
            expect(choices[4].value).toBe(4);
        });

        it("should configure rating parameters", () => {
            ratingElection
                .addChoice("Service A")
                .addChoice("Service B")
                .addChoice("Service C")
                .setMaxRating(10)
                .setMinRating(1)
                .setMaxTotalRating(25)
                .setMinTotalRating(5);

            const config = ratingElection.getRatingConfig();
            expect(config.minRating).toBe(1);
            expect(config.maxRating).toBe(10);
            expect(config.minTotalRating).toBe(5);
            expect(config.maxTotalRating).toBe(25);
        });

        it("should validate rating parameter constraints", () => {
            ratingElection
                .addChoice("Service A")
                .addChoice("Service B");

            expect(() => {
                ratingElection
                    .setMinRating(5)
                    .setMaxRating(3);
            }).toThrow("Maximum rating cannot be less than minimum rating");

            expect(() => {
                ratingElection
                    .setMinTotalRating(20)
                    .setMaxTotalRating(10);
            }).toThrow("Maximum total rating cannot be less than minimum total rating");
        });

        it("should validate achievable total rating constraints", () => {
            ratingElection
                .addChoice("Service A")
                .addChoice("Service B")
                .setMaxRating(5)
                .setMinRating(1);

            // Should throw error if constraints are impossible
            expect(() => {
                ratingElection.setMinTotalRating(15); // Impossible with 2 services rated 1-5
            }).toThrow("Minimum total rating (15) is impossible to achieve");

            expect(() => {
                ratingElection.setMaxTotalRating(1); // Impossible with 2 services rated 1-5
            }).toThrow("Maximum total rating (1) is impossible to achieve");
        });
    });

    describe("RatingElection Vote Validation", () => {
        let ratingElection: RatingElection;

        beforeEach(() => {
            ratingElection = new RatingElection(sdk, {
                title: "Test Rating Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            ratingElection
                .addChoice("Item 1")
                .addChoice("Item 2")
                .addChoice("Item 3")
                .addChoice("Item 4")
                .addChoice("Item 5")
                .setMaxRating(10);
        });

        it("should validate correct rating votes", () => {
            const validVote = [8, 6, 4, 7, 10];
            const result = ratingElection.validateVote(validVote);
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);

            // All minimum ratings
            const allMin = [0, 0, 0, 0, 0];
            const result2 = ratingElection.validateVote(allMin);
            expect(result2.valid).toBe(true);
            expect(result2.errors).toHaveLength(0);

            // All maximum ratings
            const allMax = [10, 10, 10, 10, 10];
            const result3 = ratingElection.validateVote(allMax);
            expect(result3.valid).toBe(true);
            expect(result3.errors).toHaveLength(0);
        });

        it("should reject invalid vote formats", () => {
            // Wrong number of votes
            const invalidVote1 = [8, 6, 4];
            const result1 = ratingElection.validateVote(invalidVote1);
            expect(result1.valid).toBe(false);
            expect(result1.errors[0]).toContain("exactly 5 ratings");

            // Rating out of range (too high)
            const invalidVote2 = [8, 6, 4, 12, 10];
            const result2 = ratingElection.validateVote(invalidVote2);
            expect(result2.valid).toBe(false);
            expect(result2.errors[0]).toContain("must be between 0 and 10");

            // Rating out of range (too high)
            const invalidVote3 = [8, 6, 11, 7, 10];
            const result3 = ratingElection.validateVote(invalidVote3);
            expect(result3.valid).toBe(false);
            expect(result3.errors[0]).toContain("must be between 0 and 10");
        });

        it("should enforce total rating limits", () => {
            ratingElection
                .setMaxTotalRating(20)
                .setMinTotalRating(10);

            // Total too low
            const tooLow = [1, 1, 1, 1, 1]; // Total = 5
            const result1 = ratingElection.validateVote(tooLow);
            expect(result1.valid).toBe(false);
            expect(result1.errors[0]).toContain("Total rating must be at least 10");

            // Total too high
            const tooHigh = [5, 5, 5, 5, 5]; // Total = 25
            const result2 = ratingElection.validateVote(tooHigh);
            expect(result2.valid).toBe(false);
            expect(result2.errors[0]).toContain("Total rating cannot exceed 20");

            // Just right
            const justRight = [3, 3, 3, 3, 3]; // Total = 15
            const result3 = ratingElection.validateVote(justRight);
            expect(result3.valid).toBe(true);
            expect(result3.errors).toHaveLength(0);
        });
    });

    describe("RatingElection On-Chain Creation and Retrieval", () => {
        it("should create a rating election on-chain and retrieve it for vote validation", async () => {
            const ratingElection = new RatingElection(sdk, {
                title: "City Services Satisfaction Survey",
                description: "Rate the quality of various city services from 0-10",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            ratingElection
                .addChoice("Public Transportation")
                .addChoice("Parks and Recreation")
                .addChoice("Road Maintenance")
                .addChoice("Emergency Services")
                .addChoice("Public Libraries")
                .setMaxRating(10)
                .setMinRating(0)
                .setMaxTotalRating(40);

            const result = await ratingElection.build();

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
            expect(result.metadata.title.default).toBe("City Services Satisfaction Survey");
            expect(result.metadata.description.default).toBe("Rate the quality of various city services from 0-10");
            expect(result.metadata.questions).toHaveLength(1);
            expect(result.metadata.questions[0].choices).toHaveLength(5);
            expect(result.metadata.type.name).toBe("multiple-choice");

            // Verify rating-specific metadata
            expect(result.metadata.meta?.ratingElection).toBeDefined();
            const ratingMeta = result.metadata.meta?.ratingElection as any;
            expect(ratingMeta.minRating).toBe(0);
            expect(ratingMeta.maxRating).toBe(10);
            expect(ratingMeta.maxTotalRating).toBe(40);

            // Verify choices
            const choices = result.metadata.questions[0].choices;
            expect(choices[0].title.default).toBe("Public Transportation");
            expect(choices[0].value).toBe(0);
            expect(choices[4].title.default).toBe("Public Libraries");
            expect(choices[4].value).toBe(4);

        }, parseInt(process.env.TIMEOUT || "30000"));

        it("should retrieve election by processId and validate votes", async () => {
            // Create election
            const ratingElection = new RatingElection(sdk, {
                title: "Service Quality Survey - Retrieval Test",
                description: "Test election retrieval and vote validation",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            ratingElection
                .addChoice("Customer Service")
                .addChoice("Product Quality")
                .addChoice("Delivery Speed")
                .setMinRating(0)
                .setMaxRating(5)
                .setMinTotalRating(3)
                .setMaxTotalRating(12);

            const result = await ratingElection.build();
            const processId = result.processId;

            // Retrieve election by processId
            const retrievedElection = await sdk.getElection(processId);
            
            expect(retrievedElection).not.toBeNull();
            expect(retrievedElection).toBeInstanceOf(RatingElection);

            if (retrievedElection instanceof RatingElection) {
                // Verify election type was correctly detected
                const choices = retrievedElection.getChoices();
                expect(choices).toHaveLength(3);
                expect(choices[0].title).toBe("Customer Service");
                expect(choices[1].title).toBe("Product Quality");
                expect(choices[2].title).toBe("Delivery Speed");

                // Test vote validation on retrieved election with default settings
                // Since configuration wasn't stored, it uses defaults (0-10 rating, no total limits)
                const validVote1 = [4, 5, 3]; // Valid ratings within 0-10 range
                const validResult1 = retrievedElection.validateVote(validVote1);
                expect(validResult1.valid).toBe(true);
                expect(validResult1.errors).toHaveLength(0);

                const validVote2 = [0, 1, 2]; // Valid ratings within 0-10 range
                const validResult2 = retrievedElection.validateVote(validVote2);
                expect(validResult2.valid).toBe(true);
                expect(validResult2.errors).toHaveLength(0);

                // Test invalid votes
                const invalidVote1 = [11, 5, 3]; // Rating out of range (above 10)
                const invalidResult1 = retrievedElection.validateVote(invalidVote1);
                expect(invalidResult1.valid).toBe(false);
                expect(invalidResult1.errors[0]).toContain("must be between 0 and 10");

                const invalidVote2 = [-1, 5, 3]; // Rating out of range (below 0)
                const invalidResult2 = retrievedElection.validateVote(invalidVote2);
                expect(invalidResult2.valid).toBe(false);
                expect(invalidResult2.errors[0]).toContain("must be between 0 and 10");

                const invalidVote3 = [1, 2]; // Wrong number of ratings
                const invalidResult3 = retrievedElection.validateVote(invalidVote3);
                expect(invalidResult3.valid).toBe(false);
                expect(invalidResult3.errors[0]).toContain("exactly 3 ratings");
            }

        }, parseInt(process.env.TIMEOUT || "45000"));

        it("should create a rating election with custom rating scale", async () => {
            const ratingElection = new RatingElection(sdk, {
                title: "Product Quality Rating",
                description: "Rate products on a 1-5 star scale",
                duration: 7200, // 2 hours
                censusRoot: censusRoot,
                maxVotes: "50"
            });

            ratingElection
                .addChoice("Product A")
                .addChoice("Product B")
                .addChoice("Product C")
                .setMaxRating(5)
                .setMinRating(1)
                .setMedia("https://example.com/rating-header.jpg", "https://example.com/rating-logo.png");

            const result = await ratingElection.build();

            expect(result.metadata.media.header).toBe("https://example.com/rating-header.jpg");
            expect(result.metadata.media.logo).toBe("https://example.com/rating-logo.png");
            expect(result.metadata.questions[0].choices).toHaveLength(3);

            // Verify custom rating scale
            const ratingMeta = result.metadata.meta?.ratingElection as any;
            expect(ratingMeta.minRating).toBe(1);
            expect(ratingMeta.maxRating).toBe(5);

        }, parseInt(process.env.TIMEOUT || "30000"));

        it("should handle validation errors during build", async () => {
            const ratingElection = new RatingElection(sdk, {
                title: "",  // Invalid: empty title
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            await expect(ratingElection.build()).rejects.toThrow("Election title is required");
        });

        it("should handle insufficient choices", async () => {
            const ratingElection = new RatingElection(sdk, {
                title: "Test Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            // No choices added
            await expect(ratingElection.build()).rejects.toThrow("At least one choice is required");
        });
    });

    describe("RatingElection Ballot Mode Generation", () => {
        it("should generate correct ballot mode parameters", () => {
            const ratingElection = new RatingElection(sdk, {
                title: "Test Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            ratingElection
                .addChoice("Item 1")
                .addChoice("Item 2")
                .addChoice("Item 3")
                .addChoice("Item 4")
                .addChoice("Item 5")
                .setMaxRating(10)
                .setMinRating(0)
                .setMaxTotalRating(40);

            const ballotMode = (ratingElection as any).generateBallotMode();
            
            expect(ballotMode.maxCount).toBe(5);
            expect(ballotMode.maxValue).toBe("10");
            expect(ballotMode.minValue).toBe("0");
            expect(ballotMode.forceUniqueness).toBe(false);
            expect(ballotMode.costExponent).toBe(1);
            expect(ballotMode.maxTotalCost).toBe("40");
            expect(ballotMode.minTotalCost).toBe("0");
        });

        it("should handle custom rating ranges", () => {
            const ratingElection = new RatingElection(sdk, {
                title: "Test Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            ratingElection
                .addChoice("Item 1")
                .addChoice("Item 2")
                .addChoice("Item 3")
                .setMaxRating(5)
                .setMinRating(1)
                .setMinTotalRating(6)
                .setMaxTotalRating(12);

            const ballotMode = (ratingElection as any).generateBallotMode();
            
            expect(ballotMode.maxValue).toBe("5");
            expect(ballotMode.minValue).toBe("1");
            expect(ballotMode.maxTotalCost).toBe("12");
            expect(ballotMode.minTotalCost).toBe("6");
        });
    });
});
