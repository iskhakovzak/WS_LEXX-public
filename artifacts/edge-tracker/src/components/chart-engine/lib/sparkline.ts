/**
 * Sparkline data: the price path around a trade, downsampled to a fixed number of points. Pure.
 */
import type { Candle, Side, SparkData } from "../types";
import { findBarIndex } from "./time";

export type SparkInput = {
  bars: readonly Candle[];
  side: Side;
  entryTime: number | null;
  exitTime: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  /** Target number of points (default 120). */
  points?: number;
  /** Bars of context kept on each side of the trade (default: the whole input). */
  padBars?: number | null;
};

export function buildSparkData(input: SparkInput): SparkData | null {
  const { bars, side } = input;
  if (!bars.length) return null;
  let entryIdx = input.entryTime != null ? Math.max(0, findBarIndex(bars, input.entryTime)) : null;
  let exitIdx = input.exitTime != null ? Math.max(0, findBarIndex(bars, input.exitTime)) : null;
  if (entryIdx == null && input.entryPrice != null) entryIdx = firstTouch(bars, input.entryPrice, 0);
  if (exitIdx == null && input.exitPrice != null) exitIdx = firstTouch(bars, input.exitPrice, (entryIdx ?? 0) + 1);

  let from = 0, to = bars.length - 1;
  if (input.padBars != null && entryIdx != null) {
    from = Math.max(0, entryIdx - input.padBars);
    to = Math.min(bars.length - 1, (exitIdx ?? entryIdx) + input.padBars);
  }
  const n = Math.max(2, Math.min(input.points ?? 120, to - from + 1));
  const closes: number[] = [];
  const times: number[] = [];
  const step = (to - from + 1) / n;
  const srcIdxOfPoint: number[] = [];
  for (let k = 0; k < n; k++) {
    const i = Math.min(to, Math.floor(from + k * step));
    closes.push(bars[i].c);
    times.push(bars[i].t);
    srcIdxOfPoint.push(i);
  }
  const mapIdx = (idx: number | null): number | null => {
    if (idx == null) return null;
    let best = 0, bestD = Infinity;
    for (let k = 0; k < srcIdxOfPoint.length; k++) { const d = Math.abs(srcIdxOfPoint[k] - idx); if (d < bestD) { bestD = d; best = k; } }
    return best;
  };
  let min = Infinity, max = -Infinity;
  for (const c of closes) { if (c < min) min = c; if (c > max) max = c; }
  for (const p of [input.entryPrice, input.exitPrice]) if (p != null && Number.isFinite(p)) { if (p < min) min = p; if (p > max) max = p; }
  return {
    closes, times,
    entryIdx: mapIdx(entryIdx), exitIdx: mapIdx(exitIdx),
    entryPrice: input.entryPrice ?? (entryIdx != null ? bars[entryIdx].c : null),
    exitPrice: input.exitPrice ?? (exitIdx != null ? bars[exitIdx].c : null),
    side, min, max,
  };
}

function firstTouch(bars: readonly Candle[], price: number, start: number): number | null {
  for (let i = Math.max(0, start); i < bars.length; i++) if (price >= bars[i].l && price <= bars[i].h) return i;
  return null;
}
