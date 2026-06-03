# `references/voting.md` — Casting an encrypted vote

Companion to the [[davinci-sdk]] skill. Casting a vote is the part most likely to confuse, but the `DavinciSDK` facade hides all the cryptography: you supply `choices`, it builds the ballot, ElGamal-encrypts it, generates the zk-SNARK proof, signs, and submits. None of `submitVote`'s methods need a provider — a bare `Wallet` is enough.

## Act as the voter

The SDK votes **as its `signer`**. To cast a voter's ballot, construct a `DavinciSDK` with that voter's wallet:

```ts
import { DavinciSDK, VoteStatus } from "@vocdoni/davinci-sdk";
import { Wallet } from "ethers";

const voter = new DavinciSDK({
  signer: new Wallet(VOTER_PRIVATE_KEY),    // no provider needed for voting
  sequencerUrl: SEQUENCER_API_URL,
  censusUrl: CENSUS_API_URL,                // needed so the SDK can fetch the census proof
});
await voter.init();
```

(`censusUrl` is required for voting on Merkle censuses unless you pass a custom `censusProviders`. CSP censuses need a `censusProviders.csp` — see `references/census.md`.)

## Submit

```ts
const result = await voter.submitVote({
  processId,
  choices: [1, 0],          // length MUST equal the process's ballot.numFields
  // randomness?: string    // optional; auto-generated if omitted
});
```

### `VoteConfig` / `VoteResult`

```ts
interface VoteConfig {
  processId: string;
  choices: number[];        // one integer per ballot field
  randomness?: string;      // optional hex/decimal entropy for encryption (the "k")
}

interface VoteResult {
  voteId: string;           // track this
  signature: string;
  voterAddress: string;
  processId: string;
  status: VoteStatus;       // initial status, usually "pending"
}
```

### The `choices` model (read this before guessing)

`choices` is a flat array of integers, **one per ballot field**, and `choices.length` must equal `ballot.numFields`. Each integer must lie in `[ballot.minValue, ballot.maxValue]` (the SDK validates this and throws "Choice X is out of range" otherwise).

- **Single-choice question, N options** → encoded one-hot as N fields. To pick option *j*, send an array of N zeros with a 1 at index *j*: `[0,0,1,0]` picks option 2.
- **Weighted voting** → put the voter's weight at the chosen index instead of 1: `[0, 5, 0, 0]`.
- **Multiple questions** → concatenate each question's fields: two 4-option questions → `numFields: 8`, `choices: [...q1(4), ...q2(4)]`.
- **Approval / ranked / quadratic / budget** → the field meaning changes per ballot mode; see `references/ballot-modes.md`.

`submitVote` internally fetches the live process (must be `isAcceptingVotes` or it throws *"Process is not currently accepting votes"*), gets the voter's census weight/proof, encrypts, proves, and submits.

## The two-phase status flow

`submitVote` returns as soon as the sequencer accepts the payload — the vote is **not yet counted**. It progresses through `VoteStatus`:

```ts
enum VoteStatus {
  Pending    = "pending",     // received by sequencer
  Verified   = "verified",    // proof + signature checked
  Aggregated = "aggregated",  // included in a batch
  Processed  = "processed",   // state transition applied
  Settled    = "settled",     // finalized on-chain — it counts
  Error      = "error",       // rejected
}
```

Always wait for it to settle:

```ts
const final = await voter.waitForVoteStatus(
  processId, result.voteId,
  VoteStatus.Settled,   // target (default: Settled)
  300_000,              // timeout ms (default 300_000 = 5 min) — settlement can take minutes
  5_000,                // poll interval ms (default 5_000)
);
// final: VoteStatusInfo { voteId, status, processId }
```

> Settlement depends on the sequencer batching and submitting a state transition; under light load it can take several minutes. For many votes, bump the timeout (the SDK's own demo uses ~800_000ms per vote).

### Stream status changes (for UI)

```ts
for await (const s of voter.watchVoteStatus(processId, voteId, {
  targetStatus: VoteStatus.Settled, timeoutMs: 800_000, pollIntervalMs: 5_000,
})) {
  console.log(s.status);                       // yields only on change
  if (s.status === VoteStatus.Error) throw new Error("vote rejected");
}
```

`waitForVoteStatus` is `watchVoteStatus` consumed for you, returning the final status. A one-off poll: `await voter.getVoteStatus(processId, voteId)` → `{ voteId, status, processId }`.

## Eligibility & dedup checks (no provider needed)

```ts
await sdk.isAddressAbleToVote(processId, address);  // boolean — in the census?
await sdk.hasAddressVoted(processId, address);      // boolean — already voted?
await sdk.getAddressWeight(processId, address);     // string — voting weight ("0" if none)
```

Use `isAddressAbleToVote` before submitting to give a clean "not eligible" message instead of a thrown error. Voters may **overwrite** their vote during the voting period (last-vote-wins) — `hasAddressVoted` true doesn't prevent re-voting.

## Custom randomness

`randomness` seeds the ElGamal encryption nonce (`k`) and the vote-id derivation. Omit it (recommended) to let the SDK sample fresh entropy. Supply it only for reproducible tests; reusing the same `k` across votes is unsafe.

## Verification toggles (from SDK config)

`verifyCircuitFiles` (default true) checks the SHA-256 of downloaded circuit artifacts against the hashes in the sequencer's `/info`; `verifyProof` (default true) verifies the generated proof locally before submitting. Leave both on unless profiling shows a need.

## Cross-references

- `references/ballot-modes.md` — what `choices` means under each voting system.
- `references/census.md` — CSP voting providers; how the census proof is fetched.
- `references/sequencer.md` — the REST calls underneath (`submitVote`, `getVoteStatus`, `getProcess`).
- `references/errors.md` — "not accepting votes", out-of-range, proof failures.
- `recipes/cast-vote.ts`.
