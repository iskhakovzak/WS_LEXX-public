import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError as GeneratedApiError } from "@workspace/api-client-react";
import { ApiError, buildUrl, http, toApiError } from "./http";
import { apiErrorCode, apiErrorStatus, humanizeApiError, isAuthError, isClientError, retryDelay, shouldRetryQuery } from "./errors";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: String(url), init: init as RequestInit };
}

describe("http — success", () => {
  it("GET parses JSON and builds the query string (skips empty values, repeats arrays)", async () => {
    fetchMock.mockResolvedValue(json(200, [{ id: 1 }]));
    const rows = await http.get<{ id: number }[]>("/api/trades", { query: { result: "open", trader: null, q: "", ids: [1, 2] } });
    expect(rows).toEqual([{ id: 1 }]);
    const { url, init } = lastCall();
    expect(url).toBe("/api/trades?result=open&ids=1&ids=2");
    expect(init.method).toBe("GET");
  });

  it("POST sends a JSON body with content-type", async () => {
    fetchMock.mockResolvedValue(json(201, { ok: true }));
    await http.post("/api/notes", { text: "hi" });
    const { init } = lastCall();
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ text: "hi" }));
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  it("FormData is passed through untouched (browser sets the boundary)", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    const fd = new FormData();
    fd.append("a", "1");
    await http.post("/api/upload", fd);
    const { init } = lastCall();
    expect(init.body).toBe(fd);
    expect(new Headers(init.headers).has("content-type")).toBe(false);
  });

  it("204 → null", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(http.del("/api/notes/1")).resolves.toBeNull();
  });

  it("send() takes the method by name", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: 1 }));
    await http.send("patch", "/api/x", { a: 1 });
    expect(lastCall().init.method).toBe("PATCH");
  });
});

describe("http — errors", () => {
  it("keeps status, code, server text and request id", async () => {
    fetchMock.mockResolvedValue(json(409, { error: "Сначала заполните чек-лист", code: "CHECKLIST_REQUIRED" }, { "x-request-id": "req-1" }));
    const err = await http.post("/api/trades", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(409);
    expect(e.code).toBe("CHECKLIST_REQUIRED");
    expect(e.message).toBe("Сначала заполните чек-лист");
    expect(e.requestId).toBe("req-1");
    expect(e.body).toEqual({ error: "Сначала заполните чек-лист", code: "CHECKLIST_REQUIRED" });
    expect(e.data).toEqual(e.body);
    expect(e.method).toBe("POST");
    expect(apiErrorStatus(e)).toBe(409);
    expect(apiErrorCode(e)).toBe("CHECKLIST_REQUIRED");
    // The server text is already in the request language: shown as is.
    expect(humanizeApiError(e)).toBe("Сначала заполните чек-лист");
  });

  it("body fields are reachable with field()", async () => {
    fetchMock.mockResolvedValue(json(409, { error: "exists", targetCount: 3 }));
    const e = (await http.post("/api/x").catch((x: unknown) => x)) as ApiError;
    expect(e.field<number>("targetCount")).toBe(3);
  });

  it("non-JSON error body (HTML page from a proxy) keeps the status, no HTML in the message", async () => {
    fetchMock.mockResolvedValue(new Response("<html><body>Bad gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } }));
    const e = (await http.get("/api/x").catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(502);
    expect(e.code).toBeNull();
    expect(e.message).not.toContain("<html>");
    expect(humanizeApiError(e)).toBe("Сервер временно недоступен");
  });

  it("plain-text error body becomes the message", async () => {
    fetchMock.mockResolvedValue(new Response("Too big", { status: 413, headers: { "content-type": "text/plain" } }));
    const e = (await http.post("/api/x", { a: 1 }).catch((x: unknown) => x)) as ApiError;
    expect(e.status).toBe(413);
    expect(e.message).toBe("Too big");
  });

  it("a 2xx that is not JSON (SPA fallback HTML) is BAD_RESPONSE", async () => {
    fetchMock.mockResolvedValue(new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } }));
    const e = (await http.get("/api/missing").catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(200);
    expect(e.code).toBe("BAD_RESPONSE");
    expect(humanizeApiError(e)).toBe("Сервер вернул некорректный ответ");
  });

  it("network failure → status 0, code NETWORK, retried", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const e = (await http.get("/api/x").catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(0);
    expect(e.isNetwork).toBe(true);
    expect(e.code).toBe("NETWORK");
    expect(humanizeApiError(e)).toBe("Сервер недоступен — проверьте соединение");
    expect(shouldRetryQuery(0, e)).toBe(true);
    expect(shouldRetryQuery(1, e)).toBe(true);
    expect(shouldRetryQuery(2, e)).toBe(false);
  });

  it("AbortError passes through untouched", async () => {
    const abort = new DOMException("aborted", "AbortError");
    fetchMock.mockRejectedValue(abort);
    await expect(http.get("/api/x")).rejects.toBe(abort);
  });

  it("4xx is never retried, 5xx is", async () => {
    fetchMock.mockResolvedValueOnce(json(403, { error: "Forbidden", code: "FORBIDDEN" }));
    const e403 = await http.get("/api/x").catch((x: unknown) => x);
    expect(isClientError(e403)).toBe(true);
    expect(shouldRetryQuery(0, e403)).toBe(false);

    fetchMock.mockResolvedValueOnce(json(500, { error: "boom", code: "INTERNAL" }));
    const e500 = await http.get("/api/x").catch((x: unknown) => x);
    expect(shouldRetryQuery(0, e500)).toBe(true);
    expect(retryDelay(0)).toBe(1000);
    expect(retryDelay(1)).toBe(2000);
    expect(retryDelay(10)).toBe(8000);
  });

  it("raw() returns the Response and throws ApiError on non-2xx unless told not to", async () => {
    fetchMock.mockResolvedValueOnce(new Response("a,b\n1,2", { status: 200, headers: { "content-type": "text/csv" } }));
    const res = await http.raw("/api/export.csv");
    expect(await res.text()).toBe("a,b\n1,2");

    fetchMock.mockResolvedValueOnce(json(404, { error: "Not found", code: "NOT_FOUND" }));
    const e = (await http.raw("/api/x").catch((x: unknown) => x)) as ApiError;
    expect(e.status).toBe(404);
    expect(e.code).toBe("NOT_FOUND");

    fetchMock.mockResolvedValueOnce(json(404, { error: "Not found" }));
    const r404 = await http.raw("/api/x", { throwOnError: false });
    expect(r404.status).toBe(404);

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const net = (await http.raw("/api/x").catch((x: unknown) => x)) as ApiError;
    expect(net.code).toBe("NETWORK");
  });

  it("toApiError converts the generated client's error", () => {
    const res = new Response(null, { status: 404, statusText: "Not Found" });
    const gen = new GeneratedApiError(res, { error: "Trade not found", code: "NOT_FOUND" }, { method: "GET", url: "/api/trades/1" });
    const e = toApiError(gen) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(404);
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toBe("Trade not found");
  });
});

describe("buildUrl", () => {
  it("leaves absolute URLs alone and appends to an existing query", () => {
    expect(buildUrl("https://x.test/a")).toBe("https://x.test/a");
    expect(buildUrl("/api/a?x=1", { y: 2 })).toBe("/api/a?x=1&y=2");
  });
});

describe("401 → session-expired flow (install-fetch-auth)", () => {
  it("fires ws-auth-expired, sends the token and X-Lang, and the error is an auth error", async () => {
    const g = globalThis as Record<string, unknown>;
    const prevWindow = g.window;
    const prevStorage = g.localStorage;
    const win = Object.assign(new EventTarget(), { location: { origin: "http://localhost" } });
    g.window = win;
    g.localStorage = { getItem: (k: string) => (k === "ws_lexx_token" ? "tok" : null), setItem() {}, removeItem() {} };
    try {
      fetchMock.mockResolvedValue(json(401, { error: "Требуется вход", code: "AUTH_REQUIRED" }));
      vi.resetModules();
      const { installFetchAuth, AUTH_EXPIRED_EVENT } = await import("../install-fetch-auth");
      const httpMod = await import("./http");
      installFetchAuth();
      const fired = vi.fn();
      win.addEventListener(AUTH_EXPIRED_EVENT, fired);

      const e = await httpMod.http.get("/api/trades").catch((x: unknown) => x);
      expect(fired).toHaveBeenCalledTimes(1);
      expect(isAuthError(e)).toBe(true);
      expect(shouldRetryQuery(0, e)).toBe(false);
      const headers = new Headers((fetchMock.mock.calls.at(-1)![1] as RequestInit).headers);
      expect(headers.get("authorization")).toBe("Bearer tok");
      expect(headers.get("x-lang")).toMatch(/^(ru|en|uz)$/);
    } finally {
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      g.window = prevWindow;
      g.localStorage = prevStorage;
    }
  });
});
