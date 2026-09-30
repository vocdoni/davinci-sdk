/**
 * @fileoverview Election metadata documents: building one, its exact bytes
 * and hash, publishing it through an {@link Uploader}, and reading one back
 * against the registry's `metadataHash`.
 *
 * The registry stores a document's URI and the SHA-256 of the exact bytes
 * served there, with no JSON canonicalisation (davinci-sequencer
 * `client/src/organizer.rs`, `metadata_hash`), and readers hash the bytes
 * they download (davinci-explorer `src/protocol/metadata.ts`). The SDK
 * therefore fixes the bytes of a document: UTF-8 JSON, two-space
 * indentation, keys in a fixed order and a final newline, which is what
 * davinci-sequencer's demo writes for the same content (`e2e/src/demo.rs`,
 * `render`).
 *
 * The URI is chosen by the organizer, and `getProcess` reads it from wherever
 * the SDK runs, so every metadata download follows the census URL policy
 * (`checkPublicUrl`): `http(s)` on a public host unless `allowPrivateHosts`,
 * and no redirect. A URL outside it is refused before any request.
 */

import { sha256, toUtf8Bytes } from 'ethers';
import { UrlPolicyError, checkPublicUrl, download, type Downloaded } from './download';
import type { ElectionPreset } from './types/ballot';
import type { ElectionMetadata, ElectionMetadataConfig, MultiLanguage } from './types/metadata';
import { DOCUMENT_TIMEOUT_MS, type DocumentOptions, type Uploader } from './types/uploader';

/** The metadata version the SDK writes. */
export const METADATA_VERSION = '1.1';

/** Largest metadata document the SDK publishes or reads. */
export const MAX_METADATA_BYTES = 4 * 1024 * 1024;

/** A metadata document that cannot be built, published or read. */
export class MetadataError extends Error {
  /**
   * @param message - What went wrong
   * @param uri - The document's URL, when there is one
   * @param cause - The underlying error
   */
  constructor(
    message: string,
    public readonly uri?: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * What a process's metadata URL served: `verified` when the bytes hash to
 * the registry's `metadataHash`, `mismatch` when they do not (the document
 * is not the one the organizer committed), `unreachable` when it could not
 * be downloaded, `refused` when the URL is not one the SDK reads (not
 * `http(s)`, or a host that is not public). `refused` is decided from the
 * URL alone, before any request, so it says nothing about any network; the
 * other three come only from public hosts, which anyone can probe.
 */
export type MetadataStatus = 'verified' | 'mismatch' | 'unreachable' | 'refused';

/** The result of {@link readMetadata}. */
export interface MetadataRead {
  status: MetadataStatus;
  /** sha256 of the bytes served, `0x` hex, when they were read. */
  hash?: string;
  /** The document parsed from the verified bytes; absent unless verified and JSON. */
  document?: unknown;
  /** Why the document is not verified, or why verified bytes are not JSON. */
  error?: string;
}

/** A published metadata document: the process's `metadataURI` and `metadataHash`. */
export interface PublishedMetadata {
  uri: string;
  hash: string;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Plain text as `{ default }`; a multi-language object with `default` first.
function text(v: unknown, path: string): MultiLanguage<string> {
  if (typeof v === 'string') return { default: v };
  if (isObject(v) && typeof v.default === 'string') {
    const { default: first, ...rest } = v;
    for (const [lang, t] of Object.entries(rest)) {
      if (typeof t !== 'string') throw new MetadataError(`${path}.${lang} is not a string`);
    }
    return { default: first, ...(rest as Record<string, string>) };
  }
  throw new MetadataError(`${path} is not text: want a string or { default, ...languages }`);
}

/**
 * A preset as the demo documents write it: the discriminator first, optional
 * bounds with their default (`allowAbstain` only when true).
 */
function canonicalPreset(p: ElectionPreset): ElectionPreset {
  switch (p.type) {
    case 'single_choice':
      return p.allowAbstain ? { type: p.type, allowAbstain: true } : { type: p.type };
    case 'multiple_choice':
      return {
        type: p.type,
        maxSelections: p.maxSelections,
        minSelections: p.minSelections ?? 0,
      };
    case 'rating':
      return { type: p.type, maxValue: p.maxValue, minValue: p.minValue ?? 0 };
    case 'quadratic':
      return { type: p.type, budget: p.budget, minValueSum: p.minValueSum ?? 0 };
    case 'approval':
    case 'ranking':
      return { type: p.type };
    default:
      return p;
  }
}

const KNOWN_PRESETS = new Set([
  'single_choice',
  'multiple_choice',
  'approval',
  'rating',
  'ranking',
  'quadratic',
]);

function canonicalMeta(meta: unknown): unknown {
  if (!isObject(meta)) return meta;
  const { electionPreset, ...rest } = meta;
  const preset =
    isObject(electionPreset) && KNOWN_PRESETS.has(electionPreset.type as string)
      ? canonicalPreset(electionPreset as ElectionPreset)
      : electionPreset;
  return { ...(preset !== undefined && { electionPreset: preset }), ...rest };
}

function value(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new MetadataError(`${path} is not a non-negative integer`);
  }
  return v;
}

function canonicalChoice(c: unknown, path: string): Json {
  if (!isObject(c)) throw new MetadataError(`${path} is not an object`);
  const { title, value: v, meta, ...rest } = c;
  return {
    title: text(title, `${path}.title`),
    value: value(v, `${path}.value`),
    ...(meta !== undefined && { meta }),
    ...rest,
  };
}

function canonicalQuestion(q: unknown, path: string): Json {
  if (!isObject(q)) throw new MetadataError(`${path} is not an object`);
  const { title, description, choices, meta, ...rest } = q;
  if (!Array.isArray(choices)) throw new MetadataError(`${path}.choices is not a list`);
  return {
    title: text(title, `${path}.title`),
    ...(description !== undefined && { description: text(description, `${path}.description`) }),
    choices: choices.map((c, i) => canonicalChoice(c, `${path}.choices[${i}]`)),
    ...(meta !== undefined && { meta }),
    ...rest,
  };
}

// The document with its keys in the SDK's order; other keys keep theirs, after.
function canonical(doc: unknown): Json {
  if (!isObject(doc)) throw new MetadataError('the metadata document is not an object');
  const { version, title, description, media, questions, meta, ...rest } = doc;
  if (!Array.isArray(questions)) throw new MetadataError('questions is not a list');
  let mediaOut: Json | undefined;
  if (media !== undefined) {
    if (!isObject(media)) throw new MetadataError('media is not an object');
    const { header, logo, ...more } = media;
    mediaOut = {
      ...(header !== undefined && { header }),
      ...(logo !== undefined && { logo }),
      ...more,
    };
  }
  return {
    ...(version !== undefined && { version }),
    title: text(title, 'title'),
    ...(description !== undefined && { description: text(description, 'description') }),
    ...(mediaOut && { media: mediaOut }),
    questions: questions.map((q, i) => canonicalQuestion(q, `questions[${i}]`)),
    ...(meta !== undefined && { meta: canonicalMeta(meta) }),
    ...rest,
  };
}

/**
 * The metadata document of an election, as davinci-sequencer's demo writes
 * one: version `1.1`, the title and description, the questions with their
 * choices (`value` is the ballot field a choice fills), and
 * `meta.electionPreset` when there is a preset. Text is plain (`default`
 * only) or multi-language; a missing description is empty.
 *
 * @throws MetadataError for no question, a question without choices, or a
 *   choice value that is not a non-negative integer or repeats in its question
 *
 * @example
 * ```typescript
 * const doc = buildElectionMetadata({
 *   title: { default: 'Budget', en: 'Budget', es: 'Presupuesto' },
 *   questions: [{ title: 'Which project?', choices: [{ title: 'Park', value: 0 }, { title: 'Library', value: 1 }] }],
 *   electionPreset: { type: 'single_choice' },
 * });
 * const bytes = serializeMetadata(doc);
 * ```
 */
export function buildElectionMetadata(config: ElectionMetadataConfig): ElectionMetadata {
  if (!config.questions || config.questions.length === 0) {
    throw new MetadataError('an election needs at least one question');
  }
  const questions = config.questions.map((q, i) => {
    const path = `questions[${i}]`;
    if (!q.choices || q.choices.length === 0) {
      throw new MetadataError(`${path} has no choices`);
    }
    const seen = new Set<number>();
    return {
      title: text(q.title, `${path}.title`),
      description: text(q.description ?? '', `${path}.description`),
      choices: q.choices.map((c, j) => {
        const v = value(c.value, `${path}.choices[${j}].value`);
        if (seen.has(v)) throw new MetadataError(`${path} gives value ${v} to two choices`);
        seen.add(v);
        return {
          title: text(c.title, `${path}.choices[${j}].title`),
          value: v,
          ...(c.meta !== undefined && { meta: c.meta }),
        };
      }),
      ...(q.meta !== undefined && { meta: q.meta }),
    };
  });
  if (config.electionPreset !== undefined && config.meta?.electionPreset !== undefined) {
    throw new MetadataError('give the election preset once, as electionPreset');
  }
  const meta: ElectionMetadata['meta'] =
    config.electionPreset !== undefined || config.meta !== undefined
      ? {
          ...(config.electionPreset !== undefined && {
            electionPreset: canonicalPreset(config.electionPreset),
          }),
          ...config.meta,
        }
      : undefined;
  return {
    version: METADATA_VERSION,
    title: text(config.title, 'title'),
    description: text(config.description ?? '', 'description'),
    ...(config.media && { media: { ...config.media } }),
    questions,
    ...(meta && { meta }),
  };
}

/**
 * The exact bytes of a metadata document: UTF-8 JSON with two-space
 * indentation and a final newline, keys in the order of `ElectionMetadata`
 * (other keys after, in their own order), multi-language text with
 * `default` first, and a known election preset with its defaults written
 * out. Hash these bytes (`metadataHash`) and serve them unchanged.
 *
 * Byte equality with the Rust writer (serde_json) holds for integer numbers
 * only: a number such as `1.0` or `1e21` in free-form `meta` is written `1`
 * or `1e+21` here and `1.0` or `1e21` there, so a document rebuilt from
 * another writer's fields can hash differently. Keep such values as strings.
 *
 * @throws MetadataError for a document that is not one (no title, questions
 *   that are not a list, a value that is not JSON)
 */
export function serializeMetadata(doc: ElectionMetadata): Uint8Array {
  let json: string;
  try {
    json = JSON.stringify(canonical(doc), null, 2);
  } catch (err) {
    if (err instanceof MetadataError) throw err;
    throw new MetadataError(`the metadata document is not JSON: ${message(err)}`, undefined, err);
  }
  return toUtf8Bytes(`${json}\n`);
}

/** The bytes to publish: a document serialized, or bytes (or text) given as they are. */
function bytesOf(document: ElectionMetadata | Uint8Array | string): Uint8Array {
  if (document instanceof Uint8Array) return document;
  if (typeof document === 'string') return toUtf8Bytes(document);
  return serializeMetadata(document);
}

// The bytes at a metadata URL, under the URL policy and with no redirect.
async function downloadMetadata(uri: string, options: DocumentOptions): Promise<Downloaded> {
  const url = checkPublicUrl(uri, options);
  return download(url.href, {
    fetchImpl: options.fetchImpl,
    stallTimeoutMs: options.timeoutMs ?? DOCUMENT_TIMEOUT_MS,
    maxBytes: MAX_METADATA_BYTES,
    redirect: 'manual',
  });
}

function readError(uri: string, err: unknown): MetadataError {
  const why = err instanceof UrlPolicyError ? 'refused' : 'cannot read';
  return new MetadataError(`${why} the metadata at ${uri}: ${message(err)}`, uri, err);
}

/**
 * Publishes a metadata document through `uploader` and returns its URL and
 * hash, for `newProcess` or `setProcessMetadata`. A document is serialized
 * with {@link serializeMetadata}; bytes are published as given. The URL must
 * be one readers download (`checkPublicUrl`) and, unless `verify` is false,
 * it is read back and must serve the same bytes with no redirect.
 *
 * @throws MetadataError when the upload fails, or the URL is refused or
 *   serves other bytes
 */
export async function publishMetadata(
  document: ElectionMetadata | Uint8Array | string,
  uploader: Uploader,
  options: DocumentOptions = {}
): Promise<PublishedMetadata> {
  const data = bytesOf(document);
  if (data.length > MAX_METADATA_BYTES) {
    throw new MetadataError(`the metadata document is over ${MAX_METADATA_BYTES} bytes`);
  }
  const hash = sha256(data);
  let uri: string;
  try {
    uri = await uploader.upload({
      kind: 'metadata',
      data,
      contentType: 'application/json',
      sha256: hash,
    });
  } catch (err) {
    throw new MetadataError(`the metadata upload failed: ${message(err)}`, undefined, err);
  }
  if (typeof uri !== 'string' || uri === '') {
    throw new MetadataError('the uploader returned no URL');
  }
  try {
    checkPublicUrl(uri, options);
  } catch (err) {
    throw readError(uri, err);
  }
  if (options.verify !== false) {
    let served: Downloaded;
    try {
      served = await downloadMetadata(uri, options);
    } catch (err) {
      throw readError(uri, err);
    }
    const got = sha256(served.bytes);
    if (got !== hash) {
      throw new MetadataError(`${uri} serves bytes that hash to ${got}, not ${hash}`, uri);
    }
  }
  return { uri, hash };
}

/**
 * The `metadataHash` of the document served at `uri`: the SHA-256 of the
 * bytes downloaded, under the URL policy and with no redirect.
 *
 * @throws MetadataError when the URL is refused or cannot be downloaded
 */
export async function fetchMetadataHash(
  uri: string,
  options: DocumentOptions = {}
): Promise<string> {
  try {
    return sha256((await downloadMetadata(uri, options)).bytes);
  } catch (err) {
    throw readError(uri, err);
  }
}

/**
 * Downloads a process's metadata document and checks it against the
 * registry's `metadataHash`. The JSON is parsed from the bytes that were
 * hashed, and only when they match, so what a reader shows is what the
 * organizer committed. A URL outside the policy (`checkPublicUrl`) is
 * `refused` without a request; a redirect is `unreachable` and is not
 * followed. Never throws: a failure is a status.
 */
export async function readMetadata(
  uri: string,
  expectedHash: string,
  options: DocumentOptions = {}
): Promise<MetadataRead> {
  let served: Downloaded;
  try {
    served = await downloadMetadata(uri, options);
  } catch (err) {
    if (err instanceof UrlPolicyError) {
      return { status: 'refused', error: `not read: ${message(err)}` };
    }
    return { status: 'unreachable', error: `cannot read ${uri}: ${message(err)}` };
  }
  const hash = sha256(served.bytes);
  const want = expectedHash.toLowerCase();
  if (hash !== want) {
    return {
      status: 'mismatch',
      hash,
      error: `${uri} serves bytes that hash to ${hash}; the registry has ${want}`,
    };
  }
  try {
    // A leading byte-order mark is dropped, as a JSON reader would; the hash covers it.
    const json = new TextDecoder('utf-8', { fatal: true }).decode(served.bytes);
    return { status: 'verified', hash, document: JSON.parse(json) as unknown };
  } catch (err) {
    return { status: 'verified', hash, error: `the document is not UTF-8 JSON: ${message(err)}` };
  }
}

/**
 * A metadata text in one language: plain text as it is, or from a
 * multi-language object the `lang` entry, else `default`.
 */
export function localizedText(v: unknown, lang?: string): string | undefined {
  if (typeof v === 'string') return v;
  if (!isObject(v)) return undefined;
  const pick = lang !== undefined ? v[lang] : undefined;
  if (typeof pick === 'string') return pick;
  return typeof v.default === 'string' ? v.default : undefined;
}
