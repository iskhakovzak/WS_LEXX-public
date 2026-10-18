import { describe, expect, it } from "vitest";
import { computeTradeQuality, effectiveBarRange, type QBar, type QFill, type QualityInput } from "../tradeQuality";

// Synthetic 1-minute bars. Day key: everything before T0 + 1 day is "2026-03-02".
const T0 = 1_000_000;
const DAY = 86_400;
const dayKeyOf = (t: number) => (t < T0 + DAY ? "2026-03-02" : "2026-03-03");
const bar = (i: number, o: number, h: number, l: number, c: number): QBar => ({ t: T0 + i * 60, o, h, l, c });

// Long book: entry 100 → +3 (bar 1) → −2 (bar 2) → exit 99 → next bar prints 100.
const LONG_BARS: QBar[] = [
  bar(0, 100, 101, 99.5, 100.5),
  bar(1, 100.5, 103, 100, 102),
  bar(2, 102, 102.5, 98, 99),
  bar(3, 99, 100, 98.5, 99.5),
  bar(4, 99.5, 99.8, 99, 99.2),
];
// Exact mirror around 100 (p → 200 − p) for the short.
const SHORT_BARS: QBar[] = LONG_BARS.map((b) => ({ t: b.t, o: 200 - b.o, h: 200 - b.l, l: 200 - b.h, c: 200 - b.c }));

const fill = (kind: QFill["kind"], price: number, order: number, t: number | null = null, qty: number | null = 100): QFill => ({ kind, price, qty, t, order });

function input(over: Partial<QualityInput>): QualityInput {
  return {
    side: "long", bars: LONG_BARS, interval: "1m", barSeconds: 60, fills: [], entry: null, exit: null, stop: null, qty: 100,
    riskUsd: null, atr: null, isOpen: false, tradeDate: "2026-03-02", exitDate: null, afterExitMinutes: 30, dayKeyOf, ...over,
  };
}

describe("effectiveBarRange (partial-bar rule)", () => {
  const b = bar(0, 100, 105, 95, 101);
  it("full range when the position spans the whole bar, when a fill is untimed, or when there are no fills", () => {
    expect(effectiveBarRange(b, 60, true, true, [{ price: 99, t: T0 + 10 }])).toEqual({ lo: { price: 95, at: T0 }, hi: { price: 105, at: T0 }, partial: false });
    expect(effectiveBarRange(b, 60, false, true, [{ price: 99, t: null }]).partial).toBe(false);
    expect(effectiveBarRange(b, 60, false, false, []).partial).toBe(false);
  });
  it("entry bar: fill → close; exit bar: open → fill; same bar: fill → fill", () => {
    expect(effectiveBarRange(b, 60, false, true, [{ price: 99, t: T0 + 10 }])).toEqual({ lo: { price: 99, at: T0 + 10 }, hi: { price: 101, at: T0 + 60 }, partial: true });
    expect(effectiveBarRange(b, 60, true, false, [{ price: 99, t: T0 + 50 }])).toEqual({ lo: { price: 99, at: T0 + 50 }, hi: { price: 100, at: T0 }, partial: true });
    expect(effectiveBarRange(b, 60, false, false, [{ price: 102, t: T0 + 10 }, { price: 98, t: T0 + 40 }])).toEqual({ lo: { price: 98, at: T0 + 40 }, hi: { price: 102, at: T0 + 10 }, partial: true });
  });
});

describe("computeTradeQuality — closed long, fills placed by price", () => {
  const q = computeTradeQuality(input({ fills: [fill("entry", 100, 0), fill("exit", 99, 1)], stop: 99 }));

  it("MFE / MAE with time, bars and $", () => {
    expect(q.mfe).toEqual({ perShare: 3, r: 3, usd: 300, at: T0 + 60, seconds: 60, minutes: 1, bars: 1, price: 103 });
    expect(q.mae).toEqual({ perShare: 2, r: 2, usd: 200, at: T0 + 120, seconds: 120, minutes: 2, bars: 2, price: 98 });
  });
  it("captured, efficiencies, hold", () => {
    expect(q.captured).toEqual({ perShare: -1, r: -1, usd: -100 });
    expect(q.exitEfficiency).toBe(-0.3333);
    expect(q.rangeEfficiency).toBe(0.2); // (99 − 98) / (103 − 98)
    expect(q.entryEfficiency).toBe(0.6667); // (101 − 100) / (101 − 99.5)
    expect([q.entryAt, q.exitAt, q.holdSeconds, q.holdMinutes]).toEqual([T0, T0 + 120, 180, 3]);
    expect([q.avgEntry, q.avgExit, q.riskPerShare, q.riskSource, q.qty, q.qtyAssumed]).toEqual([100, 99, 1, "stop", 100, false]);
  });
  it("left on the table after the exit (same day, within the window)", () => {
    expect(q.leftOnTable).toEqual({ perShare: 1, r: 1, usd: 100, windowMinutes: 30, bars: 2, bestPrice: 100, at: T0 + 180, toCloseOfDay: 1 });
  });
  it("heat before +1R, stop in day-range ATR, status", () => {
    expect(q.heat).toEqual({ perShare: 0.5, r: 0.5, usd: 50, workedAtSeconds: 0, workedAtMinutes: 0, threshold: "1R" });
    expect(q.stopAtr).toEqual({ atr: 5, source: "dayRange", distanceAtr: 0.2 });
    expect(q.gaps).toBeNull();
    expect(q.unrealised).toBeNull();
    expect(q.status).toBe("ok");
    expect(q.reasons).toEqual(["fills_placed_by_price", "atr_from_day_range"]);
    expect([q.placement, q.timedFills, q.fillsUsed, q.barsUsed]).toEqual(["price", false, 2, 5]);
  });
});

describe("computeTradeQuality — short mirror gives identical numbers", () => {
  const q = computeTradeQuality(input({ side: "short", bars: SHORT_BARS, fills: [fill("entry", 100, 0), fill("exit", 101, 1)], stop: 101 }));
  it("mirrors the long book", () => {
    expect(q.mfe).toMatchObject({ perShare: 3, r: 3, usd: 300, price: 97, bars: 1 });
    expect(q.mae).toMatchObject({ perShare: 2, r: 2, usd: 200, price: 102, bars: 2 });
    expect(q.captured).toEqual({ perShare: -1, r: -1, usd: -100 });
    expect(q.exitEfficiency).toBe(-0.3333);
    expect(q.rangeEfficiency).toBe(0.2);
    expect(q.entryEfficiency).toBe(0.6667);
    expect(q.leftOnTable).toMatchObject({ perShare: 1, r: 1, usd: 100, bestPrice: 100 });
    expect(q.heat).toMatchObject({ perShare: 0.5, r: 0.5 });
    expect(q.stopAtr).toEqual({ atr: 5, source: "dayRange", distanceAtr: 0.2 });
  });
});

describe("computeTradeQuality — timed fills use partial bars", () => {
  const q = computeTradeQuality(input({ fills: [fill("entry", 100, 0, T0 + 30), fill("exit", 99, 1, T0 + 150)], stop: 99 }));
  it("entry bar counts fill→close, exit bar open→fill; times are fill-to-fill", () => {
    expect(q.mfe).toMatchObject({ perShare: 3, at: T0 + 60, seconds: 30, bars: 1 });
    expect(q.mae).toMatchObject({ perShare: 1, at: T0 + 150, seconds: 120, bars: 2, price: 99 }); // bar-2 low (98) printed before? no — after the fill: not ours
    expect(q.rangeEfficiency).toBe(0); // exit 99 is the worst certain point (lo 99 … hi 103)
    expect([q.entryAt, q.exitAt, q.holdSeconds, q.holdMinutes]).toEqual([T0 + 30, T0 + 150, 120, 2]);
    expect(q.heat).toMatchObject({ perShare: 0, workedAtSeconds: 30, threshold: "1R" });
    expect([q.placement, q.timedFills, q.status]).toEqual(["time", true, "ok"]);
    expect(q.reasons).toEqual(["atr_from_day_range"]);
  });
  it("entry and exit inside one bar: fill-to-fill only and flagged coarse", () => {
    const c = computeTradeQuality(input({ fills: [fill("entry", 100, 0, T0 + 10), fill("exit", 100.5, 1, T0 + 40)], stop: 99 }));
    expect(c.mfe).toMatchObject({ perShare: 0.5, seconds: 30 });
    expect(c.mae).toMatchObject({ perShare: 0 });
    expect(c.holdSeconds).toBe(30);
    expect(c.status).toBe("partial");
    expect(c.reasons).toContain("coarse_bars");
  });
});

describe("computeTradeQuality — multi-day and open positions", () => {
  it("overnight gap is reported with its R", () => {
    const bars: QBar[] = [
      bar(0, 100, 101, 99, 100), bar(1, 100, 100.5, 99.5, 100),
      { t: T0 + DAY, o: 97, h: 98, l: 96, c: 97.5 }, { t: T0 + DAY + 60, o: 97.5, h: 98, l: 97, c: 97 },
    ];
    const q = computeTradeQuality(input({ bars, fills: [fill("entry", 100, 0), fill("exit", 97, 1)], stop: 98, exitDate: "2026-03-03" }));
    expect(q.gaps).toEqual({ count: 1, worstPerShare: -3, worstR: -1.5, list: [{ day: "2026-03-03", perShare: -3, r: -1.5 }] });
    expect(q.mae).toMatchObject({ perShare: 4, r: 2 });
    expect(q.captured).toEqual({ perShare: -3, r: -1.5, usd: -300 });
    expect(q.exitAt).toBe(T0 + DAY);
  });

  it("open position: unrealised mark-to-last-bar, partial status", () => {
    const q = computeTradeQuality(input({ bars: LONG_BARS.slice(0, 3), fills: [fill("entry", 100, 0)], stop: 99, isOpen: true }));
    expect(q.status).toBe("partial");
    expect(q.reasons).toContain("open_position");
    expect(q.captured).toBeNull();
    expect(q.unrealised).toEqual({ perShare: -1, r: -1, usd: -100 });
    expect(q.exitAt).toBeNull();
    expect(q.holdSeconds).toBe(180);
    expect(q.exitEfficiency).toBeNull();
    expect(q.leftOnTable).toBeNull();
  });

  it("scale-in / scale-out: average cost and realised $", () => {
    const q = computeTradeQuality(input({
      fills: [fill("entry", 100, 0, null, 100), fill("add", 102, 1, null, 100), fill("trim", 102.5, 2, null, 100), fill("exit", 99, 3, null, 100)],
      stop: 98,
    }));
    // add placed in bar 1 (102 ∈ [100,103]); avg 101. trim 102.5 in bar 2 → +1.5×100; exit 99 in bar 2 → −2×100.
    expect([q.avgEntry, q.avgExit, q.qty]).toEqual([101, 100.75, 100]);
    expect(q.captured).toEqual({ perShare: -0.25, r: -0.08, usd: -50 });
  });
});

describe("computeTradeQuality — degraded inputs", () => {
  it("no bars → unavailable", () => {
    const q = computeTradeQuality(input({ bars: [], entry: 100, exit: 99 }));
    expect([q.status, q.reasons, q.mfe, q.captured]).toEqual(["unavailable", ["no_bars"], null, null]);
  });
  it("no fills and no entry → no_entry; fills synthesised from entry/exit otherwise", () => {
    expect(computeTradeQuality(input({})).reasons).toEqual(["no_entry"]);
    const q = computeTradeQuality(input({ entry: 100, exit: 99, stop: 99 }));
    expect(q.captured).toEqual({ perShare: -1, r: -1, usd: -100 });
    expect(q.fillsUsed).toBe(2);
  });
  it("fills without qty: unit-weighted, $ scaled by trade qty", () => {
    const q = computeTradeQuality(input({ fills: [fill("entry", 100, 0, null, null), fill("exit", 99, 1, null, null)], stop: 99, qty: 200 }));
    expect(q.qtyAssumed).toBe(true);
    expect(q.reasons).toContain("qty_assumed");
    expect(q.captured).toEqual({ perShare: -1, r: -1, usd: -200 });
    expect(q.mfe?.usd).toBe(600);
    expect(q.qty).toBe(200);
    const noQty = computeTradeQuality(input({ fills: [fill("entry", 100, 0, null, null), fill("exit", 99, 1, null, null)], stop: 99, qty: null }));
    expect(noQty.captured).toEqual({ perShare: -1, r: -1, usd: null });
  });
  it("risk: stop first, riskUsd/qty second, else no R", () => {
    const viaRisk = computeTradeQuality(input({ fills: [fill("entry", 100, 0), fill("exit", 99, 1)], stop: null, riskUsd: 150 }));
    expect([viaRisk.riskPerShare, viaRisk.riskSource]).toEqual([1.5, "riskUsd"]);
    expect(viaRisk.reasons).toContain("no_stop");
    expect(viaRisk.captured?.r).toBe(-0.67);
    const stopAtEntry = computeTradeQuality(input({ fills: [fill("entry", 100, 0), fill("exit", 99, 1)], stop: 100 }));
    expect([stopAtEntry.riskPerShare, stopAtEntry.captured?.r, stopAtEntry.stopAtr]).toEqual([null, null, null]);
    expect(stopAtEntry.reasons).toContain("no_risk");
    expect(stopAtEntry.heat?.threshold).toBe("mfe");
  });
  it("ATR from the trade beats the day range", () => {
    const q = computeTradeQuality(input({ fills: [fill("entry", 100, 0), fill("exit", 99, 1)], stop: 99, atr: 2.5 }));
    expect(q.stopAtr).toEqual({ atr: 2.5, source: "trade", distanceAtr: 0.4 });
    expect(q.reasons).not.toContain("atr_from_day_range");
  });
  it("no bars after the exit → partial", () => {
    const q = computeTradeQuality(input({ bars: LONG_BARS.slice(0, 3), fills: [fill("entry", 100, 0), fill("exit", 99, 1)], stop: 99 }));
    expect(q.leftOnTable).toBeNull();
    expect(q.reasons).toContain("no_bars_after_exit");
    expect(q.status).toBe("partial");
  });
  it("exit price outside every bar → exit_not_in_bars (nearest bar by midpoint)", () => {
    const q = computeTradeQuality(input({ fills: [fill("entry", 100, 0), fill("exit", 90, 1)], stop: 99 }));
    expect(q.reasons).toContain("exit_not_in_bars");
    expect(q.status).toBe("partial");
  });
});
