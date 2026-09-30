# Live suite on Gnosis

`yarn test:e2e` runs the SDK against the Gnosis deployment: the preset
registry, real sequencer nodes with their prover, and the live DKG committee.
It creates eight elections, votes through the nodes, waits for the results and
checks them. It spends the organizer's xDAI, so it runs only when asked, in
two phases:

- **prepare** (offline) draws the voter keys of the file-based censuses into a
  private directory and writes the public census files and metadata documents
  to `test/e2e/fixtures/`. It then proves every planned ballot with the real
  circuit against a stand-in election, so a plan the circuit refuses shows up
  before anything is created on chain. The keys are drawn once; later runs
  reuse them, so the files do not change.
- **run** creates the elections with those files served from raw GitHub at a
  pushed commit. Nodes only download a census from a public host that answers
  without redirects, and the SDK reads back every document it publishes, so
  the fixtures have to be committed and pushed before a run.

Both phases run in `node:22` through `scripts/e2e-live.sh`, with nothing but
Docker on the host. Running `yarn test:e2e` natively works too, for
development.

## Scenarios

They run at once, one process each. Every election is created with the grace
window at the registry's floor and an hour to run, then closed early with
`closeProcessIn(noticeMin)`: the nodes flush their pending votes during the
notice, the grace window follows, then the results.

| # | Census | Key | What it checks |
|---|---|---|---|
| 1 | static Merkle (origin 1), 8 weighted voters | sequencer | the key node's key on every node; `pickNode` routing; 16-field ballots with identity padding (the stored ballots); a revote queued behind the first ballot; a resent ballot refused as `duplicate`; a ballot proved for the wrong weight refused by the node (40002); an outsider refused (`not-in-census`); every status up to `settled`; receipts; the tally with the revote, 8 voters and 1 overwrite |
| 2 | CSP (origin 4), 3 random voters | sequencer | ECDSA attestations from a CSP drawn for the run, carried as the vote's census proof; weights from the CSP; `hasAddressVoted` over every node |
| 3 | updatable Merkle (origin 2), 4 then 6 members | sequencer | `updateCensus` while voting runs; the nodes reload it (new members vote; the dropped one weighs 0); the dropped member's pending ballot fails with `census changed, recast` |
| 4 | `OwnedCensus` contract (origin 3), 3 random members, a 4th added while voting runs | sequencer | the contract deployed by the organizer; the nodes index it (each proves every member's weight); the weight as budget (`maxValueSum` 0) |
| 5 | static, 2 voters | `dkg` | the committee's pool key; a quadratic ballot; after the grace window a node requests the decryption, the committee decrypts, the tally is stored |
| 6 | static, 2 voters | `dkg-locked` | results locked after the grace window, even once the decryption is requested; a wrong secret refused (`InvalidOrganizerSecret`) as an `eth_call`; the tally after `revealProcessKey` |
| 7 | static, 2 voters | sequencer | the metadata hash round trip; `setProcessMetadata` to a tampered copy registered under another document's hash (`metadataVerified: false`), then to the update; results titled from the verified update |
| 8 | static, 1 member, no votes | sequencer | as `eth_call`s, nothing sent: END before the start, a grace outside the floor and ceiling, shortening inside the notice, PAUSE and max voters after the end; then CANCEL, and the results read `canceled` |

For every election with votes the suite also checks that the result states
the SDK reports (`waitForResults`) go through `grace` in order, that the
registry holds the expected tally and counts, and that the results landed no
earlier than the grace end the SDK computes.

At most two DKG processes run per run: an epoch's pool holds 16 keys. The
sequencer-key creations stay under the key node's 10 requests a minute.

## Before a run

- Docker.
- The organizer key file: a funded Gnosis account (the run refuses below
  0.05 xDAI). The key is read from the file and never printed. Use an account
  kept for this suite: at start the run cancels any of its last 16 processes
  still open, left by an interrupted run.
- The sequencer node URLs, reachable from where the run happens. Every node
  must take votes (none may be down or an observer).
- The DKG committee live, with at least two free keys in its pool.

## Settings

| Variable | Phase | |
|---|---|---|
| `DAVINCI_SDK_E2E` | both | `prepare` or `run`; unset skips the suite (the script sets it) |
| `DAVINCI_SDK_E2E_DIR` | both | the private directory of the voter keys, default `~/.davinci-gnosis/sdk-e2e` (mode 0700, `voters.json` 0600); refused inside the checkout |
| `DAVINCI_SDK_E2E_ARTIFACTS` | both | where the checked circuit files are kept, default `~/.cache/davinci-sdk-e2e/artifacts` |
| `DAVINCI_SDK_E2E_BASE_URL` | run | `https://raw.githubusercontent.com/vocdoni/davinci-sdk/<commit>/test/e2e/fixtures` |
| `DAVINCI_E2E_NODES` | run | the node URLs, comma-separated |
| `DAVINCI_E2E_ORGANIZER_KEY` | run | path of the organizer's key file (hex) |
| `DAVINCI_E2E_RPC` | run | optional Gnosis JSON-RPCs tried before the preset's, comma-separated |

They can also go in `test/.env` (see `test/.env.example`). The script also
reads `E2E_DOCKER_CACHE` (the container's `node_modules`, yarn cache and
home, default `~/.cache/davinci-sdk-e2e/docker`) and `E2E_LOG` (default
`~/.cache/davinci-sdk-e2e/<phase>-<time>.log`).

The circuit files come from the SDK's pinned table (davinci-circom on raw
GitHub) and are checked as always; the cache only saves the 44 MB download.

## Running it

```bash
scripts/e2e-live.sh prepare
git add test/e2e/fixtures && git commit -m 'test(e2e): live fixtures' && git push

DAVINCI_SDK_E2E_BASE_URL=https://raw.githubusercontent.com/vocdoni/davinci-sdk/<commit>/test/e2e/fixtures \
  DAVINCI_E2E_NODES=<node url>,<node url> \
  DAVINCI_E2E_ORGANIZER_KEY=/path/to/organizer.key \
  scripts/e2e-live.sh run
```

`prepare` rewrites the fixtures and says which files changed; after the
first time it changes nothing unless the scenarios in `spec.ts` change.

Before it creates anything, `run` checks that the fixtures are the ones the
private keys give and that the base URL serves them byte for byte, that the
registry carries this release's pins, that every node reports the same
deployment and takes votes, and that the organizer is funded. Each document
the SDK publishes during the run goes through an uploader that only answers
the URL of the committed file with the same bytes.

The output ends with a table (scenario, process id, key mode, origin, voters
counted, result, time) and the organizer's gas bill, one line per transaction,
checked against the balance and the nonce. Only addresses, process ids and
transaction hashes are printed; node and RPC URLs read `<node N>` and
`<rpc N>`. After a failure the run cancels the processes it left open.

Native runs, for development, need Node 20 or later:

```bash
DAVINCI_SDK_E2E=prepare yarn test:e2e
DAVINCI_SDK_E2E=run DAVINCI_SDK_E2E_BASE_URL=… DAVINCI_E2E_NODES=… DAVINCI_E2E_ORGANIZER_KEY=… yarn test:e2e
```

## CI

`.github/workflows/sdk-e2e-live.yml` runs the `run` phase on manual dispatch,
on the runner the dispatch names (default `self-hosted`). The runner needs
Docker and a route to the nodes: a self-hosted runner next to them, or node
URLs a hosted runner can reach. The fixtures are served from the dispatched
commit, or from `fixtures_commit`. Secrets:

- `DAVINCI_E2E_NODES`: the node URLs, comma-separated; each is masked in the log.
- `DAVINCI_E2E_ORGANIZER_KEY`: the organizer's private key.
- `DAVINCI_SDK_E2E_VOTERS`: the `voters.json` prepare wrote to the private
  directory. The committed census files are built from these keys, so it
  changes only when prepare draws new keys.
- `DAVINCI_E2E_RPC`, optional.

## Changing the suite

- Scenarios, voters and documents are in `spec.ts`; run `prepare` after any
  change there, then commit and push the fixtures.
- `contracts/census.json` holds the creation code of `OwnedCensus` and
  `PoseidonT3` at the commit of the vendored census ABIs. `yarn sync:abis
  --census <checkout>` rewrites it with them; the anvil suite checks it
  against its own build (`test/anvil/liveCensus.test.ts`). The run links the
  `PoseidonT3` at its usual deterministic address when the chain has it, and
  deploys one otherwise.
- The helpers have offline tests in `unit/`, part of `yarn test:unit`.

## Measured

One run on 2026-09-30, from the Docker runner on the host of both nodes
(sequencer v0.3.2), with the Gnosis preset RPCs and all eight scenarios
passing:

- `prepare`: about 30 s once the circuit files are cached, almost all of it
  proving the 27 planned ballots (the first download adds 44 MB).
- `run`: 10 min (598 s). The checks before anything is created take 2 s; the
  eight creations and the census contract take 2 min (about 10 s per organizer
  transaction, one at a time).

| scenario | time | results after the grace end |
|---|---|---|
| s1 static census | 7:35 | 5 s |
| s2 CSP census | 6:28 | 5 s |
| s3 updatable census | 6:49 | 10 s |
| s4 on-chain census | 7:25 | 5 s |
| s5 committee key | 8:42 | 1:55 (request, decryption, finalize) |
| s6 locked committee key | 9:52 | 2:23 after the reveal (sent 1:22 after the grace end, the suite's 60 s hold included) |
| s7 metadata | 6:41 | 5 s |
| s8 organizer refusals | 5:21 | (canceled) |

From a close to its results: the notice (60 s plus 45 s of slack), then the
grace floor (150 s after the last batch lands), then the results. A
sequencer-key election had its results 4 to 6 minutes after the close was
sent.

Cost: the organizer sent 31 transactions, 15.0 M gas in all. At the 14-17 wei
gas price of that day this was 2.3e-10 xDAI. The largest items are the
`PoseidonT3` library deployment (5.2 M gas; Gnosis has none at its
deterministic address, so every run deploys one), the `OwnedCensus`
deployment (1.5 M) and the creations (0.6-0.7 M with a sequencer key, 1.0 M
for `dkg`, 1.4 M for `dkg-locked`). Settlements and results are paid by the
node operators. Keep the organizer above the 0.05 xDAI the run checks for.
