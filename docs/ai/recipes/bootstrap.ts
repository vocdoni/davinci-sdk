/**
 * recipes/bootstrap.ts
 *
 * Configure the SDK for a deployment, initialize it and report what it found:
 *
 *   - the network (Gnosis by default) and the registry it points at
 *   - the registry pins, checked by init() against this SDK release
 *   - every sequencer node's /info, checked against the registry
 *   - the grace window parameters
 *
 * Environment:
 *   DAVINCI_NODES  comma-separated sequencer node URLs of the deployment
 *   RPC_URL        optional JSON-RPC of the network (default: the preset's public RPCs)
 *   PRIVATE_KEY    optional; a random wallet is enough to read
 *
 * Usage:
 *   npm install @vocdoni/davinci-sdk ethers
 *   tsx bootstrap.ts
 */

import { DavinciSDK } from '@vocdoni/davinci-sdk';
import { Wallet } from 'ethers';

const nodes = (process.env.DAVINCI_NODES ?? '').split(',').filter(Boolean);
const rpcUrls = process.env.RPC_URL ? [process.env.RPC_URL] : undefined;

async function main() {
  if (nodes.length === 0) throw new Error('set DAVINCI_NODES to the sequencer node URLs');
  const signer = process.env.PRIVATE_KEY
    ? new Wallet(process.env.PRIVATE_KEY)
    : Wallet.createRandom();

  const sdk = new DavinciSDK({ signer, sequencerUrls: nodes, rpcUrls });
  await sdk.init(); // throws DeploymentPinError or NodeMismatchError when something does not match

  const { name, chainId, processRegistry, processIdPrefix } = sdk.network;
  console.log(
    `network ${name} (chain ${chainId}), registry ${processRegistry}, prefix ${processIdPrefix}`
  );
  console.log('ballot VK hash', await sdk.registry.getBallotVKHash());
  console.log('grace window', await sdk.getGraceParams());

  for (const node of sdk.nodeChecks) {
    const settled = node.info ? `, settled ${node.info.settledBySelf} batches` : '';
    console.log(
      `node ${node.url}: ${node.status}${node.reason ? ` (${node.reason})` : ''}${settled}`
    );
  }
  console.log('processes the nodes know:', (await sdk.listProcesses()).length);
}

main().then(
  () => process.exit(0),
  err => {
    console.error(err);
    process.exit(1);
  }
);
