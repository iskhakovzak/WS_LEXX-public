import { describe, expect, it } from "vitest";
import {
  CAPITAL_EXAM_POLICY, RULES_VERSION, TEMPLATES, TEMPLATE_BY_KEY, TRAINEE_WINDOW, ddFloor, describeRules, endDateFor, evaluateChallenge, formatWindow,
  normalizeRules, weekdaysBetween, type ChallengeRules, type ChallengeTrade,
} from "../challengeEngine";
import { DEFAULT_TIERS } from "../scalingEngine";

const BASE: ChallengeRules = {
  accountSize: 10_000, profitTarget: null, dailyLossLimit: null, maxDrawdown: null, drawdownMode: "trailing", trailingStopsAtStart: false,
  consistencyPct: null, minTradingDays: null, maxPositionQty: null, maxPositionUsd: null, tradingWindow: null, tradingWindowStrict: true, rulesVersion: RULES_VERSION,
};
const rules = (r: Partial<ChallengeRules>): ChallengeRules => ({ ...BASE, ...r });
let seq = 1;
const t = (date: string, net: number | null, exitMin = 600, extra: Partial<ChallengeTrade> = {}): ChallengeTrade =>
  ({ id: seq++, ticker: "TST", date, net, qty: 100, entry: 10, entryMin: exitMin - 5, exitMin, ...extra });

// 2026-10-05 is a Monday.
const MON = "2026-10-05", TUE = "2026-10-06", WED = "2026-10-07", THU = "2026-10-08", FRI = "2026-10-09";

describe("calendar helpers", () => {
  it("endDateFor counts weekdays and rolls a weekend start forward", () => {
    expect(endDateFor(MON, 5)).toBe(FRI);
    expect(endDateFor(MON, 10)).toBe("2026-10-16");
    expect(endDateFor("2026-10-03", 1)).toBe(MON); // Saturday → Monday
    expect(weekdaysBetween("2026-10-01", "2026-10-30")).toBe(22);
  });
  it("ddFloor: static, trailing, trailing capped at the start", () => {
    expect(ddFloor(rules({ maxDrawdown: 500, drawdownMode: "static" }), 12_000)).toBe(9_500);
    expect(ddFloor(rules({ maxDrawdown: 500 }), 10_400)).toBe(9_900);
    expect(ddFloor(rules({ maxDrawdown: 500, trailingStopsAtStart: true }), 10_800)).toBe(10_000);
    expect(ddFloor(rules({}), 10_000)).toBeNull();
  });
});

describe("max drawdown", () => {
  const trades = [t(MON, 400), t(TUE, -300), t(WED, -250, 690)];
  it("trailing floor follows the high-water mark and fails on the exact day/time", () => {
    const r = evaluateChallenge({ startsOn: MON, endsOn: FRI, rules: rules({ maxDrawdown: 500 }) }, trades, FRI);
    expect(r.status).toBe("failed");
    expect(r.failure?.rule).toBe("max_drawdown");
    expect(r.failure?.date).toBe(WED);
    expect(r.failure?.time).toBe("11:30");
    const wed = r.timeline.find((d) => d.date === WED)!;
    expect(wed.events.some((e) => e.kind === "max_dd")).toBe(true);
    expect(r.timeline.at(-1)!.date).toBe(WED); // evaluation stops at the failure
  });
  it("the same trades pass a static drawdown of the same size", () => {
    const r = evaluateChallenge({ startsOn: MON, endsOn: "2026-10-16", rules: rules({ maxDrawdown: 500, drawdownMode: "static" }) }, trades, FRI);
    expect(r.status).toBe("active");
    expect(r.stats.maxDdUsed).toBe(150);
  });
  it("trailing locked at the starting balance", () => {
    const r = evaluateChallenge({ startsOn: MON, endsOn: FRI, rules: rules({ maxDrawdown: 500, trailingStopsAtStart: true }) }, [t(MON, 800), t(TUE, -801)], FRI);
    expect(r.status).toBe("failed");
    expect(r.failure?.detail).toContain("$10");
  });
  it("trailing_eod ignores the intraday peak", () => {
    // Intraday +400 then −350 the same day: trade-level trailing peak 10 400 → floor 9 900, balance 10 050 ok;
    // next day −200 → 9 850 fails trade-level trailing but not EOD trailing (EOD peak 10 050 → floor 9 550).
    const tr = [t(MON, 400, 600), t(MON, -350, 620), t(TUE, -200)];
    expect(evaluateChallenge({ startsOn: MON, endsOn: FRI, rules: rules({ maxDrawdown: 500 }) }, tr, FRI).status).toBe("failed");
    expect(evaluateChallenge({ startsOn: MON, endsOn: "2026-10-16", rules: rules({ maxDrawdown: 500, drawdownMode: "trailing_eod" }) }, tr, FRI).status).toBe("active");
  });
});

describe("daily loss", () => {
  it("fails at the trade that pushes the running day loss to the limit", () => {
    const tr = [t(MON, 50), t(TUE, -100, 600), t(TUE, 20, 630), t(TUE, -80, 660), t(TUE, 500, 700)];
    const r = evaluateChallenge({ startsOn: MON, endsOn: FRI, rules: rules({ dailyLossLimit: 150 }) }, tr, FRI);
    expect(r.status).toBe("failed");
    expect(r.failure).toMatchObject({ rule: "daily_loss", date: TUE, time: "11:00" });
    expect(r.reason).toContain("2026-10-06");
  });
  it("warns at 80% without failing; the day's low is reported", () => {
    const r = evaluateChallenge({ startsOn: MON, endsOn: "2026-10-16", rules: rules({ dailyLossLimit: 150 }) }, [t(MON, -125, 600), t(MON, 100, 700)], FRI);
    expect(r.status).toBe("active");
    const day = r.timeline[0];
    expect(day.events.map((e) => e.kind)).toContain("warn_daily");
    expect(day.dayLow).toBe(-125);
    expect(r.progress.find((p) => p.key === "daily_loss")!.state).toBe("warn");
  });
});

describe("consistency + target + min days", () => {
  const R = rules({ profitTarget: 300, minTradingDays: 2, consistencyPct: 40 });
  it("target reached but one big day dominates → not passed yet", () => {
    const r = evaluateChallenge({ startsOn: MON, endsOn: "2026-10-16", rules: R }, [t(MON, 400), t(TUE, 50)], TUE);
    expect(r.status).toBe("active");
    expect(r.stats.consistencyPct).toBeCloseTo(88.89, 1);
    const cons = r.progress.find((p) => p.key === "consistency")!;
    expect(cons.state).toBe("warn");
    expect(cons.detail).toContain("$550"); // 400 / 0.4 − 450
  });
  it("passes on the first day when every requirement holds", () => {
    const tr = [t(MON, 400), t(TUE, 50), t(WED, 200), t(THU, 200), t(FRI, 200), t("2026-10-12", 200)];
    const r = evaluateChallenge({ startsOn: MON, endsOn: "2026-10-16", rules: R }, tr, "2026-10-16");
    // after FRI: total 1050, best 400 → 38.1% ≤ 40
    expect(r.status).toBe("passed");
    expect(r.passedOn).toBe(FRI);
  });
  it("no profit ⇒ consistency is not satisfied", () => {
    const r = evaluateChallenge({ startsOn: MON, endsOn: TUE, rules: rules({ consistencyPct: 40, minTradingDays: 1 }) }, [t(MON, -10)], "2026-10-20");
    expect(r.status).toBe("expired");
    expect(r.reason).toContain("нет прибыли");
  });
});

describe("statuses and hard rules", () => {
  it("expired when the end passes without the target", () => {
    const r = evaluateChallenge({ startsOn: MON, endsOn: FRI, rules: rules({ profitTarget: 1000, minTradingDays: 3 }) }, [t(MON, 100), t(TUE, 100)], "2026-10-12");
    expect(r.status).toBe("expired");
    expect(r.reason).toMatch(/цель \$1.?000 не достигнута/);
    expect(r.reason).toContain("торговых дней 2 из 3");
  });
  it("scheduled before the start", () => {
    const r = evaluateChallenge({ startsOn: FRI, endsOn: "2026-10-16", rules: rules({ profitTarget: 100 }) }, [], MON);
    expect(r.status).toBe("scheduled");
    expect(r.tradingDaysLeft).toBe(6);
  });
  it("entry outside the trading window fails with the entry time", () => {
    const r = evaluateChallenge({ startsOn: MON, endsOn: FRI, rules: rules({ tradingWindow: { start: 570, end: 955 } }) }, [t(MON, 10, 600), t(TUE, 10, 565, { entryMin: 555 })], FRI);
    expect(r.failure).toMatchObject({ rule: "trading_window", date: TUE, time: "09:15" });
  });
  it("a non-strict window counts the entry as a violation without failing", () => {
    const r = evaluateChallenge({ startsOn: MON, endsOn: "2026-10-16", rules: rules({ tradingWindow: { start: 570, end: 959 }, tradingWindowStrict: false }) }, [t(MON, 10, 600), t(TUE, 10, 965, { entryMin: 961 })], FRI);
    expect(r.status).toBe("active");
    expect(r.stats.net).toBe(20);
    expect(r.progress.find((p) => p.key === "trading_window")!.state).toBe("warn");
    expect(r.timeline.find((d) => d.date === TUE)!.events.map((e) => e.kind)).toContain("warn_window");
  });
  it("the window end is exclusive: end 960 admits a 15:59:xx entry, rejects 16:00", () => {
    const W = rules({ tradingWindow: { start: 240, end: 960 } });
    expect(evaluateChallenge({ startsOn: MON, endsOn: "2026-10-16", rules: W }, [t(MON, 10, 965, { entryMin: 959.6 })], FRI).status).toBe("active");
    const late = evaluateChallenge({ startsOn: MON, endsOn: "2026-10-16", rules: W }, [t(MON, 10, 965, { entryMin: 960.2 })], FRI);
    expect(late.failure).toMatchObject({ rule: "trading_window", time: "16:00" });
    expect(late.failure?.detail).toContain("04:00–15:59");
    // end 959 ⇒ the last allowed minute is 15:58; the 15:59:36 entry is reported at 15:59 (not rounded up to 16:00).
    const r959 = evaluateChallenge({ startsOn: MON, endsOn: "2026-10-16", rules: rules({ tradingWindow: { start: 570, end: 959 } }) }, [t(MON, 10, 965, { entryMin: 959.6 })], FRI);
    expect(r959.failure).toMatchObject({ rule: "trading_window", time: "15:59" });
    // the start is inclusive
    expect(evaluateChallenge({ startsOn: MON, endsOn: "2026-10-16", rules: W }, [t(MON, 10, 250, { entryMin: 240 })], FRI).status).toBe("active");
  });
  it("formatWindow shows an end-exclusive window inclusively", () => {
    expect(formatWindow({ start: 240, end: 960 })).toBe("04:00–15:59");
    expect(formatWindow({ start: 570, end: 956 })).toBe("09:30–15:55");
    expect(formatWindow({ start: 0, end: 1440 })).toBe("00:00–23:59");
  });
  it("position notional above the limit fails", () => {
    const r = evaluateChallenge({ startsOn: MON, endsOn: FRI, rules: rules({ maxPositionUsd: 5_000 }) }, [t(MON, 10, 600, { qty: 1000, entry: 6 })], FRI);
    expect(r.failure?.rule).toBe("max_position");
  });
  it("trades outside the period and without P&L are ignored / counted", () => {
    const r = evaluateChallenge({ startsOn: TUE, endsOn: FRI, rules: rules({}) }, [t(MON, 999), t(TUE, null), t(TUE, 5)], FRI);
    expect(r.stats.net).toBe(5);
    expect(r.stats.tradesWithoutPnl).toBe(1);
  });
});

describe("templates and normalizeRules", () => {
  it("every template normalises to itself", () => {
    for (const tpl of TEMPLATES) expect(normalizeRules(tpl.rules)).toEqual(tpl.rules);
  });
  it("rejects a missing account size and bad windows", () => {
    expect(normalizeRules({ profitTarget: 1 })).toBeNull();
    expect(normalizeRules({ accountSize: 1000, tradingWindow: { start: 900, end: 600 } })?.tradingWindow).toBeNull();
  });
  it("legacy rules (no rulesVersion, inclusive end) are shifted so stored challenges evaluate as before", () => {
    const legacy = normalizeRules({ accountSize: 25_000, tradingWindow: { start: 240, end: 959 }, tradingWindowStrict: false })!;
    expect(legacy.tradingWindow).toEqual({ start: 240, end: 960 });
    expect(legacy.rulesVersion).toBe(RULES_VERSION);
    expect(normalizeRules({ accountSize: 10_000, tradingWindow: { start: 570, end: 955 } })!.tradingWindow).toEqual({ start: 570, end: 956 });
    expect(normalizeRules({ accountSize: 10_000, tradingWindow: { start: 0, end: 1440 } })!.tradingWindow).toEqual({ start: 0, end: 1440 });
    // a 15:55:30 entry that passed the old strict 570–955 window still passes after normalisation
    const old = normalizeRules({ accountSize: 10_000, tradingWindow: { start: 570, end: 955 } })!;
    expect(evaluateChallenge({ startsOn: MON, endsOn: "2026-10-16", rules: old }, [t(MON, 10, 957, { entryMin: 955.5 })], FRI).status).toBe("active");
    // current-version rules are not shifted (idempotent)
    expect(normalizeRules({ accountSize: 1, tradingWindow: { start: 240, end: 960 }, rulesVersion: 2 })!.tradingWindow).toEqual({ start: 240, end: 960 });
  });
});

const sp = (x: string) => x.replace(/\s/g, " ");
const money = (x: number) => `$${x.toLocaleString("en-US").replace(/,/g, " ")}`;
const tierOf = (k: string) => DEFAULT_TIERS.find((x) => x.key === k)!;

describe("capital exam templates are built from the target tier", () => {
  const expected = [
    { key: "trainee_to_junior", from: "trainee", tier: "junior", name: "Перевод Стажёр → Джун (капитал $25k)", account: 25_000, target: 1_500, dd: 1_500, daily: 300, maxPos: 25_000, cons: 40, min: 10 },
    { key: "junior_to_trader", from: "junior", tier: "trader", name: "Перевод Джун → Трейдер (капитал $50k)", account: 50_000, target: 3_000, dd: 3_000, daily: 600, maxPos: 50_000, cons: 35, min: 15 },
    { key: "trader_to_senior", from: "trader", tier: "senior", name: "Перевод Трейдер → Сеньор (капитал $100k)", account: 100_000, target: 6_000, dd: 6_000, daily: 1_200, maxPos: 100_000, cons: 30, min: 15 },
  ];
  for (const e of expected) {
    it(`${e.key}: numbers match the ${e.tier} tier`, () => {
      const tpl = TEMPLATE_BY_KEY[e.key];
      expect(tpl).toBeDefined();
      const tier = tierOf(e.tier);
      expect(tpl).toMatchObject({ name: e.name, forStage: e.from, toStage: e.tier, scalingTier: e.tier, durationTradingDays: 20 });
      expect(tpl.rules).toEqual({
        accountSize: tier.accountSize, dailyLossLimit: tier.dailyLossLimit, maxPositionUsd: tier.maxPositionUsd, maxPositionQty: null,
        maxDrawdown: tier.maxDrawdown! * 0.75, profitTarget: tier.accountSize! * 0.06,
        drawdownMode: "trailing", trailingStopsAtStart: true, consistencyPct: e.cons, minTradingDays: e.min,
        tradingWindow: { start: 240, end: 960 }, tradingWindowStrict: false, rulesVersion: RULES_VERSION,
      });
      // the literal policy table
      expect(tpl.rules).toMatchObject({ accountSize: e.account, profitTarget: e.target, maxDrawdown: e.dd, dailyLossLimit: e.daily, maxPositionUsd: e.maxPos });
    });
    it(`${e.key}: description is generated from the rules and mentions the right numbers`, () => {
      const tpl = TEMPLATE_BY_KEY[e.key];
      expect(tpl.description.endsWith(describeRules(tpl.rules, 20))).toBe(true);
      const d = sp(tpl.description);
      expect(d).toContain(`счёт ${money(e.account)}`);
      expect(d).toContain(`цель +${money(e.target)} за 20 торг. дн.`);
      expect(d).toContain(`дневной лимит убытка ${money(e.daily)}`);
      expect(d).toContain(`трейлинг-просадка ${money(e.dd)}`);
      expect(d).toContain(`позиция ≤ ${money(e.maxPos)}`);
      expect(d).toContain(`лучший день ≤ ${e.cons}%`);
      expect(d).toContain(`мин. ${e.min} торговых дней`);
      expect(d).toContain("входы 04:00–15:59 NY");
      expect(d).not.toContain("16:00");
    });
  }
  it("policy constants", () => {
    expect(CAPITAL_EXAM_POLICY).toMatchObject({ profitTargetPct: 6, drawdownShare: 0.75, durationTradingDays: 20, tradingWindow: { start: 240, end: 960 }, tradingWindowStrict: false });
  });
  it("trainee tests take account, daily limit and position from the trainee tier and keep the strict 09:30–15:55 window", () => {
    const tier = tierOf("trainee");
    for (const key of ["trainee_test_10d", "sim_exam_20d"]) {
      const tpl = TEMPLATE_BY_KEY[key];
      expect(tpl.toStage).toBeNull();
      expect(tpl.rules).toMatchObject({ accountSize: tier.accountSize, dailyLossLimit: tier.dailyLossLimit, maxPositionUsd: tier.maxPositionUsd, tradingWindow: TRAINEE_WINDOW, tradingWindowStrict: true });
      const d = sp(tpl.description);
      expect(d).toContain("входы 09:30–15:55 NY (строго");
      expect(d).toContain(`дневной лимит убытка ${money(tier.dailyLossLimit!)}`);
      expect(d).toContain(`цель +${money(tpl.rules.profitTarget!)} за ${tpl.durationTradingDays} торг. дн.`);
      expect(d).toContain(`мин. ${tpl.rules.minTradingDays} торговых дней`);
    }
  });
  it("every template description ends with the generated rules text; keys are unique", () => {
    expect(new Set(TEMPLATES.map((x) => x.key)).size).toBe(TEMPLATES.length);
    for (const tpl of TEMPLATES) expect(tpl.description.endsWith(describeRules(tpl.rules, tpl.durationTradingDays))).toBe(true);
  });
});

describe("trader_to_senior evaluation", () => {
  const R = TEMPLATE_BY_KEY.trader_to_senior.rules;
  const DAYS = Array.from({ length: 20 }, (_, i) => endDateFor(MON, i + 1)); // 20 weekdays from MON
  const END = DAYS[19];
  it("passes on the 15th trading day with +$6 000 spread evenly (best day ≤ 30%)", () => {
    const tr = DAYS.slice(0, 15).map((d) => t(d, 400, 600, { qty: 1000, entry: 50 })); // $50k notional ≤ $100k
    const r = evaluateChallenge({ startsOn: MON, endsOn: END, rules: R }, tr, END);
    expect(r.status).toBe("passed");
    expect(r.passedOn).toBe(DAYS[14]);
    expect(r.stats.net).toBe(6_000);
  });
  it("target hit in 3 days is not a pass until min days hold", () => {
    const tr = [t(DAYS[0], 2_000), t(DAYS[1], 2_000), t(DAYS[2], 2_000)];
    const r = evaluateChallenge({ startsOn: MON, endsOn: END, rules: R }, tr, DAYS[2]);
    expect(r.status).toBe("active");
    expect(r.progress.find((p) => p.key === "profit_target")!.state).toBe("met");
    expect(r.progress.find((p) => p.key === "min_days")!.state).toBe("pending");
  });
  it("expires when 15 days are traded but one day dominates (> 30%)", () => {
    const tr = [t(DAYS[0], 3_000), ...DAYS.slice(1, 15).map((d) => t(d, 250))]; // total 6 500, best 46%
    const r = evaluateChallenge({ startsOn: MON, endsOn: END, rules: R }, tr, "2026-11-10");
    expect(r.status).toBe("expired");
    expect(r.reason).toContain("> 30%");
  });
  it("fails on the daily loss limit of $1 200", () => {
    const r = evaluateChallenge({ startsOn: MON, endsOn: END, rules: R }, [t(DAYS[0], -700, 600), t(DAYS[0], -500, 660)], END);
    expect(r.failure).toMatchObject({ rule: "daily_loss", date: DAYS[0], time: "11:00" });
  });
  it("fails when the trailing $6 000 drawdown is touched", () => {
    // +2 000 → peak 102 000, floor 96 000; −1 000 ×4 → 98 000; −1 100 ×2 → 95 800 ≤ 96 000 ⇒ fail on the 7th day
    const tr = [t(DAYS[0], 2_000), t(DAYS[1], -1_000), t(DAYS[2], -1_000), t(DAYS[3], -1_000), t(DAYS[4], -1_000), t(DAYS[5], -1_100), t(DAYS[6], -1_100)];
    const r = evaluateChallenge({ startsOn: MON, endsOn: END, rules: R }, tr, END);
    expect(r.failure).toMatchObject({ rule: "max_drawdown", date: DAYS[6] });
  });
  it("fails on a position above $100 000 notional", () => {
    const r = evaluateChallenge({ startsOn: MON, endsOn: END, rules: R }, [t(DAYS[0], 50, 600, { qty: 2_001, entry: 50 })], END);
    expect(r.failure?.rule).toBe("max_position");
  });
  it("a premarket entry is fine; an entry at 16:00+ is a counted violation that does not fail", () => {
    const tr = [t(DAYS[0], 100, 300, { entryMin: 245 }), t(DAYS[1], 100, 970, { entryMin: 961 })];
    const r = evaluateChallenge({ startsOn: MON, endsOn: END, rules: R }, tr, DAYS[1]);
    expect(r.status).toBe("active");
    const w = r.progress.find((p) => p.key === "trading_window")!;
    expect(w.state).toBe("warn");
    expect(w.value).toBe(1);
    expect(w.display).toContain("04:00–15:59 NY");
  });
});

describe("no profit target", () => {
  it("surviving to the last day without a hard violation passes", () => {
    const r = evaluateChallenge({ startsOn: MON, endsOn: FRI, rules: rules({ maxDrawdown: 500 }) }, [t(MON, -100)], FRI);
    expect(r.status).toBe("passed");
    expect(r.passedOn).toBe(FRI);
  });
});
