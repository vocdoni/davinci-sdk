/**
 * @fileoverview Publishing a Merkle census file through an {@link Uploader},
 * and checking a census URL the way the sequencer nodes read it
 * (davinci-sequencer `sequencer/src/census.rs`): `http(s)` on a public host,
 * a 200 answer with no redirect, at most 256 MiB, JSON (not JSON lines), and
 * a document whose lean-IMT root is the one the registry gets. A census the
 * nodes cannot load leaves its process ignored, and the organizer has to
 * create another; these checks catch that before `newProcess`.
 */

import { sha256 } from 'ethers';
import { checkPublicUrl, download, type Downloaded } from '../core/download';
import { DOCUMENT_TIMEOUT_MS, type DocumentOptions, type Uploader } from '../core/types/uploader';
import type { MerkleCensus } from './classes/MerkleCensus';
import { OffchainCensus } from './classes/OffchainCensus';
import { CensusError, CensusPublishError } from './errors';

/** Largest census file a node reads. */
export const MAX_CENSUS_BYTES = 256 * 1024 * 1024;

/** Most members a node loads (its default `--census-max-participants`). */
export const MAX_CENSUS_MEMBERS = 1 << 22;

/** A published census file. */
export interface PublishedCensusFile {
  /** Where it is served: the process's `censusURI`. */
  uri: string;
  /** Its lean-IMT root, `bytes32` hex: the process's census root. */
  root: string;
  /** Members. */
  size: number;
  /** sha256 of the bytes uploaded, `0x` hex. */
  sha256: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Checks a census URL is one nodes download: `http` or `https`, and not a
 * loopback, private or otherwise non-public address (unless
 * `allowPrivateHosts`). See `checkPublicUrl`: a host name is not resolved.
 *
 * @throws CensusPublishError
 */
export function checkCensusUrl(uri: string, options: { allowPrivateHosts?: boolean } = {}): URL {
  try {
    return checkPublicUrl(uri, options);
  } catch (err) {
    throw new CensusPublishError(
      `census URL ${uri}: ${message(err)}; nodes would refuse it`,
      uri,
      err
    );
  }
}

const rootHex = (root: bigint) => `0x${root.toString(16).padStart(64, '0')}`;

// The bytes at a census URL, read under the nodes' rules.
async function readCensusUrl(uri: string, options: DocumentOptions): Promise<Uint8Array> {
  const url = checkCensusUrl(uri, options);
  let got: Downloaded;
  try {
    got = await download(url.href, {
      fetchImpl: options.fetchImpl,
      stallTimeoutMs: options.timeoutMs ?? DOCUMENT_TIMEOUT_MS,
      maxBytes: MAX_CENSUS_BYTES,
      redirect: 'manual',
    });
  } catch (err) {
    throw new CensusPublishError(`cannot read the census at ${uri}: ${message(err)}`, uri, err);
  }
  if (got.status !== 200) {
    throw new CensusPublishError(
      `the census at ${uri} answers ${got.status}; nodes need a 200`,
      uri
    );
  }
  const type = got.contentType?.toLowerCase() ?? '';
  if (type.includes('ndjson') || type.includes('jsonl')) {
    throw new CensusPublishError(
      `the census at ${uri} is served as ${type}; nodes would read it as JSON lines`,
      uri
    );
  }
  return got.bytes;
}

// Parses census bytes and checks their root.
async function checkCensusBytes(
  uri: string,
  bytes: Uint8Array,
  want: bigint
): Promise<{ root: string; size: number }> {
  let served: OffchainCensus;
  try {
    served = OffchainCensus.fromJSON(bytes);
  } catch (err) {
    throw new CensusPublishError(
      `${uri} does not serve a census the nodes accept: ${message(err)}`,
      uri,
      err
    );
  }
  const root = await served.root();
  if (BigInt(root) !== want) {
    throw new CensusPublishError(
      `${uri} serves a census with root ${root}, not ${rootHex(want)}`,
      uri
    );
  }
  return { root, size: served.size };
}

/**
 * Downloads a census URL as the nodes do and checks it serves a census
 * whose lean-IMT root is `root`: use it for a census file published
 * elsewhere before a process points at it.
 *
 * @returns The root and member count of the census served
 * @throws CensusPublishError naming what the nodes would refuse
 */
export async function verifyCensusUrl(
  uri: string,
  root: string | bigint,
  options: DocumentOptions = {}
): Promise<{ root: string; size: number }> {
  return checkCensusBytes(uri, await readCensusUrl(uri, options), BigInt(root));
}

/**
 * Publishes a Merkle census: serializes it, uploads the file through
 * `uploader`, checks the URL (unless `verify` is false, by
 * downloading it back as the nodes will) and records the root and URL on
 * the census.
 *
 * @throws CensusError for an empty or oversized census, CensusPublishError
 *   when the upload fails or the URL would not load at the nodes
 *
 * @example
 * ```typescript
 * const { uri, root } = await publishCensus(census, uploader);
 * ```
 */
export async function publishCensus(
  census: MerkleCensus,
  uploader: Uploader,
  options: DocumentOptions = {}
): Promise<PublishedCensusFile> {
  if (census.size === 0) throw new CensusError('the census has no members');
  if (census.size > MAX_CENSUS_MEMBERS) {
    throw new CensusError(`${census.size} members; nodes load at most ${MAX_CENSUS_MEMBERS}`);
  }
  const data = census.serialize();
  if (data.length > MAX_CENSUS_BYTES) {
    throw new CensusError(`the census file is ${data.length} bytes; nodes read at most 256 MiB`);
  }
  const root = await census.root();
  const hash = sha256(data);
  let uri: string;
  try {
    uri = await uploader.upload({
      kind: 'census',
      data,
      contentType: 'application/json',
      sha256: hash,
    });
  } catch (err) {
    throw new CensusPublishError(`the census upload failed: ${message(err)}`, undefined, err);
  }
  if (typeof uri !== 'string' || uri === '') {
    throw new CensusPublishError('the uploader returned no URL');
  }
  checkCensusUrl(uri, options);
  if (options.verify !== false) {
    // The bytes uploaded are a census the nodes accept; anything else is parsed.
    const served = await readCensusUrl(uri, options);
    if (sha256(served) !== hash) await checkCensusBytes(uri, served, BigInt(root));
  }
  census._setPublishedData(root, uri);
  return { uri, root, size: census.size, sha256: hash };
}
