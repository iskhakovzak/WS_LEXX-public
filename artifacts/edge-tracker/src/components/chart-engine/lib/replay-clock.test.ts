import { describe, expect, it } from "vitest";
import { clockTick, planAdvance, replayStartIndex, sessionEndIndex, stepSpeed, MAX_FRAME_MS } from "./replay-clock";
import { etWallToEpoch } from "./time";
import { tradeWindow } from "./window";

const DAY = "2026-10-15";
/** 1-minute bars from 04:00 to 19:59 ET of DAY. */
const bars = Array.from({ length: 16 * 60 }, (_, i) => {
  const t = etWallToEpoch(DAY, 4, 0) + i * 60;
  return { t, o: 10, h: 10.1, l: 9.9, c: 10, v: 100 };
});
const idxAt = (h: number, m: number) => (h - 4) * 60 + m;

describe("replay clock", () => {
  it("earns whole bars per elapsed time and carries the rest", () => {
    expect(clockTick(800, 200, 1)).toEqual({ steps: 1, carry: 0 });
    expect(clockTick(0, 100, 10)).toEqual({ steps: 1, carry: 0 });
    const a = clockTick(0, 16, 30); // 33.3 ms per bar
    expect(a.steps).toBe(0);
    const b = clockTick(a.carry, 20, 30);
    expect(b.steps).toBe(1);
    expect(b.carry).toBeCloseTo(36 - 1000 / 30, 6);
  });

  it("does not fast-forward after a long pause (background tab)", () => {
    expect(clockTick(0, 60_000, 10).steps).toBe(Math.floor(MAX_FRAME_MS / 100));
  });

  it("returns nothing for a non-positive speed", () => {
    expect(clockTick(50, 500, 0)).toEqual({ steps: 0, carry: 0 });
  });

  it("steps the speed ladder and clamps", () => {
    expect(stepSpeed(1, 1)).toBe(2);
    expect(stepSpeed(10, 1)).toBe(30);
    expect(stepSpeed(60, 1)).toBe(60);
    expect(stepSpeed(1, -1)).toBe(1);
    expect(stepSpeed(30, -1)).toBe(10);
    expect(stepSpeed(7, -1)).toBe(5);
    expect(stepSpeed(7, 1)).toBe(10);
  });

  it("advances, stops at the end, at a limit and on fills", () => {
    expect(planAdvance(10, 3, { last: 100 })).toEqual({ next: 13, stopped: null });
    expect(planAdvance(98, 5, { last: 100 })).toEqual({ next: 100, stopped: "end" });
    expect(planAdvance(50, 20, { last: 100, limit: 60 })).toEqual({ next: 60, stopped: "limit" });
    expect(planAdvance(10, 10, { last: 100, pauseOn: [5, 14, 12] })).toEqual({ next: 12, stopped: "fill" });
    // a fill exactly on the cursor does not stop the next advance
    expect(planAdvance(12, 1, { last: 100, pauseOn: [12] })).toEqual({ next: 13, stopped: null });
    expect(planAdvance(100, 1, { last: 100 })).toEqual({ next: 100, stopped: "end" });
  });
});

describe("replay start", () => {
  const entryIdx = idxAt(10, 0);
  const ctx = { dayKey: DAY, entryIdx, entryTime: bars[entryIdx].t + 20 };

  it("starts at premarket, the open or N minutes before the entry", () => {
    expect(replayStartIndex(bars, "pre", ctx)).toBe(0);
    expect(replayStartIndex(bars, "open", ctx)).toBe(idxAt(9, 30));
    expect(replayStartIndex(bars, "15", ctx)).toBe(idxAt(9, 46)); // 10:00:20 − 15 min = 09:45:20 → first bar ≥ is 09:46
    expect(replayStartIndex(bars, "5", ctx)).toBe(idxAt(9, 56));
  });

  it("never starts after the entry and falls back to the open without one", () => {
    const early = { dayKey: DAY, entryIdx: idxAt(9, 0), entryTime: null };
    expect(replayStartIndex(bars, "open", early)).toBe(idxAt(9, 0));
    expect(replayStartIndex(bars, "30", { dayKey: DAY, entryIdx: null, entryTime: null })).toBe(idxAt(9, 30));
  });

  it("finds the last regular-session bar of the day", () => {
    expect(sessionEndIndex(bars, DAY)).toBe(idxAt(15, 59));
    expect(sessionEndIndex(bars, "2026-10-14")).toBe(bars.length - 1);
  });
});

describe("trade window", () => {
  const trade = { id: 1, ticker: "X", date: "2026-10-15" };
  it("asks for `contextDays` weekdays before the entry day (the server trims what would cost resolution)", () => {
    expect(tradeWindow(trade, 2, "2026-10-17").fromKey).toBe("2026-10-13");
    expect(tradeWindow({ ...trade, date: "2026-10-12" }, 2, "2026-10-17").fromKey).toBe("2026-10-08");
    expect(tradeWindow({ ...trade, date: "2026-09-01" }, 2, "2026-10-17").fromKey).toBe("2026-08-28");
    expect(tradeWindow({ ...trade, date: "2026-03-02" }, 1, "2026-10-17").fromKey).toBe("2026-02-27");
    expect(tradeWindow(trade, 0, "2026-10-17")).toMatchObject({ fromKey: "2026-10-15", toKey: "2026-10-15", multiDay: false });
  });
  it("spans every day of a multi-day trade, capped at today", () => {
    expect(tradeWindow({ ...trade, horizon: "swing", exitDate: "2026-10-20" }, 0, "2026-10-17")).toMatchObject({ toKey: "2026-10-17", multiDay: true });
    expect(tradeWindow({ ...trade, date: "2026-10-12", horizon: "overnight", exitDate: "2026-10-13" }, 0, "2026-10-17")).toMatchObject({ fromKey: "2026-10-12", toKey: "2026-10-13" });
  });
});
