/**
 * @fileoverview Serving the suite's documents: the committed fixtures, read
 * back from where they are served (raw GitHub at a pushed commit), and an
 * uploader over them. The SDK publishes census files and metadata through an
 * `Uploader`; this one uploads nothing, it answers the URL of the committed
 * file with the same bytes and refuses anything else, so a run creates only
 * what `prepare` wrote and the commit holds.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { UploadRequest, Uploader } from '../../src/core/types/uploader';
import { fileHash } from './spec';

/** The files in `dir` (the fixtures), by name. */
export function readFixtures(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith('.json')) files.set(name, new Uint8Array(readFileSync(join(dir, name))));
  }
  return files;
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * How two file sets differ: files missing on either side, and files whose
 * bytes differ. Empty when they are equal.
 */
export function fixtureDiff(
  want: ReadonlyMap<string, Uint8Array>,
  got: ReadonlyMap<string, Uint8Array>
): string[] {
  const out: string[] = [];
  for (const [name, bytes] of want) {
    const other = got.get(name);
    if (!other) out.push(`${name} is missing`);
    else if (!same(bytes, other)) out.push(`${name} differs`);
  }
  for (const name of got.keys()) if (!want.has(name)) out.push(`${name} is not expected`);
  return out;
}

/**
 * Downloads every file from `baseUrl` as a node would (no redirect, a 200)
 * and compares it with the local copy.
 *
 * @throws listing every file that is not served as committed
 */
export async function checkServed(
  baseUrl: string,
  files: ReadonlyMap<string, Uint8Array>,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const problems = await Promise.all(
    [...files].map(async ([name, bytes]) => {
      const url = `${baseUrl}/${name}`;
      try {
        const res = await fetchImpl(url, { redirect: 'manual' });
        if (res.status !== 200) return `${url}: HTTP ${res.status}`;
        const body = new Uint8Array(await res.arrayBuffer());
        return same(body, bytes) ? null : `${url}: not the committed bytes`;
      } catch (err) {
        return `${url}: ${err instanceof Error ? err.message : String(err)}`;
      }
    })
  );
  const bad = problems.filter((p): p is string => p !== null);
  if (bad.length > 0) {
    throw new Error(
      `the fixtures are not served as committed (push the commit and point ` +
        `DAVINCI_SDK_E2E_BASE_URL at it):\n  ${bad.join('\n  ')}`
    );
  }
}

/** The committed fixtures at their public URL. */
export class FixtureHost {
  private readonly byHash = new Map<string, string>();

  /**
   * @param baseUrl - Where the fixtures directory is served, no trailing slash
   * @param files - The fixtures, by name
   */
  constructor(
    readonly baseUrl: string,
    files: ReadonlyMap<string, Uint8Array>
  ) {
    for (const [name, bytes] of files) this.byHash.set(fileHash(bytes), name);
  }

  /** The public URL of a fixture. */
  url(name: string): string {
    if (![...this.byHash.values()].includes(name)) throw new Error(`no fixture ${name}`);
    return `${this.baseUrl}/${name}`;
  }

  /** Publishes by pointing at the committed file with the same bytes. */
  readonly uploader: Uploader = {
    upload: (request: UploadRequest): Promise<string> => {
      const name = this.byHash.get(fileHash(request.data));
      if (name === undefined) {
        return Promise.reject(
          new Error(
            `the ${request.kind} with sha256 ${fileHash(request.data)} is not a committed ` +
              'fixture: run prepare, then commit and push test/e2e/fixtures'
          )
        );
      }
      return Promise.resolve(`${this.baseUrl}/${name}`);
    },
  };
}
