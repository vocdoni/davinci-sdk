/**
 * recipes/read-results.ts
 *
 * Wait for a process's results and print them per question:
 *
 *   - getResultsStatus: where the process stands (voting, grace, awaiting the
 *     key holder, the DKG committee's states, locked, results, canceled)
 *   - waitForResults: polls the chain until the tally is on it, and decodes it
 *     with the verified metadata's titles
 *
 * Results come after the end and the grace window, from the key holder: the
 * key node (sequencer key) within a couple of minutes, or the DKG committee
 * within a few more. Reading needs no provider: a bare wallet is enough.
 *
 * Environment: DAVINCI_NODES
 *
 * Usage:
 *   tsx read-results.ts <processId>
 */

import { DavinciSDK, ResultsError } from '@vocdoni/davinci-sdk';
import { Wallet } from 'ethers';

const nodes = (process.env.DAVINCI_NODES ?? '').split(',').filter(Boolean);
const processId = process.argv[2];

async function main() {
  if (!processId) throw new Error('usage: tsx read-results.ts <processId>');
  const sdk = new DavinciSDK({ signer: Wallet.createRandom(), sequencerUrls: nodes });
  await sdk.init();

  const status = await sdk.getResultsStatus(processId);
  console.log(`state ${status.state}, grace window closes ${status.graceEnd?.toISOString()}`);

  try {
    const results = await sdk.waitForResults(processId, {
      onStatus: s => console.log(new Date().toISOString(), s.state),
    });
    console.log(`${results.kind} ballot, ${results.voters} ballots counted`);
    for (const [q, question] of results.questions.entries()) {
      console.log(question.title ?? `question ${q + 1}`);
      for (const c of question.choices) {
        const mean = c.mean === null ? '' : ` (mean ${c.mean.toFixed(2)})`;
        console.log(`  ${c.title ?? `field ${c.field}`}: ${c.total}${mean}`);
      }
    }
  } catch (err) {
    if (err instanceof ResultsError && err.reason === 'locked') {
      console.log('the organizer has not revealed the DKG-locked key yet (revealProcessKey)');
      return;
    }
    throw err; // ResultsError canceled or timeout: its message says what was missing
  }
}

main().then(
  () => process.exit(0),
  err => {
    console.error(err);
    process.exit(1);
  }
);
