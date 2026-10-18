/**
 * routes/daily.ts — access and validation. The DB, the actor and lib/daily/service are mocked: a trader reads only
 * their own card, staff read a trader through journal.review (assigned scope respected), the override takes a valid
 * MistakeId only, a dispute needs a broken focus, a future day can't be reviewed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

type Who = { id: number; name: string; role: "trader" | "curator" | "admin"; wards: string[] };
const TRADER: Who = { id: 5, name: "Кирилл Б.", role: "trader", wards: [] };
const CURATOR: Who = { id: 3, name: "Ольга Н.", role: "curator", wards: ["Кирилл Б."] };
let who: Who = TRADER;
let focusStatus: "broken" | "kept" = "broken";

vi.mock("@workspace/db", () => ({
  db: {},
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/FROM users WHERE name = \$1/.test(sql)) return { rows: ["Кирилл Б.", "Максим Р."].includes(String(params[0])) ? [{ "?column?": 1 }] : [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  },
}));
vi.mock("../../lib/permissions", async (orig) => {
  const actual = await orig<typeof import("../../lib/permissions")>();
  return {
    ...actual,
    resolveActor: vi.fn(async () => ({ id: who.id, name: who.name, role: who.role, guest: false, wards: who.wards })),
    getEffectiveMatrix: vi.fn(async () => actual.buildEffectiveMatrix([])),
  };
});
const service = vi.hoisted(() => ({
  dailyMe: vi.fn(async (trader: string) => ({ today: "2026-10-18", phase: "weekend", focus: null, evening: null, progress: null, intraday: false, trader })),
  eveningFor: vi.fn(async () => ({ focus: { status: focusStatus } })),
  markReviewed: vi.fn(async () => undefined),
  setFocusOverride: vi.fn(async (trader: string, date: string, mistake: string | null, by: string) => ({ trader, date, mistake, source: mistake ? "curator" : "auto", by })),
}));
vi.mock("../../lib/daily/service", () => service);

process.env.JWT_SECRET ??= "vitest-only-secret";
const { default: router } = await import("../daily");
const { errorMiddleware } = await import("../../lib/http");

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: who.id, name: who.name, role: who.role };
    next();
  });
  app.use("/api", router);
  app.use(errorMiddleware);
  server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { who = TRADER; focusStatus = "broken"; vi.clearAllMocks(); });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

describe("GET /daily/me and /daily/trader/:name", () => {
  it("a trader gets their own card", async () => {
    const r = await call("GET", "/api/daily/me");
    expect(r.status).toBe(200);
    expect(service.dailyMe).toHaveBeenCalledWith("Кирилл Б.");
  });
  it("a trader can't read another trader", async () => {
    const r = await call("GET", `/api/daily/trader/${encodeURIComponent("Максим Р.")}`);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("FORBIDDEN");
    expect(service.dailyMe).not.toHaveBeenCalled();
  });
  it("a curator reads a trader; an unknown trader is 404", async () => {
    who = CURATOR;
    expect((await call("GET", `/api/daily/trader/${encodeURIComponent("Кирилл Б.")}`)).status).toBe(200);
    expect(service.dailyMe).toHaveBeenCalledWith("Кирилл Б.");
    const r = await call("GET", `/api/daily/trader/${encodeURIComponent("Никто")}`);
    expect(r.status).toBe(404);
    expect(r.json.code).toBe("TRADER_NOT_FOUND");
  });
});

describe("POST /daily/review", () => {
  it("marks the viewer's own day; the note and dispute pass through", async () => {
    const r = await call("POST", "/api/daily/review", { date: "2026-10-16", note: "ok", dispute: true });
    expect(r.status).toBe(200);
    expect(service.markReviewed).toHaveBeenCalledWith("Кирилл Б.", "2026-10-16", { note: "ok", dispute: true });
  });
  it("a dispute on a day whose focus was kept is 409", async () => {
    focusStatus = "kept";
    const r = await call("POST", "/api/daily/review", { date: "2026-10-16", dispute: true });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("DAILY_NOTHING_TO_DISPUTE");
    expect(service.markReviewed).not.toHaveBeenCalled();
  });
  it("rejects bad and future dates", async () => {
    expect((await call("POST", "/api/daily/review", { date: "2026-02-30" })).json.code).toBe("VALIDATION");
    expect((await call("POST", "/api/daily/review", { date: "2999-01-01" })).json.code).toBe("INVALID_DATE");
  });
});

describe("PUT /daily/focus/:trader/:date", () => {
  const path = `/api/daily/focus/${encodeURIComponent("Кирилл Б.")}/2026-10-19`;
  it("traders can't override", async () => {
    expect((await call("PUT", path, { mistake: "behavior:revenge" })).status).toBe(403);
  });
  it("the assigned curator sets a valid mistake, or resets with null", async () => {
    who = CURATOR;
    const r = await call("PUT", path, { mistake: "structure:averaging" });
    expect(r.status).toBe(200);
    expect(service.setFocusOverride).toHaveBeenCalledWith("Кирилл Б.", "2026-10-19", "structure:averaging", "Ольга Н.");
    expect((await call("PUT", path, { mistake: null })).json.source).toBe("auto");
  });
  it("an unknown mistake id is a validation error", async () => {
    who = CURATOR;
    const r = await call("PUT", path, { mistake: "behavior:sleepy" });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("VALIDATION");
  });
});
