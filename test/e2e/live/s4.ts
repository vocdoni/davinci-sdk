/**
 * @fileoverview Scenario 4: an on-chain census (origin 3). The organizer
 * deploys an `OwnedCensus` and adds three random members with weights 2 to 4;
 * a fourth joins while voting runs. The census weight is each voter's budget
 * (`maxValueSum` 0). Checks that the nodes index the contract (the weight
 * each node proves equals the contract's) and the weighted tally.
 */

import { Wallet, getAddress } from 'ethers';
import { expect } from 'vitest';
import { OnchainCensus } from '../../../src/census/classes/OnchainCensus';
import { OnchainCensusService } from '../../../src/contracts/OnchainCensusService';
import { deployOwnedCensus } from '../census';
import { say } from '../env';
import type { Row } from '../report';
import { S4, S4_BALLOTS, S4_LATE_WEIGHT, S4_WEIGHTS, tally } from '../spec';
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

// Every node proves `address` with `weight`.
async function nodesProve(live: Live, e: Election, address: string, weight: bigint): Promise<void> {
  for (const node of live.sdk.api.nodes.nodes) {
    const p = await node.getParticipant(e.processId, address);
    expect(p.weight, `${node.getBaseUrl()}: weight of ${address}`).toBe(weight);
  }
}

export async function s4(live: Live, row: Row): Promise<void> {
  const voters = [...S4_WEIGHTS, S4_LATE_WEIGHT].map(() => Wallet.createRandom());
  const deployed = await live.org.exclusive(() =>
    deployOwnedCensus(live.wallet, (label, hash) => live.org.record(`s4 ${label}`, hash))
  );
  say(
    `s4: OwnedCensus ${deployed.address} on PoseidonT3 ${deployed.poseidonT3}` +
      (deployed.deployedLibrary ? ' (deployed)' : '')
  );
  const contract = new OnchainCensusService(deployed.address, live.wallet);
  await live.org.send('s4 addMembers', () =>
    contract.addMembers(
      voters.slice(0, S4_WEIGHTS.length).map(w => w.address),
      S4_WEIGHTS
    )
  );

  const e = await createElection(live, 's4', S4, {
    census: new OnchainCensus(deployed.address),
    maxVoters: 10,
  });
  row.processId = e.processId;
  const p = await live.sdk.registry.getProcess(e.processId);
  expect(getAddress(p.census.contractAddress)).toBe(deployed.address);
  const first = voters.slice(0, S4_WEIGHTS.length);
  await waitServed(
    live,
    e,
    first.map(w => w.address)
  );
  for (const [i, w] of first.entries()) await nodesProve(live, e, w.address, BigInt(S4_WEIGHTS[i]));

  const sdkOf = voterSdks(live, voters);
  const casts: Cast[] = [];
  const cast = async (i: number) => {
    const b = S4_BALLOTS[i];
    const sdk = await sdkOf(b.voter);
    const c = await vote(sdk, `s4 voter ${b.voter}`, {
      processId: e.processId,
      choices: b.choices,
    });
    expect(c.weight).toBe(BigInt([...S4_WEIGHTS, S4_LATE_WEIGHT][b.voter]));
    casts.push(c);
  };
  for (let i = 0; i < S4_WEIGHTS.length; i++) await cast(i);

  // A member joins while voting runs: the nodes index it from the contract.
  const late = voters[S4_WEIGHTS.length];
  await live.org.send('s4 addMember', () => contract.addMember(late.address, S4_LATE_WEIGHT));
  expect(await (await sdkOf(S4_WEIGHTS.length)).getAddressWeight(e.processId, late.address)).toBe(
    BigInt(S4_LATE_WEIGHT)
  );
  await waitServed(live, e, [late.address]);
  await nodesProve(live, e, late.address, BigInt(S4_LATE_WEIGHT));
  await cast(S4_WEIGHTS.length);

  await closeSoon(live, e);
  const results = watchResults(live, e);
  const followed = await follow(live, e, casts);
  for (const f of followed) expect(f.statuses.at(-1), f.cast.label).toBe('settled');
  await checkReceipts(live, e, casts);

  const final = await results.done;
  expect(final.kind).toBe('custom');
  await checkResults(live, e, final, results.states, {
    tally: tally(S4_BALLOTS),
    voters: S4_BALLOTS.length,
  });
  row.voters = S4_BALLOTS.length;
}
