/**
 * @fileoverview Live conformance, after the fact: rebuilds what the node accepted
 * and refused for every process of a run from its evidence (the `vote` lines of
 * `<DAVINCI_CONFORMANCE_DIR>/<scenario>.jsonl`) and runs the end-of-process checks
 * once each process reaches RESULTS or CANCELED: every accepted vote at its final
 * status with a verifying receipt, refused ids absent, the on-chain tally and
 * counters equal to the accepted votes, the node's view and transitions equal to
 * the chain. Needs no secret: the votes are identified by id. Used when a scenario
 * process stopped before its own checks (`DAVINCI_CONFORMANCE_RECHECK` lists the
 * scenarios, comma-separated).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProcessStatus } from '../../src/contracts/types';
import { Ledger, finalChecks } from './conformance/ledger';
import { Live, type Election } from './conformance/live';
import { enabled, settings } from './conformance/settings';

interface VoteLine {
  kind: string;
  processId: string;
  label: string;
  voteId: string;
  slot: string;
  choices: string[];
  weight: string;
  status: number;
  code?: number;
  error?: string;
}

interface ProcessLine {
  label: string;
  processId: string;
  origin: string;
}

describe.skipIf(!enabled() || !process.env.DAVINCI_CONFORMANCE_RECHECK)(
  'live conformance: recheck',
  () => {
    let live: Live;

    afterAll(async () => {
      if (live) await live.close();
    });

    it(
      'end-of-process checks from the evidence',
      async () => {
        const s = settings();
        live = new Live(s, 'recheck');
        await live.connect();
        const scenarios = (process.env.DAVINCI_CONFORMANCE_RECHECK ?? '')
          .split(',')
          .filter(Boolean);
        const processes = readFileSync(join(s.dir, 'processes.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(l => JSON.parse(l) as ProcessLine);
        for (const scenario of scenarios) {
          const file = join(s.dir, `${scenario}.jsonl`);
          if (!existsSync(file)) throw new Error(`no evidence for ${scenario}`);
          const lines = readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(l => JSON.parse(l) as VoteLine);
          const pids = [...new Set(lines.filter(l => l.kind === 'vote').map(l => l.processId))];
          for (const pid of pids) {
            const meta = processes.find(p => p.processId === pid);
            const onchain = await live.sdk.registry.getProcess(pid);
            const e: Election = {
              label: `${meta?.label ?? pid} (recheck)`,
              processId: pid,
              startTime: Number(onchain.startTime),
              creationBlock: Number(onchain.creationBlock),
              origin: meta?.origin ?? '?',
              mode: {
                ...onchain.ballotMode,
                maxValue: '',
                minValue: '',
                maxValueSum: '',
                minValueSum: '',
              },
            };
            const led = new Ledger(live, e);
            for (const v of lines.filter(l => l.kind === 'vote' && l.processId === pid)) {
              led.record(
                {
                  label: v.label,
                  voteId: v.voteId,
                  slot: v.slot,
                  choices: v.choices.map(BigInt),
                  weight: BigInt(v.weight),
                },
                { status: v.status, code: v.code, error: v.error, ms: 0 }
              );
            }
            live.ev.say(
              `${e.label}: ${led.accepted.length} accepted, ${led.sent.length - led.accepted.length} refused`
            );
            const p = await live.waitFinal(e, 45 * 60_000);
            const canceled = p.status === ProcessStatus.CANCELED;
            if (canceled) for (const a of led.accepted) a.expectFinal = 'error';
            await finalChecks(live, led, { canceled });
          }
        }
      },
      120 * 60_000
    );
  }
);
