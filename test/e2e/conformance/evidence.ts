/**
 * @fileoverview Evidence of a conformance run: one JSON line per event in
 * `<dir>/<scenario>.jsonl` (process ids, vote ids, transaction hashes, node
 * answers, check outcomes), and progress lines on stderr. Never secrets: no
 * keys, no ballot secrets, no RPC URLs.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';

const T0 = Date.now();

function plain(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))
  ) as unknown;
}

/** Whether `text` holds what an error body must not: a stack, a source path, a panic. */
export function leaksInternals(text: string): string | null {
  const patterns: [RegExp, string][] = [
    [/\/home\/|\/root\/|\/usr\/|\/src\/|\\src\\/, 'a file path'],
    [/\.rs:\d+/, 'a Rust source location'],
    [/panicked|stack backtrace|RUST_BACKTRACE/i, 'a panic'],
    [/\bat [\w.<>]+ \(/, 'a stack frame'],
    [/https?:\/\/(?!127\.0\.0\.1)[^\s"]+/, 'a URL'],
  ];
  for (const [re, what] of patterns) if (re.test(text)) return what;
  return null;
}

export class Evidence {
  private readonly file: string;
  readonly checks: { name: string; ok: boolean; detail: unknown }[] = [];

  constructor(
    dir: string,
    readonly scenario: string
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, `${scenario}.jsonl`);
  }

  /** Appends one event. */
  log(kind: string, data: Record<string, unknown> = {}): void {
    const line = { t: new Date().toISOString(), scenario: this.scenario, kind, ...data };
    appendFileSync(this.file, `${JSON.stringify(plain(line))}\n`, { mode: 0o600 });
  }

  /** A progress line on stderr. */
  say(message: string): void {
    const now = new Date();
    const since = ((now.getTime() - T0) / 1000).toFixed(0).padStart(5);
    process.stderr.write(
      `[${this.scenario} ${now.toISOString().slice(11, 19)}Z ${since}s] ${message}\n`
    );
  }

  /** A soft check: recorded, and failing the test at its end when `ok` is false. */
  check(name: string, ok: boolean, detail: unknown = {}): boolean {
    this.checks.push({ name, ok, detail: plain(detail) });
    this.log('check', { name, ok, detail });
    if (!ok) this.say(`CHECK FAILED ${name}: ${JSON.stringify(plain(detail)).slice(0, 400)}`);
    expect.soft(ok, `${name}: ${JSON.stringify(plain(detail)).slice(0, 600)}`).toBe(true);
    return ok;
  }

  /** {@link check} that `actual` deep-equals `expected`. */
  eq(
    name: string,
    actual: unknown,
    expected: unknown,
    extra: Record<string, unknown> = {}
  ): boolean {
    const a = plain(actual);
    const e = plain(expected);
    return this.check(name, JSON.stringify(a) === JSON.stringify(e), {
      actual: a,
      expected: e,
      ...extra,
    });
  }
}
