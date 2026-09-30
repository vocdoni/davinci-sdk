/**
 * @fileoverview Scenario 5: a DKG key (`'dkg'`, DKG_AUTOMATIC). The key is
 * the live committee's next pool key; no node is asked for one. Two voters
 * spend a quadratic budget; after the grace window a sequencer requests the
 * decryption, the committee decrypts and the tally is stored.
 */

import { expect } from 'vitest';
import { KeyMode } from '../../../src/contracts/types';
import { isValidEncryptionKey } from '../../../src/crypto/babyjubjub';
import type { Row } from '../report';
import { S5, S5_BALLOTS, plainCensus, tally } from '../spec';
import type { Live } from './context';
import {
  checkReceipts,
  checkResults,
  closeSoon,
  createElection,
  follow,
  vote,
  voterSdks,
  waitServed,
  watchResults,
  type Cast,
} from './flow';

export async function s5(live: Live, row: Row): Promise<void> {
  const voters = live.voters.s5;
  const e = await createElection(live, 's5', S5, { census: plainCensus(voters), keyMode: 'dkg' });
  row.processId = e.processId;
  const p = await live.sdk.registry.getProcess(e.processId);
  expect(p.keyMode).toBe(KeyMode.DkgAutomatic);
  expect(p.dkg).toMatchObject({ locked: false, resultsRequested: false });
  expect(isValidEncryptionKey(p.encryptionKey)).toBe(true);
  await waitServed(
    live,
    e,
    voters.map(w => w.address)
  );

  const sdkOf = voterSdks(live, voters);
  const casts: Cast[] = [];
  for (const b of S5_BALLOTS) {
    casts.push(
      await vote(await sdkOf(b.voter), `s5 voter ${b.voter}`, {
        processId: e.processId,
        choices: b.choices,
      })
    );
  }

  await closeSoon(live, e);
  const results = watchResults(live, e);
  const followed = await follow(live, e, casts);
  for (const f of followed) expect(f.statuses.at(-1), f.cast.label).toBe('settled');
  await checkReceipts(live, e, casts);

  const final = await results.done;
  expect(final.kind).toBe('quadratic');
  await checkResults(live, e, final, results.states, {
    tally: tally(S5_BALLOTS),
    voters: S5_BALLOTS.length,
  });
  const after = await live.sdk.registry.getProcess(e.processId);
  expect(after.dkg?.resultsRequested).toBe(true);
  row.voters = S5_BALLOTS.length;
}
