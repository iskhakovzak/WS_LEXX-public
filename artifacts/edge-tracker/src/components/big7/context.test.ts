import { describe, it, expect } from "vitest";
import type { Candle } from "@/components/chart-engine/types";
import {
  boardAgg, buildRow, buildSnap, corrBeta, cumVolFrac, downsample, marketTone, phaseOf, referenceSession, rsMomentum, timeRvol, windowStart,
} from "./context";

/** Epoch seconds for an ET wall-clock time in October 2026 (EDT, UTC−4). */
function et(day: string, hh: number, mm: number): number {
  return Math.floor(Date.parse(`${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-04:00`) / 1000);
}
function bar(day: string, hh: number, mm: number, c: number, v = 1000, spread = 0.2): Candle {
  return { t: et(day, hh, mm), o: c, h: c + spread, l: c - spread, c, v };
}
/** Prior day RTH 100→102 (H 102.2, L 99.8), today premarket 103, RTH from 104 rising 0.1 per bar. */
function series(rthBars = 24, start = 104, step = 0.1): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 78; i++) out.push(bar("2026-10-15", 9 + Math.floor((30 + i * 5) / 60), (30 + i * 5) % 60, 100 + (2 * i) / 77));
  out.push(bar("2026-10-16", 8, 0, 103, 0));
  out.push(bar("2026-10-16", 9, 0, 103.5, 0));
  for (let i = 0; i < rthBars; i++) {
    const m = 30 + i * 5;
    out.push(bar("2026-10-16", 9 + Math.floor(m / 60), m % 60, start + i * step));
  }
  return out;
}

describe("session date", () => {
  it("weekend falls back to Friday", () => {
    expect(referenceSession(new Date("2026-10-17T15:00:00Z"))).toBe("2026-10-16");
  });
  it("weekday before 04:00 ET uses the previous weekday, after uses today", () => {
    expect(referenceSession(new Date("2026-10-19T07:00:00Z"))).toBe("2026-10-16"); // Mon 03:00 ET
    expect(referenceSession(new Date("2026-10-19T09:00:00Z"))).toBe("2026-10-19"); // Mon 05:00 ET
  });
  it("phase", () => {
    expect(phaseOf("2026-10-19", new Date("2026-10-19T12:00:00Z"))).toBe("pre");
    expect(phaseOf("2026-10-19", new Date("2026-10-19T15:00:00Z"))).toBe("rth");
    expect(phaseOf("2026-10-19", new Date("2026-10-19T21:00:00Z"))).toBe("post");
    expect(phaseOf("2026-10-16", new Date("2026-10-19T15:00:00Z"))).toBe("closed");
  });
  it("window start skips weekends", () => {
    expect(windowStart("2026-10-19", 3)).toBe("2026-10-14");
  });
});

describe("buildSnap", () => {
  it("levels, VWAP and volume from 5m bars", () => {
    const s = buildSnap(series())!;
    expect(s.day).toBe("2026-10-16");
    expect(s.pdc).toBeCloseTo(102, 5);
    expect(s.pdh).toBeCloseTo(102.2, 5);
    expect(s.pdl).toBeCloseTo(99.8, 5);
    expect(s.pmh).toBeCloseTo(103.7, 5);
    expect(s.pml).toBeCloseTo(102.8, 5);
    expect(s.open).toBe(104);
    expect(s.pmLast).toBe(103.5);
    expect(s.rthClose).toBeCloseTo(106.3, 5);
    expect(s.rthVol).toBe(24000);
    expect(s.rthMinutes).toBe(120);
    expect(s.vwap!).toBeGreaterThan(104);
    expect(s.vwap!).toBeLessThan(106.3);
    expect(s.spark.length).toBe(26);
  });
  it("empty input", () => {
    expect(buildSnap([])).toBeNull();
  });
});

describe("helpers", () => {
  it("cumulative volume curve is monotone and bounded", () => {
    expect(cumVolFrac(0)).toBe(0);
    expect(cumVolFrac(390)).toBe(1);
    expect(cumVolFrac(45)).toBeCloseTo(0.195, 3);
    expect(cumVolFrac(200)).toBeGreaterThan(cumVolFrac(100));
  });
  it("time-of-day RVOL", () => {
    // 30 min in: 15% of a 10M day expected; 3M traded → 2×.
    expect(timeRvol(3_000_000, 30, 10_000_000)).toBeCloseTo(2, 5);
    expect(timeRvol(1000, 5, 10_000_000)).toBeNull();
    expect(timeRvol(1000, 60, null)).toBeNull();
  });
  it("downsample keeps endpoints", () => {
    const xs = Array.from({ length: 200 }, (_, i) => i);
    const d = downsample(xs, 10);
    expect(d.length).toBe(10);
    expect(d[0]).toBe(0);
    expect(d[9]).toBe(199);
  });
  it("correlation of a scaled series is 1 with beta = scale", () => {
    const b = Array.from({ length: 30 }, (_, i) => ({ t: i, c: 100 + Math.sin(i) }));
    const s = b.map((x) => ({ t: x.t, c: 50 * (1 + 2 * (x.c / 100 - 1)) }));
    const cb = corrBeta(s, b)!;
    expect(cb.corr).toBeGreaterThan(0.99);
    expect(cb.beta).toBeGreaterThan(1.9);
    expect(cb.beta).toBeLessThan(2.1);
    expect(corrBeta(s.slice(0, 5), b.slice(0, 5))).toBeNull();
  });
  it("RS momentum over 6 bars", () => {
    expect(rsMomentum([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.9])).toBeCloseTo(0.8, 5);
    expect(rsMomentum([1, 2])).toBeNull();
  });
});

describe("rows, breadth and tone", () => {
  const qqqSnap = buildSnap(series(24, 104, 0.02));
  const qqqChg = ((qqqSnap!.rthClose! / qqqSnap!.pdc!) - 1) * 100;

  it("row: change, gap, RS, nearest levels, contribution", () => {
    const snap = buildSnap(series());
    const r = buildRow({ symbol: "NVDA", snap, phase: "closed", qqq: { snap: qqqSnap, chg: qqqChg }, stats: { atr: 4 } as never });
    expect(r.price).toBeCloseTo(106.3, 5);
    expect(r.chg).toBeCloseTo((106.3 / 102 - 1) * 100, 5);
    expect(r.gap).toBeCloseTo((104 / 102 - 1) * 100, 5);
    expect(r.rsQqq!).toBeGreaterThan(0);
    expect(r.rs30!).toBeGreaterThan(0);
    expect(r.contribQqq).toBeCloseTo((9.0 * r.chg!) / 100, 6);
    expect(r.below?.key).toBe("orbh");
    expect(r.above?.key).toBe("hod"); // above every reference level → day high
    expect(r.atrUsed).toBeGreaterThan(0);
    expect(r.levels[0].price).toBeGreaterThanOrEqual(r.levels[r.levels.length - 1].price);
  });

  it("premarket: price is the last premarket print and HOD/LOD are hidden", () => {
    const pre = series(0);
    const snap = buildSnap(pre);
    const r = buildRow({ symbol: "AAPL", snap, phase: "pre", qqq: { snap: null, chg: null } });
    expect(r.price).toBe(103.5);
    expect(r.gap).toBeCloseTo((103.5 / 102 - 1) * 100, 5);
    expect(r.levels.find((l) => l.key === "hod")).toBeUndefined();
    expect(r.above?.key).toBe("pmh");
  });

  it("falls back to the quote without bars", () => {
    const r = buildRow({ symbol: "TSLA", snap: null, phase: "rth", qqq: { snap: null, chg: 0.5 }, quote: { price: 250, change: 1.5, prevClose: 246.3 } as never });
    expect(r.price).toBe(250);
    expect(r.chg).toBe(1.5);
    expect(r.rsQqq).toBeCloseTo(1, 6);
  });

  it("breadth, Alphabet de-duplication and tone", () => {
    const mk = (symbol: string, chg: number, rsQqq: number) =>
      ({ symbol, chg, rsQqq, wQqq: symbol === "GOOG" || symbol === "GOOGL" ? 5.1 : 5, contribQqq: (5 * chg) / 100, contribSpy: null }) as never;
    const rows = [mk("AAPL", 1, 0.5), mk("MSFT", 0.8, 0.3), mk("GOOGL", 0.6, 0.1), mk("GOOG", 0.6, 0.1), mk("TSLA", -1, -1.5)];
    const a = boardAgg(rows, 0.5);
    expect(a.up).toBe(4);
    expect(a.down).toBe(1);
    expect(a.contribQqq).toBeCloseTo((5 * (1 + 0.8 + 0.6 - 1)) / 100, 6);
    expect(a.leaders.map((r) => r.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(a.laggards.map((r) => r.symbol)).toEqual(["TSLA"]);
    const t = marketTone({ qqqChg: 0.8, spyChg: 0.5, qqqVwapDist: 0.4, qqqAboveSma20: true, agg: a, phase: "rth" })!;
    expect(t.kind).toBe("on");
    expect(t.reasons.length).toBeGreaterThan(0);
    expect(t.reasons.length).toBeLessThanOrEqual(3);
    const off = marketTone({ qqqChg: -1, spyChg: -0.8, qqqVwapDist: -0.5, qqqAboveSma20: false, agg: boardAgg(rows.map((r: never) => ({ ...(r as object), chg: -1 }) as never), -1), phase: "rth" })!;
    expect(off.kind).toBe("off");
  });

  it("flags a divergence between the board and QQQ", () => {
    const rows = [{ symbol: "AAPL", chg: -1, rsQqq: -1.5, wQqq: 8, contribQqq: -0.08, contribSpy: null }] as never[];
    const t = marketTone({ qqqChg: 0.5, spyChg: 0.4, qqqVwapDist: null, qqqAboveSma20: null, agg: boardAgg(rows, 0.5), phase: "rth" })!;
    expect(t.divergence).toBe(true);
  });
});
