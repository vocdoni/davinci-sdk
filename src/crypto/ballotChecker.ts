/**
 * @fileoverview The value checks of the davinci-circom `BallotProof(16)`
 * circuit (`CheckBallotMode` in `ballot_protocol.circom` and the 48-bit
 * message decomposition in `lib/elgamal.circom`), so a ballot the prover
 * would reject fails before proving. The value bounds are evaluated in the
 * field like the circuit; the cost is compared as an integer, which is what
 * the circuit's 89-bit comparators do for every mode the registry accepts.
 */

import { BallotModeValues, packBallotMode } from './ballot';
import { BN254_FR, mod } from './field';
import { CENSUS_WEIGHT_BITS, MAX_VALUE_BITS, NUM_FIELDS } from '../protocol/limits';

/** Outcome of {@link checkBallot}. */
export interface BallotCheckResult {
  valid: boolean;
  /** Why the circuit would reject the ballot. */
  error?: string;
}

// circomlib LessThan(n): Num2Bits(n+1) of `a + 2^n - b` must hold (the value
// fits in n+1 bits) and the result is `a < b`. Null when unsatisfiable.
function lessThan(a: bigint, b: bigint, n: number): boolean | null {
  const x = mod(a + (1n << BigInt(n)) - b, BN254_FR);
  if (x >> BigInt(n + 1) !== 0n) return null;
  return (x >> BigInt(n)) & 1n ? false : true;
}

/**
 * Checks the voter's choices against the ballot mode and weight exactly as
 * the circuit constrains them: at most `numFields` values (missing ones are
 * zero), every value below 2^48, the active ones within
 * `[minValue, maxValue]`, pairwise distinct when `uniqueValues`, and the
 * cost `sum(value^costExponent)` within `[minValueSum, maxValueSum]`, where a
 * zero `maxValueSum` means the voter's weight (below 2^88). The registry
 * keeps `numFields * maxValue^costExponent` below 2^63, so the circuit's
 * field sum is the integer cost and its comparators are exact.
 *
 * @example
 * ```typescript
 * const r = checkBallot([1, 0, 1], mode, 1n);
 * if (!r.valid) throw new Error(r.error);
 * ```
 */
export function checkBallot(
  fields: readonly (bigint | number)[],
  mode: BallotModeValues,
  weight: bigint
): BallotCheckResult {
  const fail = (error: string): BallotCheckResult => ({ valid: false, error });
  try {
    packBallotMode(mode);
  } catch (e) {
    return fail((e as Error).message);
  }
  const nf = mode.numFields;
  if (nf > NUM_FIELDS) return fail(`numFields ${nf} exceeds ${NUM_FIELDS}`);
  if (fields.length > nf) return fail(`${fields.length} values for ${nf} fields`);
  if (weight < 0n || weight >> BigInt(CENSUS_WEIGHT_BITS) !== 0n) {
    return fail(`weight does not fit in ${CENSUS_WEIGHT_BITS} bits`);
  }

  const values: bigint[] = [];
  for (let i = 0; i < NUM_FIELDS; i++) {
    const v = BigInt(fields[i] ?? 0);
    if (v < 0n || v >> BigInt(MAX_VALUE_BITS) !== 0n) {
      return fail(`field ${i} is not below 2^${MAX_VALUE_BITS}`);
    }
    values.push(v);
  }
  const active = values.slice(0, nf);

  if (mode.uniqueValues) {
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        if (active[i] === active[j]) return fail(`fields ${i} and ${j} repeat a value`);
      }
    }
  }

  for (let i = 0; i < NUM_FIELDS; i++) {
    const above = lessThan(mode.maxValue, values[i], MAX_VALUE_BITS);
    const below = lessThan(values[i], mode.minValue, MAX_VALUE_BITS);
    if (above === null || below === null) return fail(`field ${i} is out of the comparator range`);
    if (i < nf && above) return fail(`field ${i} is above maxValue ${mode.maxValue}`);
    if (i < nf && below) return fail(`field ${i} is below minValue ${mode.minValue}`);
  }

  const exp = BigInt(mode.costExponent);
  const cost = active.reduce((acc, v) => acc + v ** exp, 0n);
  const max = mode.maxValueSum === 0n ? weight : mode.maxValueSum;
  if (cost > max) {
    const bound = mode.maxValueSum === 0n ? `the weight ${weight}` : `maxValueSum ${max}`;
    return fail(`total cost ${cost} exceeds ${bound}`);
  }
  if (cost < mode.minValueSum) {
    return fail(`total cost ${cost} is below minValueSum ${mode.minValueSum}`);
  }
  return { valid: true };
}
