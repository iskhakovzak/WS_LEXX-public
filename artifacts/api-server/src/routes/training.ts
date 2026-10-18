/**
 * Training tasks for the chart-lab «Тренировка» (read-only).
 *
 *   GET /api/training/pool?source=&side=&result=&ticker=&from=&to=   — how many tasks match, per bar resolution
 *   GET /api/training/task?…same…&res=1m|5m|any&exclude=t12,d:AAPL:2026-10-14 — one random task (no hints: only
 *       the ticker, day and the finest bars the day has; trader / side / result come after the reveal)
 *   GET /api/training/trades/:id — the trade, its fills and structure for the training chart. Own trades in full;
 *       someone else's (source «desk») with $ / size nulled for non-staff (lib/playbookPrivacy).
 *
 * Resolution: a day has 1-minute bars when the provider still serves them (≤ 29 days) or they are stored (candle_archive /
 * candles_cache), 5-minute when ≤ 59 days old or stored — otherwise only hourly (lib/candleLimits). Picking tasks by default only from days with
 * 1m / 5m bars is what keeps the minute timeframes available in training.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { isGuestUser } from "../lib/auth";
import { loadMoneyViewer } from "../lib/playbookAccess";
import { structureForTrade } from "../lib/tradeStructureStore";
import { nyDate, nyMinutes } from "../lib/tradingDate";
import { logger } from "../lib/logger";
import {
  buildTrainingTradePayload, canTrainOnTrades, candidateOf, parseTaskFilters, pickTask, resolutionCounts, taskKey,
  type TaskCandidate, type TaskFilters,
} from "../lib/trainingTasks";
import { AppError, badRequest, notFound } from "../lib/http";
import { langOf } from "../i18n";

const router: IRouter = Router();

/** Last day a task may be on: today only once the regular session is over (a live day has no end yet). */
function lastTaskDay(): string {
  const today = nyDate();
  if (nyMinutes() >= 16 * 60) return today;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Minute bars a day has in storage: the permanent candle archive (lib/candleArchive) or, for the live day / days not
// archived yet, candles_cache.
const CACHE_FLAGS = `
  SELECT tk, d, bool_or(m1) AS m1, bool_or(m5) AS m5 FROM (
    SELECT upper(ticker) AS tk, date::text AS d, interval = '1m' AS m1, interval = '5m' AS m5
      FROM candles_cache
     WHERE extended AND interval IN ('1m', '5m')
    UNION ALL
    SELECT symbol, day::text, tf = '1m', tf IN ('1m', '5m') FROM candle_archive WHERE extended AND tf IN ('1m', '5m')
  ) s
  GROUP BY 1, 2`;

async function loadCandidates(f: TaskFilters, viewerName: string | null): Promise<TaskCandidate[]> {
  const params: unknown[] = [lastTaskDay()];
  const where: string[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (f.source === "day") {
    if (f.ticker) add("x.tk = ?", f.ticker);
    if (f.from) add("x.d >= ?", f.from);
    if (f.to) add("x.d <= ?", f.to);
    const { rows } = await pool.query(
      `WITH c AS (${CACHE_FLAGS}),
            x AS (SELECT tk, d FROM c UNION SELECT upper(ticker), left(date, 10) FROM trades WHERE deleted_at IS NULL)
       SELECT x.tk AS ticker, x.d AS date, c.m1, c.m5
         FROM x LEFT JOIN c ON c.tk = x.tk AND c.d = x.d
        WHERE x.d <= $1 ${where.map((w) => `AND ${w}`).join(" ")}
        LIMIT 20000`,
      params,
    );
    return rows.map((r) => candidateOf({ ticker: r.ticker, date: r.date, m1: r.m1, m5: r.m5 })).filter((c): c is TaskCandidate => c != null);
  }
  if (f.source === "mine") add("t.trader = ?", viewerName ?? "");
  if (f.side) add("lower(t.side) = ?", f.side);
  if (f.result) add("t.result = ?", f.result);
  if (f.ticker) add("upper(t.ticker) = ?", f.ticker);
  if (f.from) add("left(t.date, 10) >= ?", f.from);
  if (f.to) add("left(t.date, 10) <= ?", f.to);
  const { rows } = await pool.query(
    `WITH c AS (${CACHE_FLAGS})
     SELECT t.id, t.ticker, left(t.date, 10) AS date, c.m1, c.m5
       FROM trades t
       LEFT JOIN c ON c.tk = upper(t.ticker) AND c.d = left(t.date, 10)
      WHERE t.deleted_at IS NULL AND t.entry IS NOT NULL AND t.exit IS NOT NULL AND left(t.date, 10) <= $1
        ${where.map((w) => `AND ${w}`).join(" ")}
      ORDER BY t.id DESC
      LIMIT 20000`,
    params,
  );
  return rows.map((r) => candidateOf({ id: r.id, ticker: r.ticker, date: r.date, m1: r.m1, m5: r.m5 })).filter((c): c is TaskCandidate => c != null);
}

/** Viewer + whether they may use trade sources. Desk / mine need a signed-in member; «day» is open to guests too. */
async function viewerFor(req: Request): Promise<{ name: string | null; staff: boolean; member: boolean }> {
  const v = await loadMoneyViewer(req);
  return { ...v, member: canTrainOnTrades(v, isGuestUser(req.authUser)) };
}

router.get("/training/pool", asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const f = parseTaskFilters(req.query as Record<string, unknown>);
  const v = await viewerFor(req);
  if (f.source !== "day" && !v.member) { res.json({ source: f.source, counts: resolutionCounts([]), member: false }); return; }
  const list = await loadCandidates(f, v.name);
  res.json({ source: f.source, counts: resolutionCounts(list), member: v.member });
}));

router.get("/training/task", asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const f = parseTaskFilters(req.query as Record<string, unknown>);
  const v = await viewerFor(req);
  if (f.source !== "day" && !v.member) throw new AppError("MEMBERS_ONLY");
  const list = await loadCandidates(f, v.name);
  const counts = resolutionCounts(list);
  const task = pickTask(list, f.res, f.exclude);
  if (!task) throw new AppError("NO_TASKS", 404, undefined, { counts });
  res.json({ task: { ...task, key: taskKey(task), source: f.source }, counts });
}));

router.get("/training/trades/:id", asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const { rows } = await pool.query(
    `SELECT id, ticker, date, side, entry, exit, stop, qty, pnl, fees, risk_usd, result, horizon, exit_date, r_multiple, setup, trader
       FROM trades WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  const t = rows[0];
  if (!t) throw notFound("TRADE_NOT_FOUND");
  const v = await viewerFor(req);
  const own = !!v.name && t.trader === v.name;
  if (!own && !v.member) throw new AppError("MEMBERS_ONLY");
  const { rows: execs } = await pool.query(
    `SELECT id, trade_id, kind, price, qty, executed_at, note, sort_order FROM trade_executions WHERE trade_id = $1 ORDER BY sort_order ASC, id ASC`,
    [id],
  );
  const computed = await structureForTrade(id, undefined, langOf(req)).catch((e) => {
    logger.warn({ err: e instanceof Error ? e.message : String(e), tradeId: id }, "trade structure failed");
    return null;
  });
  res.json(buildTrainingTradePayload(t, execs, computed, { name: v.name, staff: v.staff }, langOf(req)));
}));

export default router;
