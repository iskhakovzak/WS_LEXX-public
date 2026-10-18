/**
 * «Путь трейдера» — promotion engine (pure, no I/O).
 *
 * Ladder (user decision): Стажёр (trainee) → Джун (junior) → Трейдер (trader) → Сеньор (senior).
 * The pre-trainee selection / bootcamp is a separate funnel (agent F4), not a stage here.
 * Stage keys deliberately equal the scaling tiers of lib/scalingEngine.ts (DEFAULT_TIERS: trainee/junior/trader/senior),
 * so a stage borrows its tier's limits (daily loss, max drawdown, account size) for limit-based criteria.
 *
 * The window metrics that already exist in the scaling engine (net $, trades, PF, win rate, max DD, % of DD limit,
 * limit breaches, green days, violations, curator discipline rating) are computed BY the scaling engine
 * (computeWindowMetrics) — this file only adds what the academy needs on top:
 *   trading days, consistency (best day's share of profit), fee share of gross, longest red-day streak,
 *   behaviour discipline index (lib/behaviorEngine, optional), lessons / quizzes completion (F1, optional),
 *   passed evaluation challenges (lib/challengeEngine via the route).
 *
 * Conventions (shared with lib/tradeMath + scalingEngine): money is net of fees; win rate = W/(W+L) (BE excluded);
 * PF = Σ⁺/|Σ⁻|, null (never ∞) when there are no losses; dates are NY trading dates (YYYY-MM-DD).
 */
import {
  addDays, compare, computeWindowMetrics, isWeekend, progressOf, windowStart,
  type LimitsInput, type Op, type RatingInput, type Tier, type TradeInput, type TraderInput,
} from "./scalingEngine";
import { academyPathT, criterionLabelFor, ruPath, stageNameFor } from "./academyI18n";
import { DEFAULT_LANG, formatCountFor, type Lang } from "../i18n";
import { fmtDateFor } from "../i18n/format";

// ─── stages ─────────────────────────────────────────────────────────────────

export type StageKey = "trainee" | "junior" | "trader" | "senior";
export const STAGE_KEYS: readonly StageKey[] = ["trainee", "junior", "trader", "senior"];

export interface StageMeta {
  key: StageKey;
  name: string;
  order: number;
  description: string;
  /** scaling_tiers.key whose limits apply at this stage (null ⇒ none). */
  scalingTier: string | null;
}

/** Old seeded text (mentioned the pre-trainee selection, which is not part of the ladder) — replaced on startup if untouched. */
export const LEGACY_TRAINEE_DESCRIPTION: string = ruPath.stages.legacyTraineeDescription;
export const TRAINEE_DESCRIPTION: string = ruPath.stages.trainee.description;

/** Seeded stages (Russian seed rows; display names per language: academyI18n stageNameFor). */
export const DEFAULT_STAGES: StageMeta[] = (["trainee", "junior", "trader", "senior"] as const).map((key, i) => ({
  key, name: ruPath.stages[key].name, order: i + 1, scalingTier: key, description: ruPath.stages[key].description,
}));

export function isStageKey(v: unknown): v is StageKey {
  return typeof v === "string" && (STAGE_KEYS as readonly string[]).includes(v);
}

export function sortStages(stages: StageMeta[]): StageMeta[] {
  return [...stages].sort((a, b) => a.order - b.order || STAGE_KEYS.indexOf(a.key) - STAGE_KEYS.indexOf(b.key));
}

export function nextStageOf(stages: StageMeta[], key: StageKey | null): StageMeta | null {
  const s = sortStages(stages);
  if (!key) return s[0] ?? null;
  const i = s.findIndex((x) => x.key === key);
  return i >= 0 ? s[i + 1] ?? null : null;
}

// ─── metrics ────────────────────────────────────────────────────────────────

export type PromoMetricKey =
  | "net_pnl" | "trading_days" | "trades" | "max_dd_usd" | "max_dd_pct" | "consistency" | "win_rate" | "profit_factor"
  | "fee_share" | "violations" | "limit_breaches" | "red_streak_max" | "green_days_pct" | "discipline_index"
  | "rating_discipline" | "lessons_pct" | "quiz_avg" | "challenges_passed";

export type PromoUnit = "usd" | "count" | "pct" | "x" | "score100" | "score10" | "days";
export type MetricSource = "trades" | "rules" | "behavior" | "ratings" | "learning" | "challenges";

export interface PromoMetricMeta {
  key: PromoMetricKey;
  label: string;
  unit: PromoUnit;
  higherIsBetter: boolean;
  source: MetricSource;
  hint: string;
}

const METRIC_DEFS: readonly Omit<PromoMetricMeta, "label" | "hint">[] = [
  { key: "net_pnl", unit: "usd", higherIsBetter: true, source: "trades" },
  { key: "trading_days", unit: "days", higherIsBetter: true, source: "trades" },
  { key: "trades", unit: "count", higherIsBetter: true, source: "trades" },
  { key: "max_dd_usd", unit: "usd", higherIsBetter: false, source: "trades" },
  { key: "max_dd_pct", unit: "pct", higherIsBetter: false, source: "trades" },
  { key: "consistency", unit: "pct", higherIsBetter: false, source: "trades" },
  { key: "win_rate", unit: "pct", higherIsBetter: true, source: "trades" },
  { key: "profit_factor", unit: "x", higherIsBetter: true, source: "trades" },
  { key: "fee_share", unit: "pct", higherIsBetter: false, source: "trades" },
  { key: "violations", unit: "count", higherIsBetter: false, source: "rules" },
  { key: "limit_breaches", unit: "count", higherIsBetter: false, source: "trades" },
  { key: "red_streak_max", unit: "days", higherIsBetter: false, source: "trades" },
  { key: "green_days_pct", unit: "pct", higherIsBetter: true, source: "trades" },
  { key: "discipline_index", unit: "score100", higherIsBetter: true, source: "behavior" },
  { key: "rating_discipline", unit: "score10", higherIsBetter: true, source: "ratings" },
  { key: "lessons_pct", unit: "pct", higherIsBetter: true, source: "learning" },
  { key: "quiz_avg", unit: "pct", higherIsBetter: true, source: "learning" },
  { key: "challenges_passed", unit: "count", higherIsBetter: true, source: "challenges" },
];

const metricsCache = new Map<Lang, PromoMetricMeta[]>();
/** Metric catalog with labels / hints in `lang` (`academyPath.metrics.*`). */
export function promoMetricsFor(lang: Lang = DEFAULT_LANG): PromoMetricMeta[] {
  let m = metricsCache.get(lang);
  if (!m) {
    const t = academyPathT.tFor(lang);
    m = METRIC_DEFS.map((d) => ({ ...d, label: t(`metrics.${d.key}.label`), hint: t(`metrics.${d.key}.hint`) }));
    metricsCache.set(lang, m);
  }
  return m;
}
export const PROMO_METRICS: readonly PromoMetricMeta[] = promoMetricsFor(DEFAULT_LANG);

export const PROMO_METRIC_BY_KEY: Record<PromoMetricKey, PromoMetricMeta> =
  Object.fromEntries(PROMO_METRICS.map((m) => [m.key, m])) as Record<PromoMetricKey, PromoMetricMeta>;
export const PROMO_METRIC_KEYS = PROMO_METRICS.map((m) => m.key) as [PromoMetricKey, ...PromoMetricKey[]];

// ─── criteria ───────────────────────────────────────────────────────────────

export interface Criterion {
  id: number;
  /** The stage these criteria are for — i.e. what is required to move from `fromStage` to the next one. */
  fromStage: StageKey;
  metric: PromoMetricKey;
  op: Op;
  value: number;
  /** Window in trading days ending today; null ⇒ since the stage started (or all history). */
  windowDays: number | null;
  label: string | null;
  enabled: boolean;
}

/** Seed label = the Russian seed text of (stage, metric) — `academyPath.seedCriteria` (stored as data). */
const c = (fromStage: StageKey, metric: PromoMetricKey, op: Op, value: number, windowDays: number | null): Omit<Criterion, "id"> =>
  ({ fromStage, metric, op, value, windowDays, label: (ruPath.seedCriteria as Record<string, Record<string, string>>)[fromStage]?.[metric] ?? null, enabled: true });

/** Seeded on first run into academy_stage_criteria, staff-editable afterwards. */
export const DEFAULT_CRITERIA: Omit<Criterion, "id">[] = [
  // Стажёр → Джун (20 торговых дней)
  c("trainee", "trading_days", ">=", 15, 20),
  c("trainee", "net_pnl", ">=", 300, 20),
  c("trainee", "max_dd_usd", "<=", 500, 20),
  c("trainee", "consistency", "<=", 40, 20),
  c("trainee", "win_rate", ">=", 45, 20),
  c("trainee", "profit_factor", ">=", 1.2, 20),
  c("trainee", "fee_share", "<=", 50, 20),
  c("trainee", "violations", "<=", 2, 20),
  c("trainee", "red_streak_max", "<=", 4, 20),
  c("trainee", "discipline_index", ">=", 70, 20),
  c("trainee", "lessons_pct", ">=", 80, null),
  c("trainee", "quiz_avg", ">=", 70, null),
  c("trainee", "challenges_passed", ">=", 1, null),
  // Джун → Трейдер (40 торговых дней)
  c("junior", "trading_days", ">=", 30, 40),
  c("junior", "net_pnl", ">=", 1500, 40),
  c("junior", "max_dd_pct", "<=", 50, 40),
  c("junior", "consistency", "<=", 35, 40),
  c("junior", "win_rate", ">=", 48, 40),
  c("junior", "profit_factor", ">=", 1.3, 40),
  c("junior", "fee_share", "<=", 40, 40),
  c("junior", "limit_breaches", "=", 0, 40),
  c("junior", "violations", "<=", 1, 40),
  c("junior", "discipline_index", ">=", 75, 40),
  c("junior", "quiz_avg", ">=", 80, null),
  c("junior", "challenges_passed", ">=", 1, null),
  // Трейдер → Сеньор (60 торговых дней)
  c("trader", "trading_days", ">=", 50, 60),
  c("trader", "net_pnl", ">=", 6000, 60),
  c("trader", "profit_factor", ">=", 1.5, 60),
  c("trader", "consistency", "<=", 30, 60),
  c("trader", "max_dd_pct", "<=", 50, 60),
  c("trader", "fee_share", "<=", 30, 60),
  c("trader", "green_days_pct", ">=", 55, 60),
  c("trader", "limit_breaches", "=", 0, 60),
  c("trader", "discipline_index", ">=", 80, 60),
];

// ─── input ──────────────────────────────────────────────────────────────────

export interface PromoTrade extends TradeInput {
  /** Gross P&L (pnl), null when unknown. */
  gross: number | null;
  /** |fees| (0 when unknown). */
  fees: number;
}

export interface LearningInput {
  lessonsTotal: number;
  lessonsDone: number;
  /** Average best score per quiz, 0–100 (null when no quiz was taken). */
  quizAvg: number | null;
  quizzesTaken: number;
}

export interface PromotionInput {
  user: string;
  stage: StageKey | null;
  /** YYYY-MM-DD when the current stage started (null ⇒ unknown). */
  stageSince: string | null;
  today: string;
  trades: PromoTrade[];
  violationDates: string[];
  ratings: RatingInput[];
  limits: LimitsInput | null;
  /** Behaviour engine daily discipline scores; null ⇒ engine unavailable. */
  disciplineDays: { date: string; score: number }[] | null;
  /** F1 learning progress; null ⇒ content module not installed. */
  learning: LearningInput | null;
  /** Dates (YYYY-MM-DD) on which evaluation challenges were passed; null ⇒ challenges not available. */
  challengesPassed: string[] | null;
}

export interface MetricOut {
  value: number | null;
  note?: string;
  /** true ⇒ the data source is not installed (criterion is not counted). */
  unavailable?: boolean;
}

// ─── date helpers ───────────────────────────────────────────────────────────

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Weekdays in [from, to] inclusive (holidays not considered). */
export function tradingDaysBetween(from: string, to: string): number {
  if (!YMD.test(from) || !YMD.test(to) || from > to) return 0;
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isWeekend(d)) n++;
  return n;
}

/** Window length in trading days for a criterion (null window ⇒ since stage start, else ~1 year). */
export function resolveWindow(windowDays: number | null, stageSince: string | null, today: string): number {
  if (windowDays != null && windowDays > 0) return Math.round(windowDays);
  if (stageSince && YMD.test(stageSince) && stageSince <= today) return Math.max(1, tradingDaysBetween(stageSince, today));
  return 260;
}

// ─── metric computation ─────────────────────────────────────────────────────

/** Longest run of consecutive negative values. */
export function maxRun(values: number[], pred: (v: number) => boolean): number {
  let best = 0, cur = 0;
  for (const v of values) {
    if (pred(v)) { cur++; if (cur > best) best = cur; } else cur = 0;
  }
  return best;
}

/** Consistency = best day's net / total net × 100; null when the total is not positive. */
export function consistencyPct(dayNets: number[]): number | null {
  const total = dayNets.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  const best = Math.max(...dayNets);
  return best > 0 ? (best / total) * 100 : 0;
}

/** Fee share = Σ|fees| / gross × 100; null when there is no money; ≥ 100 means fees ate the whole gross. */
export function feeSharePct(gross: number, fees: number): number | null {
  if (fees <= 0 && gross === 0) return null;
  if (gross <= 0) return fees > 0 ? 100 : null;
  return (fees / gross) * 100;
}

/**
 * All promotion metrics over a window of `windowDays` trading days ending `today`.
 * Window metrics shared with the scaling plan come from scalingEngine.computeWindowMetrics (same numbers on /scaling).
 */
export function computePromoMetrics(input: PromotionInput, tier: Tier | null, windowDays: number, today = input.today, lang: Lang = DEFAULT_LANG): Record<PromoMetricKey, MetricOut> {
  const t = academyPathT.tFor(lang);
  const scalingInput: TraderInput = {
    trader: input.user,
    tierKey: tier?.key ?? null,
    limits: input.limits,
    trades: input.trades,
    ratings: input.ratings,
    violationDates: input.violationDates,
    today,
  };
  const w = computeWindowMetrics(scalingInput, tier, windowDays, lang);
  const from = w.from;
  const inWin = (d: string) => YMD.test(d) && d >= from && d <= today;

  // Money rows follow the scaling engine's choice (broker rows when the trader has any).
  const rows = input.trades.filter((t) => inWin(t.date) && (w.moneySource === "propreports" ? t.source === "propreports" : true));
  const moneyRows = rows.filter((t) => t.net != null);
  const dayNet = new Map<string, number>();
  let gross = 0, fees = 0, grossKnown = 0;
  for (const t of moneyRows) {
    dayNet.set(t.date, (dayNet.get(t.date) ?? 0) + (t.net as number));
    if (t.gross != null) { gross += t.gross; fees += Math.abs(t.fees || 0); grossKnown++; }
  }
  const tradeDays = new Set(input.trades.filter((t) => inWin(t.date)).map((t) => t.date));
  const days = [...dayNet.keys()].sort();
  const series = days.map((d) => dayNet.get(d) as number);

  const val = (k: keyof typeof w.values): MetricOut => ({ value: w.values[k].value, note: w.values[k].note });

  const disc = input.disciplineDays;
  const discWin = disc ? disc.filter((d) => inWin(d.date)) : null;
  const discAvg = discWin && discWin.length ? discWin.reduce((s, d) => s + d.score, 0) / discWin.length : null;

  const L = input.learning;
  const since = input.stageSince && YMD.test(input.stageSince) ? input.stageSince : null;
  const passed = input.challengesPassed;

  const cons = moneyRows.length ? consistencyPct(series) : null;
  const fee = grossKnown ? feeSharePct(gross, fees) : null;

  return {
    net_pnl: val("net_pnl"),
    trading_days: { value: tradeDays.size },
    trades: val("trades"),
    max_dd_usd: val("max_dd_usd"),
    max_dd_pct: val("max_dd_pct"),
    consistency: {
      value: cons == null ? null : r2(cons),
      note: !moneyRows.length ? t("notes.noMoney") : cons == null ? t("notes.noProfit") : undefined,
    },
    win_rate: val("win_rate"),
    profit_factor: val("profit_factor"),
    fee_share: { value: fee == null ? null : r2(fee), note: fee == null ? t("notes.noMoney") : gross <= 0 ? t("notes.feesAteAll") : undefined },
    violations: val("violations"),
    limit_breaches: val("limit_breaches"),
    red_streak_max: { value: series.length ? maxRun(series, (v) => v < 0) : null, note: series.length ? undefined : t("notes.noMoney") },
    green_days_pct: val("green_days_pct"),
    discipline_index: disc == null
      ? { value: null, unavailable: true, note: t("notes.behaviorOff") }
      : { value: discAvg == null ? null : r2(discAvg), note: discAvg == null ? t("notes.noEntryTimes") : t("notes.behaviorDays", { n: discWin!.length }) },
    rating_discipline: { value: w.values.discipline.value, note: w.values.discipline.note },
    lessons_pct: L == null
      ? { value: null, unavailable: true, note: t("notes.learningOff") }
      : { value: L.lessonsTotal > 0 ? r2((L.lessonsDone / L.lessonsTotal) * 100) : null, note: L.lessonsTotal > 0 ? t("notes.lessonsOf", { done: L.lessonsDone, total: L.lessonsTotal }) : t("notes.noLessons") },
    quiz_avg: L == null
      ? { value: null, unavailable: true, note: t("notes.learningOff") }
      : { value: L.quizAvg == null ? null : r2(L.quizAvg), note: L.quizzesTaken ? t("notes.quizzes", { count: L.quizzesTaken }) : t("notes.noQuizzes") },
    challenges_passed: passed == null
      ? { value: null, unavailable: true, note: t("notes.examsOff") }
      : { value: passed.filter((d) => YMD.test(d) && (!since || d >= since) && d <= today).length },
  };
}

// ─── formatting & advice ────────────────────────────────────────────────────

/** Display value of a metric. Money: "$1 234" in RU (historical), "$1,234" otherwise; counts follow `lang`. */
export function formatPromo(key: PromoMetricKey, v: number | null, lang: Lang = DEFAULT_LANG): string {
  if (v == null) return "—";
  switch (PROMO_METRIC_BY_KEY[key].unit) {
    case "usd": return `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString(lang === "ru" ? "ru-RU" : "en-US", { maximumFractionDigits: 0 })}`;
    case "pct": return `${v.toFixed(0)}%`;
    case "x": return `${v.toFixed(2)}×`;
    case "score100": return `${v.toFixed(0)}/100`;
    case "score10": return `${v.toFixed(1)}/10`;
    default: return formatCountFor(lang, Math.round(v));
  }
}

const OP_TEXT: Record<Op, string> = { ">=": "≥", ">": ">", "<=": "≤", "<": "<", "=": "=" };

export interface AdviceCtx {
  windowDays: number;
  tradingDaysLeftHint?: number;
  bestDay?: number | null;
  totalNet?: number | null;
  grossLoss?: number | null;
  grossProfit?: number | null;
  wins?: number;
  losses?: number;
  gross?: number | null;
  fees?: number | null;
}

/** "What to improve" for a failing criterion — concrete numbers where they can be derived (text in `lang`). */
export function adviceFor(metric: PromoMetricKey, op: Op, actual: number | null, target: number, ctx: AdviceCtx, lang: Lang = DEFAULT_LANG): string {
  const t = academyPathT.tFor(lang);
  const usd = (x: number) => formatPromo("net_pnl", x, lang);
  const opText = OP_TEXT[op];
  switch (metric) {
    case "net_pnl":
      return actual == null ? t("advice.netNoTrades")
        : t("advice.net", { missing: usd(Math.max(0, target - actual)), days: ctx.windowDays, perDay: usd(Math.max(0, target - actual) / Math.max(1, ctx.windowDays)) });
    case "trading_days":
      return t("advice.tradingDays", { n: Math.max(0, Math.ceil(target - (actual ?? 0))), days: ctx.windowDays });
    case "trades":
      return t("advice.trades", { n: Math.max(0, Math.ceil(target - (actual ?? 0))) });
    case "max_dd_usd":
      return actual == null ? t("advice.noMoney") : t("advice.maxDdUsd", { dd: usd(actual), limit: usd(target) });
    case "max_dd_pct":
      return actual == null ? t("advice.maxDdPctNone") : t("advice.maxDdPct", { pct: actual.toFixed(0), op: opText, target });
    case "consistency": {
      if (actual == null) return t("advice.consistencyNoProfit");
      const best = ctx.bestDay ?? null, total = ctx.totalNet ?? null;
      if (best != null && total != null && target > 0) {
        const need = best / (target / 100) - total;
        return t("advice.consistencyNeed", { pct: actual.toFixed(0), target, usd: usd(Math.max(0, need)) });
      }
      return t("advice.consistency", { pct: actual.toFixed(0), target });
    }
    case "win_rate": {
      const w = ctx.wins ?? 0, l = ctx.losses ?? 0;
      if (actual == null) return t("advice.winRateNone");
      const p = target / 100;
      const needWins = p < 1 ? Math.max(0, Math.ceil((p * (w + l) - w) / (1 - p))) : 0;
      return t("advice.winRate", { pct: actual.toFixed(0), w, l, op: opText, target, need: needWins });
    }
    case "profit_factor": {
      if (actual == null) return t("advice.pfNone");
      const gl = Math.abs(ctx.grossLoss ?? 0), gp = ctx.grossProfit ?? 0;
      return gl > 0
        ? t("advice.pf", { pf: actual.toFixed(2), target, needProfit: usd(target * gl), profit: usd(gp), cut: usd(Math.max(0, gl - gp / target)) })
        : t("advice.pfShort", { pf: actual.toFixed(2), target });
    }
    case "fee_share": {
      if (actual == null) return t("advice.feesNone");
      return (ctx.gross ?? 0) <= 0
        ? t("advice.feesAteAll", { fees: usd(ctx.fees ?? 0), gross: usd(ctx.gross ?? 0) })
        : t("advice.fees", { pct: actual.toFixed(0), target });
    }
    case "violations":
      return t("advice.violations", { n: actual ?? 0, target });
    case "limit_breaches":
      return t("advice.limitBreaches", { n: actual ?? 0 });
    case "red_streak_max":
      return actual == null ? t("advice.noMoney") : t("advice.redStreak", { n: actual, target });
    case "green_days_pct":
      return t("advice.greenDays", { pct: actual?.toFixed(0) ?? "—", target });
    case "discipline_index":
      return actual == null ? t("advice.disciplineNone") : t("advice.discipline", { value: actual.toFixed(0), target });
    case "rating_discipline":
      return actual == null ? t("advice.ratingNone") : t("advice.rating", { value: actual.toFixed(1), target });
    case "lessons_pct":
      return t("advice.lessons", { pct: actual?.toFixed(0) ?? 0, target });
    case "quiz_avg":
      return actual == null ? t("advice.quizNone") : t("advice.quiz", { pct: actual.toFixed(0), target });
    case "challenges_passed":
      return t("advice.challenges");
  }
}

// ─── evaluation ─────────────────────────────────────────────────────────────

export type CriterionStatus = "pass" | "fail" | "na";
export type Trend = "better" | "worse" | "flat";

export interface CriterionResult {
  id: number;
  metric: PromoMetricKey;
  label: string;
  hint: string;
  unit: PromoUnit;
  op: Op;
  target: number;
  windowDays: number;
  windowFrom: string;
  /** Human window: "20 торг. дн." / "с 2026-09-01 (начало ступени)" / "за всё время". */
  windowLabel: string;
  value: number | null;
  prevValue: number | null;
  display: string;
  targetDisplay: string;
  status: CriterionStatus;
  /** 0..1 towards passing. */
  progress: number;
  trend: Trend | null;
  note: string | null;
  /** What to improve (only for failing criteria). */
  advice: string | null;
}

export interface ReadinessReport {
  user: string;
  today: string;
  stage: StageMeta | null;
  nextStage: StageMeta | null;
  stageSince: string | null;
  passed: number;
  /** Criteria counted (enabled and their data source available). */
  total: number;
  ready: boolean;
  headline: string;
  criteria: CriterionResult[];
  /** Criteria whose source module is not installed (not counted). */
  skipped: CriterionResult[];
  summary: {
    windowDays: number;
    net: number | null;
    tradingDays: number;
    trades: number | null;
    winRate: number | null;
    profitFactor: number | null;
    maxDd: number | null;
    consistency: number | null;
    feeShare: number | null;
    disciplineIndex: number | null;
  };
}

function trendOf(meta: PromoMetricMeta, cur: number | null, prev: number | null): Trend | null {
  if (cur == null || prev == null) return null;
  const eps = Math.max(1e-9, Math.abs(prev) * 0.02);
  if (Math.abs(cur - prev) <= eps) return "flat";
  return (cur > prev) === meta.higherIsBetter ? "better" : "worse";
}

function adviceCtx(input: PromotionInput, windowDays: number, today: string): AdviceCtx {
  const from = windowStart(today, windowDays);
  const anyBroker = input.trades.some((t) => t.source === "propreports");
  const rows = input.trades.filter((t) => t.date >= from && t.date <= today && (!anyBroker || t.source === "propreports"));
  const dayNet = new Map<string, number>();
  let gp = 0, gl = 0, wins = 0, losses = 0, gross = 0, fees = 0;
  for (const t of rows) {
    if (t.result === "win") wins++; else if (t.result === "loss") losses++;
    if (t.net == null) continue;
    dayNet.set(t.date, (dayNet.get(t.date) ?? 0) + t.net);
    if (t.net > 0) gp += t.net; else gl += t.net;
    if (t.gross != null) { gross += t.gross; fees += Math.abs(t.fees || 0); }
  }
  const nets = [...dayNet.values()];
  return {
    windowDays,
    bestDay: nets.length ? Math.max(...nets) : null,
    totalNet: nets.length ? nets.reduce((a, b) => a + b, 0) : null,
    grossProfit: gp, grossLoss: gl, wins, losses, gross, fees,
  };
}

/**
 * Readiness report for moving `input.stage` → next stage.
 * Criteria of the current stage only; a criterion whose source is not installed is reported in `skipped`
 * and not counted. `ready` ⇔ every counted criterion passes (and there is at least one).
 */
export function evaluatePromotion(input: PromotionInput, criteriaIn: Criterion[], stagesIn: StageMeta[] = DEFAULT_STAGES, tiers: Tier[] = [], lang: Lang = DEFAULT_LANG): ReadinessReport {
  const t = academyPathT.tFor(lang);
  const metricMeta = new Map(promoMetricsFor(lang).map((m) => [m.key, m]));
  const stages = sortStages(stagesIn);
  const stage = input.stage ? stages.find((s) => s.key === input.stage) ?? null : null;
  const nextStage = nextStageOf(stages, input.stage);
  const tier = stage?.scalingTier ? tiers.find((t) => t.key === stage.scalingTier) ?? null : null;
  const today = input.today;

  const criteria = criteriaIn.filter((x) => x.enabled && input.stage != null && x.fromStage === input.stage);
  const cache = new Map<string, Record<PromoMetricKey, MetricOut>>();
  const metricsFor = (n: number, day: string) => {
    const k = `${n}|${day}`;
    let m = cache.get(k);
    if (!m) { m = computePromoMetrics(input, tier, n, day, lang); cache.set(k, m); }
    return m;
  };

  const results: CriterionResult[] = [];
  const skipped: CriterionResult[] = [];
  for (const cr of criteria) {
    const meta = metricMeta.get(cr.metric);
    if (!meta) continue;
    const n = resolveWindow(cr.windowDays, input.stageSince, today);
    const from = windowStart(today, n);
    const m = metricsFor(n, today)[cr.metric];
    // Previous equal window (trend). Not meaningful for cumulative learning/challenge counters.
    const prevable = meta.source !== "learning" && meta.source !== "challenges";
    const prev = prevable ? metricsFor(n, addDays(from, -1))[cr.metric] : null;
    const value = m.value;
    let status: CriterionStatus;
    if (m.unavailable) status = "na";
    else if (value == null) status = "fail";
    else status = compare(value, cr.op, cr.value) ? "pass" : "fail";
    const progress = status === "pass" ? 1 : value == null ? 0 : progressOf(value, cr.op, cr.value);
    const res: CriterionResult = {
      id: cr.id,
      metric: cr.metric,
      label: criterionLabelFor(cr.fromStage, cr.metric, cr.label, lang),
      hint: meta.hint,
      unit: meta.unit,
      op: cr.op,
      target: cr.value,
      windowDays: n,
      windowFrom: from,
      windowLabel: cr.windowDays != null && cr.windowDays > 0 ? t("window.days", { n })
        : input.stageSince ? t("window.since", { date: fmtDateFor(lang, input.stageSince, "short") }) : t("window.all"),
      value,
      prevValue: prev?.value ?? null,
      display: formatPromo(cr.metric, value, lang),
      targetDisplay: `${OP_TEXT[cr.op]} ${formatPromo(cr.metric, cr.value, lang)}`,
      status,
      progress: Math.round(progress * 1000) / 1000,
      trend: trendOf(meta, value, prev?.value ?? null),
      note: m.note ?? null,
      advice: status === "fail" ? adviceFor(cr.metric, cr.op, value, cr.value, adviceCtx(input, n, today), lang) : null,
    };
    (status === "na" ? skipped : results).push(res);
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const total = results.length;
  const ready = !!nextStage && total > 0 && passed === total;
  let headline: string;
  if (!stage) headline = t("headline.noStage");
  else if (!nextStage) headline = t("headline.top");
  else if (!total) headline = t("headline.noCriteria", { stage: stageNameFor(stage.key, stage.name, lang) });
  else headline = ready ? t("headline.readyNext", { stage: stageNameFor(nextStage.key, nextStage.name, lang), passed, total }) : t("headline.progress", { passed, total });

  const sw = criteria.length ? Math.max(...criteria.map((x) => resolveWindow(x.windowDays, input.stageSince, today)).filter((x) => x < 260), 20) : 20;
  const s = metricsFor(sw, today);
  return {
    user: input.user,
    today,
    stage,
    nextStage,
    stageSince: input.stageSince,
    passed,
    total,
    ready,
    headline,
    criteria: results,
    skipped,
    summary: {
      windowDays: sw,
      net: s.net_pnl.value,
      tradingDays: s.trading_days.value ?? 0,
      trades: s.trades.value,
      winRate: s.win_rate.value,
      profitFactor: s.profit_factor.value,
      maxDd: s.max_dd_usd.value,
      consistency: s.consistency.value,
      feeShare: s.fee_share.value,
      disciplineIndex: s.discipline_index.value,
    },
  };
}

