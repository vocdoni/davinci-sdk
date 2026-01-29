import { expect } from "chai";
import { 
    BallotBuilder, 
    fromRTEtoTE, 
    fromTEtoRTE, 
    hexToDecimal,
    FIELD_MODULUS, 
    SCALING_FACTOR
} from "../src/builder.js";
import type { SequencerProcessData } from "../src/builder.js";
import * as snarkjs from "snarkjs";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper for modular arithmetic
function mod(n: bigint, m: bigint): bigint {
    return ((n % m) + m) % m;
}

describe("Sequencer Test Data Integration", function () {
    this.timeout(60000); // Increase timeout for circuit operations

    // Test data from the Sequencer (test_data.txt)
    // NOTE: pubKeyX and pubKeyY from Sequencer are in RTE format (Gnark BabyJubJub)
    const sequencerData = {
        processId: "a62e32147e9c1ea76da552be6e0636f1984143afafadd02a0000000000000010",
        address: "0xA62E32147e9c1EA76DA552Be6E0636F1984143AF",
        // These are in RTE format from Gnark
        pubKeyX_RTE: 19485953556403312941904393378091455968053684322142533232252221507246354347357n,
        pubKeyY_RTE: 16219479350243308044593790248520319281271283090548119799482663113896815349782n,
        ballotMode: {
            numFields: 2,
            uniqueValues: false,
            maxValue: "3",
            minValue: "0",
            maxValueSum: "6",
            minValueSum: "0",
            costExponent: 0,
            costFromWeight: false,
        },
        censusRoot: "0x1e19f7dcef65ae548cd50d4abc068acb71e6b71e4f70149ebf02a95f7c907440",
        stateRoot: "0x23068329c92c67b356254dccb053af973af7c7883f3886cbe812d9399a924563",
    };

    let builder: BallotBuilder;

    before(async () => {
        builder = await BallotBuilder.build();
    });

    it("should correctly convert RTE to TE coordinates", () => {
        // Convert the public key from RTE (Gnark) to TE (Circom/Iden3)
        const [pubKeyX_TE, pubKeyY_TE] = fromRTEtoTE(
            sequencerData.pubKeyX_RTE,
            sequencerData.pubKeyY_RTE
        );

        console.log("Public Key (RTE - Gnark):");
        console.log("  X:", sequencerData.pubKeyX_RTE.toString());
        console.log("  Y:", sequencerData.pubKeyY_RTE.toString());
        console.log("Public Key (TE - Circom/Iden3):");
        console.log("  X:", pubKeyX_TE.toString());
        console.log("  Y:", pubKeyY_TE.toString());

        // Verify round-trip conversion
        const [x_back, y_back] = fromTEtoRTE(pubKeyX_TE, pubKeyY_TE);
        expect(x_back).to.equal(sequencerData.pubKeyX_RTE);
        expect(y_back).to.equal(sequencerData.pubKeyY_RTE);
    });

    it("should generate valid ballot inputs with sequencer data", async () => {
        // Convert process ID from hex to bigint
        const processIdBigInt = BigInt("0x" + sequencerData.processId);
        const processIdStr = processIdBigInt.toString();

        // Convert address from hex to bigint
        const addressBigInt = BigInt(sequencerData.address);
        const addressStr = addressBigInt.toString();

        // Convert the public key from RTE to TE for use with circomlibjs
        const [pubKeyX_TE, pubKeyY_TE] = fromRTEtoTE(
            sequencerData.pubKeyX_RTE,
            sequencerData.pubKeyY_RTE
        );

        // Create the public key point in TE format for circomlibjs
        // circomlibjs uses field elements, so we need to convert
        const pubKey = [
            builder.elgamal.F.e(pubKeyX_TE),
            builder.elgamal.F.e(pubKeyY_TE)
        ];

        // Generate random k for encryption
        const k = builder.randomK();

        // Ballot configuration from sequencer data
        const config = {
            numFields: sequencerData.ballotMode.numFields,
            uniqueValues: sequencerData.ballotMode.uniqueValues ? 1 : 0,
            maxValue: parseInt(sequencerData.ballotMode.maxValue),
            minValue: parseInt(sequencerData.ballotMode.minValue),
            maxValueSum: parseInt(sequencerData.ballotMode.maxValueSum),
            minValueSum: parseInt(sequencerData.ballotMode.minValueSum),
            costExponent: sequencerData.ballotMode.costExponent,
            costFromWeight: sequencerData.ballotMode.costFromWeight ? 1 : 0,
        };

        // Sample vote values (must satisfy ballot mode constraints)
        // numFields=2, maxValue=3, minValue=0, maxValueSum=6, minValueSum=0
        const fields = [1, 2]; // Two fields with values 1 and 2 (sum = 3, within 0-6)

        console.log("\nGenerating ballot inputs with:");
        console.log("  Process ID:", processIdStr);
        console.log("  Address:", addressStr);
        console.log("  Fields:", fields);
        console.log("  Config:", config);
        console.log("  K:", k);

        const inputs = builder.generateInputs(
            fields,
            1, // weight
            pubKey,
            processIdStr,
            addressStr,
            k,
            config
        );

        console.log("\nGenerated inputs:");
        console.log("  Vote ID:", inputs.vote_id);
        console.log("  Inputs Hash:", inputs.inputs_hash);
        console.log("  Encryption PubKey:", inputs.encryption_pubkey);

        // Validate the structure
        expect(inputs.fields).to.have.lengthOf(8);
        expect(inputs.fields.slice(0, 2)).to.deep.equal(fields);
        expect(inputs.num_fields).to.equal(2);
        expect(inputs.cipherfields).to.have.lengthOf(8);
        expect(inputs.vote_id).to.be.a('string');
        expect(inputs.inputs_hash).to.be.a('string');
        expect(inputs.encryption_pubkey).to.have.lengthOf(2);

        // The encryption pubkey should match the TE converted values
        expect(inputs.encryption_pubkey[0]).to.equal(pubKeyX_TE.toString());
        expect(inputs.encryption_pubkey[1]).to.equal(pubKeyY_TE.toString());
    });

    it("should produce consistent vote ID calculation", async () => {
        const processIdBigInt = BigInt("0x" + sequencerData.processId);
        const addressBigInt = BigInt(sequencerData.address);

        // Use a fixed k for reproducibility
        const k = "12345678901234567890";

        const voteId = builder.computeVoteID(
            processIdBigInt.toString(),
            addressBigInt.toString(),
            k
        );

        console.log("\nVote ID computation:");
        console.log("  Process ID:", processIdBigInt.toString());
        console.log("  Address:", addressBigInt.toString());
        console.log("  K:", k);
        console.log("  Vote ID:", voteId);

        // Vote ID should be truncated to 160 bits (max value is 2^160 - 1)
        const maxVoteId = (1n << 160n) - 1n;
        expect(BigInt(voteId)).to.be.lessThanOrEqual(maxVoteId);

        // Running the same computation should produce the same result
        const voteId2 = builder.computeVoteID(
            processIdBigInt.toString(),
            addressBigInt.toString(),
            k
        );
        expect(voteId).to.equal(voteId2);
    });

    it("should generate JSON-compatible circuit inputs", async () => {
        const processIdBigInt = BigInt("0x" + sequencerData.processId);
        const addressBigInt = BigInt(sequencerData.address);

        const [pubKeyX_TE, pubKeyY_TE] = fromRTEtoTE(
            sequencerData.pubKeyX_RTE,
            sequencerData.pubKeyY_RTE
        );

        const pubKey = [
            builder.elgamal.F.e(pubKeyX_TE),
            builder.elgamal.F.e(pubKeyY_TE)
        ];

        const k = builder.randomK();

        const config = {
            numFields: 2,
            uniqueValues: 0,
            maxValue: 3,
            minValue: 0,
            maxValueSum: 6,
            minValueSum: 0,
            costExponent: 0,
            costFromWeight: 0,
        };

        const fields = [1, 2];

        const inputs = builder.generateInputs(
            fields,
            1,
            pubKey,
            processIdBigInt.toString(),
            addressBigInt.toString(),
            k,
            config
        );

        // Convert to the JSON format expected by snarkjs/circom
        const circuitInputs = {
            fields: inputs.fields,
            num_fields: inputs.num_fields,
            unique_values: inputs.unique_values,
            max_value: inputs.max_value,
            min_value: inputs.min_value,
            max_value_sum: inputs.max_value_sum,
            min_value_sum: inputs.min_value_sum,
            cost_exponent: inputs.cost_exponent,
            cost_from_weight: inputs.cost_from_weight,
            address: inputs.address,
            weight: inputs.weight,
            process_id: inputs.process_id,
            vote_id: inputs.vote_id,
            encryption_pubkey: inputs.encryption_pubkey,
            k: inputs.k,
            cipherfields: inputs.cipherfields,
            inputs_hash: inputs.inputs_hash,
        };

        console.log("\nCircuit inputs JSON:");
        console.log(JSON.stringify(circuitInputs, null, 2));

        // Verify it can be serialized/deserialized
        const json = JSON.stringify(circuitInputs);
        const parsed = JSON.parse(json);

        expect(parsed.fields).to.deep.equal(inputs.fields);
        expect(parsed.vote_id).to.equal(inputs.vote_id);
        expect(parsed.inputs_hash).to.equal(inputs.inputs_hash);
    });

    it("should generate a valid zkProof with snarkjs", async function() {
        this.timeout(120000); // Proof generation can take a while

        // Check if circuit artifacts exist (in the repository's artifacts/ directory)
        const artifactsDir = path.resolve(__dirname, "../../artifacts");
        const wasmPath = path.join(artifactsDir, "ballot_proof.wasm");
        const zkeyPath = path.join(artifactsDir, "ballot_proof_pkey.zkey");
        const vkeyPath = path.join(artifactsDir, "ballot_proof_vkey.json");

        if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath) || !fs.existsSync(vkeyPath)) {
            console.log("Skipping proof generation test: circuit artifacts not found");
            console.log("  Expected WASM:", wasmPath);
            console.log("  Expected zkey:", zkeyPath);
            console.log("  Expected vkey:", vkeyPath);
            this.skip();
            return;
        }

        const processIdBigInt = BigInt("0x" + sequencerData.processId);
        const addressBigInt = BigInt(sequencerData.address);

        const [pubKeyX_TE, pubKeyY_TE] = fromRTEtoTE(
            sequencerData.pubKeyX_RTE,
            sequencerData.pubKeyY_RTE
        );

        const pubKey = [
            builder.elgamal.F.e(pubKeyX_TE),
            builder.elgamal.F.e(pubKeyY_TE)
        ];

        const k = builder.randomK();

        const config = {
            numFields: 2,
            uniqueValues: 0,
            maxValue: 3,
            minValue: 0,
            maxValueSum: 6,
            minValueSum: 0,
            costExponent: 0,
            costFromWeight: 0,
        };

        const fields = [1, 2];

        const inputs = builder.generateInputs(
            fields,
            1,
            pubKey,
            processIdBigInt.toString(),
            addressBigInt.toString(),
            k,
            config
        );

        console.log("\nGenerating zkProof with snarkjs...");
        console.log("  Using WASM:", wasmPath);
        console.log("  Using zkey:", zkeyPath);

        // Generate the proof
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            inputs,
            wasmPath,
            zkeyPath
        );

        console.log("\nProof generated successfully!");
        console.log("  Public signals:", publicSignals);
        console.log("  Proof protocol:", proof.protocol);

        // Verify the proof
        const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
        const isValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);

        console.log("  Proof verification:", isValid ? "VALID" : "INVALID");

        expect(isValid).to.be.true;

        // Check that public signals match expected values
        // Public signals order from snarkjs: address, vote_id, inputs_hash
        expect(publicSignals[0]).to.equal(inputs.address);
        expect(publicSignals[1]).to.equal(inputs.vote_id);
        expect(publicSignals[2]).to.equal(inputs.inputs_hash);
    });

    it("should generate inputs using generateInputsFromSequencer helper", async function() {
        this.timeout(120000);

        // Check if circuit artifacts exist (in the repository's artifacts/ directory)
        const artifactsDir = path.resolve(__dirname, "../../artifacts");
        const wasmPath = path.join(artifactsDir, "ballot_proof.wasm");
        const zkeyPath = path.join(artifactsDir, "ballot_proof_pkey.zkey");
        const vkeyPath = path.join(artifactsDir, "ballot_proof_vkey.json");

        if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath) || !fs.existsSync(vkeyPath)) {
            console.log("Skipping test: circuit artifacts not found");
            this.skip();
            return;
        }

        // Define sequencer data in the exact format it would come from the API
        const sequencerProcessData: SequencerProcessData = {
            processId: "a62e32147e9c1ea76da552be6e0636f1984143afafadd02a0000000000000010",
            address: "0xA62E32147e9c1EA76DA552Be6E0636F1984143AF",
            pubKeyX: "19485953556403312941904393378091455968053684322142533232252221507246354347357",
            pubKeyY: "16219479350243308044593790248520319281271283090548119799482663113896815349782",
            ballotMode: {
                numFields: 2,
                uniqueValues: false,
                maxValue: "3",
                minValue: "0",
                maxValueSum: "6",
                minValueSum: "0",
                costExponent: 0,
                costFromWeight: false,
            },
        };

        // Vote values that satisfy the ballot mode constraints
        const fields = [1, 2];
        const weight = 1;

        // Generate inputs using the helper method
        const inputs = builder.generateInputsFromSequencer(
            sequencerProcessData,
            fields,
            weight
        );

        console.log("\nGenerated inputs from sequencer data:");
        console.log("  Process ID:", inputs.process_id);
        console.log("  Address:", inputs.address);
        console.log("  Vote ID:", inputs.vote_id);
        console.log("  Inputs Hash:", inputs.inputs_hash);

        // Generate and verify proof
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            inputs,
            wasmPath,
            zkeyPath
        );

        const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
        const isValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);

        console.log("  Proof verification:", isValid ? "VALID" : "INVALID");
        expect(isValid).to.be.true;

        // Verify public signals match
        expect(publicSignals[0]).to.equal(inputs.address);
        expect(publicSignals[1]).to.equal(inputs.vote_id);
        expect(publicSignals[2]).to.equal(inputs.inputs_hash);
    });

    it("should work with createPubKeyFromRTE helper", async function() {
        this.timeout(120000);

        // Check if circuit artifacts exist (in the repository's artifacts/ directory)
        const artifactsDir = path.resolve(__dirname, "../../artifacts");
        const wasmPath = path.join(artifactsDir, "ballot_proof.wasm");
        const zkeyPath = path.join(artifactsDir, "ballot_proof_pkey.zkey");
        const vkeyPath = path.join(artifactsDir, "ballot_proof_vkey.json");

        if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath) || !fs.existsSync(vkeyPath)) {
            this.skip();
            return;
        }

        // Use the RTE coordinates directly from sequencer
        const pubKey = builder.createPubKeyFromRTE(
            sequencerData.pubKeyX_RTE.toString(),
            sequencerData.pubKeyY_RTE.toString()
        );

        const processId = hexToDecimal(sequencerData.processId);
        const address = hexToDecimal(sequencerData.address);
        const k = builder.randomK();

        const config = {
            numFields: 2,
            uniqueValues: 0,
            maxValue: 3,
            minValue: 0,
            maxValueSum: 6,
            minValueSum: 0,
            costExponent: 0,
            costFromWeight: 0,
        };

        const inputs = builder.generateInputs(
            [1, 2],
            1,
            pubKey,
            processId,
            address,
            k,
            config
        );

        // Generate and verify proof
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            inputs,
            wasmPath,
            zkeyPath
        );

        const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
        const isValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);

        console.log("  createPubKeyFromRTE proof verification:", isValid ? "VALID" : "INVALID");
        expect(isValid).to.be.true;
    });
});

describe("RTE/TE Coordinate Conversion", function () {
    it("should satisfy the mathematical relationship", () => {
        // The conversion formula is:
        // TE.x = RTE.x / (-f)
        // TE.y = RTE.y
        //
        // And inverse:
        // RTE.x = TE.x * (-f)
        // RTE.y = TE.y

        const testX_RTE = 19485953556403312941904393378091455968053684322142533232252221507246354347357n;
        const testY_RTE = 16219479350243308044593790248520319281271283090548119799482663113896815349782n;

        const [x_TE, y_TE] = fromRTEtoTE(testX_RTE, testY_RTE);
        const [x_back, y_back] = fromTEtoRTE(x_TE, y_TE);

        expect(x_back).to.equal(testX_RTE);
        expect(y_back).to.equal(testY_RTE);

        // Verify the mathematical relationship manually
        const negF = mod(-SCALING_FACTOR, FIELD_MODULUS);
        const expectedX_RTE = mod(x_TE * negF, FIELD_MODULUS);
        expect(expectedX_RTE).to.equal(testX_RTE);
    });

    it("should handle edge cases", () => {
        // Test with zero
        const [x0, y0] = fromRTEtoTE(0n, 0n);
        expect(x0).to.equal(0n);
        expect(y0).to.equal(0n);

        // Test with 1
        const [x1, y1] = fromRTEtoTE(1n, 1n);
        const [xBack, yBack] = fromTEtoRTE(x1, y1);
        expect(xBack).to.equal(1n);
        expect(yBack).to.equal(1n);
    });
});
