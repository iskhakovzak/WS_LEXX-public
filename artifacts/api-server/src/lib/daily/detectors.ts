/**
 * Daily loop — mistake detectors over one window of a trader's trades. Pure (no I/O); lib/daily/engine.ts assembles
 * them, lib/daily/service.ts feeds them from the DB.
 *
 *   behavior:<PatternKey>   lib/behaviorEngine flags; cost per trade = net − the personal norm of the pattern
 *                           (norms come from the whole `trades` history, not only the window)
 *   structure:averaging     an «add» leg against a losing position (price worse than the average before it);
 *                           cost = P&L of the added shares at the average exit (signed: an add that worked is +)
 *   structure:held_past_stop a closing leg beyond the stop by ≥ STOP_OVERSHOOT_SHARE of the risk per share; cost = the
 *                           overshoot × shares. Without a stop: a loss deeper than NO_STOP_LOSS_MULT × max risk per
 *                           trade (trader_risk_limits) — cost = the part beyond the limit
 *   day:giveback            day peak of cumulative realised net ≥ a meaningful amount, closed ≤ GIVEBACK_CLOSE_SHARE of
 *                           the peak; cost = close − peak
 *   day:fees                fees ≥ FEES_SHARE of a positive gross; cost = −(fees above a healthy FEES_HEALTHY_SHARE
 *                           of the gross) — what trading less would have saved, not every cent of commission
 *   day:after_limit         trades opened after the realised net hit the daily loss limit (plan maxLossUsd, else
 *                           trader_risk_limits.daily_loss_limit); cost = their net
 *   rule:<RuleKind>         lib/rulesEval violations in the window; cost = impactNet (else costNet)
 *
 * Money is net ($, pnl − |fees|); ≤ 0 = cost. Dates are New York trading days.
 */
import { median, patternFlags, type BehaviorTrade } from "../behaviorEngine";
import { evalRule, NO_LIMITS, type RiskLimits, type RuleRow, type TradeForRule } from "../rulesEval";
import { computeStructures, type ExecRowLite, type TradeRowLite } from "../tradeStructureStore";
import type { Leg, TradeStructure } from "../tradeStructure";
import type { MistakeId, TradeRef } from "./types";

export const GIVEBACK_MIN_USD = 50;
export const GIVEBACK_CLOSE_SHARE = 0.2;
export const FEES_SHARE = 0.5;
export const FEES_MIN_USD = 5;
export const FEES_HEALTHY_SHARE = 0.25;
export const STOP_OVERSHOOT_SHARE = 0.25;
export const NO_STOP_LOSS_MULT = 1.25;

/** Own contract of the day (trader_plans.doc). */
export type PlanContract = { maxLossUsd: number | null; maxTrades: number | null; ownRule: MistakeId | null };

export interface DetectInput {
  /** Behaviour rows (routes/behavior rowToBehaviorTrade): the norm history AND the window. */
  trades: readonly BehaviorTrade[];
  /** Structure rows + fills of the window trades (lib/tradeStructureStore shapes). */
  structRows?: readonly TradeRowLite[];
  fills?: readonly ExecRowLite[];
  /** Enabled rules that apply to the trader + the trader's trades in rulesEval shape (sorted by day / entry). */
  rules?: readonly RuleRow[];
  ruleTrades?: readonly TradeForRule[];
  limits?: RiskLimits;
  plans?: ReadonlyMap<string, PlanContract>;
  from: string;
  to: string;
}

/** One mistake on one day: occurrences, Σ cost (null = money unknown) and the trades involved. */
export interface DayHit { count: number; costNet: number | null; refs: TradeRef[] }

export type DayHits = Map<string, Map<MistakeId, DayHit>>;

const round2 = (v: number) => Math.round(v * 100) / 100;
const EPS = 1e-9;

export const refOf = (t: BehaviorTrade): TradeRef => ({ tradeId: t.id, date: t.date, ticker: t.ticker, net: t.net });

/** Collects hits per day and mistake (one hit per trade per mistake; day-level hits have no trade). */
export class HitBook {
  readonly days: DayHits = new Map();
  private seen = new Set<string>();

  add(id: MistakeId, date: string, cost: number | null, ref: TradeRef | null, dedupKey?: string): void {
    const key = `${id}\u0000${dedupKey ?? (ref ? `t${ref.tradeId}` : `d${date}`)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    let day = this.days.get(date);
    if (!day) this.days.set(date, (day = new Map()));
    const h = day.get(id) ?? { count: 0, costNet: null, refs: [] };
    h.count++;
    if (cost != null) h.costNet = round2((h.costNet ?? 0) + cost);
    if (ref) h.refs.push(ref);
    day.set(id, h);
  }
}

/** Window trades by day, ordered by realised time (exit → entry → id). */
export function windowDays(trades: readonly BehaviorTrade[], from: string, to: string): Map<string, BehaviorTrade[]> {
  const out = new Map<string, BehaviorTrade[]>();
  for (const t of trades) {
    if (t.date < from || t.date > to || t.result === "open") continue;
    const l = out.get(t.date);
    if (l) l.push(t); else out.set(t.date, [t]);
  }
  const at = (t: BehaviorTrade) => t.exitAt ?? t.entryAt ?? Number.MAX_SAFE_INTEGER;
  for (const l of out.values()) l.sort((a, b) => at(a) - at(b) || a.id - b.id);
  return new Map([...out.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/** Cumulative realised net path of a day (trades in realised order). */
export function dayPath(day: readonly BehaviorTrade[]): { peak: number; peakIdx: number; trough: number; close: number } {
  let cum = 0, peak = 0, peakIdx = -1, trough = 0;
  day.forEach((t, i) => {
    cum = round2(cum + (t.net ?? 0));
    if (cum > peak) { peak = cum; peakIdx = i; }
    trough = Math.min(trough, cum);
  });
  return { peak, peakIdx, trough, close: cum };
}

// ── behaviour patterns ──────────────────────────────────────────────────────────────────────────────────────────

export function detectBehavior(input: DetectInput, book: HitBook, inWindow: Map<number, BehaviorTrade>): void {
  const flags = patternFlags([...input.trades]);
  for (const [key, f] of flags) {
    if (f.noCost) continue;
    for (const id of f.ids) {
      const t = inWindow.get(id);
      if (!t) continue;
      const cost = t.net != null && f.baselineAvg != null ? round2(t.net - f.baselineAvg) : null;
      book.add(`behavior:${key}`, t.date, cost, refOf(t));
    }
  }
}

// ── trade structure ─────────────────────────────────────────────────────────────────────────────────────────────

function averagingImpact(s: TradeStructure, net: number | null): number | null | undefined {
  const dir = s.stats.side === "short" ? -1 : 1;
  let found = false, impact = 0, known = true;
  let openPx = 0, openQ = 0;
  s.legs.forEach((l: Leg, i: number) => {
    if (!l.opening) return;
    const prev = i > 0 ? s.legs[i - 1] : null;
    const avgBefore = prev?.avgAfter ?? (openQ > 0 ? openPx / openQ : null);
    if (l.role === "add" && avgBefore != null && dir * (l.price - avgBefore) < -EPS) {
      found = true;
      if (l.qty != null && s.stats.avgExit != null) impact += dir * (s.stats.avgExit - l.price) * l.qty;
      else known = false;
    }
    const w = l.qty ?? 1;
    openPx += l.price * w; openQ += w;
  });
  if (!found) return undefined;
  if (!known) return net == null ? null : Math.min(0, net);
  return round2(impact);
}

function stopOvershoot(s: TradeStructure, t: BehaviorTrade, maxRisk: number | null): number | null | undefined {
  const { stopPrice, riskPerShare } = s.stats;
  const dir = s.stats.side === "short" ? -1 : 1;
  if (stopPrice != null && riskPerShare != null && riskPerShare > EPS) {
    const tol = Math.max(0.02, STOP_OVERSHOOT_SHARE * riskPerShare);
    const closing = s.legs.filter((l) => !l.opening);
    let found = false, cost = 0;
    for (const l of closing) {
      if (dir * (stopPrice - l.price) <= tol) continue;
      found = true;
      const q = l.qty ?? (closing.length === 1 ? t.qty : null);
      if (q != null) cost += dir * (l.price - stopPrice) * Math.abs(q);
    }
    return found ? round2(cost) : undefined;
  }
  if (maxRisk != null && maxRisk > 0 && t.net != null && t.net < -NO_STOP_LOSS_MULT * maxRisk) return round2(t.net + maxRisk);
  return undefined;
}

/** Days of the window where structure mistakes can be judged (fills with sizes / a stop or a per-trade risk limit). */
export type StructureCoverage = { averaging: Set<string>; stop: Set<string> };

export function detectStructure(input: DetectInput, book: HitBook, inWindow: Map<number, BehaviorTrade>): StructureCoverage {
  const cover: StructureCoverage = { averaging: new Set(), stop: new Set() };
  const rows = (input.structRows ?? []).filter((r) => inWindow.has(r.id));
  if (!rows.length) return cover;
  const structures = computeStructures(rows, input.fills ?? []);
  const maxRisk = input.limits?.maxRiskPerTrade ?? null;
  for (const [id, s] of structures) {
    const t = inWindow.get(id);
    if (!t) continue;
    if (s.stats.fidelity === "fills" && s.legs.length > 0 && s.legs.every((l) => l.qty != null)) cover.averaging.add(t.date);
    if (s.stats.stopPrice != null || (maxRisk != null && maxRisk > 0)) cover.stop.add(t.date);
    const avg = averagingImpact(s, t.net);
    if (avg !== undefined) book.add("structure:averaging", t.date, avg, refOf(t));
    const over = stopOvershoot(s, t, maxRisk);
    if (over !== undefined) book.add("structure:held_past_stop", t.date, over, refOf(t));
  }
  return cover;
}

// ── day level ───────────────────────────────────────────────────────────────────────────────────────────────────

/** «Meaningful» peak for a giveback: the larger of GIVEBACK_MIN_USD and the trader's median green day. */
export function givebackThreshold(trades: readonly BehaviorTrade[]): number {
  const byDay = new Map<string, number>();
  for (const t of trades) if (t.net != null) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.net);
  const green = [...byDay.values()].filter((v) => v > 0);
  return Math.max(GIVEBACK_MIN_USD, green.length ? round2(median(green)) : 0);
}

export function dailyLossLimit(input: DetectInput, date: string): number | null {
  const plan = input.plans?.get(date)?.maxLossUsd ?? null;
  const v = plan != null && plan > 0 ? plan : input.limits?.dailyLossLimit ?? null;
  return v != null && v > 0 ? v : null;
}

export function detectDay(input: DetectInput, book: HitBook, days: Map<string, BehaviorTrade[]>): void {
  const thr = givebackThreshold(input.trades);
  for (const [date, day] of days) {
    const p = dayPath(day);
    if (p.peak >= thr && p.close <= GIVEBACK_CLOSE_SHARE * p.peak) {
      const after = day.slice(p.peakIdx + 1).filter((t) => (t.net ?? 0) < 0).sort((a, b) => (a.net ?? 0) - (b.net ?? 0));
      book.add("day:giveback", date, round2(p.close - p.peak), null);
      const h = book.days.get(date)?.get("day:giveback");
      if (h) h.refs = after.slice(0, 5).map(refOf);
    }
    let gross = 0, fees = 0;
    for (const t of day) if (t.gross != null && t.net != null) { gross += t.gross; fees += Math.max(0, t.gross - t.net); }
    if (gross > 0 && fees >= FEES_MIN_USD && fees >= FEES_SHARE * gross) book.add("day:fees", date, round2(-(fees - FEES_HEALTHY_SHARE * gross)), null);
    const limit = dailyLossLimit(input, date);
    if (limit != null) {
      let cum = 0, hitAt: number | null = null, hitIdx = -1;
      day.forEach((t, i) => {
        cum += t.net ?? 0;
        if (hitIdx < 0 && cum <= -limit) { hitIdx = i; hitAt = t.exitAt ?? t.entryAt; }
      });
      if (hitIdx >= 0) {
        day.forEach((t, i) => {
          const later = hitAt != null && t.entryAt != null ? t.entryAt > hitAt : i > hitIdx;
          if (later) book.add("day:after_limit", date, t.net, refOf(t));
        });
      }
    }
  }
}

// ── rules ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Rule kinds the trader has (enabled, checkable from trades). */
export function ruleKinds(rules: readonly RuleRow[] | undefined): Set<string> {
  return new Set((rules ?? []).filter((r) => r.enabled && r.kind !== "self_check").map((r) => r.kind));
}

export function detectRules(input: DetectInput, book: HitBook, byId: Map<number, BehaviorTrade>): void {
  const rules = (input.rules ?? []).filter((r) => r.enabled && r.kind !== "self_check");
  if (!rules.length || !input.ruleTrades?.length) return;
  const trades = [...input.ruleTrades];
  for (const rule of rules) {
    for (const d of evalRule(rule, trades, input.limits ?? NO_LIMITS)) {
      if (d.day < input.from || d.day > input.to) continue;
      const t = d.tradeId != null ? byId.get(d.tradeId) : undefined;
      const ref = t ? refOf(t) : null;
      book.add(`rule:${rule.kind}`, d.day, d.impactNet ?? d.costNet ?? null, ref, d.tradeId != null ? `t${d.tradeId}` : `k${d.key}`);
    }
  }
}
