/**
 * Evaluation challenges («Экзамены») — prop-style tests evaluated live from closed trades. Pure, no I/O.
 *
 * Rules (any may be null = not used):
 *   profit target        — cumulative net ≥ target (required to pass);
 *   daily loss limit     — intraday running loss of a day reaching the limit ⇒ FAIL at that trade;
 *   max drawdown         — balance touching the floor ⇒ FAIL. static: floor = start − DD;
 *                          trailing: floor = high-water mark − DD (by closed trade), trailing_eod: HWM of end-of-day balances;
 *                          with `trailingStopsAtStart` the trailing floor never rises above the starting balance;
 *   consistency          — best day ≤ X % of total profit (required to pass, never fails by itself);
 *   min trading days     — required to pass;
 *   max position         — qty and/or $ notional per trade (hard rule ⇒ FAIL);
 *   trading window       — entries only inside [start, end) NY minutes, END-EXCLUSIVE ({240, 960} = 04:00–15:59 entries).
 *                          strict ⇒ FAIL; non-strict ⇒ counted violation, the exam goes on. Trades without a time are skipped and counted.
 *                          Rules stored before rulesVersion 2 meant an inclusive end minute; normalizeRules converts them (end + 1),
 *                          so challenges created earlier evaluate exactly as before.
 * The challenge passes on the first day when target + min days + consistency hold with no hard violation.
 * Statuses: scheduled (not started) · active · passed · failed (rule, day, time) · expired (end reached without pass).
 * Money = net of fees (lib/tradeMath), dates = NY trading dates.
 */
import { DEFAULT_TIERS, addDays, isWeekend, type Tier } from "./scalingEngine";
import { academyPathT, ruPath } from "./academyI18n";
import { DEFAULT_LANG, isLang, type Lang, type Params } from "../i18n";

export type DrawdownMode = "static" | "trailing" | "trailing_eod";

export interface ChallengeRules {
  accountSize: number;
  profitTarget: number | null;
  dailyLossLimit: number | null;
  maxDrawdown: number | null;
  drawdownMode: DrawdownMode;
  trailingStopsAtStart: boolean;
  consistencyPct: number | null;
  minTradingDays: number | null;
  maxPositionQty: number | null;
  maxPositionUsd: number | null;
  /** NY minutes from midnight, end-exclusive: {start: 240, end: 960} allows entries 04:00:00–15:59:59. */
  tradingWindow: { start: number; end: number } | null;
  /** true: an entry outside the window fails the exam; false: it is counted and flagged as a violation. */
  tradingWindowStrict: boolean;
  /** Schema version of the stored rules (see RULES_VERSION). normalizeRules always outputs the current one. */
  rulesVersion: number;
}

/** 2 = trading-window end is exclusive. Rules without a version (legacy) had an inclusive end minute. */
export const RULES_VERSION = 2;

export type StageKey = "trainee" | "junior" | "trader" | "senior";

export interface ChallengeTemplate {
  key: string;
  name: string;
  /** Generated from `rules` + `durationTradingDays` (describeTemplate) — never hand-typed, so text and numbers cannot disagree. */
  description: string;
  /** Stage this exam is meant for (promotion from it). */
  forStage: StageKey | null;
  /** Capital exams: the stage the trader is promoted to on a pass (null for trainee tests). */
  toStage: StageKey | null;
  /** Scaling tier the numbers are built from (the TARGET tier for capital exams). */
  scalingTier: string | null;
  durationTradingDays: number;
  rules: ChallengeRules;
}

// ─── templates ──────────────────────────────────────────────────────────────

const stageName = (k: StageKey, lang: Lang) => academyPathT.tFor(lang)(`stages.${k}.name`);

/** Capital-exam policy: every number is derived from the target scaling tier (DEFAULT_TIERS). */
export const CAPITAL_EXAM_POLICY = {
  /** Profit target, % of the target tier's account. */
  profitTargetPct: 6,
  /** Trailing drawdown = this share of the target tier's max drawdown (trailing stops at the starting balance). */
  drawdownShare: 0.75,
  durationTradingDays: 20,
  /** Entries 04:00–16:00 NY, end-exclusive (premarket allowed); outside = counted violation, not a fail. */
  tradingWindow: { start: 240, end: 960 },
  tradingWindowStrict: false,
} as const;

/** Trainee tests: strict 09:30–15:55 NY (end-exclusive 956 ⇒ the last allowed entry minute is 15:55). */
export const TRAINEE_WINDOW = { start: 570, end: 956 } as const;

type ExamTier = { key: string; accountSize: number; dailyLossLimit: number; maxDrawdown: number; maxPositionUsd: number };
/** The scaling tier's limits an exam is built from; a missing tier/limit is a programming error (fails at module load and in tests). */
function tierOf(key: string): ExamTier {
  const t: Tier | undefined = DEFAULT_TIERS.find((x) => x.key === key);
  if (!t || t.accountSize == null || t.dailyLossLimit == null || t.maxDrawdown == null || t.maxPositionUsd == null)
    throw new Error(`challengeEngine: scaling tier "${key}" is missing or lacks account/daily/DD/position limits`);
  return { key: t.key, accountSize: t.accountSize, dailyLossLimit: t.dailyLossLimit, maxDrawdown: t.maxDrawdown, maxPositionUsd: t.maxPositionUsd };
}

/** "HH:MM–HH:MM" of an end-exclusive window, shown inclusively: {240, 960} → "04:00–15:59". */
export function formatWindow(w: { start: number; end: number }): string {
  return `${hhmm(w.start)}–${hhmm(Math.max(w.start, w.end - 1))}`;
}

/** Human description of a rules set — the single source of every template description (text in `lang`). */
export function describeRules(r: ChallengeRules, durationTradingDays: number, lang: Lang = DEFAULT_LANG): string {
  const t = academyPathT.tFor(lang);
  const usd = usdFor(lang);
  const kind = t(r.drawdownMode === "static" ? "challenge.ddKind.static" : r.drawdownMode === "trailing_eod" ? "challenge.ddKind.trailing_eod" : "challenge.ddKind.trailing");
  const parts = [
    t("challenge.describe.account", { usd: usd(r.accountSize) }),
    r.profitTarget != null ? t("challenge.describe.target", { usd: usd(r.profitTarget), n: durationTradingDays }) : t("challenge.describe.noTarget", { n: durationTradingDays }),
    r.dailyLossLimit != null ? t("challenge.describe.daily", { usd: usd(r.dailyLossLimit) }) : null,
    r.maxDrawdown != null
      ? t(r.drawdownMode !== "static" && r.trailingStopsAtStart ? "challenge.describe.ddLocked" : "challenge.describe.dd", { kind, usd: usd(r.maxDrawdown) })
      : null,
    r.consistencyPct != null ? t("challenge.describe.bestDay", { pct: r.consistencyPct }) : null,
    r.minTradingDays != null ? t("challenge.describe.minDays", { count: r.minTradingDays }) : null,
    r.maxPositionUsd != null ? t("challenge.describe.positionUsd", { usd: usd(r.maxPositionUsd) }) : null,
    r.maxPositionQty != null ? t("challenge.describe.positionQty", { n: r.maxPositionQty }) : null,
    r.tradingWindow ? t(r.tradingWindowStrict ? "challenge.describe.windowStrict" : "challenge.describe.windowSoft", { window: formatWindow(r.tradingWindow) }) : null,
  ];
  return parts.filter(Boolean).join(", ");
}

export function describeTemplate(lead: string, rules: ChallengeRules, durationTradingDays: number, lang: Lang = DEFAULT_LANG): string {
  return academyPathT.tFor(lang)("challenge.describe.template", { lead, rules: describeRules(rules, durationTradingDays, lang) });
}

type TemplateSpec = Omit<ChallengeTemplate, "description"> & { lead: string };
function template({ lead, ...t }: TemplateSpec): ChallengeTemplate {
  return { ...t, description: describeTemplate(lead, t.rules, t.durationTradingDays) };
}

/** Names / leads of the built-in templates in `lang` (capital exams are built from their stages). */
function templateTexts(key: string, lang: Lang): { name: string; lead: string } | null {
  const t = academyPathT.tFor(lang);
  if (key === "trainee_test_10d" || key === "sim_exam_20d") return { name: t(`challenge.templates.${key}.name`), lead: t(`challenge.templates.${key}.lead`) };
  const cap = CAPITAL_KEYS[key];
  if (!cap) return null;
  const from = stageName(cap.from, lang), to = stageName(cap.to, lang);
  return { name: t("challenge.templates.capitalName", { from, to, k: Math.round(tierOf(cap.to).accountSize / 1000) }), lead: t("challenge.templates.capitalLead", { from, to }) };
}
const CAPITAL_KEYS: Record<string, { from: StageKey; to: Exclude<StageKey, "trainee"> }> = {
  trainee_to_junior: { from: "trainee", to: "junior" },
  junior_to_trader: { from: "junior", to: "trader" },
  trader_to_senior: { from: "trader", to: "senior" },
};

/**
 * A capital exam «fromStage → targetTier»: account, daily limit and hard position limit = the target tier's;
 * trailing DD = 75% of the target tier's DD (stops at start); target = 6% of the account; window 04:00–16:00 NY (soft).
 */
export function capitalExam(
  fromStage: StageKey,
  targetTierKey: Exclude<StageKey, "trainee">,
  overrides: { key: string; consistencyPct: number; minTradingDays: number; name?: string; durationTradingDays?: number },
): ChallengeTemplate {
  const tier = tierOf(targetTierKey);
  const P = CAPITAL_EXAM_POLICY;
  const rules: ChallengeRules = {
    accountSize: tier.accountSize,
    profitTarget: Math.round((tier.accountSize * P.profitTargetPct) / 100),
    dailyLossLimit: tier.dailyLossLimit,
    maxDrawdown: Math.round(tier.maxDrawdown * P.drawdownShare),
    drawdownMode: "trailing",
    trailingStopsAtStart: true,
    consistencyPct: overrides.consistencyPct,
    minTradingDays: overrides.minTradingDays,
    maxPositionQty: null,
    maxPositionUsd: tier.maxPositionUsd,
    tradingWindow: { ...P.tradingWindow },
    tradingWindowStrict: P.tradingWindowStrict,
    rulesVersion: RULES_VERSION,
  };
  const t = academyPathT.tFor(DEFAULT_LANG);
  const from = stageName(fromStage, DEFAULT_LANG), to = stageName(targetTierKey, DEFAULT_LANG);
  return template({
    key: overrides.key,
    name: overrides.name ?? t("challenge.templates.capitalName", { from, to, k: Math.round(tier.accountSize / 1000) }),
    lead: t("challenge.templates.capitalLead", { from, to }),
    forStage: fromStage, toStage: targetTierKey, scalingTier: tier.key,
    durationTradingDays: overrides.durationTradingDays ?? P.durationTradingDays,
    rules,
  });
}

function traineeRules(r: Pick<ChallengeRules, "profitTarget" | "maxDrawdown" | "drawdownMode" | "trailingStopsAtStart" | "consistencyPct" | "minTradingDays">): ChallengeRules {
  const tier = tierOf("trainee");
  return {
    accountSize: tier.accountSize, dailyLossLimit: tier.dailyLossLimit, maxPositionUsd: tier.maxPositionUsd, maxPositionQty: null,
    tradingWindow: { ...TRAINEE_WINDOW }, tradingWindowStrict: true, rulesVersion: RULES_VERSION, ...r,
  };
}

export const TEMPLATES: readonly ChallengeTemplate[] = [
  template({
    key: "trainee_test_10d",
    name: ruPath.challenge.templates.trainee_test_10d.name,
    lead: ruPath.challenge.templates.trainee_test_10d.lead,
    forStage: "trainee", toStage: null, scalingTier: "trainee", durationTradingDays: 10,
    rules: traineeRules({ profitTarget: 300, maxDrawdown: 500, drawdownMode: "trailing", trailingStopsAtStart: true, consistencyPct: 50, minTradingDays: 5 }),
  }),
  capitalExam("trainee", "junior", { key: "trainee_to_junior", consistencyPct: 40, minTradingDays: 10 }),
  capitalExam("junior", "trader", { key: "junior_to_trader", consistencyPct: 35, minTradingDays: 15 }),
  capitalExam("trader", "senior", { key: "trader_to_senior", consistencyPct: 30, minTradingDays: 15 }),
  template({
    key: "sim_exam_20d",
    name: ruPath.challenge.templates.sim_exam_20d.name,
    lead: ruPath.challenge.templates.sim_exam_20d.lead,
    forStage: "trainee", toStage: null, scalingTier: "trainee", durationTradingDays: 20,
    rules: traineeRules({ profitTarget: 500, maxDrawdown: 800, drawdownMode: "static", trailingStopsAtStart: false, consistencyPct: 40, minTradingDays: 15 }),
  }),
];

export const TEMPLATE_BY_KEY: Record<string, ChallengeTemplate> = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));

const templatesCache = new Map<Lang, ChallengeTemplate[]>();
/** Built-in templates with name / description in `lang` (keys, rules and numbers are identical). */
export function templatesFor(lang: Lang | null | undefined = DEFAULT_LANG): ChallengeTemplate[] {
  const l: Lang = isLang(lang) ? lang : DEFAULT_LANG;
  if (l === DEFAULT_LANG) return TEMPLATES as ChallengeTemplate[];
  let out = templatesCache.get(l);
  if (!out) {
    out = TEMPLATES.map((tpl) => {
      const tx = templateTexts(tpl.key, l);
      return tx ? { ...tpl, name: tx.name, description: describeTemplate(tx.lead, tpl.rules, tpl.durationTradingDays, l) } : tpl;
    });
    templatesCache.set(l, out);
  }
  return out;
}

/** Display name of a stored challenge: the built-in template's Russian name → `lang`; a custom name stays. */
export function challengeNameFor(templateKey: string | null | undefined, stored: string, lang: Lang | null | undefined): string {
  const tpl = templateKey ? TEMPLATE_BY_KEY[templateKey] : undefined;
  if (!tpl || stored !== tpl.name) return stored;
  return templatesFor(lang).find((x) => x.key === tpl.key)?.name ?? stored;
}

export interface ChallengeTrade {
  id: number;
  ticker?: string;
  /** NY close date YYYY-MM-DD. */
  date: string;
  net: number | null;
  qty: number | null;
  /** Entry price (for $ notional). */
  entry: number | null;
  /** NY minutes of entry / exit (null when unknown). */
  entryMin: number | null;
  exitMin: number | null;
}

export type RuleKey = "profit_target" | "daily_loss" | "max_drawdown" | "consistency" | "min_days" | "max_position" | "trading_window";

export const RULE_LABELS: Record<RuleKey, string> = ruPath.challenge.rules;
const ruleLabel = (k: RuleKey, lang: Lang) => academyPathT.tFor(lang)(`challenge.rules.${k}`);

export type EventKind = "daily_loss" | "max_dd" | "size" | "window" | "target" | "passed" | "warn_daily" | "warn_dd" | "warn_window";

export interface TimelineEvent {
  kind: EventKind;
  label: string;
  /** HH:MM NY when known. */
  time: string | null;
  tradeId: number | null;
}

export interface TimelineDay {
  date: string;
  trades: number;
  net: number;
  cum: number;
  balance: number;
  /** High-water mark after the day. */
  peak: number;
  /** Drawdown floor after the day (null when no DD rule). */
  floor: number | null;
  /** Lowest intraday running P&L of the day (≤ 0). */
  dayLow: number;
  /** Share of the daily limit used at the day's low, 0..1+ (null without a limit). */
  dailyUsed: number | null;
  /** Room to the floor after the day, $ (null without a DD rule). */
  ddRoom: number | null;
  events: TimelineEvent[];
}

export type RuleState = "ok" | "warn" | "breached" | "met" | "pending" | "na";

export interface RuleProgress {
  key: RuleKey;
  label: string;
  kind: "target" | "limit" | "requirement";
  value: number | null;
  target: number | null;
  /** 0..1 — progress towards a target / share of a limit used. */
  pct: number | null;
  state: RuleState;
  display: string;
  detail: string;
}

export type ChallengeStatus = "scheduled" | "active" | "passed" | "failed" | "expired";

export const STATUS_LABELS: Record<ChallengeStatus, string> = ruPath.challenge.status;
/** Status labels in `lang`. */
export function statusLabelsFor(lang: Lang | null | undefined): Record<ChallengeStatus, string> {
  const t = academyPathT.tFor(lang);
  return { scheduled: t("challenge.status.scheduled"), active: t("challenge.status.active"), passed: t("challenge.status.passed"), failed: t("challenge.status.failed"), expired: t("challenge.status.expired") };
}

/** A text as data: key under `academyPath.challenge.*` + language-neutral params (money is preformatted). */
export type ChallengeMsg = { key: string; params?: Record<string, string | number> };
/**
 * The status reason as data (rendered per reader: stored in notification params, see renderChallengeReason).
 * `rule` → `{label}`, `detail` → `{detail}`, `list` → joined into `{miss}` / `{left}`.
 */
export type ReasonData = { key: string; params: Record<string, string | number>; rule?: RuleKey; detail?: ChallengeMsg; list?: ChallengeMsg[]; listSep?: string };

function renderMsg(m: ChallengeMsg, lang: Lang): string {
  const p: Params = { ...(m.params ?? {}) };
  if (p.ticker === "") p.ticker = academyPathT.tFor(lang)("challenge.trade");
  return academyPathT.tryFor(lang, `challenge.${m.key}`, p) ?? m.key;
}

/** Render a stored ReasonData in `lang`. */
export function renderChallengeReason(d: ReasonData, lang: Lang | null | undefined): string {
  const l: Lang = isLang(lang) ? lang : DEFAULT_LANG;
  const p: Params = { ...d.params };
  if (d.rule) p.label = ruleLabel(d.rule, l);
  if (d.detail) p.detail = renderMsg(d.detail, l);
  if (d.list) {
    const joined = d.list.map((m) => renderMsg(m, l)).join(d.listSep ?? "; ");
    if (d.key === "reason.expired") p.miss = joined || renderMsg({ key: "reason.expiredNone" }, l);
    else p.left = joined;
  }
  return academyPathT.tryFor(l, `challenge.${d.key}`, p) ?? d.key;
}

export interface ChallengeFailure {
  rule: RuleKey;
  label: string;
  date: string;
  time: string | null;
  tradeId: number | null;
  detail: string;
}

export interface ChallengeResult {
  status: ChallengeStatus;
  statusLabel: string;
  reason: string;
  /** `reason` as data (for texts stored or sent later in the recipient's language). */
  reasonData: ReasonData;
  failure: ChallengeFailure | null;
  passedOn: string | null;
  startsOn: string;
  endsOn: string;
  evaluatedThrough: string | null;
  tradingDaysTotal: number;
  tradingDaysElapsed: number;
  tradingDaysLeft: number;
  progress: RuleProgress[];
  timeline: TimelineDay[];
  stats: {
    net: number;
    balance: number;
    trades: number;
    tradingDays: number;
    bestDay: number | null;
    worstDay: number | null;
    consistencyPct: number | null;
    maxDdUsed: number;
    worstDayLow: number;
    tradesWithoutPnl: number;
    tradesWithoutTime: number;
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (x: number) => Math.round(x * 100) / 100;
// Function declaration (hoisted): TEMPLATES above call it while the module initialises.
/** Money for exam texts: grouping of the reader's language for RU (historical "$25 000"), "$25,000" otherwise. */
function usdFor(lang: Lang): (x: number) => string {
  const tag = lang === "ru" ? "ru-RU" : "en-US";
  return (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString(tag, { maximumFractionDigits: 0 })}`;
}
function usd(x: number): string {
  return usdFor(DEFAULT_LANG)(x);
}

export function hhmm(min: number | null): string | null {
  if (min == null || !Number.isFinite(min)) return null;
  const m = Math.max(0, Math.round(min));
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Weekdays in [from, to]. */
export function weekdaysBetween(from: string, to: string): number {
  if (!YMD.test(from) || !YMD.test(to) || from > to) return 0;
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isWeekend(d)) n++;
  return n;
}

/** Last date of a challenge lasting `tradingDays` weekdays starting at `start` (a weekend start rolls forward). */
export function endDateFor(start: string, tradingDays: number): string {
  let d = start;
  while (isWeekend(d)) d = addDays(d, 1);
  let n = 1;
  while (n < Math.max(1, tradingDays)) {
    d = addDays(d, 1);
    if (!isWeekend(d)) n++;
  }
  return d;
}

function sortKey(t: ChallengeTrade): number {
  return t.exitMin ?? t.entryMin ?? Number.MAX_SAFE_INTEGER;
}

/** Floor of the drawdown rule for a given high-water mark. */
export function ddFloor(rules: ChallengeRules, peak: number): number | null {
  if (rules.maxDrawdown == null || rules.maxDrawdown <= 0) return null;
  if (rules.drawdownMode === "static") return rules.accountSize - rules.maxDrawdown;
  const f = peak - rules.maxDrawdown;
  return rules.trailingStopsAtStart ? Math.min(f, rules.accountSize) : f;
}

// ─── evaluation ─────────────────────────────────────────────────────────────

export function evaluateChallenge(def: { startsOn: string; endsOn: string; rules: ChallengeRules }, tradesIn: ChallengeTrade[], today: string, lang: Lang = DEFAULT_LANG): ChallengeResult {
  const { startsOn, endsOn, rules } = def;
  const tt = academyPathT.tFor(lang);
  const usd = usdFor(lang);
  const txt = (key: string, params?: Record<string, string | number>) => renderMsg({ key, params }, lang);
  let failureDetail: ChallengeMsg | null = null;
  const evalEnd = today < endsOn ? today : endsOn;
  const trades = tradesIn
    .filter((t) => YMD.test(t.date) && t.date >= startsOn && t.date <= evalEnd)
    .sort((a, b) => a.date.localeCompare(b.date) || sortKey(a) - sortKey(b) || a.id - b.id);
  const byDay = new Map<string, ChallengeTrade[]>();
  for (const t of trades) (byDay.get(t.date) ?? byDay.set(t.date, []).get(t.date)!).push(t);

  // Calendar of the evaluated period: every weekday + any day that has trades.
  const days: string[] = [];
  if (startsOn <= evalEnd) for (let d = startsOn; d <= evalEnd; d = addDays(d, 1)) if (!isWeekend(d) || byDay.has(d)) days.push(d);

  let balance = rules.accountSize;
  let peak = rules.accountSize;
  let floor = ddFloor(rules, peak);
  let cum = 0;
  let maxDdUsed = 0;
  let worstDayLow = 0;
  let maxQty = 0, maxNotional = 0;
  let outOfWindow = 0;
  let withoutPnl = 0, withoutTime = 0;
  let tradingDays = 0;
  let failure: ChallengeFailure | null = null;
  let passedOn: string | null = null;
  const dayNets: number[] = [];
  const timeline: TimelineDay[] = [];
  const minDays = rules.minTradingDays ?? 0;
  const dl = rules.dailyLossLimit != null && rules.dailyLossLimit > 0 ? rules.dailyLossLimit : null;

  const consistencyNow = (): number | null => {
    const total = dayNets.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return null;
    return (Math.max(0, ...dayNets) / total) * 100;
  };
  const fail = (rule: RuleKey, date: string, t: ChallengeTrade | null, detailMsg: ChallengeMsg, ev: TimelineEvent[], kind: EventKind) => {
    const time = t ? hhmm(t.exitMin ?? t.entryMin) : null;
    const detail = renderMsg(detailMsg, lang);
    failureDetail = detailMsg;
    failure = { rule, label: ruleLabel(rule, lang), date, time, tradeId: t?.id ?? null, detail };
    ev.push({ kind, label: tt("challenge.events.rule", { label: ruleLabel(rule, lang), detail }), time, tradeId: t?.id ?? null });
  };

  for (const date of days) {
    if (failure || passedOn) break;
    const list = byDay.get(date) ?? [];
    const events: TimelineEvent[] = [];
    let dayPnl = 0, dayLow = 0, counted = 0;
    let warnedDaily = false, warnedDd = false;
    for (const t of list) {
      // Hard rules that do not need money.
      const notional = t.qty != null && t.entry != null ? Math.abs(t.qty * t.entry) : null;
      if (t.qty != null) maxQty = Math.max(maxQty, Math.abs(t.qty));
      if (notional != null) maxNotional = Math.max(maxNotional, notional);
      if (rules.maxPositionQty != null && t.qty != null && Math.abs(t.qty) > rules.maxPositionQty) {
        fail("max_position", date, t, { key: "failure.qty", params: { ticker: t.ticker ?? "", qty: Math.abs(t.qty), max: rules.maxPositionQty } }, events, "size");
        break;
      }
      if (rules.maxPositionUsd != null && notional != null && notional > rules.maxPositionUsd) {
        fail("max_position", date, t, { key: "failure.usd", params: { ticker: t.ticker ?? "", usd: usd(notional), max: usd(rules.maxPositionUsd) } }, events, "size");
        break;
      }
      if (rules.tradingWindow) {
        if (t.entryMin == null) withoutTime++;
        else if (Math.floor(t.entryMin) < rules.tradingWindow.start || Math.floor(t.entryMin) >= rules.tradingWindow.end) {
          outOfWindow++;
          const msg: ChallengeMsg = { key: "failure.window", params: { ticker: t.ticker ?? "", time: hhmm(Math.floor(t.entryMin)) ?? "", window: formatWindow(rules.tradingWindow) } };
          if (rules.tradingWindowStrict) {
            fail("trading_window", date, { ...t, entryMin: Math.floor(t.entryMin), exitMin: null }, msg, events, "window");
            break;
          }
          events.push({ kind: "warn_window", label: tt("challenge.events.windowWarn", { msg: renderMsg(msg, lang) }), time: hhmm(Math.floor(t.entryMin)), tradeId: t.id });
        }
      }
      if (t.net == null) { withoutPnl++; continue; }
      counted++;
      dayPnl += t.net;
      cum += t.net;
      balance += t.net;
      if (dayPnl < dayLow) dayLow = dayPnl;
      if (dl != null) {
        if (-dayPnl >= dl) {
          fail("daily_loss", date, t, { key: "failure.dailyLoss", params: { loss: usd(dayPnl), limit: usd(-dl) } }, events, "daily_loss");
          break;
        }
        if (!warnedDaily && -dayPnl >= 0.8 * dl) {
          warnedDaily = true;
          events.push({ kind: "warn_daily", label: txt("events.dailyWarn", { pct: Math.round((-dayPnl / dl) * 100) }), time: hhmm(t.exitMin ?? t.entryMin), tradeId: t.id });
        }
      }
      if (floor != null) {
        if (balance <= floor) {
          fail("max_drawdown", date, t, { key: "failure.dd", params: { balance: usd(balance), floor: usd(floor) } }, events, "max_dd");
          break;
        }
        if (!warnedDd && rules.maxDrawdown && balance - floor <= 0.2 * rules.maxDrawdown) {
          warnedDd = true;
          events.push({ kind: "warn_dd", label: txt("events.ddWarn", { usd: usd(balance - floor) }), time: hhmm(t.exitMin ?? t.entryMin), tradeId: t.id });
        }
      }
      if (rules.drawdownMode === "trailing" && balance > peak) { peak = balance; floor = ddFloor(rules, peak); }
      maxDdUsed = Math.max(maxDdUsed, (rules.drawdownMode === "static" ? rules.accountSize : peak) - balance);
    }
    if (rules.drawdownMode === "trailing_eod" && !failure && balance > peak) { peak = balance; floor = ddFloor(rules, peak); }
    if (rules.drawdownMode !== "trailing") maxDdUsed = Math.max(maxDdUsed, (rules.drawdownMode === "static" ? rules.accountSize : peak) - balance);
    if (counted > 0 || list.length > 0) { tradingDays++; dayNets.push(dayPnl); }
    worstDayLow = Math.min(worstDayLow, dayLow);

    if (!failure) {
      const targetMet = rules.profitTarget == null || cum >= rules.profitTarget;
      const cons = consistencyNow();
      const consOk = rules.consistencyPct == null || (cons != null && cons <= rules.consistencyPct);
      if (rules.profitTarget != null && targetMet && !timeline.some((d) => d.events.some((e) => e.kind === "target")))
        events.push({ kind: "target", label: txt("events.target", { target: usd(rules.profitTarget), total: usd(cum) }), time: null, tradeId: null });
      if (targetMet && tradingDays >= minDays && consOk && (rules.profitTarget != null || (date === evalEnd && evalEnd === endsOn))) {
        passedOn = date;
        events.push({ kind: "passed", label: txt("events.passed"), time: null, tradeId: null });
      }
    }
    timeline.push({
      date, trades: list.length, net: r2(dayPnl), cum: r2(cum), balance: r2(balance), peak: r2(peak), floor: floor == null ? null : r2(floor),
      dayLow: r2(dayLow), dailyUsed: dl != null ? r2(-dayLow / dl) : null, ddRoom: floor == null ? null : r2(balance - floor), events,
    });
  }

  // ── status ──
  const cons = consistencyNow();
  const tradingDaysTotal = weekdaysBetween(startsOn, endsOn);
  const tradingDaysElapsed = startsOn <= evalEnd ? weekdaysBetween(startsOn, evalEnd) : 0;
  const tradingDaysLeft = Math.max(0, today < startsOn ? tradingDaysTotal : weekdaysBetween(addDays(evalEnd, 1), endsOn));
  let status: ChallengeStatus;
  let reasonData: ReasonData;
  const f = failure as ChallengeFailure | null;
  if (f) {
    status = "failed";
    reasonData = { key: f.time ? "reason.failedAt" : "reason.failed", params: { date: f.date, ...(f.time ? { time: f.time } : {}) }, rule: f.rule, detail: failureDetail ?? undefined };
  } else if (passedOn) {
    status = "passed";
    reasonData = { key: "reason.passed", params: { date: passedOn, net: usd(cum), n: tradingDays } };
  } else if (today < startsOn) {
    status = "scheduled";
    reasonData = { key: "reason.scheduled", params: { date: startsOn } };
  } else if (today > endsOn) {
    status = "expired";
    const miss: ChallengeMsg[] = [];
    if (rules.profitTarget != null && cum < rules.profitTarget) miss.push({ key: "reason.missTarget", params: { target: usd(rules.profitTarget), net: usd(cum) } });
    if (tradingDays < minDays) miss.push({ key: "reason.missDays", params: { n: tradingDays, min: minDays } });
    if (rules.consistencyPct != null && (cons == null || cons > rules.consistencyPct)) {
      miss.push(cons == null ? { key: "reason.missNoProfit" } : { key: "reason.bestDayOver", params: { pct: cons.toFixed(0), max: rules.consistencyPct } });
    }
    reasonData = { key: "reason.expired", params: { date: endsOn }, list: miss, listSep: "; " };
  } else {
    status = "active";
    const left: ChallengeMsg[] = [];
    if (rules.profitTarget != null && cum < rules.profitTarget) left.push({ key: "reason.leftTarget", params: { usd: usd(rules.profitTarget - cum) } });
    if (tradingDays < minDays) left.push({ key: "reason.leftDays", params: { n: minDays - tradingDays } });
    if (rules.consistencyPct != null && cons != null && cons > rules.consistencyPct) left.push({ key: "reason.bestDayOver", params: { pct: cons.toFixed(0), max: rules.consistencyPct } });
    reasonData = left.length
      ? { key: "reason.active", params: { n: tradingDaysLeft }, list: left, listSep: ", " }
      : { key: "reason.activeNone", params: { n: tradingDaysLeft } };
  }
  const reason = renderChallengeReason(reasonData, lang);

  // ── per-rule progress ──
  const progress: RuleProgress[] = [];
  const failedRule = f?.rule ?? null;
  if (rules.profitTarget != null) {
    const pct = rules.profitTarget > 0 ? Math.max(0, Math.min(1, cum / rules.profitTarget)) : 1;
    progress.push({ key: "profit_target", label: ruleLabel("profit_target", lang), kind: "target", value: r2(cum), target: rules.profitTarget, pct: r2(pct), state: cum >= rules.profitTarget ? "met" : "pending", display: `${usd(cum)} / ${usd(rules.profitTarget)}`, detail: cum >= rules.profitTarget ? txt("progress.targetMet") : txt("progress.left", { usd: usd(rules.profitTarget - cum) }) });
  }
  if (dl != null) {
    const used = -worstDayLow;
    const st: RuleState = failedRule === "daily_loss" ? "breached" : used >= 0.8 * dl ? "warn" : "ok";
    progress.push({ key: "daily_loss", label: ruleLabel("daily_loss", lang), kind: "limit", value: r2(used), target: dl, pct: r2(used / dl), state: st, display: txt("progress.daily", { worst: usd(-used), limit: usd(-dl) }), detail: st === "breached" ? (f!.time ? txt("progress.breachedAt", { date: f!.date, time: f!.time }) : txt("progress.breached", { date: f!.date })) : txt("progress.dailyDetail", { pct: Math.round((used / dl) * 100) }) });
  }
  if (rules.maxDrawdown != null && rules.maxDrawdown > 0) {
    const room = floor != null ? balance - floor : null;
    const st: RuleState = failedRule === "max_drawdown" ? "breached" : room != null && room <= 0.2 * rules.maxDrawdown ? "warn" : "ok";
    const mode = txt(`progress.ddMode.${rules.drawdownMode === "static" ? "static" : rules.drawdownMode === "trailing_eod" ? "trailing_eod" : "trailing"}`);
    progress.push({ key: "max_drawdown", label: txt("progress.ddLabel", { label: ruleLabel("max_drawdown", lang), mode }), kind: "limit", value: r2(maxDdUsed), target: rules.maxDrawdown, pct: r2(maxDdUsed / rules.maxDrawdown), state: st, display: txt("progress.ddDisplay", { used: usd(maxDdUsed), max: usd(rules.maxDrawdown) }), detail: floor != null ? txt("progress.ddDetail", { floor: usd(floor), room: usd(room ?? 0) }) : "" });
  }
  if (rules.consistencyPct != null) {
    const st: RuleState = cons == null ? (tradingDays ? "pending" : "na") : cons <= rules.consistencyPct ? "ok" : "warn";
    progress.push({ key: "consistency", label: ruleLabel("consistency", lang), kind: "requirement", value: cons == null ? null : r2(cons), target: rules.consistencyPct, pct: cons == null ? null : r2(cons / 100), state: st, display: cons == null ? txt("progress.noProfit") : txt("progress.consDisplay", { pct: cons.toFixed(0), max: rules.consistencyPct }), detail: cons != null && cons > rules.consistencyPct ? txt("progress.consNeed", { usd: usd(Math.max(...dayNets) / (rules.consistencyPct / 100) - cum) }) : txt("progress.consOk") });
  }
  if (rules.minTradingDays != null) {
    progress.push({ key: "min_days", label: ruleLabel("min_days", lang), kind: "requirement", value: tradingDays, target: rules.minTradingDays, pct: r2(Math.min(1, rules.minTradingDays > 0 ? tradingDays / rules.minTradingDays : 1)), state: tradingDays >= rules.minTradingDays ? "met" : "pending", display: `${tradingDays} / ${rules.minTradingDays}`, detail: tradingDays >= rules.minTradingDays ? txt("progress.done") : txt("progress.daysLeft", { n: rules.minTradingDays - tradingDays }) });
  }
  if (rules.maxPositionQty != null || rules.maxPositionUsd != null) {
    const st: RuleState = failedRule === "max_position" ? "breached" : "ok";
    const parts = [rules.maxPositionQty != null ? txt("progress.qty", { qty: maxQty, max: rules.maxPositionQty }) : null, rules.maxPositionUsd != null ? `${usd(maxNotional)} / ${usd(rules.maxPositionUsd)}` : null].filter(Boolean);
    progress.push({ key: "max_position", label: ruleLabel("max_position", lang), kind: "limit", value: rules.maxPositionUsd != null ? r2(maxNotional) : maxQty, target: rules.maxPositionUsd ?? rules.maxPositionQty, pct: rules.maxPositionUsd ? r2(maxNotional / rules.maxPositionUsd) : rules.maxPositionQty ? r2(maxQty / rules.maxPositionQty) : null, state: st, display: parts.join(" · "), detail: txt("progress.maxPosDetail") });
  }
  if (rules.tradingWindow) {
    const st: RuleState = failedRule === "trading_window" ? "breached" : outOfWindow > 0 ? "warn" : "ok";
    const win = formatWindow(rules.tradingWindow);
    const outText = outOfWindow
      ? tt(rules.tradingWindowStrict ? "challenge.progress.windowOut" : "challenge.progress.windowOutSoft", { count: outOfWindow })
      : txt("progress.windowAll");
    progress.push({ key: "trading_window", label: ruleLabel("trading_window", lang), kind: "limit", value: outOfWindow, target: 0, pct: null, state: st, display: txt(rules.tradingWindowStrict ? "progress.windowDisplay" : "progress.windowDisplaySoft", { window: win }), detail: `${outText}${withoutTime ? txt("progress.withoutTime", { n: withoutTime }) : ""}` });
  }

  return {
    status,
    statusLabel: statusLabelsFor(lang)[status],
    reason,
    reasonData,
    failure: f,
    passedOn,
    startsOn,
    endsOn,
    evaluatedThrough: timeline.length ? timeline[timeline.length - 1].date : null,
    tradingDaysTotal,
    tradingDaysElapsed,
    tradingDaysLeft: status === "active" || status === "scheduled" ? tradingDaysLeft : 0,
    progress,
    timeline,
    stats: {
      net: r2(cum),
      balance: r2(balance),
      trades: trades.length,
      tradingDays,
      bestDay: dayNets.length ? r2(Math.max(...dayNets)) : null,
      worstDay: dayNets.length ? r2(Math.min(...dayNets)) : null,
      consistencyPct: cons == null ? null : r2(cons),
      maxDdUsed: r2(maxDdUsed),
      worstDayLow: r2(worstDayLow),
      tradesWithoutPnl: withoutPnl,
      tradesWithoutTime: withoutTime,
    },
  };
}

/** Validates/normalises a rules object coming from the API or DB. Returns null when it is unusable. */
export function normalizeRules(raw: unknown): ChallengeRules | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const n = (v: unknown, min = 0): number | null => {
    if (v == null || v === "") return null;
    const x = Number(v);
    return Number.isFinite(x) && x >= min ? x : null;
  };
  const accountSize = n(o.accountSize, 1);
  if (accountSize == null) return null;
  const mode = o.drawdownMode === "static" || o.drawdownMode === "trailing_eod" ? o.drawdownMode : "trailing";
  // Legacy rules (no rulesVersion) stored an inclusive end minute → shift to the exclusive form so they evaluate as before.
  const legacy = !(Number(o.rulesVersion) >= 2);
  let tw: ChallengeRules["tradingWindow"] = null;
  if (o.tradingWindow && typeof o.tradingWindow === "object") {
    const w = o.tradingWindow as Record<string, unknown>;
    const s = n(w.start), e = n(w.end);
    if (s != null && e != null && s < e && e <= 1440) tw = { start: s, end: legacy ? Math.min(1440, e + 1) : e };
  }
  const cons = n(o.consistencyPct);
  return {
    accountSize,
    profitTarget: n(o.profitTarget),
    dailyLossLimit: n(o.dailyLossLimit),
    maxDrawdown: n(o.maxDrawdown),
    drawdownMode: mode,
    trailingStopsAtStart: o.trailingStopsAtStart !== false && mode !== "static",
    consistencyPct: cons != null && cons > 0 && cons <= 100 ? cons : null,
    minTradingDays: n(o.minTradingDays) != null ? Math.round(n(o.minTradingDays)!) : null,
    maxPositionQty: n(o.maxPositionQty),
    maxPositionUsd: n(o.maxPositionUsd),
    tradingWindow: tw,
    tradingWindowStrict: o.tradingWindowStrict !== false,
    rulesVersion: RULES_VERSION,
  };
}
