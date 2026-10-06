---
'@vocdoni/davinci-sdk': minor
---

**Council key mode.** `keyMode: 'council'` (`KeyMode.Council`, 3) with a required `ceremonyId` (`bytes12` hex) binds a process to a Live Council ceremony, an invite-only threshold DKG whose organizer allowed the registry's Council adapter and authorized the creating account; its committee decrypts the tally through the same `requestResultsDecryption` / `finalizeResultsFromDKG` path and `getResultsStatus` states as `'dkg'`. New: `councilParams`, `CouncilDisabledError`, `ProcessRegistryService.getCouncilAdapter`, `OnchainDkg.council` (`epochId` is then the ceremony id and `aid` the request id), `DeploymentInfo.councilAdapter`, and the vendored `COUNCIL_ADAPTER_ABI`, `COUNCIL_MANAGER_ABI` (the real manager's adapter surface) and `COUNCIL_MANAGER_ERRORS_ABI`, whose errors `decodeDavinciError` names.

- The vendored ABIs come from davinci-contracts `a59a992` (the council branch over `36c0b0a`): `ProcessRegistry` gains `councilAdapter()`, `CouncilDisabled` and `DecryptionNotOpen`, and its constructor takes `_councilManager` after `_dkgManager`; `CouncilAdapter` has `isDecryptionOpen`, and `COUNCIL_MANAGER_ABI` is the Council v2 adapter surface (`getRequestMeta` instead of `getRequest`, plus `isDecryptionOpen`). Selectors, events and the `newProcess` and `getProcess` layouts are unchanged.
- `getProcess` decodes key mode 3 and still refuses any mode it does not know. **Releases before this one throw `unknown key mode 3` on a Council process: upgrade every reader of a chain before the first one is created there.**
- `createProcess` names every key mode: an unknown one is refused instead of being sent as `DKG_AUTOMATIC`, and `ceremonyId` is refused outside `'council'`.
- `verifyDeployment` also checks that the Council adapter, if any, points back at the registry. A registry without `councilAdapter()` reads as having none; any other failure of that read is thrown.
