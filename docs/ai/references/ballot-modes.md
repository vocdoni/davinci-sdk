# `references/ballot-modes.md` — Voting systems and the ballot mode

Companion to the [[davinci-sdk]] skill. DAVINCI uses one parametric ballot circuit, `BallotProof(16)`, for every voting system. A ballot is up to 16 integers, one per **field**, and a handful of parameters, the **ballot mode**, say which ballots are valid. Single choice, approval, rating, ranking and quadratic voting are all settings of the same parameters.

## Presets

Pass an `electionPreset` instead of computing a ballot mode:

```ts
await sdk.createProcess({
  ...config,
  electionPreset: { type: 'quadratic', budget: 100 },
  questions: [
    {
      title: 'Fund these projects',
      choices: [
        { title: 'Park', value: 0 },
        { title: 'Library', value: 1 },
        { title: 'Bike lanes', value: 2 },
      ],
    },
  ],
});
```

The field count is `questions[0].choices.length`, at most 16. `electionPreset` and `ballot` exclude each other, and a preset needs the `questions` form (not `metadataUri`). The preset is stored in the metadata (`meta.electionPreset`); `getProcess` reads it back as `info.electionPreset`, and results use it to name the ballot kind.

| Preset | Options | Ballot mode (`numFields` = N) | A ballot |
| --- | --- | --- | --- |
| `single_choice` | `allowAbstain?` | values 0..1, sum 1 (0..1 with `allowAbstain`) | `[0, 1, 0]` |
| `multiple_choice` | `maxSelections`, `minSelections?` (0) | values 0..1, sum `minSelections..maxSelections` | `[1, 0, 1]` |
| `approval` | | values 0..1, sum 0..N | `[1, 1, 0]` |
| `rating` | `maxValue`, `minValue?` (0) | values `minValue..maxValue` | `[5, 2, 4]` |
| `ranking` | | values 1..N, all different, sum N(N+1)/2 | `[2, 1, 3]` (option 1 first) |
| `quadratic` | `budget`, `minValueSum?` (0) | values 0..budget, sum of squares `minValueSum..budget` | `[3, 0, 1]` costs 10 |

`resolveElectionPreset(preset, questions)` returns the raw ballot mode, to inspect it before creating.

## The ballot mode

```ts nocheck
interface BallotMode {
  numFields: number; // 1..16: the fields a voter fills
  minValue: string; // smallest value of a field
  maxValue: string; // largest value of a field, below 2^48
  uniqueValues: boolean; // every field holds a different value
  costExponent: number; // each value is raised to this in the sum below
  minValueSum: string; // least the sum may be
  maxValueSum: string; // most the sum may be, below 2^63; 0 makes the voter's weight the budget
  groupSize?: number; // at most numFields; defaults to numFields
}
```

A ballot `v[0..numFields)` is valid when every `minValue <= v[i] <= maxValue`, the values differ if `uniqueValues`, and `minValueSum <= Σ v[i]^costExponent <= maxValueSum`. Bounds are decimal strings; `numFields` and `costExponent` are numbers.

`createProcess` checks a mode before anything is sent (`ballotModeValues`), and refuses with `BallotModeError`, whose `registryError` names the registry's revert:

- `numFields` outside 1..16 (`InvalidMaxCount`), `groupSize` above `numFields` (`InvalidGroupSize`);
- a value bound of 2^48 or more, a sum bound of 2^63 or more (`BallotModeMaxValueTooLarge`, …);
- `minValue > maxValue` (`InvalidMaxMinValueBounds`), `minValueSum > maxValueSum` (`InvalidValueSumBounds`).

The registry also caps `maxValue * maxVoters` at 1e12 (`RESULT_CAP`): a mode with large values limits `maxVoters`.

## Raw modes per voting system

```ts
import type { BallotMode } from '@vocdoni/davinci-sdk';

const N = 4; // options, one field each

// Single choice: exactly one option. minValueSum '0' allows a blank ballot.
const singleChoice: BallotMode = {
  numFields: N,
  minValue: '0',
  maxValue: '1',
  uniqueValues: false,
  costExponent: 1,
  minValueSum: '1',
  maxValueSum: '1',
};

// Approval, capped: approve up to 3 options.
const approveUpTo3: BallotMode = { ...singleChoice, minValueSum: '0', maxValueSum: '3' };

// Ranking: a permutation of 1..N.
const ranking: BallotMode = {
  numFields: N,
  minValue: '1',
  maxValue: String(N),
  uniqueValues: true,
  costExponent: 1,
  minValueSum: String((N * (N + 1)) / 2),
  maxValueSum: String((N * (N + 1)) / 2),
};

// Quadratic: v votes on an option cost v²; 100 credits.
const quadratic: BallotMode = {
  numFields: N,
  minValue: '0',
  maxValue: '10',
  uniqueValues: false,
  costExponent: 2,
  minValueSum: '0',
  maxValueSum: '100',
};

// Budget: split 1,000 linearly, at most 500 on one option.
const budget: BallotMode = { ...quadratic, costExponent: 1, maxValue: '500', maxValueSum: '1000' };
```

Several questions share one ballot: give each question its own fields (the metadata choices' `value`s) and set the bounds for the whole ballot. The presets describe one question.

## Weights

The tally adds ballots up; census weights are **not** multiplied in. A weight changes a ballot only when the mode makes it the budget: with `maxValueSum: '0'` (and `minValueSum: '0'`), each voter's sum `Σ v[i]^costExponent` may reach its census weight.

```ts
import type { BallotMode } from '@vocdoni/davinci-sdk';

// Token-weighted: each voter spreads its weight over 3 options; a weight-40
// voter may send [40, 0, 0] or [25, 15, 0].
const weighted: BallotMode = {
  numFields: 3,
  minValue: '0',
  maxValue: '1000000', // at least the largest weight, to put it all on one option
  uniqueValues: false,
  costExponent: 1,
  minValueSum: '0',
  maxValueSum: '0',
};
```

- Size `maxValue` to the largest weight; with the result cap, `maxVoters` must stay at most `1e12 / maxValue`.
- The circuit compares the sum with the weight in 63 bits: a weight of 2^63 or more cannot vote. `createProcess` refuses such a Merkle census object.
- `sdk.getAddressWeight(processId, address)` tells a voter its budget.

With any other `maxValueSum`, every voter has the same bounds whatever its weight.

## Checking a ballot before voting

`submitVote` refuses choices outside the mode (`VoteError('invalid')`) before proving. To check in a UI:

```ts
import { ballotModeValues, checkBallot } from '@vocdoni/davinci-sdk';

const info = await sdk.getProcess(processId);
const { valid, error } = checkBallot([1n, 0n, 0n], ballotModeValues(info.ballot), 1n); // fields, mode, weight
```

## Reading results per kind

See `references/results.md`: the totals of a rating are sums of ratings, of a ranking sums of ranks (lower is preferred), of a quadratic ballot the votes each option got.

## Cross-references

- `references/process.md`: where `ballot` and `electionPreset` go.
- `references/voting.md`: the `choices` array.
- `references/results.md`: decoding the tally.
