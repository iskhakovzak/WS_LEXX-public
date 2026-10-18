/**
 * Own contract → discipline points, streak and level (owner 2026-10-18: «+5 / −15 правильно, и можно прогрессивную
 * шкалу при накоплении и какие-то награды»). Rewards follow the RULES, never trading activity or P&L: a day without a
 * contract (or without trades) neither grows nor breaks the streak, so nobody is pushed to trade every day.
 *
 * Progressive scale (all numbers are desk settings, lib/settings/registry `discipline.*`):
 *   item points  each contract item (daily stop / max trades / own rule): kept +contractKeptPoints (5),
 *                broken contractBrokenPoints (−15); no trades / unknown / unset 0
 *   day outcome  broken when any item is broken; kept when at least one item is kept and none broken; else «none»
 *   kept day     item points + bonus, bonus = min(streakBonusCapPoints (10), streakStepPoints (1) × kept days in a row
 *                before it) → one item: day 1 +5, day 2 +6 … day 11 and later +15
 *   broken day   item points (the penalty), no bonus; the streak restarts from 0 (streakOnBreak «reset», default) or
 *                keeps half («halve»)
 *   none         0 points, the streak stays as it is (weekends, holidays, days off, days without a contract)
 * The day's actual points are ContractVerdict.disciplineDelta (lib/daily/service eveningFor writes them into the
 * snapshot) and feed the behaviour discipline score (lib/behaviorEngine DisciplineDay.contract) through contractDeltas.
 *
 * Accumulation: points over the last `discipline.pointsWindowDays` (30) trading days = the current form; all-time points
 * = the level (rewards.level1..4Points: 50 / 150 / 400 / 800). The level follows the all-time total because progress
 * that is not lost on the 1st of a month keeps new traders going; a broken day still costs points.
 *
 * Source per day: the stored evening snapshot (daily_reviews.verdict.contract — item statuses; points are recomputed
 * with the current settings) — else computed from the day's trades and the plan (own rules that need fills or rules
 * data are then «unknown» = 0 points until the snapshot exists; the nightly rewards job writes the snapshots).
 */
import { pool } from "@workspace/db";
import type { BehaviorTrade } from "../behaviorEngine";
import { addDays, isWeekend, nyDate, nyMinutes } from "../tradingDate";
import { CLOSE_MINUTES } from "../curatorLogic";
import { setting } from "../settings/registry";
import { analyzeWindow, contractOf, isMistakeId, type PlanContract } from "./engine";
import type { ContractVerdict, DisciplineSummary, VerdictStatus } from "./types";

/** trader_plans.doc → the own contract (null fields when absent / malformed). */
export function planContractOf(doc: unknown): PlanContract {
  const d = (doc && typeof doc === "object" ? doc : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { maxLossUsd: n(d.maxLossUsd), maxTrades: n(d.maxTrades), ownRule: isMistakeId(d.ownRule) ? d.ownRule : null };
}

/** Is the NY trading day `date` over (a past day, or today after the close)? */
export function dayFinished(date: string, now = new Date()): boolean {
  const today = nyDate(now);
  return date < today || (date === today && nyMinutes(now) >= CLOSE_MINUTES);
}

/** The last finished NY trading day at `now` (today after the close, else the previous weekday). */
export function lastFinishedDay(now = new Date()): string {
  let d = nyDate(now);
  if (!(nyMinutes(now) >= CLOSE_MINUTES && !isWeekend(d))) d = addDays(d, -1);
  for (let i = 0; i < 7 && isWeekend(d); i++) d = addDays(d, -1);
  return d;
}

/** Personal plans of a trader in [from, to] that set any contract field. */
export async function loadPlanContracts(trader: string, from: string, to: string): Promise<Map<string, PlanContract>> {
  const { rows } = await pool
    .query<{ date: string; doc: unknown }>(
      `SELECT date, doc FROM trader_plans
        WHERE trader = $1 AND date >= $2 AND date <= $3 AND deleted_at IS NULL
          AND (doc ? 'maxLossUsd' OR doc ? 'maxTrades' OR doc ? 'ownRule')`,
      [trader, from, to],
    )
    .catch(() => ({ rows: [] as { date: string; doc: unknown }[] }));
  const out = new Map<string, PlanContract>();
  for (const r of rows) {
    const c = planContractOf(r.doc);
    if (c.maxLossUsd != null || c.maxTrades != null || c.ownRule != null) out.set(String(r.date).slice(0, 10), c);
  }
  return out;
}

// ─── progressive scale (pure) ───────────────────────────────────────────────

export type ItemStatus = VerdictStatus | "unset";
export type DayOutcome = "kept" | "broken" | "none";
export type ScaleConfig = { kept: number; broken: number; step: number; cap: number; onBreak: "reset" | "halve" };
/** One contract day: the statuses of its items (daily stop, max trades, own rule). */
export type ContractDay = { date: string; items: readonly ItemStatus[] };
/** The day on the scale: its outcome, actual points (item points + bonus), the bonus part, the streak AFTER the day. */
export type LedgerDay = { date: string; outcome: DayOutcome; points: number; bonus: number; streak: number };

/** The scale from the desk settings. */
export function scaleConfig(): ScaleConfig {
  return {
    kept: setting("discipline.contractKeptPoints"),
    broken: setting("discipline.contractBrokenPoints"),
    step: setting("discipline.streakStepPoints"),
    cap: setting("discipline.streakBonusCapPoints"),
    onBreak: setting("discipline.streakOnBreak") === "halve" ? "halve" : "reset",
  };
}

export function contractItems(c: Pick<ContractVerdict, "maxLoss" | "maxTrades" | "rule">): ItemStatus[] {
  return [c.maxLoss?.status ?? "unset", c.maxTrades?.status ?? "unset", c.rule?.status ?? "unset"];
}

export function outcomeOf(items: readonly ItemStatus[]): DayOutcome {
  if (items.includes("broken")) return "broken";
  return items.includes("kept") ? "kept" : "none";
}

export function itemPoints(items: readonly ItemStatus[], cfg: ScaleConfig): number {
  return items.reduce((s, i) => s + (i === "kept" ? cfg.kept : i === "broken" ? cfg.broken : 0), 0);
}

/** Bonus of a kept day after `streakBefore` kept days in a row. */
export function streakBonus(streakBefore: number, cfg: ScaleConfig): number {
  return Math.max(0, Math.min(cfg.cap, cfg.step * Math.max(0, streakBefore)));
}

/** The scale over contract days (any order; duplicates — the last one wins). */
export function scaleLedger(days: readonly ContractDay[], cfg: ScaleConfig): LedgerDay[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  let streak = 0;
  const out: LedgerDay[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const items = byDate.get(date)!.items;
    const outcome = outcomeOf(items);
    const base = itemPoints(items, cfg);
    if (outcome === "kept") {
      const bonus = streakBonus(streak, cfg);
      streak += 1;
      out.push({ date, outcome, points: base + bonus, bonus, streak });
    } else if (outcome === "broken") {
      streak = cfg.onBreak === "halve" ? Math.floor(streak / 2) : 0;
      out.push({ date, outcome, points: base, bonus: 0, streak });
    } else {
      out.push({ date, outcome, points: 0, bonus: 0, streak });
    }
  }
  return out;
}

// ─── levels and the summary (pure) ──────────────────────────────────────────

/** Level thresholds from the settings: [0, level1, level2, …], ascending. */
export function levelThresholds(): number[] {
  const t = [setting("rewards.level1Points"), setting("rewards.level2Points"), setting("rewards.level3Points"), setting("rewards.level4Points")];
  return [0, ...t.filter((v) => v > 0).sort((a, b) => a - b)];
}

export function levelOf(points: number, thresholds: readonly number[]): { level: number; levelFrom: number; nextLevelAt: number | null } {
  let level = 0;
  for (let i = 1; i < thresholds.length; i++) if (points >= thresholds[i]!) level = i;
  return { level, levelFrom: thresholds[level] ?? 0, nextLevelAt: thresholds[level + 1] ?? null };
}

/** First day of the `n` weekdays ending at `to` (inclusive). */
export function windowStart(to: string, n: number): string {
  let d = to, k = isWeekend(to) ? 0 : 1;
  while (k < n) {
    d = addDays(d, -1);
    if (!isWeekend(d)) k++;
  }
  return d;
}

/** Streak, points (window + all time) and level as of the finished day `asOf`. */
export function summaryOf(ledger: readonly LedgerDay[], asOf: string, o: { cfg: ScaleConfig; thresholds: readonly number[]; windowDays: number }): DisciplineSummary {
  const upTo = ledger.filter((d) => d.date <= asOf);
  const from = windowStart(asOf, o.windowDays);
  const total = upTo.reduce((s, d) => s + d.points, 0);
  const recent = upTo.filter((d) => d.date >= from).reduce((s, d) => s + d.points, 0);
  const streak = upTo.length ? upTo[upTo.length - 1]!.streak : 0;
  const bestStreak = upTo.reduce((m, d) => Math.max(m, d.streak), 0);
  return {
    streak, bestStreak, nextBonus: streakBonus(streak, o.cfg), points30: recent, pointsTotal: total, windowDays: o.windowDays,
    ...levelOf(Math.max(0, total), o.thresholds),
  };
}

// ─── DB ─────────────────────────────────────────────────────────────────────

type StoredContract = Pick<ContractVerdict, "maxLoss" | "maxTrades" | "rule">;

async function storedContracts(trader: string, to: string): Promise<Map<string, ItemStatus[]>> {
  const { rows } = await pool
    .query<{ date: string; c: StoredContract | null }>(
      `SELECT date, verdict -> 'contract' AS c FROM daily_reviews
        WHERE trader = $1 AND date <= $2 AND jsonb_typeof(verdict -> 'contract') = 'object'`,
      [trader, to],
    )
    .catch(() => ({ rows: [] as { date: string; c: StoredContract | null }[] }));
  return new Map(rows.filter((r) => r.c).map((r) => [String(r.date), contractItems(r.c!)]));
}

export type LedgerOpts = {
  /** Last day to include (default: the last finished day). */
  to?: string;
  /** Behaviour rows covering the days that have a plan but no snapshot yet (norms included). */
  trades?: readonly BehaviorTrade[];
  /** Loads those rows when `trades` is not given (routes/behavior loadBehaviorRows — passed in to avoid an import cycle). */
  loadTrades?: (from: string, to: string) => Promise<BehaviorTrade[]>;
  /** A freshly computed verdict that replaces the stored one for its day (eveningFor). */
  override?: ContractVerdict | null;
  now?: Date;
};

/** Every contract day of the trader up to `to` on the progressive scale. Never throws (no data → []). */
export async function contractLedger(trader: string, o: LedgerOpts = {}): Promise<LedgerDay[]> {
  const now = o.now ?? new Date();
  const to = o.to ?? lastFinishedDay(now);
  try {
    const [stored, plans] = await Promise.all([storedContracts(trader, to), loadPlanContracts(trader, "2000-01-01", to)]);
    const days = new Map(stored);
    const missing = [...plans.keys()].filter((d) => !days.has(d) && d <= to && dayFinished(d, now) && d !== o.override?.date).sort();
    if (missing.length) {
      const from = missing[0]!, last = missing[missing.length - 1]!;
      const trades = o.trades ?? (o.loadTrades ? await o.loadTrades(addDays(from, -90), last).catch(() => []) : []);
      const a = analyzeWindow({ trades: trades.filter((t) => t.date <= last), plans, from, to: last });
      for (const d of missing) {
        const c = contractOf(a, d, plans.get(d));
        if (c) days.set(d, contractItems(c));
      }
    }
    if (o.override) days.set(o.override.date, contractItems(o.override));
    return scaleLedger([...days].map(([date, items]) => ({ date, items })), scaleConfig());
  } catch {
    return [];
  }
}

/** The finished day's verdict with its actual points on the scale, and the streak after it. */
export async function scaleVerdict(trader: string, c: ContractVerdict, trades?: readonly BehaviorTrade[]): Promise<{ contract: ContractVerdict; streak: number }> {
  const ledger = await contractLedger(trader, { to: c.date, trades, override: c });
  const day = ledger.find((d) => d.date === c.date);
  return day ? { contract: { ...c, disciplineDelta: day.points }, streak: day.streak } : { contract: c, streak: 0 };
}

/** Streak / points / level of a trader now. */
export async function disciplineSummary(trader: string, o: Pick<LedgerOpts, "loadTrades" | "now"> = {}): Promise<{ summary: DisciplineSummary; ledger: LedgerDay[] }> {
  const asOf = lastFinishedDay(o.now ?? new Date());
  const ledger = await contractLedger(trader, { ...o, to: asOf });
  const summary = summaryOf(ledger, asOf, { cfg: scaleConfig(), thresholds: levelThresholds(), windowDays: setting("discipline.pointsWindowDays") });
  return { summary, ledger };
}

/**
 * Contract points per finished day in [from, to] for the behaviour discipline score (the scale runs over the whole
 * history, so the streak bonus is right). `trades` = the behaviour rows the caller already loaded for the same period.
 * Never throws: no data → empty map.
 */
export async function contractDeltas(trader: string, trades: readonly BehaviorTrade[], from: string, to: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ledger = await contractLedger(trader, { to, trades });
  for (const d of ledger) if (d.date >= from && d.date <= to && d.points !== 0) out.set(d.date, d.points);
  return out;
}
