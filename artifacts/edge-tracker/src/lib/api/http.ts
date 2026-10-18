/**
 * The one HTTP client for our API (ARCHITECTURE.md §1 rule 2). Built on `customFetch` from the generated client, so
 * hand-written and generated calls go through the same parsing; every failure becomes one `ApiError`.
 *
 *   const rows = await http.get<Row[]>("/api/watchlist", { query: { trader } });
 *   await http.post("/api/trades/42/notes", { text });           // JSON body, JSON answer
 *   await http.del(`/api/notes/${id}`);                           // 204 → null
 *   const res = await http.raw(`/api/export.csv`);                // streams / blobs: a checked Response
 *
 * Auth (`Authorization`) and `X-Lang` are added by the global fetch patch in `lib/install-fetch-auth.ts` (one place);
 * a 401 there also starts the «session expired» flow, so callers never handle it.
 */
import { customFetch, ApiError as GeneratedApiError, ResponseParseError } from "@workspace/api-client-react";
import { apiUrl, BASE } from "@/lib/api";

/** Codes the client itself produces (the server never sends these). */
export const CLIENT_CODES = {
  network: "NETWORK",
  badResponse: "BAD_RESPONSE",
} as const;

export type ApiErrorInit = {
  status: number;
  code?: string | null;
  message?: string | null;
  body?: unknown;
  requestId?: string | null;
  method?: string;
  url?: string;
  cause?: unknown;
};

/**
 * The single error type of the app's data layer.
 * - `status`: HTTP status, `0` when the server was not reached (network down, CORS, DNS).
 * - `code`: the server's `code` (`CHECKLIST_REQUIRED`, `FORBIDDEN`…), or `NETWORK` / `BAD_RESPONSE` from the client.
 * - `message`: the server's `error` text (already in the request language once the server sends it so), else a short
 *   technical line. For people use `humanizeApiError(err)` from `lib/api/errors`, which maps `code` to the UI language.
 * - `body`: the parsed error body (`{ error, code, details?, … }`), `null` when there was none.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;
  readonly requestId: string | null;
  readonly method: string;
  readonly url: string;

  constructor(init: ApiErrorInit) {
    super(init.message?.trim() || (init.status ? `HTTP ${init.status}` : "Network error"));
    Object.setPrototypeOf(this, new.target.prototype);
    this.status = init.status;
    this.code = init.code ?? null;
    this.body = init.body ?? null;
    this.requestId = init.requestId ?? null;
    this.method = init.method ?? "GET";
    this.url = init.url ?? "";
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }

  /** Same shape as the generated client's error (`err.data`), so old call sites keep working. */
  get data(): unknown {
    return this.body;
  }

  /** A field of the error body (`err.field<number>("targetCount")`). */
  field<T = unknown>(key: string): T | undefined {
    const b = this.body;
    return b && typeof b === "object" ? ((b as Record<string, unknown>)[key] as T | undefined) : undefined;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function bodyField(body: unknown, key: string): string | null {
  return body && typeof body === "object" ? str((body as Record<string, unknown>)[key]) : null;
}

/** Server text from an error body: `{ error }` (our API), then the usual alternatives; a short plain-text body too. */
export function messageFromBody(body: unknown): string | null {
  if (typeof body === "string") {
    const t = body.trim();
    // An HTML error page (proxy, Vite fallback) is not a message.
    return t && !t.startsWith("<") && t.length <= 300 ? t : null;
  }
  return bodyField(body, "error") ?? bodyField(body, "message") ?? bodyField(body, "detail") ?? bodyField(body, "title");
}

function isAbort(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { name?: unknown }).name === "AbortError";
}

/** Anything thrown while talking to the API → `ApiError` (AbortError is passed through untouched). */
export function toApiError(err: unknown, req: { method?: string; url?: string } = {}): unknown {
  if (err instanceof ApiError || isAbort(err)) return err;
  if (err instanceof GeneratedApiError) {
    const body = err.data;
    return new ApiError({
      status: err.status,
      code: bodyField(body, "code"),
      message: messageFromBody(body) ?? err.statusText ?? null,
      body,
      requestId: err.headers?.get("x-request-id") ?? bodyField(body, "requestId"),
      method: err.method,
      url: err.url,
      cause: err,
    });
  }
  if (err instanceof ResponseParseError) {
    return new ApiError({
      status: err.status,
      code: CLIENT_CODES.badResponse,
      message: err.message,
      body: err.rawBody.slice(0, 2000),
      requestId: err.headers?.get("x-request-id") ?? null,
      method: err.method,
      url: err.url,
      cause: err,
    });
  }
  if (err instanceof TypeError) {
    // fetch() rejects with a TypeError when the request never got an answer.
    return new ApiError({ status: 0, code: CLIENT_CODES.network, message: err.message, method: req.method, url: req.url, cause: err });
  }
  return err;
}

/** Build an `ApiError` from a `Response` already in hand (for `http.raw` callers that read the body themselves). */
export async function apiErrorFromResponse(res: Response, method = "GET"): Promise<ApiError> {
  let body: unknown = null;
  try {
    const text = await res.text();
    if (text.trim()) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
  } catch {
    body = null;
  }
  return new ApiError({
    status: res.status,
    code: bodyField(body, "code"),
    message: messageFromBody(body) ?? (res.statusText || null),
    body,
    requestId: res.headers.get("x-request-id") ?? bodyField(body, "requestId"),
    method,
    url: res.url,
  });
}

// ---------------------------------------------------------------------------------------------------------------

type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue | readonly QueryValue[]>;

export type HttpOptions = Omit<RequestInit, "body" | "method"> & {
  /** Appended as a query string; `null` / `undefined` / `""` values are skipped, arrays repeat the key. */
  query?: Query;
  /** `json` (default): parse JSON, a non-JSON 2xx is an `ApiError` with code `BAD_RESPONSE`. */
  responseType?: "json" | "text" | "blob" | "auto";
};

export type RawOptions = RequestInit & {
  query?: Query;
  /** Default true: a non-2xx answer throws `ApiError`. `false` hands back the Response whatever the status. */
  throwOnError?: boolean;
};

/** Prefix the app base path for `/api/…` paths; append a query string. Absolute URLs pass through. */
export function buildUrl(path: string, query?: Query): string {
  let url = path;
  if (path.startsWith("/") && !(BASE && path.startsWith(`${BASE}/`))) url = apiUrl(path);
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      const list = Array.isArray(v) ? v : [v];
      for (const item of list) {
        if (item === null || item === undefined || item === "") continue;
        qs.append(k, String(item));
      }
    }
    const s = qs.toString();
    if (s) url += (url.includes("?") ? "&" : "?") + s;
  }
  return url;
}

function isRawBody(b: unknown): b is BodyInit {
  return (
    typeof b === "string" ||
    (typeof FormData !== "undefined" && b instanceof FormData) ||
    (typeof Blob !== "undefined" && b instanceof Blob) ||
    (typeof URLSearchParams !== "undefined" && b instanceof URLSearchParams) ||
    b instanceof ArrayBuffer ||
    ArrayBuffer.isView(b) ||
    (typeof ReadableStream !== "undefined" && b instanceof ReadableStream)
  );
}

async function request<T>(method: string, path: string, body: unknown, opts: HttpOptions = {}): Promise<T> {
  const { query, responseType = "json", headers: headersInit, ...init } = opts;
  const url = buildUrl(path, query);
  const headers = new Headers(headersInit);
  let payload: BodyInit | undefined;
  if (body !== undefined && body !== null) {
    if (isRawBody(body)) {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }
  try {
    return await customFetch<T>(url, { ...init, method, headers, body: payload, responseType });
  } catch (err) {
    throw toApiError(err, { method, url });
  }
}

async function raw(path: string, opts: RawOptions = {}): Promise<Response> {
  const { query, throwOnError = true, ...init } = opts;
  const url = buildUrl(path, query);
  const method = (init.method ?? "GET").toUpperCase();
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw toApiError(err, { method, url });
  }
  if (!res.ok && throwOnError) throw await apiErrorFromResponse(res, method);
  return res;
}

export const http = {
  get: <T = unknown>(path: string, opts?: HttpOptions) => request<T>("GET", path, undefined, opts),
  post: <T = unknown>(path: string, body?: unknown, opts?: HttpOptions) => request<T>("POST", path, body, opts),
  put: <T = unknown>(path: string, body?: unknown, opts?: HttpOptions) => request<T>("PUT", path, body, opts),
  patch: <T = unknown>(path: string, body?: unknown, opts?: HttpOptions) => request<T>("PATCH", path, body, opts),
  del: <T = unknown>(path: string, body?: unknown, opts?: HttpOptions) => request<T>("DELETE", path, body, opts),
  /** Any method by name (helpers that take `method` as a parameter). */
  send: <T = unknown>(method: string, path: string, body?: unknown, opts?: HttpOptions) => request<T>(method.toUpperCase(), path, body, opts),
  /** Streams, blobs, uploads with progress, probes: the checked `Response` itself. */
  raw,
};

export type Http = typeof http;
