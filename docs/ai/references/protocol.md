# `references/protocol.md` — How Davinci works (the *why* under the SDK)

Companion to the [[davinci-sdk]] skill. This file explains the protocol the SDK calls into: the actors, the five phases, the cryptography, the census models, and the state tree. Read it when the question is conceptual ("why ElGamal", "what's a vote id", "how is the tally kept secret until the end", "what does a sequencer actually do") rather than "how do I call X". It is distilled from the Davinci whitepaper/spec.

## One-paragraph intuition

An election is governed by **Ethereum smart contracts** (the source of truth). Voters never put votes on-chain directly: they **encrypt** their ballot and send it, with **zero-knowledge proofs** of validity and eligibility, to a **sequencer**. Sequencers verify many ballots, **aggregate** them into a single proof, **re-encrypt** them (so voters can't later prove how they voted), and submit a **state-transition proof** on-chain. Individual votes stay encrypted the whole time; only the **final aggregated tally** is decrypted at the end by a threshold of **key wardens**. A results proof anchors the tally to the final state on-chain, where anyone can audit it.

## Actors

- **Organizer** — defines the election (ballot mode + census) and submits the create transaction. In the SDK this is just your `signer`; there is no separate "organization" object.
- **Key wardens** — a decentralized group that runs a DKG to produce the **encryption public key** voters use, and later cooperate (threshold) to decrypt only the final tally. The SDK fetches the per-process encryption key from the sequencer (`getProcessKeys`); you don't manage wardens.
- **Voters** — census members; they encrypt and submit ballots off-chain to a sequencer.
- **Sequencers** — collect, verify, aggregate, re-encrypt, and commit votes to the shared state. You *talk to* a sequencer over REST; you don't run one.

## The five phases (and where the SDK sits)

1. **Election setup** — organizer commits ballot mode + census commitment on-chain. → `sdk.createProcess`.
2. **Encryption-key generation** — wardens publish the process encryption key (DKG). → fetched for you during `createProcess`.
3. **Voting period** — voters cast encrypted ballots; sequencers batch and commit them. Runs continuously until the deadline; voters may **overwrite** their vote (coercion resistance, last-vote-wins). → `sdk.submitVote` + `waitForVoteStatus`.
4. **Tally decryption** — after the deadline, a threshold of wardens publish partial decryptions of the aggregated result (never the individual votes). → triggered by `sdk.endProcess`.
5. **Finalization** — results + correctness proof are verified on-chain and recorded immutably. → readable via `sdk.getProcess(...).result` / the `onProcessResultsSet` event.

This maps directly onto the SDK's two status enums: on-chain steps surface as `TxStatus`; a single vote's journey through the sequencer surfaces as `VoteStatus` (`pending → verified → aggregated → processed → settled`).

## Cryptography in one screen

- **Homomorphic encryption (ElGamal on BabyJubJub).** Ballots are encrypted to the process public key. Ciphertexts add up, so sequencers can accumulate the encrypted tally without decrypting anything. A ciphertext is a pair of curve points `{ c1, c2 }`, serialized as decimal `[string, string]` coordinate pairs.
- **zk-SNARKs (Groth16, BN254 for the ballot circuit).** The voter's **ballot circuit** proves the encrypted ballot satisfies the ballot mode *and* that the vote id was derived correctly — without revealing the vote. The SDK runs this locally with `snarkjs`, using circuit artifacts downloaded from the sequencer's `/info`. Sequencers then run **verifier**, **aggregation**, **state-transition**, and **results** circuits.
- **Re-encryption.** Sequencers re-randomize ciphertexts so a voter can no longer prove their original plaintext — mitigating vote-buying/coercion — without changing the tally.
- **Signatures (EdDSA).** The voter signs the vote id to prove identity ownership. The SDK signs the 32-byte big-endian vote id for you.

## Vote identifiers (not classic nullifiers)

A **vote id** is `voteID = N + Hash(processID, address, k) mod N` (with `N = 2^63`), where `k` is fresh randomness. It lets a voter confirm their vote was included **without linking to the encrypted ballot**. Uniqueness isn't enforced by a nullifier set; instead the state-transition circuit only inserts a vote id into an *empty* leaf — on the rare collision the voter just resamples `k`. This is why `submitVote` accepts an optional `randomness` (the `k`) and why overwriting is natural: a re-vote writes the voter's reserved ballot slot again (last-vote-wins), updating the tally by subtracting the old contribution and adding the new.

## Census models (the four `CensusOrigin`s)

The contract stores three census parameters — `censusOrigin`, `censusURI`, `censusRoot` — interpreted per model:

| `CensusOrigin`      | `censusRoot` means…           | Membership proof          | Updates during voting |
| ------------------- | ----------------------------- | ------------------------- | --------------------- |
| `OffchainStatic` (1)| Merkle root                   | Merkle path               | no                    |
| `OffchainDynamic`(2)| latest Merkle root            | Merkle path               | append-only           |
| `Onchain` (3)       | census contract address       | Merkle path vs on-chain roots | append-only       |
| `CSP` (4)           | hash of the CSP public key    | CSP signature over `(processID, idx, address, weight)` | external |

Each voter has an index `idx`, an `address`, and a `weight`. Weights enable weighted voting; by default everyone is weight 1. The SDK's census classes (`OffchainCensus`, …) are thin builders over this — see `references/census.md`.

## State tree (why results appear when they do)

Election state is one fixed-depth (D=64) sparse Merkle tree committed on-chain as `stateRoot`. Low indices hold config (process id, ballot mode, encryption key, the encrypted `resultsAdd`/`resultsSub` accumulators, census origin); a middle region holds each voter's reserved encrypted-ballot slot (derived from `idx`); the upper half holds vote ids. Each sequencer batch produces a new `stateRoot` proven by the state-transition circuit and verified on-chain. The tally stays encrypted in the accumulators until the process ends and wardens decrypt it — which is exactly why `getProcess(...).result` is only meaningful after `endProcess` and settlement.

## What this means for SDK users

- You can't read individual votes — by design. You read aggregate `result` after the election ends.
- "It takes minutes to settle" is the batching + on-chain state transition, not a bug. Size your `waitForVoteStatus` timeouts accordingly.
- Overwriting is supported and expected; don't treat `hasAddressVoted === true` as final.
- The encryption key, circuits, and contract addresses all come from the sequencer's `/info` — keep the SDK pointed at a sequencer that matches your chain.

## Cross-references

- `references/ballot-modes.md` — the parametric ballot protocol in practice.
- `references/voting.md` — the `VoteStatus` lifecycle that mirrors phases 3–5.
- `references/sequencer.md` — `getInfo`, circuits, the encryption key.
