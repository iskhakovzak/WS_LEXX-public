import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (e: unknown) => void;
const listeners = new Map<string, Listener[]>();
const posted: { url: string; body: Record<string, unknown> }[] = [];
let nextStatus = 200;

// Minimal browser surface (node test env).
(globalThis as Record<string, unknown>).window = {
  location: { pathname: "/journal", search: "?secret=1", origin: "http://localhost" },
  addEventListener: (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
};
globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/api/client-errors")) {
    posted.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 204 });
  }
  return new Response("{}", { status: nextStatus, headers: { "X-Request-Id": "req-12345678" } });
}) as typeof fetch;

const { installErrorReporting, reportClientError, resetErrorReportingForTests } = await import("./error-reporting");

beforeEach(() => {
  posted.length = 0;
  nextStatus = 200;
  resetErrorReportingForTests();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("error reporting", () => {
  it("sends the page path only (no query), with name, message and stack", async () => {
    reportClientError({ kind: "render", error: new TypeError("x is undefined"), componentStack: "\n    at Journal" });
    await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toMatchObject({ kind: "render", name: "TypeError", message: "x is undefined", page: "/journal" });
    expect(JSON.stringify(posted[0].body)).not.toContain("secret=1");
  });

  it("dedupes the same error within a minute and caps the volume per page load", async () => {
    for (let i = 0; i < 5; i++) reportClientError({ kind: "error", error: new Error("same") });
    await flush();
    expect(posted).toHaveLength(1);
    for (let i = 0; i < 50; i++) reportClientError({ kind: "error", error: new Error(`e${i}`) });
    await flush();
    expect(posted.length).toBeLessThanOrEqual(20);
  });

  it("drops noise (cross-origin «Script error.», ResizeObserver, extensions)", async () => {
    reportClientError({ kind: "error", message: "Script error." });
    reportClientError({ kind: "error", message: "ResizeObserver loop completed with undelivered notifications." });
    await flush();
    expect(posted).toHaveLength(0);
  });

  it("observes /api responses ≥ 500 with the request id; ignores 4xx, other origins and itself", async () => {
    installErrorReporting();
    nextStatus = 500;
    await fetch("/api/trades/page?limit=5", { method: "GET" });
    await fetch("https://example.com/api/x");
    nextStatus = 404;
    await fetch("/api/trades/1");
    await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toMatchObject({ kind: "api", api: { method: "GET", path: "/api/trades/page", status: 500 }, requestId: "req-12345678" });
  });

  it("global handlers report errors and unhandled rejections (not AbortError)", async () => {
    installErrorReporting();
    listeners.get("error")?.forEach((fn) => fn({ error: new RangeError("bad"), message: "bad" }));
    listeners.get("unhandledrejection")?.forEach((fn) => fn({ reason: { name: "AbortError" } }));
    listeners.get("unhandledrejection")?.forEach((fn) => fn({ reason: new Error("lost promise") }));
    await flush();
    expect(posted.map((p) => p.body.kind)).toEqual(["error", "rejection"]);
  });
});
