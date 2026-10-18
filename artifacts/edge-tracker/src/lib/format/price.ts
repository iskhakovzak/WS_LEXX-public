/**
 * Share prices in the trading format, the same in every UI language: dot decimals and no grouping, the way
 * traders type levels ("920.74", "1234.50"). Sub-$1 prices get 4 decimals ("0.4521").
 */
import { DASH, en, MINUS, toNum, type NumLike } from "./internal";

export interface PriceOptions {
  /** Fixed decimals instead of the default (2, or 4 below $1). */
  decimals?: number;
  /** Drop trailing zeros (broker precision: "12.5", "12.3456", "150"). Default false. */
  trim?: boolean;
  /** Prefix "$" ("$12.50"). Default false. */
  dollar?: boolean;
  /** Text for null / "" / NaN / ±Infinity. Default "—". */
  fallback?: string;
}

/** 12.5 → "12.50", 0.4521 → "0.4521", 1234.5 → "1234.50"; `{ dollar: true }` → "$12.50"; `{ trim: true }` → "12.5". */
export function fmtPrice(v: NumLike, opts: PriceOptions = {}): string {
  const n = toNum(v);
  if (n == null) return opts.fallback ?? DASH;
  const abs = Math.abs(n);
  const d = opts.decimals ?? (abs > 0 && abs < 1 ? 4 : 2);
  const body = en(abs, opts.trim ? 0 : d, d, false);
  return `${n < 0 && Number(body) !== 0 ? MINUS : ""}${opts.dollar ? "$" : ""}${body}`;
}
