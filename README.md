# Vocdoni DaVinci SDK

TypeScript SDK for the Vocdoni DaVinci voting protocol.

[![npm version](https://badge.fury.io/js/%40vocdoni%2Fdavinci-sdk.svg)](https://www.npmjs.com/package/@vocdoni/davinci-sdk)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

## Installation

Requires Node.js 18 or newer and an Ethereum signer.

```bash
npm install @vocdoni/davinci-sdk ethers
yarn add @vocdoni/davinci-sdk ethers
pnpm add @vocdoni/davinci-sdk ethers
```

## Quick start

End-to-end example: initialize the SDK, create a process with an off-chain census, submit a vote, and wait for it to settle.

```typescript
import { DavinciSDK, OffchainCensus, VoteStatus } from '@vocdoni/davinci-sdk';
import { Wallet } from 'ethers';

// Substitute your own sequencer and census endpoints.
const SEQUENCER = 'https://sequencer-dev.davinci.vote';
const CENSUS = 'https://c3-dev.davinci.vote';

// Organizer SDK — needs a census URL because we're creating a census.
const organizer = new DavinciSDK({
  signer: new Wallet(process.env.ORGANIZER_KEY!),
  sequencerUrl: SEQUENCER,
  censusUrl: CENSUS,
});
await organizer.init();

// Eligible voters.
const census = new OffchainCensus();
census.add([
  '0x1234567890123456789012345678901234567890',
  '0x2345678901234567890123456789012345678901',
  '0x3456789012345678901234567890123456789012',
]);

const { processId } = await organizer.createProcess({
  title: 'Community Decision',
  description: 'Vote on our next community initiative.',
  census,
  timing: {
    startDate: new Date(Date.now() + 60_000), // starts in one minute
    duration: 86_400,                          // open for 24 hours
  },
  questions: [{
    title: 'Which initiative should we prioritize?',
    choices: [
      { title: 'Community Garden', value: 0 },
      { title: 'Tech Workshop',    value: 1 },
      { title: 'Art Exhibition',   value: 2 },
    ],
  }],
});

// Voter SDK — no census URL needed for voting-only operations.
const voter = new DavinciSDK({
  signer: new Wallet(process.env.VOTER_KEY!),
  sequencerUrl: SEQUENCER,
});
await voter.init();

const { voteId } = await voter.submitVote({
  processId,
  choices: [1],
});

const final = await voter.waitForVoteStatus(processId, voteId, VoteStatus.Settled);
console.log('Vote settled:', final.status);
```

## Concepts

### Voting process lifecycle

1. **Process creation.** The organizer registers a process on-chain with its census, timing, and ballot configuration.
2. **Vote submission.** Eligible voters submit encrypted ballots through the sequencer.
3. **Vote processing.** The sequencer aggregates and verifies votes using zk-SNARKs.
4. **Results.** Final tallies become available once the process settles.

### Key components

- **Census** — set of eligible voters, addressed either off-chain (Merkle tree) or on-chain (token contract).
- **Ballot** — structure describing the questions, choice ranges, and aggregation rules.
- **Process** — the on-chain container holding the census, ballot, timing, and lifecycle status.
- **Proof** — zero-knowledge attestation that a vote is valid without revealing its contents.

## Creating a process

### `createProcess(config)`

Resolves once the process is registered. Use this when you do not need to surface intermediate transaction status.

```typescript
import { DavinciSDK, OffchainCensus } from '@vocdoni/davinci-sdk';

const sdk = new DavinciSDK({ signer, sequencerUrl, censusUrl });
await sdk.init();

const census = new OffchainCensus();
census.add(['0x...', '0x...']);

const result = await sdk.createProcess({
  title: 'Election',
  description: 'Detailed description of the election.',
  census,
  timing: {
    startDate: new Date(Date.now() + 60_000),
    duration: 86_400,
  },
  ballot: {
    numFields: 1,
    maxValue: '2',
    minValue: '0',
    uniqueValues: false,
    costExponent: 1,
    maxValueSum: '2',
    minValueSum: '0',
  },
  questions: [{
    title: 'What is your preferred option?',
    description: 'Choose the option that best represents your view.',
    choices: [
      { title: 'Option A', value: 0 },
      { title: 'Option B', value: 1 },
      { title: 'Option C', value: 2 },
    ],
  }],
});

console.log('Process ID:', result.processId);
```

`OffchainCensus` is published automatically as part of `createProcess`, and `maxVoters` is set to the participant count. For other census types, see Advanced configuration.

### `createProcessStream(config)`

Returns an async iterator of `TxStatus` events for the underlying transaction. Use this in UI flows that need to display submission, mining, and revert states.

```typescript
import { TxStatus } from '@vocdoni/davinci-sdk';

const stream = sdk.createProcessStream(config);

for await (const event of stream) {
  switch (event.status) {
    case TxStatus.Pending:
      console.log('Transaction submitted:', event.hash);
      break;
    case TxStatus.Completed:
      console.log('Process created:', event.response.processId);
      break;
    case TxStatus.Failed:
      console.error('Transaction failed:', event.error);
      break;
    case TxStatus.Reverted:
      console.error('Transaction reverted:', event.reason);
      break;
  }
}
```

Use `createProcess` for scripts and short flows. Use `createProcessStream` when the caller needs per-event UI feedback.

## Submitting a vote

### `submitVote({ processId, choices, randomness? })`

```typescript
const result = await sdk.submitVote({
  processId: '0x...',
  choices: [1, 0],
});

console.log('Vote ID:', result.voteId);
console.log('Status:', result.status);
```

### `getVoteStatus(processId, voteId)`

```typescript
const status = await sdk.getVoteStatus(processId, voteId);
console.log('Status:', status.status);
```

`VoteStatus` is one of `pending`, `verified`, `aggregated`, `processed`, `settled`, or `error`.

### `waitForVoteStatus(processId, voteId, target, timeoutMs?, intervalMs?)`

Polls until the vote reaches `target` or the timeout elapses.

```typescript
import { VoteStatus } from '@vocdoni/davinci-sdk';

const final = await sdk.waitForVoteStatus(
  processId,
  voteId,
  VoteStatus.Settled,
  300_000, // 5 minute timeout
  5_000,   // 5 second poll interval
);
```

### Eligibility checks

```typescript
// Has this address already cast a vote in this process?
const voted = await sdk.hasAddressVoted(processId, voterAddress);

// Is this address allowed to vote, and with what weight?
const info = await sdk.isAddressAbleToVote(processId, voterAddress);
console.log('Key:', info.key, 'weight:', info.weight);
```

## Advanced configuration

<details>
<summary>Other census types</summary>

#### `OffchainDynamicCensus`

Off-chain Merkle census whose participants can be updated after process creation.

```typescript
import { OffchainDynamicCensus } from '@vocdoni/davinci-sdk';

const census = new OffchainDynamicCensus();
census.add([
  { key: '0x...', weight: 10 },
  { key: '0x...', weight: 20 },
]);

await sdk.createProcess({ census, /* ... */ });
```

#### `CspCensus`

Census whose membership is attested by an external Credential Service Provider.

```typescript
import { CspCensus } from '@vocdoni/davinci-sdk';

const census = new CspCensus(
  '0x1234567890abcdef',           // CSP root (public key)
  'https://csp-server.example',
);

await sdk.createProcess({
  census,
  maxVoters: 1000, // required for CSP census
  // ...
});
```

#### `PublishedCensus`

Reuse a census already published to the network.

```typescript
import { PublishedCensus, CensusOrigin } from '@vocdoni/davinci-sdk';

const census = new PublishedCensus(
  CensusOrigin.OffchainStatic,
  '0xroot...',
  'ipfs://uri...',
);

await sdk.createProcess({
  census,
  maxVoters: 100,
  // ...
});
```

#### `OnchainCensus`

Token-gated census backed by an ERC-20 or ERC-721 contract, with off-chain holder data sourced from a subgraph.

```typescript
import { OnchainCensus } from '@vocdoni/davinci-sdk';

const census = new OnchainCensus(
  '0xTokenContract...',
  'https://api.studio.thegraph.com/query/12345/token-holders/v1.0.0',
);

await sdk.createProcess({
  census,
  maxVoters: 10_000,
  // ...
});
```

The contract address is validated on construction; no publishing step is required.

</details>

<details>
<summary>Custom contract addresses</summary>

By default the SDK fetches the `ProcessRegistry` address from the sequencer's `/info` endpoint during `init()`. Override with `addresses.processRegistry` when running against a non-default deployment.

```typescript
const sdk = new DavinciSDK({
  signer,
  sequencerUrl,
  addresses: {
    processRegistry: '0xYourRegistryAddress...',
  },
});
```

</details>

<details>
<summary>Custom vote randomness</summary>

Pass a hex-encoded `randomness` value to `submitVote` to override the SDK's default entropy source. Used primarily for deterministic test fixtures.

```typescript
const result = await sdk.submitVote({
  processId,
  choices: [1],
  randomness: '0xabc...',
});
```

</details>

<details>
<summary>Direct service access</summary>

The high-level `DavinciSDK` composes three lower-level services. Each is reachable when you need an endpoint the facade does not surface.

```typescript
// Sequencer REST client
const process = await sdk.api.sequencer.getProcess(processId);

// Census REST client
const proof = await sdk.api.census.getCensusProof(root, address);

// CSP client (lazy-initialized)
const csp = await sdk.getCSP();
```

</details>

<details>
<summary>Manual census configuration</summary>

`createProcess` also accepts a plain census descriptor when you already have a published root and URI.

```typescript
import { CensusOrigin } from '@vocdoni/davinci-sdk';

await sdk.createProcess({
  census: {
    type: CensusOrigin.OffchainStatic,
    root: '0xabc...',
    uri: 'ipfs://...',
  },
  maxVoters: 100,
  // ...
});
```

</details>

## Error handling

`submitVote`, `createProcess`, and the process lifecycle methods throw `Error` instances whose `message` describes the failure. Discriminate by inspecting the message.

```typescript
try {
  await sdk.submitVote({ processId, choices: [1, 2, 3] });
} catch (err) {
  const msg = (err as Error).message;
  if (msg.includes('already voted'))            { /* the voter has already submitted */ }
  else if (msg.includes('not accepting votes')) { /* voting period is closed */ }
  else if (msg.includes('out of range'))        { /* a choice is outside the configured range */ }
  else                                          { throw err; }
}
```

Common error categories:

- **Process errors** — process not found, not accepting votes, invalid configuration.
- **Vote errors** — already voted, invalid choices, proof generation failed.
- **Network errors** — connection failures, transaction failures.
- **Validation errors** — invalid parameters, out-of-range values.

## Examples

A runnable end-to-end script lives under [`examples/script/`](examples/script). It exercises the full lifecycle — process creation, vote submission, and settlement — against a configurable sequencer and census service.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup, branching, and PR conventions.

Code quality tools:

- TypeScript — full type safety
- ESLint — linting and style
- Prettier — formatting
- Vitest — unit and integration test runner
- Husky — pre-commit hooks

## License

Released under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0`).

AGPL-3.0 is a copyleft license: derivative works and network-deployed applications must make corresponding source available under the same terms.

## Links

- Protocol whitepaper — https://whitepaper.vocdoni.io
- API documentation — https://github.com/vocdoni/davinci-node/tree/main/api
- Discord — https://chat.vocdoni.io
- Telegram — https://t.me/vocdoni_community
- Twitter — https://twitter.com/vocdoni
- Website — https://vocdoni.io