---
'@vocdoni/davinci-sdk': major
---

OP Mainnet (chain 10, L1-blob mode) replaces Gnosis as the production network, and the release pins move to ZisK 1.3.2.

- The `optimism` preset (`OPTIMISM`) is the default network: public RPCs, an Ethereum beacon API for the blobs, 1 confirmation. Its registry (`0x64d41aD49009204E8dAcc153Fc98a5Ee14cB6916`) has the DKG and Council adapters.
- The `gnosis` preset and the `GNOSIS` export are removed, and `NETWORKS` lists only `optimism`. `new DavinciSDK({ network: 'gnosis' })` now throws `unknown network "gnosis"`. A process of the retired Gnosis registry stays readable as a custom network with `verifyDeployment: false`; `docs/ai/references/setup.md` has the snippet.
- `RELEASE_PINS` (`BATCH_PROGRAM_VK`, `RESULTS_PROGRAM_VK`, `ROOT_C_VADCOP_FINAL`, `ZISK_VERIFIER_CODEHASH`) are the ZisK 1.3.2 values. A registry that pins the old values fails the deployment check, so the SDK works with the 1.3.2 registries only.
- The vendored `ProcessRegistry` ABI is the L1-blob one: its constructor takes `_l1BlobVerifier`, and it adds `submitStateTransitionL1`, the `ProcessStateTransitionedL1` event (decoded into the `RegistryEvent` union as `{ name: 'ProcessStateTransitionedL1', l1BlockNumbers, versionedHashes }`) and the `WrongDAMode` error.

Before:

```ts nocheck
import { GNOSIS } from '@vocdoni/davinci-sdk';
new DavinciSDK({ signer, sequencerUrls, network: 'gnosis' });
```

After:

```ts nocheck
import { OPTIMISM } from '@vocdoni/davinci-sdk';
new DavinciSDK({ signer, sequencerUrls }); // or network: 'optimism'
```
