import { describe, expect, it } from "vitest";
import { dayAgeDays, dayResolution, intervalForAge, pickServedInterval, type CandleInterval } from "../candleLimits";
import {
  buildTrainingTradePayload, canTrainOnTrades, candidateOf, meetsResolution, parseTaskFilters, pickTask, resolutionCounts, taskKey,
  trainingTradeOf, type TaskCandidate,
} from "../trainingTasks";
import type { MoneyViewer } from "../playbookPrivacy";
import type { TradeStructure } from "../tradeStructure";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const age = (d: string) => dayAgeDays(d, NOW);

describe("candleLimits", () => {
  it("age-based interval follows Yahoo limits", () => {
    expect(intervalForAge(age("2026-10-15"))).toBe("1m");
    expect(intervalForAge(age("2026-09-01"))).toBe("5m");
    expect(intervalForAge(age("2026-03-02"))).toBe("60m");
  });

  it("dayResolution: by age, or by what is cached", () => {
    expect(dayResolution("2026-10-15", { m1: false, m5: false }, NOW)).toBe("1m");
    expect(dayResolution("2026-09-01", { m1: false, m5: false }, NOW)).toBe("5m");
    expect(dayResolution("2026-09-01", { m1: true, m5: false }, NOW)).toBe("1m");
    expect(dayResolution("2026-03-02", { m1: false, m5: false }, NOW)).toBe("60m");
    expect(dayResolution("2026-03-02", { m1: false, m5: true }, NOW)).toBe("5m");
  });

  const days = (...ds: string[]) => ds.map((str) => ({ str, age: age(str) }));
  const cache = (entries: [CandleInterval, string[]][]) => new Map(entries.map(([k, v]) => [k, new Set(v)]));

  it("pickServedInterval keeps the requested interval when the oldest day allows it", () => {
    expect(pickServedInterval(days("2026-10-14", "2026-10-15"), "1m", "1m", cache([]))).toEqual({ interval: "1m", fromIndex: 0 });
  });

  it("drops old context days to keep 1m for the trade day", () => {
    // 1-minute bars reach back ~30 days (verified against Yahoo 2026-10-17): 09-11 is too old, 10-15 is not
    expect(pickServedInterval(days("2026-09-11", "2026-10-15"), "1m", "5m", cache([]))).toEqual({ interval: "1m", fromIndex: 1 });
  });

  it("an old day with cached 5m bars is served at 5m instead of hourly (the old bug: hourly + daily only)", () => {
    expect(pickServedInterval(days("2026-03-02"), "1m", "60m", cache([]))).toEqual({ interval: "60m", fromIndex: 0 });
    expect(pickServedInterval(days("2026-02-27", "2026-03-02"), "1m", "60m", cache([["5m", ["2026-03-02"]]]))).toEqual({ interval: "5m", fromIndex: 1 });
    expect(pickServedInterval(days("2026-03-02"), "1m", "60m", cache([["1m", ["2026-03-02"]], ["5m", ["2026-03-02"]]]))).toEqual({ interval: "1m", fromIndex: 0 });
  });

  it("daily requests are left alone", () => {
    expect(pickServedInterval(days("2026-03-02"), "1d", "60m", cache([]))).toEqual({ interval: "60m", fromIndex: 0 });
  });
});

describe("training task filters and picking", () => {
  it("parses filters defensively", () => {
    expect(parseTaskFilters({ source: "desk", side: "SHORT", result: "win", ticker: "aapl", from: "2026-01-01", to: "bad", res: "any", exclude: "t1,d:A:2026-01-02" })).toEqual({
      source: "desk", side: "short", result: "win", ticker: "AAPL", from: "2026-01-01", to: null, res: "any", exclude: ["t1", "d:A:2026-01-02"],
    });
    expect(parseTaskFilters({})).toMatchObject({ source: "mine", side: null, result: null, ticker: null, res: "5m", exclude: [] });
    expect(parseTaskFilters({ ticker: "DROP TABLE" }).ticker).toBeNull();
  });

  it("candidates: weekends and bad tickers are dropped, resolution comes from the day", () => {
    expect(candidateOf({ id: 5, ticker: "nvda", date: "2026-10-15", m1: false, m5: false }, NOW)).toEqual({ kind: "trade", tradeId: 5, ticker: "NVDA", date: "2026-10-15", res: "1m" });
    expect(candidateOf({ ticker: "SPY", date: "2026-03-02", m5: true }, NOW)).toEqual({ kind: "day", tradeId: null, ticker: "SPY", date: "2026-03-02", res: "5m" });
    expect(candidateOf({ id: 1, ticker: "SPY", date: "2026-10-17" }, NOW)).toBeNull(); // Saturday
    expect(candidateOf({ id: 1, ticker: "1BAD", date: "2026-10-15" }, NOW)).toBeNull();
  });

  const list: TaskCandidate[] = [
    { kind: "trade", tradeId: 1, ticker: "A", date: "2026-10-15", res: "1m" },
    { kind: "trade", tradeId: 2, ticker: "B", date: "2026-09-01", res: "5m" },
    { kind: "trade", tradeId: 3, ticker: "C", date: "2026-03-02", res: "60m" },
  ];

  it("resolution preference: 1m only, 1m/5m, any", () => {
    expect(meetsResolution("5m", "1m")).toBe(false);
    expect(meetsResolution("5m", "5m")).toBe(true);
    expect(meetsResolution("60m", "5m")).toBe(false);
    expect(meetsResolution("60m", "any")).toBe(true);
    expect(resolutionCounts(list)).toEqual({ total: 3, "1m": 1, "5m": 1, "60m": 1 });
  });

  it("never picks an hourly-only day by default, skips excluded tasks, falls back when all are excluded", () => {
    for (let i = 0; i < 20; i++) expect(pickTask(list, "5m", [], () => i / 20)?.res).not.toBe("60m");
    expect(pickTask(list, "5m", ["t1"], () => 0)?.tradeId).toBe(2);
    expect(pickTask(list, "1m", ["t1"], () => 0)?.tradeId).toBe(1);
    expect(pickTask(list.slice(2), "5m", [], () => 0)).toBeNull();
    expect(taskKey({ kind: "day", tradeId: null, ticker: "SPY", date: "2026-03-02" })).toBe("d:SPY:2026-03-02");
  });
});

describe("GET /training/trades/:id payload — $ privacy", () => {
  const trader: MoneyViewer = { name: "Артур", staff: false };
  const curator: MoneyViewer = { name: "Антон", staff: true };
  const owner: MoneyViewer = { name: "Ориф", staff: false };
  const row = {
    id: 999, ticker: "koru", date: "2026-10-15", side: "Long", entry: "10.8950", exit: "12.0100", stop: "10.50", qty: "200.00", pnl: "223.0000",
    fees: "1.10", risk_usd: "80", result: "win", horizon: "intraday", exit_date: null, r_multiple: "2.79", setup: "Gap", trader: "Ориф",
    notes: "секрет", screenshot_url: "x.png", context_snapshot: { a: 1 },
  };
  const execs = [
    { id: 1, trade_id: 999, kind: "entry", price: "10.8950", qty: "200", executed_at: "2026-10-15T13:45:00Z", note: "PropReports B #1 · fees 0.55", sort_order: 0 },
    { id: 2, trade_id: 999, kind: "exit", price: "12.0100", qty: "200", executed_at: "2026-10-15T14:10:00Z", note: "fees 0.55", sort_order: 1 },
  ];
  const structure = {
    legs: [
      { index: 0, role: "entry", label: "Вход", opening: true, executionIds: [1], pieces: 1, price: 10.895, qty: 200, positionBefore: 0, positionAfter: 200, realized: null, r: null },
      { index: 1, role: "exit", label: "Выход", opening: false, executionIds: [2], pieces: 1, price: 12.01, qty: 200, positionBefore: 200, positionAfter: 0, realized: 223, r: 2.79 },
    ],
    stats: { maxPosition: 200, openQty: 0, realized: 223, rTotal: 2.79, adds: 0, partials: 0, stopHit: false, stopInferred: false, reentryIndex: 0, flipIn: false, flipOut: false, scaledEntryLikely: false, scaledExitLikely: false, fidelity: "fills" },
    byExecution: { 1: { role: "entry", legIndex: 0, inferred: false }, 2: { role: "exit", legIndex: 1, inferred: false } },
  } as unknown as TradeStructure;

  it("a plain trader gets someone else's trade in prices / R only: no $, no size, no fees in notes", () => {
    const p = buildTrainingTradePayload(row, execs, { structure, siblings: [] }, trader);
    expect(p.trade).toMatchObject({ id: 999, ticker: "KORU", side: "Long", entry: 10.895, exit: 12.01, stop: 10.5, rMultiple: 2.79, trader: "Ориф", redacted: true });
    expect([p.trade.pnl, p.trade.qty, p.trade.fees, p.trade.riskUsd]).toEqual([null, null, null, null]);
    expect(p.executions.map((e) => e.qty)).toEqual([null, null]);
    expect(p.executions.map((e) => e.price)).toEqual(["10.8950", "12.0100"]);
    expect(p.executions.map((e) => e.note)).toEqual(["PropReports B #1", null]);
    expect(p.executions[0].roleLabel).toBe("Вход");
    const legs = (p.structure as { legs: Record<string, unknown>[] }).legs;
    expect(legs.map((l) => [l.qty, l.positionAfter, l.realized])).toEqual([[null, null, null], [null, null, null]]);
    expect(legs[1].r).toBe(2.79);
    expect((p.structure as { stats: Record<string, unknown> }).stats).toMatchObject({ maxPosition: null, openQty: null, realized: null, rTotal: 2.79 });
  });

  it("only whitelisted fields leave the server (no notes / screenshots / context)", () => {
    const t = trainingTradeOf(row, trader) as Record<string, unknown>;
    expect(t.notes).toBeUndefined();
    expect(t.screenshot_url).toBeUndefined();
    expect(t.context_snapshot).toBeUndefined();
  });

  it("someone else's trade without a stored R still carries its result after redaction: R from pnl / risk, else the % move", () => {
    const noR = { ...row, r_multiple: null, stop: null, pnl: "223", risk_usd: "80" };
    const t = trainingTradeOf(noR, trader);
    expect([t.pnl, t.riskUsd, t.redacted]).toEqual([null, null, true]);
    expect(t.rMultiple).toBe(2.79);
    expect(t.movePct).toBe(10.23);
    const noRisk = trainingTradeOf({ ...noR, risk_usd: null }, trader);
    expect(noRisk.rMultiple).toBeNull();
    expect(noRisk.movePct).toBe(10.23);
    // A short that went down is a gain; R from the price stop when there is one.
    const short = trainingTradeOf({ ...row, side: "Short", entry: "20", exit: "19", stop: "20.5", r_multiple: null, result: "win" }, trader);
    expect([short.rMultiple, short.movePct]).toEqual([2, 5]);
  });

  it("owner and staff see it in full", () => {
    for (const v of [owner, curator]) {
      const p = buildTrainingTradePayload(row, execs, { structure, siblings: [] }, v);
      expect(p.trade).toMatchObject({ pnl: 223, qty: 200, fees: 1.1, riskUsd: 80, redacted: false });
      expect(p.executions[0].qty).toBe("200");
      expect(p.executions[0].note).toContain("fees");
    }
  });

  it("desk trades need a signed-in member", () => {
    expect(canTrainOnTrades(trader, false)).toBe(true);
    expect(canTrainOnTrades({ name: null, staff: false }, false)).toBe(false);
    expect(canTrainOnTrades(trader, true)).toBe(false);
  });
});
