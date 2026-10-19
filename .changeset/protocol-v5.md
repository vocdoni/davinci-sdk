---
'@vocdoni/davinci-sdk': major
---

Protocol v5: the ballot proof carries its 71 public inputs instead of an inputs hash, and Merkle censuses are Keccak trees. This release works with v5 deployments only: a v5 node refuses an SDK 4 vote (`ballotInputsHash` is an unknown field, 40001), and the release pins, the ballot key and the census contract are the v5 ones.

- **Ballots.** `buildBallot` returns `publicSignals`, the 71 public signals in circuit order (address, vote id, process id, packed ballot mode, election key x and y, weight, then `c1.x, c1.y, c2.x, c2.y` of each of the 16 fields), and no `inputsHash`. `BallotCircuitInputs` loses `inputs_hash`, `BallotProof.publicSignals` is the 71 decimal strings, and `VoteRequest` loses `ballotInputsHash`. `ballotPublicSignals` replaces `ballotInputsHashPreimage` and `computeBallotInputsHash`; `BallotInputsHashParams` becomes `BallotPublicSignalsParams`; `multiPoseidon` is removed.
- **Ballot key.** `BALLOT_PROOF_PUBLIC_SIGNALS` is 71. `ballotVkHash`, `ballotVkWireBytes`, `verifyBallotProof` and the circuit file checks refuse a key with other than 72 IC points or without a phase-2 contribution (`delta` equal to `gamma`). `BALLOT_VK_HASH`, `BALLOT_ARTIFACTS`, `BATCH_PROGRAM_VK` and `RESULTS_PROGRAM_VK` move to the v5 release; a v4 registry fails the deployment check.
- **Census tree.** `LeanIMT` hashes a node as `keccak256(left ‖ right)` over 32-byte big-endian values (the census contract's `keccak256(abi.encode(left, right))`). Roots and siblings are 256-bit values, most of them above the BN254 modulus; leaves stay `(address << 88) | weight`, below 2^248. `new LeanIMT(leaves)` builds a tree synchronously and `LeanIMT.create` is removed; `verifyLeanIMTProof` returns a boolean instead of a promise and refuses a leaf of 2^248 or more.
- **Wire.** Census values (`censusProof.root`, `leaf` and `siblings`, a process view's `census.censusRoot`, a participant's proof) are `0x` and exactly 64 hex digits, written lowercase and read in either case. `PublishedCensus` takes a Merkle root as such a string or a `bigint` below 2^256.
- **Census contract.** `OwnedCensus` of davinci-onchain-census-contract keeps its functions and events; its tree links no library, so it deploys without `PoseidonT3`. Its ABI drops `LeafAlreadyExists` and `LeafGreaterThanSnarkScalarField` and adds `LeafTooLarge`.

Before:

```ts nocheck
const tree = await LeanIMT.create(leaves);
const ok = await verifyLeanIMTProof(tree.proof(0));
const vote = { ...request, ballotInputsHash: built.inputsHash };
```

After:

```ts
import { LeanIMT, censusLeaf, verifyLeanIMTProof } from '@vocdoni/davinci-sdk';

const tree = new LeanIMT([censusLeaf('0x1111111111111111111111111111111111111111', 1n)]);
const ok: boolean = verifyLeanIMTProof(tree.proof(0));
```
