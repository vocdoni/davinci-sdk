# Contributing to the DAVINCI SDK

Bug reports and pull requests are welcome. For a new feature or a larger change, open an issue first so the approach can be agreed on before you write it. Questions go to [Discord](https://chat.vocdoni.io). Report security issues privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.

Be respectful in issues, reviews and chat. Report unacceptable behavior to [info@vocdoni.io](mailto:info@vocdoni.io).

## Setup

You need Node.js 18 or newer (CI uses 20, the live suite needs 20 or later), Yarn 1 and Git.

```bash
git clone https://github.com/vocdoni/davinci-sdk.git
cd davinci-sdk
yarn install
yarn test:unit
```

## Layout

```
src/
  DavinciSDK.ts   the facade
  networks.ts     network presets and the RPC failover provider
  core/           orchestration: processes, votes, results, metadata, HTTP base
  contracts/      ProcessRegistry and census contract services, vendored ABIs (abi/)
  sequencer/      sequencer node client, wire codecs, routing
  census/         census classes, publishing, CSP signer, witnesses
  crypto/         protocol primitives: ballot, BabyJubJub, ElGamal, Poseidon, lean-IMT, ECDSA, tracker, DKG
  prover/         ballot circuit files and the snarkjs prover
  protocol/       limits and release pins mirrored from davinci-zkvm
test/
  <area>/unit/    unit tests
  anvil/          organizer flows on the real contracts, on a local anvil chain
  e2e/            the live suite on Gnosis (see test/e2e/README.md)
  fixtures/       test vectors
  helpers/        shared test utilities
scripts/          ABI sync, documentation build and checks, live suite runner
examples/script/  runnable elections on a configured deployment
docs/ai/          guides (SKILL.md, references/, recipes/); llms.txt and llms-full.txt are built from them
```

## Scripts

```bash
yarn build                 # dist/: ESM and CommonJS builds with types
yarn dev                   # rebuild on change
yarn lint                  # ESLint, no warnings allowed (yarn lint:fix to fix)
yarn format:check          # Prettier (yarn format to rewrite)
yarn tsc --noEmit          # type check, sources and tests
yarn test:unit             # unit tests, offline
yarn test:anvil            # the anvil suite (needs Foundry)
yarn test                  # both
yarn test:e2e              # the live Gnosis suite; skipped unless DAVINCI_SDK_E2E is set
yarn test:core             # unit tests of one area: also test:contracts, test:sequencer, test:census, test:crypto
yarn docs:build            # rebuild llms.txt and llms-full.txt from docs/ai
yarn docs:check            # both are current, and every documentation code block type-checks
yarn sync:abis <checkout>  # vendor the contract ABIs from a davinci-contracts checkout
yarn lint-staged           # format and lint the staged files (no hook installs it)
yarn changeset             # add a changeset: the release type and changelog text of a change
```

## Tests

**Unit tests** (`test/<area>/unit/`) run offline, with the chain (`test/helpers/mockChain.ts`) and the nodes mocked. Protocol code is tested against the vectors in `test/fixtures/`. A few tests prove real ballots with the circuit files; they are skipped unless `DAVINCI_CIRCUIT_ARTIFACTS` names a directory holding `ballot_proof.wasm`, `ballot_proof_pkey.zkey` and `ballot_proof_vkey.json` (a davinci-circom checkout's `artifacts/` at the pinned commit):

```bash
DAVINCI_CIRCUIT_ARTIFACTS=../davinci-circom/artifacts yarn test:unit
```

**The anvil suite** (`yarn test:anvil`) needs git and [Foundry](https://getfoundry.sh) 1.8.3 (`forge` and `anvil`). It deploys the registry with davinci-contracts' `script/DeployAll.s.sol` and an `OwnedCensus` of davinci-onchain-census-contract, at the commits the vendored ABIs come from (`src/contracts/abi/source.json`, cloned once into `~/.cache/davinci-sdk-anvil`), then runs the organizer flows against them with a local stand-in for a sequencer node. To use checkouts you already have, set their paths in `test/.env` (see `test/.env.example`):

```env
DAVINCI_CONTRACTS_DIR=../davinci-contracts
DAVINCI_CENSUS_CONTRACT_DIR=../davinci-onchain-census-contract
```

**The live suite** (`yarn test:e2e`, run through `scripts/e2e-live.sh`) creates elections on the Gnosis deployment through real sequencer nodes and spends real gas. Its phases, settings and costs are in [test/e2e/README.md](test/e2e/README.md).

CI runs lint, formatting, the type check, the unit tests, the build, the documentation checks and the anvil suite on every pull request.

## Vectors, ABIs and pins

The SDK mirrors the Rust implementation byte for byte, and its tests replay vectors produced by that implementation. Never edit a vector by hand.

- **Protocol vectors** (`test/fixtures/zkvm/`): verbatim copies from davinci-zkvm's `rust-sdk/testdata/`, `rust-sdk/assets/` and `rust-sdk/src/{limits,release}.rs`. To refresh, copy the files from a newer davinci-zkvm, update the commit and the checksums in the folder's README, and run `yarn test:unit`. A change of `limits.rs` or `release.rs` must be followed in `src/protocol/`; a new ballot VK hash needs its circuit files in the table of `src/prover/artifacts.ts`.
- **Sequencer vectors** (`test/fixtures/sequencer/`): `networks.rs` is a copy of davinci-sequencer's `client/src/networks.rs`; `tracker.json`, `wire.json` and `census-files.json` are written by the Rust programs next to them (`tracker-gen/`, `wire-gen/`, `census-gen/`) against a davinci-sequencer checkout. The folder's README says how to run each and records the checksums.
- **Contract ABIs** (`src/contracts/abi/`): `yarn sync:abis <davinci-contracts checkout>` copies the ABIs from its forge build and records the commit and the file hashes in `source.json`; `--census <checkout>` does the same for davinci-onchain-census-contract (`abi/census/`) and the creation code the live suite deploys. The script refuses a checkout with uncommitted changes or a build of other sources. `test/contracts/unit/abi.test.ts` pins every selector, topic, error and struct layout the SDK relies on, so a contract change shows up as a failing test; the anvil suite deploys the same commits.

## Conventions

- TypeScript in strict mode, formatted with Prettier and linted with ESLint (`.prettierrc.json`, `.eslintrc.json`).
- Every public export has a TSDoc comment: what it does, what it returns and what it throws. Comments in the code explain why, not what; keep them short.
- Failures are typed error classes that extend the existing hierarchies (`ContractServiceError`, `SequencerError`, `CensusError`, …), with messages that name what failed and the value involved.
- Election parameters come from the registry, never from a node. Node URLs and hosting are always configuration: never put a hosted instance's URL or other data that changes over time in the code, the tests or the docs.
- Code that mirrors davinci-zkvm or davinci-sequencer names its source (file and function) and is tested against that source's vectors.

## Documentation

- A change of the public API updates the guides in `docs/ai/` in the same pull request. Run `yarn docs:build` after editing them, so `llms.txt` and `llms-full.txt` follow.
- `yarn docs:check` type-checks every `ts` block of the README, SECURITY.md, the guides and the current major's CHANGELOG entries (changesets included, once versioned), plus the recipes and `examples/script`, against the SDK source. Mark a block that is not code as `ts nocheck`.
- Use placeholders for node URLs and hosting in examples (`https://sequencer-1.example.org`).
- Every user-visible change comes with a changeset, with migration notes for breaking ones (see [Changesets and releases](#changesets-and-releases)). Never edit [CHANGELOG.md](CHANGELOG.md) by hand.

## Pull requests

1. Branch from `main` and keep each pull request to one change.
2. Add or update tests with the change, and a changeset if users will notice it.
3. Before pushing, run `yarn lint`, `yarn format:check`, `yarn tsc --noEmit`, `yarn test:unit` and `yarn docs:check`, and `yarn test:anvil` when contract calls or organizer flows change.
4. Write commit messages as conventional commits with a lowercase summary: `feat(vote): …`, `fix(networks): …`, `docs(e2e): …`.
5. In the description, say what changes and why, and link the issue it addresses.

## Changesets and releases

Releases are made with [Changesets](https://github.com/changesets/changesets). A pull request that changes what users get (the API, its behavior, the bundle, the dependencies) adds a changeset: a Markdown file in `.changeset/` that names the release type and holds the changelog text. Run `yarn changeset` and answer its prompts, or write the file by hand, for example:

```md
---
'@vocdoni/davinci-sdk': patch
---

`waitForResults` no longer gives up when a node returns a 502 while the results are being proved.
```

- **Release type.** `patch` for fixes, `minor` for new features, `major` for breaking changes. A `major` changeset holds the migration notes.
- **Text.** Write it for the people who use the SDK: what changed and what they have to do, not how it was implemented. It becomes the CHANGELOG entry and the GitHub release notes as written, under a link to the pull request. Code blocks are allowed, and `yarn docs:check` type-checks the `ts` ones once they are in the CHANGELOG.
- **No changeset** for changes users don't see: tests, CI, documentation of the repository, refactors.

Every push to `main` runs [`release.yml`](.github/workflows/release.yml), after the tests:

1. While there are changesets on `main`, it opens or updates the **Version Packages** pull request. That pull request deletes the changesets, bumps `package.json` (the highest release type wins), prepends the new entry to `CHANGELOG.md` and rebuilds `llms-full.txt`.
2. Merging the Version Packages pull request is the release: the workflow publishes the version to npm with trusted publishing, tags the commit as `v<version>` (for example `v2.1.0`) and creates the GitHub release with the CHANGELOG entry as its notes.

The Version Packages pull request is opened with the workflow's token, so GitHub runs no checks on it. The workflow runs the tests on the merge commit before it publishes, and a failure stops the release. Review the Version Packages pull request like any other. Don't edit it: the workflow rewrites it on every push to `main`. To fix the wording of an entry, edit its changeset on `main`.

`yarn changeset status --verbose` shows the changesets of your branch and the release they add up to. It fails on a branch that has none, which is expected for changes users don't see.

## License

By contributing you agree that your contributions are licensed under the [GNU Affero General Public License v3.0](LICENSE), like the rest of the project.
