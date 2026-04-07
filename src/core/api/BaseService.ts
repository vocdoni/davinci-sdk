export interface ApiError {
  error: string;
  code: number;
}

type QueryParamValue = string | number | boolean | null | undefined;
type ErrorCode = string | number;
type ErrorWithCode = Error & { code?: ErrorCode };

export interface RequestConfig {
  method?: string;
  url: string;
  data?: unknown;
  params?: object;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface BaseServiceConfig {
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class BaseService {
  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly defaultTimeoutMs?: number;
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
  }

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
    const timeoutMs = config.timeoutMs ?? this.defaultTimeoutMs;
    const { signal, cleanup } = this.createRequestSignal(timeoutMs, config.signal);

    try {
      const url = new URL(this.resolveUrl(config.url));
      this.appendQueryParams(url, config.params);

      const method = (config.method ?? 'GET').toUpperCase();
      const headers = new Headers(this.defaultHeaders);
      if (config.headers) {
        for (const [key, value] of Object.entries(config.headers)) {
          headers.set(key, value);
        }
      }

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

      const response = await this.fetchImpl(url.toString(), init);
      const payload = await this.parseResponsePayload(response);

      if (!response.ok) {
        const apiPayload = payload as Partial<ApiError> | undefined;
        const message =
          (typeof apiPayload?.error === 'string' && apiPayload.error) ||
          response.statusText ||
          `HTTP ${response.status}`;
        const code = apiPayload?.code ?? response.status ?? 500;
        const error = new Error(message);
        (error as ErrorWithCode).code = code;
        throw error;
      }

      return payload as T;
    } catch (err) {
      if (this.hasErrorCode(err)) {
        throw err;
      }

      const message = err instanceof Error ? err.message : 'Unknown request error';
      const code =
        err instanceof Error && err.name === 'AbortError'
          ? 'ECONNABORTED'
          : this.readErrorCode(err) ?? 500;
      const error = new Error(message);
      (error as ErrorWithCode).code = code;
      throw error;
    } finally {
      cleanup();
    }
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

  private async parseResponsePayload(response: Response): Promise<unknown> {
    const raw = await response.text();
    if (!raw) return undefined;

    const contentType = response.headers.get('content-type') ?? '';
    const expectsJson = /application\/json|\/[^;]+\+json/i.test(contentType);

    if (expectsJson) {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }

  private createRequestSignal(
    timeoutMs?: number,
    externalSignal?: AbortSignal
  ): { signal?: AbortSignal; cleanup: () => void } {
    if (!timeoutMs && !externalSignal) {
      return { signal: undefined, cleanup: () => undefined };
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
      timeout = setTimeout(() => controller.abort(), timeoutMs);
    }

    return {
      signal: controller.signal,
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

  private hasErrorCode(value: unknown): value is ErrorWithCode {
    return value instanceof Error && this.readErrorCode(value) !== undefined;
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
