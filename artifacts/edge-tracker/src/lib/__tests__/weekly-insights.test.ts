import { describe, expect, it } from "vitest";
import {
  buildChecklist, buildDeskConclusions, buildPositives, buildTips, disciplineOf, feeShareOf, pfOf, tipCandidates,
  type BehaviorReport, type ChecklistInput, type FeeReport, type WeekKpi,
} from "@/lib/weeklyInsights";

const WEEK = "2026-10-05";

const behavior: BehaviorReport = {
  disciplineWeekly: [
    { week: "2026-09-21", avg: 70, days: 3 },
    { week: "2026-09-28", avg: 80, days: 4 },
    { week: WEEK, avg: 86.67, days: 3 },
  ],
  patterns: [
    { key: "martingale", title: "Мартингейл", n: 3, net: -255.29, cost: -224.51, baselineLabel: "остальные сделки", weekly: [{ week: WEEK, n: 3, net: -255.29, cost: -224.51 }] },
    { key: "fatigue", title: "Усталость", n: 2, net: -96.23, cost: -26.11, extra: { cut: 2 }, weekly: [{ week: WEEK, n: 2, net: -96.23, cost: -26.11 }] },
    { key: "revenge", title: "Реванш", n: 1, net: 8.34, cost: 53.33, weekly: [{ week: WEEK, n: 1, net: 8.34, cost: 53.33 }] },
    { key: "firstTrade", title: "Первая сделка", n: 3, net: -15.26, cost: 159.54, weekly: [{ week: WEEK, n: 3, net: -15.26, cost: 159.54 }] },
    { key: "tilt", title: "Тильт", n: 0, net: null, cost: null, weekly: [] },
    { key: "overtrading", title: "Овертрейдинг", n: 0, net: null, cost: null, weekly: [] },
  ],
};

const fees: FeeReport = {
  total: { key: "Всего", trades: 8, gross: -293.2, grossWins: 34, fees: 13.39, net: -306.59, feePctOfGrossWins: 0.39, breakEvenCents: 1.65 },
  byHold: [
    { key: "< 30 с", trades: 1, gross: 10, fees: 1.66, net: 8.34 },
    { key: "30 с – 2 мин", trades: 3, gross: -214.9, fees: 3.75, net: -218.65 },
    { key: "2–10 мин", trades: 3, gross: -112.3, fees: 7.03, net: -119.33 },
  ],
  byHour: [{ key: "15:30–16:00", trades: 8, gross: -293.2, fees: 13.39, net: -306.59, feePctOfGrossWins: 0.39 }],
  breakEvenCents: 1.7,
  recommendations: ["Минимальный целевой ход — 5 ¢."],
};

const kpi = (over: Partial<WeekKpi> = {}): WeekKpi => ({
  trades: 8, wins: 2, losses: 6, winRate: 0.25, netPnl: -306.59, grossPnl: -293.2, fees: 13.39,
  profitFactorUsd: 0.09, profitFactorR: null, totalR: 0, rCount: 0, unit: "usd",
  tradingDays: 3, greenDays: 0, redDays: 3, bestDay: { date: "2026-10-08", value: -0.6 }, worstDay: { date: "2026-10-05", value: -209.71 },
  ...over,
});

describe("weeklyInsights · derived KPIs", () => {
  it("fee share is null when gross ≤ 0", () => {
    expect(feeShareOf({ fees: 13.39, grossPnl: -293.2 })).toBeNull();
    expect(feeShareOf({ fees: 10, grossPnl: 40 })).toBeCloseTo(0.25);
  });
  it("PF follows the unit and never invents ∞", () => {
    expect(pfOf(kpi())).toBe(0.09);
    expect(pfOf(kpi({ unit: "r", profitFactorR: null }))).toBeNull();
  });
  it("discipline compares the week with the earlier weeks", () => {
    const d = disciplineOf(behavior, WEEK);
    expect(d.current).toBe(86.67);
    expect(d.prevAvg).toBe(75);
    expect(d.prevWeeks).toBe(2);
  });
});

describe("weeklyInsights · tips", () => {
  const input = {
    trader: "Ориф", weekStart: WEEK, weekEnd: "2026-10-09", kpi: kpi(), behavior, fees,
    dayReports: [{
      date: "2026-10-09",
      leaks: [
        { kind: "revenge", title: "Вход < 2 мин после убытка", count: 1, costUsd: 12.94 },
        { kind: "size_up", title: "Рост размера после убытка", count: 1, costUsd: 12.94 },
      ],
      plan: [{ id: "revenge", costUsd: 12.94, text: "Не открывать сделки 3 мин после убытка — сегодня это стоило −$12.94." }],
    }],
  };

  it("ranks by $ and keeps sources varied", () => {
    const tips = buildTips(input);
    expect(tips).toHaveLength(3);
    expect(tips[0].id).toBe("beh:martingale");
    expect(tips[0].amount).toBe(-224.51);
    expect(tips[1].id).toBe("hold:scalps");
    expect(tips[1].amount).toBeCloseTo(-210.31, 2);
    expect(tips[2].id).toBe("fees:total");
    expect(tips[2].title).toContain("15:30–16:00");
    expect(tips[2].title).toContain("39%");
  });

  it("skips the time window that simply holds every trade, and patterns that did not cost money", () => {
    const ids = tipCandidates(input).map((t) => t.id);
    expect(ids).not.toContain("time:15:30–16:00");
    expect(ids).not.toContain("beh:revenge");
    expect(ids).toContain("beh:firstTrade");
  });

  it("dedups day-report leaks already covered by behavior and cleans the plan text", () => {
    const all = tipCandidates(input);
    expect(all.find((t) => t.id === "day:size_up")).toBeUndefined();
    const rev = all.find((t) => t.id === "day:revenge");
    expect(rev?.amount).toBe(-12.94);
    expect(rev?.action).toBe("Не открывать сделки 3 мин после убытка.");
  });

  it("works with every engine missing", () => {
    expect(buildTips({ trader: "X", weekStart: WEEK, weekEnd: "2026-10-09" })).toEqual([]);
  });

  it("adds a simulator rule as a positive amount", () => {
    const tips = tipCandidates({ ...input, suggestions: [{ label: "Без сделок после 15:30", improvement: 400, ci: { lo: 120, hi: 650 }, excluded: 12 }] });
    expect(tips[0].id).toBe("sim:best");
    expect(tips[0].amount).toBe(400);
  });
});

describe("weeklyInsights · positives", () => {
  it("praises only what the data supports", () => {
    const p = buildPositives({ weekStart: WEEK, kpi: kpi(), avg4: kpi({ netPnl: -113.21, winRate: 0.4 }), avg4Weeks: 4, behavior, violations: 0, mistakes: 0, journalDays: 3, tradingDays: 3 });
    const ids = p.map((x) => x.id);
    expect(ids).not.toContain("net-vs-avg");
    expect(ids).not.toContain("best-day");
    expect(ids).toContain("clean");
    expect(ids).toContain("discipline");
    expect(p.length).toBeLessThanOrEqual(4);
  });
  it("returns nothing for an empty week", () => {
    expect(buildPositives({ weekStart: WEEK, kpi: kpi({ trades: 0 }) })).toEqual([]);
  });
});

describe("weeklyInsights · curator checklist", () => {
  const base: ChecklistInput = {
    trader: "Ориф", weekStart: WEEK, violations: [], violationCostUsd: null, mistakes: 0, mistakeCostUsd: null,
    risk: { hasLimits: false, breaches: 0, warns: 0, labels: [] }, daysWithoutReview: ["2026-10-08"], tradingDays: 3,
    behavior, feeShare: null, reviewStatus: "none", prevGoals: [],
  };
  it("flags behavior, missing reviews and limits", () => {
    const c = buildChecklist(base);
    const by = Object.fromEntries(c.map((x) => [x.id, x]));
    expect(by.rules.status).toBe("ok");
    expect(by.risk.status).toBe("na");
    expect(by.behavior.status).toBe("fail");
    expect(by.behavior.amount).toBe(-224.51);
    expect(by.journal.status).toBe("warn");
    expect(by.self.status).toBe("warn");
    expect(by.fees).toBeUndefined();
  });
  it("groups rule violations", () => {
    const c = buildChecklist({ ...base, violations: [{ ruleName: "Стоп", ruleKind: null, tradeNet: -10 }, { ruleName: "Стоп", ruleKind: null, tradeNet: -5 }], violationCostUsd: -15 });
    const rules = c.find((x) => x.id === "rules");
    expect(rules?.status).toBe("fail");
    expect(rules?.detail).toBe("Стоп ×2");
  });
});

describe("weeklyInsights · desk conclusions", () => {
  it("summarises the desk in 3–5 bullets", () => {
    const out = buildDeskConclusions(
      { traders: 3, active: 2, netPnl: 500, fees: 120, grossPnl: 620, reviewed: 1, submitted: 1 },
      [
        { trader: "A", trades: 40, netPnl: 900, fees: 70, riskStatus: "ok", verdict: "better" },
        { trader: "B", trades: 20, netPnl: -400, fees: 50, riskStatus: "breach", verdict: "worse" },
        { trader: "C", trades: 0, netPnl: null, fees: 0, riskStatus: "none" },
      ],
    );
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out[0]).toContain("+$500");
    expect(out.some((s) => s.includes("A"))).toBe(true);
    expect(out.some((s) => s.includes("B") && s.includes("нарушил лимиты"))).toBe(true);
  });
  it("handles an empty desk", () => {
    expect(buildDeskConclusions({ traders: 2, active: 0, netPnl: null, fees: 0, grossPnl: null, reviewed: 0, submitted: 0 }, [])).toHaveLength(1);
  });
});
