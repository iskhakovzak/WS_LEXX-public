import { describe, expect, it } from "vitest";
import { decodeBars, encodeBars, normalizeBars, type Bar } from "../candleArchive/codec";
import fx from "./fixtures/mrvl-2026-09-16.json";

// 2026-09-16 (EDT): 04:00 ET = 08:00Z.
const T0 = Date.UTC(2026, 8, 16, 8, 0) / 1000;

/** Deterministic pseudo-random walk (LCG) so failures are reproducible. */
function walk(n: number, opts: { start: number; step?: number; tf?: number; decimals?: number; seed?: number; t0?: number }): Bar[] {
  let s = opts.seed ?? 7;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const round = (x: number) => Number(x.toFixed(opts.decimals ?? 2));
  const tf = opts.tf ?? 60;
  let p = opts.start;
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = round(p);
    p = Math.max(0.0001, p + (rnd() - 0.5) * (opts.step ?? p * 0.004));
    const c = round(p);
    out.push({ t: (opts.t0 ?? T0) + i * tf, o, c, h: round(Math.max(o, c) + rnd() * (opts.step ?? p * 0.002)), l: round(Math.max(0.0001, Math.min(o, c) - rnd() * (opts.step ?? p * 0.002))), v: Math.floor(rnd() * 50_000) });
  }
  return out;
}

const roundTrip = (bars: Bar[], tf = 60) => decodeBars(encodeBars(bars, tf));

describe("candle codec — round trip", () => {
  it("is exact for a full extended-hours 1-minute day (960 bars)", () => {
    const bars = walk(960, { start: 226.4 });
    const d = roundTrip(bars);
    expect(d.tfSec).toBe(60);
    expect(d.bars).toEqual(bars);
  });

  it("is exact for 4-decimal sub-penny prints and sub-$1 stocks", () => {
    const sub = walk(600, { start: 0.0832, step: 0.0011, decimals: 4, seed: 3 });
    expect(roundTrip(sub).bars).toEqual(sub);
    const half = walk(300, { start: 13.125, decimals: 4, seed: 11 }).map((b, i) => (i % 3 ? b : { ...b, c: Math.round(b.c * 200) / 200 }));
    expect(roundTrip(half).bars).toEqual(normalizeBars(half));
  });

  it("is exact for extreme prices (> $1000 and > $500k) and huge volumes", () => {
    const big = walk(390, { start: 1834.25, seed: 5 });
    expect(roundTrip(big).bars).toEqual(big);
    const brk = walk(120, { start: 712_345.5, step: 250, seed: 9 }).map((b) => ({ ...b, v: 9_007_199_254 }));
    expect(roundTrip(brk).bars).toEqual(brk);
  });

  it("keeps gaps: no-trade minutes, a halt and a regular-hours-only day", () => {
    const bars = walk(500, { start: 50 });
    // premarket with holes every few minutes, a 15-minute halt, and nothing between 16:00 and 20:00
    const holey = bars.filter((b, i) => !(i < 300 && i % 4 === 1) && !(i >= 330 && i < 345));
    const d = roundTrip(holey);
    expect(d.bars).toEqual(holey);
    expect(d.bars.length).toBe(holey.length);
    const rth = walk(390, { start: 20, t0: T0 + 330 * 60 });
    expect(roundTrip(rth).bars).toEqual(rth);
  });

  it("handles flat zero-volume prints (o = h = l = c) and a split-day jump", () => {
    const flat: Bar[] = Array.from({ length: 50 }, (_, i) => ({ t: T0 + i * 60, o: 10, h: 10, l: 10, c: 10, v: 0 }));
    expect(roundTrip(flat).bars).toEqual(flat);
    const split = [...walk(100, { start: 400 }), ...walk(100, { start: 100, t0: T0 + 100 * 60, seed: 2 })];
    expect(roundTrip(split).bars).toEqual(split);
  });

  it("handles off-grid bars (Yahoo hourly with a 09:30 bar), other timeframes and empty input", () => {
    const hourly: Bar[] = [0, 3600, 7200, 10800, 14400, 18000, 19800, 23400, 27000].map((dt, i) => ({ t: T0 + dt, o: 10 + i, h: 11 + i, l: 9 + i, c: 10.5 + i, v: 1000 * i }));
    const d = roundTrip(hourly, 3600);
    expect(d.tfSec).toBe(3600);
    expect(d.bars).toEqual(hourly);
    const five = walk(192, { start: 75, tf: 300 });
    expect(roundTrip(five, 300).bars).toEqual(five);
    expect(roundTrip([]).bars).toEqual([]);
  });

  it("normalises Yahoo float noise, unsorted input, duplicates and h/l that miss the body", () => {
    const noisy: Bar[] = [
      { t: T0 + 60, o: 226.42999267578125, h: 226.5, l: 226.3, c: 226.44000244140625, v: 100.4 },
      { t: T0, o: 226.1, h: 226.0, l: 226.2, c: 226.3, v: 5 }, // h below body, l above body
      { t: T0 + 60, o: 226.43, h: 226.6, l: 226.3, c: 226.45, v: 7 }, // duplicate t: last wins
    ];
    expect(roundTrip(noisy).bars).toEqual([
      { t: T0, o: 226.1, h: 226.3, l: 226.1, c: 226.3, v: 5 },
      { t: T0 + 60, o: 226.43, h: 226.6, l: 226.3, c: 226.45, v: 7 },
    ]);
  });

  it("rejects broken prices instead of storing garbage", () => {
    expect(() => encodeBars([{ t: T0, o: Number.NaN, h: 1, l: 1, c: 1, v: 0 }], 60)).toThrow();
    expect(() => encodeBars([{ t: T0, o: -1, h: 1, l: -1, c: 1, v: 0 }], 60)).toThrow();
    expect(() => decodeBars(Uint8Array.from([9, 1, 2]))).toThrow();
  });

  it("the same bars decode identically from every compressor", () => {
    const bars = walk(200, { start: 31.07 });
    for (const compress of ["auto", "brotli", "deflate", "none"] as const) expect(decodeBars(encodeBars(bars, 60, { compress })).bars).toEqual(bars);
  });
});

describe("candle codec — size", () => {
  it("a real 5-minute extended day (MRVL) is ~16× smaller than its JSON", () => {
    const day = (fx as unknown as Record<"5m", Bar[]>)["5m"];
    const payload = encodeBars(day, 300);
    expect(decodeBars(payload).bars).toEqual(normalizeBars(day));
    expect(payload.length).toBeLessThan(JSON.stringify(day).length / 8);
    expect(payload.length).toBeLessThan(1600);
  });

  it("a full synthetic 1-minute extended day fits in ~3–4 KB", () => {
    const payload = encodeBars(walk(960, { start: 120.55, seed: 21 }), 60);
    expect(payload.length).toBeLessThan(4500);
  });
});
