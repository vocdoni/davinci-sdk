/**
 * @fileoverview The sequencer HTTP API types, decoded (davinci-sequencer
 * `client/src/api.rs`). On the wire field names are camelCase, field
 * elements decimal strings, bytes `0x` hex, vote ids `0x` + 16 hex digits and
 * points twisted Edwards `{x, y}`; here they are bigints and checked points.
 * Hex values are lowercase with `0x`, addresses checksummed.
 */

import type { BjjPoint } from '../../crypto/babyjubjub';
import type { Ballot, BallotModeValues } from '../../crypto/ballot';
import type { LeanIMTProof } from '../../crypto/census';
import type { Groth16Proof } from '../types';

/** `GET /info`. */
export interface SequencerInfo {
  /** Settling account; null for an observer node. */
  sequencerAddress: string | null;
  chainId: number;
  /** The `ProcessRegistry` the node follows. */
  processRegistry: string;
  /** sha256 of the ballot proof VK wire bytes the node verifies with. */
  ballotVkHash: string;
  batchProgramVk: string;
  resultsProgramVk: string;
  /** An observer never settles, takes no votes and issues no keys. */
  observer: boolean;
  settledBySelf: number;
  syncedFromOthers: number;
  /** Batches lost to another sequencer settling first. */
  lostRaces: number;
}

/** The registry status of a process as a node reports it; `unknown` when it never read it. */
export type SequencerProcessStatus =
  | 'ready'
  | 'ended'
  | 'canceled'
  | 'paused'
  | 'results'
  | 'unknown';

/** Census of a process as a node reports it. */
export interface CensusView {
  /** 1 static Merkle, 2 dynamic Merkle, 3 on-chain contract, 4 CSP. */
  censusOrigin: number;
  /** Lean-IMT root, or the CSP address as an integer. */
  censusRoot: bigint;
  censusURI: string;
}

/**
 * `GET /processes/{processId}`: the on-chain parameters plus the node's own
 * view. A voter takes the key, ballot mode and census from the registry and
 * only cross-checks them against this (see `checkProcessView`).
 */
export interface ProcessView {
  /** `0x` + 62 hex digits. */
  id: string;
  status: SequencerProcessStatus;
  /** False before the start time and from the end on. */
  isAcceptingVotes: boolean;
  organizationId: string;
  encryptionKey: BjjPoint;
  ballotMode: BallotModeValues;
  census: CensusView;
  /** Latest settled state root (raw arbo digest). */
  stateRoot: string;
  /** The node's committed tree root; may lead `stateRoot` while a transition is in flight. */
  localStateRoot?: string;
  /** The node's committed root equals the on-chain root. */
  synced: boolean;
  votersCount: number;
  overwrittenVotesCount: number;
  maxVoters: number;
  /** Unix seconds. */
  startTime: number;
  /** Seconds. */
  duration: number;
  /** The tally, once the results are on-chain. */
  result?: number[];
  /** The node refused to serve the process. */
  ignored: boolean;
  /** Why, when `ignored`. */
  note?: string;
}

/** `GET /processes/{processId}/participants/{address}`, with its proof checked. */
export interface ParticipantResponse {
  address: string;
  weight: bigint;
  censusProof: LeanIMTProof;
}

/** `GET /votes/{processId}/address/{address}`: the (re-encrypted) ballot in the voter's slot. */
export interface BallotResponse {
  address: string;
  ballot: Ballot;
}

/** One settled transition of a node's archive. */
export interface TransitionView {
  index: number;
  oldRoot: string;
  newRoot: string;
  txHash: string;
  blockNumber: number;
  sender: string;
  voters: number;
  overwrites: number;
  nBlobs: number;
}

/**
 * Vote lifecycle: `pending` (queued), `aggregated` (in a batch being proved),
 * `processed` (proved, settlement pending), `settled` (on-chain), or `error`.
 */
export enum VoteStatus {
  Pending = 'pending',
  Aggregated = 'aggregated',
  Processed = 'processed',
  Settled = 'settled',
  Error = 'error',
}

/** `GET /votes/{processId}/voteId/{voteId}`. */
export interface VoteStatusResponse {
  status: VoteStatus;
  /** Why, for status `error`: a guest fail bit, `process closed`, a settlement revert or a prover refusal. */
  error?: string;
}

/** A Merkle (lean-IMT) census proof in a vote. The node re-derives it and ignores this one. */
export interface MerkleProofWire extends LeanIMTProof {
  type: 'merkle';
}

/** A CSP attestation in a vote; it covers the vote's `address` and `weight`. */
export interface CspProofWire {
  type: 'csp';
  /** `0x` + 64 hex digits. */
  r: string;
  /** `0x` + 64 hex digits. */
  s: string;
  /** Recovery id. */
  recid: number;
  /** CSP-chosen index; the slot is `0x10 + index`. Travels as a JSON number, so at most 2^53 - 1. */
  index: bigint;
}

/** A vote's census proof, tagged by `type`: required for a CSP census, optional for a Merkle one. */
export type CensusProofWire = MerkleProofWire | CspProofWire;

/** `POST /votes` body. */
export interface VoteRequest {
  /** `0x` + 62 hex digits. */
  processId: string;
  address: string;
  /** At least 2^63. */
  voteId: bigint;
  /** Exactly 16 ciphertexts; fields at or above `numFields` hold the identity. */
  ballot: Ballot;
  /** snarkjs Groth16 proof of `BallotProof(16)`. */
  ballotProof: Groth16Proof;
  ballotInputsHash: bigint;
  /** 65 bytes `r || s || v`, personal-sign over the vote id. */
  signature: string;
  /** The census weight, below 2^128 (a usable one is below 2^88). */
  weight: bigint;
  censusProof?: CensusProofWire;
}

/** One member of a census file. */
export interface CensusFileParticipant {
  /** Voter address. */
  key: string;
  weight: bigint;
}

/** The census file served at `censusURI`: `{"participants": [{"key", "weight"}]}`, leaves in order. */
export interface CensusFile {
  participants: CensusFileParticipant[];
}
