import { sha256, toUtf8Bytes } from 'ethers';
import {
  CensusError,
  CensusPublishError,
  MAX_CENSUS_MEMBERS,
  OffchainCensus,
  checkCensusUrl,
  publishCensus,
  verifyCensusUrl,
} from '../../../src/census';
import { DocumentHost } from '../../helpers/documentHost';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';

function census(...members: string[]): OffchainCensus {
  const c = new OffchainCensus();
  c.add(members.length > 0 ? members : [A, B]);
  return c;
}

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as Error
  );

describe('publishCensus', () => {
  it('uploads the census file, reads it back as the nodes do and records it', async () => {
    const host = new DocumentHost();
    const c = census();
    const bytes = c.serialize();
    const out = await publishCensus(c, host.uploader, { fetchImpl: host.fetchImpl });
    expect(host.uploads).toEqual([
      { kind: 'census', data: bytes, contentType: 'application/json', sha256: sha256(bytes) },
    ]);
    expect(out).toEqual({
      uri: host.urlOf(bytes),
      root: await c.root(),
      size: 2,
      sha256: sha256(bytes),
    });
    expect(host.fetches).toHaveLength(1);
    expect(host.fetches[0].url).toBe(out.uri);
    expect(host.fetches[0].init?.redirect).toBe('manual');
    expect(c.isPublished).toBe(true);
    expect(c.censusRoot).toBe(out.root);
    expect(c.censusURI).toBe(out.uri);
  });

  it('accepts a host that serves the same census in other bytes', async () => {
    const host = new DocumentHost();
    const c = census();
    host.serve(host.urlOf(c.serialize()), { body: JSON.stringify(c.toJSON()) });
    await publishCensus(c, host.uploader, { fetchImpl: host.fetchImpl });
    expect(c.isPublished).toBe(true);
  });

  it('refuses what the nodes would not load, and leaves the census unpublished', async () => {
    const other = census(A, C).serialize();
    const cases: [
      string,
      { status?: number; body?: Uint8Array | string; headers?: Record<string, string> },
    ][] = [
      ['serves a census with root', { body: other }],
      [
        'redirects are refused',
        { status: 302, headers: { location: 'https://elsewhere.example' } },
      ],
      ['HTTP 404', { status: 404 }],
      ['answers 204; nodes need a 200', { status: 204 }],
      [
        'would read it as JSON lines',
        { body: census().serialize(), headers: { 'content-type': 'application/x-ndjson' } },
      ],
      ['not JSON', { body: new Uint8Array([0xef, 0xbb, 0xbf, ...census().serialize()]) }],
      ['has no members', { body: '{"participants":[]}' }],
    ];
    for (const [msg, served] of cases) {
      const host = new DocumentHost();
      const c = census();
      host.serve(host.urlOf(c.serialize()), served);
      const err = await errorOf(publishCensus(c, host.uploader, { fetchImpl: host.fetchImpl }));
      expect(err, msg).toBeInstanceOf(CensusPublishError);
      expect(err?.message, msg).toContain(msg);
      expect((err as CensusPublishError).uri).toBe(host.urlOf(c.serialize()));
      expect(c.isPublished).toBe(false);
    }
  });

  it('refuses an upload that fails or gives no URL, and an empty census', async () => {
    const host = new DocumentHost();
    host.failUpload = new Error('quota exceeded');
    const err = await errorOf(
      publishCensus(census(), host.uploader, { fetchImpl: host.fetchImpl })
    );
    expect(err).toBeInstanceOf(CensusPublishError);
    expect(err?.message).toBe('the census upload failed: quota exceeded');
    const blank = { upload: () => Promise.resolve('') };
    await expect(publishCensus(census(), blank)).rejects.toThrow('the uploader returned no URL');
    await expect(publishCensus(new OffchainCensus(), host.uploader)).rejects.toThrow(CensusError);
    const huge = { size: MAX_CENSUS_MEMBERS + 1 } as OffchainCensus;
    await expect(publishCensus(huge, host.uploader)).rejects.toThrow(
      `${MAX_CENSUS_MEMBERS + 1} members; nodes load at most 4194304`
    );
    expect(host.uploads).toHaveLength(1);
  });

  it('skips the read-back with verify false, but not the URL check', async () => {
    const host = new DocumentHost();
    const c = census();
    await publishCensus(c, host.uploader, { fetchImpl: host.fetchImpl, verify: false });
    expect(host.fetches).toHaveLength(0);
    expect(c.isPublished).toBe(true);
    const local = new DocumentHost('http://127.0.0.1:8080');
    await expect(
      publishCensus(census(), local.uploader, { fetchImpl: local.fetchImpl, verify: false })
    ).rejects.toThrow('127.0.0.1 is not a public host; nodes would refuse it');
    await publishCensus(census(), local.uploader, {
      fetchImpl: local.fetchImpl,
      allowPrivateHosts: true,
    });
  });

  it('gives up on a host that stops sending', async () => {
    const c = census();
    const stall = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    const host = new DocumentHost();
    const err = await errorOf(publishCensus(c, host.uploader, { fetchImpl: stall, timeoutMs: 20 }));
    expect(err?.message).toContain('no data for 20 ms');
  });
});

describe('verifyCensusUrl', () => {
  it('reads a census served elsewhere and checks its root', async () => {
    const host = new DocumentHost();
    const c = census(A, B, C);
    const url = 'https://census.example.org/c.json';
    host.serve(url, { body: c.serialize() });
    expect(await verifyCensusUrl(url, await c.root(), { fetchImpl: host.fetchImpl })).toEqual({
      root: await c.root(),
      size: 3,
    });
    await expect(verifyCensusUrl(url, 5n, { fetchImpl: host.fetchImpl })).rejects.toThrow(
      `not 0x${'5'.padStart(64, '0')}`
    );
    host.serve(url, { body: toUtf8Bytes('{"participants":[{"key":"0x11","weight":"1"}]}') });
    await expect(
      verifyCensusUrl(url, await c.root(), { fetchImpl: host.fetchImpl })
    ).rejects.toThrow(CensusPublishError);
  });
});

describe('checkCensusUrl', () => {
  it('accepts http(s) on public hosts', () => {
    for (const url of [
      'https://files.example.org/census.json',
      'http://files.example.org/c',
      'https://8.8.8.8/c.json',
      'https://[2606:4700:4700::1111]/c.json',
      'https://[::ffff:8.8.8.8]/c.json',
      'https://100.128.0.1/c.json',
      'https://172.32.0.1/c.json',
    ]) {
      expect(checkCensusUrl(url).href, url).toBe(new URL(url).href);
    }
  });

  it('refuses other schemes and the hosts nodes refuse', () => {
    for (const url of [
      'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      'file:///srv/census.json',
      'ftp://files.example.org/c.json',
      'not a url',
      'http://localhost:8080/c.json',
      'http://census.localhost/c.json',
      'http://127.0.0.1/c.json',
      'http://0.0.0.0/c.json',
      'http://10.1.2.3/c.json',
      'http://172.16.0.1/c.json',
      'http://192.168.1.10/c.json',
      'http://169.254.169.254/latest',
      'http://100.64.0.1/c.json',
      'http://192.0.2.1/c.json',
      'http://198.51.100.1/c.json',
      'http://203.0.113.1/c.json',
      'http://224.0.0.1/c.json',
      'http://255.255.255.255/c.json',
      'http://2130706433/c.json', // 127.0.0.1 as one number
      'http://[::1]/c.json',
      'http://[::]/c.json',
      'http://[::ffff:192.168.1.1]/c.json',
      'http://[::127.0.0.1]/c.json',
      'http://[fd00::1]/c.json',
      'http://[fe80::1]/c.json',
      'http://[ff02::1]/c.json',
      'http://[64:ff9b::a00:1]/c.json',
      'http://[2002:c000:204::1]/c.json',
      'http://[2001:db8::1]/c.json',
      'http://[2001:0:4136:e378::1]/c.json',
    ]) {
      expect(() => checkCensusUrl(url), url).toThrow(CensusPublishError);
    }
    expect(checkCensusUrl('http://localhost:8080/c.json', { allowPrivateHosts: true }).port).toBe(
      '8080'
    );
    expect(() => checkCensusUrl('file:///c.json', { allowPrivateHosts: true })).toThrow(
      'only http(s)'
    );
  });
});
