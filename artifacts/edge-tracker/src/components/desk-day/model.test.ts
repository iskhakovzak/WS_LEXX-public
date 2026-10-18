import { describe, expect, it } from "vitest";
import { defaultFocus, samplePath, windowBars } from "./model";

const T0 = Date.parse("2026-09-16T13:30:00Z") / 1000; // 09:30 ET
const bars1m = Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * 60 }));
const bars5m = Array.from({ length: 6 }, (_, i) => ({ t: T0 + i * 300 }));

describe("desk-day office layer — sampling per bar", () => {
  const office = { startPct: 0, path: [{ t: T0 + 2 * 60, pct: 25 }, { t: T0 + 4 * 60, pct: 100 }, { t: T0 + 12 * 60, pct: 40 }, { t: T0 + 21 * 60, pct: -10 }].map((p) => ({ ...p, shares: null })) };

  it("1m: the value after each minute with fills, start value before the first one", () => {
    const v = samplePath(office, bars1m, 60);
    expect(v.slice(0, 5)).toEqual([0, 0, 25, 25, 100]);
    expect(v[11]).toBe(100);
    expect(v[12]).toBe(40);
    expect(v[29]).toBe(-10);
  });

  it("5m: a bar takes the value at its end", () => {
    expect(samplePath(office, bars5m, 300)).toEqual([100, 100, 40, 40, -10, -10]);
  });
});

describe("desk-day — focus and zones", () => {
  const day = { traders: [{ name: "t4", alias: 4, me: false }, { name: "t2", alias: 2, me: true }] } as Parameters<typeof defaultFocus>[0];

  it("the alias URL param wins; otherwise the viewer", () => {
    expect(defaultFocus(day, 4)).toEqual(["t4"]);
    expect(defaultFocus(day, 9)).toEqual(["t2"]);
    expect(defaultFocus(day)).toEqual(["t2"]);
  });

  it("zone window → bar indexes (inside one bar → that bar; off the chart → null)", () => {
    const iso = (sec: number) => new Date(sec * 1000).toISOString();
    expect(windowBars(bars1m, 60, iso(T0 + 125), iso(T0 + 600))).toEqual({ from: 2, to: 10 });
    expect(windowBars(bars5m, 300, iso(T0 + 125), iso(T0 + 600))).toEqual({ from: 0, to: 2 });
    expect(windowBars(bars1m, 60, iso(T0 - 3600), iso(T0 - 60))).toBeNull();
  });
});
