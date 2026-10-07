# `references/voting.md` — Casting a vote

Companion to the [[davinci-sdk]] skill. The facade hides the cryptography: you give `choices`, and `submitVote` reads the election from the registry, gets the voter's census witness, builds the 16-field encrypted ballot, proves it, signs its vote id and sends it to a node. None of it needs a provider: a bare `Wallet` votes.

## Act as the voter

The SDK votes as its `signer`, so each voter has its own `DavinciSDK`:

```ts
import { DavinciSDK } from '@vocdoni/davinci-sdk';
import { Wallet } from 'ethers';

const voter = new DavinciSDK({
  signer: new Wallet(process.env.VOTER_KEY!), // no provider needed
  sequencerUrls: ['https://sequencer-1.example.org', 'https://sequencer-2.example.org'],
});
await voter.init(); // reads Gnosis through its public RPCs, or `rpcUrls`
```

In a browser, pass the wallet's signer (`await new BrowserProvider(window.ethereum).getSigner()`); the vote only asks it to sign a message.

## Submit

```ts
const vote = await voter.submitVote({ processId, choices: [0, 1, 0] });
// { voteId, signature, voterAddress, processId, status: 'pending', node, weight, k }
```

What happens:

1. **The election, from the registry** (never from a node): it must take votes, from its start to its end, READY or PAUSED. A paused process's votes settle once it resumes. The first node of the voter's order that serves the process is cross-checked against the registry (key, ballot mode, census).
2. **The census witness:** the voter's weight and proof from the nodes (origins 1 and 2), the census contract (origin 3) or `censusProviders.csp` (origin 4). See `references/census.md`.
3. **The ballot:** the choices are checked against the ballot mode, the 16-field ballot is encrypted under the registry's key (unused fields hold the identity), proved with the circuit files the registry pins, and its vote id signed.
4. **The node:** the voter's own node (`references/nodes.md`), with failover only when it is safe.

### `VoteConfig` and `VoteResult`

| `VoteConfig` | |
| --- | --- |
| `processId` | the process |
| `choices` | one integer (number or bigint) per ballot field, in field order; at most `numFields`, missing ones are 0 |
| `node?` | the node that took the voter's previous ballot, so a revote queues behind it |
| `k?` | the ballot secret; random by default, the recommended way. A given one must be a random field element (one below 2^128 is refused) used for no other ballot (see below) |

| `VoteResult` | |
| --- | --- |
| `voteId` | `0x` + 16 hex digits; track the vote with it |
| `node` | the node that took it: store it with the vote, and pass it back for a revote |
| `weight` | the census weight the vote carries |
| `k` | the ballot secret. With the election key it opens the ballot and links the vote id to the voter: keep it private |
| `status` | `pending` |

### The ballot secret `k`

Never use a `k` for two ballots: not for another voter, not in another process, not for a revote. Leave `k` out and every `submitVote` draws a fresh one (`randomBallotSecret`). The nonces that encrypt the 16 fields are a Poseidon chain of `k` alone, so two ballots with one `k` share every `C1`, and under one election key (two voters, or two processes on one DKG key or Council ceremony) `C2 − C2' = (m − m')·G` shows anyone the difference of the choices. Their vote ids differ, so no node refuses the second ballot: only the same voter's `k` in the same process repeats a vote id (`duplicate`), and that is no protection to rely on.

### The `choices` model

`choices[i]` is the value of ballot field `i`, and field `i` is the choice whose metadata `value` is `i`.

- **Single choice, N options:** one-hot. `[0, 0, 1, 0]` picks option 2.
- **Multiple choice, approval:** a 1 for each chosen option.
- **Rating:** the rating of each option.
- **Ranking:** the rank of each option, 1 to N, all different.
- **Quadratic:** the votes put on each option; the sum of their squares stays within the budget.
- **Several questions:** each question's fields one after the other, as the metadata `value`s say.

A choice outside the ballot mode fails with `VoteError('invalid')` before anything is proved. See `references/ballot-modes.md`.

## Status

```ts
import { VoteStatus } from '@vocdoni/davinci-sdk';

const { status, error, node } = await voter.getVoteStatus(processId, voteId);

for await (const s of voter.watchVoteStatus(processId, voteId)) {
  console.log(s.status, s.error ?? ''); // yields each change
}

const final = await voter.waitForVoteStatus(processId, voteId); // default target: settled
if (final.status === VoteStatus.Error) console.error(final.error);
```

| `VoteStatus` | |
| --- | --- |
| `pending` | queued on the node |
| `aggregated` | in a batch being proved |
| `processed` | proved; its settlement transaction is on the way |
| `settled` | on-chain: it counts |
| `error` | refused, with the node's reason in `error` |

- Nodes batch votes: with default node settings a vote can stay `pending` for up to a quarter of an hour (longer for a lone vote), and everything is flushed from a few minutes before the end. A lost race or a pause puts votes back to `pending`.
- `error` reasons include `process closed` (still queued when the grace window closed, or the process was canceled), `census changed, recast` (the member was removed or reweighted by a census update) and a batch check.
- By default the wait follows the process: it lasts until the grace window closes plus 5 minutes (`VOTE_STATUS_MARGIN_MS`), re-reading the end if it moves, and fails with `VoteError('timeout')` after that. `timeoutMs` and `pollIntervalMs` (5 s) override it; a later status than the target counts as reached.
- The node that took the vote is asked first; any node that has settled it answers `settled` too.

## Revotes

A voter may vote again while the process takes votes; its latest ballot replaces the earlier one in the tally. Every batch also re-randomizes a sample of the ballots already stored, so nobody can tell a revote from a routine refresh.

Send the revote to the node that took the earlier ballot: one node settles a voter's ballots in the order they were cast, two nodes do not. The SDK remembers that node in memory (per voter, for the latest 1,000 voters). An app that reloads, or revotes from another device, stores `vote.node` and passes it back:

```ts
const first = await voter.submitVote({ processId, choices: [1, 0, 0] });
localStorage.setItem(`davinci-node:${processId}`, first.node);
// ...later, maybe after a reload:
const node = localStorage.getItem(`davinci-node:${processId}`) ?? undefined;
await voter.submitVote({ processId, choices: [0, 0, 1], node });
```

A revote is a new ballot with a fresh `k`: leave `k` out, never pass the earlier one. A revote while earlier ballots are still queued may fail with `VoteError('slot-busy')`: try again once they settle.

## Errors

`submitVote` throws `VoteError` with a `reason` (and the node's `code` and `node` when a node refused):

| `reason` | Meaning | What to do |
| --- | --- | --- |
| `not-in-census` | the voter is not a member | nothing: it cannot vote |
| `not-started` | before the start | wait for `startDate` |
| `closed` | ended, canceled, or past the end | nothing |
| `invalid` | choices outside the ballot mode, or a protocol check at the node | fix the ballot |
| `duplicate` | this vote id is already queued or settled: a ballot of this voter with this `k` in this process is in | nothing: that ballot is in. A revote needs a fresh `k` |
| `slot-busy` | the voter's earlier ballots fill the node's queue | retry later, on the same node |
| `max-voters` | the process has as many voters as it allows | nothing |
| `busy` | the node is at capacity or loading a census | retry shortly, on the same node |
| `unavailable` | no node took it, or none serves the process yet | retry; a new process takes a few blocks to reach the nodes |
| `timeout` | a status wait ran out | check again later |

It can also throw `CensusWitnessError` (a CSP census without `censusProviders.csp`, or an attestation for someone else), `ArtifactError` (the circuit files cannot be loaded or are not the pinned ones), `BallotProofError`, and `RangeError` for a weak `k`. See `references/errors.md`.

## Eligibility and past votes

```ts
await voter.isAddressAbleToVote(processId, address); // a member of the census?
await voter.getAddressWeight(processId, address); // bigint; 0 for a non-member
await voter.hasAddressVoted(processId, address); // a ballot settled in the address's slot?
```

- For a CSP census these ask `censusProviders.csp`; its errors propagate.
- `hasAddressVoted` asks every node. For a CSP census only the nodes that took the ballot know its slot, so every node must answer.
- A voter "has voted" once a ballot settled; a revote is still allowed.

## Proving a vote was recorded

Once settled, `getVoteReceipt(processId, voteId)` returns a tracker proof checked against the registry: see `references/receipts.md`.

## Cross-references

- `references/ballot-modes.md`: what `choices` means per voting system.
- `references/nodes.md`: routing, failover and the revote rule.
- `references/errors.md`: the full catalogue.
- `recipes/cast-vote.ts`.
