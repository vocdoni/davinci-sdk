/**
 * @fileoverview The DKG point map and the organizer's Schnorr proof of
 * possession for DKG-locked processes, as davinci-zkvm `rust-sdk/src/dkg.rs`
 * computes them (and davinci-dkg's `DKGAppManager` verifies them).
 *
 * The DKG works on BabyJubJub in reduced twisted Edwards form (a = -1, gnark
 * and davinci-dkg), the rest of the protocol in circomlib TE form. The two are
 * related by `x_rte = x_te * (-f)`, `y_rte = y_te`.
 */

import { concat, getBytes, id, keccak256, randomBytes } from 'ethers';
import { BJJ_SUBGROUP_ORDER, BjjPoint, bjjIsOnCurve, bjjMulBase } from './babyjubjub';
import { BN254_FR, bigIntToBytes, bytesToBigInt, modInverse, parseHexBytes } from './field';

/** `-f mod p`, f the gnark/iden3 scaling factor. */
const NEG_F = 15527681003928902128179717624703512672403908117992798440346960750464748824729n;
const NEG_F_INV = modInverse(NEG_F);

/** `keccak256("davinci-dkg:organizer-register:v1")`, the organizer transcript domain. */
export const ORGANIZER_REGISTER_DOMAIN = id('davinci-dkg:organizer-register:v1');

/** Reduced TE coordinates of a circomlib TE point. */
export function pointToReducedTE(p: BjjPoint): BjjPoint {
  if (!bjjIsOnCurve(p)) throw new RangeError('point is not on the curve');
  return { x: (p.x * NEG_F) % BN254_FR, y: p.y };
}

/**
 * The circomlib TE point of reduced TE coordinates. Coordinates must be
 * canonical (below p) and the point on the curve.
 */
export function pointFromReducedTE(x: bigint, y: bigint): BjjPoint {
  if (x < 0n || x >= BN254_FR || y < 0n || y >= BN254_FR) {
    throw new RangeError('reduced TE coordinate is not below p');
  }
  const p = { x: (x * NEG_F_INV) % BN254_FR, y };
  if (!bjjIsOnCurve(p)) throw new RangeError('not on the TE curve');
  return p;
}

/**
 * A fresh organizer secret, uniform in `[1, L)`: 256 random bits per draw,
 * the top five cleared (L < 2^251), rejected until in range.
 */
export function randomOrganizerSecret(): bigint {
  for (;;) {
    const b = randomBytes(32);
    b[31] &= 0x07;
    const v = bytesToBigInt(b.reverse());
    if (v > 0n && v < BJJ_SUBGROUP_ORDER) return v;
  }
}

/** Inputs of the organizer proof of possession. */
export interface OrganizerProofParams {
  /** DKG epoch the process registers in (`adapter.registrationEpoch()`), `bytes12` hex. */
  epochId: string;
  /** Application id (`registry.aidFor(processId)`), `bytes32` hex or its integer. */
  aid: string | bigint;
  /** Organizer secret in `[1, L)`; never stored or logged. */
  secret: bigint;
  /** Schnorr witness in `[1, L)`; drawn fresh when omitted (tests pin it). */
  witness?: bigint;
}

/** The organizer key and proof, all reduced TE `uint256`s: `DKGParams` `orgPKx..popZ`. */
export interface OrganizerProof {
  pkX: bigint;
  pkY: bigint;
  aX: bigint;
  aY: bigint;
  z: bigint;
}

function assertScalar(v: bigint, what: string): void {
  if (v <= 0n || v >= BJJ_SUBGROUP_ORDER) throw new RangeError(`${what} not in [1, L)`);
}

/**
 * Proves possession of the organizer secret for a DKG-locked process:
 * `PK = sk*B8`, `A = w*B8` (both mapped to reduced TE),
 * `c = keccak256(domain || epochId12 || aid32 || PKx || PKy || Ax || Ay) mod L`,
 * `z = w + c*sk mod L`.
 */
export function proveOrganizerKey(p: OrganizerProofParams): OrganizerProof {
  assertScalar(p.secret, 'secret');
  const w = p.witness ?? randomOrganizerSecret();
  assertScalar(w, 'witness');
  const epochId = parseHexBytes(p.epochId, 12, 'epoch id');
  const aid =
    typeof p.aid === 'bigint' ? bigIntToBytes(p.aid, 32) : parseHexBytes(p.aid, 32, 'aid');
  const pk = pointToReducedTE(bjjMulBase(p.secret));
  const a = pointToReducedTE(bjjMulBase(w));
  const transcript = concat([
    getBytes(ORGANIZER_REGISTER_DOMAIN),
    epochId,
    aid,
    bigIntToBytes(pk.x),
    bigIntToBytes(pk.y),
    bigIntToBytes(a.x),
    bigIntToBytes(a.y),
  ]);
  const c = BigInt(keccak256(transcript)) % BJJ_SUBGROUP_ORDER;
  const z = (w + c * p.secret) % BJJ_SUBGROUP_ORDER;
  return { pkX: pk.x, pkY: pk.y, aX: a.x, aY: a.y, z };
}
