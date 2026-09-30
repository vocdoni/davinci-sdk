# `references/setup.md` — Install, configure, `init()`

Companion to the [[davinci-sdk]] skill. Read this first when starting a DAVINCI project.

## Install

```sh
npm install @vocdoni/davinci-sdk ethers
```

Node 18 or newer, or a current browser. The package ships ESM (`import`), CommonJS (`require`) and a UMD bundle; ethers v6 is the chain library, and you import it yourself for wallets and providers.

In Node, snarkjs keeps worker threads alive after proving or verifying. A script that votes calls `BallotProver.terminate()` once done, or it will not exit.

## Single root import

```ts
import {
  DavinciSDK,
  OffchainCensus,
  OffchainDynamicCensus,
  OnchainCensus,
  CspCensus,
  PublishedCensus,
  CensusOrigin,
  VoteStatus,
  TxStatus,
} from '@vocdoni/davinci-sdk';
```

The package exports only its root. `@vocdoni/davinci-sdk/sequencer`, `/contracts` and `/core` do not exist.

## Construct and initialize

```ts
import { DavinciSDK } from '@vocdoni/davinci-sdk';
import { JsonRpcProvider, Wallet } from 'ethers';

const sdk = new DavinciSDK({
  signer: new Wallet(process.env.PRIVATE_KEY!, new JsonRpcProvider(rpcUrl)),
  network: 'gnosis', // the default
  sequencerUrls: ['https://sequencer-1.example.org', 'https://sequencer-2.example.org'],
  uploader, // to create elections: publishes census files and metadata
});
await sdk.init(); // required before anything else
```

Node URLs are always configuration: the SDK embeds none, and they belong to whoever runs the nodes of the deployment you target.

### `DavinciSDKConfig`

| Field | Default | What it is |
| --- | --- | --- |
| `signer` | required | ethers `Signer`. It signs votes, and transactions for organizer work. |
| `network` | `'gnosis'` | A known network by name, or `{ chainId, processRegistry, startBlock?, rpcUrls?, name? }` for another deployment. |
| `sequencerUrls` | required | Base URLs of the deployment's sequencer nodes. Votes are routed among them per voter; reads ask them in order. |
| `keySequencerUrl` | first usable node | The node that issues sequencer election keys, and later publishes those elections' results. |
| `rpcUrls` | see below | JSON-RPCs for chain reads, in order of preference. |
| `uploader` | none | Publishes census files and metadata documents (`references/census.md`, `references/metadata.md`). |
| `documents` | | How documents are downloaded and checked: `fetchImpl`, `timeoutMs` (30 s stall), `verify` (read back what is published, default true), `allowPrivateHosts` (local development). |
| `artifacts` | pinned table | Where the ballot circuit files come from (below). |
| `verifyDeployment` | `true` | Check the registry pins at `init()`. `{ pins }` checks other pins (a local deployment); `false` skips it. |
| `verifyProof` | `true` | Verify every ballot proof locally before sending it. |
| `sequencerConfig` | | Headers, `fetchImpl`, `timeoutMs` (60 s) and `maxResponseBytes` (16 MiB) of the node clients. |
| `censusProviders` | | Census witnesses for voting: `csp` (required to vote in a CSP census) and `merkle` (replaces the nodes' proofs). |

Deprecated and still accepted: `sequencerUrl` (added to `sequencerUrls`), `addresses.processRegistry` (use `network: { chainId, processRegistry }`), `censusUrl` and `verifyCircuitFiles` (both ignored).

### What `init()` does

1. **Read provider.** `rpcUrls` when given; else the signer's provider when it is on the network's chain; else the network's public RPCs. A voter's bare wallet therefore reads Gnosis through the preset RPCs. Over `rpcUrls` or the preset RPCs, a request that fails or is rate-limited moves to the next endpoint.
2. **Registry.** Its `chainID()` must be the network's (`DeploymentPinError('chainID')`).
3. **Pins** (unless `verifyDeployment: false`): the batch and results program vks, the vadcop root and the ballot VK hash must be the ones this release carries, the verifier's code must hash to the pinned code hash, and the DKG adapter must point back at the registry. A mismatch throws `DeploymentPinError` naming the field.
4. **Nodes.** Every node's `/info` must report the network's chain, registry, ballot VK hash and program vks, or `init()` throws `NodeMismatchError`. A URL that answers but is not a sequencer fails too. Observers and nodes that do not answer are recorded in `sdk.nodeChecks` and left out for the session; a call that needs a node then fails with `SequencerUnavailableError` naming them.

Concurrent `init()` calls share one run, and a failed `init()` can be retried.

```ts
await sdk.init();
for (const node of sdk.nodeChecks) console.log(node.url, node.status, node.reason ?? '');
console.log(sdk.network.name, sdk.network.chainId, sdk.network.processRegistry);
```

## Signer and provider

| Operation | Needs `signer.provider` on the network's chain |
| --- | --- |
| `createProcess`, every organizer control (`endProcess`, `closeProcessIn`, `setProcessGrace`, `revealProcessKey`, …), `finalizeResults` | yes |
| `submitVote`, vote status, receipts, `getProcess`, `getResultsStatus`, `waitForResults`, eligibility reads | no |

An organizer uses `new Wallet(key, provider)` or a browser signer; a voter can use `new Wallet(key)`. A write from a signer without a provider throws "Provider required for blockchain operations", and one from a signer on another chain throws "The signer is on chain X; the gnosis registry is on chain 100.". Both are thrown when a stream is first read, before any event.

## Networks

```ts
import { GNOSIS, NETWORKS, getNetwork, resolveNetwork } from '@vocdoni/davinci-sdk';

GNOSIS.chainId; // 100
getNetwork('gnosis')?.processRegistry;
resolveNetwork('gnosis').processIdPrefix; // bytes 20..23 of every process id the registry assigns
```

A preset carries the chain id, the registry address, its deployment block and public RPCs; the grace settings, the verifier and the DKG adapter are read from the registry. A process id names its registry (bytes 20..23), so the facade refuses an id of another deployment before any request.

Another deployment, such as a local chain:

```ts
const local = new DavinciSDK({
  signer,
  network: {
    name: 'local',
    chainId: 31337,
    processRegistry: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    startBlock: 0,
    rpcUrls: ['http://127.0.0.1:8545'],
  },
  sequencerUrls: ['http://127.0.0.1:9090'],
  verifyDeployment: false, // or { pins } for a deployment that pins other values
  documents: { allowPrivateHosts: true },
});
```

## The uploader

The SDK ships no hosting. Creating an election publishes the census file (Merkle censuses) and the metadata document through `uploader`, and reads each back as nodes and readers will before anything is sent:

```ts
import type { Uploader } from '@vocdoni/davinci-sdk';

const uploader: Uploader = {
  async upload({ kind, data, contentType, sha256 }) {
    // kind: 'census' | 'metadata'; data: the exact bytes to serve
    const key = `davinci/${kind}/${sha256.slice(2)}.json`;
    await bucket.put(key, data, { contentType });
    return `https://files.example.org/${key}`;
  },
};
```

The URL must serve the bytes unchanged over public `http(s)`, with no redirect: nodes refuse private hosts and redirects for a census, and a census they cannot load leaves the process ignored. Any object store, static site or gateway that serves a file at a stable URL works.

## Circuit files

Voters prove their ballot with the `BallotProof(16)` circuit (a 44 MB proving key). The SDK downloads the files once per prover, checks each against its pinned sha256, and checks that the verification key, and the key the proving key carries, hash to the ballot VK hash the registry pins. Nothing else is trusted.

```ts
const sdk = new DavinciSDK({
  signer,
  sequencerUrls: nodeUrls,
  artifacts: {
    baseUrl: 'https://mirror.example.org/davinci-circom', // a mirror serving the same files
    // or dir: '/srv/davinci/artifacts' (Node), or per file: wasm, zkey, vkey
    // cache: new MemoryArtifactCache() shares checked files across provers
  },
});
```

Precedence: a per-file source, then `dir`, then `baseUrl`, then the table URL. `table` adds entries for a ballot VK hash this release does not know (a local deployment); the hash checks apply to them too.

## Sanity check after `init()`

```ts
await sdk.init();
const pins = {
  ballotVkHash: await sdk.registry.getBallotVKHash(),
  graceParams: await sdk.getGraceParams(),
};
console.log(sdk.network.name, pins, sdk.nodeChecks.map(n => `${n.url}: ${n.status}`));
```

`sdk.registry` is the read-only registry through the read provider; `sdk.processes` is the same registry with the signer, for raw writes (`references/contracts.md`).

## Cross-references

- `references/process.md`: creating and running an election.
- `references/nodes.md`: node checks, routing and failover.
- `references/census.md` and `references/metadata.md`: what the uploader publishes.
- `recipes/bootstrap.ts`: this wiring as a runnable file.
