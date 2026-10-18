import { describe, expect, it } from "vitest";
import {
  breachHistory,
  exposureByTrader,
  intradayCurve,
  mondayOf,
  rankLevel,
  riskScore,
  wallMinutes,
  worstUsage,
  type RankInput,
} from "./risk-math";

describe("exposureByTrader", () => {
  it("splits long / short, gross, overnight and top ticker share", () => {
    const m = exposureByTrader([
      { trader: "A", ticker: "nvda", side: "Long", exposureUsd: 6000, carriedTonight: true },
      { trader: "A", ticker: "NVDA", side: "Long", exposureUsd: 2000 },
      { trader: "A", ticker: "TSLA", side: "Short", exposureUsd: -2000 },
      { trader: "B", ticker: "AAPL", side: "шорт", exposureUsd: null },
    ]);
    const a = m.get("A")!;
    expect(a.count).toBe(3);
    expect(a.longUsd).toBe(8000);
    expect(a.shortUsd).toBe(2000);
    expect(a.grossUsd).toBe(10000);
    expect(a.netUsd).toBe(6000);
    expect(a.overnightCount).toBe(1);
    expect(a.overnightUsd).toBe(6000);
    expect(a.topTicker).toBe("NVDA");
    expect(a.topTickerPct).toBe(80);
    const b = m.get("B")!;
    expect(b.count).toBe(1);
    expect(b.grossUsd).toBe(0);
    expect(b.topTicker).toBeNull();
  });
});

describe("desk ranking", () => {
  const base: RankInput = { halted: false, status: "ok", stopState: "ok", dailyPct: 10, weeklyPct: 5, drawdownPct: 0, alertPct: null, todayPnl: -30 };
  it("maps statuses to stop / near / ok / none", () => {
    expect(rankLevel({ ...base, halted: true })).toBe("stop");
    expect(rankLevel({ ...base, status: "breach" })).toBe("stop");
    expect(rankLevel({ ...base, stopState: "warn" })).toBe("near");
    expect(rankLevel({ ...base, status: "no_limits", stopState: "no_limits" })).toBe("none");
    expect(rankLevel(base)).toBe("ok");
  });
  it("orders stop > near > ok > none, then by worst usage, then by loss", () => {
    const stop = riskScore({ ...base, halted: true, dailyPct: 100 });
    const near = riskScore({ ...base, stopState: "warn", dailyPct: 85 });
    const okHi = riskScore({ ...base, dailyPct: 60 });
    const okLo = riskScore({ ...base, dailyPct: 20 });
    const none = riskScore({ ...base, status: "no_limits", stopState: "no_limits", dailyPct: null, weeklyPct: null, drawdownPct: null, todayPnl: -5000 });
    expect(stop).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(okHi);
    expect(okHi).toBeGreaterThan(okLo);
    expect(okLo).toBeGreaterThan(none);
    expect(riskScore({ ...base, todayPnl: -200 })).toBeGreaterThan(riskScore({ ...base, todayPnl: -100 }));
    expect(worstUsage({ dailyPct: null, weeklyPct: 40, drawdownPct: 72, alertPct: null })).toBe(72);
    expect(worstUsage({ dailyPct: null, weeklyPct: null, drawdownPct: null, alertPct: null })).toBeNull();
  });
});

describe("intradayCurve", () => {
  it("parses NY wall-clock times", () => {
    expect(wallMinutes("2026-10-15T16:00:01")).toBe(960);
    expect(wallMinutes("09:28")).toBe(568);
    expect(wallMinutes(null)).toBeNull();
    expect(wallMinutes("2026-10-15")).toBeNull();
  });
  it("accumulates net by close time and tracks the low", () => {
    const c = intradayCurve([
      { id: 3, ticker: "C", side: "Long", qty: 1, net: 50, closeMin: 700, openMin: 690 },
      { id: 1, ticker: "A", side: "Long", qty: 1, net: -120.5, closeMin: 600, openMin: 568 },
      { id: 2, ticker: "B", side: "Short", qty: 1, net: null, closeMin: 650, openMin: 640 },
    ]);
    expect(c.points.map((p) => p.cum)).toEqual([0, -120.5, -70.5]);
    expect(c.points[0].min).toBe(568);
    expect(c.low).toBe(-120.5);
    expect(c.final).toBe(-70.5);
    expect(c.timed).toBe(true);
  });
  it("sums to the journal net of the day (Ориф 15.10: +309.06)", () => {
    const nets = [0.97, 220.26, 30.12, 40.5, 17.21];
    const c = intradayCurve(nets.map((net, i) => ({ id: i + 1, ticker: "T", side: "Long", qty: 1, net, closeMin: 600 + i * 30, openMin: null })));
    expect(c.final).toBe(309.06);
  });
});

describe("breachHistory", () => {
  const limits = { dailyLossLimit: 300, weeklyLossLimit: 600, maxDrawdown: 600 };
  it("finds daily breaches / warns, one weekly record per week and drawdown episodes", () => {
    // Mon 2026-10-05 … Fri 2026-10-09, Mon 2026-10-12
    const pnl = [-250, -320, -100, 50, 0, 2000];
    const dates = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12"];
    let cum = 0, peak = 0;
    const points = pnl.map((v, i) => {
      cum += v;
      peak = Math.max(peak, cum);
      return { date: dates[i], pnl: v, drawdown: cum - peak };
    });
    const b = breachHistory(points, limits);
    const daily = b.filter((x) => x.kind === "daily");
    expect(daily.map((x) => [x.date, x.level])).toEqual([["2026-10-06", "breach"], ["2026-10-05", "warn"]]);
    const weekly = b.filter((x) => x.kind === "weekly");
    expect(weekly).toHaveLength(1);
    expect(weekly[0]).toMatchObject({ date: "2026-10-07", level: "breach", used: 670 });
    const dd = b.filter((x) => x.kind === "drawdown");
    expect(dd.map((x) => [x.date, x.level])).toEqual([["2026-10-07", "breach"], ["2026-10-06", "warn"]]);
    expect(b[0].date >= b[b.length - 1].date).toBe(true);
  });
  it("returns nothing without limits", () => {
    expect(breachHistory([{ date: "2026-10-05", pnl: -5000, drawdown: -5000 }], null)).toEqual([]);
  });
  it("mondayOf handles Sunday", () => {
    expect(mondayOf("2026-10-11")).toBe("2026-10-05");
    expect(mondayOf("2026-10-12")).toBe("2026-10-12");
  });
});
