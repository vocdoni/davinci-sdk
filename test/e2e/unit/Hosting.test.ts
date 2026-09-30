import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toUtf8Bytes } from 'ethers';
import { FixtureHost, checkServed, fixtureDiff, isFixtureUrl, readFixtures } from '../hosting';
import { fileHash } from '../spec';

const BASE = 'https://raw.githubusercontent.com/vocdoni/davinci-sdk/0123abc/test/e2e/fixtures';
const bytes = (s: string) => toUtf8Bytes(s);

const files = new Map<string, Uint8Array>([
  ['a.json', bytes('{"a":1}\n')],
  ['b.json', bytes('{"b":2}\n')],
]);

// A fetch serving `served` by URL, recording the requests.
function server(served: Record<string, Response | Error>) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    requests.push({ url, init });
    const answer = served[url];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer ?? new Response('missing', { status: 404 }));
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe('the fixture host', () => {
  it('publishes committed bytes at their URL and refuses anything else', async () => {
    const host = new FixtureHost(BASE, files);
    const upload = (data: Uint8Array) =>
      host.uploader.upload({
        kind: 'metadata',
        data,
        contentType: 'application/json',
        sha256: fileHash(data),
      });
    expect(await upload(bytes('{"b":2}\n'))).toBe(`${BASE}/b.json`);
    await expect(upload(bytes('{"b":3}\n'))).rejects.toThrow(/not a committed fixture/);
    expect(host.url('a.json')).toBe(`${BASE}/a.json`);
    expect(() => host.url('c.json')).toThrow(/no fixture c.json/);
  });

  it('refuses two fixtures with the same bytes', () => {
    const twins = new Map(files);
    twins.set('c.json', bytes('{"a":1}\n'));
    expect(() => new FixtureHost(BASE, twins)).toThrow(/a\.json and c\.json are the same bytes/);
  });

  it("recognizes the suite's documents at any commit of the repository", () => {
    const at = (commit: string, name = 's1-metadata.json') =>
      `https://raw.githubusercontent.com/vocdoni/davinci-sdk/${commit}/test/e2e/fixtures/${name}`;
    expect(isFixtureUrl(at('0123abc'), BASE)).toBe(true);
    expect(isFixtureUrl(at('ffffffffffffffffffffffffffffffffffffffff'), BASE)).toBe(true);
    for (const other of [
      'https://raw.githubusercontent.com/vocdoni/davinci-node/0123abc/test/e2e/fixtures/s1-metadata.json',
      'https://raw.githubusercontent.com/someone/davinci-sdk/0123abc/test/e2e/fixtures/s1-metadata.json',
      'https://raw.githubusercontent.com/vocdoni/davinci-sdk/0123abc/test/fixtures/s1-metadata.json',
      `${at('0123abc')}?x=1`,
      at('0123abc', 'sub/s1-metadata.json'),
      'https://files.example.org/s1-metadata.json',
      'not a url',
    ]) {
      expect(isFixtureUrl(other, BASE), other).toBe(false);
    }
    // Any other host: only files right under the base.
    expect(
      isFixtureUrl('https://files.example.org/e2e/a.json', 'https://files.example.org/e2e')
    ).toBe(true);
    expect(
      isFixtureUrl('https://files.example.org/other/a.json', 'https://files.example.org/e2e')
    ).toBe(false);
  });

  it('checks every file is served as committed, with no redirect', async () => {
    const ok = server({
      [`${BASE}/a.json`]: new Response(bytes('{"a":1}\n')),
      [`${BASE}/b.json`]: new Response(bytes('{"b":2}\n')),
    });
    await checkServed(BASE, files, ok.fetchImpl);
    expect(ok.requests.map(r => r.init?.redirect)).toEqual(['manual', 'manual']);

    const bad = server({
      [`${BASE}/a.json`]: new Response(null, { status: 302, headers: { location: '/x' } }),
      [`${BASE}/b.json`]: new Response(bytes('{"b":3}\n')),
    });
    const err = await checkServed(BASE, files, bad.fetchImpl).catch((e: Error) => e);
    expect(String(err)).toMatch(/a\.json: HTTP 302/);
    expect(String(err)).toMatch(/b\.json: not the committed bytes/);

    const down = server({ [`${BASE}/a.json`]: new Error('ECONNRESET') });
    const err2 = await checkServed(BASE, files, down.fetchImpl).catch((e: Error) => e);
    expect(String(err2)).toMatch(/a\.json: ECONNRESET/);
    expect(String(err2)).toMatch(/b\.json: HTTP 404/);
  });

  it('compares file sets', () => {
    expect(fixtureDiff(files, new Map(files))).toEqual([]);
    const other = new Map(files);
    other.set('b.json', bytes('{}'));
    other.delete('a.json');
    other.set('c.json', bytes('{}'));
    expect(fixtureDiff(files, other)).toEqual([
      'a.json is missing',
      'b.json differs',
      'c.json is not expected',
    ]);
  });

  it('reads the JSON files of a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-e2e-fixtures-'));
    try {
      writeFileSync(join(dir, 'b.json'), '{"b":2}\n');
      writeFileSync(join(dir, 'a.json'), '{"a":1}\n');
      writeFileSync(join(dir, 'notes.txt'), 'x');
      const read = readFixtures(dir);
      expect([...read.keys()]).toEqual(['a.json', 'b.json']);
      expect(fixtureDiff(files, read)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
