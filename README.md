# DAVINCI SDK

TypeScript SDK for [DAVINCI](https://davinci.vote), the Vocdoni protocol for private, verifiable elections on Ethereum. Organizers use it to create and run elections, voters to cast and track their votes, and anyone to read results and vote receipts.

[![npm version](https://badge.fury.io/js/%40vocdoni%2Fdavinci-sdk.svg)](https://www.npmjs.com/package/@vocdoni/davinci-sdk)
[![SDK tests](https://github.com/vocdoni/davinci-sdk/actions/workflows/sdk-tests.yml/badge.svg)](https://github.com/vocdoni/davinci-sdk/actions/workflows/sdk-tests.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)

## Overview

An election lives in a `ProcessRegistry` contract; the Gnosis deployment is built in. A voter encrypts its ballot, proves it valid with a zk-SNARK computed on its own device, signs it and sends it to a sequencer node. The nodes, run by independent operators, batch ballots, re-encrypt them and prove each batch in a zkVM. The registry verifies the proof and records the new state, and the batch data is published in EIP-4844 blobs. After the end and a short grace window, whoever holds the election key (a node, or a committee) decrypts only the final tally and proves it on-chain.

`DavinciSDK` covers that whole flow. It takes election parameters from the registry, never from a node, checks at `init()` that the registry pins the zkVM programs and the ballot circuit this release was built for, and verifies the circuit files it downloads. The layers underneath (registry service, node client, census classes, protocol primitives, prover) are exported too.

A voter may vote again; the latest ballot counts. A vote goes `pending` → `aggregated` → `processed` → `settled` as nodes batch it, which takes minutes (up to a quarter of an hour with default node settings). After the end, batches of votes cast before it keep landing until the grace window closes; every landing pushes the window out, up to a cap. The key holder then publishes the tally, seconds to a few minutes later.

### Production beta on Gnosis

The built-in `gnosis` network is the DAVINCI production beta. The production sequencer is `https://sequencer2.davinci.vote`. For elections whose ballots no single party can open, it offers two committees:

- **Automatic** (`keyMode: 'dkg'`): a rotating committee of independent node operators holds the key. Nothing to prepare; results come a few minutes after the grace window. **Recommended for most elections.**
- **Election committee** (`keyMode: 'council'` with a `ceremonyId`): a committee the organizer invites holds the key, set up in the Council app ([davinci-dkg-council](https://github.com/vocdoni/davinci-dkg-council)). Results stay locked until the ceremony opens decryption, on a scheduled date or when its organizer opens it.

During the beta both committees' circuits come from development trusted setups. [`docs/ai/references/key-modes.md`](docs/ai/references/key-modes.md) explains both options, how to create a process with each and what every results state means.

The rest of the stack: [davinci-sequencer](https://github.com/vocdoni/davinci-sequencer) (the node), [davinci-contracts](https://github.com/vocdoni/davinci-contracts) (the registry), [davinci-zkvm](https://github.com/vocdoni/davinci-zkvm) (batch and results proofs), [davinci-dkg](https://github.com/vocdoni/davinci-dkg) (committee keys) and [davinci-circom](https://github.com/vocdoni/davinci-circom) (the ballot circuit). The protocol is described in the [whitepaper](https://whitepaper.vocdoni.io).

## Quick start

Requires Node.js 18 or newer, or a current browser through a bundler. The package ships ESM and CommonJS builds with their types, from a single root export.

```bash
npm install @vocdoni/davinci-sdk ethers   # or: yarn add / pnpm add
```

Save as `election.ts` and run with `npx tsx election.ts`:

```typescript
import { BallotProver, DavinciSDK, OffchainCensus, VoteError, type Uploader } from '@vocdoni/davinci-sdk';
import { JsonRpcProvider, Wallet } from 'ethers';

// Production sequencer on Gnosis (see docs/deployments.md in davinci-sequencer for others).
const sequencerUrls = ['https://sequencer2.davinci.vote'];

// Census files and metadata must be served unchanged over public HTTPS (no redirects).
// Replace with your own store: S3, R2, DO Spaces, IPFS, any static host work.
// UPLOAD_URL: a pre-signed base URL accepting PUT; PUBLIC_URL: the public read base URL.
const { UPLOAD_URL, PUBLIC_URL } = process.env as Record<string, string>;
const uploader: Uploader = {
  async upload({ data, contentType, sha256 }) {
    const name = `${sha256.slice(2)}.json`;
    const res = await fetch(`${UPLOAD_URL}/${name}`, {
      method: 'PUT', body: new Uint8Array(data), headers: { 'content-type': contentType },
    });
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
    return `${PUBLIC_URL}/${name}`;
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
  census,
  electionPreset: { type: 'single_choice' },
  timing: { duration: 24 * 3600 }, // starts in the block that creates it; use closeProcessIn to end early
  keyMode: 'dkg', // Automatic: the recommended option, a rotating committee holds the key
                  // 'council' with a ceremonyId: an Election committee the organizer invites
                  // 'sequencer': sequencer key, lower trust, kept for compatibility
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

// The sequencer indexes the process a few seconds after the transaction mines.
// Retry submitVote up to ~30 s if it comes back unavailable (unknown process).
const vote = await (async () => {
  for (let attempt = 0; ; attempt++) {
    try { return await voter.submitVote({ processId, choices: [0, 1, 0] }); }
    catch (err) {
      if (err instanceof VoteError && err.reason === 'unavailable' && attempt < 10)
        await new Promise(r => setTimeout(r, 3000));
      else throw err;
    }
  }
})();
const status = await voter.waitForVoteStatus(processId, vote.voteId); // settled, or error with a reason

// Once the election has ended and its grace window has closed:
// (to end early use organizer.closeProcessIn(processId, seconds) — see docs/ai/recipes/close-early.ts)
const results = await voter.waitForResults(processId);
// results.questions[0].choices[i].total is a bigint
for (const c of results.questions[0].choices) console.log(c.title, c.total.toString());

await BallotProver.terminate(); // in Node: stop snarkjs's worker threads so the process exits
```

Nodes refuse census files on private hosts or behind redirects, and ignore a process whose census they cannot load, so the SDK reads every document it publishes back before it sends the transaction.

## Usage

### Configuration

| Option | Default | Description |
| --- | --- | --- |
| `signer` | required | An ethers `Signer`. A bare `Wallet` can vote; managing elections needs a provider on the network's chain. |
| `sequencerUrls` | required | The deployment's sequencer nodes. Votes are routed among them per voter, with failover. |
| `network` | `'gnosis'` | A preset name, or `{ chainId, processRegistry, startBlock?, rpcUrls? }` for another deployment. |
| `uploader` | none | Publishes census files and metadata documents. Required to create elections. |
| `rpcUrls` | signer's provider, else the preset's | JSON-RPCs for chain reads, in order of preference. |
| `keySequencerUrl` | first usable node | The node that issues sequencer election keys and publishes their results. |
| `censusProviders` | none | `csp`: where voters get their attestation in a CSP census. |
| `documents` | `{ verify: true }` | How documents are downloaded and read back; `allowPrivateHosts` for local development. |
| `artifacts` | pinned URLs (CDN, then GitHub) | A mirror, local directory or cache for the ballot circuit files, still checked against their pins. |
| `verifyDeployment` | `true` | Check the registry pins at `init()`; `{ pins }` for a deployment you control. |
| `verifyProof` | `true` | Verify each ballot proof locally before it is sent. |

`init()` checks that the registry pins the program vks, vadcop root, ballot VK hash and verifier code of this release, and checks every node's `/info` against the registry. A node of another deployment fails `init()` with `NodeMismatchError`; one that is down or an observer is left out for the session and listed in `sdk.nodeChecks`. Process ids carry their registry's prefix, so an id of another deployment is refused before any request.

### Creating an election

```typescript
const { processId, organizerSecret } = await sdk.createProcess({
  title: 'Board election',
  census,
  electionPreset: { type: 'multiple_choice', maxSelections: 2 },
  timing: { startDate: '2026-12-07T09:00:00Z', endDate: '2026-12-08T18:00:00Z' },
  questions,
  keyMode: 'dkg-locked', // returns organizerSecret: store it, the results never unlock without it
  grace: 150, // seconds, within the registry's graceFloor..graceCeil
});
```

- `electionPreset` is one of `single_choice`, `multiple_choice`, `approval`, `rating`, `ranking` or `quadratic`. A raw `ballot` mode works too: at most 16 fields, bounds as decimal strings.
- Times are checked against the chain clock. Without `startDate` the process starts in the block that creates it.
- `maxVoters` defaults to the member count of a Merkle census object and is required otherwise. The registry caps `maxValue * maxVoters` at 1e12.
- `paused: true` creates the process paused: votes queue until `resumeProcess`.
- A config the registry would reject is refused before anything is uploaded or sent, with the registry error in `err.revertName` (e.g. `InvalidStartTime`).
- `createProcessStream(config)` yields the transaction's `TxStatus` events for UIs.

| Census class | Members |
| --- | --- |
| `OffchainCensus` | a Merkle census file the SDK builds and publishes |
| `OffchainDynamicCensus` | the same, replaceable until the end with `updateCensus` |
| `OnchainCensus` | an append-only census contract; members added later can vote |
| `CspCensus`, `CspSigner` | a credential service provider signs each voter's attestation |

| `keyMode` | Who holds the key | Results |
| --- | --- | --- |
| `'sequencer'` (default) | the key node | published by that node |
| `'dkg'` | a davinci-dkg committee, as threshold shares | decrypted by the committee |
| `'dkg-locked'` | the committee plus the organizer | decrypted once the organizer reveals the secret returned at creation |
| `'council'` | a Council committee the organizer invited (`ceremonyId`) | decrypted by the committee once its ceremony opens decryption |

### Managing an election

| Method | When |
| --- | --- |
| `endProcess`, `pauseProcess`, `resumeProcess`, `cancelProcess` | status changes; end and pause only within the voting period |
| `extendProcess(pid, seconds)`, `setProcessMaxVoters(pid, n)`, `updateMetadata(pid, metadata)` | before the end |
| `closeProcessIn(pid, seconds)` | before the end: an earlier end, with the registry's minimum notice |
| `setProcessGrace(pid, seconds)` | before the end, within `graceFloor..graceCeil` |
| `updateCensus(pid, census)` | updatable censuses, before the end |
| `revealProcessKey(pid, secret)` | `dkg-locked` processes, any time |
| `cancelOpenProcesses()` | cleanup of the account's open processes |

Each method except `cancelOpenProcesses` has a `…Stream` variant. The SDK checks the process and the chain clock first, then simulates the call before signing. To close a live meeting ("voting closes in one minute"):

```typescript
const { graceFloor, noticeMin } = await sdk.getGraceParams();
await sdk.setProcessGrace(processId, graceFloor); // or `grace: graceFloor` at creation
await sdk.closeProcessIn(processId, noticeMin);
const results = await sdk.waitForResults(processId, { onStatus: s => console.log(s.state) });
```

Nodes flush every vote they hold during the notice, and results follow a few minutes after the announcement.

### Voting

```typescript
const vote = await voter.submitVote({ processId, choices: [1, 0, 0] });
// { voteId, node, weight, k, status: 'pending', ... }

for await (const s of voter.watchVoteStatus(processId, vote.voteId)) {
  console.log(s.status, s.error ?? '');
}

const receipt = await voter.getVoteReceipt(processId, vote.voteId); // once settled
```

- `choices` holds one integer per ballot field; field `i` is the choice whose metadata `value` is `i`.
- The first vote downloads the circuit files (about 44 MB) and checks them against the ballot VK hash the registry pins.
- A revote goes to the node that took the voter's previous ballot, so it settles after it. The SDK remembers that node in memory; an app that reloads stores `vote.node` and passes it back as `node`.
- A refused vote is a `VoteError` with a `reason`: `not-in-census`, `not-started`, `closed`, `invalid`, `duplicate`, `slot-busy`, `max-voters`, `busy` or `unavailable`.
- `isAddressAbleToVote`, `getAddressWeight` (a `bigint`) and `hasAddressVoted` read membership and past votes.
- A receipt is a tracker proof that the vote id is in the process's state, checked against the registry's state roots.

### Results

```typescript
const status = await sdk.getResultsStatus(processId); // voting, grace, awaiting-opening, decrypting, results, ...
const results = await sdk.waitForResults(processId);
console.log(results.kind, results.voters);
for (const q of results.questions) {
  for (const c of q.choices) console.log(q.title, c.title, c.total, c.mean);
}
```

Results unlock when the grace window closes. A sequencer key's node publishes them within a couple of minutes, a DKG committee takes a few more, and a `dkg-locked` key first needs `revealProcessKey`. A Council process reports `awaiting-opening` (with `status.decryptionOpening`) until its ceremony opens decryption, then its committee decrypts. The tally is additive: each field's total is the sum over every voter's latest ballot. Census weights are not multiplied in; a weight is a voter's budget when the ballot mode's `maxValueSum` is 0.

### Errors

Errors are classes: test them with `instanceof`.

```typescript
import { ProcessStatusError } from '@vocdoni/davinci-sdk';

try {
  await sdk.endProcess(processId);
} catch (err) {
  if (err instanceof ProcessStatusError && err.revertName === 'InvalidTimeBounds') {
    await sdk.cancelProcess(processId); // it has not started yet
  } else throw err;
}
```

- Contract errors (`ProcessCreateError`, `ProcessStatusError`, `ProcessDurationError`, …) carry the decoded registry error in `revert` and `revertName`.
- A refused vote is a `VoteError` with a `reason` (see [Voting](#voting)); `slot-busy` and `busy` mean retry later on the same node.
- Node errors are `SequencerApiError` (with the node's `code`), `SequencerNetworkError` and `SequencerDecodeError`.
- Setup errors: `DeploymentPinError`, `NodeMismatchError`, `SequencerUnavailableError`, `ArtifactError`.
- Results: `ResultsError` (`canceled`, `locked`, `timeout`); receipts: `VoteReceiptError`.

### Secrets and trust

- A `dkg-locked` election's `organizerSecret` is returned once and never stored or logged by the SDK. Losing it loses the results.
- The ballot secret `k` returned by `submitVote` opens the ballot with the election key: keep it private, and never pass it to another vote. Every ballot, revotes included, needs a fresh `k`, which `submitVote` draws when `k` is left out: two ballots under one `k` expose the difference of their choices, and no node refuses them.
- A sequencer key trusts its node with ballot secrecy and with publishing the results; the DKG and Council key modes move both to a committee threshold.

## Documentation

- [`docs/ai/SKILL.md`](docs/ai/SKILL.md): start here. The model, a short end-to-end example and a map from task to guide.
- [`docs/ai/references/`](docs/ai/references): one guide per topic: setup, processes, key modes, the grace window, censuses, metadata, voting, nodes, receipts, results, ballot modes, the node client, the contracts, errors and the protocol.
- [`docs/ai/recipes/`](docs/ai/recipes): runnable scripts for common tasks.
- [`examples/script/`](examples/script): full elections against a configured deployment, including one on an on-chain census.
- `llms.txt` and `llms-full.txt`: the same guides as an index and a single file, for tools that load documentation by URL ([llms.txt](https://raw.githubusercontent.com/vocdoni/davinci-sdk/main/llms.txt), [llms-full.txt](https://raw.githubusercontent.com/vocdoni/davinci-sdk/main/llms-full.txt)).
- [`CHANGELOG.md`](CHANGELOG.md): release notes, including the migration from 1.x.
- [`SECURITY.md`](SECURITY.md): what the SDK checks, and how to report a vulnerability.

## Development

```bash
yarn install
yarn build        # dist/: ESM and CommonJS builds with types
yarn lint && yarn format:check
yarn test:unit    # offline
yarn test:anvil   # organizer flows on the real contracts, on a local anvil chain (needs Foundry)
yarn docs:check   # llms.txt is current and every documentation code block type-checks
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the test suites, the vendored vectors and ABIs, and the conventions. Questions are welcome on [Discord](https://chat.vocdoni.io).

## License

[GNU Affero General Public License v3.0](LICENSE).
