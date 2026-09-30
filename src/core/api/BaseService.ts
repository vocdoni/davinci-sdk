/** The error body a sequencer node answers with. */
export interface ApiError {
  error: string;
  code: number;
}

type QueryParamValue = string | number | boolean | null | undefined;
type ErrorCode = string | number;
type ErrorWithCode = Error & { code?: ErrorCode };

/** One HTTP request of a {@link BaseService}. */
export interface RequestConfig {
  method?: string;
  url: string;
  data?: unknown;
  params?: object;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** How a {@link BaseService} talks HTTP. */
export interface BaseServiceConfig {
  /** Headers sent with every request. */
  headers?: Record<string, string>;
  /** Longest wait for a response, in ms; none by default. */
  timeoutMs?: number;
  /** Replaces the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Largest response body read, in bytes; a longer one fails the request. Unbounded by default. */
  maxResponseBytes?: number;
}

/** A JSON-over-HTTP client of one base URL, the base of the sequencer client. */
export class BaseService {
  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly defaultTimeoutMs?: number;
  private readonly maxResponseBytes?: number;
  private readonly baseURL: string;

  constructor(baseURL: string, config?: BaseServiceConfig) {
    this.baseURL = baseURL;
    if (config?.fetchImpl) {
      this.fetchImpl = config.fetchImpl;
    } else if (typeof globalThis.fetch === 'function') {
      this.fetchImpl = globalThis.fetch.bind(globalThis);
    } else {
      throw new Error(
        'Global fetch is not available. Provide a fetchImpl in BaseService configuration.'
      );
    }
    this.defaultHeaders = config?.headers ?? {};
    this.defaultTimeoutMs = config?.timeoutMs;
    this.maxResponseBytes = config?.maxResponseBytes;
  }

  /** The base URL requests are resolved against. */
  public getBaseUrl(): string {
    return this.baseURL;
  }

  protected resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) {
      return path;
    }

    const trimmedBase = this.baseURL.replace(/\/+$/, '');
    const trimmedPath = path.replace(/^\/+/, '');

    if (!trimmedBase) {
      return `/${trimmedPath}`;
    }

    return `${trimmedBase}/${trimmedPath}`;
  }

  protected async request<T>(config: RequestConfig): Promise<T> {
    const url = new URL(this.resolveUrl(config.url));
    this.appendQueryParams(url, config.params);

    const method = (config.method ?? 'GET').toUpperCase();
    const headers = new Headers(this.defaultHeaders);
    if (config.headers) {
      for (const [key, value] of Object.entries(config.headers)) {
        headers.set(key, value);
      }
    }

    const timeoutMs = config.timeoutMs ?? this.defaultTimeoutMs;
    const { signal, cleanup, timedOut } = this.createRequestSignal(timeoutMs, config.signal);
    const init: RequestInit = {
      method,
      headers,
      signal,
    };

    if (config.data !== undefined && method !== 'GET' && method !== 'HEAD') {
      if (this.isBodyInit(config.data)) {
        init.body = config.data;
      } else {
        if (!headers.has('Content-Type')) {
          headers.set('Content-Type', 'application/json');
        }
        init.body = JSON.stringify(config.data);
      }
    }

    let response: Response;
    let payload: unknown;
    try {
      response = await this.fetchImpl(url.toString(), init);
      payload = await this.parseResponsePayload(response);
    } catch (err) {
      throw this.transportError(err, timedOut());
    } finally {
      cleanup();
    }

    if (!response.ok) {
      throw this.httpError(response.status, response.statusText, payload);
    }
    return payload as T;
  }

  /**
   * The error for an answer with an error status. The default is an `Error`
   * whose `code` is the body's `code`, else the HTTP status.
   */
  protected httpError(status: number, statusText: string, payload: unknown): Error {
    const apiPayload = payload as Partial<ApiError> | undefined;
    const message =
      (typeof apiPayload?.error === 'string' && apiPayload.error) || statusText || `HTTP ${status}`;
    const error = new Error(message);
    (error as ErrorWithCode).code = apiPayload?.code ?? status;
    return error;
  }

  /**
   * The error for a request that got no usable answer: a network failure, an
   * abort, the timeout, or a body that could not be read. The default is an
   * `Error` with code `ECONNABORTED` for an abort or timeout.
   */
  protected transportError(err: unknown, timedOut: boolean): Error {
    const message = err instanceof Error ? err.message : 'Unknown request error';
    const aborted = timedOut || (err instanceof Error && err.name === 'AbortError');
    const error = new Error(message);
    (error as ErrorWithCode).code = aborted ? 'ECONNABORTED' : (this.readErrorCode(err) ?? 500);
    return error;
  }

  private appendQueryParams(url: URL, params?: object): void {
    if (!params) return;

    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (this.isQueryParamValue(item)) {
            url.searchParams.append(key, String(item));
          }
        }
      } else if (this.isQueryParamValue(value)) {
        url.searchParams.append(key, String(value));
      }
    }
  }

  // JSON whatever the content type (some servers omit it), else the raw text.
  private async parseResponsePayload(response: Response): Promise<unknown> {
    const raw = await this.readText(response);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }

  // Reads the body as text, failing once it passes `maxResponseBytes`.
  private async readText(response: Response): Promise<string> {
    const max = this.maxResponseBytes;
    if (max === undefined || !response.body) return response.text();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new Error(`response body over ${max} bytes`);
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
  }

  private createRequestSignal(
    timeoutMs?: number,
    externalSignal?: AbortSignal
  ): { signal?: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
    let fired = false;
    const timedOut = () => fired;
    if (!timeoutMs && !externalSignal) {
      return { signal: undefined, cleanup: () => undefined, timedOut };
    }

    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;

    const abortFromExternal = () => controller.abort();

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', abortFromExternal, { once: true });
      }
    }

    if (timeoutMs && timeoutMs > 0) {
      timeout = setTimeout(() => {
        fired = true;
        controller.abort();
      }, timeoutMs);
    }

    return {
      signal: controller.signal,
      timedOut,
      cleanup: () => {
        if (timeout) clearTimeout(timeout);
        if (externalSignal) {
          externalSignal.removeEventListener('abort', abortFromExternal);
        }
      },
    };
  }

  private isBodyInit(value: unknown): value is BodyInit {
    if (typeof value === 'string' || value instanceof URLSearchParams) return true;
    if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value))
      return true;
    if (typeof FormData !== 'undefined' && value instanceof FormData) return true;
    if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) return true;
    return false;
  }

  private readErrorCode(value: unknown): ErrorCode | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const maybeCode = (value as { code?: unknown }).code;
    if (typeof maybeCode === 'string' || typeof maybeCode === 'number') {
      return maybeCode;
    }
    return undefined;
  }

  private isQueryParamValue(value: unknown): value is Exclude<QueryParamValue, null | undefined> {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  }
}
