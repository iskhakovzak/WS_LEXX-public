/**
 * Кабинет куратора и риск-процессы — чистая логика (без БД), покрыта lib/curatorLogic.test.ts.
 *
 *   tradingPhase       премаркет / сессия / после закрытия / выходной по минутам Нью-Йорка
 *   prevTradingDay     предыдущий будний день (праздники не учитываются — на них просто нет сделок)
 *   breachStats        нарушения за 7 календарных дней → повторное ли сегодняшнее (эскалация руководителю деска)
 *   templateDiff       расхождение лимитов трейдера с шаблоном тира (Стажёр / Джун / Трейдер / Сеньор)
 *   weeklyTrend        P&L нетто по неделям (пн–пт) за N последних недель
 *   nextActionFor      следующий шаг куратора по трейдеру (один, самый важный)
 *   BREACH_REASONS     справочник причин нарушения для «Разбора нарушения»
 */
import { addDays, isWeekend } from "./tradingDate";
import { riskT } from "../i18n/ns";
import type { Lang } from "../i18n";

// ─── время ──────────────────────────────────────────────────────────────────

export type TradingPhase = "premarket" | "session" | "afterclose" | "weekend";

export const OPEN_MINUTES = 9 * 60 + 30;
export const CLOSE_MINUTES = 16 * 60;

/** Фаза дня куратора по дате и минутам NY. */
export function tradingPhase(date: string, nyMinutes: number): TradingPhase {
  if (isWeekend(date)) return "weekend";
  if (nyMinutes < OPEN_MINUTES) return "premarket";
  if (nyMinutes < CLOSE_MINUTES) return "session";
  return "afterclose";
}

/** Предыдущий будний день (NY-дата). */
export function prevTradingDay(date: string): string {
  let d = addDays(date, -1);
  for (let i = 0; i < 7 && isWeekend(d); i++) d = addDays(d, -1);
  return d;
}

/** Понедельник недели, в которую попадает дата. */
export function mondayOf(ymd: string): string {
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return addDays(ymd, dow === 0 ? -6 : 1 - dow);
}

// ─── эскалация нарушений ────────────────────────────────────────────────────

export const REPEAT_WINDOW_DAYS = 7;

/**
 * Даты нарушений (level = breach) трейдера → сколько разных дней с нарушением за последние 7 календарных дней
 * (включая today) и повторное ли сегодняшнее: было хотя бы одно другое нарушение в окне.
 */
export function breachStats(dates: readonly string[], today: string): { days7: number; repeat: boolean; prior: string[] } {
  const from = addDays(today, -(REPEAT_WINDOW_DAYS - 1));
  const inWindow = [...new Set(dates.filter((d) => d >= from && d <= today))].sort();
  const prior = inWindow.filter((d) => d !== today);
  return { days7: inWindow.length, repeat: inWindow.includes(today) && prior.length > 0, prior };
}

/** Ключ дедупликации: одно уведомление руководителю деска на трейдера в день. */
export function repeatBreachKey(trader: string, date: string): string {
  return `risk:repeat_breach:${trader}:${date}`;
}

// ─── шаблоны лимитов ────────────────────────────────────────────────────────

export type LimitFields = {
  accountSize: number | null;
  dailyLossLimit: number | null;
  weeklyLossLimit: number | null;
  maxDrawdown: number | null;
  maxRiskPerTrade: number | null;
  maxPositionUsd: number | null;
  maxOvernightExposure: number | null;
  maxOpenPositions: number | null;
  allowOvernight: boolean;
  allowSwing: boolean;
};

const LIMIT_FIELDS: readonly (keyof LimitFields)[] = [
  "accountSize", "dailyLossLimit", "weeklyLossLimit", "maxDrawdown", "maxRiskPerTrade",
  "maxPositionUsd", "maxOvernightExposure", "maxOpenPositions", "allowOvernight", "allowSwing",
];

/** Label of a limit field in `lang` (risk namespace `limitField.*`). */
export function limitFieldLabel(field: keyof LimitFields, lang: Lang = "ru"): string {
  return riskT.tFor(lang)(`limitField.${field}`);
}

/** RU labels (kept for older imports). */
export const LIMIT_FIELD_LABELS = Object.fromEntries(LIMIT_FIELDS.map((f) => [f, limitFieldLabel(f)])) as Record<keyof LimitFields, string>;

export type LimitDiff = { field: keyof LimitFields; label: string; current: number | boolean | null; template: number | boolean | null };

const sameNum = (a: number | null, b: number | null) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.005);

/** Поля, где лимиты трейдера отличаются от шаблона тира (пусто = совпадают). null limits ⇒ отличается всё заданное. */
export function templateDiff(limits: LimitFields | null, template: LimitFields, lang: Lang = "ru"): LimitDiff[] {
  const out: LimitDiff[] = [];
  for (const field of LIMIT_FIELDS) {
    const cur = limits ? limits[field] : null;
    const tpl = template[field];
    const differs = typeof tpl === "boolean" ? (limits ? cur !== tpl : true) : !sameNum(cur as number | null, tpl as number | null);
    if (differs) out.push({ field, label: limitFieldLabel(field, lang), current: cur, template: tpl });
  }
  return out;
}

/** Академические ступени ↔ ключи тиров масштабирования (одни и те же ключи; «lead» — только в масштабировании). */
export const STAGE_TIER_KEYS = ["trainee", "junior", "trader", "senior"] as const;
const TIER_KEYS = ["trainee", "junior", "trader", "senior", "lead"] as const;
/** Stage / tier name in `lang` (risk namespace `tier.*`); unknown keys → undefined. */
export function stageLabel(key: string | null | undefined, lang: Lang = "ru"): string | undefined {
  return key ? riskT.tryFor(lang, `tier.${key}`) : undefined;
}
/** Stage / tier names by key in `lang`. */
export function stageLabels(lang: Lang = "ru"): Record<string, string> {
  return Object.fromEntries(TIER_KEYS.map((k) => [k, stageLabel(k, lang)!]));
}
/** RU names (kept for older imports). */
export const STAGE_LABELS: Record<string, string> = stageLabels("ru");

// ─── тренд ──────────────────────────────────────────────────────────────────

export type WeekPoint = { week: string; net: number | null; trades: number };

/** P&L нетто по неделям: последние `weeks` недель, самая старая первой. Недели без $-данных → net = null. */
export function weeklyTrend(days: ReadonlyArray<{ date: string; pnl: number | null; trades: number }>, today: string, weeks = 4): WeekPoint[] {
  const thisMon = mondayOf(today);
  const starts = Array.from({ length: weeks }, (_, i) => addDays(thisMon, -7 * (weeks - 1 - i)));
  return starts.map((ws) => {
    const we = addDays(ws, 6);
    const rows = days.filter((d) => d.date >= ws && d.date <= we);
    const priced = rows.filter((d) => d.pnl != null);
    return {
      week: ws,
      net: priced.length ? Math.round(priced.reduce((s, d) => s + (d.pnl ?? 0), 0) * 100) / 100 : null,
      trades: rows.reduce((s, d) => s + d.trades, 0),
    };
  });
}

/** Направление тренда по последним неделям: up / down / flat / none (недостаточно данных). */
export function trendDirection(points: readonly WeekPoint[]): "up" | "down" | "flat" | "none" {
  const vals = points.map((p) => p.net).filter((v): v is number => v != null);
  if (vals.length < 2) return "none";
  const half = Math.floor(vals.length / 2);
  const a = vals.slice(0, half).reduce((s, v) => s + v, 0) / Math.max(1, half);
  const b = vals.slice(half).reduce((s, v) => s + v, 0) / Math.max(1, vals.length - half);
  const scale = Math.max(1, ...vals.map((v) => Math.abs(v)));
  if (Math.abs(b - a) < 0.1 * scale) return "flat";
  return b > a ? "up" : "down";
}

// ─── следующий шаг ──────────────────────────────────────────────────────────

export type NextActionKind =
  | "breach_review" | "stopped" | "near_stop" | "eod_review" | "weekly_review" | "overdue_action"
  | "no_limits" | "template_drift" | "missing_plan" | "missing_eod" | "one_on_one" | "none";

export type NextAction = { kind: NextActionKind; label: string; priority: number; href: string };

export type NextActionInput = {
  trader: string;
  halted: boolean;
  nearStop: boolean;
  unreviewedBreaches: number;
  eodPending: number;
  weeklySubmitted: boolean;
  overdueActions: number;
  hasLimits: boolean;
  templateDrift: number;
  missingPlan: boolean;
  missingEod: boolean;
  /** Дней с последней 1:1 (null — не было ни одной). */
  daysSinceOneOnOne: number | null;
};

const enc = encodeURIComponent;

/** Один следующий шаг: самое срочное из того, что куратор может сделать по трейдеру прямо сейчас. */
export function nextActionFor(x: NextActionInput, lang: Lang = "ru"): NextAction {
  const t = enc(x.trader);
  const L = riskT.tFor(lang);
  const cands: NextAction[] = [];
  if (x.unreviewedBreaches > 0) cands.push({ kind: "breach_review", priority: 100, label: x.unreviewedBreaches > 1 ? L("next.breach_review_n", { count: x.unreviewedBreaches }) : L("next.breach_review"), href: `/curator?trader=${t}&tab=risk` });
  if (x.halted) cands.push({ kind: "stopped", priority: 95, label: L("next.stopped"), href: `/risk?trader=${t}` });
  if (x.nearStop) cands.push({ kind: "near_stop", priority: 80, label: L("next.near_stop"), href: `/risk?trader=${t}` });
  if (x.eodPending > 0) cands.push({ kind: "eod_review", priority: 70, label: x.eodPending > 1 ? L("next.eod_review_n", { count: x.eodPending }) : L("next.eod_review"), href: `/curator?trader=${t}&tab=journal` });
  if (x.weeklySubmitted) cands.push({ kind: "weekly_review", priority: 65, label: L("next.weekly_review"), href: `/weekly-review?view=curator&trader=${t}` });
  if (x.overdueActions > 0) cands.push({ kind: "overdue_action", priority: 60, label: L("next.overdue_action", { count: x.overdueActions }), href: `/curator?trader=${t}&tab=academy` });
  if (!x.hasLimits) cands.push({ kind: "no_limits", priority: 55, label: L("next.no_limits"), href: `/curator?trader=${t}&tab=risk` });
  else if (x.templateDrift > 0) cands.push({ kind: "template_drift", priority: 30, label: L("next.template_drift"), href: `/curator?trader=${t}&tab=risk` });
  if (x.missingEod) cands.push({ kind: "missing_eod", priority: 45, label: L("next.missing_eod"), href: `/journal?trader=${t}` });
  if (x.missingPlan) cands.push({ kind: "missing_plan", priority: 40, label: L("next.missing_plan"), href: `/curator?trader=${t}&tab=journal` });
  if (x.daysSinceOneOnOne == null || x.daysSinceOneOnOne > 14) {
    cands.push({ kind: "one_on_one", priority: 20, label: x.daysSinceOneOnOne == null ? L("next.one_on_one_first") : L("next.one_on_one_days", { days: x.daysSinceOneOnOne }), href: `/academy/mentor?student=${t}` });
  }
  if (!cands.length) return { kind: "none", priority: 0, label: L("next.none"), href: `/curator?trader=${t}` };
  return cands.sort((a, b) => b.priority - a.priority)[0];
}

// ─── разбор нарушения ───────────────────────────────────────────────────────

const REASON_KEYS = ["revenge", "size", "no_stop", "overtrading", "news", "overnight", "tilt", "technical", "other"] as const;
export type BreachReason = (typeof REASON_KEYS)[number];
export const BREACH_REASON_KEYS = REASON_KEYS as unknown as readonly [BreachReason, ...BreachReason[]];
/** Breach reasons with labels in `lang` (risk namespace `breach.reason.*`). */
export function breachReasons(lang: Lang = "ru"): { key: BreachReason; label: string }[] {
  return REASON_KEYS.map((key) => ({ key, label: riskT.tFor(lang)(`breach.reason.${key}`) }));
}
/** RU list (kept for older imports). */
export const BREACH_REASONS = breachReasons("ru");

const CONSEQUENCE_KEYS = ["none", "warning", "reduced", "pause", "demote"] as const;
export type BreachConsequence = (typeof CONSEQUENCE_KEYS)[number];
export const BREACH_CONSEQUENCE_KEYS = CONSEQUENCE_KEYS as unknown as readonly [BreachConsequence, ...BreachConsequence[]];
/** Breach consequences with labels in `lang` (risk namespace `breach.consequence.*`). */
export function breachConsequences(lang: Lang = "ru"): { key: BreachConsequence; label: string }[] {
  return CONSEQUENCE_KEYS.map((key) => ({ key, label: riskT.tFor(lang)(`breach.consequence.${key}`) }));
}
/** RU list (kept for older imports). */
export const BREACH_CONSEQUENCES = breachConsequences("ru");

export type BreachAction = { id: string; title: string; dueOn: string | null; status: "open" | "done" | "dropped" };

/** Нормализация договорённостей разбора: id, обрезка, статус по умолчанию, не больше 10. */
export function normalizeBreachActions(raw: ReadonlyArray<{ id?: string; title: string; dueOn?: string | null; status?: string }>): BreachAction[] {
  const seen = new Set<string>();
  const out: BreachAction[] = [];
  raw.forEach((a, i) => {
    const title = String(a.title ?? "").trim().slice(0, 300);
    if (!title) return;
    let id = (a.id ?? "").trim().slice(0, 40) || `a${i + 1}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    const status = a.status === "done" || a.status === "dropped" ? a.status : "open";
    out.push({ id, title, dueOn: a.dueOn && /^\d{4}-\d{2}-\d{2}$/.test(a.dueOn) ? a.dueOn : null, status });
  });
  return out.slice(0, 10);
}

// ─── очередь разборов ───────────────────────────────────────────────────────

export type QueueKind = "eod" | "weekly" | "academy" | "breach";
export const QUEUE_SLA_HOURS: Record<QueueKind, number> = { eod: 24, weekly: 48, academy: 72, breach: 24 };
/** По умолчанию очередь показывает только последние N дней; старое — по запросу или в архив. */
export const QUEUE_DEFAULT_DAYS = 14;
/** Важность типа: нарушения риска — первыми, затем дни/недели, затем задания Академии. */
const QUEUE_KIND_RANK: Record<QueueKind, number> = { breach: 0, eod: 1, weekly: 1, academy: 2 };

export type QueueItemBase = { kind: QueueKind; id: string; since: string | null; hoursWaiting: number | null };
export type QueueItem<T extends QueueItemBase> = T & { overdue: boolean; slaHours: number; old: boolean };

/**
 * Упорядочить и отсечь очередь: убрать архивированные (acked), пометить просрочку SLA,
 * спрятать элементы старше `cutoffDays` (если не `includeOld`), отсортировать —
 * сначала важные типы, внутри — самые свежие. Возвращает видимые элементы и сводку по скрытым старым.
 */
export function arrangeQueue<T extends QueueItemBase>(
  items: readonly T[],
  opts: { cutoffDays?: number; includeOld?: boolean; acked?: ReadonlySet<string> } = {},
): { items: QueueItem<T>[]; old: { count: number; overdue: number } } {
  const cutoffHours = (opts.cutoffDays ?? QUEUE_DEFAULT_DAYS) * 24;
  const all = items
    .filter((q) => !opts.acked?.has(q.id))
    .map((q) => {
      const h = q.hoursWaiting ?? 0;
      return { ...q, overdue: h > QUEUE_SLA_HOURS[q.kind], slaHours: QUEUE_SLA_HOURS[q.kind], old: h > cutoffHours };
    });
  const oldItems = all.filter((q) => q.old);
  const visible = opts.includeOld ? all : all.filter((q) => !q.old);
  visible.sort((x, y) =>
    QUEUE_KIND_RANK[x.kind] - QUEUE_KIND_RANK[y.kind]
    || (x.hoursWaiting ?? Infinity) - (y.hoursWaiting ?? Infinity)
    || x.id.localeCompare(y.id));
  return { items: visible, old: { count: oldItems.length, overdue: oldItems.filter((q) => q.overdue).length } };
}

/** Id элементов, которые «архивировать старые» уберёт из очереди (старше cutoffDays, не архивированы). */
export function staleQueueIds(items: readonly QueueItemBase[], cutoffDays = QUEUE_DEFAULT_DAYS, acked?: ReadonlySet<string>): string[] {
  const cutoffHours = cutoffDays * 24;
  return items.filter((q) => !acked?.has(q.id) && (q.hoursWaiting ?? 0) > cutoffHours).map((q) => q.id);
}
