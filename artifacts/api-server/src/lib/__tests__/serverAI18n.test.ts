/**
 * Translation wave (server-a): rules, behaviour, setups, permissions and academy texts render per language,
 * stored data (violation reasons, notification params) re-renders in the reader's language, RU stays as before.
 */
import { describe, expect, it } from "vitest";
import { catalogFor, describeThreshold, validateThreshold } from "../rulesCatalog";
import { evalRule, type TradeForRule } from "../rulesEval";
import { violationMessage } from "../rulesI18n";
import { renderNotification } from "../notificationText";
import { analyzeBehavior, type BehaviorTrade } from "../behaviorEngine";
import { describeTrigger } from "../behaviorTriggers";
import { localizedCapabilityDefs } from "../permissionsI18n";
import { CAPABILITY_DEFS } from "../permissionsMatrix";
import { classifyFromFeatures, computeFeatures, setupLabelOf } from "../setupClassifier";
import { evaluateChallenge, renderChallengeReason, TEMPLATE_BY_KEY } from "../challengeEngine";
import { describeGoal, lagReasons, summarizeAttendance } from "../academyCohorts";
import { buildInsights } from "../weeklyPsychologyReport";

const trade = (id: number, over: Partial<TradeForRule> = {}): TradeForRule => ({
  id, trader: "t", date: "2026-10-01", closeDate: "2026-10-01", result: "loss", pnl: -50, netPnl: -50, signedR: -1, entry: 10, stop: null,
  qty: 100, riskUsd: null, horizon: "intraday", source: "propreports", playbookId: null, setupScore: null, maxNotional: null, checklistRuns: 0, ...over,
});

describe("rules", () => {
  it("catalog, summaries and threshold errors per language", () => {
    expect(catalogFor("en").find((k) => k.kind === "max_trades_per_day")?.label).toBe("Max trades per day");
    expect(catalogFor("uz").find((k) => k.kind === "min_pause_after_loss")?.fields[0].unit).toBe("daq");
    expect(describeThreshold("max_trades_per_day", { n: 3 })).toBe("≤ 3 сделок в день");
    expect(describeThreshold("max_trades_per_day", { n: 3 }, undefined, "en")).toBe("≤ 3 trades a day");
    const bad = validateThreshold("banned_tickers", { tickers: [] }, "en");
    expect(bad).toEqual({ ok: false, code: "RULE_TICKERS_REQUIRED", params: { field: "Tickers" } });
  });

  it("violation reason is stored as data and re-rendered per reader", () => {
    const rule = { id: 1, trader: "t", name: "r", kind: "no_trade_after_n_losses", threshold: { n: 2 }, enabled: true };
    const v = evalRule(rule, [trade(1), trade(2), trade(3)]);
    expect(v[0].message).toBe("Сделка после 2 убытков подряд за день 2026-10-01");
    expect(violationMessage(v[0].message, { msg: v[0].msg }, "en")).toBe("Trade after 2 losses in a row on 2026-10-01");
    expect(violationMessage("old text", {}, "en")).toBe("old text");
  });

  it("rule_violation notification renders per reader", () => {
    const r = renderNotification("rule_violation", { variant: "one", rule: "Стоп", trader: "t", vkey: "consecutive", v_streak: 4, v_n: 3, message: "x" }, "en");
    expect(r?.title).toBe("Rule broken: “Стоп”");
    expect(r?.body).toBe("4 losses in a row (limit 3)");
  });
});

describe("behaviour / psychology", () => {
  const bt = (id: number, min: number, net: number): BehaviorTrade => ({
    id, ticker: "AAA", date: "2026-10-01", side: "long", result: net > 0 ? "win" : "loss", net, gross: net, qty: 100, entry: 10,
    entryAt: Date.UTC(2026, 9, 1, 13, 30 + min), exitAt: Date.UTC(2026, 9, 1, 13, 31 + min), entryMin: 570 + min, holdMin: 1, horizon: "intraday", setup: null,
  });
  it("pattern titles and triggers per language", () => {
    const rep = analyzeBehavior([bt(1, 0, -50), bt(2, 3, -20), bt(3, 30, 40)], {}, "en");
    expect(rep.patterns.find((p) => p.key === "revenge")?.title).toBe("Revenge trading");
    expect(rep.patterns.find((p) => p.key === "revenge")?.baselineLabel).toBe("other trades");
    expect(describeTrigger("loss_streak", { n: 3 })).toBe("3 убытка подряд");
    expect(describeTrigger("loss_streak", { n: 3 }, "en")).toBe("3 losses in a row");
  });
  it("weekly psychology insights re-render in the reader's language", () => {
    const r = { totalTrades: 0, totalCheckins: 0, winRate: 0, totalPnl: 0, bestState: null, emotionalBreakdown: {} };
    expect(buildInsights(r, null, "ru")[0]).toBe("На этой неделе сделок нет.");
    expect(buildInsights(r, null, "en")[0]).toBe("No trades this week.");
  });
});

describe("permissions / setups", () => {
  it("capability texts per language, keys and flags unchanged", () => {
    const en = localizedCapabilityDefs("en");
    expect(en.map((d) => d.key)).toEqual(CAPABILITY_DEFS.map((d) => d.key));
    expect(en.find((d) => d.key === "risk.limits.edit")?.label).toBe("Change limits");
    expect(localizedCapabilityDefs("ru").find((d) => d.key === "risk.limits.edit")?.label).toBe(CAPABILITY_DEFS.find((d) => d.key === "risk.limits.edit")?.label);
  });
  it("setup class keeps its canonical name, label follows the language", () => {
    const t = { id: 1, ticker: "A", date: "2026-10-01", side: "long" as const, entry: 10, exit: 11, qty: 1, entryMin: 600, holdMin: 10, horizon: "intraday" as const, entryAt: null, exitAt: null };
    const ru = classifyFromFeatures(t, computeFeatures(t, { candles: null, interval: null, prevClose: null, daily: null }));
    const en = classifyFromFeatures(t, computeFeatures(t, { candles: null, interval: null, prevClose: null, daily: null }), "en");
    expect(en.setup).toBe(ru.setup);
    expect(setupLabelOf(ru.setup, "en")).toBe("Morning");
    expect(en.note).toBe("No candles: the setup is based only on entry time and hold time.");
  });
});

describe("academy", () => {
  it("exam reason as data renders per reader", () => {
    const tpl = TEMPLATE_BY_KEY.trainee_test_10d;
    const r = evaluateChallenge({ startsOn: "2026-10-05", endsOn: "2026-10-16", rules: tpl.rules }, [], "2026-10-01");
    expect(r.reason).toBe("Начнётся 2026-10-05");
    expect(renderChallengeReason(r.reasonData, "en")).toBe("Starts on 2026-10-05");
  });
  it("IDP goal formula and lag reasons per language", () => {
    expect(describeGoal({ metric: "win_rate", target: 50, comparator: "gte", window: 100 })).toBe("Винрейт ≥ 50 % на 100 сделках");
    expect(describeGoal({ metric: "win_rate", target: 50, comparator: "gte", window: 100 }, "en")).toBe("Win rate ≥ 50 % over 100 trades");
    const att = summarizeAttendance(["absent", "absent", "present", "absent"]);
    const reasons = lagReasons({ today: "2026-10-16", stage: "trainee", status: "active", joinedOn: null, attendance: att, overdueActions: 0, missedGoals: 0, atRiskGoals: 0, lastTradeDate: "2026-10-15", lastJournalDate: "2026-10-15" }, "en");
    expect(reasons.find((x) => x.code === "attendance_low")?.text).toMatch(/^Attendance \d+ %$/);
  });
});
