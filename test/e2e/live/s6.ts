/**
 * @fileoverview Scenario 6: a locked DKG key (`'dkg-locked'`): the committee's
 * pool key plus an organizer key whose secret only the creation returns. Two
 * voters rank three candidates. After the grace window the results stay
 * locked, even once a sequencer has requested the decryption; a wrong secret
 * is refused (`InvalidOrganizerSecret`, as an `eth_call`, nothing sent); the
 * right one unlocks the tally.
 */

import { expect } from 'vitest';
import { KeyMode, ProcessStatus } from '../../../src/contracts/types';
import { ResultsError } from '../../../src/core/vote/errors';
import { BJJ_SUBGROUP_ORDER } from '../../../src/crypto/babyjubjub';
import type { ResultsState } from '../../../src/core/vote/results';
import { callOnly, refusedByCall } from './negatives';
import { say } from '../env';
import type { Row } from '../report';
import { S6, S6_BALLOTS, plainCensus, tally } from '../spec';
import type { Live } from './context';
import {
  checkReceipts,
  checkResults,
  closeSoon,
  createElection,
  follow,
  sleep,
  until,
  vote,
  voterSdks,
  waitServed,
  type Cast,
} from './flow';

/** How long the run watches a requested, still sealed decryption before revealing. */
const SEALED_HOLD_MS = 60_000;

export async function s6(live: Live, row: Row): Promise<void> {
  const voters = live.voters.s6;
  const e = await createElection(live, 's6', S6, {
    census: plainCensus(voters),
    keyMode: 'dkg-locked',
  });
  row.processId = e.processId;
  const secret = e.organizerSecret;
  if (secret === undefined) throw new Error('a dkg-locked creation returned no organizer secret');
  const p = await live.sdk.registry.getProcess(e.processId);
  expect(p.keyMode).toBe(KeyMode.DkgLocked);
  expect(p.dkg?.locked).toBe(true);
  await waitServed(
    live,
    e,
    voters.map(w => w.address)
  );

  const sdkOf = voterSdks(live, voters);
  const casts: Cast[] = [];
  for (const b of S6_BALLOTS) {
    casts.push(
      await vote(await sdkOf(b.voter), `s6 voter ${b.voter}`, {
        processId: e.processId,
        choices: b.choices,
      })
    );
  }

  await closeSoon(live, e);
  const states: ResultsState[] = [];
  const onStatus = (s: { state: ResultsState }) => {
    states.push(s.state);
    say(`s6: ${s.state}`);
  };
  const locked = live.sdk.waitForResults(e.processId, { pollIntervalMs: 10_000, onStatus }).then(
    () => null,
    (err: unknown) => err
  );
  const followed = await follow(live, e, casts);
  for (const f of followed) expect(f.statuses.at(-1), f.cast.label).toBe('settled');
  await checkReceipts(live, e, casts);

  // Past the grace window the results are locked.
  const err = await locked;
  expect(err).toBeInstanceOf(ResultsError);
  expect(err).toMatchObject({ reason: 'locked' });

  // A sequencer requests the decryption anyway; the committee waits for the secret.
  await until(
    's6: decryption requested',
    async () => (await live.sdk.registry.getProcess(e.processId)).dkg?.resultsRequested === true,
    15 * 60_000,
    10_000
  );
  say(`s6: decryption requested; holding ${SEALED_HOLD_MS / 1000} s before the reveal`);
  await sleep(SEALED_HOLD_MS);
  const sealed = await live.sdk.getResultsStatus(e.processId);
  expect(sealed.state).toBe('locked');
  const before = await live.sdk.registry.getProcess(e.processId);
  expect(before.status).not.toBe(ProcessStatus.RESULTS);
  const dkg = before.dkg;
  if (!dkg) throw new Error('s6: the process has no DKG record');
  expect(await live.sdk.registry.isProcessKeyRevealed(dkg)).toBe(false);

  // A wrong secret (another scalar in [1, L)): refused by the simulation.
  const wrong = (secret % (BJJ_SUBGROUP_ORDER - 1n)) + 1n;
  expect(wrong).not.toBe(secret);
  const refused = await refusedByCall('s6 wrong secret', () =>
    callOnly(live).revealProcessKey(e.processId, wrong)
  );
  expect(refused.revertName).toBe('InvalidOrganizerSecret');

  await live.org.send('s6 revealProcessKey', () =>
    live.sdk.revealProcessKeyStream(e.processId, secret)
  );
  expect(await live.sdk.registry.isProcessKeyRevealed(dkg)).toBe(true);
  say('s6: revealed');

  // The states seen before the reveal (up to `locked`), then the ones after it.
  const final = await live.sdk.waitForResults(e.processId, { pollIntervalMs: 10_000, onStatus });
  expect(final.kind).toBe('ranking');
  expect(states).toContain('locked');
  await checkResults(live, e, final, states, {
    tally: tally(S6_BALLOTS),
    voters: S6_BALLOTS.length,
  });
  row.voters = S6_BALLOTS.length;
}
