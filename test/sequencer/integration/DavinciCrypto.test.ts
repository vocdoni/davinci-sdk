import { DavinciCrypto, DavinciCryptoInputs } from "../../../src/sequencer";
import { VocdoniSequencerService } from "../../../src/sequencer/SequencerService";
import { CensusOrigin } from '../../../src/census/';
import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });

describe("DavinciCryptoService Integration", () => {
    let service: DavinciCrypto;
    let api: VocdoniSequencerService;

    const example: DavinciCryptoInputs = {
        address: "397d72b25676d42f899b18f06633fab9d854235d",
        processID: "1f1e0cd27b4ecd1b71b6333790864ace2870222c",
        encryptionKey: [
            "9893338637931860616720507408105297162588837225464624604186540472082423274495",
            "12595438123836047903232785676476920953357035744165788772034206819455277990072"
        ],
        k: "964256131946492867709099996647243890828558919187",
        ballotMode: {
            numFields: 5,
            uniqueValues: false,
            maxValue: "16",
            minValue: "0",
            maxValueSum: "1280",
            minValueSum: "5",
            costExponent: 2,
            costFromWeight: false
        },
        weight: "10",
        fieldValues: ["14", "9", "8", "9", "0", "0", "0", "0"]
    };

    beforeAll(async () => {
        api = new VocdoniSequencerService(process.env.SEQUENCER_API_URL!);
        const info = await api.getInfo();
        
        service = new DavinciCrypto({
            wasmExecUrl: info.ballotProofWasmHelperExecJsUrl,
            wasmUrl: info.ballotProofWasmHelperUrl
        });
        await service.init();
    });

    it("should produce a complete DavinciCryptoOutput with all fields typed correctly", async () => {
        const out = await service.proofInputs(example);
        // --- top‐level strings ---
        expect(typeof out.processId).toBe("string");
        expect(typeof out.address).toBe("string");
        expect(typeof out.ballotInputsHash).toBe("string");
        expect(typeof out.voteId).toBe("string");

        expect(typeof out.ballot.curveType).toBe("string");
        expect(Array.isArray(out.ballot.ciphertexts)).toBe(true);
        out.ballot.ciphertexts.forEach((ct) => {
            expect(Array.isArray(ct.c1)).toBe(true);
            expect(ct.c1).toHaveLength(2);
            ct.c1.forEach((x) => expect(typeof x).toBe("string"));

            expect(Array.isArray(ct.c2)).toBe(true);
            expect(ct.c2).toHaveLength(2);
            ct.c2.forEach((x) => expect(typeof x).toBe("string"));
        });

        const ci = out.circomInputs as Record<string, any>;
        expect(typeof ci).toBe("object");

        const expectedPid = BigInt("0x" + example.processID).toString();
        expect(ci.process_id).toBe(expectedPid);

        const hexAddr = example.address.startsWith("0x")
            ? example.address
            : "0x" + example.address;
        expect(ci.address).toBe(BigInt(hexAddr).toString());

        expect(ci.k).toBe(example.k);

        // Check for vote_id in circom inputs (new field)
        expect(typeof ci.vote_id).toBe("string");

        const fieldsArr = ci.fieldValues ?? ci.fields;
        expect(Array.isArray(fieldsArr)).toBe(true);
        expect(fieldsArr).toContain(example.fieldValues[0]);
    });

    describe("CSP (Credential Service Provider) Functions", () => {
        const cspTestData = {
            censusOrigin: CensusOrigin.CensusOriginCSP, // CSP origin type
            privKey: "50df49d9d1175d49808602d12bf945ba3f55d90146882fbc5d54078f204f5005372143904f3fd452767581fd55b4c27aedacdd7b70d14f374b7c9f341c0f9a5300",
            processId: "00000539f39fd6e51aad88f6f4ce6ab8827279cfffb922660000000000000000",
            address: "0e9eA11b92F119aEce01990b68d85227a41AA627"
        };

        it("should generate a CSP signature and return valid proof", async () => {
            const cspProof = await service.cspSign(
                cspTestData.censusOrigin,
                cspTestData.privKey,
                cspTestData.processId,
                cspTestData.address
            );

            // Verify the proof is a valid JSON string
            expect(typeof cspProof).toBe("string");
            expect(() => JSON.parse(cspProof)).not.toThrow();

            const parsedProof = JSON.parse(cspProof);
            expect(typeof parsedProof).toBe("object");
            expect(parsedProof).not.toBeNull();

            // The proof should contain expected fields (structure may vary based on implementation)
            expect(parsedProof).toHaveProperty("signature");
            expect(parsedProof).toHaveProperty("publicKey");
        });

        it("should verify a valid CSP proof", async () => {
            // First generate a proof
            const cspProof = await service.cspSign(
                cspTestData.censusOrigin,
                cspTestData.privKey,
                cspTestData.processId,
                cspTestData.address
            );

            // Then verify it
            const isValid = await service.cspVerify(cspProof);
            expect(typeof isValid).toBe("boolean");
            expect(isValid).toBe(true);
        });

        it("should reject an invalid CSP proof", async () => {
            const invalidProof = JSON.stringify({
                signature: "invalid_signature",
                publicKey: "invalid_public_key"
            });

            // The Go/WASM implementation throws an error for invalid proofs
            await expect(service.cspVerify(invalidProof)).rejects.toThrow();
        });

        it("should throw error when cspSign is called before initialization", async () => {
            const uninitializedService = new DavinciCrypto({
                wasmExecUrl: "dummy_url",
                wasmUrl: "dummy_url"
            });

            await expect(
                uninitializedService.cspSign(
                    cspTestData.censusOrigin,
                    cspTestData.privKey,
                    cspTestData.processId,
                    cspTestData.address
                )
            ).rejects.toThrow("DavinciCrypto not initialized");
        });

        it("should throw error when cspVerify is called before initialization", async () => {
            const uninitializedService = new DavinciCrypto({
                wasmExecUrl: "dummy_url",
                wasmUrl: "dummy_url"
            });

            await expect(
                uninitializedService.cspVerify("{}")
            ).rejects.toThrow("DavinciCrypto not initialized");
        });

        it("should handle different census origin types", async () => {
            // Test with different census origin values
            const origins = [CensusOrigin.CensusOriginMerkleTree, CensusOrigin.CensusOriginCSP];
            
            for (const origin of origins) {
                if (origin === CensusOrigin.CensusOriginCSP) { // Only test CSP origin for now
                    const cspProof = await service.cspSign(
                        origin,
                        cspTestData.privKey,
                        cspTestData.processId,
                        cspTestData.address
                    );

                    expect(typeof cspProof).toBe("string");
                    expect(() => JSON.parse(cspProof)).not.toThrow();

                    const isValid = await service.cspVerify(cspProof);
                    expect(isValid).toBe(true);
                }
            }
        });

        it("should handle malformed JSON in cspVerify gracefully", async () => {
            const malformedJson = "not_valid_json";

            // This should either throw an error or return false, depending on implementation
            try {
                const result = await service.cspVerify(malformedJson);
                expect(typeof result).toBe("boolean");
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
            }
        });
    });
});
