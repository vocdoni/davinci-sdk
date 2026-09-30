import { DownloadError, download } from '../../../src/core/download';

const URL_ = 'https://files.example.org/f.json';
const answer = (res: Response) => (() => Promise.resolve(res)) as typeof fetch;

describe('download', () => {
  it('returns the body, the status and the content type', async () => {
    const res = new Response('{"a":1}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const got = await download(URL_, { fetchImpl: answer(res), stallTimeoutMs: 100 });
    expect(new TextDecoder().decode(got.bytes)).toBe('{"a":1}');
    expect([got.status, got.contentType]).toEqual([200, 'application/json']);
  });

  it('asks for manual redirects when told, and refuses one', async () => {
    let init: RequestInit | undefined;
    const redirect = ((_: string, i?: RequestInit) => {
      init = i;
      return Promise.resolve(new Response(null, { status: 301, headers: { location: '/x' } }));
    }) as typeof fetch;
    const err = await download(URL_, {
      fetchImpl: redirect,
      stallTimeoutMs: 100,
      redirect: 'manual',
    }).catch((e: unknown) => e as DownloadError);
    expect(init?.redirect).toBe('manual');
    expect(err).toBeInstanceOf(DownloadError);
    expect(err).toMatchObject({ status: 301, message: 'HTTP 301: redirects are refused' });
    // What a browser answers for a redirect under `redirect: 'manual'`.
    const opaque = { type: 'opaqueredirect', status: 0, ok: false } as Response;
    await expect(
      download(URL_, { fetchImpl: answer(opaque), stallTimeoutMs: 100, redirect: 'manual' })
    ).rejects.toThrow('HTTP redirect: redirects are refused');
  });

  it('refuses an error status and a body past the cap', async () => {
    await expect(
      download(URL_, { fetchImpl: answer(new Response('x', { status: 503 })), stallTimeoutMs: 100 })
    ).rejects.toMatchObject({ status: 503, message: 'HTTP 503' });
    const big = () => new Response(new Uint8Array(11));
    await expect(
      download(URL_, { fetchImpl: answer(big()), stallTimeoutMs: 100, maxBytes: 10 })
    ).rejects.toThrow('larger than 10 bytes');
    const got = await download(URL_, {
      fetchImpl: answer(big()),
      stallTimeoutMs: 100,
      maxBytes: 11,
    });
    expect(got.bytes).toHaveLength(11);
    // A body without a stream is capped too.
    const flat = {
      ok: true,
      status: 200,
      body: null,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(11)),
    } as unknown as Response;
    await expect(
      download(URL_, { fetchImpl: answer(flat), stallTimeoutMs: 100, maxBytes: 10 })
    ).rejects.toThrow('larger than 10 bytes');
  });

  it('gives up on a fetch that never answers and wraps network errors', async () => {
    const never = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    await expect(download(URL_, { fetchImpl: never, stallTimeoutMs: 20 })).rejects.toThrow(
      'no data for 20 ms'
    );
    const refused = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await expect(download(URL_, { fetchImpl: refused, stallTimeoutMs: 20 })).rejects.toBeInstanceOf(
      DownloadError
    );
  });
});
