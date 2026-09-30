/**
 * @fileoverview The Merkle census and ballot slots, as davinci-zkvm
 * `rust-sdk/src/census.rs` computes them: the lean incremental Merkle tree
 * (lean-imt-go shape, iden3 Poseidon of two inputs), its compact proofs, the
 * census leaf `(address << 88) | weight` and the slot of each voter.
 */

import { getBytes, sha256, toUtf8Bytes, concat } from 'ethers';
import {
  BN254_FR,
  addressToField,
  assertFieldElement,
  bigIntToHex,
  bytesToBigInt,
  parseHexBytes,
} from './field';
import { PoseidonHasher, getPoseidon } from './poseidon';
import { BALLOT_MAX, BALLOT_MIN, CENSUS_WEIGHT_BITS, MAX_CENSUS_DEPTH } from '../protocol/limits';

/**
 * A compact lean-IMT inclusion proof: levels where the node has no sibling
 * are skipped, and bit `i` of `pathBits` is set when the i-th sibling is on
 * the left.
 */
export interface LeanIMTProof {
  root: bigint;
  leaf: bigint;
  pathBits: bigint;
  siblings: bigint[];
}

/**
 * Append-only lean incremental Merkle tree, same shape as lean-imt-go: a node
 * without a right sibling is carried up unhashed. Build it with
 * {@link LeanIMT.create}; after that every operation is synchronous.
 *
 * @example
 * ```typescript
 * const tree = await LeanIMT.create([censusLeaf(a, 1n), censusLeaf(b, 2n)]);
 * const proof = tree.proof(1);
 * ```
 */
export class LeanIMT {
  // levels[0] are the leaves; the last level is [root] once non-empty.
  private levels: bigint[][];

  private constructor(
    private readonly hasher: PoseidonHasher,
    leaves: bigint[]
  ) {
    this.levels = [leaves];
    let level = leaves;
    while (level.length > 1) {
      const next: bigint[] = [];
      for (let i = 0; i < level.length; i += 2) {
        next.push(i + 1 < level.length ? this.hash(level[i], level[i + 1]) : level[i]);
      }
      this.levels.push(next);
      level = next;
    }
  }

  /** A tree over `leaves`, in order (n - 1 hashes). Leaves are field elements. */
  static async create(leaves: readonly bigint[] = []): Promise<LeanIMT> {
    leaves.forEach((l, i) => assertFieldElement(l, `leaf ${i}`));
    return new LeanIMT(await getPoseidon(), [...leaves]);
  }

  private hash(a: bigint, b: bigint): bigint {
    return this.hasher.hash([a, b]);
  }

  /** Number of leaves. */
  get size(): number {
    return this.levels[0].length;
  }

  /** Number of hashing levels above the leaves. */
  get depth(): number {
    return this.levels.length - 1;
  }

  /** The root; zero for an empty tree. */
  get root(): bigint {
    const top = this.levels[this.levels.length - 1];
    return top.length > 0 ? top[0] : 0n;
  }

  /** The leaves, in insertion order. */
  get leaves(): readonly bigint[] {
    return this.levels[0];
  }

  /** Index of the first leaf equal to `leaf`, or -1. */
  indexOf(leaf: bigint): number {
    return this.levels[0].indexOf(leaf);
  }

  /** Appends a leaf, updating one path. */
  insert(leaf: bigint): void {
    assertFieldElement(leaf, 'leaf');
    const size = this.size + 1;
    const depth = size === 1 ? 0 : (size - 1).toString(2).length;
    while (this.levels.length < depth + 1) this.levels.push([]);
    let node = leaf;
    let index = size - 1;
    for (let level = 0; level < depth; level++) {
      this.levels[level][index] = node;
      if (index & 1) node = this.hash(this.levels[level][index - 1], node);
      index >>= 1;
    }
    this.levels[depth] = [node];
  }

  /** Compact proof of the leaf at `index`. */
  proof(index: number): LeanIMTProof {
    if (!Number.isInteger(index) || index < 0 || index >= this.size) {
      throw new RangeError('leaf index out of range');
    }
    const siblings: bigint[] = [];
    let pathBits = 0n;
    let i = index;
    for (let level = 0; level < this.depth; level++) {
      const nodes = this.levels[level];
      if (i & 1) {
        pathBits |= 1n << BigInt(siblings.length);
        siblings.push(nodes[i - 1]);
      } else if (i + 1 < nodes.length) {
        siblings.push(nodes[i + 1]);
      }
      i >>= 1;
    }
    return { root: this.root, leaf: this.levels[0][index], pathBits, siblings };
  }
}

/**
 * Verifies a compact lean-IMT proof by the guest's rules: at most 61
 * siblings, no path bit above the sibling count, and the Poseidon walk
 * reaches the root.
 */
export async function verifyLeanIMTProof(proof: LeanIMTProof): Promise<boolean> {
  const n = proof.siblings.length;
  if (n > MAX_CENSUS_DEPTH || proof.pathBits < 0n || proof.pathBits >> BigInt(n) !== 0n) {
    return false;
  }
  const canonical = (x: bigint) => x >= 0n && x < BN254_FR;
  if (!canonical(proof.leaf) || !canonical(proof.root)) return false;
  const h = await getPoseidon();
  let node = proof.leaf;
  try {
    proof.siblings.forEach((s, i) => {
      node = (proof.pathBits >> BigInt(i)) & 1n ? h.hash([s, node]) : h.hash([node, s]);
    });
  } catch {
    return false;
  }
  return node === proof.root;
}

const WEIGHT_LIMIT = 1n << BigInt(CENSUS_WEIGHT_BITS);

/** Merkle census leaf `(address << 88) | weight`; the weight must be below 2^88. */
export function censusLeaf(address: string, weight: bigint): bigint {
  if (weight < 0n || weight >= WEIGHT_LIMIT) {
    throw new RangeError(`weight does not fit in ${CENSUS_WEIGHT_BITS} bits`);
  }
  return (addressToField(address) << BigInt(CENSUS_WEIGHT_BITS)) | weight;
}

/** Weight part of a census leaf: its low 88 bits. */
export function censusLeafWeight(leaf: bigint): bigint {
  return leaf & (WEIGHT_LIMIT - 1n);
}

/** Address part of a census leaf (bits 88..247), as a lowercase `0x` address. */
export function censusLeafAddress(leaf: bigint): string {
  return bigIntToHex((leaf >> BigInt(CENSUS_WEIGHT_BITS)) & ((1n << 160n) - 1n), 20);
}

/** Domain tag of the Merkle ballot slot hash. */
export const SLOT_TAG = 'davinci-slot-v1';

/**
 * Ballot slot of a Merkle-census voter (origins 1..3):
 * `0x10 + (be64(sha256("davinci-slot-v1" || address)[0..8]) mod (2^63 - 16))`.
 * Distinct addresses can collide; a census must not hold two members with one slot.
 */
export function slotFromAddress(address: string): bigint {
  const digest = getBytes(sha256(concat([toUtf8Bytes(SLOT_TAG), parseHexBytes(address, 20)])));
  const x = bytesToBigInt(digest.slice(0, 8));
  return BALLOT_MIN + (x % (BALLOT_MAX - BALLOT_MIN + 1n));
}

/** Ballot slot of a CSP-census voter: `0x10 + index`, which must stay at or below `2^63 - 1`. */
export function slotFromCspIndex(index: bigint): bigint {
  if (index < 0n || BALLOT_MIN + index > BALLOT_MAX) {
    throw new RangeError('CSP index outside the ballot namespace');
  }
  return BALLOT_MIN + index;
}
