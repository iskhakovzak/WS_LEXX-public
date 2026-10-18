import { describe, expect, it } from "vitest";
import type { TraderSignal } from "./api";
import { matchesQuery, profileHref, sortTraders, waitLabel, worstUsage } from "./curator-math";

function sig(trader: string, over: Partial<{ priority: number; daily: number | null; weekPnl: number | null; disc: number | null }> = {}): TraderSignal {
  return {
    trader,
    stage: { key: "junior", label: "Джун", since: null },
    tier: "junior", tierName: "Джуниор",
    risk: {
      status: "ok", state: "ok", label: "", message: "", halted: false, nearStop: false,
      dailyPct: over.daily ?? null, weeklyPct: null, drawdownPct: null, todayPnl: null, todayTrades: 0, weekPnl: over.weekPnl ?? null,
      openPositions: 0, hasLimits: true, templateDrift: [],
    },
    trend: [], trendDir: "none",
    discipline: { value: over.disc ?? null, eodAvg: null, ratingAvg: null, n: 0 },
    plan: { today: null, available: true },
    eod: { prevDay: "2026-10-15", prevTraded: false, prevClosed: false, todayTraded: false, todayClosed: false, pending: 0, lastClosed: null, lastReviewedAt: null, lastScore: null },
    weekly: { currentStatus: null, submittedPending: false, lastReviewedWeek: null, lastReviewedAt: null },
    academy: { openActions: 0, overdueActions: 0, lastOneOnOne: null, daysSinceOneOnOne: null, pendingSubmissions: 0, activeGoals: 0 },
    breaches: { unreviewed: 0, last30: 0, lastDate: null },
    lastNote: null, lastTradeDate: null,
    nextAction: { kind: "none", label: "", priority: over.priority ?? 0, href: "" },
  };
}

describe("curator-math", () => {
  it("wait labels", () => {
    expect(waitLabel(0.4)).toBe("<1 ч");
    expect(waitLabel(5)).toBe("5 ч");
    expect(waitLabel(28)).toBe("1 д 4 ч");
    expect(waitLabel(48)).toBe("2 д");
  });
  it("sorts by attention, then usage", () => {
    const list = [sig("Б", { priority: 20 }), sig("А", { priority: 100 }), sig("В", { priority: 20, daily: 90 })];
    expect(sortTraders(list, "attention").map((s) => s.trader)).toEqual(["А", "В", "Б"]);
    expect(sortTraders(list, "name").map((s) => s.trader)).toEqual(["А", "Б", "В"]);
  });
  it("discipline sort puts unknown last", () => {
    const list = [sig("А", { disc: null }), sig("Б", { disc: 8 }), sig("В", { disc: 4 })];
    expect(sortTraders(list, "discipline").map((s) => s.trader)).toEqual(["В", "Б", "А"]);
  });
  it("worst usage and query", () => {
    expect(worstUsage(sig("А", { daily: 75 }))).toBe(75);
    expect(worstUsage(sig("А"))).toBeNull();
    expect(matchesQuery(sig("Артур"), "арт")).toBe(true);
    expect(matchesQuery(sig("Артур"), "джун")).toBe(true);
    expect(matchesQuery(sig("Артур"), "сеньор")).toBe(false);
  });
  it("profile href", () => {
    expect(profileHref("Артур")).toBe(`/curator?trader=${encodeURIComponent("Артур")}`);
    expect(profileHref("Артур", "risk")).toBe(`/curator?trader=${encodeURIComponent("Артур")}&tab=risk`);
  });
});
