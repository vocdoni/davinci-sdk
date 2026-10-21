/**
 * @fileoverview Live conformance: the lifecycle of one CSP process (origin 4,
 * sequencer key; three fields, group size 0, cost exponent 61, the largest the
 * registry takes for them). A vote before the start (41204); votes once open; a vote while paused (taken, sealed only
 * after the resume); `maxVoters` raised to the count plus one and two new voters
 * racing for the slot (one taken, one 41202), a third refused, an existing voter's
 * revote taken; shortening inside the notice refused by the registry; a vote just
 * before the end (settles in the grace window), after the end, during the grace
 * window and after the results (41201). The tally is checked against what the node
 * took.
 */

import { VoidSigner, Wallet, type BaseWallet } from 'ethers';
import { CspCensus } from '../../src/census/classes/CspCensus';
import { ProcessRegistryService } from '../../src/contracts/ProcessRegistryService';
import { TxStatus, type TxStatusEvent } from '../../src/contracts/SmartContractService';
import type { ContractServiceError } from '../../src/contracts/errors';
import type { BallotMode } from '../../src/core/types/common';
import { VoteError } from '../../src/core/vote/errors';
import { DavinciSDK } from '../../src/DavinciSDK';
import { signCspAttestation } from '../../src/crypto/ecdsa';
import { DirArtifactCache } from './artifactCache';
import { draft, processCtx } from './conformance/ballots';
import { counters, countersStill, sdkRefuses, sdkTakes } from './conformance/checks';
import { Ledger, finalChecks } from './conformance/ledger';
import { Live, RollingEnd, sleep } from './conformance/live';
import { enabled, settings } from './conformance/settings';

const PD_MODE: BallotMode = {
  numFields: 3,
  groupSize: 0,
  maxValue: '2',
  minValue: '0',
  uniqueValues: false,
  costExponent: 61,
  maxValueSum: '3',
  minValueSum: '0',
};

describe.skipIf(!enabled())('live conformance: lifecycle', () => {
  let live: Live;

  afterAll(async () => {
    if (!live) return;
    await live.cancelOpen();
    await live.close();
  }, 15 * 60_000);

  it(
    'PD',
    async () => {
      live = new Live(settings(), 'lifecycle');
      await live.connect();
      const ev = live.ev;
      const before = await counters(live);
      const csp = Wallet.createRandom();
      const indexOf = new Map<string, bigint>();
      const pd = await live.createProcess('PD', {
        census: new CspCensus(csp.address, 'csp://a5-conformance-pd'),
        ballot: PD_MODE,
        maxVoters: 10,
        startIn: 150,
        duration: 175,
        metadata: 's8-metadata.json',
        origin: '4 CSP',
      });
      const pid = pd.processId;
      await live.waitServed(pd);
      const ctx = await processCtx(live, pid);
      const led = new Ledger(live, pd);
      const voters = Array.from({ length: 12 }, () => Wallet.createRandom());
      voters.forEach((v, i) => indexOf.set(v.address, BigInt(i)));
      const mk = (label: string, i: number, choices: number[]) =>
        draft(live, ctx, {
          label,
          voter: voters[i],
          choices,
          weight: 1n,
          csp: { signer: csp, index: BigInt(i) },
        });
      const sdkOf = async (v: BaseWallet) => {
        const s = new DavinciSDK({
          signer: v,
          network: 'optimism',
          sequencerUrls: [live.settings.node],
          rpcUrls: live.settings.rpcUrls,
          artifacts: { cache: new DirArtifactCache(live.settings.artifactsDir) },
          censusProviders: {
            csp: r =>
              signCspAttestation(csp, {
                processId: r.processId,
                address: r.address,
                weight: 1n,
                index: indexOf.get(r.address) ?? 99n,
              }),
          },
        });
        await s.init();
        return s;
      };
      const sdkReason = async (label: string, v: BaseWallet, choices: number[], want: string) => {
        const s = await sdkOf(v);
        const got = await s.submitVote({ processId: pid, choices }).then(
          r => `taken ${r.voteId}`,
          (err: unknown) => (err instanceof VoteError ? err.reason : String(err))
        );
        ev.eq(`PD: SDK submitVote ${label}`, got, want);
      };
      const roll = new RollingEnd(live, pd);

      try {
        // ── Boundaries of cost exponent 61 ──────────────────────────────
        for (const c of [
          [1, 1, 1],
          [0, 0, 0],
          [1, 1, 0],
        ])
          sdkTakes(live, ctx, `PD ${JSON.stringify(c)}`, c, 1n);
        await sdkRefuses(live, ctx, voters[11], 'PD 2^61 exceeds maxValueSum', [2, 0, 0], 1n);
        await sdkRefuses(live, ctx, voters[11], 'PD above maxValue', [3, 0, 0], 1n);

        // ── Before the start ────────────────────────────────────────────
        const view0 = await live.node.process(pid);
        ev.eq('PD: not accepting before the start', view0?.isAcceptingVotes, false);
        const early = await mk('L1 before the start', 1, [1, 1, 1]);
        await led.submit(early, { expect: { status: 412, code: 41204 } });
        await sdkReason('before the start', voters[1], [1, 1, 1], 'not-started');

        await live.pingOrStop('PD waiting for the start');
        for (;;) {
          if ((await live.chainTime()) >= pd.startTime + 4) break;
          await sleep(3000);
        }
        for (let i = 0; i < 20; i++) {
          if ((await live.node.process(pid))?.isAcceptingVotes === true) break;
          await sleep(3000);
        }
        roll.start();
        // ── Open ────────────────────────────────────────────────────────
        const l1 = await led.submit(early, {
          label: 'L1 once open (same body)',
          expect: { status: 200 },
        });
        const l2 = await led.submit(await mk('L2', 2, [1, 0, 0]), { expect: { status: 200 } });
        const l3 = await led.submit(await mk('L3', 3, [0, 1, 1]), { expect: { status: 200 } });
        led.follow(3000);
        for (const s of [l1, l2, l3])
          ev.eq(
            `PD: ${s.label} settles`,
            await led.waitFor(s, ['settled'], 12 * 60_000),
            'settled'
          );

        // ── Paused ──────────────────────────────────────────────────────
        await live.pingOrStop('PD pause');
        await live.send('PD pause', () => live.sdk.pauseProcessStream(pid));
        let st = '';
        for (let i = 0; i < 30 && st !== 'paused'; i++) {
          st = String((await live.node.process(pid))?.status);
          if (st !== 'paused') await sleep(3000);
        }
        ev.eq('PD: the node reports paused', st, 'paused');
        const tBefore = await live.node.get(`/processes/${pid}/transitions`);
        const nBefore = ((tBefore.json as { transitions: unknown[] }).transitions ?? []).length;
        const l4 = await led.submit(await mk('L4 while paused', 4, [1, 1, 0]), {
          expect: { status: 200 },
        });
        await sleep(90_000);
        const l4st = await led.waitFor(l4, ['pending'], 1000);
        const tPaused = await live.node.get(`/processes/${pid}/transitions`);
        const nPaused = ((tPaused.json as { transitions: unknown[] }).transitions ?? []).length;
        ev.eq(
          'PD: a vote taken while paused stays pending, no batch lands',
          [l4st, nPaused],
          ['pending', nBefore]
        );

        // ── Resumed ─────────────────────────────────────────────────────
        await live.send('PD resume', () => live.sdk.resumeProcessStream(pid));
        for (let i = 0; i < 30 && st !== 'ready'; i++) {
          st = String((await live.node.process(pid))?.status);
          if (st !== 'ready') await sleep(3000);
        }
        ev.eq('PD: the node reports ready after the resume', st, 'ready');
        const l5 = await led.submit(await mk('L5 after the resume', 5, [0, 0, 1]), {
          expect: { status: 200 },
        });
        for (const s of [l4, l5])
          ev.eq(
            `PD: ${s.label} settles`,
            await led.waitFor(s, ['settled'], 12 * 60_000),
            'settled'
          );

        // ── maxVoters: the count plus one, two new voters race for it ──
        await live.pingOrStop('PD maxVoters');
        const count = Number((await live.sdk.registry.getProcess(pid)).votersCount);
        ev.eq('PD: five voters on chain before the cap', count, 5);
        await live.send('PD setProcessMaxVoters', () =>
          live.sdk.setProcessMaxVotersStream(pid, count + 1)
        );
        for (let i = 0; i < 30; i++) {
          if ((await live.node.process(pid))?.maxVoters === count + 1) break;
          await sleep(3000);
        }
        const racers = [await mk('L6 racing', 6, [1, 0, 1]), await mk('L7 racing', 7, [0, 1, 0])];
        const answers = await live.throttle.burst('PD last slot', 2, i =>
          live.node.post('/votes', racers[i].body)
        );
        answers.forEach((a, i) => led.record(racers[i], a));
        ev.eq(
          'PD: two new voters for the last slot: one taken, one 41202',
          answers.map(a => (a.status === 200 ? 200 : a.code)).sort(),
          [200, 41202]
        );
        await led.submit(await mk('L8 new voter at the cap', 8, [1, 1, 1]), {
          expect: { status: 412, code: 41202 },
        });
        await sdkReason('a new voter at the cap', voters[9], [1, 1, 1], 'max-voters');
        const l1b = await led.submit(await mk('L1 revote at the cap', 1, [0, 0, 0]), {
          expect: { status: 200 },
        });

        // ── Shortening inside the notice: refused by the registry ───────
        const raw = new ProcessRegistryService(
          live.sdk.network.processRegistry,
          new VoidSigner(live.wallet.address, live.sdk.provider)
        );
        const now = await live.chainTime();
        const inside = BigInt(now + Math.floor(live.grace.noticeMin / 2) - pd.startTime);
        const events: TxStatusEvent<unknown>[] = [];
        for await (const e of raw.setProcessDuration(pid, inside)) events.push(e);
        const only = events[0];
        ev.eq(
          'PD: shortening inside the notice refused as an eth_call',
          [
            events.map(e => e.status),
            only?.status === TxStatus.Failed
              ? (only.error as ContractServiceError).revertName
              : undefined,
          ],
          [[TxStatus.Failed], 'InvalidDuration']
        );

        for (const s of led.accepted)
          ev.eq(
            `PD: ${s.label} settles before the close`,
            await led.waitFor(s, ['settled'], 12 * 60_000),
            'settled'
          );
        void l1b;

        // ── The close ───────────────────────────────────────────────────
        await roll.stop();
        let end = await live.endOf(pd);
        if (end - (await live.chainTime()) > 120) end = await live.closeSoon(pd);
        ev.log('end', { end });
        // Just before the end: taken, settles in the grace window. A revote: the cap is full.
        while ((await live.chainTime()) < end - 25) await sleep(3000);
        await led.submit(await mk('L2 revote just before the end', 2, [1, 0, 0]), {
          expect: { status: 200 },
        });
        while ((await live.chainTime()) < end + 3) await sleep(3000);
        await led.submit(await mk('L11 after the end', 11, [0, 1, 0]), {
          expect: { status: 412, code: 41201 },
        });
        await sdkReason('after the end', voters[11], [0, 1, 0], 'closed');
        const graceEnd = Number(await live.sdk.registry.getProcessGraceEnd(pid));
        const inGrace = (await live.chainTime()) < graceEnd;
        await led.submit(await mk('L11 during the grace window', 11, [0, 0, 1]), {
          expect: { status: 412, code: 41201 },
        });
        ev.check('PD: that vote was sent inside the grace window', inGrace, { graceEnd });

        // ── Results ─────────────────────────────────────────────────────
        await live.waitFinal(pd, 40 * 60_000);
        await led.submit(await mk('L11 after the results', 11, [1, 1, 1]), {
          expect: { status: 412, code: 41201 },
        });
        await finalChecks(live, led);
        await countersStill(live, 'lifecycle', before);
      } catch (err) {
        ev.log('error', { error: err instanceof Error ? err.message : String(err) });
        await roll.stop();
        throw err;
      }
    },
    120 * 60_000
  );
});
