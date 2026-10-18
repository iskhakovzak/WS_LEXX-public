/**
 * «Академия» → когорты и наставничество (агент F2): ЧИСТАЯ логика без БД.
 *
 *  - часовые пояса: настенное время в зоне ⇄ UTC (DST-корректно, через Intl);
 *  - расписание: повторяющиеся (daily / weekdays / weekly по дням недели) и разовые занятия → вхождения;
 *  - окно самоотметки удалённого студента: от −10 мин до +15 мин от начала (проверяет сервер);
 *  - статистика посещаемости по студенту / когорте;
 *  - метрики ИПР (индивидуального плана развития) из реальных сделок: доля комиссий, серия убытков подряд,
 *    винрейт на N сделках, дни дневника с разбором, нетто за N дней, торговые дни; ручные цели;
 *  - «кто отстаёт и почему» для дашборда наставника.
 *
 * Деньги — нетто (gross − |fees|, как lib/tradeMath.netPnl), исход сделки — по нетто-деньгам (как lib/whatIf:
 * брокерская метка win/loss может расходиться с нетто после комиссий), без денег — по полю result.
 * Торговая дата — дата Нью-Йорка (lib/tradingDate). Файл импортируется тестами без БД.
 */
import { addDays, isWeekend } from "./tradingDate";
import { academyCohortsT, academyPathT, ruCohorts, ruPath } from "./academyI18n";
import { DEFAULT_LANG, type Lang } from "../i18n";
import { fmtDateFor } from "../i18n/format";

/* ─── Справочники ──────────────────────────────────────────────────────────── */

export const COHORT_FORMATS = ["office", "remote", "hybrid"] as const;
export type CohortFormat = (typeof COHORT_FORMATS)[number];

/** Лестница (решение владельца): Стажёр → Джун → Трейдер → Сеньор. */
export const STAGES = ["trainee", "junior", "trader", "senior"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABELS: Record<Stage, string> = { trainee: ruPath.stages.trainee.name, junior: ruPath.stages.junior.name, trader: ruPath.stages.trader.name, senior: ruPath.stages.senior.name };
/** Stage name in `lang` (academyPath.stages). */
export function stageLabelFor(stage: Stage, lang: Lang = DEFAULT_LANG): string {
  return academyPathT.tFor(lang)(`stages.${stage}.name`);
}

export const ENROLLMENT_STATUSES = ["active", "paused", "graduated", "dropped"] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];
export const ENROLLMENT_STATUS_LABELS: Record<EnrollmentStatus, string> = ruCohorts.enrollmentStatus;
/** Enrollment status label in `lang`. */
export function enrollmentStatusLabelFor(status: EnrollmentStatus, lang: Lang = DEFAULT_LANG): string {
  return academyCohortsT.tFor(lang)(`enrollmentStatus.${status}`);
}

export const RECURRENCES = ["none", "daily", "weekdays", "weekly"] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export const SESSION_MODES = ["office", "online", "hybrid"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const SESSION_KINDS = ["briefing", "lecture", "review", "workshop", "other"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const ATTENDANCE_STATUSES = ["present", "late", "absent", "excused"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const ACTION_STATUSES = ["open", "done", "dropped"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const GOAL_STATUSES = ["active", "achieved", "missed", "cancelled"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const NY_TZ = "America/New_York";

export function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

/* ─── Часовые пояса ────────────────────────────────────────────────────────── */

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isYmd(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = YMD_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function isHhmm(v: unknown): v is string {
  return typeof v === "string" && HHMM_RE.test(v);
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return false;
  try {
    partsFmt(tz);
    return true;
  } catch {
    return false;
  }
}

function wallParts(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const x of partsFmt(tz).formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** Смещение зоны относительно UTC в минутах в данный момент (NY летом −240, зимой −300). */
export function tzOffsetMinutes(ms: number, tz: string): number {
  const w = wallParts(ms, tz);
  const wallAsUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return Math.round((wallAsUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/**
 * Настенное время `ymd hh:mm` в зоне `tz` → epoch ms. Несуществующее время (переход на летнее, 02:30)
 * сдвигается вперёд на час; неоднозначное (переход на зимнее) — берётся первое вхождение.
 */
export function zonedWallToUtcMs(ymd: string, hhmm: string, tz: string): number {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMinutes(guess, tz);
  let t = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(t, tz);
  if (off2 !== off1) {
    const t2 = guess - off2 * 60000;
    // берём вариант, чьё настенное время совпадает с запрошенным; иначе (дыра DST) — более поздний
    const w2 = wallParts(t2, tz);
    t = w2.h === h && w2.mi === mi ? t2 : Math.max(t, t2);
  }
  return t;
}

/** Дата YYYY-MM-DD в зоне `tz` для момента `ms`. */
export function dateInTz(ms: number, tz: string): string {
  const w = wallParts(ms, tz);
  return `${String(w.y).padStart(4, "0")}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

/** HH:MM в зоне `tz` для момента `ms`. */
export function timeInTz(ms: number, tz: string): string {
  const w = wallParts(ms, tz);
  return `${String(w.h).padStart(2, "0")}:${String(w.mi).padStart(2, "0")}`;
}

/** День недели даты YYYY-MM-DD: 0 = вс … 6 = сб. */
export function weekdayOf(ymd: string): number {
  const [y, mo, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/* ─── Расписание ───────────────────────────────────────────────────────────── */

export interface SessionRule {
  recurrence: Recurrence;
  /** Для weekly: дни недели 0..6 (0 = вс). Пусто ⇒ день недели start_date. */
  weekdays: number[];
  startDate: string;
  endDate: string | null;
  startTime: string;
  durationMin: number;
  timezone: string;
}

export interface Occurrence {
  /** Дата вхождения в зоне занятия. */
  date: string;
  startMs: number;
  endMs: number;
}

export const MAX_OCCURRENCES = 1000;

/** Подходит ли дата `ymd` под правило (без учёта границ start/end). */
export function matchesRule(rule: SessionRule, ymd: string): boolean {
  const wd = weekdayOf(ymd);
  switch (rule.recurrence) {
    case "none": return ymd === rule.startDate;
    case "daily": return true;
    case "weekdays": return wd >= 1 && wd <= 5;
    case "weekly": {
      const days = rule.weekdays.length ? rule.weekdays : [weekdayOf(rule.startDate)];
      return days.includes(wd);
    }
  }
}

/** Даты вхождений в [from, to] (включительно, даты в зоне занятия). */
export function occurrenceDates(rule: SessionRule, from: string, to: string, max = MAX_OCCURRENCES): string[] {
  const lo = from > rule.startDate ? from : rule.startDate;
  let hi = to;
  if (rule.endDate && rule.endDate < hi) hi = rule.endDate;
  if (rule.recurrence === "none") hi = hi < rule.startDate ? hi : rule.startDate;
  const out: string[] = [];
  for (let d = lo; d <= hi && out.length < max; d = addDays(d, 1)) if (matchesRule(rule, d)) out.push(d);
  return out;
}

export function occurrenceAt(rule: SessionRule, date: string): Occurrence {
  const startMs = zonedWallToUtcMs(date, rule.startTime, rule.timezone);
  return { date, startMs, endMs: startMs + Math.max(1, rule.durationMin) * 60000 };
}

export function occurrences(rule: SessionRule, from: string, to: string, max = MAX_OCCURRENCES): Occurrence[] {
  return occurrenceDates(rule, from, to, max).map((d) => occurrenceAt(rule, d));
}

/** Является ли `date` вхождением правила (с учётом start/end). */
export function isOccurrence(rule: SessionRule, date: string): boolean {
  if (!isYmd(date) || date < rule.startDate) return false;
  if (rule.endDate && date > rule.endDate) return false;
  return matchesRule(rule, date);
}

/** Ближайшее вхождение, которое ещё не закончилось к `nowMs` (null — нет в пределах horizonDays). */
export function nextOccurrence(rule: SessionRule, nowMs: number, horizonDays = 60): Occurrence | null {
  const today = dateInTz(nowMs, rule.timezone);
  for (const o of occurrences(rule, addDays(today, -1), addDays(today, horizonDays), horizonDays + 2)) {
    if (o.endMs > nowMs) return o;
  }
  return null;
}

/** Описание правила на языке `lang`: «по будням в 09:00 (America/New_York)». */
export function describeRule(rule: Pick<SessionRule, "recurrence" | "weekdays" | "startDate" | "startTime" | "timezone">, lang: Lang = DEFAULT_LANG): string {
  const t = academyCohortsT.tFor(lang);
  const when = (() => {
    switch (rule.recurrence) {
      case "none": return t("rule.once", { date: rule.startDate });
      case "daily": return t("rule.daily");
      case "weekdays": return t("rule.weekdays");
      case "weekly": {
        const days = (rule.weekdays.length ? rule.weekdays : [weekdayOf(rule.startDate)]).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
        return t("rule.weekly", { days: days.map((d) => academyCohortsT.tryFor(lang, `weekdays.d${d}`) ?? String(d)).join(", ") });
      }
    }
  })();
  return t("rule.full", { when, time: rule.startTime, tz: rule.timezone });
}

/* ─── Самоотметка ──────────────────────────────────────────────────────────── */

export const CHECKIN_BEFORE_MIN = 10;
export const CHECKIN_AFTER_MIN = 15;
/** Отметился не позже чем через 5 мин после начала — «присутствовал», позже — «опоздал». */
export const LATE_GRACE_MIN = 5;

export function checkinWindow(startMs: number): { opensMs: number; closesMs: number } {
  return { opensMs: startMs - CHECKIN_BEFORE_MIN * 60000, closesMs: startMs + CHECKIN_AFTER_MIN * 60000 };
}

export type CheckinVerdict =
  | { ok: true; status: "present" | "late"; minutesFromStart: number }
  | { ok: false; reason: "too_early" | "too_late"; opensMs: number; closesMs: number };

/** Решение сервера о самоотметке (время — серверное `nowMs`). Границы окна включительно. */
export function evaluateCheckin(startMs: number, nowMs: number): CheckinVerdict {
  const { opensMs, closesMs } = checkinWindow(startMs);
  if (nowMs < opensMs) return { ok: false, reason: "too_early", opensMs, closesMs };
  if (nowMs > closesMs) return { ok: false, reason: "too_late", opensMs, closesMs };
  const minutesFromStart = (nowMs - startMs) / 60000;
  return { ok: true, status: minutesFromStart <= LATE_GRACE_MIN ? "present" : "late", minutesFromStart: Math.round(minutesFromStart * 10) / 10 };
}

/* ─── Посещаемость ─────────────────────────────────────────────────────────── */

export interface AttendanceSummary {
  /** Прошедших вхождений, на которые студент был записан. */
  total: number;
  present: number;
  late: number;
  absent: number;
  excused: number;
  /** Прошедшие вхождения без отметки. */
  unmarked: number;
  /** (present + late) / (present + late + absent); уважительные и неотмеченные не в знаменателе. null — нет данных. */
  rate: number | null;
  /** present / (present + late). */
  punctuality: number | null;
  /** Пропусков подряд с конца (неотмеченные не прерывают и не считаются). */
  absentStreak: number;
}

/** `marks` — по одному на прошедшее вхождение, в хронологическом порядке; null = нет отметки. */
export function summarizeAttendance(marks: ReadonlyArray<AttendanceStatus | null>): AttendanceSummary {
  const s: AttendanceSummary = { total: marks.length, present: 0, late: 0, absent: 0, excused: 0, unmarked: 0, rate: null, punctuality: null, absentStreak: 0 };
  for (const m of marks) {
    if (m == null) s.unmarked++;
    else s[m]++;
  }
  const attended = s.present + s.late;
  const denom = attended + s.absent;
  s.rate = denom > 0 ? attended / denom : null;
  s.punctuality = attended > 0 ? s.present / attended : null;
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i];
    if (m == null) continue;
    if (m === "absent") s.absentStreak++;
    else break;
  }
  return s;
}

export function mergeSummaries(list: ReadonlyArray<AttendanceSummary>): AttendanceSummary {
  const s: AttendanceSummary = { total: 0, present: 0, late: 0, absent: 0, excused: 0, unmarked: 0, rate: null, punctuality: null, absentStreak: 0 };
  for (const x of list) {
    s.total += x.total; s.present += x.present; s.late += x.late; s.absent += x.absent; s.excused += x.excused; s.unmarked += x.unmarked;
  }
  const attended = s.present + s.late;
  const denom = attended + s.absent;
  s.rate = denom > 0 ? attended / denom : null;
  s.punctuality = attended > 0 ? s.present / attended : null;
  return s;
}

/* ─── ИПР: метрики из сделок ───────────────────────────────────────────────── */

export const METRIC_KEYS = ["fee_share", "loss_streak", "win_rate", "journal_days", "net_pnl", "trading_days", "manual"] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export const COMPARATORS = ["lt", "lte", "gte", "gt"] as const;
export type Comparator = (typeof COMPARATORS)[number];
export const COMPARATOR_SIGNS: Record<Comparator, string> = { lt: "<", lte: "≤", gte: "≥", gt: ">" };

/** days — последние N торговых дней со сделками; trades — последние N сделок с исходом (W/L);
 *  since_start — с даты начала цели; none — ручная цель. */
export type WindowKind = "days" | "trades" | "since_start" | "none";

export interface MetricDef {
  key: MetricKey;
  label: string;
  unit: string;
  comparator: Comparator;
  windowKind: WindowKind;
  defaultWindow: number | null;
  defaultTarget: number;
  /** Меньше — лучше (для прогресса). */
  lowerIsBetter: boolean;
  description: string;
  example: string;
}

type MetricBase = Omit<MetricDef, "label" | "unit" | "description" | "example">;
const METRIC_BASE: Record<MetricKey, MetricBase> = {
  fee_share: { key: "fee_share", comparator: "lt", windowKind: "days", defaultWindow: 10, defaultTarget: 50, lowerIsBetter: true },
  loss_streak: { key: "loss_streak", comparator: "lte", windowKind: "days", defaultWindow: 10, defaultTarget: 3, lowerIsBetter: true },
  win_rate: { key: "win_rate", comparator: "gte", windowKind: "trades", defaultWindow: 100, defaultTarget: 50, lowerIsBetter: false },
  journal_days: { key: "journal_days", comparator: "gte", windowKind: "since_start", defaultWindow: null, defaultTarget: 10, lowerIsBetter: false },
  net_pnl: { key: "net_pnl", comparator: "gte", windowKind: "days", defaultWindow: 20, defaultTarget: 0, lowerIsBetter: false },
  trading_days: { key: "trading_days", comparator: "gte", windowKind: "since_start", defaultWindow: null, defaultTarget: 20, lowerIsBetter: false },
  manual: { key: "manual", comparator: "gte", windowKind: "none", defaultWindow: null, defaultTarget: 100, lowerIsBetter: false },
};

const metricsCache = new Map<Lang, Record<MetricKey, MetricDef>>();
/** IDP metric catalog with label / unit / description / example in `lang` (`academyCohorts.metrics.*`). */
export function metricsFor(lang: Lang = DEFAULT_LANG): Record<MetricKey, MetricDef> {
  let m = metricsCache.get(lang);
  if (!m) {
    const t = academyCohortsT.tFor(lang);
    m = Object.fromEntries((Object.keys(METRIC_BASE) as MetricKey[]).map((k) => [k, {
      ...METRIC_BASE[k], label: t(`metrics.${k}.label`), unit: t(`metrics.${k}.unit`), description: t(`metrics.${k}.description`), example: t(`metrics.${k}.example`),
    }])) as Record<MetricKey, MetricDef>;
    metricsCache.set(lang, m);
  }
  return m;
}
export const METRICS: Record<MetricKey, MetricDef> = metricsFor(DEFAULT_LANG);

export interface IdpTrade {
  /** Торговая дата (NY) закрытия. */
  date: string;
  /** Порядок внутри дня (время входа, id). */
  seq: number;
  gross: number | null;
  fees: number | null;
  result: "win" | "loss" | "be" | "open" | null;
}

export interface IdpGoalInput {
  metric: MetricKey;
  target: number;
  comparator: Comparator;
  window: number | null;
  startDate: string;
  dueOn: string | null;
  manualProgress: number | null;
}

export interface IdpContext {
  trades: ReadonlyArray<IdpTrade>;
  /** Даты (NY) с дневником «с разбором». */
  journalDates: ReadonlyArray<string>;
  today: string;
}

export interface GoalEval {
  value: number | null;
  /** 0..1 */
  progress: number;
  /** Условие выполнено на имеющейся выборке. */
  met: boolean;
  /** Условие выполнено И выборка полная — цель достигнута. */
  achieved: boolean;
  sample: number;
  required: number | null;
  windowFrom: string | null;
  windowTo: string | null;
  detail: string;
  /** `detail` as data: key under `academyCohorts.goal.*` + params (for notifications rendered per reader). */
  detailMsg: GoalMsg;
}

export type GoalMsg = { key: string; params?: Record<string, string | number>; inner?: GoalMsg };

/** Render a goal detail message in `lang` (`inner` fills `{detail}` of `needDays`). */
export function renderGoalMsg(m: GoalMsg, lang: Lang = DEFAULT_LANG): string {
  const params = { ...(m.params ?? {}), ...(m.inner ? { detail: renderGoalMsg(m.inner, lang) } : {}) };
  return academyCohortsT.tryFor(lang, `goal.${m.key}`, params) ?? m.key;
}

export function netOf(t: Pick<IdpTrade, "gross" | "fees">): number | null {
  return t.gross == null ? null : t.gross - Math.abs(t.fees ?? 0);
}

/** Исход по нетто (как lib/whatIf), без денег — по result. Открытые — null. */
export function outcomeOf(t: IdpTrade): "win" | "loss" | "be" | null {
  if (t.result === "open") return null;
  const n = netOf(t);
  if (n != null) return n > 0 ? "win" : n < 0 ? "loss" : "be";
  return t.result === "win" || t.result === "loss" || t.result === "be" ? t.result : null;
}

export function compare(value: number, cmp: Comparator, target: number): boolean {
  switch (cmp) {
    case "lt": return value < target;
    case "lte": return value <= target;
    case "gte": return value >= target;
    case "gt": return value > target;
  }
}

function sortTrades(ts: ReadonlyArray<IdpTrade>, today: string): IdpTrade[] {
  return ts.filter((t) => t.date <= today && outcomeOf(t) != null).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
}

/** Сделки последних N торговых дней (дни, в которые были закрытые сделки). */
export function lastTradingDays(ts: ReadonlyArray<IdpTrade>, n: number, today: string): { trades: IdpTrade[]; days: string[] } {
  const sorted = sortTrades(ts, today);
  const days = [...new Set(sorted.map((t) => t.date))].slice(-Math.max(1, n));
  const set = new Set(days);
  return { trades: sorted.filter((t) => set.has(t.date)), days };
}

export function maxLossStreak(ts: ReadonlyArray<IdpTrade>): number {
  let streak = 0, max = 0;
  for (const t of ts) {
    const o = outcomeOf(t);
    if (o === "loss") { streak++; if (streak > max) max = streak; }
    else if (o === "win") streak = 0;
  }
  return max;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

function closeness(def: MetricDef, value: number | null, target: number, met: boolean): number {
  if (met) return 1;
  if (value == null) return 0;
  if (def.lowerIsBetter) return value <= 0 ? 1 : clamp01(target / value);
  if (target <= 0) return value >= target ? 1 : 0;
  return clamp01(value / target);
}

export function evaluateGoal(goal: IdpGoalInput, ctx: IdpContext, lang: Lang = DEFAULT_LANG): GoalEval {
  const def = METRICS[goal.metric];
  const out = (msg: GoalMsg) => ({ detail: renderGoalMsg(msg, lang), detailMsg: msg });
  const target = goal.target;
  const cmp = goal.comparator;
  const window = goal.window ?? def.defaultWindow ?? null;
  const sign = COMPARATOR_SIGNS[cmp];

  if (goal.metric === "manual") {
    const p = clamp01((goal.manualProgress ?? 0) / 100);
    return {
      value: r1(p * 100), progress: p, met: p >= 1, achieved: p >= 1, sample: 0, required: null, windowFrom: null, windowTo: null,
      ...out({ key: "manual", params: { pct: Math.round(p * 100) } }),
    };
  }

  if (def.windowKind === "days") {
    const n = window ?? 10;
    const { trades, days } = lastTradingDays(ctx.trades, n, ctx.today);
    const coverage = clamp01(days.length / n);
    const from = days[0] ?? null, to = days[days.length - 1] ?? null;
    let value: number | null = null;
    let msg: GoalMsg = { key: "noTrades" };
    if (goal.metric === "fee_share") {
      let gross = 0, fees = 0;
      for (const t of trades) { gross += t.gross ?? 0; fees += Math.abs(t.fees ?? 0); }
      value = gross > 0 ? r1((fees / gross) * 100) : null;
      if (days.length) msg = gross > 0
        ? { key: "fees", params: { fees: fees.toFixed(2), gross: gross.toFixed(2), days: days.length, n } }
        : { key: "grossNeg", params: { days: days.length, fees: fees.toFixed(2) } };
    } else if (goal.metric === "loss_streak") {
      value = days.length ? maxLossStreak(trades) : null;
      if (days.length) msg = { key: "lossStreak", params: { value: value ?? 0, days: days.length, n, trades: trades.length } };
    } else if (goal.metric === "net_pnl") {
      let net = 0;
      for (const t of trades) net += netOf(t) ?? 0;
      value = days.length ? Math.round(net * 100) / 100 : null;
      if (days.length) msg = { key: "net", params: { net: net.toFixed(2), days: days.length, n } };
    }
    const met = value != null && compare(value, cmp, target);
    const progress = clamp01(coverage * closeness(def, value, target, met));
    return {
      value, progress, met, achieved: met && coverage >= 1, sample: days.length, required: n, windowFrom: from, windowTo: to,
      ...out(coverage < 1 && days.length > 0 ? { key: "needDays", params: { n, sign, target }, inner: msg } : msg),
    };
  }

  if (def.windowKind === "trades") {
    const n = window ?? 100;
    const decided = sortTrades(ctx.trades, ctx.today).filter((t) => { const o = outcomeOf(t); return o === "win" || o === "loss"; }).slice(-n);
    const wins = decided.filter((t) => outcomeOf(t) === "win").length;
    const value = decided.length ? r1((wins / decided.length) * 100) : null;
    const coverage = clamp01(decided.length / n);
    const met = value != null && compare(value, cmp, target);
    return {
      value, progress: clamp01(coverage * closeness(def, value, target, met)), met, achieved: met && coverage >= 1,
      sample: decided.length, required: n, windowFrom: decided[0]?.date ?? null, windowTo: decided[decided.length - 1]?.date ?? null,
      ...out(decided.length
        ? decided.length < n ? { key: "winRateNeed", params: { wins, total: decided.length, n } } : { key: "winRate", params: { wins, total: decided.length } }
        : { key: "noDecided" }),
    };
  }

  // since_start
  const dates = goal.metric === "journal_days"
    ? [...new Set(ctx.journalDates.filter((d) => d >= goal.startDate && d <= ctx.today))]
    : [...new Set(sortTrades(ctx.trades, ctx.today).filter((t) => t.date >= goal.startDate).map((t) => t.date))];
  const value = dates.length;
  const met = compare(value, cmp, target);
  return {
    value, progress: closeness(def, value, target, met), met, achieved: met, sample: value, required: target,
    windowFrom: goal.startDate, windowTo: ctx.today,
    ...out({ key: goal.metric === "journal_days" ? "sinceJournal" : "sinceTrading", params: { value, count: target, date: fmtDateFor(lang, goal.startDate, "short") } }),
  };
}

/** Переход статуса цели после оценки: achieved — достигнута; missed — срок прошёл (dueOn < today), не достигнута. */
export function goalTransition(status: GoalStatus, ev: Pick<GoalEval, "achieved">, dueOn: string | null, today: string): "achieved" | "missed" | null {
  if (status !== "active") return null;
  if (ev.achieved) return "achieved";
  if (dueOn && dueOn < today) return "missed";
  return null;
}

/** Формулировка цели: «Доля комиссий от брутто < 50 % · окно 10 дн.». */
export function describeGoal(goal: Pick<IdpGoalInput, "metric" | "target" | "comparator" | "window">, lang: Lang = DEFAULT_LANG): string {
  const def = metricsFor(lang)[goal.metric];
  if (goal.metric === "manual") return def.label;
  const unit = def.unit === "$" ? "" : ` ${def.unit}`;
  const val = def.unit === "$" ? `$${goal.target}` : `${goal.target}`;
  const w = goal.window ?? def.defaultWindow;
  const t = academyCohortsT.tFor(lang);
  const win = def.windowKind === "days" ? t("goal.formulaDays", { n: w ?? "" }) : def.windowKind === "trades" ? t("goal.formulaTrades", { n: w ?? "" }) : "";
  return `${def.label} ${COMPARATOR_SIGNS[goal.comparator]} ${val}${unit}${win}`;
}

/* ─── Отстающие ────────────────────────────────────────────────────────────── */

/** Будние дни строго между `from` и `to` (без праздников — их таблица живёт в routes/holidays.ts). */
export function weekdaysBetween(from: string, to: string): number {
  if (from >= to) return 0;
  let n = 0;
  for (let d = addDays(from, 1); d < to && n < 400; d = addDays(d, 1)) if (!isWeekend(d)) n++;
  return n;
}

export interface LagInput {
  today: string;
  stage: Stage;
  status: EnrollmentStatus;
  joinedOn: string | null;
  attendance: AttendanceSummary;
  overdueActions: number;
  missedGoals: number;
  /** Активные цели со сроком ≤ 3 дней и прогрессом < 70 %. */
  atRiskGoals: number;
  lastTradeDate: string | null;
  lastJournalDate: string | null;
}

export interface LagReason {
  code: "attendance_low" | "absent_streak" | "unmarked" | "overdue_actions" | "missed_goals" | "goals_at_risk" | "no_trades" | "no_journal" | "paused";
  severity: "warn" | "critical";
  text: string;
  /** Params of `text` (`academyCohorts.lag.<code>`), for clients that render it themselves. */
  params?: Record<string, string | number>;
}

export function lagReasons(i: LagInput, lang: Lang = DEFAULT_LANG): LagReason[] {
  const out: LagReason[] = [];
  const tx = (key: string, params?: Record<string, string | number>) => academyCohortsT.tryFor(lang, `lag.${key}`, params) ?? key;
  const reason = (code: LagReason["code"], severity: LagReason["severity"], key: string, params?: Record<string, string | number>): LagReason =>
    ({ code, severity, text: tx(key, params), ...(params ? { params } : {}) });
  if (i.status === "paused") out.push(reason("paused", "warn", "paused"));
  if (i.status !== "active") return out;
  const a = i.attendance;
  if (a.rate != null && a.present + a.late + a.absent >= 3 && a.rate < 0.75) {
    out.push(reason("attendance_low", a.rate < 0.5 ? "critical" : "warn", "attendance_low", { pct: Math.round(a.rate * 100) }));
  }
  if (a.absentStreak >= 2) out.push(reason("absent_streak", a.absentStreak >= 3 ? "critical" : "warn", "absent_streak", { count: a.absentStreak }));
  if (i.overdueActions > 0) out.push(reason("overdue_actions", i.overdueActions >= 3 ? "critical" : "warn", "overdue_actions", { n: i.overdueActions }));
  if (i.missedGoals > 0) out.push(reason("missed_goals", "critical", "missed_goals", { n: i.missedGoals }));
  if (i.atRiskGoals > 0) out.push(reason("goals_at_risk", "warn", "goals_at_risk", { n: i.atRiskGoals }));
  // Торговые/дневниковые пробелы считаем только после 3 будних дней в программе.
  const settled = !i.joinedOn || weekdaysBetween(i.joinedOn, i.today) >= 3;
  if (settled) {
    const gap = i.lastTradeDate ? weekdaysBetween(i.lastTradeDate, i.today) : null;
    if (gap == null) out.push(reason("no_trades", "warn", "no_trades_never"));
    else if (gap >= 3) out.push(reason("no_trades", gap >= 7 ? "critical" : "warn", "no_trades", { n: gap, date: fmtDateFor(lang, i.lastTradeDate ?? "", "short") }));
    const jgap = i.lastJournalDate ? weekdaysBetween(i.lastJournalDate, i.today) : null;
    if (jgap == null) out.push(reason("no_journal", "warn", "no_journal_never"));
    else if (jgap >= 3) out.push(reason("no_journal", "warn", "no_journal", { n: jgap }));
  }
  return out;
}

export function lagScore(reasons: ReadonlyArray<LagReason>): number {
  return reasons.reduce((s, r) => s + (r.severity === "critical" ? 3 : 1), 0);
}
