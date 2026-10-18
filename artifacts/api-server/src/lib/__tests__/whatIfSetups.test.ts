import { describe, expect, it } from "vitest";
import { computeMetrics, describeRule, gradeRank, runScenario, suggestionGrid, worstSetups, type SimTrade } from "../whatIf";

let seq = 0;
function t(p: Partial<SimTrade> & { gross: number }): SimTrade {
  seq++;
  return {
    id: seq, day: "2026-10-01", entryMin: 600 + seq, ticker: "AAA", side: "long", qty: 100, entry: 10, exit: 11,
    fees: 0, holdSec: 60, r: null, stop: null, setup: null, tags: [], horizon: "intraday", result: null, seq, ...p,
  };
}

describe("gradeRank", () => {
  it("ranks A+ best and ignores unknown values", () => {
    expect(gradeRank("A+")).toBe(0);
    expect(gradeRank(" c ")).toBe(3);
    expect(gradeRank("Z")).toBeNull();
    expect(gradeRank(null)).toBeNull();
  });
});

describe("excludeSetups", () => {
  it("drops trades of the listed setups (case-insensitive) and keeps unlabelled ones", () => {
    const trades = [t({ gross: -50, setup: "Gap fade" }), t({ gross: 30, setup: "ORB" }), t({ gross: 10 })];
    const r = runScenario(trades, [{ type: "excludeSetups", setups: ["gap FADE"] }], { bootstrap: false });
    expect(r.scenario.trades).toBe(2);
    expect(r.scenario.net).toBe(40);
    expect(r.excluded.map((e) => e.reason)).toEqual(["excludeSetups"]);
    expect(r.skipped).toEqual([]);
  });
  it("is skipped with a reason when no trade has a setup", () => {
    const r = runScenario([t({ gross: 5 })], [{ type: "excludeSetups", setups: ["ORB"] }], { bootstrap: false });
    expect(r.skipped[0]).toMatchObject({ rule: "excludeSetups" });
    expect(r.scenario.trades).toBe(1);
  });
});

describe("minGrade", () => {
  it("keeps only trades graded at least the minimum; ungraded trades are dropped", () => {
    const trades = [t({ gross: 40, grade: "A+" }), t({ gross: 10, grade: "A" }), t({ gross: -30, grade: "C" }), t({ gross: -5 })];
    const onlyAPlus = runScenario(trades, [{ type: "minGrade", grade: "A+" }], { bootstrap: false });
    expect(onlyAPlus.scenario.trades).toBe(1);
    expect(onlyAPlus.excluded.map((e) => e.detail)).toEqual(["оценка A", "оценка C", "без оценки"]);
    const aOrBetter = runScenario(trades, [{ type: "minGrade", grade: "A" }], { bootstrap: false });
    expect(aOrBetter.scenario.net).toBe(50);
  });
  it("is skipped when nothing is graded", () => {
    const r = runScenario([t({ gross: 5 })], [{ type: "minGrade", grade: "A+" }], { bootstrap: false });
    expect(r.skipped[0]).toMatchObject({ rule: "minGrade" });
    expect(r.scenario.trades).toBe(1);
  });
  it("has a plain-language label", () => {
    expect(describeRule({ type: "minGrade", grade: "A+" })).toBe("Только сделки A+");
    expect(describeRule({ type: "excludeSetups", setups: ["ORB", "VWAP"] })).toBe("Без сетапов: ORB, VWAP");
  });
});

describe("R totals", () => {
  it("sums R over trades that have it", () => {
    const m = computeMetrics([t({ gross: 10, r: 1.5 }), t({ gross: -5, r: -1 }), t({ gross: 3 })]);
    expect(m.totalR).toBe(0.5);
    expect(m.rCount).toBe(2);
    expect(computeMetrics([t({ gross: 1 })]).totalR).toBeNull();
  });
});

describe("worstSetups", () => {
  it("returns the worst losing setup, then the worst two, only with enough trades", () => {
    const trades: SimTrade[] = [];
    for (let i = 0; i < 10; i++) trades.push(t({ gross: -10, setup: "Fade" }), t({ gross: -3, setup: "Chase" }), t({ gross: 5, setup: "ORB" }));
    trades.push(t({ gross: -500, setup: "Rare" }));
    expect(worstSetups(trades)).toEqual([["Fade"], ["Fade", "Chase"]]);
    expect(suggestionGrid(trades).filter((r) => r.type === "excludeSetups")).toHaveLength(2);
    expect(worstSetups([t({ gross: -1 })])).toEqual([]);
  });
});
