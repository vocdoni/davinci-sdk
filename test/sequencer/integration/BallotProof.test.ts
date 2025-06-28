import { BallotProof, BallotProofInputs } from "../../../src/sequencer";
import { VocdoniApiService } from "../../../src/sequencer/api";
import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });

describe("BallotProofService Integration", () => {
    let service: BallotProof;
    let api: VocdoniApiService;

    const example: BallotProofInputs = {
        address: "40aA6F90Dd3731eD10d6aA544200ACC647144669",
        processID: "00aa36a7a62e32147e9c1ea76da552be6e0636f1984143af0000000000000073",
        encryptionKey: [
            '16985072905689916868240833730094117015196415915747588732795365373862001032972',
            '9426525542650791158046003409934506209718927941267507663165051158916505773203'
        ],
        k: "964256131946492867709099996647243890828558919187",
        ballotMode: {
            maxCount: 1,
            maxValue: "10",
            minValue: "0",
            forceUniqueness: false,
            costFromWeight: false,
            costExponent: 0,
            maxTotalCost: "10",
            minTotalCost: "0"
        },
        weight: "60",
        fieldValues: ["1"]
    };

    beforeAll(async () => {
        api = new VocdoniApiService(process.env.API_URL!);
        const info = await api.getInfo();
        
        service = new BallotProof({
            wasmExecUrl: info.ballotProofWasmHelperExecJsUrl,
            wasmUrl: info.ballotProofWasmHelperUrl
        });
        await service.init();
    });

    it("should produce a complete BallotOutput with all fields typed correctly", async () => {
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
});
