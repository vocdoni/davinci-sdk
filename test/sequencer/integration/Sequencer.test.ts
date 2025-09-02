import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });
import { VocdoniSequencerService } from "../../../src/sequencer/SequencerService";
import { VocdoniCensusService, CensusOrigin } from "../../../src/census";
import { createProcessSignatureMessage, signProcessCreation } from "../../../src/sequencer/api";
import { mockProvider, mockWallet, generateMockCensusParticipants, generateMockProcessRequest, isValidUUID, isValidHex } from "./utils";
import { getElectionMetadataTemplate } from "../../../src/core/types";

const sequencerService = new VocdoniSequencerService(process.env.SEQUENCER_API_URL!);
const censusService = new VocdoniCensusService(process.env.CENSUS_API_URL!);
let censusId: string;

// Generate test participants
const testParticipants = generateMockCensusParticipants(5);

describe("VocdoniSequencerService Integration", () => {
    beforeAll(async () => {
        // Create a census for testing process creation
        censusId = await censusService.createCensus();
        await censusService.addParticipants(censusId, testParticipants);
    });

    afterAll(async () => {
        // Clean up the census
        await censusService.deleteCensus(censusId);
    });

    it("should ping the API", async () => {
        await expect(sequencerService.ping()).resolves.toBeUndefined();
    });

    it("should fetch info and return valid URLs and hex hashes", async () => {
        const info = await sequencerService.getInfo();

        const urlRx = /^https?:\/\/[^\s]+$/i;
        const hexRx = /^(?:0x)?[0-9a-fA-F]{64}$/;
        const addrRx = /^0x[0-9a-fA-F]{40}$/i;

        // URL fields
        expect(urlRx.test(info.circuitUrl)).toBe(true);
        expect(urlRx.test(info.provingKeyUrl)).toBe(true);
        expect(urlRx.test(info.verificationKeyUrl)).toBe(true);
        expect(urlRx.test(info.ballotProofWasmHelperUrl)).toBe(true);
        expect(urlRx.test(info.ballotProofWasmHelperExecJsUrl)).toBe(true);

        // hash fields
        expect(hexRx.test(info.circuitHash)).toBe(true);
        expect(hexRx.test(info.provingKeyHash)).toBe(true);
        expect(hexRx.test(info.verificationKeyHash)).toBe(true);
        expect(hexRx.test(info.ballotProofWasmHelperHash)).toBe(true);
        expect(hexRx.test(info.ballotProofWasmHelperExecJsHash)).toBe(true);

        // contract addresses
        expect(addrRx.test(info.contracts.process)).toBe(true);
        expect(addrRx.test(info.contracts.organization)).toBe(true);
        expect(addrRx.test(info.contracts.stateTransitionVerifier)).toBe(true);
        expect(addrRx.test(info.contracts.resultsVerifier)).toBe(true);

        // network property
        expect(info).toHaveProperty('network');
        expect(typeof info.network).toBe('object');
        // Check that network values are numbers
        Object.values(info.network).forEach(value => {
            expect(typeof value).toBe('number');
        });
    });

    it("should list all processes", async () => {
        const processes = await sequencerService.listProcesses();
        expect(Array.isArray(processes)).toBe(true);
        // Each process ID should be a valid hex string
        processes.forEach((processId: string) => {
            expect(isValidHex(processId, 64)).toBe(true);
        });
    });

    it("should check if an address has voted", async () => {
        const processes = await sequencerService.listProcesses();
        if (processes.length === 0) {
            console.log('Skipping test: no processes available');
            return;
        }

        // First check with a random address that hasn't voted
        const randomAddress = mockWallet.address;
        const hasVoted = await sequencerService.hasAddressVoted(processes[0], randomAddress);
        expect(hasVoted).toBe(false);
    });

    it("should get process details with sequencer stats", async () => {
        const processes = await sequencerService.listProcesses();
        if (processes.length === 0) {
            console.log('Skipping test: no processes available');
            return;
        }

        const process = await sequencerService.getProcess(processes[0]);
        expect(typeof process.voteCount).toBe('string');
        expect(typeof process.voteOverwrittenCount).toBe('string');
        expect(typeof process.isAcceptingVotes).toBe('boolean');
        expect(process).toHaveProperty('sequencerStats');
        const { sequencerStats } = process;
        expect(typeof sequencerStats.stateTransitionCount).toBe('number');
        expect(typeof sequencerStats.lastStateTransitionDate).toBe('string');
        expect(typeof sequencerStats.settledStateTransitionCount).toBe('number');
        expect(typeof sequencerStats.aggregatedVotesCount).toBe('number');
        expect(typeof sequencerStats.verifiedVotesCount).toBe('number');
        expect(typeof sequencerStats.pendingVotesCount).toBe('number');
        expect(typeof sequencerStats.currentBatchSize).toBe('number');
        expect(typeof sequencerStats.lastBatchSize).toBe('number');
    });

    it("should create a process and validate the response", async () => {
        const censusRoot = await censusService.getCensusRoot(censusId);
        
        // Mock process ID (32 bytes hex)
        const processId = "0x00aa36a7000000000000000000000000000000000000dead0000000000000000";
        
        const payload = generateMockProcessRequest(processId, censusRoot);
        
        // Use the new signature format
        const signature = await signProcessCreation(processId, mockWallet);

        const fullPayload = { ...payload, signature };
        const response = await sequencerService.createProcess(fullPayload);

        expect(isValidHex(response.processId, 64)).toBe(true);
        expect(response.processId).toBe(processId);
        expect(Array.isArray(response.encryptionPubKey)).toBe(true);
        expect(response.encryptionPubKey.length).toBe(2);
        expect(isValidHex(response.stateRoot, 64)).toBe(true);
        expect(response.ballotMode).toEqual(payload.ballotMode);
    });

    describe("Metadata operations", () => {
        let metadataHash: string;
        const testMetadata = getElectionMetadataTemplate();
        testMetadata.title.default = "Test Election";
        testMetadata.description.default = "This is a test election";

        it("should push metadata and return a valid hex hash", async () => {
            const hash = await sequencerService.pushMetadata(testMetadata);
            expect(isValidHex(hash, 64)).toBe(true);
            metadataHash = hash;
        });

        it("should retrieve metadata using the hash", async () => {
            const metadata = await sequencerService.getMetadata(metadataHash);
            expect(metadata).toEqual(testMetadata);
        });

        it("should throw error for invalid hash format", () => {
            expect(() => sequencerService.getMetadata("invalid-hash"))
                .toThrow("Invalid metadata hash format");
        });
    });

    describe("Helper functions", () => {
        it("should create correct signature message", () => {
            const processId = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            const expectedMessage = "I am creating a new voting process for the davinci.vote protocol identified with id 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            
            const message = createProcessSignatureMessage(processId);
            expect(message).toBe(expectedMessage);
        });

        it("should handle processId without 0x prefix", () => {
            const processId = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            const expectedMessage = "I am creating a new voting process for the davinci.vote protocol identified with id 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            
            const message = createProcessSignatureMessage(processId);
            expect(message).toBe(expectedMessage);
        });

        it("should sign process creation message", async () => {
            const processId = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            const signature = await signProcessCreation(processId, mockWallet);
            
            expect(typeof signature).toBe('string');
            expect(signature.startsWith('0x')).toBe(true);
            expect(signature.length).toBeGreaterThan(100); // Signatures are typically 132 characters
        });
    });

    describe("Sequencer statistics", () => {
        it("should get sequencer stats", async () => {
            const stats = await sequencerService.getStats();
            
            expect(typeof stats.activeProcesses).toBe('number');
            expect(typeof stats.pendingVotes).toBe('number');
            expect(typeof stats.verifiedVotes).toBe('number');
            expect(typeof stats.aggregatedVotes).toBe('number');
            expect(typeof stats.stateTransitions).toBe('number');
            expect(typeof stats.settledStateTransitions).toBe('number');
            expect(typeof stats.lastStateTransitionDate).toBe('string');
            
            // Validate date format
            expect(new Date(stats.lastStateTransitionDate).toString()).not.toBe('Invalid Date');
        });

        it("should get workers stats", async () => {
            const response = await sequencerService.getWorkers();
            
            expect(Array.isArray(response.workers)).toBe(true);
            
            // Check each worker's structure
            response.workers.forEach((worker: any) => {
                expect(typeof worker.address).toBe('string');
                expect(typeof worker.successCount).toBe('number');
                expect(typeof worker.failedCount).toBe('number');
            });
        });
    });
});
