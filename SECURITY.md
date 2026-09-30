# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 2.0.x   | Yes       |
| 1.0.x   | No        |

## Reporting a vulnerability

Do not report security vulnerabilities through public GitHub issues. Use one of these instead:

- Email **security@vocdoni.io** (preferred).
- Open a private [GitHub security advisory](https://github.com/vocdoni/davinci-sdk/security/advisories/new).

Include as much of the following as you can:

- the kind of vulnerability (a cryptographic flaw, a missing check, an injection, …) and its impact;
- the affected versions and environment (Node.js version, browser);
- steps to reproduce, and a proof of concept if you have one;
- any workaround you found.

### What happens next

1. We acknowledge the report within 48 hours.
2. Within 5 business days we assess its validity, severity and the affected versions.
3. We aim to fix critical issues within 7 days, high within 30 days, medium within 90 days, and low ones after that.
4. Once a fix is available we release it, publish an advisory and, if you wish, credit you.

We follow coordinated disclosure: give us reasonable time to fix the issue before you make it public. We will not pursue legal action against researchers who act in good faith, do not violate privacy or destroy data, and follow this process.

Fixes are recorded in [CHANGELOG.md](CHANGELOG.md) and announced through GitHub and npm security advisories and the community channels.

## What the SDK checks

- **The deployment.** `init()` checks that the `ProcessRegistry` pins the zkVM program vks, the vadcop root and the ballot VK hash of this release, and that its verifier's code hashes to the pinned value. Every sequencer node's `/info` must name the same chain, registry, ballot VK and programs.
- **The circuit files.** They are keyed by the ballot VK hash the registry pins. Each file is checked against its pinned sha256, and both verification keys (the file, and the one inside the proving key) must hash to the registry's value, whatever the source (default URLs, a mirror, a local directory or a cache). Every proof is verified locally before it is sent.
- **The election.** Voters build ballots from the registry's key, ballot mode and census root; a node's view of the process is only cross-checked, and a node reporting another key is refused.
- **Documents.** Metadata is used only when its bytes hash to the registry's `metadataHash`. Census files and metadata are downloaded only from public `http(s)` hosts, without following redirects.
- **Receipts.** Tracker proofs are checked against state roots read from the registry, never against the root a node reports.

## Trust assumptions

- A sequencer key (the default key mode) is held by one node: it can decrypt the ballots published in the settlement blobs and is the only party able to publish the results. The DKG key modes move both to a threshold of a committee.
- The SDK uses the node URLs and RPCs as configured. Use `https` for both in production, and nodes and RPCs you trust to be available.
- Proofs are generated with `snarkjs` and chain access goes through `ethers`; keep dependencies up to date.

## Using the SDK safely

Keep the deployment and proof checks on (they are the defaults), and keep private keys out of the code:

```typescript
const sdk = new DavinciSDK({
  signer: new Wallet(process.env.PRIVATE_KEY!),
  network: 'gnosis',
  sequencerUrls: ['https://sequencer-1.example.org'],
  rpcUrls: ['https://rpc.example.org'],
  verifyDeployment: true, // the registry must pin this release
  verifyProof: true, // every ballot proof is verified before it is sent
});
await sdk.init();
```

Two values the SDK returns are secrets:

```typescript
// A 'dkg-locked' organizer secret is returned once and never stored or logged
// by the SDK: persist it where the organizer's credentials live. Without it the
// results never unlock.
const { processId: id, organizerSecret } = await sdk.createProcess({ ...config, keyMode: 'dkg-locked' });

// A vote's ballot secret `k` opens the ballot with the election key: keep it
// private, or discard it.
const { k } = await sdk.submitVote({ processId: id, choices: [1, 0] });
```

Ballot secrets and organizer secrets are drawn from the platform's secure random source; a ballot secret given by hand below 2^128 is refused. In a browser, keys live in memory: prefer a wallet extension or a hardware wallet for organizer accounts, and protect the page against XSS.

## Contact

- Security: security@vocdoni.io
- Everything else: info@vocdoni.io, or [Discord](https://chat.vocdoni.io)
