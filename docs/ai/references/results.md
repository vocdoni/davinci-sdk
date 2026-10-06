# `references/results.md` — Results

Companion to the [[davinci-sdk]] skill. Ballots stay encrypted; nodes add them up homomorphically into an encrypted accumulator in the state tree. After the end and the grace window, only that accumulator is decrypted, and the tally is stored on the registry with a proof that binds it to the final state.

## When results come

Results unlock when the grace window closes (`graceEnd`, `references/grace.md`); before that the registry refuses every results call. What happens next depends on the key mode:

| Key mode | After `graceEnd` | Typical delay |
| --- | --- | --- |
| `'sequencer'` | The key node decrypts the accumulator, proves the decryption in a zkVM guest and calls `setProcessResults`. It usually prepares the proof during the grace window. | seconds to a couple of minutes |
| `'dkg'` | A node sends `requestResultsDecryption` (the process moves to ENDED), the committee combines its decryption shares, and a node stores the tally with `finalizeResultsFromDKG`. | 1 to 5 minutes |
| `'dkg-locked'` | The same, once the organizer has called `revealProcessKey`. Nothing is decrypted before. | as `'dkg'`, from the reveal |
| `'council'` | As `'dkg'`, with the Council ceremony's members combining the whole request, once the ceremony opens decryption: on its scheduled date, or when its organizer opens it (or at its fallback date). Until then nothing is published, not even a tally of zeros. | from the opening, as long as `t` members take to show up |

With a sequencer key, only the key node can publish the results: if it is gone, they never come.

## Waiting for results

```ts
const results = await sdk.waitForResults(processId, {
  onStatus: s => console.log(s.state, s.graceEnd), // each state change
});
for (const question of results.questions) {
  console.log(question.title);
  for (const choice of question.choices) console.log(`  ${choice.title}: ${choice.total}`);
}
```

`waitForResults(processId, options)` polls the chain (every 10 s) and returns the decoded tally.

| Option | Default | |
| --- | --- | --- |
| `timeoutMs` | the grace end plus 15 minutes, following the window as it moves | then `ResultsError('timeout')`, whose message says what the process was waiting for (with a Council opening date). A Council process that opens later needs a longer one |
| `pollIntervalMs` | 10 000 | |
| `onStatus` | | called with the `ResultsStatus` on every state change |
| `waitForReveal` | false | a `'dkg-locked'` key still sealed after the grace window waits for the reveal instead of failing with `ResultsError('locked')` |
| `finalize` | false | DKG keys: when the plaintexts are ready and no node stored them after `finalizeAfterMs` (60 s), send `finalizeResultsFromDKG` from the signer, which pays its gas |

It throws `ResultsError` with `reason` `canceled`, `locked` or `timeout`, and the last `status`.

## Results states

`getResultsStatus(processId)` tells where a process stands:

| `state` | Meaning |
| --- | --- |
| `voting` | before the end (upcoming, open or paused) |
| `grace` | past the end, the grace window still open |
| `awaiting-key-holder` | sequencer key: waiting for the key node |
| `awaiting-request` | DKG key: no node has asked the committee yet (they do on their first heartbeat after the grace end) |
| `locked` | DKG-locked key not revealed |
| `awaiting-opening` | Council key: the ceremony has not opened decryption; `status.decryptionOpening` says how it opens |
| `decrypting` | the committee is combining its shares |
| `finalizable` | the plaintexts are ready; the first `finalizeResultsFromDKG` stores them (anyone may send it) |
| `results` | the tally is on-chain, decoded in `status.results` |
| `canceled` | no results will be set |

```ts
const status = await sdk.getResultsStatus(processId);
// { processId, state, keyMode, graceEnd, chainTime, results?, decryptionOpening? }
if (status.state === 'finalizable') await sdk.finalizeResults(processId); // permissionless, costs gas
```

`finalizeResults` is refused before the grace end (`GraceOpen`), before the committee is done (`ResultsNotReady`) and, for a Council process, before its ceremony opens decryption (`DecryptionNotOpen`), as a `ProcessResultError`.

### Council results locked until the opening

A Council ceremony fixes when its committee may decrypt, for every process bound to it. In state `awaiting-opening`, `status.decryptionOpening` is:

| `mode` | `opensAt` | Show |
| --- | --- | --- |
| `'scheduled'` | the date (`Date`) | "Results are locked until the committee opens decryption on `opensAt`" |
| `'manual'` | the fallback date, or `null` without one | "Results are locked until the organizer opens decryption" (plus "or on `opensAt` at the latest") |

```ts
const status = await sdk.getResultsStatus(processId);
if (status.state === 'awaiting-opening') {
  const { mode, opensAt } = status.decryptionOpening!;
  console.log(mode === 'scheduled' ? `opens ${opensAt?.toISOString()}` : 'waits for the organizer');
}
```

The registry enforces it: a vote that ended with no ballots still shows `awaiting-opening`, and its zero tally is stored only after the opening. `sdk.registry.getCouncilDecryptionGate(info.dkg)` reads the gate directly. It is a policy the contracts and honest members follow, not a time lock: enough committee members together can always decrypt off chain earlier.

## Reading a tally

The tally is **additive**: field `i` of the result is the sum of field `i` over the latest ballot of every voter. Census weights are not multiplied in; a weight only bounds a ballot when the ballot mode makes it the budget (`maxValueSum` 0, `references/ballot-modes.md`).

`ProcessResults`:

| Field | |
| --- | --- |
| `kind` | `single_choice`, `multiple_choice`, `approval`, `rating`, `ranking`, `quadratic` or `custom`: the metadata's preset when it produces the on-chain ballot mode, else what the mode's parameters read as |
| `values` | one `bigint` per ballot field, as the registry stores them |
| `voters` | ballots counted (one per voter: its latest) |
| `questions` | per question of the verified metadata, each choice with its field's `total` and `mean` |

`mean` is `total / voters` (null with no voters). Read per kind:

| Kind | `total` | `mean` |
| --- | --- | --- |
| `single_choice`, `multiple_choice`, `approval` | ballots that chose it | share of ballots that chose it |
| `rating` | sum of ratings | mean rating |
| `ranking` | sum of ranks | mean rank (lower is preferred) |
| `quadratic` | votes it got | mean votes per ballot |
| `custom` | sum of the field | mean of the field |

Without verified metadata there is one untitled question with every field. `decodeResults(await sdk.getProcess(processId))` decodes a process read by hand; it throws `RangeError` before the results are on-chain. `ProcessInfo.result` is the raw `bigint[]`.

## Listening instead of polling

```ts
const registry = sdk.registry; // through the read provider
registry.onProcessResultsSet((id, sender, result) => {
  if (id.toLowerCase() === processId.toLowerCase()) console.log('results', result);
});
// ...
registry.removeAllListeners();
```

## Cross-references

- `references/grace.md`: the grace window and closing early.
- `references/key-modes.md`: who decrypts.
- `references/ballot-modes.md`: what the fields mean.
- `recipes/read-results.ts`.
