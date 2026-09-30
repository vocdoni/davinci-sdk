import { ZeroAddress, getAddress, toBeHex, toUtf8Bytes } from 'ethers';
import { LeanIMT, type LeanIMTProof, censusLeaf, slotFromAddress } from '../../crypto/census';
import { CENSUS_WEIGHT_BITS } from '../../protocol/limits';
import { decodeCensusFile } from '../../sequencer/api/wire';
import { CensusError, CensusSlotCollisionError } from '../errors';
import type { CensusOrigin, CensusParticipant, MerkleCensusWitness } from '../types';
import { Census } from './Census';

/** A member to add: its address and weight (a decimal string, a safe integer or a bigint). */
export interface Participant {
  key: string;
  weight: string | number | bigint;
}

const WEIGHT_LIMIT = 1n << BigInt(CENSUS_WEIGHT_BITS);

function weightOf(weight: unknown, key: string): bigint {
  let w: bigint;
  if (typeof weight === 'bigint') w = weight;
  else if (typeof weight === 'number' && Number.isSafeInteger(weight)) w = BigInt(weight);
  else if (typeof weight === 'string' && /^[0-9]+$/.test(weight)) w = BigInt(weight);
  else w = -1n;
  if (w < 0n) {
    throw new CensusError(`weight of ${key} is not a non-negative integer: ${String(weight)}`);
  }
  if (w >= WEIGHT_LIMIT) {
    throw new CensusError(`weight of ${key} does not fit in ${CENSUS_WEIGHT_BITS} bits`);
  }
  return w;
}

// Lowercase `0x` address; mixed case must carry a valid checksum.
function memberKey(address: unknown): string {
  if (typeof address !== 'string' || !/^(0x)?[0-9a-fA-F]{40}$/.test(address)) {
    throw new CensusError(`not an Ethereum address: ${String(address)}`);
  }
  let checked: string;
  try {
    checked = getAddress(address.startsWith('0x') ? address : `0x${address}`);
  } catch {
    throw new CensusError(`bad address checksum: ${address}`);
  }
  if (checked === ZeroAddress) throw new CensusError('the zero address cannot be a census member');
  return checked.toLowerCase();
}

// Refuses an object that names a key twice: JSON.parse keeps the last one,
// the nodes' parser refuses the document. `text` is valid JSON.
function assertUniqueKeys(text: string): void {
  const open: (Set<string> | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') open.push(new Set());
    else if (c === '[') open.push(null);
    else if (c === '}' || c === ']') open.pop();
    else if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      let k = j + 1;
      while (text[k] === ' ' || text[k] === '\n' || text[k] === '\r' || text[k] === '\t') k++;
      const keys = open[open.length - 1];
      if (text[k] === ':' && keys) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (keys.has(key)) {
          throw new CensusError(`the census file names "${key}" twice in one object`);
        }
        keys.add(key);
      }
      i = j;
    }
  }
}

function parseJson(file: unknown): unknown {
  let text: string;
  if (file instanceof Uint8Array) {
    try {
      // A byte-order mark is kept, and so refused, as the nodes do.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file);
    } catch {
      throw new CensusError('the census file is not UTF-8');
    }
  } else if (typeof file === 'string') {
    text = file;
  } else {
    return file;
  }
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch (err) {
    throw new CensusError('the census file is not JSON', err);
  }
  assertUniqueKeys(text);
  return json;
}

interface Built {
  tree: LeanIMT;
  index: Map<string, number>;
}

/**
 * A lean-IMT census of addresses and weights (origins 1 and 2). Members are
 * leaves `(address << 88) | weight` in the order they were added, which is
 * the order of the census file nodes download.
 *
 * Every member gets the ballot slot its address derives; two members on one
 * slot would overwrite each other's ballots, so `add` refuses a member whose
 * slot is taken ({@link CensusSlotCollisionError}), as the nodes refuse such a
 * census.
 *
 * @example
 * ```typescript
 * const census = new OffchainCensus();
 * census.add(['0x1111…', '0x2222…']); // weight 1
 * census.add({ key: '0x3333…', weight: 5n });
 * const root = await census.root();
 * const bytes = census.serialize(); // what publishCensus uploads
 * ```
 */
export abstract class MerkleCensus extends Census {
  // Lowercase address -> weight, in leaf order.
  private readonly members = new Map<string, bigint>();
  private readonly slots = new Map<bigint, string>();
  private built?: Promise<Built>;

  constructor(censusOrigin: CensusOrigin) {
    super(censusOrigin);
  }

  /**
   * Reads a census file (`{"participants": [{"key", "weight"}]}`, weights as
   * decimal strings), from its bytes, its text or its parsed JSON, keeping the
   * member order. Refuses what nodes refuse: no members, an address listed
   * twice, a weight of 2^88 or more, two members on one slot; and also the
   * zero address, which nodes take as an empty leaf.
   *
   * @throws CensusError
   */
  static fromJSON<T extends MerkleCensus>(this: new () => T, file: unknown): T {
    let participants: { key: string; weight: bigint }[];
    try {
      participants = decodeCensusFile(parseJson(file)).participants;
    } catch (err) {
      if (err instanceof CensusError) throw err;
      throw new CensusError(
        `not a census file: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
    if (participants.length === 0) throw new CensusError('the census file has no members');
    const seen = new Set<string>();
    for (const p of participants) {
      const key = p.key.toLowerCase();
      if (seen.has(key)) throw new CensusError(`${key} is listed twice`);
      seen.add(key);
    }
    const census = new this();
    census.add(participants);
    return census;
  }

  /**
   * Adds members, or changes the weight of members already in (who keep
   * their place). A plain address has weight 1. Nothing is added when any
   * entry is refused.
   *
   * @param data - An address, a `{ key, weight }` member, or a list of either
   * @throws CensusError for a bad address or weight, CensusSlotCollisionError
   *   when a new member's slot belongs to another
   */
  add(data: string | Participant | readonly (string | Participant)[]): void {
    const list: readonly (string | Participant)[] = Array.isArray(data)
      ? (data as readonly (string | Participant)[])
      : [data as string | Participant];
    const entries = list.map((p): [string, bigint] => {
      if (typeof p === 'string') return [memberKey(p), 1n];
      const key = memberKey(p?.key);
      return [key, weightOf(p.weight, key)];
    });
    const taken = new Map<bigint, string>();
    for (const [key] of entries) {
      if (this.members.has(key)) continue;
      const slot = slotFromAddress(key);
      const other = this.slots.get(slot) ?? taken.get(slot);
      if (other !== undefined && other !== key) {
        throw new CensusSlotCollisionError(slot, [other, key]);
      }
      taken.set(slot, key);
    }
    let changed = false;
    for (const [key, weight] of entries) {
      if (this.members.get(key) === weight) continue;
      this.members.set(key, weight);
      changed = true;
    }
    for (const [slot, key] of taken) this.slots.set(slot, key);
    if (changed) this.changed();
  }

  /** Removes a member; the members after it move up one leaf. */
  remove(address: string): void {
    const key = memberKey(address);
    if (!this.members.delete(key)) return;
    this.slots.delete(slotFromAddress(key));
    this.changed();
  }

  /** The members in leaf order, lowercase addresses and decimal weights. */
  get participants(): CensusParticipant[] {
    return Array.from(this.members, ([key, weight]) => ({ key, weight: weight.toString() }));
  }

  /** The member addresses in leaf order, lowercase. */
  get addresses(): string[] {
    return Array.from(this.members.keys());
  }

  /** Number of members. */
  get size(): number {
    return this.members.size;
  }

  /** Whether `address` is a member. */
  has(address: string): boolean {
    return this.members.has(memberKey(address));
  }

  /** A member's weight as a decimal string; undefined for a non-member. */
  getWeight(address: string): string | undefined {
    return this.members.get(memberKey(address))?.toString();
  }

  /** A member's ballot slot; undefined for a non-member. */
  slotOf(address: string): bigint | undefined {
    const key = memberKey(address);
    return this.members.has(key) ? slotFromAddress(key) : undefined;
  }

  /**
   * The lean-IMT root of the members, `bytes32` hex.
   *
   * @throws CensusError for a census without members
   */
  async root(): Promise<string> {
    const { tree } = await this.build();
    return toBeHex(tree.root, 32);
  }

  /**
   * A member's compact lean-IMT proof, as nodes serve it.
   *
   * @throws CensusError for a non-member
   */
  async proof(address: string): Promise<LeanIMTProof> {
    const key = memberKey(address);
    const { tree, index } = await this.build();
    const i = index.get(key);
    if (i === undefined) throw new CensusError(`${key} is not in the census`);
    return tree.proof(i);
  }

  /**
   * A member's witness for the vote flow: its weight and proof.
   *
   * @throws CensusError for a non-member
   */
  async witness(address: string): Promise<MerkleCensusWitness> {
    const proof = await this.proof(address);
    return { type: 'merkle', weight: this.members.get(memberKey(address)) as bigint, proof };
  }

  /** The census file: `{ participants: [{ key, weight }] }`, members in leaf order. */
  toJSON(): { participants: CensusParticipant[] } {
    return { participants: this.participants };
  }

  /**
   * The census file as uploaded: UTF-8 JSON with two-space indentation and a
   * final newline, the bytes davinci-client's organizer writes for the same
   * members.
   */
  serialize(): Uint8Array {
    return toUtf8Bytes(`${JSON.stringify(this.toJSON(), null, 2)}\n`);
  }

  /**
   * Records where the census was published and its root.
   * @internal Used by `publishCensus`.
   */
  _setPublishedData(root: string, uri: string): void {
    this._censusRoot = root;
    this._censusURI = uri;
  }

  // A change of members: the tree and the published root no longer hold.
  private changed(): void {
    this.built = undefined;
    this._censusRoot = null;
    this._censusURI = null;
  }

  private build(): Promise<Built> {
    if (this.built) return this.built;
    if (this.members.size === 0) {
      return Promise.reject(new CensusError('the census has no members'));
    }
    const keys = Array.from(this.members.keys());
    const leaves = keys.map(k => censusLeaf(k, this.members.get(k) as bigint));
    const built = LeanIMT.create(leaves).then(
      tree => ({ tree, index: new Map(keys.map((k, i) => [k, i])) }),
      (err: unknown) => {
        if (this.built === built) this.built = undefined;
        throw err;
      }
    );
    this.built = built;
    return built;
  }
}
