import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../../.env') });
import { VocdoniApiService, createProcessSignatureMessage, signProcessCreation } from "../../../../src/sequencer/api";
import { mockProvider, mockWallet, generateMockCensusParticipants, generateMockProcessRequest, isValidUUID, isValidHex } from "../utils";
import { getElectionMetadataTemplate } from "../../../../src/core/types";

const api = new VocdoniApiService(process.env.API_URL!);
let censusId: string;

// Generate test participants
const testParticipants = generateMockCensusParticipants(5);

describe("VocdoniApiService Integration", () => {
    it("should ping the API", async () => {
        await expect(api.ping()).resolves.toBeUndefined();
    });

    it("should fetch info and return valid URLs and hex hashes", async () => {
        const info = await api.getInfo();

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

    it("should create a new census and return a valid UUID", async () => {
        censusId = await api.createCensus();
        expect(typeof censusId).toBe("string");
        expect(isValidUUID(censusId)).toBe(true);
    });

    it("should add participants to the census", async () => {
        await expect(api.addParticipants(censusId, testParticipants)).resolves.toBeUndefined();
    });

    it("should retrieve the census participants", async () => {
        const participants = await api.getParticipants(censusId);

        expect(Array.isArray(participants)).toBe(true);
        expect(participants.length).toBe(testParticipants.length);

        // Create a lookup map from the response
        const responseMap = new Map(
            participants.map(p => [p.key.toLowerCase(), p.weight])
        );

        // Assert each expected participant exists with the correct weight
        for (const expected of testParticipants) {
            const actualWeight = responseMap.get(expected.key.toLowerCase());
            expect(actualWeight).toBeDefined();
            expect(actualWeight).toBe(expected.weight);
        }
    });

    it("should fetch the census root", async () => {
        const root = await api.getCensusRoot(censusId);
        expect(typeof root).toBe("string");
        expect(isValidHex(root, 64)).toBe(true);
    });

    it("should fetch the census size", async () => {
        const size = await api.getCensusSize(censusId);
        expect(typeof size).toBe("number");
        expect(size).toBe(testParticipants.length);
    });

    it("should fetch a Merkle proof for a participant", async () => {
        const root = await api.getCensusRoot(censusId);
        const proof = await api.getCensusProof(root, testParticipants[0].key);
        expect(proof).toHaveProperty("root");
        expect(proof).toHaveProperty("key");
        expect(proof).toHaveProperty("siblings");
        expect(proof).toHaveProperty("weight");
    });

    it("should list all processes", async () => {
        const processes = await api.listProcesses();
        expect(Array.isArray(processes)).toBe(true);
        // Each process ID should be a valid hex string
        processes.forEach(processId => {
            expect(isValidHex(processId, 64)).toBe(true);
        });
    });

    it("should check if an address has voted", async () => {
        const processes = await api.listProcesses();
        if (processes.length === 0) {
            console.log('Skipping test: no processes available');
            return;
        }

        // First check with a random address that hasn't voted
        const randomAddress = mockWallet.address;
        const hasVoted = await api.hasAddressVoted(processes[0], randomAddress);
        expect(hasVoted).toBe(false);
    });


    it("should get process details with sequencer stats", async () => {
        const processes = await api.listProcesses();
        if (processes.length === 0) {
            console.log('Skipping test: no processes available');
            return;
        }

        const process = await api.getProcess(processes[0]);
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
        const censusRoot = await api.getCensusRoot(censusId);
        
        // Mock process ID (32 bytes hex)
        const processId = "0x00aa36a7000000000000000000000000000000000000dead0000000000000000";
        
        const payload = generateMockProcessRequest(processId, censusRoot);
        
        // Use the new signature format
        const signature = await signProcessCreation(processId, mockWallet);

        const fullPayload = { ...payload, signature };
        const response = await api.createProcess(fullPayload);

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
            const hash = await api.pushMetadata(testMetadata);
            expect(isValidHex(hash, 64)).toBe(true);
            metadataHash = hash;
        });

        it("should retrieve metadata using the hash", async () => {
            const metadata = await api.getMetadata(metadataHash);
            expect(metadata).toEqual(testMetadata);
        });

        it("should throw error for invalid hash format", () => {
            expect(() => api.getMetadata("invalid-hash"))
                .toThrow("Invalid metadata hash format");
        });
    });

    it("should delete the census", async () => {
        await expect(api.deleteCensus(censusId)).resolves.toBeUndefined();
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
            const stats = await api.getStats();
            
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
            const response = await api.getWorkers();
            
            expect(Array.isArray(response.workers)).toBe(true);
            
            // Check each worker's structure
            response.workers.forEach(worker => {
                expect(typeof worker.address).toBe('string');
                expect(typeof worker.successCount).toBe('number');
                expect(typeof worker.failedCount).toBe('number');
            });
        });
    });
});
