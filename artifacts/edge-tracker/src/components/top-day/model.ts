/**
 * «Топ дня» — pure helpers (unit-tested in __tests__/model.test.ts): the default day (last finished NY trading day),
 * the month grid, the heat level of a day.
 */
import { addDays, nyDate } from "@/lib/trading-date";
import type { CalendarDay } from "./api";

const NY_CLOSE_MIN = 16 * 60;

/** Minutes since midnight in New York (fixed en-GB digits; not UI text). */
function nyMinutes(d: Date): number {
  const [h, m] = d.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export const isWeekend = (date: string): boolean => {
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  return wd === 0 || wd === 6;
};

/** Last finished NY trading day (holidays not known here — the calendar picks the latest day with trades ≤ it). */
export function lastFinishedDay(now: Date = new Date()): string {
  const today = nyDate(now);
  if (!isWeekend(today) && nyMinutes(now) >= NY_CLOSE_MIN) return today;
  let d = addDays(today, -1);
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}

export const monthOf = (date: string): string => date.slice(0, 7);

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** Weeks of the month, Monday first; cells outside the month are null. */
export function monthGrid(month: string): (string | null)[][] {
  const first = `${month}-01`;
  const startWd = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7; // Mon = 0
  const weeks: (string | null)[][] = [];
  let row: (string | null)[] = Array.from({ length: startWd }, () => null);
  for (let d = first; monthOf(d) === month; d = addDays(d, 1)) {
    row.push(d);
    if (row.length === 7) { weeks.push(row); row = []; }
  }
  if (row.length) weeks.push([...row, ...Array.from({ length: 7 - row.length }, () => null)]);
  return weeks;
}

/** Latest day with trades not after `limit` (null when none). */
export function latestDay(days: readonly CalendarDay[], limit: string): string | null {
  let best: string | null = null;
  for (const d of days) if (d.trades > 0 && d.date <= limit && (!best || d.date > best)) best = d.date;
  return best;
}

/** Heat level 0..3 of |v| against the month's largest |v| (0 = no tint). */
export function heatLevel(v: number | null, maxAbs: number): 0 | 1 | 2 | 3 {
  if (v == null || v === 0 || maxAbs <= 0) return 0;
  const k = Math.min(1, Math.abs(v) / maxAbs);
  return k > 0.66 ? 3 : k > 0.33 ? 2 : 1;
}

export const maxAbsNet = (days: readonly CalendarDay[]): number => days.reduce((m, d) => Math.max(m, Math.abs(d.net ?? 0)), 0);
