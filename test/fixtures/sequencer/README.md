# Sequencer client vectors

From [davinci-sequencer](https://github.com/vocdoni/davinci-sequencer) at commit
`cb2d39c91d9b3ed92216dedef7a4ba55b18859a5`.

- `networks.rs`: verbatim copy of `client/src/networks.rs`, the known deployments.
  `test/protocol/unit/Protocol.test.ts` checks `src/networks.ts` against it.
- `tracker.json`: tracker proofs (arbo inclusion proofs of vote-id leaves in a
  SHA-256, 64-level state tree that also holds config and ballot leaves), as
  `GET /votes/{pid}/voteId/{vid}/proof` serves them, each with the result of the
  client's `verify_tracker` against an on-chain root. It holds 25 honest proofs and
  26 tampered or malformed ones. `test/crypto/unit/Tracker.test.ts` requires the
  same verdict for every case.
- `tracker-gen/`: the program that wrote `tracker.json`. It builds the trees with
  the sequencer's `arbo` crate and serializes with `davinci_client::api::TrackerProof`.
  Put the directory next to a davinci-sequencer checkout (whose workspace expects
  davinci-zkvm beside it) and run `cargo run --release > tracker.json`.

- `wire.json`: the HTTP API wire. It holds the samples of `client/tests/api.rs`
  (a vote with a Merkle, a CSP or no census proof, process views, node info, the
  election key, vote statuses, a tracker proof, a participant, a stored ballot,
  transitions, blobs and a census file) as `davinci_client::api` serializes them.
  Each `*Cases` list edits a sample (`ops`: `set`, `remove`, `pop` or `push` at a
  JSON path) and records whether the same types decode the result (`ok`).
  `newKeyCases` records what `SequencerClient::new_key` accepts, and `pickNode`
  holds `voter::pick_node` orders for several voters, processes and node lists.
  `test/sequencer/unit/Wire.test.ts`, `Routing.test.ts` and
  `SequencerService.test.ts` replay them.
- `wire-gen/`: the program that wrote `wire.json`, laid out like `tracker-gen/`;
  run `cargo run --release > wire.json`.

```
5ff61788141064f5624ad35141009f64f7ab00baa1675bd03ab49ac4cf1da531  networks.rs
6a6d1f8cb0400f01fb53019a7327661ecee8c228134e9fc45dbba3cc682633e0  tracker.json
4181ed7560b4b581d5ae471a84616f7ce09b717bd72e1fabfc0a27cf4773a9da  wire.json
```
