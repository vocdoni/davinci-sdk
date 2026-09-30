/**
 * recipes/cast-vote.ts
 *
 * Cast one vote as a voter and follow it until it settles:
 *
 *   - a DavinciSDK with the voter's wallet (no provider: it reads the chain
 *     through the network's public RPCs)
 *   - an eligibility check
 *   - submitVote with one value per ballot field
 *   - watchVoteStatus until settled (or error), then a receipt
 *
 * The SDK builds, encrypts, proves and signs the ballot. The first vote
 * downloads the circuit files (about 44 MB) and checks them.
 *
 * Environment: DAVINCI_NODES, VOTER_PRIVATE_KEY
 *
 * Usage:
 *   tsx cast-vote.ts <processId> <choices, e.g. 0,1,0,0>
 */

import { BallotProver, DavinciSDK, VoteError, VoteStatus } from '@vocdoni/davinci-sdk';
import { Wallet } from 'ethers';

const nodes = (process.env.DAVINCI_NODES ?? '').split(',').filter(Boolean);
const [processId, choicesArg] = process.argv.slice(2);

async function main() {
  if (!processId || !choicesArg) throw new Error('usage: tsx cast-vote.ts <processId> <0,1,0,0>');
  const choices = choicesArg.split(',').map(Number);

  const wallet = new Wallet(process.env.VOTER_PRIVATE_KEY!);
  const voter = new DavinciSDK({ signer: wallet, sequencerUrls: nodes });
  await voter.init();

  const weight = await voter.getAddressWeight(processId, wallet.address);
  if (weight === 0n) throw new Error(`${wallet.address} is not in the census`);

  const vote = await voter.submitVote({ processId, choices }).catch((err: unknown) => {
    // err.reason: not-in-census, not-started, closed, invalid, duplicate, slot-busy, busy, ...
    if (err instanceof VoteError) throw new Error(`vote refused (${err.reason}): ${err.message}`);
    throw err;
  });
  console.log(`vote ${vote.voteId} taken by ${vote.node} with weight ${vote.weight}`);
  // Keep vote.node with the vote: a revote from another session passes it back as `node`.

  // Nodes batch votes: settling can take minutes to a quarter of an hour.
  for await (const s of voter.watchVoteStatus(processId, vote.voteId)) {
    console.log(new Date().toISOString(), s.status, s.error ?? '');
    if (s.status === VoteStatus.Error) throw new Error(`vote failed: ${s.error}`);
  }

  const receipt = await voter.getVoteReceipt(processId, vote.voteId);
  console.log('recorded under state root', receipt.root);
}

main()
  .then(() => BallotProver.terminate()) // stop snarkjs's worker threads so Node exits
  .then(
    () => process.exit(0),
    err => {
      console.error(err);
      process.exit(1);
    }
  );
