// Pure «Закрытие дня» rules (no DB) — used by routes/eod.ts and checked offline with synthetic data.
import { addDays, isWeekend } from "./tradingDate";
import { errorMessage } from "./http/errors";

export type MissingField = "setup" | "grade";
export type MissingItem = { tradeId: number; ticker: string; fields: MissingField[] };
export type ReviewableTrade = { id: number; ticker: string; setup: string | null; confidenceGrade: string | null };

export const GRADES = ["A+", "A", "B", "C"] as const;

export function nextTradingDay(date: string): string {
  let d = addDays(date, 1);
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
}
export function prevTradingDay(date: string): string {
  let d = addDays(date, -1);
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}

/** Which required review fields a trade still lacks (setup + grade are mandatory to close the day). */
export function missingFields(t: { setup: string | null; confidenceGrade: string | null }): MissingField[] {
  const out: MissingField[] = [];
  if (!t.setup || !t.setup.trim()) out.push("setup");
  if (!t.confidenceGrade || !(GRADES as readonly string[]).includes(t.confidenceGrade)) out.push("grade");
  return out;
}

export function missingList(trades: ReviewableTrade[]): MissingItem[] {
  const out: MissingItem[] = [];
  for (const t of trades) {
    const fields = missingFields(t);
    if (fields.length) out.push({ tradeId: t.id, ticker: t.ticker, fields });
  }
  return out;
}

/** `reasonCode` = the API error code that blocks the close; `reason` = its RU text (translate the code per request). */
export function canCloseDay(args: { date: string; today: string; trades: ReviewableTrade[] }): { ok: boolean; missing: MissingItem[]; reason: string | null; reasonCode?: "EOD_FUTURE_DAY" | "EOD_INCOMPLETE" } {
  if (args.date > args.today) return { ok: false, missing: [], reason: errorMessage("EOD_FUTURE_DAY", "ru"), reasonCode: "EOD_FUTURE_DAY" };
  const missing = missingList(args.trades);
  if (missing.length) return { ok: false, missing, reason: errorMessage("EOD_INCOMPLETE", "ru"), reasonCode: "EOD_INCOMPLETE" };
  return { ok: true, missing: [], reason: null };
}

export type Streaks = { closedStreak: number; reviewedStreak: number; closedTotal: number; lastClosed: string | null };

/**
 * closedStreak   — consecutive trading days (weekdays) ending today (if closed) or the previous trading day, all closed.
 * reviewedStreak — consecutive trading days WITH trades where every trade is fully reviewed
 *                  (setup + grade + followed-plan); days without trades neither count nor break it.
 */
export function computeStreaks(args: {
  today: string;
  closedDates: Set<string>;
  tradeDays: Map<string, { n: number; reviewed: number }>;
}): Streaks {
  const { today, closedDates, tradeDays } = args;
  const start = closedDates.has(today) ? today : prevTradingDay(today);
  let closedStreak = 0;
  for (let d = start, i = 0; i < 600; d = prevTradingDay(d), i++) {
    if (!closedDates.has(d)) break;
    closedStreak++;
  }
  let reviewedStreak = 0;
  let gap = 0;
  for (let d = today, i = 0; i < 600; d = prevTradingDay(d), i++) {
    const td = tradeDays.get(d);
    if (!td) {
      if (++gap > 60) break; // 60 trading days without a single trade: stop walking
      continue;
    }
    gap = 0;
    if (td.reviewed < td.n) break;
    reviewedStreak++;
  }
  const sorted = Array.from(closedDates).sort();
  return { closedStreak, reviewedStreak, closedTotal: closedDates.size, lastClosed: sorted.length ? sorted[sorted.length - 1] : null };
}
