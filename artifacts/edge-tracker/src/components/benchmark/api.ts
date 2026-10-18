/**
 * Data layer of «Бенчмарк деска»: raw fetch helpers for /api/benchmark* (no orval codegen for new endpoints)
 * and response types mirrored from api-server/src/lib/benchmark.ts + routes/benchmark.ts.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { http } from "@/lib/api/http";

export type Result = "win" | "loss" | "be";
export type Side = "long" | "short";
export type MetricUnit = "usd" | "pct" | "ratio" | "count" | "min" | "r" | "days";

export type DayPoint = { day: string; net: number; cum: number };
export type Badge = { kind: "strength" | "weakness"; key: string; label: string; detail: string };

export type TraderMetrics = {
  trader: string;
  trades: number; pnlTrades: number; days: number; tradesPerDay: number | null;
  wins: number; losses: number; be: number; winRate: number | null;
  net: number | null; gross: number | null; fees: number | null; feeShare: number | null;
  profitFactor: number | null; expectancy: number | null;
  avgWin: number | null; avgLoss: number | null; payoff: number | null;
  bestTrade: number | null; worstTrade: number | null;
  dailyMean: number | null; dailyVol: number | null; sharpe: number | null; sortino: number | null;
  maxDd: number | null; recoveryDays: number | null; ddRecovered: boolean | null; ddDays: number | null; currentDd: number | null;
  greenDays: number; redDays: number; greenShare: number | null;
  bestDay: { day: string; net: number } | null; worstDay: { day: string; net: number } | null;
  bestDayShare: number | null; consistencyFlag: "ok" | "warn" | "breach" | null;
  maxWinStreak: number; maxLossStreak: number; currentStreak: number;
  avgHoldMin: number | null; avgHoldWinMin: number | null; avgHoldLossMin: number | null;
  first15Trades: number; first15Share: number | null; first15Net: number | null;
  rTrades: number; rCoverage: number | null; totalR: number | null; expectancyR: number | null; profitFactorR: number | null;
  firstDay: string | null; lastDay: string | null;
  equityUnit: "usd" | "r" | null; equity: DayPoint[];
};

export type BenchRow = TraderMetrics & {
  qualified: boolean;
  percentiles: Record<string, number | null> | null;
  badges: Badge[];
};

export type MetricKey = keyof TraderMetrics & string;

export type MetricDef = {
  key: MetricKey; label: string; unit: MetricUnit; better: "higher" | "lower"; hint: string; radar?: boolean; neutral: boolean;
};

export type TrendSlice = Pick<TraderMetrics,
  "trades" | "days" | "net" | "winRate" | "profitFactor" | "expectancy" | "sharpe" | "greenShare" | "maxDd" | "feeShare" | "tradesPerDay" | "bestDayShare" | "totalR" | "expectancyR">;

export type TrendResult = {
  trader: string;
  cur: { from: string; to: string }; prev: { from: string; to: string };
  curM: TrendSlice; prevM: TrendSlice;
  weeks: { week: string; net: number | null; r: number | null; trades: number }[];
  verdict: "better" | "worse" | "flat" | "nodata";
};

export type BenchPeriod = "week" | "month" | "quarter" | "all";

export type BenchmarkResponse = {
  period: { kind: string; from: string; to: string; today: string };
  viewer: { name: string; staff: boolean; scope: "desk" | "assigned" | "own" };
  mode: "desk" | "self";
  minTrades: number;
  deskSize: number;
  rules: { consistencyWarn: number; consistencyBreach: number; firstMinutes: number; medianMinTraders: number };
  metrics: MetricDef[];
  rows: BenchRow[];
  percentiles: Record<string, Record<string, number | null>> | null;
  median: Record<string, number | null>;
  trend: TrendResult[];
};

export type SameTickerParticipant = {
  trader: string; trades: number; side: Side | "mixed" | null; qty: number | null;
  avgEntry: number | null; avgExit: number | null; firstEntryMin: number | null; lastExitMin: number | null; holdMin: number | null;
  net: number | null; r: number | null; capturePerShare: number | null; capturePct: number | null;
  entryGapPct: number | null; exitGapPct: number | null; rank: number | null; tradeIds: number[];
};

export type SameTickerCase = {
  ticker: string; day: string; traders: number; sameSide: boolean; rankBy: "net" | "r" | "capture" | null;
  spread: number | null; participants: SameTickerParticipant[];
};

export type SameTickerResponse = {
  period: { kind: string; from: string; to: string };
  total: number;
  cases: SameTickerCase[];
  pairs: { a: string; b: string; cases: number }[];
};

export type BenchParams = { period: BenchPeriod; minTrades: number };

function qs(p: BenchParams): string {
  return new URLSearchParams({ period: p.period, minTrades: String(p.minTrades) }).toString();
}

export const benchmarkKeys = {
  all: ["benchmark"] as const,
  summary: (p: BenchParams) => ["benchmark", "summary", p.period, p.minTrades] as const,
  sameTicker: (p: BenchParams) => ["benchmark", "same-ticker", p.period] as const,
};

export function useBenchmark(p: BenchParams) {
  return useQuery({
    queryKey: benchmarkKeys.summary(p),
    queryFn: () => http.get<BenchmarkResponse>(`/api/benchmark?${qs(p)}`),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function useSameTicker(p: BenchParams, enabled: boolean) {
  return useQuery({
    queryKey: benchmarkKeys.sameTicker(p),
    queryFn: () => http.get<SameTickerResponse>(`/api/benchmark/same-ticker?${qs(p)}&limit=300`),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}
