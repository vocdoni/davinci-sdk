# Changelog

All notable changes to the Vocdoni DaVinci SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Council key mode.** `keyMode: 'council'` (`KeyMode.Council`, 3) with a required `ceremonyId` (`bytes12` hex) binds a process to a Live Council ceremony, an invite-only threshold DKG whose organizer allowed the registry's Council adapter and authorized the creating account; its committee decrypts the tally through the same `requestResultsDecryption` / `finalizeResultsFromDKG` path and `getResultsStatus` states as `'dkg'`. `councilParams`, `CouncilDisabledError`, `ProcessRegistryService.getCouncilAdapter`, `OnchainDkg.council` (`epochId` is then the ceremony id and `aid` the request id), `DeploymentInfo.councilAdapter`, and the vendored `COUNCIL_ADAPTER_ABI`, `COUNCIL_MANAGER_ABI` (the real manager's adapter surface) and `COUNCIL_MANAGER_ERRORS_ABI`, whose errors `decodeDavinciError` names.
- **Council decryption gate.** A Council ceremony fixes when its committee may decrypt; until then `getResultsStatus` reports the new state `awaiting-opening` with `decryptionOpening` (`mode` `'scheduled'` or `'manual'`, `opensAt` the scheduled or fallback date, or null), even for a tally of zeros, which the registry now stores only after the opening. `ProcessRegistryService.getCouncilDecryptionGate`, the `CouncilDecryptionGate` type, and `COUNCIL_POLICY_ABI` (the manager's `getPolicy`, written out from the Council spec). `finalizeResults` reverts with `DecryptionNotOpen` before the opening, and a `waitForResults` timeout names the opening date.

### Changed

- The vendored ABIs come from davinci-contracts `f4abc5d` (the council branch over `36c0b0a`): `ProcessRegistry` gains `councilAdapter()`, `CouncilDisabled` and `DecryptionNotOpen`, and its constructor takes `_councilManager` after `_dkgManager`; `CouncilAdapter` has `isDecryptionOpen`, and `COUNCIL_MANAGER_ABI` is the Council v2 adapter surface (`getRequestMeta` instead of `getRequest`, plus `isDecryptionOpen`). Selectors, events and the `newProcess` and `getProcess` layouts are unchanged.
- `ResultsState` has the new member `awaiting-opening`: an exhaustive `switch` or `Record<ResultsState, …>` over it needs a case.
- `getProcess` decodes key mode 3 and still refuses any mode it does not know. **Releases before this one throw `unknown key mode 3` on a Council process: upgrade every reader of a chain before the first one is created there.**
- `createProcess` names every key mode: an unknown one is refused instead of being sent as `DKG_AUTOMATIC`, and `ceremonyId` is refused outside `'council'`.
- `verifyDeployment` also checks that the Council adapter, if any, points back at the registry. A registry without `councilAdapter()` (the Gnosis deployment) reads as having none; any other failure of that read is thrown.

## [2.0.0] - 2026-09-30

The SDK now targets the zkVM stack of DAVINCI: the Rust sequencer nodes (davinci-sequencer), the zkVM batch and results provers (davinci-zkvm), the `BallotProof(16)` ballot circuit, and the `ProcessRegistry` with the grace window and the DKG key modes (davinci-contracts). The Gnosis deployment is built in as a network preset. Nothing of the 1.x stack (davinci-node, the census service, the `/info`-based addresses) is supported any more: every integration has to migrate, following the notes at the end of this entry.

### Added

- **Networks and configuration.**
  - The `network` option: a preset by name (`'gnosis'`, the default: `GNOSIS`, `NETWORKS`, `getNetwork`) or a `CustomNetwork` (`{ chainId, processRegistry, startBlock?, rpcUrls? }`), resolved by `resolveNetwork`. `processIdPrefix`, `processIdPrefixOf`, `networkOfProcessId` and `computeProcessId` read and compute registry-scoped process ids.
  - `sequencerUrls` (several nodes) and `keySequencerUrl`. Node URLs are always configuration; the SDK embeds none.
  - `rpcUrls` and `FailoverRpcProvider`, which fails over between JSON-RPC endpoints, backs off on rate limits, broadcasts a signed transaction to every endpoint and takes the highest nonce any endpoint reports. A voter's bare wallet reads the chain through the network's public RPCs.
  - `init()` checks the registry pins (`verifyDeployment`, default true: program vks, vadcop root, ballot VK hash, verifier code hash, DKG adapter) and every node's `/info` against the registry. `sdk.nodeChecks` reports each node as `usable`, `observer` or `down`.
  - `sdk.network`, `sdk.provider`, `sdk.registry` (read-only), `sdk.uploader`, `sdk.ballotProver`, `sdk.proveBallot`.
  - `sequencerConfig` (headers, `fetchImpl`, timeout, body cap of the node clients) and `documents` (`fetchImpl`, `timeoutMs`, `verify`, `allowPrivateHosts`).
- **Key modes.** `keyMode: 'sequencer' | 'dkg' | 'dkg-locked'` on `createProcess`. `'dkg-locked'` returns `organizerSecret`; `revealProcessKey` unlocks the results. `KeyMode`, `ProcessInfo.keyMode` and `ProcessInfo.dkg`.
- **Grace window and organizer controls.** `grace` and `paused` on `createProcess`; `extendProcess`, `closeProcessIn` (a shorter end with the registry's notice), `setProcessGrace`, `revealProcessKey`, `updateCensus`, `updateMetadata`, `cancelOpenProcesses`, `getGraceParams` and `getGraceEnd`, each control with a `…Stream` variant. `ProcessInfo` gains `phase`, `grace`, `lastVoteAt`, `graceEnd`, `chainTime` and `stateRoot`; `graceEndOf` and `processPhase` compute them.
- **Censuses for every origin.** Local lean-IMT Merkle censuses (`OffchainCensus`, `OffchainDynamicCensus`) published through an `Uploader` (`publishCensus`, `verifyCensusUrl`, `checkCensusUrl`); on-chain census contracts (`OnchainCensus` with `check` and `witness`, `OnchainCensusService`); CSP censuses with ECDSA attestations (`CspCensus`, `CspSigner`); witness checks (`checkCensusWitness`) and the `CensusError` family.
- **Metadata with its hash.** `buildElectionMetadata`, `serializeMetadata`, `publishMetadata`, `readMetadata`, `fetchMetadataHash`, `metadataHash`, `localizedText`; `ProcessInfo.metadataHash`, `metadataVerified`, `metadataStatus`, `metadataError` and `metadata`. Multi-language titles, descriptions and choices.
- **Voting.** 16-field ballots proved with the pinned circuit files (`BallotProver`, `BALLOT_ARTIFACTS`, the `artifacts` option, `verifyBallotProof`); per-voter node routing with failover (`pickNode`, `SequencerNodes`) and revotes kept on the node that holds the voter's previous ballot (`VoteConfig.node`, `VoteResult.node`); `VoteError` with a `reason`; `getVoteReceipt` (tracker proofs checked against the registry, `verifyTrackerProof`).
- **Results.** `getResultsStatus`, `waitForResults`, `decodeResults`, `ballotKindOf`, `finalizeResults(Stream)`, `ResultsError`.
- **Registry layer.** Vendored ABIs with a drift test (`PROCESS_REGISTRY_ABI` and the DKG, verifier and census contract ABIs), `decodeDavinciError`, `verifyDeployment`, `createProcess` in every key mode, `queryEvents`, `eventWindows`, `parseRegistryLogs`, the DKG reads (`getDkgAdapter`, `aidFor`, `getRegistrationEpoch`, `getDkgPlaintexts`, `isProcessKeyRevealed`) and listeners for the new events (`onProcessMetadataUpdated`, `onProcessGraceChanged`, `onResultsDecryptionRequested`).
- **Protocol primitives**, exported from the root: BabyJubJub and ElGamal, Poseidon, ballots (`buildBallot`, `packBallotMode`, `computeVoteId`, …), the ballot checker (`checkBallot`), lean-IMT censuses and slots, ECDSA vote-id signatures and CSP attestations, tracker proofs, the ballot VK hash and the DKG organizer proof; the protocol limits and release pins (`NUM_FIELDS`, `RELEASE_PINS`, …).
- **Documentation.** Guides for key modes, the grace window, censuses, metadata, nodes, receipts and results; recipes for a DKG-locked election, an early close, an on-chain census and receipts; runnable examples on the new API; `scripts/build-llms.mjs` builds `llms.txt` and `llms-full.txt` from `docs/ai`, and `yarn docs:check` type-checks every code block of the documentation.

### Changed

- **BREAKING** `DavinciSDKConfig`: `sequencerUrls` replaces `sequencerUrl` (kept as a deprecated alias), `network` replaces `addresses.processRegistry` (a deprecated alias), `censusUrl` and `verifyCircuitFiles` are ignored. Creating elections needs an `uploader`.
- **BREAKING** `init()` resolves one deployment from the network preset instead of the node's `/info`, and fails on a registry or node that does not match (`DeploymentPinError`, `NodeMismatchError`). A process id of another deployment is refused by every facade method.
- **BREAKING** `sdk.api`, `sdk.processes`, `sdk.processOrchestrator` and `sdk.voteOrchestrator` require `init()`. `sdk.api.sequencer` is the key node's client and `sdk.api.nodes` the vote nodes (`SequencerNodes`). `getConfig()` returns a frozen `DavinciSDKSettings`.
- **BREAKING** `createProcess`: without `startDate` a process starts in the block that creates it (it was 60 s later); an explicit start must be after the chain head (30 s in the past was accepted). Timing, ballot mode, `maxVoters` and the result cap are checked against the chain clock and the registry's rules before anything is uploaded or sent, as `Failed` stream events with the registry error in `revertName`. The plain methods throw the typed error instead of `Error('Transaction reverted: …')`.
- **BREAKING** Ballot modes are checked like the registry and the circuit do (`ballotModeValues`, `BallotModeError`): 1 to 16 fields, bounds as decimal strings (hex is refused), values below 2^48, sums below 2^63, `uniqueValues` a boolean. `resolveElectionPreset` refuses more than 16 choices and non-integer parameters.
- **BREAKING** `ProcessConfigWithMetadata`: `title` and `description` are `LocalizedText` and `questions` are `QuestionConfig`s; the document is published through the `uploader` with its SHA-256 (`metadataHash`). `ProcessConfigWithMetadataUri` takes an optional `metadataHash`. `ElectionMetadata.version` is `1.1` and `media` is optional.
- **BREAKING** `ProcessInfo`: title, description, questions and preset come from the metadata only when its bytes hash to the registry's `metadataHash`; `timeRemaining` is negative before the start; `graceEnd` may be null; `raw` is the `OnchainProcess`.
- **BREAKING** `ProcessCreationResult` gains `organizerSecret`, `grace` and `graceError`. `TxStatusEvent`'s pending event may carry `step`, and the reverted event an `error`.
- **BREAKING** Census classes: `CensusParticipant` is `{ key, weight: string }`; `MerkleCensus.add` validates addresses (checksums, no zero address), weights (below 2^88) and ballot slots (`CensusSlotCollisionError`); `root()` is computed locally; `Census.censusId` is gone. `CspCensus(cspAddress, uri)` takes the CSP's Ethereum address. `OnchainCensus(contract, uri?)` is an append-only census contract, with no indexer URI. `PublishedCensus` refuses origin 3 and checks its root. `CensusConfig.size` is deprecated.
- **BREAKING** `CensusProviders` is `{ merkle?, csp? }`: `csp` returns a `CspAttestation` (ECDSA), `merkle` a `MerkleCensusWitness`.
- **BREAKING** Voting: `VoteConfig.choices` takes numbers or bigints (at most `numFields`, missing fields are 0); `VoteConfig.randomness` is deprecated for `k` (a bigint; one below 2^128 is refused). `VoteResult` gains `node`, `weight` and `k`; `voteId` is `0x` + 16 hex digits. `submitVote` throws `VoteError` with a `reason` instead of message strings.
- **BREAKING** `VoteStatus` has no `verified`; `VoteStatusInfo` gains `error` and `node`. `waitForVoteStatus` and `watchVoteStatus` wait by default until the process's grace window closes plus 5 minutes (it was 300 s); `watchVoteStatus` takes `node`.
- **BREAKING** `getAddressWeight` returns a `bigint`, 0 for a non-member (it was a string). It and `isAddressAbleToVote` read the census from the nodes (Merkle censuses, with the proof checked against the registry's root), the census contract (on-chain) or `censusProviders.csp` (CSP); `hasAddressVoted` asks every node.
- **BREAKING** `VoteOrchestrationService` is built as `(registry, api, signer, options)`; `VoteOrchestrationConfig` is replaced by `VoteOrchestrationOptions`.
- **BREAKING** `VocdoniSequencerService` follows the new node API: `getInfo()` returns `SequencerInfo`, `getProcess()` a `ProcessView`, `getEncryptionKey()` replaces `getProcessKeys()`, and `getParticipant`, `getTransitions`, `getTransitionBlobs`, `getVoteIdProof` and `getBallot` are new. Failures are `SequencerApiError` (with the node's `code`), `SequencerNetworkError` or `SequencerDecodeError` instead of an `Error` with a `.code`; the codes are the new node's (`SequencerErrorCode`: 40007 is gone, 40001 means a malformed request). `VoteRequest` carries `weight` and a tagged `censusProof`.
- **BREAKING** `ProcessRegistryService` is built on the vendored ABI: `newProcess(params, options)` takes a `NewProcessParams` object with the ten registry arguments (metadata hash and DKG parameters included); `getProcess` returns an `OnchainProcess`; writes are simulated before they are signed and sent only when their stream is iterated; contract errors carry the decoded revert (`revert`, `revertName`, `cause`). `setProcessMaxVoters` fails with `ProcessMaxVotersError`. `ProcessStateTransitionedCallback` has the seven arguments of the new event.
- **BREAKING** Event listeners (`onProcessStatusChanged`, …) receive exactly the event's arguments; the ethers event payload that followed them is no longer passed.
- **BREAKING** The CommonJS build is `dist/index.cjs` (with `dist/index.d.cts`), and `package.json` `exports` has `import` and `require` conditions with their own types. `require('@vocdoni/davinci-sdk')` works; `dist/index.js` no longer exists. The package ships only these two builds and their types (see Removed).
- The ESM bundle imports in plain Node (no global `Worker` needed). In Node, `BallotProver.terminate()` lets a script exit after proving.
- Development: `yarn test` runs the unit tests and the anvil suite (it needs Foundry); the per-area scripts run unit tests only; CI runs lint, types, unit tests, the build, the documentation checks and the anvil suite on GitHub-hosted runners.

### Removed

- **BREAKING** The census service client and its orchestration: `VocdoniCensusService`, `CensusOrchestrator`, `sdk.api.census`, and the types `CensusSizeResponse`, `PublishCensusResponse`, `Snapshot`, `SnapshotsQueryParams`, `SnapshotsResponse`.
- **BREAKING** The EdDSA CSP: `DavinciCSP`, `sdk.getCSP()`, `CspCensus.publicKey` and `cspURI`, and the census proof types `CensusProof`, `BaseCensusProof`, `MerkleCensusProof`, `CSPCensusProof`, `MerkleCensusProofProvider`, `CSPCensusProofProvider`, `isMerkleCensusProof`, `isCSPCensusProof`, `assertMerkleCensusProof`, `assertCSPCensusProof`.
- **BREAKING** The 8-field ballot flow: `BallotInputGenerator`, `sdk.getBallotInputGenerator()`, `ProofInputs`.
- **BREAKING** Sequencer routes and types the new nodes do not have: `pushMetadata`, `getMetadata`, `getMetadataUrl`, `getStats`, `getWorkers`, `getProcessKeys`, `createProcessSignatureMessage`, `signProcessCreation`, and `InfoResponse`, `GetProcessResponse`, `ListProcessesResponse`, `HealthResponse`, `ProcessKeysRequest`, `ProcessKeysResponse`, `ParticipantInfoResponse`, `SequencerStats`, `WorkerStats`, `WorkersResponse`, `VoteBallot`, `VoteCiphertext`, `VoteProof`.
- **BREAKING** Registry calls only sequencers make or that no longer exist: `submitStateTransition`, `setProcessResults`, `getRVerifier`, `getSTVerifier`, `getRVerifierVKeyHash`, `getSTVerifierVKeyHash`, `getMaxCensusOrigin`, `getProcessDirect`, the protected `sendTx`, and `ProcessStateTransitionError`.
- **BREAKING** `CensusData` (it described `onchainAllowAnyValidRoot`, which the registry now refuses).
- **BREAKING** `dist/index.umd.js`, the browser-global build (`window.VocdoniSDK`). No package field pointed at it; browser apps take the ESM build through their bundler, which resolves `ethers` and `snarkjs` for the browser.
- `dist/contracts.d.ts` and `dist/sequencer.d.ts`, type bundles of subpaths the package does not export (every type is in `dist/index.d.ts`).
- The `@vocdoni/davinci-contracts` and `@ethereumjs/common` dependencies.
- The Go-stack integration tests and their Docker Compose environment.

### Deprecated

- `sequencerUrl`, `addresses.processRegistry`, `censusUrl` and `verifyCircuitFiles` in `DavinciSDKConfig`; `VoteConfig.randomness`; `CensusConfig.size`; the `EncryptionKey` type.

### Fixed

- `require()` of the package loaded the CommonJS bundle as ESM and got no exports.
- `setProcessMaxVoters` failures were reported as `ProcessDurationError`.

### Migrating from 1.0.x

1. **Configuration.** Name the nodes and, to create elections, the hosting:

   ```typescript
   // 1.0: new DavinciSDK({ signer, sequencerUrl, censusUrl })
   const sdk = new DavinciSDK({
     signer,
     sequencerUrls: ['https://sequencer-1.example.org', 'https://sequencer-2.example.org'],
     uploader, // publishes census files and metadata documents
   });
   await sdk.init();
   ```

   The network defaults to Gnosis; another deployment is `network: { chainId, processRegistry, startBlock, rpcUrls }`. Voters no longer need a census URL. Access `sdk.api` only after `init()`.

2. **Hosting.** There is no census service and nodes host no metadata. Implement an `Uploader` for a store that serves files over public https without redirects. Merkle censuses are built locally and published with the process.

3. **Censuses.**
   - `OffchainCensus` and `OffchainDynamicCensus` keep `add`, `remove` and `participants`; weights must be below 2^88.
   - A CSP census is `new CspCensus(cspAddress, uri)` or `await new CspSigner(cspWallet).census(uri)`; voters pass `censusProviders.csp`, which returns the CSP's ECDSA attestation (`CspSigner.attest`).
   - An on-chain census is a davinci-onchain-census-contract contract: `new OnchainCensus(contractAddress)`. Token contracts with an indexer are not supported.
   - `PublishedCensus` needs the lean-IMT root of a census file served by URL.

4. **Creating processes.**
   - Drop `startDate` to start at once (it was now + 60 s); a future `startDate` must be after the chain head.
   - Give bounds as decimal strings and at most 16 fields.
   - A document served by you goes in `metadataUri`; its SHA-256 is computed from the URL, or given as `metadataHash`.
   - Choose a `keyMode` (default `'sequencer'`) and, for a live meeting, `grace` at the registry's floor.
   - Catch typed errors (`ProcessCreateError`, …) and read `revertName`.

5. **Voting.**

   ```typescript
   try {
     const vote = await sdk.submitVote({ processId, choices: [0, 1, 0] });
     // 1.0: { voteId, signature, voterAddress, processId, status }
     // 2.0 adds node (keep it with the vote for revotes), weight and k (the ballot secret)
     console.log(vote.voteId, vote.node);
   } catch (err) {
     // 1.0: err.message.includes('already voted') and similar
     if (err instanceof VoteError) console.log(err.reason); // 'not-in-census', 'closed', ...
     else throw err;
   }
   ```

   `VoteStatus.Verified` is gone; `settled` still means counted. The default status wait follows the process: pass `timeoutMs` for a shorter one. `getAddressWeight` returns a bigint.

6. **Results.** Results no longer follow `endProcess`: they come after the grace window, from the key holder. Replace waits on `onProcessResultsSet` or `getProcess(...).result` with:

   ```typescript
   const results = await sdk.waitForResults(processId);
   for (const c of results.questions[0].choices) console.log(c.title, c.total);
   ```

   Tallies add each voter's latest ballot; census weights are not multiplied in.

7. **The node client.** Replace `getProcessKeys` with `getEncryptionKey`, switch on `SequencerErrorCode` values with `hasSequencerErrorCode`, and read process state from `sdk.registry.getProcess` rather than from a node.

8. **The registry.** Build `newProcess` arguments as a `NewProcessParams` object, or use `createProcess`; iterate every write stream (nothing is sent before); use `sdk.processes.onStateTransitioned` with its seven arguments.

9. **Packaging.** CommonJS consumers get `dist/index.cjs` through `require`; deep imports of `dist/index.js` must change to the package name. A page that loaded `dist/index.umd.js` with a `<script>` tag moves to a bundler, which takes the ESM build.

## [1.0.0] - 2026-06-11

### Added
- Class-level JSDoc on `VocdoniSequencerService`, `VocdoniCensusService`, and `ProcessRegistryService`.
- Unit tests for `ElGamal` primitives (`test/crypto/unit/ElGamal.test.ts`).
- Unit tests for `BallotBuilder` RTE/TE coordinate transforms (`test/crypto/unit/BallotBuilder.test.ts`).
- `electionPreset` field on `ProcessConfig` accepting a discriminated union of six canonical voting modes (`single_choice`, `multiple_choice`, `approval`, `rating`, `ranking`, `quadratic`). Mutually exclusive with the existing `ballot` field, which remains supported as the raw-mode escape hatch.
- `resolveElectionPreset(preset, questions)` exported for callers that need to compute a `BallotMode` outside of `createProcess`.
- `electionPreset?: ElectionPreset` on `ProcessInfo`. Populated by `getProcess(processId)` when the on-chain metadata records a recognized preset (stored at `metadata.meta.electionPreset`). Absent for raw-ballot processes or when metadata is unavailable.
- `parseElectionPresetFromMetadata(metadata)` exported for callers that need to extract a preset from a metadata object outside of `getProcess`.

### Changed
- Upgraded `@vocdoni/davinci-contracts` from `0.0.45-rc1` to `^0.0.49`.
- Declared minimum supported Node.js version as `>=18` via the `engines` field.
- Marked the package as side-effect free (`"sideEffects": false`) to enable tree-shaking in downstream bundlers.
- Tightened several `any` types to `unknown` in `src/core/types/metadata.ts` and `src/census/types.ts` type guards.
  Consumers passing strongly-typed values are unaffected; callers relying on implicit `any` widening may need an explicit cast.
- Updated `SECURITY.md` supported-versions table to `1.0.x`.
- Updated `CONTRIBUTING.md`: corrected the license reference (now correctly AGPL-3.0), refreshed the test-tooling references from Jest to Vitest, and bumped the documented Node minimum to 18.
- `ElectionMetadata.meta` map now declares a typed `electionPreset?: ElectionPreset` key, populated by the SDK when an `electionPreset` is provided during process creation. The open-ended `[key: string]: unknown` index signature is preserved for caller-supplied keys.
- The preset is stored under `metadata.meta.electionPreset` (not the top-level `metadata.type` field, which is reserved by the sequencer). `ElectionMetadataTemplate` (and `getElectionMetadataTemplate()`) do not set this field — the SDK populates it only when the caller passes an `electionPreset`.

### Removed
- Removed the always-skipped working-census participants integration test; the underlying sequencer endpoint was never implemented.
- **BREAKING**: `ElectionMetadata.type` field. The legacy `type: ElectionResultsType` field on the metadata interface is gone. Consumers parsing SDK-produced metadata should look at `meta.electionPreset` instead (or use the new `parseElectionPresetFromMetadata` helper).
- **BREAKING**: `ElectionResultsTypeNames` enum.
- **BREAKING**: `ElectionResultsType` discriminated union.
- **BREAKING**: `AbstainProperties`, `ChoiceProperties`, `BudgetProperties`, `ApprovalProperties`, `QuadraticProperties` interfaces.

  These types were exported but never produced meaningful values inside the SDK (`metadata.type` was always defaulted to `{ name: 'single-choice-multiquestion', properties: {} }`). Consumers reading metadata produced by older SDK versions will still see that legacy shape in the raw JSON's `type` field; the new schema does not expose it on the TypeScript interface, and `parseElectionPresetFromMetadata` ignores legacy values entirely.

### Migrating from 0.4.x
- **Node.js minimum is now 18.** Node 16 will refuse to install due to the new `engines` field.
- **Type tightening.** Callers that relied on passing `any` to `isMerkleCensusProof`, `isCSPCensusProof`, or to the `meta` map on `ElectionMetadata` should now pass `unknown` (or the proper typed value). The runtime behavior is unchanged.
- **`ElectionResultsType` and related types are removed.** If you imported `ElectionResultsTypeNames`, `ElectionResultsType`, `AbstainProperties`, `ChoiceProperties`, `BudgetProperties`, `ApprovalProperties`, or `QuadraticProperties`, the imports will now fail at compile time. These types never carried meaningful values inside the SDK (`metadata.type` was always a placeholder); to know what kind of election a process is, use the new `info.electionPreset` field on `getProcess()` or `parseElectionPresetFromMetadata(metadata)`.

## [0.4.0] - 2026-05-14

### Changed
- Updated SDK network handling to support multi-network sequencer info flows.
- Bound on-chain operations to the active signer chain to improve cross-network safety.
- Expanded multichain integration and unit test coverage.

### Fixed
- Fixed contract error event handling to avoid ethers "unknown fragment" listener failures.
- Stabilized CI integration timing for sequencer bootstrap and process lifecycle waits.

### Removed
- **BREAKING**: Removed legacy single-network assumptions in network/process orchestration paths; integrations relying on previous implicit network resolution must migrate to the updated multi-network flow.

## [0.3.0] - 2026-04-28

### Changed
- Updated `@vocdoni/davinci-contracts` dependency to `0.0.45-rc1`.
- Aligned sequencer info endpoint types with the current API response.
- Simplified script examples to match the current process creation flow.

### Removed
- **BREAKING**: Removed `costFromWeight` from SDK ballot mode types, contract process creation, sequencer ballot input generation, crypto ballot inputs, examples, and documentation.
- **BREAKING**: Updated packed ballot mode encoding to remove the `costFromWeight` bit and shift subsequent fields accordingly.

### Added
- Added unit coverage for ballot validation rules in `BallotChecker`.

## [0.2.4] - 2026-04-07

### Fixed
- Fixed `BaseService` fetch initialization by binding `globalThis.fetch` to preserve browser context and avoid `Illegal invocation` errors.
- Added a clear configuration error when no global `fetch` is available and no `fetchImpl` is provided.

## [0.2.3] - 2026-03-31

### Changed
- Replaced the internal HTTP client implementation with native `fetch` across SDK API services.
- Preserved SDK error compatibility by keeping transport errors surfaced with a `.code` field.
- Increased CI full-election-cycle vote settlement wait time to reduce transient failures on slower runners.

### Removed
- Removed `axios` from SDK runtime dependencies.

### Fixed
- Relaxed API query parameter typing to support typed objects (for example, `SnapshotsQueryParams`) without TypeScript errors.

## [0.2.2] - 2026-03-26

### Changed
- Migrated SDK test commands and configuration from Jest to Vitest, including dedicated unit and integration configs.
- Updated CSP proof signing so voter index is included in the signed message (`index + processId + address + weight`), and extended `cspVerify` to optionally verify with an explicit index.
- Updated sequencer metadata hash validation to the 72-hex format returned by metadata endpoints.

### Fixed
- Forced integration tests to run sequentially under Vitest to avoid race conditions against shared infrastructure.
- Updated test setup/mocking utilities for Vitest compatibility and more reliable mock cleanup between tests.

## [0.2.1] - 2026-03-10

### Changed
- CSP vote payload compatibility updated to support sequencer field naming migration by normalizing legacy `index`/`voterIndex` handling before vote submission.
- CSP proof typing was aligned with numeric index transport expectations for sequencer interoperability.
- Core process lifecycle integration tests were refactored to reduce duplication with shared lifecycle builders and reusable status-stream assertions.

### Fixed
- Stabilized process status transition integration tests (`end`, `pause`, `cancel`, `resume`) by waiting on on-chain timestamp progression instead of fixed wall-clock sleeps.
- Reduced teardown-related integration flakiness by improving provider cleanup behavior in integration test runtime.

## [0.2.0] - 2026-02-24

### Added
- Native TypeScript CSP cryptography flow via `DavinciCSP` (no external CSP WASM runtime required).
- `DavinciSDK.getCSP()` helper for lazy CSP service initialization.
- Extended integration coverage for census providers, including CSP provider scenarios and validation.
- Expanded domain test suites and shared test helpers (`test/helpers/*`) for more consistent integration setup.

### Changed
- Updated `@vocdoni/davinci-contracts` dependency to `0.0.37` and aligned SDK contract/process wiring with the latest contracts package.
- CSP proof handling was consolidated around SDK-native types and validation in vote orchestration.
- Test command organization and docs were updated to include domain suites (`test:core`, `test:crypto`) and clearer environment variable usage.
- **BREAKING**: SDK configuration no longer accepts `addresses.organizationRegistry`.
- **BREAKING**: `sdk.organizations` accessor was removed from the public SDK API.
- **BREAKING**: Legacy sequencer crypto classes were removed in favor of `DavinciCSP` and `BallotInputGenerator`.

### Removed
- Removed deprecated/legacy sequencer crypto services:
  - `CircomProofService`
  - `DavinciCryptoService`
- Removed `OrganizationRegistry` service and its contract integration tests.
- Removed the `examples/ui` app and the `deploy-ui` GitHub workflow to keep this repository focused on SDK code and script examples.

### Fixed
- Minor sequencer integration test stability adjustments.

## [0.1.3] - 2026-02-05

### Fixed
- **Buffer Polyfill**: Fixed browser compatibility by adding proper buffer polyfill configuration
  - Added `buffer` package as a dependency
  - Added `@rollup/plugin-inject` for automatic Buffer injection in browser environments
  - Updated Rollup configuration to properly inject Buffer polyfill for browser builds
  - Ensures SDK works correctly in browser environments without manual Buffer setup
- Improved Rollup build configuration for better browser compatibility

### Removed
- Removed obsolete `src/js/` directory containing old JavaScript implementation
  - Cleaned up legacy code that was no longer in use
  - Reduced repository size and complexity

### Technical Details
- Browser builds now automatically include Buffer polyfill via Rollup plugin injection
- UMD, ESM, and CommonJS builds all properly handle Buffer dependencies
- No breaking changes - existing code continues to work without modifications

## [0.1.2] - 2026-02-02

### Added
- **Circuit File Caching**: Implemented in-memory caching for WASM, zkey, and verification key files
  - Prevents re-downloading circuit files when submitting votes in parallel
  - Files are downloaded once per `VoteOrchestrationService` instance and cached for all subsequent votes
  - Significantly improves performance for batch voting scenarios
- **Hash Verification**: Added SHA-256 hash verification for downloaded circuit files
  - Verifies integrity of `circuit.wasm`, `proving_key.zkey`, and `verification_key.json`
  - Controlled by `verifyCircuitFiles` configuration option (enabled by default)
  - Enhances security by ensuring downloaded files match expected hashes from sequencer
- Added `verifyHash()` private method in `VoteOrchestrationService` for file integrity checks

### Changed
- **VoteId Signing**: Modified `signVote()` method to pad voteId to 32 bytes (64 hex characters) before signing
  - Ensures consistent signature format for vote verification
  - Pads with leading zeros to meet required byte length
- Imported `sha256` from ethers for hash verification functionality

### Fixed
- Fixed Rollup configuration warning for `circomlibjs` global variable
  - Added `'circomlibjs': 'circomlibjs'` to UMD globals in `rollup.config.js`
  - Eliminates build warnings about missing global variable names

### Performance
- Circuit file downloads reduced from N downloads to 1 download when submitting N votes in parallel
  - Example: 5 parallel votes now download files once instead of 5 times
  - Cache is maintained per service instance throughout its lifetime

### Technical Details
- Cache implementation uses `Map<string, Uint8Array>` for WASM and zkey files
- Cache implementation uses `Map<string, any>` for parsed verification key JSON
- Hash verification uses ethers' `sha256` function for consistency
- All verification is performed after download but before caching
- `verifyCircuitFiles` and `verifyProof` options both default to `true` for maximum security

## [0.1.1] - 2026-01-26

### Changed
- Updated `@vocdoni/davinci-contracts` dependency from version 0.0.31 to 0.0.35
  - **v0.0.33**: Added `onchainAllowAnyValidRoot: boolean` field to census data
  - **v0.0.34**: Added `contractAddress: AddressLike` field for onchain censuses
- **BREAKING**: `OnchainCensus` constructor now requires `uri` parameter (no longer optional)
  - URI must point to a data source like a subgraph endpoint, not explorers
  - Added validation to reject empty URI strings
  - Example: `new OnchainCensus(tokenAddress, "https://api.studio.thegraph.com/...")`

### Added
- Added `contractAddress?: string` field to `CensusData` interface for onchain census support
- Added `onchainAllowAnyValidRoot?: boolean` field to `CensusData` interface
  - Automatically set to `true` for onchain censuses, `false` for others
- `CensusOrchestrator.getCensusData()` now extracts and returns `contractAddress` from `OnchainCensus` objects
- Enhanced README with comprehensive `OnchainCensus` documentation
  - Added token-based voting examples
  - Documented subgraph integration patterns
  - Provided examples for different subgraph providers (The Graph Studio, custom deployments)

### Fixed
- **CRITICAL**: `OnchainCensus` now sets `censusRoot` to 32-byte zero value (`0x0000...000`)
  - Required when `contractAddress` is set to prevent smart contract validation failures
  - Contract address is now properly passed through `contractAddress` field instead of `censusRoot`
- Fixed `ProcessRegistryService.newProcess()` to include both new census fields with proper defaults
- Fixed `ProcessRegistryService.setProcessCensus()` to include both new census fields with proper defaults
- Fixed `ProcessOrchestrationService.handleCensus()` to properly extract and pass `contractAddress`
- Updated all test files to provide required URI parameter for `OnchainCensus`
  - Fixed 17 tests in `test/census/unit/OnchainCensus.test.ts`
  - Fixed 3 tests in `test/census/unit/CensusOrchestrator.test.ts`
  - Added new test for URI validation

### Technical Details
- `censusRoot` for onchain censuses: `0x0000000000000000000000000000000000000000000000000000000000000000`
- `contractAddress` properly stored and exposed via getter in `OnchainCensus` class
- `onchainAllowAnyValidRoot` automatically managed based on census type
- Census data flow: `OnchainCensus` → `CensusOrchestrator` → `ProcessOrchestrationService` → `ProcessRegistryService` → Smart Contract

### Migration Guide

**Before (v0.1.0):**
```typescript
// URI was optional
const census = new OnchainCensus("0xTokenAddress...");
```

**After (v0.1.1):**
```typescript
// URI is required and should be a subgraph endpoint
const census = new OnchainCensus(
  "0xTokenAddress...",
  "https://api.studio.thegraph.com/query/12345/token-holders/v1.0.0"
);
```

## [0.1.0] - 2026-01-15

### Changed
- **BREAKING**: Complete census class refactor for improved API ergonomics
  - Removed `PlainCensus` and `WeightedCensus` classes
  - Added new named census classes that automatically determine their census origin:
    - `OffchainCensus()` - Static Merkle tree census for OffchainStatic origin
    - `OffchainDynamicCensus()` - Updatable Merkle tree census for OffchainDynamic origin
    - `OnchainCensus(contractAddress, uri?)` - On-chain census for Onchain origin
    - `CspCensus(publicKey, cspURI)` - Certificate Service Provider census for CSP origin
  - New unified `MerkleCensus` base class that supports both plain and weighted participants
    - Single `add()` method intelligently handles plain addresses (weight=1) and weighted participants
    - Flexible weight types: accepts string, number, or bigint values
  - Removed `CensusType` enum (redundant with named census classes)
  - Removed `size` parameter from all census classes (no longer needed)
  - **Smart maxVoters logic**: `maxVoters` is now optional for published MerkleCensus objects (OffchainCensus, OffchainDynamicCensus)
    - SDK automatically calculates `maxVoters` from participant count when using census objects
    - Still required for manual census configs, OnchainCensus, CspCensus, and PublishedCensus
- Updated `PublishedCensus` constructor to accept `CensusOrigin` instead of deprecated `CensusType`
- Updated `CspCensus` constructor to only require (publicKey, cspURI) parameters

### Added
- New `Participant` interface exported from `MerkleCensus` for type safety
- Comprehensive unit tests for all new census classes:
  - `test/census/unit/OffchainCensus.test.ts` - Tests for plain and weighted OffchainCensus
  - `test/census/unit/OffchainDynamicCensus.test.ts` - Tests for dynamic census functionality
  - `test/census/unit/OnchainCensus.test.ts` - Tests for on-chain census
- Updated existing tests:
  - `test/census/unit/PublishedCensus.test.ts` - Updated for new API
  - `test/census/unit/CspCensus.test.ts` - Updated for new constructor
  - `test/census/unit/CensusOrchestrator.test.ts` - Updated for new census classes
- Updated integration tests to use new census classes and maxVoters behavior:
  - `test/core/integration/SimpleProcessCreation.test.ts` - Updated all census usage
  - `test/core/integration/VoteOrchestration.test.ts` - Updated all census configs

### Removed
- Removed `PlainCensus` class (replaced by `OffchainCensus`)
- Removed `WeightedCensus` class (replaced by `OffchainCensus` with weighted participants)
- Removed `CensusType` enum (replaced by `CensusOrigin` usage)
- Removed `size` property from all census classes
- Removed legacy census test files:
  - `test/census/unit/PlainCensus.test.ts`
  - `test/census/unit/WeightedCensus.test.ts`

### Fixed
- Fixed `Participant` type export issue in census classes index file
- Updated example script to showcase new census API and optional maxVoters feature
- Updated README.md documentation to reflect new census class names and usage patterns
- Corrected all manual census configuration examples to exclude deprecated `size` parameter

### Migration Guide

#### Updating Census Classes

**Before (v0.0.7):**
```typescript
import { PlainCensus, WeightedCensus } from '@vocdoni/davinci-sdk';

// Plain census
const plainCensus = new PlainCensus();
plainCensus.add(['0x123...', '0x456...']);

// Weighted census
const weightedCensus = new WeightedCensus();
weightedCensus.add([
  { key: '0x123...', weight: 10 },
  { key: '0x456...', weight: 20 }
]);
```

**After (v0.1.0):**
```typescript
import { OffchainCensus } from '@vocdoni/davinci-sdk';

// Plain addresses (weight defaults to 1)
const census = new OffchainCensus();
census.add(['0x123...', '0x456...']);

// Weighted participants (same class!)
const census = new OffchainCensus();
census.add([
  { key: '0x123...', weight: 10 },
  { key: '0x456...', weight: 20 }
]);
```

#### Updating Process Creation with Census Objects

**Before (v0.0.7):**
```typescript
const census = new PlainCensus();
census.add(['0x123...', '0x456...']);

const process = await sdk.createProcess({
  census: census,
  maxVoters: 100, // Always required
  // ... other config
});
```

**After (v0.1.0):**
```typescript
const census = new OffchainCensus();
census.add(['0x123...', '0x456...']);

const process = await sdk.createProcess({
  census: census,
  // maxVoters is optional - auto-calculated from census!
  // ... other config
});
```

#### Updating Manual Census Configurations

**Before (v0.0.7):**
```typescript
const process = await sdk.createProcess({
  census: {
    type: CensusOrigin.OffchainStatic,
    root: "0x...",
    size: 100, // Had size parameter
    uri: "ipfs://..."
  },
  // ... other config
});
```

**After (v0.1.0):**
```typescript
const process = await sdk.createProcess({
  census: {
    type: CensusOrigin.OffchainStatic,
    root: "0x...",
    uri: "ipfs://..." // No size parameter
  },
  maxVoters: 100, // Now required for manual configs
  // ... other config
});
```

#### Updating CspCensus Usage

**Before (v0.0.7):**
```typescript
const census = new CspCensus(
  CensusOrigin.CSP,
  "0x...",
  "https://csp.example.com",
  1000
);
```

**After (v0.1.0):**
```typescript
const census = new CspCensus(
  "0x...", // publicKey
  "https://csp.example.com" // cspURI
);

// Use with maxVoters in process config
const process = await sdk.createProcess({
  census: census,
  maxVoters: 1000, // Required for CSP
  // ... other config
});
```

### Technical Details
- Census classes now use the class name itself to determine census origin, eliminating the need to pass `CensusOrigin` as a constructor parameter
- The `MerkleCensus` base class provides a unified implementation for both plain and weighted participants
- Automatic maxVoters calculation reduces boilerplate and prevents mismatches between census size and maxVoters
- All census classes properly extend the base `Census` class with appropriate origin types
- Type exports fixed to properly handle both type and value exports

## [0.0.7] - 2026-01-14

### Added
- **Batch Voting Submission**: Enhanced voting capabilities to support batch submission of multiple votes
  - Improved vote orchestration for handling multiple votes efficiently
  - Updated example script to demonstrate batch voting workflows
- **CensusNotUpdatable Error**: New error class for handling census update restrictions
  - Added to `src/contracts/errors.ts` for better error handling when census updates are not allowed

### Changed
- **BREAKING**: Refactored census origin types for better clarity and alignment with smart contracts
  - Changed `CensusOrigin.CensusOriginMerkleTree` to `CensusOrigin.OffchainStatic`
  - Changed `CensusOrigin.CensusOriginCSP` to `CensusOrigin.CSP`
  - Updated all census classes (`Census`, `PlainCensus`, `WeightedCensus`, `CspCensus`, `PublishedCensus`) to use new origin types
  - Updated `ProcessRegistryService` to reflect new census origin types in event callbacks
  - Modified SDK documentation and examples to use new census origin nomenclature
- Enhanced census origin handling across the SDK
  - Improved census type detection and origin assignment
  - Better validation for census update operations
- Updated `@vocdoni/davinci-contracts` dependency to version `0.0.31`
  - Includes latest smart contract improvements and census origin type updates

### Fixed
- Improved test coverage for census update scenarios
- Fixed census origin type consistency across the codebase

### Technical Details
- Census origin refactoring ensures consistency between SDK types and smart contract enums
- New `OffchainStatic` name better represents MerkleTree-based censuses stored off-chain
- All census-related tests updated to use new origin types
- Examples updated to demonstrate best practices with new API

## [0.0.6] - 2025-12-15

### Added
- **Process MaxVoters Management**: New methods to manage the maximum number of voters for a process
  - Added `setProcessMaxVoters(processId, maxVoters)` method to DavinciSDK for updating voter limits
  - Added `setProcessMaxVotersStream(processId, maxVoters)` for real-time transaction status monitoring
  - Added `maxVoters` optional parameter to `ProcessConfig` during process creation (defaults to census size)
  - Added `maxVoters` field to `ProcessInfo` returned by `getProcess()`
  - Available at all architecture layers: SDK, Orchestration, and Contract services
- Added `ProcessMaxVotersChangedCallback` event type for monitoring maxVoters changes
- Added `onProcessMaxVotersChanged()` event listener to ProcessRegistryService
- Contract integration now supports `@vocdoni/davinci-contracts` version 0.0.29 with maxVoters parameter

### Changed
- Updated `ProcessRegistryService.newProcess()` to include `maxVoters` parameter
- Updated `ProcessOrchestrationService` to automatically set maxVoters to census size if not specified
- Process creation now validates and enforces maximum voter limits on-chain

### Technical Details
- All process management methods follow consistent architecture pattern: `DavinciSDK` → `ProcessOrchestrationService` → `ProcessRegistryService` → `Smart Contract`
- MaxVoters updates emit `ProcessMaxVotersChanged` events on-chain for monitoring
- Comprehensive test coverage added at contract, orchestration, and SDK levels
- Both stream-based and promise-based APIs available for maximum flexibility

## [0.0.5] - 2025-12-04

### Changed
- **BREAKING**: `GetProcessResponse` type updated to match actual sequencer API response
  - `startTime` changed from `number` to `string` (ISO date format)
  - `result` changed from `string[]` to `string[] | null` (can be null before process ends)
  - Renamed `voteCount` to `votersCount` 
  - Renamed `voteOverwrittenCount` to `overwrittenVotesCount`
  - Removed `metadata` field (not returned by sequencer)
- **BREAKING**: `isAddressAbleToVote()` now returns `Promise<boolean>` instead of participant info object
  - Returns `true` if address is in census and can vote
  - Returns `false` only when address is not in census (error code 40001)
  - Throws errors for invalid inputs (invalid process ID, invalid address format, etc.)
  - Use new `getAddressWeight()` method to retrieve weight separately if needed
- Optimized MerkleTree voting to use sequencer's participant endpoint
  - Vote submission now calls `getAddressWeight()` instead of fetching full census proof
  - More efficient - only fetches required weight for vote encryption
  - Custom census providers still supported for both MerkleTree and CSP

### Added
- Added `getAddressWeight(processId, address)` method to retrieve voting weight
  - Returns weight as a string
  - Available in both SequencerService and DavinciSDK
  - Throws errors for invalid process ID or address not in census
- Added comprehensive test coverage for new methods
  - Updated `isAddressAbleToVote` tests to expect boolean return
  - Added 4 new tests for `getAddressWeight` functionality
  - Updated vote orchestration tests for new census proof flow

### Fixed
- Fixed sequencer integration tests to use new property names (`votersCount`, `overwrittenVotesCount`)
- Fixed vote orchestration to properly handle census weight retrieval from sequencer
- Improved error handling in `isAddressAbleToVote` to distinguish between "not in census" and other errors

### Technical Details
- `VoteOrchestrationService.getCensusProof()` now uses `getAddressWeight()` for MerkleTree census
- Census proof objects for MerkleTree voting now include minimal data (weight only)
- Full census proof still available through custom census providers if needed
- All type definitions now accurately match sequencer API responses

## [0.0.4] - 2025-12-01

### Changed
- **BREAKING**: Removed `maxVotes` field from census data structure in smart contracts
  - Census now only includes: `censusOrigin`, `censusRoot`, and `censusURI` (3 fields instead of 4)
  - Updated `ProcessRegistryService.newProcess()` to remove maxVotes parameter
  - Updated `ProcessRegistryService.setProcessCensus()` to remove maxVotes parameter
  - Updated `ProcessCensusUpdatedCallback` type signature
- **BREAKING**: Census proof `weight` field is now mandatory (required by Go WASM cryptographic operations)
  - Previously optional weight field in census proofs is now required
  - Type guards now validate that weight is present and is a string
- Fixed CSP proof verification to include weight parameter
  - Added `weight` field to `CSPSignOutput` interface
  - Added `weight` parameter to `cspVerify()` method
  - Updated all CSP-related tests to include weight in verification calls

### Added
- Added `isAddressAbleToVote()` method to DavinciSDK
  - Returns participant information including voting weight for an address
  - Useful for verifying voter eligibility before vote submission
  - Enables displaying voting power/weight to users
  - Supports building voter dashboards and analytics
- Added comprehensive test coverage for `isAddressAbleToVote()` functionality
  - 1 test in Sequencer integration tests
  - 4 tests in VoteOrchestration integration tests
- Updated README.md with documentation for new `isAddressAbleToVote()` method

### Fixed
- Fixed `ProcessInfo` interface to include census `size` field
  - Census size is not stored on-chain, so it's set to 0 when fetching process info
  - Ensures compatibility with the `BaseProcess` interface
- Fixed all test files to work with updated census data structure
  - Removed maxVotes assertions from ProcessRegistry tests
  - Removed maxVotes assertions from SimpleProcessCreation tests
  - Updated CensusOrchestrator tests to include missing size field
- All 23 CSP tests now passing with updated verification parameters

### Technical Details
- Census proof weight validation now enforced at compile-time
- CSP signature verification now properly includes weight in cryptographic operations
- Process information retrieval properly handles missing census size from on-chain data

## [0.0.3] - 2025-10-30

### Changed
- **BREAKING**: Removed legacy `environment` parameter from SDK configuration
- **BREAKING**: SDK now requires explicit `sequencerUrl` parameter
- Updated SDK to fetch contract addresses automatically from sequencer `/info` endpoint
- Improved contract integration tests to dynamically fetch addresses from sequencer
- Organized and optimized import statements across the codebase

### Added
- Added proper validation for `censusUrl` requirement when using PlainCensus or WeightedCensus
- Added helpful error messages when census URL is missing for census publication
- Documentation updates reflecting new initialization patterns in README

### Fixed
- Fixed async error handling in Sequencer integration tests
- Fixed census URL validation to properly check axios baseURL configuration
- Fixed test files to use environment variables instead of hardcoded URLs

### Removed
- Removed entire `src/core/config/` module (deprecated legacy configuration system)
- Removed unused `deployedAddresses` export and related configuration code
- Removed hardcoded contract addresses from codebase

## [0.0.2] - 2025-01-16

### Added
- Initial public release preparation
- Complete TypeScript SDK for Vocdoni DaVinci protocol
- Support for both MerkleTree and CSP census types
- Comprehensive examples (script and UI)
- Full test coverage with unit and integration tests

### Changed
- Updated build configuration for better module compatibility
- Improved error handling and type definitions

### Fixed
- Various bug fixes and stability improvements

## [0.0.1] - 2024-12-01

### Added
- **Core SDK Features**
  - Complete DaVinci SDK implementation with TypeScript support
  - Process creation and management capabilities
  - Vote submission with homomorphic encryption
  - Census creation and management (MerkleTree and CSP)
  - Smart contract integration for Ethereum networks
  - Support for Sepolia testnet and Ethereum mainnet

- **API Services**
  - Sequencer API client for vote processing
  - Census API client for participant management
  - Base API service with error handling and retries
  - Comprehensive type definitions

- **Cryptographic Features**
  - Homomorphic encryption for vote privacy
  - zk-SNARK proof generation and verification
  - Circom circuit integration
  - CSP (Census Service Provider) signature support

- **Developer Experience**
  - Complete TypeScript definitions
  - ESM and CommonJS module support
  - Browser and Node.js compatibility
  - Comprehensive JSDoc documentation
  - Multiple bundle formats (UMD, ES modules, CommonJS)

- **Examples and Documentation**
  - Script example with complete voting workflow
  - React UI example with wallet integration
  - Comprehensive README with usage examples
  - API reference documentation
  - Contributing guidelines

- **Testing Infrastructure**
  - Unit tests for all core functionality
  - Integration tests with real network interactions
  - Jest test framework setup
  - Test utilities and helpers

- **Build and Development**
  - Rollup build configuration for multiple formats
  - TypeScript compilation with strict mode
  - ESLint and Prettier configuration
  - Automated formatting and linting
  - Git hooks for code quality

- **Quality Assurance**
  - Comprehensive error handling
  - Input validation and sanitization
  - Network timeout and retry logic
  - Memory-efficient proof generation

### Technical Details
- **Dependencies**
  - ethers.js v6 for Ethereum interactions
  - axios for HTTP requests
  - snarkjs for zk-SNARK operations
  - @vocdoni/davinci-contracts for smart contract ABIs

- **Supported Networks**
  - Ethereum Sepolia testnet
  - Ethereum mainnet
  - Custom network configuration support

- **Supported Environments**
  - Node.js 16+
  - Modern browsers (Chrome, Firefox, Safari, Edge)
  - React applications
  - Vue.js applications
  - Vanilla JavaScript/TypeScript projects

### Known Issues
- None at initial release

---

## Release Notes

### Version 0.0.1 - Initial Release

This is the first public release of the Vocdoni DaVinci SDK, providing a complete TypeScript interface for building decentralized voting applications on the Vocdoni DaVinci protocol.

**Key Features:**
- 🔒 **Privacy-First**: Homomorphic encryption ensures vote privacy
- 🛡️ **Secure**: Built on battle-tested cryptographic primitives  
- ⚡ **Easy Integration**: Simple, intuitive API for developers
- 🌐 **Decentralized**: No central authority controls the voting process
- 📱 **Cross-Platform**: Works in browsers, Node.js, and mobile apps
- 🔧 **TypeScript**: Full type safety and excellent developer experience

**Getting Started:**
```bash
npm install @vocdoni/davinci-sdk ethers
```

See the [README](README.md) for complete usage examples and API documentation.

**Breaking Changes:** N/A (initial release)

**Migration Guide:** N/A (initial release)

---

## Contributing

When contributing to this project, please:

1. Follow the [Contributing Guidelines](CONTRIBUTING.md)
2. Update this CHANGELOG with your changes
3. Use the format described in [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
4. Group changes by type: Added, Changed, Deprecated, Removed, Fixed, Security

## Links

- [GitHub Repository](https://github.com/vocdoni/davinci-sdk)
- [npm Package](https://www.npmjs.com/package/@vocdoni/davinci-sdk)
- [Documentation](https://docs.vocdoni.io)
- [Issue Tracker](https://github.com/vocdoni/davinci-sdk/issues)
