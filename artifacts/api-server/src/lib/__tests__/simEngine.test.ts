import { describe, it, expect } from "vitest";
import { simulate, resultOf, mistakesOf, orderDelta, maxDrawdown, type SimBar, type SimConfig, type SimEvent } from "../sim/engine";

/** Flat bars at `c` unless overridden: [o, h, l, c]. */
function bars(spec: ([number, number, number, number] | number)[]): SimBar[] {
  return spec.map((s, i) => {
    const [o, h, l, c] = typeof s === "number" ? [s, s, s, s] : s;
    return { t: 1000 + i * 60, o, h, l, c, v: 100 };
  });
}

const cfg = (over: Partial<SimConfig> = {}): SimConfig => ({ startIdx: 0, endIdx: 9, feePerShare: 0.005, riskUnit: 1, ...over });
let seq = 0;
const order = (idx: number, kind: "buy" | "sell" | "flat", qty = 100, req?: number): SimEvent => ({ seq: ++seq, idx, type: "order", kind, qty, req });
const bracket = (idx: number, stop: number | null, target: number | null = null): SimEvent => ({ seq: ++seq, idx, type: "bracket", stop, target });

describe("sim engine — fills and fees", () => {
  it("fills at the close and charges the fee per share on every fill", () => {
    const b = bars([10, 10, 11, 12, 12, 12, 12, 12, 12, 12]);
    const s = simulate(b, cfg(), [order(0, "buy", 100), order(3, "flat")], 9);
    expect(s.fills.map((f) => [f.idx, f.price, f.qty, f.reason])).toEqual([[0, 10, 100, "buy"], [3, 12, 100 * -1, "flat"]]);
    expect(s.fees).toBe(1); // 200 shares × $0.005
    expect(s.realized).toBe(200);
    expect(s.net).toBe(199);
    expect(s.trades).toHaveLength(1);
    expect(s.trades[0]).toMatchObject({ side: "long", entryAvg: 10, exitAvg: 12, gross: 200, fees: 1, net: 199, riskPerShare: 1, r: 1.99 });
  });

  it("averages adds, realises partials and flips into a new trade", () => {
    const b = bars([10, 12, 11, 13, 13, 13, 13, 13, 13, 13]);
    const s = simulate(b, cfg({ feePerShare: 0 }), [order(0, "buy", 100), order(1, "buy", 100), order(2, "sell", 300), order(3, "flat")], 9);
    // avg 11 after the add; selling 300 at 11 closes 200 flat (0) and opens a 100 short at 11; covered at 13 → −200.
    expect(s.trades).toHaveLength(2);
    expect(s.trades[0]).toMatchObject({ side: "long", entryAvg: 11, maxQty: 200, adds: 1, gross: 0, exitReason: "sell" });
    expect(s.trades[1]).toMatchObject({ side: "short", entryAvg: 11, gross: -200, exitReason: "flat" });
    expect(s.pos).toBe(0);
    expect(s.realized).toBe(-200);
  });

  it("marks an open position at the cursor close", () => {
    const b = bars([10, 11, 9]);
    const s = simulate(b, cfg({ endIdx: 2, feePerShare: 0 }), [order(0, "sell", 50)], 1);
    expect(s.pos).toBe(-50);
    expect(s.unrealized).toBe(-50);
    expect(s.trades[0].closeIdx).toBeNull();
    expect(s.trades[0].r).toBe(-1); // −$50 / (1 × 50)
  });

  it("flat with no position does nothing; orderDelta flattens either side", () => {
    expect(orderDelta("flat", 0, -30)).toBe(30);
    expect(orderDelta("sell", 20.7, 0)).toBe(-20);
    const s = simulate(bars([10, 10]), cfg({ endIdx: 1 }), [order(0, "flat")], 1);
    expect(s.fills).toHaveLength(0);
  });
});

describe("sim engine — brackets", () => {
  it("stop fills at the stop from the next bar on, at the open when the bar gaps through", () => {
    const b = bars([10, [10, 10.2, 9.5, 9.6], 9]);
    const s = simulate(b, cfg({ endIdx: 2, feePerShare: 0 }), [order(0, "buy", 100), bracket(0, 9.7)], 2);
    expect(s.fills[1]).toMatchObject({ idx: 1, price: 9.7, reason: "stop" });
    expect(s.trades[0].riskPerShare).toBeCloseTo(0.3);
    expect(s.trades[0].r).toBe(-1);
    const gap = bars([10, [9.0, 9.2, 8.8, 9.1]]);
    const g = simulate(gap, cfg({ endIdx: 1, feePerShare: 0 }), [order(0, "buy", 10), bracket(0, 9.7)], 1);
    expect(g.fills[1]).toMatchObject({ price: 9, reason: "stop" });
  });

  it("is not checked on the bar it was set (decided at that close)", () => {
    const b = bars([[10, 10, 9, 10], 10]);
    const s = simulate(b, cfg({ endIdx: 1 }), [order(0, "buy", 10), bracket(0, 9.5)], 1);
    expect(s.pos).toBe(10);
  });

  it("stop wins when both stop and target are inside one bar; target fills otherwise", () => {
    const both = simulate(bars([10, [10, 11.5, 8.5, 10]]), cfg({ endIdx: 1, feePerShare: 0 }), [order(0, "buy", 1), bracket(0, 9, 11)], 1);
    expect(both.fills[1].reason).toBe("stop");
    const tgt = simulate(bars([10, [10, 11.5, 9.5, 11]]), cfg({ endIdx: 1, feePerShare: 0 }), [order(0, "sell", 1), bracket(0, 11.8, 9.6)], 1);
    expect(tgt.fills[1]).toMatchObject({ price: 9.6, reason: "target" });
  });

  it("floors a tiny stop at a quarter of the risk unit so R cannot be inflated", () => {
    const s = simulate(bars([10, 12]), cfg({ endIdx: 1, feePerShare: 0, riskUnit: 1 }), [order(0, "buy", 100), bracket(0, 9.99), order(1, "flat")], 1);
    expect(s.trades[0].riskPerShare).toBe(0.25);
    expect(s.trades[0].r).toBe(8);
  });
});

describe("sim engine — result, buy & hold, mistakes", () => {
  it("compares with buy & hold of the base size over the same bars, fees included", () => {
    const b = bars([10, 10, 10, 10, 10, 10, 10, 10, 10, 11]);
    const st = simulate(b, cfg(), [order(0, "sell", 100), order(9, "flat")], 9);
    const r = resultOf(b, cfg(), st, { baseQty: 100, lookAhead: 5, overtrading: 8 });
    expect(r.bh).toEqual({ entry: 10, exit: 11, qty: 100, net: 99, pct: 9.9 });
    expect(r.net).toBe(-101);
    expect(r.pct).toBe(-10.1);
    expect(r.vsBh).toBe(-20);
    expect(r.beatBh).toBe(false);
  });

  it("flags a held loser, a cut winner, adding to a loser, no stop and overtrading", () => {
    const b = bars([10, 9, 8, 8, 9, 10, 12, 13, 13, 13]);
    const c = cfg({ feePerShare: 0 });
    const st = simulate(b, c, [order(0, "buy", 10), order(1, "buy", 10), order(2, "flat"), order(4, "buy", 10), order(5, "flat")], 9);
    const m = mistakesOf(b, c, st.trades, { lookAhead: 5, overtrading: 1 });
    const kinds = m.map((x) => `${x.kind}:${x.trade}`);
    expect(kinds).toContain("heldLoser:1"); // avg 9.5 → 8 = −1.5R
    expect(kinds).toContain("addedToLoser:1");
    expect(kinds).toContain("noStop:1");
    expect(kinds).toContain("cutWinner:2"); // out at 10, then 13 (+3R)
    expect(kinds).toContain("overtrading:null");
  });

  it("max drawdown from the equity peak", () => {
    expect(maxDrawdown([0, 50, 20, 80, 10, 30])).toBe(70);
  });
});
