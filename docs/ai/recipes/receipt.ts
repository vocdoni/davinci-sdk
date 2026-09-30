/**
 * recipes/receipt.ts
 *
 * A vote's receipt: proof that its vote id is in the process's state, checked
 * against the registry rather than against the node that gave it.
 *
 *   - getVoteReceipt asks the nodes for the tracker proof (the node that took
 *     the vote first) and checks it against the registry's latest state root,
 *     or a root of one of the process's transitions
 *   - verifyTrackerProof re-checks it by hand against the chain
 *
 * A receipt shows the vote was recorded, not what it says; a later revote
 * replaces it in the tally.
 *
 * Environment: DAVINCI_NODES
 *
 * Usage:
 *   tsx receipt.ts <processId> <voteId> [node that took the vote]
 */

import { DavinciSDK, VoteReceiptError, verifyTrackerProof } from '@vocdoni/davinci-sdk';
import { Wallet } from 'ethers';

const nodes = (process.env.DAVINCI_NODES ?? '').split(',').filter(Boolean);
const [processId, voteId, node] = process.argv.slice(2);

async function main() {
  if (!processId || !voteId) throw new Error('usage: tsx receipt.ts <processId> <voteId> [node]');
  const sdk = new DavinciSDK({ signer: Wallet.createRandom(), sequencerUrls: nodes });
  await sdk.init();

  const { status, error } = await sdk.getVoteStatus(processId, voteId, node);
  console.log('status', status, error ?? '');

  try {
    const receipt = await sdk.getVoteReceipt(processId, voteId, node);
    console.log(
      `vote ${receipt.voteId} is under state root ${receipt.root} (node ${receipt.node})`
    );
    if (receipt.latest) {
      const onchain = await sdk.registry.getProcess(processId);
      // False only if another batch landed since: the proof then names an earlier root.
      console.log('re-checked:', verifyTrackerProof(receipt.proof, onchain.latestStateRoot));
    } else {
      console.log(`set by transition ${receipt.transactionHash} in block ${receipt.blockNumber}`);
    }
  } catch (err) {
    if (err instanceof VoteReceiptError) {
      console.log('no receipt yet:', err.message); // not settled on any node
      return;
    }
    throw err;
  }
}

main().then(
  () => process.exit(0),
  err => {
    console.error(err);
    process.exit(1);
  }
);
