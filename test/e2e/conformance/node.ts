/**
 * @fileoverview A raw client of the node's HTTP API for the conformance checks:
 * it sends exactly the bytes a test gives and keeps exactly what the node
 * answered (status, code, message), and flags what no answer may be: a 5xx, a
 * hang (no answer within 70 s; the node's own deadline is 60 s), an error body
 * outside the documented `{error, code}` shape, or one that exposes internals.
 */

import { leaksInternals, type Evidence } from './evidence';

/** What the node answered. */
export interface Answer {
  status: number;
  /** The `code` of an error body. */
  code?: number;
  /** The `error` of an error body. */
  error?: string;
  json?: unknown;
  text: string;
  /** Milliseconds. */
  ms: number;
  /** The request got no answer (transport error or hang). */
  failed?: string;
}

/** Problems seen in the node's answers, for the report. */
export interface AnswerProblem {
  what: string;
  path: string;
  status: number;
  text: string;
}

const HANG_MS = 70_000;

export class NodeClient {
  readonly problems: AnswerProblem[] = [];

  constructor(
    readonly base: string,
    private readonly ev: Evidence
  ) {}

  private async send(method: string, path: string, init: RequestInit = {}): Promise<Answer> {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        ...init,
        signal: AbortSignal.timeout(HANG_MS),
      });
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const a: Answer = { status: 0, text: '', ms: Date.now() - t0, failed: msg };
      this.flag(msg.includes('Timeout') ? 'hang' : 'no answer', path, a);
      return a;
    }
    const text = await res.text();
    const a: Answer = { status: res.status, text, ms: Date.now() - t0 };
    try {
      a.json = JSON.parse(text) as unknown;
    } catch {
      // Not JSON: flagged below for error statuses.
    }
    if (res.status >= 400) {
      const o = a.json as { error?: unknown; code?: unknown } | undefined;
      if (
        typeof o !== 'object' ||
        o === null ||
        typeof o.error !== 'string' ||
        typeof o.code !== 'number' ||
        Math.floor(o.code / 100) !== res.status
      ) {
        this.flag('error body outside {error, code}', path, a);
      } else {
        a.code = o.code;
        a.error = o.error;
      }
      const leak = leaksInternals(text);
      if (leak) this.flag(`error body exposes ${leak}`, path, a);
    }
    if (res.status >= 500) this.flag('5xx', path, a);
    return a;
  }

  private flag(what: string, path: string, a: Answer): void {
    const p = { what, path: path.slice(0, 200), status: a.status, text: a.text.slice(0, 300) };
    this.problems.push(p);
    this.ev.log('node-problem', p);
    this.ev.say(`NODE PROBLEM ${what} on ${p.path}: ${a.status} ${p.text}`);
  }

  get(path: string): Promise<Answer> {
    return this.send('GET', path);
  }

  /** POSTs `body` as is (a string) or as JSON, with `Content-Type: application/json` unless `headers` say otherwise. */
  post(path: string, body: string | object, headers: Record<string, string> = {}): Promise<Answer> {
    return this.send('POST', path, {
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  method(method: string, path: string): Promise<Answer> {
    return this.send(method, path);
  }

  /** Any request, `init` as given (no default headers). */
  raw(method: string, path: string, init: RequestInit): Promise<Answer> {
    return this.send(method, path, init);
  }

  async ping(): Promise<boolean> {
    const a = await this.get('/ping');
    return a.status === 200;
  }

  async process(pid: string): Promise<Record<string, unknown> | undefined> {
    const a = await this.get(`/processes/${pid}`);
    return a.status === 200 ? (a.json as Record<string, unknown>) : undefined;
  }

  async voteStatus(pid: string, vid: string): Promise<Answer> {
    return this.get(`/votes/${pid}/voteId/${vid}`);
  }

  async info(): Promise<Record<string, unknown>> {
    const a = await this.get('/info');
    if (a.status !== 200) throw new Error(`GET /info: ${a.status} ${a.text.slice(0, 200)}`);
    return a.json as Record<string, unknown>;
  }
}
