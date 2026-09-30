# `references/receipts.md` — Vote receipts

Companion to the [[davinci-sdk]] skill. A settled vote's id is a leaf of the process's state tree, whose root the registry holds. A **receipt** is a node's inclusion proof of that leaf (a tracker proof), checked against the registry: it shows the vote was recorded as cast, without revealing what it says.

## Get a receipt

```ts
import { VoteReceiptError } from '@vocdoni/davinci-sdk';

try {
  const receipt = await sdk.getVoteReceipt(processId, voteId);
  console.log(receipt.root, receipt.latest ? 'latest root' : `transition ${receipt.transactionHash}`);
} catch (err) {
  if (err instanceof VoteReceiptError) console.log('not settled yet, or not provable:', err.message);
  else throw err;
}
```

`getVoteReceipt(processId, voteId, node?)`:

1. Asks the node that took the vote first (`node`, or the one this SDK sent it to), then the others, for the vote id's tracker proof.
2. Reads the process from the registry. If the proof names the registry's `latestStateRoot`, it must walk from the vote id's leaf to that root.
3. If it names another root, both are read once more (a batch may have landed in between). A proof of an earlier root must reach it, and that root must be the new root of one of the process's `ProcessStateTransitioned` events, found by scanning the registry logs newest first from the process's creation block.

| `VoteReceipt` | |
| --- | --- |
| `processId`, `voteId` | the vote |
| `root` | the on-chain state root the proof reaches |
| `latest` | `root` is the registry's latest state root |
| `transactionHash`, `blockNumber` | the transition that set `root`, when it is an earlier one |
| `node` | the node that gave the proof |
| `proof` | the tracker proof: `{ processId, voteId, root, siblings }` |

It fails with `VoteReceiptError` when no node holds the vote yet ("has not settled") or when the proof reaches no state root the process ever had.

## When

Ask once the vote is `settled`:

```ts
const final = await sdk.waitForVoteStatus(processId, voteId);
if (final.status === VoteStatus.Settled) {
  const receipt = await sdk.getVoteReceipt(processId, voteId, final.node);
}
```

A receipt stays valid after later batches: the proof then names the latest root again, or an earlier root the event history holds.

## Checking a proof yourself

```ts
import { verifyTrackerProof } from '@vocdoni/davinci-sdk';

const receipt = await sdk.getVoteReceipt(processId, voteId);
const p = await sdk.registry.getProcess(processId);
const ok = verifyTrackerProof(receipt.proof, p.latestStateRoot); // true when `latest`
```

Always check against a root from the registry, never against the root inside the proof alone: a node can build a proof of any root it makes up. `verifyTrackerProof` requires the proof to name that root, carry at most 64 siblings and a vote id in the vote-id range, and walk to it.

## What a receipt does not show

- **What the ballot says.** It is encrypted, and batches re-randomize ballots.
- **That this ballot counts.** A later revote by the same voter replaces it in the tally; the earlier vote id stays in the tree.
- **The stored ballot.** `sdk.api.nodes.firstAnswer(n => n.getBallot(processId, address))` returns the ciphertext in the voter's slot, but silent refreshes change it, so it only shows the slot is occupied.

## Cross-references

- `references/voting.md`: statuses and when a vote settles.
- `references/contracts.md`: `queryEvents` and `eventWindows` for the transition history.
- `recipes/receipt.ts`.
