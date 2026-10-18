/**
 * Data layer of «Статистика офиса»: lib/api/http calls for /api/office-stats* (no orval codegen for new endpoints)
 * and response types mirrored from api-server/src/lib/officeStats.ts + routes/officeStats.ts.
 *
 * Admin (partner) responses carry both views (`usd`, `pct`) + capital; member responses carry `pct` only —
 * the server strips $, absolute volume and per-trader rows before sending.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { STALE } from "@/lib/api/keys";
import { fmtCompact, fmtCount, fmtDate, fmtMonth, fmtPct, fmtRate, fmtUsd } from "@/lib/format";

export const STRATEGIES = ["OPG", "OPGtoDAY", "Day", "MOC", "AfterMarket", "Overnight", "OPT"] as const;
export type Strategy = (typeof STRATEGIES)[number];
export type Unit = "usd" | "pct";

export type DayValue = { date: string; v: number };

export type Totals = {
  net: number; trades: number; wins: number; losses: number; winRate: number | null; profitFactor: number | null;
  avgR: number | null; volume?: number; tradingDays: number; greenDays: number; redDays: number; avgDay: number | null;
  bestDay: DayValue | null; worstDay: DayValue | null;
};

export type StrategyRow = {
  key: Strategy; trades: number; wins: number; losses: number; winRate: number | null; net: number;
  profitFactor: number | null; avgR: number | null; netShare: number | null; volumeShare: number | null; volume?: number;
};
export type YearStrategyRow = StrategyRow & { cum: number[]; monthly: (number | null)[] };

export type DayPoint = { date: string; doy: number; v: number; cum: number; trades: number; s: Partial<Record<Strategy, number>> };
export type MonthRow = { month: number; v: number | null; trades: number; days: number; green: number; red: number };

export type DrawdownInfo = {
  max: number; peakDate: string | null; troughDate: string | null; recoveredDate: string | null;
  recoveryDays: number | null; lengthDays: number | null; current: number; currentDays: number;
};
export type Pace = {
  goal: number; expected: number; actual: number; gap: number; needPerMonth: number; monthsLeft: number;
  projected: number | null; elapsed: number; status: "done" | "ahead" | "behind";
};

export type YearView = {
  year: number; goalPct: number; goal: number | null; capitalMissing: boolean; hasData: boolean;
  totals: Totals; days: DayPoint[]; strategies: YearStrategyRow[]; months: MonthRow[];
  drawdown: DrawdownInfo; streaks: { maxGreen: number; maxRed: number; current: number }; pace: Pace | null;
};

export type TimeBucket = { key: string; label: string; fromSec: number | null; v: number; trades: number; wins: number; losses: number; winRate: number | null };
export type WeekdayRow = { weekday: number; label: string; v: number; days: number; green: number; avg: number | null };
export type TickerRow = { ticker: string; trades: number; v: number; winRate: number | null; share: number | null; strategy: Strategy };
export type TraderRow = {
  trader: string; trades: number; net: number; share: number | null; winRate: number | null; profitFactor: number | null;
  volume: number; volumeShare: number | null; activeDays: number; greenDays: number; consistency: number | null;
  bestDay: DayValue | null; worstDay: DayValue | null; maxDrawdown: number; topStrategy: Strategy | null; spark: number[];
};

export type PeriodView = {
  from: string; to: string; totals: Totals; strategies: StrategyRow[]; timeOfDay: TimeBucket[]; weekday: WeekdayRow[];
  tickers: { top: TickerRow[]; bottom: TickerRow[] }; traders?: TraderRow[];
};
export type PrevPeriod = { from: string; to: string; totals: Totals; strategies: { key: Strategy; net: number }[] };
export type Insight = { key: string; tone: "up" | "down" | "warn" | "neutral"; text: string };

export type OfficeView = { unit: Unit; years: YearView[]; period: PeriodView; prev: PrevPeriod | null; insights: Insight[] };

export type Rules = {
  strategies: { key: Strategy; text: string }[];
  order: string;
  thresholds: { openAuctionUntil: string; opgExitBy: string; mocFrom: string; closeCross: string };
  notes: string[];
};

type Base = { years: number[]; period: { from: string; to: string }; today: string; rules: Rules };
export type AdminSetting = { year: number; capital: number | null; goalPct: number; updatedBy: string | null; updatedAt: string | null };
export type AdminResponse = Base & { role: "admin"; settings: AdminSetting[]; usd: OfficeView; pct: OfficeView };
export type MemberResponse = Base & { role: "member"; settings: { year: number; goalPct: number; hasCapital: boolean }[]; pct: OfficeView };
export type OfficeStatsResponse = AdminResponse | MemberResponse;

export type OfficeParams = { years: number[]; from: string | null; to: string | null };

export function useOfficeStats(p: OfficeParams, enabled = true) {
  return useQuery({
    queryKey: ["office-stats", p.years.join(","), p.from, p.to],
    queryFn: ({ signal }) =>
      http.get<OfficeStatsResponse>("/api/office-stats", { query: { years: p.years.join(","), from: p.from, to: p.to }, signal }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: STALE.short,
  });
}

export function useSaveCapital() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { year: number; capital: number | null; goalPct: number }) => http.put<AdminSetting>("/api/office-stats/capital", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["office-stats"] }),
  });
}

// ─── Formatting ────────────────────────────────────────────────────────────

/** Value in the office unit: +1.23% (return on capital) / −$1,234 — signed by default; fewer decimals as it grows. */
export function fmtV(v: number | null | undefined, unit: Unit, o: { signed?: boolean; digits?: number } = {}): string {
  const signed = o.signed ?? true;
  const a = v == null ? 0 : Math.abs(v);
  if (unit === "pct") return fmtPct(v, { signed, decimals: o.digits ?? (a >= 100 ? 0 : a >= 10 ? 1 : 2) });
  return fmtUsd(v, { signed, decimals: o.digits ?? (a >= 100 ? 0 : 2) });
}

/** Compact axis label: +12% / −$4.5K. */
export function fmtAxis(v: number, unit: Unit): string {
  if (Math.abs(v) < 1e-9) return unit === "pct" ? "0%" : "$0";
  const a = Math.abs(v);
  if (unit === "pct") return fmtPct(v, { signed: false, decimals: a >= 10 ? 0 : a >= 1 ? 1 : 2 }).replace(/\.0%$/, "%").replace(/(\.\d)0%$/, "$1%");
  return fmtUsd(v, { compact: true });
}

/** Contribution style: 4.21% / (2.77%) — accounting parentheses for negatives. */
export function fmtParen(v: number | null | undefined, unit: Unit): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = fmtV(Math.abs(v), unit, { signed: false });
  return v < 0 ? `(${s})` : s;
}

/** Share 0…1 → "57%" (no "−0%" for a tiny negative). */
export function fmtShare(x: number | null | undefined, digits = 0): string {
  return fmtRate(x, digits);
}

/** Trade / share counts: locale grouping below 10,000, compact above (12.3K, 1.2M). */
export function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.abs(n) >= 10_000 ? fmtCompact(n) : fmtCount(Math.round(n));
}

/** Short month 0–11 without the abbreviation dot: «янв» / «Jan». */
export const monthShort = (i: number) => fmtMonth(i, "short").replace(".", "");
/** Month 0–11 with a capital letter: «Январь» / «January». */
export const monthLong = (i: number) => {
  const s = fmtMonth(i, "long");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function fmtDay(ymd: string | null | undefined): string {
  if (!ymd) return "—";
  return fmtDate(ymd, "dayMonth").replace(".", "");
}
export function fmtDayLong(ymd: string): string {
  return fmtDate(ymd, "fullShortWeekday");
}
/** Calendar date of a day-of-year (1-based) in a year. */
export function dateOfDoy(year: number, doy: number): string {
  return new Date(Date.UTC(year, 0, doy)).toISOString().slice(0, 10);
}
