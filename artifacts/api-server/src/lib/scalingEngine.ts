/**
 * Scaling plan engine («План масштабирования»): pure functions, no I/O.
 *
 * Given the tier ladder, the rule set and a trader's already-normalised trade rows
 * (close date, net P&L, signed R, result — produced by the shared SQL builders in lib/tradeMath.ts),
 * it computes window metrics, checks every rule and returns a promote / hold / demote recommendation
 * with the actual values and the progress towards the next tier.
 *
 * Conventions mirror lib/tradeMath.ts + edge-tracker/src/lib/trade-math.ts:
 *   win rate = W / (W + L) (BE excluded); PF = Σ⁺ / |Σ⁻| (null, never ∞); money is net of fees;
 *   drawdown = peak-to-trough of the cumulative series.
 * Money metrics come from broker rows (source = 'propreports') when the trader has any; otherwise from the journal.
 *
 * Texts (metric labels, notes, rule results, reasons) come from the server `scaling` namespace in `lang` (default RU).
 * Recommendation reasons are also returned as data (`reasonItems`, rendered again per reader by renderReason) so a
 * stored proposal can be shown in any language.
 */
import { scalingT } from "../i18n/ns";
import { formatCountFor, type Lang, } from "../i18n";

export type RuleKind = "promote" | "demote";
export type Op = ">=" | ">" | "<=" | "<" | "=";
export type Unit = "abs" | "x_daily_limit" | "pct_account";
export type MetricUnit = "usd" | "r" | "pct" | "count" | "x" | "score" | "weeks" | "days";

export type MetricKey =
  | "trades"
  | "net_pnl"
  | "net_r"
  | "profit_factor"
  | "win_rate"
  | "expectancy_r"
  | "green_weeks"
  | "green_days_pct"
  | "max_dd_usd"
  | "max_dd_pct"
  | "limit_breaches"
  | "red_streak"
  | "discipline"
  | "rating_overall"
  | "violations";

export interface MetricMeta {
  key: MetricKey;
  label: string;
  unit: MetricUnit;
  /** true ⇒ bigger is better (promotion rules use ≥, demotion ≤). */
  higherIsBetter: boolean;
  hint: string;
}

const METRIC_DEFS: readonly Omit<MetricMeta, "label" | "hint">[] = [
  { key: "trades", unit: "count", higherIsBetter: true },
  { key: "net_pnl", unit: "usd", higherIsBetter: true },
  { key: "net_r", unit: "r", higherIsBetter: true },
  { key: "profit_factor", unit: "x", higherIsBetter: true },
  { key: "win_rate", unit: "pct", higherIsBetter: true },
  { key: "expectancy_r", unit: "r", higherIsBetter: true },
  { key: "green_weeks", unit: "weeks", higherIsBetter: true },
  { key: "green_days_pct", unit: "pct", higherIsBetter: true },
  { key: "max_dd_usd", unit: "usd", higherIsBetter: false },
  { key: "max_dd_pct", unit: "pct", higherIsBetter: false },
  { key: "limit_breaches", unit: "count", higherIsBetter: false },
  { key: "red_streak", unit: "days", higherIsBetter: false },
  { key: "discipline", unit: "score", higherIsBetter: true },
  { key: "rating_overall", unit: "score", higherIsBetter: true },
  { key: "violations", unit: "count", higherIsBetter: false },
];

/** Metric registry with labels / hints in `lang`. */
export function metricsMeta(lang: Lang = "ru"): MetricMeta[] {
  const t = scalingT.tFor(lang);
  return METRIC_DEFS.map((m) => ({ ...m, label: t(`metric.${m.key}.label`), hint: t(`metric.${m.key}.hint`) }));
}

/** RU registry (kept for older imports). */
export const METRICS: readonly MetricMeta[] = metricsMeta("ru");

export const METRIC_BY_KEY: Record<MetricKey, MetricMeta> = Object.fromEntries(METRICS.map((m) => [m.key, m])) as Record<MetricKey, MetricMeta>;
export const OPS: readonly Op[] = [">=", ">", "<=", "<", "="];
const UNIT_KEYS: readonly Unit[] = ["abs", "x_daily_limit", "pct_account"];
/** Threshold units with labels in `lang`. */
export function unitsMeta(lang: Lang = "ru"): { key: Unit; label: string }[] {
  return UNIT_KEYS.map((key) => ({ key, label: scalingT.tFor(lang)(`unit.${key}`) }));
}
/** RU list (kept for older imports). */
export const UNITS: readonly { key: Unit; label: string }[] = unitsMeta("ru");

export interface Tier {
  key: string;
  name: string;
  order: number;
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
  description?: string | null;
}

export interface Rule {
  id: number;
  kind: RuleKind;
  metric: MetricKey;
  op: Op;
  value: number;
  unit: Unit;
  windowDays: number;
  /** null ⇒ applies at every tier. */
  tierKey: string | null;
  label: string | null;
  enabled: boolean;
}

export interface TradeInput {
  /** Close date YYYY-MM-DD (exit date for multi-day holds). */
  date: string;
  /** Net P&L (pnl − |fees|), null when the journal has no money. */
  net: number | null;
  /** Signed R, null when it cannot be derived. */
  r: number | null;
  result: "win" | "loss" | "be";
  source: "propreports" | "manual";
}

export interface RatingInput {
  /** Monday of the rated week, YYYY-MM-DD. */
  week: string;
  discipline: number | null;
  overall: number | null;
}

export interface LimitsInput {
  accountSize: number | null;
  dailyLossLimit: number | null;
  weeklyLossLimit: number | null;
  maxDrawdown: number | null;
}

export interface TraderInput {
  trader: string;
  tierKey: string | null;
  limits: LimitsInput | null;
  trades: TradeInput[];
  ratings: RatingInput[];
  /** YYYY-MM-DD of each rule violation / logged mistake. */
  violationDates: string[];
  today: string;
}

export interface MetricValue {
  key: MetricKey;
  value: number | null;
  /** Which series produced the number ("$" vs "R" fallbacks). */
  basis?: "usd" | "r";
  /** Why the value is what it is (rendered in the requested language). */
  note?: string;
  /** The same note as data (scaling namespace `note.<code>`; `ratings` takes `noteCount`). */
  noteCode?: NoteCode;
  noteCount?: number;
}

export type NoteCode = "noLimits" | "broker" | "journal" | "noMoney" | "noLosses" | "noTrades" | "byR" | "byUsd" | "noDdLimit" | "noRatings" | "ratings";

export interface WindowMetrics {
  windowDays: number;
  from: string;
  to: string;
  moneySource: "propreports" | "journal";
  hasMoney: boolean;
  values: Record<MetricKey, MetricValue>;
}

export type RuleStatus = "pass" | "fail" | "na";

export interface RuleResult {
  ruleId: number;
  kind: RuleKind;
  metric: MetricKey;
  label: string;
  op: Op;
  /** Resolved threshold in the metric's unit (null when it cannot be resolved, e.g. no daily limit). */
  threshold: number | null;
  rawValue: number;
  unit: Unit;
  windowDays: number;
  actual: number | null;
  basis?: "usd" | "r";
  status: RuleStatus;
  /** 0..1 progress towards passing (1 = passes). */
  progress: number;
  text: string;
  /** Why the threshold is not defined (status "na" without a threshold). */
  naReason?: "noDailyLimit" | "noAccount";
  /** Custom rule label typed by a curator (null → the metric label in the reader's language). */
  customLabel: string | null;
}

/** A recommendation reason as data (rendered per reader by renderReason). */
export type ReasonItem =
  | { code: "tierMissing"; tier: string }
  | { code: "noTier" | "noLowerTier" | "topTier" | "noPromoteRules" | "manual" }
  | { code: "manualWith"; comment: string }
  | { code: "allMet"; count: number }
  | { code: "missing"; missing: number; total: number }
  | { code: "rule"; rule: Pick<RuleResult, "metric" | "op" | "threshold" | "actual" | "customLabel" | "naReason" | "unit"> & { noteCode?: NoteCode; noteCount?: number } };

export type Action = "promote" | "hold" | "demote" | "assign";

export interface Evaluation {
  trader: string;
  today: string;
  tierKey: string | null;
  tier: Tier | null;
  nextTier: Tier | null;
  prevTier: Tier | null;
  rules: RuleResult[];
  /** Metrics for every distinct window used by the rules (plus 20 trading days by default). */
  windows: WindowMetrics[];
  recommendation: {
    action: Action;
    toTier: Tier | null;
    reasons: string[];
    /** The reasons as data (store these; render with renderReason). */
    reasonItems: ReasonItem[];
    /** Set when demotion rules fire but there is no lower tier. */
    warning: boolean;
  };
  /** Promotion progress: passed / applicable promote rules (null when no promote rule applies). */
  progress: number | null;
  promotePassed: number;
  promoteTotal: number;
  /** Failing promote rules — "what is missing until the next tier". */
  missing: RuleResult[];
  /** Demotion rules that fired. */
  triggered: RuleResult[];
}

// ─── dates ──────────────────────────────────────────────────────────────────

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function parse(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function addDays(ymd: string, n: number): string {
  const d = parse(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}
export function isWeekend(ymd: string): boolean {
  const wd = parse(ymd).getUTCDay();
  return wd === 0 || wd === 6;
}
/** Monday of the ISO week containing ymd. */
export function mondayOf(ymd: string): string {
  const d = parse(ymd);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return fmt(d);
}
/** First date of a window of `n` trading days (weekdays) ending today (inclusive). Holidays are not considered. */
export function windowStart(today: string, n: number): string {
  let d = today;
  let count = isWeekend(d) ? 0 : 1;
  while (count < n) {
    d = addDays(d, -1);
    if (!isWeekend(d)) count++;
  }
  return d;
}

// ─── math ───────────────────────────────────────────────────────────────────

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Peak-to-trough drawdown (≥ 0) of a cumulative series built from values in chronological order. */
export function maxDrawdownAbs(values: number[]): number {
  let cum = 0, peak = 0, dd = 0;
  for (const v of values) {
    cum += v;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }
  return dd;
}

function sumBy(map: Map<string, number>, key: string, v: number) {
  map.set(key, (map.get(key) ?? 0) + v);
}

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// ─── metrics ────────────────────────────────────────────────────────────────

export function computeWindowMetrics(input: TraderInput, tier: Tier | null, windowDays: number, lang: Lang = "ru"): WindowMetrics {
  const tn = scalingT.tFor(lang);
  const today = input.today;
  const from = windowStart(today, windowDays);
  const all = input.trades.filter((t) => YMD.test(t.date) && t.date >= from && t.date <= today);
  const moneySource: "propreports" | "journal" = input.trades.some((t) => t.source === "propreports") ? "propreports" : "journal";
  const moneyRows = (moneySource === "propreports" ? all.filter((t) => t.source === "propreports") : all).filter((t) => t.net != null);
  const hasMoney = moneyRows.length > 0;

  const sorted = [...all].sort((a, b) => a.date.localeCompare(b.date));

  let wins = 0, losses = 0;
  let sumR = 0, rCount = 0, posR = 0, negR = 0;
  for (const t of sorted) {
    if (t.result === "win") wins++;
    else if (t.result === "loss") losses++;
    if (t.r != null) {
      sumR += t.r; rCount++;
      if (t.r > 0) posR += t.r; else if (t.r < 0) negR += t.r;
    }
  }
  let net = 0, posNet = 0, negNet = 0;
  const dayNet = new Map<string, number>();
  for (const t of moneyRows) {
    const n = t.net as number;
    net += n;
    if (n > 0) posNet += n; else if (n < 0) negNet += n;
    sumBy(dayNet, t.date, n);
  }
  // Daily series for streaks / drawdown: $ when available, else R.
  const dayVal = new Map<string, number>();
  if (hasMoney) for (const [d, v] of dayNet) dayVal.set(d, v);
  else for (const t of sorted) if (t.r != null) sumBy(dayVal, t.date, t.r);
  const days = [...dayVal.keys()].sort();
  const daySeries = days.map((d) => dayVal.get(d) as number);
  const basis: "usd" | "r" = hasMoney ? "usd" : "r";

  // Green weeks: consecutive weeks (by Monday) with positive total, walking back from the current week.
  const weekVal = new Map<string, number>();
  const weekTrades = new Map<string, number>();
  for (const d of days) sumBy(weekVal, mondayOf(d), dayVal.get(d) as number);
  for (const t of sorted) sumBy(weekTrades, mondayOf(t.date), 1);
  let greenWeeks = 0;
  {
    let wk = mondayOf(today);
    const cur = weekVal.get(wk);
    if (cur != null && cur > 0) greenWeeks++;
    // Current (partial) week never breaks the streak when it is not green.
    wk = addDays(wk, -7);
    while (wk >= mondayOf(from)) {
      const v = weekVal.get(wk);
      if (v != null && v > 0 && (weekTrades.get(wk) ?? 0) > 0) greenWeeks++;
      else break;
      wk = addDays(wk, -7);
    }
  }

  let redStreak = 0;
  for (let i = daySeries.length - 1; i >= 0; i--) {
    if (daySeries[i] < 0) redStreak++;
    else break;
  }
  const greenDays = daySeries.filter((v) => v > 0).length;

  const limits = input.limits;
  const dailyLimit = limits?.dailyLossLimit ?? tier?.dailyLossLimit ?? null;
  const weeklyLimit = limits?.weeklyLossLimit ?? tier?.weeklyLossLimit ?? null;
  const ddLimit = limits?.maxDrawdown ?? tier?.maxDrawdown ?? null;

  let breaches: number | null = null;
  let breachNote: NoteCode | undefined;
  if (hasMoney) {
    breaches = 0;
    if (dailyLimit != null && dailyLimit > 0) for (const v of dayNet.values()) if (-v > dailyLimit) breaches++;
    if (weeklyLimit != null && weeklyLimit > 0) {
      const wk = new Map<string, number>();
      for (const [d, v] of dayNet) sumBy(wk, mondayOf(d), v);
      for (const v of wk.values()) if (-v > weeklyLimit) breaches++;
    }
    if ((dailyLimit == null || dailyLimit <= 0) && (weeklyLimit == null || weeklyLimit <= 0)) breachNote = "noLimits";
  }

  const ddUsd = hasMoney ? maxDrawdownAbs(days.map((d) => dayNet.get(d) ?? 0)) : null;
  const ddPct = ddUsd != null && ddLimit != null && ddLimit > 0 ? (ddUsd / ddLimit) * 100 : null;

  const weekFrom = mondayOf(from);
  const ratingRows = input.ratings.filter((r) => YMD.test(r.week) && r.week >= weekFrom && r.week <= today);
  const discipline = avg(ratingRows.map((r) => r.discipline).filter((v): v is number => v != null && Number.isFinite(v)));
  const overall = avg(ratingRows.map((r) => r.overall).filter((v): v is number => v != null && Number.isFinite(v)));
  const violations = input.violationDates.filter((d) => YMD.test(d) && d >= from && d <= today).length;

  const pf = hasMoney
    ? (negNet < 0 ? posNet / Math.abs(negNet) : null)
    : (negR < 0 ? posR / Math.abs(negR) : null);
  const decided = wins + losses;

  const v = (key: MetricKey, value: number | null, extra: { basis?: "usd" | "r"; note?: NoteCode; noteCount?: number } = {}): MetricValue => {
    const { note, noteCount, ...rest } = extra;
    const out: MetricValue = { key, value: value == null || !Number.isFinite(value) ? null : r2(value), ...rest };
    if (note) {
      out.noteCode = note;
      out.note = note === "ratings" ? tn("note.ratings", { count: noteCount ?? 0 }) : tn(`note.${note}`);
      if (noteCount != null) out.noteCount = noteCount;
    }
    return out;
  };

  const values: Record<MetricKey, MetricValue> = {
    trades: v("trades", sorted.length),
    net_pnl: v("net_pnl", hasMoney ? net : null, { basis: "usd", note: hasMoney ? (moneySource === "propreports" ? "broker" : "journal") : "noMoney" }),
    net_r: v("net_r", rCount ? sumR : null, { basis: "r" }),
    profit_factor: v("profit_factor", pf, { basis, note: pf == null ? (sorted.length ? "noLosses" : "noTrades") : basis === "r" ? "byR" : "byUsd" }),
    win_rate: v("win_rate", decided ? (wins / decided) * 100 : null),
    expectancy_r: v("expectancy_r", rCount ? sumR / rCount : null, { basis: "r" }),
    green_weeks: v("green_weeks", days.length ? greenWeeks : null, { basis }),
    green_days_pct: v("green_days_pct", days.length ? (greenDays / days.length) * 100 : null, { basis }),
    max_dd_usd: v("max_dd_usd", ddUsd, { basis: "usd", note: hasMoney ? undefined : "noMoney" }),
    max_dd_pct: v("max_dd_pct", ddPct, { basis: "usd", note: ddUsd == null ? "noMoney" : ddLimit == null || ddLimit <= 0 ? "noDdLimit" : undefined }),
    limit_breaches: v("limit_breaches", breaches, { basis: "usd", note: breaches == null ? "noMoney" : breachNote }),
    red_streak: v("red_streak", days.length ? redStreak : null, { basis }),
    discipline: v("discipline", discipline, discipline == null ? { note: "noRatings" } : { note: "ratings", noteCount: ratingRows.length }),
    rating_overall: v("rating_overall", overall, { note: overall == null ? "noRatings" : undefined }),
    violations: v("violations", violations),
  };

  return { windowDays, from, to: today, moneySource, hasMoney, values };
}

// ─── rules ──────────────────────────────────────────────────────────────────

export function resolveThreshold(rule: Pick<Rule, "value" | "unit">, limits: LimitsInput | null, tier: Tier | null): number | null {
  if (rule.unit === "abs") return rule.value;
  if (rule.unit === "x_daily_limit") {
    const d = limits?.dailyLossLimit ?? tier?.dailyLossLimit ?? null;
    return d != null && d > 0 ? r2(rule.value * d) : null;
  }
  const a = limits?.accountSize ?? tier?.accountSize ?? null;
  return a != null && a > 0 ? r2((rule.value / 100) * a) : null;
}

export function compare(actual: number, op: Op, threshold: number): boolean {
  switch (op) {
    case ">=": return actual >= threshold;
    case ">": return actual > threshold;
    case "<=": return actual <= threshold;
    case "<": return actual < threshold;
    case "=": return Math.abs(actual - threshold) < 1e-9;
  }
}

/** 0..1 "how close to passing" (1 when it passes). */
export function progressOf(actual: number, op: Op, threshold: number): number {
  if (compare(actual, op, threshold)) return 1;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  if (op === ">=" || op === ">") {
    if (threshold <= 0) return actual >= threshold ? 1 : 0;
    return clamp(actual / threshold);
  }
  if (op === "<=" || op === "<") {
    if (actual <= 0) return 1;
    if (threshold <= 0) return 0;
    return clamp(threshold / actual);
  }
  return 0;
}

/** A metric value for people. Money / R / ratios keep the trading format in every language; counts use the locale grouping. */
export function formatMetric(key: MetricKey, value: number | null, lang: Lang = "ru"): string {
  if (value == null) return "—";
  const u = METRIC_BY_KEY[key].unit;
  switch (u) {
    case "usd": return `${value < 0 ? "−" : ""}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    case "r": return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}R`;
    case "pct": return `${value.toFixed(0)}%`;
    case "x": return `${value.toFixed(2)}×`;
    case "score": return `${value.toFixed(1)}/10`;
    default: return formatCountFor(lang, Math.round(value));
  }
}

/** Custom rule label, else the metric label in `lang`. */
export function ruleLabel(rule: Pick<Rule, "label" | "metric">, lang: Lang = "ru"): string {
  return rule.label?.trim() || scalingT.tryFor(lang, `metric.${rule.metric}.label`) || rule.metric;
}

/** Text of a rule result in `lang` (also used to re-render stored reasons). */
export function ruleText(
  r: Pick<RuleResult, "metric" | "op" | "threshold" | "actual" | "customLabel" | "naReason"> & { noteCode?: NoteCode; noteCount?: number },
  lang: Lang = "ru",
): string {
  const t = scalingT.tFor(lang);
  const label = ruleLabel({ label: r.customLabel, metric: r.metric }, lang);
  if (r.threshold == null) return t("rule.na", { label, why: t(r.naReason === "noAccount" ? "rule.noAccount" : "rule.noDailyLimit") });
  if (r.actual == null) {
    const note = r.noteCode ? (r.noteCode === "ratings" ? t("note.ratings", { count: r.noteCount ?? 0 }) : t(`note.${r.noteCode}`)) : t("note.noData");
    return t("rule.noValue", { label, note });
  }
  return t("rule.value", { label, actual: formatMetric(r.metric, r.actual, lang), op: r.op, threshold: formatMetric(r.metric, r.threshold, lang) });
}

function evaluateRule(rule: Rule, metrics: WindowMetrics, limits: LimitsInput | null, tier: Tier | null, lang: Lang): RuleResult {
  const mv = metrics.values[rule.metric];
  const actual = mv?.value ?? null;
  const threshold = resolveThreshold(rule, limits, tier);
  const label = ruleLabel(rule, lang);
  const customLabel = rule.label?.trim() || null;
  const base = { ruleId: rule.id, kind: rule.kind, metric: rule.metric, label, op: rule.op, threshold, rawValue: rule.value, unit: rule.unit, windowDays: rule.windowDays, actual, basis: mv?.basis, customLabel };
  const note = { noteCode: mv?.noteCode, noteCount: mv?.noteCount };
  if (threshold == null) {
    const naReason = rule.unit === "x_daily_limit" ? "noDailyLimit" as const : "noAccount" as const;
    return { ...base, status: "na", progress: 0, naReason, text: ruleText({ ...base, ...note, naReason }, lang) };
  }
  if (actual == null) {
    return { ...base, status: "na", progress: 0, text: ruleText({ ...base, ...note }, lang) };
  }
  const pass = compare(actual, rule.op, threshold);
  return { ...base, status: pass ? "pass" : "fail", progress: progressOf(actual, rule.op, threshold), text: ruleText({ ...base, ...note }, lang) };
}

/** A recommendation reason in `lang`. */
export function renderReason(item: ReasonItem, lang: Lang = "ru"): string {
  const t = scalingT.tFor(lang);
  switch (item.code) {
    case "tierMissing": return t("reason.tierMissing", { tier: item.tier });
    case "manualWith": return t("reason.manualWith", { comment: item.comment });
    case "allMet": return t("reason.allMet", { count: item.count });
    case "missing": return t("reason.missing", { missing: item.missing, total: item.total });
    case "rule": return ruleText(item.rule, lang);
    default: return t(`reason.${item.code}`);
  }
}

/** Stored reasons (legacy strings or ReasonItem objects) → texts in `lang`. */
export function renderStoredReasons(raw: unknown, lang: Lang = "ru"): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => (x && typeof x === "object" && typeof (x as { code?: unknown }).code === "string" ? renderReason(x as ReasonItem, lang) : String(x)));
}

const ruleItem = (r: RuleResult): ReasonItem => ({
  code: "rule",
  rule: { metric: r.metric, op: r.op, threshold: r.threshold, actual: r.actual, customLabel: r.customLabel, naReason: r.naReason, unit: r.unit },
});

// ─── evaluation ─────────────────────────────────────────────────────────────

export function sortTiers(tiers: Tier[]): Tier[] {
  return [...tiers].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

export function evaluateTrader(input: TraderInput, tiersIn: Tier[], rules: Rule[], lang: Lang = "ru"): Evaluation {
  const tiers = sortTiers(tiersIn);
  const idx = input.tierKey ? tiers.findIndex((t) => t.key === input.tierKey) : -1;
  const tier = idx >= 0 ? tiers[idx] : null;
  const nextTier = idx >= 0 ? tiers[idx + 1] ?? null : tiers[0] ?? null;
  const prevTier = idx > 0 ? tiers[idx - 1] : null;

  const applicable = rules.filter((r) => r.enabled && (r.tierKey == null || r.tierKey === input.tierKey));
  const windowsNeeded = new Set<number>([20, ...applicable.map((r) => Math.max(1, Math.round(r.windowDays)))]);
  const windows = [...windowsNeeded].sort((a, b) => a - b).map((n) => computeWindowMetrics(input, tier, n, lang));
  const byWindow = new Map(windows.map((w) => [w.windowDays, w]));

  const results = applicable
    .map((r) => evaluateRule(r, byWindow.get(Math.max(1, Math.round(r.windowDays)))!, input.limits, tier, lang))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "promote" ? -1 : 1));

  const promote = results.filter((r) => r.kind === "promote");
  const demote = results.filter((r) => r.kind === "demote");
  const promotePassed = promote.filter((r) => r.status === "pass").length;
  const missing = promote.filter((r) => r.status !== "pass");
  const triggered = demote.filter((r) => r.status === "pass");

  let action: Action = "hold";
  let toTier: Tier | null = null;
  const reasonItems: ReasonItem[] = [];
  let warning = false;

  if (!tier) {
    action = "assign";
    toTier = tiers[0] ?? null;
    reasonItems.push(input.tierKey ? { code: "tierMissing", tier: input.tierKey } : { code: "noTier" });
  } else if (triggered.length) {
    if (prevTier) {
      action = "demote";
      toTier = prevTier;
    } else {
      action = "hold";
      warning = true;
      reasonItems.push({ code: "noLowerTier" });
    }
    for (const r of triggered) reasonItems.push(ruleItem(r));
  } else if (promote.length && missing.length === 0) {
    if (nextTier) {
      action = "promote";
      toTier = nextTier;
      reasonItems.push({ code: "allMet", count: promote.length });
    } else {
      reasonItems.push({ code: "topTier" });
    }
  } else if (!promote.length) {
    reasonItems.push({ code: "noPromoteRules" });
  } else {
    reasonItems.push({ code: "missing", missing: missing.length, total: promote.length });
  }
  const reasons = reasonItems.map((it) => renderReason(it, lang));

  return {
    trader: input.trader,
    today: input.today,
    tierKey: input.tierKey,
    tier,
    nextTier,
    prevTier,
    rules: results,
    windows,
    recommendation: { action, toTier, reasons, reasonItems, warning },
    progress: promote.length ? promotePassed / promote.length : null,
    promotePassed,
    promoteTotal: promote.length,
    missing,
    triggered,
  };
}

// ─── defaults (seeded on first run, curator-editable afterwards) ────────────

// Seed data (written to the DB once, curator-editable afterwards): tier names, descriptions and rule labels are
// stored user content, not UI text.
export const DEFAULT_TIERS: Tier[] = [
  { key: "trainee", name: "Стажёр", order: 1, accountSize: 10_000, dailyLossLimit: 150, weeklyLossLimit: 400, maxDrawdown: 800, maxRiskPerTrade: 50, maxPositionUsd: 10_000, maxOvernightExposure: 0, maxOpenPositions: 2, allowOvernight: false, allowSwing: false, description: "Симулятор / минимальный размер" }, // i18n-ignore (seed data)
  { key: "junior", name: "Джун", order: 2, accountSize: 25_000, dailyLossLimit: 300, weeklyLossLimit: 900, maxDrawdown: 2_000, maxRiskPerTrade: 100, maxPositionUsd: 25_000, maxOvernightExposure: 5_000, maxOpenPositions: 3, allowOvernight: false, allowSwing: false, description: "Интрадей, малый лот" }, // i18n-ignore (seed data)
  { key: "trader", name: "Трейдер", order: 3, accountSize: 50_000, dailyLossLimit: 600, weeklyLossLimit: 1_800, maxDrawdown: 4_000, maxRiskPerTrade: 200, maxPositionUsd: 50_000, maxOvernightExposure: 20_000, maxOpenPositions: 5, allowOvernight: true, allowSwing: false, description: "Интрадей + овернайт" }, // i18n-ignore (seed data)
  { key: "senior", name: "Сеньор", order: 4, accountSize: 100_000, dailyLossLimit: 1_200, weeklyLossLimit: 3_500, maxDrawdown: 8_000, maxRiskPerTrade: 400, maxPositionUsd: 100_000, maxOvernightExposure: 50_000, maxOpenPositions: 8, allowOvernight: true, allowSwing: true, description: "Полный BP, свинг" }, // i18n-ignore (seed data)
  { key: "lead", name: "Лид", order: 5, accountSize: 250_000, dailyLossLimit: 2_500, weeklyLossLimit: 7_000, maxDrawdown: 15_000, maxRiskPerTrade: 800, maxPositionUsd: 250_000, maxOvernightExposure: 120_000, maxOpenPositions: 12, allowOvernight: true, allowSwing: true, description: "Максимальный BP, менторство" }, // i18n-ignore (seed data)
];

export const DEFAULT_RULES: Omit<Rule, "id">[] = [
  { kind: "promote", metric: "trades", op: ">=", value: 40, unit: "abs", windowDays: 20, tierKey: null, label: "Минимум сделок за 20 дней", enabled: true }, // i18n-ignore (seed data)
  { kind: "promote", metric: "green_weeks", op: ">=", value: 3, unit: "abs", windowDays: 20, tierKey: null, label: "Зелёных недель подряд", enabled: true }, // i18n-ignore (seed data)
  { kind: "promote", metric: "net_pnl", op: ">=", value: 5, unit: "x_daily_limit", windowDays: 20, tierKey: null, label: "P&L нетто ≥ 5 дневных лимитов", enabled: true }, // i18n-ignore (seed data)
  { kind: "promote", metric: "profit_factor", op: ">=", value: 1.3, unit: "abs", windowDays: 20, tierKey: null, label: "Profit factor", enabled: true }, // i18n-ignore (seed data)
  { kind: "promote", metric: "max_dd_pct", op: "<", value: 50, unit: "abs", windowDays: 20, tierKey: null, label: "Просадка меньше половины лимита", enabled: true }, // i18n-ignore (seed data)
  { kind: "promote", metric: "limit_breaches", op: "=", value: 0, unit: "abs", windowDays: 20, tierKey: null, label: "Без нарушений лимитов", enabled: true }, // i18n-ignore (seed data)
  { kind: "promote", metric: "discipline", op: ">=", value: 7, unit: "abs", windowDays: 20, tierKey: null, label: "Оценка дисциплины", enabled: true }, // i18n-ignore (seed data)
  { kind: "demote", metric: "limit_breaches", op: ">=", value: 3, unit: "abs", windowDays: 20, tierKey: null, label: "Три и более нарушений лимитов", enabled: true }, // i18n-ignore (seed data)
  { kind: "demote", metric: "max_dd_pct", op: ">=", value: 100, unit: "abs", windowDays: 20, tierKey: null, label: "Просадка достигла лимита", enabled: true }, // i18n-ignore (seed data)
  { kind: "demote", metric: "net_pnl", op: "<=", value: -3, unit: "x_daily_limit", windowDays: 20, tierKey: null, label: "Убыток ≥ 3 дневных лимитов", enabled: true }, // i18n-ignore (seed data)
  { kind: "demote", metric: "discipline", op: "<", value: 4, unit: "abs", windowDays: 20, tierKey: null, label: "Дисциплина ниже 4", enabled: true }, // i18n-ignore (seed data)
  { kind: "demote", metric: "red_streak", op: ">=", value: 5, unit: "abs", windowDays: 20, tierKey: null, label: "Пять красных дней подряд", enabled: true }, // i18n-ignore (seed data)
];
