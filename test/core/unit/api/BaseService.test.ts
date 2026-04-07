import { BaseService, RequestConfig } from '../../../../src/core/api/BaseService';

class TestService extends BaseService {
  async makeRequest<T>(config: RequestConfig): Promise<T> {
    return this.request<T>(config);
  }
}

describe('BaseService', () => {
  it('binds global fetch so browser-style implementations do not throw illegal invocation', async () => {
    const fetchMock = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }

      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }) as typeof fetch;

    vi.stubGlobal('fetch', fetchMock);

    const service = new TestService('https://sequencer.example.com');
    const response = await service.makeRequest<{ ok: boolean }>({
      method: 'GET',
      url: '/ping',
    });

    expect(response).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
