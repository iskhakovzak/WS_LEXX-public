import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CLIENT_CODES, http, isApiError } from "@/lib/api/http";
import { POLL, STALE } from "@/lib/api/keys";
import { curatorI18n } from "@/i18n/ns/curator";
import type { CostQueueItem, DailyFocus, FocusVerdict, MistakeCost, MistakeId } from "@/lib/daily/types";

/**
 * «Кабинет куратора» client: types + lib/api/http hooks for /api/curator/* and the risk-process endpoints
 * (/api/risk/templates, /api/risk/breaches, /api/risk/summary). Contract: api-server routes/curator.ts, routes/risk.ts.
 * A 404 (router not registered / API not rebuilt yet) becomes `NotAvailableError` so the page can say so.
 */

export class NotAvailableError extends Error {
  constructor() { super(curatorI18n.t("notAvailable")); }
}

/** Route missing (404 without a `code`: Express «Cannot GET», not a handler's NOT_FOUND) / SPA HTML fallback → `NotAvailableError`. */
function orNotAvailable<T>(p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    if (isApiError(e)) {
      if (e.code === CLIENT_CODES.badResponse) throw new NotAvailableError();
      if (e.status === 404 && !e.code) throw new NotAvailableError();
    }
    throw e;
  });
}

const enc = encodeURIComponent;

// ─── types ──────────────────────────────────────────────────────────────────

export type Scope = "mine" | "desk";
export type Phase = "premarket" | "session" | "afterclose" | "weekend";
export type NextActionKind =
  | "breach_review" | "stopped" | "near_stop" | "eod_review" | "weekly_review" | "overdue_action"
  | "no_limits" | "template_drift" | "missing_plan" | "missing_eod" | "one_on_one" | "none";
export type NextAction = { kind: NextActionKind; label: string; priority: number; href: string };
export type WeekPoint = { week: string; net: number | null; trades: number };

export type TraderSignal = {
  trader: string;
  stage: { key: string | null; label: string | null; since: string | null };
  tier: string | null;
  tierName: string | null;
  risk: {
    status: string; state: string; label: string; message: string; halted: boolean; nearStop: boolean;
    dailyPct: number | null; weeklyPct: number | null; drawdownPct: number | null;
    todayPnl: number | null; todayTrades: number; weekPnl: number | null; openPositions: number;
    hasLimits: boolean; templateDrift: string[];
  };
  trend: WeekPoint[];
  trendDir: "up" | "down" | "flat" | "none";
  discipline: { value: number | null; eodAvg: number | null; ratingAvg: number | null; n: number };
  plan: { today: "ready" | "draft" | null; available: boolean };
  eod: { prevDay: string; prevTraded: boolean; prevClosed: boolean; todayTraded: boolean; todayClosed: boolean; pending: number; lastClosed: string | null; lastReviewedAt: string | null; lastScore: number | null };
  weekly: { currentStatus: string | null; submittedPending: boolean; lastReviewedWeek: string | null; lastReviewedAt: string | null };
  academy: { openActions: number; overdueActions: number; lastOneOnOne: string | null; daysSinceOneOnOne: number | null; pendingSubmissions: number; activeGoals: number };
  /** week — breach alerts since Monday (NY); absent on older API builds. */
  breaches: { unreviewed: number; last30: number; week?: number; lastDate: string | null };
  lastNote: { body: string; author: string; createdAt: string } | null;
  lastTradeDate: string | null;
  nextAction: NextAction;
  /** users.assigned_curator — the trader's group; null = «Без куратора». Absent on older API builds. */
  curator?: string | null;
  /** users.name_latin — Latin alias for search. */
  nameLatin?: string | null;
  /** Month to date (NY): net P&L and trades. */
  month?: { pnl: number | null; trades: number };
  /** Latest sign of life (activity, closed day, weekly report, trade day). */
  lastActivityAt?: string | null;
};

export type RiskBrief = { trader: string; state: string; label: string; message: string; pnlNet: number | null; dailyPct: number | null; weeklyPct: number | null; drawdownPct: number | null };
export type QueueKind = "eod" | "weekly" | "academy" | "breach";
/** `eodId` + `date` (closed days) let the cabinet open the review sheet in place; absent on older API builds. */
export type QueueItem = {
  kind: QueueKind; id: string; trader: string; title: string; since: string | null; hoursWaiting: number | null; href: string;
  overdue: boolean; slaHours: number; old?: boolean; date?: string | null; eodId?: number;
};

export type TodayPayload = {
  date: string; prevDay: string; phase: Phase; nyMinutes: number; scope: Scope; wards: number; traders: string[]; plansAvailable: boolean;
  counts: { traders: number; trading: number; halted: number; nearStop: number; noLimits: number; missingPlan: number; missingEod: number; queue: number; queueOverdue: number; queueOld?: number; queueOldOverdue?: number; overdueActions: number };
  trading: { trader: string; trades: number; pnlNet: number | null; openPositions: number; state: string; dailyPct: number | null }[];
  risk: { halted: RiskBrief[]; nearStop: RiskBrief[]; noLimits: string[] };
  missingPlan: { trader: string; status: "ready" | "draft" | null }[];
  missingEod: { trader: string; date: string }[];
  openToday: { trader: string; date: string }[];
  queue: QueueItem[];
  /** Окно очереди: по умолчанию последние `days` дней; `old` — сколько старых скрыто. */
  queueWindow?: { days: number; includeOld: boolean; old: number; oldOverdue: number };
  overdueActions: { id: number; trader: string; title: string; dueOn: string; owner: string; daysOverdue: number }[];
  nextActions: (NextAction & { trader: string })[];
  /** The queue by money (lib/daily/costQueue): most negative first; `resolved` — the curator already looked. Absent on older API builds. */
  byCost?: CostQueueRow[];
};

export type CostQueueRow = CostQueueItem & { resolved: boolean };
export type CostReasonKind = CostQueueItem["reasons"][number]["kind"];

/** Profile `focus` (api lib/daily/curatorFocus): the focus in force, its day-by-day history, the options to replace it. */
export type CuratorFocus = {
  current: DailyFocus | null;
  date: string;
  history: { date: string; trades: number; netPnl: number | null; focus: FocusVerdict | null; reviewed: boolean }[];
  options: MistakeCost[];
  window: { from: string; to: string };
};

export type TradersPayload = { date: string; scope: Scope; wards: number; traders: TraderSignal[] };

export type CuratorNote = { id: number; trader: string; author: string; body: string; kind: NoteKind; pinned: boolean; createdAt: string; updatedAt: string };
export type NoteKind = "note" | "call" | "concern" | "praise";

export type BreachAction = { id: string; title: string; dueOn: string | null; status: "open" | "done" | "dropped" };
export type BreachReview = {
  id: number; alertId: number; trader: string; date: string; kind: string; reason: string; comment: string | null;
  actions: BreachAction[]; consequence: string; createdBy: string; createdAt: string; updatedBy: string | null; updatedAt: string;
};
export type Breach = {
  id: number; trader?: string; date: string; kind: string; kindLabel: string; used: number | null; limit: number | null; message: string;
  createdAt: string | null; repeat?: boolean; breachDays7?: number; review: BreachReview | null;
};

export type RiskLimits = {
  trader: string; accountSize: number | null; dailyLossLimit: number | null; weeklyLossLimit: number | null; maxDrawdown: number | null;
  maxRiskPerTrade: number | null; maxPositionUsd: number | null; maxOvernightExposure: number | null; maxOpenPositions: number | null;
  allowOvernight: boolean; allowSwing: boolean; tier: string | null; notes: string | null; updatedBy: string | null; updatedAt: string | null;
};

export type ProfilePayload = {
  trader: string; role: string;
  assigned: { curator: string | null; mentor: string | null; riskManager: string | null };
  signal: TraderSignal;
  limits: RiskLimits | null;
  metrics: {
    today: { pnlNet: number | null; trades: number; openPositions: number; openRiskUsd: number; dailyLimitUsedPct: number | null; dailyRemainingUsd: number | null };
    week: { pnlNet: number | null; trades: number; limitUsedPct: number | null; remainingUsd: number | null };
    drawdown: { currentUsd: number; maxUsd: number; limitUsedPct: number | null; redDayStreak: number };
    stop: { state: string; label: string; message: string; halted: boolean };
    alerts: { kind: string; label: string; level: "warn" | "breach"; used: number; limit: number | null; pct: number | null; detail?: string }[];
  } | null;
  breaches: Breach[];
  /** Closed, unreviewed and not archived days (oldest first) — reviewed right from the profile. Absent on older API builds. */
  eodPending?: { id: number; date: string; closedAt: string | null; hoursWaiting: number }[];
  eodDays: { id: number; date: string; closedAt: string | null; reviewedAt: string | null; reviewedBy: string | null; discipline: number | null; curatorScore: number | null; curatorComment: string | null }[];
  weeks: { id: number; week: string; weekStart: string; status: string; submittedAt: string | null; reviewedAt: string | null; score: number | null }[];
  actions: { id: number; owner: string; title: string; dueOn: string | null; status: string; overdue: boolean }[];
  meetings: { id: number; mentor: string; metAt: string | null; format: string; agenda: string }[];
  goals: { id: number; title: string; metric: string; comparator: string; target: number | null; dueOn: string | null; status: string; lastValue: number | null; lastProgress: number | null }[];
  notes: CuratorNote[];
  limitEvents: { id: number; reason: string | null; changedBy: string | null; changedAt: string | null }[];
  canEditLimits: boolean;
  /** Daily-loop focus; absent on older API builds. */
  focus?: CuratorFocus;
};

export type BreachesPayload = {
  from: string; to: string; trader: string | null; breaches: Breach[]; unreviewed: number;
  reasons: { key: string; label: string }[]; consequences: { key: string; label: string }[]; canReview: boolean;
};

export type LimitDiff = { field: string; label: string; current: number | boolean | null; template: number | boolean | null };
export type TierTemplate = {
  key: string; name: string; order: number; accountSize: number | null; dailyLossLimit: number | null; weeklyLossLimit: number | null; maxDrawdown: number | null;
  maxRiskPerTrade: number | null; maxPositionUsd: number | null; maxOvernightExposure: number | null; maxOpenPositions: number | null;
  allowOvernight: boolean; allowSwing: boolean; description: string | null; stage: string | null; stageLabel: string | null;
};
export type TemplatesPayload = {
  tiers: TierTemplate[];
  traders: { trader: string; limits: RiskLimits | null; tier: string | null; tierName: string | null; hasLimits: boolean; drift: LimitDiff[] }[];
  canEdit: boolean;
};
export type ApplyResult = { applied: number; failed: number; results: { trader: string; ok: boolean; error?: string; tier?: string; resync?: boolean; changes?: string[] }[] };

export type RiskSummary = {
  date: string;
  totals: { traders: number; trading: number; pnlNetToday: number | null; openPositions: number; openRiskUsd: number; carriedTonight: number; overnightExposureUsd: number };
  halted: RiskBrief[]; nearStop: RiskBrief[];
  breachesToday: { trader: string; kind: string; kindLabel: string }[];
  repeatBreachers: { trader: string; days7: number; dates: string[] }[];
  unreviewedBreaches: { id: number; trader: string; date: string; kind: string; kindLabel: string; message: string }[];
  noLimits: string[];
  templateDrift: { trader: string; tier: string | null; tierName: string | null; fields: string[] }[];
  overnight: { trader: string; positions: number; exposureUsd: number; allowed: boolean | null; limitUsd: number | null }[];
};

export type IdpMetric = { key: string; label: string; unit: string; comparator: string; windowKind: string; defaultWindow: number | null; defaultTarget: number; description: string; example: string };

// ─── keys + fetchers ────────────────────────────────────────────────────────

export const curatorKeys = {
  all: ["curator"] as const,
  today: (scope: Scope | "auto") => ["curator", "today", scope] as const,
  todayOld: (scope: Scope | "auto") => ["curator", "today", scope, "old"] as const,
  traders: (scope: Scope | "auto") => ["curator", "traders", scope] as const,
  profile: (trader: string) => ["curator", "profile", trader] as const,
  breaches: (trader: string | null) => ["curator", "breaches", trader ?? "*"] as const,
  templates: ["curator", "templates"] as const,
  summary: ["curator", "risk-summary"] as const,
  idpMetrics: ["curator", "idp-metrics"] as const,
  behavior: (trader: string) => ["curator", "behavior", trader] as const,
};

const scopeOf = (s: Scope | "auto") => (s === "auto" ? null : s);

export const curatorApi = {
  today: (scope: Scope | "auto", includeOld = false) =>
    orNotAvailable(http.get<TodayPayload>("/api/curator/today", { query: { scope: scopeOf(scope), old: includeOld ? 1 : null } })),
  archiveOldQueue: (scope: Scope | "auto", olderThanDays?: number) =>
    orNotAvailable(http.post<{ archived: number; byKind: Record<string, number>; olderThanDays: number; ids?: string[] }>(
      "/api/curator/queue/archive-old", { ...(scope === "auto" ? {} : { scope }), ...(olderThanDays ? { olderThanDays } : {}) })),
  restoreQueue: (ids: string[]) =>
    orNotAvailable(http.post<{ restored: number }>("/api/curator/queue/restore", { ids })),
  traders: (scope: Scope | "auto") => orNotAvailable(http.get<TradersPayload>("/api/curator/traders", { query: { scope: scopeOf(scope) } })),
  profile: (trader: string) => orNotAvailable(http.get<ProfilePayload>(`/api/curator/trader/${enc(trader)}`)),
  addNote: (body: { trader: string; body: string; kind: NoteKind; pinned?: boolean }) =>
    orNotAvailable(http.post<CuratorNote>("/api/curator/notes", body)),
  patchNote: (id: number, body: { body?: string; kind?: NoteKind; pinned?: boolean }) =>
    orNotAvailable(http.patch<CuratorNote>(`/api/curator/notes/${id}`, body)),
  archiveNote: (id: number) => orNotAvailable(http.post<{ ok: true }>(`/api/curator/notes/${id}/archive`)),
  restoreNote: (id: number) => orNotAvailable(http.post<CuratorNote>(`/api/curator/notes/${id}/restore`)),
  breaches: (trader: string | null, days = 90) =>
    orNotAvailable(http.get<BreachesPayload>("/api/risk/breaches", { query: { days, trader } })),
  review: (alertId: number, body: { reason: string; comment: string | null; actions: { id?: string; title: string; dueOn: string | null; status?: string }[]; consequence: string }) =>
    orNotAvailable(http.post<BreachReview>(`/api/risk/breaches/${alertId}/review`, body)),
  setActionStatus: (reviewId: number, actionId: string, status: BreachAction["status"]) =>
    orNotAvailable(http.post<BreachReview>(`/api/risk/breach-reviews/${reviewId}/action`, { actionId, status })),
  templates: () => orNotAvailable(http.get<TemplatesPayload>("/api/risk/templates")),
  applyTemplate: (items: { trader: string; tierKey: string }[], reason: string | null) =>
    orNotAvailable(http.post<ApplyResult>("/api/risk/templates/apply", { items, reason })),
  summary: () => orNotAvailable(http.get<RiskSummary>("/api/risk/summary")),
  idpMetrics: () => orNotAvailable(http.get<{ metrics: IdpMetric[] }>("/api/academy/idp/metrics")),
  addGoal: (body: { student: string; title: string; metric: string; target?: number; window?: number | null; dueOn?: string | null; note?: string }) =>
    orNotAvailable(http.post<{ id: number }>("/api/academy/idp", body)),
  /** Curator replaces the trader's focus for a day (routes/daily.ts, contract: PUT /api/daily/focus/:trader/:date {mistake}). */
  setFocus: (trader: string, date: string, mistake: MistakeId) =>
    orNotAvailable(http.put<unknown>(`/api/daily/focus/${enc(trader)}/${enc(date)}`, { mistake })),
  behavior: (trader: string, from: string, to: string) =>
    orNotAvailable(http.get<{ patterns?: { key: string; title: string; n: number; share?: number; net?: number | null; cost?: number | null; severity?: string }[] }>(
      "/api/behavior", { query: { trader, from, to } })),
};

const retryUnlessMissing = (count: number, err: unknown) => !(err instanceof NotAvailableError) && count < 2;

export function useCuratorToday(scope: Scope | "auto") {
  return useQuery({ queryKey: curatorKeys.today(scope), queryFn: () => curatorApi.today(scope), refetchInterval: POLL.minute, retry: retryUnlessMissing });
}
/** `enabled` — only the «Мои трейдеры» list needs it (the tab count comes from /today), so «Сегодня» doesn't pay for a second roster build. */
export function useCuratorTraders(scope: Scope | "auto", enabled = true) {
  return useQuery({ queryKey: curatorKeys.traders(scope), queryFn: () => curatorApi.traders(scope), enabled, staleTime: STALE.default, retry: retryUnlessMissing });
}
export function useCuratorProfile(trader: string | null) {
  return useQuery({ queryKey: curatorKeys.profile(trader ?? ""), queryFn: () => curatorApi.profile(trader!), enabled: !!trader, retry: retryUnlessMissing });
}
export function useRiskSummary(enabled = true) {
  return useQuery({ queryKey: curatorKeys.summary, queryFn: curatorApi.summary, enabled, refetchInterval: POLL.minute, retry: retryUnlessMissing });
}
export function useRiskTemplates(enabled = true) {
  return useQuery({ queryKey: curatorKeys.templates, queryFn: curatorApi.templates, enabled, staleTime: STALE.short, retry: retryUnlessMissing });
}
export function useIdpMetrics(enabled: boolean) {
  return useQuery({ queryKey: curatorKeys.idpMetrics, queryFn: curatorApi.idpMetrics, enabled, staleTime: 10 * 60_000, retry: retryUnlessMissing });
}
export type PatternBrief = { key: string; title: string; n: number; cost: number | null; severity: string | null };

/**
 * Top behaviour patterns for many traders in ONE request (GET /api/behavior/top-patterns) — the card grid used to
 * fire a full /api/behavior report per card. Returns null for the map on an API build without the endpoint.
 */
export function useTopPatterns(traders: readonly string[], from: string, to: string, enabled: boolean) {
  const list = [...traders].sort();
  return useQuery({
    queryKey: [...curatorKeys.all, "top-patterns", from, to, list.join(",")],
    queryFn: async (): Promise<Record<string, PatternBrief[]> | null> => {
      const body = await orNotAvailable(
        http.get<{ traders: Record<string, PatternBrief[]> }>("/api/behavior/top-patterns", { query: { traders: list.join(","), from, to, limit: 2 } })
          .catch((e: unknown) => { if (isApiError(e) && e.status === 404) return null; throw e; }),
      );
      return body ? body.traders ?? {} : null;
    },
    enabled: enabled && list.length > 0,
    staleTime: STALE.long,
    retry: false,
  });
}

/** Reassign a trader to another curator's group (audited admin-console route; users.manage). */
export async function reassignCurator(userId: number, curator: string | null, reason: string): Promise<{ ok: true; name: string }> {
  return orNotAvailable(http.post<{ ok: true; name: string }>(`/api/admin/console/people/${userId}/curator`, { curator, reason }));
}

export function useBehaviorPatterns(trader: string, from: string, to: string, enabled: boolean) {
  return useQuery({ queryKey: [...curatorKeys.behavior(trader), from, to], queryFn: () => curatorApi.behavior(trader, from, to), enabled, staleTime: STALE.long, retry: false });
}

/** Invalidate everything the cabinet shows (after a note / review / template / goal change). */
export function useInvalidateCurator() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: curatorKeys.all });
    void qc.invalidateQueries({ queryKey: ["risk"] });
  };
}

export function useCuratorMutation<V, R>(fn: (v: V) => Promise<R>) {
  const invalidate = useInvalidateCurator();
  return useMutation({ mutationFn: fn, onSuccess: () => invalidate() });
}
