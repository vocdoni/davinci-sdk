# `references/census.md` — Censuses: who may vote, and with what weight

Companion to the [[davinci-sdk]] skill. A **census** lists the voters and their weights. The registry stores its origin, a root and a URI; nodes use them to check every vote. There are four origins, and a census class for each.

## The four origins

```ts
enum CensusOrigin {
  OffchainStatic = 1, // a Merkle census file, fixed at creation
  OffchainDynamic = 2, // a Merkle census file the organizer may replace until the end
  Onchain = 3, // an append-only census contract
  CSP = 4, // a credential service provider's signatures
}
```

| Origin | Class | Root | Where nodes get the members | Changes |
| --- | --- | --- | --- | --- |
| 1 | `OffchainCensus` | lean-IMT root | the census file at the URI | none |
| 2 | `OffchainDynamicCensus` | lean-IMT root of the current version | the census file at the URI | `updateCensus` until the end |
| 3 | `OnchainCensus` | zero at creation; the contract's roots | the contract's `CensusMemberAdded` logs | members added to the contract count |
| 4 | `CspCensus` | the CSP's Ethereum address | none: each vote carries a CSP signature | whatever the CSP signs |

A Merkle leaf is `(address << 88) | weight`: a weight is a whole number below 2^88. Weight 1 is the usual one-person-one-vote; see `references/ballot-modes.md` for what a weight does to a ballot.

**Ballot slots.** Each voter's ballot lives in one slot of the state tree, derived from its address (Merkle origins) or `0x10 + index` (CSP). A voter's revote overwrites its own slot. Two members on one slot would overwrite each other, so a census with colliding slots is refused: by `add` (`CensusSlotCollisionError`), by the nodes, and by the census contract (`SlotTaken`). A collision is astronomically unlikely unless someone grinds addresses for it.

## Merkle censuses (origins 1 and 2)

```ts
import { OffchainCensus } from '@vocdoni/davinci-sdk';

const census = new OffchainCensus(); // or new OffchainDynamicCensus()
census.add('0x1111111111111111111111111111111111111111'); // weight 1
census.add([
  { key: '0x2222222222222222222222222222222222222222', weight: 5 },
  { key: '0x3333333333333333333333333333333333333333', weight: '100' },
  '0x4444444444444444444444444444444444444444',
]);

census.remove('0x1111111111111111111111111111111111111111');
census.getWeight('0x2222222222222222222222222222222222222222'); // '5'
census.size; // 3
const root = await census.root(); // bytes32 hex
const bytes = census.serialize(); // the census file nodes download
```

- Weights are a decimal string, a safe integer or a bigint. Re-adding a member changes its weight in place. A batch `add` is all or nothing.
- Mixed-case addresses must carry a valid checksum; the zero address is refused.
- Any change clears the published root and URI.
- `OffchainCensus.fromJSON(bytes | text | json)` reads a census file back. It is stricter than the nodes' parser, never laxer: what it accepts, nodes load with the same root.

### Publishing

`createProcess` publishes an unpublished census object through the SDK's `uploader`, then downloads it back as the nodes will (a 200 with no redirect, from a public host, at most 256 MiB) and checks the root, all before the key request and the transaction. A census the nodes cannot load would leave the process ignored, with no way to fix it but a new process. To publish on your own:

```ts
import { publishCensus, verifyCensusUrl } from '@vocdoni/davinci-sdk';

const published = await publishCensus(census, uploader); // { uri, root, size, sha256 }
// A census file hosted elsewhere: check it before a process points at it.
await verifyCensusUrl('https://files.example.org/census.json', published.root);
```

A census already served is passed as a `PublishedCensus` (checked the same way unless `documents.verify` is false):

```ts
import { CensusOrigin, PublishedCensus } from '@vocdoni/davinci-sdk';

const census = new PublishedCensus(
  CensusOrigin.OffchainStatic,
  '0x0a3b…root', // the lean-IMT root, as 0x hex or a bigint
  'https://files.example.org/census.json'
);
await sdk.createProcess({ ...config, census, maxVoters: 1000 });
```

The node limits: at most 4,194,304 members (`MAX_CENSUS_MEMBERS`) and a 256 MiB file (`MAX_CENSUS_BYTES`).

### Updating an updatable census (origin 2)

```ts
import { OffchainDynamicCensus } from '@vocdoni/davinci-sdk';

const members = new OffchainDynamicCensus();
members.add(['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222']);
const { processId } = await sdk.createProcess({ ...config, census: members });

members.add('0x5555555555555555555555555555555555555555');
members.remove('0x2222222222222222222222222222222222222222');
await sdk.updateCensus(processId, members); // publishes the new version, then setProcessCensus
```

- Only the organizer, while the process is READY or PAUSED and before its end. Any other origin fails with `CensusNotUpdatable`, before anything is uploaded.
- `updateCensus(processId, { root, uri })` points at a census file served elsewhere (checked first).
- Nodes load the new version in the background and answer votes with "busy" (429) meanwhile. A pending vote whose member was removed or reweighted fails with `census changed, recast`; the voter votes again if still a member.

## On-chain census (origin 3)

The census is a contract of [davinci-onchain-census-contract](https://github.com/vocdoni/davinci-onchain-census-contract), branch `davinci-zkvm`: an append-only lean-IMT with fixed weights and one ballot slot per member. `OwnedCensus` is its owner-managed version. Deploy one with Foundry from that repository (it links the `PoseidonT3` library), then manage it with `OnchainCensusService`:

```ts
import { OnchainCensus, OnchainCensusService, SmartContractService } from '@vocdoni/davinci-sdk';

const contract = '0x9999999999999999999999999999999999999999'; // your OwnedCensus
const owned = new OnchainCensusService(contract, signer); // the owner's signer
await SmartContractService.executeTx(
  owned.addMembers(
    ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'],
    [1n, 3n]
  )
);

const census = new OnchainCensus(contract); // URI defaults to onchain://<address>
await census.check(sdk.provider); // the contract is a davinci-zkvm census: { root, size }
const { processId } = await sdk.createProcess({ ...config, census, maxVoters: 1000 });
```

- The registry reads the contract's root at creation and accepts any root the contract records from then on, so members added while the process runs can vote.
- `createProcess` runs `check()` on an `OnchainCensus` object before sending: a contract without the davinci-zkvm `slotOf` (the upstream census, whose weights can change) is refused with `CensusContractError`.
- A contract that ever changes a member's weight is marked unusable by the nodes.
- Reads: `getCensusRoot()`, `treeSize()`, `weightOf(address)` (0 for a non-member), `slotOf`, `slotOwner`, `totalVotingPower()`. Writes (`OwnedCensus`): `addMember(user, weight)` and `addMembers(users, weights)`, with the contract's errors (`SlotTaken`, `AlreadyRegisteredAddress`, `InvalidCensusWeight`) in `revertName`.
- Voters' weights are read from the contract, not from the nodes.

## CSP census (origin 4)

A credential service provider authenticates voters however it likes and signs, per voter, an attestation of its address, weight and index with a secp256k1 key. The census root is that key's address.

The CSP side:

```ts
import { CspSigner } from '@vocdoni/davinci-sdk';
import { Wallet } from 'ethers';

const csp = new CspSigner(new Wallet(process.env.CSP_KEY!));
const census = await csp.census('https://csp.example.org'); // a CspCensus; the URI tells voters where to ask
const { processId } = await sdk.createProcess({ ...config, census, maxVoters: 500 });

// Later, for a voter the CSP has authenticated:
const attestation = await csp.attest({ processId, address: voterAddress, weight: 1n });
```

`CspSigner` hands out indexes 0, 1, 2… per process and pins each voter to one index and one weight: two voters on one index would overwrite each other's ballots, and a voter with two would vote twice. Its memory lasts as long as the instance; a CSP that restarts keeps its own table of address, index and weight and passes `index` and `weight` explicitly. Indexes stay at or below 2^53 − 1.

The voter side needs a provider that fetches its attestation:

```ts
import { DavinciSDK, type CspAttestation } from '@vocdoni/davinci-sdk';
import { Wallet } from 'ethers';

const voter = new DavinciSDK({
  signer: new Wallet(process.env.VOTER_KEY!),
  sequencerUrls: nodeUrls,
  censusProviders: {
    // Ask your CSP service; the SDK checks the attestation before proving.
    csp: async ({ processId, address }) => {
      const res = await fetch(`https://csp.example.org/attest?process=${processId}&voter=${address}`);
      const body = (await res.json()) as Record<string, string | number>;
      return {
        address: String(body.address),
        weight: BigInt(body.weight),
        index: BigInt(body.index),
        r: String(body.r),
        s: String(body.s),
        recid: Number(body.recid) as 0 | 1,
      } satisfies CspAttestation;
    },
  },
});
```

The attestation must recover to the census root, name the voter and use a ballot index; otherwise the vote fails with `CensusWitnessError` before anything is proved.

## Hand-given census

```ts
import { CensusOrigin } from '@vocdoni/davinci-sdk';

await sdk.createProcess({
  ...config,
  census: {
    type: CensusOrigin.OffchainStatic,
    root: '0x0a3b…root',
    uri: 'https://files.example.org/census.json',
  },
  maxVoters: 100,
});
```

A Merkle URL given this way is still downloaded and checked; an origin-3 config needs `contractAddress` and skips the contract probe.

## `maxVoters`

| Census | `maxVoters` at `createProcess` |
| --- | --- |
| `OffchainCensus`, `OffchainDynamicCensus` object | optional: defaults to the member count |
| `PublishedCensus`, `OnchainCensus`, `CspCensus`, a `CensusConfig` | required |

## How a vote proves membership

`submitVote` does this for you:

- **Origins 1 and 2:** the nodes' participant endpoint gives the voter's weight and lean-IMT proof, checked locally and against the registry's root. The voter is "not in the census" only when every node says so.
- **Origin 3:** the census contract's `weightOf`.
- **Origin 4:** `censusProviders.csp`.

`censusProviders.merkle` replaces the source for origins 1 to 3. `sdk.getAddressWeight(processId, address)` and `sdk.isAddressAbleToVote(processId, address)` use the same path.

## Cross-references

- `references/process.md`: passing the census to `createProcess`.
- `references/voting.md`: the vote flow.
- `recipes/onchain-census.ts`: an election on an `OwnedCensus`.
