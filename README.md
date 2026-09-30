# Vocdoni DaVinci SDK

TypeScript SDK for the Vocdoni DAVINCI voting protocol.

[![npm version](https://badge.fury.io/js/%40vocdoni%2Fdavinci-sdk.svg)](https://www.npmjs.com/package/@vocdoni/davinci-sdk)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

DAVINCI runs private, verifiable elections on an Ethereum `ProcessRegistry` contract (the Gnosis deployment is built in). A voter encrypts its ballot, proves it valid with a zk-SNARK computed on its own device, signs it and sends it to a **sequencer node**. The nodes, run by independent operators, batch ballots, re-encrypt them and prove each batch in a **zkVM**; the registry verifies the proof and records the new state, with the batch's data published in EIP-4844 blobs. After the end and a short **grace window**, whoever holds the election key (a node, or a **DKG committee**) decrypts only the final tally and proves it on-chain.

Organizers use the SDK to create and run elections, voters to cast and track their votes, and anyone to read results and receipts. It checks what it is told against the registry: the election parameters, the pinned zkVM programs and the ballot circuit files.

## Installation

Requires Node.js 18 or newer, or a current browser.

```bash
npm install @vocdoni/davinci-sdk ethers
yarn add @vocdoni/davinci-sdk ethers
pnpm add @vocdoni/davinci-sdk ethers
```

The package ships ESM (`import`) and CommonJS (`require`) builds with their types, and has a single root export. Browser apps take the ESM build through their bundler (Vite, webpack, esbuild, …).

## Quick start

```typescript
import { BallotProver, DavinciSDK, OffchainCensus, type Uploader } from '@vocdoni/davinci-sdk';
import { JsonRpcProvider, Wallet } from 'ethers';

// The deployment's sequencer nodes: configuration, never built in.
const sequencerUrls = ['https://sequencer-1.example.org', 'https://sequencer-2.example.org'];

// Your hosting for the census file and the metadata document. They must be
// served unchanged over public https; the SDK reads them back before use.
const uploader: Uploader = {
  async upload({ data, contentType, sha256 }) {
    const key = `davinci/${sha256.slice(2)}.json`;
    await bucket.put(key, data, { contentType });
    return `https://files.example.org/${key}`;
  },
};

// Organizer: a signer with a provider on Gnosis, the default network.
const organizer = new DavinciSDK({
  signer: new Wallet(process.env.ORGANIZER_KEY!, new JsonRpcProvider(process.env.GNOSIS_RPC)),
  sequencerUrls,
  uploader,
});
await organizer.init();

const voterWallet = new Wallet(process.env.VOTER_KEY!);
const census = new OffchainCensus();
census.add([voterWallet.address, '0x2222222222222222222222222222222222222222']);

const { processId } = await organizer.createProcess({
  title: 'Community decision',
  description: 'Vote on our next community initiative.',
  census,
  electionPreset: { type: 'single_choice' },
  timing: { duration: 24 * 3600 }, // starts in the block that creates it
  questions: [
    {
      title: 'Which initiative should we prioritize?',
      choices: [
        { title: 'Community garden', value: 0 },
        { title: 'Tech workshop', value: 1 },
        { title: 'Art exhibition', value: 2 },
      ],
    },
  ],
});

// Voter: a bare wallet is enough; the SDK reads the chain through public RPCs.
const voter = new DavinciSDK({ signer: voterWallet, sequencerUrls });
await voter.init();
const vote = await voter.submitVote({ processId, choices: [0, 1, 0] });
const status = await voter.waitForVoteStatus(processId, vote.voteId); // settled, or error with a reason

// Once the election has ended and its grace window closed:
const results = await voter.waitForResults(processId);
for (const c of results.questions[0].choices) console.log(c.title, c.total);

await BallotProver.terminate(); // in Node: stop snarkjs's worker threads so the process exits
```

## Concepts

### An election's life

1. **Creation.** The organizer publishes the census and the metadata document, and registers the process with its ballot mode, timing and key mode.
2. **Voting.** Voters send encrypted, proved and signed ballots to the nodes, from the start to the end. A voter may vote again; its latest ballot counts.
3. **Settlement.** Nodes batch ballots and settle each batch on the registry. A vote goes `pending` → `aggregated` → `processed` → `settled`; batching takes minutes, up to a quarter of an hour with default node settings.
4. **Grace window.** From the end, batches of votes cast before it keep landing until the grace window closes. Every landing pushes it out, up to a cap.
5. **Results.** The key holder decrypts the final tally and stores it with a proof, seconds to a few minutes after the grace window.

### Key modes

| `keyMode` | Who holds the key | Results |
| --- | --- | --- |
| `'sequencer'` (default) | the key node | published by that node only |
| `'dkg'` | a davinci-dkg committee, as threshold shares | decrypted by the committee |
| `'dkg-locked'` | the committee plus the organizer | decrypted once the organizer reveals the secret returned at creation |

### Census origins

| Origin | Class | Members |
| --- | --- | --- |
| static Merkle | `OffchainCensus` | a census file the SDK builds and publishes |
| updatable Merkle | `OffchainDynamicCensus` | the same, replaceable until the end (`updateCensus`) |
| on-chain | `OnchainCensus` | an append-only census contract; members added later can vote |
| CSP | `CspCensus`, `CspSigner` | a credential provider signs each voter's attestation |

## Configuration

```typescript
const sdk = new DavinciSDK({
  signer, // an ethers Signer: a bare Wallet for voters, one with a provider for organizers
  network: 'gnosis', // the default; or { chainId, processRegistry, startBlock?, rpcUrls? }
  sequencerUrls: ['https://sequencer-1.example.org'], // the deployment's nodes (required)
  keySequencerUrl: 'https://sequencer-1.example.org', // issues sequencer keys; default the first node
  rpcUrls: ['https://rpc.example.org'], // chain reads; default the signer's provider, else the preset's RPCs
  uploader, // publishes census files and metadata documents (to create elections)
  documents: { verify: true }, // read back what is published (default)
  artifacts: {}, // where the ballot circuit files come from; default their pinned URLs
  verifyDeployment: true, // check the registry pins at init() (default)
  censusProviders: {}, // `csp`: the attestation source, to vote in a CSP census
});
await sdk.init();
```

`init()` picks the read RPC, checks that the registry pins what this release proves and verifies (program vks, vadcop root, ballot VK hash, verifier code), and checks every node's `/info` against the registry. A node of another deployment fails `init()` (`NodeMismatchError`); a node that is down or an observer is left out for the session and listed in `sdk.nodeChecks`.

**Networks.** A preset (`GNOSIS`, `getNetwork('gnosis')`) carries the chain id, the registry, its deployment block and public RPCs. Any other deployment, such as a local chain, is a `CustomNetwork`. Process ids carry their registry's prefix, so an id of another deployment is refused before any request.

**Node URLs** are always configuration: the SDK embeds none. Ask the operators of the deployment you target.

**Hosting.** The SDK ships no hosting. Creating an election publishes the census file and the metadata document through your `Uploader`, which returns a public URL. Nodes refuse census URLs on private hosts or behind redirects, and a census they cannot load leaves the process ignored, so the SDK downloads each document back as nodes and readers will before anything is sent.

## Creating a process

```typescript
const { processId, organizerSecret, grace } = await sdk.createProcess({
  title: 'Board election',
  census,
  electionPreset: { type: 'multiple_choice', maxSelections: 2 },
  timing: { startDate: '2026-12-07T09:00:00Z', endDate: '2026-12-08T18:00:00Z' },
  questions,
  keyMode: 'dkg-locked', // returns organizerSecret: store it, the results never unlock without it
  grace: 150, // the grace window in seconds, within the registry's floor and ceiling
});
```

- `electionPreset` (`single_choice`, `multiple_choice`, `approval`, `rating`, `ranking`, `quadratic`) or a raw `ballot`: at most 16 fields, bounds as decimal strings.
- Times are checked against the chain clock. Without `startDate` the process starts in the block that creates it.
- `maxVoters` defaults to the member count of a Merkle census object and is required otherwise; the registry caps `maxValue * maxVoters` at 1e12.
- `paused: true` creates it paused: votes queue until `resumeProcess`.
- Refusals name the registry error they avoid (`err.revertName`, e.g. `InvalidStartTime`); nothing is uploaded or sent for a config the registry would reject.

`createProcessStream(config)` yields the transaction's `TxStatus` events (`pending`, `completed`, `failed`, `reverted`) for UIs.

### Organizer controls

| Method | When |
| --- | --- |
| `endProcess`, `pauseProcess`, `resumeProcess`, `cancelProcess` | status changes; END and PAUSE only within the voting period |
| `extendProcess(pid, seconds)` | before the end |
| `closeProcessIn(pid, seconds)` | before the end: an earlier end, with the registry's minimum notice |
| `setProcessGrace(pid, seconds)` | before the end, within `graceFloor..graceCeil` |
| `setProcessMaxVoters(pid, n)` | before the end |
| `updateCensus(pid, census)` | updatable censuses, before the end |
| `updateMetadata(pid, metadata)` | before the end |
| `revealProcessKey(pid, secret)` | `dkg-locked` processes, any time |
| `cancelOpenProcesses()` | cleanup of the account's open processes |

Each has a `…Stream` variant. Every control checks the process and the chain clock first, then simulates the call before signing; a refusal is the operation's error class with the registry error in `revertName`.

### Closing a live meeting

```typescript
const { graceFloor, noticeMin } = await sdk.getGraceParams();
await sdk.setProcessGrace(processId, graceFloor); // or `grace: graceFloor` at creation
await sdk.closeProcessIn(processId, noticeMin); // "voting closes in one minute"
const results = await sdk.waitForResults(processId, { onStatus: s => console.log(s.state) });
```

Nodes flush every vote they hold during the notice; results follow the grace window, a few minutes after the announcement.

## Voting

```typescript
const vote = await voter.submitVote({ processId, choices: [1, 0, 0] });
// { voteId, node, weight, k, status: 'pending', ... }

for await (const s of voter.watchVoteStatus(processId, vote.voteId)) {
  console.log(s.status, s.error ?? '');
}

const receipt = await voter.getVoteReceipt(processId, vote.voteId); // once settled
```

- `choices` holds one integer per ballot field; field `i` is the choice whose metadata `value` is `i`.
- The election key, ballot mode and census root come from the registry, never from a node. The first vote downloads the circuit files (about 44 MB) and checks them against the ballot VK hash the registry pins.
- Votes are routed per voter over the nodes, with failover only when it is safe. **A revote goes to the node that took the voter's previous ballot**, so it settles after it: the SDK remembers that node in memory; an app that reloads stores `vote.node` and passes it back as `node`.
- A refused vote is a `VoteError` with a `reason`: `not-in-census`, `not-started`, `closed`, `invalid`, `duplicate`, `slot-busy`, `max-voters`, `busy`, `unavailable`.
- `isAddressAbleToVote`, `getAddressWeight` (a `bigint`) and `hasAddressVoted` read membership and past votes.
- A receipt is a tracker proof that the vote id is in the process's state, checked against the registry's state roots.

## Results

```typescript
const status = await sdk.getResultsStatus(processId); // voting, grace, awaiting-key-holder, locked, decrypting, results, ...
const results = await sdk.waitForResults(processId);
console.log(results.kind, results.voters);
for (const q of results.questions) {
  for (const c of q.choices) console.log(q.title, c.title, c.total, c.mean);
}
```

Results unlock when the grace window closes. A sequencer key's node publishes them within a couple of minutes; a DKG committee takes a few more; a `dkg-locked` key first needs `revealProcessKey`. The tally is additive: each field's total is the sum over every voter's latest ballot, and census weights are not multiplied in (a weight is a voter's budget when the ballot mode's `maxValueSum` is 0).

## Error handling

Errors are classes: test them with `instanceof`.

```typescript
import { ProcessStatusError, VoteError } from '@vocdoni/davinci-sdk';

try {
  await voter.submitVote({ processId, choices: [1, 0, 0] });
} catch (err) {
  if (err instanceof VoteError && err.reason === 'slot-busy') {
    // the voter's earlier ballots are still queued: retry later, on the same node
  } else throw err;
}

try {
  await sdk.endProcess(processId);
} catch (err) {
  if (err instanceof ProcessStatusError && err.revertName === 'InvalidTimeBounds') {
    await sdk.cancelProcess(processId); // it has not started yet
  } else throw err;
}
```

- Contract errors (`ProcessCreateError`, `ProcessStatusError`, `ProcessDurationError`, …) carry the decoded registry error in `revert` and `revertName`.
- Node errors are `SequencerApiError` (with the node's `code`), `SequencerNetworkError` and `SequencerDecodeError`.
- Setup errors: `DeploymentPinError`, `NodeMismatchError`, `SequencerUnavailableError`, `ArtifactError`.
- Results: `ResultsError` (`canceled`, `locked`, `timeout`); receipts: `VoteReceiptError`.

See [`docs/ai/references/errors.md`](docs/ai/references/errors.md) for the full list.

## Security

- **Registry pins.** `init()` checks that the registry pins the zkVM programs, the vadcop root and the ballot VK hash this release carries, and the verifier's code hash. Disable it only for a deployment you control (`verifyDeployment: { pins }`).
- **Circuit files.** The ballot circuit files are keyed by the ballot VK hash the registry pins. Each file is checked against its pinned sha256, and both verification keys (the file, and the one inside the proving key) must hash to the registry's value; a mirror or a local copy (`artifacts`) is checked the same way. Proofs are verified locally before they are sent (`verifyProof`).
- **Election parameters** come from the registry, never from a node: a node whose view differs is refused.
- **Metadata** is shown only when the served bytes hash to the registry's `metadataHash` (`metadataVerified`). Census and metadata downloads refuse private hosts and redirects.
- **Secrets.** The ballot secret `k` returned by `submitVote` opens the ballot with the election key: keep it private. A `dkg-locked` organizer secret is returned once and never stored or logged by the SDK: losing it loses the results.
- **Trust.** A sequencer key trusts its node with ballot secrecy and with publishing the results; a DKG key moves both to a committee threshold.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Examples

Runnable scripts against a configured deployment live under [`examples/script/`](examples/script): a full election (census, creation, votes, revote, early close, results, receipts) and an election on an on-chain census contract.

## Documentation

- [`docs/ai/`](docs/ai): the guides. Start at [`SKILL.md`](docs/ai/SKILL.md); topic references cover setup, processes, key modes, the grace window, censuses, metadata, voting, nodes, receipts, results, ballot modes, the node client, the contracts, errors and the protocol, and `recipes/` holds runnable files.
- `llms.txt` (index) and `llms-full.txt` (everything in one file) at the repository root, for tools that load documentation by URL:
  - https://raw.githubusercontent.com/vocdoni/davinci-sdk/main/llms.txt
  - https://raw.githubusercontent.com/vocdoni/davinci-sdk/main/llms-full.txt
- [CHANGELOG.md](CHANGELOG.md): 2.0.0 moves the SDK to the zkVM stack, with migration notes.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development setup, tests and conventions.

- TypeScript, with ESLint and Prettier.
- Vitest: offline unit tests (`yarn test:unit`), the contracts on a local anvil chain (`yarn test:anvil`, needs Foundry), and a live suite run on demand (`yarn test:e2e`).

## License

Released under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0`).

AGPL-3.0 is a copyleft license: derivative works and network-deployed applications must make corresponding source available under the same terms.

## Links

- Protocol whitepaper: https://whitepaper.vocdoni.io
- Sequencer node: https://github.com/vocdoni/davinci-sequencer
- Contracts: https://github.com/vocdoni/davinci-contracts
- Discord: https://chat.vocdoni.io
- Telegram: https://t.me/vocdoni_community
- Twitter: https://twitter.com/vocdoni
- Website: https://vocdoni.io
