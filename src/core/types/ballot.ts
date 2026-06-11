import { BallotMode } from './common';

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
 * `numFields` is derived from `questions[0].choices.length`. Throws if
 * the preset's invariants are violated (e.g., `maxSelections` exceeds
 * `numFields`, `rating.maxValue` not greater than `minValue`).
 *
 * Exposed for callers who need to compute the ballot mode separately
 * from process creation (e.g., to inspect it before submitting).
 */
export function resolveElectionPreset(
  preset: ElectionPreset,
  questions: ReadonlyArray<{ choices: ReadonlyArray<unknown> }>,
): BallotMode {
  if (!questions || questions.length === 0) {
    throw new Error(
      `electionPreset '${preset.type}' requires at least one question`,
    );
  }
  const numFields = questions[0]?.choices?.length ?? 0;
  if (numFields === 0) {
    throw new Error(
      `electionPreset '${preset.type}' requires questions[0].choices to be non-empty`,
    );
  }

  switch (preset.type) {
    case 'single_choice': {
      const minSum = preset.allowAbstain ? 0 : 1;
      return makeBallotMode(numFields, 0, 1, false, 1, minSum, 1);
    }
    case 'multiple_choice': {
      const min = preset.minSelections ?? 0;
      const max = preset.maxSelections;
      if (max < 1) {
        throw new Error(
          "electionPreset 'multiple_choice': maxSelections must be >= 1",
        );
      }
      if (max > numFields) {
        throw new Error(
          `electionPreset 'multiple_choice': maxSelections (${max}) cannot exceed numFields (${numFields})`,
        );
      }
      if (min < 0) {
        throw new Error(
          `electionPreset 'multiple_choice': minSelections (${min}) cannot be negative`,
        );
      }
      if (min > max) {
        throw new Error(
          `electionPreset 'multiple_choice': minSelections (${min}) cannot exceed maxSelections (${max})`,
        );
      }
      return makeBallotMode(numFields, 0, 1, false, 1, min, max);
    }
    case 'approval': {
      return makeBallotMode(numFields, 0, 1, false, 1, 0, numFields);
    }
    case 'rating': {
      const minVal = preset.minValue ?? 0;
      const maxVal = preset.maxValue;
      if (maxVal <= minVal) {
        throw new Error(
          `electionPreset 'rating': maxValue (${maxVal}) must be greater than minValue (${minVal})`,
        );
      }
      return makeBallotMode(
        numFields,
        minVal,
        maxVal,
        false,
        1,
        numFields * minVal,
        numFields * maxVal,
      );
    }
    case 'ranking': {
      const sum = (numFields * (numFields + 1)) / 2;
      return makeBallotMode(numFields, 1, numFields, true, 1, sum, sum);
    }
    case 'quadratic': {
      const budget = preset.budget;
      if (budget <= 0) {
        throw new Error(
          `electionPreset 'quadratic': budget (${budget}) must be > 0`,
        );
      }
      const minSum = preset.minValueSum ?? 0;
      if (minSum < 0) {
        throw new Error(
          `electionPreset 'quadratic': minValueSum (${minSum}) must be >= 0`,
        );
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
  maxValueSum: number,
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
 * Returns the preset when `metadata.type` carries one of the known
 * preset discriminator shapes (`{ type: 'single_choice' | ... }`).
 * Returns `undefined` for:
 * - Missing metadata or missing `type` field
 * - Legacy `ElectionResultsType` shape (`{ name, properties }`) from
 *   older SDK versions
 * - Any other unknown / malformed value
 *
 * This is a structural check, not a deep validator: a preset object
 * with the right discriminator but missing required sub-fields will
 * still be returned. Callers that need stricter guarantees should
 * validate the per-variant fields themselves.
 */
export function parseElectionPresetFromMetadata(
  metadata: { type?: unknown } | null | undefined,
): ElectionPreset | undefined {
  const t = metadata?.type;
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
