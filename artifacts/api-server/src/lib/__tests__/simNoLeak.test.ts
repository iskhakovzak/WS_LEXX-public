/**
 * The simulator never hands the player the future: the store is replaced by an in-memory fake (one cached ticker-day),
 * and every payload the service returns during a game is checked for bars past the cursor, real timestamps, the
 * ticker and the date. The reveal appears only once the game is over, and «undo» cannot rewind past a shown bar.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SimBar } from "../sim/engine";

const DAY = "2026-10-16";
const TICKER = "ZZTOP";
const ny = (date: string, hh: number, mm: number) => Date.parse(`${date}T${String(hh + 4).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`) / 1000;
function minuteBars(date: string, fromMin: number, toMin: number, price: number): SimBar[] {
  const out: SimBar[] = [];
  let p = price;
  for (let m = fromMin; m < toMin; m++) {
    const o = p; p = Math.round((p + Math.sin(m / 7) * 0.2) * 100) / 100;
    out.push({ t: ny(date, Math.floor(m / 60), m % 60), o, h: Math.max(o, p) + 0.03, l: Math.min(o, p) - 0.03, c: p, v: 500 + m });
  }
  return out;
}
const DAY_BARS = [...minuteBars(DAY, 240, 570, 41.1), ...minuteBars(DAY, 570, 960, 42.3), ...minuteBars(DAY, 960, 1100, 44)];
const PREV_BARS = minuteBars("2026-10-15", 570, 960, 40.2);
const REAL_TIMES = new Set([...DAY_BARS, ...PREV_BARS].map((b) => String(b.t)));

type Row = import("../sim/store").GameRow;
const games = new Map<number, Row>();
let nextId = 1;

vi.mock("../sim/store", async (orig) => {
  const real = await orig<typeof import("../sim/store")>();
  return {
    ...real,
    intradayCandidates: vi.fn(async () => [{ ticker: TICKER, day: DAY, tf: "1m", desk: 3, gapPct: 1.2, rangePct: 3.4, prevClose: 41 }]),
    swingCandidates: vi.fn(async () => []),
    loadDayBars: vi.fn(async () => ({ bars: DAY_BARS, tf: "1m", prevClose: 41 })),
    loadPrevDay: vi.fn(async () => ({ bars: PREV_BARS, levels: { h: 41, l: 40, c: PREV_BARS[PREV_BARS.length - 1].c } })),
    recentScenarioKeys: vi.fn(async () => new Set<string>()),
    deskFeePerShare: vi.fn(async () => 0.0048),
    insertGame: vi.fn(async (g: Omit<Row, "id" | "status" | "result" | "createdAt" | "finishedAt" | "events">) => {
      const row: Row = { ...g, id: nextId++, status: "active", result: null, events: [], createdAt: new Date().toISOString(), finishedAt: null };
      games.set(row.id, structuredClone(row));
      return structuredClone(row);
    }),
    loadGame: vi.fn(async (id: number) => (games.has(id) ? structuredClone(games.get(id)!) : null)),
    activeGameId: vi.fn(async (uid: number) => [...games.values()].find((g) => g.userId === uid && g.status === "active")?.id ?? null),
    saveProgress: vi.fn(async (id: number, cursor: number, events: Row["events"]) => { const g = games.get(id)!; g.cursor = cursor; g.events = structuredClone(events); }),
    saveFinished: vi.fn(async (id: number, cursor: number, events: Row["events"], result: Row["result"]) => {
      const g = games.get(id)!; g.cursor = cursor; g.events = structuredClone(events); g.status = "finished"; g.result = structuredClone(result);
    }),
    markAbandoned: vi.fn(async (id: number) => { games.get(id)!.status = "abandoned"; }),
    deskTradesForDay: vi.fn(async () => [
      { id: 1, trader: "Закир", side: "Long", entry: "42.40", exit: "42.90", stop: "42.20", qty: "100", pnl: "50", fees: "1", risk_usd: "20", r_multiple: null, result: "win", horizon: "intraday", date: DAY, exit_date: null,
        execs: [{ kind: "entry", price: "42.40", qty: "100", at: new Date(ny(DAY, 9, 35) * 1000).toISOString() }, { kind: "exit", price: "42.90", qty: "100", at: new Date(ny(DAY, 10, 20) * 1000).toISOString() }] },
      { id: 2, trader: "Артур", side: "Short", entry: "42.80", exit: "42.50", stop: null, qty: "200", pnl: "60", fees: "2", risk_usd: null, r_multiple: "1.5", result: "win", horizon: "intraday", date: DAY, exit_date: null,
        execs: [{ kind: "entry", price: "42.80", qty: "200", at: new Date(ny(DAY, 9, 40) * 1000).toISOString() }, { kind: "exit", price: "42.50", qty: "200", at: new Date(ny(DAY, 14, 0) * 1000).toISOString() }] },
    ]),
    deskTradesForRange: vi.fn(async () => []),
    deskIntradayCount: vi.fn(async () => 0),
    longNameOf: vi.fn(async () => "ZZ Top Holdings"),
  };
});

const sim = await import("../sim/service");
const me = { id: 1, name: "Закир", staff: false };
const curator = { id: 2, name: "Антон", staff: true };

function assertNoLeak(payload: unknown, cursor: number) {
  const json = JSON.stringify(payload);
  expect(json).not.toContain(TICKER);
  expect(json).not.toContain(DAY);
  expect(json).not.toContain("2026-10-15");
  for (const t of REAL_TIMES) expect(json.includes(`[${t},`)).toBe(false);
  const bars = (payload as { bars?: unknown[] }).bars;
  if (bars) for (const b of bars as number[][]) expect(new Date(b[0] * 1000).getUTCFullYear()).toBe(2001);
  const s = payload as { cursor?: number; bars?: unknown[] };
  if (s.cursor != null) expect(s.cursor).toBe(cursor);
}

beforeEach(() => { games.clear(); nextId = 1; sim._resetSimCache(); });

describe("simulator — no leak", () => {
  it("a new game shows only the past: bars up to the cursor, fake times, no ticker / date / reveal", async () => {
    const g = await sim.createGame(me, "intraday", "medium", () => 0.3);
    expect(g.reveal).toBeNull();
    expect(g.bars).toHaveLength(g.cursor + 1);
    expect(g.cursor).toBe(g.startIdx);
    expect(g.endIdx - g.startIdx).toBe(90);
    assertNoLeak(g, g.startIdx);
    // Levels come from the past only (premarket / previous day).
    expect(g.levels.pmh).not.toBeNull();
  });

  it("each step returns exactly the requested new bars; state never uses later bars", async () => {
    const g = await sim.createGame(me, "intraday", "medium", () => 0.3);
    const s1 = await sim.step(me, g.id, { order: { kind: "buy", qty: g.defaultQty }, bracket: { stop: Math.round((g.bars[g.cursor][4] - g.riskUnit) * 100) / 100, target: null }, advance: 3 });
    expect(s1.bars).toHaveLength(3);
    expect(s1.cursor).toBe(g.cursor + 3);
    expect(s1.reveal).toBeNull();
    assertNoLeak(s1, g.cursor + 3);
    // Unrealised P&L is marked at the last SHOWN close.
    const lastShown = s1.bars[2][4];
    if (s1.state.pos !== 0) expect(s1.state.unrealized).toBeCloseTo((lastShown - (s1.state.avg ?? 0)) * s1.state.pos, 2);
    // Re-reading the game gives the same window, not more.
    const again = await sim.gameSnapshot(me, g.id);
    expect(again.bars).toHaveLength(s1.cursor + 1);
    assertNoLeak(again, s1.cursor);
    const active = await sim.activeSnapshot(me);
    expect(active!.id).toBe(g.id);
    assertNoLeak(active, s1.cursor);
  });

  it("undo removes the last order only while no bar has been shown since", async () => {
    const g = await sim.createGame(me, "intraday", "medium", () => 0.3);
    const a = await sim.step(me, g.id, { order: { kind: "sell", qty: 10 }, advance: 0 });
    expect(a.state.pos).toBe(-10);
    expect(a.state.canUndo).toBe(true);
    const u = await sim.undo(me, g.id);
    expect(u.state.pos).toBe(0);
    await sim.step(me, g.id, { order: { kind: "buy", qty: 10 }, advance: 1 });
    await expect(sim.undo(me, g.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("orders over buying power and stops on the wrong side are refused", async () => {
    const g = await sim.createGame(me, "intraday", "medium", () => 0.3);
    await expect(sim.step(me, g.id, { order: { kind: "buy", qty: 1_000_000 }, advance: 0 })).rejects.toMatchObject({ code: "VALIDATION" });
    const px = g.bars[g.cursor][4];
    await expect(sim.step(me, g.id, { order: { kind: "buy", qty: 10 }, bracket: { stop: px + 1, target: null }, advance: 0 })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("another user cannot read or play someone's game", async () => {
    const g = await sim.createGame(me, "intraday", "medium", () => 0.3);
    await expect(sim.gameSnapshot({ id: 99, name: "X", staff: true }, g.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(sim.step({ id: 99, name: "X", staff: false }, g.id, { advance: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("the reveal comes from the server at the end: ticker, real times, result, desk trades (anonymised for traders)", async () => {
    const g = await sim.createGame(me, "intraday", "medium", () => 0.3);
    await sim.step(me, g.id, { order: { kind: "buy", qty: 50 }, advance: 10 });
    const end = await sim.finish(me, g.id);
    expect(end.done).toBe(true);
    expect(end.cursor).toBe(g.endIdx);
    expect(end.reveal).not.toBeNull();
    const r = end.reveal!;
    expect(r.ticker).toBe(TICKER);
    expect(r.day).toBe(DAY);
    expect(r.realTimes).toHaveLength(g.endIdx + 1);
    expect(end.state.pos).toBe(0);
    expect(r.result.trades).toBe(1);
    // Desk: own trade with name and $, the other trader anonymised without $.
    const mine = r.desk.traders.find((t) => t.own)!;
    expect(mine.name).toBe("Закир");
    expect(mine.trades[0].net).toBe(49);
    const other = r.desk.traders.find((t) => !t.own)!;
    expect(other.name).toBeNull();
    expect(other.label).toBe("A");
    expect(other.trades[0].net).toBeNull();
    expect(other.trades[0].r).toBe(1.5);
    // The 14:00 exit is after the game window (9:30–11:00): counted, not drawn.
    expect(r.desk.outside).toBe(1);
    expect(JSON.stringify(r.desk)).not.toContain("Артур");
    await expect(sim.step(me, g.id, { advance: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("staff see names and money in the desk comparison", async () => {
    const g = await sim.createGame(curator, "intraday", "medium", () => 0.3);
    const end = await sim.finish(curator, g.id);
    const names = end.reveal!.desk.traders.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["Закир", "Артур"]));
    expect(end.reveal!.desk.traders.every((t) => t.trades.every((x) => x.net != null))).toBe(true);
  });

  it("starting a new game settles the old one: played out if it had orders, abandoned if not", async () => {
    const a = await sim.createGame(me, "intraday", "medium", () => 0.3);
    await sim.createGame(me, "intraday", "medium", () => 0.3);
    expect(games.get(a.id)!.status).toBe("abandoned");
    const b = [...games.values()].find((x) => x.status === "active")!;
    await sim.step(me, b.id, { order: { kind: "buy", qty: 5 }, advance: 2 });
    await sim.createGame(me, "intraday", "medium", () => 0.3);
    expect(games.get(b.id)!.status).toBe("finished");
    expect(games.get(b.id)!.result!.trades).toBe(1);
  });
});
