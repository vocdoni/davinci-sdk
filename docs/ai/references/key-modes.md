# `references/key-modes.md` — Who holds the election key

Companion to the [[davinci-sdk]] skill. Every process has one of four key modes, chosen at creation with `keyMode`. The key encrypts every ballot; whoever holds its secret can decrypt the tally, and could open the ballots published in the settlement blobs. The mode decides who that is and who publishes the results.

| `keyMode` | `KeyMode` | Who holds the secret | Who publishes the results |
| --- | --- | --- | --- |
| `'sequencer'` (default) | `Sequencer` (0) | the key node (`keySequencerUrl`) | only that node |
| `'dkg'` | `DkgAutomatic` (1) | a davinci-dkg committee, as threshold shares | any node asks the committee, which decrypts the final tally |
| `'dkg-locked'` | `DkgLocked` (2) | the committee plus the organizer | the committee, once the organizer reveals its secret |
| `'council'` | `Council` (3) | an invite-only Council committee, as threshold shares | the committee decrypts the final tally; anyone stores it |

In every mode only the final tally is decrypted, after the grace window (`references/grace.md`), and never the individual ballots.

## On Gnosis (production beta)

The `gnosis` deployment, the default network, offers two committee options for elections whose ballots no single party can open.

| Option | `keyMode` | What the organizer prepares | When the results come |
| --- | --- | --- | --- |
| **Automatic**: a rotating committee of independent node operators | `'dkg'` (`'dkg-locked'` to release the results on the organizer's word) | nothing | 1 to 5 minutes after the grace window |
| **Election committee**: a committee the organizer invites (a board, an assembly) | `'council'` with a `ceremonyId` | a Live Council ceremony that grants the registry's Council adapter and the creating account | once the ceremony opens decryption: on its scheduled date, or when its organizer opens it |

Sequencer keys remain for tests and demos. During the beta both committees prove their work with circuits from development trusted setups: one party generated each Groth16 setup, and whoever kept its secret randomness could forge committee proofs until multi-party ceremonies replace them.

### With Automatic

```ts
const { processId } = await sdk.createProcess({ ...config, keyMode: 'dkg' });
```

The registry takes a free key from the network's newest live epoch; nothing else is needed. The process then goes `voting` → `grace` → `awaiting-request` → `decrypting` → `finalizable` → `results`, the last four within minutes of the grace end. Nodes ask for the decryption and store the tally on their own; `waitForResults({ finalize: true })` stores it from the signer if no node has a minute after it is ready.

### With an Election committee

1. The Council's organizer creates a ceremony in the Council app ([davinci-dkg-council](https://github.com/vocdoni/davinci-dkg-council)), invites the members and waits until they have joined and dealt: the ceremony is then `Live`. Its decryption opening is fixed at creation: a scheduled date (after the vote's end plus the grace window), or manual with an optional fallback date.
2. The organizer grants the registry's Council adapter and the account that calls `createProcess`. Both grants are permanent for that ceremony.
3. The product creates the process with the ceremony id:

```ts
const adapter = await sdk.registry.getCouncilAdapter(); // the address to grant; null without Council support
const ceremonyId = '0x00c0c1a7e0000000000000a1'; // bytes12 hex, from the Council app
const { processId } = await sdk.createProcess({ ...config, keyMode: 'council', ceremonyId });
```

The process then goes `voting` → `grace` → `awaiting-opening` until the ceremony opens decryption (`status.decryptionOpening` says how: `'scheduled'` with its date, or `'manual'` with the fallback date or none) → `decrypting` while `t` members post their decryption shares → `finalizable` → `results`. Nothing is published before the opening, not even a tally of zeros, and one opening unlocks every process bound to the ceremony. A missing grant fails the creation before anything is sent (`NotAllowedAdapter`, `NotAuthorizedCreator`).

### What to show voters and organizers

| `state` | Automatic | Election committee |
| --- | --- | --- |
| `voting`, `grace` | voting, then counting the last votes | the same |
| `awaiting-request`, `decrypting`, `finalizable` | decrypting the results, minutes | the committee is decrypting; it needs `t` members to show up |
| `awaiting-opening` | (never) | locked until the opening: the date, or "until the organizer opens them" |
| `locked` | `'dkg-locked'` only: waiting for the organizer's reveal | (never) |
| `results` | the tally | the tally |

## Sequencer key

```ts
const { processId } = await sdk.createProcess({ ...config, keyMode: 'sequencer' });
```

The SDK asks the key node for the key of the id the registry assigns next, checks it is a valid point of the prime-order subgroup, and creates the process with it. That node derives the secret from its master key and is the only one able to prove and publish the results; if it disappears, the results never come. It also holds a key that opens every ballot in the blobs, so this mode trusts one node with ballot secrecy. It suits tests, and organizers who accept that trust.

Two creations from one account must not race for the same id: the SDK serializes creations per account, and a creation that lands under another id anyway fails with `WrongProcessIdError` (`created`, `expected`). No node holds that process's key; cancel it (`cancelOpenProcesses()` finds it).

## DKG key (`'dkg'`)

```ts
const { processId } = await sdk.createProcess({ ...config, keyMode: 'dkg' });
```

The registry takes a free key from the pool of the committee's newest live epoch. No sequencer and no organizer holds the secret; each committee member holds a share. After the grace window a node sends `requestResultsDecryption`, the committee combines its decryption shares (1 to 5 minutes), and a node stores the tally with `finalizeResultsFromDKG`. Anyone may send that last call; `waitForResults({ finalize: true })` sends it from the signer when no node has after a minute.

- A registry deployed without a DKG manager refuses both DKG modes: `DkgDisabledError`, before anything is uploaded.
- An epoch pool holds 16 keys. When it runs out, or a new epoch goes live, between the read and the transaction, the creation is retried once (a second `Pending` event).
- `NoLiveEpoch` (`revertName`) means no epoch can take a process right now; the committee opens a new one within minutes.

## DKG-locked key and the organizer secret (`'dkg-locked'`)

```ts
const { processId, organizerSecret } = await sdk.createProcess({
  ...config,
  keyMode: 'dkg-locked',
});
// Store organizerSecret (a bigint) now: the SDK keeps no copy and never logs it.
```

The key is the committee's pool key plus an organizer key. The SDK draws the organizer secret, proves possession of it to the DKG (a Schnorr proof bound to the epoch and the application id), and returns it once, in `organizerSecret`. The committee does not decrypt anything until the secret is revealed:

```ts
await sdk.revealProcessKey(processId, organizerSecret);
```

- It works at any time and needs only the secret, not the organizer's account. Revealing after the end lets the organizer decide **when** the tally appears, never **which** tally.
- Revealing while voting runs drops the process to the `'dkg'` trust model.
- A wrong secret is refused by the simulation (`ProcessKeyRevealError`, `revertName` `InvalidOrganizerSecret`) before anything is sent. A second reveal is refused (`AlreadyRevealed`).
- **Losing the secret loses the results.** Keep it where the organizer's other credentials live; do not put it in the metadata, logs or the browser's local storage of a shared machine.

Until the reveal, `getResultsStatus` reports `locked` after the grace window, and `waitForResults` fails with `ResultsError('locked')` unless `waitForReveal: true` (`references/results.md`).

## Council key (`'council'`)

```ts
const { processId } = await sdk.createProcess({
  ...config,
  keyMode: 'council',
  ceremonyId: '0x00c0c1a7e0000000000000a1', // bytes12 hex of a Live Council ceremony
});
```

The key is the public key of a Council ceremony: an invite-only threshold DKG whose members were invited by its organizer, instead of the public davinci-dkg committee. The ceremony must be `Live`, and its organizer must already have allowed the registry's Council adapter (`sdk.registry.getCouncilAdapter()`) and authorized the account that creates the process. The process is bound to the ceremony under a request id; results go through the same calls as `'dkg'` (`requestResultsDecryption`, then `finalizeResultsFromDKG` once the members have combined every field), and `getResultsStatus` reports the same states, plus `awaiting-opening` while the ceremony has not opened decryption (`references/results.md`).

- `ceremonyId` is required with `'council'` and refused with every other mode. There is no organizer secret and nothing to reveal (`revealProcessKey` reverts with `InvalidKeyMode`).
- Every process bound to one ceremony shares its key. Organizers who need two votes kept apart run two ceremonies.
- The ceremony decides when results may be decrypted (a scheduled date, or the organizer's opening with an optional fallback date), once for every process bound to it. Nothing is published before, not even a tally of zeros: `getResultsStatus` reports `awaiting-opening` with `decryptionOpening`, and `finalizeResults` reverts with `DecryptionNotOpen`.
- A registry without a Council manager, or one deployed before the mode, refuses it: `CouncilDisabledError`, before anything is uploaded. A ceremony that is not Live, an adapter it does not allow or a creator it does not authorize fails the creation with the manager's error in `revertName` (`WrongPhase`, `NotAllowedAdapter`, `NotAuthorizedCreator`, `UnknownCeremony`); it is not retried.
- SDK releases before this mode throw `unknown key mode 3` when they read a Council process; every reader of a chain must upgrade before the first one is created there.

## Reading the mode

```ts
import { KeyMode } from '@vocdoni/davinci-sdk';

const info = await sdk.getProcess(processId);
if (info.keyMode === KeyMode.DkgLocked) {
  console.log('epoch', info.dkg?.epochId, 'decryption requested:', info.dkg?.resultsRequested);
}
const revealed = info.dkg ? await sdk.registry.isProcessKeyRevealed(info.dkg) : false;
if (info.keyMode === KeyMode.Council) {
  // dkg.epochId is the ceremony id and dkg.aid the request id the process decrypts under.
  console.log('ceremony', info.dkg?.epochId, 'request', info.dkg?.aid);
}
```

## Choosing

- **Tests, demos, trusted operator:** `'sequencer'`. Fastest results, no committee.
- **Public elections:** `'dkg'`. No single party can decrypt ballots or withhold the results.
- **Results released on the organizer's schedule** (an embargo, an announcement): `'dkg-locked'`, with the secret stored safely.
- **A committee the organization picks itself** (a board, an assembly that votes several times): `'council'`, bound to that committee's ceremony.

## Cross-references

- `references/results.md`: the results states per key mode.
- `references/process.md`: creation and `revealProcessKey` among the controls.
- `recipes/dkg-locked.ts`: a locked election and its reveal.
