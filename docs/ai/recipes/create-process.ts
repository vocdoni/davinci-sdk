/**
 * recipes/create-process.ts
 *
 * Create an election with a local Merkle census, following its transaction:
 *
 *   - an OffchainCensus of addresses (weight 1 each), published by createProcess
 *   - the metadata document built from the title and questions, published too
 *   - a single-choice preset over 4 options
 *   - the TxStatus stream a UI would show
 *
 * The organizer's signer needs a provider on the network's chain (Gnosis by
 * default) and gas. Census files and metadata documents are published with an
 * HTTP PUT to UPLOAD_URL and must then be served, unchanged, at PUBLIC_URL over
 * public https: replace `uploader` with your own store.
 *
 * Environment: DAVINCI_NODES, RPC_URL, PRIVATE_KEY, UPLOAD_URL, PUBLIC_URL
 *
 * Usage:
 *   tsx create-process.ts 0xVoter1,0xVoter2,0xVoter3
 */

import { DavinciSDK, OffchainCensus, TxStatus, type Uploader } from '@vocdoni/davinci-sdk';
import { JsonRpcProvider, Wallet } from 'ethers';

const { RPC_URL, PRIVATE_KEY, UPLOAD_URL, PUBLIC_URL } = process.env as Record<string, string>;
const nodes = (process.env.DAVINCI_NODES ?? '').split(',').filter(Boolean);
const voters = (process.argv[2] ?? '').split(',').filter(Boolean);

const uploader: Uploader = {
  async upload({ data, contentType, sha256 }) {
    const name = `${sha256.slice(2)}.json`;
    const res = await fetch(`${UPLOAD_URL}/${name}`, {
      method: 'PUT',
      body: new Uint8Array(data), // a copy fetch types accept
      headers: { 'content-type': contentType },
    });
    if (!res.ok) throw new Error(`upload of ${name} failed: HTTP ${res.status}`);
    return `${PUBLIC_URL}/${name}`;
  },
};

async function main() {
  if (voters.length === 0) throw new Error('usage: tsx create-process.ts <address,address,...>');

  const sdk = new DavinciSDK({
    signer: new Wallet(PRIVATE_KEY, new JsonRpcProvider(RPC_URL)),
    sequencerUrls: nodes,
    uploader,
  });
  await sdk.init();

  // 1. The census: plain addresses weigh 1 (census.add({ key, weight }) for more).
  const census = new OffchainCensus();
  census.add(voters);

  // 2. Stream the creation. Omitting startDate starts it in the creation block.
  let processId = '';
  for await (const event of sdk.createProcessStream({
    title: 'Favourite colour',
    description: 'Pick one',
    census, // maxVoters defaults to its member count
    electionPreset: { type: 'single_choice' },
    timing: { duration: 8 * 3600 },
    questions: [
      {
        title: 'What is your favourite colour?',
        choices: [
          { title: 'Red', value: 0 },
          { title: 'Blue', value: 1 },
          { title: 'Green', value: 2 },
          { title: 'Yellow', value: 3 },
        ],
      },
    ],
  })) {
    switch (event.status) {
      case TxStatus.Pending:
        console.log('transaction sent:', event.hash);
        break;
      case TxStatus.Completed:
        processId = event.response.processId;
        console.log('created', processId, 'in', event.response.transactionHash);
        break;
      case TxStatus.Failed:
        throw event.error; // refused before anything was mined (see err.revertName)
      case TxStatus.Reverted:
        throw event.error ?? new Error(`reverted: ${event.reason ?? 'unknown'}`);
    }
  }

  // The same, without the stream:
  //   const { processId } = await sdk.createProcess(config);

  const info = await sdk.getProcess(processId);
  console.log(info.phase, 'until', info.endDate.toISOString(), 'metadata', info.metadataStatus);
}

main().then(
  () => process.exit(0),
  err => {
    console.error(err);
    process.exit(1);
  }
);
