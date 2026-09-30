/**
 * A whole election on a configured DAVINCI deployment:
 *
 *   1. connect the organizer and report the deployment
 *   2. a census of fresh voters: a Merkle census file, or a CSP's attestations
 *   3. create the process (single choice, grace window at the floor)
 *   4. every voter votes from its own SDK; the first one changes its mind
 *   5. close with notice: the nodes flush the votes they hold
 *   6. follow the votes to `settled`, and get their receipts
 *   7. wait for the results (revealing a DKG-locked key first)
 *
 * Settings in `.env` (see `.env.example`): the nodes, the RPC, the organizer's
 * key and the hosting, plus CENSUS (merkle | csp), KEY_MODE (sequencer | dkg |
 * dkg-locked) and VOTERS.
 */

import {
  BallotProver,
  CspSigner,
  OffchainCensus,
  VoteStatus,
  type Census,
  type CensusProviders,
  type DavinciSDK,
  type ProcessKeyMode,
} from '@vocdoni/davinci-sdk';
import { Wallet } from 'ethers';
import { connect, info, organizerSigner, step, uploader, voteWhenReady } from './config';

const CENSUS = process.env.CENSUS === 'csp' ? 'csp' : 'merkle';
const KEY_MODE = (process.env.KEY_MODE ?? 'sequencer') as ProcessKeyMode;
const VOTERS = Number(process.env.VOTERS ?? '3');
const OPTIONS = ['Red', 'Blue', 'Green', 'Yellow'];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  step(1, 'Connect the organizer');
  const organizer = await connect(organizerSigner(), { uploader: uploader() });
  const { name, chainId, processRegistry } = organizer.network;
  info(`${name} (chain ${chainId}), registry ${processRegistry}`);
  for (const n of organizer.nodeChecks) info(`node ${n.url}: ${n.status} ${n.reason ?? ''}`);
  const { graceFloor, noticeMin } = await organizer.getGraceParams();

  step(2, `A ${CENSUS} census of ${VOTERS} voters`);
  const voters = Array.from({ length: VOTERS }, () => Wallet.createRandom());
  let census: Census;
  let censusProviders: CensusProviders = {};
  if (CENSUS === 'csp') {
    // The CSP signs each voter's attestation; its address is the census root.
    const key = process.env.CSP_PRIVATE_KEY;
    const csp = new CspSigner(key ? new Wallet(key) : Wallet.createRandom());
    census = await csp.census('https://csp.example.org'); // where voters would ask
    // A real CSP authenticates the voter first; here the voters are ours.
    censusProviders = { csp: ({ processId, address }) => csp.attest({ processId, address }) };
    info('CSP', await csp.address());
  } else {
    const merkle = new OffchainCensus();
    merkle.add(voters.map(v => v.address));
    census = merkle; // published by createProcess through the uploader
  }

  step(3, `Create the process (key mode ${KEY_MODE})`);
  const created = await organizer.createProcess({
    title: `Favourite colour, ${new Date().toISOString()}`,
    description: 'A DAVINCI SDK example election.',
    census,
    maxVoters: VOTERS,
    electionPreset: { type: 'single_choice' },
    timing: { duration: 3600 },
    grace: graceFloor,
    keyMode: KEY_MODE,
    questions: [
      {
        title: 'What is your favourite colour?',
        choices: OPTIONS.map((title, value) => ({ title, value })),
      },
    ],
  });
  const { processId, organizerSecret } = created;
  info('process', processId, 'in', created.transactionHash);
  if (created.graceError) info('grace not set:', created.graceError.message);
  if (organizerSecret !== undefined) {
    // A real organizer stores it now: without it the results never unlock.
    info('organizer secret received (not printed)');
  }

  step(4, 'Vote');
  const votes: { sdk: DavinciSDK; voteId: string; node: string }[] = [];
  for (const [i, wallet] of voters.entries()) {
    const sdk = await connect(wallet, { censusProviders });
    const choices = OPTIONS.map((_, j) => (j === i % OPTIONS.length ? 1 : 0));
    const vote = await voteWhenReady(sdk, { processId, choices });
    info(`${wallet.address} votes ${OPTIONS[i % OPTIONS.length]}: ${vote.voteId} on ${vote.node}`);
    votes.push({ sdk, voteId: vote.voteId, node: vote.node });
    if (i === 0) {
      // A revote goes to the node holding the first ballot, so it settles after it. If
      // that node already holds as many queued ballots for this voter as it keeps, it
      // refuses with VoteError('slot-busy') (40902): retry once an earlier ballot
      // settles, on the same node (pass `node`).
      const revote = await sdk.submitVote({ processId, choices: [0, 0, 0, 1], node: vote.node });
      info(`${wallet.address} changes to Yellow: ${revote.voteId}`);
      votes.push({ sdk, voteId: revote.voteId, node: revote.node });
    }
  }

  step(5, `Close in ${noticeMin} s: the nodes flush every vote they hold during the notice`);
  await organizer.closeProcessIn(processId, noticeMin);

  step(6, 'Follow the votes to settled, and their receipts');
  for (const { sdk, voteId, node } of votes) {
    const final = await sdk.waitForVoteStatus(processId, voteId);
    if (final.status !== VoteStatus.Settled) {
      info(voteId, final.status, final.error ?? '');
      continue;
    }
    const receipt = await sdk.getVoteReceipt(processId, voteId, node);
    info(voteId, 'settled, recorded under', receipt.root);
  }

  step(7, 'Results, after the grace window');
  if (organizerSecret !== undefined) {
    // Reveal once voting has ended: before, it would drop the process to the 'dkg' trust model.
    const end = (await organizer.getProcess(processId)).endDate.getTime() / 1000;
    while (Number(await organizer.registry.getChainTime()) < end) await sleep(15_000);
    await organizer.revealProcessKey(processId, organizerSecret);
    info('organizer key revealed');
  }
  const results = await organizer.waitForResults(processId, {
    onStatus: s => info(new Date().toISOString(), s.state, 'grace ends', s.graceEnd?.toISOString()),
  });
  info(`${results.voters} ballots counted (${results.kind})`);
  for (const c of results.questions[0].choices) info(`${c.title}: ${c.total}`);
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
