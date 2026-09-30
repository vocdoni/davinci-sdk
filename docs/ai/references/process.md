# `references/process.md` — Creating and running an election

Companion to the [[davinci-sdk]] skill. A **process** is one election. This file covers `createProcess`, its config, the organizer controls and `getProcess`. Creation and every control need a signer with a provider on the network's chain; `getProcess` does not.

## Create a process

```ts
const created = await sdk.createProcess(config);
// { processId, transactionHash, organizerSecret?, grace?, graceError? }
```

The facade does the whole creation, in this order:

1. **Checks, before anything is uploaded or sent.** The timing on the chain clock, the ballot mode against the registry and the circuit, `maxVoters` and the result cap, the grace value, and for a DKG key that the registry has a DKG adapter. A refusal names the registry error it avoids (`err.revertName`, e.g. `InvalidStartTime`).
2. **Documents.** A Merkle census object and the metadata document are published through the `uploader` and read back as nodes and readers will. A census or a document given by URL is checked the same way.
3. **One creation at a time per account.** It reads the id the registry assigns next, asks the key node for that id's key (sequencer key only), simulates `newProcess` and sends it. The process id comes from the receipt's `ProcessCreated` log.
4. **Grace** (with `grace`): `setProcessGrace` follows as its own transaction.

### `ProcessConfig`

```ts nocheck
interface ProcessConfig {
  census: Census | CensusConfig; // a census object, or { type, root, uri, contractAddress? }
  ballot?: BallotMode; // raw ballot mode, or:
  electionPreset?: ElectionPreset; // { type: 'single_choice' } etc. (references/ballot-modes.md)
  timing: {
    startDate?: Date | string | number; // omitted or 0: the creation block
    duration?: number; // seconds; or:
    endDate?: Date | string | number;
  };
  maxVoters?: number; // default: the member count of a Merkle census object
  keyMode?: 'sequencer' | 'dkg' | 'dkg-locked'; // default 'sequencer' (references/key-modes.md)
  grace?: number; // seconds, within the registry's graceFloor..graceCeil (references/grace.md)
  paused?: boolean; // create it PAUSED

  // EITHER the metadata, which the SDK builds and publishes:
  title: LocalizedText; // 'text' or { default: 'text', en: 'text', es: 'texto' }
  description?: LocalizedText;
  questions: [QuestionConfig, ...QuestionConfig[]]; // { title, description?, choices: [{ title, value }] }
  media?: { header?: string; logo?: string };
  // OR a document you serve yourself:
  metadataUri: string;
  metadataHash?: string; // sha256 of the exact bytes; downloaded and hashed when omitted
}
```

`ballot` and `electionPreset` exclude each other; a preset takes its field count from `questions[0].choices.length` and needs the `questions` form. Choice `value`s are ballot field indexes, from 0.

### Timing

- Times are checked against the **chain head's** time, which is what the registry uses.
- No `startDate` (or 0): the process starts in the block that creates it, so voters can vote as soon as the nodes have seen it (a few blocks).
- An explicit `startDate` must be after the chain head, with room for the transaction to land (`InvalidStartTime`).
- Give `duration` in seconds or an `endDate`, not both. With no `startDate` the duration runs from the head.
- Dates accept a `Date`, an ISO string or a unix timestamp (seconds; values above 1e10 are read as milliseconds).

### `maxVoters` and the result cap

| Census | `maxVoters` |
| --- | --- |
| `OffchainCensus`, `OffchainDynamicCensus` object | optional: the member count |
| `OnchainCensus`, `CspCensus`, `PublishedCensus`, a `CensusConfig` | required |

The registry caps `maxValue * maxVoters` at `RESULT_CAP` (1e12): a ballot mode with `maxValue` 10 allows up to 1e11 voters. Beyond it the creation is refused as `MaxPossibleResultCapExceeded`.

### Example

```ts
import { OffchainCensus } from '@vocdoni/davinci-sdk';

const census = new OffchainCensus();
census.add([
  '0x1111111111111111111111111111111111111111',
  { key: '0x2222222222222222222222222222222222222222', weight: 3 },
]);

const { processId } = await sdk.createProcess({
  title: { default: 'Community decision', es: 'Decisión comunitaria' },
  description: 'What should we build next?',
  census,
  electionPreset: { type: 'single_choice' },
  timing: { duration: 7 * 24 * 3600 },
  questions: [
    {
      title: 'Which initiative?',
      choices: [
        { title: 'Garden', value: 0 },
        { title: 'Workshop', value: 1 },
        { title: 'Gallery', value: 2 },
      ],
    },
  ],
});
```

## Streaming the creation

`createProcessStream(config)` yields `TxStatusEvent`s for UIs:

```ts
import { TxStatus } from '@vocdoni/davinci-sdk';

for await (const event of sdk.createProcessStream({ ...config, grace: 150 })) {
  switch (event.status) {
    case TxStatus.Pending:
      // event.step is 'setProcessGrace' for the follow-up transaction
      console.log(event.step ?? 'newProcess', 'sent:', event.hash);
      break;
    case TxStatus.Completed:
      console.log('created', event.response.processId, event.response.grace);
      if (event.response.graceError) console.warn('grace not set:', event.response.graceError);
      break;
    case TxStatus.Failed:
      throw event.error; // refused before or while sending: nothing was mined
    case TxStatus.Reverted:
      throw event.error ?? new Error(event.reason); // mined and reverted, named by replaying it
  }
}
```

- A refusal of the config itself is a single `Failed` event whose `error` is a `ProcessCreateError` (or a census, metadata, ballot mode or node error) with the registry error in `revertName`.
- A DKG creation is retried once when the committee's key pool ran out or its epoch moved: a second `Pending`.
- With `grace`, a failed `setProcessGrace` still completes, with `graceError` set: the process exists with the registry's default window. Retry with `setProcessGrace`.
- The stream throws, before any event, when the SDK is not initialized or the signer has no provider or is on another chain.

`createProcess(config)` consumes the stream and throws the `Failed` or `Reverted` error.

## Organizer controls

Each control reads the process and the chain clock first and refuses what the registry would revert, with the operation's error class and the registry error in `revertName`; the call is then simulated before it is signed. Each has a plain form (throws) and a `…Stream` form (yields `TxStatusEvent`s). Only the organizer may call them, except `revealProcessKey`.

| Method | Allowed | Effect | Error class |
| --- | --- | --- | --- |
| `endProcess(pid)` | READY or PAUSED, from the start (before it: `cancelProcess`) | ENDED; the end moves to now; admitted votes still settle through the grace window | `ProcessStatusError` |
| `pauseProcess(pid)` | READY, before the end | PAUSED; nodes take votes but settle none until resumed | `ProcessStatusError` |
| `resumeProcess(pid)` | PAUSED | READY; the queued votes settle | `ProcessStatusError` |
| `cancelProcess(pid)` | READY or PAUSED, any time, the grace window included (a DKG process is ENDED once its decryption is requested) | CANCELED; no results | `ProcessStatusError` |
| `extendProcess(pid, seconds)` | READY or PAUSED, before the end | the end moves later; returns `{ duration }` | `ProcessDurationError` |
| `closeProcessIn(pid, seconds, { slack? })` | READY or PAUSED, before the end | the end moves earlier, with notice (`references/grace.md`) | `ProcessDurationError` |
| `setProcessGrace(pid, seconds)` | READY or PAUSED, before the end, within `graceFloor..graceCeil` | the grace window | `ProcessGraceError` |
| `setProcessMaxVoters(pid, n)` | READY or PAUSED, before the end, at least the votes counted, within the result cap | the voter cap | `ProcessMaxVotersError` |
| `updateCensus(pid, census)` | origin 2 only, READY or PAUSED, before the end | a new census version (`references/census.md`) | `ProcessCensusError`, `CensusNotUpdatable` |
| `updateMetadata(pid, metadata)` | READY or PAUSED, before the end | a new metadata document (`references/metadata.md`) | `ProcessMetadataError` |
| `revealProcessKey(pid, secret)` | `dkg-locked` processes, any time, anyone with the secret | the committee may decrypt (`references/key-modes.md`) | `ProcessKeyRevealError` |

```ts
import { ProcessStatusError } from '@vocdoni/davinci-sdk';

try {
  await sdk.endProcess(processId);
} catch (err) {
  if (err instanceof ProcessStatusError && err.revertName === 'InvalidTimeBounds') {
    await sdk.cancelProcess(processId); // it has not started: cancel it instead
  } else throw err;
}
```

`ProcessStatus` is the registry's enum: `READY = 0`, `ENDED = 1`, `CANCELED = 2`, `PAUSED = 3`, `RESULTS = 4`.

### Cleaning up

`cancelOpenProcesses()` cancels the processes this SDK instance created that are still READY or PAUSED; `{ processIds }` cancels those instead, and `{ all: true }` every process the signer ever created on the registry. It tries them all and reports `{ canceled, failed }`.

## Read a process: `getProcess`

```ts
const info = await sdk.getProcess(processId);
console.log(info.phase, info.status, info.endDate, info.graceEnd, info.votersCount);
if (info.metadataVerified) console.log(info.title, info.questions);
```

It reads the registry through the read provider (a voter's bare wallet is enough), downloads the metadata document and checks its hash. `ProcessInfo` holds:

| Field | |
| --- | --- |
| `processId`, `creator`, `status`, `phase` | `phase` is `upcoming`, `open`, `paused`, `closing`, `ended`, `results` or `canceled` (`references/grace.md`) |
| `title`, `description`, `questions`, `electionPreset`, `metadata` | from the metadata document, only when it is verified |
| `metadataURI`, `metadataHash`, `metadataVerified`, `metadataStatus`, `metadataError` | `metadataStatus`: `verified`, `mismatch`, `unreachable` or `refused` |
| `census` | `{ type, root, uri, contractAddress? }` |
| `ballot` | the registry's ballot mode, bounds as decimal strings |
| `keyMode`, `dkg` | the key mode; the DKG application of a DKG process |
| `startDate`, `endDate`, `duration`, `timeRemaining` | `timeRemaining`: seconds to the end, 0 after it, negative (minus the seconds to the start) before the start |
| `grace`, `lastVoteAt`, `graceEnd`, `chainTime` | the grace window, computed from the same read; `graceEnd` is null when it never closes |
| `maxVoters`, `votersCount`, `overwrittenVotesCount`, `stateRoot` | counters and the latest state root |
| `result` | one `bigint` per ballot field once the status is RESULTS, else empty |
| `raw` | the registry struct (`OnchainProcess`) |

For results use `waitForResults` or `decodeResults(info)` (`references/results.md`); `result` alone is per ballot field.

`sdk.listProcesses()` lists the process ids the nodes know.

## Cross-references

- `references/census.md`: the `census` you pass in.
- `references/ballot-modes.md`: `ballot` and `electionPreset`.
- `references/key-modes.md`, `references/grace.md`: `keyMode` and `grace`.
- `references/results.md`: what happens after the end.
- `recipes/create-process.ts`, `recipes/close-early.ts`.
