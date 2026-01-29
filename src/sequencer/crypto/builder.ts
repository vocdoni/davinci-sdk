import { buildElGamal, ElGamal } from './elgamal';
import { buildPoseidon } from 'circomlibjs';

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

  generateInputs(
    fields: number[],
    weight: number,
    pubKey: any, // [x, y] - can be strings, BigInts, or field elements
    processId: string,
    address: string,
    k: string,
    config: BallotConfig,
    circuitCapacity: number = 8
  ): BallotInputs {
    config.maxValueSum = 0;
    console.log('Using config:', config);
    console.log('Using circuit capacity:', circuitCapacity);
    console.log('Address:', address);
    console.log('Process ID:', processId);
    console.log('k:', k);
    console.log('Public Key (RTE):', pubKey);
    console.log('Fields:', fields);
    
    // Convert pubKey from RTE (Reduced Twisted Edwards) to TE (Twisted Edwards)
    // The sequencer returns keys in RTE format, but circomlibjs expects TE format
    const pubKeyTE = this.elgamal.fromRTEtoTE(pubKey[0], pubKey[1]);
    console.log('Public Key (TE):', pubKeyTE);
    
    const activeFields = fields.length;

    const { cipherfields, paddedFields } = this.encryptFields(fields, pubKeyTE, k, circuitCapacity);
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

    inputsList.push(BigInt(this.elgamal.F.toString(pubKeyTE[0], 10)));
    inputsList.push(BigInt(this.elgamal.F.toString(pubKeyTE[1], 10)));

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
        this.elgamal.F.toString(pubKeyTE[0], 10),
        this.elgamal.F.toString(pubKeyTE[1], 10),
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
}
