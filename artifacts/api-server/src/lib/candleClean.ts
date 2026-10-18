/**
 * Bad-tick filter for intraday candles — pure (no DB, no network). Applied by routes/candles.ts to every day it serves
 * (fresh from Yahoo and read back from candles_cache), so the chart, replay, training and trade quality all get the
 * same cleaned series.
 *
 * Yahoo occasionally ships a bar whose wick is a stray print far from where the stock traded (MRVL 2026-09-16 04:10 ET:
 * high 283.21 while every bar around it was ~226). One such wick blows up the y-axis and anything derived from bar
 * extremes (suggested stops, MAE). Rules:
 *   - bodies (open / close) of normal bars are never changed;
 *   - a wick is clamped only when it sticks out beyond the body by more than `tol` (max of K × the neighbours' median
 *     range and a % of price — looser in regular hours than in pre/post-market) AND no adjacent bar traded at least
 *     halfway out to it — with its body, with volume, or with a wick that is not itself beyond the cap (neighbouring
 *     zero-volume stray prints with the same absurd wick, META 2026-09-16 16:45 + 16:50 ET up to 714 at ~674, do not
 *     vouch for each other);
 *     it is cut back to the body plus the neighbours' typical wick;
 *   - a bar is dropped only when it is clearly broken: non-finite / non-positive prices, or a zero-volume body that
 *     sits alone far away from both the previous close and the next open while those two agree (a single-bar spike);
 *   - h / l that do not even contain the body are widened to the body.
 */
import { nyMinutes } from "./tradingDate";

export type Ohlcv = { t: number; o: number; h: number; l: number; c: number; v: number };

export type CleanOptions = {
  /** Neighbours on each side used for the local reference (default 10). */
  window?: number;
  /** Fewer neighbours than this ⇒ the bar is left as is (not enough context to judge). Default 4. */
  minNeighbours?: number;
};

/** Thresholds per session: tol = max(k × median neighbour range, pct × price). */
export const OUTLIER_THRESHOLDS = {
  extended: { k: 10, pct: 0.03 },
  regular: { k: 20, pct: 0.08 },
} as const;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const finitePos = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

/** True for bars inside 09:30–16:00 New York time. */
export function isRegularSession(t: number): boolean {
  const m = nyMinutes(new Date(t * 1000));
  return m >= 570 && m < 960;
}

/** Cleaned copy of `bars` (sorted by time). Returns the same values for a clean series. */
export function cleanCandles<T extends Ohlcv>(bars: readonly T[], opts: CleanOptions = {}): T[] {
  const W = opts.window ?? 10;
  const minN = opts.minNeighbours ?? 4;
  // 1. Broken bars out; h / l widened to contain the body.
  const base: T[] = [];
  for (const b of bars) {
    if (!b || !Number.isFinite(b.t) || !finitePos(b.o) || !finitePos(b.c) || !finitePos(b.h) || !finitePos(b.l)) continue;
    const top = Math.max(b.o, b.c), bot = Math.min(b.o, b.c);
    base.push(b.h < top || b.l > bot ? { ...b, h: Math.max(b.h, top), l: Math.min(b.l, bot) } : b);
  }
  base.sort((a, b) => a.t - b.t);
  const n = base.length;
  if (n < minN + 1) return base;

  const tolAt = (i: number, nb: T[]): number => {
    const b = base[i];
    const th = isRegularSession(b.t) ? OUTLIER_THRESHOLDS.regular : OUTLIER_THRESHOLDS.extended;
    const ref = median(nb.flatMap((x) => [x.o, x.c]));
    const scale = median(nb.map((x) => x.h - x.l));
    return Math.max(th.k * scale, th.pct * ref);
  };
  const neighbours = (i: number, skip?: ReadonlySet<number>): T[] => {
    const out: T[] = [];
    for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) if (j !== i && !skip?.has(j)) out.push(base[j]);
    return out;
  };

  // 2. Single-bar body spikes (judged on the original series). Only zero-volume bars: a lone print with volume can be a
  //    real trade in an illiquid instrument (options jump like that), Yahoo's stray ticks come with v = 0.
  const drop = new Set<number>();
  for (let i = 1; i < n - 1; i++) {
    const b = base[i], prev = base[i - 1], next = base[i + 1];
    const nb = neighbours(i);
    if (nb.length < minN) continue;
    const tol = tolAt(i, nb);
    const far = (x: number) => Math.abs(x - prev.c) > tol && Math.abs(x - next.o) > tol;
    if (!(b.v > 0) && far(b.o) && far(b.c) && Math.abs(prev.c - next.o) <= tol) drop.add(i);
  }

  // 3. Absurd wicks (neighbours exclude dropped bars).
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    if (drop.has(i)) continue;
    const b = base[i];
    const nb = neighbours(i, drop);
    if (nb.length < minN) { out.push(b); continue; }
    const tol = tolAt(i, nb);
    const top = Math.max(b.o, b.c), bot = Math.min(b.o, b.c);
    const adj = [i - 1, i + 1].filter((j) => j >= 0 && j < n && !drop.has(j)).map((j) => base[j]);
    const upWick = median(nb.map((x) => x.h - Math.max(x.o, x.c)));
    const dnWick = median(nb.map((x) => Math.min(x.o, x.c) - x.l));
    const refHi = Math.max(top, median(nb.map((x) => x.h)));
    const refLo = Math.min(bot, median(nb.map((x) => x.l)));
    const capHi = refHi + tol, capLo = refLo - tol;
    // An adjacent bar that traded at least halfway out to this extreme confirms it (a real spike, not a stray print).
    const halfHi = top + (b.h - top) / 2, halfLo = bot - (bot - b.l) / 2;
    const confirmedHi = adj.some((x) => Math.max(x.o, x.c) >= halfHi || (x.h >= halfHi && (x.v > 0 || x.h <= capHi)));
    const confirmedLo = adj.some((x) => Math.min(x.o, x.c) <= halfLo || (x.l <= halfLo && (x.v > 0 || x.l >= capLo)));
    let { h, l } = b;
    if (h > capHi && !confirmedHi) h = Math.max(top, Math.min(capHi, top + upWick));
    if (l < capLo && !confirmedLo) l = Math.min(bot, Math.max(capLo, bot - dnWick));
    out.push(h !== b.h || l !== b.l ? { ...b, h, l } : b);
  }
  return out;
}
