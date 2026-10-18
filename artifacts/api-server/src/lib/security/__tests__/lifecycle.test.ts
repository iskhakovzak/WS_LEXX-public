import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { crashHandler, createShutdown, isShuttingDown, resetShutdownStateForTests, shutdownConnectionClose } from "../lifecycle";
import { corsMiddleware, genReqId, inlineScriptHashes, JSON_BODY_OVERRIDES, trustProxySetting, cspDirectives } from "../http";

const quietLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() });

afterEach(() => resetShutdownStateForTests());

describe("graceful shutdown", () => {
  it("finishes the in-flight request, stops jobs, closes the pool, then exit(0)", async () => {
    const app = express();
    app.use(shutdownConnectionClose);
    app.get("/slow", (_req, res) => { setTimeout(() => res.json({ ok: true }), 300); });
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slow`;

    const order: string[] = [];
    const exit = vi.fn((code: number) => { order.push(`exit:${code}`); });
    const shutdown = createShutdown(server, {
      logger: quietLogger(),
      stopJobs: async () => { order.push("jobs"); },
      closePool: async () => { order.push("pool"); },
      exit,
      timeoutMs: 5000,
    });

    const inflight = fetch(url).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 50));
    const done = shutdown("SIGTERM");
    expect(isShuttingDown()).toBe(true);
    await expect(inflight).resolves.toEqual({ ok: true });
    await done;
    expect(order).toEqual(["jobs", "pool", "exit:0"]);
    // New connections are refused once draining started.
    await expect(fetch(url)).rejects.toThrow();
  });

  it("a hanging step hits the hard timeout → exit(1)", async () => {
    const server = http.createServer((_req, res) => res.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const exit = vi.fn();
    const shutdown = createShutdown(server, { logger: quietLogger(), stopJobs: () => new Promise(() => {}), exit, timeoutMs: 100 });
    void shutdown("SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("a second signal while draining is ignored", async () => {
    const server = http.createServer((_req, res) => res.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const exit = vi.fn();
    const stopJobs = vi.fn(async () => {});
    const shutdown = createShutdown(server, { logger: quietLogger(), stopJobs, exit, timeoutMs: 1000 });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect(stopJobs).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe("crash policy", () => {
  it("logs, records, exits with 1 — once", async () => {
    const exit = vi.fn();
    const capture = vi.fn(async () => undefined);
    const logger = quietLogger();
    const h = crashHandler("uncaughtException", { logger, capture, exit });
    await h(new Error("boom"));
    await h(new Error("again"));
    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("a hanging tracker does not keep a crashed process alive", async () => {
    const exit = vi.fn();
    const h = crashHandler("unhandledRejection", { logger: quietLogger(), capture: () => new Promise(() => {}), exit, captureTimeoutMs: 50 });
    await h("reason");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("http security config", () => {
  it("trust proxy: one hop by default, never `true`", () => {
    expect(trustProxySetting(undefined)).toBe(1);
    expect(trustProxySetting("2")).toBe(2);
    expect(trustProxySetting("true")).toBe(1);
    expect(trustProxySetting("false")).toBe(false);
    expect(trustProxySetting("loopback, 10.0.0.0/8")).toBe("loopback, 10.0.0.0/8");
  });

  it("CORS: none in production (no throw → no 500), permissive in development", () => {
    expect(corsMiddleware(true)).toBeNull();
    expect(typeof corsMiddleware(false)).toBe("function");
  });

  it("request id: reuses a sane incoming id, else a UUID, echoed in the response", () => {
    const set = vi.fn();
    expect(genReqId({ headers: { "x-request-id": "proxy-1234abcd" } } as never, { setHeader: set } as never)).toBe("proxy-1234abcd");
    const id = genReqId({ headers: { "x-request-id": "bad id with spaces" } } as never, { setHeader: set } as never);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(set).toHaveBeenCalledWith("X-Request-Id", id);
  });

  it("JSON body overrides cover the long-text editors only", () => {
    const match = (m: string, p: string) => JSON_BODY_OVERRIDES.find((o) => o.methods.includes(m) && o.path.test(p))?.limit;
    expect(match("PATCH", "/academy/content/lessons/12")).toBe("1mb");
    expect(match("PUT", "/game-plan/2026-10-17")).toBe("1mb");
    expect(match("PUT", "/game-plan/my/2026-10-17")).toBe("1mb");
    expect(match("POST", "/client-errors")).toBe("32kb");
    expect(match("POST", "/trades")).toBeUndefined();
    expect(match("DELETE", "/playbook/3")).toBeUndefined();
  });

  it("CSP: scripts locked, frames limited to the video hosts, reports wired", () => {
    const d = cspDirectives(["sha256-abc"]);
    expect(d["script-src"]).toEqual(["'self'", "'sha256-abc'"]);
    expect(d["frame-src"]).toContain("https://www.youtube-nocookie.com");
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["report-uri"]).toEqual(["/api/csp-report"]);
    expect(inlineScriptHashes('<script src="/a.js"></script><script>x()</script>')).toHaveLength(1);
  });
});
