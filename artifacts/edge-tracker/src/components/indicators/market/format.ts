import type { Tone } from "@/components/ds";
import { addDays } from "@/lib/trading-date";
import { fmtDate, fmtUsd } from "@/lib/format";

/** Signed day P&L: "+$1,234" / "−$4.20" — two decimals under $10 so small averages stay readable. */
export function usd(v: number | null | undefined, opts: { digits?: number } = {}): string {
  return fmtUsd(v, { signed: true, decimals: opts.digits ?? (v != null && Math.abs(v) < 10 ? 2 : 0) });
}

export const toneOfMoney = (v: number | null | undefined): Tone => (v == null || Math.abs(v) < 0.005 ? "neutral" : v > 0 ? "up" : "down");

/** "16 окт" / "пт, 16 окт" (UI language, no trailing dot). */
export function dayLabel(d: string, withWeekday = false): string {
  return fmtDate(d, withWeekday ? "weekdayDayMonth" : "dayMonth").replace(/\.$/, "");
}

export function nextWeekday(d: string): string {
  let n = addDays(d, 1);
  for (;;) {
    const wd = new Date(`${n}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) return n;
    n = addDays(n, 1);
  }
}

/** Minutes since midnight in New York (DST-aware). */
export function nyMinutes(d: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}
/** The regular session (9:30–16:00 NY) of `lastBarDate` is still running ⇒ its daily bar is not final yet. */
export function sessionInProgress(lastBarDate: string | null, today: string, minutes: number): boolean {
  return lastBarDate != null && lastBarDate === today && minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
