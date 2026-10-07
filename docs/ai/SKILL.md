# Davinci SDK (`@vocdoni/davinci-sdk`)

The TypeScript SDK for **DAVINCI**, Vocdoni's private, verifiable voting protocol. An election lives in a `ProcessRegistry` contract (the Gnosis production beta is built in). Voters encrypt their ballot under the election key, prove it valid with a Groth16 proof they compute themselves, sign its vote id and send it to a **sequencer node**. Nodes batch ballots, re-encrypt them, prove each batch in a zkVM and settle it on the registry with the data in EIP-4844 blobs. After the end and a short **grace window**, the tally is decrypted by whoever holds the election key (a node, or a committee: the DKG key network or a Council) and stored on-chain.

One facade, **`DavinciSDK`**, does all of it. The layers below it (`ProcessRegistryService`, the node clients, the census classes, the crypto primitives, the prover) are exported too, for the cases the facade does not cover.

This is the entry point. Find the task in the table below, read the matching `references/` file, and start from a `recipes/` file when one fits.

## How to use this guide

1. **Find the area** in the task → reference table.
2. **Read only the references you need.** Most tasks need one to three.
3. **Start from a recipe** when one fits.
4. **Respect the exact shapes.** One root import; `choices` is one integer per ballot field; `TxStatus` (transactions) and `VoteStatus` (votes) are different enums; weights, results and secrets are `bigint`; node URLs and hosting are always configuration.

## Task → reference

| Goal | Read | Recipe |
| --- | --- | --- |
| Install, configure and `init()` the SDK; networks, node URLs, RPCs | `references/setup.md` | `recipes/bootstrap.ts` |
| Create an election; end, pause, resume, cancel, extend, max voters | `references/process.md` | `recipes/create-process.ts` |
| Choose who holds the election key (the DKG key network or a Council on Gnosis); the organizer secret | `references/key-modes.md` | `recipes/dkg-locked.ts` |
| Close early with notice; the grace window; a live meeting | `references/grace.md` | `recipes/close-early.ts` |
| Build a census: Merkle file, updatable, on-chain contract, CSP | `references/census.md` | `recipes/onchain-census.ts` |
| Titles and questions: the metadata document and its hash | `references/metadata.md` | — |
| Cast a vote; follow its status; eligibility | `references/voting.md` | `recipes/cast-vote.ts` |
| Several nodes: routing, failover, revotes | `references/nodes.md` | — |
| Prove a vote was recorded | `references/receipts.md` | `recipes/receipt.ts` |
| Wait for and read results | `references/results.md` | `recipes/read-results.ts` |
| Configure a voting system (approval, ranking, quadratic…) | `references/ballot-modes.md` | — |
| Call a node's REST API directly | `references/sequencer.md` | — |
| Use the registry directly: events, raw writes, pins | `references/contracts.md` | — |
| Debug an error or a revert | `references/errors.md` | — |
| Understand the protocol | `references/protocol.md` | — |
| Run everything end to end | — | `recipes/full-election.ts` |

## Package shape

The package has a single root export. There are no `/sequencer`, `/contracts` or `/core` subpaths:

```ts
import {
  DavinciSDK, // the facade
  OffchainCensus, // + OffchainDynamicCensus, OnchainCensus, CspCensus, PublishedCensus, CspSigner
  CensusOrigin, // OffchainStatic=1, OffchainDynamic=2, Onchain=3, CSP=4
  KeyMode, // Sequencer=0, DkgAutomatic=1, DkgLocked=2, Council=3
  VoteStatus, // pending | aggregated | processed | settled | error
  TxStatus, // pending | completed | reverted | failed
  VoteError, // a refused vote, with a `reason`
  BallotProver, // BallotProver.terminate() lets a Node script exit
  type Uploader, // publishes census files and metadata documents
} from '@vocdoni/davinci-sdk';
```

It builds on **ethers v6**, `snarkjs` and `circomlibjs`, and runs in Node 18 or newer (ESM `import` or CommonJS `require`) and in browsers, through a bundler.

## Mental model

- **One deployment per SDK instance.** A `DavinciSDK` works with one network (default `'gnosis'`: chain 100 and its registry) and the sequencer nodes you configure. The SDK embeds no node URL and no hosting; you pass `sequencerUrls` and, to create elections, an `uploader`.
- **`init()` is mandatory.** It picks the read RPC, checks that the registry pins what this release proves and verifies, and checks every node's `/info` against the registry. Nodes that are down or observers are left out for the session (`sdk.nodeChecks`).
- **The SDK acts as its signer.** An organizer's signer needs a provider on the network's chain. A voter's can be a bare `Wallet`: the SDK reads the chain through `rpcUrls` or the network's public RPCs. To act as someone else, build another `DavinciSDK`.
- **Voters trust the registry, not the nodes.** The election key, ballot mode and census root come from the contract; a node's view is only cross-checked. The circuit files are checked against the ballot VK hash the registry pins.
- **A vote is asynchronous.** `submitVote` returns once a node queued the ballot (`pending`). Nodes batch votes, so `settled` can take minutes to a quarter of an hour on default nodes; the end flushes everything. A voter may vote again: the latest ballot counts.
- **Results come after the grace window.** From the end, batches of votes cast before it keep landing until the grace window closes (`graceEnd`); only then can the tally be decrypted: by the key node (sequencer key) or the committee (DKG or Council, the latter once its ceremony opens decryption). `waitForResults` follows it.
- **Two status enums.** Transactions report `TxStatus`; votes report `VoteStatus`. Organizer methods come as a stream (`…Stream`, yields `TxStatusEvent`s) and as a plain promise that throws the typed error.
- **Numbers.** `choices` are numbers or bigints, one per ballot field; ballot bounds are decimal strings; weights, results, `k` and the organizer secret are `bigint`.

## The SDK in ~35 lines

```ts
import { BallotProver, DavinciSDK, OffchainCensus, type Uploader } from '@vocdoni/davinci-sdk';
import { JsonRpcProvider, Wallet } from 'ethers';

const sequencerUrls = ['https://sequencer-1.example.org', 'https://sequencer-2.example.org'];

// Your hosting: census files and metadata documents must be served over public https.
const uploader: Uploader = {
  async upload({ data, contentType, sha256 }) {
    const key = `davinci/${sha256.slice(2)}.json`;
    await bucket.put(key, data, { contentType });
    return `https://files.example.org/${key}`;
  },
};

// 1. The organizer: a signer with a provider on Gnosis.
const organizerWallet = new Wallet(process.env.ORGANIZER_KEY!, new JsonRpcProvider(rpcUrl));
const sdk = new DavinciSDK({ signer: organizerWallet, sequencerUrls, uploader });
await sdk.init();

// 2. The census, published through the uploader when the process is created.
const voterWallet = Wallet.createRandom();
const census = new OffchainCensus();
census.add([voterWallet.address, '0x2222222222222222222222222222222222222222']);

// 3. The election: one question, two choices, open for an hour from its creation block.
const { processId } = await sdk.createProcess({
  title: 'Is the sky blue?',
  census,
  electionPreset: { type: 'single_choice' },
  timing: { duration: 3600 },
  questions: [{ title: 'Pick one', choices: [{ title: 'Yes', value: 0 }, { title: 'No', value: 1 }] }],
});

// 4. A voter, from its own SDK: a bare wallet is enough.
const voter = new DavinciSDK({ signer: voterWallet, sequencerUrls });
await voter.init();
const { voteId } = await voter.submitVote({ processId, choices: [1, 0] }); // "Yes"
await voter.waitForVoteStatus(processId, voteId); // settled, or error with the reason

// 5. After the end and the grace window: the decoded tally.
const results = await sdk.waitForResults(processId);
console.log(results.questions[0].choices.map(c => `${c.title}: ${c.total}`));
await BallotProver.terminate(); // Node: stop snarkjs's worker threads
```

`recipes/full-election.ts` is the runnable version, with an early close. Never hand-roll the encrypt, prove and sign steps: `submitVote` builds the ballot from the registry's parameters and checks every step.

## Safe reading order when the task is open-ended

1. `references/setup.md`: configuration and `init()`.
2. `references/process.md`: creating and running an election.
3. `references/census.md`: which census, and the `maxVoters` rule.
4. `references/voting.md`: the vote and its statuses.
5. `references/results.md`: when and how results come.
6. `references/key-modes.md` and `references/grace.md` when the election needs a committee key or a quick close.
7. The closest `recipes/*.ts`.

`references/sequencer.md` and `references/contracts.md` are for when the facade is not enough, `references/errors.md` is the catalogue of failures, and `references/protocol.md` explains the protocol underneath.
