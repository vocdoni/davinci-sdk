/**
 * recipes/full-election.ts
 *
 * The complete Davinci flow in one file, condensed from the SDK's own demo:
 *
 *   1. organizer SDK (signer WITH provider)
 *   2. build an OffchainCensus of N random voters
 *   3. createProcess (one 4-option question)
 *   4. wait until the process accepts votes
 *   5. each voter votes from their OWN SDK (signer, no provider)
 *   6. wait for every vote to settle
 *   7. end the process and print the tally
 *
 * This is the spine; every variant (CSP, on-chain, weighted, multi-question)
 * is this shape with a different census and/or ballot mode. See the other
 * recipes and references/ for those.
 *
 * Usage:
 *   tsx full-election.ts
 */

import { JsonRpcProvider, Wallet } from "ethers";
import { DavinciSDK, OffchainCensus, VoteStatus, TxStatus } from "@vocdoni/davinci-sdk";

const { SEQUENCER_API_URL, CENSUS_API_URL, RPC_URL, PRIVATE_KEY } = process.env as Record<string, string>;
const NUM_VOTERS = 3;

function organizerConfig() {
  return {
    signer: new Wallet(PRIVATE_KEY, new JsonRpcProvider(RPC_URL)),
    sequencerUrl: SEQUENCER_API_URL,
    censusUrl: CENSUS_API_URL,
  };
}
function voterConfig(pk: string) {
  // Voting needs no provider — a bare Wallet is enough.
  return { signer: new Wallet(pk), sequencerUrl: SEQUENCER_API_URL, censusUrl: CENSUS_API_URL };
}

async function main() {
  // 1. Organizer
  const sdk = new DavinciSDK(organizerConfig());
  await sdk.init();

  // 2. Census of random voters (weight 1 each)
  const voters = Array.from({ length: NUM_VOTERS }, () => Wallet.createRandom());
  const census = new OffchainCensus();
  census.add(voters.map((v) => v.address));

  // 3. Create the process (single question, 4 one-hot options)
  let processId = "";
  for await (const e of sdk.createProcessStream({
    title: "Favourite colour " + Date.now(),
    description: "Demo election",
    census,
    ballot: {
      numFields: 4, minValue: "0", maxValue: "1",
      uniqueValues: false, costExponent: 1, minValueSum: "1", maxValueSum: "1",
    },
    timing: { startDate: new Date(Date.now() + 60_000), duration: 3600 * 8 },
    questions: [{
      title: "What is your favourite colour?",
      choices: [
        { title: "Red", value: 0 }, { title: "Blue", value: 1 },
        { title: "Green", value: 2 }, { title: "Yellow", value: 3 },
      ],
    }],
  })) {
    if (e.status === TxStatus.Completed) processId = e.response.processId;
    else if (e.status === TxStatus.Failed) throw e.error;
    else if (e.status === TxStatus.Reverted) throw new Error(`reverted: ${e.reason}`);
  }
  console.log("processId:", processId);

  // 4. Wait until the sequencer reports the process is accepting votes
  await new Promise((r) => setTimeout(r, 10_000));
  for (let i = 0; i < 30; i++) {
    try {
      if ((await sdk.api.sequencer.getProcess(processId)).isAcceptingVotes) break;
    } catch (e: any) {
      if (e.code !== 40007) throw e; // not indexed yet
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log("accepting votes");

  // 5. Each voter votes from their own SDK. Random one-hot choice.
  const voteIds: string[] = [];
  for (const v of voters) {
    const voterSdk = new DavinciSDK(voterConfig(v.privateKey));
    await voterSdk.init();
    const choice = Math.floor(Math.random() * 4);
    const choices = [0, 0, 0, 0];
    choices[choice] = 1;
    const { voteId } = await voterSdk.submitVote({ processId, choices });
    voteIds.push(voteId);
    console.log(`voter ${v.address} → option ${choice}, voteId ${voteId}`);
  }

  // 6. Wait for all votes to settle (settlement can take minutes)
  await Promise.all(
    voteIds.map((voteId) =>
      sdk.waitForVoteStatus(processId, voteId, VoteStatus.Settled, 800_000, 5_000),
    ),
  );
  console.log("all votes settled");

  // 7. End the process and read the tally
  await sdk.endProcess(processId);
  await new Promise<void>((resolve) =>
    sdk.processes.onProcessResultsSet((id) => {
      if (id.toLowerCase() === processId.toLowerCase()) resolve();
    }),
  );
  const info = await sdk.getProcess(processId);
  console.log("\nResults:");
  info.questions[0].choices.forEach((c, i) =>
    console.log(`  ${c.title}: ${info.result[i]?.toString() ?? "0"}`),
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
