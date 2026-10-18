import { describe, expect, it } from "vitest";
import { buildDayCandles, type EquityTradeInput } from "@/components/equity-candles/lib";
import { aggregate, bucketKey, derive, fromDashboardDays, fromOhlc, monthStart, toMonthCandles, windowStats } from "../model";

const t = (id: number, date: string, pnl: number): EquityTradeInput => ({
  id, date, pnl, fees: 0, result: pnl > 0 ? "win" : pnl < 0 ? "loss" : "be", ticker: `T${id}`, trader: "Ориф",
});

const day = (date: string, pnl: number, cumPnl: number, extra: Partial<Parameters<typeof fromDashboardDays>[0][number]> = {}) => ({
  date, trades: 2, wins: pnl > 0 ? 2 : 0, losses: pnl < 0 ? 2 : 0, pnl, pnlGross: pnl + 4, fees: -4, r: pnl / 100, cumPnl, cumR: cumPnl / 100, ...extra,
});

describe("fromDashboardDays", () => {
  it("chains open → close from the cumulative values, wicks equal the body", () => {
    const c = fromDashboardDays([day("2026-10-12", 100, 100), day("2026-10-13", -250, -150), day("2026-10-14", 50, -100)], "net");
    expect(c.map((x) => [x.open, x.close])).toEqual([[0, 100], [100, -150], [-150, -100]]);
    expect(c[1]).toMatchObject({ high: 100, low: -150, value: -250, fees: 4, net: -250, gross: -246, trades: 2, losses: 2, winRate: 0 });
    // Peak 100 → close −150: 250 below the high-water mark.
    expect(c[1].closeDrawdown).toBe(-250);
    expect(c[2].closeDrawdown).toBe(-200);
  });

  it("uses R when asked and leaves $ empty without P&L", () => {
    const c = fromDashboardDays([day("2026-10-12", 100, 100, { pnl: null })], "r");
    expect(c[0]).toMatchObject({ close: 1, net: null, fees: 0 });
  });
});

describe("fromOhlc", () => {
  it("keeps the wicks and the trade count", () => {
    const c = fromOhlc([{ time: "2026-10-12", open: 0, high: 30, low: -20, close: 10, volume: 3 }]);
    expect(c[0]).toMatchObject({ open: 0, high: 30, low: -20, close: 10, trades: 3, peakIn: 30, troughIn: -20, drawdown: -20 });
  });
});

describe("aggregation", () => {
  const days = buildDayCandles([
    t(1, "2026-09-29", 100), t(2, "2026-09-30", -40), t(3, "2026-10-01", 70), t(4, "2026-10-06", -20), t(5, "2026-11-02", 5),
  ]);

  it("folds days into months (key = the 1st)", () => {
    const m = toMonthCandles(days);
    expect(m.map((x) => x.key)).toEqual(["2026-09-01", "2026-10-01", "2026-11-01"]);
    expect(m[0]).toMatchObject({ from: "2026-09-29", to: "2026-09-30", days: 2, open: 0, close: 60, high: 100, value: 60, trades: 2, wins: 1, losses: 1 });
    expect(m[1]).toMatchObject({ open: 60, close: 110, value: 50, days: 2 });
  });

  it("aggregate dispatches by level and keeps the total", () => {
    for (const agg of ["day", "week", "month"] as const) {
      const a = aggregate(days, agg);
      expect(a[a.length - 1].close).toBe(115);
      expect(a.reduce((s, c) => s + c.trades, 0)).toBe(5);
    }
    expect(aggregate(days, "week").map((c) => c.key)).toEqual(["2026-09-28", "2026-10-05", "2026-11-02"]);
  });

  it("bucket keys", () => {
    expect(monthStart("2026-10-17")).toBe("2026-10-01");
    expect(bucketKey("2026-10-17", "week")).toBe("2026-10-12");
    expect(bucketKey("2026-10-17", "month")).toBe("2026-10-01");
    expect(bucketKey("2026-10-17", "day")).toBe("2026-10-17");
  });
});

describe("derive", () => {
  it("running peak, underwater and landmarks", () => {
    const c = fromDashboardDays([day("2026-10-12", 100, 100), day("2026-10-13", -250, -150), day("2026-10-14", 300, 150), day("2026-10-15", -20, 130)], "net");
    const d = derive(c);
    expect(d.peak).toEqual([100, 100, 150, 150]);
    expect(d.underwater).toEqual([0, -250, 0, -20]);
    expect(d).toMatchObject({ best: 2, worst: 1, trough: 1, maxDrawdown: -250 });
  });

  it("no best on an all-red curve, no worst on an all-green one, no trough at the peak", () => {
    const red = derive(fromDashboardDays([day("2026-10-12", -10, -10), day("2026-10-13", -5, -15)], "net"));
    expect(red.best).toBe(-1);
    expect(red.worst).toBe(0);
    const green = derive(fromDashboardDays([day("2026-10-12", 10, 10), day("2026-10-13", 5, 15)], "net"));
    expect(green).toMatchObject({ worst: -1, trough: -1, maxDrawdown: 0 });
    expect(derive([])).toMatchObject({ best: -1, worst: -1, trough: -1, peak: [] });
  });
});

describe("windowStats", () => {
  const c = fromDashboardDays([day("2026-10-12", 100, 100), day("2026-10-13", -250, -150), day("2026-10-14", 300, 150), day("2026-10-15", -20, 130)], "net");

  it("result and drawdown measured inside the window", () => {
    expect(windowStats(c, 1, 3)).toMatchObject({ from: "2026-10-13", to: "2026-10-15", result: 30, bars: 3, green: 1, red: 2, maxDrawdown: -250 });
    // Starting at day 3 the peak is that day's open (−150): only the −20 dip counts.
    expect(windowStats(c, 2, 3)).toMatchObject({ result: 280, maxDrawdown: -20, trades: 4, fees: 8 });
  });

  it("clamps and handles empty input", () => {
    expect(windowStats(c, -5, 99)?.bars).toBe(4);
    expect(windowStats([], 0, 0)).toBeNull();
  });
});
