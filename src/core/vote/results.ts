/**
 * @fileoverview A process's results: the tally the registry stores, read per
 * ballot kind, and where a process stands on the way to it.
 *
 * The tally is additive: `result[i]` is the sum of field `i` over the latest
 * ballot of every voter (the census weight bounds a ballot's values when
 * `maxValueSum` is 0; it does not multiply them). How to read the sums
 * depends on the ballot kind.
 */

import type { KeyMode } from '../../contracts/types';
import type { BallotModeValues } from '../../crypto/ballot';
import type { ProcessInfo } from '../process/ProcessOrchestrationService';
import { ballotModeValues, resolveElectionPreset, type ElectionPresetType } from '../types/ballot';

/**
 * What a tally's numbers mean: one of the SDK's election presets, or
 * `custom` for any other ballot mode (a weight budget, several questions).
 */
export type BallotKind = ElectionPresetType | 'custom';

/** One choice of a question: its ballot field and that field's total. */
export interface ChoiceResult {
  /** The ballot field (the metadata's choice `value`). */
  field: number;
  /** The choice's title, from the verified metadata. */
  title?: string;
  /** The field's total over every counted ballot. */
  total: bigint;
  /**
   * `total / voters`, null with no voters. Per kind: the share of ballots
   * that chose it (`single_choice`, `multiple_choice`, `approval`), the mean
   * rating (`rating`), the mean rank, lower being preferred (`ranking`), or
   * the mean votes it got (`quadratic`).
   */
  mean: number | null;
}

/** The results of one question. */
export interface QuestionResult {
  /** From the verified metadata. */
  title?: string;
  choices: ChoiceResult[];
}

/** A process's tally, read per ballot kind. */
export interface ProcessResults {
  processId: string;
  /** How to read the totals; see {@link ChoiceResult.mean}. */
  kind: BallotKind;
  /** One total per ballot field, as the registry stores them. */
  values: bigint[];
  /** Ballots counted: the voters whose latest ballot is in the tally. */
  voters: number;
  /**
   * Per question of the verified metadata, each choice with its field's
   * total; without verified metadata, one untitled question with every field.
   */
  questions: QuestionResult[];
}

/** What {@link decodeResults} reads: a `ProcessInfo` (`getProcess`) has it all. */
export type ResultsSource = Pick<
  ProcessInfo,
  'processId' | 'ballot' | 'result' | 'votersCount' | 'questions' | 'electionPreset'
>;

/**
 * Where a process stands on the way to its results:
 *
 * - `voting`: before the end (upcoming, open or paused).
 * - `grace`: past the end, while the grace window still records batches of
 *   votes cast before it; every landing pushes the window out.
 * - `awaiting-key-holder`: a sequencer key, the window has closed; only the
 *   node that issued the key can prove and publish the tally.
 * - `awaiting-request`: a DKG key, the window has closed; no node has asked
 *   the committee to decrypt yet (they do on their first heartbeat after it).
 * - `locked`: a DKG-locked key the organizer has not revealed: nothing is
 *   decrypted until `revealProcessKey`.
 * - `awaiting-opening`: a COUNCIL key whose ceremony has not opened
 *   decryption: the results stay locked until the committee may decrypt
 *   them, on the scheduled date or when the organizer opens it
 *   (`decryptionOpening`). Even a tally of zeros waits; nodes publish it
 *   once the gate opens.
 * - `decrypting`: the committee is combining its decryption shares.
 * - `finalizable`: the committee's plaintexts are ready; the first
 *   `finalizeResultsFromDKG` (anyone may send it) stores them.
 * - `results`: the tally is on-chain.
 * - `canceled`: no results will be set.
 */
export type ResultsState =
  | 'voting'
  | 'grace'
  | 'awaiting-key-holder'
  | 'awaiting-request'
  | 'locked'
  | 'awaiting-opening'
  | 'decrypting'
  | 'finalizable'
  | 'results'
  | 'canceled';

/** A process's {@link ResultsState} as read from the chain. */
export interface ResultsStatus {
  processId: string;
  state: ResultsState;
  keyMode: KeyMode;
  /** When the grace window closes and results unlock; null when it never does. */
  graceEnd: Date | null;
  /** The chain head's time the state was read at. */
  chainTime: Date;
  /** The decoded tally, in state `results`. */
  results?: ProcessResults;
  /**
   * In state `awaiting-opening`: how the Council ceremony opens decryption.
   * `scheduled` opens by itself at `opensAt`. `manual` opens when the
   * ceremony's organizer opens it, or by itself at `opensAt` (its fallback
   * date) when it has one; `opensAt` is null without a fallback.
   */
  decryptionOpening?: { mode: 'scheduled' | 'manual'; opensAt: Date | null };
}

const sameMode = (a: BallotModeValues, b: BallotModeValues) =>
  a.numFields === b.numFields &&
  a.groupSize === b.groupSize &&
  a.uniqueValues === b.uniqueValues &&
  a.costExponent === b.costExponent &&
  a.maxValue === b.maxValue &&
  a.minValue === b.minValue &&
  a.maxValueSum === b.maxValueSum &&
  a.minValueSum === b.minValueSum;

/**
 * The ballot kind a mode reads as, from its parameters alone: the modes the
 * SDK's presets produce (`resolveElectionPreset`), else `custom`. Presets
 * with the same parameters read the same way: a rating from 0 to 1 is an
 * approval, a multiple choice of at most one a single choice.
 */
export function ballotKindOf(mode: BallotModeValues): BallotKind {
  const n = BigInt(mode.numFields);
  const { minValue, maxValue, minValueSum, maxValueSum, costExponent, uniqueValues } = mode;
  // No ballot meets a floor above the ceiling: no preset reads so.
  if (minValueSum > maxValueSum) return 'custom';
  if (costExponent === 1 && !uniqueValues && minValue === 0n && maxValue === 1n) {
    if (maxValueSum === 1n) return 'single_choice';
    if (maxValueSum === n && minValueSum === 0n) return 'approval';
    if (maxValueSum > 1n && maxValueSum <= n) return 'multiple_choice';
  }
  const ranks = (n * (n + 1n)) / 2n;
  if (
    costExponent === 1 &&
    uniqueValues &&
    minValue === 1n &&
    maxValue === n &&
    minValueSum === ranks &&
    maxValueSum === ranks
  ) {
    return 'ranking';
  }
  if (costExponent === 2 && !uniqueValues && minValue === 0n && maxValue === maxValueSum) {
    if (maxValue > 0n) return 'quadratic';
  }
  if (
    costExponent === 1 &&
    !uniqueValues &&
    maxValue > minValue &&
    maxValueSum === n * maxValue &&
    minValueSum === n * minValue
  ) {
    return 'rating';
  }
  return 'custom';
}

/**
 * Reads a process's tally per ballot kind. The kind is the metadata's
 * election preset when it yields the on-chain ballot mode, else what the
 * mode's parameters read as ({@link ballotKindOf}). Choices come from the
 * verified metadata (`questions`), each on the field its `value` names.
 *
 * @param info - `getProcess(processId)` of a process with results
 * @throws RangeError when the process has no results yet
 *
 * @example
 * ```typescript
 * const results = decodeResults(await sdk.getProcess(processId));
 * for (const q of results.questions) {
 *   for (const c of q.choices) console.log(c.title, c.total, c.mean);
 * }
 * ```
 */
export function decodeResults(info: ResultsSource): ProcessResults {
  const mode = ballotModeValues(info.ballot);
  const values = [...info.result];
  if (values.length !== mode.numFields) {
    throw new RangeError(
      `process ${info.processId} has no results yet (${values.length} values for ${mode.numFields} fields)`
    );
  }
  let kind = ballotKindOf(mode);
  if (info.electionPreset) {
    try {
      const preset = ballotModeValues(resolveElectionPreset(info.electionPreset, info.questions));
      if (sameMode(preset, mode)) kind = info.electionPreset.type;
    } catch {
      // A preset that does not fit the questions says nothing about the mode.
    }
  }
  const voters = info.votersCount;
  const choice = (field: number, title?: string): ChoiceResult => ({
    field,
    ...(title !== undefined && { title }),
    total: values[field],
    mean: voters > 0 ? Number(values[field]) / voters : null,
  });
  const questions: QuestionResult[] =
    info.questions.length > 0
      ? info.questions.map(q => ({
          ...(q.title !== '' && { title: q.title }),
          choices: q.choices
            .filter(c => Number.isInteger(c.value) && c.value >= 0 && c.value < mode.numFields)
            .map(c => choice(c.value, c.title)),
        }))
      : [{ choices: values.map((_, i) => choice(i)) }];
  return { processId: info.processId, kind, values, voters, questions };
}
