import { describe, expect, it } from "vitest";
import {
  alertFires, analogues, baseline, bucketize, buildFrame, DIMENSIONS, INDICATOR_BY_ID, joinDays, percentileAt, readings, regimeAt,
  tercileDimension, traderDays, type Bar, type MarketData,
} from "./engine";

function dates(n: number, start = "2025-01-02"): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T12:00:00Z`);
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function series(ds: string[], f: (i: number) => number, wiggle = 0.004): Bar[] {
  return ds.map((d, i) => {
    const c = f(i);
    const o = i ? f(i - 1) * (1 + (i % 3 === 0 ? 0.006 : 0)) : c;
    return { d, o, h: Math.max(o, c) * (1 + wiggle), l: Math.min(o, c) * (1 - wiggle), c };
  });
}

const N = 300;
const ds = dates(N);
// Steady uptrend, calm VIX in the last third.
const data: MarketData = {
  spy: series(ds, (i) => 500 * (1 + 0.001 * i)),
  rsp: series(ds, (i) => 170 * (1 + 0.0012 * i)),
  iwm: series(ds, (i) => 220 * (1 + 0.0013 * i)),
  qqq: series(ds, (i) => 450 * (1 + 0.001 * i)),
  vix: series(ds, (i) => (i < 200 ? 22 - (i % 10) * 0.3 : 13 + (i % 5) * 0.2), 0),
  vix3m: series(ds, () => 19, 0),
  tnx: series(ds, () => 4.2, 0),
  dxy: series(ds, () => 103, 0),
};

describe("market engine", () => {
  const rows = buildFrame(data);

  it("aligns the frame on SPY sessions and derives values", () => {
    expect(rows).toHaveLength(N);
    const last = rows[N - 1];
    expect(last.dist50).toBeGreaterThan(0);
    expect(last.vixTerm).toBeCloseTo(last.vix! / 19, 6);
    expect(last.rspRel20).toBeGreaterThan(0);
    expect(rows[0].spyChg).toBeNull();
  });

  it("percentile counts the last year only and needs 60 values", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i);
    expect(percentileAt(xs, 99)).toBe(1);
    expect(percentileAt(xs, 30)).toBeNull();
    expect(percentileAt([...xs, 0], 100)).toBeCloseTo(2 / 101, 6);
  });

  it("classifies a calm uptrend as trend up / low vol / risk-on", () => {
    const r = regimeAt(rows, N - 1)!;
    expect(r.trend.key).toBe("up");
    expect(r.vol.key).toBe("low");
    expect(r.risk.key).toBe("on");
    expect(r.drivers.length).toBeGreaterThanOrEqual(8);
    expect(r.drivers.every((d) => d.impact >= -1 && d.impact <= 1)).toBe(true);
  });

  it("aggregates trader days net of fees and buckets them without look-ahead", () => {
    const trades = ds.slice(100).flatMap((d, k) => [
      { date: d, result: "win", pnl: 100, fees: 2 },
      { date: d, result: k % 2 ? "loss" : "win", pnl: k % 2 ? -50 : 30, fees: 1 },
      { date: d, result: "open", pnl: null, fees: null },
    ]);
    const days = traderDays(trades);
    const first = days.get(ds[100])!;
    expect(first.trades).toBe(2);
    expect(first.net).toBeCloseTo(98 + 29, 6);
    const joined = joinDays(rows, days);
    expect(joined).toHaveLength(N - 100);

    const vixDim = DIMENSIONS.find((d) => d.id === "vixLevel")!;
    const buckets = bucketize(vixDim, rows, joined);
    expect(buckets.reduce((a, b) => a + b.days, 0)).toBe(joined.length);
    // Session 201 is classified by the close of 200 (VIX 13.x) — never by its own close.
    const lt15 = buckets.find((b) => b.id === "lt15")!;
    expect(lt15.dates).toContain(ds[201]);
    expect(lt15.dates).not.toContain(ds[200]);

    const base = baseline(joined, rows);
    expect(base.days).toBe(joined.length);
    expect(base.winRate).toBeCloseTo(base.dates.length ? (joined.reduce((a, j) => a + j.day.wins, 0) / joined.reduce((a, j) => a + j.day.wins + j.day.losses, 0)) : 0, 6);

    const terc = tercileDimension(INDICATOR_BY_ID.get("vix")!, rows, joined)!;
    expect(terc.cuts[0]).toBeLessThan(terc.cuts[1]);
    const tb = bucketize(terc.dim, rows, joined);
    expect(tb.reduce((a, b) => a + b.days, 0)).toBe(joined.length);
  });

  it("finds analogues from pre-open state and excludes the state day", () => {
    const trades = ds.slice(60).map((d) => ({ date: d, result: "win", pnl: 10, fees: 0 }));
    const joined = joinDays(rows, traderDays(trades));
    const list = analogues(rows, joined, N - 1, 5, ds[N - 1]);
    expect(list).toHaveLength(5);
    expect(list[0].similarity).toBeGreaterThanOrEqual(list[4].similarity);
    expect(list.some((a) => a.d === ds[N - 1])).toBe(false);
    expect(list.every((a) => a.similarity >= 0 && a.similarity <= 1)).toBe(true);
  });

  it("reads indicators with day/week deltas and evaluates alerts", () => {
    const rs = readings(rows);
    const vix = rs.find((r) => r.id === "vix")!;
    expect(vix.spark).toHaveLength(60);
    expect(vix.dDay).toBeCloseTo(rows[N - 1].vix! - rows[N - 2].vix!, 6);
    expect(alertFires({ op: "above", value: 12 }, vix.value)).toBe(true);
    expect(alertFires({ op: "below", value: 12 }, vix.value)).toBe(false);
    expect(alertFires({ op: "below", value: 12 }, null)).toBe(false);
  });
});
