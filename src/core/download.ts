/**
 * @fileoverview HTTP downloads with a stall timeout and a size cap (circuit
 * files, census files and metadata documents), and the URL policy of the
 * documents a process points at.
 */

/**
 * A URL the SDK does not download from: not `http(s)`, or a host that is not
 * public. It is decided from the URL alone, before any request.
 */
export class UrlPolicyError extends Error {
  constructor(
    message: string,
    public readonly uri: string
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

// Globally routable IPv4 unicast, as the node's `is_public` has it.
function publicV4([a, b, c]: number[]): boolean {
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && (b & 0xc0) === 64) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

// The eight 16-bit pieces of a URL's IPv6 host (`[…]`, which the URL parser
// writes in lowercase hex with at most one `::`).
function ipv6Pieces(host: string): number[] | null {
  const [head, tail, ...more] = host.slice(1, -1).split('::');
  if (more.length > 0) return null;
  const pieces = (s: string | undefined) => (s ? s.split(':').map(p => parseInt(p, 16)) : []);
  const a = pieces(head);
  const b = pieces(tail);
  const zeros = 8 - a.length - b.length;
  if (tail === undefined ? zeros !== 0 : zeros < 1) return null;
  return [...a, ...new Array<number>(zeros).fill(0), ...b];
}

function publicV6(s: number[]): boolean {
  const v4 = () => publicV4([s[6] >> 8, s[6] & 0xff, s[7] >> 8, s[7] & 0xff]);
  const zeroTo = (n: number) => s.slice(0, n).every(p => p === 0);
  if (zeroTo(5) && s[5] === 0xffff) return v4();
  const loopback = zeroTo(7) && s[7] === 1;
  const unspecified = zeroTo(8);
  if (zeroTo(6) && !loopback && !unspecified) return v4();
  return !(
    loopback ||
    unspecified ||
    (s[0] & 0xff00) === 0xff00 ||
    (s[0] & 0xfe00) === 0xfc00 ||
    (s[0] & 0xffc0) === 0xfe80 ||
    (s[0] === 0x64 && s[1] === 0xff9b) ||
    s[0] === 0x2002 ||
    (s[0] === 0x2001 && (s[1] === 0x0db8 || s[1] === 0))
  );
}

/**
 * Checks `uri` is a URL the SDK downloads documents from, with the sequencer
 * nodes' policy for census URLs (`sequencer/src/census.rs`, `is_public`):
 * `http` or `https`, and a host that is not `localhost` nor a loopback,
 * private, link-local, shared, documentation, multicast or otherwise
 * non-public IPv4 or IPv6 literal, unless `allowPrivateHosts`. A host name is
 * not resolved: one that points at a private address passes (nodes resolve
 * it and refuse it). Where that matters, pass a `fetchImpl` whose resolver
 * drops private addresses.
 *
 * @throws UrlPolicyError
 */
export function checkPublicUrl(uri: string, options: { allowPrivateHosts?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new UrlPolicyError(`${uri} is not a URL`, uri);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UrlPolicyError(`only http(s) URLs are read, not ${url.protocol}`, uri);
  }
  if (options.allowPrivateHosts) return url;
  const host = url.hostname.toLowerCase();
  let isPublic = true;
  if (host === 'localhost' || host.endsWith('.localhost')) isPublic = false;
  else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) isPublic = publicV4(host.split('.').map(Number));
  else if (host.startsWith('[')) {
    const pieces = ipv6Pieces(host);
    isPublic = pieces !== null && publicV6(pieces);
  }
  if (!isPublic) throw new UrlPolicyError(`${host} is not a public host`, uri);
  return url;
}

/** How to download a file. */
export interface DownloadOptions {
  /** Default: the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Longest wait for the answer or for more of its body, in milliseconds. */
  stallTimeoutMs: number;
  /** Largest body read; a longer one fails. */
  maxBytes?: number;
  /** `manual` makes a redirect fail instead of being followed. */
  redirect?: RequestRedirect;
}

/** A downloaded body with what its answer said about it. */
export interface Downloaded {
  bytes: Uint8Array;
  /** The HTTP status, a 2xx. */
  status: number;
  /** The `Content-Type` header, when there was one. */
  contentType: string | null;
}

/** Why a download failed; `status` is the HTTP status of an answer that was not a 2xx. */
export class DownloadError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Downloads `url`, failing once `stallTimeoutMs` pass without the answer or
 * more of its body, on an answer that is not a 2xx (a redirect with
 * `redirect: 'manual'`), and past `maxBytes`. The wait is raced as well as
 * signalled, so a fetch that ignores the signal cannot hang the download.
 *
 * @throws DownloadError
 */
export async function download(url: string, options: DownloadOptions): Promise<Downloaded> {
  const { stallTimeoutMs, maxBytes, redirect } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    abort.signal.addEventListener('abort', () => reject(abort.signal.reason));
  });
  stalled.catch(() => undefined);
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => abort.abort(new DownloadError(`no data for ${stallTimeoutMs} ms`)),
      stallTimeoutMs
    );
  };
  const tooLarge = () => new DownloadError(`larger than ${maxBytes} bytes`);
  arm();
  try {
    const res = await Promise.race([
      fetchImpl(url, { signal: abort.signal, ...(redirect && { redirect }) }),
      stalled,
    ]);
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new DownloadError(
        `HTTP ${res.status || 'redirect'}: redirects are refused`,
        res.status
      );
    }
    if (!res.ok) throw new DownloadError(`HTTP ${res.status}`, res.status);
    const contentType = res.headers?.get('content-type') ?? null;
    if (!res.body) {
      const bytes = new Uint8Array(await Promise.race([res.arrayBuffer(), stalled]));
      if (maxBytes !== undefined && bytes.length > maxBytes) throw tooLarge();
      return { bytes, status: res.status, contentType };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), stalled]);
        if (done) break;
        size += value.length;
        if (maxBytes !== undefined && size > maxBytes) throw tooLarge();
        chunks.push(value);
        arm();
      }
    } catch (err) {
      void reader.cancel().catch(() => undefined);
      throw err;
    }
    return { bytes: concat(chunks), status: res.status, contentType };
  } catch (err) {
    if (err instanceof DownloadError) throw err;
    throw new DownloadError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}
