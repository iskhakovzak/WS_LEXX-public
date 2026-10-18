/**
 * «Топ дня» ↔ DB. One grouped query per call over live trades of a NY date / month (indexes trades_live_date_id_idx
 * (date, id) and trades_live_ticker_date_idx); fill times via trade_executions_trade_idx. Shaping and the privacy
 * policy: lib/topDay.ts (pure).
 */
import { pool } from "@workspace/db";
import { netPnlSql } from "./tradeMath";
import type { CalendarRow, TraderTickerRow, TraderTickerSideRow } from "./topDay";

type Queryable = { query: (typeof pool)["query"] };

const LIVE = `t.deleted_at IS NULL AND t.trader IS NOT NULL AND t.trader <> ''`;
const NET = netPnlSql("t");

/** First day of the month after `month` (YYYY-MM) as YYYY-MM-DD. */
export function nextMonthStart(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

/** Per trading date of `month`: desk net, trades, traders, best / worst trader-day net, the viewer's own net. */
export async function loadCalendarRows(month: string, viewerName: string | null, q: Queryable = pool): Promise<{ rows: CalendarRow[]; holidays: string[] }> {
  const from = `${month}-01`;
  const to = nextMonthStart(month);
  const [days, hol] = await Promise.all([
    q.query(
      `WITH td AS (
         SELECT t.date, t.trader, SUM(${NET}) AS net, COUNT(*)::int AS n
           FROM trades t
          WHERE t.date >= $1 AND t.date < $2 AND ${LIVE}
          GROUP BY t.date, t.trader
       )
       SELECT date, SUM(net) AS net, SUM(n)::int AS trades, COUNT(*)::int AS traders, MAX(net) AS best, MIN(net) AS worst,
              SUM(net) FILTER (WHERE trader = $3) AS mine, COALESCE(BOOL_OR(trader = $3), FALSE) AS traded
         FROM td GROUP BY date ORDER BY date`,
      [from, to, viewerName ?? ""],
    ),
    q.query(`SELECT DISTINCT date FROM holiday_calendar WHERE type = 'holiday' AND date >= $1 AND date < $2`, [from, to]),
  ]);
  return { rows: days.rows as CalendarRow[], holidays: (hol.rows as { date: string }[]).map((r) => String(r.date)) };
}

/** Every (trader, ticker) of `date` with net, trades, wins, losses. */
export async function loadDayRows(date: string, q: Queryable = pool): Promise<TraderTickerRow[]> {
  const { rows } = await q.query(
    `SELECT t.trader, t.ticker, SUM(${NET}) AS net, COUNT(*)::int AS trades,
            COUNT(*) FILTER (WHERE ${NET} > 0)::int AS wins, COUNT(*) FILTER (WHERE ${NET} < 0)::int AS losses
       FROM trades t
      WHERE t.date = $1 AND ${LIVE}
      GROUP BY t.trader, t.ticker`,
    [date],
  );
  return rows as TraderTickerRow[];
}

/**
 * Every (trader, ticker, side) of `date` with first / last fill time. The whole day is read (not one trader): the
 * trader's place among the day's traders needs everyone's net; a desk day is a few hundred trades.
 */
export async function loadDaySideRows(date: string, q: Queryable = pool): Promise<TraderTickerSideRow[]> {
  const { rows } = await q.query(
    `SELECT t.trader, t.ticker, t.side, SUM(${NET}) AS net, COUNT(*)::int AS trades,
            COUNT(*) FILTER (WHERE ${NET} > 0)::int AS wins, COUNT(*) FILTER (WHERE ${NET} < 0)::int AS losses,
            MIN(x.first_at) AS first_at, MAX(x.last_at) AS last_at
       FROM trades t
       LEFT JOIN LATERAL (
         SELECT MIN(e.executed_at) AS first_at, MAX(e.executed_at) AS last_at FROM trade_executions e WHERE e.trade_id = t.id
       ) x ON TRUE
      WHERE t.date = $1 AND ${LIVE}
      GROUP BY t.trader, t.ticker, t.side`,
    [date],
  );
  return rows as TraderTickerSideRow[];
}
