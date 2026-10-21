import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { VocdoniSequencerService } from '../../../src/sequencer/SequencerService';

// Two local servers: the "node" the SDK is configured for, and a third party it redirects to.
interface Seen {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
}

function listen(
  handler: (
    req: IncomingMessage,
    seen: Seen[]
  ) => { status: number; headers?: Record<string, string>; body?: string }
) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      const out = handler(req, seen);
      res.writeHead(out.status, out.headers);
      res.end(out.body ?? '');
    });
  });
  return new Promise<{ server: Server; seen: Seen[]; url: string }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

describe('attack: a node that redirects the SDK elsewhere', () => {
  const servers: Server[] = [];
  afterAll(() => servers.forEach(s => s.close()));

  // BUG: BaseService follows redirects, so a hostile node can send configured headers and POST bodies to a third party.
  it('does not follow a redirect with the configured headers or a vote body', async () => {
    const third = await listen(() => ({ status: 200, body: '{"voteId":"0x8000000000000001"}' }));
    const node = await listen(() => ({
      status: 307,
      headers: { location: `${third.url}/stolen` },
    }));
    servers.push(third.server, node.server);
    const svc = new VocdoniSequencerService(node.url, { headers: { 'x-api-key': 'SECRET' } });

    await expect(svc.getInfo()).rejects.toThrow();
    await expect(
      (svc as unknown as { request(c: unknown): Promise<unknown> }).request({
        method: 'POST',
        url: '/votes',
        data: { signature: '0x' + '11'.repeat(65) },
      })
    ).rejects.toThrow();
    expect(third.seen).toEqual([]);
  });
});

describe('attack: the sequencer client keeps its caps', () => {
  // BUG: an explicit undefined in the config removes the default timeout and body cap.
  it('keeps the default timeout and body cap when the config sets them to undefined', async () => {
    const big = 'x'.repeat(17 << 20);
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(big))) as unknown as typeof fetch;
    const svc = new VocdoniSequencerService('https://a.example', {
      fetchImpl,
      timeoutMs: undefined,
      maxResponseBytes: undefined,
    });
    await expect(svc.getInfo()).rejects.toThrow(/over/);
  });
});
