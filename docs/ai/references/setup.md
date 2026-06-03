# `references/setup.md` — Install, construct, `init()`, environment

Companion to the [[davinci-sdk]] skill. Read this first when starting a Davinci project.

## Install

```sh
npm install @vocdoni/davinci-sdk ethers
# bundled runtime deps: @noble/curves, @noble/hashes, circomlibjs, snarkjs
```

Node ≥ 18 (for global `fetch`) or a modern browser. `ethers` v6 is a peer you import yourself.

## Single root import — there are no subpaths

```ts
import {
  DavinciSDK,
  OffchainCensus, OffchainDynamicCensus, CspCensus, OnchainCensus, PublishedCensus,
  CensusOrigin, VoteStatus, TxStatus,
} from "@vocdoni/davinci-sdk";
```

`@vocdoni/davinci-sdk` exports **only** the package root (its `package.json` `exports` map has a single `"."` entry). Do **not** write `@vocdoni/davinci-sdk/sequencer`, `/contracts`, or `/core` — those paths do not exist.

## Construct the facade

```ts
import { JsonRpcProvider, Wallet } from "ethers";
import { DavinciSDK } from "@vocdoni/davinci-sdk";

const sdk = new DavinciSDK({
  signer: new Wallet(PRIVATE_KEY, new JsonRpcProvider(RPC_URL)),
  sequencerUrl: SEQUENCER_API_URL,   // required
  censusUrl: CENSUS_API_URL,         // optional — only to publish Merkle censuses
});
await sdk.init();                    // REQUIRED before any other method
```

### `DavinciSDKConfig`

```ts
interface DavinciSDKConfig {
  signer: Signer;                    // ethers v6 Signer (required)
  sequencerUrl: string;              // sequencer REST base URL (required)
  censusUrl?: string;                // census service base URL (optional)
  addresses?: { processRegistry?: string };  // override; else fetched from sequencer /info
  censusProviders?: CensusProviders; // custom proof providers (CSP voting needs one)
  verifyCircuitFiles?: boolean;      // verify downloaded circuit hashes (default: true)
  verifyProof?: boolean;             // verify generated proof before submit (default: true)
}
```

- **`censusUrl`** is needed only when you build and publish a Merkle census (`OffchainCensus` / `OffchainDynamicCensus`) — i.e. on the *organizer* who calls `createProcess`, and on a *voter* who needs the sequencer to fetch its census proof. It is **not** needed for an organizer using a pre-published / on-chain / CSP census, and you can omit it for voting if you supply a custom `censusProviders`.
- **Contract addresses are auto-resolved.** Leave `addresses` unset and `init()` reads `processRegistry` for the signer's chain from the sequencer's `/info`. Only set `addresses.processRegistry` to pin a custom deployment.
- **Keep `verifyCircuitFiles` / `verifyProof` on** (the defaults) unless you have a measured reason: they protect against tampered circuit downloads and malformed proofs.

## The signer-vs-provider rule (the #1 setup gotcha)

| Operation                                                | Needs `signer.provider`? |
| -------------------------------------------------------- | ------------------------ |
| `createProcess`, `createProcessStream`                   | **Yes** (on-chain tx)    |
| `getProcess` (rich `ProcessInfo` from the contract)      | **Yes**                  |
| `endProcess`/`pauseProcess`/`cancelProcess`/`resumeProcess`/`setProcessMaxVoters` | **Yes** |
| `submitVote`                                             | No — bare `Wallet` is fine |
| `getVoteStatus`/`watchVoteStatus`/`waitForVoteStatus`    | No                       |
| `hasAddressVoted`/`isAddressAbleToVote`/`getAddressWeight`| No                       |
| `sdk.api.sequencer.getProcess` (lightweight, REST)       | No                       |

So an **organizer** wallet must be `new Wallet(pk, provider)`; a **voter** wallet can be `new Wallet(pk)`. Calling an on-chain method without a provider throws: *"Provider required for blockchain operations…"*. To act as two different people in one script, build two `DavinciSDK` instances.

```ts
// organizer (on-chain) — provider required
const organizer = new DavinciSDK({ signer: new Wallet(pk, provider), sequencerUrl, censusUrl });
// voter (voting only) — no provider
const voter = new DavinciSDK({ signer: new Wallet(voterPk), sequencerUrl, censusUrl });
await organizer.init(); await voter.init();
```

## Environment variables (from the SDK's example `.env`)

```
SEQUENCER_API_URL=https://sequencer-dev.davinci.vote   # sequencer REST base URL
CENSUS_API_URL=https://c3-dev.davinci.vote             # census service base URL
RPC_URL=https://...                                     # ethers JsonRpcProvider endpoint
PRIVATE_KEY=...                                         # organizer/voter EOA key (no 0x ok)
```

Known endpoints (verify against current docs / the sequencer's `/info`):

| Env      | Sequencer                              | Census                       |
| -------- | -------------------------------------- | ---------------------------- |
| Dev      | `https://sequencer-dev.davinci.vote`   | `https://c3-dev.davinci.vote`|
| Staging  | `https://sequencer1.davinci.vote`      | (per docs)                   |

The **chain is determined by the sequencer**, not by you — the RPC must point at the chain the sequencer expects. The voter/organizer needs testnet gas on that chain to create/end processes (voting itself is gasless for the voter — it goes to the sequencer, not on-chain).

## ethers v6 (this SDK is v6, not v5)

| v5 (legacy `@vocdoni/sdk`)                  | v6 (Davinci SDK)                          |
| ------------------------------------------- | ----------------------------------------- |
| `new ethers.providers.JsonRpcProvider(url)` | `new ethers.JsonRpcProvider(url)`         |
| `ethers.utils.parseUnits(...)`              | `ethers.parseUnits(...)`                  |
| `BigNumber`                                 | native `bigint`                           |
| `provider.getNetwork()` → `{chainId: number}` | → `{chainId: bigint}` (use `Number(...)`)|

## Sanity check after `init()`

```ts
const info = await sdk.api.sequencer.getInfo();   // reachable? which chains/circuits?
const net  = await provider.getNetwork();
const supported = Object.values(info.networks).some(n => n.chainID === Number(net.chainId));
console.assert(supported, "RPC chain not supported by this sequencer");
```

A chain mismatch here is the root cause of most later "process not found" / proof-verification failures.

## Cross-references

- `references/process.md` — `createProcess` and lifecycle.
- `references/census.md` — which census class, and the `maxVoters` rule.
- `references/voting.md` — the encrypted-vote flow.
- `recipes/bootstrap.ts` — this wiring as a runnable file.
