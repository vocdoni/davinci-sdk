/**
 * recipes/read-results.ts
 *
 * End a process and read its final tally.
 *
 *   - (optionally) wait until all expected votes are counted on-chain
 *   - endProcess (triggers tally decryption + on-chain results)
 *   - await the ProcessResultsSet contract event
 *   - print result[] mapped back to the question's options
 *
 * Needs an organizer signer WITH a provider (reading the contract + ending the
 * process are on-chain operations).
 *
 * Usage:
 *   tsx read-results.ts <processId> [expectedVoteCount]
 */

import { JsonRpcProvider, Wallet } from "ethers";
import { DavinciSDK, TxStatus } from "@vocdoni/davinci-sdk";

const { SEQUENCER_API_URL, CENSUS_API_URL, RPC_URL, PRIVATE_KEY } = process.env as Record<string, string>;
const processId = process.argv[2];
const expected = process.argv[3] ? Number(process.argv[3]) : undefined;

async function main() {
  if (!processId) throw new Error("usage: tsx read-results.ts <processId> [expectedVoteCount]");

  const sdk = new DavinciSDK({
    signer: new Wallet(PRIVATE_KEY, new JsonRpcProvider(RPC_URL)),
    sequencerUrl: SEQUENCER_API_URL,
    censusUrl: CENSUS_API_URL,
  });
  await sdk.init();

  // 1. Optionally wait for the on-chain vote count to reach the expected number.
  if (expected !== undefined) {
    while (true) {
      const info = await sdk.getProcess(processId);
      if (Number(info.votersCount) >= expected) break;
      console.log(`counted ${info.votersCount}/${expected}…`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  // 2. End the process (stops voting; triggers tally). Stream the tx.
  for await (const event of sdk.endProcessStream(processId)) {
    if (event.status === TxStatus.Completed) console.log("Process ended");
    else if (event.status === TxStatus.Failed) throw event.error;
    else if (event.status === TxStatus.Reverted) throw new Error(`Reverted: ${event.reason}`);
  }

  // 3. Wait for results to be set on-chain (escape-hatch contract event).
  await new Promise<void>((resolve) => {
    sdk.processes.onProcessResultsSet((id, _sender, _result) => {
      if (id.toLowerCase() === processId.toLowerCase()) resolve();
    });
  });

  // 4. Read and display the tally. result[] is one bigint per ballot field.
  const info = await sdk.getProcess(processId);
  console.log(`\nResults for: ${info.title}`);
  info.questions[0].choices.forEach((choice, i) => {
    console.log(`  ${choice.title}: ${info.result[i]?.toString() ?? "0"}`);
  });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
