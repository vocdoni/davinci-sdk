/**
 * recipes/bootstrap.ts
 *
 * Wire up the Davinci SDK and verify the connection. This is the foundation
 * every other recipe builds on.
 *
 *   - construct a DavinciSDK with an ethers v6 signer + sequencer/census URLs
 *   - init() (mandatory — resolves contract addresses from the sequencer)
 *   - sanity-check that the RPC chain matches what the sequencer serves
 *
 * Usage:
 *   npm install @vocdoni/davinci-sdk ethers
 *   # set env vars (see references/setup.md), then:
 *   tsx bootstrap.ts
 */

import { JsonRpcProvider, Wallet } from "ethers";
import { DavinciSDK } from "@vocdoni/davinci-sdk";

const SEQUENCER_API_URL = process.env.SEQUENCER_API_URL!; // e.g. https://sequencer-dev.davinci.vote
const CENSUS_API_URL = process.env.CENSUS_API_URL!;       // e.g. https://c3-dev.davinci.vote
const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;

async function main() {
  // An organizer signer needs a provider (on-chain ops). A voting-only signer would not.
  const signer = new Wallet(PRIVATE_KEY, new JsonRpcProvider(RPC_URL));

  const sdk = new DavinciSDK({
    signer,
    sequencerUrl: SEQUENCER_API_URL,
    censusUrl: CENSUS_API_URL, // only needed to publish Merkle censuses / fetch census proofs
  });

  await sdk.init(); // REQUIRED before any other method
  console.log("SDK initialized");

  // Sanity check: does the sequencer serve our RPC's chain?
  const info = await sdk.api.sequencer.getInfo();
  const net = await signer.provider!.getNetwork();
  const chainId = Number(net.chainId);

  const supported = Object.values(info.networks).some((n) => n.chainID === chainId);
  if (!supported) {
    const available = Object.values(info.networks)
      .map((n) => `${n.shortName}(${n.chainID})`)
      .join(", ");
    throw new Error(`RPC chain ${chainId} not served by this sequencer. Available: ${available}`);
  }

  console.log(`Connected. chainId=${chainId}, sequencer=${info.sequencerAddress}`);
  console.log(`Ballot-proof circuit: ${info.circuitUrl}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
