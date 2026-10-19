---
'@vocdoni/davinci-sdk': minor
---

Pre-production ballot key and registry. Ballots are now proved under the phase-2 ceremony key of davinci-circom v1.2.0 (ballot VK hash `0x7caf…e219`, replacing the development key; its circuit files are pinned by sha256 and fetched from the DAVINCI CDN, then raw GitHub), and `init()` checks the registry pins that hash. The `optimism` preset points to the OP Mainnet protocol v5 pre-production `ProcessRegistry` (`0x6F500A3e3A161EcB3C19A034bFB6a6Ac3b71abE6`, from block 158414417, process id prefix `0x3c3e0777`); the previous registry (`0x64d4…6916`) is retired. A public ceremony replaces this key before public production.
