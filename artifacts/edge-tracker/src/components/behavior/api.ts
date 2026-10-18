/**
 * Данные для страницы «Поведение и сетапы»: типы (зеркало api-server routes/behavior.ts и routes/setups-auto.ts),
 * react-query хуки и мутации. Сырые fetch-хелперы — эндпоинты не в OpenAPI-спеке (codegen не запускаем).
 */
import * as React from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { http } from "@/lib/api/http";
import { invalidateTradeDependents } from "@/lib/query-keys";
import { dayHref } from "@/lib/period-links";
import { fmtMonth } from "@/lib/format";
import { behaviorI18n } from "@/i18n/ns/behavior";

/* ─── Типы: поведение ─────────────────────────────────────────────────────── */

export type PatternKey =
  | "revenge" | "martingale" | "overtrading" | "fatigue" | "chase" | "tilt" | "disposition" | "firstTrade" | "euphoria";
export type Severity = "none" | "low" | "medium" | "high";

export type PatternExample = { id: number; ticker: string; date: string; net: number | null; note: string; entryMin?: number | null };
export type WeekPoint = { week: string; n: number; cost: number | null; net: number | null };

export type TrendDirection = "better" | "worse" | "flat" | "insufficient";
export type TrendWindow = { from: string | null; to: string | null; days: number; trades: number; n: number; cost: number | null; costPerDay: number | null; rate: number | null };
export type PatternTrend = { recent: TrendWindow; prior: TrendWindow; direction: TrendDirection };

export type TriggerKind =
  | "loss_streak" | "quick_after_loss" | "max_trades_day" | "daily_loss" | "size_up_after_loss"
  | "after_big_win" | "long_loser_hold" | "red_morning" | "custom";
export type RuleDraft = { kind: string; threshold: Record<string, number>; name: string };
export type TriggerDraft = { kind: TriggerKind; params: Record<string, number>; name: string };
export type PatternInsight = { why: string; recommendation: string; ruleText: string; rule: RuleDraft | null; trigger: TriggerDraft };

export type PatternReport = {
  key: PatternKey;
  title: string;
  description: string;
  n: number;
  share: number;
  days: number;
  net: number | null;
  avgNet: number | null;
  baselineAvg: number | null;
  baselineLabel: string;
  cost: number | null;
  severity: Severity;
  winRate: number | null;
  examples: PatternExample[];
  tradeIds: number[];
  weekly: WeekPoint[];
  rule: string;
  extra: Record<string, number | string | null>;
  trend?: PatternTrend;
  insight?: PatternInsight;
};

export type Bucket = { label: string; n: number; net: number | null; avgNet: number | null; winRate: number | null };
export type ProfileBucket = Bucket & { auto?: number };

export type TraderProfile = {
  style: {
    key: "scalper" | "intraday" | "swing" | "unknown";
    label: string;
    description: string;
    medianHoldMin: number | null;
    tradesPerDay: number;
    scalpShare: number | null;
    carryShare: number;
  };
  hours: { best: Bucket | null; worst: Bucket | null; minN: number };
  setups: { best: ProfileBucket | null; worst: ProfileBucket | null; coverage: number; autoShare: number; minN: number; rows: ProfileBucket[] };
  habits: {
    total: number | null;
    sumOfCosts: number;
    trades: number;
    days: number;
    baselineAvg: number | null;
    byPattern: { key: PatternKey; title: string; cost: number }[];
    monthly: { month: string; cost: number | null; n: number }[];
  };
  discipline: { avg: number | null; recent: number | null; prior: number | null; delta: number | null; direction: TrendDirection };
};

export type DisciplineDay = {
  date: string;
  score: number;
  trades: number;
  net: number | null;
  penalties: Partial<Record<PatternKey, number>>;
};

export type BehaviorReport = {
  scope: string | null;
  from: string | null;
  to: string | null;
  options: { revengeMin: number; overtradingK: number; martingaleRatio: number; euphoriaMin: number; morningEndMin: number };
  summary: {
    trades: number; closed: number; withPnl: number; withTime: number; days: number;
    net: number | null; grossProfit: number; grossLoss: number; avgNet: number | null;
    medianTradesPerDay: number; madTradesPerDay: number; tradesPerDayNorm: number; medianGapMin: number | null;
    avgHoldWinMin: number | null; avgHoldLossMin: number | null; from: string | null; to: string | null;
  };
  patterns: PatternReport[];
  byTradeNumber: Bucket[];
  byMinutesAfterLoss: Bucket[];
  byHour: Bucket[];
  discipline: DisciplineDay[];
  disciplineWeekly: { week: string; avg: number; days: number }[];
  disciplineFormula: string;
  disciplineAvg: number | null;
  profile?: TraderProfile;
  generatedAt: string;
};

/* ─── Типы: лента дня ─────────────────────────────────────────────────────── */

export type TimelineFlag = { key: PatternKey; note: string };
export type TimelineTrade = {
  id: number; ticker: string; side: "long" | "short" | null; result: "win" | "loss" | "be" | "open" | null;
  net: number | null; cum: number; qty: number | null; entry: number | null;
  entryAt: number | null; exitAt: number | null; entryMin: number | null; exitMin: number | null; holdMin: number | null;
  setup: string | null; flags: TimelineFlag[];
};
export type DayTimeline = {
  scope: string | null;
  date: string;
  trades: TimelineTrade[];
  summary: {
    n: number; net: number | null; wins: number; losses: number; score: number | null;
    penalties: Partial<Record<PatternKey, number>>;
    peak: number; trough: number;
    breakdown: { id: number; entryMin: number | null; key: PatternKey; note: string; cumBefore: number; netAfter: number | null } | null;
  };
  norms: { tradesPerDayNorm: number; medianGapMin: number | null; revengeMin: number; euphoriaMin: number };
};

/* ─── Типы: мои триггеры ──────────────────────────────────────────────────── */

export type TriggerField = { key: string; label: string; default: number; min: number; max: number; step?: number; unit?: string };
export type TriggerKindDef = { kind: TriggerKind; label: string; hint: string; fields: TriggerField[] };
export type TriggerHit = { id: number; ticker: string; date: string; net: number | null; note: string };
export type TriggerEval = {
  fires: number; days: number; trades: number; net: number | null; tradeIds: number[];
  firstDate: string | null; lastDate: string | null; recentDates: string[]; examples: TriggerHit[]; evaluable: boolean;
};
export type BehaviorTrigger = {
  id: number; trader: string; kind: TriggerKind; name: string; params: Record<string, number>; note: string | null;
  sourcePattern: string | null; enabled: boolean; createdBy: string | null; createdAt: string; updatedAt: string;
  eval?: TriggerEval; existing?: boolean;
};
export type TriggersResponse = {
  trader: string | null; from: string | null; to: string | null; kinds: TriggerKindDef[]; canEdit: boolean;
  today: string; lastTradingDate: string | null; tradingDays: number; items: BehaviorTrigger[];
};

/* ─── Типы: сетапы (авто) ─────────────────────────────────────────────────── */

export type SuggestionStatus = "suggested" | "accepted" | "rejected" | "stale";

export type SetupSuggestionDto = {
  setup: string;
  confidence: number;
  reasons: string[];
  alternatives: { setup: string; score: number }[];
  tags: string[];
  note: string | null;
  candlesAvailable: boolean;
  interval: string | null;
  status: SuggestionStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  version: string;
};

export type SetupItem = {
  tradeId: number;
  ticker: string;
  date: string;
  side: "long" | "short" | null;
  entry: number | null;
  exit: number | null;
  qty: number | null;
  net: number | null;
  result: "win" | "loss" | "be" | "open" | null;
  entryMin: number | null;
  holdMin: number | null;
  currentSetup: string | null;
  suggestion: SetupSuggestionDto | null;
};

export type SetupsAutoResponse = {
  scope: string | null;
  from: string | null;
  to: string | null;
  total: number;
  pending: number;
  computed: number;
  budget: number;
  inFlight: number;
  version: string;
  items: SetupItem[];
  generatedAt: string;
};

export type SetupAggregate = {
  setup: string;
  n: number; wins: number; losses: number; be: number;
  winRate: number | null;
  net: number;
  expectancy: number | null;
  profitFactor: number | null;
  avgConfidence: number | null;
  accepted: number;
  /** 95% интервал Уилсона для win rate (доля 0–1). */
  winRateCI?: { low: number; high: number } | null;
  /** 95% бутстрап-интервал ожидания $ на сделку. */
  expectancyCI?: { low: number; high: number } | null;
  /** n < 20 — выводы ненадёжны. */
  small?: boolean;
};

export type MatrixCell = { setup: string; bucket: string; n: number; net: number; avg: number | null; winRate: number | null };
export type SetupMatrix = { buckets: string[]; cells: MatrixCell[] };

export type SetupAggregatesResponse = {
  scope: string | null;
  trades: number;
  covered: number;
  pending: number;
  smallSample?: number;
  groups: SetupAggregate[];
  matrix?: { hour: SetupMatrix; hold: SetupMatrix };
  generatedAt: string;
};

export type BulkAcceptResponse = {
  ok: boolean; accepted: number; tradeIds?: number[];
  skipped: { forbidden: number; missing: number; stale: number; lowConfidence: number; decided: number };
};

/* ─── fetch ───────────────────────────────────────────────────────────────── */

function qs(params: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/* ─── Ключи и хуки ────────────────────────────────────────────────────────── */

export type Range = { from: string | null; to: string | null };

export const behaviorKeys = {
  all: ["behavior"] as const,
  report: (trader: string | null, r: Range) => ["behavior", "report", trader ?? "", r.from ?? "", r.to ?? ""] as const,
  day: (trader: string | null, date: string, r: Range) => ["behavior", "day", trader ?? "", date, r.from ?? "", r.to ?? ""] as const,
  triggers: (trader: string | null, r: Range) => ["behavior", "triggers", trader ?? "", r.from ?? "", r.to ?? ""] as const,
};

export const setupsAutoKeys = {
  all: ["setups-auto"] as const,
  list: (trader: string | null, r: Range, withSetup: boolean) => ["setups-auto", "list", trader ?? "", r.from ?? "", r.to ?? "", withSetup ? 1 : 0] as const,
  aggregates: (trader: string | null, r: Range, withSetup: boolean) => ["setups-auto", "aggregates", trader ?? "", r.from ?? "", r.to ?? "", withSetup ? 1 : 0] as const,
};

export function useBehavior(trader: string | null, range: Range, enabled = true) {
  return useQuery({
    queryKey: behaviorKeys.report(trader, range),
    queryFn: ({ signal }) => http.get<BehaviorReport>(`/api/behavior${qs({ trader, from: range.from, to: range.to })}`, { signal }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** Список предложений; `budget` — сколько недостающих посчитать за этот запрос (0 = только из кэша). */
export function useSetupsAuto(trader: string | null, range: Range, opts: { withSetup: boolean; budget: number }, enabled = true) {
  return useQuery({
    queryKey: setupsAutoKeys.list(trader, range, opts.withSetup),
    queryFn: () =>
      http.get<SetupsAutoResponse>(`/api/setups-auto${qs({ trader, from: range.from, to: range.to, budget: opts.budget, withSetup: opts.withSetup ? 1 : 0, limit: 1000 })}`),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function useSetupAggregates(trader: string | null, range: Range, withSetup: boolean, enabled = true) {
  return useQuery({
    queryKey: setupsAutoKeys.aggregates(trader, range, withSetup),
    queryFn: ({ signal }) => http.get<SetupAggregatesResponse>(`/api/setups-auto/aggregates${qs({ trader, from: range.from, to: range.to, withSetup: withSetup ? 1 : 0 })}`, { signal }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** Принять предложение: пишет setup в сделку тем же механизмом, что правка сделки. */
export function useAcceptSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tradeId, setup }: { tradeId: number; setup?: string }) =>
      http.post<{ ok: boolean; tradeId: number; setup: string }>(`/api/setups-auto/${tradeId}/accept`, setup ? { setup } : {}),
    onSuccess: async (_d, v) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: setupsAutoKeys.all }),
        qc.invalidateQueries({ queryKey: behaviorKeys.all }),
        invalidateTradeDependents(qc, { tradeId: v.tradeId }),
      ]);
    },
  });
}

export function useRejectSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tradeId }: { tradeId: number }) => http.post<{ ok: boolean }>(`/api/setups-auto/${tradeId}/reject`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: setupsAutoKeys.all }),
  });
}

export function useRecomputeSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tradeId }: { tradeId: number }) => http.post<{ ok: boolean; item: SetupItem }>(`/api/setups-auto/${tradeId}/recompute`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: setupsAutoKeys.all }),
  });
}

/** Принять пачку актуальных предложений (сервер сам отсеет устаревшие, решённые и ниже порога). */
export function useAcceptBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { tradeIds: number[]; minConfidence?: number }) => http.post<BulkAcceptResponse>("/api/setups-auto/accept-bulk", b),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: setupsAutoKeys.all }),
        qc.invalidateQueries({ queryKey: behaviorKeys.all }),
        invalidateTradeDependents(qc),
      ]);
    },
  });
}

/* ─── «Посчитать всё» ─────────────────────────────────────────────────────── */

export type ComputeAllState = {
  status: "idle" | "running" | "done" | "cancelled" | "stalled" | "error";
  /** Сколько было не посчитано на старте. */
  start: number;
  pending: number;
  done: number;
  batches: number;
  error: string | null;
};

const IDLE: ComputeAllState = { status: "idle", start: 0, pending: 0, done: 0, batches: 0, error: null };
/** Пакет 30 (сервер разрешает ≤ 50 и сам держит параллельность 2, паузу к Yahoo и лимит 12 с на запрос). */
const BATCH = 30;
const PAUSE_MS = 600;
const STALL_LIMIT = 3;

/**
 * «Посчитать всё»: клиентский цикл пакетами по 30 (GET /api/setups-auto?budget=30&limit=1) до pending = 0.
 * Пауза между пакетами; отмена через AbortController; три пакета подряд без прогресса (сервер занят другим
 * запросом или нет рыночных данных) — остановка со статусом «stalled». По завершении — обновление таблиц.
 */
export function useComputeAll(trader: string | null, range: Range, withSetup: boolean) {
  const qc = useQueryClient();
  const [state, setState] = React.useState<ComputeAllState>(IDLE);
  const ctrl = React.useRef<AbortController | null>(null);

  React.useEffect(() => () => ctrl.current?.abort(), []);
  // Смена трейдера/периода/выборки — прерываем текущий цикл.
  React.useEffect(() => { ctrl.current?.abort(); setState(IDLE); }, [trader, range.from, range.to, withSetup]);

  const run = React.useCallback(async () => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    const url = (budget: number) => `/api/setups-auto${qs({ trader, from: range.from, to: range.to, budget, withSetup: withSetup ? 1 : 0, limit: 1 })}`;
    const sleep = (ms: number) => new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      ac.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
    let stalls = 0;
    let start = 0;
    let done = 0;
    let batches = 0;
    try {
      start = (await http.get<SetupsAutoResponse>(url(0), { signal: ac.signal })).pending;
      setState({ status: start ? "running" : "done", start, pending: start, done: 0, batches: 0, error: null });
      let pending = start;
      while (pending > 0 && !ac.signal.aborted) {
        const j = await http.get<SetupsAutoResponse>(url(BATCH), { signal: ac.signal });
        batches++;
        done += j.computed;
        pending = j.pending;
        stalls = j.computed > 0 ? 0 : stalls + 1;
        if (stalls >= STALL_LIMIT) { setState({ status: "stalled", start, pending, done, batches, error: null }); break; }
        setState({ status: pending > 0 ? "running" : "done", start, pending, done, batches, error: null });
        if (pending > 0) await sleep(stalls ? PAUSE_MS * 4 : PAUSE_MS);
      }
      if (ac.signal.aborted) setState((s) => ({ ...s, status: "cancelled" }));
    } catch (e) {
      if (ac.signal.aborted) setState((s) => ({ ...s, status: "cancelled" }));
      else setState((s) => ({ ...s, status: "error", error: e instanceof Error ? e.message : String(e) }));
    } finally {
      if (ctrl.current === ac) ctrl.current = null;
      if (done > 0) {
        await Promise.all([
          qc.invalidateQueries({ queryKey: setupsAutoKeys.all }),
          qc.invalidateQueries({ queryKey: behaviorKeys.all }),
        ]);
      }
    }
  }, [qc, trader, range.from, range.to, withSetup]);

  const cancel = React.useCallback(() => { ctrl.current?.abort(); }, []);
  const reset = React.useCallback(() => setState(IDLE), []);
  return { state, run, cancel, reset };
}

/* ─── Лента дня ───────────────────────────────────────────────────────────── */

export function useBehaviorDay(trader: string | null, date: string | null, range: Range, enabled = true) {
  return useQuery({
    queryKey: behaviorKeys.day(trader, date ?? "", range),
    queryFn: ({ signal }) => http.get<DayTimeline>(`/api/behavior/day${qs({ trader, date, from: range.from, to: range.to })}`, { signal }),
    enabled: enabled && !!date,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/* ─── Мои триггеры ────────────────────────────────────────────────────────── */

export function useTriggers(trader: string | null, range: Range, enabled = true) {
  return useQuery({
    queryKey: behaviorKeys.triggers(trader, range),
    queryFn: ({ signal }) => http.get<TriggersResponse>(`/api/behavior/triggers${qs({ trader, from: range.from, to: range.to })}`, { signal }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

function invalidateTriggers(qc: ReturnType<typeof useQueryClient>) {
  return qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "behavior" && q.queryKey[1] === "triggers" });
}

export type TriggerInput = { trader?: string | null; kind: TriggerKind; params?: Record<string, number>; name?: string; note?: string; sourcePattern?: string };

export function useCreateTrigger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (t: TriggerInput) => http.post<BehaviorTrigger>("/api/behavior/triggers", { ...t, trader: t.trader ?? undefined }),
    onSuccess: () => invalidateTriggers(qc),
  });
}

export function useUpdateTrigger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: number; name?: string; params?: Record<string, number>; note?: string | null; enabled?: boolean }) =>
      http.patch<BehaviorTrigger>(`/api/behavior/triggers/${id}`, patch),
    onSuccess: () => invalidateTriggers(qc),
  });
}

/** Мягкое удаление (сервер ставит deleted_at). */
export function useDeleteTrigger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: number }) => http.del<{ ok: boolean }>(`/api/behavior/triggers/${id}`),
    onSuccess: () => invalidateTriggers(qc),
  });
}

/* ─── Правила деска (существующий API /api/rules) ─────────────────────────── */

type DeskRule = { id: number; trader: string; name: string; kind: string; threshold: Record<string, unknown> | null; enabled: boolean };

/**
 * «Сделать правилом» для паттерна с подходящим видом правила деска: POST /api/rules (сканер нарушений подхватит сам).
 * Тот же вид + порог уже есть — не дублируем (выключенное включаем). Кэш раздела «Правила» сбрасывается (ключи ["rules", …]).
 */
export function useCreateDeskRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ trader, rule }: { trader: string; rule: RuleDraft }): Promise<{ rule: DeskRule; existing: boolean }> => {
      const list = await http.get<DeskRule[]>(`/api/rules${qs({ trader })}`);
      const same = list.find((r) => r.trader === trader && r.kind === rule.kind && JSON.stringify(r.threshold ?? {}) === JSON.stringify(rule.threshold));
      if (same) {
        if (!same.enabled) await http.patch(`/api/rules/${same.id}`, { enabled: true });
        return { rule: same, existing: true };
      }
      const created = await http.post<DeskRule>("/api/rules", { trader, name: rule.name, kind: rule.kind, threshold: rule.threshold });
      return { rule: created, existing: false };
    },
    onSuccess: () => qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "rules" }),
  });
}

/* ─── Ссылки ──────────────────────────────────────────────────────────────── */

/** Разбор дня — через общий dayHref (lib/period-links). */
export function dayReportHref(date: string, trader?: string | null): string {
  return dayHref(date, trader);
}

/* ─── Форматирование ──────────────────────────────────────────────────────── */

// Money / percent / ratio / dates / plurals: @/lib/format (fmtUsd, fmtRate, fmtRatio, fmtDate) and commonI18n units.

export function fmtMinutes(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return "—";
  const t = behaviorI18n.t;
  if (min < 1) return t("dur.seconds", { count: Math.round(min * 60) });
  if (min < 60) return t("dur.minutes", { count: Math.round(min) });
  if (min < 1440) return t("dur.hm", { h: Math.floor(min / 60), m: Math.round(min % 60) });
  return t("dur.days", { value: (min / 1440).toFixed(1) });
}

export function fmtClock(entryMin: number | null | undefined): string {
  if (entryMin == null) return "—";
  return `${Math.floor(entryMin / 60)}:${String(Math.floor(entryMin % 60)).padStart(2, "0")}`;
}

/** "окт. 26" for a "YYYY-MM" key (chart axis), month in the UI language. */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  const i = Number(m) - 1;
  return `${i >= 0 && i < 12 ? fmtMonth(i, "short") : m} ${y.slice(2)}`;
}

/** Record whose values are read at access time (labels follow the UI language). */
function liveLabels<K extends string>(keys: readonly K[], label: (k: K) => string): Record<K, string> {
  const o = {} as Record<K, string>;
  for (const k of keys) Object.defineProperty(o, k, { get: () => label(k), enumerable: true });
  return o;
}

export const SEVERITY_LABEL: Record<Severity, string> = liveLabels(["none", "low", "medium", "high"] as const, (k) => behaviorI18n.t(`severity.${k}`));
export const SEVERITY_TONE: Record<Severity, "neutral" | "warn" | "down" | "accent"> = { none: "neutral", low: "neutral", medium: "warn", high: "down" };

export const PATTERN_SHORT: Record<PatternKey, string> = liveLabels(
  ["revenge", "martingale", "overtrading", "tilt", "chase", "euphoria", "fatigue", "disposition", "firstTrade"] as const,
  (k) => behaviorI18n.t(`pattern.${k}`),
);


/** Тон маркера паттерна на ленте и в чипах. */
export const PATTERN_TONE: Record<PatternKey, "down" | "warn" | "purple" | "accent" | "neutral"> = {
  revenge: "down", martingale: "down", tilt: "warn", chase: "warn", euphoria: "purple",
  overtrading: "accent", fatigue: "neutral", disposition: "neutral", firstTrade: "neutral",
};

/** Тон win rate относительно порога (аудит G-4: WR красим только от порога, иначе нейтрально). */
export function winRateTone(wr: number | null | undefined, n = 0): "up" | "down" | "neutral" {
  if (wr == null || n < 20) return "neutral";
  if (wr >= 0.55) return "up";
  if (wr < 0.4) return "down";
  return "neutral";
}
