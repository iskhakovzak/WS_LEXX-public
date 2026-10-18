/**
 * Time axis labels for an index axis (pure).
 *
 * Candles are keyed by trading dates; a label goes on the first candle of a day / week / month / quarter /
 * year. The coarsest level that still keeps ~`minPx` between labels wins; month and year starts are «major».
 */
import type { EquityAgg } from "./model";
import { fmtMonth, fmtWeekday } from "@/lib/format";
import { equityChartI18n } from "@/i18n/ns/equityChart";

/** Three-letter month for the axis in the UI language: «янв», «фев», «сен» / «Jan» / «Yan» (Intl short form without the dot). */
export function monthShort(m: number): string {
  return fmtMonth(m, "short").replace(".", "").slice(0, 3);
}

export interface TimeTick { index: number; label: string; major: boolean }

type Level = "day" | "week" | "month" | "quarter" | "year";

const month = (d: string) => Number(d.slice(5, 7)) - 1;
const year = (d: string) => d.slice(0, 4);

function isoWeek(d: string): string {
  // Monday-based week id: the Monday date itself is unique enough for «new week» detection.
  const dt = new Date(`${d}T12:00:00Z`);
  const wd = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() - wd + 1);
  return dt.toISOString().slice(0, 10);
}

function bucket(d: string, level: Level): string {
  switch (level) {
    case "day": return d;
    case "week": return isoWeek(d);
    case "month": return d.slice(0, 7);
    case "quarter": return `${year(d)}-Q${Math.floor(month(d) / 3)}`;
    case "year": return year(d);
  }
}

function labelOf(d: string, level: Level, prev: string | null): { label: string; major: boolean } {
  const newYear = prev == null || year(prev) !== year(d);
  const newMonth = prev == null || prev.slice(0, 7) !== d.slice(0, 7);
  if (level === "year") return { label: year(d), major: true };
  if (level === "month" || level === "quarter") {
    return newYear ? { label: year(d), major: true } : { label: monthShort(month(d)), major: false };
  }
  // day / week: the day number, with the month name where a new month starts.
  if (newMonth) return { label: newYear && prev != null ? year(d) : monthShort(month(d)), major: true };
  return { label: String(Number(d.slice(8, 10))), major: false };
}

/**
 * Labels for the visible candles. `keys` are candle start dates, `slotPx` the width of one candle slot.
 * The aggregation sets the finest sensible level (no day labels on monthly candles).
 */
export function timeTicks(keys: string[], i0: number, i1: number, slotPx: number, agg: EquityAgg = "day", minPx = 64): TimeTick[] {
  const a = Math.max(0, Math.floor(i0));
  const b = Math.min(keys.length - 1, Math.ceil(i1));
  if (b < a || !(slotPx > 0)) return [];
  const levels: Level[] = agg === "month" ? ["month", "quarter", "year"] : agg === "week" ? ["week", "month", "quarter", "year"] : ["day", "week", "month", "quarter", "year"];
  for (const level of levels) {
    const idx: number[] = [];
    for (let i = a; i <= b; i++) {
      if (i === 0 || bucket(keys[i], level) !== bucket(keys[i - 1], level)) idx.push(i);
    }
    // Spacing check on the real pixel gaps (buckets are uneven: holidays, months with fewer trading days).
    // The first / last bucket is usually cut by the window edge — judge by the inner gaps (thin() fixes the rest).
    let minGap = Infinity;
    const k0 = idx.length > 3 ? 2 : 1, k1 = idx.length > 3 ? idx.length - 1 : idx.length;
    for (let k = k0; k < k1; k++) minGap = Math.min(minGap, (idx[k] - idx[k - 1]) * slotPx);
    if (idx.length <= 1 || minGap >= minPx || level === "year") {
      const out = thin(idx, slotPx, minPx).map((i) => ({ index: i, ...labelOf(keys[i], level, i > 0 ? keys[i - 1] : null) }));
      // Zoomed into the middle of a month: the first label carries the month for context («29 июн»).
      const first = out[0];
      if (first && !first.major && (level === "day" || level === "week")) first.label = `${first.label} ${monthShort(month(keys[first.index]))}`;
      return out;
    }
  }
  return [];
}

/** Drops labels that would still collide (year level on a very long range). */
function thin(idx: number[], slotPx: number, minPx: number): number[] {
  const out: number[] = [];
  for (const i of idx) {
    if (!out.length || (i - out[out.length - 1]) * slotPx >= minPx) out.push(i);
  }
  return out;
}

/** «пт, 15 окт» / «пт, 15 окт 2025» — crosshair pill on the time axis. */
export function crosshairDate(d: string, agg: EquityAgg, currentYear: string): string {
  const y = year(d) !== currentYear ? ` ${year(d)}` : "";
  if (agg === "month") return `${fmtMonth(month(d), "long")} ${year(d)}`;
  const day = `${Number(d.slice(8, 10))} ${monthShort(month(d))}${y}`;
  if (agg === "week") return equityChartI18n.t("axis.week", { day });
  return equityChartI18n.t("axis.day", { weekday: fmtWeekday(new Date(`${d}T12:00:00Z`).getUTCDay(), "short"), day });
}
