/**
 * @fileoverview Tracker proofs (recorded-as-cast): a sequencer's arbo
 * inclusion proof that a vote id is a leaf of the state tree whose root is on
 * chain. Port of davinci-sequencer `client/src/api.rs` `verify_tracker`.
 */

import { concat, getBytes, sha256 } from 'ethers';
import { bigIntToBytes, parseHexBytes } from './field';
import { SMT_LEVELS, VOTE_ID_MIN } from '../protocol/limits';

/** `GET /votes/{processId}/voteId/{voteId}/proof`, decoded. */
export interface TrackerProof {
  /** `0x` + 62 hex digits. */
  processId: string;
  voteId: bigint;
  /** The raw arbo root the proof reaches, as the registry stores `latestStateRoot`. */
  root: string;
  /** 32-byte siblings, root to leaf. */
  siblings: string[];
}

/** Arbo leaf hash of a vote id (value 0): `sha256(voteId_LE8 || 0^32 || 0x01)`. */
export function voteIdLeafHash(voteId: bigint): Uint8Array {
  const le8 = bigIntToBytes(voteId, 8).reverse();
  return getBytes(sha256(concat([le8, new Uint8Array(32), new Uint8Array([1])])));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Verifies a tracker proof against the root the registry holds. The proof
 * must name that root, carry at most 64 siblings and a vote id at or above
 * 2^63, and its walk must reach the root: nodes are `sha256(left || right)`
 * and bit `i` of the vote id (LSB first) puts the node at depth `i` on the right.
 *
 * Check it against the registry's `latestStateRoot`, never against the root
 * inside the proof alone.
 */
export function verifyTrackerProof(proof: TrackerProof, onchainRoot: string): boolean {
  let root: Uint8Array;
  let siblings: Uint8Array[];
  try {
    root = parseHexBytes(onchainRoot, 32, 'root');
    if (!equal(parseHexBytes(proof.root, 32, 'proof root'), root)) return false;
    siblings = proof.siblings.map(s => parseHexBytes(s, 32, 'sibling'));
  } catch {
    return false;
  }
  if (siblings.length > SMT_LEVELS || proof.voteId < VOTE_ID_MIN || proof.voteId >= 1n << 64n) {
    return false;
  }
  let node = voteIdLeafHash(proof.voteId);
  for (let i = siblings.length - 1; i >= 0; i--) {
    const pair = (proof.voteId >> BigInt(i)) & 1n ? [siblings[i], node] : [node, siblings[i]];
    node = getBytes(sha256(concat(pair)));
  }
  return equal(node, root);
}
