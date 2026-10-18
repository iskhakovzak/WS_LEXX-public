/**
 * «Разбор дня» — автоматический детерминированный отчёт по одному торговому дню трейдера.
 *
 *   GET /api/day-report?trader=&date=YYYY-MM-DD[&revengeMin=2]
 *
 * Только чтение, таблиц не создаёт. Scope через lib/auth.scopeTrader: трейдер видит только себя,
 * staff — выбранного трейдера (без ?trader= — себя). Гость — пустой отчёт.
 * День = дата закрытия по NY (lib/tradeMath.closeDateSql); деньги — нетто (pnl − |fees|).
 * Время сделок: trade_executions (первый вход / последний выход) → снапшот PropReports (ET) → нет.
 * Дневной лимит: trader_risk_limits.daily_loss_limit → лимит уровня скейлинга (scaling_tiers по tier), только SELECT.
 */
import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { scopeTrader, isStaffRole, viewerRole, GUEST_SCOPE } from "../lib/auth";
import { closeDateSql, netPnlSql, resultSql } from "../lib/tradeMath";
import { execSpanJoin } from "../lib/execSpan";
import { nyDate } from "../lib/tradingDate";
import { buildDayReport, toDayTrade, type DailyNet } from "../lib/dayReport";
import { badRequest, unauthorized } from "../lib/http";
import { langOf } from "../i18n";

const router: IRouter = Router();

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z.object({
  trader: z.string().trim().max(120).optional(),
  date: z.string().regex(YMD_RE).optional(),
  revengeMin: z.coerce.number().int().min(1).max(30).optional(),
});

function normQuery(q: Request["query"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string" && s.trim() !== "") out[k] = s;
  }
  return out;
}

const CDATE = `substring(${closeDateSql("t")}, 1, 10)`;

type Row = {
  id: number; ticker: string | null; side: string | null; setup: string | null; playbook_id: number | null;
  result: string | null; pnl: unknown; fees: unknown; qty: unknown; entry: unknown; exit: unknown;
  opened_at: string | null; closed_at: string | null; first_entry: Date | null; last_exit: Date | null;
};

async function loadDayTrades(trader: string, date: string): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    `SELECT t.id, t.ticker, t.side, t.setup, t.playbook_id, ${resultSql("t")} AS result,
            t.pnl::float8 AS pnl, t.fees::float8 AS fees, t.qty::float8 AS qty, t.entry::float8 AS entry, t.exit::float8 AS exit,
            t.context_snapshot->>'openedAt' AS opened_at, t.context_snapshot->>'closedAt' AS closed_at,
            e.first_entry, e.last_exit
     FROM trades t ${execSpanJoin("lateral")}
     WHERE t.deleted_at IS NULL AND t.trader = $1 AND ${CDATE} = $2
     ORDER BY COALESCE(e.first_entry, e.last_exit) NULLS LAST, t.id`,
    [trader, date],
  );
  return rows;
}

async function loadHistory(trader: string, date: string, days: number): Promise<DailyNet[]> {
  const { rows } = await pool.query<{ d: string; net: number }>(
    `SELECT ${CDATE} AS d, SUM(${netPnlSql("t")})::float8 AS net
     FROM trades t
     WHERE t.deleted_at IS NULL AND t.trader = $1 AND t.pnl IS NOT NULL AND ${CDATE} < $2
     GROUP BY 1 ORDER BY 1 DESC LIMIT $3`,
    [trader, date, days],
  );
  return rows.map((r) => ({ date: r.d, net: Number(r.net) }));
}

/** Ближайшие дни со сделками до/после даты (для стрелок и пустого состояния). */
async function loadNeighbours(trader: string, date: string): Promise<{ prev: string | null; next: string | null }> {
  const { rows } = await pool.query<{ prev: string | null; next: string | null }>(
    `SELECT (SELECT MAX(${CDATE}) FROM trades t WHERE t.deleted_at IS NULL AND t.trader = $1 AND ${CDATE} < $2) AS prev,
            (SELECT MIN(${CDATE}) FROM trades t WHERE t.deleted_at IS NULL AND t.trader = $1 AND ${CDATE} > $2) AS next`,
    [trader, date],
  );
  return { prev: rows[0]?.prev ?? null, next: rows[0]?.next ?? null };
}

/** Дневной лимит: персональный → уровень скейлинга. Таблиц может не быть — тогда null. */
async function loadDailyLimit(trader: string): Promise<{ value: number | null; source: "personal" | "tier" | null }> {
  try {
    const { rows } = await pool.query<{ own: string | null; tier_limit: string | null }>(
      `SELECT l.daily_loss_limit::text AS own,
              (SELECT s.daily_loss_limit::text FROM scaling_tiers s WHERE s.key = l.tier LIMIT 1) AS tier_limit
       FROM trader_risk_limits l WHERE l.trader = $1 LIMIT 1`,
      [trader],
    );
    const r = rows[0];
    const own = r?.own != null ? Number(r.own) : null;
    if (own != null && Number.isFinite(own) && own > 0) return { value: own, source: "personal" };
    const tier = r?.tier_limit != null ? Number(r.tier_limit) : null;
    if (tier != null && Number.isFinite(tier) && tier > 0) return { value: tier, source: "tier" };
  } catch { /* trader_risk_limits / scaling_tiers ещё не созданы */ }
  return { value: null, source: null };
}

async function loadTraders(): Promise<string[]> {
  const { rows } = await pool.query<{ trader: string }>(
    `SELECT DISTINCT trader FROM trades WHERE deleted_at IS NULL AND trader IS NOT NULL AND trim(trader) <> '' ORDER BY trader`,
  );
  return rows.map((r) => r.trader);
}

router.get("/day-report", asyncHandler(async (req, res) => {
  const parsed = querySchema.safeParse(normQuery(req.query));
  if (!parsed.success) throw badRequest("BAD_REQUEST", parsed.error.flatten());
  const q = parsed.data;
  const date = q.date ?? nyDate();
  const scope = await scopeTrader(req, q.trader);
  if (scope === undefined) throw unauthorized();
  // Staff без ?trader= получает null (= вся команда) — отчёт дня строится по одному трейдеру: берём себя.
  const trader = scope ?? req.authUser?.name ?? null;
  if (!trader) throw badRequest("TRADER_REQUIRED");

  const isGuestScope = trader === GUEST_SCOPE;
  const staff = !isGuestScope && isStaffRole(await viewerRole(req));
  const [rows, history, neighbours, limit, traders] = await Promise.all([
    isGuestScope ? Promise.resolve([] as Row[]) : loadDayTrades(trader, date),
    isGuestScope ? Promise.resolve([] as DailyNet[]) : loadHistory(trader, date, 20),
    isGuestScope ? Promise.resolve({ prev: null, next: null }) : loadNeighbours(trader, date),
    isGuestScope ? Promise.resolve({ value: null, source: null }) : loadDailyLimit(trader),
    staff ? loadTraders() : Promise.resolve([] as string[]),
  ]);

  const trades = rows.map((r) => toDayTrade({
    id: r.id, ticker: r.ticker, side: r.side, setup: r.setup, playbookId: r.playbook_id, result: r.result,
    pnl: r.pnl, fees: r.fees, qty: r.qty, entry: r.entry, exit: r.exit,
    firstEntryAt: r.first_entry, lastExitAt: r.last_exit, openedAt: r.opened_at, closedAt: r.closed_at,
  }));
  const report = buildDayReport({
    trader: isGuestScope ? "" : trader,
    date,
    trades,
    history,
    dailyLossLimit: limit.value,
    options: { revengeMin: q.revengeMin, lang: langOf(req) },
  });

  res.json({
    ...report,
    dailyLossLimitSource: limit.source,
    nav: { prevTradeDate: neighbours.prev, nextTradeDate: neighbours.next },
    traders,
    canPickTrader: staff,
    today: nyDate(),
    generatedAt: new Date().toISOString(),
  });
}));

export default router;
