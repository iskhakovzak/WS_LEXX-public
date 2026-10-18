import { describe, expect, it } from "vitest";
import type { Candle } from "@/components/chart-engine/types";
import type { DeskDay, DeskLeg, DeskTrade, DeskTrader } from "../api";
import { TRADER_COLORS, buildMarkers, defaultFocus, initialWindow, pickTakeaways, traderColors } from "../model";

// 1-minute bars 09:30–10:29 ET on 2026-09-16 (EDT: 13:30Z).
const T0 = Date.parse("2026-09-16T13:30:00Z") / 1000;
const bars: Candle[] = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * 60, o: 100, h: 101, l: 99, c: 100.5, v: 1000 }));
const iso = (min: number, sec = 0) => new Date((T0 + min * 60 + sec) * 1000).toISOString();

const leg = (p: Partial<DeskLeg>): DeskLeg => ({
  role: "entry", price: 100, at: null, atEnd: null, opening: true, buy: true, pieces: 1, inferred: false,
  fraction: null, perShare: null, r: null, qty: null, realized: null, ...p,
});
const trade = (id: number, trader: string, legs: DeskLeg[]): DeskTrade => ({
  id, trader, side: "long", result: "win", r: 1, firstAt: legs[0]?.at ?? null, lastAt: legs[legs.length - 1]?.at ?? null, holdSec: 60,
  avgEntry: 100, avgExit: 101, stopPrice: null, stopHit: false, reentryIndex: 0, adds: 0, partials: 0, addedAgainst: false,
  fidelity: "fills", net: null, qty: null, redacted: true, legs,
});
const trader = (name: string, me = false): DeskTrader => ({
  name, alias: null, me, side: "long", trades: 1, result: "win", r: 1, firstAt: null, lastAt: null, holdSec: null, addedAgainst: false, net: null, redacted: !me,
});

describe("desk-day model", () => {
  const day: Pick<DeskDay, "trades" | "traders"> = {
    traders: [trader("A"), trader("B", true)],
    trades: [
      trade(1, "A", [leg({ at: iso(5, 30) }), leg({ role: "exit", opening: false, buy: false, at: iso(12), price: 101 })]),
      trade(2, "B", [leg({ at: iso(20) }), leg({ role: "stop", opening: false, buy: false, at: iso(90), price: 99 })]),
      trade(3, "B", [leg({ at: null })]),
    ],
  };
  const colors = traderColors(day.traders);

  it("colours follow legend order", () => {
    expect(colors.get("A")).toBe(TRADER_COLORS[0]);
    expect(colors.get("B")).toBe(TRADER_COLORS[1]);
  });

  it("markers land on the bar that contains the fill; legs outside the bars or without time are skipped", () => {
    const m = buildMarkers(day, bars, 60, colors);
    expect(m.map((x) => [x.key, x.idx])).toEqual([["1:0", 5], ["1:1", 12], ["2:0", 20]]);
    expect(m[0].color).toBe(TRADER_COLORS[0]);
    expect(buildMarkers(day, [], 60, colors)).toEqual([]);
  });

  it("initial window pads around the fills and clamps to the data", () => {
    const m = buildMarkers(day, bars, 60, colors);
    expect(initialWindow(m, bars.length, 10)).toEqual({ from: 0, to: 30 });
    expect(initialWindow([], bars.length)).toEqual({ from: 0, to: 59 });
    expect(initialWindow([], 0)).toEqual({ from: 0, to: 0 });
  });

  it("focus defaults to the viewer when they traded it", () => {
    expect(defaultFocus(day)).toEqual(["B"]);
    expect(defaultFocus({ traders: [trader("A")] })).toEqual([]);
  });

  it("takeaways: known kinds only, at most two", () => {
    const list = pickTakeaways([
      { kind: "averaging", losers: 3, averaged: 2 },
      { kind: "unknown" } as never,
      { kind: "sides", long: { traders: 1, winners: 1 }, short: { traders: 2, winners: 0 } },
      { kind: "averaging", losers: 1, averaged: 1 },
    ]);
    expect(list.map((x) => x.kind)).toEqual(["averaging", "sides"]);
  });
});
