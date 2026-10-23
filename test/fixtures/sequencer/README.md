# Sequencer client vectors

From [davinci-sequencer](https://github.com/vocdoni/davinci-sequencer): `wire.json` at
commit `4702cf7e6c41a2868abb84ead13dcfe59ec80672` (branch `feat/v5.1`: every byte string `0x` hex), next to
davinci-zkvm `4b7b6e8ca5be1ebdbe0742623dd9411f392de830`; `census-files.json` at commit
`b109a4d9c47451455b54c274aed40827eff38ad0` (branch `feat/protocol-v5`: census values `0x`
and 64 hex digits, no `ballotInputsHash`, Keccak census roots), next to davinci-zkvm
`867316bb18e59be3290682719795fb8d41b638b7`;
`tracker.json` at `e9f941ba998e72c1cd07febfe8cf0a83bb8c648b` (branch `feat/v5.1`); `networks.rs` at `8f0c959f5fd081bf7b4d87180aff61f5da70e5e1`
(branch `main`: the OP Mainnet registry of 2026-10-23).

- `networks.rs`: verbatim copy of `client/src/networks.rs`, the known deployments,
  from branch main (commit `8f0c959`, OP Mainnet in L1-blob mode).
  `test/protocol/unit/Protocol.test.ts` checks `src/networks.ts` against it.
- `tracker.json`: tracker proofs (arbo inclusion proofs of vote-id leaves in a
  SHA-256, 64-level state tree that also holds config and ballot leaves), as
  `GET /votes/{pid}/voteId/{vid}/proof` serves them, each with the result of the
  client's `verify_tracker` against an on-chain root. It holds 26 honest proofs and
  28 tampered or malformed ones; one honest proof is a vote id at depth 64, next to
  the ballot slot it shares 63 key bits with (64 siblings). `test/crypto/unit/Tracker.test.ts` requires the
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

- `census-files.json`: census files as `davinci_client::organizer` writes them
  (`census_file`, compact like the e2e fixtures and pretty with a final newline like
  the demo), their lean-IMT roots (`merkle_census`), every member's proof and ballot
  slot, and edited census documents, each with the verdict of the node's own loader
  (`davinci_sequencer::census::CensusStore::fetch` on a `file://` copy): accepted with
  the root it built, or refused with its error. `demo` records the root of the demo
  census files below. `test/census/unit/OffchainCensus.test.ts` rebuilds every file
  byte for byte and checks that the SDK reads no document the node refuses.
- `census-gen/`: the program that wrote `census-files.json`, laid out like
  `tracker-gen/` (it also reads `../davinci-sequencer/e2e/demo`); run
  `cargo run --release > census-files.json`.
- `demo/`: verbatim copies of files the demo election run published
  (`e2e/demo/` at the same commit, written by `e2e/src/demo.rs`): metadata documents,
  with several languages and every election preset, and census files, including an
  updatable census's second version. `test/core/unit/Metadata.test.ts` builds each
  metadata document byte for byte; `OffchainCensus.test.ts` reads and rewrites the
  census files.

```
da35ddfb5b10f8483297fa3d002f6a8fe5fdae6c454d9e550b57641697993bbf  networks.rs
c88cad4f050f5255b659eee02017e3d2b18cd5301cbe7a355189342f188c002c  tracker.json
3c38c892879d3a46b36468d34e572868955f9da0074f64df1e573f94268454ca  wire.json
b293e19055b27ae24d4a536888fa4d2e6c6812a65d560a8d34513f62402bb068  census-files.json
9ec77a356a33c245334516f3e5521c02849a5bb42e13a7f2139a183cef20ec9e  demo/1-community-project/metadata.json
0a3fd057ef18c06651369065a661852a96d4b09816af29205f7a1fe8fd662e90  demo/3-budget-2027/census-2.json
d3999a2bf1a6a4080051efd402b3708add559ac215ae334c90b88219fdf4290d  demo/3-budget-2027/census.json
110d8780af419c722c48bb0c74097987c83cd422e9c66b9be00b676771ceda2c  demo/3-budget-2027/metadata.json
ccb000b6e81cdacec07a6631c851b67d0449c182305de16ba477e8d868256ed9  demo/6-shareholder-resolution/metadata.json
cb212e6007d747a14db20da2251114891aa56c0b4860fcaa0f5eb6c1b2a8042a  demo/wave2/13-dog-park/census.json
9cf20cdf47ee3c6e929033708151d8df6a72b7f5337012c591c0040e5ea3aeac  demo/wave2/13-dog-park/metadata.json
9924e1c34bcddec6289357922becb4949f85d43f08e9a313b7972f181d240589  demo/wave2/14-photography-themes/metadata.json
9c715bad63afab3a2cea5580b1149faf493e0a66a623ceea2778ae801b6e23b7  demo/wave2/15-community-kitchen/metadata-2.json
f3ce731eaf1360534772757eb38c0c3c9835ae0137cb166894576ae5c4ef274d  demo/wave2/15-community-kitchen/metadata.json
52c037d4f8ca5265c7a6cd3e1137d035e371cfb818db74f7b11d1c213c9fb263  demo/wave2/1-neighbourhood-plan/metadata.json
4287daf1216446bfc6a921133f96c5d60835acd2ffb8f4c0bb2566f58d362e67  demo/wave2/2-festival-closing-night/metadata.json
f5214d9a4a27e55ad12b46bc59e8c45342e48c181a943def7ef6ccd00bbe56b9  demo/wave2/3-federation-delegates/metadata.json
c0efaa1345d809a243ee5367f599a577d285a5ef985c3b0f6b2c60d97dd9f6e2  demo/wave2/5-bus-routes/metadata.json
85d171e7af4aedce73d204f42b926a59b285147c56fbb35aa6228c17d4383ee3  demo/wave2/6-participatory-budget/metadata.json
95163bba1d35e882d9880147a3a38a3e5a0a9aa58af9a1c0c684101a4f448827  demo/wave2/7-housing-cooperative/metadata.json
8cb87c4cff10a4f336466fd57bbaa36c60748e153a232fda3b2162a88ecb922e  demo/wave2/8-name-the-square/metadata.json
```
