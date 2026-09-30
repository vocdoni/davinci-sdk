/**
 * recipes/close-early.ts
 *
 * Close a running election the way a live meeting does: "voting closes in
 * one minute", then the results a few minutes later.
 *
 *   - the grace window at the registry's floor (skipped if already there)
 *   - closeProcessIn with the least notice the registry allows: nodes flush
 *     every vote they hold during the notice
 *   - waitForResults, following the grace window
 *
 * Both changes are only possible before the current end, by the organizer.
 * For a new meeting, pass `grace: graceFloor` to createProcess instead.
 *
 * Environment: DAVINCI_NODES, RPC_URL, PRIVATE_KEY
 *
 * Usage:
 *   tsx close-early.ts <processId> [seconds of notice]
 */

import { DavinciSDK, ProcessDurationError } from '@vocdoni/davinci-sdk';
import { JsonRpcProvider, Wallet } from 'ethers';

const nodes = (process.env.DAVINCI_NODES ?? '').split(',').filter(Boolean);
const [processId, noticeArg] = process.argv.slice(2);

async function main() {
  if (!processId) throw new Error('usage: tsx close-early.ts <processId> [seconds]');
  const sdk = new DavinciSDK({
    signer: new Wallet(process.env.PRIVATE_KEY!, new JsonRpcProvider(process.env.RPC_URL)),
    sequencerUrls: nodes,
  });
  await sdk.init();

  const { graceFloor, noticeMin } = await sdk.getGraceParams();
  const info = await sdk.getProcess(processId);
  console.log(`phase ${info.phase}, ends ${info.endDate.toISOString()}, grace ${info.grace} s`);

  if (info.grace !== graceFloor) {
    await sdk.setProcessGrace(processId, graceFloor);
    console.log(`grace set to the floor, ${graceFloor} s`);
  }

  // The new end: the chain head's time + max(notice, noticeMin) + 45 s for the
  // transaction to land (the `slack` option; a few seconds on a local chain).
  const notice = noticeArg ? Number(noticeArg) : noticeMin;
  try {
    const { duration } = await sdk.closeProcessIn(processId, notice);
    const end = new Date(info.startDate.getTime() + Number(duration) * 1000);
    console.log('voting closes at', end.toISOString());
  } catch (err) {
    // InvalidTimeBounds: already ended; InvalidDuration: not earlier than the current end.
    if (err instanceof ProcessDurationError) console.error(err.revertName, err.message);
    throw err;
  }

  const results = await sdk.waitForResults(processId, {
    onStatus: s => console.log(new Date().toISOString(), s.state, s.graceEnd?.toISOString() ?? ''),
  });
  for (const q of results.questions) {
    for (const c of q.choices) console.log(`${c.title ?? c.field}: ${c.total}`);
  }
}

main().then(
  () => process.exit(0),
  err => {
    console.error(err);
    process.exit(1);
  }
);
