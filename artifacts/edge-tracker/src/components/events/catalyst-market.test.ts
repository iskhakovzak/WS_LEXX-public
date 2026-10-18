import { describe, expect, it } from "vitest";
import { marketReporters, reactionOf } from "./catalyst-market";
import type { CatalystData } from "./use-catalysts";

const item = (ticker: string, callType: "BMO" | "AMC" | "TNS", cap: number, extra: Record<string, unknown> = {}) => ({
  ticker, company: `${ticker} Inc.`, callType, epsEstimate: null, marketCap: null, marketCapNum: cap, fiscalQuarter: null,
  noOfEsts: null, lastYearEps: null, lastYearDate: null, epsActual: null, epsSurprisePct: null, price: null, priceMoveDay: null,
  pricePreMarket: null, pricePostMarket: null, volume: null, avgVolume: null, relVol: null, ...extra,
});

function fake(over: Partial<{ myTickers: string[]; watch: unknown; upcoming: unknown }>): CatalystData {
  return {
    myTickers: over.myTickers ?? [],
    watch: { data: over.watch ?? null },
    upcoming: { data: over.upcoming ?? null },
  } as unknown as CatalystData;
}

describe("marketReporters", () => {
  const day = "2026-10-19";
  const prev = "2026-10-16";
  it("takes the previous session's AMC only, the day's BMO/TNS, skips my tickers, biggest first", () => {
    const data = fake({
      myTickers: ["NFLX"],
      watch: { date: "2026-10-17", amcDate: prev, bmo: [], amc: [item("HOST", "TNS", 7e7), item("NFLX", "AMC", 4e11), item("ISRG", "AMC", 2e11, { pricePostMarket: 6.2 })] },
      upcoming: { days: [{ date: day, total: 3, items: [item("FITB", "BMO", 4.5e10), item("SMMT", "TNS", 1.2e10), item("STLD", "AMC", 3.4e10)] }] },
    });
    const r = marketReporters(data, day, prev);
    expect(r.open.map((e) => e.ticker)).toEqual(["ISRG", "FITB", "SMMT"]);
    expect(r.open[0].pricePostMarket).toBe(6.2);
    expect(r.after.map((e) => e.ticker)).toEqual(["STLD"]);
  });
  it("prefers the watch feed's BMO list (with premarket) for today", () => {
    const data = fake({
      watch: { date: day, amcDate: prev, bmo: [item("FITB", "BMO", 4.5e10, { pricePreMarket: -3.1 })], amc: [] },
      upcoming: { days: [{ date: day, total: 1, items: [item("FITB", "BMO", 4.5e10)] }] },
    });
    const r = marketReporters(data, day, prev);
    expect(r.open).toHaveLength(1);
    expect(reactionOf(r.open[0])).toEqual({ kind: "pre", label: "пре", pct: -3.1 });
  });
});

describe("reactionOf", () => {
  it("premarket beats after-hours; nothing → null", () => {
    expect(reactionOf({ pricePreMarket: 2, pricePostMarket: 5 })).toEqual({ kind: "pre", label: "пре", pct: 2 });
    expect(reactionOf({ pricePreMarket: null, pricePostMarket: -4 })).toEqual({ kind: "post", label: "после закр.", pct: -4 });
    expect(reactionOf({ pricePreMarket: null, pricePostMarket: null })).toBeNull();
  });
});
