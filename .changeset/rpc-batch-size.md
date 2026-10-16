---
'@vocdoni/davinci-sdk': patch
---

`FailoverRpcProvider` sends at most 3 calls per JSON-RPC request. dRPC's free plan, the last endpoint of the `optimism` preset, refuses larger batches, so a batched call that fell through to it after the other endpoints failed or rate-limited used to fail with "Batch of more than 3 requests are not allowed".
