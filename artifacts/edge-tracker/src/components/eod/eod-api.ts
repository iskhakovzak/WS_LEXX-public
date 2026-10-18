import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getListTradesQueryKey } from "@workspace/api-client-react";
import { CLIENT_CODES, http, isApiError } from "@/lib/api/http";
import { POLL, STALE } from "@/lib/api/keys";
import { JOURNAL_DAYS_KEY } from "@/components/journal/use-journal-days";
import { eodI18n } from "@/i18n/ns/eod";

/**
 * «Закрытие дня» client: types + fetchers for /api/eod/* (see api-server/src/routes/eod.ts for the contract).
 * All reads are tolerant of a missing route (404 ⇒ `null`), so the journal keeps working before the API rebuild.
 */

export type EodStatus = "open" | "closed" | "reviewed";
export type Grade = "A+" | "A" | "B" | "C";
export const GRADES: Grade[] = ["A+", "A", "B", "C"];

export type EodPosition = { tradeId: number; thesisValid: boolean | null; stop: number | null; target: number | null; gapNote: string };
export type EodSummary = {
  mood: number | null;
  repeat: string;
  stop: string;
  tomorrow: string;
  positions: EodPosition[];
  reconcile?: { brokerNet: number | null; journalNet: number | null; brokerTrades: number | null; journalTrades: number | null; note: string };
};
export const emptySummary = (): EodSummary => ({ mood: null, repeat: "", stop: "", tomorrow: "", positions: [] });

export type EodDay = {
  id: number; trader: string; date: string; closedAt: string | null; discipline: number | null; summary: Partial<EodSummary> | null;
  reviewedBy: string | null; reviewedAt: string | null; curatorComment: string | null; curatorScore: number | null;
  createdAt: string; updatedAt: string; status: EodStatus;
};

export type MissingField = "setup" | "grade";
export type MissingItem = { tradeId: number; ticker: string; fields: MissingField[] };

export type EodTrade = {
  id: number; ticker: string; date: string; side: string | null; setup: string | null; result: string; session: string | null;
  pnl: number | null; fees: number | null; qty: number | null; entry: number | null; exit: number | null; stop: number | null;
  rMultiple: number | null; riskUsd: number | null; confidenceGrade: Grade | string | null; tags: string | null; conclusion: string | null;
  patternId: number | null; horizon: string | null; exitDate: string | null; source: string | null; externalId: string | null;
  r: number | null; net: number | null; closeDate: string; horizonEff: "intraday" | "overnight" | "swing"; resultNorm: "win" | "loss" | "be" | "open" | null;
  followedPlan: boolean | null; mistakes: string[]; lesson: string; reviewUpdatedAt: string | null;
  enteredToday: boolean; closedToday: boolean; onPlan: boolean; missing: MissingField[];
};

export type Totals = { trades: number; closed: number; open: number; gross: number | null; fees: number; net: number | null };
export type Streaks = { closedStreak: number; reviewedStreak: number; closedTotal: number; lastClosed: string | null };

export type EodDayPayload = {
  trader: string; date: string; today: string;
  day: EodDay | null; status: EodStatus;
  trades: EodTrade[]; carried: EodTrade[]; positions: number[];
  /** Blocking: manual trades without setup / grade. */
  missing: MissingItem[];
  /** Reminder only: broker-imported trades without setup / grade (never block the close; absent on old API builds). */
  softMissing?: MissingItem[];
  canClose: boolean; closeBlockedReason: string | null;
  reconcile: { journal: Totals; broker: Totals | null; manualUnmatched: number };
  plan: { date: string; inPlay: Array<{ ticker: string; grade: string | null; horizon: string }> } | null;
  streaks: Streaks;
};

export type EodStatusRow = {
  trader: string; status: EodStatus; trades: number; reviewedTrades: number; missing: MissingItem[];
  closedAt: string | null; reviewedAt: string | null; reviewedBy: string | null; curatorScore: number | null; discipline: number | null;
};
export type EodStatusPayload = { date: string; today: string; traders: EodStatusRow[] };

export type QueueItem = {
  id: number; trader: string; date: string; closedAt: string | null; discipline: number | null; trades: number; net: number | null;
  /** pending: hours since close; reviewed: hours from close to review. */
  hoursWaiting: number; overdue: boolean; mood: number | null;
  reviewedAt?: string | null; reviewedBy?: string | null; curatorScore?: number | null;
};
/** `mode` is absent on API builds that predate the «Проверено» tab. */
export type QueuePayload = { slaHours: number; mode?: "pending" | "reviewed"; items: QueueItem[] };

export type EodDayMark = { date: string; status: EodStatus; closedAt: string | null; reviewedAt: string | null; reviewedBy: string | null; curatorScore: number | null };

export type BrokerDaily = { date: string; trades: number; wins: number; losses: number; breakeven: number; open: number; gross: number; fees: number; net: number; qty: number };

class NotAvailable extends Error {}

/** Route not deployed (404) or the SPA's HTML fallback → `NotAvailable`; other failures stay `ApiError` (status, body). */
function orNotAvailable<T>(p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    if (isApiError(e) && (e.status === 404 || e.code === CLIENT_CODES.badResponse)) throw new NotAvailable();
    throw e;
  });
}

export const eodKeys = {
  all: ["eod"] as const,
  day: (trader: string, date: string) => ["eod", "day", trader, date] as const,
  status: (date: string, trader: string) => ["eod", "status", date, trader] as const,
  queue: ["eod", "queue"] as const,
  queueReviewed: ["eod", "queue", "reviewed"] as const,
  queueCount: ["eod", "queue", "count"] as const,
  range: (trader: string, from: string, to: string) => ["eod", "range", trader, from, to] as const,
  broker: (trader: string, date: string) => ["eod", "broker", trader, date] as const,
  playbook: ["eod", "playbook"] as const,
};

export const eodApi = {
  day: (trader: string, date: string) =>
    orNotAvailable(http.get<EodDayPayload>("/api/eod/day", { query: { date, trader } })),
  status: (date: string, trader: string) =>
    orNotAvailable(http.get<EodStatusPayload>("/api/eod/status", { query: { date, trader } })),
  queue: (limit = 50, reviewed = false) =>
    orNotAvailable(http.get<QueuePayload>("/api/eod/queue", { query: { limit, reviewed: reviewed ? 1 : null } })),
  range: (trader: string, from: string, to: string) =>
    orNotAvailable(http.get<{ trader: string; days: EodDayMark[] }>("/api/eod/days", { query: { from, to, trader } })),
  queueCount: () => orNotAvailable(http.get<{ count: number; overdue: number; slaHours: number }>("/api/eod/queue/count")),
  saveDay: (date: string, body: { discipline?: number | null; summary?: EodSummary }) =>
    orNotAvailable(http.put<EodDay>(`/api/eod/day/${date}`, body)),
  close: (date: string, body: { discipline?: number | null; summary?: EodSummary }) =>
    orNotAvailable(http.post<{ day: EodDay; streaks: Streaks }>(`/api/eod/day/${date}/close`, body)),
  reopen: (date: string) => orNotAvailable(http.post<EodDay>(`/api/eod/day/${date}/reopen`)),
  reviewTrade: (id: number, body: { followedPlan?: boolean | null; mistakes?: string[]; lesson?: string }) =>
    orNotAvailable(http.put<unknown>(`/api/eod/trades/${id}/review`, body)),
  /** Setup / grade live on the trade itself. Post-hoc classification is not an entry decision, so the checklist gate is bypassed. */
  patchTrade: (id: number, body: { setup?: string | null; confidenceGrade?: Grade; conclusion?: string | null }) =>
    orNotAvailable(http.patch<unknown>(`/api/trades/${id}`, { ...body, skipChecklist: true })),
  curatorReview: (id: number, body: { comment: string; score: number }) =>
    orNotAvailable(http.post<{ day: EodDay; next: QueueItem | null }>(`/api/eod/days/${id}/review`, body)),
  brokerDaily: (trader: string, date: string) =>
    orNotAvailable(http.get<{ days: BrokerDaily[] }>("/api/propreports/daily", { query: { from: date, to: date, trader } }))
      .then((d) => d.days.find((x) => x.date === date) ?? null),
  playbook: () => orNotAvailable(http.get<Array<{ id: number; name: string; setupType?: string | null; folder?: string | null }>>("/api/playbook")),
};

/** `null` when the EOD route is not deployed yet (404) — callers hide the feature instead of erroring. */
export function useEodDay(trader: string, date: string, enabled = true) {
  return useQuery<EodDayPayload | null>({
    queryKey: eodKeys.day(trader, date),
    enabled: enabled && !!trader && !!date,
    staleTime: STALE.live,
    retry: false,
    queryFn: async () => {
      try { return await eodApi.day(trader, date); } catch (e) { if (e instanceof NotAvailable) return null; throw e; }
    },
  });
}

export function useEodStatus(date: string, trader: string, enabled = true) {
  return useQuery<EodStatusPayload | null>({
    queryKey: eodKeys.status(date, trader),
    enabled: enabled && !!date,
    staleTime: STALE.default,
    retry: false,
    queryFn: async () => {
      try { return await eodApi.status(date, trader); } catch (e) { if (e instanceof NotAvailable) return null; throw e; }
    },
  });
}

export function useEodQueue(enabled: boolean) {
  return useQuery<QueuePayload | null>({
    queryKey: eodKeys.queue,
    enabled,
    staleTime: STALE.default,
    refetchInterval: POLL.twoMinutes,
    refetchIntervalInBackground: false,
    retry: false,
    queryFn: async () => {
      try { return await eodApi.queue(); } catch (e) { if (e instanceof NotAvailable) return null; throw e; }
    },
  });
}

/** «Проверено за 7 дней». `null` when the API build does not support it yet (it would ignore the flag). */
export function useEodReviewed(enabled: boolean) {
  return useQuery<QueuePayload | null>({
    queryKey: eodKeys.queueReviewed,
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      try {
        const out = await eodApi.queue(100, true);
        return out.mode === "reviewed" ? out : null;
      } catch (e) { if (e instanceof NotAvailable) return null; throw e; }
    },
  });
}

/** EOD status per day of a range (calendar marks). Empty map while the route is not deployed. */
export function useEodRange(trader: string, from: string, to: string, enabled = true) {
  return useQuery<Map<string, EodDayMark>>({
    queryKey: eodKeys.range(trader, from, to),
    enabled: enabled && !!trader,
    staleTime: 60_000,
    retry: false,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      try {
        const out = await eodApi.range(trader, from, to);
        return new Map(out.days.map((d) => [d.date, d]));
      } catch {
        return new Map();
      }
    },
  });
}

/** Broker daily P&L for the reconcile step; `null` when PropReports is not wired up (route 404 or no rows). */
export function useBrokerDaily(trader: string, date: string, enabled = true) {
  return useQuery<BrokerDaily | null>({
    queryKey: eodKeys.broker(trader, date),
    enabled: enabled && !!date,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      try { return await eodApi.brokerDaily(trader, date); } catch { return null; }
    },
  });
}

export function usePlaybookNames(enabled = true) {
  return useQuery({
    queryKey: eodKeys.playbook,
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      try {
        const rows = await eodApi.playbook();
        return rows.map((r) => ({ id: r.id, name: r.name, folder: r.folder ?? null }));
      } catch {
        return [] as Array<{ id: number; name: string; folder: string | null }>;
      }
    },
  });
}

/** Invalidate everything the EOD flow touches (eod payloads, trades, journal entries). */
export function useInvalidateEod() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: eodKeys.all });
    qc.invalidateQueries({ queryKey: getListTradesQueryKey() });
    qc.invalidateQueries({ queryKey: [JOURNAL_DAYS_KEY] });
  };
}

export function useEodMutation<TArgs, TOut>(fn: (a: TArgs) => Promise<TOut>, onDone?: (out: TOut) => void) {
  const invalidate = useInvalidateEod();
  return useMutation({
    mutationFn: fn,
    onSuccess: (out) => { invalidate(); onDone?.(out); },
  });
}

/** Day status → label in the current language (read on access). */
export const STATUS_LABEL: Record<EodStatus, string> = Object.defineProperties({} as Record<EodStatus, string>, {
  open: { get: () => eodI18n.t("status.open"), enumerable: true },
  closed: { get: () => eodI18n.t("status.closed"), enumerable: true },
  reviewed: { get: () => eodI18n.t("status.reviewed"), enumerable: true },
});
/** 1–5 scale labels (shared with the journal; language-aware). */
export { MOOD_LABELS, DISCIPLINE_LABELS } from "@/components/shared/day-labels";
/**
 * Mistake taxonomy for per-trade review (desk language; matches the journal day tags). Stored codes: the Russian word
 * is what the review keeps; show it with `tagLabel` from components/trades/review-presets.
 */
export const MISTAKE_TAGS = ["FOMO", "Ранний вход", "Поздний выход", "Двигал стоп", "Овертрейдинг", "Реванш", "Без плана", "Большой размер", "Не по сетапу", "Ранний выход"]; // i18n-ignore (stored codes)

export function gradeTone(g: string | null | undefined): "up" | "accent" | "warn" | "down" | "neutral" {
  if (g === "A+") return "up";
  if (g === "A") return "accent";
  if (g === "B") return "warn";
  if (g === "C") return "down";
  return "neutral";
}

export function hoursText(h: number): string {
  if (h < 1) return eodI18n.t("hours.lessThanHour");
  if (h < 48) return eodI18n.t("hours.h", { h: Math.round(h) });
  return eodI18n.t("hours.dh", { d: Math.floor(h / 24), h: Math.round(h % 24) });
}

/**
 * Blocking vs reminder items. Broker-imported trades never block the close (P1-8); on API builds that predate
 * `softMissing` the split is reproduced from the trade source so the UI already behaves the new way.
 */
export function splitMissing(d: EodDayPayload): { blocking: MissingItem[]; soft: MissingItem[] } {
  if (d.softMissing) return { blocking: d.missing, soft: d.softMissing };
  const broker = new Set(d.trades.filter((t) => t.source === "propreports").map((t) => t.id));
  return { blocking: d.missing.filter((m) => !broker.has(m.tradeId)), soft: d.missing.filter((m) => broker.has(m.tradeId)) };
}

/** SLA text for a waiting day: «осталось 5 ч» / «просрочено на 3 ч». */
export function slaText(hoursWaiting: number, slaHours: number): string {
  const left = slaHours - hoursWaiting;
  return left >= 0 ? eodI18n.t("sla.left", { time: hoursText(left) }) : eodI18n.t("sla.overdue", { time: hoursText(-left) });
}

/** Queue row for a closed day opened from the day view (curator «Проверить» outside the queue). */
export function queueItemFromDay(d: EodDayPayload, slaHours = 24): QueueItem | null {
  if (!d.day || d.status === "open") return null;
  const closed = d.day.closedAt ? new Date(d.day.closedAt).getTime() : null;
  const end = d.day.reviewedAt ? new Date(d.day.reviewedAt).getTime() : Date.now();
  const hoursWaiting = closed != null ? Math.max(0, (end - closed) / 3_600_000) : 0;
  return {
    id: d.day.id, trader: d.trader, date: d.date, closedAt: d.day.closedAt, discipline: d.day.discipline,
    trades: d.reconcile.journal.trades, net: d.reconcile.journal.net,
    hoursWaiting, overdue: d.status === "closed" && hoursWaiting > slaHours, mood: d.day.summary?.mood ?? null,
    reviewedAt: d.day.reviewedAt, reviewedBy: d.day.reviewedBy, curatorScore: d.day.curatorScore,
  };
}
