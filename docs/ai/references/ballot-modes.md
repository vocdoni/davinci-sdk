# `references/ballot-modes.md` — Configuring voting systems via the ballot mode

Companion to the [[davinci-sdk]] skill. Davinci uses **one parametric ballot circuit** for every voting system. A ballot is a fixed-length array of integers (`choices`), and a small set of parameters — the **ballot mode** — constrains what's valid. Approval, ranking, quadratic, multiple-choice, budget, and plain single-choice are all special cases of the same parameters. This file maps each voting system to a concrete `BallotMode`.

## The parameters (recap from `references/process.md`)

```ts
interface BallotMode {
  numFields: number;     // number of fields in the ballot (= choices.length)
  minValue: string;      // min value any field may take
  maxValue: string;      // max value any field may take
  uniqueValues: boolean; // if true, all field values must be distinct
  costExponent: number;  // exponent e in the cost sum below
  minValueSum: string;   // floor on Σ vᵢ^e
  maxValueSum: string;   // ceiling on Σ vᵢ^e
  groupSize?: number;    // optional; advanced grouping
}
```

A ballot `v = [v₁ … v_numFields]` is **valid** iff:

- `minValue ≤ vᵢ ≤ maxValue` for every field, and
- if `uniqueValues`, all `vᵢ` are distinct, and
- `minValueSum ≤ Σ vᵢ^costExponent ≤ maxValueSum`.

Invalid ballots are rejected by the circuit and never reach the tally. Results are accumulated field-by-field: `result[i]` is the weighted sum of `vᵢ` across all voters. (Bounds are strings; remember `choices` are `number`s within `[minValue, maxValue]`.)

## Encoding questions as fields

There are two idioms:

1. **One-hot options** (single/multiple/approval): one field per *option*; the value marks selection (`1`) or magnitude (weight / credits). Tally `result[i]` = total received by option *i*. This is what the SDK's examples use.
2. **Positional** (ranking): one field per *rank slot* or per *option*, the value is the rank.

For multi-question elections, concatenate the fields of each question and set `numFields` to the total.

## Recipes per voting system

### Single-choice, N options (one-hot)

Exactly one option gets `1`, the rest `0`.

```ts
ballot = { numFields: N, minValue: "0", maxValue: "1",
           uniqueValues: false, costExponent: 1, minValueSum: "1", maxValueSum: "1" };
// pick option j:  choices = one-hot(N, j)   e.g. N=4, j=2 → [0,0,1,0]
```

`maxValueSum: "1"` forces exactly one selection. Use `minValueSum:"0"` to allow abstaining (all zeros).

### Approval voting (pick any subset of N)

Each option is binary; approve as many as you like.

```ts
ballot = { numFields: N, minValue: "0", maxValue: "1",
           uniqueValues: false, costExponent: 1, minValueSum: "0", maxValueSum: String(N) };
// approve options 0 and 2 of 4:  choices = [1,0,1,0]
```

Cap approvals with a smaller `maxValueSum` (e.g. "pick up to 3" → `maxValueSum: "3"`).

### Multiple-choice (pick between min and max of N)

```ts
ballot = { numFields: N, minValue: "0", maxValue: "1", uniqueValues: false,
           costExponent: 1, minValueSum: String(min), maxValueSum: String(max) };
```

### Ranked voting (rank N options 1..N)

Fields hold a permutation of `1..N`; `uniqueValues` forbids ties.

```ts
ballot = { numFields: N, minValue: "1", maxValue: String(N), uniqueValues: true,
           costExponent: 1, minValueSum: String(N*(N+1)/2), maxValueSum: String(N*(N+1)/2) };
// rank: option0=2nd, option1=1st, option2=3rd → choices = [2,1,3]
```

The sum of `1..N` is fixed (`N(N+1)/2`), so pinning `min/maxValueSum` to it rejects partial rankings.

### Quadratic voting (allocate credits, quadratic cost)

`costExponent: 2` makes a field of value `v` cost `v²`; `maxValueSum` is the credit budget.

```ts
ballot = { numFields: N, minValue: "0", maxValue: String(maxCreditsPerOption),
           uniqueValues: false, costExponent: 2, minValueSum: "0", maxValueSum: String(budget) };
// spend on options: choices = [2,0,1,0] costs 2²+0+1²+0 = 5 credits
```

### Budget voting (allocate a budget linearly)

Like quadratic but `costExponent: 1` — the budget is the sum of allocations.

```ts
ballot = { numFields: N, minValue: "0", maxValue: String(maxPerOption),
           uniqueValues: false, costExponent: 1, minValueSum: "0", maxValueSum: String(budget) };
```

## Weighted voting

When the census assigns per-voter weights, the voter's weight scales their contribution. The SDK examples model this by putting the **weight** (not `1`) into the chosen one-hot field, and sizing the bounds accordingly:

```ts
const maxValue = String(maxOption * maxWeight);   // headroom for weight-scaled values
ballot = { numFields: N, minValue: "0", maxValue, uniqueValues: false,
           costExponent: 1, minValueSum: "0", maxValueSum: maxValue };
// a weight-5 voter picking option 1:  choices = [0,5,0,0]
```

The census provides the weight (`sdk.getAddressWeight`); the ballot/verifier circuits enforce that the value used matches the voter's authenticated weight. Size `maxValue`/`maxValueSum` to the largest weight you expect or the circuit will reject high-weight ballots.

## Practical defaults

- Start from single-choice or approval; reach for quadratic/ranked only when the user explicitly asks.
- `numFields` must equal `choices.length` at vote time — keep them in lockstep.
- Bounds are **strings**; `costExponent`/`numFields` are **numbers**.
- The tally `result[i]` is per **field**. For one-hot encodings that's per option; map back to your `questions[].choices` by index.

## Cross-references

- `references/process.md` — where `ballot` lives in `ProcessConfig`; reading `result`.
- `references/voting.md` — the `choices` array and range validation.
- `references/protocol.md` — the formal ballot-protocol definition this is drawn from.
