/**
 * @fileoverview The live suite's settings (see test/e2e/README.md), read
 * from the environment or `test/.env`:
 *
 * - `DAVINCI_SDK_E2E`: the phase, `prepare` or `run`; unset skips the suite.
 * - `DAVINCI_SDK_E2E_DIR`: the private directory holding the voter keys,
 *   default `~/.davinci-gnosis/sdk-e2e`; never inside the repository.
 * - `DAVINCI_SDK_E2E_ARTIFACTS`: where the checked circuit files are kept
 *   between runs, default `~/.cache/davinci-sdk-e2e/artifacts`.
 *
 * `run` also needs:
 *
 * - `DAVINCI_SDK_E2E_BASE_URL`: where `test/e2e/fixtures` is served, the raw
 *   GitHub URL of that directory at a pushed commit.
 * - `DAVINCI_E2E_NODES`: the sequencer node URLs, comma-separated.
 * - `DAVINCI_E2E_ORGANIZER_KEY`: the path of the organizer's key file (hex);
 *   the key is read from it and never printed.
 * - `DAVINCI_E2E_RPC`, optional: Gnosis JSON-RPCs tried before the preset's,
 *   comma-separated.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { GNOSIS } from '../../src/networks';
import { loadIntegrationEnv } from '../helpers/integrationEnv';

loadIntegrationEnv();

export type Phase = 'prepare' | 'run';

/** The phase this invocation runs, if any. */
export function phase(): Phase | undefined {
  const p = process.env.DAVINCI_SDK_E2E?.trim();
  if (!p) return undefined;
  if (p !== 'prepare' && p !== 'run') {
    throw new Error(`DAVINCI_SDK_E2E=${p}: want prepare or run`);
  }
  return p;
}

/** The committed fixtures: census files and metadata documents. */
export const FIXTURES_DIR = resolve(__dirname, 'fixtures');

const REPO = resolve(__dirname, '../..');

function dirSetting(name: string, fallback: string): string {
  return resolve(process.env[name]?.trim() || fallback);
}

/** The private directory of the voter keys; refused inside the repository. */
export function privateDir(): string {
  const dir = dirSetting('DAVINCI_SDK_E2E_DIR', join(homedir(), '.davinci-gnosis', 'sdk-e2e'));
  if (dir === REPO || dir.startsWith(`${REPO}/`)) {
    throw new Error(`DAVINCI_SDK_E2E_DIR=${dir} is inside the repository; keep the keys out of it`);
  }
  return dir;
}

/** Where the checked circuit files are kept between runs. */
export function artifactsDir(): string {
  return dirSetting(
    'DAVINCI_SDK_E2E_ARTIFACTS',
    join(homedir(), '.cache', 'davinci-sdk-e2e', 'artifacts')
  );
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '');
}

/** What `run` needs. */
export interface RunSettings {
  baseUrl: string;
  nodes: string[];
  organizerKeyFile: string;
  /** `DAVINCI_E2E_RPC` first, then the Gnosis preset's. */
  rpcUrls: string[];
  privateDir: string;
  artifactsDir: string;
}

/**
 * The settings of `run`.
 *
 * @throws naming every variable that is missing
 */
export function runSettings(): RunSettings {
  const missing = [
    'DAVINCI_SDK_E2E_BASE_URL',
    'DAVINCI_E2E_NODES',
    'DAVINCI_E2E_ORGANIZER_KEY',
  ].filter(name => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`the run phase needs ${missing.join(', ')} (see test/e2e/README.md)`);
  }
  const extra = list(process.env.DAVINCI_E2E_RPC);
  return {
    baseUrl: (process.env.DAVINCI_SDK_E2E_BASE_URL as string).trim().replace(/\/+$/, ''),
    nodes: list(process.env.DAVINCI_E2E_NODES),
    organizerKeyFile: resolve((process.env.DAVINCI_E2E_ORGANIZER_KEY as string).trim()),
    rpcUrls: [...new Set([...extra, ...GNOSIS.rpcUrls])],
    privateDir: privateDir(),
    artifactsDir: artifactsDir(),
  };
}

/**
 * `text` without the node and RPC URLs of the environment, which are not
 * public (an RPC URL may carry an API key): each reads `<node N>` or
 * `<rpc N>`, in the order configured.
 */
export function redact(text: string): string {
  let out = text;
  const names: [string, string][] = [
    ...list(process.env.DAVINCI_E2E_NODES).map((u, i): [string, string] => [u, `<node ${i + 1}>`]),
    ...list(process.env.DAVINCI_E2E_RPC).map((u, i): [string, string] => [u, `<rpc ${i + 1}>`]),
  ];
  // Longest first, so a URL that extends another is replaced whole.
  for (const [url, name] of names.sort((a, b) => b[0].length - a[0].length)) {
    out = out.split(url).join(name);
  }
  return out;
}

/** An error whose message and stack are {@link redact}ed. */
export function redactError(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  const out = new Error(redact(e.message));
  out.stack = e.stack === undefined ? undefined : redact(e.stack);
  return out;
}

const T0 = Date.now();

/** A progress line on stderr: UTC time and seconds since the suite started. */
export function say(message: string): void {
  const now = new Date();
  const clock = now.toISOString().slice(11, 19);
  const since = ((now.getTime() - T0) / 1000).toFixed(0).padStart(5);
  process.stderr.write(`[e2e ${clock}Z ${since}s] ${redact(message)}\n`);
}
