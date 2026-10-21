/**
 * @fileoverview Live conformance, CSP census (origin 4), sequencer key: two
 * processes with one CSP key drawn in the test.
 *
 * PA (fixed `maxValueSum`, kept open in flush mode by extending its end):
 * duplicates (twice in a row, 20 at once), a revote while the first ballot is
 * pending and while it is being proved, ten successive revotes against the slot
 * depth, a CSP index given to A, then B, then A again under another index (in
 * separate batches), another voter under two indexes, high-S and v 27/28
 * signatures (vote and CSP), weights 0 to 2^88-1 (2^88 refused), binding
 * checks (another process, address, weight; a proof for another weight; a reused
 * vote id; a PA vote replayed to PB) and hand-modified submissions.
 *
 * PB (`maxValueSum` 0: the weight is the budget, cost exponent 8): weights 0,
 * 1, 2^63-1, 2^63, 2^88-1 and 2^88 at their boundaries.
 *
 * Every process ends in RESULTS; the tally is checked against what the node took.
 */

import { Wallet } from 'ethers';
import { CspCensus } from '../../src/census/classes/CspCensus';
import { DavinciSDK } from '../../src/DavinciSDK';
import { encodeEcdsaSignature, signCspAttestation, signVote } from '../../src/crypto/ecdsa';
import { formatVoteId } from '../../src/sequencer/api/helpers';
import type { BallotMode } from '../../src/core/types/common';
import { DirArtifactCache } from './artifactCache';
import {
  BN254_FQ,
  clone,
  draft,
  processCtx,
  type CspSpec,
  type Draft,
  type DraftSpec,
  type ProcessCtx,
} from './conformance/ballots';
import { counters, countersStill, sdkRefuses, sdkTakes } from './conformance/checks';
import { Ledger, finalChecks, type Sent } from './conformance/ledger';
import { Fatal, Live, RollingEnd, sleep, type Election } from './conformance/live';
import { enabled, settings } from './conformance/settings';

const PA_MODE: BallotMode = {
  numFields: 4,
  groupSize: 2,
  maxValue: '5',
  minValue: '0',
  uniqueValues: false,
  costExponent: 1,
  maxValueSum: '15',
  minValueSum: '0',
};
const PB_MODE: BallotMode = {
  numFields: 4,
  groupSize: 4,
  maxValue: '10',
  minValue: '0',
  uniqueValues: false,
  costExponent: 8,
  maxValueSum: '0',
  minValueSum: '0',
};

const W63 = 1n << 63n;
const W88 = 1n << 88n;

type Body = Record<string, unknown>;
type MkSpec = Omit<DraftSpec, 'csp'> & { index: bigint; csp?: Partial<CspSpec> };
type Point = { x: string; y: string };
type Ct = { c1: Point; c2: Point };

describe.skipIf(!enabled())('live conformance: CSP census', () => {
  let live: Live;

  afterAll(async () => {
    if (!live) return;
    await live.cancelOpen();
    await live.close();
  }, 15 * 60_000);

  it(
    'PA (fixed budget) and PB (weight budget)',
    async () => {
      live = new Live(settings(), 'csp');
      await live.connect();
      const ev = live.ev;
      const csp = Wallet.createRandom();
      const census = new CspCensus(csp.address, 'csp://a5-conformance');
      const before = await counters(live);
      ev.log('counters-before', before);

      const pa = await live.createProcess('PA', {
        census,
        ballot: PA_MODE,
        maxVoters: 40,
        duration: 175,
        metadata: 's2-metadata.json',
        origin: '4 CSP',
      });
      const pb = await live.createProcess('PB', {
        census,
        ballot: PB_MODE,
        maxVoters: 10,
        duration: 20 * 60,
        metadata: 's2-metadata.json',
        origin: '4 CSP',
      });
      const roll = new RollingEnd(live, pa);
      roll.start();
      for (const e of [pa, pb]) {
        const view = await live.waitServed(e);
        ev.eq(
          `${e.label}: node serves the CSP census`,
          [
            (view.census as { censusOrigin: number }).censusOrigin,
            BigInt((view.census as { censusRoot: string }).censusRoot),
          ],
          [4, BigInt(csp.address)]
        );
      }
      const ctxA = await processCtx(live, pa.processId);
      const ctxB = await processCtx(live, pb.processId);
      const la = new Ledger(live, pa);
      const lb = new Ledger(live, pb);
      la.follow();
      lb.follow();

      const mk = (ctx: ProcessCtx, d: MkSpec) =>
        draft(live, ctx, { ...d, csp: { signer: csp, index: d.index, ...d.csp } });
      const voter = () => Wallet.createRandom();

      try {
        // ── PA basics: the SDK's own flow, then hand-built votes ──────────
        await live.pingOrStop('PA basics');
        const v0 = voter();
        const v0sdk = new DavinciSDK({
          signer: v0,
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
                index: 0n,
              }),
          },
        });
        try {
          await v0sdk.init();
          const r0 = await v0sdk.submitVote({ processId: pa.processId, choices: [1, 0, 0, 0] });
          la.record(
            {
              label: 'V0 (SDK submitVote)',
              voteId: r0.voteId,
              slot: 'csp:0',
              choices: [1n, 0n, 0n, 0n],
              weight: 1n,
            },
            { status: 200, ms: 0 }
          );
          ev.check('PA: V0 through the SDK submitVote', true);
        } catch (err) {
          ev.check('PA: V0 through the SDK submitVote', false, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        const basics: [number[], bigint][] = [
          [[1, 2, 3, 4], 1n],
          [[5, 5, 5, 0], 2n],
          [[0, 0, 0, 0], 3n],
          [[2, 2, 2, 2], 4n],
        ];
        for (const [i, [choices, index]] of basics.entries()) {
          sdkTakes(live, ctxA, `PA V${i + 1}`, choices, 1n);
          const d = await mk(ctxA, {
            label: `V${i + 1}`,
            voter: voter(),
            choices,
            weight: 1n,
            index,
          });
          await la.submit(d, { expect: { status: 200 } });
        }
        const view0 = await live.node.process(pa.processId);
        ev.log('batching', {
          processId: pa.processId,
          pendingVotes: view0?.pendingVotes,
          nextSealNotBefore: view0?.nextSealNotBefore,
          now: Math.floor(Date.now() / 1000),
        });
        // Boundaries of PA's mode: cost 15 is the most; 16, or a value over 5, is refused.
        const probe = voter();
        await sdkRefuses(live, ctxA, probe, 'PA one over maxValueSum', [5, 5, 5, 1], 1n);
        await sdkRefuses(live, ctxA, probe, 'PA one over maxValue', [6, 0, 0, 0], 1n);

        // ── A PA vote replayed to PB, then PB's weights ───────────────────
        await live.pingOrStop('PA binding');
        const x = voter();
        const xA = await mk(ctxA, {
          label: 'X',
          voter: x,
          choices: [2, 0, 0, 0],
          weight: 1n,
          index: 40n,
        });
        const toB = clone(xA.body);
        toB.processId = pb.processId;
        await lb.submit(xA, {
          label: 'X: a PA vote sent to PB (attestation for PA)',
          body: toB,
          expect: { status: 400, code: 40002 },
        });
        const xAforB = await mk(ctxA, {
          label: 'X',
          voter: x,
          choices: [2, 0, 0, 0],
          weight: 1n,
          index: 40n,
          proofFrom: xA,
          csp: { processId: pb.processId },
        });
        const toB2 = clone(xAforB.body);
        toB2.processId = pb.processId;
        await lb.submit(xAforB, {
          label: 'X: a PA ballot proof sent to PB (attestation for PB)',
          body: toB2,
          expect: { status: 400, code: 40002 },
        });
        await la.submit(xA, { label: 'X: the vote in PA', expect: { status: 200 } });

        // ── PB: the weight is the budget ──────────────────────────────────
        await live.pingOrStop('PB weights');
        const pbCases: [string, bigint, number[], number[][]][] = [
          ['B weight 0', 0n, [0, 0, 0, 0], [[1, 0, 0, 0]]],
          [
            'B weight 1',
            1n,
            [1, 0, 0, 0],
            [
              [1, 1, 0, 0],
              [2, 0, 0, 0],
            ],
          ],
          ['B weight 2^63-1', W63 - 1n, [10, 10, 10, 10], [[11, 0, 0, 0]]],
          ['B weight 2^63', W63, [10, 0, 0, 0], [[11, 0, 0, 0]]],
          ['B weight 2^88-1', W88 - 1n, [10, 10, 10, 10], [[11, 0, 0, 0]]],
        ];
        let pbIndex = 0n;
        let lastB: Draft | undefined;
        for (const [label, weight, good, bad] of pbCases) {
          const v = voter();
          sdkTakes(live, ctxB, `PB ${label}`, good, weight);
          for (const choices of bad)
            await sdkRefuses(live, ctxB, v, `PB ${label}`, choices, weight);
          lastB = await mk(ctxB, { label, voter: v, choices: good, weight, index: pbIndex++ });
          await lb.submit(lastB, { expect: { status: 200 } });
        }
        // The 89-bit comparator: a weight past 2^63 takes any ballot it covers.
        sdkTakes(live, ctxB, 'PB B weight 2^63', [0, 0, 0, 0], W63);
        sdkTakes(live, ctxB, 'PB B weight 2^88-1', [0, 0, 0, 0], W88 - 1n);
        void lastB;
        const b88 = await mk(ctxB, {
          label: 'B weight 2^88 (ballot proved for 2^63)',
          voter: voter(),
          choices: [10, 0, 0, 0],
          weight: W88,
          proveWeight: W63,
          index: pbIndex++,
        });
        await lb.submit(b88, { expect: { status: 400, code: 40002 } });
        const xB = await mk(ctxB, {
          label: 'X in PB',
          voter: x,
          choices: [1, 0, 0, 0],
          weight: 1n,
          index: 40n,
        });
        await lb.submit(xB, { expect: { status: 200 } });
        await live.closeSoon(pb);

        // ── Ten successive revotes by one voter, in the background ────────
        const t = voter();
        const tVotes: Sent[] = [];
        let slotBusy = 0;
        const tLoop = (async () => {
          for (let i = 1; i <= 10; i++) {
            const d = await mk(ctxA, {
              label: `T revote ${i}`,
              voter: t,
              choices: [i % 6, 0, 0, i % 4],
              weight: 1n,
              index: 14n,
            });
            const deadline = Date.now() + 25 * 60_000;
            for (;;) {
              const a = await live.node.post('/votes', d.body);
              if (a.status === 409 && a.code === 40902 && Date.now() < deadline) {
                slotBusy++;
                ev.log('slot-busy', { label: d.label, error: a.error });
                await sleep(15_000);
                continue;
              }
              const s = la.record(d, a);
              tVotes.push(s);
              break;
            }
          }
        })();

        // ── Duplicates ────────────────────────────────────────────────────
        await live.pingOrStop('PA duplicates');
        const dd = await mk(ctxA, {
          label: 'D first',
          voter: voter(),
          choices: [1, 1, 0, 0],
          weight: 1n,
          index: 10n,
        });
        await la.submit(dd, { expect: { status: 200 } });
        await la.submit(dd, { label: 'D same ballot again', expect: { status: 409, code: 40901 } });

        const de = await mk(ctxA, {
          label: 'E',
          voter: voter(),
          choices: [0, 1, 1, 0],
          weight: 1n,
          index: 11n,
        });
        const answers = await live.throttle.burst('PA E x20', 20, () =>
          live.node.post('/votes', de.body)
        );
        const ok = answers.filter(a => a.status === 200);
        ok.forEach(a => la.record(de, a, 'E (20 at once: the one taken)'));
        answers
          .filter(a => a.status !== 200)
          .forEach((a, i) => la.record(de, a, `E (20 at once: refused ${i + 1})`));
        ev.eq('PA: the same ballot 20 times at once is taken exactly once', ok.length, 1, {
          codes: answers.map(a => a.code ?? a.status),
        });
        ev.check(
          'PA: the other 19 are refused as duplicates (40901) or busy (42903)',
          answers.filter(a => a.status !== 200).every(a => a.code === 40901 || a.code === 42903),
          { codes: answers.map(a => a.code ?? a.status) }
        );

        // Revote while the first is pending.
        const rv = voter();
        const r1 = await la.submit(
          await mk(ctxA, {
            label: 'R first',
            voter: rv,
            choices: [3, 0, 0, 0],
            weight: 1n,
            index: 12n,
          }),
          {
            expect: { status: 200 },
          }
        );
        const r2d = await mk(ctxA, {
          label: 'R revote while pending',
          voter: rv,
          choices: [0, 3, 0, 0],
          weight: 1n,
          index: 12n,
        });
        await la.submit(r2d, { expect: { status: 200 } });
        // Still pending after the revote was taken: it was pending at its admission.
        const r1Status = (await live.node.voteStatus(pa.processId, r1.voteId)).json as {
          status?: string;
        };
        ev.log('revote-while', { which: 'pending', firstStatus: r1Status?.status });
        ev.eq(
          'PA: R first ballot still pending once the revote was taken',
          r1Status?.status,
          'pending'
        );

        // Revote while the first is being proved.
        const pv = voter();
        const p1 = await la.submit(
          await mk(ctxA, {
            label: 'P first',
            voter: pv,
            choices: [0, 0, 4, 0],
            weight: 1n,
            index: 13n,
          }),
          {
            expect: { status: 200 },
          }
        );
        const p2d = await mk(ctxA, {
          label: 'P revote while proving',
          voter: pv,
          choices: [0, 0, 0, 4],
          weight: 1n,
          index: 13n,
        });
        const pAt = await la.waitFor(p1, ['aggregated', 'processed', 'settled'], 8 * 60_000, 1500);
        ev.log('revote-while', { which: 'proving', firstStatus: pAt });
        await la.submit(p2d, { expect: { status: 200 } });
        ev.eq(
          'PA: P first ballot was in a batch being proved when the revote was sent',
          pAt,
          'aggregated'
        );

        // ── A CSP index for A, then B, then A under another index ─────────
        await live.pingOrStop('PA CSP indexes');
        const a = voter();
        const b = voter();
        const a1 = await la.submit(
          await mk(ctxA, {
            label: 'A at index 100',
            voter: a,
            choices: [1, 0, 0, 0],
            weight: 1n,
            index: 100n,
          }),
          {
            expect: { status: 200 },
          }
        );
        ev.eq(
          'PA: A at index 100 settles',
          await la.waitFor(a1, ['settled'], 10 * 60_000),
          'settled'
        );
        const b1 = await la.submit(
          await mk(ctxA, {
            label: 'B at index 100',
            voter: b,
            choices: [0, 2, 0, 0],
            weight: 1n,
            index: 100n,
          }),
          {
            expect: { status: 200 },
          }
        );
        ev.eq(
          'PA: B at index 100 settles',
          await la.waitFor(b1, ['settled'], 10 * 60_000),
          'settled'
        );
        const a2 = await la.submit(
          await mk(ctxA, {
            label: 'A at index 101',
            voter: a,
            choices: [0, 0, 3, 0],
            weight: 1n,
            index: 101n,
          }),
          {
            expect: { status: 200 },
          }
        );
        const c = voter();
        await la.submit(
          await mk(ctxA, {
            label: 'C at index 200',
            voter: c,
            choices: [0, 0, 0, 1],
            weight: 1n,
            index: 200n,
          }),
          {
            expect: { status: 200 },
          }
        );
        await la.submit(
          await mk(ctxA, {
            label: 'C at index 201',
            voter: c,
            choices: [0, 0, 0, 2],
            weight: 1n,
            index: 201n,
          }),
          {
            expect: { status: 200 },
          }
        );

        // ── Signature spellings (documented as accepted) ──────────────────
        await live.pingOrStop('PA spellings');
        const spellings: [string, Partial<DraftSpec>, Partial<CspSpec>, bigint][] = [
          ['H1 vote-id signature high-S', { sigSpelling: 'high-s' }, {}, 20n],
          ['H2 vote-id signature v 27/28', { sigSpelling: 'v27' }, {}, 21n],
          ['H3 CSP signature high-S', {}, { spelling: 'high-s' }, 22n],
          ['H4 CSP recid 27/28', {}, { spelling: 'v27' }, 23n],
        ];
        for (const [label, extra, cspExtra, index] of spellings) {
          const d = await mk(ctxA, {
            label,
            voter: voter(),
            choices: [0, 1, 0, 1],
            weight: 1n,
            index,
            ...extra,
            csp: cspExtra,
          });
          await la.submit(d, { expect: { status: 200 } });
        }

        // ── Weights with a fixed maxValueSum ──────────────────────────────
        const weights: [string, bigint, bigint][] = [
          ['W weight 0', 0n, 30n],
          ['W weight 1', 1n, 31n],
          ['W weight 2^63-1', W63 - 1n, 32n],
          ['W weight 2^63', W63, 33n],
          ['W weight 2^88-1', W88 - 1n, 34n],
        ];
        let lastW: Draft | undefined;
        for (const [label, weight, index] of weights) {
          sdkTakes(live, ctxA, `PA ${label}`, [1, 1, 1, 1], weight);
          lastW = await mk(ctxA, { label, voter: voter(), choices: [1, 1, 1, 1], weight, index });
          await la.submit(lastW, { expect: { status: 200 } });
        }
        void lastW;
        const w88 = await mk(ctxA, {
          label: 'W weight 2^88 (ballot proved for 2^88-1)',
          voter: voter(),
          choices: [1, 1, 1, 1],
          weight: W88,
          proveWeight: W88 - 1n,
          index: 35n,
        });
        await la.submit(w88, { expect: { status: 400, code: 40002 } });

        // ── Binding ───────────────────────────────────────────────────────
        const y = voter();
        const y1 = await mk(ctxA, {
          label: 'Y',
          voter: y,
          choices: [1, 0, 0, 0],
          weight: 1n,
          index: 41n,
        });
        await la.submit(y1, { expect: { status: 200 } });
        const y2 = await mk(ctxA, {
          label: 'Y: its vote id with another ballot',
          voter: y,
          choices: [0, 1, 0, 0],
          weight: 1n,
          index: 41n,
          k: y1.k,
        });
        ev.eq('PA: Y reused k gives the same vote id', y2.voteId, y1.voteId);
        await la.submit(y2, { expect: { status: 409, code: 40901 } });

        const z = voter();
        const zOther = voter();
        const zCases: [string, Partial<DraftSpec>, Partial<CspSpec>][] = [
          ['Z: attestation for PB', {}, { processId: pb.processId }],
          ['Z: attestation for another address', {}, { address: zOther.address }],
          ['Z: attestation for weight 2, vote weight 1', {}, { weight: 2n }],
          [
            'Z: ballot proved for weight 1, sent with weight 2 and its attestation',
            { weight: 2n, proveWeight: 1n },
            {},
          ],
          ['Z: attestation under index 43 sent as index 42', {}, {}],
        ];
        for (const [label, extra, cspExtra] of zCases) {
          const d = await mk(ctxA, {
            label,
            voter: z,
            choices: [0, 0, 1, 0],
            weight: 1n,
            index: 42n,
            ...extra,
            csp: cspExtra,
          });
          let body = d.body;
          if (label.includes('index 43')) {
            const signed = await mk(ctxA, {
              label,
              voter: z,
              choices: [0, 0, 1, 0],
              weight: 1n,
              index: 43n,
              proofFrom: d,
            });
            body = clone(signed.body);
            (body.censusProof as Body).index = 42;
          }
          await la.submit(d, { label, body, expect: { status: 400, code: 40002 } });
        }
        await la.submit(
          await mk(ctxA, {
            label: 'Z: valid',
            voter: z,
            choices: [0, 0, 1, 0],
            weight: 1n,
            index: 42n,
          }),
          {
            expect: { status: 200 },
          }
        );

        // ── Hand-modified submissions ─────────────────────────────────────
        await live.pingOrStop('PA tampering');
        const m = voter();
        const md = await mk(ctxA, {
          label: 'M',
          voter: m,
          choices: [2, 1, 0, 0],
          weight: 1n,
          index: 44n,
        });
        const tamper: [string, (b: Body) => void][] = [
          [
            'M: c1 and c2 of field 0 swapped',
            body => {
              const ct = (body.ballot as Ct[])[0];
              [ct.c1, ct.c2] = [ct.c2, ct.c1];
            },
          ],
          [
            'M: ciphertexts of fields 0 and 1 swapped',
            body => {
              const bl = body.ballot as Ct[];
              [bl[0], bl[1]] = [bl[1], bl[0]];
            },
          ],
          [
            'M: field 5 (past numFields) not the identity',
            body => {
              const bl = body.ballot as Ct[];
              bl[5] = clone(bl[0]);
            },
          ],
          [
            'M: proof pi_a negated',
            body => {
              const pi = (body.ballotProof as { pi_a: string[] }).pi_a;
              pi[1] = (BN254_FQ - BigInt(pi[1])).toString();
            },
          ],
          [
            'M: proof pi_a.x plus the field modulus (non-canonical)',
            body => {
              const pi = (body.ballotProof as { pi_a: string[] }).pi_a;
              pi[0] = (BigInt(pi[0]) + BN254_FQ).toString();
            },
          ],
          [
            'M: proof pi_c replaced by pi_a',
            body => {
              const pr = body.ballotProof as { pi_a: string[]; pi_c: string[] };
              pr.pi_c = [...pr.pi_a];
            },
          ],
        ];
        for (const [label, f] of tamper) {
          const body = clone(md.body);
          f(body);
          const code = label.includes('non-canonical') ? undefined : 40002;
          await la.submit(md, { label, body, expect: { status: 400, code } });
        }
        // The vote id changed, with the voter's signature over the new id.
        const vid2 = BigInt(md.voteId) ^ 1n;
        const sig2 = encodeEcdsaSignature(await signVote(m, md.processId, vid2, md.built.ballot));
        const changed = clone(md.body);
        changed.voteId = formatVoteId(vid2);
        changed.signature = sig2;
        await la.submit(
          { ...md, voteId: formatVoteId(vid2) },
          {
            label: 'M: vote id changed, signed',
            body: changed,
            expect: { status: 400, code: 40002 },
          }
        );
        // Another address, with that voter's signature and attestation.
        const other = voter();
        const asOther = await mk(ctxA, {
          label: 'M: sent as another voter',
          voter: other,
          choices: [2, 1, 0, 0],
          weight: 1n,
          index: 44n,
          proofFrom: md,
        });
        await la.submit(asOther, { expect: { status: 400, code: 40002 } });
        await la.submit(md, { label: 'M: unmodified', expect: { status: 200 } });

        // ── Wait for the revotes, then let PA end ─────────────────────────
        await tLoop;
        ev.eq(
          'PA: T ten successive revotes all taken (after 40902 retries)',
          tVotes.filter(s => s.accepted).length,
          10,
          {
            slotBusy,
            codes: tVotes.map(s => s.code ?? s.status),
          }
        );
        ev.check('PA: T revotes past the slot depth were refused with 40902 first', slotBusy > 0, {
          slotBusy,
        });
        ev.eq('PA: A index 101 settles', await la.waitFor(a2, ['settled'], 10 * 60_000), 'settled');
        for (const [label, addr] of [
          ['A', a.address],
          ['B', b.address],
          ['never voted', voter().address],
        ] as const) {
          const got = await live.node.get(`/votes/${pa.processId}/address/${addr}`);
          ev.log('slot-ballot', { label, status: got.status, code: got.code });
        }
        ev.eq(
          'PA: GET /votes/{pid}/address for A, B and a non-voter',
          await Promise.all(
            [a.address, b.address, voter().address].map(
              async ad => (await live.node.get(`/votes/${pa.processId}/address/${ad}`)).status
            )
          ),
          [200, 200, 404]
        );
        await roll.stop();
        ev.log('rolling', { extensions: roll.extensions, end: await live.endOf(pa) });
        await live.pingOrStop('PA closing');

        // ── Results ───────────────────────────────────────────────────────
        for (const [e, l] of [
          [pa, la],
          [pb, lb],
        ] as [Election, Ledger][]) {
          await live.waitFinal(e, 40 * 60_000);
          await finalChecks(live, l);
        }
        await countersStill(live, 'csp', before);
      } catch (err) {
        ev.log('error', { error: err instanceof Error ? err.message : String(err) });
        if (err instanceof Fatal) ev.say(`FATAL ${err.message}`);
        await roll.stop();
        throw err;
      }
    },
    120 * 60_000
  );
});
