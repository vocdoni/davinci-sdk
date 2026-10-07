---
'@vocdoni/davinci-sdk': major
---

**The `gnosis` preset names the production-beta registry.** `network: 'gnosis'` (the default) and `GNOSIS` point at the `ProcessRegistry` `TODO(prod-beta): R2 address`, deployed at block `TODO(prod-beta): R2 start block`, whose process ids carry the prefix `TODO(prod-beta): R2 prefix`. It creates elections in every key mode: a sequencer key, the DKG key network (`'dkg'`, `'dkg-locked'`) and a Council (`'council'`). `init()` checks that both its DKG and Council adapters point back at it.

**Breaking:** the registry of 2.x, `0x6702e0141B6b72bCF8C1bdff20A82A35C5502E7D`, is retired. Under the new preset every facade method refuses a process id it created (`was not created by the gnosis registry`), and `networkOfProcessId` no longer knows it. To read or finish such a process, name that registry as a custom network, with nodes that still follow it:

```ts
const retired = new DavinciSDK({
  signer,
  sequencerUrls: nodeUrls,
  network: {
    name: 'gnosis-retired',
    chainId: 100,
    processRegistry: '0x6702e0141B6b72bCF8C1bdff20A82A35C5502E7D',
    startBlock: 48_504_090,
    rpcUrls: GNOSIS.rpcUrls,
  },
});
await retired.init();
```
