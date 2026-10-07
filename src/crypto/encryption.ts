/**
 * @fileoverview Exponential ElGamal on BabyJubJub (TE form, generator B8), as
 * the ballot circuit and davinci-zkvm `crypto/elgamal.rs` compute it.
 */

import { randomBytes } from 'ethers';
import { BJJ_IDENTITY, BjjPoint, bjjAdd, bjjIsIdentity, bjjMul, bjjMulBase } from './babyjubjub';
import { BN254_FR, bytesToBigInt } from './field';

/** An ElGamal ciphertext `(c1, c2) = (k*B8, m*B8 + k*pk)`. */
export interface ElGamalCiphertext {
  c1: BjjPoint;
  c2: BjjPoint;
}

/** `((0,1),(0,1))`: the value of every padded ballot field. */
export const IDENTITY_CIPHERTEXT: Readonly<ElGamalCiphertext> = Object.freeze({
  c1: BJJ_IDENTITY,
  c2: BJJ_IDENTITY,
});

/** True for the identity ciphertext `((0,1),(0,1))`. */
export function isIdentityCiphertext(c: ElGamalCiphertext): boolean {
  return bjjIsIdentity(c.c1) && bjjIsIdentity(c.c2);
}

/** Encrypts `m` under `pk` with randomness `k`: `(k*B8, m*B8 + k*pk)`. */
export function elgamalEncrypt(pk: BjjPoint, m: bigint, k: bigint): ElGamalCiphertext {
  if (m < 0n) throw new RangeError('message must be non-negative');
  return { c1: bjjMulBase(k), c2: bjjAdd(bjjMulBase(m), bjjMul(pk, k)) };
}

/**
 * A fresh ballot secret `k`: 64 random bytes read little-endian and reduced
 * mod p, like davinci-sequencer `voter::random_k` (uniform up to 2^-250).
 * Draw one for every ballot, revotes included: a `k` must never encrypt two
 * ballots (see `encryptBallot`).
 */
export function randomBallotSecret(): bigint {
  return bytesToBigInt(randomBytes(64).reverse()) % BN254_FR;
}
