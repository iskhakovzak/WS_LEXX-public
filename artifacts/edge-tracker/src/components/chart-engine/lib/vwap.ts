/**
 * VWAP with standard-deviation bands and anchored VWAP. Pure.
 *
 * Session VWAP resets every New-York day and, by default, uses regular hours only (pre/post bars
 * from Yahoo carry zero volume anyway). σ is the volume-weighted standard deviation of the typical
 * price around VWAP: Σv·tp² / Σv − vwap².
 */
import type { Candle, VwapPoint } from "../types";
import { etParts, sessionOfMinutes } from "./time";

export type VwapOptions = { rthOnly?: boolean };

function typical(c: Candle): number {
  return (c.h + c.l + c.c) / 3;
}

export function sessionVwap(bars: readonly Candle[], opts: VwapOptions = {}): VwapPoint[] {
  const rthOnly = opts.rthOnly !== false;
  const out: VwapPoint[] = [];
  let day = "";
  let sumV = 0, sumPV = 0, sumPV2 = 0;
  for (const c of bars) {
    const p = etParts(c.t);
    if (rthOnly && sessionOfMinutes(p.mod) !== "rth") continue;
    if (p.dayKey !== day) { day = p.dayKey; sumV = 0; sumPV = 0; sumPV2 = 0; }
    const v = Number.isFinite(c.v) && c.v > 0 ? c.v : 0;
    if (v <= 0) continue;
    const tp = typical(c);
    sumV += v; sumPV += tp * v; sumPV2 += tp * tp * v;
    const vwap = sumPV / sumV;
    const variance = Math.max(0, sumPV2 / sumV - vwap * vwap);
    out.push({ t: c.t, vwap, sd: Math.sqrt(variance) });
  }
  return out;
}

/** VWAP anchored at `fromIdx` (e.g. the entry bar); no daily reset. Zero-volume bars are skipped. */
export function anchoredVwap(bars: readonly Candle[], fromIdx: number): VwapPoint[] {
  const out: VwapPoint[] = [];
  if (fromIdx < 0 || fromIdx >= bars.length) return out;
  let sumV = 0, sumPV = 0, sumPV2 = 0;
  for (let i = fromIdx; i < bars.length; i++) {
    const c = bars[i];
    const v = Number.isFinite(c.v) && c.v > 0 ? c.v : 0;
    if (v <= 0) continue;
    const tp = typical(c);
    sumV += v; sumPV += tp * v; sumPV2 += tp * tp * v;
    const vwap = sumPV / sumV;
    out.push({ t: c.t, vwap, sd: Math.sqrt(Math.max(0, sumPV2 / sumV - vwap * vwap)) });
  }
  return out;
}
