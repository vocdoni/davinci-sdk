# `references/nodes.md` — Several sequencer nodes: routing, failover, revotes

Companion to the [[davinci-sdk]] skill. A deployment is served by several independent sequencer nodes. Any node can take a vote and settle any election, and nodes that lose a settlement race rebuild their state from the winner's blobs. The SDK takes the list of nodes as configuration and spreads voters over them.

## Configuring nodes

```ts
const sdk = new DavinciSDK({
  signer,
  sequencerUrls: ['https://sequencer-1.example.org', 'https://sequencer-2.example.org'],
  keySequencerUrl: 'https://sequencer-1.example.org', // optional
});
await sdk.init();
```

- `sequencerUrls`: the nodes that take votes and answer reads. The SDK embeds none; get them from whoever runs the deployment's nodes.
- `keySequencerUrl`: the node that issues sequencer election keys (default: the first usable node). With a sequencer key only that node can publish the results, so an organizer picks one it trusts to stay up.

## Checks at `init()`

Every node's `/info` is compared with the registry:

| Field | Must equal |
| --- | --- |
| `chainId`, `processRegistry` | the network's |
| `ballotVkHash` | the registry's `ballotVKHash()` |
| `batchProgramVk`, `resultsProgramVk` | the registry's program vks |

- A mismatch fails `init()` with `NodeMismatchError { field, expected, got, node }`: that URL serves another deployment or release. A URL that answers but is not a sequencer fails too.
- An **observer** (it follows the chain but takes no votes and issues no keys) and a node that is **down** (no answer, a 408, 429 or 5xx) are recorded and left out for the session:

```ts
for (const { url, status, reason } of sdk.nodeChecks) {
  console.log(url, status, reason ?? ''); // 'usable' | 'observer' | 'down'
}
```

`init()` succeeds even with no usable node left, so organizer work that needs no node (reads, controls, DKG creations) goes on. A call that needs one fails with `SequencerUnavailableError`, whose `nodes` lists each node left out and why. A new `DavinciSDK` checks the nodes again.

## Per-voter routing

Each voter has its own order of the nodes for each process:

```text
order = nodes sorted by sha256(voter address (20 bytes) ‖ process id (31 bytes) ‖ node URL (UTF-8))
```

`pickNode(voter, processId, urls)` computes it (the same function as the Rust client), so a voter always starts at the same node and voters spread evenly. The URL is hashed exactly as configured: keep the same spelling across apps.

## Failover

`submitVote` tries the voter's first node and moves down the order only when that is safe:

| The node… | The SDK |
| --- | --- |
| does not answer, times out (408) or fails (5xx) | resends once to the same node, then tries the next. The first may have taken the vote, so from then on a "duplicate" (40901) anywhere means the vote is in. |
| does not serve the process (40402) or is an observer (41203) | tries the next |
| refuses the vote (40002 invalid, 41201 closed, …) | stops: every node would refuse it the same way |
| is busy (42903) or the voter's slot is full (40902) | stops: retry later **on the same node** |

Vote status and receipts ask the node that took the vote first, then the others.

## The revote rule

One node keeps a voter's ballots in order: its queue for a ballot slot settles them oldest first. Nodes do not order ballots among themselves. If a voter's first ballot sits on node A and the revote goes to node B, whichever settles last counts, even if it was cast first.

So a revote goes to the node that holds the voter's previous ballot:

- `VoteResult.node` names the node that took a vote.
- The SDK remembers it per voter, in memory, and sends the voter's next ballot there first.
- An app that reloads, runs in several tabs or lets the voter revote from another device stores `VoteResult.node` with the vote and passes it back as `VoteConfig.node`:

```ts
const first = await voter.submitVote({ processId, choices: [1, 0] });
// ... persist first.node with the vote ...
await voter.submitVote({ processId, choices: [0, 1], node: first.node });
```

A node given as `node` that is no longer usable is passed over, and the voter's usual order applies.

## Lower level

`sdk.api.nodes` is the `SequencerNodes` wrapper over the usable nodes (`submitVote(vote, node?)`, `getVoteStatus`, `getVoteIdProof`, `order(voter, processId)`, `firstAnswer(call)`); `sdk.api.sequencer` is the key node's `VocdoniSequencerService`. See `references/sequencer.md`.

## Cross-references

- `references/voting.md`: the vote flow and its errors.
- `references/setup.md`: `init()` and the rest of the config.
