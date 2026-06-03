/**
 * recipes/create-process.ts
 *
 * Create a voting process with a locally-built Merkle census, watching the
 * on-chain transaction in real time.
 *
 *   - build an OffchainCensus (auto-published by createProcess)
 *   - one single-choice question with 4 options, encoded as 4 one-hot fields
 *   - stream TxStatus events so a UI can show progress
 *
 * The organizer signer MUST have a provider (process creation is on-chain).
 *
 * Usage:
 *   tsx create-process.ts
 */

import { JsonRpcProvider, Wallet } from "ethers";
import { DavinciSDK, OffchainCensus, TxStatus } from "@vocdoni/davinci-sdk";

const { SEQUENCER_API_URL, CENSUS_API_URL, RPC_URL, PRIVATE_KEY } = process.env as Record<string, string>;

async function main() {
  const sdk = new DavinciSDK({
    signer: new Wallet(PRIVATE_KEY, new JsonRpcProvider(RPC_URL)),
    sequencerUrl: SEQUENCER_API_URL,
    censusUrl: CENSUS_API_URL, // required to publish the Merkle census
  });
  await sdk.init();

  // 1. Census of eligible voters. Plain addresses → weight 1 each.
  //    (For weighted voting use census.add({ key, weight }).)
  const census = new OffchainCensus();
  census.add([
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
  ]);

  // 2. Process config. One question, 4 options → numFields: 4 (one-hot).
  //    Single-choice: each field 0..1, exactly one selected (maxValueSum "1").
  const config = {
    title: "Favourite colour",
    description: "Pick one",
    census, // auto-published; maxVoters defaults to participant count
    ballot: {
      numFields: 4,
      minValue: "0",
      maxValue: "1",
      uniqueValues: false,
      costExponent: 1,
      minValueSum: "1",
      maxValueSum: "1",
    },
    timing: {
      startDate: new Date(Date.now() + 60 * 1000), // start in ~1 minute
      duration: 3600 * 8, // 8 hours
    },
    questions: [
      {
        title: "What is your favourite colour?",
        choices: [
          { title: "Red", value: 0 },
          { title: "Blue", value: 1 },
          { title: "Green", value: 2 },
          { title: "Yellow", value: 3 },
        ],
      },
    ],
  };

  // 3. Stream the creation so we can react to each on-chain state.
  let processId = "";
  for await (const event of sdk.createProcessStream(config)) {
    switch (event.status) {
      case TxStatus.Pending:
        console.log("Tx submitted:", event.hash);
        break;
      case TxStatus.Completed:
        processId = event.response.processId;
        console.log("Process created:", processId);
        console.log("Tx:", event.response.transactionHash);
        break;
      case TxStatus.Failed:
        throw event.error;
      case TxStatus.Reverted:
        throw new Error(`Reverted: ${event.reason ?? "unknown"}`);
    }
  }

  // Simpler, non-streaming equivalent:
  //   const { processId } = await sdk.createProcess(config);

  console.log("Done. processId =", processId);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
