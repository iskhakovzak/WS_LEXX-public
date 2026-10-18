import { describe, it, expect } from "vitest";
import {
  INTRADAY_SPECS, SWING_SPECS, aggregate, buildIntraday, buildSwing, dailyBar, dayFeatures, defaultQty, etOf, fakeTimes, playBarsOf,
  riskUnitOf, seriesFeatures, toWire, weightedSample, pickWeighted,
} from "../sim/scenario";
import { contiguousRuns, weekdaysBetween } from "../sim/store";
import { lastPlayableDay, streaks, weekStart, downsample } from "../sim/service";
import type { SimBar } from "../sim/engine";

/** Epoch seconds of a New York wall time (EDT, UTC−4, for October dates). */
const ny = (date: string, hh: number, mm: number) => Date.parse(`${date}T${String(hh + 4).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`) / 1000;

function minuteBars(date: string, fromMin: number, toMin: number, price = 100, drift = 0.01): SimBar[] {
  const out: SimBar[] = [];
  let p = price;
  for (let m = fromMin; m < toMin; m++) {
    const o = p; p = p + drift;
    out.push({ t: ny(date, Math.floor(m / 60), m % 60), o, h: Math.max(o, p) + 0.05, l: Math.min(o, p) - 0.05, c: p, v: 1000 });
  }
  return out;
}

describe("sim scenario — time and aggregation", () => {
  it("etOf reads the New York date and minutes", () => {
    expect(etOf(ny("2026-10-16", 9, 30))).toEqual({ date: "2026-10-16", min: 570 });
  });

  it("aggregates 1-minute bars into 5-minute buckets", () => {
    const b = minuteBars("2026-10-16", 570, 580);
    const a = aggregate(b, 300);
    expect(a).toHaveLength(2);
    expect(a[0].o).toBe(b[0].o);
    expect(a[0].c).toBe(b[4].c);
    expect(a[0].v).toBe(5000);
  });

  it("daily bar from regular-session bars only", () => {
    const b = [...minuteBars("2026-10-16", 500, 510, 90), ...minuteBars("2026-10-16", 570, 960, 100)];
    const d = dailyBar("2026-10-16", b)!;
    expect(d.o).toBe(100);
    expect(d.t).toBe(Date.parse("2026-10-16T00:00:00Z") / 1000);
  });
});

describe("sim scenario — intraday series", () => {
  const day = "2026-10-16";
  const dayBars = [...minuteBars(day, 240, 570, 99), ...minuteBars(day, 570, 960, 100), ...minuteBars(day, 960, 1000, 104)];
  const prevBars = minuteBars("2026-10-15", 570, 960, 98);

  it("starts on the last premarket bar and plays the level's minutes", () => {
    const s = buildIntraday({ day, dayBars, prevBars, prevLevels: null, spec: INTRADAY_SPECS.medium })!;
    expect(etOf(s.bars[s.startIdx].t).min).toBe(569);
    expect(s.endIdx - s.startIdx).toBe(90);
    expect(etOf(s.bars[s.endIdx].t).min).toBe(570 + 89);
    expect(s.levels.pdc).toBeCloseTo(prevBars[prevBars.length - 1].c);
    expect(s.levels.pmh).not.toBeNull();
    // Nothing after the play window (no post-market) is ever in the series.
    expect(s.bars.every((b) => etOf(b.t).min < 960)).toBe(true);
  });

  it("easy plays 5-minute bars of the whole session", () => {
    const s = buildIntraday({ day, dayBars, prevBars: [], prevLevels: { h: 1, l: 1, c: 99 }, spec: INTRADAY_SPECS.easy })!;
    expect(s.endIdx - s.startIdx).toBe(78);
    expect(playBarsOf("intraday", "easy")).toBe(78);
  });

  it("rejects a day cached mid-session", () => {
    const short = [...minuteBars(day, 240, 570), ...minuteBars(day, 570, 600)];
    expect(buildIntraday({ day, dayBars: short, prevBars, prevLevels: null, spec: INTRADAY_SPECS.medium })).toBeNull();
  });

  it("features: gap and range", () => {
    const f = dayFeatures(95, minuteBars(day, 570, 600, 100, 0.1))!;
    expect(f.gapPct).toBeCloseTo(5.263, 2);
    expect(f.rangePct).toBeGreaterThan(2.9);
  });
});

describe("sim scenario — fake timeline", () => {
  it("keeps the New York wall clock on fake days and hides the real date", () => {
    const bars = [...minuteBars("2026-10-15", 900, 902), ...minuteBars("2026-10-16", 570, 572)];
    const t = fakeTimes(bars, "intraday");
    expect(t.map((x) => etOf(x))).toEqual([
      { date: "2001-01-09", min: 900 }, { date: "2001-01-09", min: 901 }, { date: "2001-01-10", min: 570 }, { date: "2001-01-10", min: 571 },
    ]);
    const w = toWire(bars, t, 0, 3);
    expect(w.map((x) => x[0])).toEqual(t);
    expect(JSON.stringify(w)).not.toContain(String(bars[0].t));
  });

  it("swing bars get a plain daily index", () => {
    const t = fakeTimes([{ t: 5, o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: 99, o: 1, h: 1, l: 1, c: 1, v: 1 }], "swing");
    expect(t[1] - t[0]).toBe(86400);
    expect(new Date(t[0] * 1000).toISOString().slice(0, 10)).toBe("2001-01-01");
  });
});

describe("sim scenario — swing", () => {
  const daily: SimBar[] = Array.from({ length: 300 }, (_, i) => ({ t: i * 86400, o: 50 + i * 0.1, h: 51 + i * 0.1, l: 49 + i * 0.1, c: 50.5 + i * 0.1, v: 1e6 }));
  it("history visible, then the level's bars", () => {
    const s = buildSwing(daily, 10, SWING_SPECS.medium)!;
    expect(s.startIdx).toBe(119);
    expect(s.endIdx - s.startIdx).toBe(100);
    expect(buildSwing(daily, 250, SWING_SPECS.hard)).toBeNull();
  });
  it("features: ATR % and big gaps", () => {
    const f = seriesFeatures(daily.slice(0, 50));
    expect(f.atrPct).toBeGreaterThan(3);
    expect(f.bigGaps).toBe(0);
  });
  it("contiguous runs tolerate weekends and one holiday, break on a hole", () => {
    expect(contiguousRuns(["2026-01-02", "2026-01-05", "2026-01-07", "2026-01-20", "2026-01-21"])).toEqual([[0, 2], [3, 4]]);
    expect(contiguousRuns(["2026-01-05", "2026-01-08"])).toEqual([[0, 0], [1, 1]]); // Tue and Wed missing
  });
});

describe("sim scenario — sizing, risk and picking", () => {
  it("default size ≈ $10k in round lots", () => {
    expect(defaultQty(100)).toBe(100);
    expect(defaultQty(343.37)).toBe(30);
    expect(defaultQty(3.21)).toBe(3120);
    expect(defaultQty(2500)).toBe(4);
  });
  it("risk unit: ATR × timeframe factor, floored at 0.2% of the price", () => {
    const flat: SimBar[] = Array.from({ length: 20 }, (_, i) => ({ t: i, o: 100, h: 100.01, l: 99.99, c: 100, v: 1 }));
    expect(riskUnitOf(flat, "1d", 100)).toBe(0.2);
    const wide: SimBar[] = Array.from({ length: 20 }, (_, i) => ({ t: i, o: 100, h: 102, l: 98, c: 100, v: 1 }));
    expect(riskUnitOf(wide, "1d", 100)).toBe(4);
  });
  it("weighted picks are deterministic with an injected random and prefer heavy items", () => {
    const items = ["a", "b", "c"];
    expect(pickWeighted(items, (x) => (x === "c" ? 10 : 0), () => 0.5)).toBe("c");
    let i = 0;
    const seq = [0.9, 0.1, 0.5];
    const s = weightedSample(items, 2, (x) => (x === "a" ? 100 : 1), () => seq[i++ % 3]);
    expect(s[0]).toBe("a");
    expect(s).toHaveLength(2);
  });
  it("weekdays between two dates; last playable day waits for the close", () => {
    expect(weekdaysBetween("2026-10-09", "2026-10-13")).toBe(1); // Mon 12th
    expect(lastPlayableDay(new Date("2026-10-16T18:00:00Z"))).toBe("2026-10-15"); // 14:00 NY
    expect(lastPlayableDay(new Date("2026-10-16T21:00:00Z"))).toBe("2026-10-16"); // 17:00 NY
  });
});

describe("sim progress helpers", () => {
  const row = (net: number, at: string) => ({ id: 1, mode: "intraday" as const, difficulty: "easy" as const, ticker: "X", day: "d", dayTo: null, tf: "5m" as const, net, r: 0, pct: 0, bhPct: 0, beatBh: false, trades: 1, finishedAt: at });
  it("win streaks and days in a row", () => {
    const rows = [row(5, "2026-10-17T15:00:00Z"), row(3, "2026-10-16T15:00:00Z"), row(-1, "2026-10-15T15:00:00Z"), row(2, "2026-10-14T15:00:00Z"), row(2, "2026-10-14T14:00:00Z"), row(1, "2026-10-14T13:00:00Z")];
    expect(streaks(rows, "2026-10-17")).toEqual({ current: 2, best: 3, days: 4 });
    expect(streaks(rows, "2026-10-19").days).toBe(0);
  });
  it("week starts on Monday; downsample keeps the ends", () => {
    expect(weekStart("2026-10-18")).toBe("2026-10-12");
    expect(weekStart("2026-10-12")).toBe("2026-10-12");
    const d = downsample(Array.from({ length: 1000 }, (_, i) => i), 5);
    expect(d).toEqual([0, 250, 500, 749, 999]);
  });
});

describe("sim data source", () => {
  it("never reads candles_cache (pruned nightly): intraday comes from the candle archive", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../sim/store.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/FROM\s+candles_cache/i);
    expect(src).toMatch(/readArchivedDays/);
  });
});
