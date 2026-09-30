/**
 * @fileoverview What the live suite runs: each scenario's election, census
 * members, ballots and expected tally, and the public files `prepare`
 * writes to `test/e2e/fixtures/`. `prepare` and `run` both build the files
 * from here, so the documents the SDK publishes during a run are the
 * committed ones, byte for byte.
 */

import { sha256, type Wallet } from 'ethers';
import { OffchainCensus } from '../../src/census/classes/OffchainCensus';
import { OffchainDynamicCensus } from '../../src/census/classes/OffchainDynamicCensus';
import type { MerkleCensus } from '../../src/census/classes/MerkleCensus';
import { buildElectionMetadata, serializeMetadata } from '../../src/core/metadata';
import type { BallotMode } from '../../src/core/types/common';
import {
  ballotModeValues,
  resolveElectionPreset,
  type ElectionPreset,
} from '../../src/core/types/ballot';
import type { BallotModeValues } from '../../src/crypto/ballot';
import type { ElectionMetadataConfig, QuestionConfig } from '../../src/core/types/metadata';
import { NUM_FIELDS } from '../../src/protocol/limits';
import { walletsOf, type VoterKeys } from './voters';

/** Voter keys per scenario, for the censuses the suite publishes as files. */
export const VOTER_GROUPS = { s1: 8, s3: 7, s5: 2, s6: 2, s7: 2, s8: 1 } as const;

/** An election's metadata and ballot mode (a preset, or a raw mode). */
export interface ElectionSpec {
  title: string;
  description: string;
  questions: [QuestionConfig, ...QuestionConfig[]];
  electionPreset?: ElectionPreset;
  ballot?: BallotMode;
}

/** One ballot: the voter's index in its group and the value of each field. */
export interface PlannedBallot {
  voter: number;
  choices: number[];
}

const options = (...titles: string[]) => titles.map((title, value) => ({ title, value }));

// ─── 1: static census, sequencer key ────────────────────────────────

export const S1: ElectionSpec = {
  title: 'SDK live test 1: static census',
  description: 'Eight weighted voters rate four proposals from 0 to 5; one of them votes twice.',
  questions: [
    {
      title: 'Rate each proposal',
      choices: options('Bike lanes', 'Longer library hours', 'Tree planting', 'Night buses'),
    },
  ],
  electionPreset: { type: 'rating', maxValue: 5 },
};
export const S1_WEIGHTS = [1, 2, 3, 1, 2, 3, 1, 2];
export const S1_BALLOTS: PlannedBallot[] = [
  { voter: 0, choices: [1, 2, 3, 4] },
  { voter: 1, choices: [2, 2, 2, 2] },
  { voter: 2, choices: [3, 0, 5, 1] },
  { voter: 3, choices: [4, 4, 0, 0] },
  { voter: 4, choices: [5, 5, 5, 5] },
  { voter: 5, choices: [0, 1, 2, 3] },
  { voter: 6, choices: [1, 1, 1, 1] },
  { voter: 7, choices: [2, 3, 4, 5] },
];
/** Voter 0 changes its mind: the tally counts this one. */
export const S1_REVOTE: PlannedBallot = { voter: 0, choices: [5, 4, 3, 2] };

// ─── 2: CSP census ──────────────────────────────────────────────────

export const S2: ElectionSpec = {
  title: 'SDK live test 2: CSP census',
  description: 'Three voters attested by a census service provider pick one option each.',
  questions: [
    { title: 'Where should the next meetup be?', choices: options('Library', 'Park', 'Online') },
  ],
  electionPreset: { type: 'single_choice' },
};
export const S2_WEIGHTS = [1, 2, 3];
export const S2_BALLOTS: PlannedBallot[] = [
  { voter: 0, choices: [0, 1, 0] },
  { voter: 1, choices: [1, 0, 0] },
  { voter: 2, choices: [0, 1, 0] },
];

// ─── 3: updatable census ────────────────────────────────────────────

export const S3: ElectionSpec = {
  title: 'SDK live test 3: updatable census',
  description:
    'The census grows from four to six members while voting runs, and drops one whose ballot is pending.',
  questions: [
    {
      title: 'Which activities do you approve?',
      choices: options('Choir', 'Chess club', 'Hiking'),
    },
  ],
  electionPreset: { type: 'approval' },
};
/** Members of the first census; member 3 votes, then leaves. */
export const S3_FIRST = [0, 1, 2, 3];
/** Members after the update. */
export const S3_UPDATED = [0, 1, 2, 4, 5, 6];
/** Cast before the update; voter 3's must fail at seal time. */
export const S3_BEFORE: PlannedBallot[] = [
  { voter: 0, choices: [1, 1, 0] },
  { voter: 1, choices: [0, 1, 1] },
  { voter: 3, choices: [1, 0, 1] },
];
/** Cast by new members after the update. */
export const S3_AFTER: PlannedBallot[] = [
  { voter: 4, choices: [1, 1, 1] },
  { voter: 5, choices: [0, 0, 1] },
];

// ─── 4: on-chain census ─────────────────────────────────────────────

/** The census weight is each voter's budget: `maxValueSum` 0. */
export const S4: ElectionSpec = {
  title: 'SDK live test 4: on-chain census',
  description: 'Members of a census contract spread a budget equal to their weight.',
  questions: [
    {
      title: 'Share your budget among the projects',
      choices: options('Playground', 'Pool', 'Garden'),
    },
  ],
  ballot: {
    numFields: 3,
    groupSize: 3,
    maxValue: '5',
    minValue: '0',
    uniqueValues: false,
    costExponent: 1,
    maxValueSum: '0',
    minValueSum: '0',
  },
};
/** Members added before the process is created; the last joins while it runs. */
export const S4_WEIGHTS = [2, 3, 4];
export const S4_LATE_WEIGHT = 5;
export const S4_BALLOTS: PlannedBallot[] = [
  { voter: 0, choices: [1, 1, 0] },
  { voter: 1, choices: [0, 3, 0] },
  { voter: 2, choices: [2, 0, 2] },
  { voter: 3, choices: [1, 2, 2] },
];

// ─── 5, 6: DKG keys ─────────────────────────────────────────────────

export const S5: ElectionSpec = {
  title: 'SDK live test 5: committee key',
  description: 'Two voters spend a quadratic budget; the DKG committee decrypts the tally.',
  questions: [{ title: 'Allocate your votes', choices: options('Solar panels', 'Heat pumps') }],
  electionPreset: { type: 'quadratic', budget: 4 },
};
export const S5_BALLOTS: PlannedBallot[] = [
  { voter: 0, choices: [2, 0] },
  { voter: 1, choices: [1, 1] },
];

export const S6: ElectionSpec = {
  title: 'SDK live test 6: locked committee key',
  description: 'Two voters rank three candidates; the tally unlocks when the organizer reveals.',
  questions: [{ title: 'Rank the candidates', choices: options('Ada', 'Grace', 'Edsger') }],
  electionPreset: { type: 'ranking' },
};
export const S6_BALLOTS: PlannedBallot[] = [
  { voter: 0, choices: [1, 2, 3] },
  { voter: 1, choices: [2, 1, 3] },
];

// ─── 7: metadata ────────────────────────────────────────────────────

const S7_QUESTION: QuestionConfig = {
  title: 'Which days suit the clean-up?',
  choices: options('Saturday', 'Sunday', 'Monday'),
};

export const S7: ElectionSpec = {
  title: 'SDK live test 7: metadata',
  description: 'Draft: the date is still open.',
  questions: [S7_QUESTION],
  electionPreset: { type: 'multiple_choice', maxSelections: 2 },
};
/** The corrected document `setProcessMetadata` moves the process to. */
export const S7_UPDATE: ElectionMetadataConfig = {
  title: 'SDK live test 7: metadata, updated',
  description: 'Pick up to two days; the clean-up happens on the most voted.',
  questions: [S7_QUESTION],
  electionPreset: S7.electionPreset,
};
/**
 * Served at its own URL but registered with the hash of `S7_UPDATE`: a
 * tampered copy readers must refuse.
 */
export const S7_MISMATCH: ElectionMetadataConfig = {
  ...S7_UPDATE,
  questions: [{ ...S7_QUESTION, choices: options('Saturday', 'Sunday', 'Never') }],
};
export const S7_BALLOTS: PlannedBallot[] = [
  { voter: 0, choices: [1, 1, 0] },
  { voter: 1, choices: [0, 1, 1] },
];

// ─── 8: organizer refusals ──────────────────────────────────────────

export const S8: ElectionSpec = {
  title: 'SDK live test 8: organizer refusals',
  description: 'A process the organizer tries to change outside the rules; it is then canceled.',
  questions: [{ title: 'Keep the current schedule?', choices: options('Yes', 'No') }],
  electionPreset: { type: 'single_choice' },
};

// ─── Files ──────────────────────────────────────────────────────────

/** The metadata document the SDK builds for an election created from `spec`. */
export function metadataOf(spec: ElectionSpec): ElectionMetadataConfig {
  return {
    title: spec.title,
    description: spec.description,
    questions: spec.questions,
    electionPreset: spec.electionPreset,
  };
}

/** The exact bytes of a metadata document. */
export function metadataBytes(config: ElectionMetadataConfig): Uint8Array {
  return serializeMetadata(buildElectionMetadata(config));
}

function members<T extends MerkleCensus>(census: T, wallets: Wallet[], weights: number[]): T {
  census.add(wallets.map((w, i) => ({ key: w.address, weight: weights[i] ?? 1 })));
  return census;
}

/** The voters of every group. */
export type Voters = Record<keyof typeof VOTER_GROUPS, Wallet[]>;

/** The voters of every group, from the private keys. */
export function votersOf(keys: VoterKeys): Voters {
  const out = {} as Voters;
  for (const [group, count] of Object.entries(VOTER_GROUPS)) {
    out[group as keyof Voters] = walletsOf(keys, group, count);
  }
  return out;
}

const pick = (wallets: Wallet[], indexes: number[]) => indexes.map(i => wallets[i]);

/** Scenario 1's census. */
export const s1Census = (v: Voters) => members(new OffchainCensus(), v.s1, S1_WEIGHTS);
/** Scenario 3's first census. */
export const s3Census = (v: Voters) =>
  members(new OffchainDynamicCensus(), pick(v.s3, S3_FIRST), []);
/** Scenario 3's census after the update, built from scratch. */
export const s3UpdatedCensus = (v: Voters) =>
  members(new OffchainDynamicCensus(), pick(v.s3, S3_UPDATED), []);
/** The one-weight censuses of scenarios 5 to 8. */
export const plainCensus = (wallets: Wallet[]) => members(new OffchainCensus(), wallets, []);

/**
 * Every public file of the suite: census files (origins 1 and 2) and
 * metadata documents, by file name.
 */
export function fixtureFiles(v: Voters): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ['s1-census.json', s1Census(v).serialize()],
    ['s1-metadata.json', metadataBytes(metadataOf(S1))],
    ['s2-metadata.json', metadataBytes(metadataOf(S2))],
    ['s3-census.json', s3Census(v).serialize()],
    ['s3-census-updated.json', s3UpdatedCensus(v).serialize()],
    ['s3-metadata.json', metadataBytes(metadataOf(S3))],
    ['s4-metadata.json', metadataBytes(metadataOf(S4))],
    ['s5-census.json', plainCensus(v.s5).serialize()],
    ['s5-metadata.json', metadataBytes(metadataOf(S5))],
    ['s6-census.json', plainCensus(v.s6).serialize()],
    ['s6-metadata.json', metadataBytes(metadataOf(S6))],
    ['s7-census.json', plainCensus(v.s7).serialize()],
    ['s7-metadata.json', metadataBytes(metadataOf(S7))],
    ['s7-metadata-update.json', metadataBytes(S7_UPDATE)],
    ['s7-metadata-mismatch.json', metadataBytes(S7_MISMATCH)],
    ['s8-census.json', plainCensus(v.s8).serialize()],
    ['s8-metadata.json', metadataBytes(metadataOf(S8))],
  ]);
}

/** `0x` sha256 of a file. */
export const fileHash = (data: Uint8Array): string => sha256(data);

/** The ballot mode an election is created with. */
export function modeOf(spec: ElectionSpec): BallotModeValues {
  if (spec.ballot) return ballotModeValues(spec.ballot);
  if (!spec.electionPreset) throw new Error(`${spec.title}: no ballot mode`);
  return ballotModeValues(resolveElectionPreset(spec.electionPreset, spec.questions));
}

/** A ballot of the plan, with what it is checked against. */
export interface PlanEntry {
  scenario: string;
  mode: BallotModeValues;
  weight: bigint;
  choices: number[];
}

/** Every ballot the run casts and expects to count, or to be refused only by the census. */
export function plannedBallots(): PlanEntry[] {
  const of = (scenario: string, spec: ElectionSpec, ballots: PlannedBallot[], weights: number[]) =>
    ballots.map(b => ({
      scenario,
      mode: modeOf(spec),
      weight: BigInt(weights[b.voter] ?? 1),
      choices: b.choices,
    }));
  return [
    ...of('s1', S1, [...S1_BALLOTS, S1_REVOTE], S1_WEIGHTS),
    ...of('s2', S2, S2_BALLOTS, S2_WEIGHTS),
    ...of('s3', S3, [...S3_BEFORE, ...S3_AFTER], []),
    ...of('s4', S4, S4_BALLOTS, [...S4_WEIGHTS, S4_LATE_WEIGHT]),
    ...of('s5', S5, S5_BALLOTS, []),
    ...of('s6', S6, S6_BALLOTS, []),
    ...of('s7', S7, S7_BALLOTS, []),
  ];
}

/** The tally of the counted ballots: one total per ballot field (16). */
export function tally(ballots: readonly PlannedBallot[]): bigint[] {
  const totals = Array.from({ length: NUM_FIELDS }, () => 0n);
  for (const b of ballots) b.choices.forEach((c, i) => (totals[i] += BigInt(c)));
  return totals;
}
