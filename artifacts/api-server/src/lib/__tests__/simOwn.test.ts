/**
 * Simulator own mode («Мои худшие дни»): the pure builders (decision bar, lead-in, real mistakes, comparison, picking)
 * and the service flow over in-memory stores — the game pauses on the real entry, nothing of the real result leaks
 * before the reveal, the reveal compares in the trade's own R, only the viewer's trades are used, and own games stay
 * out of the fair progress.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SimBar } from "../sim/engine";
import { buildOwn, compareOwn, pickOrder, realMistakes, type OwnTradeRow } from "../sim/own";

const DAY = "2026-10-13";
const ny = (date: string, hh: number, mm: number, ss = 0) => Date.parse(`${date}T${String(hh + 4).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}Z`) / 1000;
const iso = (s: number) => new Date(s * 1000).toISOString();
function minuteBars(date: string, fromMin: number, toMin: number, price: number): SimBar[] {
  const out: SimBar[] = [];
  let p = price;
  for (let m = fromMin; m < toMin; m++) {
    const o = p; p = Math.round((p + Math.sin(m / 9) * 0.3) * 100) / 100;
    out.push({ t: ny(date, Math.floor(m / 60), m % 60), o, h: Math.max(o, p) + 0.05, l: Math.min(o, p) - 0.05, c: p, v: 1000 + m });
  }
  return out;
}
const DAY_BARS = [...minuteBars(DAY, 240, 570, 768), ...minuteBars(DAY, 570, 960, 769)];
const PREV_BARS = minuteBars("2026-10-10", 570, 960, 760);

/** A short at 9:57:58 with an add 14 s later, out through the stop at 9:58:37 (like a real −$64 trade). */
const TRADE: OwnTradeRow = {
  id: 501, ticker: "META", day: DAY, side: "Short", entry: "768.83", exit: "770.93", stop: "770.43", qty: "30", pnl: "-63", fees: "0.92", risk_usd: "40.5", tf: "1m",
  execs: [
    { id: 1, kind: "entry", price: "769.08", qty: "15", at: iso(ny(DAY, 9, 57, 58)) },
    { id: 2, kind: "add", price: "768.58", qty: "15", at: iso(ny(DAY, 9, 58, 12)) },
    { id: 3, kind: "exit", price: "770.93", qty: "30", at: iso(ny(DAY, 9, 58, 37)) },
  ],
};
/** A long averaged down 5 minutes later, closed inside the stop. */
const AVG: OwnTradeRow = {
  id: 502, ticker: "INTC", day: DAY, side: "Long", entry: "122.67", exit: "122.54", stop: null, qty: "100", pnl: "-13.5", fees: "1.15", risk_usd: null, tf: "1m",
  execs: [
    { id: 4, kind: "entry", price: "122.74", qty: "75", at: iso(ny(DAY, 11, 22, 49)) },
    { id: 5, kind: "add", price: "122.48", qty: "25", at: iso(ny(DAY, 11, 27, 11)) },
    { id: 6, kind: "exit", price: "122.54", qty: "100", at: iso(ny(DAY, 11, 41, 47)) },
  ],
};

describe("own mode — pure", () => {
  it("decision = the bar before the real entry; lead-in never starts before the last premarket bar", () => {
    const b = buildOwn({ day: DAY, tf: "1m", dayBars: DAY_BARS, prevBars: PREV_BARS, prevLevels: null, firstAt: ny(DAY, 9, 57, 58), lastAt: ny(DAY, 9, 58, 37) })!;
    expect(b).not.toBeNull();
    expect(b.bars[b.entryIdx].t).toBe(ny(DAY, 9, 57));
    expect(b.decisionIdx).toBe(b.entryIdx - 1);
    expect(b.bars[b.startIdx].t).toBe(ny(DAY, 9, 29)); // 30 bars before 9:56 would be 9:26 → clamped to the last premarket bar
    expect(b.bars[b.endIdx].t).toBe(ny(DAY, 15, 59));
    expect(b.exitIdx).toBe(b.entryIdx + 1);
    expect(b.levels.pdh).not.toBeNull();
    // Later entry: a plain 30-bar lead-in.
    const late = buildOwn({ day: DAY, tf: "1m", dayBars: DAY_BARS, prevBars: PREV_BARS, prevLevels: null, firstAt: ny(DAY, 11, 22, 49), lastAt: null })!;
    expect(late.decisionIdx - late.startIdx).toBe(30);
  });

  it("no game without the rest of the day or before the first bar", () => {
    expect(buildOwn({ day: DAY, tf: "1m", dayBars: DAY_BARS.slice(0, 400), prevBars: [], prevLevels: null, firstAt: ny(DAY, 9, 40), lastAt: null })).toBeNull();
    expect(buildOwn({ day: DAY, tf: "1m", dayBars: DAY_BARS, prevBars: [], prevLevels: null, firstAt: ny(DAY, 3, 0), lastAt: null })).toBeNull();
  });

  it("real mistakes: held past the stop (short) and averaging down (long); adding to a winner is not averaging", () => {
    expect(realMistakes(TRADE)).toEqual(["structure:held_past_stop"]);
    expect(realMistakes(AVG)).toEqual(["structure:averaging"]);
  });

  it("comparison in the trade's own R: better / worse / same / skipped", () => {
    const o = { realNet: -63.92, riskUsd: 40.5 };
    expect(compareOwn(o, { net: 20, trades: 1 })).toMatchObject({ diff: 83.92, verdict: "better", realR: -1.58, simR: 0.49 });
    expect(compareOwn(o, { net: -100, trades: 2 }).verdict).toBe("worse");
    expect(compareOwn(o, { net: -63, trades: 1 }).verdict).toBe("same");
    expect(compareOwn(o, { net: 0, trades: 0 })).toMatchObject({ verdict: "skipped", diff: 63.92 });
  });

  it("worst: biggest unplayed loss of the window, then older ones, then replays oldest first; random prefers unplayed", () => {
    const c = (id: number, day: string, net: number) => ({ id, day, net, riskUsd: 50, mistakes: [] as string[] });
    const cands = [c(1, "2026-10-10", -40), c(2, "2026-10-12", -90), c(3, "2026-08-01", -300), c(4, "2026-10-01", -60)];
    const played = new Map([[2, 77], [4, 12]]);
    expect(pickOrder(cands, "worst", played, "2026-10-16", "2026-09-16").map((x) => x.id)).toEqual([1, 3, 4, 2]);
    const r = pickOrder(cands, "random", played, "2026-10-16", "2026-09-16", () => 0.5).map((x) => x.id);
    expect(new Set(r.slice(0, 2))).toEqual(new Set([1, 3]));
  });
});

/* ─────────────────────────── Service flow ─────────────────────────── */

type Row = import("../sim/store").GameRow;
const games = new Map<number, Row>();
let nextId = 1;
const ME = { id: 7, name: "Кирилл Б.", staff: false };

vi.mock("../sim/store", async (orig) => {
  const real = await orig<typeof import("../sim/store")>();
  return {
    ...real,
    loadDayBars: vi.fn(async () => ({ bars: DAY_BARS, tf: "1m", prevClose: 760 })),
    loadPrevDay: vi.fn(async () => ({ bars: PREV_BARS, levels: { h: 765, l: 755, c: PREV_BARS[PREV_BARS.length - 1].c } })),
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
      const g = games.get(id)!; g.cursor = cursor; g.events = structuredClone(events); g.status = "finished"; g.result = structuredClone(result); g.finishedAt = new Date().toISOString();
    }),
    markAbandoned: vi.fn(async (id: number) => { games.get(id)!.status = "abandoned"; }),
    deskTradesForDay: vi.fn(async () => [
      { id: 501, trader: "Кирилл Б.", side: "Short", entry: "768.83", exit: "770.93", stop: "770.43", qty: "30", pnl: "-63", fees: "0.92", risk_usd: "40.5", r_multiple: null, result: "loss", horizon: "intraday", date: DAY, exit_date: null,
        execs: TRADE.execs.map((e) => ({ kind: e.kind, price: e.price, qty: e.qty, at: e.at })) },
      { id: 900, trader: "Ориф", side: "Long", entry: "769", exit: "772", stop: null, qty: "100", pnl: "300", fees: "2", risk_usd: "50", r_multiple: null, result: "win", horizon: "intraday", date: DAY, exit_date: null,
        execs: [{ kind: "entry", price: "769", qty: "100", at: iso(ny(DAY, 10, 0)) }, { kind: "exit", price: "772", qty: "100", at: iso(ny(DAY, 11, 0)) }] },
    ]),
    longNameOf: vi.fn(async () => "Meta Platforms"),
    finishedGames: vi.fn(async (uid: number) => [...games.values()].filter((g) => g.userId === uid && g.status === "finished").map((g) => ({
      id: g.id, mode: g.mode, difficulty: g.difficulty, ticker: g.ticker, day: g.day, dayTo: g.dayTo, tf: g.tf, net: g.result!.net, r: g.result!.r, pct: g.result!.pct,
      bhPct: g.result!.bh.pct, beatBh: g.result!.beatBh, trades: g.result!.trades, finishedAt: g.finishedAt!, own: !!g.params.own,
      ownDiff: (g.result as { own?: { diff: number } }).own?.diff ?? null,
    }))),
    getPrefs: vi.fn(async () => ({ leaderboardVisible: false })),
  };
});

vi.mock("../sim/ownStore", () => ({
  ownCandidates: vi.fn(async (trader: string) => (trader === ME.name ? [structuredClone(TRADE), structuredClone(AVG)] : [])),
  ownTrade: vi.fn(async (trader: string, _last: string, id: number) => (trader === ME.name ? [TRADE, AVG].find((t) => t.id === id) ?? null : null)),
  playedOwnTrades: vi.fn(async (uid: number) => new Map([...games.values()].filter((g) => g.userId === uid && g.params.own && g.status !== "abandoned").map((g) => [g.params.own!.tradeId, g.id]))),
}));

vi.mock("../daily/service", () => ({ mistakeCosts: vi.fn(async () => [{ id: "behavior:revenge", count: 1, days: 1, costNet: -63.92, examples: [{ tradeId: 501, date: DAY, ticker: "META", net: -63.92 }] }]) }));

const sim = await import("../sim/service");
const own = await import("../sim/ownService");

beforeEach(() => { games.clear(); nextId = 1; sim._resetSimCache(); });

describe("own mode — service", () => {
  it("lists only the viewer's replayable losses and points «worst» at the biggest one", async () => {
    const v = await own.ownCandidates(ME);
    expect(v.trades.map((t) => t.tradeId).sort()).toEqual([501, 502]);
    expect(v.worst).toBe(501);
    expect(v.trades.find((t) => t.tradeId === 501)).toMatchObject({ net: -63.92, r: -1.58, mistakes: ["structure:held_past_stop", "behavior:revenge"], played: false });
    expect((await own.ownCandidates({ id: 9, name: "Ориф", staff: true })).trades).toEqual([]);
  });

  it("plays to the real entry, then on; the reveal compares with the real trade and shows only own trades", async () => {
    const s = await own.createOwnGame(ME, "worst", null);
    expect(s.own).toEqual({ tradeId: 501, pick: "worst", ticker: "META", date: DAY, decisionIdx: expect.any(Number), riskSource: "trade" });
    expect(s.cursor).toBeLessThan(s.own!.decisionIdx);
    expect(s.defaultQty).toBe(30);
    expect(s.riskUnit).toBe(1.35); // 40.5 $ / 30 shares
    expect(s.feePerShare).toBeCloseTo(0.92 / 60, 5);
    const json = JSON.stringify(s);
    for (const leak of ["realNet", "\"legs\"", "riskUsd", "held_past_stop", "Ориф"]) expect(json).not.toContain(leak);
    expect(s.reveal).toBeNull();

    // A long autoplay request stops on the decision bar.
    const a = await sim.step(ME, s.id, { advance: 60 });
    expect(a.cursor).toBe(s.own!.decisionIdx);
    expect(JSON.stringify(a)).not.toContain("realNet");
    // Decide: short the default size, then the rest of the day plays on.
    const b = await sim.step(ME, s.id, { order: { kind: "sell", qty: 30 }, advance: 60 });
    expect(b.cursor).toBe(s.own!.decisionIdx + 60);
    const done = await sim.finish(ME, s.id);
    expect(done.done).toBe(true);
    const o = done.reveal!.own!;
    expect(o).toMatchObject({ tradeId: 501, side: "short", realNet: -63.92, riskUsd: 40.5, riskSource: "trade", maxQty: 30 });
    expect(o.mistakes).toEqual(["structure:held_past_stop", "behavior:revenge"]);
    expect(o.legs.map((l) => l.role).slice(0, 2)).toEqual(["entry", "add"]);
    expect(["exit", "stop"]).toContain(o.legs[2].role);
    expect(o.legs[0].idx).toBe(o.entryIdx);
    expect(o.compare.simNet).toBe(done.reveal!.result.net);
    expect(o.compare.diff).toBeCloseTo(done.reveal!.result.net + 63.92, 2);
    expect(done.reveal!.desk.traders.map((t) => t.key)).toEqual(["me"]);
    expect((games.get(s.id)!.result as { own?: unknown }).own).toEqual(o.compare);

    const stats = await sim.myStats(ME);
    expect(stats.totals.games).toBe(0);
    expect(stats.own.games).toBe(1);
    expect(stats.recent[0].own).toBe(true);
  });

  it("a played trade is not offered again while another loss is unplayed; another trader's trade is not found", async () => {
    const first = await own.createOwnGame(ME, "worst", null);
    await sim.finish(ME, first.id).catch(() => undefined); // no orders → abandoned on settle; finish plays it out
    const second = await own.createOwnGame(ME, "worst", null);
    expect(second.own!.tradeId).toBe(502);
    await expect(own.createOwnGame({ id: 9, name: "Ориф", staff: true }, "trade", 501)).rejects.toMatchObject({ code: "TRADE_NOT_FOUND" });
    const direct = await own.createOwnGame(ME, "trade", 502);
    expect(direct.own).toMatchObject({ tradeId: 502, pick: "trade" });
  });
});
