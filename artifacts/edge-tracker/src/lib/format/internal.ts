/**
 * Shared pieces of lib/format (not exported from the barrel). Trading numbers use one fixed en-US style in every
 * UI language (ARCHITECTURE.md §0.7), so the Intl objects here are bound to "en-US", never to the UI locale.
 */

/** U+2212 MINUS SIGN: the minus used for every signed number on the desk (−$12.50, −0.21R, −1.2%). */
export const MINUS = "−";
/** Placeholder for a missing value. */
export const DASH = "—";

/** Numbers as they arrive from the API (pg `numeric` often comes as a string). */
export type NumLike = number | string | null | undefined;

/** Finite number or null ("" / null / NaN / ±Infinity → null). */
export function toNum(v: NumLike): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const enCache = new Map<string, Intl.NumberFormat>();
/** en-US digits with grouping (1,234.56): fixed `min`–`max` decimals. Cached; locale is constant. */
export function en(abs: number, min: number, max: number = min, grouping = true): string {
  const k = `${min}|${max}|${grouping ? 1 : 0}`;
  let f = enCache.get(k);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: grouping });
    enCache.set(k, f);
  }
  return f.format(abs);
}

/**
 * Sign prefix for a value whose displayed magnitude is `shown` (already rounded): a value that rounds to zero,
 * and negative zero, carry no sign («−$0.00» reads like a loss).
 */
export function signOf(n: number, shownIsZero: boolean, signed: boolean | undefined): string {
  if (shownIsZero || n === 0) return "";
  if (n < 0) return MINUS;
  return signed ? "+" : "";
}

/** True when `abs` formatted with `decimals` shows as zero. */
export function roundsToZero(abs: number, decimals: number): boolean {
  return Number(abs.toFixed(decimals)) === 0;
}

const UNITS: readonly [number, string][] = [
  [1e3, "K"],
  [1e6, "M"],
  [1e9, "B"],
  [1e12, "T"],
];

/**
 * Compact magnitude: 1,234 → "1.2K", 12,345 → "12.3K", 123,456 → "123K", 3,400,000 → "3.4M".
 * One decimal below 100 of a unit, none from 100; a trailing ".0" is dropped ("$1K", "2M"). A value that rounds
 * up to 1000 of a unit moves to the next unit (999,960 → "1M"). Below 1000: whole number.
 */
export function compactAbs(abs: number): string {
  let i = -1;
  for (let j = UNITS.length - 1; j >= 0; j--) {
    if (abs >= UNITS[j][0]) {
      i = j;
      break;
    }
  }
  if (i < 0) {
    const whole = Math.round(abs);
    if (whole < 1000) return String(whole);
    i = 0;
  }
  for (;;) {
    const scaled = abs / UNITS[i][0];
    const d = scaled < 100 ? 1 : 0;
    const s = scaled.toFixed(d);
    if (Number(s) >= 1000 && i < UNITS.length - 1) {
      i++;
      continue;
    }
    return `${s.replace(/\.0$/, "")}${UNITS[i][1]}`;
  }
}
