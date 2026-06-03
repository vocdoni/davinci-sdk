# `references/sequencer.md` — The sequencer REST client (`sdk.api.sequencer`)

Companion to the [[davinci-sdk]] skill. The sequencer is the off-chain service that collects encrypted ballots, verifies their zk proofs, aggregates them, and drives the on-chain state. Its REST client is `VocdoniSequencerService`, reachable as **`sdk.api.sequencer`** (and `sdk.api.census` for the census service — see `references/census.md`). The `DavinciSDK` facade calls these for you; reach here when you need a lightweight, provider-free read or a call the facade doesn't wrap.

```ts
const seq = sdk.api.sequencer;   // VocdoniSequencerService, base URL = config.sequencerUrl
```

## Methods (exact signatures)

```ts
// Health / discovery
seq.ping(): Promise<void>
seq.getInfo(): Promise<InfoResponse>          // circuit URLs+hashes, networks, sequencer addr

// Processes (lightweight, no provider needed)
seq.getProcess(processId: string): Promise<GetProcessResponse>
seq.getProcessKeys(processId: string): Promise<{ encryptionPubKey: [string, string] }>
seq.listProcesses(chainId?: number): Promise<string[]>

// Votes
seq.submitVote(vote: VoteRequest): Promise<void>            // facade builds the VoteRequest
seq.getVoteStatus(processId, voteId): Promise<{ status: VoteStatus }>
seq.hasAddressVoted(processId, address): Promise<boolean>
seq.isAddressAbleToVote(processId, address): Promise<boolean>
seq.getAddressWeight(processId, address): Promise<string>   // "0" if not in census

// Metadata (used by createProcess)
seq.pushMetadata(metadata: ElectionMetadata): Promise<string>   // → content hash
seq.getMetadata(hashOrUrl: string): Promise<ElectionMetadata>
seq.getMetadataUrl(hash: string): string

// Stats
seq.getStats(): Promise<SequencerStats>
seq.getWorkers(): Promise<WorkersResponse>
```

No network call on construction. The base URL comes from the SDK config.

## `getInfo` — the source of circuit artifacts & chains

```ts
interface InfoResponse {
  circuitUrl: string;        circuitHash: string;          // ballot-proof WASM
  provingKeyUrl: string;     provingKeyHash: string;        // zkey
  verificationKeyUrl: string; verificationKeyHash: string;  // vkey (JSON)
  networks: Record<string /* chainId */, {
    chainID: number;
    shortName: string;
    processRegistryContract: string;   // contract address per chain
    processIDVersion: string;          // 4-byte version embedded in process IDs
  }>;
  sequencerAddress: string;
}
```

`init()` uses `networks[chainId].processRegistryContract` to wire the contract service. The vote flow downloads `circuitUrl`/`provingKeyUrl`/`verificationKeyUrl` (multi-MB; the SDK caches them in memory) and verifies their SHA-256 against the `*Hash` fields when `verifyCircuitFiles` is on.

## `getProcess` (REST) vs `sdk.getProcess` (contract)

`seq.getProcess` is the **lightweight, provider-free** view straight from the sequencer; `sdk.getProcess` reads the contract + metadata and returns the richer `ProcessInfo` (and needs a provider). Use the REST one for status/readiness polling.

```ts
interface GetProcessResponse {
  id: string;
  status: number;                       // ProcessStatus as a number
  organizationId: string;               // creator address
  encryptionKey: { x: string; y: string };
  stateRoot: string;
  result: string[] | null;              // decimal strings once tallied
  startTime: string;
  duration: number;
  metadataURI: string;
  ballotMode: BallotMode;               // string-bounded shape
  census: { censusOrigin: number; censusRoot: string; censusURI: string; /* … */ };
  votersCount: string;
  maxVoters: string;
  overwrittenVotesCount: string;
  isAcceptingVotes: boolean;            // ← poll this for readiness
  sequencerStats: { /* per-process processing counters */ };
}
```

The canonical readiness check before voting:

```ts
const p = await sdk.api.sequencer.getProcess(processId);
if (p.isAcceptingVotes) { /* safe to submitVote */ }
```

## `VoteRequest` (the wire payload — the facade builds it)

You normally never construct this; `sdk.submitVote` does. Shown for debugging:

```ts
interface VoteRequest {
  processId: string;
  censusProof?: CensusProof;   // only for CSP; omitted for Merkle
  ballot: { curveType: string; ciphertexts: { c1: [string,string]; c2: [string,string] }[] };
  ballotProof: { pi_a; pi_b; pi_c; protocol };   // groth16
  ballotInputsHash: string;
  address: string;
  signature: string;           // EdDSA over the 32-byte voteId
  voteId: string;
}
```

`submitVote` returns `void`; the sequencer assigns/echoes the `voteId` you computed. Track the `voteId` from `sdk.submitVote`'s `VoteResult` and poll `getVoteStatus`.

## Errors

REST errors throw with a numeric `code` you can switch on. Common ones:

- **`40007`** — process not found / not yet indexed (right after `createProcess`; retry with backoff).
- **`40001`** — address not in census (surfaces from `hasAddressVoted`/`isAddressAbleToVote`).

```ts
try { await sdk.api.sequencer.getProcess(id); }
catch (e: any) { if (e.code === 40007) { /* not indexed yet, wait & retry */ } else throw e; }
```

See `references/errors.md` for the full catalogue.

## Gotchas

- **Decimal strings, not numbers.** `votersCount`, `maxValue`, weights, results are strings over the wire — `BigInt(...)` / `Number(...)` before arithmetic.
- **Encryption-key points are `[string,string]` / `{x,y}` decimal coordinate pairs** (BabyJubJub), not hex.
- **The sequencer doesn't bundle circuits** — `getInfo()` gives URLs you download at proof time.
- **`isAcceptingVotes` can be false right after creation** until the start time passes and the sequencer indexes the process.

## Cross-references

- `references/voting.md` — how these calls compose into the vote flow.
- `references/census.md` — `sdk.api.census` (the other REST service).
- `references/contracts.md` — the on-chain side (`sdk.processes`).
