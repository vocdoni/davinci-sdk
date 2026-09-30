/**
 * @fileoverview Scenario 8: organizer changes the registry refuses, each as an
 * `eth_call` through the SDK's raw registry service (nothing is sent): ending
 * before the start, a grace outside the bounds, shortening inside the
 * notice, and pausing or changing max voters after the end. The process
 * starts two minutes after its creation and lasts two minutes; it is then
 * canceled, and reads as such.
 */

import { expect } from 'vitest';
import { ProcessStatus } from '../../../src/contracts/types';
import { ResultsError } from '../../../src/core/vote/errors';
import { say } from '../env';
import type { Row } from '../report';
import { S8, plainCensus } from '../spec';
import type { Live } from './context';
import { createElection, until } from './flow';
import { callOnly, refusedByCall } from './negatives';

/** Seconds from the creation's turn to the start, and the duration. */
const START_IN = 120;
const DURATION = 120;

export async function s8(live: Live, row: Row): Promise<void> {
  const { sdk } = live;
  const e = await createElection(
    live,
    's8',
    S8,
    // No votes to settle: the registry's default grace is fine.
    { census: plainCensus(live.voters.s8), grace: undefined },
    async () => ({
      startDate: Number(await sdk.registry.getChainTime()) + START_IN,
      duration: DURATION,
    })
  );
  row.processId = e.processId;
  const pid = e.processId;
  const p = await sdk.registry.getProcess(pid);
  const start = p.startTime;
  const end = p.startTime + p.duration;
  const head = await sdk.registry.getChainTime();
  expect(head).toBeLessThan(start);
  say(`s8: starts in ${start - head} s, ends at ${new Date(Number(end) * 1000).toISOString()}`);

  const raw = callOnly(live);
  const { graceFloor, graceCeil, noticeMin } = live.grace;
  const ended = await refusedByCall('s8 end before the start', () =>
    raw.setProcessStatus(pid, ProcessStatus.ENDED)
  );
  expect(ended.revertName).toBe('InvalidTimeBounds');
  for (const grace of [graceFloor - 1, graceCeil + 1]) {
    const refused = await refusedByCall(`s8 grace ${grace}`, () => raw.setProcessGrace(pid, grace));
    expect(refused.revertName).toBe('InvalidGrace');
  }

  // Once open: an earlier end closer than the notice.
  const chainTime = () => sdk.registry.getChainTime();
  await until('s8: started', async () => (await chainTime()) >= start + 5n, 10 * 60_000);
  const now = await chainTime();
  const inside = now + BigInt(Math.floor(noticeMin / 2)) - start;
  expect(start + inside).toBeLessThan(end);
  const shortened = await refusedByCall('s8 shorten inside the notice', () =>
    raw.setProcessDuration(pid, inside)
  );
  expect(shortened.revertName).toBe('InvalidDuration');

  // Past the end.
  await until('s8: ended', async () => (await chainTime()) >= end + 5n, 10 * 60_000);
  const paused = await refusedByCall('s8 pause after the end', () =>
    raw.setProcessStatus(pid, ProcessStatus.PAUSED)
  );
  expect(paused.revertName).toBe('InvalidTimeBounds');
  const capped = await refusedByCall('s8 max voters after the end', () =>
    raw.setProcessMaxVoters(pid, 5)
  );
  expect(capped.revertName).toBe('InvalidTimeBounds');

  // Canceling works at any time before the results.
  await live.org.send('s8 cancel', () => sdk.cancelProcessStream(pid));
  const info = await sdk.getProcess(pid);
  expect(info.status).toBe(ProcessStatus.CANCELED);
  expect(info.phase).toBe('canceled');
  expect((await sdk.getResultsStatus(pid)).state).toBe('canceled');
  const waited = await sdk.waitForResults(pid).then(
    () => null,
    (err: unknown) => err
  );
  expect(waited).toBeInstanceOf(ResultsError);
  expect(waited).toMatchObject({ reason: 'canceled' });
  row.voters = 0;
}
