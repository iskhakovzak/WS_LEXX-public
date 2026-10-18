/**
 * Browser → internal error tracker (POST /api/client-errors; admin page Пульт → Ошибки).
 *
 *   reportClientError({ kind: "render", error, componentStack })   — from RouteErrorBoundary.componentDidCatch
 *   installErrorReporting()                                         — once in main.tsx, after installFetchAuth():
 *       window "error" + "unhandledrejection", and every same-origin /api call that answered ≥ 500
 *
 * Privacy: only the page PATH is sent (no query/hash), messages are capped, the server scrubs tokens/secrets again.
 * Volume: the same report at most once per minute, at most 20 reports per page load; the reporter's own request
 * never reports itself. Never throws.
 */

const ENDPOINT = "/api/client-errors";
const MAX_PER_LOAD = 20;
const DEDUPE_MS = 60_000;

type Kind = "render" | "error" | "rejection" | "api";

export type ClientErrorReport = {
  kind: Kind;
  error?: unknown;
  message?: string;
  componentStack?: string | null;
  api?: { method: string; path: string; status: number };
  requestId?: string | null;
};

let sent = 0;
const recent = new Map<string, number>();
let origFetch: typeof fetch | null = null;

function release(): string | null {
  try {
    return (import.meta.env?.VITE_RELEASE as string | undefined) ?? null;
  } catch {
    return null;
  }
}

function describe(err: unknown): { name: string; message: string; stack: string | null } {
  if (err instanceof Error) return { name: err.name || "Error", message: err.message || String(err), stack: err.stack ?? null };
  if (typeof err === "string") return { name: "Error", message: err, stack: null };
  try {
    return { name: "NonError", message: JSON.stringify(err)?.slice(0, 500) ?? String(err), stack: null };
  } catch {
    return { name: "NonError", message: String(err), stack: null };
  }
}

/** Drop browser-extension and cross-origin script noise that we can't act on. */
function isNoise(message: string, stack: string | null): boolean {
  if (/^Script error\.?$/i.test(message)) return true;
  if (/ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i.test(message)) return true;
  if (stack && /(chrome|moz|safari)-extension:\/\//.test(stack)) return true;
  return false;
}

export function reportClientError(r: ClientErrorReport): void {
  try {
    if (sent >= MAX_PER_LOAD) return;
    const d = describe(r.error ?? r.message ?? "Unknown error");
    const message = (r.message ?? d.message).slice(0, 4000);
    if (r.kind !== "api" && isNoise(message, d.stack)) return;
    const key = `${r.kind}|${d.name}|${message}|${r.api?.path ?? ""}`;
    const now = Date.now();
    const last = recent.get(key);
    if (last && now - last < DEDUPE_MS) return;
    recent.set(key, now);
    sent++;
    const body = {
      kind: r.kind,
      name: d.name.slice(0, 200),
      message,
      stack: d.stack?.slice(0, 16_000) ?? null,
      componentStack: r.componentStack?.slice(0, 8000) ?? null,
      page: window.location.pathname.slice(0, 500),
      api: r.api ?? null,
      requestId: r.requestId ?? null,
      release: release(),
    };
    const f = origFetch ?? fetch;
    // keepalive: the report survives a page unload right after the error.
    void f(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* reporting must never break the app */
  }
}

function apiPathOf(input: RequestInfo | URL): string | null {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const u = new URL(raw, window.location.origin);
    if (u.origin !== window.location.origin || !u.pathname.startsWith("/api/")) return null;
    return u.pathname;
  } catch {
    return null;
  }
}

let installed = false;

/** Global handlers + a thin fetch observer for /api responses ≥ 500. Call once, after installFetchAuth(). */
export function installErrorReporting(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (e: ErrorEvent) => {
    // Resource load errors (img/script 404) have no `error` and target an element — not app errors.
    if (!e.error && !e.message) return;
    reportClientError({ kind: "error", error: e.error ?? e.message });
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    if (reason && typeof reason === "object" && (reason as { name?: string }).name === "AbortError") return;
    reportClientError({ kind: "rejection", error: reason });
  });

  origFetch = globalThis.fetch.bind(globalThis);
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const res = await inner(input, init);
    if (res.status >= 500) {
      const path = apiPathOf(input);
      if (path && path !== ENDPOINT) {
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        reportClientError({
          kind: "api",
          message: `${method} ${path} → ${res.status}`,
          api: { method, path, status: res.status },
          requestId: res.headers.get("X-Request-Id"),
        });
      }
    }
    return res;
  };
}

/** Tests only. */
export function resetErrorReportingForTests(): void {
  sent = 0;
  recent.clear();
  installed = false;
  origFetch = null;
}
