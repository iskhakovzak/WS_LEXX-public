import { describe, expect, it } from "vitest";
import {
  buildCandles, buildDayCandles, dayReportHref, filterPeriod, periodStart, soleTrader, summarize, toWeekCandles, weekStart,
  type EquityTradeInput,
} from "../lib";

const t = (id: number, date: string, pnl: number, fees = 0, closedAt?: string, extra: Partial<EquityTradeInput> = {}): EquityTradeInput => ({
  id, date, pnl, fees, result: pnl > fees ? "win" : pnl < fees ? "loss" : "be", ticker: `T${id}`, trader: "Ориф",
  contextSnapshot: closedAt ? { closedAt: `${date}T${closedAt}` } : null, ...extra,
});

describe("equity candles", () => {
  it("builds OHLC from the intraday cumulative path in close-time order", () => {
    // Day 1: closes at 10:00 (−30), 11:00 (+100), 09:30 (+20) → path 0 → +20 → −10 → +90.
    const c = buildDayCandles([
      t(1, "2026-10-12", -30, 0, "10:00:00"),
      t(2, "2026-10-12", 100, 0, "11:00:00"),
      t(3, "2026-10-12", 20, 0, "09:30:00"),
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ open: 0, close: 90, high: 90, low: -10, peakIn: 90, troughIn: -10, trades: 3, wins: 2, losses: 1, timeOrdered: true });
    expect(c[0].best?.id).toBe(2);
    expect(c[0].worst?.id).toBe(1);
  });

  it("falls back to id order without times and chains days", () => {
    const c = buildDayCandles([
      t(5, "2026-10-13", 50), t(4, "2026-10-13", -80), // id order: −80 then +50
      t(1, "2026-10-12", 10),
    ]);
    expect(c.map((x) => x.key)).toEqual(["2026-10-12", "2026-10-13"]);
    expect(c[1]).toMatchObject({ open: 10, low: -70, high: 10, close: -20, timeOrdered: false });
    expect(c[1].drawdown).toBe(-80); // peak +10 → −70 intraday
    expect(c[1].closeDrawdown).toBe(-30);
  });

  it("uses net = gross − |fees| and skips open trades", () => {
    const c = buildDayCandles([t(1, "2026-10-12", 10, 2.5), { ...t(2, "2026-10-12", 99), result: "open" }]);
    expect(c[0]).toMatchObject({ close: 7.5, net: 7.5, gross: 10, fees: 2.5, trades: 1 });
  });

  it("folds days into Monday-keyed weeks", () => {
    expect(weekStart("2026-10-18")).toBe("2026-10-12"); // Sunday → previous Monday
    expect(weekStart("2026-10-12")).toBe("2026-10-12");
    const days = buildDayCandles([
      t(1, "2026-10-12", 50), t(2, "2026-10-13", -120), t(3, "2026-10-16", 30), t(4, "2026-10-19", 5),
    ]);
    const w = toWeekCandles(days);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ key: "2026-10-12", from: "2026-10-12", to: "2026-10-16", days: 3, open: 0, high: 50, low: -70, close: -40, trades: 3 });
    expect(w[1]).toMatchObject({ open: -40, close: -35, days: 1 });
    expect(buildCandles(days.length ? [t(9, "2026-10-12", 1)] : [], { agg: "week" })).toHaveLength(1);
  });

  it("summarises, filters periods and builds the day-report link", () => {
    const c = buildDayCandles([t(1, "2026-10-12", 50), t(2, "2026-10-13", -120), t(3, "2026-10-14", 30)]);
    const s = summarize(c);
    expect(s).toMatchObject({ total: -40, green: 2, red: 1, maxDrawdown: -120 });
    expect(periodStart("1m", "2026-10-17")).toBe("2026-09-17");
    expect(periodStart("ytd", "2026-10-17")).toBe("2026-01-01");
    expect(filterPeriod([t(1, "2026-08-01", 1), t(2, "2026-10-01", 1)], "1m", "2026-10-17")).toHaveLength(1);
    expect(soleTrader([t(1, "2026-10-12", 1), t(2, "2026-10-12", 1)])).toBe("Ориф");
    expect(soleTrader([t(1, "2026-10-12", 1), t(2, "2026-10-12", 1, 0, undefined, { trader: "Б" })])).toBeNull();
    expect(dayReportHref("2026-10-15", "Ориф")).toBe("/day-report?date=2026-10-15&trader=%D0%9E%D1%80%D0%B8%D1%84");
  });
});
