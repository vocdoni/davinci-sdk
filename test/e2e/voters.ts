/**
 * @fileoverview The voter keys of the file-based censuses, kept in the
 * private directory (mode 0700, the file 0600) and never in the repository.
 * `prepare` draws them once; every later `prepare` and `run` reuses them, so
 * the census files built from them do not change.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet } from 'ethers';

/** The voters' file in the private directory. */
export const VOTERS_FILE = 'voters.json';

/** Private keys by group name (a scenario), `0x` + 64 hex digits each. */
export type VoterKeys = Record<string, string[]>;

const KEY = /^0x[0-9a-f]{64}$/;

function parse(text: string, path: string): VoterKeys {
  const json = JSON.parse(text) as unknown;
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error(`${path}: not a voters file`);
  }
  const keys: VoterKeys = {};
  for (const [group, list] of Object.entries(json)) {
    if (!Array.isArray(list) || !list.every(k => typeof k === 'string' && KEY.test(k))) {
      throw new Error(`${path}: ${group} is not a list of private keys`);
    }
    keys[group] = list as string[];
  }
  return keys;
}

/**
 * The voter keys in `dir`.
 *
 * @throws when the file is missing (run `prepare`) or malformed
 */
export function loadVoterKeys(dir: string): VoterKeys {
  const path = join(dir, VOTERS_FILE);
  if (!existsSync(path)) {
    throw new Error(`no voter keys in ${dir}: run the prepare phase first`);
  }
  return parse(readFileSync(path, 'utf8'), path);
}

/**
 * The voter keys in `dir`, with keys drawn for every group of `counts` that
 * has fewer (existing keys are kept, so the censuses built from them do not
 * change). Creates `dir` with mode 0700 and writes the file with mode 0600
 * when anything was drawn.
 */
export function ensureVoterKeys(dir: string, counts: Readonly<Record<string, number>>): VoterKeys {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, VOTERS_FILE);
  const keys = existsSync(path) ? parse(readFileSync(path, 'utf8'), path) : {};
  let drawn = 0;
  for (const [group, count] of Object.entries(counts)) {
    const list = (keys[group] ??= []);
    while (list.length < count) {
      list.push(Wallet.createRandom().privateKey);
      drawn++;
    }
  }
  if (drawn > 0 || !existsSync(path)) {
    writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  return keys;
}

/** The first `count` wallets of a group. */
export function walletsOf(keys: VoterKeys, group: string, count: number): Wallet[] {
  const list = keys[group] ?? [];
  if (list.length < count) {
    throw new Error(
      `the voters file has ${list.length} keys for ${group}, the suite needs ${count}: run prepare`
    );
  }
  return list.slice(0, count).map(k => new Wallet(k));
}
