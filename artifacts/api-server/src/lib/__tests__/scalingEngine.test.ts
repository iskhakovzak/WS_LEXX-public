import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES, DEFAULT_TIERS, addDays, compare, computeWindowMetrics, evaluateTrader, isWeekend, maxDrawdownAbs, mondayOf,
  progressOf, resolveThreshold, sortTiers, windowStart, type Rule, type Tier, type TradeInput, type TraderInput,
} from "../scalingEngine";

const TODAY = "2026-10-14"; // Wednesday

const trade = (date: string, net: number | null, r: number | null, result: TradeInput["result"] = net != null ? (net > 0 ? "win" : net < 0 ? "loss" : "be") : r != null && r > 0 ? "win" : "loss", source: TradeInput["source"] = "manual"): TradeInput =>
  ({ date, net, r, result, source });

const input = (trades: TradeInput[], extra: Partial<TraderInput> = {}): TraderInput => ({
  trader: "t1", tierKey: "junior", limits: null, trades, ratings: [], violationDates: [], today: TODAY, ...extra,
});

describe("scalingEngine dates", () => {
  it.each<[string, number]>([["2026-10-14", 3], ["2026-10-17", 6], ["2026-10-18", 0]])("isWeekend/addDays sanity %s", (d) => {
    expect(addDays(d, 7)).toBe(addDays(addDays(d, 3), 4));
    expect(isWeekend(d)).toBe(["2026-10-17", "2026-10-18"].includes(d));
  });

  it.each<[string, string]>([
    ["2026-10-14", "2026-10-12"], // Wed → Mon
    ["2026-10-12", "2026-10-12"], // Mon
    ["2026-10-18", "2026-10-12"], // Sun → Monday of that ISO week
    ["2026-11-01", "2026-10-26"], // Sunday across month
  ])("mondayOf(%s) → %s", (d, e) => expect(mondayOf(d)).toBe(e));

  it.each<[string, number, string]>([
    ["2026-10-14", 1, "2026-10-14"],
    ["2026-10-14", 3, "2026-10-12"],
    ["2026-10-14", 4, "2026-10-09"], // across weekend
    ["2026-10-17", 1, "2026-10-16"], // Saturday today: Friday is day 1
    ["2026-10-19", 5, "2026-10-13"],
    ["2026-10-14", 20, "2026-09-17"],
  ])("windowStart(%s, %i) → %s", (d, n, e) => expect(windowStart(d, n)).toBe(e));
});

describe("scalingEngine.maxDrawdownAbs", () => {
  it.each<[number[], number]>([
    [[], 0], [[1, 2], 0], [[-3], 3], [[5, -2, -4, 10, -1], 6], [[-1, -1, 2, -5], 5],
  ])("%j → %d", (xs, e) => expect(maxDrawdownAbs(xs)).toBe(e));
});

describe("scalingEngine.computeWindowMetrics", () => {
  it("win rate excludes BE, PF null without losses, expectancy over R rows", () => {
    const m = computeWindowMetrics(input([
      trade("2026-10-12", 100, 2, "win"),
      trade("2026-10-12", 50, 1, "win"),
      trade("2026-10-13", 0, 0, "be"),
      trade("2026-10-13", null, null, "loss"), // no money, no R: still a loss for WR
    ]), null, 20).values;
    expect(m.trades.value).toBe(4);
    expect(m.win_rate.value).toBeCloseTo((2 / 3) * 100, 2);
    expect(m.net_r.value).toBe(3);
    expect(m.expectancy_r.value).toBe(1);
    expect(m.profit_factor.value).toBeNull();
    expect(m.profit_factor.note).toBe("нет убыточных сделок");
    expect(m.net_pnl.value).toBe(150);
    expect(m.net_pnl.note).toBe("по журналу");
  });

  it("PF uses $ when money exists, else R; max_dd / breaches null without money", () => {
    const usd = computeWindowMetrics(input([trade("2026-10-12", 300, 1), trade("2026-10-13", -100, -2)]), null, 20).values;
    expect(usd.profit_factor.value).toBe(3);
    expect(usd.profit_factor.basis).toBe("usd");
    const r = computeWindowMetrics(input([trade("2026-10-12", null, 1, "win"), trade("2026-10-13", null, -2, "loss")]), null, 20).values;
    expect(r.profit_factor.value).toBe(0.5);
    expect(r.profit_factor.basis).toBe("r");
    expect(r.max_dd_usd.value).toBeNull();
    expect(r.limit_breaches.value).toBeNull();
    expect(r.net_pnl.value).toBeNull();
  });

  it("broker rows win over journal rows for money when any exist", () => {
    const m = computeWindowMetrics(input([
      trade("2026-10-12", 1000, 1, "win", "manual"),
      trade("2026-10-12", 40, 1, "win", "propreports"),
      trade("2026-10-13", -10, -1, "loss", "propreports"),
    ]), null, 20);
    expect(m.moneySource).toBe("propreports");
    expect(m.values.net_pnl.value).toBe(30);
    expect(m.values.trades.value).toBe(3); // counts are over all rows
  });

  it("window filters by close date (trading days, weekends skipped) and ignores bad dates", () => {
    const m = computeWindowMetrics(input([
      trade("2026-10-09", 10, 1), // Fri — inside a 4-day window ending Wed
      trade("2026-10-08", 10, 1), // Thu — outside
      trade("bad", 10, 1),
      trade("2026-10-15", 10, 1), // tomorrow — outside
    ]), null, 4);
    expect(m.from).toBe("2026-10-09");
    expect(m.values.trades.value).toBe(1);
  });

  it("red streak / green days / drawdown / breaches by day", () => {
    const m = computeWindowMetrics(input([
      trade("2026-10-06", 200, 1),
      trade("2026-10-07", -350, -1), // breach (> 300)
      trade("2026-10-08", -300, -1), // exactly at the limit: not a breach (strict >)
      trade("2026-10-09", 50, 1),
      trade("2026-10-12", -20, -1),
      trade("2026-10-13", -10, -1),
      trade("2026-10-13", -10, -1),
    ], { limits: { accountSize: 25_000, dailyLossLimit: 300, weeklyLossLimit: 500, maxDrawdown: 1000 } }), null, 20).values;
    expect(m.red_streak.value).toBe(2);
    expect(m.green_days_pct.value).toBeCloseTo((2 / 6) * 100, 2);
    // day series: 200, −350, −300, 50, −20, −20 → cum 200, −150, −450, −400, −420, −440 → dd 650
    expect(m.max_dd_usd.value).toBe(650);
    expect(m.max_dd_pct.value).toBe(65);
    // weekly: week of 10-05 = 200−350−300+50 = −400 (< −500? no) ; week of 10-12 = −40 → 1 daily breach only
    expect(m.limit_breaches.value).toBe(1);
  });

  it("weekly breach counts separately; tier limits are the fallback", () => {
    const tier: Tier = { ...DEFAULT_TIERS[1], dailyLossLimit: 1000, weeklyLossLimit: 500 };
    const m = computeWindowMetrics(input([
      trade("2026-10-06", -200, -1),
      trade("2026-10-07", -200, -1),
      trade("2026-10-08", -200, -1), // week −600 < −500 → weekly breach, no daily breach
    ]), tier, 20).values;
    expect(m.limit_breaches.value).toBe(1);
  });

  it("no limits anywhere: breaches 0 with a note", () => {
    const m = computeWindowMetrics(input([trade("2026-10-06", -200, -1)]), null, 20).values;
    expect(m.limit_breaches.value).toBe(0);
    expect(m.limit_breaches.note).toBe("лимиты не заданы");
    expect(m.max_dd_pct.value).toBeNull();
  });

  it("green weeks: current partial week counts only when green and never breaks the streak", () => {
    const base = [
      trade("2026-10-05", 100, 1), // week −1 (Mon 10-05)
      trade("2026-09-28", 100, 1), // week −2
      trade("2026-09-21", -100, -1), // week −3: red → stops
      trade("2026-09-14", 100, 1), // week −4: not reached
    ];
    const greenNow = computeWindowMetrics(input([trade("2026-10-13", 10, 1), ...base]), null, 30).values;
    expect(greenNow.green_weeks.value).toBe(3);
    const redNow = computeWindowMetrics(input([trade("2026-10-13", -10, -1), ...base]), null, 30).values;
    expect(redNow.green_weeks.value).toBe(2);
    const noTradesNow = computeWindowMetrics(input(base), null, 30).values;
    expect(noTradesNow.green_weeks.value).toBe(2);
  });

  it("ratings and violations are counted inside the window only", () => {
    const m = computeWindowMetrics(input([trade("2026-10-13", 1, 1)], {
      ratings: [
        { week: "2026-10-12", discipline: 8, overall: 7 },
        { week: "2026-10-05", discipline: 6, overall: null },
        { week: "2026-01-05", discipline: 1, overall: 1 }, // outside
      ],
      violationDates: ["2026-10-13", "2026-10-01", "2026-01-01", "nope"],
    }), null, 10).values;
    expect(m.discipline.value).toBe(7);
    expect(m.rating_overall.value).toBe(7);
    expect(m.violations.value).toBe(2);
  });
});

describe("scalingEngine rules", () => {
  const limits = { accountSize: 25_000, dailyLossLimit: 300, weeklyLossLimit: 900, maxDrawdown: 2000 };
  it("resolveThreshold: abs / × daily limit / % of account, limits before tier", () => {
    expect(resolveThreshold({ value: 5, unit: "abs" }, null, null)).toBe(5);
    expect(resolveThreshold({ value: 5, unit: "x_daily_limit" }, limits, DEFAULT_TIERS[2])).toBe(1500);
    expect(resolveThreshold({ value: 5, unit: "x_daily_limit" }, null, DEFAULT_TIERS[2])).toBe(3000);
    expect(resolveThreshold({ value: 5, unit: "x_daily_limit" }, null, null)).toBeNull();
    expect(resolveThreshold({ value: 2, unit: "pct_account" }, limits, null)).toBe(500);
    expect(resolveThreshold({ value: 2, unit: "pct_account" }, { ...limits, accountSize: 0 }, null)).toBeNull();
  });

  it.each<[number, Rule["op"], number, boolean]>([
    [5, ">=", 5, true], [4.99, ">=", 5, false], [5, ">", 5, false], [5, "<=", 5, true], [5, "<", 5, false], [0, "=", 0, true], [0.1 + 0.2, "=", 0.3, true],
  ])("compare(%d %s %d) → %s", (a, op, b, e) => expect(compare(a, op, b)).toBe(e));

  it.each<[number, Rule["op"], number, number]>([
    [10, ">=", 40, 0.25], [40, ">=", 40, 1], [-5, ">=", 40, 0], [5, ">=", 0, 1], [-1, ">=", 0, 0],
    [100, "<=", 50, 0.5], [0, "<=", 50, 1], [-3, "<", 0, 1], [3, "<", 0, 0], [1, "=", 2, 0],
  ])("progressOf(%d %s %d) → %d", (a, op, b, e) => expect(progressOf(a, op, b)).toBeCloseTo(e, 9));
});

describe("scalingEngine.evaluateTrader", () => {
  const rules: Rule[] = DEFAULT_RULES.map((r, i) => ({ ...r, id: i + 1 }));
  const goodMonth = (): TradeInput[] => {
    const out: TradeInput[] = [];
    for (let i = 0; i < 20; i++) {
      const d = windowStart(TODAY, i + 1);
      out.push(trade(d, 120, 1.2, "win", "propreports"), trade(d, -40, -0.4, "loss", "propreports"), trade(d, 30, 0.3, "win", "propreports"));
    }
    return out;
  };

  it("unknown tier ⇒ assign to the first tier", () => {
    const e = evaluateTrader(input([], { tierKey: "nope" }), DEFAULT_TIERS, rules);
    expect(e.recommendation.action).toBe("assign");
    expect(e.recommendation.toTier?.key).toBe("trainee");
    expect(e.tier).toBeNull();
  });

  it("no rules ⇒ hold, progress null", () => {
    const e = evaluateTrader(input([]), DEFAULT_TIERS, []);
    expect(e.recommendation.action).toBe("hold");
    expect(e.progress).toBeNull();
    expect(e.windows.map((w) => w.windowDays)).toEqual([20]);
  });

  it("all promote rules pass ⇒ promote to the next tier", () => {
    const e = evaluateTrader(
      input(goodMonth(), { tierKey: "junior", ratings: [{ week: "2026-10-12", discipline: 9, overall: 8 }] }),
      DEFAULT_TIERS,
      rules,
    );
    expect(e.missing.map((m) => m.text)).toEqual([]);
    expect(e.recommendation.action).toBe("promote");
    expect(e.recommendation.toTier?.key).toBe("trader");
    expect(e.progress).toBe(1);
    expect(e.promoteTotal).toBe(7);
  });

  it("top tier with everything passing ⇒ hold with explanation", () => {
    const e = evaluateTrader(input(goodMonth(), { tierKey: "lead", limits: { accountSize: 25_000, dailyLossLimit: 300, weeklyLossLimit: 900, maxDrawdown: 2000 }, ratings: [{ week: "2026-10-12", discipline: 9, overall: 8 }] }), DEFAULT_TIERS, rules);
    expect(e.recommendation.action).toBe("hold");
    expect(e.nextTier).toBeNull();
    expect(e.recommendation.reasons[0]).toMatch(/верхний тир/);
  });

  it("demotion rule fires ⇒ demote to the previous tier, reasons carry the rule text", () => {
    const red: TradeInput[] = [];
    for (let i = 0; i < 6; i++) red.push(trade(windowStart(TODAY, i + 1), -100, -1, "loss", "propreports"));
    const e = evaluateTrader(input(red, { tierKey: "trader" }), DEFAULT_TIERS, rules);
    expect(e.recommendation.action).toBe("demote");
    expect(e.recommendation.toTier?.key).toBe("junior");
    expect(e.triggered.some((t) => t.metric === "red_streak")).toBe(true);
    expect(e.recommendation.warning).toBe(false);
  });

  it("demotion at the lowest tier ⇒ hold + warning", () => {
    const red: TradeInput[] = [];
    for (let i = 0; i < 6; i++) red.push(trade(windowStart(TODAY, i + 1), -100, -1, "loss", "propreports"));
    const e = evaluateTrader(input(red, { tierKey: "trainee" }), DEFAULT_TIERS, rules);
    expect(e.recommendation.action).toBe("hold");
    expect(e.recommendation.warning).toBe(true);
  });

  it("rules scoped to another tier or disabled are ignored; thresholds without limits are n/a", () => {
    const scoped: Rule[] = [
      { id: 1, kind: "promote", metric: "trades", op: ">=", value: 1, unit: "abs", windowDays: 5, tierKey: "senior", label: null, enabled: true },
      { id: 2, kind: "promote", metric: "trades", op: ">=", value: 1, unit: "abs", windowDays: 5, tierKey: null, label: null, enabled: false },
      { id: 3, kind: "promote", metric: "net_pnl", op: ">=", value: 2, unit: "x_daily_limit", windowDays: 5, tierKey: null, label: "x", enabled: true },
    ];
    const tiers: Tier[] = [{ ...DEFAULT_TIERS[0], dailyLossLimit: null }];
    const e = evaluateTrader(input([trade("2026-10-13", 10, 1)], { tierKey: "trainee" }), tiers, scoped);
    expect(e.rules.map((r) => r.ruleId)).toEqual([3]);
    expect(e.rules[0].status).toBe("na");
    expect(e.rules[0].text).toMatch(/нет дневного лимита/);
    expect(e.recommendation.action).toBe("hold");
  });

  it("sortTiers orders by `order` then key", () => {
    const t = sortTiers([{ ...DEFAULT_TIERS[0], key: "b", order: 2 }, { ...DEFAULT_TIERS[0], key: "a", order: 2 }, { ...DEFAULT_TIERS[0], key: "z", order: 1 }]);
    expect(t.map((x) => x.key)).toEqual(["z", "a", "b"]);
  });
});
