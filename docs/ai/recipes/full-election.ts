/**
 * recipes/full-election.ts
 *
 * An election end to end, on a configured deployment:
 *
 *   1. the organizer's SDK (a signer with a provider, and an uploader)
 *   2. a census of N fresh voters
 *   3. createProcess: one question, 4 options, the grace window at the floor
 *   4. every voter votes from its own SDK; one of them changes its mind
 *   5. close with notice (closeProcessIn): the nodes flush what they hold
 *   6. wait for the votes to settle, then for the results
 *
 * Every variant (CSP, on-chain census, DKG key, another ballot) is this shape
 * with another census, key mode or preset: see the other recipes.
 *
 * Environment: DAVINCI_NODES, RPC_URL, PRIVATE_KEY, UPLOAD_URL, PUBLIC_URL
 *
 * Usage:
 *   tsx full-election.ts
 */

import {
  BallotProver,
  DavinciSDK,
  OffchainCensus,
  VoteStatus,
  type Uploader,
} from '@vocdoni/davinci-sdk';
import { JsonRpcProvider, Wallet } from 'ethers';

const { RPC_URL, PRIVATE_KEY, UPLOAD_URL, PUBLIC_URL } = process.env as Record<string, string>;
const nodes = (process.env.DAVINCI_NODES ?? '').split(',').filter(Boolean);
const NUM_VOTERS = 3;

// Replace with your own store: the files must be served unchanged over public https.
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
  // 1. The organizer.
  const sdk = new DavinciSDK({
    signer: new Wallet(PRIVATE_KEY, new JsonRpcProvider(RPC_URL)),
    sequencerUrls: nodes,
    uploader,
  });
  await sdk.init();
  const { graceFloor, noticeMin } = await sdk.getGraceParams();

  // 2. The census.
  const voters = Array.from({ length: NUM_VOTERS }, () => Wallet.createRandom());
  const census = new OffchainCensus();
  census.add(voters.map(v => v.address));

  // 3. The election, open for an hour, with the shortest grace window.
  const { processId } = await sdk.createProcess({
    title: `Favourite colour ${new Date().toISOString()}`,
    census,
    electionPreset: { type: 'single_choice' },
    timing: { duration: 3600 },
    grace: graceFloor,
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
  });
  console.log('process', processId);

  // 4. Each voter from its own SDK: a bare wallet is enough. The first votes twice;
  // the revote goes to the node that holds its first ballot, and replaces it.
  const cast: { voter: DavinciSDK; voteId: string }[] = [];
  for (const [i, wallet] of voters.entries()) {
    const voter = new DavinciSDK({ signer: wallet, sequencerUrls: nodes });
    await voter.init();
    const choices = [0, 0, 0, 0];
    choices[i % 4] = 1;
    const vote = await voter.submitVote({ processId, choices });
    console.log(`${wallet.address} -> option ${i % 4} (${vote.voteId} on ${vote.node})`);
    if (i === 0) {
      // The node queues the revote behind the first ballot. If it already holds as many
      // queued ballots for this voter as it keeps, it refuses with VoteError('slot-busy')
      // (40902): retry once an earlier ballot settles, on the same node (pass `node`).
      const revote = await voter.submitVote({ processId, choices: [0, 0, 0, 1], node: vote.node });
      cast.push({ voter, voteId: revote.voteId });
    }
    cast.push({ voter, voteId: vote.voteId });
  }

  // 5. Close with the least notice: the nodes flush every vote they hold during it.
  await sdk.closeProcessIn(processId, noticeMin);

  // 6. Wait for every vote (the default wait follows the process's grace window).
  for (const { voter, voteId } of cast) {
    const final = await voter.waitForVoteStatus(processId, voteId);
    if (final.status === VoteStatus.Error) console.warn(voteId, 'failed:', final.error);
  }
  console.log('votes settled');

  // 7. The results, once the grace window has closed.
  const results = await sdk.waitForResults(processId, {
    onStatus: s => console.log('results:', s.state, 'grace ends', s.graceEnd?.toISOString()),
  });
  console.log(`${results.voters} ballots counted`);
  for (const c of results.questions[0].choices) console.log(`  ${c.title}: ${c.total}`);
}

main()
  .then(() => BallotProver.terminate())
  .then(
    () => process.exit(0),
    err => {
      console.error(err);
      process.exit(1);
    }
  );
