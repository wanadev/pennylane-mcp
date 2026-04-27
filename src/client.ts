import axios, { AxiosInstance, AxiosError } from 'axios';

export const PENNYLANE_BASE_URL = 'https://app.pennylane.com/api/external/v2';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  method: HttpMethod;
  /** Path template under /api/external/v2, e.g. "/customers/{id}". Leading slash optional. */
  path: string;
  /** Path-template substitutions, e.g. { id: 42 }. */
  pathParams?: Record<string, string | number | boolean | undefined>;
  /** Query parameters; undefined/null entries are dropped. */
  query?: Record<string, unknown>;
  /** JSON body for POST/PUT/PATCH. */
  body?: unknown;
}

export class PennylaneApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly url?: string;

  constructor(message: string, opts: { status?: number; code?: string; details?: unknown; url?: string }) {
    super(message);
    this.name = 'PennylaneApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
    this.url = opts.url;
  }
}

export class PennylaneClient {
  private readonly http: AxiosInstance;

  constructor(apiKey: string, baseUrl: string = PENNYLANE_BASE_URL) {
    this.http = axios.create({
      baseURL: baseUrl,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      // Pennylane doesn't accept arbitrary timeouts well; leave to caller/socket.
      validateStatus: () => true,
    });
  }

  async request<T = unknown>(opts: RequestOptions): Promise<T> {
    const url = this.buildPath(opts.path, opts.pathParams);
    const params = this.cleanQuery(opts.query);

    let response;
    try {
      response = await this.http.request({
        method: opts.method,
        url,
        params,
        data: opts.body,
      });
    } catch (err) {
      // Network-level failure (DNS, ECONNREFUSED, etc.).
      const ax = err as AxiosError;
      throw new PennylaneApiError(`Network error calling Pennylane: ${ax.message}`, {
        code: ax.code,
        url,
      });
    }

    if (response.status >= 200 && response.status < 300) {
      return response.data as T;
    }

    const data = response.data as Record<string, unknown> | undefined;
    const message =
      (typeof data?.message === 'string' && data.message) ||
      (typeof data?.error === 'string' && data.error) ||
      `Pennylane API responded with HTTP ${response.status}`;

    throw new PennylaneApiError(message, {
      status: response.status,
      details: data,
      url,
    });
  }

  private buildPath(path: string, pathParams?: Record<string, string | number | boolean | undefined>): string {
    let url = path.startsWith('/') ? path : `/${path}`;
    if (!pathParams) return url;
    for (const [key, value] of Object.entries(pathParams)) {
      if (value === undefined) continue;
      url = url.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
    }
    return url;
  }

  private cleanQuery(query?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!query) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      out[key] = value;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
}
