import { join } from 'node:path';
import { sha256, toUtf8Bytes } from 'ethers';
import { ballotVkHash, type SnarkjsVerificationKey } from '../../../src/crypto';
import { BALLOT_VK_HASH } from '../../../src/protocol';
import {
  ArtifactError,
  BALLOT_ARTIFACTS,
  ARTIFACT_STALL_TIMEOUT_MS,
  BallotProver,
  MemoryArtifactCache,
  ballotArtifactSet,
  checkArtifactsConfig,
  loadBallotArtifacts,
  type ArtifactFile,
  type ArtifactsConfig,
  type BallotArtifactSet,
} from '../../../src/prover';
import { checkVerificationKey, loadArtifactFile } from '../../../src/prover/artifacts';
import { PINNED_VKEY_TEXT, V1_VKEY } from '../../helpers/realProof';

// davinci-circom a39a9f9: sha256sum of the checkout's artifacts/.
const A39A9F9 = 'a39a9f9867bb70726ad2137ed536d75670e042b9';
const PINNED = {
  wasm: ['ballot_proof.wasm', '07ecaef89f730cd4a3ee0355821a1fee4eb235fe8934f3c4bf24744bf1c7e4d5'],
  zkey: [
    'ballot_proof_pkey.zkey',
    '4fa825ca364142b066f4a905564f54ed9ff330e6b748c517d08708f866eedf1e',
  ],
  vkey: [
    'ballot_proof_vkey.json',
    '498fa6f25d2b4adebe880eb2aa368712fba2821dda5a94efaea4d62725fa9ad7',
  ],
} as const;

const VKEY_BYTES = toUtf8Bytes(PINNED_VKEY_TEXT);
const VKEY_FILE: ArtifactFile = BALLOT_ARTIFACTS[BALLOT_VK_HASH].vkey;
const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'zkvm');

// A fetch that serves `files` by URL and records every request.
function serve(files: Record<string, Uint8Array | number>) {
  const seen: string[] = [];
  const fetchImpl = vi.fn((input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const body = files[url];
    if (body === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    if (typeof body === 'number') return Promise.resolve(new Response('', { status: body }));
    return Promise.resolve(new Response(body));
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

describe('the ballot artifact table', () => {
  it('pins the registry key to davinci-circom a39a9f9 on raw GitHub, with its sha256s', () => {
    expect(Object.keys(BALLOT_ARTIFACTS)).toEqual([BALLOT_VK_HASH]);
    const entry = BALLOT_ARTIFACTS[BALLOT_VK_HASH];
    expect(entry.source).toContain(A39A9F9);
    for (const name of ['wasm', 'zkey', 'vkey'] as const) {
      const [file, hash] = PINNED[name];
      expect(entry[name]).toEqual({
        url: `https://raw.githubusercontent.com/vocdoni/davinci-circom/${A39A9F9}/artifacts/${file}`,
        sha256: `0x${hash}`,
      });
    }
    expect(Object.isFrozen(BALLOT_ARTIFACTS)).toBe(true);
    expect(Object.isFrozen(entry.zkey)).toBe(true);
  });

  it('keys the entry by the hash of its verification key, the committed copy', () => {
    expect(sha256(VKEY_BYTES)).toBe(VKEY_FILE.sha256);
    expect(ballotVkHash(JSON.parse(PINNED_VKEY_TEXT) as SnarkjsVerificationKey)).toBe(
      BALLOT_VK_HASH
    );
  });

  it('looks keys up in any case, own entries first, and refuses unknown ones', () => {
    const upper = `0x${BALLOT_VK_HASH.slice(2).toUpperCase()}`;
    expect(ballotArtifactSet(upper)).toBe(BALLOT_ARTIFACTS[BALLOT_VK_HASH]);
    const other = `0x${'12'.repeat(32)}`;
    const own = { ...BALLOT_ARTIFACTS[BALLOT_VK_HASH], source: 'local build' };
    expect(ballotArtifactSet(other, { [other.toUpperCase().replace('0X', '0x')]: own })).toBe(own);
    expect(ballotArtifactSet(BALLOT_VK_HASH, { [BALLOT_VK_HASH]: own })).toBe(own);
    expect(() => ballotArtifactSet(other)).toThrow(ArtifactError);
    expect(() => ballotArtifactSet(other)).toThrow(`ballot VK hash ${other}`);
    expect(() => ballotArtifactSet('0x1234')).toThrow(TypeError);
  });

  it('refuses a malformed table wherever it is read, naming what is wrong', async () => {
    const entry = BALLOT_ARTIFACTS[BALLOT_VK_HASH];
    const cases: [ArtifactsConfig, string][] = [
      [
        { table: { '0x1234': entry } },
        'artifacts table key "0x1234" is not a 32-byte ballot VK hash',
      ],
      [
        {
          table: { [BALLOT_VK_HASH]: entry, [`0x${BALLOT_VK_HASH.slice(2).toUpperCase()}`]: entry },
        },
        `artifacts table lists ${BALLOT_VK_HASH} twice`,
      ],
      [
        { table: { [BALLOT_VK_HASH]: { ...entry, zkey: { url: 'x', sha256: '0x12' } } } },
        `artifacts table entry ${BALLOT_VK_HASH}: zkey needs a url and a 32-byte sha256`,
      ],
      [
        { table: { [BALLOT_VK_HASH]: { source: 'x' } as unknown as BallotArtifactSet } },
        'wasm needs a url',
      ],
      [{ timeoutMs: -1 }, 'artifacts timeoutMs -1 is not a positive number'],
      [{ timeoutMs: Number.NaN }, 'is not a positive number'],
    ];
    for (const [config, msg] of cases) {
      expect(() => checkArtifactsConfig(config), msg).toThrow(ArtifactError);
      expect(() => checkArtifactsConfig(config)).toThrow(msg);
      expect(() => new BallotProver({ artifacts: config })).toThrow(msg);
      await expect(loadBallotArtifacts(BALLOT_VK_HASH, config)).rejects.toThrow(msg);
    }
    // A bad key is reported even when looking up another one.
    expect(() => ballotArtifactSet(BALLOT_VK_HASH, { nope: entry })).toThrow(ArtifactError);
    expect(() => checkArtifactsConfig({})).not.toThrow();
    expect(() => checkArtifactsConfig()).not.toThrow();
  });
});

describe('loadArtifactFile', () => {
  it('downloads from the table URL and checks the sha256', async () => {
    const { seen, fetchImpl } = serve({ [VKEY_FILE.url]: VKEY_BYTES });
    expect(await loadArtifactFile('vkey', VKEY_FILE, { fetchImpl })).toEqual(VKEY_BYTES);
    expect(seen).toEqual([VKEY_FILE.url]);
  });

  it('refuses bytes whose sha256 differs, and failed downloads', async () => {
    const tampered = VKEY_BYTES.slice();
    tampered[10] ^= 1;
    const bad = serve({ [VKEY_FILE.url]: tampered });
    const err = (await loadArtifactFile('vkey', VKEY_FILE, { fetchImpl: bad.fetchImpl }).catch(
      (e: unknown) => e
    )) as ArtifactError;
    expect(err).toBeInstanceOf(ArtifactError);
    expect(err.file).toBe('vkey');
    expect(err.message).toContain(`has sha256 ${sha256(tampered)}, want ${VKEY_FILE.sha256}`);

    const down = serve({ [VKEY_FILE.url]: 503 });
    await expect(
      loadArtifactFile('vkey', VKEY_FILE, { fetchImpl: down.fetchImpl })
    ).rejects.toThrow(`vkey: cannot read ${VKEY_FILE.url}: HTTP 503`);
    const offline = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    await expect(
      loadArtifactFile('vkey', VKEY_FILE, { fetchImpl: offline as unknown as typeof fetch })
    ).rejects.toThrow('fetch failed');
  });

  it('takes the file from a per-file source, a directory or a mirror, in that order', async () => {
    const mirror = 'https://mirror.example/davinci/';
    const own = 'https://own.example/key.json';
    const files = { [`${mirror}ballot_proof_vkey.json`]: VKEY_BYTES, [own]: VKEY_BYTES };
    const cases: [ArtifactsConfig, string[]][] = [
      [{ baseUrl: mirror }, [`${mirror}ballot_proof_vkey.json`]],
      [{ baseUrl: mirror, vkey: own }, [own]],
      [{ baseUrl: mirror, vkey: { url: own } }, [own]],
      [{ baseUrl: mirror, dir: FIXTURES }, []],
      [{ baseUrl: mirror, vkey: { path: join(FIXTURES, 'ballot_proof_vkey.json') } }, []],
      [{ baseUrl: mirror, vkey: { data: VKEY_BYTES } }, []],
    ];
    for (const [config, want] of cases) {
      const { seen, fetchImpl } = serve(files);
      expect(await loadArtifactFile('vkey', VKEY_FILE, { ...config, fetchImpl })).toEqual(
        VKEY_BYTES
      );
      expect(seen).toEqual(want);
    }
  });

  it('checks overrides against the pinned sha256 too', async () => {
    const other = toUtf8Bytes('{"not":"the key"}');
    await expect(loadArtifactFile('vkey', VKEY_FILE, { vkey: { data: other } })).rejects.toThrow(
      'the bytes given has sha256'
    );
    await expect(
      loadArtifactFile('vkey', VKEY_FILE, { vkey: { path: join(FIXTURES, 'limits.rs') } })
    ).rejects.toThrow(`${join(FIXTURES, 'limits.rs')} has sha256`);
    await expect(
      loadArtifactFile('vkey', VKEY_FILE, { dir: join(FIXTURES, 'missing') })
    ).rejects.toThrow('cannot read');
  });

  it('reuses a cached file, and replaces a cached copy that does not hash', async () => {
    const cache = new MemoryArtifactCache();
    const first = serve({ [VKEY_FILE.url]: VKEY_BYTES });
    await loadArtifactFile('vkey', VKEY_FILE, { cache, fetchImpl: first.fetchImpl });
    expect(cache.get(VKEY_FILE.sha256)).toEqual(VKEY_BYTES);

    const second = serve({ [VKEY_FILE.url]: VKEY_BYTES });
    await loadArtifactFile('vkey', VKEY_FILE, { cache, fetchImpl: second.fetchImpl });
    expect(second.seen).toEqual([]);

    cache.set(VKEY_FILE.sha256, toUtf8Bytes('corrupted'));
    const third = serve({ [VKEY_FILE.url]: VKEY_BYTES });
    expect(
      await loadArtifactFile('vkey', VKEY_FILE, { cache, fetchImpl: third.fetchImpl })
    ).toEqual(VKEY_BYTES);
    expect(third.seen).toEqual([VKEY_FILE.url]);
    expect(cache.get(VKEY_FILE.sha256)).toEqual(VKEY_BYTES);
  });
});

describe('artifact download timeout', () => {
  const url = VKEY_FILE.url;

  // A response whose body sends `chunks` every `everyMs`, then ends; or never
  // ends when `stall` is set. It honours the abort signal like fetch does,
  // unless `deaf` is set.
  function dripping(chunks: Uint8Array[], everyMs: number, stall = false, deaf = false) {
    return vi.fn((_: string | URL | Request, init?: RequestInit) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(ctl) {
          let i = 0;
          timer = setInterval(() => {
            if (i < chunks.length) ctl.enqueue(chunks[i++]);
            else if (!stall) {
              clearInterval(timer);
              ctl.close();
            }
          }, everyMs);
          if (deaf) return;
          init?.signal?.addEventListener('abort', () => {
            clearInterval(timer);
            ctl.error(init.signal?.reason);
          });
        },
        cancel() {
          clearInterval(timer);
        },
      });
      return Promise.resolve(new Response(body));
    }) as unknown as typeof fetch;
  }

  const split = (b: Uint8Array, n: number) =>
    Array.from({ length: n }, (_, i) => b.slice((i * b.length) / n, ((i + 1) * b.length) / n));

  it('defaults to a minute without data', () => {
    expect(ARTIFACT_STALL_TIMEOUT_MS).toBe(60_000);
  });

  it('fails a download whose body stalls, whether its stream heeds the abort or not', async () => {
    for (const deaf of [false, true]) {
      const fetchImpl = dripping(split(VKEY_BYTES, 3), 5, true, deaf);
      const err = (await loadArtifactFile('vkey', VKEY_FILE, { fetchImpl, timeoutMs: 60 }).catch(
        (e: unknown) => e
      )) as ArtifactError;
      expect(err, `deaf: ${deaf}`).toBeInstanceOf(ArtifactError);
      expect(err.message).toBe(`vkey: cannot read ${url}: no data for 60 ms`);
    }
  });

  it('fails a download that never answers, even through a fetch that ignores the signal', async () => {
    const never = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const started = Date.now();
    await expect(
      loadArtifactFile('vkey', VKEY_FILE, { fetchImpl: never, timeoutMs: 50 })
    ).rejects.toThrow('no data for 50 ms');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('lets a slow download finish while data keeps coming', async () => {
    // 6 chunks 25 ms apart: 150 ms in all, never 60 ms without data.
    const fetchImpl = dripping(split(VKEY_BYTES, 6), 25);
    const started = Date.now();
    expect(await loadArtifactFile('vkey', VKEY_FILE, { fetchImpl, timeoutMs: 60 })).toEqual(
      VKEY_BYTES
    );
    expect(Date.now() - started).toBeGreaterThan(60);
  });
});

describe('checkVerificationKey', () => {
  it('accepts the key the registry pins and names any other', () => {
    const pinned: unknown = JSON.parse(PINNED_VKEY_TEXT);
    expect(checkVerificationKey('vkey', pinned, BALLOT_VK_HASH)).toBe(pinned);
    expect(() => checkVerificationKey('zkey', V1_VKEY, BALLOT_VK_HASH)).toThrow(
      `zkey: its verification key hashes to ${ballotVkHash(V1_VKEY)}, the registry pins ${BALLOT_VK_HASH}`
    );
    const err = (() => {
      try {
        checkVerificationKey('vkey', { IC: [] }, BALLOT_VK_HASH);
      } catch (e) {
        return e as ArtifactError;
      }
    })();
    expect(err).toBeInstanceOf(ArtifactError);
    expect(err?.message).toContain('vkey: not a ballot verification key');
  });
});
