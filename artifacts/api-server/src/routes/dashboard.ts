// Dashboard = the desk cockpit. Every number here comes from the shared trade math
// (../lib/tradeMath) on the New York trading date (../lib/tradingDate), scoped by role
// (../lib/auth: staff see the team / any trader, everyone else only themselves).
//
//   GET /dashboard/summary       — legacy KPI card contract (now net $, signed R, W/(W+L))
//   GET /dashboard/performance   — per setup / trader / event type
//   GET /dashboard/toppatterns   — research patterns + avg net P&L
//   GET /dashboard/recenttrades  — last N trades (light columns, close-date order)
//   GET /dashboard/today         — today strip, positions, attention list, streaks, market
//   GET /dashboard/equity        — daily equity curve (R and net $) for a period
//
// Money is NET by default (`pnl`/`pnlNet` = gross − |fees|); gross is exposed next to it as `pnlGross`.
// "Today"/"week" are by close date (exit date for multi-day holds): a swing closed today counts today.
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { dashboardCache } from "../lib/hotCache";
import {
  GetDashboardSummaryResponse,
  GetPerformanceStatsResponse,
  GetTopPatternsResponse,
} from "@workspace/api-zod";
import { signedRSql, netPnlSql, closeDateSql, horizonSql, decidedSql, closedSql, resultSql, normResult } from "../lib/tradeMath";
import { nyDate, nyMinutes, nySession, addDays, isWeekend } from "../lib/tradingDate";
import { recentViolationWindow, violationDaySql } from "../lib/violationWindow";
import { scopeTrader, viewerRole, isStaffRole } from "../lib/auth";
import { unauthorized } from "../lib/http";
import { violationMessage } from "../lib/rulesI18n";
import { langOf } from "../i18n";
import { calendarName } from "../lib/calendarText";

const router: IRouter = Router();

// ─── shared SQL fragments (alias `t`) ─────────────────────────────────────────
const R = signedRSql();
const NET = netPnlSql();
const CLOSE = closeDateSql();
const HORIZON = horizonSql();
const DECIDED = decidedSql();
const CLOSED = closedSql();
const RESULT = resultSql();
const IS_OPEN = `LOWER(TRIM(COALESCE(t.result, ''))) = 'open'`;
const NOT_REVIEWED = `COALESCE(TRIM(t.conclusion), '') = '' AND COALESCE(TRIM(t.what_worked), '') = '' AND COALESCE(TRIM(t.what_failed), '') = ''`;
/** `$1` = trader filter (NULL ⇒ whole team). */
const SCOPE = `($1::text IS NULL OR t.trader = $1)`;

/** Aggregate block reused by today / week / per-day queries. */
const AGG = `
  COUNT(*)::int AS trades,
  COUNT(*) FILTER (WHERE ${RESULT} = 'win')::int AS wins,
  COUNT(*) FILTER (WHERE ${RESULT} = 'loss')::int AS losses,
  COUNT(*) FILTER (WHERE ${RESULT} = 'be')::int AS be,
  SUM(t.pnl)::float AS pnl_gross,
  SUM(${NET})::float AS pnl_net,
  SUM(ABS(COALESCE(t.fees, 0))) FILTER (WHERE t.pnl IS NOT NULL)::float AS fees,
  COUNT(t.pnl)::int AS pnl_count,
  COALESCE(SUM(${R}), 0)::float AS r,
  COUNT(${R})::int AS r_count,
  COALESCE(SUM(${R}) FILTER (WHERE ${R} > 0), 0)::float AS r_pos,
  COALESCE(SUM(${R}) FILTER (WHERE ${R} < 0), 0)::float AS r_neg`;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (v: number): number => Math.round(v * 100) / 100;
const nullable = (v: unknown): number | null => (v == null ? null : n(v));

/** Monday of the NY trading week that contains `ymd` (Sat/Sun belong to the week just ended). */
export function mondayOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sun
  return addDays(ymd, -((wd + 6) % 7));
}

/**
 * Oldest date of the "fresh" market-context window: the last 3 trading days up to `today`
 * (weekends skipped; holidays aren't excluded here, so the window can only be slightly wider).
 */
export function freshFeedFrom(today: string, tradingDays = 3): string {
  let d = today;
  let seen = isWeekend(d) ? 0 : 1;
  while (seen < tradingDays) {
    d = addDays(d, -1);
    if (!isWeekend(d)) seen++;
  }
  return d;
}

/** Trading date requested by the client (only a valid YYYY-MM-DD is honoured), else today in New York. */
function tradingDate(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  return YMD_RE.test(s) ? s : nyDate();
}

type Agg = Record<string, unknown>;
function aggOut(a: Agg | undefined) {
  const wins = n(a?.wins), losses = n(a?.losses), be = n(a?.be);
  const decided = wins + losses;
  const rCount = n(a?.r_count), rNeg = n(a?.r_neg), rPos = n(a?.r_pos);
  const hasPnl = n(a?.pnl_count) > 0;
  return {
    trades: n(a?.trades),
    closed: wins + losses + be,
    wins, losses, be,
    /** Net $ (gross − |fees|); null until broker/manual P&L exists. */
    pnl: hasPnl ? r2(n(a?.pnl_net)) : null,
    pnlNet: hasPnl ? r2(n(a?.pnl_net)) : null,
    pnlGross: hasPnl ? r2(n(a?.pnl_gross)) : null,
    fees: hasPnl ? r2(n(a?.fees)) : null,
    pnlCount: n(a?.pnl_count),
    r: r2(n(a?.r)),
    rCount,
    winRate: decided > 0 ? wins / decided : null,
    expectancyR: rCount > 0 ? r2(n(a?.r) / rCount) : null,
    profitFactorR: rNeg < 0 ? r2(rPos / Math.abs(rNeg)) : null,
  };
}

/**
 * Resolve who the caller may look at.
 *  - `scope=team` → whole desk for staff; silently "me" for everyone else.
 *  - `trader=X`   → that trader for staff; ignored for everyone else.
 * Returns the SQL trader param (null = team) and the effective scope label.
 */
async function resolveScope(req: Parameters<typeof scopeTrader>[0]): Promise<
  { ok: true; traderParam: string | null; scope: "me" | "team" | "trader"; me: string; staff: boolean } | { ok: false }
> {
  const me = req.authUser?.name;
  if (!me) return { ok: false };
  const staff = isStaffRole(await viewerRole(req));
  const wantTeam = req.query.scope === "team";
  const traderQ = typeof req.query.trader === "string" ? req.query.trader.trim().slice(0, 100) : "";
  const requested = wantTeam ? null : traderQ || me;
  const traderParam = await scopeTrader(req, requested);
  if (traderParam === undefined) return { ok: false };
  const scope = traderParam === null ? "team" : traderParam === me ? "me" : "trader";
  return { ok: true, traderParam, scope, me, staff };
}

// ─── Streak helpers (results most-recent-first) ───────────────────────────────
function streaksOf(results: ("win" | "loss" | "be")[]) {
  let current = { count: 0, type: "none" as "win" | "loss" | "none" };
  for (const r of results) {
    if (r !== "win" && r !== "loss") continue;
    if (current.type === "none") current = { count: 1, type: r };
    else if (r === current.type) current.count++;
    else break;
  }
  let bestWin = 0, bestLoss = 0, runW = 0, runL = 0;
  for (const r of [...results].reverse()) {
    if (r === "win") { runW++; runL = 0; } else if (r === "loss") { runL++; runW = 0; } else continue;
    bestWin = Math.max(bestWin, runW); bestLoss = Math.max(bestLoss, runL);
  }
  return { current, bestWin, bestLoss };
}

// ═════════════════════════════════════════════════════════════════════════════
// /dashboard/summary — legacy KPI contract, now on shared math and role scope.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/dashboard/summary", asyncHandler(async (req, res): Promise<void> => {
  const sc = await resolveScope(req);
  if (!sc.ok) throw unauthorized();
  const { traderParam } = sc;
  const CACHE_KEY = `dashboard:summary:${traderParam ?? "*"}`;
  const cached = dashboardCache.get(CACHE_KEY);
  if (cached) { res.json(cached); return; }

  const today = nyDate();
  const weekStart = mondayOf(today);

  const [allAgg, todayAgg, weekAgg, topSetup, topTrader, lastResults, feed] = await Promise.all([
    pool.query(`SELECT ${AGG} FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${CLOSED}`, [traderParam]),
    pool.query(`SELECT ${AGG} FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${CLOSED} AND ${CLOSE} = $2`, [traderParam, today]),
    pool.query(`SELECT ${AGG} FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${CLOSED} AND ${CLOSE} BETWEEN $2 AND $3`, [traderParam, weekStart, today]),
    pool.query(
      `SELECT t.setup,
              COUNT(*) FILTER (WHERE ${RESULT} = 'win')::float / NULLIF(COUNT(*) FILTER (WHERE ${DECIDED}), 0) AS win_rate,
              COUNT(*) FILTER (WHERE ${DECIDED})::int AS decided
       FROM trades t
       WHERE t.deleted_at IS NULL AND ${SCOPE} AND NULLIF(TRIM(t.setup), '') IS NOT NULL AND ${DECIDED}
       GROUP BY t.setup HAVING COUNT(*) FILTER (WHERE ${DECIDED}) >= 3
       ORDER BY 2 DESC NULLS LAST, 3 DESC LIMIT 1`,
      [traderParam],
    ),
    // Leader by NET P&L — only traders with recorded P&L (otherwise the "leader" was random).
    pool.query(
      `SELECT t.trader, SUM(${NET})::float AS net
       FROM trades t
       WHERE t.deleted_at IS NULL AND ${SCOPE} AND t.trader IS NOT NULL AND ${CLOSED}
       GROUP BY t.trader HAVING COUNT(t.pnl) > 0
       ORDER BY 2 DESC LIMIT 1`,
      [traderParam],
    ),
    pool.query(
      `SELECT ${RESULT} AS result FROM trades t
       WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${DECIDED}
       ORDER BY ${CLOSE} DESC, t.created_at DESC, t.id DESC LIMIT 100`,
      [traderParam],
    ),
    // Market context only from a fresh entry (today or the last 3 trading days, NY) — an April row must not pose as today's.
    pool.query(
      `SELECT market_theme, best_tickers FROM daily_feed
       WHERE deleted_at IS NULL AND substring(date, 1, 10) BETWEEN $1 AND $2
       ORDER BY substring(date, 1, 10) DESC, created_at DESC LIMIT 1`,
      [freshFeedFrom(today), today],
    ).catch(() => ({ rows: [] as any[] })),
  ]);

  const all = aggOut(allAgg.rows[0]);
  const todayA = aggOut(todayAgg.rows[0]);
  const weekA = aggOut(weekAgg.rows[0]);
  const results = lastResults.rows.map((x: any) => normResult(x.result)).filter((x): x is "win" | "loss" => x === "win" || x === "loss");
  const { current } = streaksOf(results);

  // The generated contract still types winRate/avgRMultiple as number (codegen is frozen), so the zod check runs
  // on a numeric placeholder and the real nullable values are put back after it: null = "no data" (no decided
  // trades / no trade with a known R — e.g. broker imports without a stop), never a fake 0 / 0.00R.
  const parsed = GetDashboardSummaryResponse.parse({
    totalTrades: all.closed,
    winRate: all.winRate ?? 0,
    totalPnl: all.pnlNet ?? 0,
    avgRMultiple: all.expectancyR ?? 0,
    todayTrades: todayA.closed,
    todayPnl: todayA.pnlNet ?? 0,
    topSetup: topSetup.rows[0]?.setup ?? null,
    topTrader: topTrader.rows[0]?.trader ?? null,
    marketRegime: feed.rows[0]?.market_theme ?? null,
    bestTickers: feed.rows[0]?.best_tickers ?? null,
    streak: current,
    weekStats: { count: weekA.closed, pnl: weekA.pnlNet ?? 0, wins: weekA.wins },
  });
  const payload = { ...parsed, winRate: all.winRate ?? null, avgRMultiple: all.expectancyR ?? null };

  dashboardCache.set(CACHE_KEY, payload);
  res.json(payload);
}));

// ═════════════════════════════════════════════════════════════════════════════
// /dashboard/performance — by setup / trader / event type (W/(W+L), net $, signed R).
// ═════════════════════════════════════════════════════════════════════════════
router.get("/dashboard/performance", asyncHandler(async (req, res): Promise<void> => {
  const sc = await resolveScope(req);
  if (!sc.ok) throw unauthorized();
  const { traderParam } = sc;
  const CACHE_KEY = `dashboard:performance:${traderParam ?? "*"}`;
  const cached = dashboardCache.get(CACHE_KEY);
  if (cached) { res.json(cached); return; }

  const GROUP_AGG = `
    COUNT(*)::int AS count,
    COUNT(*) FILTER (WHERE ${RESULT} = 'win')::int AS wins,
    COUNT(*) FILTER (WHERE ${DECIDED})::int AS decided,
    SUM(${NET})::float AS net, COUNT(t.pnl)::int AS pnl_count,
    AVG(${R})::float AS avg_r`;

  const [setupRows, traderRows, eventsAll, eventTradeRows] = await Promise.all([
    pool.query(`SELECT t.setup, ${GROUP_AGG} FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${CLOSED} GROUP BY t.setup`, [traderParam]),
    pool.query(`SELECT t.trader, ${GROUP_AGG} FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${CLOSED} GROUP BY t.trader`, [traderParam]),
    pool.query(`SELECT e.event_type, COUNT(*)::int AS count, COALESCE(AVG(e.percent_move), 0)::float AS avg_move FROM events e WHERE e.deleted_at IS NULL GROUP BY e.event_type`).catch(() => ({ rows: [] as any[] })),
    pool.query(`SELECT t.event_type, ${GROUP_AGG} FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${CLOSED} AND t.event_type IS NOT NULL GROUP BY t.event_type`, [traderParam]),
  ]);

  const wr = (r: any) => (n(r.decided) > 0 ? n(r.wins) / n(r.decided) : 0);
  const bySetup = setupRows.rows.map((r: any) => ({
    setup: r.setup ?? "Unknown",
    count: n(r.count),
    winRate: wr(r),
    avgPnl: n(r.pnl_count) > 0 ? n(r.net) / n(r.pnl_count) : 0,
    avgRMultiple: n(r.avg_r),
  }));
  const byTrader = traderRows.rows.map((r: any) => ({
    trader: r.trader ?? "Unknown",
    count: n(r.count),
    winRate: wr(r),
    totalPnl: n(r.net),
    avgRMultiple: n(r.avg_r),
  }));
  const eventMap = new Map<string, any>();
  for (const r of eventTradeRows.rows) if (r.event_type) eventMap.set(String(r.event_type), r);
  const byEventType = eventsAll.rows.map((r: any) => {
    const t = eventMap.get(String(r.event_type));
    return { eventType: String(r.event_type), count: n(r.count), winRate: t ? wr(t) : 0, avgMove: n(r.avg_move) };
  });

  const payload = GetPerformanceStatsResponse.parse({ bySetup, byTrader, byEventType });
  dashboardCache.set(CACHE_KEY, payload);
  res.json(payload);
}));

// ═════════════════════════════════════════════════════════════════════════════
// /dashboard/toppatterns — research patterns with average NET P&L of linked trades.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/dashboard/toppatterns", asyncHandler(async (req, res): Promise<void> => {
  const sc = await resolveScope(req);
  if (!sc.ok) throw unauthorized();
  const { traderParam } = sc;
  const CACHE_KEY = `dashboard:toppatterns:${traderParam ?? "*"}`;
  const cached = dashboardCache.get(CACHE_KEY);
  if (cached) { res.json(cached); return; }

  const [patterns, agg] = await Promise.all([
    pool.query(`SELECT id, pattern_name, repeat_count, confidence_level FROM research ORDER BY repeat_count DESC NULLS LAST`),
    pool.query(
      `SELECT t.pattern_id, AVG(${NET})::float AS avg_net FROM trades t
       WHERE t.deleted_at IS NULL AND ${SCOPE} AND t.pattern_id IS NOT NULL AND ${CLOSED} GROUP BY t.pattern_id`,
      [traderParam],
    ),
  ]);
  const map = new Map<number, number>();
  for (const r of agg.rows) if (r.pattern_id != null && r.avg_net != null) map.set(Number(r.pattern_id), n(r.avg_net));
  const payload = GetTopPatternsResponse.parse(
    patterns.rows.map((p: any) => ({
      patternName: p.pattern_name,
      repeatCount: n(p.repeat_count),
      confidenceLevel: n(p.confidence_level),
      avgPnl: map.get(Number(p.id)) ?? 0,
    })),
  );
  dashboardCache.set(CACHE_KEY, payload);
  res.json(payload);
}));

// ═════════════════════════════════════════════════════════════════════════════
// /dashboard/recenttrades — last N trades, light columns, ordered by close date.
// Auth + role scope (a trader never sees teammates' rows). `?trader=` honoured for staff.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/dashboard/recenttrades", asyncHandler(async (req, res): Promise<void> => {
  const sc = await resolveScope(req);
  if (!sc.ok) throw unauthorized();
  const { traderParam } = sc;
  const rawLimit = Number(req.query.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;
  const { rows } = await pool.query(
    `SELECT t.id, t.ticker, LEFT(t.date, 10) AS date, NULLIF(t.exit_date, '') AS "exitDate", ${CLOSE} AS "closeDate",
            t.side, t.setup, t.result, t.trader, ${HORIZON} AS horizon, t.source,
            t.pnl::float AS "pnlGross", ABS(COALESCE(t.fees, 0))::float AS fees,
            (CASE WHEN t.pnl IS NULL THEN NULL ELSE ${NET} END)::float AS "pnlNet",
            ${R}::float AS "rMultiple",
            (${NOT_REVIEWED}) AS "unreviewed",
            t.created_at AS "createdAt"
     FROM trades t
     WHERE t.deleted_at IS NULL AND ${SCOPE}
     ORDER BY ${CLOSE} DESC, t.created_at DESC, t.id DESC
     LIMIT $2`,
    [traderParam, limit],
  );
  res.json(
    rows.map((r: any) => ({
      id: Number(r.id),
      ticker: String(r.ticker),
      date: String(r.date),
      exitDate: r.exitDate ?? null,
      closeDate: String(r.closeDate),
      side: r.side ?? null,
      setup: r.setup ?? null,
      result: r.result ?? "",
      trader: r.trader ?? null,
      horizon: r.horizon,
      source: r.source ?? null,
      /** Net $ (gross − |fees|); gross and fees next to it. */
      pnl: nullable(r.pnlNet),
      pnlNet: nullable(r.pnlNet),
      pnlGross: nullable(r.pnlGross),
      fees: n(r.fees),
      /** Signed R (shared rule), null for open trades. */
      rMultiple: nullable(r.rMultiple),
      unreviewed: !!r.unreviewed,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    })),
  );
}));

// ═════════════════════════════════════════════════════════════════════════════
// /dashboard/today — the cockpit payload.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/dashboard/today", asyncHandler(async (req, res): Promise<void> => {
  const sc = await resolveScope(req);
  if (!sc.ok) throw unauthorized();
  const { traderParam, scope, me, staff } = sc;
  const today = tradingDate(req.query.date);
  const nyToday = nyDate();
  const weekFrom = mondayOf(today);
  const weekTo = addDays(weekFrom, 4); // Friday
  const reviewFrom = addDays(today, -30);
  const curatorFrom = addDays(today, -14);
  const quiet = () => ({ rows: [] as any[] });

  const [
    todayAgg, openedToday, weekAgg, weekDays, openCount, openRows, unreviewed, violations,
    checkinRows, draftIdeas, ideasToReview, lastResults, dayRows, holidayRows, positionRows, horizonRows,
    curatorQueue, gamePlan, journalRows, syncRows, tickerRows, watchRows,
  ] = await Promise.all([
    pool.query(`SELECT ${AGG} FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${CLOSED} AND ${CLOSE} = $2`, [traderParam, today]),
    pool.query(`SELECT COUNT(*)::int AS c FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE} AND LEFT(t.date, 10) = $2`, [traderParam, today]),
    pool.query(`SELECT ${AGG} FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${CLOSED} AND ${CLOSE} BETWEEN $2 AND $3`, [traderParam, weekFrom, weekTo]),
    pool.query(
      `SELECT ${CLOSE} AS day, SUM(${NET})::float AS net, COUNT(t.pnl)::int AS pnl_count, COALESCE(SUM(${R}), 0)::float AS r,
              COUNT(*) FILTER (WHERE ${RESULT} = 'win')::int AS wins, COUNT(*) FILTER (WHERE ${RESULT} = 'loss')::int AS losses
       FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${CLOSED} AND ${CLOSE} BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 1`,
      [traderParam, weekFrom, weekTo],
    ),
    pool.query(`SELECT COUNT(*)::int AS c FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${IS_OPEN}`, [traderParam]),
    pool.query(
      `SELECT t.id, t.ticker, LEFT(t.date, 10) AS date, t.side, t.setup, t.trader, ${HORIZON} AS horizon
       FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${IS_OPEN}
       ORDER BY t.date DESC, t.id DESC LIMIT 5`,
      [traderParam],
    ),
    pool.query(
      `SELECT t.id, t.ticker, ${CLOSE} AS date, t.side, t.result, t.trader, COUNT(*) OVER()::int AS total
       FROM trades t
       WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${CLOSED} AND ${CLOSE} >= $2 AND ${NOT_REVIEWED}
       ORDER BY ${CLOSE} DESC, t.id DESC LIMIT 5`,
      [traderParam, reviewFrom],
    ),
    pool.query(
      `SELECT v.id, v.trader, v.severity, v.message, v.details, v.trade_id AS "tradeId", r.name AS "ruleName", v.occurred_at AS "occurredAt",
              COUNT(*) OVER()::int AS total
       FROM rule_violations v LEFT JOIN trading_rules r ON r.id = v.rule_id
       WHERE ($1::text IS NULL OR v.trader = $1) AND v.archived_at IS NULL
         AND ${violationDaySql("v")} BETWEEN $2 AND $3
       ORDER BY ${violationDaySql("v")} DESC, v.occurred_at DESC LIMIT 5`,
      // «За сутки» — по торговому дню нарушения (v.day), а не по occurred_at: бэкфилл вставляет старые нарушения «сейчас».
      [traderParam, recentViolationWindow(today).from, recentViolationWindow(today).to],
    ).catch(quiet),
    pool.query(`SELECT DISTINCT date FROM emotional_state_log WHERE user_id = $1 AND date >= $2 AND date <= $3 ORDER BY date DESC`, [me, addDays(today, -60), today]).catch(quiet),
    pool.query(`SELECT COUNT(*)::int AS c FROM trade_ideas WHERE deleted_at IS NULL AND trader = $1 AND status = 'draft'`, [me]).catch(quiet),
    pool.query(
      `SELECT i.id, i.ticker, i.trader, i.side, COUNT(*) OVER()::int AS total
       FROM trade_ideas i
       WHERE i.deleted_at IS NULL AND i.status = 'published' AND COALESCE(i.trader, '') <> $1
         AND i.created_at >= NOW() - INTERVAL '7 days'
         AND NOT EXISTS (SELECT 1 FROM trade_idea_reactions r WHERE r.trade_idea_id = i.id AND r.trader = $1)
       ORDER BY i.created_at DESC LIMIT 5`,
      [me],
    ).catch(quiet),
    pool.query(
      `SELECT ${RESULT} AS result FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${CLOSED}
       ORDER BY ${CLOSE} DESC, t.created_at DESC, t.id DESC LIMIT 200`,
      [traderParam],
    ),
    pool.query(
      `SELECT ${CLOSE} AS day, SUM(${NET})::float AS net, COUNT(t.pnl)::int AS pnl_count, COALESCE(SUM(${R}), 0)::float AS r,
              COUNT(*) FILTER (WHERE ${RESULT} = 'win')::int AS wins, COUNT(*) FILTER (WHERE ${RESULT} = 'loss')::int AS losses
       FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${CLOSED} GROUP BY 1 ORDER BY 1 DESC LIMIT 120`,
      [traderParam],
    ),
    pool.query(`SELECT date::text AS date, name FROM holiday_calendar WHERE type = 'holiday' AND date::text >= $1 AND date::text <= $2 ORDER BY 1`, [nyToday, addDays(nyToday, 30)]).catch(quiet),
    pool.query(
      `SELECT t.id, t.ticker, LEFT(t.date, 10) AS date, t.side, t.setup, t.trader, ${HORIZON} AS horizon,
              t.qty::float AS qty, t.risk_usd::float AS "riskUsd", t.entry::float AS entry, t.stop::float AS stop, t.source,
              (SELECT LEFT(e.date, 10) FROM events e WHERE e.deleted_at IS NULL AND e.ticker = t.ticker AND LEFT(e.date, 10) >= $2 ORDER BY e.date ASC LIMIT 1) AS "nextEventDate",
              (SELECT e.event_type FROM events e WHERE e.deleted_at IS NULL AND e.ticker = t.ticker AND LEFT(e.date, 10) >= $2 ORDER BY e.date ASC LIMIT 1) AS "nextEventType"
       FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${IS_OPEN}
       ORDER BY t.date ASC, t.id ASC LIMIT 100`,
      [traderParam, today],
    ).catch(() => null),
    pool.query(
      `SELECT ${HORIZON} AS horizon, ${AGG}
       FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${CLOSED} AND ${CLOSE} = $2 GROUP BY 1`,
      [traderParam, today],
    ).catch(() => null),
    // Curator queue: closed team trades the trader has written a conclusion for, with no curator review yet.
    staff
      ? pool.query(
          `SELECT t.id, t.ticker, ${CLOSE} AS date, t.trader, t.result, COUNT(*) OVER()::int AS total
           FROM trades t
           WHERE t.deleted_at IS NULL AND ${CLOSED} AND ${CLOSE} >= $1 AND COALESCE(TRIM(t.conclusion), '') <> ''
             AND NOT EXISTS (SELECT 1 FROM trade_reviews rv WHERE rv.trade_id = t.id)
           ORDER BY ${CLOSE} DESC, t.id DESC LIMIT 5`,
          [curatorFrom],
        ).catch(quiet)
      : Promise.resolve(quiet()),
    pool.query(
      `SELECT p.id, p.bias, p.risk_mode AS "riskMode", COALESCE(jsonb_array_length(p.in_play), 0)::int AS "inPlayCount", p.updated_at AS "updatedAt",
              (SELECT r.read_at FROM game_plan_reads r WHERE r.plan_id = p.id AND r.trader = $2) AS "myReadAt"
       FROM game_plans p WHERE p.date = $1 AND p.deleted_at IS NULL LIMIT 1`,
      [today, me],
    ).catch(() => null),
    pool.query(`SELECT trader FROM journal_days WHERE day = $1::date AND ($2::text IS NULL OR trader = $2)`, [today, traderParam]).catch(() => null),
    pool.query(
      `SELECT MAX(t.synced_at) AS last, COUNT(*) FILTER (WHERE t.source = 'propreports')::int AS imported
       FROM trades t WHERE t.deleted_at IS NULL AND ${SCOPE}`,
      [traderParam],
    ).catch(() => null),
    // «Мои тикеры» for the attention panel: traded in the last 14 days (scope) + in-play names on the team watchlist.
    pool.query(
      `SELECT UPPER(TRIM(t.ticker)) AS ticker, MAX(t.date) AS last FROM trades t
       WHERE t.deleted_at IS NULL AND ${SCOPE} AND LEFT(t.date, 10) >= $2 AND COALESCE(TRIM(t.ticker), '') <> ''
       GROUP BY 1 ORDER BY 2 DESC LIMIT 40`,
      [traderParam, addDays(today, -14)],
    ).catch(() => null),
    pool.query(`SELECT DISTINCT UPPER(TRIM(w.ticker)) AS ticker FROM watchlist w WHERE w.deleted_at IS NULL AND w.in_play = TRUE LIMIT 40`).catch(() => null),
  ]);

  const todayOut = aggOut(todayAgg.rows[0]);
  const weekOut = aggOut(weekAgg.rows[0]);
  const dayScore = (d: any) => (n(d.pnl_count) > 0 ? n(d.net) : n(d.r) !== 0 ? n(d.r) : n(d.wins) - n(d.losses));

  const results = lastResults.rows.map((x: any) => normResult(x.result)).filter((x): x is "win" | "loss" | "be" => x === "win" || x === "loss" || x === "be");
  const { current, bestWin, bestLoss } = streaksOf(results);
  let greenDays = 0;
  for (const d of dayRows.rows) { if (dayScore(d) > 0) greenDays++; else break; }

  const checkinSet = new Set<string>(checkinRows.rows.map((r: any) => String(r.date)));
  const checkinDone = checkinSet.has(today);
  let checkinStreak = 0;
  for (let cursor = checkinDone ? today : addDays(today, -1); checkinSet.has(cursor); cursor = addDays(cursor, -1)) checkinStreak++;

  const daysBetween = (a: string, b: string) => Math.max(0, Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000));
  const positions = positionRows
    ? positionRows.rows.map((p: any) => {
        const entry = nullable(p.entry), stop = nullable(p.stop), qty = nullable(p.qty);
        const stopDist = entry != null && stop != null ? Math.abs(entry - stop) : null;
        const riskUsd = nullable(p.riskUsd) ?? (stopDist != null && qty != null ? r2(stopDist * qty) : null);
        return {
          id: Number(p.id), ticker: String(p.ticker), date: String(p.date),
          side: p.side ?? null, setup: p.setup ?? null, trader: p.trader ?? null,
          horizon: ["intraday", "overnight", "swing"].includes(p.horizon) ? p.horizon : "intraday",
          source: p.source ?? null,
          qty, riskUsd, entry, stop,
          /** Distance to stop as % of entry (planned risk per share). */
          stopPct: entry && stopDist != null ? r2((stopDist / Math.abs(entry)) * 100) : null,
          daysHeld: YMD_RE.test(String(p.date)) ? daysBetween(String(p.date), today) : 0,
          nextEvent: p.nextEventDate ? { date: String(p.nextEventDate), type: p.nextEventType ?? null } : null,
        };
      })
    : null;
  const openRiskUsd = positions ? positions.reduce((s, p) => s + (p.riskUsd ?? 0), 0) : null;
  const carried = positions ? positions.filter((p) => p.horizon !== "intraday") : [];

  const byHorizon = horizonRows
    ? (["intraday", "overnight", "swing"] as const).map((h) => {
        const row = horizonRows.rows.find((x: any) => x.horizon === h);
        const a = aggOut(row);
        return { horizon: h, trades: a.closed, pnl: a.pnlNet, pnlGross: a.pnlGross, fees: a.fees, r: a.r };
      })
    : null;

  const plan = gamePlan?.rows[0];
  const holidays = holidayRows.rows.map((x: any) => ({ date: String(x.date), name: calendarName(String(x.name), langOf(req)) ?? String(x.name) }));
  const journalTraders = journalRows ? journalRows.rows.map((x: any) => String(x.trader)) : null;

  const first = <T,>(q: { rows: any[] }, f: (r: any) => T): T | null => (q.rows[0] ? f(q.rows[0]) : null);

  res.json({
    date: today,
    scope,
    trader: traderParam ?? me,
    viewer: { name: me, staff },
    today: {
      ...todayOut,
      /** Trades opened today (entry date) — differs from `trades` (realised today) for swings. */
      opened: n(openedToday.rows[0]?.c),
      open: n(openCount.rows[0]?.c),
      byHorizon,
    },
    positions,
    exposure: positions ? { open: positions.length, carried: carried.length, openRiskUsd: openRiskUsd == null ? null : r2(openRiskUsd), carriedRiskUsd: r2(carried.reduce((s, p) => s + (p.riskUsd ?? 0), 0)) } : null,
    week: {
      from: weekFrom,
      to: weekTo,
      ...weekOut,
      tradingDays: weekDays.rows.length,
      greenDays: weekDays.rows.filter((d: any) => dayScore(d) > 0).length,
      days: weekDays.rows.map((d: any) => ({ date: String(d.day), pnl: n(d.pnl_count) > 0 ? r2(n(d.net)) : null, r: r2(n(d.r)), wins: n(d.wins), losses: n(d.losses) })),
    },
    attention: {
      openTrades: { count: n(openCount.rows[0]?.c), items: openRows.rows },
      unreviewed: { count: first(unreviewed, (x) => n(x.total)) ?? 0, items: unreviewed.rows.map(({ total: _t, ...x }: any) => x) },
      checkin: { done: checkinDone },
      draftIdeas: { count: n(draftIdeas.rows[0]?.c) },
      ideasToReview: { count: first(ideasToReview, (x) => n(x.total)) ?? 0, items: ideasToReview.rows.map(({ total: _t, ...x }: any) => x) },
      violations: { count: first(violations, (x) => n(x.total)) ?? 0, items: violations.rows.map(({ total: _t, details, ...x }: any) => ({ ...x, message: violationMessage(x.message, details, langOf(req)) })) },
      /** Staff only: closed trades with a trader conclusion and no curator review (14 days). */
      curatorQueue: staff ? { count: first(curatorQueue, (x) => n(x.total)) ?? 0, items: curatorQueue.rows.map(({ total: _t, ...x }: any) => x) } : null,
    },
    /** Today's game plan: exists / read by me / in-play count. null when the table is missing. */
    gamePlan: gamePlan
      ? plan
        ? { exists: true, id: Number(plan.id), bias: plan.bias ?? null, riskMode: plan.riskMode ?? null, inPlayCount: n(plan.inPlayCount), myReadAt: plan.myReadAt ? new Date(plan.myReadAt).toISOString() : null, updatedAt: plan.updatedAt ? new Date(plan.updatedAt).toISOString() : null }
        : { exists: false, id: null, bias: null, riskMode: null, inPlayCount: 0, myReadAt: null, updatedAt: null }
      : null,
    /** Day review in the journal (journal_days row for today). `reviewed` is for the scoped trader; `traders` for team scope. */
    journal: journalTraders
      ? { reviewed: traderParam ? journalTraders.includes(traderParam) : journalTraders.length > 0, traders: journalTraders }
      : null,
    /** PropReports import footprint in this scope (the live sync status lives at /propreports/status). */
    sync: syncRows && syncRows.rows[0]
      ? { lastSyncedAt: syncRows.rows[0].last ? new Date(syncRows.rows[0].last).toISOString() : null, imported: n(syncRows.rows[0].imported) }
      : null,
    /** Additive: tickers the scope trades or watches (recent 14 days + in-play watchlist), for «события по моим тикерам». */
    myTickers: Array.from(new Set([
      ...(tickerRows ? tickerRows.rows.map((x: any) => String(x.ticker)) : []),
      ...(watchRows ? watchRows.rows.map((x: any) => String(x.ticker)) : []),
    ].filter(Boolean))).slice(0, 60),
    streaks: {
      current,
      bestWin,
      bestLoss,
      greenDays,
      checkinDays: checkinStreak,
      recent: results.slice(0, 20).reverse(),
    },
    market: {
      nyDate: nyToday,
      nyMinutes: nyMinutes(),
      session: nySession(),
      weekend: isWeekend(nyToday),
      holidayToday: holidays.find((h) => h.date === nyToday)?.name ?? null,
      holidays,
    },
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// /dashboard/equity — daily curve by close date; R and net $ side by side.
// ═════════════════════════════════════════════════════════════════════════════
const PERIODS = ["week", "7d", "30d", "90d", "ytd", "all"] as const;
type Period = (typeof PERIODS)[number];

router.get("/dashboard/equity", asyncHandler(async (req, res): Promise<void> => {
  const sc = await resolveScope(req);
  if (!sc.ok) throw unauthorized();
  const { traderParam, scope } = sc;
  const today = tradingDate(req.query.date);
  const requested = String(req.query.period ?? "30d");
  const period: Period = (PERIODS as readonly string[]).includes(requested) ? (requested as Period) : "30d";
  const from =
    period === "week" || period === "7d" ? mondayOf(today)
    : period === "30d" ? addDays(today, -29)
    : period === "90d" ? addDays(today, -89)
    : period === "ytd" ? `${today.slice(0, 4)}-01-01`
    : "0000-01-01";

  const { rows } = await pool.query(
    `SELECT ${CLOSE} AS day, ${AGG}
     FROM trades t
     WHERE t.deleted_at IS NULL AND ${SCOPE} AND ${CLOSED} AND ${CLOSE} BETWEEN $2 AND $3
     GROUP BY 1 ORDER BY 1 ASC`,
    [traderParam, from, today],
  );

  let cumNet = 0, cumGross = 0, cumR = 0, peakR = 0, maxDdR = 0, peakNet = 0, maxDdNet = 0;
  let trades = 0, wins = 0, losses = 0, be = 0, rPos = 0, rNeg = 0, rCount = 0, net = 0, gross = 0, fees = 0, pnlCount = 0, greenDays = 0;
  let bestR: { date: string; r: number } | null = null, worstR: { date: string; r: number } | null = null;
  let bestNet: { date: string; pnl: number } | null = null, worstNet: { date: string; pnl: number } | null = null;
  const days = rows.map((d: any) => {
    const a = aggOut(d);
    const dayNet = a.pnlNet;
    cumNet += dayNet ?? 0;
    cumGross += a.pnlGross ?? 0;
    cumR += a.r;
    peakR = Math.max(peakR, cumR); maxDdR = Math.min(maxDdR, cumR - peakR);
    peakNet = Math.max(peakNet, cumNet); maxDdNet = Math.min(maxDdNet, cumNet - peakNet);
    trades += a.closed; wins += a.wins; losses += a.losses; be += a.be;
    rPos += n(d.r_pos); rNeg += n(d.r_neg); rCount += a.rCount;
    if (dayNet != null) { net += dayNet; gross += a.pnlGross ?? 0; fees += a.fees ?? 0; pnlCount += a.pnlCount; }
    if ((dayNet ?? a.r) > 0) greenDays++;
    const date = String(d.day);
    if (!bestR || a.r > bestR.r) bestR = { date, r: a.r };
    if (!worstR || a.r < worstR.r) worstR = { date, r: a.r };
    if (dayNet != null) {
      if (!bestNet || dayNet > bestNet.pnl) bestNet = { date, pnl: dayNet };
      if (!worstNet || dayNet < worstNet.pnl) worstNet = { date, pnl: dayNet };
    }
    return {
      date,
      trades: a.closed, wins: a.wins, losses: a.losses, be: a.be,
      pnl: dayNet, pnlGross: a.pnlGross, fees: a.fees,
      r: a.r,
      cumPnl: r2(cumNet), cumPnlGross: r2(cumGross), cumR: r2(cumR),
    };
  });

  const decided = wins + losses;
  res.json({
    period,
    scope,
    from: period === "all" ? (days[0]?.date ?? today) : from,
    to: today,
    hasPnl: pnlCount > 0,
    days,
    totals: {
      trades, wins, losses, be,
      winRate: decided > 0 ? wins / decided : null,
      /** Net $ (labelled «нетто» in the UI). */
      pnl: pnlCount > 0 ? r2(net) : null,
      pnlGross: pnlCount > 0 ? r2(gross) : null,
      fees: pnlCount > 0 ? r2(fees) : null,
      r: r2(cumR),
      expectancyR: rCount > 0 ? r2((rPos + rNeg) / rCount) : null,
      profitFactorR: rNeg < 0 ? r2(rPos / Math.abs(rNeg)) : null,
      maxDrawdownR: r2(maxDdR),
      maxDrawdownNet: pnlCount > 0 ? r2(maxDdNet) : null,
      tradingDays: days.length,
      greenDays,
      bestR, worstR, bestNet, worstNet,
    },
  });
}));

export default router;
