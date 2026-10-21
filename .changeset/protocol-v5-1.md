---
'@vocdoni/davinci-sdk': major
---

Protocol v5.1: the vote signature covers the whole vote, every census weight works as a budget, and the registry's new rules on ballot modes and metadata. This release works with davinci-sequencer 0.8 nodes and the new OP Mainnet registry only: an SDK 5 and a 0.8 node refuse each other at `init()` (the `/info` pins), and a 0.8 node refuses a vote signed the SDK 5 way (40002).

- **Vote signature.** The voter signs the vote envelope instead of the bare vote id: `voteEnvelopeDigest(processId, voteId, ballot)` is `keccak256("davinci-vote-v1" ‖ processId ‖ voteId ‖ ballotLeafHash(ballot))`, signed with personal-sign, so a signature is good for that ballot in that process only. `signVote` and `recoverVoteSigner` replace `signVoteId` and `recoverVoteIdSigner`; `voteIdSignatureMessage` and `voteIdSignatureHash` are removed; `ballotLeafHash` is new. `submitVote` signs the envelope, and `VoteResult.signature` is that signature. A wallet still shows the signed value as an opaque 32-byte hash.
- **Budgets.** The ballot circuit compares the cost with the budget in 89 bits, so with `maxValueSum` 0 every census weight (below 2^88) is a budget a voter can spend: `checkBallot` compares the integer cost, and `createProcess` no longer refuses census weights of 2^63 or more. `checkBallot` refuses a weight of 2^88 or more (`weight does not fit in 88 bits`).
- **Ballot modes.** `createProcess`, `ballotModeValues` and `resolveElectionPreset` refuse a `costExponent` of 0 and a mode whose `numFields * maxValue^costExponent` reaches 2^63, as the registry does (`BallotModeError`, `ProcessCreateError` with `revertName` `InvalidBallotCost`). With 16 fields a quadratic `budget` is at most 759,250,124.
- **Metadata.** `updateMetadata` works only before the process starts (`ProcessMetadataError`, `InvalidTimeBounds`): a process created without a `startDate` keeps the document it was created with.
- **Wire.** The decoders of node answers require `0x` on every hex field, as nodes do; census files are still read with or without it.
- **Pins.** The ballot key of davinci-circom v1.3.0 (`BALLOT_VK_HASH` `67e8e6b47ea32cf144d6e72886f02b95ed068b157f9d4ccc8e97f335858e4963`, its pre-production ceremony on the revised circuit), the batch and results programs of davinci-zkvm v0.5.0, and the `optimism` preset's new `ProcessRegistry` (`0x02D6c284234B4CE75faB3085cF3f1ba4b7262B97`, from block 158487281, process id prefix `0xe8d4e286`); the registry `0x6F500A3e3A161EcB3C19A034bFB6a6Ac3b71abE6` is retired.

Before:

```ts nocheck
const signature = await signVoteId(signer, built.voteId);
const voter = recoverVoteIdSigner(built.voteId, signature);
```

After:

```ts
import { buildBallot, recoverVoteSigner, signVote, type BuildBallotParams } from '@vocdoni/davinci-sdk';

declare const params: BuildBallotParams;
const built = await buildBallot(params);
const signature = await signVote(signer, params.processId, built.voteId, built.ballot);
const voter: string = recoverVoteSigner(params.processId, built.voteId, built.ballot, signature);
```
