import { describe, expect, it } from "vitest";
import {
  badgesFor, bestDayShare, computeTraderMetrics, consistencyFlag, deskMedian, drawdownInfo, parseHoldMinutes, percentileRank,
  percentiles, profitFactor, sameTickerCases, sharpeRatio, sortinoRatio, stdev, streaks, trendFor, type BenchTrade,
} from "../benchmark";

let seq = 0;
const tr = (p: Partial<BenchTrade> & { day: string }): BenchTrade => ({
  id: ++seq, trader: "A", ticker: "AAPL", side: "long", fees: 0, qty: 100, entry: 10, exit: 11,
  entryMin: null, exitMin: null, holdMin: null, r: null,
  gross: p.net ?? null, net: null,
  result: p.net == null ? null : p.net > 0 ? "win" : p.net < 0 ? "loss" : "be",
  ...p,
});

describe("sharpe / sortino", () => {
  it("mean / sample sd × √252", () => {
    const d = [100, -50, 200, 0, 50];
    const m = 60;
    const sd = Math.sqrt(((40 ** 2) + (110 ** 2) + (140 ** 2) + (60 ** 2) + (10 ** 2)) / 4);
    expect(stdev(d)).toBeCloseTo(sd, 9);
    expect(sharpeRatio(d)).toBeCloseTo((m / sd) * Math.sqrt(252), 9);
  });

  it("null below the minimum of days and with zero variance", () => {
    expect(sharpeRatio([10, 20, 30, 40])).toBeNull();
    expect(sharpeRatio([10, 10, 10, 10, 10])).toBeNull();
    expect(sharpeRatio([10, 20], 2)).not.toBeNull();
  });

  it("sortino uses downside deviation over all days; null without red days", () => {
    const d = [100, -50, 200, 0, 50];
    const dd = Math.sqrt((50 ** 2) / 5);
    expect(sortinoRatio(d)).toBeCloseTo((60 / dd) * Math.sqrt(252), 9);
    expect(sortinoRatio([1, 2, 3, 4, 5])).toBeNull();
  });
});

describe("profit factor", () => {
  it("Σ⁺ / |Σ⁻|", () => expect(profitFactor([30, -10, 20, -10])).toBe(2.5));
  it("null (never ∞) without losses, and for empty input", () => {
    expect(profitFactor([10, 20, 0])).toBeNull();
    expect(profitFactor([])).toBeNull();
  });
  it("0 when only losses", () => expect(profitFactor([-5, -5])).toBe(0));
  it("trader metrics expose PF null, not Infinity, on an all-green book", () => {
    const m = computeTraderMetrics("A", [tr({ day: "2026-10-01", net: 50 }), tr({ day: "2026-10-02", net: 30 })]);
    expect(m.profitFactor).toBeNull();
    expect(m.winRate).toBe(1);
    expect(JSON.stringify(m)).not.toContain("Infinity");
  });
});

describe("drawdown & recovery", () => {
  const pts = (xs: number[]) => xs.map((net, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, net }));

  it("peak → trough depth and trading days to recover", () => {
    // equity: 100, 50, 0, 80, 120 → peak 100 (d1), trough 0 (d3), back ≥ 100 on d5
    const dd = drawdownInfo(pts([100, -50, -50, 80, 40]));
    expect(dd.maxDd).toBe(100);
    expect(dd.peakDay).toBe("2026-10-01");
    expect(dd.troughDay).toBe("2026-10-03");
    expect(dd.recoveredDay).toBe("2026-10-05");
    expect(dd.recoveryDays).toBe(2);
    expect(dd.ddDays).toBe(2);
    expect(dd.currentDd).toBe(0);
  });

  it("not recovered → recoveryDays null and current depth reported", () => {
    const dd = drawdownInfo(pts([100, -150, 20]));
    expect(dd.maxDd).toBe(150);
    expect(dd.recoveryDays).toBeNull();
    expect(dd.currentDd).toBe(130);
  });

  it("drawdown from the start (equity never above 0)", () => {
    const dd = drawdownInfo(pts([-30, -20, 60]));
    expect(dd.maxDd).toBe(50);
    expect(dd.peakDay).toBeNull();
    expect(dd.recoveredDay).toBe("2026-10-03");
    expect(dd.recoveryDays).toBe(1);
  });

  it("monotonic equity has no drawdown", () => {
    expect(drawdownInfo(pts([10, 20, 30])).maxDd).toBe(0);
  });
});

describe("consistency (best day / total profit)", () => {
  it("share and flags at 30% / 40%", () => {
    expect(bestDayShare([100, 100, 100, 100])).toBe(0.25);
    expect(consistencyFlag(0.25)).toBe("ok");
    expect(bestDayShare([350, 100, 50, 500])).toBe(0.5);
    expect(consistencyFlag(0.5)).toBe("breach");
    expect(consistencyFlag(0.35)).toBe("warn");
    expect(consistencyFlag(0.3)).toBe("ok"); // strictly greater
  });
  it("null when the period is not profitable", () => {
    expect(bestDayShare([100, -200])).toBeNull();
    expect(bestDayShare([])).toBeNull();
    expect(consistencyFlag(null)).toBeNull();
  });
  it("a losing day lowers the total and raises the share", () => {
    expect(bestDayShare([300, -100, 100])).toBe(1);
  });
});

describe("streaks, hold parsing, percentiles", () => {
  it("streaks: BE breaks, current is signed", () => {
    expect(streaks(["win", "win", "loss", "loss", "loss", "be", "win"])).toEqual({ maxWin: 2, maxLoss: 3, current: 1 });
    expect(streaks(["loss", "loss"]).current).toBe(-2);
  });
  it.each<[unknown, number | null]>([
    ["5m", 5], ["2h 29m", 149], ["6h 1m", 361], ["1:05", 65], ["45s", 0.75], ["2часа", 120], ["3 мин", 3], ["", null], [null, null], ["—", null],
  ])("parseHoldMinutes(%s) = %s", (raw, want) => {
    const v = parseHoldMinutes(raw);
    if (want == null) expect(v).toBeNull();
    else expect(v).toBeCloseTo(want, 6);
  });
  it("percentile rank oriented by direction, mid-rank ties", () => {
    expect(percentileRank(3, [1, 2, 3])).toBe(1);
    expect(percentileRank(1, [1, 2, 3])).toBe(0);
    expect(percentileRank(1, [1, 2, 3], "lower")).toBe(1);
    expect(percentileRank(2, [2, 2, 2])).toBe(0.5);
    expect(percentileRank(5, [5])).toBe(0.5);
  });
});

describe("trader metrics on a synthetic book", () => {
  const book = [
    tr({ day: "2026-10-01", net: 100, gross: 110, fees: 10, entryMin: 572, holdMin: 5 }),
    tr({ day: "2026-10-01", net: -40, gross: -35, fees: 5, entryMin: 600, holdMin: 20 }),
    tr({ day: "2026-10-02", net: 60, gross: 65, fees: 5, entryMin: 700, holdMin: 10, r: 1.5 }),
    tr({ day: "2026-10-03", net: -80, gross: -75, fees: 5, entryMin: 575, holdMin: 30, r: -1 }),
    tr({ day: "2026-10-06", net: 0, gross: 5, fees: 5, result: "be" }),
  ];
  const m = computeTraderMetrics("A", book);
  it("counts, money and ratios", () => {
    expect(m.trades).toBe(5);
    expect(m.days).toBe(4);
    expect(m.tradesPerDay).toBe(1.25);
    expect(m.winRate).toBe(0.5);
    expect(m.net).toBe(40);
    expect(m.gross).toBe(70);
    expect(m.fees).toBe(30);
    expect(m.feeShare).toBeCloseTo(30 / 70, 4);
    expect(m.profitFactor).toBe(1.33);
    expect(m.expectancy).toBe(8);
    expect(m.avgWin).toBe(80);
    expect(m.avgLoss).toBe(-60);
    expect(m.payoff).toBe(1.33);
  });
  it("daily: green share, best day, drawdown", () => {
    // days: +60, +60, −80, 0
    expect(m.greenDays).toBe(2);
    expect(m.greenShare).toBe(0.5);
    expect(m.bestDayShare).toBe(1.5); // best 60 / total 40
    expect(m.consistencyFlag).toBe("breach");
    expect(m.maxDd).toBe(80);
    expect(m.ddRecovered).toBe(false);
  });
  it("first 15 minutes, hold, R coverage", () => {
    expect(m.first15Trades).toBe(2);
    expect(m.first15Share).toBe(0.5);
    expect(m.first15Net).toBe(20);
    expect(m.avgHoldMin).toBe(16.25);
    expect(m.rTrades).toBe(2); // only trades that carry an R
    expect(m.rCoverage).toBe(0.4);
    expect(m.totalR).toBe(0.5);
  });
});

describe("R-only book (manual trades without $)", () => {
  it("money is null, equity falls back to R", () => {
    const m = computeTraderMetrics("B", [tr({ trader: "B", day: "2026-04-09", r: 2, result: "win" }), tr({ trader: "B", day: "2026-04-10", r: -1, result: "loss" })]);
    expect(m.net).toBeNull();
    expect(m.profitFactor).toBeNull();
    expect(m.profitFactorR).toBe(2);
    expect(m.equityUnit).toBe("r");
    expect(m.equity.map((p) => p.cum)).toEqual([2, 1]);
  });
});

describe("desk median (anonymised), badges", () => {
  const rows = ["A", "B", "C"].map((t, i) => computeTraderMetrics(t, [tr({ trader: t, day: "2026-10-01", net: (i + 1) * 100 }), tr({ trader: t, day: "2026-10-02", net: -50 })]));
  it("median needs ≥ 3 traders per metric", () => {
    expect(deskMedian(rows).net).toBe(150);
    expect(deskMedian(rows.slice(0, 2)).net).toBeNull();
  });
  it("percentiles per metric and quartile badges", () => {
    const p = percentiles(rows);
    expect(p.C.net).toBe(1);
    expect(p.A.net).toBe(0);
    const b = badgesFor(rows[2], p.C, 3, 3, 1);
    expect(b.some((x) => x.kind === "strength" && x.key === "net")).toBe(true);
    expect(badgesFor(rows[2], p.C, 2, 3, 1).some((x) => x.key === "net")).toBe(false); // too few peers
    expect(badgesFor(rows[2], p.C, 3).some((x) => x.key === "net")).toBe(false); // 2 trades < 10: no desk-relative badge
  });
});

describe("trend and same-ticker", () => {
  it("4 weeks vs previous 4", () => {
    const ts = [
      tr({ day: "2026-09-01", net: -50 }), tr({ day: "2026-09-02", net: -30 }), tr({ day: "2026-09-03", net: 20 }),
      tr({ day: "2026-10-01", net: 80 }), tr({ day: "2026-10-02", net: 40 }), tr({ day: "2026-10-05", net: -10 }),
    ];
    const t = trendFor("A", ts, "2026-10-14", 4);
    expect(t.cur).toEqual({ from: "2026-09-17", to: "2026-10-14" });
    expect(t.prev).toEqual({ from: "2026-08-20", to: "2026-09-16" });
    expect(t.curM.net).toBe(110);
    expect(t.prevM.net).toBe(-60);
    expect(t.verdict).toBe("better");
    expect(t.weeks.reduce((s, w) => s + w.trades, 0)).toBe(6);
  });

  it("groups by ticker+day across traders, ranks by net, compares fills side-aware", () => {
    const cases = sameTickerCases([
      tr({ trader: "A", ticker: "INTC", day: "2026-04-09", side: "long", entry: 20, exit: 21, net: 100, entryMin: 580 }),
      tr({ trader: "B", ticker: "intc", day: "2026-04-09", side: "long", entry: 20.2, exit: 20.8, net: 60, entryMin: 600 }),
      tr({ trader: "A", ticker: "PLTR", day: "2026-04-09", net: 10 }),
      tr({ trader: "C", ticker: "INTC", day: "2026-04-10", net: 5 }),
    ]);
    expect(cases).toHaveLength(1);
    const c = cases[0];
    expect(c.ticker).toBe("INTC");
    expect(c.sameSide).toBe(true);
    expect(c.spread).toBe(40);
    expect(c.participants.map((p) => p.trader)).toEqual(["A", "B"]);
    expect(c.participants[0].entryGapPct).toBe(0);
    expect(c.participants[1].entryGapPct).toBeCloseTo(1, 6); // 20.2 vs 20 → 1% worse
    expect(c.participants[1].exitGapPct).toBeCloseTo((0.2 / 21) * 100, 3);
    expect(c.rankBy).toBe("net");
  });

  it("does not rank across units ($ vs R); falls back to % captured", () => {
    const [c] = sameTickerCases([
      tr({ trader: "A", ticker: "CRWV", day: "2026-04-09", side: "long", entry: 100, exit: 101, net: 6 }),
      tr({ trader: "B", ticker: "CRWV", day: "2026-04-09", side: "short", entry: 100, exit: 96, net: null, gross: null, r: 4, result: "win" }),
    ]);
    expect(c.rankBy).toBe("capture");
    expect(c.participants[0].trader).toBe("B"); // 4% captured beats 1%
    expect(c.participants[0].capturePct).toBe(4);
    const [d] = sameTickerCases([
      tr({ trader: "A", ticker: "X", day: "2026-04-09", side: null, net: 6 }),
      tr({ trader: "B", ticker: "X", day: "2026-04-09", side: null, net: null, gross: null, r: 4, result: "win" }),
    ]);
    expect(d.rankBy).toBeNull();
    expect(d.participants.every((p) => p.rank == null)).toBe(true);
  });
});
