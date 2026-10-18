/**
 * Own contract → next-day discipline. The evening card's contract verdict (daily stop / max trades / own rule from the
 * personal plan) adds DISCIPLINE_POINTS to that day's behaviour discipline score (lib/behaviorEngine DisciplineDay:
 * score = 100 − pattern penalties + contract), so the verdict is visible the next day on «Поведение», in the
 * Academy readiness index and wherever the behaviour discipline index is shown.
 *
 * Source of the points per day: the stored snapshot (daily_reviews.verdict.contract, written by lib/daily/service
 * eveningFor once the day is finished) — else computed here from the day's trades and the plan (own rules that need
 * fills or rules data are then «unknown» = 0 points until the snapshot exists).
 */
import { pool } from "@workspace/db";
import type { BehaviorTrade } from "../behaviorEngine";
import { nyDate, nyMinutes } from "../tradingDate";
import { CLOSE_MINUTES } from "../curatorLogic";
import { analyzeWindow, contractOf, isMistakeId, type PlanContract } from "./engine";

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

/**
 * Contract points per finished day in [from, to] for the behaviour discipline score. `trades` = the behaviour rows the
 * caller already loaded for the same period (norms for the own-rule check). Never throws: no data → empty map.
 */
export async function contractDeltas(trader: string, trades: readonly BehaviorTrade[], from: string, to: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const [stored, plans] = await Promise.all([
      pool
        .query<{ date: string; delta: number | null }>(
          `SELECT date, (verdict #>> '{contract,disciplineDelta}')::float8 AS delta FROM daily_reviews
            WHERE trader = $1 AND date >= $2 AND date <= $3 AND verdict ? 'contract'`,
          [trader, from, to],
        )
        .then((r) => r.rows)
        .catch(() => [] as { date: string; delta: number | null }[]),
      loadPlanContracts(trader, from, to),
    ]);
    for (const r of stored) if (r.delta != null && Number.isFinite(r.delta)) out.set(String(r.date), r.delta);
    const missing = [...plans.keys()].filter((d) => !out.has(d) && dayFinished(d)).sort();
    if (missing.length) {
      const a = analyzeWindow({ trades, plans, from: missing[0]!, to: missing[missing.length - 1]! });
      for (const d of missing) {
        const c = contractOf(a, d, plans.get(d));
        if (c && c.disciplineDelta !== 0) out.set(d, c.disciplineDelta);
      }
    }
  } catch {
    return out;
  }
  return out;
}
