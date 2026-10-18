import { describe, expect, it } from "vitest";
import { DEFAULT_TIERS, addDays, isWeekend } from "../scalingEngine";
import {
  DEFAULT_CRITERIA, DEFAULT_STAGES, adviceFor, computePromoMetrics, consistencyPct, evaluatePromotion, feeSharePct, maxRun, nextStageOf,
  resolveWindow, tradingDaysBetween, type Criterion, type PromoTrade, type PromotionInput,
} from "../promotionEngine";

const TODAY = "2026-10-16"; // Friday

const tr = (date: string, net: number, fees = 1, source: PromoTrade["source"] = "propreports"): PromoTrade =>
  ({ date, net, gross: net + fees, fees, r: null, result: net > 0 ? "win" : net < 0 ? "loss" : "be", source });

const input = (trades: PromoTrade[], extra: Partial<PromotionInput> = {}): PromotionInput => ({
  user: "u", stage: "trainee", stageSince: null, today: TODAY, trades, violationDates: [], ratings: [], limits: null,
  disciplineDays: null, learning: null, challengesPassed: null, ...extra,
});

/** Last `n` weekdays ending TODAY, oldest first. */
function weekdays(n: number, end = TODAY): string[] {
  const out: string[] = [];
  for (let d = end; out.length < n; d = addDays(d, -1)) if (!isWeekend(d)) out.unshift(d);
  return out;
}

const crit = (metric: Criterion["metric"], op: Criterion["op"], value: number, windowDays: number | null = 20, id = 1): Criterion =>
  ({ id, fromStage: "trainee", metric, op, value, windowDays, label: null, enabled: true });

describe("ladder", () => {
  it("has exactly four stages mapped onto the scaling tiers", () => {
    expect(DEFAULT_STAGES.map((s) => s.key)).toEqual(["trainee", "junior", "trader", "senior"]);
    for (const s of DEFAULT_STAGES) expect(DEFAULT_TIERS.some((t) => t.key === s.scalingTier)).toBe(true);
    expect(nextStageOf(DEFAULT_STAGES, "junior")?.key).toBe("trader");
    expect(nextStageOf(DEFAULT_STAGES, "senior")).toBeNull();
    expect(new Set(DEFAULT_CRITERIA.map((c) => c.fromStage))).toEqual(new Set(["trainee", "junior", "trader"]));
  });
  it("window helpers", () => {
    expect(tradingDaysBetween("2026-10-12", TODAY)).toBe(5);
    expect(resolveWindow(20, null, TODAY)).toBe(20);
    expect(resolveWindow(null, "2026-10-12", TODAY)).toBe(5);
    expect(resolveWindow(null, null, TODAY)).toBe(260);
  });
});

describe("pure metric helpers", () => {
  it("consistency = best day / total profit; null without profit", () => {
    expect(consistencyPct([100, 50, 50])).toBe(50);
    expect(consistencyPct([300, -100])).toBe(150);
    expect(consistencyPct([-10, 5])).toBeNull();
  });
  it("fee share of gross; fees eating a non-positive gross ⇒ 100", () => {
    expect(feeSharePct(1000, 250)).toBe(25);
    expect(feeSharePct(-50, 20)).toBe(100);
    expect(feeSharePct(0, 0)).toBeNull();
  });
  it("maxRun", () => {
    expect(maxRun([-1, -2, 3, -1, -1, -1, 2], (v) => v < 0)).toBe(3);
  });
});

describe("computePromoMetrics", () => {
  it("PF is null (never ∞) when there are no losing trades", () => {
    const days = weekdays(5);
    const m = computePromoMetrics(input(days.map((d) => tr(d, 50))), null, 20);
    expect(m.profit_factor.value).toBeNull();
    expect(m.win_rate.value).toBe(100);
    expect(m.trading_days.value).toBe(5);
  });
  it("net, trading days, consistency, fee share, red streak from the scaling engine + academy extras", () => {
    const d = weekdays(6);
    const m = computePromoMetrics(input([tr(d[0], 200, 10), tr(d[1], -50, 10), tr(d[2], -50, 10), tr(d[3], 100, 10), tr(d[4], 100, 10), tr(d[5], 0, 10)]), null, 20);
    expect(m.net_pnl.value).toBe(300);
    expect(m.trading_days.value).toBe(6);
    expect(m.consistency.value).toBeCloseTo(66.67, 1);
    expect(m.fee_share.value).toBeCloseTo((60 / 360) * 100, 1);
    expect(m.red_streak_max.value).toBe(2);
    expect(m.profit_factor.value).toBe(4);
    expect(m.discipline_index.unavailable).toBe(true);
    expect(m.lessons_pct.unavailable).toBe(true);
  });
  it("uses broker rows when the trader has any (manual duplicates ignored for money)", () => {
    const d = weekdays(2);
    const m = computePromoMetrics(input([tr(d[0], 100), tr(d[0], 999, 0, "manual"), tr(d[1], 50)]), null, 20);
    expect(m.net_pnl.value).toBe(150);
  });
  it("learning, discipline and challenges when the sources exist", () => {
    const d = weekdays(3);
    const m = computePromoMetrics(input([tr(d[0], 10)], {
      stageSince: d[0],
      disciplineDays: [{ date: d[0], score: 80 }, { date: d[1], score: 60 }],
      learning: { lessonsTotal: 10, lessonsDone: 7, quizAvg: 82.5, quizzesTaken: 3 },
      challengesPassed: [addDays(d[0], -30), d[1]],
    }), null, 20);
    expect(m.discipline_index.value).toBe(70);
    expect(m.lessons_pct.value).toBe(70);
    expect(m.quiz_avg.value).toBe(82.5);
    expect(m.challenges_passed.value).toBe(1); // only since the stage started
  });
});

describe("evaluatePromotion", () => {
  const days = weekdays(16);
  const steady = days.map((d, i) => tr(d, i % 4 === 3 ? -20 : 40, 5));
  it("headline «Готов к переводу: X из Y», per-criterion status and advice", () => {
    const criteria = [
      crit("trading_days", ">=", 15, 20, 1),
      crit("net_pnl", ">=", 1000, 20, 2),
      crit("profit_factor", ">=", 1.2, 20, 3),
      crit("consistency", "<=", 40, 20, 4),
      crit("lessons_pct", ">=", 80, null, 5), // learning module absent ⇒ skipped, not counted
    ];
    const rep = evaluatePromotion(input(steady), criteria, DEFAULT_STAGES, DEFAULT_TIERS);
    expect(rep.nextStage?.key).toBe("junior");
    expect(rep.total).toBe(4);
    expect(rep.skipped.map((s) => s.metric)).toEqual(["lessons_pct"]);
    expect(rep.passed).toBe(3);
    expect(rep.ready).toBe(false);
    expect(rep.headline).toBe("Готов к переводу: 3 из 4 критериев");
    const net = rep.criteria.find((c) => c.metric === "net_pnl")!;
    expect(net.status).toBe("fail");
    expect(net.value).toBe(400); // 12×40 − 4×20
    expect(net.advice).toContain("$600");
    expect(net.progress).toBeCloseTo(0.4, 3);
  });
  it("ready when everything passes; top stage has no next step", () => {
    const rep = evaluatePromotion(input(steady), [crit("trading_days", ">=", 10)], DEFAULT_STAGES, DEFAULT_TIERS);
    expect(rep.ready).toBe(true);
    expect(rep.headline).toBe("Готов к переводу на «Джун»: 1 из 1 критериев");
    const top = evaluatePromotion(input(steady, { stage: "senior" }), [crit("trading_days", ">=", 10)], DEFAULT_STAGES, DEFAULT_TIERS);
    expect(top.nextStage).toBeNull();
    expect(top.ready).toBe(false);
  });
  it("missing data fails (not skipped); PF null ⇒ fail with an explanation", () => {
    const d = weekdays(3);
    const rep = evaluatePromotion(input(d.map((x) => tr(x, 10))), [crit("profit_factor", ">=", 1.2)], DEFAULT_STAGES);
    expect(rep.criteria[0].value).toBeNull();
    expect(rep.criteria[0].status).toBe("fail");
    expect(rep.criteria[0].advice).toContain("PF не определён");
  });
  it("trend compares with the previous equal window", () => {
    const prev = weekdays(20, addDays(weekdays(20)[0], -1)).map((d) => tr(d, -10));
    const cur = weekdays(20).map((d) => tr(d, 10));
    const rep = evaluatePromotion(input([...prev, ...cur]), [crit("net_pnl", ">=", 100)], DEFAULT_STAGES);
    expect(rep.criteria[0].prevValue).toBe(-200);
    expect(rep.criteria[0].trend).toBe("better");
  });
  it("max_dd_pct uses the stage's scaling tier limit when the trader has no own limits", () => {
    const d = weekdays(3);
    const rep = evaluatePromotion(input([tr(d[0], 100), tr(d[1], -400), tr(d[2], 10)]), [crit("max_dd_pct", "<=", 50)], DEFAULT_STAGES, DEFAULT_TIERS);
    // trainee tier maxDrawdown = 800 → 400 / 800 = 50%
    expect(rep.criteria[0].value).toBe(50);
    expect(rep.criteria[0].status).toBe("pass");
  });
});

describe("adviceFor", () => {
  it("consistency advice gives the extra profit needed outside the best day", () => {
    const a = adviceFor("consistency", "<=", 62.5, 40, { windowDays: 20, bestDay: 500, totalNet: 800 });
    expect(a).toContain("$450"); // 500 / 0.4 − 800
  });
  it("win rate advice gives the wins needed", () => {
    expect(adviceFor("win_rate", ">=", 40, 50, { windowDays: 20, wins: 4, losses: 6 })).toContain("≈ 2 прибыльных");
  });
});
