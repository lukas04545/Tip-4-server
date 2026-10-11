export const DEFAULT_BASE_URL = "https://api.tip4serv.com/v1";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type QueryValue = string | number | boolean | null | undefined | unknown[] | Record<string, unknown>;

export interface RequestOptions {
  method?: HttpMethod;
  /** Path relative to the API base URL, e.g. "/store/products". */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Send the Authorization header (default true). */
  auth?: boolean;
}

export interface Tip4ServClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class Tip4ServApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "Tip4ServApiError";
  }
}

export class Tip4ServClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: Tip4ServClientOptions = {}) {
    this.apiKey = options.apiKey;
    // Keep a trailing slash so relative resolution appends to the /v1 prefix.
    this.baseUrl = new URL((options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "") + "/");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /** Builds the full request URL, refusing anything that would leave the configured API host. */
  buildUrl(path: string, query?: Record<string, QueryValue>): URL {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /^\/*[a-z][a-z0-9+.-]*:/i.test(path)) {
      throw new Error(`Invalid API path "${path}": it must be relative to the API base and start with "/" (e.g. "/store/products").`);
    }
    if (path.split(/[/?#]/).some((segment) => segment === "..")) {
      throw new Error(`Invalid API path "${path}": ".." segments are not allowed.`);
    }
    const url = new URL(path.slice(1), this.baseUrl);
    if (url.origin !== this.baseUrl.origin || !url.pathname.startsWith(this.baseUrl.pathname)) {
      throw new Error(`Invalid API path "${path}": it resolves outside ${this.baseUrl.href}.`);
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      // Tip4Serv takes structured query params (e.g. `products`) as JSON strings.
      url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    return url;
  }

  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const method = options.method ?? "GET";
    const url = this.buildUrl(options.path, options.query);
    const useAuth = options.auth ?? true;
    if (useAuth && !this.apiKey) {
      throw new Error("TIP4SERV_API_KEY is not set. Create a key in the Tip4Serv dashboard (Store → API Keys) and pass it to the server via the TIP4SERV_API_KEY environment variable.");
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (useAuth) headers.Authorization = `Bearer ${this.apiKey}`;
    let body: string | undefined;
    if (options.body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Request to Tip4Serv failed (${method} ${url.pathname}): ${reason}`);
    }

    const text = await response.text();
    const data = parseBody(text);
    if (!response.ok) {
      throw new Tip4ServApiError(`Tip4Serv API ${method} ${url.pathname} returned ${response.status}: ${errorMessage(data, response.statusText)}`, response.status, data);
    }
    return data as T;
  }
}

function parseBody(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["error", "message", "details"]) {
      if (typeof record[key] === "string" && record[key]) return record[key] as string;
    }
    return JSON.stringify(data).slice(0, 500);
  }
  if (typeof data === "string" && data) return data.slice(0, 500);
  return fallback || "Unknown error";
}
