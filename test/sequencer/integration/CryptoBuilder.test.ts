import { buildElGamal } from '../../../src/sequencer/crypto/elgamal';
import { buildPoseidon } from 'circomlibjs';
import { BallotBuilder } from '../../../src/sequencer/crypto/builder';

describe('Integration: Poseidon + ElGamal', function () {
  let elgamal: any;
  let poseidon: any;
  let F: any;

  beforeAll(async () => {
    elgamal = await buildElGamal();
    poseidon = await buildPoseidon();
    F = poseidon.F;
  });

  it('should encrypt and match structure', async () => {
    const k = '77133043288661348011445954248744555004576526375';
    const msg = '3';

    // Key Pair
    const { pubKey } = elgamal.generateKeyPair();

    // Encrypt
    const result = elgamal.encrypt(msg, pubKey, k);

    // Check types
    expect(result.c1).toBeDefined();
    expect(result.c2).toBeDefined();
    expect(Array.isArray(result.c1)).toBe(true);
    expect(Array.isArray(result.c2)).toBe(true);
    expect(result.c1).toHaveLength(2);
    expect(result.c2).toHaveLength(2);
  });

  it('should generate valid inputs for multiple fields (Rate 5)', async () => {
    const builder = await BallotBuilder.build();
    const config = {
      numFields: 8,
      uniqueValues: 1,
      maxValue: 16,
      minValue: 0,
      maxValueSum: 1125,
      minValueSum: 5,
      costExponent: 2,
      costFromWeight: 0,
    };
    const fields = [1, 2, 3, 4, 5];
    const { pubKey } = builder.elgamal.generateKeyPair();
    const processId = '123';
    const address = '456';
    const k = builder.randomK();

    const inputs = builder.generateInputs(fields, 1, pubKey, processId, address, k, config);

    expect(inputs.fields).toHaveLength(8);
    expect(inputs.fields.slice(0, 5)).toEqual(fields);
    expect(inputs.fields.slice(5)).toEqual([0, 0, 0]);
    expect(inputs.num_fields).toBe(5);
    expect(inputs.cipherfields).toHaveLength(8);
    expect(typeof inputs.inputs_hash).toBe('string');
  });

  it('should generate consistent encryption with same k value', async () => {
    const builder = await BallotBuilder.build();
    const k = '77133043288661348011445954248744555004576526375';
    const msg = '5';
    const { pubKey } = builder.elgamal.generateKeyPair();

    const result1 = builder.elgamal.encrypt(msg, pubKey, k);
    const result2 = builder.elgamal.encrypt(msg, pubKey, k);

    // Same k and message should produce same ciphertext
    expect(result1.c1).toEqual(result2.c1);
    expect(result1.c2).toEqual(result2.c2);
  });

  it('should generate different ciphertexts with different k values', async () => {
    const builder = await BallotBuilder.build();
    const msg = '5';
    const { pubKey } = builder.elgamal.generateKeyPair();

    const k1 = builder.randomK();
    const k2 = builder.randomK();

    const result1 = builder.elgamal.encrypt(msg, pubKey, k1);
    const result2 = builder.elgamal.encrypt(msg, pubKey, k2);

    // Different k values should produce different ciphertexts
    expect(result1.c1).not.toEqual(result2.c1);
    expect(result1.c2).not.toEqual(result2.c2);
  });

  it('should generate random k values', async () => {
    const builder = await BallotBuilder.build();

    const k1 = builder.randomK();
    const k2 = builder.randomK();
    const k3 = builder.randomK();

    // All k values should be different
    expect(k1).not.toBe(k2);
    expect(k2).not.toBe(k3);
    expect(k1).not.toBe(k3);

    // All should be valid BigInt strings
    expect(() => BigInt(k1)).not.toThrow();
    expect(() => BigInt(k2)).not.toThrow();
    expect(() => BigInt(k3)).not.toThrow();
  });

  it('should handle edge case: all zero fields', async () => {
    const builder = await BallotBuilder.build();
    const config = {
      numFields: 5,
      uniqueValues: 0,
      maxValue: 10,
      minValue: 0,
      maxValueSum: 50,
      minValueSum: 0,
      costExponent: 1,
      costFromWeight: 0,
    };
    const fields = [0, 0, 0, 0, 0];
    const { pubKey } = builder.elgamal.generateKeyPair();
    const processId = '999';
    const address = '888';
    const k = builder.randomK();

    const inputs = builder.generateInputs(fields, 10, pubKey, processId, address, k, config);

    expect(inputs.fields).toEqual(fields);
    expect(inputs.num_fields).toBe(5);
    expect(inputs.cipherfields).toHaveLength(5);
    expect(typeof inputs.inputs_hash).toBe('string');
  });

  it('should handle edge case: max values', async () => {
    const builder = await BallotBuilder.build();
    const config = {
      numFields: 3,
      uniqueValues: 0,
      maxValue: 100,
      minValue: 0,
      maxValueSum: 300,
      minValueSum: 0,
      costExponent: 1,
      costFromWeight: 0,
    };
    const fields = [100, 100, 100];
    const { pubKey } = builder.elgamal.generateKeyPair();
    const processId = '777';
    const address = '666';
    const k = builder.randomK();

    const inputs = builder.generateInputs(fields, 50, pubKey, processId, address, k, config);

    expect(inputs.fields).toEqual(fields);
    expect(inputs.num_fields).toBe(3);
    expect(inputs.cipherfields).toHaveLength(3);
    expect(typeof inputs.inputs_hash).toBe('string');
  });
});
