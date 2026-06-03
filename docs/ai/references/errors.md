# `references/errors.md` — Errors, reverts, and gotchas

Companion to the [[davinci-sdk]] skill. Failure modes grouped by where they come from.

## The two status enums — don't confuse them

| Enum         | Where                                   | Values                                                        |
| ------------ | --------------------------------------- | ------------------------------------------------------------- |
| `TxStatus`   | on-chain txs (create/end/pause/…)       | `pending` · `completed` · `reverted` · `failed`               |
| `VoteStatus` | a vote's processing journey             | `pending` · `verified` · `aggregated` · `processed` · `settled` · `error` |

A `TxStatus.Reverted` is the contract rejecting a transaction; a `VoteStatus.Error` is the sequencer rejecting a ballot. They are unrelated code paths.

## Setup / wiring

| Symptom | Cause / fix |
| ------- | ----------- |
| *"SDK must be initialized… Call sdk.init() first."* | You called a method before `await sdk.init()`. |
| *"Provider required for blockchain operations…"* | An on-chain method (`createProcess`, `getProcess`, lifecycle) ran on a signer with **no provider**. Use `new Wallet(pk, provider)`. Voting doesn't need one. |
| *"Census URL is required for voting."* | Voting on a Merkle census without `censusUrl` and without a custom `censusProviders`. Add `censusUrl` to the config. |
| *"Census API URL is required to publish Merkle censuses…"* | `createProcess` tried to auto-publish an `OffchainCensus` but the SDK has no `censusUrl`. Add it, or pass a pre-published / on-chain / CSP census. |
| *"Failed to fetch contract addresses from sequencer…"* | `init()` couldn't resolve the registry for your chain. The RPC chain isn't supported by this sequencer, or `sequencerUrl` is wrong. Check `getInfo().networks` vs `provider.getNetwork()`, or pass `addresses.processRegistry`. |
| *"Signer chainId N is not supported by sequencer."* | RPC points at a chain the sequencer doesn't serve. Point RPC at the sequencer's chain. |

## Process creation

| Symptom | Cause / fix |
| ------- | ----------- |
| *"maxVoters is required…"* | Census type needs an explicit `maxVoters` (Onchain/CSP/Published/manual, or an unpublished census). Only published `OffchainCensus`/`OffchainDynamicCensus` auto-derive it. See `references/census.md`. |
| *"Cannot specify both 'duration' and 'endDate'."* | Pick one in `timing`. |
| *"Must specify either 'duration' … or 'endDate'."* | `timing` had neither. |
| *"Start date cannot be in the past."* | `startDate` is >30s before now. Default is now+60s; leave it unset for "start soon". |
| `TxStatus.Reverted` from `createProcessStream` | On-chain rejection — wrong chain, insufficient gas, malformed struct, or not the organizer. Inspect `event.reason`. |
| `TxStatus.Failed` | The tx couldn't be sent/mined (`event.error`) — usually RPC/gas/nonce. |

## Sequencer (numeric error codes)

REST errors throw with a numeric `.code`:

| Code | Meaning | Typical handling |
| ---- | ------- | ---------------- |
| `40007` | Process not found / not yet indexed | Right after `createProcess` the sequencer hasn't indexed it. Poll `getProcess` with backoff until it appears and `isAcceptingVotes`. |
| `40001` | Address not in census | Surface a clean "not eligible" message; pre-check with `isAddressAbleToVote`. |

```ts
try { const p = await sdk.api.sequencer.getProcess(id); }
catch (e: any) {
  if (e.code === 40007) { /* wait & retry */ }
  else throw e;
}
```

## Voting

| Symptom | Cause / fix |
| ------- | ----------- |
| *"Process is not currently accepting votes"* | Process isn't `READY`/started yet, is paused/ended, or not indexed. Poll `sdk.api.sequencer.getProcess(id).isAcceptingVotes` first. |
| *"Choice X is out of range [min, max]"* | A `choices` entry violates `ballot.minValue`/`maxValue`. Also ensure `choices.length === ballot.numFields`. |
| *"CSP voting requires a CSP census proof provider."* | Voting on a `CspCensus` without `censusProviders.csp`. Supply one (see `references/census.md`). |
| *"Hash verification failed for circuit.wasm/…"* | A downloaded circuit artifact didn't match the sequencer's published hash (`verifyCircuitFiles`). Don't disable the check — investigate the sequencer/CDN. |
| *"Generated proof is invalid"* | `verifyProof` caught a bad proof before submit — usually mismatched circuit artifacts or inputs. Confirm the SDK and sequencer agree on the chain/process. |
| *"Vote did not reach status … within …ms"* | `waitForVoteStatus` timed out. Settlement can take minutes under load; raise the timeout (the SDK demo uses ~800_000ms). |
| `VoteStatus.Error` | The sequencer rejected the ballot (bad proof/signature/eligibility). Re-check census membership and that the process is live. |

## Reading results

- `getProcess(...).result` is only meaningful once the process is `ENDED`/`RESULTS` **and** votes have settled and results are set on-chain. Before that it may be empty/zeros. Wait for `votersCount` to match expectations, `endProcess`, then await `sdk.processes.onProcessResultsSet` (see `recipes/read-results.ts`).
- `result` is `bigint[]` per **ballot field**, not per question — map by index to your one-hot options.

## Quick reference: handling a TxStatus stream safely

```ts
for await (const e of sdk.createProcessStream(cfg)) {
  if (e.status === TxStatus.Completed) return e.response.processId;
  if (e.status === TxStatus.Failed)    throw e.error;
  if (e.status === TxStatus.Reverted)  throw new Error(`reverted: ${e.reason ?? "unknown"}`);
}
```

## Cross-references

- `references/setup.md` — the signer/provider rule behind half of these.
- `references/voting.md`, `references/process.md`, `references/sequencer.md`.
