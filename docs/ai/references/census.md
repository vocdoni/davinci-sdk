# `references/census.md` — Censuses (who may vote)

Companion to the [[davinci-sdk]] skill. A **census** defines the eligible voters and their weights. You pick a census *class*, hand it to `createProcess`, and the facade publishes/normalizes it. This file covers the five census classes, the `CensusOrigin` enum, the all-important `maxVoters` rule, the low-level census REST service, and CSP voting.

## `CensusOrigin`

```ts
enum CensusOrigin {
  OffchainStatic  = 1,   // fixed off-chain Merkle tree
  OffchainDynamic = 2,   // off-chain Merkle tree you can append to during voting
  Onchain         = 3,   // on-chain contract (ERC20/721 token holders, etc.)
  CSP             = 4,   // credential service provider (blind-signature style)
}
```

## The five census classes

All extend an abstract `Census`. Merkle-based ones (`OffchainCensus`, `OffchainDynamicCensus`) collect participants locally and must be **published**; the rest reference an already-existing source and are ready on construction.

### `OffchainCensus` — static Merkle tree (the common case)

```ts
import { OffchainCensus } from "@vocdoni/davinci-sdk";

const census = new OffchainCensus();
census.add("0xAbc…");                                  // single address, weight = 1
census.add(["0xAaa…", "0xBbb…"]);                       // many addresses, weight = 1
census.add({ key: "0xCcc…", weight: 5 });               // weighted (string | number | bigint)
census.add([{ key: "0xDdd…", weight: "100" }, { key: "0xEee…", weight: 10n }]);
```

Read/inspect:

```ts
census.remove("0xAbc…");
census.getWeight("0xCcc…");   // "5" | undefined
census.addresses;             // string[]
census.participants;          // { key: string; weight: string }[]
census.isPublished;           // false until createProcess publishes it
census.censusRoot;            // null until published
census.censusURI;             // null until published
```

`createProcess` auto-publishes it (requires `censusUrl` on the SDK). After creation, `census.isPublished === true` and `censusRoot`/`censusURI` are populated. `maxVoters` defaults to the participant count.

### `OffchainDynamicCensus` — appendable Merkle tree

Same API as `OffchainCensus`, but the census may grow during the voting period (new roots get published; never remove voters or change weights — that would enable double voting). Use when eligibility is still being added after the process starts.

### `CspCensus` — credential service provider

```ts
import { CspCensus } from "@vocdoni/davinci-sdk";
const census = new CspCensus(cspPublicKey /* = censusRoot */, "https://csp-server.example");
```

Voter eligibility is certified by a CSP signature instead of a Merkle proof. No local participant list, no publishing. **`maxVoters` is required** at process creation, and **voting requires a CSP proof provider** (see "CSP voting" below).

### `OnchainCensus` — token holders / on-chain source

```ts
import { OnchainCensus } from "@vocdoni/davinci-sdk";
const census = new OnchainCensus(
  "0xTokenOrCensusContract…",                 // contract address (ERC20/721/custom)
  "graphql://indexer.example/137/0xToken…/graphql"  // indexer/subgraph URI to read holders
);
census.contractAddress;   // getter
```

Uses existing on-chain data; nothing to publish. `censusRoot` is set to the 32-byte zero value and the contract address is passed through to the chain. **`maxVoters` is required.** The sequencer imports voter weights from the indexer after creation — expect a short delay before voters appear (poll `sdk.api.sequencer.getAddressWeight`). See `recipes/token-census.ts`.

### `PublishedCensus` — reuse an already-published census

```ts
import { PublishedCensus, CensusOrigin } from "@vocdoni/davinci-sdk";
const census = new PublishedCensus(CensusOrigin.OffchainStatic, "0xroot…", "https://…/census");
```

Wraps a census published in a prior session. Read-only; **`maxVoters` is required**.

## `maxVoters` requirement summary

| Class                    | Publishing | `maxVoters` at `createProcess` |
| ------------------------ | ---------- | ------------------------------ |
| `OffchainCensus`         | auto       | optional (defaults to count)   |
| `OffchainDynamicCensus`  | auto       | optional (defaults to count)   |
| `OnchainCensus`          | none       | **required**                   |
| `CspCensus`              | none       | **required**                   |
| `PublishedCensus`        | none       | **required**                   |
| manual `{type,root,size,uri}` | none  | **required**                   |

## Manual census config (advanced)

Skip the classes entirely:

```ts
await sdk.createProcess({
  census: { type: CensusOrigin.OffchainStatic, root: "0xroot…", size: 100, uri: "https://…" },
  maxVoters: 100,
  // …
});
```

## Low-level census service: `sdk.api.census`

For building/inspecting censuses outside `createProcess`'s auto-publish. This is `VocdoniCensusService` (needs `censusUrl`). Key methods:

```ts
sdk.api.census.createCensus(): Promise<string>                       // → working censusId
sdk.api.census.addParticipants(censusId, participants): Promise<void> // [{ key, weight }]
sdk.api.census.publishCensus(censusId): Promise<PublishCensusResponse> // { root, uri, size, … }
sdk.api.census.getCensusRoot(censusId): Promise<string>
sdk.api.census.getCensusSize(censusIdOrRoot): Promise<number>         // auto-detects id vs root
sdk.api.census.getCensusProof(censusRoot, key): Promise<CensusProof>  // membership proof
sdk.api.census.deleteCensus(censusId): Promise<void>
```

```ts
// Build, publish, then create a process against the published root:
const censusId = await sdk.api.census.createCensus();
await sdk.api.census.addParticipants(censusId, [{ key: addr, weight: "1" }]);
const { root, uri, size } = await sdk.api.census.publishCensus(censusId);
await sdk.createProcess({ census: { type: CensusOrigin.OffchainStatic, root, size, uri },
                          maxVoters: size, /* … */ });
```

## How voting fetches the census proof

You usually don't touch this — `submitVote` does it. For reference:

- **Merkle censuses** (Offchain*/Onchain): the SDK fetches just the voter's **weight** from the sequencer (`getAddressWeight`); the full Merkle proof isn't needed in the vote payload.
- **CSP census**: the SDK calls your **CSP proof provider** (there is no default), which must return a `CSPCensusProof`.

### CSP voting (`censusProviders.csp`)

A voter on a CSP census must supply a `csp` provider in the SDK config:

```ts
import { DavinciSDK, CensusOrigin } from "@vocdoni/davinci-sdk";

const voter = new DavinciSDK({
  signer: new Wallet(voterPk),
  sequencerUrl,
  censusProviders: {
    csp: async ({ processId, address }) => {
      // Obtain a CSP credential. The bundled DavinciCSP helper can sign for testing:
      const csp = await sdk.getCSP();                  // any initialised SDK instance
      const out = await csp.cspSign(CensusOrigin.CSP, CSP_PRIVATE_KEY, processId, address, weight);
      return {
        censusOrigin: CensusOrigin.CSP,
        root: out.root, address: out.address, weight,
        processId: out.processId, publicKey: out.publicKey,
        signature: out.signature, voterIndex: out.index,
      };
    },
  },
});
await voter.init();
await voter.submitVote({ processId, choices });
```

`CSPCensusProof` shape: `{ root, address, weight, censusOrigin: CSP, processId, publicKey, signature, voterIndex? }`. In production the provider would call your real CSP server rather than signing locally. `sdk.getCSP()` returns a `DavinciCSP` helper with `cspSign(...)` and `cspCensusRoot(censusOrigin, privKey)` (used to derive the root you pass to `new CspCensus(root, uri)`).

## Cross-references

- `references/process.md` — passing the census to `createProcess` and the `maxVoters` rule.
- `references/voting.md` — the vote flow that consumes census proofs.
- `recipes/token-census.ts` — full `OnchainCensus` flow.
