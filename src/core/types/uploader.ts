/** What the SDK publishes through an {@link Uploader}. */
export type UploadKind = 'census' | 'metadata';

/** One document to publish. */
export interface UploadRequest {
  kind: UploadKind;
  /** The exact bytes to serve: nodes and voters hash what they download. */
  data: Uint8Array;
  /** Media type of `data`, `application/json` for both kinds. */
  contentType: string;
  /**
   * sha256 of `data`, `0x` + 64 hex digits. It is a metadata document's
   * on-chain `metadataHash`, and a stable name for content-addressed hosts.
   */
  sha256: string;
}

/**
 * Publishes census files and metadata documents where nodes and voters can
 * fetch them. The SDK ships no hosting: bring an implementation for the store
 * you use (an object store, a gist, an IPFS gateway).
 *
 * The returned URL must serve the bytes unchanged over public `https`.
 * Sequencer nodes download a Merkle census at process creation and refuse
 * `file://` URLs, private hosts and redirects, and a census they cannot load
 * leaves the process ignored.
 *
 * @example
 * ```typescript
 * const uploader: Uploader = {
 *   async upload({ data, contentType, sha256 }) {
 *     const key = `davinci/${sha256.slice(2)}.json`;
 *     await bucket.put(key, data, { contentType });
 *     return `https://files.example.org/${key}`;
 *   },
 * };
 * ```
 */
export interface Uploader {
  /** Stores `request.data` and resolves to the public URL serving it. */
  upload(request: UploadRequest): Promise<string>;
}

/** Default wait for a census file or metadata document (answer or more of its body). */
export const DOCUMENT_TIMEOUT_MS = 30_000;

/** How the SDK downloads and checks census files and metadata documents. */
export interface DocumentOptions {
  /** Default: the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Longest wait for an answer or for more of its body; default {@link DOCUMENT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Check the documents a process points at, as nodes and readers will
   * (default true): every census file and metadata document the SDK
   * uploads is downloaded back (a census file as nodes read it: a 200 with no
   * redirect and the same root; a metadata document by its sha256), and so
   * is a Merkle census URL given by hand. Turn it off only where the host
   * cannot be read back, such as a browser app on a host without CORS
   * headers.
   */
  verify?: boolean;
  /**
   * Accept census and metadata URLs on loopback and private hosts (which
   * nodes refuse for a census unless run with `--census-allow-private`):
   * local development only. Otherwise the SDK never downloads a document
   * from such a host, whatever URL a process names.
   */
  allowPrivateHosts?: boolean;
}
