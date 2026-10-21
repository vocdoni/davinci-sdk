/**
 * @fileoverview Keeps this process's traffic to the node under a steady rate:
 * `globalThis.fetch` is wrapped so every request to the node waits for a token
 * (the SDK's own requests included, as it binds the global `fetch` when built).
 * A burst (the concurrent duplicate submissions) bypasses the bucket; bursts
 * and over-cap bodies are counted across processes in the evidence directory,
 * against the run's caps.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms: number) => new Promise<void>(ok => setTimeout(ok, ms));

let installed: Throttle | undefined;

export class Throttle {
  private next = 0;
  private bypass = 0;
  requests = 0;
  readonly serverErrors: { url: string; status: number }[] = [];
  private readonly original: typeof fetch;

  constructor(
    private readonly base: string,
    private readonly rps: number,
    private readonly dir: string
  ) {
    this.original = globalThis.fetch.bind(globalThis);
  }

  /** Installs the wrapper (once per process). */
  static install(base: string, rps: number, dir: string): Throttle {
    if (installed) return installed;
    const t = new Throttle(base, rps, dir);
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      t.fetch(input, init)) as typeof fetch;
    installed = t;
    return t;
  }

  private async token(): Promise<void> {
    const gap = 1000 / this.rps;
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + gap;
    if (at > now) await sleep(at - now);
  }

  private async fetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(this.base)) return this.original(input, init);
    if (this.bypass === 0) await this.token();
    this.requests++;
    const res = await this.original(input, init);
    if (res.status >= 500)
      this.serverErrors.push({ url: url.slice(this.base.length), status: res.status });
    return res;
  }

  private countFile(name: string): number {
    const f = join(this.dir, name);
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
  }

  /**
   * Runs `n` copies of `fn` at once, outside the rate (one of the run's five bursts
   * of at most 20 requests).
   */
  async burst<T>(label: string, n: number, fn: (i: number) => Promise<T>): Promise<T[]> {
    if (n > 20) throw new Error(`a burst holds at most 20 requests, not ${n}`);
    if (this.countFile('bursts.jsonl') >= 5) throw new Error('the run already used its 5 bursts');
    appendFileSync(
      join(this.dir, 'bursts.jsonl'),
      `${JSON.stringify({ label, n, t: Date.now() })}\n`
    );
    await this.token();
    this.bypass++;
    try {
      return await Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
    } finally {
      this.bypass--;
    }
  }

  /** Reserves one of the run's three bodies over the size cap. */
  reserveOversize(label: string): void {
    if (this.countFile('oversize.jsonl') >= 3) {
      throw new Error('the run already sent its 3 bodies over the cap');
    }
    appendFileSync(
      join(this.dir, 'oversize.jsonl'),
      `${JSON.stringify({ label, t: Date.now() })}\n`
    );
  }
}
