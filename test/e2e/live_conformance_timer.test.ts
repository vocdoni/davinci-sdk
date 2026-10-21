/**
 * @fileoverview Live conformance: the batch timer and `maxVoters` lowered under a
 * pending vote. One CSP process (origin 4, sequencer key; one field, `minValue =
 * maxValue`, cost exponent 0) with no flush until its end: two voters' batch seals
 * by the timer (not before the `nextSealNotBefore` the node announced); then a new
 * voter's vote is taken and `maxVoters` is lowered to the on-chain count, so that
 * vote can never fit (docs/lifecycle.md: it ends in `error`, uncounted); a new
 * voter is refused (41202) and an existing voter's revote is taken.
 */

import { Wallet } from 'ethers';
import { CspCensus } from '../../src/census/classes/CspCensus';
import type { BallotMode } from '../../src/core/types/common';
import { draft, processCtx } from './conformance/ballots';
import { counters, countersStill, sdkTakes } from './conformance/checks';
import { Ledger, finalChecks } from './conformance/ledger';
import { Live, sleep } from './conformance/live';
import { enabled, settings } from './conformance/settings';

const PF_MODE: BallotMode = {
  numFields: 1,
  groupSize: 1,
  maxValue: '3',
  minValue: '3',
  uniqueValues: false,
  costExponent: 1,
  maxValueSum: '3',
  minValueSum: '3',
};

describe.skipIf(!enabled())('live conformance: batch timer and a lowered cap', () => {
  let live: Live;

  afterAll(async () => {
    if (!live) return;
    await live.cancelOpen();
    await live.close();
  }, 15 * 60_000);

  it(
    'PF',
    async () => {
      live = new Live(settings(), 'timer');
      await live.connect();
      const ev = live.ev;
      const before = await counters(live);
      const csp = Wallet.createRandom();
      const pf = await live.createProcess('PF', {
        census: new CspCensus(csp.address, 'csp://a5-conformance-pf'),
        ballot: PF_MODE,
        maxVoters: 20,
        duration: 25 * 60,
        metadata: 's8-metadata.json',
        origin: '4 CSP',
      });
      const pid = pf.processId;
      await live.waitServed(pf);
      const ctx = await processCtx(live, pid);
      const led = new Ledger(live, pf);
      const voters = Array.from({ length: 5 }, () => Wallet.createRandom());
      const mk = (label: string, i: number) =>
        draft(live, ctx, {
          label,
          voter: voters[i],
          choices: [3],
          weight: 1n,
          csp: { signer: csp, index: BigInt(i) },
        });
      sdkTakes(live, ctx, 'PF [3] (cost 3)', [3], 1n);

      const v1 = await led.submit(await mk('V1', 1), { expect: { status: 200 } });
      const v2 = await led.submit(await mk('V2', 2), { expect: { status: 200 } });
      const view = await live.node.process(pid);
      const notBefore = Number(view?.nextSealNotBefore ?? 0);
      const sentAt = Math.floor(Date.now() / 1000);
      ev.log('batching', { sentAt, nextSealNotBefore: notBefore, pending: view?.pendingVotes });
      ev.say(`PF: the batch may seal ${notBefore - sentAt} s after the votes`);
      led.follow(5000);
      for (const s of [v1, v2])
        ev.eq(
          `PF: ${s.label} settles by the timer`,
          await led.waitFor(s, ['settled'], 22 * 60_000, 10_000),
          'settled'
        );
      const tr = await live.node.get(`/processes/${pid}/transitions`);
      const first = (tr.json as { transitions: { blockNumber: number }[] }).transitions[0];
      const landedAt = first
        ? (await live.sdk.provider.getBlock(first.blockNumber))?.timestamp
        : undefined;
      const end = await live.endOf(pf);
      ev.check(
        'PF: the timer batch landed no earlier than nextSealNotBefore',
        landedAt !== undefined && landedAt >= notBefore,
        {
          notBefore,
          landedAt,
        }
      );
      ev.check(
        'PF: and before the flush horizon (3 min before the end)',
        landedAt !== undefined && landedAt < end - 180,
        {
          landedAt,
          end,
        }
      );

      // A new voter's vote, then the cap lowered to the on-chain count under it.
      await live.pingOrStop('PF cap');
      const v3 = await led.submit(await mk('V3 (new slot, then the cap drops)', 3), {
        expect: { status: 200 },
      });
      v3.expectFinal = 'error';
      const count = Number((await live.sdk.registry.getProcess(pid)).votersCount);
      ev.eq('PF: two voters on chain', count, 2);
      await live.send('PF setProcessMaxVoters', () =>
        live.sdk.setProcessMaxVotersStream(pid, count)
      );
      for (let i = 0; i < 30; i++) {
        if ((await live.node.process(pid))?.maxVoters === count) break;
        await sleep(3000);
      }
      await led.submit(await mk('V4 new voter at the cap', 4), {
        expect: { status: 412, code: 41202 },
      });
      await led.submit(await mk('V1 revote at the cap', 1), { expect: { status: 200 } });

      await live.closeSoon(pf);
      await live.waitFinal(pf, 40 * 60_000);
      await finalChecks(live, led);
      ev.log('v3', { status: v3.last, error: v3.lastError });
      await countersStill(live, 'timer', before);
    },
    90 * 60_000
  );
});
