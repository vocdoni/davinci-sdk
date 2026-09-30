# `references/protocol.md` — How DAVINCI works

Companion to the [[davinci-sdk]] skill. The protocol under the SDK: the actors, the life of an election, the ballot, the state and the results. Read it when the question is "why" rather than "how do I call X".

## One-paragraph intuition

An election is a process in the `ProcessRegistry` contract, which is the source of truth. A voter encrypts a ballot under the election key, proves with a zk-SNARK that it follows the ballot mode, signs its vote id and sends it to a sequencer node. Nodes collect ballots, re-encrypt them, and prove each batch in a zkVM guest that checks every ballot proof, the census and the state update; the registry verifies that proof and records the new state root, with the batch's data in EIP-4844 blobs so anyone can rebuild the state. The tally accumulates encrypted. After the voting period and a short grace window, the holder of the election key decrypts only the final tally and proves the decryption; the registry stores it.

## Actors

- **Organizer:** creates the process and runs its controls. In the SDK it is the signer; there is no organization object.
- **Voters:** census members. They vote off-chain, with a signature and a proof, and pay no gas.
- **Sequencer nodes:** independent operators. Any node takes votes and can settle any election; settlement is permissionless and nodes that lose a race rebuild from the winner's blobs. Nodes are configured by URL; the SDK embeds none.
- **Key holder:** the node that issued a sequencer key, or a davinci-dkg committee holding threshold shares (`references/key-modes.md`).
- **Registry and verifier:** the `ProcessRegistry` checks every transition and results proof through the `ZiskVerifier`, against the program vks it pins.

## The life of an election

1. **Creation.** The organizer publishes the census (Merkle file, contract or CSP) and the metadata document, gets the election key (from the key node, or from the DKG through the registry), and calls `newProcess` with the ballot mode, the census, the metadata URL and its SHA-256, the timing and the key mode. Nodes bootstrap the process from the `ProcessCreated` event.
2. **Voting.** From the start to the end, voters send ballots to nodes. A node checks each ballot (proof, signature, census, inputs hash) before queueing it.
3. **Batching and settlement.** A node seals a batch when enough ballots wait, when the oldest has waited long enough, or near the end. The zkVM guest verifies the batch's Groth16 proofs, re-encrypts every ballot, re-randomizes a sample of other occupied slots, updates the state tree and the encrypted accumulator, and lays out the blob data. The node proves it as a PLONK and sends `submitStateTransition` with the blobs.
4. **Grace window.** Admission closes at the end; batches of ballots taken before it keep landing until `graceEnd = min(end + graceMaxTotal, max(end, lastVoteAt) + grace)` (`references/grace.md`).
5. **Results.** After the grace end the key holder decrypts the accumulator: the key node with a second zkVM guest proving 16 Chaum–Pedersen decryptions, or the committee with proofs of every share. The registry checks the result against the final state root and stores it (`references/results.md`).

`TxStatus` covers the organizer's transactions; `VoteStatus` follows one ballot through step 2 (`pending`), 3 (`aggregated`, `processed`, `settled`) or a refusal (`error`).

## The ballot

- **16 fields**, always. A ballot is 16 ElGamal ciphertexts on BabyJubJub (circomlib twisted Edwards form, the election key's curve). Fields past the ballot mode's `numFields` hold the identity ciphertext, which the guest checks before skipping them.
- **Ballot proof.** A Groth16 proof (BN254) of the `BallotProof(16)` circuit shows the plaintexts follow the ballot mode and the voter's weight, and that the ciphertexts and the vote id were derived from the voter's secret `k`. Its public signals are the voter's address, the vote id and an inputs hash: a MultiPoseidon of the process id, the packed ballot mode, the election key, the address, the vote id, the 64 ballot coordinates and the weight.
- **Vote id.** `2^63 + (Poseidon(processId, address, k) mod 2^63)`. The voter signs it (secp256k1, personal-sign); the guest checks the signature against the address. The same `k` twice gives the same vote id, which nodes refuse as a duplicate.
- **Circuit files.** The wasm, the proving key and the verification key are keyed by the ballot VK hash the registry pins. The SDK checks each file's sha256 and that both verification keys (the file and the one inside the proving key) hash to the registry's value; the guest checks the same hash against the state tree.

## Censuses and slots

| Origin | Root in the registry | Membership proof |
| --- | --- | --- |
| 1 static Merkle | lean-IMT root of the census file | lean-IMT path of `(address << 88) \| weight` |
| 2 updatable Merkle | the current version's root | the same, at the current root |
| 3 on-chain contract | roots the contract recorded since the process's creation | the same, from the contract's logs |
| 4 CSP | the CSP's address | an ECDSA attestation of `(process, address, weight, index)` |

Each voter owns one **ballot slot** in the state tree: `0x10 + (be64(sha256("davinci-slot-v1" ‖ address)[0..8]) mod (2^63 − 16))` for a Merkle census, `0x10 + index` for a CSP. A revote writes the same slot again: the latest ballot replaces the earlier one, and the accumulator subtracts the old and adds the new. The slot comes from the address, not the voter's position in the tree, so a growing census never moves a voter.

## State and privacy

- **State tree.** One sparse Merkle tree per process (64 levels, SHA-256): config leaves (process id, ballot mode, election key, the encrypted results accumulator, census origin, ballot VK hash) at keys below `0x10`, ballots in their slots, and vote ids from 2^63 up. The registry stores its root (`latestStateRoot`).
- **Re-encryption.** The guest re-encrypts every ballot of a batch with scalars from a secret per-batch seed, so the stored ciphertext cannot be matched to the one the voter sent, and a voter cannot prove how it voted.
- **Silent revoting.** Every batch also re-randomizes a sample of the occupied slots it did not write, and adds zero encryptions to the accumulator for them, so an observer cannot tell an overwrite from a routine refresh. Participation is not hidden: a slot's first write is a new vote.
- **Data availability.** The blobs carry the vote ids, the updated slots and the accumulator, so any node or observer can rebuild the state and check every transition.
- **Receipts.** A vote id is a leaf of the state tree: a node's inclusion proof against an on-chain root shows the vote was recorded as cast (`references/receipts.md`).

## What this means for SDK users

- Individual votes cannot be read, by design: read the tally after the grace window.
- `settled` taking minutes is batching and proving, not a fault.
- Revotes are expected, and invisible; the latest ballot counts.
- Trust comes from the registry and the pins the SDK checks, not from the node you talk to. A sequencer key does trust its node with ballot secrecy and with publishing the results; a DKG key moves both to a committee threshold.

## Cross-references

- `references/key-modes.md`, `references/grace.md`, `references/results.md`: the parts of the timeline.
- `references/census.md`: the census classes.
- `references/ballot-modes.md`: the ballot mode in practice.
