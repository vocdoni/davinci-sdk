/**
 * @fileoverview Vote requests built by hand from the SDK's primitives, so a test
 * controls every field: the ballot is built and proved by the SDK (`buildBallot`,
 * the pinned circuit), the vote signed by the voter, the CSP attestation signed
 * by a CSP key drawn in the test, and the request encoded as the node reads it
 * (`encodeVoteRequest`). Variants change one thing on purpose: the signature
 * spelling (high-S, v 27/28), the attestation's process, address, weight or index,
 * or the weight the proof was made for.
 */

import { Signature, concat, getBytes, type BaseWallet } from 'ethers';
import { buildBallot, type BallotModeValues, type BuiltBallot } from '../../../src/crypto/ballot';
import type { BjjPoint } from '../../../src/crypto/babyjubjub';
import { cspAttestationMessage, signVote } from '../../../src/crypto/ecdsa';
import { randomBallotSecret } from '../../../src/crypto/encryption';
import { bigIntToHex } from '../../../src/crypto/field';
import { formatVoteId } from '../../../src/sequencer/api/helpers';
import type { VoteRequest } from '../../../src/sequencer/api/types';
import { encodeVoteRequest } from '../../../src/sequencer/api/wire';
import type { Groth16Proof } from '../../../src/sequencer/types';
import type { Live } from './live';

/** secp256k1 group order. */
export const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** BN254 base field (proof coordinates). */
export const BN254_FQ =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

/** What a vote is checked against: the registry's view of the process. */
export interface ProcessCtx {
  processId: string;
  encryptionKey: BjjPoint;
  ballotMode: BallotModeValues;
  origin: number;
}

export async function processCtx(live: Live, processId: string): Promise<ProcessCtx> {
  const p = await live.sdk.registry.getProcess(processId);
  return {
    processId,
    encryptionKey: p.encryptionKey,
    ballotMode: p.ballotMode,
    origin: Number(p.census.origin),
  };
}

/** A low-S secp256k1 signature, `recid` 0 or 1. */
export interface Sig {
  r: string;
  s: string;
  recid: 0 | 1;
}

/** How a signature is spelled on the wire. */
export type Spelling = 'low' | 'high-s' | 'v27';

function spell(sig: Sig, how: Spelling): { r: string; s: string; v: number } {
  if (how === 'high-s') {
    return { r: sig.r, s: bigIntToHex(SECP_N - BigInt(sig.s)), v: sig.recid ^ 1 };
  }
  return { r: sig.r, s: sig.s, v: how === 'v27' ? sig.recid + 27 : sig.recid };
}

/**
 * A CSP's signature over `(processId, address, weight, index)`, any weight below
 * 2^128 (the SDK's signer stops at 2^88, a test needs one past it).
 */
export async function cspSign(
  csp: BaseWallet,
  processId: string,
  address: string,
  weight: bigint,
  index: bigint
): Promise<Sig> {
  const raw = Signature.from(
    await csp.signMessage(cspAttestationMessage(processId, address, weight, index))
  );
  let s = BigInt(raw.s);
  let recid = (raw.v - 27) as 0 | 1;
  if (s > SECP_N >> 1n) {
    s = SECP_N - s;
    recid = (recid ^ 1) as 0 | 1;
  }
  return { r: raw.r, s: bigIntToHex(s), recid };
}

/** The CSP part of a vote. */
export interface CspSpec {
  signer: BaseWallet;
  index: bigint;
  /** What the attestation covers, when it is not the vote's own. */
  processId?: string;
  address?: string;
  weight?: bigint;
  spelling?: Spelling;
}

export interface DraftSpec {
  label: string;
  voter: BaseWallet;
  choices: (number | bigint)[];
  weight: bigint;
  /** Ballot secret; default a fresh one. Reusing one repeats the vote id. */
  k?: bigint;
  csp?: CspSpec;
  /** The vote signature's spelling. */
  sigSpelling?: Spelling;
  /** The weight the ballot is proved for, when not the vote's own. */
  proveWeight?: bigint;
  /** Reuse this draft's ballot and proof (a weight past the circuit's, a replay). */
  proofFrom?: Draft;
}

/** A vote ready to send: the request body and what it stands for. */
export interface Draft {
  label: string;
  processId: string;
  address: string;
  voteId: string;
  weight: bigint;
  choices: bigint[];
  /** The ballot slot: `csp:<index>` or `addr:<address>`. */
  slot: string;
  /** The exact JSON body. */
  body: Record<string, unknown>;
  built: Pick<BuiltBallot, 'ballot' | 'voteId'>;
  proof: Groth16Proof;
  /** Ballot secret, kept in memory only. */
  k: bigint;
}

/** Builds, proves and signs a vote for `ctx`, then encodes it. */
export async function draft(live: Live, ctx: ProcessCtx, d: DraftSpec): Promise<Draft> {
  const address = await d.voter.getAddress();
  const k = d.k ?? randomBallotSecret();
  let built: Pick<BuiltBallot, 'ballot' | 'voteId'>;
  let proof: Groth16Proof;
  if (d.proofFrom) {
    built = d.proofFrom.built;
    proof = d.proofFrom.proof;
  } else {
    const b = await buildBallot({
      processId: ctx.processId,
      address,
      encryptionKey: ctx.encryptionKey,
      ballotMode: ctx.ballotMode,
      fields: d.choices,
      weight: d.proveWeight ?? d.weight,
      k,
    });
    proof = (await live.sdk.proveBallot(b)).proof;
    built = b;
  }
  const sig = await signVote(d.voter, ctx.processId, built.voteId, built.ballot);
  const vs = spell({ r: sig.r, s: sig.s, recid: sig.v }, d.sigSpelling ?? 'low');
  let censusProof: VoteRequest['censusProof'];
  let slot = `addr:${address.toLowerCase()}`;
  if (d.csp) {
    const c = d.csp;
    const a = await cspSign(
      c.signer,
      c.processId ?? ctx.processId,
      c.address ?? address,
      c.weight ?? d.weight,
      c.index
    );
    const cs = spell(a, c.spelling ?? 'low');
    censusProof = { type: 'csp', r: cs.r, s: cs.s, recid: cs.v, index: c.index };
    slot = `csp:${c.index}`;
  }
  const request: VoteRequest = {
    processId: ctx.processId,
    address,
    voteId: built.voteId,
    ballot: built.ballot,
    ballotProof: proof,
    signature: concat([getBytes(vs.r), getBytes(vs.s), new Uint8Array([vs.v])]),
    weight: d.weight,
    ...(censusProof && { censusProof }),
  };
  return {
    label: d.label,
    processId: ctx.processId,
    address,
    voteId: formatVoteId(built.voteId),
    weight: d.weight,
    choices: d.choices.map(BigInt),
    slot,
    body: encodeVoteRequest(request),
    built,
    proof,
    k,
  };
}

/** A deep copy of a body, to mutate. */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
