/**
 * @fileoverview Ballots and the values the ballot proof binds: the packed
 * ballot mode, the 16-field encryption with identity padding, the vote id and
 * the inputs hash, as davinci-zkvm `rust-sdk/src/ballot.rs` and the
 * davinci-circom `BallotProof(16)` circuit compute them.
 */

import { BjjPoint, isValidEncryptionKey } from './babyjubjub';
import {
  ElGamalCiphertext,
  IDENTITY_CIPHERTEXT,
  elgamalEncrypt,
  isIdentityCiphertext,
} from './encryption';
import { addressToField, assertFieldElement, processIdToField } from './field';
import { PoseidonHasher, getPoseidon } from './poseidon';
import {
  CENSUS_WEIGHT_BITS,
  MAX_VALUE_BITS,
  NUM_FIELDS,
  VALUE_SUM_BITS,
  VOTE_ID_MIN,
} from '../protocol/limits';

/**
 * A ballot mode with its bounds as integers, the form the circuit packs
 * (davinci-node `spec.BallotMode`).
 */
export interface BallotModeValues {
  /** Fields the election uses, 1..16 (u8). */
  numFields: number;
  /** Must not exceed `numFields` (u8). */
  groupSize: number;
  uniqueValues: boolean;
  /** u8. */
  costExponent: number;
  /** Below 2^48. */
  maxValue: bigint;
  /** Below 2^48. */
  minValue: bigint;
  /** Below 2^63. */
  maxValueSum: bigint;
  /** Below 2^63. */
  minValueSum: bigint;
}

/** A ballot: exactly 16 ciphertexts; fields at or above `numFields` hold the identity. */
export type Ballot = ElGamalCiphertext[];

/** The snarkjs input of the `BallotProof(16)` circuit (decimal strings). Contains the secret `k`. */
export interface BallotCircuitInputs {
  fields: string[];
  packed_ballot_mode: string;
  address: string;
  weight: string;
  process_id: string;
  vote_id: string;
  encryption_pubkey: [string, string];
  k: string;
  cipherfields: [[string, string], [string, string]][];
  inputs_hash: string;
}

const MAX_VALUE = 1n << BigInt(MAX_VALUE_BITS);
const MAX_SUM = 1n << BigInt(VALUE_SUM_BITS);
const PACKED_BITS = 247n;

function assertU8(v: number, what: string): void {
  if (!Number.isInteger(v) || v < 0 || v > 255) throw new RangeError(`${what} must be a u8`);
}

function assertBelow(v: bigint, bound: bigint, what: string, bits: number): void {
  if (v < 0n || v >= bound) throw new RangeError(`ballot mode: ${what} exceeds ${bits} bits`);
}

/**
 * Packs a ballot mode into the 247-bit word the circuit and the state tree use:
 * `numFields[0:8] | groupSize[8:16] | unique[16] | costExp[17:25] | maxValue[25:73] |
 * minValue[73:121] | maxValueSum[121:184] | minValueSum[184:247]`.
 * Out-of-range values throw instead of overlapping bits.
 */
export function packBallotMode(mode: BallotModeValues): bigint {
  assertU8(mode.numFields, 'numFields');
  assertU8(mode.groupSize, 'groupSize');
  assertU8(mode.costExponent, 'costExponent');
  if (mode.groupSize > mode.numFields) {
    throw new RangeError('ballot mode: groupSize exceeds numFields');
  }
  assertBelow(mode.maxValue, MAX_VALUE, 'maxValue', MAX_VALUE_BITS);
  assertBelow(mode.minValue, MAX_VALUE, 'minValue', MAX_VALUE_BITS);
  assertBelow(mode.maxValueSum, MAX_SUM, 'maxValueSum', VALUE_SUM_BITS);
  assertBelow(mode.minValueSum, MAX_SUM, 'minValueSum', VALUE_SUM_BITS);
  return (
    BigInt(mode.numFields) |
    (BigInt(mode.groupSize) << 8n) |
    ((mode.uniqueValues ? 1n : 0n) << 16n) |
    (BigInt(mode.costExponent) << 17n) |
    (mode.maxValue << 25n) |
    (mode.minValue << 73n) |
    (mode.maxValueSum << 121n) |
    (mode.minValueSum << 184n)
  );
}

/** Inverse of {@link packBallotMode}; rejects bits at or above 247 and a group size above the field count. */
export function unpackBallotMode(packed: bigint): BallotModeValues {
  if (packed < 0n || packed >> PACKED_BITS !== 0n) {
    throw new RangeError('ballot mode: bits above 247 set');
  }
  const get = (off: bigint, bits: bigint) => (packed >> off) & ((1n << bits) - 1n);
  const mode: BallotModeValues = {
    numFields: Number(get(0n, 8n)),
    groupSize: Number(get(8n, 8n)),
    uniqueValues: get(16n, 1n) === 1n,
    costExponent: Number(get(17n, 8n)),
    maxValue: get(25n, 48n),
    minValue: get(73n, 48n),
    maxValueSum: get(121n, 63n),
    minValueSum: get(184n, 63n),
  };
  if (mode.groupSize > mode.numFields) {
    throw new RangeError('ballot mode: groupSize exceeds numFields');
  }
  return mode;
}

function toValues(fields: readonly (bigint | number)[]): bigint[] {
  if (fields.length > NUM_FIELDS) {
    throw new RangeError(`at most ${NUM_FIELDS} field values, got ${fields.length}`);
  }
  return fields.map((f, i) => {
    const v = BigInt(f);
    if (v < 0n || v >= 1n << 64n) throw new RangeError(`field ${i} is not a u64`);
    return v;
  });
}

function encryptWith(
  h: PoseidonHasher,
  pk: BjjPoint,
  fields: bigint[],
  k: bigint,
  numFields: number
): Ballot {
  const pad = numFields > 0 && numFields < NUM_FIELDS;
  const out: Ballot = [];
  let ki = assertFieldElement(k, 'k');
  for (let i = 0; i < NUM_FIELDS; i++) {
    ki = h.hash([ki]);
    out.push(
      pad && i >= numFields
        ? { c1: { ...IDENTITY_CIPHERTEXT.c1 }, c2: { ...IDENTITY_CIPHERTEXT.c2 } }
        : elgamalEncrypt(pk, fields[i] ?? 0n, ki)
    );
  }
  return out;
}

function assertFieldCount(numFields: number, values: number): void {
  if (!Number.isInteger(numFields) || numFields < 1 || numFields > NUM_FIELDS) {
    throw new RangeError(`numFields ${numFields} not in 1..${NUM_FIELDS}`);
  }
  if (values > numFields) throw new RangeError(`${values} values for ${numFields} fields`);
}

/**
 * Encrypts a ballot as the circuit does: `k_1 = Poseidon(k)`,
 * `k_{i+1} = Poseidon(k_i)`, field `i` encrypted under `k_{i+1}`. Fields at
 * or above `numFields` become the identity ciphertext (the chain still
 * advances for them); missing values are zero. More values than `numFields`
 * throw rather than being dropped.
 *
 * @param pk - Election key in TE form
 * @param fields - At most `numFields` values
 * @param k - Ballot secret, a field element
 * @param numFields - The election's `numFields`, 1..16
 */
export async function encryptBallot(
  pk: BjjPoint,
  fields: readonly (bigint | number)[],
  k: bigint,
  numFields: number
): Promise<Ballot> {
  assertFieldCount(numFields, fields.length);
  return encryptWith(await getPoseidon(), pk, toValues(fields), k, numFields);
}

/** True for a 16-ciphertext ballot whose fields at or above `numFields` are the identity. */
export function isBallotPaddingValid(ballot: Ballot, numFields: number): boolean {
  if (ballot.length !== NUM_FIELDS) return false;
  return ballot.slice(Math.max(0, numFields)).every(isIdentityCiphertext);
}

/** `[c1.x, c1.y, c2.x, c2.y] x 16`, the layout every hash and wire format uses. */
export function ballotCoords(ballot: Ballot): bigint[] {
  if (ballot.length !== NUM_FIELDS) {
    throw new RangeError(`a ballot has ${NUM_FIELDS} ciphertexts, got ${ballot.length}`);
  }
  return ballot.flatMap(c => [c.c1.x, c.c1.y, c.c2.x, c.c2.y]);
}

function voteIdWith(h: PoseidonHasher, processId: bigint, address: bigint, k: bigint): bigint {
  return VOTE_ID_MIN | (h.hash([processId, address, k]) & (VOTE_ID_MIN - 1n));
}

/**
 * Vote id: `2^63 + (Poseidon(processId, address, k) mod 2^63)`.
 *
 * @param processId - Process id as a field element (see `processIdToField`)
 * @param address - Voter address as a field element (see `addressToField`)
 * @param k - Ballot secret
 */
export async function computeVoteId(
  processId: bigint,
  address: bigint,
  k: bigint
): Promise<bigint> {
  return voteIdWith(await getPoseidon(), processId, address, k);
}

/** What the ballot proof's inputs hash binds. */
export interface BallotInputsHashParams {
  /** Process id as a field element. */
  processId: bigint;
  ballotMode: BallotModeValues;
  /** Election key in TE form. */
  encryptionKey: BjjPoint;
  /** Voter address as a field element. */
  address: bigint;
  voteId: bigint;
  ballot: Ballot;
  weight: bigint;
}

/**
 * The 71 inputs of the inputs hash, in circuit order:
 * `[pid, packedMode, pk.x, pk.y, address, voteId, 64 ballot coords, weight]`.
 */
export function ballotInputsHashPreimage(p: BallotInputsHashParams): bigint[] {
  return [
    p.processId,
    packBallotMode(p.ballotMode),
    p.encryptionKey.x,
    p.encryptionKey.y,
    p.address,
    p.voteId,
    ...ballotCoords(p.ballot),
    p.weight,
  ];
}

/** The third public signal of the ballot proof: MultiPoseidon of {@link ballotInputsHashPreimage}. */
export async function computeBallotInputsHash(p: BallotInputsHashParams): Promise<bigint> {
  return (await getPoseidon()).multiHash(ballotInputsHashPreimage(p));
}

/** Everything a vote needs before the proof. */
export interface BuildBallotParams {
  /** Process id, `0x` + 62 hex digits. */
  processId: string;
  /** Voter address. */
  address: string;
  /** Election key in TE form, as read from the registry. */
  encryptionKey: BjjPoint;
  ballotMode: BallotModeValues;
  /** The voter's choices: at most `ballotMode.numFields` values, missing ones are zero. */
  fields: readonly (bigint | number)[];
  /** Census weight, below 2^88. */
  weight: bigint;
  /** Ballot secret; see `randomBallotSecret`. */
  k: bigint;
}

/** A built ballot: what the vote request carries plus the circuit inputs. */
export interface BuiltBallot {
  ballot: Ballot;
  voteId: bigint;
  inputsHash: bigint;
  /** snarkjs input for `BallotProof(16)`. Contains the secret `k`. */
  circuitInputs: BallotCircuitInputs;
  /** The public signals the proof must carry: `[address, voteId, inputsHash]`. */
  publicSignals: [bigint, bigint, bigint];
}

/**
 * Builds a ballot like davinci-sequencer `Voter::prepare_vote`: checks the
 * key and the field count, encrypts with identity padding, derives the vote
 * id and the inputs hash, and assembles the circuit inputs.
 *
 * It does not check the choices against the ballot mode; see `checkBallot`.
 */
export async function buildBallot(p: BuildBallotParams): Promise<BuiltBallot> {
  const nf = p.ballotMode.numFields;
  assertFieldCount(nf, p.fields.length);
  if (!isValidEncryptionKey(p.encryptionKey)) {
    throw new RangeError('encryption key is not a valid subgroup point');
  }
  if (p.weight < 0n || p.weight >> BigInt(CENSUS_WEIGHT_BITS) !== 0n) {
    throw new RangeError(`weight does not fit in ${CENSUS_WEIGHT_BITS} bits`);
  }
  const h = await getPoseidon();
  const processId = processIdToField(p.processId);
  const address = addressToField(p.address);
  const fields = toValues(p.fields);
  const ballot = encryptWith(h, p.encryptionKey, fields, p.k, nf);
  const voteId = voteIdWith(h, processId, address, p.k);
  const packed = packBallotMode(p.ballotMode);
  const inputsHash = h.multiHash(
    ballotInputsHashPreimage({
      processId,
      ballotMode: p.ballotMode,
      encryptionKey: p.encryptionKey,
      address,
      voteId,
      ballot,
      weight: p.weight,
    })
  );
  const dec = (x: bigint) => x.toString();
  const circuitInputs: BallotCircuitInputs = {
    fields: Array.from({ length: NUM_FIELDS }, (_, i) => dec(fields[i] ?? 0n)),
    packed_ballot_mode: dec(packed),
    address: dec(address),
    weight: dec(p.weight),
    process_id: dec(processId),
    vote_id: dec(voteId),
    encryption_pubkey: [dec(p.encryptionKey.x), dec(p.encryptionKey.y)],
    k: dec(p.k),
    cipherfields: ballot.map(c => [
      [dec(c.c1.x), dec(c.c1.y)],
      [dec(c.c2.x), dec(c.c2.y)],
    ]),
    inputs_hash: dec(inputsHash),
  };
  return {
    ballot,
    voteId,
    inputsHash,
    circuitInputs,
    publicSignals: [address, voteId, inputsHash],
  };
}
