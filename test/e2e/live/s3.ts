/**
 * @fileoverview Scenario 3: an updatable Merkle census (origin 2). Four
 * members; three vote, then the organizer publishes a census of six that
 * drops the member whose ballot is still pending and adds three. The nodes
 * reload it in the background, the new members vote, and the dropped
 * member's ballot fails with `census changed, recast`.
 */

import { expect } from 'vitest';
import type { Row } from '../report';
import { say } from '../env';
import { S3, S3_AFTER, S3_BEFORE, S3_FIRST, S3_UPDATED, s3Census, tally } from '../spec';
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

export async function s3(live: Live, row: Row): Promise<void> {
  const voters = live.voters.s3;
  const census = s3Census(live.voters);
  const e = await createElection(live, 's3', S3, { census, maxVoters: 10 });
  row.processId = e.processId;
  await waitServed(
    live,
    e,
    S3_FIRST.map(i => voters[i].address)
  );

  const sdkOf = voterSdks(live, voters);
  const before: Cast[] = [];
  for (const b of S3_BEFORE) {
    before.push(
      await vote(await sdkOf(b.voter), `s3 voter ${b.voter}`, {
        processId: e.processId,
        choices: b.choices,
      })
    );
  }

  // Drop member 3 (its ballot is pending) and add 4, 5 and 6.
  const dropped = voters[3].address;
  census.remove(dropped);
  census.add(S3_UPDATED.filter(i => !S3_FIRST.includes(i)).map(i => voters[i].address));
  expect(census.addresses).toEqual(S3_UPDATED.map(i => voters[i].address.toLowerCase()));
  await live.org.send('s3 updateCensus', () => live.sdk.updateCensusStream(e.processId, census));
  const root = BigInt((await live.sdk.registry.getProcess(e.processId)).census.root);
  expect(root).toBe(BigInt(await census.root()));
  await waitServed(
    live,
    e,
    S3_AFTER.map(b => voters[b.voter].address),
    root
  );
  say('s3: every node loaded the updated census');
  expect(await live.sdk.getAddressWeight(e.processId, dropped)).toBe(0n);
  expect(await live.sdk.isAddressAbleToVote(e.processId, voters[4].address)).toBe(true);

  const after: Cast[] = [];
  for (const b of S3_AFTER) {
    after.push(
      await vote(await sdkOf(b.voter), `s3 voter ${b.voter}`, {
        processId: e.processId,
        choices: b.choices,
      })
    );
  }

  await closeSoon(live, e);
  const results = watchResults(live, e);
  const followed = await follow(live, e, [...before, ...after]);
  const settled: Cast[] = [];
  for (const f of followed) {
    if (f.cast.voterAddress === voters[3].address) {
      expect(f.statuses.at(-1), 'the dropped member').toBe('error');
      expect(f.error).toMatch(/census changed/);
    } else {
      expect(f.statuses.at(-1), f.cast.label).toBe('settled');
      settled.push(f.cast);
    }
  }
  await checkReceipts(live, e, settled);

  const counted = [...S3_BEFORE.filter(b => b.voter !== 3), ...S3_AFTER];
  await checkResults(live, e, await results.done, results.states, {
    tally: tally(counted),
    voters: counted.length,
  });
  row.voters = counted.length;
}
