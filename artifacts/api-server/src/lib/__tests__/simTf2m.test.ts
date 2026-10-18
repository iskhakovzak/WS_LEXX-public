import { describe, expect, it } from "vitest";
import { aggregate, buildIntraday, etOf, intradaySpecOf, judgeOpts, playBarsOf, riskUnitOf, tfSec } from "../sim/scenario";
import { buildOwn } from "../sim/own";
import type { SimBar } from "../sim/engine";

const ny = (date: string, hh: number, mm: number) => Date.parse(`${date}T${String(hh + 4).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`) / 1000;
function minuteBars(date: string, fromMin: number, toMin: number, price = 100, drift = 0.01): SimBar[] {
  const out: SimBar[] = [];
  let p = price;
  for (let m = fromMin; m < toMin; m++) {
    const o = p; p += drift;
    out.push({ t: ny(date, Math.floor(m / 60), m % 60), o, h: Math.max(o, p) + 0.05 + (m % 3) * 0.01, l: Math.min(o, p) - 0.05, c: p, v: 100 + m });
  }
  return out;
}

describe("sim 2-minute timeframe", () => {
  it("aggregates 1m bars into 2m buckets aligned to even minutes (9:30, 9:32, …)", () => {
    const b = minuteBars("2026-10-16", 570, 576);
    const a = aggregate(b, tfSec("2m"));
    expect(a).toHaveLength(3);
    expect(a.map((x) => etOf(x.t).min)).toEqual([570, 572, 574]);
    expect(a[0]).toEqual({ t: b[0].t, o: b[0].o, h: Math.max(b[0].h, b[1].h), l: Math.min(b[0].l, b[1].l), c: b[1].c, v: b[0].v + b[1].v });
  });

  it("a level played on 2m keeps its session minutes: half the bars of 1m", () => {
    expect(tfSec("2m")).toBe(120);
    expect(intradaySpecOf("medium", "2m")).toMatchObject({ tf: "2m", playMinutes: 90 });
    expect(intradaySpecOf("medium", null).tf).toBe("1m");
    expect(playBarsOf("intraday", "medium", "2m")).toBe(45);
    expect(playBarsOf("intraday", "easy", "2m")).toBe(195);
    expect(judgeOpts("intraday", "2m").lookAhead).toBe(15);
  });

  it("buildIntraday on 2m: 45 bars from the open, premarket and the previous session aggregated too", () => {
    const day = "2026-10-16";
    const dayBars = [...minuteBars(day, 240, 570, 99), ...minuteBars(day, 570, 960, 100)];
    const prevBars = minuteBars("2026-10-15", 570, 960, 98);
    const s = buildIntraday({ day, dayBars, prevBars, prevLevels: null, spec: intradaySpecOf("medium", "2m") })!;
    expect(s.endIdx - s.startIdx).toBe(45);
    expect(etOf(s.bars[s.startIdx].t).min).toBe(568);
    expect(etOf(s.bars[s.startIdx + 1].t).min).toBe(570);
    expect(s.bars.every((b, i) => i === 0 || b.t - s.bars[i - 1].t >= 120)).toBe(true);
    expect(s.riskUnit).toBeGreaterThan(0);
  });

  it("risk unit on 2m stays above the price floor", () => {
    const vis = minuteBars("2026-10-16", 570, 620, 100, 0.02);
    const r1 = riskUnitOf(vis, "1m", 100), r2 = riskUnitOf(aggregate(vis, 120), "2m", 100);
    expect(r2).toBeGreaterThanOrEqual(0.2);
    expect(r1).toBeGreaterThanOrEqual(0.2);
  });

  it("own mode (my worst days) builds on 2m from 1m bars", () => {
    const day = "2026-10-16";
    const bars = aggregate([...minuteBars(day, 240, 570, 99), ...minuteBars(day, 570, 960, 100)], 120);
    const built = buildOwn({ day, tf: "2m", dayBars: bars, prevBars: [], prevLevels: null, firstAt: ny(day, 10, 1), lastAt: ny(day, 10, 31) })!;
    expect(built.tf).toBe("2m");
    expect(etOf(built.bars[built.entryIdx].t).min).toBe(600);
    expect(built.decisionIdx).toBe(built.entryIdx - 1);
    expect(built.entryIdx - built.startIdx).toBeLessThanOrEqual(16);
    expect(etOf(built.bars[built.exitIdx!].t).min).toBe(630);
  });
});
