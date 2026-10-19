---
'@vocdoni/davinci-sdk': patch
---

`cancelOpenProcesses` leaves alone a process past its grace end, which the v5 registry no longer cancels (its results may be on their way), instead of reporting it as failed with `InvalidTimeBounds`. `cancelProcess` on such a process still fails with that revert.
