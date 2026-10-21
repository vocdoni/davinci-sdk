/**
 * @fileoverview Live conformance: `maxVoters` and the close. One CSP process
 * (origin 4, sequencer key; five fields, group size 3, unique values from 1 to 7,
 * cost exponent 3, sum bounds 316..377: two value sets fit, each on a bound), kept
 * in flush mode by extending its end.
 * `maxVoters` raised to the count plus one: two new voters race for the slot (one
 * taken, one 41202), a third is refused, an existing voter's revote is taken. A new
 * voter's vote taken while paused, then the cap lowered to the on-chain count under
 * it: it can never fit and must end in `error`, uncounted. Shortening inside the
 * notice is refused by the registry. A revote just before the end settles in the
 * grace window; votes after the end, during the grace window and after the results
 * are refused (41201).
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
import { Ledger, finalChecks, type Sent } from './conformance/ledger';
import { Live, RollingEnd, sleep } from './conformance/live';
import { enabled, settings } from './conformance/settings';

const PG_MODE: BallotMode = {
  numFields: 5,
  groupSize: 3,
  maxValue: '7',
  minValue: '1',
  uniqueValues: true,
  costExponent: 3,
  maxValueSum: '377',
  minValueSum: '316',
};

describe.skipIf(!enabled())('live conformance: caps and the close', () => {
  let live: Live;

  afterAll(async () => {
    if (!live) return;
    await live.cancelOpen();
    await live.close();
  }, 15 * 60_000);

  it(
    'PG',
    async () => {
      live = new Live(settings(), 'caps');
      await live.connect();
      const ev = live.ev;
      const before = await counters(live);
      const csp = Wallet.createRandom();
      const pg = await live.createProcess('PG', {
        census: new CspCensus(csp.address, 'csp://a5-conformance-pg'),
        ballot: PG_MODE,
        maxVoters: 10,
        duration: 175,
        metadata: 's8-metadata.json',
        origin: '4 CSP',
      });
      const pid = pg.processId;
      const roll = new RollingEnd(live, pg);
      roll.start();
      await live.waitServed(pg);
      const ctx = await processCtx(live, pid);
      const led = new Ledger(live, pg);
      led.follow(3000);
      const voters = Array.from({ length: 12 }, () => Wallet.createRandom());
      const indexOf = new Map(voters.map((v, i) => [v.address, BigInt(i)]));
      const mk = (label: string, i: number, choices: number[]) =>
        draft(live, ctx, {
          label,
          voter: voters[i],
          choices,
          weight: 1n,
          csp: { signer: csp, index: BigInt(i) },
        });
      const sdkReason = async (label: string, v: BaseWallet, choices: number[], want: string) => {
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
        const got = await s.submitVote({ processId: pid, choices }).then(
          r => `taken ${r.voteId}`,
          (err: unknown) => (err instanceof VoteError ? err.reason : String(err))
        );
        ev.eq(`PG: SDK submitVote ${label}`, got, want);
      };
      const nodeSees = async (what: string, ok: (v: Record<string, unknown>) => boolean) => {
        for (let i = 0; i < 40; i++) {
          const v = await live.node.process(pid);
          if (v && ok(v)) return true;
          await sleep(3000);
        }
        ev.check(`PG: the node sees ${what}`, false);
        return false;
      };
      const settles = async (ss: Sent[]) => {
        for (const s of ss)
          ev.eq(
            `PG: ${s.label} settles`,
            await led.waitFor(s, ['settled'], 12 * 60_000),
            'settled'
          );
      };

      try {
        // ── Boundaries ──────────────────────────────────────────────────
        sdkTakes(live, ctx, 'PG [1,2,3,4,6] (cost 316, minValueSum)', [1, 2, 3, 4, 6], 1n);
        sdkTakes(live, ctx, 'PG [1,2,3,5,6] (cost 377, maxValueSum)', [1, 2, 3, 5, 6], 1n);
        const probe = voters[11];
        await sdkRefuses(live, ctx, probe, 'PG below minValueSum (225)', [1, 2, 3, 4, 5], 1n);
        await sdkRefuses(live, ctx, probe, 'PG above maxValueSum (414)', [1, 2, 4, 5, 6], 1n);
        await sdkRefuses(live, ctx, probe, 'PG below minValue', [0, 2, 3, 4, 6], 1n);
        await sdkRefuses(live, ctx, probe, 'PG above maxValue', [1, 2, 3, 4, 8], 1n);
        await sdkRefuses(live, ctx, probe, 'PG a repeated value', [1, 1, 3, 4, 6], 1n);

        // ── Three voters ────────────────────────────────────────────────
        await live.pingOrStop('PG first votes');
        const first = [
          await led.submit(await mk('V1', 1, [1, 2, 3, 4, 6]), { expect: { status: 200 } }),
          await led.submit(await mk('V2', 2, [6, 4, 3, 2, 1]), { expect: { status: 200 } }),
          await led.submit(await mk('V3', 3, [1, 2, 3, 5, 6]), { expect: { status: 200 } }),
        ];
        await settles(first);

        // ── The count plus one, raced for ───────────────────────────────
        await live.pingOrStop('PG cap');
        let count = Number((await live.sdk.registry.getProcess(pid)).votersCount);
        ev.eq('PG: three voters on chain', count, 3);
        await live.send('PG setProcessMaxVoters +1', () =>
          live.sdk.setProcessMaxVotersStream(pid, count + 1)
        );
        await nodeSees(`maxVoters ${count + 1}`, v => v.maxVoters === count + 1);
        const racers = [
          await mk('V4 racing for the last slot', 4, [2, 1, 3, 4, 6]),
          await mk('V5 racing for the last slot', 5, [3, 1, 2, 5, 6]),
        ];
        const answers = await live.throttle.burst('PG last slot', 2, i =>
          live.node.post('/votes', racers[i].body)
        );
        const raced = answers.map((a, i) => led.record(racers[i], a));
        ev.eq(
          'PG: two new voters for the last slot: one taken, one 41202',
          answers.map(a => (a.status === 200 ? 200 : a.code)).sort(),
          [200, 41202]
        );
        await led.submit(await mk('V6 new voter at the cap', 6, [1, 2, 3, 6, 4]), {
          expect: { status: 412, code: 41202 },
        });
        await sdkReason('a new voter at the cap', voters[7], [1, 2, 4, 3, 6], 'max-voters');
        const v1b = await led.submit(await mk('V1 revote at the cap', 1, [6, 1, 2, 3, 5]), {
          expect: { status: 200 },
        });
        await settles([...raced.filter(s => s.accepted), v1b]);

        // ── The cap lowered under a pending new voter ───────────────────
        await live.pingOrStop('PG cap under a pending vote');
        count = Number((await live.sdk.registry.getProcess(pid)).votersCount);
        ev.eq('PG: four voters on chain', count, 4);
        await live.send('PG setProcessMaxVoters +1 again', () =>
          live.sdk.setProcessMaxVotersStream(pid, count + 1)
        );
        await live.send('PG pause', () => live.sdk.pauseProcessStream(pid));
        await nodeSees('paused', v => v.status === 'paused' && v.maxVoters === count + 1);
        const v8 = await led.submit(
          await mk('V8 new voter, then the cap drops', 8, [4, 3, 2, 1, 6]),
          {
            expect: { status: 200 },
          }
        );
        v8.expectFinal = 'error';
        await live.send('PG setProcessMaxVoters to the count', () =>
          live.sdk.setProcessMaxVotersStream(pid, count)
        );
        await nodeSees(`maxVoters ${count}`, v => v.maxVoters === count);
        await live.send('PG resume', () => live.sdk.resumeProcessStream(pid));
        await nodeSees('ready', v => v.status === 'ready');
        const v2b = await led.submit(await mk('V2 revote after the cap drop', 2, [1, 3, 2, 6, 5]), {
          expect: { status: 200 },
        });
        await settles([v2b]);
        const v8st = await led.waitFor(v8, ['error'], 5 * 60_000);
        ev.log('v8', { status: v8st, error: v8.lastError });

        // ── Shortening inside the notice: refused by the registry ───────
        const raw = new ProcessRegistryService(
          live.sdk.network.processRegistry,
          new VoidSigner(live.wallet.address, live.sdk.provider)
        );
        const now = await live.chainTime();
        const inside = BigInt(now + Math.floor(live.grace.noticeMin / 2) - pg.startTime);
        const events: TxStatusEvent<unknown>[] = [];
        for await (const e of raw.setProcessDuration(pid, inside)) events.push(e);
        const only = events[0];
        ev.eq(
          'PG: shortening inside the notice refused as an eth_call',
          [
            events.map(e => e.status),
            only?.status === TxStatus.Failed
              ? (only.error as ContractServiceError).revertName
              : undefined,
          ],
          [[TxStatus.Failed], 'InvalidDuration']
        );

        // ── The close ───────────────────────────────────────────────────
        await roll.stop();
        let end = await live.endOf(pg);
        if (end - (await live.chainTime()) > 125) end = await live.closeSoon(pg);
        ev.log('end', { end });
        while ((await live.chainTime()) < end - 25) await sleep(3000);
        await led.submit(await mk('V3 revote just before the end', 3, [6, 5, 3, 2, 1]), {
          expect: { status: 200 },
        });
        while ((await live.chainTime()) < end + 3) await sleep(3000);
        await led.submit(await mk('V3 revote after the end', 3, [1, 2, 3, 4, 6]), {
          expect: { status: 412, code: 41201 },
        });
        await sdkReason('after the end', voters[3], [1, 2, 3, 4, 6], 'closed');
        const graceEnd = Number(await live.sdk.registry.getProcessGraceEnd(pid));
        const inGrace = (await live.chainTime()) < graceEnd;
        await led.submit(await mk('V2 revote during the grace window', 2, [1, 2, 3, 4, 6]), {
          expect: { status: 412, code: 41201 },
        });
        ev.check('PG: that vote was sent inside the grace window', inGrace, { graceEnd });

        // ── Results ─────────────────────────────────────────────────────
        await live.waitFinal(pg, 40 * 60_000);
        await led.submit(await mk('V1 revote after the results', 1, [1, 2, 3, 4, 6]), {
          expect: { status: 412, code: 41201 },
        });
        await finalChecks(live, led);
        await countersStill(live, 'caps', before);
      } catch (err) {
        ev.log('error', { error: err instanceof Error ? err.message : String(err) });
        await roll.stop();
        throw err;
      }
    },
    100 * 60_000
  );
});
