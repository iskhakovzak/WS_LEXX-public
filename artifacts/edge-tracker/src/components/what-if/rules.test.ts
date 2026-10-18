import { describe, expect, it } from "vitest";
import {
  type PreviewTrade, type Rule, chipLabel, decodeRules, encodeRules, ifNotPhrase, isApplied, mergeRule, planSummary, previewRule, recomputeFees, removeRule, subtractRule,
} from "./rules";

const mk = (id: number, day: string, entryMin: number, gross: number, extra: Partial<PreviewTrade> = {}): PreviewTrade => ({
  id, day, entryMin, ticker: "AAA", side: "long", qty: 100, entry: 10, gross, fees: 0, holdSec: 60, seq: id, ...extra,
});

const trades: PreviewTrade[] = [
  mk(1, "2026-01-02", 600, -50, { holdSec: 120 }), // loss closes at 602
  mk(2, "2026-01-02", 603, 30), // 1 min after the loss
  mk(3, "2026-01-02", 610, 20, { ticker: "BBB" }), // 8 min after
  mk(4, "2026-01-03", 570, 10, { qty: 500, entry: 3 }),
  mk(5, "2026-01-03", 900, -10, { qty: 50, side: "short", holdSec: 30 }),
];

describe("scenario list", () => {
  it("merges bounds of the same type and replaces the rest", () => {
    let rs: Rule[] = [];
    rs = mergeRule(rs, { type: "timeWindow", from: "09:45", to: null });
    rs = mergeRule(rs, { type: "timeWindow", from: null, to: "15:00" });
    expect(rs).toEqual([{ type: "timeWindow", from: "09:45", to: "15:00" }]);
    rs = mergeRule(rs, { type: "excludeTickers", tickers: ["amd"] });
    rs = mergeRule(rs, { type: "excludeTickers", tickers: ["TSLA", "AMD"] });
    expect(rs[1]).toEqual({ type: "excludeTickers", tickers: ["AMD", "TSLA"] });
    rs = mergeRule(rs, { type: "minHold", seconds: 120 });
    rs = mergeRule(rs, { type: "minHold", seconds: 300 });
    expect(rs.filter((r) => r.type === "minHold")).toEqual([{ type: "minHold", seconds: 300 }]);
  });

  it("subtracts only the part a suggestion added", () => {
    const rs: Rule[] = [{ type: "timeWindow", from: "09:45", to: "15:00" }, { type: "excludeTickers", tickers: ["AMD", "TSLA"] }];
    expect(subtractRule(rs, { type: "timeWindow", to: "15:00" })[0]).toEqual({ type: "timeWindow", from: "09:45", to: null });
    expect(subtractRule(rs, { type: "excludeTickers", tickers: ["AMD"] })[1]).toEqual({ type: "excludeTickers", tickers: ["TSLA"] });
    expect(subtractRule([{ type: "minHold", seconds: 300 }], { type: "minHold", seconds: 300 })).toEqual([]);
    expect(removeRule(rs, "timeWindow")).toHaveLength(1);
  });

  it("knows when a suggestion is already applied", () => {
    const rs: Rule[] = [{ type: "timeWindow", from: "09:45", to: "15:00" }];
    expect(isApplied(rs, { type: "timeWindow", to: "15:00" })).toBe(true);
    expect(isApplied(rs, { type: "timeWindow", to: "14:00" })).toBe(false);
    expect(isApplied([], { type: "afterLoss", minutes: 5 })).toBe(false);
  });

  it("phrases rules in Russian", () => {
    expect(ifNotPhrase({ type: "minHold", seconds: 300 })).toBe("Если бы ты не закрывал сделки быстрее 5 мин");
    expect(ifNotPhrase({ type: "excludeTickers", tickers: ["AMD"] })).toBe("Если бы ты не торговал AMD");
    expect(chipLabel({ type: "sizeRange", max: 200 })).toBe("Без позиций больше 200 акц.");
    expect(chipLabel({ type: "afterLoss", minutes: 10 })).toBe("Пауза 10 мин после убытка");
  });
});

describe("URL state", () => {
  it("round-trips rules, including Cyrillic-free base64url", () => {
    const rs: Rule[] = [{ type: "minHold", seconds: 300 }, { type: "excludeTickers", tickers: ["AMD"] }, { type: "commissionPlan", perShare: 0.003, minPerOrder: 0.5, ecnPerShare: 0.002, keepRegulatory: true }];
    const s = encodeRules(rs);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRules(s)).toEqual(rs);
    expect(encodeRules([])).toBe("");
  });

  it("drops garbage instead of throwing", () => {
    expect(decodeRules("%%%")).toEqual([]);
    expect(decodeRules(null)).toEqual([]);
    const bad = encodeRules([{ type: "minHold", seconds: -5 } as Rule, { type: "nope" } as unknown as Rule, { type: "timeWindow", from: "25:99" } as Rule, { type: "dailyLossLimit", usd: 200 }]);
    expect(decodeRules(bad)).toEqual([{ type: "dailyLossLimit", usd: 200 }]);
  });
});

describe("live preview (mirror of the engine)", () => {
  it("counts static exclusions and their net", () => {
    expect(previewRule(trades, { type: "excludeTickers", tickers: ["bbb"] })).toMatchObject({ affected: 1, net: 20, effect: -20, total: 5 });
    expect(previewRule(trades, { type: "timeWindow", from: "09:45" })).toMatchObject({ affected: 1, net: 10 });
    expect(previewRule(trades, { type: "sizeRange", max: 200 })).toMatchObject({ affected: 1, net: 10 });
    expect(previewRule(trades, { type: "excludeSide", side: "short" })).toMatchObject({ affected: 1, net: -10, effect: 10 });
    expect(previewRule(trades, { type: "minHold", seconds: 45 })).toMatchObject({ affected: 1 });
  });

  it("applies the after-loss pause within the day only", () => {
    expect(previewRule(trades, { type: "afterLoss", minutes: 5 })).toMatchObject({ affected: 1, net: 30, effect: -30 });
    expect(previewRule(trades, { type: "afterLoss", minutes: 10 })).toMatchObject({ affected: 2, net: 50 });
  });

  it("stops the day on a loss limit / trade count", () => {
    expect(previewRule(trades, { type: "dailyLossLimit", usd: 40 })).toMatchObject({ affected: 2, net: 50 });
    expect(previewRule(trades, { type: "maxTradesPerDay", n: 1 })).toMatchObject({ affected: 3 });
  });

  it("caps losses as an estimate", () => {
    expect(previewRule(trades, { type: "capLoss", usd: 20 })).toMatchObject({ affected: 1, effect: 30 });
  });
});

describe("fee plans", () => {
  it("uses the server formula (orders from fills, min per order, ECN, regulatory kept)", () => {
    const t = mk(1, "2026-01-02", 600, 5, { qty: 100, fills: 2, fees: 1, feeBreakdown: { comm: 0.6, sec: 0.02, taf: 0.01 } });
    // 2 orders × max(0.5, 0.003×100) = 1.00; ECN 0.002×200 = 0.40; regulatory 0.03
    expect(recomputeFees(t, { perShare: 0.003, minPerOrder: 0.5, ecnPerShare: 0.002, keepRegulatory: true })).toBe(1.43);
    expect(recomputeFees(t, { perShare: 0.003, minPerOrder: 0.5, ecnPerShare: 0.002, keepRegulatory: false })).toBe(1.4);
    expect(recomputeFees({ ...t, qty: null }, { perShare: 0.003, minPerOrder: 0.5, ecnPerShare: 0 })).toBeNull();
  });

  it("summarises the actual fees and the break-even move per share", () => {
    const ts = [mk(1, "d", 1, 10, { fees: 2, qty: 100 }), mk(2, "d", 2, -4, { fees: 1, qty: 200 })];
    const s = planSummary(ts, null);
    expect(s).toMatchObject({ fees: 3, gross: 6, net: 3, shares: 300, trades: 2, breakEvenCents: 1 });
    expect(s.feePctOfGross).toBeCloseTo(0.5);
  });
});
