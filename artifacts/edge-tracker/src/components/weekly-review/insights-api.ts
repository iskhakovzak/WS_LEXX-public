/**
 * Read-only feeds for the «Отчёт недели» insights. Every hook GETs an existing engine
 * (behavior, whatif, day-report, benchmark, risk desk) and resolves to `null` when the endpoint is
 * missing or fails — the report then simply shows fewer tips instead of an error.
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { addDays } from "@/lib/trading-date";
import type { BehaviorReport, DayReportLite, FeeReport, SimSuggestion } from "@/lib/weeklyInsights";
import type { RiskStatus, WeekInfo } from "./api";

const qs = (p: Record<string, string | null | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) s.set(k, v);
  return s.toString();
};

export const insightKeys = {
  all: ["weekly-insights"] as const,
  behavior: (trader: string, from: string, to: string) => ["weekly-insights", "behavior", trader, from, to] as const,
  fees: (trader: string, from: string, to: string) => ["weekly-insights", "fees", trader, from, to] as const,
  sim: (trader: string, from: string, to: string) => ["weekly-insights", "sim", trader, from, to] as const,
  day: (trader: string, date: string) => ["weekly-insights", "day", trader, date] as const,
  bench: (from: string, to: string) => ["weekly-insights", "bench", from, to] as const,
  riskDesk: () => ["weekly-insights", "risk-desk"] as const,
};

const STALE = 60_000;

/** Behavior engine over the week + 4 prior weeks (per-week pattern slices, discipline trend). */
export function useWeekBehavior(trader: string | null, week: WeekInfo | null | undefined) {
  const from = week ? addDays(week.start, -28) : "";
  const to = week?.end ?? "";
  return useQuery({
    queryKey: insightKeys.behavior(trader ?? "", from, to),
    queryFn: () => http.get<BehaviorReport>(`/api/behavior?${qs({ trader, from, to })}`).catch(() => null),
    enabled: !!trader && !!week,
    staleTime: STALE,
  });
}

/** Commission breakdown for the week (scalps, time-of-day windows, break-even). */
export function useWeekFees(trader: string | null, week: WeekInfo | null | undefined) {
  const from = week?.start ?? "";
  const to = week?.end ?? "";
  return useQuery({
    queryKey: insightKeys.fees(trader ?? "", from, to),
    queryFn: () => http.get<FeeReport>(`/api/whatif/fees?${qs({ trader, from, to })}`).catch(() => null),
    enabled: !!trader && !!week,
    staleTime: STALE,
  });
}

export const SIM_WEEKS = 8;

/** Simulator rule suggestions over the last 8 weeks up to the week's Friday (needs a larger sample). */
export function useSimSuggestions(trader: string | null, week: WeekInfo | null | undefined) {
  const from = week ? addDays(week.start, -(SIM_WEEKS - 1) * 7) : "";
  const to = week?.end ?? "";
  return useQuery({
    queryKey: insightKeys.sim(trader ?? "", from, to),
    queryFn: async () => (await http.get<{ suggestions?: SimSuggestion[] }>(`/api/whatif/suggestions?${qs({ trader, from, to })}`).catch(() => null))?.suggestions ?? null,
    enabled: !!trader && !!week,
    staleTime: STALE,
  });
}

// Module-level so react-query can memoise the combined result (stable `data` across renders).
const combineDays = (results: Array<{ data?: DayReportLite | null; isLoading: boolean }>) => ({
  data: results.map((r) => r.data).filter((d): d is DayReportLite => !!d && typeof d.date === "string"),
  loading: results.some((r) => r.isLoading),
});

/** Day reports for the week's trading days (leaks with $ cost, plan items). */
export function useWeekDayReports(trader: string | null, dates: string[]) {
  return useQueries({
    queries: dates.map((date) => ({
      queryKey: insightKeys.day(trader ?? "", date),
      queryFn: () => http.get<DayReportLite>(`/api/day-report?${qs({ trader, date })}`).catch(() => null),
      enabled: !!trader,
      staleTime: STALE,
    })),
    combine: combineDays,
  });
}

// ── Benchmark (desk median, per-trader trend) ────────────────────────────────

export type BenchBadge = { kind: "strength" | "weakness"; key: string; label: string; detail?: string };
export type BenchRow = {
  trader: string; trades: number; days: number; winRate: number | null; net: number | null; gross: number | null; fees: number | null;
  feeShare: number | null; profitFactor: number | null; expectancy: number | null; payoff: number | null; maxDd: number | null;
  avgHoldMin: number | null; tradesPerDay: number | null; first15Share: number | null; badges?: BenchBadge[]; qualified?: boolean;
};
export type BenchTrend = {
  trader: string;
  weeks: Array<{ week: string; net: number | null; trades: number }>;
  verdict: "better" | "worse" | "flat" | "nodata";
  curM?: { net: number | null } | null;
  prevM?: { net: number | null } | null;
};
export type BenchMetric = { key: string; label: string; unit?: string; better?: "higher" | "lower"; hint?: string };
export type Benchmark = {
  viewer?: { name: string; staff: boolean; scope?: string };
  deskSize: number;
  minTrades?: number;
  metrics?: BenchMetric[];
  rows: BenchRow[];
  median: Record<string, number | null>;
  trend: BenchTrend[];
};

export function useWeekBenchmark(week: WeekInfo | null | undefined, enabled = true) {
  const from = week?.start ?? "";
  const to = week?.end ?? "";
  return useQuery({
    queryKey: insightKeys.bench(from, to),
    queryFn: () => http.get<Benchmark>(`/api/benchmark?${qs({ period: "week", from, to })}`).catch(() => null),
    enabled: enabled && !!week,
    staleTime: STALE,
  });
}

// ── Risk desk (fallback for the partners table when the overview has no `risk`) ──

export type RiskDeskRow = { trader: string; status: "ok" | "warn" | "breach" | string; breaches?: unknown[] | number };
export function useRiskDeskNow(enabled: boolean) {
  return useQuery({
    queryKey: insightKeys.riskDesk(),
    queryFn: async () => {
      const r = await http.get<{ traders?: RiskDeskRow[] }>("/api/risk/desk").catch(() => null);
      if (!r?.traders) return null;
      const m = new Map<string, RiskStatus>();
      for (const t of r.traders) m.set(t.trader, t.status === "breach" ? "breach" : t.status === "warn" ? "warn" : t.status === "ok" ? "ok" : "none");
      return m;
    },
    enabled,
    staleTime: STALE,
  });
}
