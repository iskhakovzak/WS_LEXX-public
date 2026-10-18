/**
 * Nightly prune of the candle CACHES now that finished days live in candle_archive (ARCHITECTURE.md §3.9: caches have a
 * TTL and a nightly prune). The archive itself is never pruned.
 *
 *   candles_cache
 *     1. rows the archive makes redundant: a finished day archived at the same or a finer bar size (and with extended
 *        hours when the row has them) — every reader goes archive-first, so these are never read again;
 *     2. intraday rows (1m–30m) of finished days not refreshed for CANDLES_INTRADAY_TTL_DAYS — leftovers from before
 *        the archive (every finished day read since is archived on first read);
 *     3. hourly / daily rows older than CANDLES_HOURLY_TTL_DAYS (kept long: the simulator's swing mode still builds
 *        daily series from cached hourly bars).
 *   analyst_bars_cache — tickers not refreshed for ANALYST_BARS_TTL_DAYS (no longer on any watchlist).
 *
 * Deletes run in batches so a large first prune never holds long locks.
 */
import { pool } from "@workspace/db";
import { nyDate } from "../tradingDate";

export const CANDLES_INTRADAY_TTL_DAYS = 45;
export const CANDLES_HOURLY_TTL_DAYS = 400;
export const ANALYST_BARS_TTL_DAYS = 30;
const BATCH = 5000;

async function deleteInBatches(sql: string, params: unknown[], signal?: AbortSignal): Promise<number> {
  let total = 0;
  for (;;) {
    if (signal?.aborted) break;
    const r = await pool.query(sql, params);
    const n = r.rowCount ?? 0;
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

export type PruneReport = { redundant: number; intradayTtl: number; hourlyTtl: number; analystBars: number; cacheBytesBefore: number; cacheBytesAfter: number };

export async function pruneCandleCaches(opts: { signal?: AbortSignal } = {}): Promise<PruneReport> {
  const today = nyDate();
  const size = async () => Number((await pool.query(`SELECT pg_total_relation_size('candles_cache') AS b`)).rows[0]?.b ?? 0);
  const cacheBytesBefore = await size();
  const redundant = await deleteInBatches(
    `DELETE FROM candles_cache WHERE id IN (
       SELECT c.id FROM candles_cache c
        WHERE c.date < $1 AND c.interval IN ('1m', '5m', '15m', '30m', '60m')
          AND EXISTS (
            SELECT 1 FROM candle_archive a
             WHERE a.symbol = c.ticker AND a.day::text = c.date AND (a.extended OR NOT c.extended)
               AND (CASE a.tf WHEN '1m' THEN 1 WHEN '5m' THEN 5 WHEN '15m' THEN 15 WHEN '30m' THEN 30 ELSE 60 END)
                <= (CASE c.interval WHEN '1m' THEN 1 WHEN '5m' THEN 5 WHEN '15m' THEN 15 WHEN '30m' THEN 30 ELSE 60 END))
        LIMIT ${BATCH})`,
    [today], opts.signal,
  );
  const intradayTtl = await deleteInBatches(
    `DELETE FROM candles_cache WHERE id IN (
       SELECT id FROM candles_cache
        WHERE date < $1 AND interval IN ('1m', '5m', '15m', '30m') AND fetched_at < now() - make_interval(days => $2)
        LIMIT ${BATCH})`,
    [today, CANDLES_INTRADAY_TTL_DAYS], opts.signal,
  );
  const hourlyTtl = await deleteInBatches(
    `DELETE FROM candles_cache WHERE id IN (
       SELECT id FROM candles_cache WHERE interval IN ('60m', '1d') AND fetched_at < now() - make_interval(days => $1) LIMIT ${BATCH})`,
    [CANDLES_HOURLY_TTL_DAYS], opts.signal,
  );
  let analystBars = 0;
  const { rows: reg } = await pool.query<{ t: string | null }>(`SELECT to_regclass('public.analyst_bars_cache')::text AS t`);
  if (reg[0]?.t) {
    analystBars = (await pool.query(`DELETE FROM analyst_bars_cache WHERE fetched_at < now() - make_interval(days => $1)`, [ANALYST_BARS_TTL_DAYS])).rowCount ?? 0;
  }
  return { redundant, intradayTtl, hourlyTtl, analystBars, cacheBytesBefore, cacheBytesAfter: await size() };
}
