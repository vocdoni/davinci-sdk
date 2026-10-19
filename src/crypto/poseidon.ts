/**
 * @fileoverview iden3/circomlib Poseidon over BN254 (widths 1..16), as
 * davinci-zkvm `crypto/poseidon.rs` computes it.
 */

import { buildPoseidon } from 'circomlibjs';
import { assertFieldElement } from './field';

/** A synchronous Poseidon hasher, available once the circomlibjs build has loaded. */
export interface PoseidonHasher {
  /** Poseidon of 1..16 field elements. */
  hash(inputs: readonly bigint[]): bigint;
}

interface CircomPoseidon {
  (inputs: bigint[]): unknown;
  F: { toObject(x: unknown): bigint };
}

let hasher: Promise<PoseidonHasher> | undefined;

/** Loads circomlibjs' Poseidon once and returns a synchronous hasher. */
export function getPoseidon(): Promise<PoseidonHasher> {
  hasher ??= (buildPoseidon as () => Promise<CircomPoseidon>)().then(p => {
    const hash = (inputs: readonly bigint[]): bigint => {
      if (inputs.length === 0 || inputs.length > 16) {
        throw new RangeError(`poseidon takes 1..16 inputs, got ${inputs.length}`);
      }
      inputs.forEach((x, i) => assertFieldElement(x, `poseidon input ${i}`));
      return p.F.toObject(p([...inputs]));
    };
    return { hash };
  });
  hasher.catch(() => {
    hasher = undefined;
  });
  return hasher;
}

/**
 * Poseidon hash of 1..16 field elements (iden3, initial state 0).
 *
 * @example
 * ```typescript
 * await poseidon([1n, 2n]);
 * ```
 */
export async function poseidon(inputs: readonly bigint[]): Promise<bigint> {
  return (await getPoseidon()).hash(inputs);
}
