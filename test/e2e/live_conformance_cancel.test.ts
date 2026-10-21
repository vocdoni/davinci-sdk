/**
 * @fileoverview Live conformance: input validation and a cancel with pending
 * votes. One CSP process (origin 4, sequencer key) with one field, `minValue =
 * maxValue` and cost exponent 0, open long enough that its votes wait in the
 * queue. The input battery (docs/api.md wire format and errors) runs against it;
 * then it is canceled with votes pending: they must end in `error`
 * (`process closed`), nothing is settled, later votes are refused (41201).
 */

import { Wallet, type BaseWallet } from 'ethers';
import { CspCensus } from '../../src/census/classes/CspCensus';
import type { BallotMode } from '../../src/core/types/common';
import { ProcessStatus } from '../../src/contracts/types';
import { draft, processCtx, type ProcessCtx } from './conformance/ballots';
import { sdkRefuses, sdkTakes } from './conformance/checks';
import { inputBattery } from './conformance/inputs';
import { Ledger, finalChecks } from './conformance/ledger';
import { Live, sleep } from './conformance/live';
import { enabled, settings } from './conformance/settings';

const PE_MODE: BallotMode = {
  numFields: 1,
  groupSize: 1,
  maxValue: '3',
  minValue: '3',
  uniqueValues: false,
  costExponent: 1,
  maxValueSum: '3',
  minValueSum: '3',
};

describe.skipIf(!enabled())('live conformance: input validation and cancel', () => {
  let live: Live;

  afterAll(async () => {
    if (!live) return;
    await live.cancelOpen();
    await live.close();
  }, 15 * 60_000);

  it(
    'PE',
    async () => {
      live = new Live(settings(), 'cancel');
      await live.connect();
      const ev = live.ev;
      const csp = Wallet.createRandom();
      const pe = await live.createProcess('PE', {
        census: new CspCensus(csp.address, 'csp://a5-conformance-pe'),
        ballot: PE_MODE,
        maxVoters: 20,
        duration: 30 * 60,
        metadata: 's8-metadata.json',
        origin: '4 CSP',
      });
      await live.waitServed(pe);
      const ctx: ProcessCtx = await processCtx(live, pe.processId);
      const led = new Ledger(live, pe);
      const mk = (label: string, voter: BaseWallet, index: bigint, choices = [3]) =>
        draft(live, ctx, { label, voter, choices, weight: 1n, csp: { signer: csp, index } });

      // Boundaries: one field at exactly 3 (cost 3^0 = 1 = both sum bounds).
      const probe = Wallet.createRandom();
      sdkTakes(live, ctx, 'PE [3]', [3], 1n);
      await sdkRefuses(live, ctx, probe, 'PE below minValue', [2], 1n);
      await sdkRefuses(live, ctx, probe, 'PE above maxValue', [4], 1n);
      await sdkRefuses(live, ctx, probe, 'PE a second field past numFields', [3, 3], 1n);

      // Two voters wait in the queue; the view says when their batch may seal.
      const q1 = await mk('Q1', Wallet.createRandom(), 0n);
      await led.submit(q1, { expect: { status: 200 } });
      const v1 = await live.node.process(pe.processId);
      const q2 = await mk('Q2', Wallet.createRandom(), 1n);
      await led.submit(q2, { expect: { status: 200 } });
      const v2 = await live.node.process(pe.processId);
      ev.log('batching', {
        now: Math.floor(Date.now() / 1000),
        afterOne: { pending: v1?.pendingVotes, nextSealNotBefore: v1?.nextSealNotBefore },
        afterTwo: { pending: v2?.pendingVotes, nextSealNotBefore: v2?.nextSealNotBefore },
      });
      ev.say(
        `batching: one slot seals at ${String(v1?.nextSealNotBefore)}, two at ${String(v2?.nextSealNotBefore)}, now ${Math.floor(Date.now() / 1000)}`
      );

      await live.pingOrStop('PE inputs');
      const fresh = await mk('F', Wallet.createRandom(), 2n);
      await inputBattery(live, led, q1, fresh);
      await led.submit(fresh, { label: 'F valid', expect: { status: 200 } });
      await live.pingOrStop('PE after inputs');

      // One more right before the cancel.
      await led.submit(await mk('Q3', Wallet.createRandom(), 3n), {
        expect: { status: 200 },
      });
      for (const s of led.accepted) await led.waitFor(s, ['pending'], 1000, 1000);
      const before = led.accepted.map(s => [s.label, s.last]);
      ev.log('before-cancel', { statuses: before });
      for (const s of led.accepted) if (s.last !== 'settled') s.expectFinal = 'error';

      await live.send('PE cancel', () => live.sdk.cancelProcessStream(pe.processId));
      const p = await live.sdk.registry.getProcess(pe.processId);
      ev.eq('PE: registry status after the cancel', ProcessStatus[p.status], 'CANCELED');
      // The node learns the cancel from its event, a block or two later.
      let seen = '';
      for (let i = 0; i < 30 && seen !== 'canceled'; i++) {
        seen = String((await live.node.process(pe.processId))?.status);
        if (seen !== 'canceled') await sleep(4000);
      }
      ev.eq('PE: the node reports canceled', seen, 'canceled');
      const late = await mk('Q4 after the cancel', Wallet.createRandom(), 4n);
      await led.submit(late, { expect: { status: 412, code: 41201 } });
      const view = await live.node.process(pe.processId);
      ev.eq('PE: not accepting votes after the cancel', view?.isAcceptingVotes, false);

      led.follow(3000);
      const allDone = await led.waitAllFinal(10 * 60_000);
      ev.check('PE: queued votes closed out after the cancel', allDone, {
        statuses: led.accepted.map(s => [s.label, s.last, s.lastError]),
      });
      for (const s of led.accepted.filter(x => x.expectFinal === 'error')) {
        ev.check(
          `PE: ${s.label} closed as "process closed"`,
          (s.lastError ?? '').includes('process closed'),
          {
            error: s.lastError,
          }
        );
      }
      const results = await live.sdk.getResultsStatus(pe.processId);
      ev.eq('PE: results state canceled', results.state, 'canceled');
      await finalChecks(live, led, { canceled: true });
    },
    60 * 60_000
  );
});
