/**
 * @fileoverview The voter-side check of a census witness, as
 * davinci-sequencer `client/src/voter.rs` (`census_wire`) makes it before a
 * vote is built: the witness must be this voter's and for the census the
 * registry stores, or the node refuses the vote.
 */

import { getAddress } from 'ethers';
import { censusLeaf, slotFromCspIndex, verifyLeanIMTProof } from '../crypto/census';
import { recoverCspSigner } from '../crypto/ecdsa';
import type { CensusProofWire } from '../sequencer/api/types';
import { CensusWitnessError } from './errors';
import { CensusOrigin, type CensusWitness } from './types';

/** The census a witness is checked against: the registry's, never a node's. */
export interface WitnessContext {
  processId: string;
  census: {
    origin: CensusOrigin | number;
    /** `bytes32` hex or the integer: the lean-IMT root, or the CSP address. */
    root: string | bigint;
  };
}

/** A checked witness: the weight to vote with and the census proof the vote carries. */
export interface CheckedWitness {
  weight: bigint;
  /** Required for a CSP census; a Merkle proof when the witness had one (nodes ignore it). */
  censusProof?: CensusProofWire;
}

const MAX_WIRE_INDEX = BigInt(Number.MAX_SAFE_INTEGER);

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function leafOf(address: string, weight: bigint): bigint {
  try {
    return censusLeaf(address, weight);
  } catch (err) {
    throw new CensusWitnessError(`census weight ${weight} does not fit in 88 bits`, err);
  }
}

/**
 * Checks `witness` is `address`'s, for the census of `process`, and returns
 * what the vote carries.
 *
 * - Merkle (origins 1 to 3): a proof, when given, must be of the voter's leaf
 *   `(address << 88) | weight` and verify; for origins 1 and 2 its root must
 *   be the registry's (an on-chain census moves on, so origin 3 is not pinned).
 * - CSP (origin 4): the attestation must recover to the census root (the CSP
 *   address), cover `address`, and carry an index whose slot exists and that
 *   fits a JSON number.
 *
 * @throws CensusWitnessError naming what does not match
 */
export async function checkCensusWitness(
  process: WitnessContext,
  address: string,
  witness: CensusWitness
): Promise<CheckedWitness> {
  const voter = getAddress(address);
  const origin = Number(process.census.origin) as CensusOrigin;
  const root = BigInt(process.census.root);
  if (witness.type === 'merkle') {
    if (origin < CensusOrigin.OffchainStatic || origin > CensusOrigin.Onchain) {
      throw new CensusWitnessError(`a Merkle witness for a census of origin ${origin}`);
    }
    const leaf = leafOf(voter, witness.weight);
    const { proof } = witness;
    if (!proof) return { weight: witness.weight };
    if (
      proof.leaf !== leaf ||
      (origin !== CensusOrigin.Onchain && proof.root !== root) ||
      !(await verifyLeanIMTProof(proof))
    ) {
      throw new CensusWitnessError('the census proof is not for this voter and census');
    }
    return { weight: witness.weight, censusProof: { type: 'merkle', ...proof } };
  }
  if (witness.type !== 'csp') {
    throw new CensusWitnessError('unknown census witness');
  }
  if (origin !== CensusOrigin.CSP) {
    throw new CensusWitnessError(`a CSP attestation for a census of origin ${origin}`);
  }
  const a = witness.attestation;
  let signer: string;
  try {
    signer = recoverCspSigner(process.processId, a);
  } catch (err) {
    throw new CensusWitnessError(`the CSP attestation does not recover: ${message(err)}`, err);
  }
  // The root is the CSP address as an integer, so its upper 96 bits are zero.
  if (getAddress(a.address) !== voter || root !== BigInt(signer)) {
    throw new CensusWitnessError('the CSP attestation is not for this voter and census');
  }
  try {
    slotFromCspIndex(a.index);
  } catch (err) {
    throw new CensusWitnessError(`CSP index ${a.index} is outside the ballot slots`, err);
  }
  if (a.index > MAX_WIRE_INDEX) {
    throw new CensusWitnessError(`CSP index ${a.index} does not fit a JSON number`);
  }
  leafOf(voter, a.weight);
  return {
    weight: a.weight,
    censusProof: { type: 'csp', r: a.r, s: a.s, recid: a.recid, index: a.index },
  };
}
