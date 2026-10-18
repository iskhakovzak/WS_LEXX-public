import { describe, expect, it } from "vitest";
import { buildRoundTrips } from "../propreports/round-trips";
import type { Fill, FillSide, RoundTrip } from "../propreports/types";
import { classifyTrade, isFractionalCent, linkTrades, structureSummary, type ExecIn, type ExecKind, type TradeCtx, type TradeHead } from "../tradeStructure";
import { redactStructure } from "../playbookPrivacy";
import { computeStructures, sourceOfRow, type ExecRowLite, type TradeRowLite } from "../tradeStructureStore";

let seq = 0;
function fill(side: FillSide, qty: number, price: number, dateTime: string, orderId: string | null = null, symbol = "AAPL"): Fill {
  seq++;
  return {
    dateTime, account: "ACC", side, qty, symbol, price, route: null, fees: {},
    tradeDate: dateTime.slice(0, 10), orderId, fillId: `F${seq}`, propReportsId: null, status: null, line: seq,
  };
}
/** Executions of a round trip as the classifier sees them (ids 1..n). */
const execsOf = (t: RoundTrip, base = 0): ExecIn[] =>
  t.executions.map((e, i) => ({ id: base + i + 1, kind: e.kind as ExecKind, price: e.price, qty: e.qty, at: `${e.at}Z`, orderId: e.orderId ?? null, sortOrder: i }));
const headOf = (t: RoundTrip, id: number): TradeHead => ({
  id, group: t.account, symbol: t.symbol, session: t.date, side: t.side === "Short" ? "short" : "long",
  openedAt: `${t.openedAt}Z`, closedAt: t.closedAt ? `${t.closedAt}Z` : null,
});
const ctx = (over: Partial<TradeCtx> = {}): TradeCtx => ({ side: "long", source: "fills", ...over });
let eid = 0;
const ex = (kind: ExecKind, price: number, qty: number | null, at: string | null, orderId: string | null = null): ExecIn =>
  ({ id: ++eid, kind, price, qty, at: at ? `2026-03-02T${at}Z` : null, orderId, sortOrder: eid });
const roles = (s: ReturnType<typeof classifyTrade>) => s.legs.map((l) => l.role);

describe("classifyTrade — legs and roles", () => {
  it("scale-in, partial fix, final exit (long)", () => {
    const s = classifyTrade([
      ex("entry", 10, 100, "09:35:00"), ex("add", 10.5, 100, "09:40:00"),
      ex("trim", 11, 100, "09:50:00"), ex("exit", 11.5, 100, "10:00:00"),
    ], ctx({ riskUsd: 100 }));
    expect(roles(s)).toEqual(["entry", "add", "partial_exit", "exit"]);
    expect(s.legs.map((l) => l.label)).toEqual(["Вход", "Добор", "Частичный фикс", "Выход"]);
    expect(s.stats).toMatchObject({ adds: 1, partials: 1, entries: 2, exits: 2, maxPosition: 200, avgEntry: 10.25, avgExit: 11.25, openQty: 0 });
    expect(s.legs[1].avgAfter).toBe(10.25);
    expect(s.legs[2]).toMatchObject({ positionBefore: 200, positionAfter: 100, realized: 75, r: 0.75, fraction: 0.5 });
    expect(s.legs[3]).toMatchObject({ realized: 125, r: 1.25 });
    expect(s.stats.realized).toBe(200);
    expect(s.stats.rTotal).toBe(2);
    expect(structureSummary(s.stats)).toBe("1 добор · 1 частичный фикс");
  });

  it("partial fills of one order at the same second are ONE leg (no fake add)", () => {
    const s = classifyTrade([
      ex("entry", 20, 100, "09:31:05"), ex("add", 20.02, 200, "09:31:05"), ex("exit", 21, 300, "09:45:00"),
    ], ctx());
    expect(roles(s)).toEqual(["entry", "exit"]);
    expect(s.legs[0]).toMatchObject({ pieces: 2, qty: 300, price: 20.0133 });
    expect(s.stats.adds).toBe(0);
    expect(s.stats.splitFills).toBe(1);
  });

  it("order ids beat timestamps: same order over several seconds = one leg; two orders in one second = two legs", () => {
    const a = classifyTrade([
      ex("entry", 5, 100, "09:31:00", "O1"), ex("add", 5.01, 100, "09:31:03", "O1"), ex("exit", 5.2, 200, "09:40:00", "O2"),
    ], ctx());
    expect(roles(a)).toEqual(["entry", "exit"]);
    const b = classifyTrade([
      ex("entry", 5, 100, "09:31:00", "O1"), ex("add", 5.05, 100, "09:31:00", "O2"), ex("exit", 5.2, 200, "09:40:00", "O3"),
    ], ctx());
    expect(roles(b)).toEqual(["entry", "add", "exit"]);
  });

  it("odd lots keep exact averages and fractions", () => {
    const s = classifyTrade([
      ex("entry", 3.1, 37, "09:31:00"), ex("add", 3.2, 63, "09:33:00"), ex("trim", 3.4, 13, "09:40:00"), ex("exit", 3.3, 87, "09:50:00"),
    ], ctx());
    expect(roles(s)).toEqual(["entry", "add", "partial_exit", "exit"]);
    expect(s.stats.avgEntry).toBe(3.163);
    expect(s.legs[2].fraction).toBe(0.13);
    expect(s.legs[2].positionAfter).toBe(87);
  });

  it("short: adds and covers are signed correctly", () => {
    const s = classifyTrade([
      ex("entry", 50, 200, "09:31:00"), ex("add", 50.5, 100, "09:35:00"), ex("trim", 49, 150, "09:50:00"), ex("exit", 48.5, 150, "10:05:00"),
    ], ctx({ side: "short", riskUsd: 300 }));
    expect(roles(s)).toEqual(["entry", "add", "partial_exit", "exit"]);
    expect(s.stats.avgEntry).toBe(50.1667);
    expect(s.legs[2].realized).toBeCloseTo(175, 2);
    expect(s.legs[3].realized).toBeCloseTo(250, 2);
    expect(s.stats.rTotal).toBeCloseTo(1.4167, 3);
  });

  it("re-entry inside one manual trade (flat, then open again)", () => {
    const s = classifyTrade([
      ex("entry", 10, 100, "09:31:00"), ex("exit", 10.2, 100, "09:40:00"), ex("entry", 10.1, 100, "09:50:00"), ex("exit", 10.4, 100, "10:00:00"),
    ], ctx({ source: "manual" }));
    expect(roles(s)).toEqual(["entry", "exit", "reentry", "exit"]);
  });

  it("explicit stop kind is «Стоп»", () => {
    const s = classifyTrade([ex("entry", 10, 100, "09:31:00"), ex("stop", 9.8, 100, "09:35:00")], ctx({ source: "manual" }));
    expect(roles(s)).toEqual(["entry", "stop"]);
    expect(s.stats).toMatchObject({ stopHit: true, stopInferred: false });
  });

  it("fills without time keep the logged order", () => {
    const s = classifyTrade([ex("entry", 10, 100, null), ex("add", 9.9, 100, null), ex("exit", 10.3, 200, null)], ctx({ source: "manual" }));
    expect(roles(s)).toEqual(["entry", "add", "exit"]);
  });
});

describe("classifyTrade — stops", () => {
  it("known stop: exit at / through the level", () => {
    const s = classifyTrade([ex("entry", 10, 100, "09:31:00"), ex("exit", 9.49, 100, "09:40:00")], ctx({ stop: 9.5 }));
    expect(roles(s)).toEqual(["entry", "stop"]);
    expect(s.legs[1].inferred).toBe(false);
    expect(s.stats).toMatchObject({ stopHit: true, stopInferred: false, stopPrice: 9.5, riskPerShare: 0.5, rTotal: -1.02 });
  });

  it("known stop: a winning exit is never a stop; a partial stopped out keeps the rest", () => {
    const win = classifyTrade([ex("entry", 10, 100, "09:31:00"), ex("exit", 11, 100, "09:40:00")], ctx({ stop: 9.5 }));
    expect(roles(win)).toEqual(["entry", "exit"]);
    const partial = classifyTrade([
      ex("entry", 10, 200, "09:31:00"), ex("trim", 9.5, 100, "09:35:00"), ex("exit", 10.8, 100, "09:50:00"),
    ], ctx({ stop: 9.5 }));
    expect(roles(partial)).toEqual(["entry", "stop", "exit"]);
  });

  it("short known stop is above entry", () => {
    const s = classifyTrade([ex("entry", 20, 100, "09:31:00"), ex("exit", 20.42, 100, "09:40:00")], ctx({ side: "short", stop: 20.4 }));
    expect(roles(s)).toEqual(["entry", "stop"]);
  });

  it("stop derived from risk $", () => {
    const s = classifyTrade([ex("entry", 10, 200, "09:31:00"), ex("exit", 9.5, 200, "09:40:00")], ctx({ riskUsd: 100 }));
    expect(s.stats.stopPrice).toBe(9.5);
    expect(roles(s)).toEqual(["entry", "stop"]);
    expect(s.legs[1].reason).toContain("стоп из риска");
  });

  it("inferred stop: losing exit within 5 min of an adverse add", () => {
    const s = classifyTrade([
      ex("entry", 10, 100, "09:31:00"), ex("add", 9.8, 100, "09:35:00"), ex("exit", 9.6, 200, "09:37:00"),
    ], ctx());
    expect(roles(s)).toEqual(["entry", "add", "stop"]);
    expect(s.legs[2].inferred).toBe(true);
    expect(s.stats.stopInferred).toBe(true);
    expect(structureSummary(s.stats)).toBe("1 добор · стоп?");
  });

  it("inferred stop: losing exit at the worst price of the hold; not when far from it", () => {
    const at = classifyTrade([ex("entry", 10, 100, "09:31:00"), ex("exit", 9.71, 100, "09:40:00")], ctx({ adverseExtreme: 9.7 }));
    expect(roles(at)).toEqual(["entry", "stop"]);
    // gave back 33 % of the 0.30 drawdown — a discretionary exit, not a stop
    const away = classifyTrade([ex("entry", 10, 100, "09:31:00"), ex("exit", 9.9, 100, "09:40:00")], ctx({ adverseExtreme: 9.7 }));
    expect(roles(away)).toEqual(["entry", "exit"]);
    // short on a $300 name: high 300.65, covered at 300.30 = 46 % of the drawdown — not a stop
    const shortAway = classifyTrade([ex("entry", 300, 100, "09:31:00"), ex("exit", 300.3, 100, "09:40:00")], ctx({ side: "short", adverseExtreme: 300.65 }));
    expect(roles(shortAway)).toEqual(["entry", "exit"]);
    const shortStop = classifyTrade([ex("entry", 300, 100, "09:31:00"), ex("exit", 300.6, 100, "09:40:00")], ctx({ side: "short", adverseExtreme: 300.65 }));
    expect(roles(shortStop)).toEqual(["entry", "stop"]);
    const noCandles = classifyTrade([ex("entry", 10, 100, "09:31:00"), ex("exit", 9.71, 100, "09:40:00")], ctx());
    expect(roles(noCandles)).toEqual(["entry", "exit"]);
  });
});

describe("classifyTrade — carry and report averages", () => {
  it("overnight carry: position before the first known fill", () => {
    const s = classifyTrade([ex("add", 12, 100, "09:35:00"), ex("exit", 12.5, 300, "10:00:00")], ctx({ carriedIn: { qty: 200, avg: 11 } }));
    expect(roles(s)).toEqual(["add", "exit"]);
    expect(s.legs[0].positionBefore).toBe(200);
    expect(s.legs[1].realized).toBeCloseTo((12.5 - 11.3333) * 300, 1);
    expect(s.stats.carriedIn).toBe(true);
  });

  it("closing fills with nothing open (carry not loaded) are flagged, not crashed", () => {
    const s = classifyTrade([ex("exit", 12.5, 100, "09:35:00")], ctx());
    expect(roles(s)).toEqual(["exit"]);
    expect(s.stats.carriedIn).toBe(true);
    expect(s.stats.notes.join(" ")).toContain("раньше загруженного периода");
  });

  it("Trades-report averages: fractional cents ⇒ scaled entry / exit likely", () => {
    const s = classifyTrade([ex("entry", 12.3456, 300, "09:35:00"), ex("exit", 12.9, 300, "10:00:00")], ctx({ source: "report" }));
    expect(s.stats).toMatchObject({ fidelity: "averages", scaledEntryLikely: true, scaledExitLikely: false });
    expect(structureSummary(s.stats)).toBe("вход частями");
    expect(isFractionalCent(12.34)).toBe(false);
    expect(isFractionalCent(12.345)).toBe(true);
    expect(isFractionalCent(0.1234)).toBe(false); // sub-dollar quotes trade in 1/100 of a cent
  });

  it("qty unknown: roles from the order, R per share from the stop", () => {
    const s = classifyTrade([ex("entry", 10, null, "09:31:00"), ex("exit", 10.5, null, "09:40:00")], ctx({ source: "manual", stop: 9.75 }));
    expect(roles(s)).toEqual(["entry", "exit"]);
    expect(s.stats.rTotal).toBe(2);
    expect(s.stats.maxPosition).toBeNull();
  });
});

describe("PropReports fills → round trips → structure", () => {
  it("flip through zero: two trades linked as «Переворот»", () => {
    const { trips } = buildRoundTrips([
      fill("B", 100, 10, "2026-03-02 09:31:00"),
      fill("S", 300, 10.4, "2026-03-02 09:40:00"), // closes 100 long, opens 200 short
      fill("B", 200, 10.1, "2026-03-02 09:55:00"),
    ]);
    expect(trips).toHaveLength(2);
    const links = linkTrades(trips.map((t, i) => headOf(t, i + 1)));
    const long = classifyTrade(execsOf(trips[0]), ctx({ link: links.get(1) }));
    const short = classifyTrade(execsOf(trips[1], 10), ctx({ side: "short", link: links.get(2) }));
    expect(roles(long)).toEqual(["entry", "flip"]);
    expect(roles(short)).toEqual(["flip", "exit"]);
    expect(short.legs[0].label).toBe("Переворот");
    expect(structureSummary(long.stats)).toBe("→ переворот");
    expect(structureSummary(short.stats)).toBe("переворот");
  });

  it("re-entry after flat: same symbol, same session, second trade = «Перезаход №1»", () => {
    const { trips } = buildRoundTrips([
      fill("B", 100, 10, "2026-03-02 09:31:00"), fill("S", 100, 10.2, "2026-03-02 09:40:00"),
      fill("B", 100, 10.1, "2026-03-02 10:10:00"), fill("S", 100, 10.5, "2026-03-02 10:30:00"),
      fill("B", 50, 7, "2026-03-02 10:00:00", null, "MSFT"), fill("S", 50, 7.1, "2026-03-02 10:20:00", null, "MSFT"),
    ]);
    const aapl = trips.filter((t) => t.symbol === "AAPL");
    const links = linkTrades(trips.map((t, i) => headOf(t, i + 1)));
    const idOf = (t: RoundTrip) => trips.indexOf(t) + 1;
    const second = classifyTrade(execsOf(aapl[1]), ctx({ link: links.get(idOf(aapl[1])) }));
    expect(roles(second)).toEqual(["reentry", "exit"]);
    expect(second.stats).toMatchObject({ reentryIndex: 1, prevId: idOf(aapl[0]) });
    expect(links.get(idOf(trips.find((t) => t.symbol === "MSFT")!))?.reentryIndex).toBe(0);
  });

  it("one order filled in pieces (same orderId) is not a scale-in", () => {
    const { trips } = buildRoundTrips([
      fill("B", 100, 4, "2026-03-02 09:31:00", "O1"), fill("B", 37, 4.01, "2026-03-02 09:31:02", "O1"), fill("B", 63, 4.01, "2026-03-02 09:31:02", "O1"),
      fill("S", 120, 4.3, "2026-03-02 09:50:00", "O2"), fill("S", 80, 4.25, "2026-03-02 10:05:00", "O3"),
    ]);
    const s = classifyTrade(execsOf(trips[0]), ctx());
    expect(roles(s)).toEqual(["entry", "partial_exit", "exit"]);
    expect(s.legs[0].pieces).toBe(3);
  });

  it("different sessions never link", () => {
    const { trips } = buildRoundTrips([
      fill("B", 100, 10, "2026-03-02 09:31:00"), fill("S", 100, 10.2, "2026-03-02 09:40:00"),
      fill("B", 100, 10, "2026-03-03 09:31:00"), fill("S", 100, 10.2, "2026-03-03 09:40:00"),
    ]);
    const links = linkTrades(trips.map((t, i) => headOf(t, i + 1)));
    expect([...links.values()].map((l) => l.reentryIndex)).toEqual([0, 0]);
  });
});

describe("computeStructures (DB rows)", () => {
  const trade = (id: number, side: string, over: Partial<TradeRowLite> = {}): TradeRowLite => ({
    id, trader: "Ориф", broker_account: "31206881", ticker: "AAPL", date: "2026-03-02", side, stop: null, risk_usd: null, qty: "100",
    result: "Win", source: "propreports", context_snapshot: { fromReport: true }, ...over,
  });
  const exec = (id: number, tradeId: number, kind: string, price: string, at: string, sort: number): ExecRowLite =>
    ({ id, trade_id: tradeId, kind, price, qty: "100", executed_at: new Date(`2026-03-02T${at}Z`), sort_order: sort });

  it("links the day chain and reads report averages", () => {
    const trades = [trade(1, "Long"), trade(2, "Short"), trade(3, "Long", { ticker: "MSFT" })];
    const execs = [
      exec(1, 1, "entry", "10.005", "14:31:00", 0), exec(2, 1, "exit", "10.4", "14:40:00", 1),
      exec(3, 2, "entry", "10.4", "14:40:00", 0), exec(4, 2, "exit", "10.1", "14:55:00", 1),
      exec(5, 3, "entry", "5", "14:31:00", 0), exec(6, 3, "exit", "5.1", "14:41:00", 1),
    ];
    const out = computeStructures(trades, execs);
    expect(out.get(1)!.stats).toMatchObject({ fidelity: "averages", flipOut: true, scaledEntryLikely: true });
    expect(out.get(2)!.legs[0].role).toBe("flip");
    expect(out.get(3)!.stats.reentryIndex).toBe(0);
    expect(out.get(2)!.byExecution[3]).toMatchObject({ role: "flip", legIndex: 0 });
  });

  it("source detection", () => {
    expect(sourceOfRow({ source: "propreports", context_snapshot: { fromReport: true } })).toBe("report");
    expect(sourceOfRow({ source: "propreports", context_snapshot: {} })).toBe("fills");
    expect(sourceOfRow({ source: null, context_snapshot: null })).toBe("manual");
  });
});

describe("redactStructure ($ privacy of GET /trades/:id/executions → structure)", () => {
  const s = classifyTrade([ex("entry", 10, 100, "09:31:00"), ex("trim", 10.5, 50, "09:40:00"), ex("exit", 10.8, 50, "09:50:00")], ctx({ riskUsd: 50 }));
  const viewer = { name: "Алекс", staff: false };

  it("someone else's trade: sizes and $ nulled, roles / prices / R / fractions kept", () => {
    const r = redactStructure({ legs: s.legs, stats: s.stats }, viewer, "Сеня");
    expect(r.legs.map((l) => [l.qty, l.positionBefore, l.positionAfter, l.realized])).toEqual(r.legs.map(() => [null, null, null, null]));
    expect(r.legs.map((l) => [l.role, l.price, l.r, l.fraction])).toEqual(s.legs.map((l) => [l.role, l.price, l.r, l.fraction]));
    expect([r.stats.maxPosition, r.stats.openQty, r.stats.realized]).toEqual([null, null, null]);
    expect(r.stats.rTotal).toBe(s.stats.rTotal);
  });

  it("own trade and staff see everything", () => {
    expect(redactStructure({ legs: s.legs, stats: s.stats }, viewer, "Алекс").stats.maxPosition).toBe(100);
    expect(redactStructure({ legs: s.legs, stats: s.stats }, { name: "Ориф", staff: true }, "Сеня").legs[1].realized).toBe(25);
  });
});
