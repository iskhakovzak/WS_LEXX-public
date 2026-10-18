/**
 * Daily loop engine (lib/daily/engine.ts + detectors.ts) on realistic fixtures: a junior's month of small scalps in
 * October 2026 (NY = UTC−4), with repeating revenge entries, a giveback day, a fee-heavy day, trading past the daily
 * limit, an add against a losing position and an exit past the stop (fills), a rule, the own contract, the trade to
 * review, tier progress and the behaviour discipline score with the contract points.
 */
import { describe, expect, it } from "vitest";
import { analyzeBehavior, type BehaviorTrade } from "../behaviorEngine";
import {
  DISCIPLINE_POINTS, analyzeWindow, contractOf, focusOf, focusWindow, isMistakeId, pickFocus, tierProgressOf, tradeToReview, verdictOf,
  type DetectInput,
} from "../daily/engine";
import type { ExecRowLite, TradeRowLite } from "../tradeStructureStore";
import type { RuleRow, TradeForRule } from "../rulesEval";
import type { Evaluation } from "../scalingEngine";

let nextId = 1000;
/** Trade on `date` entered at NY `hhmm`, held `hold` minutes, net $ (gross = net + fees). */
function tr(date: string, hhmm: string, hold: number, net: number, o: Partial<BehaviorTrade> & { fees?: number } = {}): BehaviorTrade {
  const [h, m] = hhmm.split(":").map(Number);
  const entryAt = Date.parse(`${date}T${String(h + 4).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  const fees = o.fees ?? 1;
  return {
    id: o.id ?? nextId++, ticker: o.ticker ?? "AMD", date, side: "long", result: net > 0 ? "win" : net < 0 ? "loss" : "be",
    net, gross: net + fees, qty: o.qty ?? 100, entry: o.entry ?? 10, entryAt, exitAt: entryAt + hold * 60000,
    entryMin: h * 60 + m, holdMin: hold, horizon: "intraday", setup: null, ...o,
  };
}

/** 20 calm history days (Sep 2026): two winners and a small loser a day, no pattern. */
function history(): BehaviorTrade[] {
  const out: BehaviorTrade[] = [];
  let d = new Date("2026-09-01T12:00:00Z");
  while (out.length < 60) {
    const ymd = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      out.push(tr(ymd, "09:45", 5, 30), tr(ymd, "10:30", 6, -12), tr(ymd, "11:30", 5, 25));
    }
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

/** A revenge day: a loser exits 10:05, the next entry at 10:08 loses more. */
const revengeDay = (date: string) => [tr(date, "10:00", 5, -20), tr(date, "10:08", 4, -45), tr(date, "11:30", 5, 20)];

const window = { from: "2026-10-05", to: "2026-10-16" };

describe("focus window", () => {
  it("is the 10 weekdays before the day", () => {
    expect(focusWindow("2026-10-19")).toEqual({ from: "2026-10-05", to: "2026-10-16" });
    expect(focusWindow("2026-10-14")).toEqual({ from: "2026-09-30", to: "2026-10-13" });
  });
  it("validates mistake ids", () => {
    expect(isMistakeId("behavior:revenge")).toBe(true);
    expect(isMistakeId("behavior:firstTrade")).toBe(true);
    expect(isMistakeId("rule:max_trades_per_day")).toBe(true);
    expect(isMistakeId("structure:averaging")).toBe(true);
    expect(isMistakeId("behavior:nope")).toBe(false);
    expect(isMistakeId("rule:DROP TABLE")).toBe(false);
    expect(isMistakeId(null)).toBe(false);
  });
});

describe("focus pick", () => {
  const trades = [...history(), ...revengeDay("2026-10-06"), ...revengeDay("2026-10-08"), ...revengeDay("2026-10-13"), tr("2026-10-14", "09:50", 5, 15)];
  const a = analyzeWindow({ trades, ...window });

  it("finds the repeating revenge entries and prices them against the personal norm", () => {
    const rev = a.costs.find((c) => c.id === "behavior:revenge")!;
    expect(rev.count).toBe(3);
    expect(rev.days).toBe(3);
    expect(rev.costNet!).toBeLessThan(-100); // −45 each vs a positive norm
    expect(rev.examples[0]!.net).toBe(-45);
  });

  it("picks the costliest repeating mistake and writes the line", () => {
    const pick = pickFocus(a.costs);
    expect(pick?.id).toBe("behavior:revenge");
    const f = focusOf("Кирилл Б.", "2026-10-19", window, pick);
    expect(f.source).toBe("auto");
    expect(f.text.key).toBe("focus.behavior:revenge");
    expect(f.text.params).toEqual({ cost: Math.round(Math.abs(pick!.costNet!)), count: 3, days: 3 });
  });

  it("skips a disputed mistake and one-day mistakes; nothing left → «none»", () => {
    const pick = pickFocus(a.costs, new Set(["behavior:revenge"]));
    expect(pick == null || pick.days >= 2).toBe(true);
    expect(pick?.id).not.toBe("behavior:revenge");
    const calm = analyzeWindow({ trades: [...history(), tr("2026-10-06", "09:45", 5, 30)], ...window });
    const f = focusOf("Кирилл Б.", "2026-10-19", window, pickFocus(calm.costs));
    expect(f).toMatchObject({ mistake: null, source: "none", text: { key: "focus.none", params: { days: 10 } } });
  });

  it("verdict: broken with the hit on a revenge day, kept on a clean day, no_trades on an empty day", () => {
    const broken = verdictOf(a, "2026-10-08", "behavior:revenge");
    expect(broken.status).toBe("broken");
    expect(broken.hits).toHaveLength(1);
    expect(broken.hits[0]!.net).toBe(-45);
    expect(verdictOf(a, "2026-10-14", "behavior:revenge").status).toBe("kept");
    expect(verdictOf(a, "2026-10-15", "behavior:revenge").status).toBe("no_trades");
    // Structure mistakes need fills: without them the engine says «unknown», never «kept».
    expect(verdictOf(a, "2026-10-14", "structure:averaging").status).toBe("unknown");
  });
});

describe("day-level detectors", () => {
  it("giveback: peak ≥ the meaningful amount, closed near zero; cost = close − peak", () => {
    const day = [tr("2026-10-07", "09:40", 5, 80), tr("2026-10-07", "10:00", 5, 40), tr("2026-10-07", "10:30", 5, -60), tr("2026-10-07", "11:00", 5, -55)];
    const a = analyzeWindow({ trades: [...history(), ...day], ...window });
    const h = a.days.get("2026-10-07")!.get("day:giveback")!;
    expect(h.costNet).toBe(-115);
    expect(h.refs.map((r) => r.net)).toEqual([-60, -55]);
    expect(tradeToReview(a, "2026-10-07", null)).toMatchObject({ net: -60, reason: "biggest_loss" });
  });

  it("fees ≥ 50 % of a positive gross; cost = fees above a quarter of the gross", () => {
    const day = [tr("2026-10-09", "09:40", 2, 5, { fees: 15 }), tr("2026-10-09", "09:50", 2, 5, { fees: 15 })]; // gross 40, fees 30
    const a = analyzeWindow({ trades: [...history(), ...day], ...window });
    expect(a.days.get("2026-10-09")!.get("day:fees")!.costNet).toBe(-20);
  });

  it("trading after the daily loss limit (plan stop wins over the risk limit)", () => {
    const day = [tr("2026-10-12", "09:40", 5, -60), tr("2026-10-12", "09:50", 5, -50), tr("2026-10-12", "10:30", 5, -30), tr("2026-10-12", "11:00", 5, 10)];
    const input: DetectInput = {
      trades: [...history(), ...day], ...window,
      limits: { accountSize: null, dailyLossLimit: 300, maxPositionUsd: null, maxRiskPerTrade: null, allowOvernight: true, allowSwing: true },
      plans: new Map([["2026-10-12", { maxLossUsd: 100, maxTrades: 3, ownRule: "day:after_limit" }]]),
    };
    const a = analyzeWindow(input);
    const h = a.days.get("2026-10-12")!.get("day:after_limit")!;
    expect(h.count).toBe(2);
    expect(h.costNet).toBe(-20);
    const c = contractOf(a, "2026-10-12", input.plans!.get("2026-10-12"))!;
    expect(c.maxLoss).toEqual({ limit: 100, actual: -140, status: "broken" });
    expect(c.maxTrades).toEqual({ limit: 3, actual: 4, status: "broken" });
    expect(c.rule).toEqual({ mistake: "day:after_limit", status: "broken" });
    expect(c.disciplineDelta).toBe(3 * DISCIPLINE_POINTS.broken);
  });
});

describe("own contract and the trade to review", () => {
  const day = [tr("2026-10-14", "09:45", 5, 30), tr("2026-10-14", "10:20", 5, 12)];
  const a = analyzeWindow({ trades: [...history(), ...day], ...window });
  it("kept items add points; unset items add nothing; no contract → null", () => {
    const c = contractOf(a, "2026-10-14", { maxLossUsd: 150, maxTrades: 5, ownRule: "behavior:revenge" })!;
    expect([c.maxLoss.status, c.maxTrades.status, c.rule.status]).toEqual(["kept", "kept", "kept"]);
    expect(c.disciplineDelta).toBe(3 * DISCIPLINE_POINTS.kept);
    const partial = contractOf(a, "2026-10-14", { maxLossUsd: null, maxTrades: 5, ownRule: null })!;
    expect(partial.maxLoss.status).toBe("unset");
    expect(partial.disciplineDelta).toBe(DISCIPLINE_POINTS.kept);
    expect(contractOf(a, "2026-10-14", { maxLossUsd: null, maxTrades: null, ownRule: null })).toBeNull();
    expect(contractOf(a, "2026-10-15", { maxLossUsd: 150, maxTrades: null, ownRule: null })!.maxLoss.status).toBe("no_trades");
  });
  it("a green day without losers → the best trade", () => {
    expect(tradeToReview(a, "2026-10-14", null)).toMatchObject({ net: 30, reason: "best" });
    expect(tradeToReview(a, "2026-10-15", null)).toBeNull();
  });
});

describe("structure detectors (fills)", () => {
  const row = (id: number, stop: number | null): TradeRowLite => ({
    id, trader: "Кирилл Б.", broker_account: "A1", ticker: "AMD", date: "2026-10-13", side: "long", stop, risk_usd: null, qty: 200,
    result: "loss", source: "propreports", context_snapshot: null,
  });
  const fill = (id: number, tradeId: number, kind: string, price: number, qty: number, hhmmss: string, order: number): ExecRowLite => ({
    id, trade_id: tradeId, kind, price, qty, executed_at: `2026-10-13T${hhmmss}Z`, sort_order: order, order_id: `o${id}`,
  });
  const avgTrade = tr("2026-10-13", "10:00", 10, -21, { id: 1 });
  const stopTrade = tr("2026-10-13", "11:00", 10, -21, { id: 2, qty: 100 });
  const input: DetectInput = {
    trades: [...history(), avgTrade, stopTrade], ...window,
    structRows: [row(1, null), row(2, 9.9)],
    fills: [
      fill(11, 1, "entry", 10.0, 100, "14:00:00", 0), fill(12, 1, "add", 9.8, 100, "14:03:00", 1), fill(13, 1, "exit", 9.7, 200, "14:10:00", 2),
      fill(21, 2, "entry", 10.0, 100, "15:00:00", 0), fill(22, 2, "exit", 9.7, 100, "15:10:00", 1),
    ],
  };
  const a = analyzeWindow(input);
  it("averaging: an add below the average of a long; cost = P&L of the added shares", () => {
    const h = a.days.get("2026-10-13")!.get("structure:averaging")!;
    expect(h.count).toBe(1);
    expect(h.refs[0]!.tradeId).toBe(1);
    expect(h.costNet).toBe(-10); // 100 sh × (9.70 − 9.80)
    expect(verdictOf(a, "2026-10-13", "structure:averaging").status).toBe("broken");
  });
  it("held past the stop: exit 0.20 beyond a 9.90 stop on 100 shares", () => {
    const h = a.days.get("2026-10-13")!.get("structure:held_past_stop")!;
    expect(h.refs.map((r) => r.tradeId)).toEqual([2]);
    expect(h.costNet).toBe(-20);
  });
});

describe("rules", () => {
  it("rule violations of the window become rule:<kind> with their impact", () => {
    const day = [tr("2026-10-15", "09:40", 3, 10), tr("2026-10-15", "09:50", 3, -8), tr("2026-10-15", "10:00", 3, -25)];
    const ruleTrades = day.map((t) => ({
      id: t.id, trader: "Кирилл Б.", date: t.date, closeDate: t.date, result: t.result, pnl: t.gross, netPnl: t.net, signedR: null,
      entry: 10, stop: null, qty: 100, riskUsd: null, horizon: "intraday", source: "propreports", playbookId: null, setupScore: null,
      maxNotional: null, checklistRuns: 0, ticker: "AMD", side: "long", entryAt: t.entryAt, exitAt: t.exitAt, entryMin: t.entryMin,
    })) as TradeForRule[];
    const rules: RuleRow[] = [{ id: 7, trader: "Кирилл Б.", name: "2 trades", kind: "max_trades_per_day", threshold: { n: 2 }, enabled: true }];
    const a = analyzeWindow({ trades: [...history(), ...day], ...window, rules, ruleTrades });
    const h = a.days.get("2026-10-15")!.get("rule:max_trades_per_day")!;
    expect(h.count).toBe(1);
    expect(h.costNet).toBe(-25);
    expect(a.evaluable("rule:max_trades_per_day", "2026-10-15")).toBe(true);
    expect(a.evaluable("rule:no_overnight", "2026-10-15")).toBe(false);
  });
});

describe("tier progress and discipline", () => {
  it("maps a scaling evaluation to «to the next tier: met of total»", () => {
    const ev = {
      tier: { key: "junior" }, nextTier: { key: "trader" }, promotePassed: 3, promoteTotal: 5,
      rules: [
        { kind: "promote", metric: "trades", actual: 124, threshold: 40, status: "pass", customLabel: null },
        { kind: "promote", metric: "profit_factor", actual: 0.98, threshold: 1.3, status: "fail", customLabel: "PF" },
        { kind: "demote", metric: "red_streak", actual: 1, threshold: 5, status: "fail", customLabel: null },
      ],
    } as unknown as Evaluation;
    const p = tierProgressOf(ev)!;
    expect(p).toMatchObject({ tier: "junior", nextTier: "trader", met: 3, total: 5 });
    expect(p.items).toHaveLength(2);
    expect(p.items[1]).toMatchObject({ metric: "profit_factor", ok: false, label: { key: "scaling.metric.profit_factor.label", params: { custom: "PF" } } });
    expect(tierProgressOf(null)).toBeNull();
  });

  it("the contract verdict moves the next-day discipline score (behaviour engine)", () => {
    const trades = [...history(), ...revengeDay("2026-10-06")];
    const base = analyzeBehavior(trades).discipline.find((d) => d.date === "2026-10-06")!;
    const withContract = analyzeBehavior(trades, {}, undefined, new Map([["2026-10-06", DISCIPLINE_POINTS.broken]])).discipline.find((d) => d.date === "2026-10-06")!;
    expect(withContract.contract).toBe(-15);
    expect(withContract.score).toBe(Math.max(0, base.score - 15));
    expect(base.contract).toBeUndefined();
  });
});
