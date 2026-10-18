/**
 * Scales and tick generation (pure).
 *
 * X is an index axis: candle i occupies the slot [i, i + 1] and is centred at i + 0.5, so weekends and days
 * without trades leave no gaps (TradingView-style). Y is linear with «nice» 1 / 2 / 2.5 / 5 × 10ⁿ steps.
 */
import { fmtAxis, type EquityUnit } from "@/components/equity-candles/lib";

export interface Domain { min: number; max: number }

/** Linear map domain → range (works for inverted ranges, e.g. y pixels top < bottom). */
export function linear(d: Domain, r0: number, r1: number) {
  const span = d.max - d.min || 1;
  const k = (r1 - r0) / span;
  const map = (v: number) => r0 + (v - d.min) * k;
  map.invert = (px: number) => d.min + (px - r0) / k;
  return map;
}

/** «Nice» step nearest to range / target: 1, 2, 2.5, 5 × 10ⁿ. */
export function niceStep(range: number, target: number): number {
  if (!(range > 0) || !(target > 0)) return 1;
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const nice = f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10;
  return nice * mag;
}

/** Tick values inside [min, max] (inclusive with a float tolerance), at most ~target + 1. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max < min) [min, max] = [max, min];
  if (max === min) return [min];
  const step = niceStep(max - min, target);
  const eps = step * 1e-6;
  const out: number[] = [];
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 2);
  for (let k = Math.ceil((min - eps) / step); k * step <= max + eps; k++) {
    // toFixed kills float noise (0.6000000000000001 → 0.6).
    out.push(k === 0 ? 0 : Number((k * step).toFixed(decimals)));
    if (out.length > 50) break;
  }
  return out;
}

/**
 * Y domain of the visible values with breathing room. The 0 start line is pulled in when it is reasonably
 * close (so «above / below the start» reads at a glance) but not when it would squash a far-away curve.
 */
export function yDomain(lo: number, hi: number, opts: { includeZero?: "auto" | boolean; pad?: number } = {}): Domain {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: -1, max: 1 };
  let min = Math.min(lo, hi), max = Math.max(lo, hi);
  const inc = opts.includeZero ?? "auto";
  const span0 = max - min;
  if (inc === true || (inc === "auto" && (span0 === 0 || (min <= span0 * 0.75 && max >= -span0 * 0.75)))) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (max === min) {
    const a = Math.abs(max) || 1;
    return { min: min - a * 0.5, max: max + a * 0.5 };
  }
  const pad = (max - min) * (opts.pad ?? 0.08);
  return { min: min - pad, max: max + pad };
}

/** Axis label of a value; R keeps its sign, money is compact ($1.2K). */
export function axisLabel(v: number, unit: EquityUnit, step?: number): string {
  if (unit === "r") {
    if (Math.abs(v) < 1e-9) return "0R";
    const a = Math.abs(v);
    const digits = step != null && step < 1 ? (step < 0.1 ? 2 : 1) : a >= 10 ? 0 : 1;
    return `${v > 0 ? "+" : "−"}${a.toFixed(digits)}R`;
  }
  if (step != null && Math.abs(v) >= 1000 && step < 100) {
    // Fine steps on a large curve: $12.35K instead of two identical «$12K».
    const sign = v < 0 ? "−" : "";
    return `${sign}$${(Math.abs(v) / 1000).toFixed(step < 10 ? 3 : 2)}K`;
  }
  return fmtAxis(v, unit);
}
