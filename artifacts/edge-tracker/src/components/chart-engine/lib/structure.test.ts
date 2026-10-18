import { describe, expect, it } from "vitest";
import type { Candle, Execution, StructureLeg } from "../types";
import { isOpening, resolveFills } from "./position";
import { positionSteps, roleLabel, roleOf, siblingTitle } from "./structure";

const T0 = Date.UTC(2026, 5, 12, 14, 0, 0) / 1000; // 10:00 ET
const bars: Candle[] = Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * 60, o: 10, h: 10.5, l: 9.5, c: 10, v: 1000 }));
const at = (min: number, sec = 0) => new Date((T0 + min * 60 + sec) * 1000).toISOString();
const fallback = { entry: null, exit: null, qty: null, dayKey: "2026-06-12" };

function leg(p: Partial<StructureLeg> & Pick<StructureLeg, "index" | "role" | "opening" | "executionIds" | "price">): StructureLeg {
  return {
    label: "", pieces: p.executionIds.length, qty: null, at: null, atEnd: null, positionBefore: null, positionAfter: null, avgAfter: null,
    fraction: null, perShare: null, realized: null, r: null, inferred: false, reason: null, ...p,
  };
}

describe("roles on the client", () => {
  it("prefers the API role and falls back to the stored kind", () => {
    expect(roleOf({ kind: "entry", role: "reentry" })).toBe("reentry");
    expect(roleOf({ kind: "trim" })).toBe("partial_exit");
    expect(roleOf({ kind: "exit", role: null })).toBe("exit");
    expect(roleLabel("stop", true)).toBe("Стоп?");
    expect(roleLabel("partial_exit")).toBe("Частичный фикс");
  });

  it("titles siblings by their place in the chain", () => {
    expect(siblingTitle({ id: 1, reentryIndex: 0, legs: [{ role: "entry" }] })).toBe("Первый вход");
    expect(siblingTitle({ id: 2, reentryIndex: 2, legs: [{ role: "reentry" }] })).toBe("Перезаход №2");
    expect(siblingTitle({ id: 3, reentryIndex: 1, legs: [{ role: "flip" }] })).toBe("Переворот");
  });
});

describe("resolveFills with structure legs", () => {
  const execs: Execution[] = [
    { id: 1, kind: "entry", price: "10", qty: "100", executedAt: at(1), legIndex: 0, role: "entry" },
    { id: 2, kind: "entry", price: "10.02", qty: "100", executedAt: at(1, 2), legIndex: 0, role: "entry" },
    { id: 3, kind: "add", price: "10.4", qty: "200", executedAt: at(5), legIndex: 1, role: "add" },
    { id: 4, kind: "trim", price: "10.8", qty: "200", executedAt: at(9), legIndex: 2, role: "partial_exit" },
    { id: 5, kind: "stop", price: "10.1", qty: "200", executedAt: at(12), legIndex: 3, role: "stop", roleInferred: true },
  ];
  const legs = [
    leg({ index: 0, role: "entry", opening: true, executionIds: [1, 2], price: 10.01, qty: 200 }),
    leg({ index: 1, role: "add", opening: true, executionIds: [3], price: 10.4, qty: 200 }),
    leg({ index: 2, role: "partial_exit", opening: false, executionIds: [4], price: 10.8, qty: 200 }),
    leg({ index: 3, role: "stop", opening: false, executionIds: [5], price: 10.1, qty: 200, inferred: true }),
  ];

  it("folds the pieces of one order into one marker at the VWAP and keeps the roles", () => {
    const fills = resolveFills(bars, 60, execs, fallback, legs);
    expect(fills.map((f) => f.role)).toEqual(["entry", "add", "partial_exit", "stop"]);
    expect(fills[0].pieces).toBe(2);
    expect(fills[0].qty).toBe(200);
    expect(fills[0].price).toBeCloseTo(10.01, 6);
    expect(fills[3].inferred).toBe(true);
    expect(fills[1].leg?.index).toBe(1);
  });

  it("steps the running average through adds and keeps it through partial exits", () => {
    const fills = resolveFills(bars, 60, execs, fallback, legs);
    const steps = positionSteps(fills, (f) => isOpening(f.kind));
    expect(steps.map((s) => s.qty)).toEqual([200, 400, 200, 0]);
    expect(steps[0].avg).toBeCloseTo(10.01, 6);
    expect(steps[1].avg).toBeCloseTo(10.205, 6);
    expect(steps[2].avg).toBeCloseTo(10.205, 6);
    expect(steps[3].avg).toBeNull();
  });

  it("counts every fill as one unit when sizes are unknown", () => {
    const fills = resolveFills(bars, 60, execs.map((e) => ({ ...e, qty: null, legIndex: null, role: null })), fallback);
    const steps = positionSteps(fills, (f) => isOpening(f.kind));
    expect(steps.every((s) => s.qty == null)).toBe(true);
    expect(steps[steps.length - 1].avg).toBeNull();
  });
});

describe("2m / 3m timeframes", () => {
  it("fold 1-minute bars into clock-aligned 2m and 3m bars starting at the 9:30 open", async () => {
    const { aggregate, availableTimeframes } = await import("./aggregate");
    const open = Date.UTC(2026, 9, 13, 13, 30) / 1000; // 9:30 ET
    const ones: Candle[] = Array.from({ length: 6 }, (_, i) => ({ t: open + i * 60, o: 10 + i, h: 11 + i, l: 9 + i, c: 10.5 + i, v: 100 }));
    const two = aggregate(ones, 60, "2m");
    expect(two.map((b) => b.t - open)).toEqual([0, 120, 240]);
    expect(two[0]).toMatchObject({ o: 10, h: 12, l: 9, c: 11.5, v: 200, n: 2 });
    const three = aggregate(ones, 60, "3m");
    expect(three.map((b) => b.t - open)).toEqual([0, 180]);
    expect(three[1]).toMatchObject({ o: 13, h: 16, c: 15.5, v: 300 });
    expect(availableTimeframes(60, ["1m", "2m", "3m", "5m", "15m"])).toEqual(["1m", "2m", "3m", "5m", "15m"]);
    expect(availableTimeframes(300, ["1m", "2m", "3m", "5m", "15m"])).toEqual(["5m", "15m"]);
  });
});

describe("unavailable timeframes", () => {
  it("explains why a finer timeframe cannot be built from the served bars", async () => {
    const { timeframeUnavailableReason, baseBarLabel } = await import("./aggregate");
    expect(timeframeUnavailableReason("1m", 60)).toBeNull();
    expect(timeframeUnavailableReason("5m", 300)).toBeNull();
    expect(timeframeUnavailableReason("2m", 300)).toMatch(/7 дней/);
    expect(timeframeUnavailableReason("5m", 3600)).toMatch(/60 дней/);
    expect(timeframeUnavailableReason("1h", 86400)).toMatch(/только дневные/);
    expect([baseBarLabel(60), baseBarLabel(300), baseBarLabel(3600)]).toEqual(["1 мин", "5 мин", "1 ч"]);
  });
});
