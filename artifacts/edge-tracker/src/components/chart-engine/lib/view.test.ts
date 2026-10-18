import { describe, expect, it } from "vitest";
import { capVolumes, daySpanOf, defaultViewRange, followCursor } from "./view";
import { pushHistory, type TrainingRecord } from "./training-sim";

describe("default view", () => {
  it("frames the trade with a lead-in of at least 30 bars", () => {
    expect(defaultViewRange({ count: 900, entryIdx: 400, exitIdx: 410, dayRange: null })).toEqual({ from: 370, to: 430 });
    expect(defaultViewRange({ count: 900, entryIdx: 300, exitIdx: 500, dayRange: null })).toEqual({ from: 180, to: 600 });
  });
  it("falls back to the session, then to the tail", () => {
    expect(defaultViewRange({ count: 900, entryIdx: null, exitIdx: null, dayRange: { from: 330, to: 719 } })).toEqual({ from: 325, to: 724 });
    expect(defaultViewRange({ count: 50, entryIdx: null, exitIdx: null, dayRange: null })).toEqual({ from: 0, to: 55 });
    expect(defaultViewRange({ count: 0, entryIdx: null, exitIdx: null, dayRange: null })).toBeNull();
  });
});

describe("full-day view", () => {
  it("frames every bar of the trade day(s) in day mode and the trade window in trade mode", () => {
    const daySpan = { from: 0, to: 959 };
    expect(defaultViewRange({ count: 960, entryIdx: 400, exitIdx: 410, dayRange: { from: 330, to: 719 }, daySpan, mode: "day" })).toEqual({ from: -2, to: 962 });
    expect(defaultViewRange({ count: 960, entryIdx: 400, exitIdx: 410, dayRange: { from: 330, to: 719 }, daySpan, mode: "trade" })).toEqual({ from: 370, to: 430 });
    // no span known (e.g. daily bars) → trade framing even in day mode
    expect(defaultViewRange({ count: 960, entryIdx: 400, exitIdx: 410, dayRange: null, daySpan: null, mode: "day" })).toEqual({ from: 370, to: 430 });
  });
  it("daySpanOf covers each day a multi-day trade spans and skips context days", () => {
    const keys = ["2026-10-13", "2026-10-13", "2026-10-14", "2026-10-14", "2026-10-15", "2026-10-15", "2026-10-16"];
    expect(daySpanOf(keys, "2026-10-14", "2026-10-15")).toEqual({ from: 2, to: 5 });
    expect(daySpanOf(keys, "2026-10-14", "2026-10-14")).toEqual({ from: 2, to: 3 });
    expect(daySpanOf(keys, "2026-10-20", "2026-10-21")).toBeNull();
  });
});

describe("follow cursor", () => {
  it("leaves a good view alone and re-centres when the cursor leaves it", () => {
    expect(followCursor({ from: 100, to: 200 }, 150)).toBeNull();
    expect(followCursor({ from: 100, to: 200 }, 199)).toEqual({ from: 129, to: 229 });
    expect(followCursor({ from: 100, to: 200 }, 50)).toEqual({ from: -20, to: 80 });
    expect(followCursor(null, 10)).toEqual({ from: -60, to: 40 });
  });
});

describe("volume cap", () => {
  it("caps the opening spike at the 98th percentile and keeps the rest", () => {
    const vols = [...Array.from({ length: 99 }, (_, i) => 100 + i), 1_000_000];
    const { cap, values } = capVolumes(vols);
    expect(cap).toBe(197);
    expect(values[99]).toBe(197);
    expect(values[0]).toBe(100);
  });
  it("handles junk and empty input", () => {
    expect(capVolumes([NaN, -5, 0])).toEqual({ cap: 0, values: [0, 0, 0] });
  });
});

describe("training history push", () => {
  it("prepends and caps", () => {
    const rec = (at: number): TrainingRecord => ({ at, tradeId: 1, ticker: "X", day: "d", score: null, pnlUsd: 0, r: null, perShare: null, vsRealPerShare: null, trades: 0 });
    let list: TrainingRecord[] = [];
    for (let i = 0; i < 205; i++) list = pushHistory(list, rec(i));
    expect(list).toHaveLength(200);
    expect(list[0].at).toBe(204);
  });
});
