/**
 * routes/top.ts — access, validation and the privacy policy end to end (DB and actor mocked): a trader gets aliases and
 * $ but never a real name (anonymous mode, the default), staff get names, the setting off shows names and hides others'
 * $; an unknown alias is 404; bad dates / months are 400; one grouped query per call plus the desk roster / holidays lookup.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

type Who = { id: number; name: string; role: "trader" | "curator" | "admin" };
const TRADER: Who = { id: 5, name: "Кирилл Б.", role: "trader" };
const ADMIN: Who = { id: 1, name: "Дмитрий К.", role: "admin" };
let who: Who = TRADER;

const DAY_ROWS = [
  { trader: "Кирилл Б.", ticker: "AMD", net: "120.5", trades: 2, wins: 2, losses: 0 },
  { trader: "Максим Р.", ticker: "META", net: "640", trades: 4, wins: 3, losses: 1 },
  { trader: "Глеб П.", ticker: "META", net: "-310", trades: 3, wins: 0, losses: 3 },
  { trader: "Павел С.", ticker: "NVDA", net: "-45", trades: 1, wins: 0, losses: 1 },
];
const NAMES = ["Кирилл Б.", "Максим Р.", "Глеб П.", "Павел С."];
const query = vi.fn(async (sql: string) => {
  if (/holiday_calendar/.test(sql)) return { rows: [{ date: "2026-10-12" }] };
  if (/WITH td AS/.test(sql)) return { rows: [{ date: "2026-10-16", net: 405.5, trades: 10, traders: 4, best: 640, worst: -310, mine: 120.5, traded: true }] };
  if (/SELECT DISTINCT trader FROM trades/.test(sql)) return { rows: DAY_ROWS.map((r) => ({ trader: r.trader })) };
  if (/LATERAL/.test(sql)) return { rows: DAY_ROWS.map((r) => ({ ...r, side: "Long", first_at: "2026-10-16T13:45:00.000Z", last_at: "2026-10-16T14:10:00.000Z" })) };
  return { rows: DAY_ROWS };
});
vi.mock("@workspace/db", () => ({ db: {}, pool: { query: (sql: string) => query(sql) } }));
vi.mock("../../lib/permissions", async (orig) => {
  const actual = await orig<typeof import("../../lib/permissions")>();
  return {
    ...actual,
    resolveActor: vi.fn(async () => ({ id: who.id, name: who.name, role: who.role, guest: false, wards: [] })),
    getEffectiveMatrix: vi.fn(async () => actual.buildEffectiveMatrix([])),
  };
});

process.env.JWT_SECRET ??= "vitest-only-secret";
const { default: router } = await import("../top");
const { errorMiddleware } = await import("../../lib/http");
const { __loadSettingsCache } = await import("../../lib/settings/registry");
const { deskAliases } = await import("../../lib/deskAliases");

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
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
beforeEach(() => { who = TRADER; __loadSettingsCache({}); query.mockClear(); });

async function get(path: string): Promise<{ status: number; text: string; json: any }> {
  const r = await fetch(base + path);
  const text = await r.text();
  return { status: r.status, text, json: JSON.parse(text) };
}
const noNames = (text: string) => { for (const n of NAMES) expect(text).not.toContain(n); };

describe("GET /top/day/:date", () => {
  it("trader (default setting): aliases + $, own row flagged, no real name in the body", async () => {
    const r = await get("/api/top/day/2026-10-16");
    expect(r.status).toBe(200);
    expect(r.json.mode).toBe("anonymous");
    expect(r.json.profit.map((x: any) => x.net)).toEqual([640, 120.5]);
    expect(r.json.loss.map((x: any) => x.net)).toEqual([-310, -45]);
    expect(r.json.profit[1]).toMatchObject({ me: true, name: null, alias: deskAliases(NAMES, "2026-10-16").get("Кирилл Б.") });
    noNames(r.text);
    expect(query).toHaveBeenCalledTimes(2); // the grouped rows + the desk roster (lib/deskDayStore)
  });
  it("admin: names shown", async () => {
    who = ADMIN;
    const r = await get("/api/top/day/2026-10-16");
    expect(r.json.mode).toBe("staff");
    expect(r.json.profit[0]).toMatchObject({ name: "Максим Р.", net: 640 });
  });
  it("setting off: a trader sees names, others' $ hidden", async () => {
    __loadSettingsCache({ "privacy.hideNamesFromTraders": false });
    const r = await get("/api/top/day/2026-10-16");
    expect(r.json.mode).toBe("named");
    expect(r.json.profit[0]).toMatchObject({ name: "Максим Р.", net: null });
    expect(r.json.me).toMatchObject({ name: "Кирилл Б.", net: 120.5 });
  });
  it("bad date → 400", async () => {
    expect((await get("/api/top/day/2026-13-40")).status).toBe(400);
  });
});

describe("GET /top/day/:date/trader/:alias", () => {
  const aliases = deskAliases(NAMES, "2026-10-16");
  it("trader opens another trader's day by alias: tickers with $ and times, no name", async () => {
    const r = await get(`/api/top/day/2026-10-16/trader/${aliases.get("Максим Р.")}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ me: false, name: null, net: 640, place: 1 });
    expect(r.json.tickers[0]).toMatchObject({ ticker: "META", side: "long", net: 640, firstAt: "2026-10-16T13:45:00.000Z" });
    noNames(r.text);
    expect(query).toHaveBeenCalledTimes(2); // the grouped rows + the desk roster (lib/deskDayStore)
  });
  it("unknown alias → 404; non-numeric → 400", async () => {
    expect((await get("/api/top/day/2026-10-16/trader/99")).status).toBe(404);
    expect((await get("/api/top/day/2026-10-16/trader/abc")).status).toBe(400);
  });
});

describe("GET /top/calendar", () => {
  it("days + holidays; month is validated", async () => {
    const r = await get("/api/top/calendar?month=2026-10");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ month: "2026-10", holidays: ["2026-10-12"], days: [{ date: "2026-10-16", net: 405.5, best: 640, worst: -310, mine: 120.5 }] });
    expect((await get("/api/top/calendar?month=2026-13")).status).toBe(400);
    expect((await get("/api/top/calendar")).status).toBe(400);
  });
});
