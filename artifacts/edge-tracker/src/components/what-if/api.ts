/**
 * Data layer of the «Что-если» simulator: raw fetch helpers for /api/whatif/* (no orval codegen for new
 * endpoints) and the response types mirrored from api-server/src/lib/whatIf.ts.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { isNotFound } from "@/lib/api/errors";
import type { Rule, RuleType } from "./rules";

export type Side = "long" | "short";

export type SimTrade = {
  id: number;
  day: string;
  entryMin: number | null;
  ticker: string;
  side: Side | null;
  qty: number | null;
  entry: number | null;
  gross: number | null;
  fees: number;
  holdSec: number | null;
  setup: string | null;
  /** Engine-only fields: /whatif/base no longer sends them (payload size); kept optional for older API builds. */
  exit?: number | null;
  r?: number | null;
  stop?: number | null;
  tags?: string[];
  horizon?: "intraday" | "overnight" | "swing";
  result?: "win" | "loss" | "be" | null;
  feeBreakdown?: Record<string, number> | null;
  fills?: number | null;
  seq: number;
  /** Own grade A+…C; absent on older API builds. */
  grade?: string | null;
};

export type DayResult = { day: string; net: number; gross: number; fees: number; trades: number };
export type EquityPoint = { day: string; net: number; cum: number };

export type Metrics = {
  trades: number; wins: number; losses: number; be: number;
  gross: number; fees: number; net: number;
  winRate: number | null; profitFactor: number | null; expectancy: number | null;
  avgWin: number | null; avgLoss: number | null;
  maxDrawdown: number; days: number;
  bestDay: DayResult | null; worstDay: DayResult | null;
  dailyMean: number | null; dailyStd: number | null; sharpe: number | null;
  maxLossStreak: number;
  feePctOfGross: number | null; feePerTrade: number | null; shares: number; feePerShare: number | null;
  /** Σ R of trades with a known R (absent on older API builds). */
  totalR?: number | null; rCount?: number;
};

export type Ci = { mean: number; lo: number; hi: number };
export type MonthDist = { p5: number; p25: number; p50: number; p75: number; p95: number; probPositive: number };
export type BootstrapSummary = {
  iters: number; days: number;
  diffTotal: Ci;
  dailyExpectancy: { base: Ci; scenario: Ci };
  month: MonthDist; monthBase: MonthDist;
  significant: boolean; smallSample: boolean;
};

export type ExcludedTrade = { id: number; day: string; ticker: string; net: number; reason: string; detail: string };
export type ChangedTrade = { id: number; day: string; ticker: string; reason: string; before: number; after: number; detail: string; estimate: boolean };
export type SkippedRule = { rule: string; reason: string };

export type PeriodMeta = { from: string | null; to: string | null; withEntryTime: number; withHold: number; withR: number; withQty: number };

export type Preset = { id: string; label: string; description: string; rules: Rule[] };

export type BaseResponse = {
  scope: string | null;
  period: PeriodMeta;
  trades: SimTrade[];
  baseline: Metrics;
  equity: EquityPoint[];
  daily: DayResult[];
  presets: Preset[];
  /** Rule types the running engine understands (absent on an older API build → only the legacy set). */
  ruleTypes?: RuleType[];
  generatedAt: string;
};

export type RunResponse = {
  scope: string | null;
  period: PeriodMeta;
  rules: Rule[];
  ruleLabels: string[];
  baseline: Metrics;
  scenario: Metrics;
  baselineEquity: EquityPoint[];
  scenarioEquity: EquityPoint[];
  baselineDaily: DayResult[];
  scenarioDaily: DayResult[];
  excluded: ExcludedTrade[];
  changed: ChangedTrade[];
  skipped: SkippedRule[];
  keptIds: number[];
  bootstrap: BootstrapSummary | null;
  generatedAt: string;
};

export type Suggestion = {
  rule: Rule; label: string; improvement: number; ci: { lo: number; hi: number };
  tradesLeft: number; excluded: number; scenarioNet: number; scenarioWinRate: number | null; scenarioProfitFactor: number | null;
  /** CI of the improvement above zero (absent on an older API build, where every suggestion is robust). */
  robust?: boolean;
  removedNet?: number;
};
export type SuggestionsResponse = {
  scope: string | null; period: PeriodMeta; baselineNet: number; trades: number; days: number; smallSample: boolean;
  suggestions: Suggestion[]; generatedAt: string;
};

export type FeeGroupRow = {
  key: string; trades: number; wins: number; losses: number;
  gross: number; grossWins: number; fees: number; net: number; shares: number;
  feePctOfGross: number | null; feePctOfGrossWins: number | null; feePerTrade: number | null; feePerShare: number | null;
  breakEvenCents: number | null; eatenWinners: number;
};
export type FeesResponse = {
  scope: string | null; period: PeriodMeta;
  total: FeeGroupRow; byPrice: FeeGroupRow[]; bySize: FeeGroupRow[]; byHold: FeeGroupRow[]; byHour: FeeGroupRow[]; byTicker: FeeGroupRow[];
  byType: { key: string; label: string; amount: number; share: number }[];
  eaten: { id: number; day: string; ticker: string; qty: number | null; gross: number; fees: number; net: number; feePct: number }[];
  eatenCount: number; feesOverGrossCount: number;
  typicalQty: number | null; typicalFeePerTrade: number | null; breakEvenCents: number | null;
  recommendations: string[]; generatedAt: string;
};

export type SavedScenario = { id: number; trader: string; name: string; rules: Rule[]; labels: string[]; createdBy: string | null; createdAt: string; updatedAt: string };

export type Scope = { trader: string; from: string; to: string };

function scopeParams(s: Scope): string {
  const sp = new URLSearchParams();
  if (s.trader) sp.set("trader", s.trader);
  if (s.from) sp.set("from", s.from);
  if (s.to) sp.set("to", s.to);
  return sp.toString();
}

export const whatIfKeys = {
  all: ["whatif"] as const,
  base: (s: Scope) => ["whatif", "base", scopeParams(s)] as const,
  run: (s: Scope, rules: Rule[]) => ["whatif", "run", scopeParams(s), JSON.stringify(rules)] as const,
  suggestions: (s: Scope) => ["whatif", "suggestions", scopeParams(s)] as const,
  fees: (s: Scope) => ["whatif", "fees", scopeParams(s)] as const,
  scenarios: (trader: string) => ["whatif", "scenarios", trader] as const,
};

export function useWhatIfBase(scope: Scope, enabled = true) {
  return useQuery<BaseResponse>({ queryKey: whatIfKeys.base(scope), enabled, staleTime: 60_000, queryFn: () => http.get<BaseResponse>(`/api/whatif/base?${scopeParams(scope)}`) });
}

/** Read-only POST: nothing is stored, so it is modelled as a query (cached by scope + rules). */
export function useWhatIfRun(scope: Scope, rules: Rule[], enabled = true) {
  return useQuery<RunResponse>({
    queryKey: whatIfKeys.run(scope, rules),
    enabled,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
    queryFn: () => http.post<RunResponse>("/api/whatif/run", { trader: scope.trader || undefined, from: scope.from || undefined, to: scope.to || undefined, rules }),
  });
}

export function useWhatIfSuggestions(scope: Scope, enabled = true) {
  return useQuery<SuggestionsResponse>({ queryKey: whatIfKeys.suggestions(scope), enabled, staleTime: 5 * 60_000, queryFn: () => http.get<SuggestionsResponse>(`/api/whatif/suggestions?${scopeParams(scope)}`) });
}

export function useWhatIfFees(scope: Scope, enabled = true) {
  return useQuery<FeesResponse>({ queryKey: whatIfKeys.fees(scope), enabled, staleTime: 5 * 60_000, queryFn: () => http.get<FeesResponse>(`/api/whatif/fees?${scopeParams(scope)}`) });
}

export function useSavedScenarios(trader: string, enabled = true) {
  return useQuery<SavedScenario[]>({
    queryKey: whatIfKeys.scenarios(trader),
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      try {
        return await http.get<SavedScenario[]>(`/api/whatif/scenarios${trader ? `?trader=${encodeURIComponent(trader)}` : ""}`);
      } catch (e) {
        if (isNotFound(e)) return [];
        throw e;
      }
    },
  });
}

export function useSaveScenario(trader: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; rules: Rule[] }) => http.post<SavedScenario>("/api/whatif/scenarios", { ...body, trader: trader || undefined }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["whatif", "scenarios"] }),
  });
}

export function useDeleteScenario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => http.del<{ ok: true }>(`/api/whatif/scenarios/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["whatif", "scenarios"] }),
  });
}

/** Debounced copy of a value (the rule constructor fires on every keystroke; the server runs once it settles). */
export function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
