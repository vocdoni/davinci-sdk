import { buildPoseidon } from 'circomlibjs';
import { FIELDS_PER_BALLOT } from './constants';
import { FIELD_MODULUS, mod } from './field';
import { multiPoseidon } from './poseidon';

const STATE_KEYS = {
  PROCESS_ID: 0n,
  BALLOT_MODE: 2n,
  ENCRYPTION_KEY: 3n,
  RESULTS_ADD: 4n,
  RESULTS_SUB: 5n,
  CENSUS_ORIGIN: 6n,
} as const;

export interface BallotModeInput {
  numFields: number | bigint;
  uniqueValues: boolean | number | bigint;
  maxValue: string | number | bigint;
  minValue: string | number | bigint;
  maxValueSum: string | number | bigint;
  minValueSum: string | number | bigint;
  costExponent: number | bigint;
  costFromWeight: boolean | number | bigint;
}

export interface EncryptionKeyInput {
  x: string | bigint;
  y: string | bigint;
}

export interface StateInitializationInput {
  processId: string | bigint;
  censusOrigin: number | bigint;
  ballotMode: BallotModeInput;
  encryptionKey: EncryptionKeyInput;
}

function toBigInt(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

function toFlag(value: boolean | number | bigint): bigint {
  if (typeof value === 'boolean') {
    return value ? 1n : 0n;
  }
  return toBigInt(value);
}

function parseHexToBigInt(value: string | bigint): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  const clean = value.startsWith('0x') || value.startsWith('0X') ? value : `0x${value}`;
  return BigInt(clean);
}

function buildZeroBallotValues(): bigint[] {
  const values: bigint[] = [];
  for (let i = 0; i < FIELDS_PER_BALLOT; i += 1) {
    values.push(0n, 1n, 0n, 1n);
  }
  return values;
}

const ZERO_BALLOT_VALUES = buildZeroBallotValues();

function hashBigInts(poseidon: any, F: any, values: bigint[]): bigint {
  const safeValues = values.map((value) => mod(value, FIELD_MODULUS));
  return multiPoseidon(poseidon, F, safeValues);
}

export function serializeBallotMode(ballotMode: BallotModeInput): bigint[] {
  return [
    toBigInt(ballotMode.numFields),
    toFlag(ballotMode.uniqueValues),
    toBigInt(ballotMode.maxValue),
    toBigInt(ballotMode.minValue),
    toBigInt(ballotMode.maxValueSum),
    toBigInt(ballotMode.minValueSum),
    toBigInt(ballotMode.costExponent),
    toFlag(ballotMode.costFromWeight),
  ];
}

async function buildStateTree() {
  const { SMT, SMTMemDb } = (await import('circomlibjs')) as any;
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const hash0 = (left: bigint, right: bigint) => poseidon([left, right]);
  const hash1 = (key: bigint, value: bigint) => poseidon([key, value, F.one]);
  const db = new SMTMemDb(F);
  const root = await db.getRoot();
  const smt = new SMT(db, root, hash0, hash1, F);
  return { smt, poseidon, F };
}

export async function calculateInitialStateRoot(input: StateInitializationInput): Promise<bigint> {
  const { smt, poseidon, F } = await buildStateTree();

  const processId = parseHexToBigInt(input.processId);
  const censusOrigin = toBigInt(input.censusOrigin);
  const ballotMode = serializeBallotMode(input.ballotMode);
  const encryptionKey = [toBigInt(input.encryptionKey.x), toBigInt(input.encryptionKey.y)];

  const entries = [
    { key: STATE_KEYS.PROCESS_ID, values: [processId] },
    { key: STATE_KEYS.BALLOT_MODE, values: ballotMode },
    { key: STATE_KEYS.ENCRYPTION_KEY, values: encryptionKey },
    { key: STATE_KEYS.RESULTS_ADD, values: ZERO_BALLOT_VALUES },
    { key: STATE_KEYS.RESULTS_SUB, values: ZERO_BALLOT_VALUES },
    { key: STATE_KEYS.CENSUS_ORIGIN, values: [censusOrigin] },
  ];

  for (const entry of entries) {
    const leafValue = hashBigInts(poseidon, F, entry.values);
    await smt.insert(entry.key, leafValue);
  }

  return F.toObject(smt.root);
}

export function formatStateRoot(root: bigint, byteLength: number = 32): string {
  const hex = root.toString(16).padStart(byteLength * 2, '0');
  return `0x${hex}`;
}
