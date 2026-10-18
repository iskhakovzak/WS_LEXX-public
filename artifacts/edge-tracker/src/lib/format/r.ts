/** R multiple in the trading format, the same in every UI language: "+0.21R", "−1.50R", "0.00R". */
import { DASH, en, roundsToZero, signOf, toNum, type NumLike } from "./internal";

export interface ROptions {
  /** Fixed decimals. Default 2. */
  decimals?: number;
  /** `+` on positives. Default true. Zero never carries a sign. */
  signed?: boolean;
  /** Text for null / "" / NaN / ±Infinity. Default "—". */
  fallback?: string;
}

/** "+0.21R". `fmtR(v, 1)` is shorthand for `{ decimals: 1 }`. */
export function fmtR(v: NumLike, opts: number | ROptions = {}): string {
  const o = typeof opts === "number" ? { decimals: opts } : opts;
  const n = toNum(v);
  if (n == null) return o.fallback ?? DASH;
  const d = o.decimals ?? 2;
  const abs = Math.abs(n);
  return `${signOf(n, roundsToZero(abs, d), o.signed ?? true)}${en(abs, d)}R`;
}
