import { describe, expect, it } from "vitest";
import {
  attachAlerts, dedupeOverlap, feesReason, focusReason, giveback, givebackReason, lastFinishedDay, lossStreak, lossStreakReason, makeItem, queueDays,
  rankQueue, rulesReason, stopBreachReason, storedVerdict, sumCost, type DayTrade,
} from "../daily/costQueue";
import type { FocusVerdict } from "../daily/types";

const tr = (id: number, net: number | null, exitAt: number | null = id): DayTrade => ({ id, ticker: "AMD", net, exitAt });

describe("costQueue window", () => {
  it("last finished day: today after the close, else the previous trading day", () => {
    expect(lastFinishedDay("2026-10-16", { date: "2026-10-16", minutes: 17 * 60 })).toBe("2026-10-16");
    expect(lastFinishedDay("2026-10-16", { date: "2026-10-16", minutes: 10 * 60 })).toBe("2026-10-15");
    expect(lastFinishedDay("2026-10-19", { date: "2026-10-19", minutes: 8 * 60 })).toBe("2026-10-16"); // Monday premarket → Friday
    expect(lastFinishedDay("2026-10-18", { date: "2026-10-18", minutes: 12 * 60 })).toBe("2026-10-16"); // Sunday
    expect(lastFinishedDay("2026-10-14", { date: "2026-10-18", minutes: 12 * 60 })).toBe("2026-10-14"); // past day = finished
  });

  it("queue days: D then the carry trading days, skipping weekends", () => {
    expect(queueDays("2026-10-19", 2)).toEqual(["2026-10-19", "2026-10-16", "2026-10-15"]);
  });
});

describe("costQueue reasons", () => {
  it("stop breach: day net past the daily limit, trade that crossed it", () => {
    const r = stopBreachReason(-420, 300, [tr(1, -100), tr(2, -250), tr(3, -70)], []);
    expect(r).toMatchObject({ kind: "stop_breach", costNet: -120, tradeId: 2 });
    expect(r!.text).toEqual({ key: "costQueue.detail.stop_breach", params: { scope: "daily", used: 420, limit: 300 } });
    expect(stopBreachReason(-200, 300, [], [])).toBeNull();
    expect(stopBreachReason(-500, null, [], [])).toBeNull();
  });

  it("stop breach: the deepest overshoot of alerts wins; an alert without $ still flags", () => {
    const r = stopBreachReason(-50, 300, [], [{ id: 9, kind: "drawdown", used: 3630, limit: 2000, reviewed: false }]);
    expect(r).toMatchObject({ costNet: -1630, text: { params: { scope: "drawdown" } } });
    expect(stopBreachReason(null, null, [], [{ id: 9, kind: "stop", used: null, limit: null, reviewed: false }])).toMatchObject({ costNet: null });
  });

  it("fees ≥ 50 % of a positive gross, priced as the fees above a healthy 25 % (engine day:fees)", () => {
    expect(feesReason(40, 21)).toMatchObject({ kind: "fees", costNet: -11, text: { params: { pct: 53 } } });
    expect(feesReason(6, 4)).toBeNull(); // below $5 of fees
    expect(feesReason(40, 19)).toBeNull();
    expect(feesReason(-80, 30)).toBeNull();
    expect(feesReason(null, 30)).toBeNull();
  });

  it("loss streak counts losing traded days back from the day", () => {
    const days = [
      { date: "2026-10-12", net: 50 }, { date: "2026-10-13", net: -10 }, { date: "2026-10-14", net: -20 },
      { date: "2026-10-15", net: -30 }, { date: "2026-10-16", net: -5 },
    ];
    expect(lossStreak(days, "2026-10-16")).toEqual({ days: 4, net: -65, from: "2026-10-13" });
    expect(lossStreakReason(days, "2026-10-16")).toMatchObject({ kind: "loss_streak", costNet: -65 });
    expect(lossStreakReason(days, "2026-10-14")).toBeNull(); // only 2 days
    expect(lossStreak(days, "2026-10-17").days).toBe(0); // no trading on the day
  });

  it("giveback: peak ≥ $50 closed at ≤ 20 % of it, by exit order", () => {
    expect(giveback([tr(1, 80, 1), tr(2, 70, 2), tr(3, -90, 3), tr(4, -40, 4)])).toEqual({ peak: 150, close: 20, tradeId: 3 });
    expect(givebackReason([tr(1, 80), tr(2, 70), tr(3, -90), tr(4, -40)])).toMatchObject({ kind: "giveback", costNet: -130, tradeId: 3 });
    expect(givebackReason([tr(1, 80), tr(2, 70), tr(3, -40)])).toBeNull(); // kept 110 of 150
    expect(givebackReason([tr(1, 40), tr(2, -40)])).toBeNull(); // peak below $50
    expect(givebackReason([tr(1, 100), tr(2, -75)])).toBeNull(); // kept 25 % of the peak
    // exit order, not id order
    expect(giveback([tr(2, -90, 30), tr(1, 150, 10)]).peak).toBe(150);
  });

  it("rules: one cost per trade (deepest), day-level added, unknown money → null", () => {
    const r = rulesReason([
      { tradeId: 7, costNet: -40, rule: "no_averaging_down" }, { tradeId: 7, costNet: -40, rule: "max_loss_per_trade_usd" },
      { tradeId: 8, costNet: -15, rule: "no_averaging_down" }, { tradeId: null, costNet: -5, rule: "min_pause_after_loss" },
    ]);
    expect(r).toMatchObject({ kind: "rule", costNet: -60, tradeId: 7, text: { params: { count: 4, rule: "no_averaging_down", rules: 3 } } });
    expect(rulesReason([{ tradeId: 3, costNet: null, rule: "x" }])).toMatchObject({ costNet: null, tradeId: 3 });
    expect(rulesReason([])).toBeNull();
  });

  it("focus: broken → focus_broken, disputed wins over broken, kept → nothing", () => {
    const v: FocusVerdict = {
      date: "2026-10-16", mistake: "structure:averaging", status: "broken", costNet: -212, disputed: false,
      hits: [{ tradeId: 1, date: "2026-10-16", ticker: "AMD", net: -12 }, { tradeId: 2, date: "2026-10-16", ticker: "AMD", net: -200 }],
    };
    expect(focusReason(v)).toMatchObject({ kind: "focus_broken", costNet: -212, tradeId: 2, text: { params: { mistake: "structure:averaging", count: 2 } } });
    expect(focusReason({ ...v, disputed: true })).toMatchObject({ kind: "disputed" });
    expect(focusReason({ ...v, status: "kept", hits: [] })).toBeNull();
    expect(focusReason(null)).toBeNull();
  });
});

describe("costQueue assembly + ranking", () => {
  it("sums reasons (positive / unknown count as 0) and orders reasons costliest first", () => {
    const item = makeItem("A", "2026-10-16", [
      feesReason(40, 30), null, stopBreachReason(-420, 300, [], []),
      { kind: "disputed", costNet: null, text: { key: "k" } },
    ], false)!;
    expect(item.costNet).toBe(-140);
    expect(item.reasons.map((r) => r.kind)).toEqual(["stop_breach", "fees", "disputed"]);
    expect(makeItem("A", "2026-10-16", [null, null], false)).toBeNull();
    expect(sumCost([{ kind: "fees", costNet: 5, text: { key: "k" } }])).toBe(0);
  });

  it("ranks most negative first; ties: more reasons, newer day, name", () => {
    const row = (trader: string, date: string, costNet: number, n = 1) => ({ trader, date, costNet, resolved: false, reasons: Array.from({ length: n }, () => ({ kind: "fees" as const, costNet: null, text: { key: "k" } })) });
    const out = rankQueue([row("B", "2026-10-16", -10), row("A", "2026-10-16", -500), row("C", "2026-10-15", -10, 2), row("D", "2026-10-16", -10, 2)]);
    expect(out.map((r) => r.trader)).toEqual(["A", "D", "C", "B"]);
  });

  it("alerts: daily stops on their day, later alerts clamp to D, state-like limits only once (newest)", () => {
    const days = ["2026-10-16", "2026-10-15", "2026-10-14"];
    const m = attachAlerts([
      { trader: "K", date: "2026-10-15", kind: "drawdown" }, { trader: "K", date: "2026-10-18", kind: "drawdown" },
      { trader: "K", date: "2026-10-14", kind: "stop" }, { trader: "K", date: "2026-10-01", kind: "stop" },
    ], days);
    expect(m.get("K|2026-10-16")?.map((a) => a.kind)).toEqual(["drawdown"]);
    expect(m.get("K|2026-10-15")).toBeUndefined();
    expect(m.get("K|2026-10-14")?.map((a) => a.kind)).toEqual(["stop"]);
  });
});

describe("storedVerdict", () => {
  const focus: FocusVerdict = { date: "2026-10-16", mistake: "day:fees", status: "broken", hits: [], costNet: -30, disputed: false };
  it("applies a later «not a mistake» of the same focus (or of any when the mistake is not recorded)", () => {
    expect(storedVerdict({ focus, disputed: false, disputed_mistake: null })?.disputed).toBe(false);
    expect(storedVerdict({ focus, disputed: true, disputed_mistake: "day:fees" })?.disputed).toBe(true);
    expect(storedVerdict({ focus, disputed: true, disputed_mistake: null })?.disputed).toBe(true);
    expect(storedVerdict({ focus, disputed: true, disputed_mistake: "behavior:revenge" })?.disputed).toBe(false);
    expect(storedVerdict({ focus: null, disputed: true, disputed_mistake: null })).toBeNull();
  });
});

describe("dedupeOverlap", () => {
  const focus = (mistake: string, costNet: number) => ({ kind: "focus_broken" as const, costNet, text: { key: "k", params: { mistake, count: 1 } } });
  it("focus day:fees swallows the same fees reason; rule:* keeps the rule reason with the rest of its cost", () => {
    expect(dedupeOverlap([focus("day:fees", -31.7), feesReason(3.25, 31.7)!]).map((r) => r.kind)).toEqual(["focus_broken"]);
    const out = dedupeOverlap([focus("rule:no_trade_after_n_losses", -50), { kind: "rule", costNet: -80, text: { key: "k" } }]);
    expect(out.find((r) => r.kind === "rule")?.costNet).toBe(-30);
    // a profitable «broken» focus does not reduce anything
    expect(dedupeOverlap([focus("day:fees", 12), feesReason(40, 30)!]).map((r) => r.kind)).toEqual(["focus_broken", "fees"]);
    expect(makeItem("A", "d", [focus("day:fees", -31.7), feesReason(3.25, 31.7)], false)!.costNet).toBe(-31.7);
  });
});
