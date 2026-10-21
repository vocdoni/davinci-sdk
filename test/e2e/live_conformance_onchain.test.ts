/**
 * @fileoverview Live conformance: an on-chain census (origin 3), sequencer key.
 * The organizer deploys an `OwnedCensus` with three members; a fourth joins while
 * voting runs. Ballots of 16 fields, unique values, cost exponent 2 and a
 * `minValueSum` above zero. Checks: the node proves each member's weight and none
 * for a non-member; a non-member's vote is refused; the late member votes once the
 * node indexes it; a client census proof (for the older root, malformed, or of the
 * other type) is ignored, as documented; a vote with another weight is refused;
 * votes validated under the first root seal under the second; the tally.
 */

import { Wallet, type BaseWallet } from 'ethers';
import { OnchainCensus } from '../../src/census/classes/OnchainCensus';
import { OnchainCensusService } from '../../src/contracts/OnchainCensusService';
import type { BallotMode } from '../../src/core/types/common';
import { VoteError } from '../../src/core/vote/errors';
import { DavinciSDK } from '../../src/DavinciSDK';
import { DirArtifactCache } from './artifactCache';
import { deployOwnedCensus } from './census';
import { clone, draft, processCtx } from './conformance/ballots';
import { counters, countersStill, sdkRefuses, sdkTakes } from './conformance/checks';
import { Ledger, finalChecks } from './conformance/ledger';
import { Live, sleep } from './conformance/live';
import { enabled, settings } from './conformance/settings';

const PC_MODE: BallotMode = {
  numFields: 16,
  groupSize: 16,
  maxValue: '16',
  minValue: '0',
  uniqueValues: true,
  costExponent: 2,
  maxValueSum: '1271',
  minValueSum: '1241',
};

/** 0..14 and 16: cost 1271, the most; rotated per voter. */
const BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16];
const perm = (shift: number) => BASE.map((_, i) => BASE[(i + shift) % 16]);

interface Participant {
  weight: string;
  censusProof: { root: string; leaf: string; pathBits: number; siblings: string[] };
}

describe.skipIf(!enabled())('live conformance: on-chain census', () => {
  let live: Live;

  afterAll(async () => {
    if (!live) return;
    await live.cancelOpen();
    await live.close();
  }, 15 * 60_000);

  it(
    'PC',
    async () => {
      live = new Live(settings(), 'onchain');
      await live.connect();
      const ev = live.ev;
      const before = await counters(live);
      const members = Array.from({ length: 4 }, () => Wallet.createRandom());
      const weights = [1, 2, 3, 4];
      const deployed = await live.org.exclusive(() =>
        deployOwnedCensus(live.wallet, (label, hash) => {
          live.org.record(`PC ${label}`, hash);
          ev.log('tx', { label: `PC ${label}`, hash });
        })
      );
      ev.say(`PC: OwnedCensus ${deployed.address}`);
      const contract = new OnchainCensusService(deployed.address, live.wallet);
      await live.send('PC addMembers', () =>
        contract.addMembers(
          members.slice(0, 3).map(w => w.address),
          weights.slice(0, 3)
        )
      );
      const pc = await live.createProcess('PC', {
        census: new OnchainCensus(deployed.address),
        ballot: PC_MODE,
        maxVoters: 10,
        duration: 20 * 60,
        metadata: 's4-metadata.json',
        origin: '3 contract',
      });
      const pid = pc.processId;
      await live.waitServed(pc);
      const ctx = await processCtx(live, pid);
      const led = new Ledger(live, pc);
      const participant = async (a: string) => live.node.get(`/processes/${pid}/participants/${a}`);
      const mk = (label: string, v: BaseWallet, weight: number, choices: number[]) =>
        draft(live, ctx, { label, voter: v, choices, weight: BigInt(weight) });

      try {
        // ── The node indexes the contract ───────────────────────────────
        let proofs: Participant[] = [];
        for (let i = 0; i < 40; i++) {
          const got = await Promise.all(members.slice(0, 3).map(m => participant(m.address)));
          if (got.every(a => a.status === 200)) {
            proofs = got.map(a => a.json as Participant);
            break;
          }
          await sleep(5000);
        }
        ev.eq(
          'PC: the node proves each member with its weight',
          proofs.map(p => p.weight),
          ['1', '2', '3']
        );
        const r1 = proofs[0]?.censusProof.root;
        const outsider = Wallet.createRandom();
        const nonMember = await participant(outsider.address);
        ev.eq('PC: no proof for a non-member', nonMember.code, 40401);

        // ── Boundaries of the 16-field mode ─────────────────────────────
        sdkTakes(live, ctx, 'PC a permutation of 0..14,16 (cost 1271)', perm(0), 1n);
        const probe = Wallet.createRandom();
        await sdkRefuses(live, ctx, probe, 'PC below minValueSum', [...Array(16).keys()], 1n);
        await sdkRefuses(
          live,
          ctx,
          probe,
          'PC above maxValueSum',
          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16],
          1n
        );
        await sdkRefuses(
          live,
          ctx,
          probe,
          'PC a repeated value',
          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 14],
          1n
        );
        await sdkRefuses(
          live,
          ctx,
          probe,
          'PC above maxValue',
          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17],
          1n
        );

        // ── Votes under the first root ──────────────────────────────────
        await live.pingOrStop('PC first root');
        led.follow(3000);
        await led.submit(await mk('M1', members[0], 1, perm(1)), { expect: { status: 200 } });
        await led.submit(await mk('M2', members[1], 2, perm(2)), { expect: { status: 200 } });
        await led.submit(await mk('N non-member', outsider, 1, perm(3)), {
          expect: { status: 400, code: 40001 },
        });
        const outSdk = new DavinciSDK({
          signer: outsider,
          network: 'optimism',
          sequencerUrls: [live.settings.node],
          rpcUrls: live.settings.rpcUrls,
          artifacts: { cache: new DirArtifactCache(live.settings.artifactsDir) },
        });
        await outSdk.init();
        const why = await outSdk.submitVote({ processId: pid, choices: perm(3) }).then(
          r => `taken ${r.voteId}`,
          (err: unknown) => (err instanceof VoteError ? err.reason : String(err))
        );
        ev.eq('PC: SDK submitVote of a non-member', why, 'not-in-census');
        await led.submit(await mk('M1 with weight 2 (census weight 1)', members[0], 2, perm(4)), {
          expect: { status: 400, code: 40002 },
        });

        // ── A member joins while voting runs ────────────────────────────
        await live.send('PC addMember', () => contract.addMember(members[3].address, weights[3]));
        let late: Participant | undefined;
        for (let i = 0; i < 60; i++) {
          const a = await participant(members[3].address);
          if (a.status === 200) {
            late = a.json as Participant;
            break;
          }
          await sleep(5000);
        }
        ev.eq('PC: the node proves the late member', late?.weight, '4');
        const r2 = late?.censusProof.root;
        ev.check('PC: the census root moved', r2 !== undefined && r2 !== r1, { r1, r2 });
        await led.submit(await mk('M4 (joined while voting runs)', members[3], 4, perm(5)), {
          expect: { status: 200 },
        });

        // Client census proofs are ignored for a Merkle census.
        const m3 = await mk('M3 with its proof for the older root', members[2], 3, perm(6));
        const withOld = clone(m3.body);
        withOld.censusProof = { type: 'merkle', ...proofs[2].censusProof };
        await led.submit(m3, { body: withOld, expect: { status: 200 } });
        const m2b = await mk(
          'M2 revote with a malformed proof (leaf >= 2^248)',
          members[1],
          2,
          perm(7)
        );
        const bad = clone(m2b.body);
        bad.censusProof = {
          type: 'merkle',
          root: `0x${'ff'.repeat(32)}`,
          leaf: `0x${'ff'.repeat(32)}`,
          pathBits: 0,
          siblings: [],
        };
        await led.submit(m2b, { body: bad, expect: { status: 200 } });
        const m1b = await mk('M1 revote with a CSP-type proof', members[0], 1, perm(8));
        const csp = clone(m1b.body);
        csp.censusProof = {
          type: 'csp',
          r: `0x${'11'.repeat(32)}`,
          s: `0x${'22'.repeat(32)}`,
          recid: 0,
          index: 0,
        };
        await led.submit(m1b, { body: csp, expect: { status: 200 } });

        // The SDK's own flow for an on-chain member.
        const m4sdk = new DavinciSDK({
          signer: members[3],
          network: 'optimism',
          sequencerUrls: [live.settings.node],
          rpcUrls: live.settings.rpcUrls,
          artifacts: { cache: new DirArtifactCache(live.settings.artifactsDir) },
        });
        await m4sdk.init();
        try {
          const r = await m4sdk.submitVote({ processId: pid, choices: perm(9) });
          led.record(
            {
              label: 'M4 revote (SDK submitVote)',
              voteId: r.voteId,
              slot: `addr:${members[3].address.toLowerCase()}`,
              choices: perm(9).map(BigInt),
              weight: 4n,
            },
            { status: 200, ms: 0 }
          );
          ev.eq('PC: SDK submitVote of the late member carries its weight', r.weight, 4n);
        } catch (err) {
          ev.check('PC: SDK submitVote of the late member', false, {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // ── Close, results ──────────────────────────────────────────────
        await live.pingOrStop('PC close');
        await live.closeSoon(pc);
        await live.waitFinal(pc, 40 * 60_000);
        await finalChecks(live, led);
        await countersStill(live, 'onchain', before);
      } catch (err) {
        ev.log('error', { error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
    120 * 60_000
  );
});
