import { sha256 } from 'ethers';
import type { Uploader, UploadRequest } from '../../src/core/types/uploader';

/** What the host answers for one URL. */
export interface Served {
  status?: number;
  body?: Uint8Array | string;
  headers?: Record<string, string>;
}

/**
 * A file host in memory: an {@link Uploader} that stores each upload under
 * `<base>/<sha256>.json`, and a `fetch` that serves what is stored (or what
 * a test put at a URL). Requests are recorded.
 */
export class DocumentHost {
  readonly uploads: UploadRequest[] = [];
  readonly fetches: { url: string; init?: RequestInit }[] = [];
  readonly files = new Map<string, Served>();
  /** Makes the next upload fail with this error. */
  failUpload?: Error;

  constructor(readonly base = 'https://files.example.org') {}

  readonly uploader: Uploader = {
    upload: (request: UploadRequest) => {
      this.uploads.push(request);
      if (this.failUpload) {
        const err = this.failUpload;
        this.failUpload = undefined;
        return Promise.reject(err);
      }
      const url = `${this.base}/${request.sha256.slice(2)}.json`;
      if (!this.files.has(url)) {
        this.files.set(url, {
          body: request.data,
          headers: { 'content-type': request.contentType },
        });
      }
      return Promise.resolve(url);
    },
  };

  /** Serves `served` at `url`. */
  serve(url: string, served: Served): void {
    this.files.set(url, served);
  }

  /** The URL the host gives bytes with this content. */
  urlOf(data: Uint8Array): string {
    return `${this.base}/${sha256(data).slice(2)}.json`;
  }

  readonly fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    this.fetches.push({ url, init });
    const f = this.files.get(url);
    if (!f) return Promise.resolve(new Response('not found', { status: 404 }));
    const status = f.status ?? 200;
    const body = status === 204 || (status >= 300 && status < 400) ? null : (f.body ?? '');
    return Promise.resolve(new Response(body, { status, headers: f.headers }));
  }) as typeof fetch;
}
