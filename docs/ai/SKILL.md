
# Davinci SDK (`@vocdoni/davinci-sdk`)

The TypeScript SDK for **Davinci**, Vocdoni's zk-based voting protocol. It runs private, verifiable elections where ballots are **homomorphically encrypted** (ElGamal) and accompanied by **zk-SNARK validity proofs**, collected and aggregated off-chain by a **sequencer**, with canonical state and results anchored in **Ethereum smart contracts**.

The SDK ships a single high-level facade, **`DavinciSDK`**, that orchestrates all of this. Almost every task goes through it. Lower-level services (`ProcessRegistryService`, the sequencer/census REST clients, the crypto primitives) exist and are reachable, but you reach for them only when the facade doesn't cover a case.

This is the entry point. Read the section matching the task, load the matching `references/` file for the exhaustive API, and lift a `recipes/` file when you need a complete working flow.

## How to use this guide

1. **Find the area** in the task → reference table below.
2. **Read only the references you need** — most tasks need 1–3.
3. **Start from a recipe** when one fits; adapt rather than reinvent the boilerplate.
4. **Respect the exact shapes.** The facade hides most cryptography, but the public shapes still have sharp edges: a single root import (no subpaths), a `choices: number[]` ballot model whose length must equal `ballot.numFields`, two *different* status enums (`TxStatus` for on-chain transactions, `VoteStatus` for vote processing), and `bigint` results. The references spell these out.

## Task → reference

| Goal                                                              | Read                                                  | Recipe                       |
| ----------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------- |
| Install, construct & `init()` the SDK, signer vs provider, env    | `references/setup.md`                                 | `recipes/bootstrap.ts`       |
| Create a process/election; lifecycle (end/pause/cancel/resume)    | `references/process.md`                               | `recipes/create-process.ts`  |
| Choose & build a census (Merkle, dynamic, CSP, on-chain, prebuilt)| `references/census.md`                                | `recipes/create-process.ts`  |
| Cast an encrypted vote; check/await status; eligibility           | `references/voting.md`                                | `recipes/cast-vote.ts`       |
| Configure a voting system (approval/ranked/quadratic/budget…)     | `references/ballot-modes.md`                          | —                            |
| Token-holder / on-chain (ERC20/721) census                        | `references/census.md`                                | `recipes/token-census.ts`    |
| Read results / tally; vote & voter counts                         | `references/process.md`                               | `recipes/read-results.ts`    |
| Talk to the sequencer REST API directly (`sdk.api.sequencer`)     | `references/sequencer.md`                             | —                            |
| Drop to the raw contract service (`sdk.processes`)                | `references/contracts.md`                             | —                            |
| Debug a runtime error / revert / proof / "not accepting votes"    | `references/errors.md`                                | —                            |
| Understand the protocol itself (crypto, lifecycle, why)           | `references/protocol.md`                              | —                            |
| Run the whole thing end to end                                    | —                                                     | `recipes/full-election.ts`   |

## Package shape

`@vocdoni/davinci-sdk` is published with a **single root export** — there are *no* `/sequencer`, `/contracts`, or `/core` subpaths. Import everything from the root:

```ts
import {
  DavinciSDK,            // the facade you'll use 95% of the time
  OffchainCensus,        // + OffchainDynamicCensus, CspCensus, OnchainCensus, PublishedCensus
  CensusOrigin,          // enum: OffchainStatic=1, OffchainDynamic=2, Onchain=3, CSP=4
  VoteStatus,            // pending | verified | aggregated | processed | settled | error
  TxStatus,              // pending | completed | reverted | failed
} from "@vocdoni/davinci-sdk";
```

It depends on **ethers v6**, `@noble/curves`, `@noble/hashes`, `circomlibjs`, and `snarkjs`. Node ≥ 18 (global `fetch`) or a browser.

> ⚠️ If you see code importing `@vocdoni/davinci-sdk/sequencer`, `OrganizationRegistryService`, `VocdoniContracts`, or `deployedAddresses`, it is **wrong / from an older imagined API**. None of those exist. There is no "organization" object in this SDK — the process creator is simply the signer's Ethereum address.

## Mental model

- **One facade, three actors.** The `DavinciSDK` instance acts as whoever its `signer` is. The *organizer* (a signer with a provider) calls `createProcess` and the lifecycle methods. A *voter* (a signer, no provider needed) calls `submitVote`. The *sequencer* is a remote service you talk to via REST — you never run it. To act as a different person, construct a second `DavinciSDK` with that wallet.
- **Two transports, hidden behind the facade.** Canonical state lives in Ethereum contracts (ethers v6); the heavy off-chain work (proof verification, aggregation) is done by the sequencer (REST). `createProcess` coordinates both; you don't.
- **`init()` is mandatory.** Every facade method throws until you `await sdk.init()`. `init()` resolves contract addresses from the sequencer's `/info` and wires the services.
- **Signer with provider ⇒ on-chain ops; signer alone ⇒ voting only.** `createProcess`, `getProcess`, and lifecycle methods need `signer.provider`. `submitVote`, `getVoteStatus`, `hasAddressVoted` do not — a bare `new Wallet(pk)` is fine for voting.
- **The encrypted vote is two-phase, and the SDK does the crypto for you.** `submitVote({ processId, choices })` builds the ballot, ElGamal-encrypts it against the process key, generates the zk-SNARK proof with `snarkjs` (downloading circuits from the sequencer once, then caching), signs, and submits. It returns a `voteId` with an initial `VoteStatus`. The vote only *counts* after the sequencer drives it to `settled` — always `waitForVoteStatus`.
- **`choices` is `number[]`, length === `ballot.numFields`.** Each entry is the value for one ballot field. A single-choice question with N options is encoded as N one-hot fields (`[0,1,0,0]`). Multi-question elections concatenate the fields. See `references/ballot-modes.md`.
- **Two status enums, don't mix them.** On-chain transactions (process create/end/pause/…) report `TxStatus` (`pending|completed|reverted|failed`). Vote processing reports `VoteStatus` (`pending|verified|aggregated|processed|settled|error`).
- **Numbers: `choices`/`maxVoters`/`numFields`/`costExponent` are `number`; ballot bounds (`maxValue`/`minValue`/`maxValueSum`/`minValueSum`) are decimal **strings**; on-chain results/weights come back as `bigint` (or numeric strings from the sequencer).**

## The SDK in ~25 lines (single yes/no question)

```ts
import { JsonRpcProvider, Wallet } from "ethers";
import { DavinciSDK, OffchainCensus, VoteStatus } from "@vocdoni/davinci-sdk";

// 1. Organizer SDK — signer WITH a provider (on-chain ops need it).
const organizer = new Wallet(process.env.PRIVATE_KEY!, new JsonRpcProvider(process.env.RPC_URL));
const sdk = new DavinciSDK({
  signer: organizer,
  sequencerUrl: process.env.SEQUENCER_API_URL!,   // e.g. https://sequencer-dev.davinci.vote
  censusUrl: process.env.CENSUS_API_URL!,         // needed to publish a Merkle census
});
await sdk.init();

// 2. Census of eligible voters (auto-published during createProcess).
const census = new OffchainCensus();
census.add(["0xVoterA…", "0xVoterB…"]);            // weight defaults to 1

// 3. Create the process. One question, two options → 2 one-hot ballot fields.
const { processId } = await sdk.createProcess({
  title: "Is the sky blue?",
  census,                                          // maxVoters auto = participant count
  ballot: { numFields: 2, minValue: "0", maxValue: "1",
            uniqueValues: false, costExponent: 1, minValueSum: "0", maxValueSum: "1" },
  timing: { duration: 3600 },                      // startDate defaults to now+60s
  questions: [{ title: "Pick one",
                choices: [{ title: "Yes", value: 0 }, { title: "No", value: 1 }] }],
});

// 4. Vote AS a voter — a fresh SDK with the voter's wallet (no provider needed).
const voterSdk = new DavinciSDK({ signer: new Wallet(VOTER_PK),
  sequencerUrl: process.env.SEQUENCER_API_URL!, censusUrl: process.env.CENSUS_API_URL! });
await voterSdk.init();
const { voteId } = await voterSdk.submitVote({ processId, choices: [1, 0] }); // votes "Yes"
await voterSdk.waitForVoteStatus(processId, voteId, VoteStatus.Settled);

// 5. Read results (bigint per ballot field).
const info = await sdk.getProcess(processId);
console.log(info.result); // e.g. [ 1n, 0n ] → 1 vote on field 0 ("Yes")
```

The full, runnable version with real-time status streaming is `recipes/full-election.ts`. Don't hand-roll the encrypt/prove step — the facade owns it; you only ever supply `choices`.

## Safe reading order when the task is open-ended

1. `references/setup.md` — construct & `init()`, signer-vs-provider rule, env vars.
2. `references/process.md` — `createProcess` config, lifecycle, `getProcess` / results.
3. `references/census.md` — pick a census class; the `maxVoters` rule per type.
4. `references/voting.md` — `submitVote`, the `choices` model, status polling.
5. `references/ballot-modes.md` — only when the user wants a specific voting system.
6. A `recipes/*.ts` for the closest scenario.

`references/sequencer.md` and `references/contracts.md` are escape hatches for when the facade isn't enough; `references/errors.md` is the gotcha catalogue; `references/protocol.md` explains the cryptography and the *why*.

---

Sourced from [`vocdoni/skills`](https://github.com/vocdoni/skills/tree/main/plugins/davinci-sdk/skills/davinci-sdk) — AGPL-3.0-or-later.
