import type { Trade as ApiTrade } from "@workspace/api-client-react";
import { nyDate } from "@/lib/trading-date";
import { HORIZON_LABEL as TRADES_HORIZON_LABEL } from "@/components/shared/trade-labels";
import { fmtDate, fmtR, fmtUsd, fmtWeekday } from "@/lib/format";
import {
  closeDate, computeKpis, feesOf, grossPnl, isOpen, netPnl, resultOf, signedR, type Kpis,
} from "@/lib/trade-math";

/**
 * Trade with the newer optional columns (fees, qty, riskUsd, horizon, exitDate, PropReports source). Declared
 * explicitly so this section type-checks both against stale and regenerated api-client typings.
 */
export type Trade = ApiTrade & {
  fees?: number | null;
  qty?: number | null;
  riskUsd?: number | null;
  horizon?: "intraday" | "overnight" | "swing" | null;
  exitDate?: string | null;
  source?: "propreports" | "manual" | string | null;
  externalId?: string | null;
  brokerAccount?: string | null;
  syncedAt?: string | null;
};

// ── Dates (YYYY-MM-DD; "today" is the New York trading date) ───────────────────

export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The desk's trading date (America/New_York), never the browser's local date. */
export function todayStr(): string {
  return nyDate();
}

export function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function isIsoDate(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(parseDate(s).getTime());
}

export function addDays(s: string, n: number): string {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}

/** Next/previous weekday (skips Sat/Sun). */
export function stepWeekday(s: string, dir: 1 | -1): string {
  let d = addDays(s, dir);
  for (let i = 0; i < 3; i++) {
    const wd = parseDate(d).getDay();
    if (wd !== 0 && wd !== 6) break;
    d = addDays(d, dir);
  }
  return d;
}

/** ISO week key «YYYY-Www» (the /weekly-review ?week= format). */
export function isoWeekKey(s: string): string {
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  const wd = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - wd + 3); // Thursday of this week decides the year
  const year = dt.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((dt.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Monday of the week containing s. */
export function weekStart(s: string): string {
  const d = parseDate(s);
  const wd = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - wd);
  return localDateStr(d);
}

export function monthKey(s: string): string {
  return s.slice(0, 7);
}

export function monthBounds(mk: string): { from: string; to: string } {
  const [y, m] = mk.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0);
  return { from: localDateStr(first), to: localDateStr(last) };
}

export function shiftMonth(mk: string, n: number): string {
  const [y, m] = mk.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return localDateStr(d).slice(0, 7);
}

const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Calendar header «Пн» … «Вс» (Monday first) in the UI language. */
export function weekdaysShortMonFirst(): string[] {
  return [1, 2, 3, 4, 5, 6, 0].map((d) => capFirst(fmtWeekday(d, "short")));
}

/** Month key "2026-10" → «Октябрь 2026 г.» (heading, capitalised). */
export function fmtMonthTitle(mk: string): string {
  return capFirst(fmtDate(`${mk.slice(0, 7)}-01`, "monthYear"));
}

// ── Trade metrics (all R / P&L math comes from @/lib/trade-math — never redefine it here) ──

export type Outcome = "win" | "loss" | "be" | "open";

export function tradeOutcome(t: Trade): Outcome {
  if (isOpen(t)) return "open";
  return resultOf(t) ?? "open";
}

/** Horizon code → label (current language); the trades area owns the labels. */
export const HORIZON_LABEL: Record<string, string> = TRADES_HORIZON_LABEL;

export function isMultiDay(t: Trade): boolean {
  return t.horizon === "overnight" || t.horizon === "swing" || !!t.exitDate;
}

/** The day a trade's result is realised (exit date for multi-day holds, else the trade date). */
export function realisedDate(t: Trade): string {
  return closeDate(t) ?? t.date;
}

/**
 * Positions opened before `day` that are still held on it: multi-day trades either exited strictly after `day`
 * or still open (and `day` is not in the future).
 */
export function carriedInto(trades: Trade[], day: string, today: string): Trade[] {
  return trades.filter((t) => {
    if (!(t.date < day)) return false;
    if (!isMultiDay(t)) return false;
    if (t.exitDate) return t.exitDate > day;
    return isOpen(t) && day <= today;
  });
}

/** Trades entered on `day` whose result is realised on a later day (shown as «открыто» on the entry day). */
export function openedOn(trades: Trade[], day: string): Trade[] {
  return trades.filter((t) => t.date === day && realisedDate(t) !== day);
}

/** Risk per share (|entry − stop|) as % of entry. */
export function tradeRiskPct(t: Trade): number | null {
  if (t.entry == null || t.stop == null || !(t.entry > 0)) return null;
  return Math.abs(t.entry - t.stop) / t.entry;
}

export type DayStats = {
  date: string;
  /** Trades realised on this day (closed on it, or open trades entered on it). */
  trades: number;
  /** Entered on this day but realised later (multi-day holds) — not part of this day's P&L. */
  opened: number;
  wins: number;
  losses: number;
  be: number;
  open: number;
  /** Net P&L (gross − fees); null when no trade of the day has a P&L. */
  pnl: number | null;
  gross: number | null;
  fees: number | null;
  r: number | null;
  rCount: number;
  /** Mean R over closed trades with an R. */
  expectancyR: number | null;
  /** wins / (wins + losses) — break-even excluded. */
  winRate: number | null;
  best: Trade | null;
  worst: Trade | null;
  kpis: Kpis;
};

export function computeStats(date: string, trades: Trade[], opened = 0): DayStats {
  const k = computeKpis(trades);
  let best: Trade | null = null, worst: Trade | null = null;
  let bestV = -Infinity, worstV = Infinity;
  for (const t of trades) {
    const v = netPnl(t) ?? signedR(t);
    if (v == null) continue;
    if (v > bestV) { bestV = v; best = t; }
    if (v < worstV) { worstV = v; worst = t; }
  }
  return {
    date,
    trades: trades.length,
    opened,
    wins: k.wins, losses: k.losses, be: k.be, open: k.open,
    pnl: k.netPnl, gross: k.grossPnl, fees: k.pnlCount ? k.fees : null,
    r: k.rCount ? k.totalR : null, rCount: k.rCount, expectancyR: k.expectancyR, winRate: k.winRate,
    best, worst, kpis: k,
  };
}

/** Group trades by the day their result is realised (exit day for multi-day holds). */
export function groupByDate(trades: Trade[]): Map<string, Trade[]> {
  const m = new Map<string, Trade[]>();
  for (const t of trades) {
    const d = realisedDate(t);
    const arr = m.get(d);
    if (arr) arr.push(t);
    else m.set(d, [t]);
  }
  return m;
}

/** Count of trades entered per day that are realised on a later day. */
export function openedCountByDate(trades: Trade[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of trades) {
    if (realisedDate(t) === t.date) continue;
    m.set(t.date, (m.get(t.date) ?? 0) + 1);
  }
  return m;
}

/**
 * One unit per view: money only when EVERY day with trades in the set has a net P&L, otherwise R.
 * Mixing «$ for some days, R for others» in the same list is never allowed.
 */
export function pickUnit(stats: Iterable<DayStats>): "pnl" | "r" {
  let any = false;
  for (const s of stats) {
    if (s.trades === 0) continue;
    any = true;
    if (s.pnl == null) return "r";
  }
  return any ? "pnl" : "r";
}

export function dayValue(s: DayStats | undefined, unit: "pnl" | "r"): number | null {
  if (!s) return null;
  return unit === "pnl" ? s.pnl : s.r;
}

export function fmtUnit(v: number | null | undefined, unit: "pnl" | "r", digits = 1): string {
  return unit === "pnl" ? fmtUsd(v, { signed: true, decimals: "auto" }) : fmtR(v, digits);
}

export function splitTags(s: string | null | undefined): string[] {
  if (!s) return [];
  return s.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
}

/** Whether keyboard shortcuts should be ignored (typing in a field / dialog open). */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!el.closest("[role=dialog],[role=listbox],[role=menu]");
}

// Re-exported so journal components import every number from one place.
export { signedR, netPnl, grossPnl, feesOf, isOpen };
