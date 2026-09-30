# `references/contracts.md` — The registry, directly

Companion to the [[davinci-sdk]] skill. The facade (`createProcess`, the organizer controls, `getProcess`, `waitForResults`) wraps the `ProcessRegistry`. Come here for events, raw reads and writes, the deployment pin check and revert decoding.

## Getting the service

```ts
const reader = sdk.registry; // through the read provider: reads and listeners
const writer = sdk.processes; // with the signer: writes (its provider must be on the network's chain)
```

By hand, with any ethers runner:

```ts
import { GNOSIS, ProcessRegistryService } from '@vocdoni/davinci-sdk';
import { JsonRpcProvider } from 'ethers';

const registry = new ProcessRegistryService(GNOSIS.processRegistry, new JsonRpcProvider(rpcUrl), {
  receiptTimeoutMs: 180_000, // the default
});
```

The ABIs are vendored from davinci-contracts at a pinned commit (`CONTRACTS_ABI_COMMIT`) and exported: `PROCESS_REGISTRY_ABI`, `DAVINCI_DKG_ADAPTER_ABI`, `ZISK_VERIFIER_ABI`, `CENSUS_VALIDATOR_ABI`, `DKG_APP_MANAGER_ABI`, `DKG_MANAGER_ABI`, and the census contracts' `ONCHAIN_CENSUS_ABI` and `OWNED_CENSUS_ABI`.

## Writes are streams of `TxStatusEvent`

```ts nocheck
enum TxStatus { Pending = 'pending', Completed = 'completed', Reverted = 'reverted', Failed = 'failed' }
type TxStatusEvent<T> =
  | { status: TxStatus.Pending; hash: string; step?: string }
  | { status: TxStatus.Completed; response: T }
  | { status: TxStatus.Reverted; reason?: string; error?: Error }
  | { status: TxStatus.Failed; error: Error };
```

Every write returns an async generator:

1. Nothing happens until it is iterated; arguments that do not build fail the stream.
2. The call is simulated from the signer (`eth_call`) first, so a revert comes back as a `Failed` event carrying the decoded custom error, and nothing is signed.
3. It is signed and sent. A resend refused as "already known" or "nonce too low" whose transaction the chain has counts as sent.
4. The receipt is awaited; a mined revert is named by replaying the call (`Reverted`, with `error`).

```ts
import { ProcessStatus, SmartContractService } from '@vocdoni/davinci-sdk';

// Unwrap a stream: the Completed response, or the Failed/Reverted error thrown.
await SmartContractService.executeTx(writer.setProcessStatus(processId, ProcessStatus.PAUSED));
```

## Reads

| Method | Returns |
| --- | --- |
| `getProcess(pid)` | `OnchainProcess`: every field of the registry struct, grace window and DKG side included; `ProcessNotFoundError` for an unknown id |
| `getChainTime()` | the latest block's time: the clock the registry's rules run on |
| `getProcessCount()`, `getNextProcessId(creator)`, `getProcessNonce(creator)`, `getPidPrefix()` | ids |
| `getProcessEndTime(pid)`, `getProcessGraceEnd(pid)`, `getGraceParams()` | the timeline |
| `getBallotVKHash()`, `getBatchProgramVK()`, `getResultsProgramVK()`, `getRootCVadcopFinal()`, `getZiskVerifier()`, `getChainID()` | the pins |
| `getDkgAdapter()` (null when DKG is disabled), `aidFor(pid)`, `getRegistrationEpoch()`, `getDkgPlaintexts(dkg)`, `isProcessKeyRevealed(dkg)` | the DKG side |

## Writes

| Method | |
| --- | --- |
| `createProcess(params)` | a creation in any key mode: builds the DKG arguments (the locked mode's organizer secret and proof), checks the id is still the next one, and retries a DKG creation once. Returns `{ processId, transactionHash, organizerSecret? }` |
| `newProcess(params, { expectedProcessId? })` | one `newProcess`, the 10 arguments as a `NewProcessParams` object |
| `setProcessStatus(pid, status)` | end, pause, resume, cancel |
| `setProcessCensus(pid, census)` | origin 2 only (`CensusNotUpdatable`) |
| `setProcessMetadata(pid, uri, hash)` | a new metadata document |
| `setProcessDuration(pid, duration)` | the raw duration change |
| `closeProcessIn(pid, seconds, { slack? })` | a shorter end with notice (`references/grace.md`) |
| `setProcessMaxVoters(pid, n)`, `setProcessGrace(pid, seconds)` | limits |
| `revealProcessKey(pid, secret)` | a DKG-locked key |
| `finalizeResultsFromDKG(pid)` | stores a DKG tally (permissionless) |

The facade's versions add the local checks (organizer, status, time window) and the documents; use them unless you need the raw call. `metadataHash(bytes)`, `sequencerKeyParams()`, `dkgAutomaticParams()` and `dkgLockedParams(epochId, proof)` build write arguments by hand.

## Deployment pins

```ts
import { RELEASE_PINS } from '@vocdoni/davinci-sdk';

const { chainId, verifier, dkgAdapter } = await registry.verifyDeployment();
```

It checks the registry's batch and results program vks, vadcop root and ballot VK hash against `RELEASE_PINS`, its `chainID()` against the provider's chain, the `ZiskVerifier`'s code hash and root, and that the DKG adapter points back at the registry. A difference throws `DeploymentPinError { field, expected, got }`. `verifyDeployment(pins)` overrides entries, for a local deployment. `init()` runs it unless `verifyDeployment: false`.

## Events

```ts
const events = await reader.queryEvents({ processId, fromBlock: 48_600_000 });
for (const e of events) {
  if (e.name === 'ProcessStateTransitioned') console.log(e.newStateRoot, e.votersCount);
}

// Public RPCs cap the block range of one query: read in windows, newest first.
for await (const window of reader.eventWindows({ processId })) {
  const results = window.find(e => e.name === 'ProcessResultsSet');
  if (results) break;
}
```

`RegistryEvent` is a union over the ten events (`ProcessCreated`, `ProcessStatusChanged`, `CensusUpdated`, `ProcessMetadataUpdated`, `ProcessDurationChanged`, `ProcessMaxVotersChanged`, `ProcessGraceChanged`, `ProcessStateTransitioned`, `ProcessResultsSet`, `ResultsDecryptionRequested`), each with `blockNumber`, `transactionHash` and `logIndex`. `fromBlock` defaults to the registry's deployment block for a known network and is required otherwise. `parseRegistryLogs(receipt.logs, registry.address)` decodes a receipt's logs.

Listeners call back with exactly the event's arguments:

```ts
reader.onProcessStatusChanged((id, oldStatus, newStatus) => console.log(id, oldStatus, newStatus));
reader.onStateTransitioned((id, sender, oldRoot, newRoot, voters, overwrites, nBlobs) => {
  console.log(id, newRoot, voters);
});
reader.onProcessResultsSet((id, sender, result) => console.log(id, result));
// also onProcessCreated, onCensusUpdated, onProcessMetadataUpdated, onProcessDurationChanged,
// onProcessGraceChanged, onProcessMaxVotersChanged, onResultsDecryptionRequested
reader.removeAllListeners();
```

They use `eth_newFilter` when the RPC keeps filters and poll `eth_getLogs` otherwise (`setEventPollingInterval(ms)`, default 5 s).

## Errors

Every contract error extends `ContractServiceError`, with `operation`, `revert` (the decoded custom error: `{ name, signature, selector, args }`), `revertName` and `cause`:

| Class | Operation |
| --- | --- |
| `ProcessCreateError`, `WrongProcessIdError` | creation |
| `ProcessStatusError` | end, pause, resume, cancel |
| `ProcessCensusError`, `CensusNotUpdatable` | census updates |
| `ProcessMetadataError`, `ProcessDurationError`, `ProcessMaxVotersError`, `ProcessGraceError` | the other controls |
| `ProcessKeyRevealError`, `ProcessResultError` | reveal, results |
| `ProcessNotFoundError`, `DkgDisabledError`, `DeploymentPinError`, `CensusContractError` | reads and checks |

```ts
import { decodeDavinciError, ProcessDurationError } from '@vocdoni/davinci-sdk';

try {
  await sdk.closeProcessIn(processId, 60);
} catch (err) {
  if (err instanceof ProcessDurationError) console.log(err.revertName, err.revert?.args);
}
decodeDavinciError('0x…'); // any registry, adapter, DKG or verifier revert data → { name, args, … } | null
```

The registry's error names are listed in `references/errors.md`.

## The census contract

`OnchainCensusService(address, runner)` reads an origin-3 census contract (`getCensusRoot`, `treeSize`, `weightOf`, `slotOf`, `slotOwner`, `totalVotingPower`, `check`) and writes an `OwnedCensus` (`addMember`, `addMembers`). See `references/census.md`.

## Cross-references

- `references/process.md`: the facade's controls.
- `references/errors.md`: revert names and what they mean.
