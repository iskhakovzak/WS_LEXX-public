/**
 * Plain numbers.
 * - Counts (trades, shares, people, rows) follow the UI language: `fmtCount` (1 234 / 1,234), from i18n/format.
 * - Trading metrics without a unit (PF, ratios, ATR, multipliers) use the trading format in every language:
 *   `fmtNum` (dot decimals, en-US grouping).
 * - Volumes / shares outstanding / market cap: `fmtCompact` (1.2K / 3.4M / 1.2B).
 */
import { compactAbs, DASH, en, roundsToZero, signOf, toNum, type NumLike } from "./internal";

export { fmtCount } from "@/i18n/format";

export interface NumOptions {
  /** Fixed decimals. Default 2. */
  decimals?: number;
  /** `+` on positives. Default false. */
  signed?: boolean;
  /** Appended after the number (e.g. "×"). */
  suffix?: string;
  /** Text for null / "" / NaN / ±Infinity. Default "—". */
  fallback?: string;
}

/** Trading-format number: 1.23, 1,234.50, −0.50; `fmtNum(2.5, { suffix: "×" })` → "2.50×". */
export function fmtNum(v: NumLike, opts: number | NumOptions = {}): string {
  const o = typeof opts === "number" ? { decimals: opts } : opts;
  const n = toNum(v);
  if (n == null) return o.fallback ?? DASH;
  const d = o.decimals ?? 2;
  const abs = Math.abs(n);
  return `${signOf(n, roundsToZero(abs, d), o.signed)}${en(abs, d)}${o.suffix ?? ""}`;
}

/** Profit factor / ratio that may be infinite (no losses): 1.85, "∞" for +Infinity, "—" when missing. */
export function fmtRatio(v: number | null | undefined, decimals = 2): string {
  if (v === Infinity) return "∞";
  return fmtNum(v, decimals);
}

/** Compact count: 950 → "950", 12,345 → "12.3K", 3,400,000 → "3.4M", 1.2e9 → "1.2B". */
export function fmtCompact(v: NumLike, opts: { signed?: boolean; fallback?: string } = {}): string {
  const n = toNum(v);
  if (n == null) return opts.fallback ?? DASH;
  const body = compactAbs(Math.abs(n));
  return `${signOf(n, body === "0", opts.signed)}${body}`;
}
