/**
 * A ballot mode as a process config gives it: the rules every ballot must
 * meet. `numFields` values `v[0..numFields)` are valid when each lies in
 * `[minValue, maxValue]`, they are all different if `uniqueValues`, and
 * `minValueSum <= sum(v[i] ** costExponent) <= maxValueSum`. A `maxValueSum`
 * of 0 makes each voter's census weight the budget. Bounds are decimal
 * strings (`ballotModeValues` reads them as bigints and checks the limits).
 */
export interface BallotMode {
  /** Ballot fields a voter fills, 1 to 16. */
  numFields: number;
  /**
   * Number of choices grouped per encrypted chunk.
   * Defaults to numFields when omitted.
   */
  groupSize?: number;
  /** Largest value of a field, below 2^48. */
  maxValue: string;
  /** Smallest value of a field. */
  minValue: string;
  /** Every field must hold a different value (a ranking). */
  uniqueValues: boolean;
  /** Exponent of each value in the sum the bounds apply to (2 for quadratic voting). */
  costExponent: number;
  /** Most the sum of `value ** costExponent` may reach, below 2^63; 0 makes the weight the budget. */
  maxValueSum: string;
  /** Least the sum of `value ** costExponent` must reach. */
  minValueSum: string;
}

/**
 * A BabyJubJub point as decimal coordinates.
 *
 * @deprecated Unused since 2.0: election keys are `BjjPoint`s (bigint coordinates).
 */
export interface EncryptionKey {
  x: string;
  y: string;
}
