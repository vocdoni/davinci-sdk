import { buildElGamal } from '../../../src/crypto/ElGamal';
import { buildPoseidon } from 'circomlibjs';
import { BallotBuilder } from '../../../src/crypto/BallotBuilder';

describe('Crypto Integration: Poseidon + ElGamal', () => {
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
    expect(inputs.vote_id).toBeDefined();
    expect(typeof inputs.vote_id).toBe('string');
  });

  it('should generate deterministic outputs with same k', async () => {
    const builder = await BallotBuilder.build();
    const config = {
      numFields: 4,
      uniqueValues: 0,
      maxValue: 10,
      minValue: 0,
      maxValueSum: 20,
      minValueSum: 0,
      costExponent: 1,
      costFromWeight: 0,
    };
    const fields = [1, 2];
    const { pubKey } = builder.elgamal.generateKeyPair();
    const processId = '999';
    const address = '888';
    const k = builder.randomK();

    // Generate twice with same k
    const inputs1 = builder.generateInputs(fields, 1, pubKey, processId, address, k, config);
    const inputs2 = builder.generateInputs(fields, 1, pubKey, processId, address, k, config);

    // Should be identical
    expect(inputs1.vote_id).toBe(inputs2.vote_id);
    expect(inputs1.inputs_hash).toBe(inputs2.inputs_hash);
    expect(inputs1.cipherfields).toEqual(inputs2.cipherfields);
  });

  it('should handle single field', async () => {
    const builder = await BallotBuilder.build();
    const config = {
      numFields: 1,
      uniqueValues: 0,
      maxValue: 5,
      minValue: 0,
      maxValueSum: 5,
      minValueSum: 0,
      costExponent: 1,
      costFromWeight: 0,
    };
    const fields = [3];
    const { pubKey } = builder.elgamal.generateKeyPair();
    const processId = '111';
    const address = '222';
    const k = builder.randomK();

    const inputs = builder.generateInputs(fields, 1, pubKey, processId, address, k, config, 1);

    expect(inputs.fields).toEqual([3]);
    expect(inputs.num_fields).toBe(1);
    expect(inputs.cipherfields).toHaveLength(1);
  });

  it('should pad fields to circuit capacity', async () => {
    const builder = await BallotBuilder.build();
    const config = {
      numFields: 8,
      uniqueValues: 0,
      maxValue: 10,
      minValue: 0,
      maxValueSum: 30,
      minValueSum: 0,
      costExponent: 1,
      costFromWeight: 0,
    };
    const fields = [1, 2, 3];
    const { pubKey } = builder.elgamal.generateKeyPair();
    const processId = '333';
    const address = '444';
    const k = builder.randomK();

    const inputs = builder.generateInputs(fields, 1, pubKey, processId, address, k, config, 8);

    // Should pad to 8
    expect(inputs.fields).toHaveLength(8);
    expect(inputs.fields.slice(0, 3)).toEqual([1, 2, 3]);
    expect(inputs.fields.slice(3)).toEqual([0, 0, 0, 0, 0]);
    expect(inputs.cipherfields).toHaveLength(8);
  });

  it('should derive different k values using poseidon chain', async () => {
    const builder = await BallotBuilder.build();
    const seedK = builder.randomK();
    const numFields = 5;

    const ks = builder.derivePoseidonChain(seedK, numFields);

    // Should have numFields + 1 values (seed + derived)
    expect(ks).toHaveLength(numFields + 1);
    expect(ks[0]).toBe(seedK);

    // All values should be different
    const unique = new Set(ks);
    expect(unique.size).toBe(ks.length);
  });

  it('should compute vote ID correctly', async () => {
    const builder = await BallotBuilder.build();
    const processId = '12345';
    const address = '67890';
    const k = builder.randomK();

    const voteId1 = builder.computeVoteID(processId, address, k);
    const voteId2 = builder.computeVoteID(processId, address, k);

    // Should be deterministic
    expect(voteId1).toBe(voteId2);
    expect(typeof voteId1).toBe('string');

    // Different inputs should give different vote IDs
    const voteId3 = builder.computeVoteID(processId, address, builder.randomK());
    expect(voteId1).not.toBe(voteId3);
  });

  it('should compute inputs hash with multiHash', async () => {
    const builder = await BallotBuilder.build();

    // Test with small input (< 16 elements)
    const smallInputs = [1n, 2n, 3n];
    const hash1 = builder.computeInputsHash(smallInputs);
    expect(typeof hash1).toBe('string');

    // Test with large input (> 16 elements) - should use chunking
    const largeInputs = Array.from({ length: 20 }, (_, i) => BigInt(i + 1));
    const hash2 = builder.computeInputsHash(largeInputs);
    expect(typeof hash2).toBe('string');
    expect(hash1).not.toBe(hash2);
  });

  it('should generate valid encryption public key format', async () => {
    const builder = await BallotBuilder.build();
    const { pubKey } = builder.elgamal.generateKeyPair();

    // PubKey should be [x, y] point
    expect(Array.isArray(pubKey)).toBe(true);
    expect(pubKey).toHaveLength(2);

    // Convert to strings
    const pubKeyStr = [
      builder.elgamal.F.toString(pubKey[0], 10),
      builder.elgamal.F.toString(pubKey[1], 10),
    ];

    expect(typeof pubKeyStr[0]).toBe('string');
    expect(typeof pubKeyStr[1]).toBe('string');
    expect(pubKeyStr[0].length).toBeGreaterThan(0);
    expect(pubKeyStr[1].length).toBeGreaterThan(0);
  });
});
