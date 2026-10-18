import { describe, expect, it } from "vitest";
import { canCloseDay, computeStreaks, missingFields, missingList, nextTradingDay, prevTradingDay, type ReviewableTrade } from "../eodLogic";

describe("eodLogic trading-day navigation (weekends only)", () => {
  it.each<[string, string]>([
    ["2026-10-16", "2026-10-19"], // Fri → Mon
    ["2026-10-17", "2026-10-19"], // Sat → Mon
    ["2026-10-18", "2026-10-19"], // Sun → Mon
    ["2026-10-19", "2026-10-20"],
    ["2026-12-31", "2027-01-01"], // Thu → Fri (holidays not modelled)
  ])("nextTradingDay(%s) → %s", (d, e) => expect(nextTradingDay(d)).toBe(e));

  it.each<[string, string]>([
    ["2026-10-19", "2026-10-16"], // Mon → Fri
    ["2026-10-18", "2026-10-16"],
    ["2026-10-17", "2026-10-16"],
    ["2026-10-20", "2026-10-19"],
    ["2026-01-01", "2025-12-31"],
  ])("prevTradingDay(%s) → %s", (d, e) => expect(prevTradingDay(d)).toBe(e));
});

describe("eodLogic.missingFields", () => {
  it.each<[string, { setup: string | null; confidenceGrade: string | null }, string[]]>([
    ["complete", { setup: "ORB", confidenceGrade: "A" }, []],
    ["A+ is valid", { setup: "ORB", confidenceGrade: "A+" }, []],
    ["setup null", { setup: null, confidenceGrade: "B" }, ["setup"]],
    ["setup whitespace", { setup: "   ", confidenceGrade: "C" }, ["setup"]],
    ["grade null", { setup: "ORB", confidenceGrade: null }, ["grade"]],
    ["grade not in list", { setup: "ORB", confidenceGrade: "A-" }, ["grade"]],
    ["grade lower-case is rejected", { setup: "ORB", confidenceGrade: "a" }, ["grade"]],
    ["both missing", { setup: "", confidenceGrade: "" }, ["setup", "grade"]],
  ])("%s", (_n, t, e) => expect(missingFields(t)).toEqual(e));

  it("missingList keeps only incomplete trades with ids and tickers", () => {
    const trades: ReviewableTrade[] = [
      { id: 1, ticker: "AAPL", setup: "ORB", confidenceGrade: "A" },
      { id: 2, ticker: "TSLA", setup: null, confidenceGrade: "A" },
      { id: 3, ticker: "NVDA", setup: "Gap", confidenceGrade: "Z" },
    ];
    expect(missingList(trades)).toEqual([
      { tradeId: 2, ticker: "TSLA", fields: ["setup"] },
      { tradeId: 3, ticker: "NVDA", fields: ["grade"] },
    ]);
  });
});

describe("eodLogic.canCloseDay", () => {
  const ok: ReviewableTrade = { id: 1, ticker: "A", setup: "x", confidenceGrade: "B" };
  it("future day is refused even with no trades", () => {
    const r = canCloseDay({ date: "2026-10-18", today: "2026-10-17", trades: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/будущий/);
  });
  it("today and the past are allowed when every trade is reviewed", () => {
    expect(canCloseDay({ date: "2026-10-17", today: "2026-10-17", trades: [ok] })).toEqual({ ok: true, missing: [], reason: null });
    expect(canCloseDay({ date: "2026-10-10", today: "2026-10-17", trades: [] }).ok).toBe(true);
  });
  it("unreviewed trades block the close and are listed", () => {
    const r = canCloseDay({ date: "2026-10-17", today: "2026-10-17", trades: [ok, { id: 2, ticker: "B", setup: "", confidenceGrade: null }] });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([{ tradeId: 2, ticker: "B", fields: ["setup", "grade"] }]);
  });
});

describe("eodLogic.computeStreaks", () => {
  const days = (xs: Array<[string, number, number]>) => new Map(xs.map(([d, n, reviewed]) => [d, { n, reviewed }]));

  it("closed streak counts consecutive weekdays ending today", () => {
    // today Wed 2026-10-14; closed Mon..Wed and the previous Fri → 4 (weekend skipped)
    const s = computeStreaks({ today: "2026-10-14", closedDates: new Set(["2026-10-14", "2026-10-13", "2026-10-12", "2026-10-09"]), tradeDays: new Map() });
    expect(s.closedStreak).toBe(4);
    expect(s.closedTotal).toBe(4);
    expect(s.lastClosed).toBe("2026-10-14");
  });

  it("today not yet closed: the streak starts from the previous trading day", () => {
    const s = computeStreaks({ today: "2026-10-14", closedDates: new Set(["2026-10-13", "2026-10-12"]), tradeDays: new Map() });
    expect(s.closedStreak).toBe(2);
  });

  it("a gap breaks the closed streak", () => {
    const s = computeStreaks({ today: "2026-10-14", closedDates: new Set(["2026-10-14", "2026-10-12"]), tradeDays: new Map() });
    expect(s.closedStreak).toBe(1);
  });

  it("weekend today: counting starts on Friday", () => {
    const s = computeStreaks({ today: "2026-10-17", closedDates: new Set(["2026-10-16", "2026-10-15"]), tradeDays: new Map() });
    expect(s.closedStreak).toBe(2);
  });

  it("empty input", () => {
    expect(computeStreaks({ today: "2026-10-14", closedDates: new Set(), tradeDays: new Map() })).toEqual({ closedStreak: 0, reviewedStreak: 0, closedTotal: 0, lastClosed: null });
  });

  it("reviewed streak: days without trades neither count nor break; a partially reviewed day breaks", () => {
    const s = computeStreaks({
      today: "2026-10-14",
      closedDates: new Set(),
      tradeDays: days([
        ["2026-10-14", 2, 2],
        // 10-13 no trades
        ["2026-10-12", 1, 1],
        ["2026-10-09", 3, 2], // breaks
        ["2026-10-08", 1, 1],
      ]),
    });
    expect(s.reviewedStreak).toBe(2);
  });

  it("reviewed streak stops after 60 empty trading days", () => {
    const s = computeStreaks({
      today: "2026-10-14",
      closedDates: new Set(),
      tradeDays: days([["2026-06-01", 1, 1]]), // > 60 trading days before today
    });
    expect(s.reviewedStreak).toBe(0);
  });
});
