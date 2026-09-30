# `references/sequencer.md` — The sequencer node client

Companion to the [[davinci-sdk]] skill. A sequencer node takes votes, batches and proves them, settles the batches on the registry and serves what it knows over HTTP. The facade calls the nodes for you; this client is for reads and calls it does not wrap. Nothing a node says replaces the registry: voters take the election key, ballot mode and census root from the contract (`sdk.registry`).

```ts
const keyNode = sdk.api.sequencer; // VocdoniSequencerService: the key node
const nodes = sdk.api.nodes; // SequencerNodes: every usable node, with vote routing
const first = nodes.nodes[0]; // one node's client
```

Both getters need `init()`, and throw `SequencerUnavailableError` when their role has no usable node. A client can also be built directly: `new VocdoniSequencerService(url, { timeoutMs, headers, fetchImpl, maxResponseBytes })`.

## Methods

| Method | Route | Returns |
| --- | --- | --- |
| `ping()` | `GET /ping` | |
| `getInfo()` | `GET /info` | `SequencerInfo` |
| `listProcesses()` | `GET /processes` | process ids the node knows |
| `getProcess(pid)` | `GET /processes/{pid}` | `ProcessView` |
| `getEncryptionKey(pid)` | `POST /processes/keys` | the node's election key for that (future) id; the identity and points outside the subgroup are refused |
| `getParticipant(pid, address)` | `GET /processes/{pid}/participants/{address}` | `{ address, weight, censusProof }`: the proof must be the address's own leaf and verify |
| `getAddressWeight(pid, address)` | same | `bigint` |
| `isAddressAbleToVote(pid, address)` | same | false on 40401 |
| `getTransitions(pid)` | `GET /processes/{pid}/transitions` | settled transitions: roots, transaction, block, sender, counts, blob count |
| `getTransitionBlobs(pid, index)` | `GET /processes/{pid}/transitions/{i}/blobs` | the blobs, `0x` hex |
| `submitVote(vote)` | `POST /votes` | the exact body of a `VoteRequest`; the vote id echo is checked |
| `getVoteStatus(pid, voteId)` | `GET /votes/{pid}/voteId/{vid}` | `{ status, error? }` |
| `getVoteIdProof(pid, voteId)` | `GET /votes/{pid}/voteId/{vid}/proof` | `TrackerProof`, checked to be for that vote |
| `getBallot(pid, address)` | `GET /votes/{pid}/address/{address}` | the re-encrypted ballot in the voter's slot |
| `hasAddressVoted(pid, address)` | same | false on 40401 |

Process ids go out lowercase with `0x` (either form is accepted); vote ids are `0x` + 16 hex digits and at least 2^63.

### `SequencerInfo`

```ts nocheck
interface SequencerInfo {
  sequencerAddress: string | null; // null for an observer
  chainId: number;
  processRegistry: string;
  ballotVkHash: string;
  batchProgramVk: string;
  resultsProgramVk: string;
  observer: boolean; // follows the chain; takes no votes, issues no keys
  settledBySelf: number;
  syncedFromOthers: number;
  lostRaces: number;
}
```

`init()` checks the first five fields against the registry (`references/nodes.md`); `checkNodeInfo(info, expected, url)` does the same by hand.

### `ProcessView`

The registry's parameters plus the node's own view: `status` (`'ready' | 'ended' | 'canceled' | 'paused' | 'results' | 'unknown'`), `isAcceptingVotes` (false before the start and from the end on), `encryptionKey`, `ballotMode`, `census`, `stateRoot`, `localStateRoot` (the node's committed root), `synced`, the counters, `startTime`, `duration`, `result` once on-chain, and `ignored` with a `note` when the node refused to serve the process (a census it could not load, a key that is not a subgroup point).

```ts
const view = await sdk.api.nodes.firstAnswer(n => n.getProcess(processId));
if (view.ignored) console.warn('the nodes ignore this process:', view.note);
checkProcessView(view, await sdk.registry.getProcess(processId)); // throws naming a field that differs
```

A node's view may trail the registry for a block or two (an updated census root, for instance).

## Routing helpers

```ts
import { pickNode, SequencerNodes } from '@vocdoni/davinci-sdk';

const order = pickNode(voterAddress, processId, nodeUrls); // the voter's node order
const cluster = new SequencerNodes(nodeUrls);
const status = await cluster.getVoteStatus(processId, voteId); // the vote's node first
```

`SequencerNodes.submitVote(vote, node?)` implements the failover rules of `references/nodes.md`, and `firstAnswer(call, order?)` moves to the next node after any node error except a malformed request (40001).

## Wire format

On the wire, field names are camelCase, field elements decimal strings, bytes `0x` hex, points twisted Edwards `{ x, y }`, and a ballot exactly 16 ciphertexts. The node decodes strictly: no unknown fields, exact lengths, every value in range. The SDK's types hold bigints and checked points; `encodeVoteRequest`/`decodeVoteRequest` and `encodeCensusFile`/`decodeCensusFile` convert. A vote body carries `weight` (decimal) and, for a CSP census, `censusProof: { type: 'csp', r, s, recid, index }`; for a Merkle census the node derives the proof and the SDK sends none.

## Errors

| Class | When |
| --- | --- |
| `SequencerApiError { status, code?, node }` | the node answered with an error |
| `SequencerNetworkError { timedOut, cause, node }` | no usable answer: network failure, timeout (60 s by default), abort |
| `SequencerDecodeError` | an answer that does not decode or does not check out |
| `NodeMismatchError { field, expected, got, node }` | `/info` names another deployment or release |
| `SequencerUnavailableError { nodes }` | no usable node for the role |

All extend `SequencerError`. The node's `code` is the HTTP status times 100 plus a discriminator (`SequencerErrorCode`):

| Code | Name | Meaning |
| --- | --- | --- |
| 40001 | `MalformedRequest` | malformed request; for a vote also an address outside the census or a missing CSP proof |
| 40002 | `InvalidVote` | the vote failed a protocol check (proof, signature, inputs hash, census binding, ballot, weight) |
| 40401 | `NotFound` | not found |
| 40402 | `UnknownProcess` | a process this node does not know or serve |
| 40801 | `RequestTimeout` | the node's 60 s deadline; a vote may still have been admitted |
| 40901 | `DuplicateVote` | the vote id is already queued or settled |
| 40902 | `SlotBusy` | the voter's slot holds the most queued votes; retry once one settles |
| 41201 | `NotAcceptingVotes` | ended, canceled or past the end |
| 41202 | `MaxVotersReached` | the voter cap is reached |
| 41203 | `ObserverNode` | an observer: no votes, no keys |
| 41204 | `NotStarted` | before the start |
| 41301 | `BodyTooLarge` | body over 256 KiB |
| 42901 | `KeyRateLimit` | the per-minute limit of `POST /processes/keys` |
| 42903 | `Busy` | at capacity or loading a census; retry shortly |
| 50001 | `Internal` | internal error |

```ts
import { hasSequencerErrorCode, SequencerErrorCode } from '@vocdoni/davinci-sdk';

try {
  await sdk.api.nodes.nodes[0].getProcess(processId);
} catch (err) {
  if (hasSequencerErrorCode(err, SequencerErrorCode.UnknownProcess)) {
    // not bootstrapped on that node yet: a new process takes a few blocks
  } else throw err;
}
```

`submitVote` on the facade maps these to `VoteError` reasons (`references/voting.md`).

## Cross-references

- `references/nodes.md`: node checks, routing and failover.
- `references/voting.md`: the vote flow built on this client.
- `references/receipts.md`: tracker proofs.
