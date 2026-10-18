/**
 * Data layer of «Академия → Путь трейдера / Экзамены»: fetch helpers for /api/academy/path/* and /api/academy/challenges/*
 * and response types mirrored from api-server lib/promotionEngine.ts, lib/challengeEngine.ts and routes/academy-path.ts.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { fmtDate, fmtTimeNY } from "@/lib/format";

// ─── ladder / readiness ─────────────────────────────────────────────────────

export type StageKey = "trainee" | "junior" | "trader" | "senior";
export const STAGE_KEYS: readonly StageKey[] = ["trainee", "junior", "trader", "senior"];

export type Op = ">=" | ">" | "<=" | "<" | "=";
export const OPS: readonly Op[] = [">=", ">", "<=", "<", "="];
export const OP_LABEL: Record<Op, string> = { ">=": "≥", ">": ">", "<=": "≤", "<": "<", "=": "=" };

export type PromoUnit = "usd" | "count" | "pct" | "x" | "score100" | "score10" | "days";
export type MetricSource = "trades" | "rules" | "behavior" | "ratings" | "learning" | "challenges";

export type StageMeta = { key: StageKey; name: string; order: number; description: string; scalingTier: string | null };
export type PromoMetricMeta = { key: string; label: string; unit: PromoUnit; higherIsBetter: boolean; source: MetricSource; hint: string };
export type Criterion = { id: number; fromStage: StageKey; metric: string; op: Op; value: number; windowDays: number | null; label: string | null; enabled: boolean };

export type CriterionStatus = "pass" | "fail" | "na";
export type Trend = "better" | "worse" | "flat";
export type CriterionResult = {
  id: number; metric: string; label: string; hint: string; unit: PromoUnit; op: Op; target: number;
  windowDays: number; windowFrom: string; windowLabel: string; value: number | null; prevValue: number | null;
  display: string; targetDisplay: string; status: CriterionStatus; progress: number; trend: Trend | null; note: string | null; advice: string | null;
};
export type ReadinessReport = {
  user: string; today: string; stage: StageMeta | null; nextStage: StageMeta | null; stageSince: string | null;
  passed: number; total: number; ready: boolean; headline: string; criteria: CriterionResult[]; skipped: CriterionResult[];
  summary: {
    windowDays: number; net: number | null; tradingDays: number; trades: number | null; winRate: number | null; profitFactor: number | null;
    maxDd: number | null; consistency: number | null; feeShare: number | null; disciplineIndex: number | null;
  };
};

export type RequestStatus = "pending" | "approved" | "rejected" | "withdrawn";
export type PromotionRequest = {
  id: number; user: string; fromStage: StageKey | null; toStage: StageKey; status: RequestStatus; passed: number; total: number; ready: boolean;
  comment: string | null; requestedBy: string; createdAt: string; decidedBy: string | null; decidedAt: string | null; decisionComment: string | null;
  report: ReadinessReport | null;
};
export type HistoryItem = {
  id: number; user: string; fromStage: StageKey | null; toStage: StageKey; action: string; requestId: number | null; actor: string; comment: string | null; createdAt: string;
};

export type PathConfig = {
  stages: StageMeta[]; criteria: Criterion[];
  tiers: { key: string; name: string; accountSize: number | null; dailyLossLimit: number | null; maxDrawdown: number | null }[];
  meta: { metrics: PromoMetricMeta[]; ops: Op[] }; templates: ChallengeTemplate[]; canEdit: boolean; me: string;
};
export type ReportResponse = { report: ReadinessReport | null; guest?: boolean; pendingRequest: PromotionRequest | null; history: HistoryItem[]; canDecide: boolean };

export type FunnelPerson = {
  user: string; role: string | null; stage: StageKey | null; since: string | null; stageSource: string | null; cohortId: number | null;
  passed: number; total: number; ready: boolean; headline: string; nextStage: StageKey | null; failing: string[];
  summary: ReadinessReport["summary"]; pendingRequestId: number | null;
};
export type Funnel = {
  today: string; stages: StageMeta[];
  columns: { key: StageKey | "none"; name: string; people: FunnelPerson[] }[];
  totals: { people: number; ready: number; pending: number };
};

// ─── challenges ─────────────────────────────────────────────────────────────

export type DrawdownMode = "static" | "trailing" | "trailing_eod";
export type ChallengeRules = {
  accountSize: number; profitTarget: number | null; dailyLossLimit: number | null; maxDrawdown: number | null; drawdownMode: DrawdownMode;
  trailingStopsAtStart: boolean; consistencyPct: number | null; minTradingDays: number | null; maxPositionQty: number | null; maxPositionUsd: number | null;
  /** NY minutes, end-exclusive: {240, 960} = entries 04:00–15:59 (see fmtWindow). */
  tradingWindow: { start: number; end: number } | null; tradingWindowStrict: boolean;
  rulesVersion?: number;
};
export type ChallengeTemplate = {
  /** description is generated server-side from rules (always consistent with the numbers). */
  key: string; name: string; description: string; forStage: StageKey | null; scalingTier: string | null; durationTradingDays: number; rules: ChallengeRules;
  /** Capital exams: stage reached on a pass; null for trainee tests. */
  toStage: StageKey | null;
};
/** The capital exam suggested for a trader at `stage` (Стажёр → Джун, Джун → Трейдер, Трейдер → Сеньор); null at the top. */
export function suggestedTemplate(templates: ChallengeTemplate[], stage: StageKey | null | undefined): ChallengeTemplate | null {
  if (!stage) return null;
  return templates.find((t) => t.toStage != null && t.forStage === stage) ?? null;
}
export type ChallengeStatus = "scheduled" | "active" | "passed" | "failed" | "expired";
export type RuleKey = "profit_target" | "daily_loss" | "max_drawdown" | "consistency" | "min_days" | "max_position" | "trading_window";
export type RuleState = "ok" | "warn" | "breached" | "met" | "pending" | "na";
export type RuleProgress = { key: RuleKey; label: string; kind: "target" | "limit" | "requirement"; value: number | null; target: number | null; pct: number | null; state: RuleState; display: string; detail: string };
export type EventKind = "daily_loss" | "max_dd" | "size" | "window" | "target" | "passed" | "warn_daily" | "warn_dd" | "warn_window";
export type TimelineEvent = { kind: EventKind; label: string; time: string | null; tradeId: number | null };
export type TimelineDay = {
  date: string; trades: number; net: number; cum: number; balance: number; peak: number; floor: number | null; dayLow: number;
  dailyUsed: number | null; ddRoom: number | null; events: TimelineEvent[];
};
export type ChallengeFailure = { rule: RuleKey; label: string; date: string; time: string | null; tradeId: number | null; detail: string };
export type ChallengeStats = {
  net: number; balance: number; trades: number; tradingDays: number; bestDay: number | null; worstDay: number | null; consistencyPct: number | null;
  maxDdUsed: number; worstDayLow: number; tradesWithoutPnl: number; tradesWithoutTime: number;
};
export type ChallengeResult = {
  status: ChallengeStatus; statusLabel: string; reason: string; failure: ChallengeFailure | null; passedOn: string | null; startsOn: string; endsOn: string;
  evaluatedThrough: string | null; tradingDaysTotal: number; tradingDaysElapsed: number; tradingDaysLeft: number;
  progress: RuleProgress[]; timeline: TimelineDay[]; stats: ChallengeStats;
};
export type ChallengeRow = {
  id: number; user: string; templateKey: string | null; name: string; rules: ChallengeRules; startsOn: string; endsOn: string;
  status: ChallengeStatus; comment: string | null; createdBy: string; createdAt: string; archivedAt: string | null;
};
export type ChallengeListItem = ChallengeRow & {
  result: Omit<ChallengeResult, "timeline"> & { lastDays: { date: string; net: number; cum: number; events: number }[] };
};
export type ChallengeList = { challenges: ChallengeListItem[]; today: string; canCreate: boolean };
export type ChallengeDetail = { challenge: ChallengeRow; result: ChallengeResult; template: ChallengeTemplate | null; canManage: boolean };

// ─── fetch ──────────────────────────────────────────────────────────────────

const qs = (p: Record<string, string | null | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v != null && v !== "") s.set(k, v);
  const out = s.toString();
  return out ? `?${out}` : "";
};

export const pathKeys = {
  all: ["academy-path"] as const,
  config: () => [...pathKeys.all, "config"] as const,
  report: (user: string | null) => [...pathKeys.all, "report", user ?? "me"] as const,
  funnel: () => [...pathKeys.all, "funnel"] as const,
  requests: (status: string | null) => [...pathKeys.all, "requests", status ?? "all"] as const,
  challenges: (user: string | null, archived: boolean) => ["academy-challenges", "list", user ?? "scope", archived] as const,
  challenge: (id: number) => ["academy-challenges", "one", id] as const,
};

export const usePathConfig = () => useQuery({ queryKey: pathKeys.config(), queryFn: () => http.get<PathConfig>("/api/academy/path/config"), staleTime: 60_000 });
export const useReport = (user: string | null, enabled = true) =>
  useQuery({ queryKey: pathKeys.report(user), queryFn: () => http.get<ReportResponse>(`/api/academy/path/report${qs({ user })}`), enabled });
export const useFunnel = (enabled: boolean) => useQuery({ queryKey: pathKeys.funnel(), queryFn: () => http.get<Funnel>("/api/academy/path/funnel"), enabled });
export const useRequests = (status: RequestStatus | null, enabled: boolean) =>
  useQuery({ queryKey: pathKeys.requests(status), queryFn: () => http.get<{ requests: PromotionRequest[] }>(`/api/academy/path/requests${qs({ status })}`), enabled });
export const useChallenges = (user: string | null, archived: boolean) =>
  useQuery({ queryKey: pathKeys.challenges(user, archived), queryFn: () => http.get<ChallengeList>(`/api/academy/challenges${qs({ user, archived: archived ? "1" : null })}`) });
export const useChallenge = (id: number | null) =>
  useQuery({ queryKey: pathKeys.challenge(id ?? 0), queryFn: () => http.get<ChallengeDetail>(`/api/academy/challenges/${id}`), enabled: id != null });

/** Mutation that invalidates everything academy-path related on success. */
export function usePathMutation<TVars, TOut = unknown>(fn: (v: TVars) => Promise<TOut>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: pathKeys.all });
      void qc.invalidateQueries({ queryKey: ["academy-challenges"] });
    },
  });
}

// ─── formatting ─────────────────────────────────────────────────────────────

export function hhmm(min: number): string {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
/** End-exclusive window shown inclusively: {240, 960} → "04:00–15:59". */
export function fmtWindow(w: { start: number; end: number }): string {
  return `${hhmm(w.start)}–${hhmm(Math.max(w.start, w.end - 1))}`;
}
/** Instant → "Oct 15, 10:12 (NY 03:12)" (UI language) — local time first, NY in brackets. Stage / metric / template names: ./labels.ts. */
export function fmtInstant(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${fmtDate(d, "dateTime")} (NY ${fmtTimeNY(d)})`;
}
