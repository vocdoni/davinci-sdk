import { BallotBuilder, BallotInputsOutput, BallotConfig } from '../crypto';
import { BallotMode } from '../core/types';
import { ProofInputs } from './CircomProofService';

export class BallotInputGenerator {
  private builder?: BallotBuilder;
  private initialized = false;

  constructor() {}

  /**
   * Initialize the ballot input generator
   * Must be called before generating inputs
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.builder = await BallotBuilder.build();
    this.initialized = true;
  }

  /**
   * Generate ballot inputs for voting
   * @param processId - Process ID (hex string without 0x)
   * @param address - Voter address (hex string without 0x)
   * @param encryptionKey - Encryption public key [x, y]
   * @param ballotMode - Ballot mode configuration
   * @param choices - Array of voter choices
   * @param weight - Voter weight
   * @param customK - Optional custom randomness (will be generated if not provided)
   * @returns Ballot inputs ready for proof generation
   */
  async generateInputs(
    processId: string,
    address: string,
    encryptionKey: { x: string; y: string },
    ballotMode: BallotMode,
    choices: number[],
    weight: string,
    customK?: string
  ): Promise<BallotInputsOutput> {
    if (!this.initialized || !this.builder) {
      throw new Error('BallotInputGenerator not initialized — call `await init()` first');
    }

    const ballotInputs = this.builder.generateInputsFromSequencer(
      {
        processId,
        address: '0x' + address,
        pubKeyX: encryptionKey.x,
        pubKeyY: encryptionKey.y,
        ballotMode: {
          numFields: ballotMode.numFields,
          uniqueValues: ballotMode.uniqueValues,
          maxValue: ballotMode.maxValue,
          minValue: ballotMode.minValue,
          maxValueSum: ballotMode.maxValueSum,
          minValueSum: ballotMode.minValueSum,
          costExponent: ballotMode.costExponent,
          costFromWeight: ballotMode.costFromWeight,
        },
      },
      choices,
      parseInt(weight),
      customK,
      8
    );

    // Convert to CircomProof inputs format
    const circomInputs: ProofInputs = {
      fields: ballotInputs.fields.map(f => f.toString()),
      num_fields: ballotInputs.num_fields.toString(),
      unique_values: ballotInputs.unique_values.toString(),
      max_value: ballotInputs.max_value.toString(),
      min_value: ballotInputs.min_value.toString(),
      max_value_sum: ballotInputs.max_value_sum.toString(),
      min_value_sum: ballotInputs.min_value_sum.toString(),
      cost_exponent: ballotInputs.cost_exponent.toString(),
      cost_from_weight: ballotInputs.cost_from_weight.toString(),
      address: ballotInputs.address,
      weight: ballotInputs.weight.toString(),
      process_id: ballotInputs.process_id,
      vote_id: ballotInputs.vote_id,
      encryption_pubkey: [
        ballotInputs.encryption_pubkey[0],
        ballotInputs.encryption_pubkey[1],
      ] as [string, string],
      k: ballotInputs.k,
      cipherfields: ballotInputs.cipherfields.flat(2),
      inputs_hash: ballotInputs.inputs_hash,
    };

    // Convert cipherfields to the expected format
    const ciphertexts = ballotInputs.cipherfields.map(cf => ({
      c1: [cf[0][0], cf[0][1]] as [string, string],
      c2: [cf[1][0], cf[1][1]] as [string, string],
    }));

    // Build final output
    const output: BallotInputsOutput = {
      processId: '0x' + BigInt(ballotInputs.process_id).toString(16).padStart(64, '0'),
      address: '0x' + BigInt(ballotInputs.address).toString(16).padStart(40, '0'),
      ballot: {
        curveType: 'bjj_iden3',
        ciphertexts,
      },
      ballotInputsHash: ballotInputs.inputs_hash,
      voteId: '0x' + BigInt(ballotInputs.vote_id).toString(16).padStart(40, '0'),
      circomInputs,
    };
console.log("Generated ballot inputs:", JSON.stringify(output, null, 4));
    return output;
  }
}
