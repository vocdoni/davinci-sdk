---
'@vocdoni/davinci-sdk': patch
---

Harden the SDK against hostile servers and inputs. The sequencer client no longer follows redirects and keeps its default timeout and body cap when the config sets them to `undefined`. Circuit-file downloads are size-capped and a failing artifact cache counts as a miss. `verifyBallotProof` refuses non-canonical proof coordinates, and `ballotPublicSignals` refuses `numFields` outside 1..16 and non-canonical signals. The document URL policy now refuses the ranges the nodes refuse (`192.0.0.0/24`, `198.18.0.0/15`, `fec0::/10`, `::ffff:0:a.b.c.d`, trailing-dot `localhost`). CSP attestations with a high-S signature or `recid` 27/28, which nodes accept, are accepted and sent in canonical form.
