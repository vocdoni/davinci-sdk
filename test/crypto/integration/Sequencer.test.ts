import {
  BallotBuilder,
  fromRTEtoTE,
  fromTEtoRTE,
  hexToDecimal,
  FIELD_MODULUS,
  SCALING_FACTOR,
  SequencerProcessData,
} from '../../../src/crypto/BallotBuilder';

// Helper for modular arithmetic
function mod(n: bigint, m: bigint): bigint {
  return ((n % m) + m) % m;
}

describe('Sequencer Integration: RTE/TE Coordinate Conversion', () => {
  // Test data from the Sequencer
  // NOTE: pubKeyX and pubKeyY from Sequencer are in RTE format (Gnark BabyJubJub)
  const sequencerData = {
    processId: 'a62e32147e9c1ea76da552be6e0636f1984143afafadd02a0000000000000010',
    address: '0xA62E32147e9c1EA76DA552Be6E0636F1984143AF',
    // These are in RTE format from Gnark
    pubKeyX_RTE: 19485953556403312941904393378091455968053684322142533232252221507246354347357n,
    pubKeyY_RTE: 16219479350243308044593790248520319281271283090548119799482663113896815349782n,
    ballotMode: {
      numFields: 2,
      uniqueValues: false,
      maxValue: '3',
      minValue: '0',
      maxValueSum: '6',
      minValueSum: '0',
      costExponent: 0,
      costFromWeight: false,
    },
    censusRoot: '0x1e19f7dcef65ae548cd50d4abc068acb71e6b71e4f70149ebf02a95f7c907440',
    stateRoot: '0x23068329c92c67b356254dccb053af973af7c7883f3886cbe812d9399a924563',
  };

  let builder: BallotBuilder;

  beforeAll(async () => {
    builder = await BallotBuilder.build();
  });

  it('should correctly convert RTE to TE coordinates', () => {
    // Convert the public key from RTE (Gnark) to TE (Circom/Iden3)
    const [pubKeyX_TE, pubKeyY_TE] = fromRTEtoTE(
      sequencerData.pubKeyX_RTE,
      sequencerData.pubKeyY_RTE
    );

    expect(pubKeyX_TE).toBeDefined();
    expect(pubKeyY_TE).toBeDefined();

    // Verify round-trip conversion
    const [x_back, y_back] = fromTEtoRTE(pubKeyX_TE, pubKeyY_TE);
    expect(x_back).toBe(sequencerData.pubKeyX_RTE);
    expect(y_back).toBe(sequencerData.pubKeyY_RTE);
  });

  it('should generate valid ballot inputs with sequencer data', async () => {
    // Convert process ID from hex to bigint
    const processIdBigInt = BigInt('0x' + sequencerData.processId);
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
    const pubKey = [builder.elgamal.F.e(pubKeyX_TE), builder.elgamal.F.e(pubKeyY_TE)];

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
    const fields = [1, 2]; // Two fields with values 1 and 2 (sum = 3, within 0-6)

    const inputs = builder.generateInputs(
      fields,
      1, // weight
      pubKey,
      processIdStr,
      addressStr,
      k,
      config
    );

    // Validate the structure
    expect(inputs.fields).toHaveLength(8);
    expect(inputs.fields.slice(0, 2)).toEqual(fields);
    expect(inputs.num_fields).toBe(2);
    expect(inputs.cipherfields).toHaveLength(8);
    expect(typeof inputs.vote_id).toBe('string');
    expect(typeof inputs.inputs_hash).toBe('string');
    expect(inputs.encryption_pubkey).toHaveLength(2);

    // The encryption pubkey should match the TE converted values
    expect(inputs.encryption_pubkey[0]).toBe(pubKeyX_TE.toString());
    expect(inputs.encryption_pubkey[1]).toBe(pubKeyY_TE.toString());
  });

  it('should produce consistent vote ID calculation', async () => {
    const processIdBigInt = BigInt('0x' + sequencerData.processId);
    const addressBigInt = BigInt(sequencerData.address);

    // Use a fixed k for reproducibility
    const k = '12345678901234567890';

    const voteId = builder.computeVoteID(
      processIdBigInt.toString(),
      addressBigInt.toString(),
      k
    );

    // Vote ID should be truncated to 160 bits (max value is 2^160 - 1)
    const maxVoteId = (1n << 160n) - 1n;
    expect(BigInt(voteId)).toBeLessThanOrEqual(maxVoteId);

    // Running the same computation should produce the same result
    const voteId2 = builder.computeVoteID(
      processIdBigInt.toString(),
      addressBigInt.toString(),
      k
    );
    expect(voteId).toBe(voteId2);
  });

  it('should generate JSON-compatible circuit inputs', async () => {
    const processIdBigInt = BigInt('0x' + sequencerData.processId);
    const addressBigInt = BigInt(sequencerData.address);

    const [pubKeyX_TE, pubKeyY_TE] = fromRTEtoTE(
      sequencerData.pubKeyX_RTE,
      sequencerData.pubKeyY_RTE
    );

    const pubKey = [builder.elgamal.F.e(pubKeyX_TE), builder.elgamal.F.e(pubKeyY_TE)];

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

    // Verify it can be serialized/deserialized
    const json = JSON.stringify(circuitInputs);
    const parsed = JSON.parse(json);

    expect(parsed.fields).toEqual(inputs.fields);
    expect(parsed.vote_id).toBe(inputs.vote_id);
    expect(parsed.inputs_hash).toBe(inputs.inputs_hash);
  });

  it('should generate inputs using generateInputsFromSequencer helper', async () => {
    // Define sequencer data in the exact format it would come from the API
    const sequencerProcessData: SequencerProcessData = {
      processId: 'a62e32147e9c1ea76da552be6e0636f1984143afafadd02a0000000000000010',
      address: '0xA62E32147e9c1EA76DA552Be6E0636F1984143AF',
      pubKeyX: '19485953556403312941904393378091455968053684322142533232252221507246354347357',
      pubKeyY: '16219479350243308044593790248520319281271283090548119799482663113896815349782',
      ballotMode: {
        numFields: 2,
        uniqueValues: false,
        maxValue: '3',
        minValue: '0',
        maxValueSum: '6',
        minValueSum: '0',
        costExponent: 0,
        costFromWeight: false,
      },
    };

    // Vote values that satisfy the ballot mode constraints
    const fields = [1, 2];
    const weight = 1;

    // Generate inputs using the helper method
    const inputs = builder.generateInputsFromSequencer(sequencerProcessData, fields, weight);

    expect(typeof inputs.process_id).toBe('string');
    expect(typeof inputs.address).toBe('string');
    expect(typeof inputs.vote_id).toBe('string');
    expect(typeof inputs.inputs_hash).toBe('string');
    expect(inputs.fields).toEqual([1, 2, 0, 0, 0, 0, 0, 0]); // Padded to 8
    expect(inputs.num_fields).toBe(2);
  });

  it('should work with createPubKeyFromRTE helper', async () => {
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

    const inputs = builder.generateInputs([1, 2], 1, pubKey, processId, address, k, config);

    expect(typeof inputs.vote_id).toBe('string');
    expect(typeof inputs.inputs_hash).toBe('string');
    expect(inputs.fields).toHaveLength(8);
  });

  it('should satisfy the mathematical relationship for RTE/TE conversion', () => {
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

    expect(x_back).toBe(testX_RTE);
    expect(y_back).toBe(testY_RTE);

    // Verify the mathematical relationship manually
    const negF = mod(-SCALING_FACTOR, FIELD_MODULUS);
    const expectedX_RTE = mod(x_TE * negF, FIELD_MODULUS);
    expect(expectedX_RTE).toBe(testX_RTE);
  });

  it('should handle edge cases in coordinate conversion', () => {
    // Test with zero
    const [x0, y0] = fromRTEtoTE(0n, 0n);
    expect(x0).toBe(0n);
    expect(y0).toBe(0n);

    // Test with 1
    const [x1, y1] = fromRTEtoTE(1n, 1n);
    const [xBack, yBack] = fromTEtoRTE(x1, y1);
    expect(xBack).toBe(1n);
    expect(yBack).toBe(1n);
  });

  it('should correctly use hexToDecimal helper', () => {
    // With 0x prefix
    const decimal1 = hexToDecimal('0xa62e32147e9c1ea76da552be6e0636f1984143af');
    expect(typeof decimal1).toBe('string');
    expect(BigInt(decimal1)).toBeGreaterThan(0n);

    // Without 0x prefix
    const decimal2 = hexToDecimal('a62e32147e9c1ea76da552be6e0636f1984143af');
    expect(decimal1).toBe(decimal2);

    // Should handle uppercase
    const decimal3 = hexToDecimal('0xA62E32147E9C1EA76DA552BE6E0636F1984143AF');
    expect(decimal1).toBe(decimal3);
  });
});
