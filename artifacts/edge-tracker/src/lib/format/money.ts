/**
 * Money in the trading format, the same in every UI language: `$1,234.56`, `+$1,234.56` / `−$1,234.56`,
 * compact `$1.2K` / `$3.4M`. Minus is U+2212.
 */
import { compactAbs, DASH, en, roundsToZero, signOf, toNum, type NumLike } from "./internal";

/**
 * - number: fixed decimals;
 * - "auto": no cents from $1,000 (`$12,345` / `$123.45`) — dense tables, tiles;
 * - "trim": no cents for whole dollars (`$500` / `$12.50`) — limits and amounts people type.
 */
export type MoneyDecimals = number | "auto" | "trim";

export interface MoneyOptions {
  /** `+` on positives too (P&L, deltas). Default false: only negatives carry a sign. Zero never does. */
  signed?: boolean;
  /** Default 2 (`$1,234.56`); 0 in compact mode below the compact threshold. */
  decimals?: MoneyDecimals;
  /** Compact K/M/B from this absolute value: `true` = from 1,000; a number = from that value (e.g. 10_000). */
  compact?: boolean | number;
  /** Text for null / "" / NaN / ±Infinity. Default "—". */
  fallback?: string;
}

function decimalsFor(d: MoneyDecimals, abs: number): number {
  if (d === "auto") return abs >= 1000 ? 0 : 2;
  if (d === "trim") return Number.isInteger(Math.round(abs * 100) / 100) ? 0 : 2;
  return d;
}

/** `$1,234.56`. See MoneyOptions for sign, decimals and compact. */
export function fmtUsd(v: NumLike, opts: MoneyOptions = {}): string {
  const n = toNum(v);
  if (n == null) return opts.fallback ?? DASH;
  const abs = Math.abs(n);
  const from = opts.compact === true ? 1000 : typeof opts.compact === "number" ? opts.compact : Infinity;
  if (abs >= from) {
    const body = compactAbs(abs);
    return `${signOf(n, body === "0", opts.signed)}$${body}`;
  }
  const d = decimalsFor(opts.decimals ?? (opts.compact ? 0 : 2), abs);
  return `${signOf(n, roundsToZero(abs, d), opts.signed)}$${en(abs, d)}`;
}
