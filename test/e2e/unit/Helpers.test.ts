import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, sha256, type Provider } from 'ethers';
import { TxStatus, type TxStatusEvent } from '../../../src/contracts/SmartContractService';
import censusSource from '../../../src/contracts/abi/census/source.json';
import { GNOSIS } from '../../../src/networks';
import { DirArtifactCache } from '../artifactCache';
import {
  CENSUS_CONTRACT_COMMIT,
  POSEIDON_T3_ADDRESS,
  isPoseidonT3,
  linkOwnedCensus,
} from '../census';
import vendored from '../contracts/census.json';
import { phase, redact, redactError, runSettings } from '../env';
import { KEY_REQUESTS_PER_MINUTE, Organizer, formatBill } from '../organizer';
import { formatTable } from '../report';

describe('the circuit file cache', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sdk-e2e-cache-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps files by sha256 on disk and shares one copy in memory', () => {
    const data = new Uint8Array([1, 2, 3]);
    const hash = sha256(data);
    const cache = new DirArtifactCache(dir);
    expect(cache.get(hash)).toBeUndefined();
    cache.set(hash, data);
    expect(cache.get(hash)).toBe(data);
    expect(new Uint8Array(readFileSync(join(dir, hash.slice(2))))).toEqual(data);

    const later = new DirArtifactCache(dir);
    const read = later.get(hash.toUpperCase().replace('0X', '0x'));
    expect(read).toEqual(data);
    expect(later.get(hash)).toBe(read);
    expect(() => later.get('0x12')).toThrow(/not a sha256/);
  });

  it('hands back whatever is on disk: the SDK checks it again', () => {
    const hash = sha256(new Uint8Array([9]));
    writeFileSync(join(dir, hash.slice(2)), 'damaged');
    expect(new DirArtifactCache(dir).get(hash)).toEqual(new Uint8Array(Buffer.from('damaged')));
  });
});

describe("the live suite's census contract", () => {
  it('is vendored from the commit of the census ABIs, with PoseidonT3 at its usual address', () => {
    expect(CENSUS_CONTRACT_COMMIT).toBe(censusSource.commit);
    expect(getAddress(POSEIDON_T3_ADDRESS)).toBe(POSEIDON_T3_ADDRESS);
  });

  it('links PoseidonT3 into OwnedCensus where the build says', () => {
    const library = '0x00000000000000000000000000000000000000ab';
    const code = linkOwnedCensus(library);
    const at =
      2 +
      vendored.contracts.OwnedCensus.linkReferences[
        'lib/poseidon-solidity/contracts/PoseidonT3.sol'
      ].PoseidonT3[0].start *
        2;
    expect(code.slice(at, at + 40)).toBe(library.slice(2).toLowerCase());
    expect(code).not.toMatch(/__\$/);
    expect(code.length).toBe(vendored.contracts.OwnedCensus.bytecode.length);
    expect(() => linkOwnedCensus('0x12')).toThrow();
  });

  it('recognizes PoseidonT3 only by its runtime code', () => {
    expect(isPoseidonT3('0x')).toBe(false);
    expect(isPoseidonT3(`0x73${'11'.repeat(20)}3014`)).toBe(false);
  });
});

// A stream of the given events.
async function* events<T>(...list: TxStatusEvent<T>[]): AsyncGenerator<TxStatusEvent<T>> {
  for (const e of list) {
    await Promise.resolve();
    yield e;
  }
}

describe('the organizer queue', () => {
  it('runs one job at a time, in order, whatever the earlier one did', async () => {
    const org = new Organizer();
    const log: string[] = [];
    const job = (name: string, ms: number, fail = false) =>
      org.exclusive(async () => {
        log.push(`${name} start`);
        await new Promise(ok => setTimeout(ok, ms));
        log.push(`${name} end`);
        if (fail) throw new Error(name);
        return name;
      });
    const results = await Promise.allSettled([job('a', 30, true), job('b', 5), job('c', 1)]);
    expect(log).toEqual(['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
    expect(results.map(r => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
  });

  it('records every transaction sent and returns the result', async () => {
    const org = new Organizer();
    const done = await org.send('create', () =>
      events(
        { status: TxStatus.Pending, hash: '0x01' },
        { status: TxStatus.Pending, hash: '0x02', step: 'setProcessGrace' },
        { status: TxStatus.Completed, response: 7 }
      )
    );
    expect(done).toBe(7);
    expect(org.sent).toEqual([
      { label: 'create', hash: '0x01' },
      { label: 'create (setProcessGrace)', hash: '0x02' },
    ]);
    const failed = new Error('refused');
    await expect(
      org.send('x', () => events<number>({ status: TxStatus.Failed, error: failed }))
    ).rejects.toBe(failed);
    await expect(
      org.send('y', () =>
        events<number>({ status: TxStatus.Pending, hash: '0x03' }, { status: TxStatus.Reverted })
      )
    ).rejects.toThrow(/y reverted/);
    await expect(org.send('z', () => events<number>())).rejects.toThrow(/without a result/);
    expect(org.sent.map(s => s.hash)).toEqual(['0x01', '0x02', '0x03']);
  });

  it('keeps key requests under the per-minute limit', async () => {
    let now = 0;
    const waits: number[] = [];
    const org = new Organizer({
      now: () => now,
      sleep: ms => {
        waits.push(ms);
        now += ms;
        return Promise.resolve();
      },
    });
    const keyed = () =>
      org.sendWithKey('create', () => events({ status: TxStatus.Completed, response: now }));
    const times: number[] = [];
    for (let i = 0; i < KEY_REQUESTS_PER_MINUTE; i++) {
      times.push(await keyed());
      now += 1_000;
    }
    expect(waits).toEqual([]);
    times.push(await keyed());
    expect(waits).toHaveLength(1);
    expect(times[KEY_REQUESTS_PER_MINUTE] - times[0]).toBeGreaterThan(60_000);
  });

  it('bills gas from the receipts', async () => {
    const org = new Organizer();
    org.record('create', '0xaa');
    org.record('lost', '0xbb');
    const provider = {
      getTransactionReceipt: (hash: string) =>
        Promise.resolve(
          hash === '0xaa' ? { gasUsed: 100_000n, gasPrice: 2_000_000_000n, status: 1 } : null
        ),
    } as unknown as Provider;
    const lines = await org.bill(provider);
    expect(lines.map(l => [l.label, l.cost, l.ok])).toEqual([
      ['create', 200_000_000_000_000n, true],
      ['lost', 0n, false],
    ]);
    const text = formatBill(lines);
    expect(text).toMatch(/2 transactions, 0\.0002 xDAI/);
    expect(text).toMatch(/create +gas +100000 @ +2\.0 gwei +0\.0002 xDAI +0xaa$/m);
    expect(text).toMatch(/lost +gas +0 .* \(no receipt or reverted\) +0xbb$/m);
  });
});

describe('the run summary', () => {
  it('prints one aligned row per scenario', () => {
    const table = formatTable([
      {
        scenario: 's1 static census',
        processId: '0xabc',
        keyMode: 'sequencer',
        origin: '1 static',
        voters: 8,
        result: 'pass',
        duration: 754_000,
      },
      {
        scenario: 's8 organizer refusals',
        keyMode: 'sequencer',
        origin: '1 static',
        result: 'FAIL: one\ntwo',
        duration: 5_000,
      },
    ]).split('\n');
    expect(table[0].split(/ {2,}/)).toEqual([
      'scenario',
      'process id',
      'key',
      'origin',
      'voters',
      'result',
      'time',
    ]);
    // Every column starts where its header does.
    const starts = (line: string) => [...line.matchAll(/(?:^| {2})(\S)/g)].map(m => m.index);
    expect(starts(table[2])).toEqual(starts(table[0]));
    expect(table[2]).toMatch(/pass +12:34$/);
    expect(table[3].split(/ {2,}/)).toEqual([
      's8 organizer refusals',
      '-',
      'sequencer',
      '1 static',
      '-',
      'FAIL: one',
      '0:05',
    ]);
  });
});

describe('the settings', () => {
  const names = [
    'DAVINCI_SDK_E2E',
    'DAVINCI_SDK_E2E_BASE_URL',
    'DAVINCI_E2E_NODES',
    'DAVINCI_E2E_ORGANIZER_KEY',
    'DAVINCI_E2E_RPC',
  ];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
    for (const n of names) delete process.env[n];
  });
  afterEach(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it('name what the run needs', () => {
    expect(phase()).toBeUndefined();
    process.env.DAVINCI_SDK_E2E = 'live';
    expect(() => phase()).toThrow(/want prepare or run/);
    expect(() => runSettings()).toThrow(
      /needs DAVINCI_SDK_E2E_BASE_URL, DAVINCI_E2E_NODES, DAVINCI_E2E_ORGANIZER_KEY/
    );
  });

  it('put the given RPCs before the preset ones', () => {
    process.env.DAVINCI_SDK_E2E_BASE_URL = 'https://files.example.org/fixtures/';
    process.env.DAVINCI_E2E_NODES = ' http://127.0.0.1:1 ,http://127.0.0.1:2';
    process.env.DAVINCI_E2E_ORGANIZER_KEY = '/keys/org.key';
    process.env.DAVINCI_E2E_RPC = `https://rpc.example.org,${GNOSIS.rpcUrls[1]}`;
    const s = runSettings();
    expect(s.baseUrl).toBe('https://files.example.org/fixtures');
    expect(s.nodes).toEqual(['http://127.0.0.1:1', 'http://127.0.0.1:2']);
    expect(s.organizerKeyFile).toBe('/keys/org.key');
    expect(s.rpcUrls).toEqual([
      'https://rpc.example.org',
      GNOSIS.rpcUrls[1],
      GNOSIS.rpcUrls[0],
      ...GNOSIS.rpcUrls.slice(2),
    ]);
  });

  it('keep node and RPC URLs out of the output', () => {
    process.env.DAVINCI_E2E_NODES = 'http://10.0.0.1:9090,http://10.0.0.1:90';
    process.env.DAVINCI_E2E_RPC = 'https://rpc.example.org/v1/secret-key';
    expect(
      redact(
        'sent to http://10.0.0.1:9090/votes, then http://10.0.0.1:90; ' +
          'rpc https://rpc.example.org/v1/secret-key failed'
      )
    ).toBe('sent to <node 1>/votes, then <node 2>; rpc <rpc 1> failed');
    const err = redactError(new Error('down: http://10.0.0.1:90/info'));
    expect(err.message).toBe('down: <node 2>/info');
    expect(err.stack).not.toMatch(/10\.0\.0\.1/);
    // Transport errors name the host, with or without the port.
    expect(
      redact('connect ECONNREFUSED 10.0.0.1:9090; getaddrinfo ENOTFOUND rpc.example.org')
    ).toBe('connect ECONNREFUSED <node 1>; getaddrinfo ENOTFOUND <rpc 1>');
    expect(redact('socket hang up (10.0.0.1)')).toBe('socket hang up (<node>)');
  });
});
