import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });

import { DavinciSDK, DavinciSDKConfig } from "../../../src/core/DavinciSDK";
import { RankingElection } from "../../../src/core/RankingElection";
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

describe("RankingElection Integration Tests", () => {
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

    describe("RankingElection Configuration", () => {
        let rankingElection: RankingElection;

        beforeEach(() => {
            rankingElection = new RankingElection(sdk, {
                title: "School Trip Destination Ranking",
                description: "Rank your preferred destinations for the school trip",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });
        });

        it("should create a RankingElection instance", () => {
            expect(rankingElection).toBeInstanceOf(RankingElection);
        });

        it("should add choices to the election", () => {
            rankingElection
                .addChoice("Paris, France")
                .addChoice("Rome, Italy")
                .addChoice("Barcelona, Spain")
                .addChoice("Amsterdam, Netherlands")
                .addChoice("Berlin, Germany");

            const choices = rankingElection.getChoices();
            expect(choices).toHaveLength(5);
            expect(choices[0].title).toBe("Paris, France");
            expect(choices[0].value).toBe(0);
            expect(choices[4].title).toBe("Berlin, Germany");
            expect(choices[4].value).toBe(4);
        });

        it("should configure full ranking by default", () => {
            rankingElection
                .addChoice("Option A")
                .addChoice("Option B")
                .addChoice("Option C");

            const config = rankingElection.getRankingConfig();
            expect(config.allowPartialRanking).toBe(false);
            expect(config.minRankedChoices).toBe(0);
            expect(config.maxRank).toBe(3);
        });

        it("should configure partial ranking", () => {
            rankingElection
                .addChoice("Option A")
                .addChoice("Option B")
                .addChoice("Option C")
                .addChoice("Option D")
                .addChoice("Option E")
                .enablePartialRanking(3);

            const config = rankingElection.getRankingConfig();
            expect(config.allowPartialRanking).toBe(true);
            expect(config.minRankedChoices).toBe(3);
            expect(config.maxRank).toBe(5);
        });

        it("should validate partial ranking constraints", () => {
            rankingElection
                .addChoice("Option A")
                .addChoice("Option B")
                .addChoice("Option C");

            expect(() => {
                rankingElection.enablePartialRanking(5); // More than available choices
            }).toThrow("Minimum ranked choices cannot exceed the number of choices");

            expect(() => {
                rankingElection.enablePartialRanking(0); // Zero (should be at least 1)
            }).toThrow("Minimum ranked choices must be at least 1");
        });
    });

    describe("RankingElection Vote Validation", () => {
        describe("Full Ranking", () => {
            let rankingElection: RankingElection;

            beforeEach(() => {
                rankingElection = new RankingElection(sdk, {
                    title: "Test Ranking Election",
                    duration: 3600,
                    censusRoot: censusRoot,
                    maxVotes: "100"
                });

                rankingElection
                    .addChoice("Destination 1")
                    .addChoice("Destination 2")
                    .addChoice("Destination 3")
                    .addChoice("Destination 4")
                    .addChoice("Destination 5")
                    .requireFullRanking();
            });

            it("should validate correct ranking votes", () => {
            const validVote = [1, 3, 2, 4, 5];
                const result = rankingElection.validateVote(validVote);
                expect(result.valid).toBe(true);
                expect(result.errors).toHaveLength(0);

                // Another valid ranking
                const validVote2 = [5, 4, 3, 2, 1];
                const result2 = rankingElection.validateVote(validVote2);
                expect(result2.valid).toBe(true);
                expect(result2.errors).toHaveLength(0);
            });

            it("should reject invalid vote formats", () => {
                // Wrong number of votes
                const invalidVote1 = [1, 3, 2];
                const result1 = rankingElection.validateVote(invalidVote1);
                expect(result1.valid).toBe(false);
                expect(result1.errors[0]).toContain("exactly 5 rankings");

                // Duplicate rankings
                const invalidVote2 = [1, 3, 3, 4, 5];
                const result2 = rankingElection.validateVote(invalidVote2);
                expect(result2.valid).toBe(false);
                expect(result2.errors[0]).toContain("All rankings must be unique");

                // Missing ranking
                const invalidVote3 = [1, 3, 2, 4, 6]; // 6 is out of range
                const result3 = rankingElection.validateVote(invalidVote3);
                expect(result3.valid).toBe(false);
                expect(result3.errors[0]).toContain("must be between 1 and 5");

                // Zero in full ranking
                const invalidVote4 = [1, 3, 0, 4, 5];
                const result4 = rankingElection.validateVote(invalidVote4);
                expect(result4.valid).toBe(false);
                expect(result4.errors[0]).toContain("Full ranking required");
            });

            it("should require all ranks from 1 to N", () => {
                // Missing rank 2
                const invalidVote = [1, 3, 4, 5, 6];
                const result = rankingElection.validateVote(invalidVote);
                expect(result.valid).toBe(false);
                expect(result.errors).toContain("Ranking 2 is missing - all ranks from 1 to 5 must be used");
            });
        });

        describe("Partial Ranking", () => {
            let rankingElection: RankingElection;

            beforeEach(() => {
                rankingElection = new RankingElection(sdk, {
                    title: "Test Partial Ranking Election",
                    duration: 3600,
                    censusRoot: censusRoot,
                    maxVotes: "100"
                });

                rankingElection
                    .addChoice("Destination 1")
                    .addChoice("Destination 2")
                    .addChoice("Destination 3")
                    .addChoice("Destination 4")
                    .addChoice("Destination 5")
                    .enablePartialRanking(3);
            });

            it("should validate correct partial ranking votes", () => {
                // Valid partial ranking (rank top 3, leave others as 0)
                const validVote = [1, 2, 3, 0, 0];
                const result = rankingElection.validateVote(validVote);
                expect(result.valid).toBe(true);
                expect(result.errors).toHaveLength(0);

                // Valid partial ranking with different order
                const validVote2 = [0, 1, 0, 2, 3];
                const result2 = rankingElection.validateVote(validVote2);
                expect(result2.valid).toBe(true);
                expect(result2.errors).toHaveLength(0);
            });

            it("should enforce minimum ranked choices", () => {
                // Too few rankings
                const invalidVote = [1, 2, 0, 0, 0];
                const result = rankingElection.validateVote(invalidVote);
                expect(result.valid).toBe(false);
                expect(result.errors[0]).toContain("Must rank at least 3");
            });

            it("should require consecutive rankings starting from 1", () => {
                // Non-consecutive rankings (1, 3 without 2)
                const invalidVote = [1, 3, 0, 0, 0];
                const result = rankingElection.validateVote(invalidVote);
                expect(result.valid).toBe(false);
                expect(result.errors[0]).toContain("consecutive sequence starting from 1");

                // Starting from 2 instead of 1
                const invalidVote2 = [2, 3, 4, 0, 0];
                const result2 = rankingElection.validateVote(invalidVote2);
                expect(result2.valid).toBe(false);
                expect(result2.errors[0]).toContain("consecutive sequence starting from 1");
            });

            it("should allow full ranking in partial mode", () => {
                // Full ranking should still be valid in partial mode
                const validVote = [1, 2, 3, 4, 5];
                const result = rankingElection.validateVote(validVote);
                expect(result.valid).toBe(true);
                expect(result.errors).toHaveLength(0);
            });
        });
    });

    describe("RankingElection On-Chain Creation", () => {
        it("should create a full ranking election on-chain", async () => {
            const rankingElection = new RankingElection(sdk, {
                title: "European Cities Ranking",
                description: "Rank European cities by your preference for visiting",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            rankingElection
                .addChoice("Paris, France")
                .addChoice("Rome, Italy")
                .addChoice("Barcelona, Spain")
                .addChoice("Amsterdam, Netherlands")
                .addChoice("Berlin, Germany")
                .requireFullRanking();

            const result = await rankingElection.build();

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
            expect(result.metadata.title.default).toBe("European Cities Ranking");
            expect(result.metadata.description.default).toBe("Rank European cities by your preference for visiting");
            expect(result.metadata.questions).toHaveLength(1);
            expect(result.metadata.questions[0].choices).toHaveLength(5);
            expect(result.metadata.type.name).toBe("multiple-choice");

            // Verify ranking-specific metadata
            expect(result.metadata.meta?.rankingElection).toBeDefined();
            const rankingMeta = result.metadata.meta?.rankingElection as any;
            expect(rankingMeta.allowPartialRanking).toBe(false);
            expect(rankingMeta.minRankedChoices).toBe(0);
            expect(rankingMeta.maxRank).toBe(5);

            // Verify choices
            const choices = result.metadata.questions[0].choices;
            expect(choices[0].title.default).toBe("Paris, France");
            expect(choices[0].value).toBe(0);
            expect(choices[4].title.default).toBe("Berlin, Germany");
            expect(choices[4].value).toBe(4);

        }, parseInt(process.env.TIMEOUT || "30000"));

        it("should retrieve election by processId and validate votes", async () => {
            // Create election
            const rankingElection = new RankingElection(sdk, {
                title: "Programming Languages Ranking - Retrieval Test",
                description: "Test election retrieval and vote validation",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            rankingElection
                .addChoice("TypeScript")
                .addChoice("Python")
                .addChoice("Rust")
                .addChoice("Go")
                .enablePartialRanking(2);

            const result = await rankingElection.build();
            const processId = result.processId;

            // Retrieve election by processId
            const retrievedElection = await sdk.getElection(processId);
            
            expect(retrievedElection).not.toBeNull();
            expect(retrievedElection).toBeInstanceOf(RankingElection);

            if (retrievedElection instanceof RankingElection) {
                // Verify configuration was restored
                const config = retrievedElection.getRankingConfig();
                expect(config.allowPartialRanking).toBe(true);
                expect(config.minRankedChoices).toBe(2);
                expect(config.maxRank).toBe(4);

                const choices = retrievedElection.getChoices();
                expect(choices).toHaveLength(4);
                expect(choices[0].title).toBe("TypeScript");
                expect(choices[1].title).toBe("Python");
                expect(choices[2].title).toBe("Rust");
                expect(choices[3].title).toBe("Go");

                // Test vote validation on retrieved election
                const validVote1 = [1, 2, 3, 0]; // Rank top 3 (partial ranking)
                const validResult1 = retrievedElection.validateVote(validVote1);
                expect(validResult1.valid).toBe(true);
                expect(validResult1.errors).toHaveLength(0);

                const validVote2 = [1, 3, 2, 4]; // Full ranking (allowed in partial mode)
                const validResult2 = retrievedElection.validateVote(validVote2);
                expect(validResult2.valid).toBe(true);
                expect(validResult2.errors).toHaveLength(0);

                // Test invalid votes
                const invalidVote1 = [1, 0, 0, 0]; // Only 1 ranking (below minimum)
                const invalidResult1 = retrievedElection.validateVote(invalidVote1);
                expect(invalidResult1.valid).toBe(false);
                expect(invalidResult1.errors[0]).toContain("Must rank at least 2");

                const invalidVote2 = [1, 1, 2, 0]; // Duplicate ranking
                const invalidResult2 = retrievedElection.validateVote(invalidVote2);
                expect(invalidResult2.valid).toBe(false);
                expect(invalidResult2.errors[0]).toContain("All non-zero rankings must be unique");

                const invalidVote3 = [1, 3, 0, 0]; // Non-consecutive (1, 3 without 2)
                const invalidResult3 = retrievedElection.validateVote(invalidVote3);
                expect(invalidResult3.valid).toBe(false);
                expect(invalidResult3.errors[0]).toContain("consecutive sequence starting from 1");
            }

        }, parseInt(process.env.TIMEOUT || "45000"));

        it("should create a partial ranking election on-chain", async () => {
            const rankingElection = new RankingElection(sdk, {
                title: "Top 3 Favorite Movies",
                description: "Rank your top 3 favorite movies from the list",
                duration: 7200, // 2 hours
                censusRoot: censusRoot,
                maxVotes: "50"
            });

            rankingElection
                .addChoice("The Shawshank Redemption")
                .addChoice("The Godfather")
                .addChoice("The Dark Knight")
                .addChoice("Pulp Fiction")
                .addChoice("Forrest Gump")
                .addChoice("Inception")
                .addChoice("The Matrix")
                .enablePartialRanking(3)
                .setMedia("https://example.com/movies-header.jpg", "https://example.com/movies-logo.png");

            const result = await rankingElection.build();

            expect(result.metadata.media.header).toBe("https://example.com/movies-header.jpg");
            expect(result.metadata.media.logo).toBe("https://example.com/movies-logo.png");
            expect(result.metadata.questions[0].choices).toHaveLength(7);

            // Verify partial ranking configuration
            const rankingMeta = result.metadata.meta?.rankingElection as any;
            expect(rankingMeta.allowPartialRanking).toBe(true);
            expect(rankingMeta.minRankedChoices).toBe(3);
            expect(rankingMeta.maxRank).toBe(7);

            // Verify abstain values for partial ranking
            const multiChoiceProperties = result.metadata.type.properties as any;
            expect(multiChoiceProperties.canAbstain).toBe(true);
            expect(multiChoiceProperties.abstainValues).toEqual(["0"]);

        }, parseInt(process.env.TIMEOUT || "30000"));

        it("should handle validation errors during build", async () => {
            const rankingElection = new RankingElection(sdk, {
                title: "",  // Invalid: empty title
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            await expect(rankingElection.build()).rejects.toThrow("Election title is required");
        });

        it("should handle insufficient choices", async () => {
            const rankingElection = new RankingElection(sdk, {
                title: "Test Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            rankingElection.addChoice("Only One Choice");

            // Should require at least 2 choices for ranking
            await expect(rankingElection.build()).rejects.toThrow("Ranking elections must have at least 2 choices");
        });
    });

    describe("RankingElection Ballot Mode Generation", () => {
        it("should generate correct ballot mode parameters for full ranking", () => {
            const rankingElection = new RankingElection(sdk, {
                title: "Test Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            rankingElection
                .addChoice("Destination 1")
                .addChoice("Destination 2")
                .addChoice("Destination 3")
                .addChoice("Destination 4")
                .addChoice("Destination 5")
                .requireFullRanking();

            const ballotMode = (rankingElection as any).generateBallotMode();
            
            expect(ballotMode.maxCount).toBe(5);
            expect(ballotMode.maxValue).toBe("5");
            expect(ballotMode.minValue).toBe("1");
            expect(ballotMode.forceUniqueness).toBe(true);
            expect(ballotMode.costExponent).toBe(1);
            // Sum of 1+2+3+4+5 = 15
            expect(ballotMode.maxTotalCost).toBe("15");
            expect(ballotMode.minTotalCost).toBe("15");
        });

        it("should generate correct ballot mode parameters for partial ranking", () => {
            const rankingElection = new RankingElection(sdk, {
                title: "Test Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            rankingElection
                .addChoice("Option 1")
                .addChoice("Option 2")
                .addChoice("Option 3")
                .addChoice("Option 4")
                .addChoice("Option 5")
                .enablePartialRanking(3);

            const ballotMode = (rankingElection as any).generateBallotMode();
            
            expect(ballotMode.maxCount).toBe(5);
            expect(ballotMode.maxValue).toBe("5");
            expect(ballotMode.minValue).toBe("0"); // 0 allowed for unranked in partial
            expect(ballotMode.forceUniqueness).toBe(true);
            expect(ballotMode.costExponent).toBe(1);
            // Min sum: 1+2+3 = 6, Max sum: 1+2+3+4+5 = 15
            expect(ballotMode.minTotalCost).toBe("6");
            expect(ballotMode.maxTotalCost).toBe("15");
        });

        it("should handle minimum partial ranking of 0", () => {
            const rankingElection = new RankingElection(sdk, {
                title: "Test Election",
                duration: 3600,
                censusRoot: censusRoot,
                maxVotes: "100"
            });

            rankingElection
                .addChoice("Option 1")
                .addChoice("Option 2")
                .addChoice("Option 3")
                .enablePartialRanking(0); // Allow no rankings

            const ballotMode = (rankingElection as any).generateBallotMode();
            
            expect(ballotMode.minTotalCost).toBe("0");
            expect(ballotMode.maxTotalCost).toBe("6"); // 1+2+3 = 6
        });
    });
});
