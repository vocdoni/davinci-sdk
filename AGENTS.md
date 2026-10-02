# AGENTS.md

Instructions for coding agents working on `@vocdoni/davinci-sdk`, the TypeScript SDK for the Vocdoni DAVINCI voting protocol. [CONTRIBUTING.md](CONTRIBUTING.md) is the full guide for humans; this file holds what an agent must not get wrong. Where they disagree, CONTRIBUTING.md wins and this file needs fixing.

Using the SDK (not changing it) is documented in `docs/ai/` (`SKILL.md`, `references/`, `recipes/`).

## Setup and checks

Node.js 18+ (CI uses 20) and **Yarn 1** (`yarn@1.22.22`). Do not switch package managers or add a `packageManager` field.

Before you say a change is done, run what CI runs:

```bash
yarn lint             # ESLint, zero warnings
yarn format:check     # Prettier (yarn format to fix)
yarn tsc --noEmit     # types, sources and tests
yarn test:unit        # offline unit tests
yarn build            # dist/
yarn docs:check       # llms*.txt are current; every ts block in the docs type-checks
yarn test:anvil       # when contract calls or organizer flows change (needs Foundry)
```

After editing `docs/ai/`, run `yarn docs:build` and commit the regenerated `llms.txt` and `llms-full.txt`.

## Layout

```
src/DavinciSDK.ts  the facade          src/core/       processes, votes, results, metadata
src/networks.ts    presets, RPC        src/contracts/  registry and census services, vendored ABIs
src/sequencer/     node client         src/census/     census classes, publishing, CSP
src/crypto/        protocol primitives src/prover/     ballot circuit files, snarkjs
src/protocol/      limits and pins mirrored from davinci-zkvm
test/<area>/unit/  unit tests          test/anvil/     flows on real contracts
test/fixtures/     vectors (never edit by hand)
```

## Code rules

- Strict TypeScript. Every public export has a TSDoc comment: what it does, returns and throws.
- Failures are typed errors extending the existing hierarchies (`ContractServiceError`, `SequencerError`, `CensusError`, …).
- Election parameters come from the registry, never from a node. Never hard-code a hosted node URL or other data that changes over time; use placeholders such as `https://sequencer-1.example.org` in docs.
- Code that mirrors davinci-zkvm or davinci-sequencer names its source and is tested against that source's vectors. Vectors in `test/fixtures/` and ABIs in `src/contracts/abi/` are copied or synced (`yarn sync:abis`), never edited.
- A public API change updates `docs/ai/` in the same pull request.
- Commits are conventional with a lowercase summary: `feat(vote): …`, `fix(networks): …`, `docs: …`, `ci(release): …`.

## Releases: Changesets

Versions, the changelog, tags, npm publishing and GitHub releases are all produced by [Changesets](https://github.com/changesets/changesets) and `.github/workflows/release.yml`. **Your only part in a release is adding a changeset file to your pull request.**

### Never

- Never change `version` in `package.json`.
- Never edit `CHANGELOG.md` by hand, and never run Prettier on it (it would rewrite the old entries). The `*.md` rule of `.lintstagedrc.json` would do that if `CHANGELOG.md` were staged.
- Never run `changeset version`, `changeset publish`, `changeset tag`, `yarn version-packages`, `yarn release`, `npm publish` or `npm version`, and never create `v*` tags or GitHub releases. The workflow does all of that on `main`.
- Never edit the "Version Packages" pull request (branch `changeset-release/main`). The workflow force-pushes it on every push to `main`. To change an entry's text, edit its changeset on `main`.
- Never upgrade `@changesets/cli` to 3.x or `changesets/action` to v2: Changesets 3 does not install with Yarn 1 or on Node 20, and action v2 refuses CLI 2.x. That pairing is a deliberate pin.
- Never set `"prettier": true` in `.changeset/config.json`, and never prefix tags or headings with the package name. Releases are `v2.1.0`, not `@vocdoni/davinci-sdk@2.1.0`.
- Never enter pre-release mode (`changeset pre enter`) without the maintainer asking for it.

### When a pull request needs a changeset

Add one when users of the package notice the change: the public API, runtime behavior, the bundle, the published files or the dependencies. Skip it for tests, CI, repository docs (README, CONTRIBUTING, this file) and refactors with no visible effect. `docs/ai/` changes need one only when they come with an API change, which has its own changeset.

Pick the release type by semver, from the user's point of view:

| Type    | When |
| ------- | ---- |
| `major` | Anything that can break a caller: a removed or renamed export, a changed signature or return shape, a changed default, a dropped Node version, support dropped for a deployed contract or node version. |
| `minor` | New exports, options or capabilities, backwards compatible. |
| `patch` | Fixes and internal changes users can notice (performance, error messages, dependency bumps) without an API change. |

If unsure between two types, pick the higher one and say so in the pull request.

### Writing the changeset

Create a file in `.changeset/` with a short kebab-case name describing the change, such as `.changeset/vote-retry-on-502.md`. `yarn changeset` is interactive and agents can't drive it, so write the file directly:

```md
---
'@vocdoni/davinci-sdk': patch
---

`waitForResults` keeps polling when a node answers 502 while the results are being proved, instead of throwing.
```

- The frontmatter key is exactly `'@vocdoni/davinci-sdk'`, and the value is `patch`, `minor` or `major`.
- The body becomes the CHANGELOG entry and the GitHub release notes verbatim, after a link to the pull request. Write it for SDK users: what changed and what they must do, in the present tense. Leave out the implementation story.
- A `major` changeset carries the migration notes: what to change, before and after.
- `ts` code blocks are type-checked by `yarn docs:check` once they reach the CHANGELOG, so they must compile against the current source. Mark a block that is not real code as `ts nocheck`.
- One changeset per distinct change. A pull request may hold several, and the highest type wins.
- To check the result, run `yarn changeset status --verbose`. It exits 1 on a branch without changesets, which is fine when none is needed.

### What happens after merge

On each push to `main`, `release.yml` runs the test suite, then:

1. If changesets exist, it opens or updates the **Version Packages** pull request. That pull request deletes the changesets, bumps `package.json`, prepends the CHANGELOG entry and rebuilds `llms-full.txt`.
2. When a maintainer merges that pull request, it publishes to npm through trusted publishing (no token), tags `v<version>` and creates the GitHub release.

Merging is always the maintainer's call. Do not merge the Version Packages pull request, or any other, unless asked.
