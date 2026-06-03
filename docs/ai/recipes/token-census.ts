/**
 * recipes/token-census.ts
 *
 * Create a process whose electorate is an on-chain token / contract census
 * (e.g. ERC20 / ERC721 holders), via OnchainCensus.
 *
 * Unlike a Merkle census, an OnchainCensus is NOT published — it points at an
 * existing contract plus an indexer/subgraph URI the sequencer reads holders
 * from. Because of that:
 *   - maxVoters is REQUIRED at process creation
 *   - after creation, the sequencer needs a moment to import voter weights;
 *     poll getAddressWeight until your voters appear
 *
 * This recipe assumes the token/census contract and its indexer already exist.
 * (Standing up the indexer for a freshly deployed contract is environment-
 * specific — see the SDK's examples/script/src/onchain.ts.)
 *
 * Usage:
 *   tsx token-census.ts
 */

import { JsonRpcProvider, Wallet } from "ethers";
import { DavinciSDK, OnchainCensus, TxStatus } from "@vocdoni/davinci-sdk";

const { SEQUENCER_API_URL, CENSUS_API_URL, RPC_URL, PRIVATE_KEY } = process.env as Record<string, string>;

// The token/census contract and the indexer endpoint that serves its holders.
const TOKEN_CONTRACT = process.env.TOKEN_CONTRACT!; // 0x… ERC20/721 or census contract
// Indexer URI. OnchainCensus accepts a graphql:// or https:// endpoint the
// sequencer queries for membership/weights, e.g.:
//   graphql://indexer.example/<chainId>/<contractAddress>/graphql
const CENSUS_URI = process.env.ONCHAIN_CENSUS_URI!;
const MAX_VOTERS = Number(process.env.ONCHAIN_MAX_VOTERS ?? "10000");

async function main() {
  const sdk = new DavinciSDK({
    signer: new Wallet(PRIVATE_KEY, new JsonRpcProvider(RPC_URL)),
    sequencerUrl: SEQUENCER_API_URL,
    censusUrl: CENSUS_API_URL,
  });
  await sdk.init();

  // 1. On-chain census — references existing chain data; nothing to publish.
  const census = new OnchainCensus(TOKEN_CONTRACT, CENSUS_URI);

  // 2. Create the process. maxVoters is REQUIRED for on-chain censuses.
  const { processId } = await sdk.createProcess({
    title: "Token-holder governance",
    description: "One question, weighted by token balance",
    census,
    maxVoters: MAX_VOTERS, // REQUIRED
    ballot: {
      numFields: 4, // 4 one-hot options
      minValue: "0",
      // headroom for weighted voting: a holder puts their weight in the chosen field
      maxValue: "1000000",
      uniqueValues: false,
      costExponent: 1,
      minValueSum: "0",
      maxValueSum: "1000000",
    },
    timing: { startDate: new Date(Date.now() + 60_000), duration: 3600 * 24 },
    questions: [
      {
        title: "Which proposal?",
        choices: [
          { title: "A", value: 0 },
          { title: "B", value: 1 },
          { title: "C", value: 2 },
          { title: "D", value: 3 },
        ],
      },
    ],
  });
  console.log("Process created:", processId);

  // 3. Wait for the process to accept votes AND for the sequencer to import
  //    on-chain weights (token censuses are imported asynchronously).
  for (let i = 0; i < 60; i++) {
    try {
      const p = await sdk.api.sequencer.getProcess(processId);
      if (p.isAcceptingVotes) {
        console.log("Process is accepting votes");
        break;
      }
    } catch (e: any) {
      if (e.code !== 40007) throw e;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }

  // Example: check a specific holder's imported weight before they vote.
  const holder = process.env.HOLDER_ADDRESS;
  if (holder) {
    const weight = await sdk.getAddressWeight(processId, holder);
    console.log(`${holder} weight = ${weight}`); // "0" until imported / if not a holder
  }

  // Voters then vote exactly as in cast-vote.ts. For weighted voting, put the
  // voter's weight (from getAddressWeight) into the chosen one-hot field:
  //   const w = Number(await voter.getAddressWeight(processId, addr));
  //   await voter.submitVote({ processId, choices: [0, w, 0, 0] }); // weight on option 1
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
