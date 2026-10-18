import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "@/i18n";
import { PICKABLE_MISTAKES, mistakeLabel, mistakeRule, parseMistake } from "@/components/shared/mistake-labels";
import { contractLine, contractOverall, dayView, fmtDelta, fmtMetric, fmtTarget, planContract, tierTitle } from "../daily-model";
import { contractBroken, eveningBroken, focusAuto, focusNone, me, progress } from "./fixtures";

afterEach(async () => {
  await setLang("ru", { source: "init" });
});

describe("dayView — one focal point per phase", () => {
  it("premarket: the focus leads; an unreviewed yesterday is offered as a compact row", () => {
    const v = dayView(me())!;
    expect(v.primary).toBe("focus");
    expect(v.pendingEvening).toBe(true);
    expect(v.evening?.date).toBe("2026-10-16");
  });

  it("premarket after the review: no pending row", () => {
    const v = dayView(me({ evening: { ...eveningBroken, reviewed: true } }))!;
    expect(v.primary).toBe("focus");
    expect(v.pendingEvening).toBe(false);
  });

  it("after the close and on weekends the evening card leads", () => {
    expect(dayView(me({ phase: "afterclose" }))!.primary).toBe("evening");
    expect(dayView(me({ phase: "weekend" }))!.primary).toBe("evening");
  });

  it("a day without trades has no evening card", () => {
    const v = dayView(me({ phase: "afterclose", evening: { ...eveningBroken, trades: 0 } }))!;
    expect(v.primary).toBe("focus");
    expect(v.evening).toBeNull();
    expect(v.pendingEvening).toBe(false);
  });

  it("nothing to show → null", () => {
    expect(dayView(null)).toBeNull();
    expect(dayView(me({ focus: null, evening: null }))).toBeNull();
  });
});

describe("contract line — prefill law", () => {
  it("a rule never chosen is prefilled with the focus", () => {
    const l = contractLine({ maxLossUsd: 300, maxTrades: 10, ownRule: undefined }, focusAuto);
    expect(l).toMatchObject({ maxLossUsd: 300, maxTrades: 10, rule: "structure:averaging", ruleFromFocus: true, empty: false });
  });

  it("an explicit «no rule» is respected; no plan + no focus = empty", () => {
    expect(contractLine({ maxLossUsd: null, maxTrades: null, ownRule: null }, focusAuto)).toMatchObject({ rule: null, empty: true });
    expect(contractLine(null, focusNone)).toMatchObject({ rule: null, empty: true, ruleFromFocus: false });
  });

  it("no plan yet still shows the focus as the suggested rule", () => {
    expect(contractLine(null, focusAuto)).toMatchObject({ rule: "structure:averaging", ruleFromFocus: true, empty: false });
  });

  it("reads the plan doc defensively", () => {
    expect(planContract({ plan: { doc: { maxLossUsd: 250, maxTrades: "x", ownRule: "behavior:revenge" } } })).toEqual({
      maxLossUsd: 250,
      maxTrades: null,
      ownRule: "behavior:revenge",
    });
    expect(planContract({ plan: { doc: { ownRule: null } } })?.ownRule).toBeNull();
    expect(planContract({ plan: { doc: {} } })?.ownRule).toBeUndefined();
    expect(planContract({ plan: null })).toBeNull();
  });
});

describe("verdicts and numbers", () => {
  it("one word for the whole contract", () => {
    expect(contractOverall(contractBroken)).toBe("broken");
    expect(contractOverall({ ...contractBroken, maxTrades: { ...contractBroken.maxTrades, status: "kept" }, rule: { mistake: null, status: "unset" } })).toBe("kept");
    expect(contractOverall({ ...contractBroken, maxLoss: { limit: null, actual: null, status: "unset" }, maxTrades: { limit: null, actual: 0, status: "unset" }, rule: { mistake: null, status: "unset" } })).toBe("unset");
    expect(contractOverall(null)).toBe("unset");
  });

  it("discipline delta keeps a real minus", () => {
    expect(fmtDelta(3)).toBe("+3");
    expect(fmtDelta(-2)).toBe("−2");
    expect(fmtDelta(0)).toBe("0");
  });

  it("criteria values follow the metric unit", () => {
    expect(fmtMetric("net_pnl", 1500)).toBe("$1,500");
    expect(fmtMetric("profit_factor", 1.3)).toBe("1.30");
    expect(fmtMetric("max_dd_pct", 42.4)).toBe("42%");
    expect(fmtMetric("trades", 40)).toBe("40");
    expect(fmtMetric("trades", null)).toBe("—");
    expect(fmtTarget("trades", 40)).toBe("≥ 40");
    expect(fmtTarget("limit_breaches", 0)).toBe("≤ 0");
  });
});

describe("tier title in three languages", () => {
  it("«До Джуна: 3 из 5» / «To Junior: 3 of 5» / Uzbek", async () => {
    expect(tierTitle(progress)).toBe("До Джуна: 3 из 5");
    await setLang("en", { source: "init" });
    expect(tierTitle(progress)).toBe("To Junior: 3 of 5");
    await setLang("uz", { source: "init" });
    expect(tierTitle(progress)).toBe("Junior darajasigacha: 5 tadan 3");
  });

  it("top tier and custom tiers", async () => {
    await setLang("en", { source: "init" });
    expect(tierTitle({ ...progress, tier: "senior", nextTier: null })).toBe("“Senior” is the top level");
    expect(tierTitle({ ...progress, nextTier: "Pro" })).toBe("To “Pro”: 3 of 5");
    expect(tierTitle({ ...progress, tier: null, nextTier: null })).toBeNull();
  });
});

describe("mistake dictionary covers every MistakeId", () => {
  const ruleKinds = ["max_trades_per_day", "no_averaging_down", "trading_window", "self_check"];
  for (const lang of ["ru", "en", "uz"] as const) {
    it(`${lang}: every pickable mistake and rule kind has a label and a rule phrase`, async () => {
      await setLang(lang, { source: "init" });
      for (const { id } of PICKABLE_MISTAKES) {
        expect(mistakeLabel(id)).not.toMatch(/mistake\.|:/);
        expect(mistakeRule(id)).not.toMatch(/avoid\.|:/);
      }
      for (const k of ruleKinds) expect(mistakeLabel(`rule:${k}`)).not.toContain(k);
    });
  }

  it("unknown ids stay readable, groups parse", () => {
    expect(mistakeLabel("rule:brand_new_kind")).toContain("brand_new_kind");
    expect(mistakeLabel("weird")).toContain("weird");
    expect(parseMistake("behavior:revenge")).toEqual({ group: "behavior", key: "revenge" });
    expect(PICKABLE_MISTAKES).toHaveLength(14);
  });
});
