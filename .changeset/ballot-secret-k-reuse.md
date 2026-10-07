---
'@vocdoni/davinci-sdk': patch
---

The documentation of the ballot secret `k` (`VoteConfig.k`, `encryptBallot`, `computeVoteId`, the voting and protocol guides, the README and SECURITY.md) said a reused `k` is refused as a duplicate. Only the same voter's `k` in the same process repeats a vote id; in another process or for another voter nothing refuses it, while the two ballots share their nonces and, under one election key, expose the difference of their choices. The documentation now forbids reusing `k` for any other ballot, revotes included. No behavior change.
