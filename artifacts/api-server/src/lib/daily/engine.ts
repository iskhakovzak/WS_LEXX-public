/**
 * Daily loop engine — pure (no I/O). One mistake a day, decided from the trades, never self-reported.
 *
 *   analyzeWindow(input)          every mistake of a window (lib/daily/detectors.ts) → hits per day + costs per mistake
 *   pickFocus(costs, disputed)    the costliest REPEATING mistake (≥ focusMinDays, cost ≤ −focusMinCost), disputed excluded
 *   focusOf(...)                  DailyFocus with its one line (TextItem `focus.<mistakeId>` {cost, count, days})
 *   verdictOf(analysis, date, m)  was the mistake there that day: kept / broken / no_trades / unknown (+ hits)
 *   contractOf(analysis, date, p) the own contract (daily stop / max trades / own rule) → disciplineDelta
 *   tradeToReview(analysis, date) biggest loss, else giveback, else a focus hit, else the best trade
 *   tierProgressOf(evaluation)    «to Junior: 3 of 5» from lib/scalingEngine
 *
 * Window length, repeat days and the minimum cost are desk settings (lib/settings registry, group "daily"), read per call.
 * Money is net ($, ≤ 0 = cost). Dates are New York trading days.
 */
import type { BehaviorTrade } from "../behaviorEngine";
import { addDays, isWeekend } from "../tradingDate";
import type { Evaluation } from "../scalingEngine";
import { setting } from "../settings/registry";
import {
  HitBook, dayPath, detectBehavior, detectDay, detectRules, detectStructure, dailyLossLimit, refOf, ruleKinds, windowDays,
  type DayHits, type DetectInput, type PlanContract,
} from "./detectors";
import type {
  ContractVerdict, DailyFocus, EveningCard, FocusVerdict, MistakeCost, MistakeId, TierProgress, TradeRef, VerdictStatus,
} from "./types";

export type { DayHit, DetectInput, PlanContract } from "./detectors";

/** Focus thresholds now in force (admin → «Настройки деска»). */
export function focusSettings() {
  return {
    /** Trading days in the focus window (default 10 ≈ two weeks). */
    windowDays: setting("daily.focusWindowDays"),
    /** A mistake must repeat on at least this many days of the window to become the focus. */
    minDays: setting("daily.focusMinDays"),
    /** Smaller costs are noise — the focus then says «nothing repeating». */
    minCost: setting("daily.focusMinCostUsd"),
  };
}
/** Calendar days of history before the window that set the personal norms (behaviour patterns, giveback size). */
export const NORM_HISTORY_DAYS = 90;
/** Points the own contract adds to the day's discipline score (lib/behaviorEngine DisciplineDay.contract). */
export const DISCIPLINE_POINTS: Readonly<Record<VerdictStatus | "unset", number>> = { kept: 5, broken: -15, no_trades: 0, unknown: 0, unset: 0 };

const MISTAKE_RE = /^(behavior:(revenge|martingale|overtrading|fatigue|chase|tilt|disposition|firstTrade|euphoria)|structure:(averaging|held_past_stop)|day:(giveback|fees|after_limit)|rule:[a-z_]{2,40})$/;
/** True for a well-formed MistakeId (used to validate the plan's own rule and the curator override). */
export function isMistakeId(v: unknown): v is MistakeId {
  return typeof v === "string" && MISTAKE_RE.test(v);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The focus-window weekdays before `date` (exclusive): { from, to }. Holidays simply carry no trades. */
export function focusWindow(date: string, days: number = focusSettings().windowDays): { from: string; to: string } {
  let d = date, to = "", n = 0, from = date;
  while (n < days) {
    d = addDays(d, -1);
    if (isWeekend(d)) continue;
    if (!to) to = d;
    from = d;
    n++;
  }
  return { from, to };
}

export interface WindowAnalysis {
  from: string;
  to: string;
  /** Every mistake seen in the window, costliest first. */
  costs: MistakeCost[];
  days: DayHits;
  /** Window trades per day (realised order). */
  tradesByDay: Map<string, BehaviorTrade[]>;
  /** Can the engine judge `mistake` on `date` (the data it needs is there)? */
  evaluable: (mistake: MistakeId, date: string) => boolean;
}

function costsOf(days: DayHits): MistakeCost[] {
  const agg = new Map<MistakeId, { count: number; days: Set<string>; cost: number | null; refs: TradeRef[] }>();
  for (const [date, m] of days) {
    for (const [id, h] of m) {
      const a = agg.get(id) ?? { count: 0, days: new Set<string>(), cost: null, refs: [] };
      a.count += h.count;
      a.days.add(date);
      if (h.costNet != null) a.cost = round2((a.cost ?? 0) + h.costNet);
      a.refs.push(...h.refs);
      agg.set(id, a);
    }
  }
  return [...agg.entries()]
    .map(([id, a]) => ({
      id, count: a.count, days: a.days.size, costNet: a.cost,
      examples: [...a.refs].sort((x, y) => (x.net ?? 0) - (y.net ?? 0)).slice(0, 5),
    }))
    .sort((x, y) => (x.costNet ?? 0) - (y.costNet ?? 0) || y.count - x.count || x.id.localeCompare(y.id));
}

export function analyzeWindow(input: DetectInput): WindowAnalysis {
  const days = windowDays(input.trades, input.from, input.to);
  const inWindow = new Map<number, BehaviorTrade>();
  for (const l of days.values()) for (const t of l) inWindow.set(t.id, t);
  const byId = new Map(input.trades.map((t) => [t.id, t]));
  const book = new HitBook();
  detectBehavior(input, book, inWindow);
  const cover = detectStructure(input, book, inWindow);
  detectDay(input, book, days);
  detectRules(input, book, byId);
  const kinds = ruleKinds(input.rules);
  const evaluable = (mistake: MistakeId, date: string): boolean => {
    const list = days.get(date) ?? [];
    if (!list.length) return false;
    if (mistake === "structure:averaging") return cover.averaging.has(date);
    if (mistake === "structure:held_past_stop") return cover.stop.has(date);
    if (mistake === "day:after_limit") return dailyLossLimit(input, date) != null;
    if (mistake === "day:giveback" || mistake === "day:fees") return list.some((t) => t.net != null);
    if (mistake.startsWith("rule:")) return kinds.has(mistake.slice(5));
    return mistake.startsWith("behavior:");
  };
  return { from: input.from, to: input.to, costs: costsOf(book.days), days: book.days, tradesByDay: days, evaluable };
}

/** The costliest repeating mistake of the window, or null (nothing repeats, or only small costs). */
export function pickFocus(costs: readonly MistakeCost[], disputed: ReadonlySet<MistakeId> = new Set()): MistakeCost | null {
  let best: MistakeCost | null = null;
  const { minDays, minCost } = focusSettings();
  for (const c of costs) {
    if (c.days < minDays || c.costNet == null || c.costNet > -minCost || disputed.has(c.id)) continue;
    if (!best || c.costNet < (best.costNet ?? 0) || (c.costNet === best.costNet && c.count > best.count)) best = c;
  }
  return best;
}

/** The focus line: `focus.<mistakeId>` {cost, count, days}; `focus.none` when nothing repeats. */
export function focusOf(trader: string, date: string, window: { from: string; to: string }, pick: MistakeCost | null, source: DailyFocus["source"] = pick ? "auto" : "none"): DailyFocus {
  if (!pick) {
    return { trader, date, mistake: null, window, costNet: null, count: 0, source: "none", text: { key: "focus.none", params: { days: focusSettings().windowDays } } };
  }
  return {
    trader, date, mistake: pick.id, window, costNet: pick.costNet, count: pick.count, source,
    text: { key: `focus.${pick.id}`, params: { cost: pick.costNet == null ? null : Math.round(Math.abs(pick.costNet)), count: pick.count, days: pick.days } },
  };
}

/** Was `mistake` there on `date`? */
export function verdictOf(a: WindowAnalysis, date: string, mistake: MistakeId, disputed = false): FocusVerdict {
  const trades = a.tradesByDay.get(date) ?? [];
  const base = { date, mistake, disputed };
  if (!trades.length) return { ...base, status: "no_trades", hits: [], costNet: null };
  if (!a.evaluable(mistake, date)) return { ...base, status: "unknown", hits: [], costNet: null };
  const h = a.days.get(date)?.get(mistake);
  if (!h) return { ...base, status: "kept", hits: [], costNet: null };
  // Signed impacts can be positive (an add that worked out): the verdict reports a cost only when it cost money.
  return { ...base, status: "broken", hits: h.refs.slice(0, 10), costNet: h.costNet != null && h.costNet < 0 ? h.costNet : null };
}

/** Own contract verdict (null when the plan sets none of daily stop / max trades / own rule). */
export function contractOf(a: WindowAnalysis, date: string, plan: PlanContract | null | undefined): ContractVerdict | null {
  const maxLoss = plan?.maxLossUsd != null && plan.maxLossUsd > 0 ? plan.maxLossUsd : null;
  const maxTrades = plan?.maxTrades != null && plan.maxTrades >= 0 ? plan.maxTrades : null;
  const own = plan?.ownRule ?? null;
  if (maxLoss == null && maxTrades == null && own == null) return null;
  const trades = a.tradesByDay.get(date) ?? [];
  const path = dayPath(trades);
  const lossStatus: VerdictStatus | "unset" = maxLoss == null ? "unset" : !trades.length ? "no_trades" : path.trough <= -maxLoss ? "broken" : "kept";
  const tradesStatus: VerdictStatus | "unset" = maxTrades == null ? "unset" : !trades.length ? "no_trades" : trades.length > maxTrades ? "broken" : "kept";
  const ruleStatus: VerdictStatus | "unset" = own == null ? "unset" : verdictOf(a, date, own).status;
  const disciplineDelta = DISCIPLINE_POINTS[lossStatus] + DISCIPLINE_POINTS[tradesStatus] + DISCIPLINE_POINTS[ruleStatus];
  return {
    date,
    maxLoss: { limit: maxLoss, actual: trades.length ? path.trough : null, status: lossStatus },
    maxTrades: { limit: maxTrades, actual: trades.length, status: tradesStatus },
    rule: { mistake: own, status: ruleStatus },
    disciplineDelta,
  };
}

/** One trade worth opening tonight. */
export function tradeToReview(a: WindowAnalysis, date: string, focus: MistakeId | null): EveningCard["tradeToReview"] {
  const trades = (a.tradesByDay.get(date) ?? []).filter((t) => t.net != null);
  if (!trades.length) return null;
  const worst = trades.reduce((m, t) => ((t.net as number) < (m.net as number) ? t : m));
  if ((worst.net as number) < 0) return { ...refOf(worst), reason: "biggest_loss" };
  const give = a.days.get(date)?.get("day:giveback")?.refs[0];
  if (give) return { ...give, reason: "giveback" };
  const hit = focus ? a.days.get(date)?.get(focus)?.refs[0] : undefined;
  if (hit) return { ...hit, reason: "focus_hit" };
  const best = trades.reduce((m, t) => ((t.net as number) > (m.net as number) ? t : m));
  return { ...refOf(best), reason: "best" };
}

/** Day totals for the evening card. */
export function dayTotals(a: WindowAnalysis, date: string): { trades: number; netPnl: number | null } {
  const list = a.tradesByDay.get(date) ?? [];
  const known = list.filter((t) => t.net != null);
  return { trades: list.length, netPnl: known.length ? round2(known.reduce((s, t) => s + (t.net as number), 0)) : null };
}

/** «To the next tier: met of total» from a scaling evaluation (promote rules only). */
export function tierProgressOf(ev: Evaluation | null | undefined): TierProgress | null {
  if (!ev) return null;
  const items = ev.rules
    .filter((r) => r.kind === "promote")
    .map((r) => ({
      metric: r.metric,
      label: { key: `scaling.metric.${r.metric}.label`, params: r.customLabel ? { custom: r.customLabel } : undefined },
      actual: r.actual,
      target: r.threshold,
      ok: r.status === "pass",
    }));
  return { tier: ev.tier?.key ?? null, nextTier: ev.nextTier?.key ?? null, met: ev.promotePassed, total: ev.promoteTotal, items };
}
