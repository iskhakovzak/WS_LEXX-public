import { describe, expect, it, vi } from "vitest";

// rulesEngine imports the DB pool and runs an idempotent ALTER TABLE at import time; keep the test pure.
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));
vi.mock("../logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { evalRule, RULE_KINDS } = await import("../rulesEngine");
type TradeForRule = import("../rulesEngine").TradeForRule;
type RuleRow = import("../rulesEngine").RuleRow;
type RiskLimits = import("../rulesEngine").RiskLimits;

let nextId = 1;
function trade(over: Partial<TradeForRule> = {}): TradeForRule {
  const id = over.id ?? nextId++;
  const date = over.date ?? "2026-10-14";
  const result = over.result === undefined ? "win" : over.result;
  const pnl = over.pnl ?? (result === "loss" ? -100 : result === "win" ? 100 : 0);
  return {
    id, trader: "alice", date, closeDate: over.closeDate ?? date, result, pnl, netPnl: over.netPnl ?? (pnl == null ? null : pnl - 1),
    signedR: null, entry: null, stop: null, qty: null, riskUsd: null, horizon: "intraday", source: null, playbookId: null, setupScore: null,
    maxNotional: null, checklistRuns: 0, ...over,
  };
}
const rule = (kind: string, threshold: Record<string, unknown> = {}): RuleRow => ({ id: 7, trader: "alice", name: kind, kind, threshold, enabled: true });
const NO_LIMITS: RiskLimits = { accountSize: null, dailyLossLimit: null, maxPositionUsd: null, maxRiskPerTrade: null, allowOvernight: true, allowSwing: true };
const ids = (v: { tradeId: number | null }[]) => v.map((x) => x.tradeId);

describe("RULE_KINDS", () => {
  it("every kind has a label and numeric defaults; optional fields name their risk-desk column", () => {
    expect(RULE_KINDS.map((k) => k.kind)).toEqual([
      "max_trades_per_day", "no_trade_after_n_losses", "max_daily_loss_usd", "max_loss_per_day_pct", "max_position_usd", "position_size_pct",
      "max_risk_per_trade_usd", "max_consecutive_losses", "no_overnight", "no_swing", "trade_without_checklist",
    ]);
    for (const k of RULE_KINDS) for (const f of k.fields) {
      expect(f.type).toBe("number");
      if (f.optional) expect(f.riskLimit).toBeDefined();
    }
  });
});

describe("evalRule — counts per day", () => {
  it("max_trades_per_day: every trade beyond N is a violation; days are entry days", () => {
    const trades = [trade({ id: 1 }), trade({ id: 2 }), trade({ id: 3, result: "loss" }), trade({ id: 4, date: "2026-10-15" }), trade({ id: 5, date: "2026-10-15" }), trade({ id: 6, date: "2026-10-15" })];
    const v = evalRule(rule("max_trades_per_day", { n: 2 }), trades);
    expect(ids(v)).toEqual([3, 6]);
    expect(v[0]).toMatchObject({ key: "t3", day: "2026-10-14", severity: "high", costNet: -101, details: { totalTradesThatDay: 3, limit: 2 } });
    expect(v[1].costNet).toBe(0); // the winning trade cost nothing
    expect(evalRule(rule("max_trades_per_day", { n: "abc" }), trades)).toEqual([]); // invalid → default 5 → nothing (3 + 3 per day)
    expect(evalRule(rule("max_trades_per_day", { n: 0 }), trades)).toEqual([]); // 0 is "empty" → default 5
    expect(evalRule(rule("max_trades_per_day", { n: "1" }), trades).length).toBe(4); // numeric string accepted
  });

  it("no_trade_after_n_losses: BE does not reset the streak, a win does", () => {
    const seq: Array<TradeForRule["result"]> = ["loss", "loss", "win", "loss", "loss", "be", "loss"];
    const trades = seq.map((result, i) => trade({ id: i + 1, result }));
    expect(ids(evalRule(rule("no_trade_after_n_losses", { n: 2 }), trades))).toEqual([3, 6, 7]);
    expect(evalRule(rule("no_trade_after_n_losses", { n: 2 }), trades)[0]).toMatchObject({ severity: "critical", details: { lossesBefore: 2, limit: 2 } });
    const spread = trades.map((t) => ({ ...t, date: `2026-10-${10 + t.id}` })); // one trade per day: no intraday streak
    expect(evalRule(rule("no_trade_after_n_losses", { n: 2 }), spread)).toEqual([]);
  });

  it("max_consecutive_losses: streak across days, reported at the realised day", () => {
    const seq: Array<TradeForRule["result"]> = ["loss", "loss", "be", "loss", "win", "loss"];
    const trades = seq.map((result, i) => trade({ id: i + 1, result, date: `2026-10-1${i}`, closeDate: `2026-10-2${i}` }));
    const v = evalRule(rule("max_consecutive_losses", { n: 2 }), trades);
    expect(ids(v)).toEqual([2, 4]);
    expect(v[1]).toMatchObject({ day: "2026-10-23", details: { streak: 3, limit: 2, date: "2026-10-13" } });
  });
});

describe("evalRule — daily loss (net, by realised day)", () => {
  const trades = [
    trade({ id: 1, netPnl: -200 }),
    trade({ id: 2, netPnl: -300 }), // running −500: breach
    trade({ id: 3, netPnl: 150 }), // after the breach: critical even if it wins
    trade({ id: 4, netPnl: -1000, date: "2026-10-15" }), // other day
    trade({ id: 5, netPnl: null }), // unknown P&L never counts
  ];
  it("$ limit from the rule: breach at exactly −limit, later trades critical, cost = overshoot", () => {
    const v = evalRule(rule("max_daily_loss_usd", { usd: 500 }), trades);
    expect(ids(v)).toEqual([2, 3, 4]);
    expect(v[0]).toMatchObject({ severity: "high", day: "2026-10-14", costNet: 0, details: { runningNet: -500, limitUsd: 500, afterBreach: false } });
    expect(v[1]).toMatchObject({ severity: "critical", costNet: 0, details: { runningNet: -350, afterBreach: true } });
    expect(v[2]).toMatchObject({ severity: "high", day: "2026-10-15", costNet: -500 });
    expect(v[0].message).not.toMatch(/риск-деск/);
  });
  it("empty threshold → risk-desk limit (flagged), no limit anywhere → no violations", () => {
    const v = evalRule(rule("max_daily_loss_usd", {}), trades, { ...NO_LIMITS, dailyLossLimit: 450 });
    expect(ids(v)).toEqual([2, 3, 4]);
    expect(v[0].message).toMatch(/риск-деск/);
    expect(evalRule(rule("max_daily_loss_usd", {}), trades, NO_LIMITS)).toEqual([]);
    expect(evalRule(rule("max_daily_loss_usd", { usd: 501 }), trades.slice(0, 3))).toEqual([]); // −500 > −501: not breached
  });
  it("% of capital: rule capital, else account size, else 50k", () => {
    expect(ids(evalRule(rule("max_loss_per_day_pct", { pct: 5, capital: 10_000 }), trades))).toEqual([2, 3, 4]); // 500
    expect(ids(evalRule(rule("max_loss_per_day_pct", { pct: 2 }), trades, { ...NO_LIMITS, accountSize: 20_000 }))).toEqual([2, 3, 4]); // 400
    expect(ids(evalRule(rule("max_loss_per_day_pct", { pct: 2 }), trades))).toEqual([4]); // 1000 of 50k
  });
  it("overnight loss is charged to the close day, not the entry day", () => {
    const t = [trade({ id: 1, netPnl: -300, date: "2026-10-13", closeDate: "2026-10-14" }), trade({ id: 2, netPnl: -300, date: "2026-10-14" })];
    const v = evalRule(rule("max_daily_loss_usd", { usd: 500 }), t);
    expect(ids(v)).toEqual([2]);
    expect(v[0].day).toBe("2026-10-14");
  });
});

describe("evalRule — size and risk", () => {
  it("max_position_usd: executions notional first, entry × qty fallback, risk-desk fallback", () => {
    const trades = [
      trade({ id: 1, maxNotional: 25_000, entry: 10, qty: 10 }), // executions win over entry×qty
      trade({ id: 2, entry: 100, qty: 150 }), // 15 000
      trade({ id: 3, entry: 100, qty: null }), // unknown size → never a violation
    ];
    const v = evalRule(rule("max_position_usd", { usd: 20_000 }), trades);
    expect(ids(v)).toEqual([1]);
    expect(v[0].details).toEqual({ positionSize: 25_000, maxSize: 20_000, fromExecutions: true });
    const desk = evalRule(rule("max_position_usd", {}), trades, { ...NO_LIMITS, maxPositionUsd: 10_000 });
    expect(ids(desk)).toEqual([1, 2]);
    expect(desk[1].details.fromExecutions).toBe(false);
    expect(desk[1].message).toMatch(/риск-деск/);
    expect(evalRule(rule("max_position_usd", {}), trades, NO_LIMITS)).toEqual([]);
  });
  it("position_size_pct: % of capital (default 10% of 50k)", () => {
    const trades = [trade({ id: 1, entry: 50, qty: 101 }), trade({ id: 2, entry: 50, qty: 100 })];
    expect(ids(evalRule(rule("position_size_pct", {}), trades))).toEqual([1]); // 5050 > 5000
    expect(ids(evalRule(rule("position_size_pct", { pct: 20 }), trades, { ...NO_LIMITS, accountSize: 20_000 }))).toEqual([1, 2]); // 4000
  });
  it("max_risk_per_trade_usd: risk_usd first, |entry − stop| × qty second, stop == entry is unknown", () => {
    const trades = [
      trade({ id: 1, riskUsd: 250, entry: 10, stop: 9.99, qty: 1 }),
      trade({ id: 2, entry: 100, stop: 97, qty: 100 }), // 300
      trade({ id: 3, entry: 100, stop: 100, qty: 100 }),
      trade({ id: 4, entry: 100, stop: 99, qty: 100 }), // 100
    ];
    expect(ids(evalRule(rule("max_risk_per_trade_usd", { usd: 200 }), trades))).toEqual([1, 2]);
    expect(evalRule(rule("max_risk_per_trade_usd", { usd: 200 }), trades)[1].details).toEqual({ riskUsd: 300, limitUsd: 200 });
    expect(ids(evalRule(rule("max_risk_per_trade_usd", {}), trades, { ...NO_LIMITS, maxRiskPerTrade: 99 }))).toEqual([1, 2, 4]);
    expect(evalRule(rule("max_risk_per_trade_usd", {}), trades, NO_LIMITS)).toEqual([]);
  });
});

describe("evalRule — horizon and process", () => {
  const trades = [trade({ id: 1 }), trade({ id: 2, horizon: "overnight", closeDate: "2026-10-15" }), trade({ id: 3, horizon: "swing", closeDate: "2026-10-20" })];
  it("no_overnight hits overnight and swing; no_swing only swing", () => {
    const v = evalRule(rule("no_overnight"), trades);
    expect(ids(v)).toEqual([2, 3]);
    expect(v[0].details).toEqual({ horizon: "overnight", exitDate: "2026-10-15" });
    expect(ids(evalRule(rule("no_swing"), trades))).toEqual([3]);
  });
  it("trade_without_checklist: broker imports, checklist runs and scored setups are exempt", () => {
    const t = [
      trade({ id: 1, source: "propreports" }),
      trade({ id: 2, checklistRuns: 1 }),
      trade({ id: 3, setupScore: 0 }),
      trade({ id: 4, playbookId: 9 }),
      trade({ id: 5 }),
    ];
    const v = evalRule(rule("trade_without_checklist"), t);
    expect(ids(v)).toEqual([4, 5]);
    expect(v[0].message).toMatch(/по сетапу/);
    expect(v[1].message).toMatch(/без сетапа/);
  });
  it("unknown kind, empty trades, missing threshold", () => {
    expect(evalRule(rule("something_else"), trades)).toEqual([]);
    expect(evalRule(rule("max_trades_per_day"), [])).toEqual([]);
    expect(evalRule({ ...rule("no_swing"), threshold: undefined as unknown as Record<string, unknown> }, trades).length).toBe(1);
  });
});
