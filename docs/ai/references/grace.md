# `references/grace.md` — The grace window, phases and closing early

Companion to the [[davinci-sdk]] skill. Voting ends at the process's end time, but settlement does not: nodes may still hold ballots cast before the end, queued or being proved. The registry keeps accepting their batches for a **grace window** after the end, and only unlocks the results once it closes.

## The grace end

```text
graceEnd = min(end + graceMaxTotal, max(end, lastVoteAt) + grace)
```

- `lastVoteAt` is the time of the latest settled batch. Every landing after the end pushes the window out, so a backlog drains batch by batch; the window closes `grace` seconds after the last one.
- `graceMaxTotal` caps it: the window never closes later than the end plus that.
- `grace` is per process: the registry's `defaultGrace`, or what the organizer sets within `graceFloor..graceCeil`.
- Before `graceEnd` the registry refuses every results call (`GraceOpen`). At it, votes still queued on a node fail with `error: process closed`.

The five parameters are immutables of the registry:

```ts
const { defaultGrace, graceFloor, graceCeil, graceMaxTotal, noticeMin } = await sdk.getGraceParams();
// Gnosis registry: 180, 150, 600, 1800 and 60 seconds
```

```ts
const graceEnd = await sdk.getGraceEnd(processId); // Date, or null when it never closes
const info = await sdk.getProcess(processId); // info.grace, info.lastVoteAt, info.graceEnd, info.phase
```

`ProcessInfo.graceEnd` is computed from the same registry read as `phase` and `lastVoteAt`, so they agree; `getGraceEnd` asks the registry.

## Phases

`ProcessInfo.phase` (and `processPhase`, exported) reads the status against the chain clock:

| Phase | When | Votes |
| --- | --- | --- |
| `upcoming` | READY, before the start | refused (`not-started`) |
| `open` | READY, between the start and the end | taken |
| `paused` | PAUSED, before the end | taken and queued; nothing settles until `resumeProcess` |
| `closing` | past the end (READY, PAUSED or ENDED) until `graceEnd` | refused; batches of earlier votes still land |
| `ended` | the grace window closed, no results yet | refused |
| `results` | RESULTS: the tally is on-chain | refused |
| `canceled` | CANCELED | refused; no results |

A process still paused at its end settles through the grace window like an ended one. `endProcess` before the end moves the end to now: from there it is the same timeline.

## Setting the grace

```ts
// At creation: checked against graceFloor..graceCeil before anything is sent,
// then sent as its own transaction right after the creation.
const { processId, grace, graceError } = await sdk.createProcess({ ...config, grace: 150 });

// Or later, before the end:
await sdk.setProcessGrace(processId, 150);
```

A value outside `graceFloor..graceCeil`, or a change from the end on, is refused as `ProcessGraceError` (`revertName` `InvalidGrace` or `InvalidTimeBounds`).

A short grace gets results sooner after the close; a longer one gives slow nodes more room to land what they took before the end. The floor is enough when the nodes settle while voting runs.

## Closing early with notice: `closeProcessIn`

```ts
const { noticeMin } = await sdk.getGraceParams();
const { duration } = await sdk.closeProcessIn(processId, noticeMin); // "voting closes in one minute"
```

It shortens the end to `head + max(seconds, noticeMin) + slack`, where `head` is the chain head's time. The registry refuses an end sooner than `noticeMin` from the moment the transaction lands, so `slack` covers the transaction's own inclusion: 45 s by default (what a live chain needs), a few seconds on a local chain (`{ slack: 6 }`). Nodes see the new end within a block or two, flush everything they hold during the notice, and refuse votes from the new end on.

- Only before the current end, and only to an earlier end: `extendProcess(processId, seconds)` moves it later.
- A process that has not started cannot close before its start; cancel it instead.
- `endProcess` closes at once, without notice: votes in flight at that moment may be refused.

## Live meetings (AGM)

A meeting wants results a few minutes after the vote closes:

1. **Grace at the floor**, at creation (`grace: graceFloor`) or right after it.
2. **Close with notice**: announce "voting closes in one minute" and call `closeProcessIn(processId, noticeMin)`.
3. **Wait for the results**: `waitForResults(processId, { onStatus })`.

On the Gnosis registry, with a sequencer key and nodes that settle while voting runs, results land about four and a half minutes after the announcement: the notice and its slack, the last batch, the 150 s grace, then the key node's results transaction. A DKG key adds the committee's round (1 to 5 minutes). Nodes configured for meetings (short batch timers) keep the backlog at the end small; ask the operators of the nodes you use.

```ts
const { graceFloor, noticeMin } = await sdk.getGraceParams();
const { processId } = await sdk.createProcess({ ...config, grace: graceFloor });
// ... the meeting votes ...
await sdk.closeProcessIn(processId, noticeMin);
const results = await sdk.waitForResults(processId, {
  onStatus: s => console.log(s.state, s.graceEnd),
});
```

## Cross-references

- `references/results.md`: what happens at and after `graceEnd`.
- `references/process.md`: the controls and their windows.
- `recipes/close-early.ts`: a close with notice and the grace at the floor.
