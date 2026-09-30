/**
 * @fileoverview Strict JSON codecs of the sequencer API, as the serde types
 * of davinci-sequencer `client/src/api.rs` read and write them. Decoding only
 * accepts canonical values: field elements are decimal strings below p,
 * points lie on the curve, byte strings have their exact length, and the
 * bodies the node checks field by field (votes, census proofs, points, ballot
 * modes) carry no unknown field. Responses may grow new fields.
 */

import { getAddress } from 'ethers';
import { type BjjPoint, bjjIsOnCurve } from '../../crypto/babyjubjub';
import { type Ballot, type BallotModeValues, packBallotMode } from '../../crypto/ballot';
import type { LeanIMTProof } from '../../crypto/census';
import type { ElGamalCiphertext } from '../../crypto/encryption';
import type { TrackerProof } from '../../crypto/tracker';
import { BN254_FR } from '../../crypto/field';
import { NUM_FIELDS, VOTE_ID_MIN } from '../../protocol/limits';
import { SequencerDecodeError } from '../errors';
import type { Groth16Proof } from '../types';
import {
  type BallotResponse,
  type CensusFile,
  type CensusProofWire,
  type ParticipantResponse,
  type ProcessView,
  type SequencerInfo,
  type SequencerProcessStatus,
  type TransitionView,
  VoteStatus,
  type VoteRequest,
  type VoteStatusResponse,
} from './types';

type Json = Record<string, unknown>;

const U64_BOUND = 1n << 64n;
const U128_BOUND = 1n << 128n;

function fail(path: string, what: string): never {
  throw new SequencerDecodeError(`${path}: ${what}`);
}

// An object; with `fields`, one that carries no other key.
function object(v: unknown, path: string, fields?: readonly string[]): Json {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'want an object');
  const o = v as Json;
  if (fields) {
    const extra = Object.keys(o).find(k => !fields.includes(k));
    if (extra !== undefined) fail(path, `unknown field ${extra}`);
  }
  return o;
}

function array(v: unknown, path: string, length?: number): unknown[] {
  if (!Array.isArray(v)) fail(path, 'want an array');
  if (length !== undefined && v.length !== length) fail(path, `want ${length} elements`);
  return v;
}

function string(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, 'want a string');
  return v;
}

function boolean(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'want a boolean');
  return v;
}

// An unsigned integer JSON number below 2^bits. u64s are read only up to
// 2^53 - 1: past that a JSON number no longer holds every digit.
function uint(v: unknown, path: string, bits: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v >= 2 ** bits) {
    fail(path, `want a u${bits} number`);
  }
  return v;
}

// A decimal string of at most `digits` digits whose value is below `bound`.
function decimal(v: unknown, path: string, digits: number, bound: bigint): bigint {
  const s = string(v, path);
  if (s.length === 0 || s.length > digits || !/^[0-9]+$/.test(s)) {
    fail(path, 'want a decimal integer string');
  }
  const n = BigInt(s);
  if (n >= bound) fail(path, 'integer out of range');
  return n;
}

const fieldElement = (v: unknown, path: string) => decimal(v, path, 80, BN254_FR);
const u128 = (v: unknown, path: string) => decimal(v, path, 39, U128_BOUND);
const u64Decimal = (v: unknown, path: string) => decimal(v, path, 39, U64_BOUND);

// Exactly `length` bytes of hex, `0x` optional; returned lowercase with `0x`.
function hexBytes(v: unknown, path: string, length: number): string {
  const s = string(v, path);
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (h.length !== 2 * length || !/^[0-9a-fA-F]*$/.test(h)) {
    fail(path, `want ${length} bytes of hex`);
  }
  return `0x${h.toLowerCase()}`;
}

// Any even number of hex digits, `0x` optional.
function hexVar(v: unknown, path: string): string {
  const s = string(v, path);
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) fail(path, 'want hex bytes');
  return `0x${h.toLowerCase()}`;
}

const address = (v: unknown, path: string) => getAddress(hexBytes(v, path, 20));
const processId = (v: unknown, path: string) => hexBytes(v, path, 31);

function voteId(v: unknown, path: string): bigint {
  const id = BigInt(hexBytes(v, path, 8));
  if (id < VOTE_ID_MIN) fail(path, 'vote id below 2^63');
  return id;
}

// `{x, y}` decimal coordinates on the curve. Like serde, the node also takes
// the fields as a two-element array.
function point(v: unknown, path: string): BjjPoint {
  const [x, y] = Array.isArray(v)
    ? array(v, path, 2)
    : ((o: Json) => [o.x, o.y])(object(v, path, ['x', 'y']));
  const p = { x: fieldElement(x, `${path}.x`), y: fieldElement(y, `${path}.y`) };
  if (!bjjIsOnCurve(p)) fail(path, 'point not on the curve');
  return p;
}

function ciphertext(v: unknown, path: string): ElGamalCiphertext {
  const [c1, c2] = Array.isArray(v)
    ? array(v, path, 2)
    : ((o: Json) => [o.c1, o.c2])(object(v, path, ['c1', 'c2']));
  return { c1: point(c1, `${path}.c1`), c2: point(c2, `${path}.c2`) };
}

function ballot(v: unknown, path: string): Ballot {
  return array(v, path, NUM_FIELDS).map((c, i) => ciphertext(c, `${path}[${i}]`));
}

const BALLOT_MODE_FIELDS = [
  'numFields',
  'groupSize',
  'uniqueValues',
  'costExponent',
  'maxValue',
  'minValue',
  'maxValueSum',
  'minValueSum',
] as const;

// camelCase ballot mode that must pack (the circuit's bit widths).
function ballotMode(v: unknown, path: string): BallotModeValues {
  const o = object(v, path, BALLOT_MODE_FIELDS);
  const mode: BallotModeValues = {
    numFields: uint(o.numFields, `${path}.numFields`, 8),
    groupSize: uint(o.groupSize, `${path}.groupSize`, 8),
    uniqueValues: boolean(o.uniqueValues, `${path}.uniqueValues`),
    costExponent: uint(o.costExponent, `${path}.costExponent`, 8),
    maxValue: u64Decimal(o.maxValue, `${path}.maxValue`),
    minValue: u64Decimal(o.minValue, `${path}.minValue`),
    maxValueSum: u64Decimal(o.maxValueSum, `${path}.maxValueSum`),
    minValueSum: u64Decimal(o.minValueSum, `${path}.minValueSum`),
  };
  try {
    packBallotMode(mode);
  } catch (err) {
    fail(path, err instanceof Error ? err.message : 'does not pack');
  }
  return mode;
}

const MERKLE_FIELDS = ['root', 'leaf', 'pathBits', 'siblings'] as const;

function merkleProof(o: Json, path: string): LeanIMTProof {
  return {
    root: fieldElement(o.root, `${path}.root`),
    leaf: fieldElement(o.leaf, `${path}.leaf`),
    pathBits: BigInt(uint(o.pathBits, `${path}.pathBits`, 64)),
    siblings: array(o.siblings, `${path}.siblings`).map((s, i) =>
      fieldElement(s, `${path}.siblings[${i}]`)
    ),
  };
}

function censusProof(v: unknown, path: string): CensusProofWire {
  const o = object(v, path);
  if (o.type === 'merkle') {
    return { type: 'merkle', ...merkleProof(object(v, path, ['type', ...MERKLE_FIELDS]), path) };
  }
  if (o.type === 'csp') {
    object(v, path, ['type', 'r', 's', 'recid', 'index']);
    return {
      type: 'csp',
      r: hexBytes(o.r, `${path}.r`, 32),
      s: hexBytes(o.s, `${path}.s`, 32),
      recid: uint(o.recid, `${path}.recid`, 8),
      index: BigInt(uint(o.index, `${path}.index`, 64)),
    };
  }
  fail(`${path}.type`, 'want "merkle" or "csp"');
}

function strings(v: unknown, path: string, length: number): string[] {
  return array(v, path, length).map((s, i) => string(s, `${path}[${i}]`));
}

// snarkjs proof; `protocol` and `curve` default like rapidsnark output.
function snarkProof(v: unknown, path: string): Groth16Proof {
  const o = object(v, path);
  const piB = array(o.pi_b, `${path}.pi_b`, 3).map((p, i) => strings(p, `${path}.pi_b[${i}]`, 2));
  return {
    pi_a: strings(o.pi_a, `${path}.pi_a`, 3) as Groth16Proof['pi_a'],
    pi_b: piB as Groth16Proof['pi_b'],
    pi_c: strings(o.pi_c, `${path}.pi_c`, 3) as Groth16Proof['pi_c'],
    protocol: o.protocol === undefined ? 'groth16' : string(o.protocol, `${path}.protocol`),
    curve: o.curve === undefined ? 'bn128' : string(o.curve, `${path}.curve`),
  };
}

// Serde `Option`: absent or null is none.
function optional<T>(v: unknown, read: (v: unknown) => T): T | undefined {
  return v === undefined || v === null ? undefined : read(v);
}

const VOTE_REQUEST_FIELDS = [
  'processId',
  'address',
  'voteId',
  'ballot',
  'ballotProof',
  'ballotInputsHash',
  'signature',
  'weight',
  'censusProof',
] as const;

/**
 * Decodes a `POST /votes` body the way the node does: unknown fields, a
 * non-canonical field element, an off-curve point or a wrong length are refused.
 *
 * @throws SequencerDecodeError
 */
export function decodeVoteRequest(json: unknown): VoteRequest {
  const o = object(json, 'vote', VOTE_REQUEST_FIELDS);
  const proof = optional(o.censusProof, v => censusProof(v, 'vote.censusProof'));
  return {
    processId: processId(o.processId, 'vote.processId'),
    address: address(o.address, 'vote.address'),
    voteId: voteId(o.voteId, 'vote.voteId'),
    ballot: ballot(o.ballot, 'vote.ballot'),
    ballotProof: snarkProof(o.ballotProof, 'vote.ballotProof'),
    ballotInputsHash: fieldElement(o.ballotInputsHash, 'vote.ballotInputsHash'),
    signature: hexBytes(o.signature, 'vote.signature', 65),
    weight: u128(o.weight, 'vote.weight'),
    ...(proof && { censusProof: proof }),
  };
}

// Caller input the node would refuse.
function invalid(what: string): never {
  throw new RangeError(`vote request: ${what}`);
}

function checkHex(v: string, length: number, what: string): string {
  const h = v.startsWith('0x') ? v.slice(2) : v;
  if (h.length !== 2 * length || !/^[0-9a-fA-F]*$/.test(h))
    invalid(`${what} must be ${length} bytes of hex`);
  return `0x${h.toLowerCase()}`;
}

function checkBelow(v: bigint, bound: bigint, what: string): string {
  if (v < 0n || v >= bound) invalid(`${what} out of range`);
  return v.toString();
}

function checkSafe(v: bigint, what: string): number {
  if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) invalid(`${what} must be at most 2^53 - 1`);
  return Number(v);
}

function encodePoint(p: BjjPoint, what: string): { x: string; y: string } {
  const out = {
    x: checkBelow(p.x, BN254_FR, `${what}.x`),
    y: checkBelow(p.y, BN254_FR, `${what}.y`),
  };
  if (!bjjIsOnCurve(p)) invalid(`${what} is not on the curve`);
  return out;
}

function encodeCensusProof(p: CensusProofWire): Json {
  if (p.type === 'merkle') {
    return {
      type: 'merkle',
      root: checkBelow(p.root, BN254_FR, 'census proof root'),
      leaf: checkBelow(p.leaf, BN254_FR, 'census proof leaf'),
      pathBits: checkSafe(p.pathBits, 'census proof pathBits'),
      siblings: p.siblings.map(s => checkBelow(s, BN254_FR, 'census proof sibling')),
    };
  }
  if (p.type === 'csp') {
    if (!Number.isInteger(p.recid) || p.recid < 0 || p.recid > 255) invalid('recid must be a u8');
    return {
      type: 'csp',
      r: checkHex(p.r, 32, 'CSP r'),
      s: checkHex(p.s, 32, 'CSP s'),
      recid: p.recid,
      index: checkSafe(p.index, 'CSP index'),
    };
  }
  invalid('census proof type must be merkle or csp');
}

/**
 * The exact `POST /votes` body for `vote`, fields in the order the node's
 * types write them. Refuses anything the node would reject on decoding.
 *
 * @throws RangeError for a value the node would refuse
 */
export function encodeVoteRequest(vote: VoteRequest): Json {
  if (vote.ballot.length !== NUM_FIELDS) invalid(`ballot must hold ${NUM_FIELDS} ciphertexts`);
  if (vote.voteId < VOTE_ID_MIN || vote.voteId >= U64_BOUND) invalid('vote id not in [2^63, 2^64)');
  const proof = vote.ballotProof;
  const body: Json = {
    processId: checkHex(vote.processId, 31, 'process id'),
    address: checkHex(vote.address, 20, 'address'),
    voteId: `0x${vote.voteId.toString(16).padStart(16, '0')}`,
    ballot: vote.ballot.map((c, i) => ({
      c1: encodePoint(c.c1, `ballot[${i}].c1`),
      c2: encodePoint(c.c2, `ballot[${i}].c2`),
    })),
    ballotProof: {
      pi_a: proof.pi_a,
      pi_b: proof.pi_b,
      pi_c: proof.pi_c,
      protocol: proof.protocol ?? 'groth16',
      curve: proof.curve ?? 'bn128',
    },
    ballotInputsHash: checkBelow(vote.ballotInputsHash, BN254_FR, 'ballotInputsHash'),
    signature: checkHex(vote.signature, 65, 'signature'),
    weight: checkBelow(vote.weight, U128_BOUND, 'weight'),
  };
  if (vote.censusProof) body.censusProof = encodeCensusProof(vote.censusProof);
  return body;
}

/** `POST /votes` answer: the vote id the node took. */
export function decodeVoteResponse(json: unknown): bigint {
  return voteId(object(json, 'vote response').voteId, 'vote response.voteId');
}

/** `GET /info`. */
export function decodeInfo(json: unknown): SequencerInfo {
  const o = object(json, 'info');
  // Present, null for an observer.
  if (!('sequencerAddress' in o)) fail('info.sequencerAddress', 'missing');
  return {
    sequencerAddress:
      optional(o.sequencerAddress, v => address(v, 'info.sequencerAddress')) ?? null,
    chainId: uint(o.chainId, 'info.chainId', 64),
    processRegistry: address(o.processRegistry, 'info.processRegistry'),
    ballotVkHash: hexBytes(o.ballotVkHash, 'info.ballotVkHash', 32),
    batchProgramVk: hexBytes(o.batchProgramVk, 'info.batchProgramVk', 32),
    resultsProgramVk: hexBytes(o.resultsProgramVk, 'info.resultsProgramVk', 32),
    observer: boolean(o.observer, 'info.observer'),
    settledBySelf: uint(o.settledBySelf, 'info.settledBySelf', 64),
    syncedFromOthers: uint(o.syncedFromOthers, 'info.syncedFromOthers', 64),
    lostRaces: o.lostRaces === undefined ? 0 : uint(o.lostRaces, 'info.lostRaces', 64),
  };
}

const PROCESS_STATUSES: readonly SequencerProcessStatus[] = [
  'ready',
  'ended',
  'canceled',
  'paused',
  'results',
  'unknown',
];

/** `GET /processes/{processId}`. */
export function decodeProcessView(json: unknown): ProcessView {
  const o = object(json, 'process');
  const status = string(o.status, 'process.status') as SequencerProcessStatus;
  if (!PROCESS_STATUSES.includes(status)) fail('process.status', `unknown status ${status}`);
  const census = object(o.census, 'process.census');
  const localStateRoot = optional(o.localStateRoot, v => hexBytes(v, 'process.localStateRoot', 32));
  const result = optional(o.result, v =>
    array(v, 'process.result').map((r, i) => uint(r, `process.result[${i}]`, 64))
  );
  const note = optional(o.note, v => string(v, 'process.note'));
  return {
    id: processId(o.id, 'process.id'),
    status,
    isAcceptingVotes: boolean(o.isAcceptingVotes, 'process.isAcceptingVotes'),
    organizationId: address(o.organizationId, 'process.organizationId'),
    encryptionKey: point(o.encryptionKey, 'process.encryptionKey'),
    ballotMode: ballotMode(o.ballotMode, 'process.ballotMode'),
    census: {
      censusOrigin: uint(census.censusOrigin, 'process.census.censusOrigin', 8),
      censusRoot: fieldElement(census.censusRoot, 'process.census.censusRoot'),
      censusURI: string(census.censusURI, 'process.census.censusURI'),
    },
    stateRoot: hexBytes(o.stateRoot, 'process.stateRoot', 32),
    ...(localStateRoot !== undefined && { localStateRoot }),
    synced: o.synced === undefined ? false : boolean(o.synced, 'process.synced'),
    votersCount: uint(o.votersCount, 'process.votersCount', 64),
    overwrittenVotesCount: uint(o.overwrittenVotesCount, 'process.overwrittenVotesCount', 64),
    maxVoters: uint(o.maxVoters, 'process.maxVoters', 64),
    startTime: uint(o.startTime, 'process.startTime', 64),
    duration: uint(o.duration, 'process.duration', 64),
    ...(result !== undefined && { result }),
    ignored: o.ignored === undefined ? false : boolean(o.ignored, 'process.ignored'),
    ...(note !== undefined && { note }),
  };
}

/** `GET /processes`. */
export function decodeProcessList(json: unknown): string[] {
  const o = object(json, 'process list');
  return array(o.processes, 'processes').map((p, i) => processId(p, `processes[${i}]`));
}

/** `POST /processes/keys` answer: the key, on the curve (not yet checked for the subgroup). */
export function decodeEncryptionKey(json: unknown): BjjPoint {
  const o = object(json, 'key');
  const p = { x: fieldElement(o.x, 'key.x'), y: fieldElement(o.y, 'key.y') };
  if (!bjjIsOnCurve(p)) fail('key', 'encryption key not on the curve');
  return p;
}

const VOTE_STATUSES = Object.values(VoteStatus) as string[];

/** `GET /votes/{processId}/voteId/{voteId}`. */
export function decodeVoteStatus(json: unknown): VoteStatusResponse {
  const o = object(json, 'vote status');
  const status = string(o.status, 'vote status.status');
  if (!VOTE_STATUSES.includes(status)) fail('vote status.status', `unknown vote status ${status}`);
  const error = optional(o.error, v => string(v, 'vote status.error'));
  return { status: status as VoteStatus, ...(error !== undefined && { error }) };
}

/** `GET /votes/{processId}/voteId/{voteId}/proof`. */
export function decodeTrackerProof(json: unknown): TrackerProof {
  const o = object(json, 'tracker proof');
  return {
    processId: processId(o.processId, 'tracker proof.processId'),
    voteId: voteId(o.voteId, 'tracker proof.voteId'),
    root: hexBytes(o.root, 'tracker proof.root', 32),
    siblings: array(o.siblings, 'tracker proof.siblings').map((s, i) =>
      hexBytes(s, `tracker proof.siblings[${i}]`, 32)
    ),
  };
}

/** `GET /processes/{processId}/participants/{address}`, not yet checked against the address. */
export function decodeParticipant(json: unknown): ParticipantResponse {
  const o = object(json, 'participant');
  return {
    address: address(o.address, 'participant.address'),
    weight: u128(o.weight, 'participant.weight'),
    censusProof: merkleProof(
      object(o.censusProof, 'participant.censusProof', MERKLE_FIELDS),
      'participant.censusProof'
    ),
  };
}

/** `GET /votes/{processId}/address/{address}`. */
export function decodeBallotResponse(json: unknown): BallotResponse {
  const o = object(json, 'ballot response');
  return {
    address: address(o.address, 'ballot response.address'),
    ballot: ballot(o.ballot, 'ballot response.ballot'),
  };
}

/** `GET /processes/{processId}/transitions`. */
export function decodeTransitions(json: unknown): TransitionView[] {
  const o = object(json, 'transitions');
  return array(o.transitions, 'transitions').map((t, i) => {
    const path = `transitions[${i}]`;
    const v = object(t, path);
    return {
      index: uint(v.index, `${path}.index`, 64),
      oldRoot: hexBytes(v.oldRoot, `${path}.oldRoot`, 32),
      newRoot: hexBytes(v.newRoot, `${path}.newRoot`, 32),
      txHash: hexBytes(v.txHash, `${path}.txHash`, 32),
      blockNumber: uint(v.blockNumber, `${path}.blockNumber`, 64),
      sender: address(v.sender, `${path}.sender`),
      voters: uint(v.voters, `${path}.voters`, 64),
      overwrites: uint(v.overwrites, `${path}.overwrites`, 64),
      nBlobs: uint(v.nBlobs, `${path}.nBlobs`, 64),
    };
  });
}

/** `GET /processes/{processId}/transitions/{index}/blobs`: raw blobs as `0x` hex. */
export function decodeBlobs(json: unknown): string[] {
  const o = object(json, 'blobs');
  return array(o.blobs, 'blobs').map((b, i) => hexVar(b, `blobs[${i}]`));
}

/**
 * Decodes a census file (`{"participants": [{"key", "weight"}]}`), keeping
 * the leaf order.
 *
 * @throws SequencerDecodeError
 */
export function decodeCensusFile(json: unknown): CensusFile {
  const o = object(json, 'census');
  return {
    participants: array(o.participants, 'census.participants').map((p, i) => {
      const path = `census.participants[${i}]`;
      const v = object(p, path);
      return { key: address(v.key, `${path}.key`), weight: u128(v.weight, `${path}.weight`) };
    }),
  };
}

/**
 * The census file for `census`: `{"participants": [{"key", "weight"}]}` with
 * lowercase keys and decimal weights, in order (the order is the leaf order).
 *
 * @throws RangeError for a malformed address or a weight outside u128
 */
export function encodeCensusFile(census: CensusFile): Json {
  return {
    participants: census.participants.map(p => {
      const h = p.key.startsWith('0x') ? p.key.slice(2) : p.key;
      if (h.length !== 40 || !/^[0-9a-fA-F]*$/.test(h)) {
        throw new RangeError(`census: ${p.key} is not an address`);
      }
      if (p.weight < 0n || p.weight >= U128_BOUND) {
        throw new RangeError(`census: weight of ${p.key} out of range`);
      }
      return { key: `0x${h.toLowerCase()}`, weight: p.weight.toString() };
    }),
  };
}
