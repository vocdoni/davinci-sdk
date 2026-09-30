# DAVINCI SDK examples

Two scripts that run whole elections on a DAVINCI deployment with the SDK in this repository:

- **`src/election.ts`**: a census of fresh voters (a Merkle census file, or a CSP's signatures), a single-choice election in any key mode, every voter voting from its own SDK (one of them twice), statuses and receipts, an early close with notice, and the results.
- **`src/onchain.ts`**: an election on an append-only census contract (`OwnedCensus` of davinci-onchain-census-contract, branch `davinci-zkvm`): weighted members spreading their weight, and a member added while voting runs.

Each run creates a real election and spends the organizer's gas. A run takes about ten minutes: the votes, a close with notice during which the nodes settle them, the grace window, then the key holder's results.

## Prerequisites

- Node.js 18 or newer and Yarn.
- The deployment's sequencer node URLs (the SDK embeds none).
- A JSON-RPC of the network (Gnosis by default) and an organizer account with gas.
- Somewhere to publish census files and metadata documents: a web server serving a directory, or an endpoint that accepts an HTTP `PUT`, reachable over public https. Nodes refuse census files on private hosts or behind redirects.

## Setup

```bash
# from the repository root: the SDK's dependencies
yarn install

# the examples' own tools
cd examples/script
yarn install
cp .env.example .env # then fill it in
```

The scripts import `@vocdoni/davinci-sdk` from this checkout's `src/` (the `paths` entry of `tsconfig.json`), so they always run the code next to them. In your own project, install the package instead.

## Settings

| Variable | Used by | |
| --- | --- | --- |
| `DAVINCI_NODES` | both | the sequencer node URLs, comma-separated |
| `RPC_URL` | both | the network's JSON-RPC |
| `PRIVATE_KEY` | both | the organizer's key |
| `PUBLISH_DIR`, `PUBLISH_URL` | both | publish by writing into a directory a web server serves at `PUBLISH_URL` |
| `UPLOAD_URL`, `PUBLIC_URL` | both | or publish with an HTTP `PUT` to `UPLOAD_URL/<name>`, served at `PUBLIC_URL/<name>` |
| `CENSUS` | `election.ts` | `merkle` (default) or `csp` |
| `KEY_MODE` | `election.ts` | `sequencer` (default), `dkg` or `dkg-locked` |
| `VOTERS` | `election.ts` | voters to draw, default 3 |
| `CSP_PRIVATE_KEY` | `election.ts` | the CSP's key with `CENSUS=csp`; random when empty |
| `CENSUS_CONTRACT` | `onchain.ts` | an `OwnedCensus` the organizer owns; one is deployed when empty |
| `ARTIFACTS_DIR` | both | read the ballot circuit files from a directory instead of downloading them (still checked) |
| `ALLOW_PRIVATE_HOSTS` | both | `true` for local development against local nodes |

## Running

```bash
yarn election
KEY_MODE=dkg-locked yarn election
CENSUS=csp yarn election
yarn onchain
```

What `yarn election` prints, step by step:

1. The deployment and each node's status (`usable`, `observer`, `down`).
2. The census. A Merkle census is published when the process is created.
3. The process id. With `dkg-locked`, the organizer secret stays in memory: a real organizer stores it.
4. Each vote: its id and the node that took it. The first voter votes again, on the same node.
5. The close with notice: the nodes flush every vote they hold before the new end.
6. Each vote reaching `settled` and its receipt's state root.
7. The results states (`grace`, then `awaiting-key-holder` or the DKG ones) and the tally. With `dkg-locked` the organizer key is revealed once voting has ended.

A new process takes a few blocks to reach the nodes; the scripts retry a vote the nodes do not serve yet.

## Troubleshooting

- **`NodeMismatchError` at start:** a URL in `DAVINCI_NODES` serves another deployment or release.
- **`DeploymentPinError`:** the registry pins another release than this SDK's; update the SDK.
- **`CensusPublishError` or `MetadataError`:** the published file is not served back unchanged at its URL, from a public host, without a redirect.
- **`VoteError('unavailable')` for minutes:** the nodes ignore the process (a census they cannot load); `sdk.api.nodes.firstAnswer(n => n.getProcess(id))` shows their `note`.
- **Results `timeout`:** the error names what the process still waits for, for example the node holding a sequencer key.

The guides in [`docs/ai/`](../../docs/ai) cover each step in detail.
