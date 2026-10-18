/**
 * Data layer for «Разбор дня»: types (mirror of api-server lib/dayReport.ts + routes/day-report.ts),
 * react-query hooks, trading-day navigation (weekends + market holidays) and formatting.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { dayReportI18n } from "@/i18n/ns/dayReport";
import { commonI18n } from "@/i18n/ns/common";
import { http } from "@/lib/api/http";
import { addDays, nyDate } from "@/lib/trading-date";
import { fmtDate, } from "@/lib/format";

// ── Types ────────────────────────────────────────────────────────────────────
export type Side = "long" | "short";
export type TimeSource = "executions" | "snapshot" | "none";

export type TradeRef = {
  id: number; ticker: string; side: Side | null; net: number | null; gross: number | null; fees: number;
  qty: number | null; entryTime: string | null; exitTime: string | null; holdMin: number | null; setup: string | null;
};

export type Summary = {
  trades: number; closed: number; open: number; wins: number; losses: number; be: number;
  winRate: number | null; net: number; gross: number; fees: number; feeShareOfGross: number | null;
  profitFactor: number | null; avgWin: number | null; avgLoss: number | null; expectancy: number | null;
  best: TradeRef | null; worst: TradeRef | null; volumeShares: number;
};

export type DailyNet = { date: string; net: number };

export type Comparison = {
  days: number; avg: number | null; std: number | null; z: number | null; betterThanPct: number | null; rank: number | null;
  bestDay: DailyNet | null; worstDay: DailyNet | null; label: string;
};

export type EquityPoint = { t: number | null; time: string | null; tradeId: number | null; ticker: string | null; net: number; cum: number };

export type Equity = {
  timeSource: TimeSource;
  points: EquityPoint[];
  peak: { value: number; time: string | null; tradeId: number | null };
  trough: { value: number; time: string | null; tradeId: number | null };
  maxDrawdown: { value: number; fromTime: string | null; toTime: string | null; fromTradeId: number | null; toTradeId: number | null };
  final: number;
  giveback: number;
};

export type TimelineRow = TradeRef & {
  index: number; result: "win" | "loss" | "be" | "open" | null;
  gapMin: number | null; overlap: boolean; cumAfter: number | null; afterLoss: boolean;
};

export type Bucket = { key: string; label: string; trades: number; wins: number; losses: number; winRate: number | null; net: number; gross: number; fees: number };

export type LeakKind = "fee_over_gross" | "after_peak" | "revenge" | "size_up" | "after_limit";

export type Leak = {
  kind: LeakKind; title: string; detail: string; count: number; tradeIds: number[];
  netUsd: number; costUsd: number; severity: "high" | "medium" | "low";
};

export type EdgeItem = { key: string; label: string; trades: number; wins: number; losses: number; net: number; winRate: number | null };

export type PlanItem = { id: string; text: string; reason: string; costUsd: number | null; source: LeakKind | "stat" };

export type DayReport = {
  trader: string; date: string; weekday: string;
  summary: Summary; comparison: Comparison; equity: Equity; timeline: TimelineRow[];
  breakdown: { byTicker: Bucket[]; byHour: Bucket[]; bySide: Bucket[] };
  leaks: Leak[]; leaksTotalUsd: number;
  strengths: { topTrades: TradeRef[]; tickers: EdgeItem[]; setups: EdgeItem[]; sides: EdgeItem[]; bestHour: Bucket | null };
  plan: PlanItem[];
  dailyLossLimit: number | null;
  dailyLossLimitSource: "personal" | "tier" | null;
  firstEntry: string | null; lastExit: string | null; activeMinutes: number | null;
  nav: { prevTradeDate: string | null; nextTradeDate: string | null };
  traders: string[];
  canPickTrader: boolean;
  today: string;
  generatedAt: string;
};

// ── HTTP ─────────────────────────────────────────────────────────────────────
export const dayReportKeys = {
  all: ["day-report"] as const,
  doc: (trader: string, date: string) => ["day-report", trader, date] as const,
  holidays: (year: number) => ["day-report", "holidays", year] as const,
};

export function useDayReport(trader: string | null, date: string, enabled = true) {
  return useQuery({
    queryKey: dayReportKeys.doc(trader ?? "", date),
    queryFn: () => {
      const q = new URLSearchParams({ date });
      if (trader) q.set("trader", trader);
      return http.get<DayReport>(`/api/day-report?${q.toString()}`);
    },
    enabled: enabled && isYmd(date),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

type HolidayEvent = { date: string; type: string };

/** Market-closed days (type "holiday") for the year of `date` ± a week of margin. */
export function useMarketHolidays(date: string) {
  const year = Number(date.slice(0, 4)) || new Date().getFullYear();
  return useQuery({
    queryKey: dayReportKeys.holidays(year),
    queryFn: async () => {
      const j = await http.get<{ events: HolidayEvent[] }>(`/api/holidays?from=${year - 1}-12-01&to=${year + 1}-01-31&types=holiday`);
      return new Set(j.events.filter((e) => String(e.type).toLowerCase() === "holiday").map((e) => String(e.date).slice(0, 10)));
    },
    staleTime: 6 * 60 * 60_000,
  });
}

// ── Trading-day helpers ──────────────────────────────────────────────────────
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isYmd(v: string | null | undefined): v is string {
  if (!v || !YMD_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isWeekendYmd(date: string): boolean {
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  return wd === 0 || wd === 6;
}

export function isTradingDay(date: string, holidays: ReadonlySet<string> | undefined): boolean {
  return !isWeekendYmd(date) && !(holidays?.has(date) ?? false);
}

/** Next (dir = 1) or previous (dir = −1) trading day, skipping weekends and market holidays. */
export function shiftTradingDay(date: string, dir: 1 | -1, holidays: ReadonlySet<string> | undefined): string {
  let d = addDays(date, dir);
  for (let i = 0; i < 14 && !isTradingDay(d, holidays); i++) d = addDays(d, dir);
  return d;
}

/** Last trading day on or before today (NY). */
export function lastTradingDay(holidays: ReadonlySet<string> | undefined): string {
  const today = nyDate();
  return isTradingDay(today, holidays) ? today : shiftTradingDay(today, -1, holidays);
}

// ── Formatting ───────────────────────────────────────────────────────────────
// Money / percent: @/lib/format (fmtUsd, fmtRate).
export function fmtHold(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return "—";
  const t = dayReportI18n.t;
  if (min < 1) return t("hold.s", { n: Math.max(1, Math.round(min * 60)) });
  if (min < 60) return t("hold.m", { n: Math.round(min) });
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return m ? t("hold.hm", { h, m }) : t("hold.h", { h });
}

/** "Чт, 15 октября 2026 г." (UI language). */
export function fmtDayLong(ymd: string): string {
  if (!isYmd(ymd)) return ymd;
  const s = fmtDate(ymd, "fullShortWeekday");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "15 окт" (UI language). */
export function fmtDayShort(ymd: string): string {
  if (!isYmd(ymd)) return ymd;
  return fmtDate(ymd, "dayMonth").replace(".", "");
}

/** Side code → label in the current language (read on access). */
export const SIDE_LABEL: Record<Side, string> = Object.defineProperties({} as Record<Side, string>, {
  long: { get: () => commonI18n.t("trading.long"), enumerable: true },
  short: { get: () => commonI18n.t("trading.short"), enumerable: true },
});
