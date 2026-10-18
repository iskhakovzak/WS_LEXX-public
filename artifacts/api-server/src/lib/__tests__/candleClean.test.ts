import { describe, expect, it } from "vitest";
import { cleanCandles, isRegularSession, type Ohlcv } from "../candleClean";
import fx from "./fixtures/mrvl-2026-09-16.json";

const day = fx as unknown as Record<"5m" | "60m", Ohlcv[]>;

/** Indexes whose bar changed or disappeared. */
function diff(src: readonly Ohlcv[], out: readonly Ohlcv[]): { changed: number[]; dropped: number[] } {
  const byT = new Map(out.map((b) => [b.t, b]));
  const changed: number[] = [], dropped: number[] = [];
  src.forEach((b, i) => {
    const o = byT.get(b.t);
    if (!o) dropped.push(i);
    else if (o.o !== b.o || o.h !== b.h || o.l !== b.l || o.c !== b.c || o.v !== b.v) changed.push(i);
  });
  return { changed, dropped };
}

// 2026-09-16 (EDT, UTC−4): 04:00 ET = 08:00Z.
const T0 = Date.UTC(2026, 8, 16, 8, 0) / 1000;

/** Quiet premarket series around `p`: tiny ranges, bodies wobbling ±0.1. */
function quiet(n: number, p = 100, startT = T0, step = 60): Ohlcv[] {
  return Array.from({ length: n }, (_, i) => {
    const o = p + ((i % 3) - 1) * 0.05, c = p + (((i + 1) % 3) - 1) * 0.05;
    return { t: startT + i * step, o, c, h: Math.max(o, c) + 0.05, l: Math.min(o, c) - 0.05, v: 1000 };
  });
}

describe("cleanCandles — MRVL 2026-09-16 bad Yahoo tick", () => {
  it("5m extended: only the 04:10 bar's 283.21 wick is clamped, its body stays", () => {
    const src = day["5m"];
    const bad = src.findIndex((b) => b.h > 280);
    expect(bad).toBeGreaterThan(0);
    const out = cleanCandles(src);
    expect(out).toHaveLength(src.length);
    expect(diff(src, out)).toEqual({ changed: [bad], dropped: [] });
    const fixed = out[bad];
    expect([fixed.o, fixed.c, fixed.l]).toEqual([src[bad].o, src[bad].c, src[bad].l]);
    expect(fixed.h).toBeGreaterThanOrEqual(Math.max(src[bad].o, src[bad].c));
    expect(fixed.h).toBeLessThan(228);
    expect(Math.max(...out.map((b) => b.h))).toBeLessThan(235);
  });

  it("60m extended: the 04:00 hour loses the stray wick, the real regular-hours highs stay", () => {
    const src = day["60m"];
    const bad = src.findIndex((b) => b.h > 280);
    const out = cleanCandles(src);
    expect(diff(src, out)).toEqual({ changed: [bad], dropped: [] });
    expect(out[bad].h).toBeLessThan(229);
    expect(Math.max(...out.map((b) => b.h))).toBeCloseTo(233.98, 2);
  });

  it("the regular-hours-only series of that day is left untouched", () => {
    const src = day["5m"].filter((b) => isRegularSession(b.t));
    expect(src.length).toBe(78);
    expect(cleanCandles(src)).toEqual(src);
  });
});

describe("cleanCandles — rules", () => {
  it("leaves a clean series identical", () => {
    const src = quiet(60);
    expect(cleanCandles(src)).toEqual(src);
  });

  it("clamps an absurd low wick too", () => {
    const src = quiet(30);
    src[15] = { ...src[15], l: 60 };
    const out = cleanCandles(src);
    expect(out[15].l).toBeGreaterThan(99.5);
    expect([out[15].o, out[15].c]).toEqual([src[15].o, src[15].c]);
  });

  it("keeps a big wick an adjacent bar also traded to (a real spike, not a stray print)", () => {
    const src = quiet(30);
    src[15] = { ...src[15], h: 112 };
    src[16] = { ...src[16], h: 111.5 };
    const out = cleanCandles(src);
    expect(out[15].h).toBe(112);
    expect(out[16].h).toBe(111.5);
  });

  it("clamps neighbouring zero-volume stray wicks that only vouch for each other (META 2026-09-16 16:45/16:50 ET)", () => {
    const src = quiet(30, 674).map((b) => ({ ...b, v: 0 }));
    src[15] = { ...src[15], h: 714.4555, l: 628.7078 };
    src[16] = { ...src[16], h: 714.4555, l: 628.7078 };
    const out = cleanCandles(src);
    for (const i of [15, 16]) {
      expect(out[i].h).toBeLessThan(680);
      expect(out[i].l).toBeGreaterThan(668);
      expect([out[i].o, out[i].c]).toEqual([src[i].o, src[i].c]);
    }
  });

  it("keeps a real gap: bodies move and stay there", () => {
    const src = [...quiet(20, 100), ...quiet(20, 125, T0 + 20 * 60)];
    src[20] = { ...src[20], o: 100, l: 99.9 }; // the gap bar opens at the old level and closes at the new one
    expect(diff(src, cleanCandles(src))).toEqual({ changed: [], dropped: [] });
  });

  it("allows a looser wick in regular hours than in premarket", () => {
    const pre = quiet(30);
    pre[15] = { ...pre[15], h: 105 }; // +5% stray wick at ~04:15 ET
    expect(cleanCandles(pre)[15].h).toBeLessThan(101);
    const reg = quiet(30, 100, Date.UTC(2026, 8, 16, 14, 0) / 1000); // 10:00 ET
    reg[15] = { ...reg[15], h: 105 };
    expect(cleanCandles(reg)[15].h).toBe(105);
  });

  it("drops a single-bar body spike and broken bars", () => {
    const src = quiet(30);
    src[10] = { ...src[10], o: 150, c: 151, h: 152, l: 149, v: 0 };
    src[20] = { ...src[20], h: Number.NaN };
    src[22] = { ...src[22], l: 0 };
    const out = cleanCandles(src);
    expect(diff(src, out)).toEqual({ changed: [], dropped: [10, 20, 22] });
  });

  it("keeps a lone body spike that has volume (illiquid instruments really trade like that)", () => {
    const src = quiet(30);
    src[10] = { ...src[10], o: 150, c: 150, h: 150, l: 150, v: 15 };
    expect(diff(src, cleanCandles(src)).dropped).toEqual([]);
  });

  it("widens h / l that do not contain the body", () => {
    const src = quiet(10);
    src[5] = { ...src[5], o: 100, c: 100.1, h: 100.05, l: 100.02 };
    const out = cleanCandles(src);
    expect([out[5].h, out[5].l]).toEqual([100.1, 100]);
  });

  it("does not judge with too little context", () => {
    const src = quiet(4);
    src[2] = { ...src[2], h: 200 };
    expect(cleanCandles(src)[2].h).toBe(200);
  });
});
