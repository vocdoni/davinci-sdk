# `references/errors.md` — Errors, reverts and gotchas

Companion to the [[davinci-sdk]] skill. Failures grouped by where they happen. Every error is a class you can test with `instanceof`; contract errors carry the registry's error name in `revertName`, vote errors a `reason`.

## Two status enums

| Enum | For | Values |
| --- | --- | --- |
| `TxStatus` | a transaction (creation, controls) | `pending`, `completed`, `reverted`, `failed` |
| `VoteStatus` | a vote at the nodes | `pending`, `aggregated`, `processed`, `settled`, `error` |

`TxStatus.Failed` means nothing was mined (refused by a local check or the simulation, or not sent); `TxStatus.Reverted` means the transaction was mined and reverted. `VoteStatus.Error` is a node refusing or closing out a vote, with the reason in `error`.

## Setup and `init()`

| Error | Cause |
| --- | --- |
| "SDK must be initialized before … Call sdk.init() first." | a call before `await sdk.init()` |
| "sequencerUrls is required" | no node URL in the config |
| "no RPC to read the … registry" | a custom network without `rpcUrls`, and a signer without a provider on its chain |
| "cannot read the … ProcessRegistry at …" | the read RPC is on another chain, or the address is wrong |
| `DeploymentPinError` (`field`, `expected`, `got`) | the registry pins another release (program vks, vadcop root, ballot VK hash, verifier code); `verifyDeployment: { pins }` for a local deployment |
| `NodeMismatchError` (`field`, `node`) | a node serves another chain, registry, ballot VK or program vk: remove it or fix the URL |
| `SequencerUnavailableError` (`nodes`) | every node of a role is down or an observer; `sdk.nodeChecks` says why |
| `ArtifactError` | a malformed `artifacts` config; later, circuit files that cannot be read or are not the pinned ones |
| "Provider required for blockchain operations" | an organizer call from a signer without a provider |
| "The signer is on chain X; the gnosis registry is on chain 100." | an organizer call from a signer on another chain |
| "Process … belongs to …" / "was not created by the … registry" | a process id of another deployment |

## Creating a process

Local checks and the simulation both fail the stream with a `Failed` event (the plain method throws it). The error is a `ProcessCreateError` unless noted, with `revertName`:

| `revertName` or error | Meaning |
| --- | --- |
| `InvalidStartTime` | the start is not after the chain head; omit `startDate` to start in the creation block |
| `InvalidDuration` | an end not after the start (a non-positive `duration` is refused without a name) |
| `InvalidMaxVoters` | `maxVoters` not a positive integer |
| `MaxPossibleResultCapExceeded` | `maxValue * maxVoters` above 1e12 |
| `BallotModeError` (`registryError`: `InvalidMaxCount`, `InvalidGroupSize`, `InvalidMaxMinValueBounds`, `InvalidValueSumBounds`, `BallotModeMaxValueTooLarge`, …) | the ballot mode does not fit the registry or the circuit (16 fields, values below 2^48, sums below 2^63) |
| `InvalidGrace` (`ProcessGraceError`) | `grace` outside `graceFloor..graceCeil` |
| `DkgDisabledError` (`revertName` `DKGDisabled`) | a DKG key mode on a registry without DKG |
| `NoLiveEpoch`, `PoolExhausted` | no committee epoch can take the process now (the SDK already retried once); try again in a few minutes |
| `InvalidCensusRoot`, `InvalidCensusURI`, `InvalidCensusAddress`, `InvalidCensusOrigin` | the census fields do not fit its origin |
| `InvalidMetadata` | an empty metadata URI or a zero hash |
| `CensusPublishError` | the census file cannot be uploaded, or the URL would not load at the nodes (private host, redirect, other root) |
| `CensusSlotCollisionError` (`slot`, `addresses`) | two members derive the same ballot slot |
| `CensusContractError` | the on-chain census is not a davinci-zkvm census contract |
| `MetadataError` | the metadata cannot be built, uploaded or read back with the same hash |
| "publishing the metadata document needs an uploader" | no `uploader` in the config |
| "maxVoters is required" | a census other than a Merkle object without `maxVoters` |
| "Cannot specify both 'duration' and 'endDate'" | give one of them |
| `SequencerApiError` code 42901 | the key node's per-minute limit on key requests |
| `WrongProcessIdError` (`created`, `expected`) | another creation from the account took the key's id; cancel `created` |

## Organizer controls

| `revertName` | Meaning |
| --- | --- |
| `Unauthorized` | not the process's organizer |
| `InvalidStatus` | the status does not allow it (a second pause, a control on an ENDED process, …) |
| `InvalidTimeBounds` | outside the control's time window: END before the start (cancel instead), a change at or after the end |
| `InvalidDuration` | an extension of 0, or a shortened end inside the notice (`closeProcessIn` adds slack for this) |
| `InvalidGrace` | outside `graceFloor..graceCeil` |
| `InvalidMaxVoters`, `MaxPossibleResultCapExceeded` | below the votes counted, or over the result cap |
| `CensusNotUpdatable` | a census update on an origin other than 2 |
| `InvalidKeyMode` | a reveal on a process that is not `dkg-locked`, a DKG finalize on a sequencer-key process |
| `InvalidOrganizerSecret`, `AlreadyRevealed` | a wrong organizer secret, or a second reveal |
| `ProcessNotFound` (`ProcessNotFoundError`) | no such process |

A change landing just after the end is mined and reverts (`TxStatus.Reverted`, the name recovered by replaying the call): send time-sensitive changes with a margin.

## Voting

`submitVote` throws `VoteError` with a `reason`; the table with what to do about each is in `references/voting.md`. Also:

| Error | Cause |
| --- | --- |
| `CensusWitnessError` | a CSP census without `censusProviders.csp`, an attestation for someone else, or no node at the registry's census root |
| `SequencerDecodeError` naming a node | the node's view of the process differs from the registry (key, ballot mode, census) |
| `ArtifactError` | the circuit files cannot be downloaded or are not the pinned ones |
| `BallotProofError` | the prover failed, or produced other public signals |
| `RangeError` "k is below 2^128" | a guessable ballot secret |

Vote status `error` reasons:

| `error` | |
| --- | --- |
| `process closed` | still queued when the grace window closed, or the process was canceled |
| `census changed, recast` | a census update removed or reweighted the member; vote again if still a member |
| a guest or settlement reason | a batch check failed; resubmit |

A `VoteError('timeout')` from a status wait means the default wait (grace end plus 5 minutes) ran out: check the process phase and the node.

## Receipts and results

| Error | Cause |
| --- | --- |
| `VoteReceiptError` | the vote has not settled on any node yet, or the proof reaches no state root of the process |
| `ResultsError('canceled')` | the process was canceled |
| `ResultsError('locked')` | a `dkg-locked` key not revealed after the grace window (`revealProcessKey`, or `waitForReveal: true`) |
| `ResultsError('timeout')` | the message says what the process still waits for, e.g. "only the node that issued the election key can publish them" |
| `ProcessResultError` `GraceOpen` / `ResultsNotReady` | `finalizeResults` before the grace end or before the committee finished |

## Handling a transaction stream

```ts
import { TxStatus } from '@vocdoni/davinci-sdk';

async function create() {
  for await (const e of sdk.createProcessStream(config)) {
    if (e.status === TxStatus.Completed) return e.response.processId;
    if (e.status === TxStatus.Failed) throw e.error; // e.error.revertName when the registry refused
    if (e.status === TxStatus.Reverted) throw e.error ?? new Error(e.reason ?? 'reverted');
  }
}
```

The stream itself throws, before any event, when the SDK is not initialized, the process id is another deployment's, or the signer has no provider or is on another chain.

## Gotchas

- **Results are not right after the end.** They come after the grace window, by the key holder (`references/results.md`).
- **`settled` takes time.** Nodes batch votes; with default settings a vote can stay `pending` for up to a quarter of an hour.
- **A new process takes a few blocks** to reach the nodes: an early vote may fail with `unavailable` (40402).
- **Node URLs are case- and slash-sensitive** in the per-voter order: configure them the same way everywhere.
- **A Node script hangs after voting:** call `BallotProver.terminate()`.
- **Browser apps and CORS:** the nodes, the RPCs, your census and metadata host and the circuit file host must all allow the app's origin; `documents.verify: false` skips reading back uploads from a host without CORS headers.

## Cross-references

- `references/setup.md`, `references/voting.md`, `references/sequencer.md` (node error codes), `references/contracts.md` (error classes and decoding).
