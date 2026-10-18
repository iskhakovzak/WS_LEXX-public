/**
 * Percent in the trading format (dot decimals, no space, U+2212 minus), the same in every UI language.
 * - `fmtPct(1.234)` → "+1.23%": a value already in percent (price change, gap, return). Signed by default.
 * - `fmtRate(0.571)` → "57%": a share 0…1 (win rate, discipline, progress). Unsigned, whole by default.
 */
import { DASH, en, roundsToZero, signOf, toNum, type NumLike } from "./internal";

export interface PctOptions {
  /** Fixed decimals. fmtPct default 2, fmtRate default 0. */
  decimals?: number;
  /** `+` on positives. fmtPct default true, fmtRate default false. Zero never carries a sign. */
  signed?: boolean;
  /** Text for null / "" / NaN / ±Infinity. Default "—". */
  fallback?: string;
}

function pct(n: number | null, d: number, signed: boolean, fallback: string | undefined): string {
  if (n == null) return fallback ?? DASH;
  const abs = Math.abs(n);
  return `${signOf(n, roundsToZero(abs, d), signed)}${en(abs, d)}%`;
}

/** Value in percent → "+1.23%". `fmtPct(v, 1)` is shorthand for `{ decimals: 1 }`. */
export function fmtPct(v: NumLike, opts: number | PctOptions = {}): string {
  const o = typeof opts === "number" ? { decimals: opts } : opts;
  return pct(toNum(v), o.decimals ?? 2, o.signed ?? true, o.fallback);
}

/** Share 0…1 → "57%". `fmtRate(v, 1)` is shorthand for `{ decimals: 1 }`. */
export function fmtRate(v: NumLike, opts: number | PctOptions = {}): string {
  const o = typeof opts === "number" ? { decimals: opts } : opts;
  const n = toNum(v);
  return pct(n == null ? null : n * 100, o.decimals ?? 0, o.signed ?? false, o.fallback);
}
