import { BallotMode } from './common';
import { type BallotModeValues, packBallotMode } from '../../crypto/ballot';
import { MAX_VALUE_BITS, NUM_FIELDS, VALUE_SUM_BITS } from '../../protocol/limits';

/**
 * A ballot mode the registry or the `BallotProof(16)` circuit refuses.
 * `registryError` names the registry's revert for the same rule, when it has one.
 */
export class BallotModeError extends RangeError {
  constructor(
    message: string,
    public readonly registryError?: string
  ) {
    super(message);
    this.name = 'BallotModeError';
  }
}

// A bound of a ballot mode: a decimal string, a safe integer or a bigint.
function modeBound(v: unknown, what: string): bigint {
  if (typeof v === 'bigint' && v >= 0n) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v);
  throw new BallotModeError(`ballot mode: ${what} ${String(v)} is not a non-negative integer`);
}

function modeByte(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
    throw new BallotModeError(`ballot mode: ${what} ${String(v)} is not an integer in 0..255`);
  }
  return v;
}

/**
 * The registry form of a ballot mode (integer bounds, `groupSize` defaulting
 * to `numFields`), checked against what the registry and the ballot circuit
 * accept: 1 to 16 fields, `groupSize <= numFields`, value bounds below 2^48,
 * sum bounds below 2^63, `minValue <= maxValue` and
 * `minValueSum <= maxValueSum`. A `maxValueSum` of 0 makes each voter's census
 * weight the budget, so `minValueSum` must be 0 too.
 *
 * @throws BallotModeError naming the rule, and the registry's revert for it
 *
 * @example
 * ```typescript
 * const mode = ballotModeValues(resolveElectionPreset({ type: 'approval' }, questions));
 * ```
 */
export function ballotModeValues(mode: BallotMode): BallotModeValues {
  const numFields = mode.numFields;
  if (!Number.isInteger(numFields) || numFields < 1 || numFields > NUM_FIELDS) {
    throw new BallotModeError(
      `ballot mode: numFields ${String(numFields)} is not in 1..${NUM_FIELDS} ` +
        `(the ballot circuit has ${NUM_FIELDS} fields)`,
      'InvalidMaxCount'
    );
  }
  const groupSize = modeByte(mode.groupSize ?? numFields, 'groupSize');
  if (groupSize > numFields) {
    throw new BallotModeError(
      `ballot mode: groupSize ${groupSize} exceeds numFields ${numFields}`,
      'InvalidGroupSize'
    );
  }
  if (typeof mode.uniqueValues !== 'boolean') {
    throw new BallotModeError(
      `ballot mode: uniqueValues ${String(mode.uniqueValues)} is not a boolean`
    );
  }
  const values: BallotModeValues = {
    numFields,
    groupSize,
    uniqueValues: mode.uniqueValues,
    costExponent: modeByte(mode.costExponent, 'costExponent'),
    maxValue: modeBound(mode.maxValue, 'maxValue'),
    minValue: modeBound(mode.minValue, 'minValue'),
    maxValueSum: modeBound(mode.maxValueSum, 'maxValueSum'),
    minValueSum: modeBound(mode.minValueSum, 'minValueSum'),
  };
  const tooLarge: [bigint, number, string, string][] = [
    [values.maxValue, MAX_VALUE_BITS, 'maxValue', 'BallotModeMaxValueTooLarge'],
    [values.minValue, MAX_VALUE_BITS, 'minValue', 'BallotModeMinValueTooLarge'],
    [values.maxValueSum, VALUE_SUM_BITS, 'maxValueSum', 'BallotModeMaxValueSumTooLarge'],
    [values.minValueSum, VALUE_SUM_BITS, 'minValueSum', 'BallotModeMinValueSumTooLarge'],
  ];
  for (const [v, bits, what, revert] of tooLarge) {
    if (v >> BigInt(bits) !== 0n) {
      throw new BallotModeError(`ballot mode: ${what} ${v} does not fit in ${bits} bits`, revert);
    }
  }
  if (values.minValue > values.maxValue) {
    throw new BallotModeError(
      `ballot mode: minValue ${values.minValue} exceeds maxValue ${values.maxValue}`,
      'InvalidMaxMinValueBounds'
    );
  }
  if (values.minValueSum > values.maxValueSum) {
    throw new BallotModeError(
      `ballot mode: minValueSum ${values.minValueSum} exceeds maxValueSum ${values.maxValueSum}` +
        (values.maxValueSum === 0n ? ' (a zero maxValueSum makes the weight the budget)' : ''),
      'InvalidValueSumBounds'
    );
  }
  packBallotMode(values);
  return values;
}

// A preset parameter: a non-negative safe integer.
function presetInt(preset: string, what: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new BallotModeError(
      `electionPreset '${preset}': ${what} (${String(v)}) must be an integer`
    );
  }
  return v;
}

/**
 * Discriminator strings for {@link ElectionPreset}.
 */
export type ElectionPresetType =
  | 'single_choice'
  | 'multiple_choice'
  | 'approval'
  | 'rating'
  | 'ranking'
  | 'quadratic';

/**
 * Discriminated union of election preset configurations.
 *
 * Pass one of these as the `electionPreset` field on a process config
 * instead of computing a raw {@link BallotMode} by hand. The SDK
 * resolves the preset into the underlying `BallotMode` using the choice
 * count of the first question (`questions[0].choices.length`) as
 * `numFields`. `electionPreset` and `ballot` are mutually exclusive on
 * `ProcessConfig`.
 *
 * Parameter mappings follow the canonical DAVINCI ballot protocol.
 */
export type ElectionPreset =
  /**
   * Single-choice voting. Each voter selects exactly one option.
   * If `allowAbstain` is true, voters may submit a ballot with zero
   * selections.
   *
   * BallotMode: (minValue, maxValue) = (0, 1), uniqueValues = false,
   * costExponent = 1, (minValueSum, maxValueSum) = (allowAbstain ? 0 : 1, 1).
   */
  | { type: 'single_choice'; allowAbstain?: boolean }
  /**
   * Multiple-choice voting. Voters select between `minSelections` and
   * `maxSelections` options. `minSelections` defaults to 0.
   *
   * BallotMode: (minValue, maxValue) = (0, 1), uniqueValues = false,
   * costExponent = 1, (minValueSum, maxValueSum) = (minSelections ?? 0, maxSelections).
   */
  | { type: 'multiple_choice'; maxSelections: number; minSelections?: number }
  /**
   * Approval voting. Voters independently approve any subset of options
   * (each option is 0 or 1, no upper limit on approvals).
   *
   * BallotMode: (minValue, maxValue) = (0, 1), uniqueValues = false,
   * costExponent = 1, (minValueSum, maxValueSum) = (0, numFields).
   */
  | { type: 'approval' }
  /**
   * Rating voting. Voters rate each option within a fixed range.
   * `minValue` defaults to 0.
   *
   * BallotMode: (minValue, maxValue) = (minValue ?? 0, maxValue),
   * uniqueValues = false, costExponent = 1,
   * (minValueSum, maxValueSum) = (numFields * (minValue ?? 0), numFields * maxValue).
   */
  | { type: 'rating'; maxValue: number; minValue?: number }
  /**
   * Ranking voting. Voters assign a unique rank from 1 to `numFields`
   * to each option (an exact permutation).
   *
   * BallotMode: (minValue, maxValue) = (1, numFields), uniqueValues = true,
   * costExponent = 1, minValueSum = maxValueSum = numFields * (numFields + 1) / 2.
   */
  | { type: 'ranking' }
  /**
   * Quadratic voting. Voters distribute a fixed `budget` across options;
   * the cost of placing `v` votes on an option is `v ** 2`. `minValueSum`
   * defaults to 0 (no minimum spend).
   *
   * BallotMode: (minValue, maxValue) = (0, budget), uniqueValues = false,
   * costExponent = 2, (minValueSum, maxValueSum) = (minValueSum ?? 0, budget).
   */
  | { type: 'quadratic'; budget: number; minValueSum?: number };

/**
 * Resolve an {@link ElectionPreset} into a complete {@link BallotMode}.
 *
 * `numFields` is derived from `questions[0].choices.length`, at most 16 (the
 * ballot circuit's fields). Throws if the preset's invariants are violated
 * (e.g., `maxSelections` exceeds `numFields`, `rating.maxValue` not greater
 * than `minValue`), if a parameter is not an integer, or if the mode falls
 * outside what the registry and the circuit accept ({@link ballotModeValues}:
 * values below 2^48, so a `rating.maxValue` or a quadratic `budget` of 2^48
 * or more is refused).
 *
 * Exposed for callers who need to compute the ballot mode separately
 * from process creation (e.g., to inspect it before submitting).
 */
export function resolveElectionPreset(
  preset: ElectionPreset,
  questions: ReadonlyArray<{ choices: ReadonlyArray<unknown> }>
): BallotMode {
  if (!questions || questions.length === 0) {
    throw new Error(`electionPreset '${preset.type}' requires at least one question`);
  }
  const numFields = questions[0]?.choices?.length ?? 0;
  if (numFields === 0) {
    throw new Error(
      `electionPreset '${preset.type}' requires questions[0].choices to be non-empty`
    );
  }
  if (numFields > NUM_FIELDS) {
    throw new BallotModeError(
      `electionPreset '${preset.type}': questions[0] has ${numFields} choices; ` +
        `the ballot circuit has ${NUM_FIELDS} fields`,
      'InvalidMaxCount'
    );
  }
  const mode = presetMode(preset, numFields);
  ballotModeValues(mode);
  return mode;
}

function presetMode(preset: ElectionPreset, numFields: number): BallotMode {
  const int = (what: string, v: unknown) => presetInt(preset.type, what, v);

  switch (preset.type) {
    case 'single_choice': {
      const minSum = preset.allowAbstain ? 0 : 1;
      return makeBallotMode(numFields, 0, 1, false, 1, minSum, 1);
    }
    case 'multiple_choice': {
      const min = int('minSelections', preset.minSelections ?? 0);
      const max = int('maxSelections', preset.maxSelections);
      if (max < 1) {
        throw new Error("electionPreset 'multiple_choice': maxSelections must be >= 1");
      }
      if (max > numFields) {
        throw new Error(
          `electionPreset 'multiple_choice': maxSelections (${max}) cannot exceed numFields (${numFields})`
        );
      }
      if (min < 0) {
        throw new Error(
          `electionPreset 'multiple_choice': minSelections (${min}) cannot be negative`
        );
      }
      if (min > max) {
        throw new Error(
          `electionPreset 'multiple_choice': minSelections (${min}) cannot exceed maxSelections (${max})`
        );
      }
      return makeBallotMode(numFields, 0, 1, false, 1, min, max);
    }
    case 'approval': {
      return makeBallotMode(numFields, 0, 1, false, 1, 0, numFields);
    }
    case 'rating': {
      const minVal = int('minValue', preset.minValue ?? 0);
      const maxVal = int('maxValue', preset.maxValue);
      if (minVal < 0) {
        throw new Error(`electionPreset 'rating': minValue (${minVal}) must be >= 0`);
      }
      if (maxVal <= minVal) {
        throw new Error(
          `electionPreset 'rating': maxValue (${maxVal}) must be greater than minValue (${minVal})`
        );
      }
      return makeBallotMode(
        numFields,
        minVal,
        maxVal,
        false,
        1,
        numFields * minVal,
        numFields * maxVal
      );
    }
    case 'ranking': {
      const sum = (numFields * (numFields + 1)) / 2;
      return makeBallotMode(numFields, 1, numFields, true, 1, sum, sum);
    }
    case 'quadratic': {
      const budget = int('budget', preset.budget);
      if (budget <= 0) {
        throw new Error(`electionPreset 'quadratic': budget (${budget}) must be > 0`);
      }
      const minSum = int('minValueSum', preset.minValueSum ?? 0);
      if (minSum < 0) {
        throw new Error(`electionPreset 'quadratic': minValueSum (${minSum}) must be >= 0`);
      }
      return makeBallotMode(numFields, 0, budget, false, 2, minSum, budget);
    }
    default: {
      const exhaustive: never = preset;
      throw new Error(`Unknown electionPreset: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function makeBallotMode(
  numFields: number,
  minValue: number,
  maxValue: number,
  uniqueValues: boolean,
  costExponent: number,
  minValueSum: number,
  maxValueSum: number
): BallotMode {
  return {
    numFields,
    groupSize: numFields,
    maxValue: String(maxValue),
    minValue: String(minValue),
    uniqueValues,
    costExponent,
    maxValueSum: String(maxValueSum),
    minValueSum: String(minValueSum),
  };
}

/**
 * Extract an {@link ElectionPreset} from an off-chain metadata object.
 *
 * Returns the preset when `metadata.meta.electionPreset` carries one of
 * the known preset discriminator shapes (`{ type: 'single_choice' | ... }`).
 * Returns `undefined` for:
 * - Missing metadata, missing `meta`, or missing `electionPreset` field
 * - Any unknown / malformed value
 *
 * This is a structural check, not a deep validator: a preset object
 * with the right discriminator but missing required sub-fields will
 * still be returned. Callers that need stricter guarantees should
 * validate the per-variant fields themselves.
 */
export function parseElectionPresetFromMetadata(
  metadata: { meta?: { electionPreset?: unknown } } | null | undefined
): ElectionPreset | undefined {
  const t = metadata?.meta?.electionPreset;
  if (!t || typeof t !== 'object') return undefined;
  const candidate = t as { type?: string };
  switch (candidate.type) {
    case 'single_choice':
    case 'multiple_choice':
    case 'approval':
    case 'rating':
    case 'ranking':
    case 'quadratic':
      return t as ElectionPreset;
    default:
      return undefined;
  }
}
