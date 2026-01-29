import { buildElGamal, ElGamal } from './ElGamal';
import { buildPoseidon } from 'circomlibjs';

// BN254 scalar field modulus (Fr)
export const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Scaling factor for RTE <-> TE conversion
// This is used to convert between Gnark's BabyJubJub (Reduced Twisted Edwards)
// and Iden3/Circomlibjs BabyJubJub (Standard Twisted Edwards)
export const SCALING_FACTOR =
  6360561867910373094066688120553762416144456282423235903351243436111059670888n;

/**
 * Modular inverse using extended Euclidean algorithm
 */
function modInverse(a: bigint, m: bigint): bigint {
  let [old_r, r] = [a, m];
  let [old_s, s] = [1n, 0n];

  while (r !== 0n) {
    const quotient = old_r / r;
    [old_r, r] = [r, old_r - quotient * r];
    [old_s, s] = [s, old_s - quotient * s];
  }

  return ((old_s % m) + m) % m;
}

/**
 * Modular arithmetic helper
 */
function mod(n: bigint, m: bigint): bigint {
  return ((n % m) + m) % m;
}

/**
 * FromRTEtoTE converts a point from Reduced TwistedEdwards (Gnark) to TwistedEdwards (Circom/Iden3) coordinates.
 * It applies the transformation:
 *      x = x' / (-f)
 *      y = y'
 *
 * This matches the Go implementation in davinci-node/crypto/ecc/format/twistededwards.go
 */
export function fromRTEtoTE(x: bigint, y: bigint): [bigint, bigint] {
  // Calculate -f mod p
  const negF = mod(-SCALING_FACTOR, FIELD_MODULUS);
  // Calculate (-f)^-1 mod p
  const negFInv = modInverse(negF, FIELD_MODULUS);
  // xTE = x * (-f)^-1 mod p
  const xTE = mod(x * negFInv, FIELD_MODULUS);
  return [xTE, y];
}

/**
 * FromTEtoRTE converts a point from TwistedEdwards (Circom/Iden3) to Reduced TwistedEdwards (Gnark) coordinates.
 * It applies the transformation:
 *      x' = x * (-f)
 *      y' = y
 */
export function fromTEtoRTE(x: bigint, y: bigint): [bigint, bigint] {
  const negF = mod(-SCALING_FACTOR, FIELD_MODULUS);
  const xRTE = mod(x * negF, FIELD_MODULUS);
  return [xRTE, y];
}

export interface BallotConfig {
  numFields: number;
  uniqueValues: number;
  maxValue: number;
  minValue: number;
  maxValueSum: number;
  minValueSum: number;
  costExponent: number;
  costFromWeight: number;
}

/**
 * Sequencer data format - the raw data from a DAVINCI sequencer
 * Note: pubKeyX and pubKeyY are in RTE format (Gnark BabyJubJub)
 */
export interface SequencerProcessData {
  processId: string; // hex string (with or without 0x prefix)
  address: string; // hex string (with or without 0x prefix)
  pubKeyX: string; // decimal string - RTE X coordinate
  pubKeyY: string; // decimal string - RTE Y coordinate
  ballotMode: {
    numFields: number;
    uniqueValues: boolean;
    maxValue: string;
    minValue: string;
    maxValueSum: string;
    minValueSum: string;
    costExponent: number;
    costFromWeight: boolean;
  };
}

/**
 * Converts a hex string (with or without 0x prefix) to a decimal string
 */
export function hexToDecimal(hex: string): string {
  const cleanHex = hex.startsWith('0x') || hex.startsWith('0X') ? hex : '0x' + hex;
  return BigInt(cleanHex).toString();
}

/**
 * Parses ballot mode from sequencer format to circuit format
 */
export function parseBallotMode(ballotMode: SequencerProcessData['ballotMode']): BallotConfig {
  return {
    numFields: ballotMode.numFields,
    uniqueValues: ballotMode.uniqueValues ? 1 : 0,
    maxValue: parseInt(ballotMode.maxValue),
    minValue: parseInt(ballotMode.minValue),
    maxValueSum: parseInt(ballotMode.maxValueSum),
    minValueSum: parseInt(ballotMode.minValueSum),
    costExponent: ballotMode.costExponent,
    costFromWeight: ballotMode.costFromWeight ? 1 : 0,
  };
}

export interface BallotInputs {
  fields: number[];
  weight: number;
  encryption_pubkey: string[];
  cipherfields: string[][][];
  process_id: string;
  address: string;
  k: string;
  vote_id: string;
  inputs_hash: string;
  // Config
  num_fields: number;
  unique_values: number;
  max_value: number;
  min_value: number;
  max_value_sum: number;
  min_value_sum: number;
  cost_exponent: number;
  cost_from_weight: number;
}

export class BallotBuilder {
  elgamal: ElGamal;
  poseidon: any;
  F: any;

  constructor(elgamal: ElGamal, poseidon: any) {
    this.elgamal = elgamal;
    this.poseidon = poseidon;
    this.F = poseidon.F;
  }

  static async build(): Promise<BallotBuilder> {
    const elgamal = await buildElGamal();
    const poseidon = await buildPoseidon();
    return new BallotBuilder(elgamal, poseidon);
  }

  randomK(): string {
    return this.elgamal.randomScalar().toString();
  }

  derivePoseidonChain(seedK: string, n: number): string[] {
    let current = BigInt(seedK);
    const out: string[] = [current.toString()];
    for (let i = 0; i < n; i++) {
      // Hash(current) - using Poseidon(1) as in circuit
      const h = this.poseidon([current]);
      const hBig = BigInt(this.F.toString(h, 10));
      out.push(hBig.toString());
      current = hBig;
    }
    return out;
  }

  // Matches circuits/lib/multiposeidon.circom logic
  multiHash(inputs: bigint[]): bigint {
    const nInputs = inputs.length;
    if (nInputs <= 16) {
      return this.F.toObject(this.poseidon(inputs));
    }

    // Split into chunks of 16
    const chunks: bigint[][] = [];
    for (let i = 0; i < nInputs; i += 16) {
      chunks.push(inputs.slice(i, i + 16));
    }

    const intermediateHashes: bigint[] = [];
    for (const chunk of chunks) {
      intermediateHashes.push(this.F.toObject(this.poseidon(chunk)));
    }

    // Hash the chunk hashes
    return this.F.toObject(this.poseidon(intermediateHashes));
  }

  encryptFields(fields: number[], pubKey: any, seedK: string, nFields: number) {
    const paddedFields = [...fields];
    while (paddedFields.length < nFields) {
      paddedFields.push(0);
    }

    const ks = this.derivePoseidonChain(seedK, nFields);
    const cipherfields: string[][][] = [];

    for (let i = 0; i < nFields; i++) {
      const k = ks[i + 1]; // Use derived k
      const msg = BigInt(paddedFields[i]);
      const enc = this.elgamal.encrypt(msg, pubKey, k);

      cipherfields.push([
        [this.elgamal.F.toString(enc.c1[0], 10), this.elgamal.F.toString(enc.c1[1], 10)],
        [this.elgamal.F.toString(enc.c2[0], 10), this.elgamal.F.toString(enc.c2[1], 10)],
      ]);
    }
    return { cipherfields, paddedFields };
  }

  computeVoteID(processId: string, address: string, k: string): string {
    // Poseidon(3)
    const h = this.poseidon([BigInt(processId), BigInt(address), BigInt(k)]);
    const hBig = BigInt(this.F.toString(h, 10));
    const mask = (1n << 160n) - 1n;
    return (hBig & mask).toString();
  }

  computeInputsHash(inputs: any[]): string {
    return this.multiHash(inputs).toString();
  }

  /**
   * Creates a public key point from TE coordinates (as strings or bigints).
   * Use this when you already have coordinates in TE format.
   */
  createPubKeyFromTE(x: string | bigint, y: string | bigint): any {
    return [this.elgamal.F.e(BigInt(x)), this.elgamal.F.e(BigInt(y))];
  }

  /**
   * Creates a public key point from RTE coordinates (as strings or bigints).
   * Use this when you have coordinates from a Gnark-based system (like the DAVINCI sequencer).
   * This automatically converts from RTE to TE format.
   */
  createPubKeyFromRTE(x: string | bigint, y: string | bigint): any {
    const [xTE, yTE] = fromRTEtoTE(BigInt(x), BigInt(y));
    return [this.elgamal.F.e(xTE), this.elgamal.F.e(yTE)];
  }

  /**
   * Generates ballot inputs for the circuit.
   *
   * IMPORTANT: The pubKey must be in TE (Twisted Edwards) format as used by circomlibjs.
   * If you have RTE coordinates from a Gnark-based system (like DAVINCI sequencer),
   * use `createPubKeyFromRTE()` or `generateInputsFromSequencer()` instead.
   *
   * @param fields - The vote field values
   * @param weight - The voter's weight
   * @param pubKey - Public key as field elements [x, y] in TE format (use createPubKeyFromTE/RTE)
   * @param processId - Process ID as decimal string
   * @param address - Voter address as decimal string
   * @param k - Random k value for encryption
   * @param config - Ballot configuration
   * @param circuitCapacity - Number of fields the circuit supports (default: 8)
   */
  generateInputs(
    fields: number[],
    weight: number,
    pubKey: any, // [x, y] as field elements - use createPubKeyFromTE/RTE to create
    processId: string,
    address: string,
    k: string,
    config: BallotConfig,
    circuitCapacity: number = 8
  ): BallotInputs {
    const activeFields = fields.length;

    const { cipherfields, paddedFields } = this.encryptFields(fields, pubKey, k, circuitCapacity);
    const voteId = this.computeVoteID(processId, address, k);

    // Build Inputs Hash - MUST MATCH ballot_proof.circom ORDER
    const inputsList: any[] = [];

    inputsList.push(BigInt(processId));
    inputsList.push(BigInt(activeFields)); // num_fields
    inputsList.push(BigInt(config.uniqueValues));
    inputsList.push(BigInt(config.maxValue));
    inputsList.push(BigInt(config.minValue));
    inputsList.push(BigInt(config.maxValueSum));
    inputsList.push(BigInt(config.minValueSum));
    inputsList.push(BigInt(config.costExponent));
    inputsList.push(BigInt(config.costFromWeight));

    inputsList.push(BigInt(this.elgamal.F.toString(pubKey[0], 10)));
    inputsList.push(BigInt(this.elgamal.F.toString(pubKey[1], 10)));

    inputsList.push(BigInt(address));
    inputsList.push(BigInt(voteId));

    for (const cf of cipherfields) {
      inputsList.push(BigInt(cf[0][0]));
      inputsList.push(BigInt(cf[0][1]));
      inputsList.push(BigInt(cf[1][0]));
      inputsList.push(BigInt(cf[1][1]));
    }

    inputsList.push(BigInt(weight));

    const inputsHash = this.computeInputsHash(inputsList);

    return {
      fields: paddedFields,
      weight,
      encryption_pubkey: [
        this.elgamal.F.toString(pubKey[0], 10),
        this.elgamal.F.toString(pubKey[1], 10),
      ],
      cipherfields,
      process_id: processId,
      address,
      k,
      vote_id: voteId,
      inputs_hash: inputsHash,
      // Config
      num_fields: activeFields,
      unique_values: config.uniqueValues,
      max_value: config.maxValue,
      min_value: config.minValue,
      max_value_sum: config.maxValueSum,
      min_value_sum: config.minValueSum,
      cost_exponent: config.costExponent,
      cost_from_weight: config.costFromWeight,
    };
  }

  /**
   * Generates ballot inputs from sequencer data.
   * This is a convenience method that handles the RTE to TE conversion
   * for the public key automatically.
   *
   * @param sequencerData - Data from the DAVINCI sequencer
   * @param fields - The vote field values
   * @param weight - The voter's weight
   * @param k - Optional random k value (generated if not provided)
   * @param circuitCapacity - The number of fields the circuit supports (default: 8)
   */
  generateInputsFromSequencer(
    sequencerData: SequencerProcessData,
    fields: number[],
    weight: number,
    k?: string,
    circuitCapacity: number = 8
  ): BallotInputs {
    // Convert process ID and address from hex to decimal
    const processId = hexToDecimal(sequencerData.processId);
    const address = hexToDecimal(sequencerData.address);

    // Convert public key from RTE (Gnark) to TE (Circom/Iden3)
    const [pubKeyX_TE, pubKeyY_TE] = fromRTEtoTE(
      BigInt(sequencerData.pubKeyX),
      BigInt(sequencerData.pubKeyY)
    );

    // Create the public key point in TE format for circomlibjs
    const pubKey = [this.elgamal.F.e(pubKeyX_TE), this.elgamal.F.e(pubKeyY_TE)];

    // Parse ballot mode
    const config = parseBallotMode(sequencerData.ballotMode);

    // Generate random k if not provided
    const kValue = k ?? this.randomK();

    return this.generateInputs(fields, weight, pubKey, processId, address, kValue, config, circuitCapacity);
  }
}
