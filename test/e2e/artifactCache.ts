/**
 * @fileoverview The circuit files between runs: an `ArtifactCache` over a
 * directory, one file per sha256, with the bytes also kept in memory so every
 * prover of a run shares one copy. The SDK hashes each cached file again
 * before it uses it, so a damaged file is downloaded anew.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactCache } from '../../src/prover/artifacts';

export class DirArtifactCache implements ArtifactCache {
  private readonly memory = new Map<string, Uint8Array>();

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(sha256: string): string {
    const hex = sha256.replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a sha256: ${sha256}`);
    return join(this.dir, hex);
  }

  get(sha256: string): Uint8Array | undefined {
    const path = this.path(sha256);
    let data = this.memory.get(path);
    if (!data) {
      try {
        data = new Uint8Array(readFileSync(path));
      } catch {
        return undefined;
      }
      this.memory.set(path, data);
    }
    return data;
  }

  set(sha256: string, data: Uint8Array): void {
    const path = this.path(sha256);
    this.memory.set(path, data);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  }
}
