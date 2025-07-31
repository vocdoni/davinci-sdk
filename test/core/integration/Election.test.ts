import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });

import { DavinciSDK, DavinciSDKConfig } from "../../../src/core/DavinciSDK";
import { BasicElection, MultiChoiceElection, ElectionBuilder } from "../../../src/core";
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

describe("Core Election Integration Tests", () => {
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

    describe("ElectionBuilder", () => {
        it("should create an ElectionBuilder instance", () => {
            const builder = sdk.createElection();
            expect(builder).toBeInstanceOf(ElectionBuilder);
        });

        it("should configure election parameters using fluent API", () => {
            const builder = sdk.createElection()
                .title("Test Election")
                .description("This is a test election")
                .duration(3600) // 1 hour
                .censusRoot(censusRoot)
                .maxVotes("100")
                .media("https://example.com/header.jpg", "https://example.com/logo.png");

            const config = builder.getConfig();
            expect(config.title).toBe("Test Election");
            expect(config.description).toBe("This is a test election");
            expect(config.duration).toBe(3600);
            expect(config.censusRoot).toBe(censusRoot);
            expect(config.maxVotes).toBe("100");
            expect(config.media?.header).toBe("https://example.com/header.jpg");
            expect(config.media?.logo).toBe("https://example.com/logo.png");
        });

        it("should throw error when required fields are missing", () => {
            const builder = sdk.createElection();
            
            expect(() => builder.singleChoice()).toThrow("Election title is required");
            
            builder.title("Test");
            expect(() => builder.singleChoice()).toThrow("Election duration is required");
            
            builder.duration(3600);
            expect(() => builder.singleChoice()).toThrow("Census root is required");
            
            builder.censusRoot(censusRoot);
            expect(() => builder.singleChoice()).toThrow("Max votes is required");
        });
    });

    describe("BasicElection", () => {
        let basicElection: BasicElection;

        beforeEach(() => {
            basicElection = sdk.createElection()
                .title("Basic Test Election")
                .description("A basic single choice election")
                .duration(3600)
                .censusRoot(censusRoot)
                .maxVotes("100")
                .singleChoice();
        });

        it("should create a BasicElection instance", () => {
            expect(basicElection).toBeInstanceOf(BasicElection);
        });

        it("should add choices to the election", () => {
            basicElection
                .addChoice("Option A")
                .addChoice("Option B")
                .addChoice("Option C");

            const choices = basicElection.getChoices();
            expect(choices).toHaveLength(3);
            expect(choices[0].title).toBe("Option A");
            expect(choices[0].value).toBe(0);
            expect(choices[1].title).toBe("Option B");
            expect(choices[1].value).toBe(1);
            expect(choices[2].title).toBe("Option C");
            expect(choices[2].value).toBe(2);
        });

        it("should validate votes correctly", () => {
            basicElection.addChoice("Yes").addChoice("No");

            // Valid vote
            const validResult = basicElection.validateVote([0]);
            expect(validResult.valid).toBe(true);
            expect(validResult.errors).toHaveLength(0);

            // Invalid: multiple votes
            const multipleVotesResult = basicElection.validateVote([0, 1]);
            expect(multipleVotesResult.valid).toBe(false);
            expect(multipleVotesResult.errors).toContain("Basic elections require exactly one choice");

            // Invalid: out of range
            const outOfRangeResult = basicElection.validateVote([5]);
            expect(outOfRangeResult.valid).toBe(false);
            expect(outOfRangeResult.errors).toContain("Vote value must be between 0 and 1");
        });

        it("should create a yes/no election", () => {
            const yesNoElection = sdk.createElection()
                .title("Yes/No Election")
                .duration(3600)
                .censusRoot(censusRoot)
                .maxVotes("100")
                .yesNo();

            expect(yesNoElection).toBeInstanceOf(BasicElection);
            expect(yesNoElection.isYesNoElection()).toBe(true);

            const choices = yesNoElection.getChoices();
            expect(choices).toHaveLength(2);
            expect(choices[0].title).toBe("Yes");
            expect(choices[1].title).toBe("No");
        });

        it("should prevent adding choices to yes/no election", () => {
            const yesNoElection = sdk.createElection()
                .title("Yes/No Election")
                .duration(3600)
                .censusRoot(censusRoot)
                .maxVotes("100")
                .yesNo();

            expect(() => yesNoElection.addChoice("Maybe")).toThrow(
                "Cannot add choices to a yes/no election. Use asYesNo() or create a regular single choice election."
            );
        });

        it("should build and create an election", async () => {
            basicElection
                .addChoice("Option A")
                .addChoice("Option B");

            const result = await basicElection.build();

            expect(result).toHaveProperty("processId");
            expect(result).toHaveProperty("transactionHash");
            expect(result).toHaveProperty("encryptionPubKey");
            expect(result).toHaveProperty("stateRoot");
            expect(result).toHaveProperty("metadataHash");
            expect(result).toHaveProperty("metadata");

            expect(isValidHex(result.processId, 64)).toBe(true);
            expect(isValidHex(result.transactionHash, 64)).toBe(true);
            expect(Array.isArray(result.encryptionPubKey)).toBe(true);
            expect(result.encryptionPubKey).toHaveLength(2);
            expect(isValidHex(result.stateRoot, 64)).toBe(true);
            expect(isValidHex(result.metadataHash, 64)).toBe(true);

            // Check metadata
            expect(result.metadata.title.default).toBe("Basic Test Election");
            expect(result.metadata.description.default).toBe("A basic single choice election");
            expect(result.metadata.questions).toHaveLength(1);
            expect(result.metadata.questions[0].choices).toHaveLength(2);
        }, parseInt(process.env.TIMEOUT || "30000"));
    });

    describe("MultiChoiceElection", () => {
        let multiChoiceElection: MultiChoiceElection;

        beforeEach(() => {
            multiChoiceElection = sdk.createElection()
                .title("Multi Choice Test Election")
                .description("A multiple choice election")
                .duration(3600)
                .censusRoot(censusRoot)
                .maxVotes("100")
                .multipleChoice();
        });

        it("should create a MultiChoiceElection instance", () => {
            expect(multiChoiceElection).toBeInstanceOf(MultiChoiceElection);
        });

        it("should configure selection limits", () => {
            multiChoiceElection
                .allowMultipleSelections(3)
                .requireMinimumSelections(1);

            const limits = multiChoiceElection.getSelectionLimits();
            expect(limits.min).toBe(1);
            expect(limits.max).toBe(3);
        });

        it("should allow abstention", () => {
            multiChoiceElection.allowAbstention();
            expect(multiChoiceElection.isAbstentionAllowed()).toBe(true);

            const limits = multiChoiceElection.getSelectionLimits();
            expect(limits.min).toBe(0); // Should be set to 0 when abstention is allowed
        });

        it("should allow repeat choices", () => {
            multiChoiceElection.allowRepeatChoices();
            expect(multiChoiceElection.areRepeatChoicesAllowed()).toBe(true);
        });

        it("should validate votes correctly", () => {
            multiChoiceElection
                .addChoice("Option A")
                .addChoice("Option B")
                .addChoice("Option C")
                .allowMultipleSelections(2)
                .requireMinimumSelections(1);

            // Valid vote
            const validResult = multiChoiceElection.validateVote([0, 1]);
            expect(validResult.valid).toBe(true);
            expect(validResult.errors).toHaveLength(0);

            // Invalid: too many selections
            const tooManyResult = multiChoiceElection.validateVote([0, 1, 2]);
            expect(tooManyResult.valid).toBe(false);
            expect(tooManyResult.errors).toContain("Cannot select more than 2 choice(s)");

            // Invalid: too few selections
            const tooFewResult = multiChoiceElection.validateVote([]);
            expect(tooFewResult.valid).toBe(false);
            expect(tooFewResult.errors).toContain("Must select at least 1 choice(s)");
        });

        it("should validate repeat choices when not allowed", () => {
            multiChoiceElection
                .addChoice("Option A")
                .addChoice("Option B")
                .allowMultipleSelections(3);

            // Invalid: repeat choices when not allowed
            const repeatResult = multiChoiceElection.validateVote([0, 0, 1]);
            expect(repeatResult.valid).toBe(false);
            expect(repeatResult.errors).toContain("Cannot select the same choice multiple times");
        });

        it("should allow repeat choices when configured", () => {
            multiChoiceElection
                .addChoice("Option A")
                .addChoice("Option B")
                .allowMultipleSelections(3)
                .allowRepeatChoices();

            // Valid: repeat choices when allowed
            const repeatResult = multiChoiceElection.validateVote([0, 0, 1]);
            expect(repeatResult.valid).toBe(true);
            expect(repeatResult.errors).toHaveLength(0);
        });

        it("should build and create a multi-choice election", async () => {
            multiChoiceElection
                .addChoice("Option A")
                .addChoice("Option B")
                .addChoice("Option C")
                .allowMultipleSelections(2);

            const result = await multiChoiceElection.build();

            expect(result).toHaveProperty("processId");
            expect(result).toHaveProperty("transactionHash");
            expect(result).toHaveProperty("encryptionPubKey");
            expect(result).toHaveProperty("stateRoot");
            expect(result).toHaveProperty("metadataHash");
            expect(result).toHaveProperty("metadata");

            expect(isValidHex(result.processId, 64)).toBe(true);
            expect(isValidHex(result.transactionHash, 64)).toBe(true);
            expect(Array.isArray(result.encryptionPubKey)).toBe(true);
            expect(result.encryptionPubKey).toHaveLength(2);
            expect(isValidHex(result.stateRoot, 64)).toBe(true);
            expect(isValidHex(result.metadataHash, 64)).toBe(true);

            // Check metadata
            expect(result.metadata.title.default).toBe("Multi Choice Test Election");
            expect(result.metadata.description.default).toBe("A multiple choice election");
            expect(result.metadata.questions).toHaveLength(1);
            expect(result.metadata.questions[0].choices).toHaveLength(3);
            expect(result.metadata.type.name).toBe("multiple-choice");
        }, parseInt(process.env.TIMEOUT || "30000"));
    });

    describe("Election Validation", () => {
        it("should validate election configuration", () => {
            const builder = sdk.createElection()
                .title("Test Election")
                .duration(3600)
                .censusRoot(censusRoot)
                .maxVotes("100");

            const election = builder.singleChoice();

            // Should throw error when no choices are added
            expect(async () => await election.build()).rejects.toThrow("At least one choice is required");
        });

        it("should validate minimum choices for single choice elections", () => {
            const election = sdk.createElection()
                .title("Test Election")
                .duration(3600)
                .censusRoot(censusRoot)
                .maxVotes("100")
                .singleChoice()
                .addChoice("Only One Option");

            // Should throw error when less than 2 choices for single choice
            expect(async () => await election.build()).rejects.toThrow("Single choice elections must have at least 2 choices");
        });

        it("should validate minimum choices for multiple choice elections", () => {
            const election = sdk.createElection()
                .title("Test Election")
                .duration(3600)
                .censusRoot(censusRoot)
                .maxVotes("100")
                .multipleChoice()
                .addChoice("Only One Option");

            // Should throw error when less than 2 choices for multiple choice
            expect(async () => await election.build()).rejects.toThrow("Multiple choice elections must have at least 2 choices");
        });

        it("should validate selection limits", () => {
            expect(() => {
                sdk.createElection()
                    .title("Test Election")
                    .duration(3600)
                    .censusRoot(censusRoot)
                    .maxVotes("100")
                    .multipleChoice()
                    .requireMinimumSelections(3)
                    .allowMultipleSelections(2); // min > max
            }).toThrow("Minimum selections cannot be greater than maximum selections");
        });
    });
});
