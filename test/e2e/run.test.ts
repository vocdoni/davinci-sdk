/**
 * @fileoverview The live suite's `run` phase (`DAVINCI_SDK_E2E=run`): eight
 * elections on the Gnosis deployment, concurrently, one process each, through
 * the sequencer nodes of `DAVINCI_E2E_NODES` (see test/e2e/README.md). Before
 * anything is created it checks the committed fixtures against the voter keys
 * and against what `DAVINCI_SDK_E2E_BASE_URL` serves, the registry pins, the
 * nodes and the organizer's funds. It ends with a table of the scenarios and
 * the organizer's gas bill; after a failure it cancels what it left open.
 */

import { phase, redactError, runSettings, say } from './env';
import type { Row } from './report';
import { connect, finish, type Live } from './live/context';
import { s1 } from './live/s1';
import { s2 } from './live/s2';
import { s3 } from './live/s3';
import { s4 } from './live/s4';
import { s5 } from './live/s5';
import { s6 } from './live/s6';
import { s7 } from './live/s7';
import { s8 } from './live/s8';

interface Scenario {
  name: string;
  keyMode: string;
  origin: string;
  run: (live: Live, row: Row) => Promise<void>;
}

const SCENARIOS: Scenario[] = [
  { name: 's1 static census', keyMode: 'sequencer', origin: '1 static', run: s1 },
  { name: 's2 CSP census', keyMode: 'sequencer', origin: '4 CSP', run: s2 },
  { name: 's3 updatable census', keyMode: 'sequencer', origin: '2 updatable', run: s3 },
  { name: 's4 on-chain census', keyMode: 'sequencer', origin: '3 contract', run: s4 },
  { name: 's5 committee key', keyMode: 'dkg', origin: '1 static', run: s5 },
  { name: 's6 locked committee key', keyMode: 'dkg-locked', origin: '1 static', run: s6 },
  { name: 's7 metadata', keyMode: 'sequencer', origin: '1 static', run: s7 },
  { name: 's8 organizer refusals', keyMode: 'sequencer', origin: '1 static', run: s8 },
];

/** The longest a scenario may take: settling, the grace window, results and the DKG. */
const SCENARIO_TIMEOUT_MS = 60 * 60_000;

describe.skipIf(phase() !== 'run')('live e2e on Gnosis', () => {
  let live: Live | undefined;
  const rows: Row[] = [];

  beforeAll(async () => {
    live = await connect(runSettings()).catch((err: unknown) => {
      throw redactError(err);
    });
  }, 15 * 60_000);

  afterAll(async () => {
    await finish(live, rows);
  }, 30 * 60_000);

  for (const s of SCENARIOS) {
    it.concurrent(
      s.name,
      async () => {
        if (!live) throw new Error('not connected');
        const row: Row = {
          scenario: s.name,
          keyMode: s.keyMode,
          origin: s.origin,
          result: 'running',
          duration: 0,
        };
        rows.push(row);
        const t0 = Date.now();
        try {
          await s.run(live, row);
          row.result = 'pass';
        } catch (err) {
          const e = redactError(err);
          row.result = `FAIL: ${e.message}`;
          say(`${s.name}: ${row.result}`);
          throw e;
        } finally {
          row.duration = Date.now() - t0;
        }
      },
      SCENARIO_TIMEOUT_MS
    );
  }
});
