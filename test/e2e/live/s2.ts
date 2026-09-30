/**
 * @fileoverview Scenario 2: a CSP census (origin 4). A census service
 * provider drawn for the run attests three random voters with their weights
 * (ECDSA); each vote carries the attestation as its census proof.
 */

import { Wallet, getAddress } from 'ethers';
import { expect } from 'vitest';
import { CspSigner } from '../../../src/census/CspSigner';
import type { CspWitnessProvider } from '../../../src/census/types';
import type { Row } from '../report';
import { S2, S2_BALLOTS, S2_WEIGHTS, tally } from '../spec';
import type { Live } from './context';
import {
  checkReceipts,
  checkResults,
  closeSoon,
  createElection,
  follow,
  vote,
  waitServed,
  watchResults,
  type Cast,
} from './flow';

/** What the CSP census records as its URI; nodes do not read it. */
const CSP_URI = 'csp://davinci-sdk-e2e';

export async function s2(live: Live, row: Row): Promise<void> {
  const csp = new CspSigner(Wallet.createRandom());
  const voters = S2_WEIGHTS.map(() => Wallet.createRandom());
  const weightOf = new Map(voters.map((w, i) => [w.address, BigInt(S2_WEIGHTS[i])]));
  // The CSP attests the voters it knows, with their weight.
  const attest: CspWitnessProvider = request => {
    const weight = weightOf.get(getAddress(request.address));
    if (weight === undefined) return Promise.reject(new Error(`${request.address} is unknown`));
    return csp.attest({ processId: request.processId, address: request.address, weight });
  };

  const census = await csp.census(CSP_URI);
  const e = await createElection(live, 's2', S2, { census, maxVoters: 10 });
  row.processId = e.processId;
  const p = await live.sdk.registry.getProcess(e.processId);
  expect(BigInt(p.census.root)).toBe(BigInt(await csp.address()));
  await waitServed(live, e);

  const casts: Cast[] = [];
  for (const b of S2_BALLOTS) {
    const sdk = await live.voterSdk(voters[b.voter], { csp: attest });
    expect(await sdk.getAddressWeight(e.processId, voters[b.voter].address)).toBe(
      BigInt(S2_WEIGHTS[b.voter])
    );
    const cast = await vote(sdk, `s2 voter ${b.voter}`, {
      processId: e.processId,
      choices: b.choices,
    });
    expect(cast.weight).toBe(BigInt(S2_WEIGHTS[b.voter]));
    casts.push(cast);
  }

  await closeSoon(live, e);
  const results = watchResults(live, e);
  const followed = await follow(live, e, casts);
  for (const f of followed) expect(f.statuses.at(-1), f.cast.label).toBe('settled');
  await checkReceipts(live, e, casts);
  for (const w of voters) expect(await live.sdk.hasAddressVoted(e.processId, w.address)).toBe(true);

  await checkResults(live, e, await results.done, results.states, {
    tally: tally(S2_BALLOTS),
    voters: S2_BALLOTS.length,
  });
  row.voters = S2_BALLOTS.length;
}
