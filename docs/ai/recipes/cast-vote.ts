/**
 * recipes/cast-vote.ts
 *
 * Cast a single encrypted vote and wait for it to settle.
 *
 *   - construct a DavinciSDK as the VOTER (their wallet; no provider needed)
 *   - confirm the process is accepting votes
 *   - submitVote with a one-hot choices array
 *   - waitForVoteStatus(Settled)
 *
 * The SDK does all the cryptography (ElGamal encrypt → zk-SNARK proof → sign).
 * You only ever supply `choices`.
 *
 * Usage:
 *   tsx cast-vote.ts <processId>
 */

import { Wallet } from "ethers";
import { DavinciSDK, VoteStatus } from "@vocdoni/davinci-sdk";

const { SEQUENCER_API_URL, CENSUS_API_URL, VOTER_PRIVATE_KEY } = process.env as Record<string, string>;
const processId = process.argv[2];

async function main() {
  if (!processId) throw new Error("usage: tsx cast-vote.ts <processId>");

  // Voter SDK — a bare Wallet is fine; voting never touches the chain directly.
  const voter = new DavinciSDK({
    signer: new Wallet(VOTER_PRIVATE_KEY),
    sequencerUrl: SEQUENCER_API_URL,
    censusUrl: CENSUS_API_URL, // lets the SDK fetch this voter's census proof/weight
  });
  await voter.init();

  const address = await new Wallet(VOTER_PRIVATE_KEY).getAddress();

  // Optional pre-checks (no provider needed).
  if (!(await voter.isAddressAbleToVote(processId, address))) {
    throw new Error(`${address} is not in this process's census`);
  }

  // Wait until the sequencer reports the process is accepting votes.
  for (let i = 0; i < 30; i++) {
    try {
      const p = await voter.api.sequencer.getProcess(processId);
      if (p.isAcceptingVotes) break;
    } catch (e: any) {
      if (e.code !== 40007) throw e; // 40007 = not indexed yet
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }

  // Submit. choices.length MUST equal the process's ballot.numFields.
  // Here: 4 one-hot fields, voting for option 1 ("Blue").
  const result = await voter.submitVote({
    processId,
    choices: [0, 1, 0, 0],
  });
  console.log("Vote submitted:", result.voteId, "status:", result.status);

  // The vote only counts once settled — settlement can take minutes.
  const final = await voter.waitForVoteStatus(
    processId,
    result.voteId,
    VoteStatus.Settled,
    800_000, // generous timeout
    5_000,
  );
  console.log("Final status:", final.status);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
