import { describe, expect, it } from "vitest";
import {
  canSeeAggregateMoney, canSeeTradeMoney, equityByR, nullFields, redactEdgeStats, redactSlot, redactSummaryRow,
  redactTradeRow, redactTradeRows, redactUsdStats, type MoneyViewer,
} from "../playbookPrivacy";
import { computeEdge, computeUsdStats, type EdgeTrade } from "../playbookEdge";

const alex: MoneyViewer = { name: "Алекс", staff: false };
const curator: MoneyViewer = { name: "Ориф", staff: true };
const guest: MoneyViewer = { name: null, staff: false };

const example = {
  id: 7, tradeId: 42, tier: 1, note: "образцовый пробой", checklistMarks: { a: true }, mediaId: 3, addedBy: "Сеня",
  ticker: "NVDA", date: "2026-03-02", closeDate: "2026-03-02", side: "Long", result: "win",
  entry: 101.5, exit: 104.25, entryTime: "2026-03-02T14:41:00.000Z", exitTime: "2026-03-02T15:10:00.000Z",
  signedR: 2.4, horizon: "intraday", trader: "Сеня",
  netPnl: 268.4, pnl: 275, fees: -6.6, qty: 100,
};

describe("canSeeTradeMoney", () => {
  it("owner and staff see $, everyone else does not", () => {
    expect(canSeeTradeMoney(alex, "Алекс")).toBe(true);
    expect(canSeeTradeMoney(alex, "Сеня")).toBe(false);
    expect(canSeeTradeMoney(curator, "Сеня")).toBe(true);
    expect(canSeeTradeMoney(curator, null)).toBe(true);
  });

  it("no name / no owner never matches (guest, orphan trades)", () => {
    expect(canSeeTradeMoney(guest, "Сеня")).toBe(false);
    expect(canSeeTradeMoney(guest, null)).toBe(false);
    expect(canSeeTradeMoney(alex, null)).toBe(false);
    expect(canSeeTradeMoney({ name: "", staff: false }, "")).toBe(false);
  });
});

describe("redactTradeRow", () => {
  it("another trader's example: $ fields null, everything else kept, redacted: true", () => {
    const r = redactTradeRow(example, alex);
    expect(r.redacted).toBe(true);
    expect(r.netPnl).toBeNull();
    expect(r.pnl).toBeNull();
    expect(r.fees).toBeNull();
    expect(r.qty).toBeNull();
    // visible facts
    expect(r).toMatchObject({
      ticker: "NVDA", date: "2026-03-02", side: "Long", entry: 101.5, exit: 104.25, signedR: 2.4, tier: 1,
      note: "образцовый пробой", checklistMarks: { a: true }, mediaId: 3, addedBy: "Сеня", trader: "Сеня",
      entryTime: "2026-03-02T14:41:00.000Z", exitTime: "2026-03-02T15:10:00.000Z", result: "win",
    });
  });

  it("does not mutate the input row", () => {
    redactTradeRow(example, alex);
    expect(example.netPnl).toBe(268.4);
  });

  it("own trade and staff: untouched, redacted: false", () => {
    const own = redactTradeRow({ ...example, trader: "Алекс" }, alex);
    expect(own.redacted).toBe(false);
    expect(own.netPnl).toBe(268.4);
    const staff = redactTradeRow(example, curator);
    expect(staff.redacted).toBe(false);
    expect(staff.qty).toBe(100);
  });

  it("linked-trade shape: risk $, slippage and other $ keys are nulled too; absent keys are not added", () => {
    const row = { id: 1, trader: "Сеня", pnl: 50, fees: 1, netPnl: 49, riskUsd: 25, slippage: 0.4, qty: 10, rMultiple: 2, entry: 5, stop: 4.5 };
    const r = redactTradeRow(row, alex);
    expect(r).toMatchObject({ pnl: null, fees: null, netPnl: null, riskUsd: null, slippage: null, qty: null, rMultiple: 2, entry: 5, stop: 4.5 });
    expect("mfeUsd" in r).toBe(false);
  });

  it("guest sees no $ at all", () => {
    expect(redactTradeRows([example, { ...example, trader: null }], guest).every((r) => r.redacted && r.netPnl === null)).toBe(true);
  });
});

describe("aggregates", () => {
  const trades = [
    { id: 1, trader: "Алекс", result: "win", pnl: 120, fees: 2, rMultiple: 2, date: "2026-03-02", session: null, contextSnapshot: null, setupScore: null },
    { id: 2, trader: "Сеня", result: "loss", pnl: -60, fees: 2, rMultiple: -1, date: "2026-03-03", session: null, contextSnapshot: null, setupScore: null },
    { id: 3, trader: "Алекс", result: "win", pnl: 30, fees: 1, rMultiple: 0.5, date: "2026-03-03", session: null, contextSnapshot: null, setupScore: null },
  ] satisfies (EdgeTrade & { trader: string })[];

  it("$ visible only when every trade is own (or staff)", () => {
    expect(canSeeAggregateMoney(alex, trades.map((t) => t.trader))).toBe(false);
    expect(canSeeAggregateMoney(alex, ["Алекс", "Алекс"])).toBe(true);
    expect(canSeeAggregateMoney(alex, [])).toBe(true);
    expect(canSeeAggregateMoney(curator, trades.map((t) => t.trader))).toBe(true);
    expect(canSeeAggregateMoney(alex, ["Алекс", null])).toBe(false);
  });

  it("UsdStats: counts and win rate stay, every $ figure (incl. $ ratios) is null", () => {
    const u = redactUsdStats(computeUsdStats(trades));
    expect(u).toMatchObject({ n: 3, wins: 2, losses: 1, winrate: 0.6667 });
    for (const k of ["net", "expectancy", "avgWin", "avgLoss", "payoff", "profitFactor", "best", "worst"] as const) expect(u[k]).toBeNull();
  });

  it("EdgeStats: R-based stats stay, $ total / drawdown / fees are null", () => {
    const e = redactEdgeStats(computeEdge(trades));
    expect(e).toMatchObject({ count: 3, wins: 2, losses: 1, avgR: 0.5, rCount: 3, profitFactor: 2.5 });
    expect(e.totalPnl).toBeNull();
    expect(e.totalPnlGross).toBeNull();
    expect(e.maxDrawdown).toBeNull();
    expect(e.fees).toBeNull();
  });

  it("slot rows lose net / expectancy", () => {
    expect(redactSlot({ slot: "09:30", n: 4, net: 120, expectancy: 30, winrate: 0.75 })).toEqual({ slot: "09:30", n: 4, net: null, expectancy: null, winrate: 0.75 });
  });

  it("summary row: top-level $ and byHorizon.netPnl nulled, R / counts kept", () => {
    const row = {
      id: 5, tradeCount: 3, winrate: 0.66, avgR: 0.5, profitFactor: 2.5,
      netPnl: 87, grossPnl: 90, totalPnl: 87, expectancyUsd: 29, avgWinUsd: 73.5, avgLossUsd: -62, profitFactorUsd: 2.37,
      byHorizon: { intraday: { n: 3, wins: 2, losses: 1, winrate: 0.66, avgR: 0.5, netPnl: 87 } },
    };
    const r = redactSummaryRow(row);
    expect(r.redacted).toBe(true);
    expect(r).toMatchObject({ tradeCount: 3, winrate: 0.66, avgR: 0.5, profitFactor: 2.5, netPnl: null, grossPnl: null, totalPnl: null, expectancyUsd: null, avgWinUsd: null, avgLossUsd: null, profitFactorUsd: null });
    expect(r.byHorizon.intraday).toEqual({ n: 3, wins: 2, losses: 1, winrate: 0.66, avgR: 0.5, netPnl: null });
    expect(row.netPnl).toBe(87);
  });
});

describe("equityByR", () => {
  it("cumulates signed R by close day, skipping trades without R", () => {
    expect(equityByR([
      { closeDate: "2026-03-03", r: -1 },
      { closeDate: "2026-03-02", r: 2 },
      { closeDate: "2026-03-03", r: 0.5 },
      { closeDate: "2026-03-04", r: null },
    ])).toEqual([
      { day: "2026-03-02", r: 2, cum: 2 },
      { day: "2026-03-03", r: -0.5, cum: 1.5 },
    ]);
  });
});

describe("nullFields", () => {
  it("only touches listed keys that exist", () => {
    expect(nullFields({ a: 1, b: 2 }, ["a", "c"])).toEqual({ a: null, b: 2 });
  });
});
