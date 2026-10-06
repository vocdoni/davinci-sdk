---
'@vocdoni/davinci-sdk': major
---

**Council decryption gate.** A Council ceremony fixes when its committee may decrypt; until then `getResultsStatus` reports the new state `awaiting-opening` with `decryptionOpening` (`mode` `'scheduled'` or `'manual'`, `opensAt` the scheduled or fallback date, or null), even for a tally of zeros, which the registry now stores only after the opening. New: `ProcessRegistryService.getCouncilDecryptionGate`, the `CouncilDecryptionGate` type, and `COUNCIL_POLICY_ABI` (the manager's `getPolicy`, written out from the Council spec). `finalizeResults` reverts with `DecryptionNotOpen` before the opening, and a `waitForResults` timeout names the opening date.

**Breaking:** `ResultsState` has the new member `awaiting-opening`. An exhaustive `switch` or `Record<ResultsState, …>` over it needs a case:

```ts nocheck
const label: Record<ResultsState, string> = {
  voting: 'Voting',
  grace: 'Grace window',
  'awaiting-key-holder': 'Waiting for the key holder',
  'awaiting-request': 'Waiting for the decryption request',
  locked: 'Locked',
  'awaiting-opening': 'Opens later', // new
  decrypting: 'Decrypting',
  finalizable: 'Ready to publish',
  results: 'Results',
  canceled: 'Canceled',
};
```
