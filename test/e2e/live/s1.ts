/**
 * @fileoverview Scenario 1: a static Merkle census (origin 1) and a sequencer
 * key. Eight weighted voters rate four proposals (16-field ballots with
 * identity padding past the fourth); one votes twice, one resends a ballot
 * (duplicate), one first sends a ballot with the wrong weight, and an
 * outsider is refused. Checks the key node's key, the voters' routing, every
 * status to `settled`, the receipts, the stored ballots and the tally.
 */

import { Wallet, type BaseWallet } from 'ethers';
import { expect } from 'vitest';
import { KeyMode } from '../../../src/contracts/types';
import { isValidEncryptionKey } from '../../../src/crypto/babyjubjub';
import { buildBallot, isBallotPaddingValid } from '../../../src/crypto/ballot';
import { encodeEcdsaSignature, signVoteId } from '../../../src/crypto/ecdsa';
import { randomBallotSecret } from '../../../src/crypto/encryption';
import type { DavinciSDK } from '../../../src/DavinciSDK';
import { pickNode } from '../../../src/sequencer/routing';
import type { VoteRequest } from '../../../src/sequencer/api/types';
import { say } from '../env';
import type { Row } from '../report';
import { S1, S1_BALLOTS, S1_REVOTE, S1_WEIGHTS, s1Census, tally } from '../spec';
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

// A ballot proved for `weight` instead of the voter's census weight, sent as is.
async function sendWithWeight(
  sdk: DavinciSDK,
  voter: BaseWallet,
  processId: string,
  choices: number[],
  weight: bigint
): Promise<unknown> {
  const p = await sdk.registry.getProcess(processId);
  const built = await buildBallot({
    processId,
    address: voter.address,
    encryptionKey: p.encryptionKey,
    ballotMode: p.ballotMode,
    fields: choices,
    weight,
    k: randomBallotSecret(),
  });
  const { proof } = await sdk.proveBallot(built);
  const request: VoteRequest = {
    processId,
    address: voter.address,
    voteId: built.voteId,
    ballot: built.ballot,
    ballotProof: proof,
    ballotInputsHash: built.inputsHash,
    signature: encodeEcdsaSignature(await signVoteId(voter, built.voteId)),
    weight,
  };
  return sdk.api.nodes.submitVote(request).then(
    () => new Error('the node took a ballot with the wrong weight'),
    (err: unknown) => err
  );
}

// The vote went to `want`, the voter's node, unless `want` was down: then
// the SDK fails over, and `want` does not answer now either.
async function routedTo(live: Live, label: string, got: string, want: string): Promise<void> {
  if (got === want) return;
  const answers = await live.sdk.api.nodes
    .node(want)
    .getInfo()
    .then(
      () => true,
      () => false
    );
  expect(answers, `${label}: sent to ${got} while its node ${want} answers`).toBe(false);
  say(`${label}: ${want} did not answer; the vote failed over to ${got}`);
}

export async function s1(live: Live, row: Row): Promise<void> {
  const voters = live.voters.s1;
  const e = await createElection(live, 's1', S1, { census: s1Census(live.voters) });
  row.processId = e.processId;
  await waitServed(
    live,
    e,
    voters.map(w => w.address)
  );
  // The key node's key, a subgroup point, as every node serves it.
  const onchain = await live.sdk.registry.getProcess(e.processId);
  expect(onchain.keyMode).toBe(KeyMode.Sequencer);
  expect(onchain.ballotMode.numFields).toBe(4);
  expect(isValidEncryptionKey(onchain.encryptionKey)).toBe(true);
  for (const node of live.sdk.api.nodes.nodes) {
    expect((await node.getProcess(e.processId)).encryptionKey).toEqual(onchain.encryptionKey);
  }

  const sdkOf = voterSdks(live, voters);
  const casts: Cast[] = [];
  for (const b of S1_BALLOTS) {
    const sdk = await sdkOf(b.voter);
    const weight = BigInt(S1_WEIGHTS[b.voter]);
    if (b.voter === 7) {
      const refused = await sendWithWeight(sdk, voters[7], e.processId, b.choices, weight + 1n);
      expect(refused, 'a ballot with the wrong weight').toMatchObject({ code: 40002 });
      say(`s1: voter 7's ballot with weight ${weight + 1n} refused (40002)`);
    }
    const cast = await vote(sdk, `s1 voter ${b.voter}`, {
      processId: e.processId,
      choices: b.choices,
    });
    expect(cast.weight).toBe(weight);
    const pick = pickNode(cast.voterAddress, e.processId, live.settings.nodes)[0];
    await routedTo(live, cast.label, cast.node, pick);
    casts.push(cast);
  }
  const nodesUsed = new Set(casts.map(c => c.node)).size;
  say(`s1: ${casts.length} votes over ${nodesUsed} nodes`);

  // The same ballot secret again: the same vote id.
  const again = await (await sdkOf(1))
    .submitVote({ processId: e.processId, choices: S1_BALLOTS[1].choices, k: casts[1].k })
    .then(
      () => null,
      (err: unknown) => err
    );
  expect(again, 'a resent ballot').toMatchObject({ reason: 'duplicate' });

  // Voter 0 changes its mind: the revote queues behind its first ballot.
  const revote = await vote(await sdkOf(0), 's1 voter 0 revote', {
    processId: e.processId,
    choices: S1_REVOTE.choices,
  });
  await routedTo(live, revote.label, revote.node, casts[0].node);

  const outsider = await live.voterSdk(Wallet.createRandom());
  const refused = await outsider.submitVote({ processId: e.processId, choices: [1, 1, 1, 1] }).then(
    () => null,
    (err: unknown) => err
  );
  expect(refused, 'an outsider').toMatchObject({ reason: 'not-in-census' });

  await closeSoon(live, e);
  const results = watchResults(live, e);
  const all = [...casts, revote];
  const followed = await follow(live, e, all);
  for (const f of followed) expect(f.statuses.at(-1), f.cast.label).toBe('settled');
  await checkReceipts(live, e, all);

  // Each voter's slot holds a 16-field ballot, identity past the fourth field.
  for (const w of voters) {
    expect(await live.sdk.hasAddressVoted(e.processId, w.address)).toBe(true);
    const stored = await live.sdk.api.nodes.firstAnswer(n => n.getBallot(e.processId, w.address));
    expect(isBallotPaddingValid(stored.ballot, 4), `${w.address}: padding`).toBe(true);
  }

  const counted = [...S1_BALLOTS.filter(b => b.voter !== 0), S1_REVOTE];
  await checkResults(live, e, await results.done, results.states, {
    tally: tally(counted),
    voters: 8,
    overwrites: 1,
  });
  row.voters = 8;
}
