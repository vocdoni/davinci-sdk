/**
 * @fileoverview Scenario 7: metadata. The creation commits the sha256 of the
 * document it publishes, and readers verify it. Before the end the organizer
 * points the process at a tampered copy registered under the update's hash
 * (readers must refuse it: `metadataVerified` false), then at the update
 * itself. The results come back titled from the verified update.
 */

import { expect } from 'vitest';
import { say } from '../env';
import type { Row } from '../report';
import {
  S7,
  S7_BALLOTS,
  S7_UPDATE,
  fileHash,
  metadataBytes,
  metadataOf,
  plainCensus,
  tally,
} from '../spec';
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
  type Election,
} from './flow';

/**
 * The metadata of `e`, created from `S7`: verified as created, refused as a
 * tampered copy, then verified again at the update.
 */
export async function changeMetadata(live: Live, e: Election): Promise<void> {
  // The hash round trip: what the creation published is what readers verify.
  const original = await live.sdk.getProcess(e.processId);
  expect(original.metadataURI).toBe(live.host.url('s7-metadata.json'));
  expect(original.metadataHash).toBe(fileHash(metadataBytes(metadataOf(S7))));
  expect(original).toMatchObject({
    metadataVerified: true,
    metadataStatus: 'verified',
    title: S7.title,
  });

  // A tampered copy under the update's hash.
  const updateHash = fileHash(metadataBytes(S7_UPDATE));
  await live.org.send('s7 setProcessMetadata (tampered copy)', () =>
    live.sdk.updateMetadataStream(e.processId, {
      uri: live.host.url('s7-metadata-mismatch.json'),
      hash: updateHash,
    })
  );
  const tampered = await live.sdk.getProcess(e.processId);
  expect(tampered).toMatchObject({
    metadataHash: updateHash,
    metadataVerified: false,
    metadataStatus: 'mismatch',
  });
  expect(tampered.metadata).toBeUndefined();
  say('s7: the tampered copy reads as a mismatch');

  // The update itself.
  await live.org.send('s7 setProcessMetadata', () =>
    live.sdk.updateMetadataStream(e.processId, S7_UPDATE)
  );
  const updated = await live.sdk.getProcess(e.processId);
  expect(updated).toMatchObject({
    metadataURI: live.host.url('s7-metadata-update.json'),
    metadataHash: updateHash,
    metadataVerified: true,
    title: S7_UPDATE.title,
  });
}

export async function s7(live: Live, row: Row): Promise<void> {
  const voters = live.voters.s7;
  const e = await createElection(live, 's7', S7, { census: plainCensus(voters) });
  row.processId = e.processId;
  await changeMetadata(live, e);

  await waitServed(
    live,
    e,
    voters.map(w => w.address)
  );
  const sdkOf = voterSdks(live, voters);
  const casts: Cast[] = [];
  for (const b of S7_BALLOTS) {
    casts.push(
      await vote(await sdkOf(b.voter), `s7 voter ${b.voter}`, {
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
  expect(final.kind).toBe('multiple_choice');
  const question = S7_UPDATE.questions[0];
  expect(final.questions[0].title).toBe(question.title);
  expect(final.questions[0].choices.map(c => c.title)).toEqual(question.choices.map(c => c.title));
  await checkResults(live, e, final, results.states, {
    tally: tally(S7_BALLOTS),
    voters: S7_BALLOTS.length,
  });
  row.voters = S7_BALLOTS.length;
}
