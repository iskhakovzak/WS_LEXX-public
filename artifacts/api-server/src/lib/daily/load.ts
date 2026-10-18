/**
 * Daily loop — DB loaders for the engine (lib/daily/engine.ts): behaviour rows (norm history + window), structure rows
 * and fills of the window trades, the trader's enabled rules with their trades in rulesEval shape, risk limits and the
 * personal plan contracts. One call per (trader, period); everything optional degrades to «no data».
 */
import { pool } from "@workspace/db";
import { loadBehaviorRows, rowToBehaviorTrade } from "../../routes/behavior";
import { fetchRiskLimits, fetchRulesFor, fetchTrades } from "../rulesEngine";
import { NO_LIMITS } from "../rulesEval";
import { resultSql } from "../tradeMath";
import { addDays } from "../tradingDate";
import { logger } from "../logger";
import type { ExecRowLite, TradeRowLite } from "../tradeStructureStore";
import { loadPlanContracts } from "./discipline";
import { NORM_HISTORY_DAYS, type DetectInput } from "./engine";

export type DailyContext = Omit<DetectInput, "from" | "to"> & { trader: string; loadedFrom: string; loadedTo: string };

async function structRowsOf(trader: string, from: string, to: string): Promise<TradeRowLite[]> {
  const { rows } = await pool.query<TradeRowLite>(
    `SELECT t.id, t.trader, t.broker_account, t.ticker, t.date, t.side, t.stop, t.risk_usd, t.qty, ${resultSql("t")} AS result, t.source,
            CASE WHEN t.context_snapshot->>'fromReport' = 'true' THEN '{"fromReport":true}'::jsonb END AS context_snapshot
       FROM trades t
      WHERE t.trader = $1 AND t.deleted_at IS NULL AND substring(t.date, 1, 10) >= $2 AND substring(t.date, 1, 10) <= $3`,
    [trader, from, to],
  );
  return rows;
}

async function fillsOf(ids: readonly number[]): Promise<ExecRowLite[]> {
  if (!ids.length) return [];
  const { rows } = await pool.query<ExecRowLite>(
    `SELECT id, trade_id, kind, price, qty, executed_at, sort_order, order_id
       FROM trade_executions WHERE trade_id = ANY($1::int[]) ORDER BY trade_id, sort_order, id`,
    [ids],
  );
  return rows;
}

const soft = <T>(p: Promise<T>, fallback: T, what: string): Promise<T> =>
  p.catch((err: unknown) => {
    logger.warn({ err: (err as Error)?.message, what }, "daily: optional data unavailable");
    return fallback;
  });

/**
 * Everything the engine needs for windows inside [from, to]: behaviour rows from `from − NORM_HISTORY_DAYS`, structure
 * rows + fills for [from, to], enabled rules (+ the trader's trades when there are any), risk limits, plan contracts.
 */
export async function loadDailyContext(trader: string, from: string, to: string): Promise<DailyContext> {
  const histFrom = addDays(from, -NORM_HISTORY_DAYS);
  const [rows, structRows, rules, limits, plans] = await Promise.all([
    loadBehaviorRows(trader, histFrom, to),
    soft(structRowsOf(trader, from, to), [] as TradeRowLite[], "structure rows"),
    soft(fetchRulesFor(trader, { enabledOnly: true }), [], "rules"),
    soft(fetchRiskLimits(trader), NO_LIMITS, "risk limits"),
    loadPlanContracts(trader, from, to),
  ]);
  const [fills, ruleTrades] = await Promise.all([
    soft(fillsOf(structRows.map((r) => Number(r.id))), [] as ExecRowLite[], "fills"),
    rules.some((r) => r.kind !== "self_check") ? soft(fetchTrades(trader), [], "rule trades") : Promise.resolve([]),
  ]);
  return {
    trader,
    trades: rows.map(rowToBehaviorTrade),
    structRows,
    fills,
    rules,
    ruleTrades: ruleTrades.filter((t) => t.date.slice(0, 10) >= histFrom && t.date.slice(0, 10) <= to),
    limits,
    plans,
    loadedFrom: from,
    loadedTo: to,
  };
}

/** Engine input for the window [from, to] out of a loaded context (trades after `to` are left out of the norms). */
export function inputFor(ctx: DailyContext, from: string, to: string): DetectInput {
  return { ...ctx, trades: ctx.trades.filter((t) => t.date <= to), from, to };
}

/** Other desk traders with a trade in `ticker` on `date` (count only — never their money). */
export async function deskTradersOn(ticker: string, date: string, except: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(DISTINCT trader)::int AS n FROM trades
      WHERE deleted_at IS NULL AND UPPER(ticker) = $1 AND substring(date, 1, 10) = $2 AND trader IS NOT NULL AND trader <> $3`,
    [ticker.toUpperCase(), date, except],
  );
  return Number(rows[0]?.n ?? 0);
}
