import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../../.env') });
import { VocdoniApiService } from "../../../../src/sequencer/api";
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

    it("should create a process and validate the response", async () => {
        const nonce = await mockProvider.getTransactionCount(mockWallet.address, "latest") + 1;
        const censusRoot = await api.getCensusRoot(censusId);
        const payload = generateMockProcessRequest(censusRoot);
        
        const message = `${payload.chainId}${nonce}`;
        const signature = await mockWallet.signMessage(message);

        const fullPayload = { ...payload, signature };
        const response = await api.createProcess(fullPayload);

        expect(isValidHex(response.processId, 64)).toBe(true);
        expect(Array.isArray(response.encryptionPubKey)).toBe(true);
        expect(response.encryptionPubKey.length).toBe(2);
        expect(isValidHex(response.stateRoot, 64)).toBe(true);
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
});
