/**
 * @fileoverview The ballot circuit files: the `BallotProof(16)` witness wasm,
 * its Groth16 proving key and verification key, pinned by sha256 and keyed by
 * the ballot VK hash a registry pins (`ballotVKHash()`). Every file is
 * checked against its sha256, and both the verification key and the key the
 * proving key carries must hash to the registry's ballot VK hash.
 */

import { sha256, toUtf8String } from 'ethers';
import * as snarkjs from 'snarkjs';
import { ballotVkHash as vkHashOf, type SnarkjsVerificationKey } from '../crypto/groth16';
import { download } from '../core/download';
import { isNode } from '../core/runtime';
import { ArtifactError } from './errors';

/** The three circuit files. */
export type ArtifactName = 'wasm' | 'zkey' | 'vkey';

const NAMES: readonly ArtifactName[] = ['wasm', 'zkey', 'vkey'];

/** A circuit file: where it is published and its sha256 (`0x` hex). */
export interface ArtifactFile {
  url: string;
  sha256: string;
}

/** The circuit files that prove under one ballot VK. */
export interface BallotArtifactSet {
  /** Where the files come from (a davinci-circom commit or release). */
  source: string;
  /** Witness calculator, `ballot_proof.wasm`. */
  wasm: ArtifactFile;
  /** Groth16 proving key, `ballot_proof_pkey.zkey`. */
  zkey: ArtifactFile;
  /** snarkjs verification key, `ballot_proof_vkey.json`. */
  vkey: ArtifactFile;
}

const CIRCOM_A39A9F9 =
  'https://raw.githubusercontent.com/vocdoni/davinci-circom/a39a9f9867bb70726ad2137ed536d75670e042b9/artifacts';

/**
 * The circuit files this release knows, by the ballot VK hash they prove
 * under.
 *
 * `0xbf1e…bb0e`, the key of the Gnosis registry, is davinci-circom commit
 * `a39a9f9` (`BallotProof(16)`, 64,816 constraints), served from raw GitHub
 * at that commit until davinci-circom publishes a release for it. Keys added
 * later point at davinci-circom GitHub release assets
 * (`https://github.com/vocdoni/davinci-circom/releases/download/<tag>/<file>`).
 */
export const BALLOT_ARTIFACTS: Readonly<Record<string, BallotArtifactSet>> = Object.freeze({
  '0xbf1e6590bb1ba883d601c4d7d1c6fa2722a78590716874019db6d68fc776bb0e': Object.freeze({
    source: 'davinci-circom a39a9f9867bb70726ad2137ed536d75670e042b9',
    wasm: Object.freeze({
      url: `${CIRCOM_A39A9F9}/ballot_proof.wasm`,
      sha256: '0x07ecaef89f730cd4a3ee0355821a1fee4eb235fe8934f3c4bf24744bf1c7e4d5',
    }),
    zkey: Object.freeze({
      url: `${CIRCOM_A39A9F9}/ballot_proof_pkey.zkey`,
      sha256: '0x4fa825ca364142b066f4a905564f54ed9ff330e6b748c517d08708f866eedf1e',
    }),
    vkey: Object.freeze({
      url: `${CIRCOM_A39A9F9}/ballot_proof_vkey.json`,
      sha256: '0x498fa6f25d2b4adebe880eb2aa368712fba2821dda5a94efaea4d62725fa9ad7',
    }),
  }),
});

/**
 * Where one circuit file comes from instead of its table URL: a URL, a local
 * path (Node only) or the bytes themselves. It is still checked against the
 * table's sha256.
 */
export type ArtifactSource = string | { url: string } | { path: string } | { data: Uint8Array };

/** Keeps checked circuit files between loads, by sha256. Entries are checked again on reuse. */
export interface ArtifactCache {
  get(sha256: string): Uint8Array | undefined | Promise<Uint8Array | undefined>;
  set(sha256: string, data: Uint8Array): void | Promise<void>;
}

/** An {@link ArtifactCache} in memory. */
export class MemoryArtifactCache implements ArtifactCache {
  private readonly files = new Map<string, Uint8Array>();

  /** The file stored under `hash`, if any. */
  get(hash: string): Uint8Array | undefined {
    return this.files.get(hash);
  }

  /** Stores a checked file under its sha256. */
  set(hash: string, data: Uint8Array): void {
    this.files.set(hash, data);
  }
}

/** Where the circuit files come from, and how they are kept. */
export interface ArtifactsConfig {
  /** Fetch every file from `<baseUrl>/<file name>` instead of its table URL (a mirror). */
  baseUrl?: string;
  /** Read every file from `<dir>/<file name>` (Node only). */
  dir?: string;
  /** Where the witness wasm comes from; wins over `dir` and `baseUrl`. */
  wasm?: ArtifactSource;
  /** Where the proving key comes from; wins over `dir` and `baseUrl`. */
  zkey?: ArtifactSource;
  /** Where the verification key comes from; wins over `dir` and `baseUrl`. */
  vkey?: ArtifactSource;
  /**
   * Table entries by ballot VK hash, over {@link BALLOT_ARTIFACTS}: circuit
   * files for a key this release does not list (a local deployment), or other
   * files for one it does. The verification key checks apply to them too.
   */
  table?: Readonly<Record<string, BallotArtifactSet>>;
  /** Where checked files are kept across loads and provers; default none. */
  cache?: ArtifactCache;
  /** Replaces the global `fetch` for downloads. */
  fetchImpl?: typeof fetch;
  /**
   * Longest wait, in ms, for a download's answer or for more of its body; a
   * stalled download fails after it. Slow downloads that keep receiving data
   * are not cut. Default {@link ARTIFACT_STALL_TIMEOUT_MS}.
   */
  timeoutMs?: number;
}

/** Default {@link ArtifactsConfig.timeoutMs}: a minute without data. */
export const ARTIFACT_STALL_TIMEOUT_MS = 60_000;

/** The checked circuit files of one ballot VK. */
export interface BallotArtifacts {
  /** The ballot VK hash they prove under. */
  ballotVkHash: string;
  /** The table entry's `source`. */
  source: string;
  wasm: Uint8Array;
  zkey: Uint8Array;
  vkey: SnarkjsVerificationKey;
}

/**
 * A 32-byte hash (a ballot VK hash, a file's sha256) as the table writes it:
 * `0x` + 64 lowercase hex digits.
 *
 * @throws TypeError for anything else
 */
export function normalizeHash(hash: string): string {
  const h = hash.startsWith('0x') ? hash.slice(2) : hash;
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new TypeError(`${hash} is not a 32-byte hash`);
  return `0x${h.toLowerCase()}`;
}

const isHash = (v: unknown) => typeof v === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(v);

/**
 * Checks an artifacts configuration: every table key is a 32-byte hash (in
 * one spelling only), every entry lists the three files with a URL and a
 * sha256, and `timeoutMs` is a positive number.
 *
 * @throws ArtifactError naming the first thing that is wrong
 */
export function checkArtifactsConfig(config: ArtifactsConfig = {}): void {
  const { table = {}, timeoutMs } = config;
  if (timeoutMs !== undefined && !(typeof timeoutMs === 'number' && timeoutMs > 0)) {
    throw new ArtifactError(`artifacts timeoutMs ${String(timeoutMs)} is not a positive number`);
  }
  const seen = new Set<string>();
  for (const [key, entry] of Object.entries(table)) {
    if (!isHash(key)) {
      throw new ArtifactError(`artifacts table key "${key}" is not a 32-byte ballot VK hash`);
    }
    const k = normalizeHash(key);
    if (seen.has(k)) throw new ArtifactError(`artifacts table lists ${k} twice`);
    seen.add(k);
    for (const name of NAMES) {
      const file = (entry as Partial<BallotArtifactSet> | undefined)?.[name];
      if (typeof file?.url !== 'string' || !isHash(file.sha256)) {
        throw new ArtifactError(
          `artifacts table entry ${k}: ${name} needs a url and a 32-byte sha256`,
          name
        );
      }
    }
  }
}

/**
 * The table entry of a ballot VK hash: `table` over {@link BALLOT_ARTIFACTS}.
 *
 * @throws ArtifactError when neither lists the key, or `table` is malformed
 */
export function ballotArtifactSet(
  ballotVkHash: string,
  table: Readonly<Record<string, BallotArtifactSet>> = {}
): BallotArtifactSet {
  checkArtifactsConfig({ table });
  const key = normalizeHash(ballotVkHash);
  const own = Object.entries(table).find(([k]) => normalizeHash(k) === key)?.[1];
  const entry = own ?? BALLOT_ARTIFACTS[key];
  if (!entry) {
    throw new ArtifactError(
      `no ballot circuit files are known for ballot VK hash ${key}; ` +
        'give them in the artifacts table'
    );
  }
  return entry;
}

type Source = { url: string } | { path: string } | { data: Uint8Array };

function describe(src: Source): string {
  if ('url' in src) return src.url;
  if ('path' in src) return src.path;
  return 'the bytes given';
}

// A per-file source, else `<dir>/<name>`, else `<baseUrl>/<name>`, else the table URL.
function sourceOf(name: ArtifactName, file: ArtifactFile, config: ArtifactsConfig): Source {
  const own = config[name];
  if (own !== undefined) return typeof own === 'string' ? { url: own } : own;
  const fileName = file.url.split(/[?#]/)[0].split('/').pop() ?? '';
  if (config.dir !== undefined) return { path: `${config.dir.replace(/\/+$/, '')}/${fileName}` };
  if (config.baseUrl !== undefined) {
    return { url: `${config.baseUrl.replace(/\/+$/, '')}/${fileName}` };
  }
  return { url: file.url };
}

// Node's fs, loaded only for a local path; the specifier is a variable so
// bundlers leave it alone.
async function readLocal(path: string): Promise<Uint8Array> {
  if (!isNode()) throw new Error('local paths can only be read in Node');
  const fsPromises = 'node:fs/promises';
  const fs = (await import(/* webpackIgnore: true */ /* @vite-ignore */ fsPromises)) as {
    readFile(p: string): Promise<Uint8Array>;
  };
  const buf = await fs.readFile(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function read(src: Source, config: ArtifactsConfig): Promise<Uint8Array> {
  if ('data' in src) return src.data;
  if ('path' in src) return readLocal(src.path);
  const { bytes } = await download(src.url, {
    fetchImpl: config.fetchImpl,
    stallTimeoutMs: config.timeoutMs ?? ARTIFACT_STALL_TIMEOUT_MS,
  });
  return bytes;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * One circuit file, from the cache or its source, checked against its sha256.
 *
 * @throws ArtifactError when it cannot be read or its sha256 differs
 */
export async function loadArtifactFile(
  name: ArtifactName,
  file: ArtifactFile,
  config: ArtifactsConfig = {}
): Promise<Uint8Array> {
  const want = normalizeHash(file.sha256);
  const cached = await config.cache?.get(want);
  if (cached && sha256(cached) === want) return cached;

  const src = sourceOf(name, file, config);
  let data: Uint8Array;
  try {
    data = await read(src, config);
  } catch (err) {
    throw new ArtifactError(`${name}: cannot read ${describe(src)}: ${message(err)}`, name, err);
  }
  const got = sha256(data);
  if (got !== want) {
    throw new ArtifactError(`${name}: ${describe(src)} has sha256 ${got}, want ${want}`, name);
  }
  await config.cache?.set(want, data);
  return data;
}

/**
 * Checks a verification key hashes (VK wire bytes) to the registry's ballot VK hash.
 *
 * @throws ArtifactError for a malformed key or another key
 */
export function checkVerificationKey(
  name: ArtifactName,
  vk: unknown,
  ballotVkHash: string
): SnarkjsVerificationKey {
  const want = normalizeHash(ballotVkHash);
  let got: string;
  try {
    got = vkHashOf(vk as SnarkjsVerificationKey);
  } catch (err) {
    throw new ArtifactError(`${name}: not a ballot verification key: ${message(err)}`, name, err);
  }
  if (got !== want) {
    throw new ArtifactError(
      `${name}: its verification key hashes to ${got}, the registry pins ${want}`,
      name
    );
  }
  return vk as SnarkjsVerificationKey;
}

/**
 * Loads the circuit files of a ballot VK hash (read it from the registry,
 * `ballotVKHash()`), from the table entry or the overrides of `config`.
 * Each file must match the entry's sha256; the verification key and the key
 * the proving key carries must both hash to `ballotVkHash`, so no override
 * can make the SDK prove under another key.
 *
 * @throws ArtifactError when a file is unknown, unreadable or not the pinned one
 *
 * @example
 * ```typescript
 * const files = await loadBallotArtifacts(await registry.getBallotVKHash());
 * // Self-hosted copies, still checked against the pinned sha256s:
 * await loadBallotArtifacts(hash, { baseUrl: 'https://cdn.example.org/davinci' });
 * ```
 */
export async function loadBallotArtifacts(
  ballotVkHash: string,
  config: ArtifactsConfig = {}
): Promise<BallotArtifacts> {
  checkArtifactsConfig(config);
  const key = normalizeHash(ballotVkHash);
  const entry = ballotArtifactSet(key, config.table);
  const [wasm, zkey, vkeyBytes] = await Promise.all(
    NAMES.map(name => loadArtifactFile(name, entry[name], config))
  );

  let vkJson: unknown;
  try {
    vkJson = JSON.parse(toUtf8String(vkeyBytes));
  } catch (err) {
    throw new ArtifactError(`vkey: not JSON: ${message(err)}`, 'vkey', err);
  }
  const vkey = checkVerificationKey('vkey', vkJson, key);

  let carried: unknown;
  try {
    carried = await snarkjs.zKey.exportVerificationKey(zkey);
  } catch (err) {
    throw new ArtifactError(`zkey: not a proving key: ${message(err)}`, 'zkey', err);
  }
  checkVerificationKey('zkey', carried, key);

  return { ballotVkHash: key, source: entry.source, wasm, zkey, vkey };
}
