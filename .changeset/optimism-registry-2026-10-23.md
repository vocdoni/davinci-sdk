---
'@vocdoni/davinci-sdk': patch
---

The `optimism` preset points to the OP Mainnet protocol v5.1 `ProcessRegistry` deployed on 2026-10-23 (`0xc916F985CbCdbEb25A0EE6950361cf7Dd9Fbe35a`, from block 158592889, process id prefix `0xe1b56c76`), with new DKG and Council adapters and a new DKG key network; the pins and the ballot key are unchanged. The registry `0x02D6…2B97` is retired: a sequencer on the new registry refuses an SDK still on it at `init()`.
