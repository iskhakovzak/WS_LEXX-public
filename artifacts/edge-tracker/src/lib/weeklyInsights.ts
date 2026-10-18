/**
 * «Отчёт недели» — pure insight builders (no React, no fetch): tips with $ amounts, «что получилось»,
 * the curator checklist and the partners' executive conclusions.
 *
 * Nothing here re-computes trading math: every number comes from an existing engine response
 * (GET /api/weekly-review, /api/behavior, /api/whatif/fees, /api/whatif/suggestions, /api/day-report,
 * /api/benchmark). Each input is optional — a missing / failed endpoint simply yields fewer insights.
 */
import { fmtR, fmtRate, fmtUsd, fmtWeekday } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { weeklyI18n } from "@/i18n/ns/weeklyReview";
import { personName } from "@/i18n";

const t = weeklyI18n.t;
const trades = (count: number) => commonI18n.t("units.trades", { count });
const usd = (v: number | null | undefined) => fmtUsd(v, { signed: true, decimals: "auto" });

// ── Inputs (defensive subsets of the engine responses) ───────────────────────

export type WeekKpi = {
  trades: number; wins: number; losses: number;
  winRate: number | null;
  netPnl: number | null; grossPnl: number | null; fees: number;
  profitFactorUsd: number | null; profitFactorR: number | null;
  totalR: number; rCount: number;
  unit: "usd" | "r";
  tradingDays: number; greenDays: number; redDays: number;
  bestDay: { date: string; value: number } | null;
  worstDay: { date: string; value: number } | null;
};

export type BehaviorWeekPoint = { week: string; n: number; cost: number | null; net: number | null };

export type BehaviorPattern = {
  key: string;
  title: string;
  n: number;
  net: number | null;
  cost: number | null;
  severity?: "none" | "low" | "medium" | "high";
  baselineLabel?: string;
  baselineAvg?: number | null;
  weekly?: BehaviorWeekPoint[];
  extra?: Record<string, unknown>;
};

export type BehaviorReport = {
  patterns?: BehaviorPattern[];
  disciplineWeekly?: Array<{ week: string; avg: number | null; days: number }>;
  disciplineAvg?: number | null;
};

export type FeeRow = {
  key: string; trades: number; wins?: number; losses?: number;
  gross: number; grossWins?: number; fees: number; net: number;
  feePctOfGross?: number | null; feePctOfGrossWins?: number | null; breakEvenCents?: number | null;
};

export type FeeReport = {
  total?: FeeRow;
  byHold?: FeeRow[];
  byHour?: FeeRow[];
  breakEvenCents?: number | null;
  recommendations?: string[];
};

export type SimSuggestion = {
  label: string;
  improvement: number;
  ci?: { lo: number; hi: number } | null;
  excluded?: number;
  tradesLeft?: number;
};

export type DayLeak = { kind: string; title: string; count: number; costUsd: number | null; netUsd?: number | null; tradeIds?: number[] };
export type DayPlanItem = { id: string; source?: string; costUsd: number | null; text: string };
export type DayReportLite = {
  date: string;
  summary?: { trades: number; net: number | null; fees?: number | null; winRate?: number | null };
  leaks?: DayLeak[];
  leaksTotalUsd?: number | null;
  plan?: DayPlanItem[];
};

// ── Formatting: @/lib/format (fmtUsd, fmtRate, fmtWeekday) and commonI18n units ──

// ── Derived KPIs ─────────────────────────────────────────────────────────────

/** Fees as a share of gross P&L; null when gross ≤ 0 (a share of a loss is meaningless). */
export function feeShareOf(k: Pick<WeekKpi, "fees" | "grossPnl"> | null | undefined): number | null {
  if (!k || k.grossPnl == null || !(k.grossPnl > 0)) return null;
  return k.fees / k.grossPnl;
}

/** PF in the week's unit: $ when the book has P&L, else R. Never ∞ (the engines return null). */
export function pfOf(k: Pick<WeekKpi, "unit" | "profitFactorUsd" | "profitFactorR"> | null | undefined): number | null {
  if (!k) return null;
  return k.unit === "usd" ? k.profitFactorUsd : k.profitFactorR;
}

/** Behavior discipline index (0–100) for the week and the mean of the previous weeks in the response. */
export function disciplineOf(beh: BehaviorReport | null | undefined, weekStart: string): { current: number | null; prevAvg: number | null; prevWeeks: number } {
  const rows = beh?.disciplineWeekly ?? [];
  const cur = rows.find((r) => r.week === weekStart);
  const prev = rows.filter((r) => r.week < weekStart && r.avg != null);
  const prevAvg = prev.length ? Math.round((prev.reduce((s, r) => s + (r.avg as number), 0) / prev.length) * 10) / 10 : null;
  return { current: cur?.avg ?? null, prevAvg, prevWeeks: prev.length };
}

/** The pattern's numbers for one week (weekly point keyed by the week's Monday). */
export function patternWeek(p: BehaviorPattern, weekStart: string): BehaviorWeekPoint | null {
  return p.weekly?.find((w) => w.week === weekStart) ?? null;
}

// ── Tips ─────────────────────────────────────────────────────────────────────

export type TipSource = "behavior" | "hold" | "fees" | "time" | "sim" | "day";

export type Tip = {
  id: string;
  source: TipSource;
  /** Short headline with the $ figure. */
  title: string;
  /** $ impact: negative = what it cost this week, positive = potential gain (what-if). */
  amount: number | null;
  /** What the data shows. */
  evidence: string;
  /** One concrete rule for next week (can become the weekly goal). */
  action: string;
  /** Where to dig deeper (route + params). */
  href?: string;
};

/** Tip source → label in the UI language (getters: read at render time). */
export const TIP_SOURCE_LABEL: Record<TipSource, string> = {
  get behavior() { return t("insights.source.behavior"); },
  get hold() { return t("insights.source.hold"); },
  get fees() { return t("insights.source.fees"); },
  get time() { return t("insights.source.time"); },
  get sim() { return t("insights.source.sim"); },
  get day() { return t("insights.source.day"); },
};

type PatternKey = "martingale" | "revenge" | "overtrading" | "fatigue" | "tilt" | "chase" | "disposition" | "euphoria" | "firstTrade";
const PATTERN_KEYS = new Set<string>(["martingale", "revenge", "overtrading", "fatigue", "tilt", "chase", "disposition", "euphoria", "firstTrade"]);
const isPatternKey = (k: string): k is PatternKey => PATTERN_KEYS.has(k);

/** Concrete next-week rule per behavior pattern (keys from lib/behaviorEngine). */
function patternAction(p: BehaviorPattern): string {
  if (!isPatternKey(p.key)) return t("insights.action.fallback");
  if (p.key === "overtrading") return t("insights.action.overtrading", { n: typeof p.extra?.norm === "number" ? p.extra.norm : 4 });
  if (p.key === "fatigue") return t("insights.action.fatigue", { n: typeof p.extra?.cut === "number" ? p.extra.cut : 3 });
  return t(`insights.action.${p.key}`);
}

/** Pattern name in the UI language; unknown keys fall back to the server title. */
function patternTitle(p: BehaviorPattern): string {
  return isPatternKey(p.key) ? t(`insights.pattern.${p.key}`) : p.title;
}

/** Day-report leak kinds that duplicate a behavior pattern (so the same issue is not tipped twice). */
const LEAK_TO_PATTERN: Record<string, string> = { revenge: "revenge", size_up: "martingale", overtrading: "overtrading", tilt: "tilt" };

// Hold-bucket keys as the what-if fees engine sends them (data codes, not UI text).
const SCALP_KEYS = new Set(["< 30 с", "30 с – 2 мин"]); // i18n-ignore (server bucket keys)

export type TipInput = {
  trader: string;
  weekStart: string;
  weekEnd: string;
  kpi?: WeekKpi | null;
  behavior?: BehaviorReport | null;
  fees?: FeeReport | null;
  suggestions?: SimSuggestion[] | null;
  /** Window the suggestions were computed on (for the evidence line). */
  suggestionsWeeks?: number;
  dayReports?: DayReportLite[] | null;
};

const q = (p: Record<string, string | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) s.set(k, v);
  const out = s.toString();
  return out ? `?${out}` : "";
};

/** Every candidate tip, most expensive first (deduplicated by id). */
export function tipCandidates(input: TipInput): Tip[] {
  const { trader, weekStart, behavior, fees, suggestions, dayReports } = input;
  const out: Tip[] = [];
  const usedPatterns = new Set<string>();

  // 1) Behavior patterns — this week's slice of the 5-week report.
  for (const p of behavior?.patterns ?? []) {
    const w = patternWeek(p, weekStart);
    if (!w || w.n <= 0) continue;
    const action = patternAction(p);
    const name = patternTitle(p);
    if (p.key === "firstTrade") {
      // «Первая сделка дня −$Y»: the absolute result of the first trades, only when it lost money.
      if (w.net == null || w.net >= -1) continue;
      out.push({
        id: "beh:firstTrade", source: "behavior", amount: w.net,
        title: t("insights.titleAmount", { name, amount: usd(w.net) }),
        evidence: t("insights.firstTradeEvidence", { trades: trades(w.n), amount: usd(w.net) }),
        action, href: `/behavior${q({ trader })}`,
      });
      usedPatterns.add(p.key);
      continue;
    }
    if (w.cost == null || w.cost >= -1) continue;
    out.push({
      id: `beh:${p.key}`, source: "behavior", amount: w.cost,
      title: t("insights.titleAmount", { name, amount: usd(w.cost) }),
      evidence: (() => {
        const head = w.net != null ? t("insights.behHeadNet", { trades: trades(w.n), net: usd(w.net) }) : trades(w.n);
        const cost = fmtUsd(Math.abs(w.cost), { decimals: "auto" });
        return p.baselineLabel ? t("insights.behEvidenceBase", { head, cost, baseline: p.baselineLabel }) : t("insights.behEvidence", { head, cost });
      })(),
      action, href: `/behavior${q({ trader })}`,
    });
    usedPatterns.add(p.key);
  }

  // 2) Fees — scalps shorter than 2 minutes.
  const total = fees?.total;
  const scalps = (fees?.byHold ?? []).filter((r) => SCALP_KEYS.has(r.key));
  if (scalps.length) {
    const n = scalps.reduce((s, r) => s + r.trades, 0);
    const net = scalps.reduce((s, r) => s + r.net, 0);
    const fee = scalps.reduce((s, r) => s + r.fees, 0);
    if (n >= 2 && net < -1) {
      const be = fees?.breakEvenCents ?? total?.breakEvenCents ?? null;
      out.push({
        id: "hold:scalps", source: "hold", amount: Math.round(net * 100) / 100,
        title: t("insights.scalpsTitle", { amount: usd(net) }),
        evidence: t("insights.scalpsEvidence", { trades: trades(n), fees: fmtUsd(fee, { decimals: "auto" }) }),
        action: be != null ? t("insights.scalpsActionBe", { cents: Math.max(3, Math.ceil(be * 3)) }) : t("insights.scalpsAction"),
        href: `/what-if${q({ trader })}`,
      });
    }
  }

  // 3) Time of day — the worst window (skipped when it is simply where all the week's trades were).
  const hours = (fees?.byHour ?? []).filter((r) => r.trades >= 2 && r.net < -1);
  const totalTrades = total?.trades ?? hours.reduce((s, r) => s + r.trades, 0);
  const worstHour = [...hours].sort((a, b) => a.net - b.net)[0];
  if (worstHour && totalTrades > 0 && worstHour.trades / totalTrades < 0.9) {
    const share = worstHour.feePctOfGrossWins ?? null;
    out.push({
      id: `time:${worstHour.key}`, source: "time", amount: worstHour.net,
      title: t("insights.timeTitle", { window: worstHour.key, amount: usd(worstHour.net) }),
      evidence: share != null && share > 0
        ? t("insights.timeEvidenceFees", { trades: trades(worstHour.trades), share: fmtRate(share) })
        : t("insights.timeEvidence", { trades: trades(worstHour.trades) }),
      action: t("insights.timeAction", { window: worstHour.key }),
      href: `/what-if${q({ trader })}`,
    });
  }

  // 4) Fees overall — when commissions eat a large share of the winners. When (almost) every trade sat in
  //    one time window, name it: «15:30–16:00: комиссии съели 39% прибыли».
  if (total && total.fees > 0) {
    const eaten = total.feePctOfGrossWins ?? null;
    const dominant = (fees?.byHour ?? []).find((r) => totalTrades > 0 && r.trades / totalTrades >= 0.9);
    if (eaten != null && eaten >= 0.25) {
      out.push({
        id: "fees:total", source: "fees", amount: -Math.round(total.fees * 100) / 100,
        title: dominant ? t("insights.feesTitleWindow", { window: dominant.key, share: fmtRate(eaten) }) : t("insights.feesTitle", { share: fmtRate(eaten) }),
        evidence: t("insights.feesEvidence", { fees: fmtUsd(total.fees, { decimals: "auto" }), gross: fmtUsd(total.grossWins ?? null, { decimals: "auto" }) }),
        action: fees?.recommendations?.[0] ?? t("insights.feesAction"),
        href: `/what-if${q({ trader })}`,
      });
    }
  }

  // 5) Day reports — leaks not already covered by a behavior pattern, summed over the week.
  const leakAgg = new Map<string, { title: string; cost: number; count: number; days: number; plan?: string; date: string }>();
  for (const d of dayReports ?? []) {
    for (const l of d.leaks ?? []) {
      const pk = LEAK_TO_PATTERN[l.kind];
      if (pk && usedPatterns.has(pk)) continue;
      if (l.costUsd == null || !(l.costUsd > 0)) continue;
      const a = leakAgg.get(l.kind) ?? { title: l.title, cost: 0, count: 0, days: 0, date: d.date };
      a.cost += l.costUsd; a.count += l.count; a.days += 1;
      const plan = d.plan?.find((p) => p.id === l.kind)?.text;
      // Day-report plan lines end with «— сегодня …» / «— today …»: keep the rule, drop the day-specific tail.
      if (plan && !a.plan) a.plan = plan.replace(/\s+—\s+(сегодня|today|bugun).*$/iu, ".").replace(/\.\.$/, "."); // i18n-ignore (parses server text)
      leakAgg.set(l.kind, a);
    }
  }
  for (const [kind, a] of leakAgg) {
    const cost = -Math.round(a.cost * 100) / 100;
    if (cost >= -1) continue;
    out.push({
      id: `day:${kind}`, source: "day", amount: cost,
      title: t("insights.titleAmount", { name: a.title, amount: usd(cost) }),
      evidence: t("insights.dayEvidence", { trades: trades(a.count), days: commonI18n.t("units.days", { count: a.days }) }),
      action: a.plan ?? t("insights.dayAction"),
      href: `/day-report${q({ trader, date: a.date })}`,
    });
  }

  // 6) Simulator — a statistically confirmed rule (positive = what it would have added).
  const best = (suggestions ?? []).filter((s) => s.improvement > 0).sort((a, b) => b.improvement - a.improvement)[0];
  if (best) {
    const weeks = input.suggestionsWeeks ?? 8;
    out.push({
      id: "sim:best", source: "sim", amount: best.improvement,
      title: t("insights.simTitle", { label: best.label, amount: usd(best.improvement) }),
      evidence: `${t("insights.simEvidence", { weeks: commonI18n.t("units.weeks", { count: weeks }), amount: usd(best.improvement) })}${
        best.ci ? ` (${t("insights.simRange", { lo: usd(best.ci.lo), hi: usd(best.ci.hi) })})` : ""}${
        best.excluded ? `, ${t("insights.simExcluded", { trades: trades(best.excluded) })}` : ""}.`,
      action: t("insights.simAction", { label: best.label }),
      href: `/what-if${q({ trader })}`,
    });
  }

  const seen = new Set<string>();
  return out
    .filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
    .sort((a, b) => Math.abs(b.amount ?? 0) - Math.abs(a.amount ?? 0));
}

/** Top-N tips (default 3): one per source first so the list stays varied, then the next most expensive. */
export function buildTips(input: TipInput, limit = 3): Tip[] {
  const all = tipCandidates(input);
  const picked: Tip[] = [];
  const sources = new Set<TipSource>();
  for (const t of all) {
    if (picked.length >= limit) break;
    if (sources.has(t.source)) continue;
    picked.push(t);
    sources.add(t.source);
  }
  for (const t of all) {
    if (picked.length >= limit) break;
    if (!picked.includes(t)) picked.push(t);
  }
  return picked.sort((a, b) => Math.abs(b.amount ?? 0) - Math.abs(a.amount ?? 0));
}

// ── What went well ───────────────────────────────────────────────────────────

export type Positive = { id: string; text: string; amount?: number | null };

export type PositiveInput = {
  weekStart: string;
  kpi?: WeekKpi | null;
  avg4?: WeekKpi | null;
  avg4Weeks?: number;
  behavior?: BehaviorReport | null;
  bestTrade?: { ticker: string; net: number | null } | null;
  violations?: number;
  mistakes?: number;
  journalDays?: number;
  tradingDays?: number;
};

/** "Пн" (UI language) for a YYYY-MM-DD. */
const wd = (ymd: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  const s = fmtWeekday(ymd, "short");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function buildPositives(input: PositiveInput, limit = 4): Positive[] {
  const { kpi: k, avg4, behavior, weekStart } = input;
  const out: Positive[] = [];
  if (!k || k.trades === 0) return out;
  const money = k.unit === "usd";
  if (money && k.netPnl != null && avg4?.netPnl != null && (input.avg4Weeks ?? 0) > 0 && k.netPnl > avg4.netPnl + 1) {
    out.push({ id: "net-vs-avg", text: t("insights.pos.netVsAvg", { amount: fmtUsd(k.netPnl - avg4.netPnl, { decimals: "auto" }) }), amount: k.netPnl - avg4.netPnl });
  }
  if (k.winRate != null && avg4?.winRate != null && (input.avg4Weeks ?? 0) > 0 && k.winRate - avg4.winRate >= 0.05) {
    out.push({ id: "wr", text: t("insights.pos.wr", { wr: fmtRate(k.winRate), pp: Math.round((k.winRate - avg4.winRate) * 100) }) });
  }
  if (k.bestDay && k.bestDay.value > 0) {
    out.push({ id: "best-day", text: t("insights.pos.bestDay", { day: wd(k.bestDay.date), value: money ? usd(k.bestDay.value) : fmtR(k.bestDay.value) }), amount: money ? k.bestDay.value : null });
  }
  if (input.bestTrade?.net != null && input.bestTrade.net > 0) {
    out.push({ id: "best-trade", text: t("insights.pos.bestTrade", { ticker: input.bestTrade.ticker, amount: usd(input.bestTrade.net) }), amount: input.bestTrade.net });
  }
  const first = behavior?.patterns?.find((p) => p.key === "firstTrade");
  const fw = first ? patternWeek(first, weekStart) : null;
  if (fw && fw.n > 0 && fw.cost != null && fw.cost > 1 && (fw.net ?? 0) >= 0) {
    out.push({ id: "first-trade", text: t("insights.pos.firstTrade", { amount: usd(fw.net), trades: trades(fw.n) }), amount: fw.net });
  }
  if ((input.violations ?? 0) === 0 && (input.mistakes ?? 0) === 0) out.push({ id: "clean", text: t("insights.pos.clean") });
  const disc = disciplineOf(behavior, weekStart).current;
  if (disc != null && disc >= 85) out.push({ id: "discipline", text: t("insights.pos.discipline", { value: Math.round(disc) }) });
  const avoided = (behavior?.patterns ?? []).filter((p) => ["overtrading", "tilt", "revenge"].includes(p.key));
  if (avoided.length === 3 && avoided.every((p) => (patternWeek(p, weekStart)?.n ?? 0) === 0)) out.push({ id: "no-tilt", text: t("insights.pos.noTilt") });
  if ((input.tradingDays ?? 0) > 0 && (input.journalDays ?? 0) >= (input.tradingDays ?? 0)) out.push({ id: "journal", text: t("insights.pos.journal") });
  return out.slice(0, limit);
}

// ── Curator checklist ────────────────────────────────────────────────────────

export type CheckStatus = "ok" | "warn" | "fail" | "na";
export type CheckItem = { id: string; label: string; status: CheckStatus; detail: string; amount?: number | null; href?: string };

export type ChecklistInput = {
  trader: string;
  weekStart: string;
  violations: Array<{ ruleName: string | null; ruleKind: string | null; tradeNet: number | null }>;
  violationCostUsd: number | null;
  mistakes: number;
  mistakeCostUsd: number | null;
  risk: { hasLimits: boolean; breaches: number; warns: number; labels: string[] };
  /** Trading days that have no journal review. */
  daysWithoutReview: string[];
  tradingDays: number;
  behavior?: BehaviorReport | null;
  feeShare: number | null;
  reviewStatus: "none" | "draft" | "submitted" | "reviewed";
  prevGoals: Array<{ status: string }>;
};

const BEHAVIOR_RED_FLAGS = ["martingale", "revenge", "tilt", "overtrading"];

export function buildChecklist(input: ChecklistInput): CheckItem[] {
  const out: CheckItem[] = [];
  const q2 = (p: Record<string, string>) => q(p);

  // Rules
  const byRule = new Map<string, number>();
  for (const v of input.violations) {
    const k = v.ruleName ?? v.ruleKind ?? t("insights.check.rule");
    byRule.set(k, (byRule.get(k) ?? 0) + 1);
  }
  const ruleList = [...byRule.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(", ");
  out.push(input.violations.length === 0
    ? { id: "rules", label: t("insights.check.rulesOk"), status: "ok", detail: t("insights.check.rulesOkDetail") }
    : { id: "rules", label: t("insights.check.rulesFail"), status: "fail", detail: ruleList, amount: input.violationCostUsd, href: "/error-tracker" });

  // Risk limits
  const r = input.risk;
  out.push(!r.hasLimits
    ? { id: "risk", label: t("insights.check.risk"), status: "na", detail: t("insights.check.riskNa"), href: `/risk${q2({ trader: input.trader })}` }
    : r.breaches
      ? { id: "risk", label: t("insights.check.riskBreach"), status: "fail", detail: r.labels.join(", ") || commonI18n.t("units.violations", { count: r.breaches }), href: `/risk${q2({ trader: input.trader })}` }
      : r.warns
        ? { id: "risk", label: t("insights.check.riskWarn"), status: "warn", detail: r.labels.join(", ") || t("insights.check.warnings", { count: r.warns }), href: `/risk${q2({ trader: input.trader })}` }
        : { id: "risk", label: t("insights.check.riskOk"), status: "ok", detail: t("insights.check.riskOkDetail") });

  // Behavior red flags this week
  const flags = (input.behavior?.patterns ?? [])
    .filter((p) => BEHAVIOR_RED_FLAGS.includes(p.key))
    .map((p) => ({ p, w: patternWeek(p, input.weekStart) }))
    .filter((x) => x.w && x.w.n > 0);
  if (input.behavior) {
    const cost = flags.reduce((s, x) => s + Math.min(0, x.w?.cost ?? 0), 0);
    out.push(flags.length === 0
      ? { id: "behavior", label: t("insights.check.behOk"), status: "ok", detail: t("insights.check.behOkDetail") }
      : {
          id: "behavior", label: t("insights.check.behFail"), status: cost < -1 ? "fail" : "warn",
          detail: flags.map((x) => `${patternTitle(x.p)} ×${x.w?.n}`).join(", "),
          amount: cost < 0 ? Math.round(cost * 100) / 100 : null, href: `/behavior${q2({ trader: input.trader })}`,
        });
  }

  // Journal / day review
  const missing = input.daysWithoutReview.length;
  out.push(input.tradingDays === 0
    ? { id: "journal", label: t("insights.check.journal"), status: "na", detail: t("insights.check.journalNa") }
    : missing === 0
      ? { id: "journal", label: t("insights.check.journalOk"), status: "ok", detail: t("insights.check.journalOkDetail", { done: input.tradingDays, total: input.tradingDays }) }
      : { id: "journal", label: t("insights.check.journalMissing"), status: missing >= Math.ceil(input.tradingDays / 2) ? "fail" : "warn", detail: t("insights.check.journalMissingDetail", { missing, total: input.tradingDays }) });

  // Mistakes
  if (input.mistakes > 0) out.push({ id: "mistakes", label: t("insights.check.mistakes"), status: "warn", detail: t("insights.check.mistakesDetail", { count: input.mistakes }), amount: input.mistakeCostUsd, href: "/error-tracker" });

  // Fees
  if (input.feeShare != null) {
    out.push(input.feeShare > 0.4
      ? { id: "fees", label: t("insights.check.feesFail"), status: "fail", detail: t("insights.check.feesDetail", { share: fmtRate(input.feeShare) }) }
      : input.feeShare > 0.25
        ? { id: "fees", label: t("insights.check.feesWarn"), status: "warn", detail: t("insights.check.feesDetail", { share: fmtRate(input.feeShare) }) }
        : { id: "fees", label: t("insights.check.feesOk"), status: "ok", detail: t("insights.check.feesOkDetail", { share: fmtRate(input.feeShare) }) });
  }

  // Self-review & last week's goals
  out.push(input.reviewStatus === "submitted" || input.reviewStatus === "reviewed"
    ? { id: "self", label: t("insights.check.selfOk"), status: "ok", detail: input.reviewStatus === "reviewed" ? t("insights.check.selfReviewed") : t("insights.check.selfWaiting") }
    : { id: "self", label: t("insights.check.selfMissing"), status: "warn", detail: input.reviewStatus === "draft" ? t("insights.check.selfDraft") : t("insights.check.selfNone") });
  if (input.prevGoals.length) {
    const open = input.prevGoals.filter((g) => g.status === "open").length;
    const done = input.prevGoals.filter((g) => g.status === "done").length;
    out.push(open
      ? { id: "goals", label: t("insights.check.goalsOpen"), status: "warn", detail: t("insights.check.goalsOpenDetail", { open, total: input.prevGoals.length }) }
      : { id: "goals", label: t("insights.check.goals"), status: done === input.prevGoals.length ? "ok" : "warn", detail: t("insights.check.goalsDetail", { done, total: input.prevGoals.length }) });
  }
  return out;
}

// ── Partners: desk conclusions ───────────────────────────────────────────────

export type DeskRow = {
  trader: string;
  trades: number;
  netPnl: number | null;
  fees: number;
  grossPnl?: number | null;
  riskStatus?: "ok" | "warn" | "breach" | "none" | null;
  verdict?: "better" | "worse" | "flat" | "nodata" | null;
  weakness?: string | null;
};

export type DeskSummary = {
  traders: number;
  active: number;
  netPnl: number | null;
  fees: number;
  grossPnl: number | null;
  reviewed: number;
  submitted: number;
};

export function buildDeskConclusions(s: DeskSummary, rows: DeskRow[], limit = 5): string[] {
  const out: string[] = [];
  const active = rows.filter((r) => r.trades > 0);
  if (active.length === 0) return [t("insights.desk.empty")];
  const green = active.filter((r) => (r.netPnl ?? 0) > 0);
  out.push(t("insights.desk.summary", { net: usd(s.netPnl), active: s.active, total: s.traders, green: green.length }));

  const byNet = [...active].filter((r) => r.netPnl != null).sort((a, b) => (b.netPnl as number) - (a.netPnl as number));
  const top = byNet[0];
  const worst = byNet[byNet.length - 1];
  if (top && (top.netPnl ?? 0) > 0) {
    const share = s.netPnl != null && s.netPnl > 0 && top.netPnl != null ? top.netPnl / s.netPnl : null;
    out.push(share != null && share >= 0.5 && byNet.length > 1
      ? t("insights.desk.topShare", { name: personName(top.trader), net: usd(top.netPnl), share: fmtRate(Math.min(share, 9.99)) })
      : t("insights.desk.top", { name: personName(top.trader), net: usd(top.netPnl) }));
  }
  if (worst && worst !== top && (worst.netPnl ?? 0) < 0) {
    const why = worst.riskStatus === "breach" ? t("insights.desk.whyBreach") : worst.verdict === "worse" ? t("insights.desk.whyWorse") : worst.weakness ?? null;
    out.push(why ? t("insights.desk.worstWhy", { name: worst.trader, net: usd(worst.netPnl), why }) : t("insights.desk.worst", { name: worst.trader, net: usd(worst.netPnl) }));
  }

  if (s.fees > 0) {
    const share = s.grossPnl != null && s.grossPnl > 0 ? s.fees / s.grossPnl : null;
    const perTrade = s.netPnl != null ? s.netPnl / Math.max(1, active.reduce((a, r) => a + r.trades, 0)) : null;
    const feeArgs = { fees: fmtUsd(s.fees, { decimals: "auto" }), perTrade: usd(perTrade) };
    out.push(share != null
      ? t("insights.desk.feesShare", { ...feeArgs, share: fmtRate(share) })
      : s.grossPnl != null ? t("insights.desk.feesNegGross", feeArgs) : t("insights.desk.fees", feeArgs));
  }

  const breach = rows.filter((r) => r.riskStatus === "breach").map((r) => r.trader);
  const warn = rows.filter((r) => r.riskStatus === "warn").map((r) => r.trader);
  if (breach.length) out.push(warn.length ? t("insights.desk.riskBreachWarn", { names: breach.join(", "), warn: warn.join(", ") }) : t("insights.desk.riskBreach", { names: breach.join(", ") }));
  else if (warn.length) out.push(t("insights.desk.riskWarn", { names: warn.join(", ") }));
  else if (rows.some((r) => r.riskStatus === "ok")) out.push(t("insights.desk.riskOk"));

  const worse = active.filter((r) => r.verdict === "worse").map((r) => r.trader);
  if (worse.length) out.push(t("insights.desk.trend", { names: worse.join(", ") }));

  if (out.length < limit) {
    out.push(s.submitted
      ? t("insights.desk.reviewWaiting", { reviewed: s.reviewed, total: s.traders, waiting: s.submitted })
      : t("insights.desk.review", { reviewed: s.reviewed, total: s.traders }));
  }
  // Names ending in a dot («Игорь П.») before the sentence's own dot.
  return out.slice(0, limit).map((line) => line.replace(/\.\.$/, "."));
}
