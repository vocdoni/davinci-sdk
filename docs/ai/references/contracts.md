# `references/contracts.md` — The raw contract service (`sdk.processes`)

Companion to the [[davinci-sdk]] skill. This is an **escape hatch**. The `DavinciSDK` facade (`createProcess`, `endProcess`, `getProcess`, …) wraps the on-chain `ProcessRegistryService` and is what you should use. Drop here only when you need an event subscription, a raw read, or a method the facade doesn't expose.

> There is **no** `OrganizationRegistryService`, `deployedAddresses`, `getAddresses`, or `AbiRegistry` in this SDK. The process creator is simply the signer's address (`ProcessInfo.creator` / `organizationId`). The `contracts` module exports exactly: `SmartContractService`, `ProcessRegistryService`, the contract types/enums, and the error classes.

## Getting the service

```ts
const registry = sdk.processes;     // ProcessRegistryService, wired to your signer's chain
```

`sdk.processes` requires a signer **with a provider** and that the registry address is resolved (it is, after `init()` against a sequencer that knows your chain). Constructing one by hand:

```ts
import { ProcessRegistryService } from "@vocdoni/davinci-sdk";
const registry = new ProcessRegistryService(contractAddress, signerOrProvider /* ContractRunner */);
```

## Transactions are async generators of `TxStatusEvent`

Every write method returns `AsyncGenerator<TxStatusEvent<T>>`, not a receipt. Consume it, or unwrap with the static helper.

```ts
enum TxStatus { Pending = "pending", Completed = "completed", Reverted = "reverted", Failed = "failed" }
type TxStatusEvent<T> =
  | { status: TxStatus.Pending;   hash: string }
  | { status: TxStatus.Completed; response: T }
  | { status: TxStatus.Reverted;  reason?: string }
  | { status: TxStatus.Failed;    error: Error };
```

```ts
import { SmartContractService } from "@vocdoni/davinci-sdk";
// unwrap a stream to a promise of the final response:
await SmartContractService.executeTx(registry.setProcessStatus(processId, ProcessStatus.ENDED));
```

The facade's lifecycle methods are thin wrappers around exactly these streams.

## `ProcessRegistryService` — methods

### Writes (all → `AsyncGenerator<TxStatusEvent<{ success: true }>>`)

```ts
registry.newProcess(
  status: ProcessStatus, startTime: number, duration: number, maxVoters: number,
  ballotMode: BallotMode, census: CensusData, metadata: string, encryptionKey: EncryptionKey
)
registry.setProcessStatus(processID: string, newStatus: ProcessStatus)
registry.setProcessCensus(processID: string, census: CensusData)
registry.setProcessDuration(processID: string, duration: number)
registry.setProcessMaxVoters(processID: string, maxVoters: number)
// sequencer-only in practice (your app never calls these):
registry.submitStateTransition(processID: string, proof: string, input: string)
registry.setProcessResults(processID: string, proof: string, input: string)
```

> `newProcess` here takes **positional args** and the contract-shaped structs below. This is *not* the friendly `ProcessConfig` — use `sdk.createProcess` for that. The facade computes `startTime`/`duration`, fetches the `encryptionKey` from the sequencer, builds `CensusData`, uploads metadata, and calls this for you.

### Reads

```ts
registry.getProcess(processID: string)                  // raw contract struct
registry.getProcessCount(): Promise<number>
registry.getChainID(): Promise<string>
registry.getNextProcessId(organizationId: string): Promise<string>   // precompute the id
registry.getProcessEndTime(processID: string): Promise<bigint>
registry.getProcessNonce(address: string): Promise<bigint>
registry.getRVerifier(): Promise<string>      // + getSTVerifier, *VKeyHash, getMaxCensusOrigin, getMaxStatus
```

### Events (the main reason to come here)

```ts
registry.onProcessCreated((processID, creator) => …)
registry.onProcessStatusChanged((processID, oldStatus, newStatus) => …)         // bigints
registry.onCensusUpdated((processID, root, uri) => …)
registry.onProcessDurationChanged((processID, duration) => …)
registry.onStateTransitioned((processID, sender, oldRoot, newRoot, voters, overwritten) => …)
registry.onProcessResultsSet((processID, sender, result /* bigint[] */) => …)   // ← results landed
registry.onProcessMaxVotersChanged((processID, maxVoters) => …)
registry.removeAllListeners()
registry.setEventPollingInterval(ms)   // default 5000
```

`onProcessResultsSet` is the clean way to know the tally is final (see `recipes/read-results.ts`).

## Contract-shaped types

These differ from the friendly SDK config; the facade converts at the boundary, coercing to `bigint` where the contract needs it.

```ts
// core types — what newProcess consumes
interface BallotMode {           // SAME field names as ProcessConfig.ballot; bounds are decimal strings
  numFields: number; groupSize?: number;
  minValue: string; maxValue: string; uniqueValues: boolean;
  costExponent: number; minValueSum: string; maxValueSum: string;
}
interface CensusData {
  censusOrigin: CensusOrigin; censusRoot: string;
  contractAddress?: string;      // set for Onchain censuses (else zero address)
  censusURI: string; onchainAllowAnyValidRoot?: boolean;
}
interface EncryptionKey { x: string; y: string; }   // BabyJubJub pubkey (from sequencer getProcessKeys)
```

`ProcessStatus`:

```ts
enum ProcessStatus { READY = 0, ENDED = 1, CANCELED = 2, PAUSED = 3, RESULTS = 4 }
```

## `SmartContractService` (base class)

```ts
class SmartContractService {
  static executeTx<T>(stream: AsyncGenerator<TxStatusEvent<T>>): Promise<T>   // unwrap → promise
  setEventPollingInterval(ms: number): void
}
```

`ProcessRegistryService` extends it; the streaming + event plumbing lives here.

## Errors

All contract-layer errors extend `ContractServiceError` (`.operation` field), e.g. `ProcessCreateError`, `ProcessStatusError`, `ProcessCensusError`, `CensusNotUpdatable`, `ProcessDurationError`, `ProcessStateTransitionError`, `ProcessResultError`. No numeric codes here (those are the sequencer's — see `references/sequencer.md`).

## Cross-references

- `references/process.md` — the facade methods you should normally use instead.
- `references/sequencer.md` — the off-chain side and where `encryptionKey` comes from.
- `references/errors.md` — `TxStatus.Reverted`/`Failed` handling and revert reasons.
