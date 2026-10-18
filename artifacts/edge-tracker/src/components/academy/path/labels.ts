/**
 * Display texts of «Путь трейдера / Экзамены» in the current language (read at call time — never at module scope).
 *
 * The server sends codes plus default RU texts (stage names, metric labels, seeded criterion labels, template names,
 * statuses). A text is translated by its code only when it is still the server default; a stage name, criterion label
 * or exam name customized by staff is user content and is shown as is.
 */
import { academyPathI18n } from "@/i18n/ns/academyPath";
import { commonI18n } from "@/i18n/ns/common";
import ruPath from "@/i18n/locales/ru/academyPath";
import ruCommon from "@/i18n/locales/ru/common";
import { fmtCount, fmtDate, fmtUsd } from "@/lib/format";
import {
  type ChallengeFailure, type ChallengeRules, type ChallengeStatus, type ChallengeTemplate, type CriterionResult, type DrawdownMode,
  type Op, type PromoUnit, type RuleKey, type RuleState, type StageKey, type StageMeta, OP_LABEL, fmtWindow,
} from "./api";

const t = academyPathI18n.t;
const usd0 = (v: number) => fmtUsd(v, { decimals: 0 });

// ─── stages ─────────────────────────────────────────────────────────────────

const TIER_KEY = { trainee: "intern", junior: "junior", trader: "trader", senior: "senior" } as const satisfies Record<StageKey, keyof typeof ruCommon.tiers>;

/** Ladder tier name in the current language (Стажёр = Intern / Stajyor …). */
export const defaultStageName = (key: StageKey): string => commonI18n.t(`tiers.${TIER_KEY[key]}`);

/** A configured stage's name: translated while it is the default RU name, as is when staff renamed it. */
export function stageTitle(s: Pick<StageMeta, "key" | "name">): string {
  const name = s.name?.trim();
  return !name || name === ruCommon.tiers[TIER_KEY[s.key]] ? defaultStageName(s.key) : name;
}

export function stageDescription(s: Pick<StageMeta, "key" | "description">): string {
  return s.description === ruPath.stage.descriptions[s.key] ? t(`stage.descriptions.${s.key}`) : s.description;
}

/** Stage name by key (config stages first), «не назначена» for null. */
export function stageName(stages: StageMeta[] | undefined, key: StageKey | null | undefined): string {
  if (!key) return t("stage.none");
  const s = stages?.find((x) => x.key === key);
  return s ? stageTitle(s) : defaultStageName(key);
}

/** «Стажёр → Джун → Трейдер → Сеньор» in the current language. */
export const ladderText = (): string => (["trainee", "junior", "trader", "senior"] as const).map(defaultStageName).join(" → ");

// ─── metrics and criteria ───────────────────────────────────────────────────

type MetricKey = keyof typeof ruPath.metrics;
const isMetric = (k: string): k is MetricKey => Object.prototype.hasOwnProperty.call(ruPath.metrics, k);

export const metricLabel = (key: string, fallback: string): string => (isMetric(key) ? t(`metrics.${key}.label`) : fallback);
export const metricHint = (key: string, fallback: string): string => (isMetric(key) ? t(`metrics.${key}.hint`) : fallback);

const SEED = ruPath.seedCriteria as Record<string, Record<string, string> | undefined>;

/** Criterion label: the metric name or the seeded default label is translated; a label written by staff stays as is. */
export function criterionLabel(label: string, metric: string, stage: StageKey | null | undefined): string {
  if (isMetric(metric) && label === ruPath.metrics[metric].label) return t(`metrics.${metric}.label`);
  if (stage && SEED[stage]?.[metric] === label) return academyPathI18n.tryT(`seedCriteria.${stage}.${metric}`) ?? label;
  return label;
}

const METRIC_BY_RU_LABEL = new Map<string, MetricKey>((Object.keys(ruPath.metrics) as MetricKey[]).map((k) => [ruPath.metrics[k].label, k]));

/** Same as criterionLabel when only the text is known (funnel «Не хватает: …» list). */
export function criterionLabelByText(label: string, stage: StageKey | null | undefined): string {
  const metric = METRIC_BY_RU_LABEL.get(label);
  if (metric) return t(`metrics.${metric}.label`);
  const seeds = stage ? SEED[stage] : undefined;
  const seeded = seeds ? Object.keys(seeds).find((m) => seeds[m] === label) : undefined;
  return seeded ? academyPathI18n.tryT(`seedCriteria.${stage}.${seeded}`) ?? label : label;
}

const NOTE_KEY = new Map<string, keyof typeof ruPath.notes>(
  (Object.keys(ruPath.notes) as (keyof typeof ruPath.notes)[]).map((k) => [ruPath.notes[k], k]),
);
/** Fixed server notes are translated; notes with numbers come from the server as is. */
export function noteText(note: string | null | undefined): string {
  if (!note) return "";
  const k = NOTE_KEY.get(note);
  return k ? t(`notes.${k}`) : note;
}

/** Value of a promotion metric in the trading format (same in every language). */
export function fmtPromo(unit: PromoUnit, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  switch (unit) {
    case "usd": return usd0(v);
    case "pct": return `${v.toFixed(0)}%`;
    case "x": return `${v.toFixed(2)}×`;
    case "score100": return `${v.toFixed(0)}/100`;
    case "score10": return `${v.toFixed(1)}/10`;
    default: return fmtCount(v, { maximumFractionDigits: 0 });
  }
}
export const fmtPromoTarget = (unit: PromoUnit, op: Op, target: number): string => `${OP_LABEL[op]} ${fmtPromo(unit, target)}`;

/**
 * Window of a criterion. `configured` is the criterion's window from the config (null = since the stage started);
 * undefined when the criterion is not in the config → the server text.
 */
export function windowLabel(c: CriterionResult, configured: number | null | undefined, stageSince: string | null): string {
  if (configured === undefined) return c.windowLabel;
  if (configured != null && configured > 0) return t("criterion.window.days", { count: c.windowDays });
  if (stageSince) return t("criterion.window.sinceStage", { date: fmtDate(stageSince, "short") });
  return t("criterion.window.all");
}

/** Readiness headline (mirrors the server's, in the current language). */
export function headlineText(o: { stage: string | null; next: string | null; passed: number; total: number; ready: boolean }): string {
  if (o.stage == null) return t("headline.noStage");
  if (o.next == null) return t("headline.top");
  if (!o.total) return t("headline.noCriteria", { stage: o.stage });
  return o.ready
    ? t("headline.readyFor", { stage: o.next, passed: o.passed, count: o.total })
    : t("headline.progress", { passed: o.passed, count: o.total });
}

// ─── challenges ─────────────────────────────────────────────────────────────

export const challengeStatusLabel = (s: ChallengeStatus): string => t(`challenge.status.${s}`);
export const ruleStateLabel = (s: RuleState): string => t(`challenge.ruleState.${s}`);

export function ruleLabel(key: RuleKey, mode?: DrawdownMode): string {
  const base = t(`challenge.rules.${key}`);
  return key === "max_drawdown" && mode ? t("challenge.maxDrawdownMode", { label: base, mode: t(`challenge.ddMode.${mode}`) }) : base;
}

/** «Правило «…» нарушено 15.10.2026 в 10:12 NY (сделка #123).» */
export function failureText(f: ChallengeFailure, mode?: DrawdownMode): string {
  const p = { rule: ruleLabel(f.rule, mode), date: fmtDate(f.date), time: f.time ?? "", id: f.tradeId ?? 0 };
  if (f.time && f.tradeId) return t("challenge.failure.dateTimeTrade", p);
  if (f.time) return t("challenge.failure.dateTime", p);
  if (f.tradeId) return t("challenge.failure.dateTrade", p);
  return t("challenge.failure.date", p);
}

/** Short one-line rules summary (cards / detail). */
export function rulesSummary(r: ChallengeRules): string {
  const parts = [
    t("challenge.summary.account", { usd: usd0(r.accountSize) }),
    r.profitTarget != null ? t("challenge.summary.target", { usd: usd0(r.profitTarget) }) : null,
    r.dailyLossLimit != null ? t("challenge.summary.daily", { usd: usd0(r.dailyLossLimit) }) : null,
    r.maxDrawdown != null ? t("challenge.summary.dd", { usd: usd0(r.maxDrawdown), mode: t(`challenge.summary.ddMode.${r.drawdownMode}`) }) : null,
    r.consistencyPct != null ? t("challenge.summary.bestDay", { pct: r.consistencyPct }) : null,
    r.minTradingDays != null ? t("challenge.summary.minDays", { count: r.minTradingDays }) : null,
    r.maxPositionUsd != null ? t("challenge.summary.position", { usd: usd0(r.maxPositionUsd) }) : null,
    r.tradingWindow ? t(r.tradingWindowStrict ? "challenge.summary.window" : "challenge.summary.windowSoft", { window: fmtWindow(r.tradingWindow) }) : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** Full rules description (mirrors the server's describeRules). */
export function describeRules(r: ChallengeRules, durationTradingDays: number): string {
  const locked = r.drawdownMode !== "static" && r.trailingStopsAtStart;
  const ddKey = r.drawdownMode === "static" ? "static" : r.drawdownMode === "trailing_eod" ? (locked ? "trailing_eodLocked" : "trailing_eod") : (locked ? "trailingLocked" : "trailing");
  const parts = [
    t("challenge.describe.account", { usd: usd0(r.accountSize) }),
    r.profitTarget != null
      ? t("challenge.describe.target", { usd: usd0(r.profitTarget), count: durationTradingDays })
      : t("challenge.describe.noTarget", { count: durationTradingDays }),
    r.dailyLossLimit != null ? t("challenge.describe.daily", { usd: usd0(r.dailyLossLimit) }) : null,
    r.maxDrawdown != null ? t(`challenge.describe.dd.${ddKey}`, { usd: usd0(r.maxDrawdown) }) : null,
    r.consistencyPct != null ? t("challenge.describe.bestDay", { pct: r.consistencyPct }) : null,
    r.minTradingDays != null ? t("challenge.describe.minDays", { count: r.minTradingDays }) : null,
    r.maxPositionUsd != null ? t("challenge.describe.positionUsd", { usd: usd0(r.maxPositionUsd) }) : null,
    r.maxPositionQty != null ? t("challenge.describe.positionQty", { count: r.maxPositionQty }) : null,
    r.tradingWindow ? t(r.tradingWindowStrict ? "challenge.describe.windowStrict" : "challenge.describe.windowSoft", { window: fmtWindow(r.tradingWindow) }) : null,
  ];
  return parts.filter(Boolean).join(", ");
}

const isCapital = (tpl: ChallengeTemplate): tpl is ChallengeTemplate & { forStage: StageKey; toStage: StageKey } => tpl.forStage != null && tpl.toStage != null;

/** Template name: capital exams «Перевод Стажёр → Джун (капитал $25k)» and the known trainee tests by key. */
export function templateName(tpl: ChallengeTemplate): string {
  if (isCapital(tpl)) {
    return t("challenge.templates.capital", { from: defaultStageName(tpl.forStage), to: defaultStageName(tpl.toStage), size: `$${Math.round(tpl.rules.accountSize / 1000)}k` });
  }
  return academyPathI18n.tryT(`challenge.templates.${tpl.key}.name`) ?? tpl.name;
}

export function templateDescription(tpl: ChallengeTemplate): string {
  const lead = isCapital(tpl)
    ? t("challenge.templates.capitalLead", { from: defaultStageName(tpl.forStage), to: defaultStageName(tpl.toStage) })
    : academyPathI18n.tryT(`challenge.templates.${tpl.key}.lead`);
  return lead ? t("challenge.templates.description", { lead, rules: describeRules(tpl.rules, tpl.durationTradingDays) }) : tpl.description;
}

/** Exam name: the template's (translated) name while it was not changed at creation, else as stored. */
export function challengeName(c: { name: string; templateKey: string | null }, templates: readonly ChallengeTemplate[] | null | undefined): string {
  const tpl = c.templateKey ? templates?.find((x) => x.key === c.templateKey) : undefined;
  return tpl && tpl.name === c.name ? templateName(tpl) : c.name;
}
