/**
 * @fileoverview Census origins, census file members and the witnesses a
 * voter proves membership with.
 */

import type { LeanIMTProof } from '../crypto/census';
import type { CspAttestation } from '../crypto/ecdsa';

/** Where a process's census lives (the registry's `CensusOrigin`). */
export enum CensusOrigin {
  /**
   * Static Merkle census: a lean-IMT root fixed at creation. Nodes download
   * the census file at `censusURI` and rebuild the tree.
   */
  OffchainStatic = 1,
  /**
   * Updatable Merkle census: like the static one, but the organizer can
   * replace its root and URI (`setProcessCensus`) until the end.
   */
  OffchainDynamic = 2,
  /**
   * An append-only census contract (davinci-onchain-census-contract, the
   * davinci-zkvm branch). Nodes build the tree from its `CensusMemberAdded`
   * logs; the registry accepts any root it recorded since the process began.
   */
  Onchain = 3,
  /**
   * A credential service provider: a secp256k1 key signs one attestation per
   * voter, and its Ethereum address is the census root. The registry keeps
   * the historical name `CSP_EDDSA_BABYJUBJUB_V1` for this origin.
   */
  CSP = 4,
}

/** A member of a census file: `key` a lowercase `0x` address, `weight` a decimal integer. */
export interface CensusParticipant {
  key: string;
  weight: string;
}

/**
 * How a member of a Merkle census (origins 1 to 3) votes: its weight, and
 * optionally its lean-IMT proof. Nodes derive the proof from their own tree
 * and ignore the one sent, so the weight is what matters.
 */
export interface MerkleCensusWitness {
  type: 'merkle';
  /** The member's census weight, below 2^88. */
  weight: bigint;
  /** Proof of the member's leaf `(address << 88) | weight`. */
  proof?: LeanIMTProof;
}

/** How a member of a CSP census votes: the CSP's attestation for its address, weight and index. */
export interface CspCensusWitness {
  type: 'csp';
  attestation: CspAttestation;
}

/** A voter's census witness, by the kind of census. */
export type CensusWitness = MerkleCensusWitness | CspCensusWitness;

/** What a census witness provider is asked for. */
export interface CensusWitnessRequest {
  processId: string;
  /** The voter's address. */
  address: string;
  /** The process's census as the registry stores it. */
  origin: CensusOrigin;
  /** `bytes32` hex: the lean-IMT root, or the CSP address. */
  censusRoot: string;
  /** The census contract of an on-chain census. */
  contractAddress?: string;
}

/** Supplies a Merkle-census witness (origins 1 to 3). */
export type MerkleWitnessProvider = (request: CensusWitnessRequest) => Promise<MerkleCensusWitness>;

/** Supplies the CSP attestation of a voter (origin 4), from the CSP. */
export type CspWitnessProvider = (request: CensusWitnessRequest) => Promise<CspAttestation>;

/** Census witness providers for the vote flow. */
export interface CensusProviders {
  /** Replaces the default Merkle witness (the nodes' participants endpoint or the census contract). */
  merkle?: MerkleWitnessProvider;
  /** Asks the CSP for a voter's attestation; required to vote in a CSP census. */
  csp?: CspWitnessProvider;
}
