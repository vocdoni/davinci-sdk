# `references/process.md` — Creating & managing a process, reading results

Companion to the [[davinci-sdk]] skill. A **process** is one election. This file covers `createProcess`, its config shape, the lifecycle methods, and `getProcess` / result reading — all on the `DavinciSDK` facade. All of these require a **signer with a provider** (see `references/setup.md`).

## Create a process

```ts
const result = await sdk.createProcess(config);  // Promise<ProcessCreationResult>
// result = { processId: string, transactionHash: string }
```

The facade does everything: validates timing, computes the next `processId`, auto-publishes the census if needed, uploads metadata, fetches the per-process encryption key from the sequencer, and sends the on-chain create transaction.

### `ProcessConfig`

```ts
interface ProcessConfig {
  // Census: a Census object (recommended) OR manual { type, root, size, uri }.
  census: Census | { type: CensusOrigin; root: string; size: number; uri: string };

  ballot: BallotMode;                 // the voting rules — see references/ballot-modes.md

  timing: {
    startDate?: Date | string | number;  // default: now + 60s
    duration?: number;                    // seconds — use this OR endDate, not both
    endDate?: Date | string | number;     // alternative to duration
  };

  maxVoters?: number;                 // see "the maxVoters rule" below

  // EITHER inline metadata (uploaded for you) …
  title?: string;
  description?: string;
  questions?: [ProcessQuestion, ...ProcessQuestion[]];   // ≥1 required in this form
  // … OR a pre-uploaded metadata URI:
  metadataUri?: string;
}

type ProcessQuestion = {
  title: string;
  description?: string;
  choices: Array<{ title: string; value: number }>;
};
```

`ProcessConfig` is a union: provide **either** `title`+`questions` (the SDK builds & uploads `ElectionMetadata` for you) **or** a `metadataUri` you uploaded yourself. You cannot mix `duration` and `endDate`.

### `BallotMode` (the `ballot` field)

```ts
interface BallotMode {
  numFields: number;        // number of ballot fields; choices.length must equal this
  groupSize?: number;       // optional grouping (advanced)
  minValue: string;         // min value per field (decimal STRING)
  maxValue: string;         // max value per field (decimal STRING)
  uniqueValues: boolean;    // all field values must differ (ranking)
  costExponent: number;     // exponent in the cost sum (2 = quadratic)
  minValueSum: string;      // floor on Σ value^costExponent (decimal STRING)
  maxValueSum: string;      // ceiling on Σ value^costExponent (decimal STRING)
}
```

> Bounds are **decimal strings**, not numbers — bigint-safe JSON. `numFields`/`costExponent` are plain `number`. How to set these for approval/ranked/quadratic/budget/single/multiple choice is in `references/ballot-modes.md`.

### The `maxVoters` rule

`maxVoters` caps how many voters the process accepts. When you can omit it vs must supply it:

| Census you pass                              | `maxVoters` |
| -------------------------------------------- | ----------- |
| Published `OffchainCensus`/`OffchainDynamicCensus` (Merkle) | **Optional** — defaults to the participant count |
| `OnchainCensus` (token / on-chain)           | **Required** |
| `CspCensus`                                  | **Required** |
| `PublishedCensus`                            | **Required** |
| Manual `{ type, root, size, uri }`           | **Required** |

Omitting it when required throws: *"maxVoters is required…"*. See `references/census.md`.

### Timing notes

- `startDate` defaults to **now + 60 seconds**; a start date more than 30s in the past throws.
- Accepts `Date`, ISO string, or Unix timestamp (seconds; values > 1e10 are treated as ms and divided).
- Give `duration` (seconds) **or** `endDate`, never both. `endDate` must be after `startDate`.

### Minimal example

```ts
import { OffchainCensus } from "@vocdoni/davinci-sdk";

const census = new OffchainCensus();
census.add(["0xAaa…", "0xBbb…", "0xCcc…"]);

const { processId, transactionHash } = await sdk.createProcess({
  title: "Community Decision",
  description: "What should we build next?",
  census,                                            // auto-published; maxVoters auto
  ballot: {
    numFields: 3, minValue: "0", maxValue: "1",
    uniqueValues: false, costExponent: 1, minValueSum: "0", maxValueSum: "1",
  },
  timing: { startDate: new Date(Date.now() + 60_000), duration: 3600 * 24 },
  questions: [{
    title: "Which initiative?",
    choices: [
      { title: "Garden",   value: 0 },
      { title: "Workshop", value: 1 },
      { title: "Gallery",  value: 2 },
    ],
  }],
});
```

## Real-time creation: `createProcessStream`

For UIs that show transaction progress, use the streaming variant. It yields `TxStatusEvent`s:

```ts
import { TxStatus } from "@vocdoni/davinci-sdk";

let processId = "";
for await (const event of sdk.createProcessStream(config)) {
  switch (event.status) {
    case TxStatus.Pending:   console.log("submitted:", event.hash); break;
    case TxStatus.Completed: processId = event.response.processId;   // + event.response.transactionHash
                             break;
    case TxStatus.Failed:    throw event.error;
    case TxStatus.Reverted:  throw new Error(`reverted: ${event.reason}`);
  }
}
```

`createProcess(config)` is exactly this loop consumed for you, returning `{ processId, transactionHash }`. Use the plain method for scripts; the stream for progress UX.

## Lifecycle

Every lifecycle method has a plain (`Promise<void>`) form and a `…Stream` form yielding `TxStatusEvent`s. All require a signer with a provider, and revert if you're not the process organizer or the transition is invalid.

```ts
await sdk.endProcess(processId);        // → status ENDED (stops accepting votes; triggers tally)
await sdk.pauseProcess(processId);      // → status PAUSED
await sdk.resumeProcess(processId);     // PAUSED → READY (resume a paused process)
await sdk.cancelProcess(processId);     // → status CANCELED (abandon; no results)
await sdk.setProcessMaxVoters(processId, 750);   // change the voter cap

// streaming equivalents: endProcessStream, pauseProcessStream, resumeProcessStream,
// cancelProcessStream, setProcessMaxVotersStream — same TxStatusEvent shape as above.
```

`ProcessStatus` (contract enum — note the values):

```ts
enum ProcessStatus { READY = 0, ENDED = 1, CANCELED = 2, PAUSED = 3, RESULTS = 4 }
```

A process becomes accepting-votes once it is `READY` **and** its `startDate` has passed; check `sdk.api.sequencer.getProcess(id).isAcceptingVotes` (see `references/sequencer.md`). After `endProcess`, the sequencer computes the final tally and the contract moves to `RESULTS`.

## Read a process & results: `getProcess`

```ts
const info = await sdk.getProcess(processId);   // Promise<ProcessInfo>
```

```ts
interface ProcessInfo {
  processId: string;
  title: string;
  description?: string;
  census: { type: CensusOrigin; root: string; uri: string };
  ballot: BallotMode;
  questions: ProcessQuestion[];

  status: ProcessStatus;          // READY/ENDED/CANCELED/PAUSED/RESULTS
  creator: string;                // the organizer's address
  startDate: Date;
  endDate: Date;
  duration: number;               // seconds
  timeRemaining: number;          // seconds (0 if ended, negative if not started)
  maxVoters: number;

  result: bigint[];               // tally — one entry per ballot field
  votersCount: number;            // votes cast
  overwrittenVotesCount: number;  // overwrites (last-vote-wins)
  metadataURI: string;
  raw?: any;                      // raw contract struct, for advanced use

  electionPreset?: ElectionPreset; // preset used at creation, if any (round-tripped via metadata.meta.electionPreset)
}
```

`getProcess` reads the contract and fetches metadata, so it needs a provider. For a lightweight, provider-free read (status, `isAcceptingVotes`, `votersCount`, encryption key), use `sdk.api.sequencer.getProcess(processId)` — see `references/sequencer.md`.

### Reading the tally

`result` is a `bigint[]`, **one entry per ballot field** (not per question, not per choice — though for one-hot single-choice questions each field *is* a choice). Each entry is the weighted sum of that field's values across all voters.

```ts
const info = await sdk.getProcess(processId);
// e.g. one question "favourite colour" encoded as 4 one-hot fields:
info.questions[0].choices.forEach((c, i) => {
  console.log(`${c.title}: ${info.result[i].toString()}`);
});
```

Results are meaningful only once the process is `ENDED`/`RESULTS` and the sequencer has settled all votes and set results on-chain. To be notified the instant results land, subscribe to the contract event (escape hatch, needs `sdk.processes`):

```ts
sdk.processes.onProcessResultsSet((id, sender, result /* bigint[] */) => {
  if (id.toLowerCase() === processId.toLowerCase()) console.log("results:", result);
});
```

See `recipes/read-results.ts` for the full "wait for all votes counted → end → await results" pattern.

## Listing processes

```ts
const ids: string[] = await sdk.listProcesses();          // uses signer's chain
const ids2 = await sdk.listProcesses(chainId /* number */); // explicit chain
```

## Cross-references

- `references/census.md` — building the `census` you pass in.
- `references/ballot-modes.md` — configuring `ballot` for a voting system.
- `references/voting.md` — casting votes once the process is live.
- `references/contracts.md` — the raw `ProcessRegistryService` behind these methods.
- `recipes/create-process.ts`, `recipes/read-results.ts`, `recipes/full-election.ts`.
