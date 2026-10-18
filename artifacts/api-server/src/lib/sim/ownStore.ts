/**
 * Simulator own mode — SQL (logic: own.ts, ownService.ts). Every query is scoped to ONE trader name: the viewer's own
 * trades only; another trader's trade id simply is not found.
 */
import { pool } from "@workspace/db";
import { netPnlSql, horizonSql } from "../tradeMath";
import type { OwnTradeRow } from "./own";

const SELECT = `
  SELECT t.id, t.ticker, left(t.date, 10) AS day, t.side, t.entry, t.exit, t.stop, t.qty, t.pnl, t.fees, t.risk_usd,
         (SELECT a.tf FROM candle_archive a
           WHERE a.symbol = t.ticker AND a.day = left(t.date, 10)::date AND a.tf IN ('1m', '5m')
           ORDER BY (a.tf = '1m') DESC LIMIT 1) AS tf,
         COALESCE((SELECT json_agg(json_build_object('id', e.id, 'kind', e.kind, 'price', e.price, 'qty', e.qty, 'at', e.executed_at)
                                   ORDER BY e.executed_at, e.sort_order, e.id)
                     FROM trade_executions e WHERE e.trade_id = t.id), '[]'::json) AS execs
    FROM trades t
   WHERE t.deleted_at IS NULL AND t.trader = $1 AND ${netPnlSql("t")} < 0 AND ${horizonSql("t")} = 'intraday'
     AND t.ticker ~ '^[A-Z]{1,5}$' AND t.date ~ '^\\d{4}-\\d{2}-\\d{2}' AND left(t.date, 10) <= $2
     AND EXISTS (SELECT 1 FROM candle_archive a WHERE a.symbol = t.ticker AND a.day = left(t.date, 10)::date AND a.tf IN ('1m', '5m'))
     AND EXISTS (SELECT 1 FROM trade_executions e WHERE e.trade_id = t.id AND e.executed_at IS NOT NULL)`;

type DbRow = Omit<OwnTradeRow, "id" | "execs"> & { id: number | string; execs: OwnTradeRow["execs"] };
const fromDb = (r: DbRow): OwnTradeRow => ({ ...r, id: Number(r.id), execs: r.execs ?? [] });

/** The trader's losing intraday trades that can be replayed (archived 1-minute / 5-minute bars, timed fills). */
export async function ownCandidates(trader: string, lastDay: string, limit = 300): Promise<OwnTradeRow[]> {
  const { rows } = await pool.query<DbRow>(`${SELECT} ORDER BY ${netPnlSql("t")} ASC, t.id DESC LIMIT $3`, [trader, lastDay, limit]);
  return rows.map(fromDb);
}

/** One of the trader's replayable trades, or null (not theirs, not a loss, no bars …). */
export async function ownTrade(trader: string, lastDay: string, id: number): Promise<OwnTradeRow | null> {
  const { rows } = await pool.query<DbRow>(`${SELECT} AND t.id = $3`, [trader, lastDay, id]);
  return rows[0] ? fromDb(rows[0]) : null;
}

/** Trade id → newest own game id over it (finished or still active; abandoned ones do not count as played). */
export async function playedOwnTrades(userId: number): Promise<Map<number, number>> {
  const { rows } = await pool.query<{ tid: number; gid: number }>(
    `SELECT (params->'own'->>'tradeId')::int AS tid, max(id)::int AS gid
       FROM sim_games WHERE user_id = $1 AND params ? 'own' AND status <> 'abandoned'
      GROUP BY 1`,
    [userId],
  );
  return new Map(rows.filter((r) => r.tid != null).map((r) => [Number(r.tid), Number(r.gid)]));
}
