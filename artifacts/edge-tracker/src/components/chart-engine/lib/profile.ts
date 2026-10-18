/**
 * Volume profile (VPVR): POC, value-area high/low. Pure.
 * Each bar's volume is spread evenly over the price bins its high–low range covers.
 */
import type { Candle, VolumeProfile } from "../types";

export type ProfileOptions = {
  /** Number of price bins (default 48). */
  bins?: number;
  /** Share of volume inside the value area (default 0.70). */
  valueArea?: number;
  /** Index range [from, to] inclusive; defaults to all bars. */
  from?: number;
  to?: number;
};

export function volumeProfile(bars: readonly Candle[], opts: ProfileOptions = {}): VolumeProfile {
  const bins = Math.max(4, Math.floor(opts.bins ?? 48));
  const vaShare = opts.valueArea ?? 0.7;
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(bars.length - 1, opts.to ?? bars.length - 1);
  const empty: VolumeProfile = { rows: [], binSize: 0, poc: null, vah: null, val: null, maxVol: 0, totalVol: 0 };
  if (!bars.length || from > to) return empty;

  let lo = Infinity, hi = -Infinity;
  for (let i = from; i <= to; i++) { lo = Math.min(lo, bars[i].l); hi = Math.max(hi, bars[i].h); }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return empty;
  if (hi <= lo) hi = lo + 0.01;
  const binSize = (hi - lo) / bins;
  const vols = new Float64Array(bins);
  let total = 0;
  for (let i = from; i <= to; i++) {
    const b = bars[i];
    const v = Number.isFinite(b.v) && b.v > 0 ? b.v : 0;
    if (v <= 0) continue;
    total += v;
    let b0 = Math.floor((b.l - lo) / binSize);
    let b1 = Math.floor((b.h - lo) / binSize);
    if (b0 < 0) b0 = 0; if (b1 > bins - 1) b1 = bins - 1; if (b1 < b0) b1 = b0;
    const share = v / (b1 - b0 + 1);
    for (let k = b0; k <= b1; k++) vols[k] += share;
  }
  if (total <= 0) return { ...empty, binSize };

  let pocIdx = 0, maxVol = 0;
  for (let k = 0; k < bins; k++) if (vols[k] > maxVol) { maxVol = vols[k]; pocIdx = k; }

  // Value area: grow from the POC, always taking the heavier neighbour, until 70 % of volume is inside.
  let lower = pocIdx, upper = pocIdx, acc = vols[pocIdx];
  const target = total * vaShare;
  while (acc < target && (lower > 0 || upper < bins - 1)) {
    const below = lower > 0 ? vols[lower - 1] : -1;
    const above = upper < bins - 1 ? vols[upper + 1] : -1;
    if (above >= below) { upper++; acc += vols[upper]; } else { lower--; acc += vols[lower]; }
  }
  const mid = (k: number) => lo + (k + 0.5) * binSize;
  return {
    rows: Array.from(vols, (vol, k) => ({ price: mid(k), vol })),
    binSize,
    poc: mid(pocIdx),
    vah: lo + (upper + 1) * binSize,
    val: lo + lower * binSize,
    maxVol,
    totalVol: total,
  };
}
