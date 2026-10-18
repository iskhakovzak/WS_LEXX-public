/**
 * Nightly rewards run (job «rewards.nightly», src/jobs/definitions.ts, weekdays after the evening sync): for every
 * trader who traded or had a personal-plan contract on the last finished day — writes the missing evening snapshots
 * of the last BACKFILL_DAYS plan days (so the scale judges own rules with fills, not «unknown») and re-evaluates the
 * rewards (lib/daily/rewards.ts: awards new badges once and notifies). Idempotent: a re-run awards and notifies nothing.
 */
import { pool } from "@workspace/db";
import { logger } from "../logger";
import { addDays } from "../tradingDate";
import { lastFinishedDay } from "./discipline";
import { evaluateRewards } from "./rewards";
import { eveningFor } from "./service";

const BACKFILL_DAYS = 30;

export async function runRewardsNightly(o: { now?: Date; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
  const now = o.now ?? new Date();
  const date = lastFinishedDay(now);
  const from = addDays(date, -BACKFILL_DAYS);
  const { rows } = await pool.query<{ trader: string }>(
    `SELECT DISTINCT trader FROM (
       SELECT trader FROM trades WHERE deleted_at IS NULL AND trader IS NOT NULL AND substring(date, 1, 10) = $1
       UNION SELECT trader FROM trader_plans WHERE deleted_at IS NULL AND date = $1
     ) x WHERE EXISTS (SELECT 1 FROM users u WHERE u.name = x.trader AND u.active = true)`,
    [date],
  );
  let snapshots = 0, awarded = 0, failed = 0;
  for (const { trader } of rows) {
    if (o.signal?.aborted) break;
    try {
      // Counted before the snapshots: eveningFor of the last finished day already evaluates (and awards) on its own.
      const before = (await pool.query(`SELECT 1 FROM trader_badges WHERE trader = $1`, [trader])).rowCount ?? 0;
      const { rows: missing } = await pool.query<{ date: string }>(
        `SELECT p.date FROM trader_plans p
          WHERE p.trader = $1 AND p.deleted_at IS NULL AND p.date >= $2 AND p.date <= $3
            AND (p.doc ? 'maxLossUsd' OR p.doc ? 'maxTrades' OR p.doc ? 'ownRule')
            AND NOT EXISTS (SELECT 1 FROM daily_reviews r WHERE r.trader = p.trader AND r.date = p.date AND jsonb_typeof(r.verdict -> 'contract') = 'object')
          ORDER BY p.date`,
        [trader, from, date],
      );
      const days = new Set([...missing.map((m) => String(m.date)), date]);
      for (const d of [...days].sort()) {
        await eveningFor(trader, d);
        snapshots++;
      }
      await evaluateRewards(trader, now);
      awarded += Math.max(0, ((await pool.query(`SELECT 1 FROM trader_badges WHERE trader = $1`, [trader])).rowCount ?? 0) - before);
    } catch (err) {
      failed++;
      logger.warn({ err: (err as Error)?.message, trader }, "rewards.nightly: trader failed");
    }
  }
  return { date, traders: rows.length, snapshots, awarded, failed };
}
