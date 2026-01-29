import { expect } from "chai";
import { buildElGamal } from "../src/elgamal.js";
import { buildPoseidon } from "circomlibjs";
import { BallotBuilder } from "../src/builder.js";

describe("Integration: Poseidon + ElGamal", function () {
    let elgamal: any;
    let poseidon: any;
    let F: any;

    before(async () => {
        elgamal = await buildElGamal();
        poseidon = await buildPoseidon();
        F = poseidon.F;
    });

    it("should encrypt and match structure", async () => {
        const k = "77133043288661348011445954248744555004576526375";
        const msg = "3";
        
        // Key Pair
        const { pubKey } = elgamal.generateKeyPair();

        // Encrypt
        const result = elgamal.encrypt(msg, pubKey, k);

        // Check types
        expect(result.c1).to.exist;
        expect(result.c2).to.exist;
    });

    it("should generate valid inputs for multiple fields (Rate 5)", async () => {
        const builder = await BallotBuilder.build();
        const config = {
            numFields: 8,
            uniqueValues: 1,
            maxValue: 16,
            minValue: 0,
            maxValueSum: 1125,
            minValueSum: 5,
            costExponent: 2,
            costFromWeight: 0
        };
        const fields = [1, 2, 3, 4, 5];
        const { pubKey } = builder.elgamal.generateKeyPair();
        const processId = "123";
        const address = "456";
        const k = builder.randomK();

        const inputs = builder.generateInputs(fields, 1, pubKey, processId, address, k, config);

        expect(inputs.fields).to.have.lengthOf(8);
        expect(inputs.fields.slice(0, 5)).to.deep.equal(fields);
        expect(inputs.fields.slice(5)).to.deep.equal([0, 0, 0]);
        expect(inputs.num_fields).to.equal(5);
        expect(inputs.cipherfields).to.have.lengthOf(8);
        expect(inputs.inputs_hash).to.be.a('string');
    });
});