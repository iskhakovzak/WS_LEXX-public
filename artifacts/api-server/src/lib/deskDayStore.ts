/**
 * «Деск на тикере» ↔ DB. Loads every live trade of one ticker on one NY trading date (index trades_live_ticker_date_idx),
 * their fills (trade_executions) and classifies them with lib/tradeStructure — the whole day chain of each trader is in
 * the set, so re-entries / flips link right. Shaping and the money rule: lib/deskDay.ts (pure).
 */
import { pool } from "@workspace/db";
import type { MoneyViewer } from "./playbookPrivacy";
import { buildDeskDay, type DeskDay, type DeskTradeRow } from "./deskDay";
import { deskAliases } from "./deskAliases";
import { setting } from "./settings/registry";
import { computeStructures, loadExtremes, type ExecRowLite, type TradeRowLite } from "./tradeStructureStore";

type Queryable = { query: (typeof pool)["query"] };

/** Hard cap on trades of one ticker-day (a desk of ~50 never comes close; keeps a bad day cheap). */
export const DESK_DAY_MAX_TRADES = 400;

type Row = TradeRowLite & DeskTradeRow;

/** Every trader with a live trade on `date` (any ticker) — the desk-wide roster the day aliases are numbered over. */
export async function deskRoster(date: string, q: Queryable = pool): Promise<string[]> {
  const { rows } = await q.query(
    `SELECT DISTINCT trader FROM trades WHERE date = $1 AND deleted_at IS NULL AND trader IS NOT NULL AND trader <> ''`,
    [date],
  );
  return (rows as { trader: string }[]).map((r) => r.trader);
}

/** Day aliases of `date` over the whole desk (same numbers on every ticker and on the top of the day). */
export async function loadDayAliases(date: string, q: Queryable = pool): Promise<Map<string, number>> {
  return deskAliases(await deskRoster(date, q), date);
}

export async function loadDeskDay(
  ticker: string, date: string, viewer: MoneyViewer, q: Queryable = pool,
  hideNames: boolean = setting("privacy.hideNamesFromTraders"),
): Promise<DeskDay> {
  const { rows } = await q.query(
    `SELECT id, trader, broker_account, ticker, date, side, stop, risk_usd, qty, result, source, context_snapshot,
            entry, exit, r_multiple, pnl, fees
       FROM trades
      WHERE ticker = $1 AND date = $2 AND deleted_at IS NULL AND trader IS NOT NULL AND trader <> ''
      ORDER BY id
      LIMIT $3`,
    [ticker, date, DESK_DAY_MAX_TRADES],
  );
  const trades = rows as Row[];
  if (!trades.length) return buildDeskDay(ticker, date, [], new Map(), viewer, { hideNames });
  const ex = await q.query(
    `SELECT id, trade_id, kind, price, qty, executed_at, sort_order, order_id
       FROM trade_executions WHERE trade_id = ANY($1::int[]) ORDER BY trade_id, sort_order, id`,
    [trades.map((t) => t.id)],
  );
  const execs = ex.rows as ExecRowLite[];
  const extremes = await loadExtremes(q, trades, execs);
  const structures = computeStructures(trades, execs, extremes);
  return buildDeskDay(ticker, date, trades, structures, viewer, { hideNames, aliases: await loadDayAliases(date, q) });
}

export interface DeskDayCount {
  ticker: string;
  /** Distinct traders with a live trade of this ticker on the date. */
  traders: number;
  /** Did `trader` (the perspective) trade it? */
  traded: boolean;
  /** traders minus the perspective trader. */
  others: number;
}

/**
 * Cheap counts for entry points («Деск на этом тикере: N трейдеров»): one grouped query on (ticker, date).
 * `trader` = whose perspective «others» is counted from (the trade owner on a trade sheet, the viewer otherwise).
 */
export async function deskDayCounts(tickers: readonly string[], date: string, trader: string | null, q: Queryable = pool): Promise<DeskDayCount[]> {
  if (!tickers.length) return [];
  const { rows } = await q.query(
    `SELECT ticker, COUNT(DISTINCT trader)::int AS traders, COALESCE(BOOL_OR(trader = $3), FALSE) AS traded
       FROM trades
      WHERE ticker = ANY($1::text[]) AND date = $2 AND deleted_at IS NULL AND trader IS NOT NULL AND trader <> ''
      GROUP BY ticker`,
    [tickers, date, trader ?? ""],
  );
  const got = new Map((rows as { ticker: string; traders: number; traded: boolean }[]).map((r) => [r.ticker, r]));
  return tickers.map((t) => {
    const r = got.get(t);
    const traders = r ? Number(r.traders) : 0;
    const traded = !!r?.traded;
    return { ticker: t, traders, traded, others: Math.max(0, traders - (traded ? 1 : 0)) };
  });
}
