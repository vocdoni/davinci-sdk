/**
 * @fileoverview Live conformance: `POST /processes/keys` (docs/api.md,
 * docs/security.md "Election keys are derived, not stored"). The key is a pure
 * function of the process id: the same id gives the same key, it equals the
 * on-chain key of every sequencer-key process the node issued, and any other id
 * (another organizer's, a random one) gets a key too, stored nowhere. The
 * per-IP limit (`--keys-per-minute`, 10 by default) is reached once: run this
 * file when no process is being created, since creations ask for keys too.
 */

import { ZeroAddress, hexlify, randomBytes } from 'ethers';
import { KeyMode } from '../../src/contracts/types';
import { isValidEncryptionKey } from '../../src/crypto/babyjubjub';
import { computeProcessId } from '../../src/networks';
import { Live, sleep } from './conformance/live';
import { enabled, settings } from './conformance/settings';

type Key = { x: string; y: string };

/** Another organizer: the account the SDK live suite runs as (its s1 is a sequencer-key process). */
const OTHER_CREATOR = '0x470d1ddc7ddceb0d818751d171d40366f010a3cc';

describe.skipIf(!enabled())('live conformance: election keys', () => {
  let live: Live;

  afterAll(async () => {
    if (live) await live.close();
  });

  it(
    'POST /processes/keys',
    async () => {
      live = new Live(settings(), 'keys');
      await live.connect();
      const ev = live.ev;
      const key = async (body: unknown) => live.node.post('/processes/keys', body as object);
      const asKey = (j: unknown) => j as Key;

      // Window 1: determinism (at most 9 requests).
      const nonce = Number(await live.sdk.registry.getProcessNonce(live.wallet.address));
      const mine = Array.from({ length: nonce }, (_, i) =>
        computeProcessId(live.wallet.address, live.sdk.network.processIdPrefix, i)
      );
      const other = computeProcessId(OTHER_CREATOR, live.sdk.network.processIdPrefix, 0);
      const pids = [...mine.slice(0, 6), other];
      for (const pid of pids) {
        // The other organizer's process exists once the live suite ran on this registry.
        const p = await live.sdk.registry.getProcess(pid).catch(() => undefined);
        if (!p || p.organizationId === ZeroAddress || p.keyMode !== KeyMode.Sequencer) continue;
        const a = await key({ processId: pid });
        ev.eq(`keys: ${pid} equals its on-chain key`, a.status === 200 ? asKey(a.json) : a, {
          x: p.encryptionKey.x.toString(),
          y: p.encryptionKey.y.toString(),
        });
      }
      const random = hexlify(randomBytes(31));
      const r1 = await key({ processId: random });
      const r2 = await key({ processId: random });
      ev.eq('keys: a random process id gets the same key twice', r1.json, r2.json);
      const k = asKey(r1.json);
      ev.check(
        'keys: the random id key is a subgroup point other than the identity',
        r1.status === 200 && isValidEncryptionKey({ x: BigInt(k.x), y: BigInt(k.y) }),
        { status: r1.status }
      );

      // Window 2: the limit, reached once. Malformed bodies take a token too.
      await sleep(62_000);
      const answers: { status: number; code?: number }[] = [];
      const malformed: unknown[] = [{ processId: '0x1234' }, { processId: random, extra: 1 }, {}];
      for (const m of malformed) {
        const a = await key(m);
        answers.push({ status: a.status, code: a.code });
        ev.eq(`keys: malformed body ${JSON.stringify(m).slice(0, 60)} -> 40001`, a.code, 40001);
      }
      let limited = false;
      for (let i = 0; i < 12 && !limited; i++) {
        const a = await key({ processId: hexlify(randomBytes(31)) });
        answers.push({ status: a.status, code: a.code });
        limited = a.code === 42901;
      }
      const taken = answers.filter(a => a.status === 200).length;
      ev.log('key-window', { answers });
      ev.check('keys: the per-minute limit answers 42901', limited, { answers });
      ev.eq('keys: requests answered before 42901 (malformed included)', answers.length - 1, 10, {
        taken,
      });
      await sleep(62_000);
      const after = await key({ processId: random });
      ev.eq('keys: a new minute takes requests again', after.status, 200);
    },
    10 * 60_000
  );
});
