import { sha256, toUtf8Bytes } from 'ethers';
import { BALLOT_VK_HASH } from '../../../src/protocol';
import {
  ArtifactError,
  BALLOT_ARTIFACTS,
  MemoryArtifactCache,
  loadBallotArtifacts,
  type ArtifactFile,
  type ArtifactCache,
} from '../../../src/prover';
import { loadArtifactFile } from '../../../src/prover/artifacts';

const ENTRY = BALLOT_ARTIFACTS[BALLOT_VK_HASH];
const MIB = 1 << 20;

// A body that never ends on its own: 1 MiB chunks, `total` bytes at most, counting what was pulled.
function endless(total: number) {
  const state = { pulled: 0 };
  const chunk = new Uint8Array(MIB);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= total) return controller.close();
      state.pulled += chunk.length;
      controller.enqueue(chunk);
    },
  });
  return { state, res: () => new Response(body) };
}

describe('attack: a CDN or mirror that serves too much', () => {
  // BUG: no size cap on circuit-file downloads; a hostile mirror streams until memory runs out (also: a throwing cache fails the load).
  it('stops reading the verification key long before 64 MiB', async () => {
    const { state, res } = endless(64 * MIB);
    const file: ArtifactFile = { url: 'https://cdn.test/vkey.json', sha256: ENTRY.vkey.sha256 };
    const fetchImpl = vi.fn(() => Promise.resolve(res())) as unknown as typeof fetch;
    await expect(loadArtifactFile('vkey', file, { fetchImpl })).rejects.toThrow(ArtifactError);
    expect(state.pulled).toBeLessThan(8 * MIB);
  });

  it('stops reading the witness wasm long before 1 GiB', async () => {
    const { state, res } = endless(300 * MIB);
    const file: ArtifactFile = { url: 'https://cdn.test/w.wasm', sha256: ENTRY.wasm.sha256 };
    const fetchImpl = vi.fn(() => Promise.resolve(res())) as unknown as typeof fetch;
    await expect(loadArtifactFile('wasm', file, { fetchImpl })).rejects.toThrow(ArtifactError);
    expect(state.pulled).toBeLessThan(100 * MIB);
  });
});

describe('attack: a CDN that serves another file', () => {
  const good = toUtf8Bytes('the pinned file');
  const file: ArtifactFile = {
    url: 'https://cdn.test/a',
    mirrors: ['https://mirror.test/a'],
    sha256: sha256(good),
  };

  it('falls through to a mirror whose copy hashes right, never returns the bad one', async () => {
    const fetchImpl = vi.fn((u: string | URL | Request) =>
      Promise.resolve(new Response(String(u).startsWith('https://cdn') ? 'evil' : good))
    ) as unknown as typeof fetch;
    const out = await loadArtifactFile('vkey', file, { fetchImpl });
    expect(sha256(out)).toBe(file.sha256);
  });

  it('refuses when every source is wrong, empty, truncated or extended', async () => {
    for (const body of [new Uint8Array(0), good.slice(0, -1), new Uint8Array([...good, 0])]) {
      const fetchImpl = vi.fn(() => Promise.resolve(new Response(body))) as unknown as typeof fetch;
      await expect(loadArtifactFile('vkey', file, { fetchImpl })).rejects.toThrow(/sha256/);
    }
  });

  it('does not cache a bad file, and ignores a poisoned cache entry', async () => {
    const cache = new MemoryArtifactCache();
    const bad = vi.fn(() => Promise.resolve(new Response('evil'))) as unknown as typeof fetch;
    await expect(loadArtifactFile('vkey', file, { fetchImpl: bad, cache })).rejects.toThrow();
    expect(cache.get(file.sha256)).toBeUndefined();
    cache.set(file.sha256, toUtf8Bytes('poison'));
    const ok = vi.fn(() => Promise.resolve(new Response(good))) as unknown as typeof fetch;
    const out = await loadArtifactFile('vkey', file, { fetchImpl: ok, cache });
    expect(sha256(out)).toBe(file.sha256);
    expect(sha256(cache.get(file.sha256) as Uint8Array)).toBe(file.sha256);
  });

  it('a redirect to a hostile host cannot get past the sha256', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('evil', { status: 200 }))
    ) as unknown as typeof fetch;
    await expect(loadArtifactFile('vkey', file, { fetchImpl })).rejects.toThrow(/sha256/);
  });

  it('a per-file override (bytes, url) is checked as well', async () => {
    await expect(
      loadArtifactFile('vkey', file, { vkey: { data: toUtf8Bytes('evil') } })
    ).rejects.toThrow(/sha256/);
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('evil'))) as unknown as typeof fetch;
    await expect(
      loadArtifactFile('vkey', file, { vkey: 'https://other.test/x', fetchImpl })
    ).rejects.toThrow(/sha256/);
    await expect(
      loadArtifactFile('vkey', file, { vkey: { path: '/etc/hostname' } })
    ).rejects.toThrow(/sha256/);
  });

  it('a cache that throws does not hide the pinned download', async () => {
    const cache: ArtifactCache = {
      get: () => {
        throw new Error('disk gone');
      },
      set: () => {
        throw new Error('disk full');
      },
    };
    const ok = vi.fn(() => Promise.resolve(new Response(good))) as unknown as typeof fetch;
    const out = await loadArtifactFile('vkey', file, { fetchImpl: ok, cache });
    expect(sha256(out)).toBe(file.sha256);
  });
});

describe('attack: loadBallotArtifacts on the ceremony key', () => {
  it('refuses a vkey of the right sha256 under another registry hash', async () => {
    // The table is keyed by the registry hash; a different hash has no files.
    await expect(loadBallotArtifacts(`0x${'12'.repeat(32)}`)).rejects.toThrow(ArtifactError);
    await expect(loadBallotArtifacts('0x12')).rejects.toThrow();
  });
});
