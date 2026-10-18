/**
 * «Бенчмарк деска» — team comparison for curators / head of desk.
 *
 *   GET /benchmark              ?period=week|month|quarter|all|days&days=N&from&to&minTrades=N
 *        → { period, viewer, metrics (catalogue), rows[], percentiles, median, trend[], mode }
 *          staff (team.read, desk or assigned scope): every visible trader with metrics, badges, daily equity,
 *          desk percentiles and the 4-weeks-vs-previous-4 trend;
 *          trader: only their own row + the anonymised desk median (k ≥ 3 per metric) and their own trend.
 *   GET /benchmark/same-ticker  ?…same period params&limit=N
 *        → staff only: cases where ≥ 2 traders traded the same ticker on the same day (result + execution).
 *
 * Numbers: net = pnl − |fees|, signed R, canonical result — lib/tradeMath; close date = exit_date ?? date and
 * fill minutes in America/New_York — lib/tradingDate. Pure metrics: lib/benchmark. Period windows reuse
 * resolveWindow() from routes/leaderboard. GET only, no tables created.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { closeDateSql, closedSql, netPnlSql, resultSql, signedRSql, horizonSql, num } from "../lib/tradeMath";
import { nyDate, nyMinutes } from "../lib/tradingDate";
import { readScope, resolveActor } from "../lib/permissions";
import { resolveWindow } from "./leaderboard";
import {metricDefs, NEUTRAL_METRICS, MEDIAN_MIN_TRADERS, CONSISTENCY_WARN, CONSISTENCY_BREACH, FIRST_MINUTES,
  badgesFor, computeTraderMetrics, deskMedian, parseHoldMinutes, percentiles, sameTickerCases, trendFor,
  type BenchTrade, type Result, type Side,
} from "../lib/benchmark";
import { AppError, sendError, unauthorized } from "../lib/http";
import { langOf } from "../i18n";

const router: IRouter = Router();

type Viewer = { name: string; staff: boolean; visible: string[] | null };

/** Who may see what: team.read (desk → everyone, assigned → self + wards) or a plain member (own row only). */
async function viewerOf(req: Request, res: Response): Promise<Viewer | null> {
  if (!req.authUser) { sendError(res, unauthorized()); return null; }
  const actor = await resolveActor(req);
  if (!actor) { sendError(res, unauthorized()); return null; }
  if (actor.guest) { sendError(res, new AppError("GUEST_UNAVAILABLE")); return null; }
  const scope = await readScope(req, "team.read");
  if (scope === null) return { name: actor.name, staff: true, visible: null };
  if (scope.length > 1) return { name: actor.name, staff: true, visible: scope };
  return { name: actor.name, staff: false, visible: [actor.name] };
}

type Row = {
  id: number; trader: string; ticker: string | null; day: string; side: string | null; result: string | null;
  gross: number | null; fees: number | null; net: number | null; r: number | null; qty: number | null;
  entry: number | null; exit: number | null; hold_time: string | null; horizon: string | null;
  first_entry: Date | null; last_exit: Date | null; avg_entry: number | null; avg_exit: number | null; fill_qty: number | null;
};

async function loadTrades(from: string, to: string): Promise<BenchTrade[]> {
  const CLOSE = closeDateSql();
  const { rows } = await pool.query<Row>(
    `SELECT t.id, t.trader, t.ticker, LEFT(${CLOSE}, 10) AS day, t.side, ${resultSql()} AS result,
            t.pnl::float AS gross, ABS(COALESCE(t.fees, 0))::float AS fees,
            (CASE WHEN t.pnl IS NULL THEN NULL ELSE ${netPnlSql()} END)::float AS net,
            ${signedRSql()}::float AS r, t.qty::float AS qty, t.entry::float AS entry, t.exit::float AS exit,
            t.hold_time, ${horizonSql()} AS horizon,
            x.first_entry, x.last_exit, x.avg_entry::float AS avg_entry, x.avg_exit::float AS avg_exit, x.fill_qty::float AS fill_qty
       FROM trades t
       LEFT JOIN LATERAL (
         SELECT MIN(e.executed_at) FILTER (WHERE e.kind IN ('entry','add')) AS first_entry,
                MAX(e.executed_at) FILTER (WHERE e.kind IN ('exit','trim','stop')) AS last_exit,
                SUM(e.price * e.qty) FILTER (WHERE e.kind IN ('entry','add')) / NULLIF(SUM(e.qty) FILTER (WHERE e.kind IN ('entry','add')), 0) AS avg_entry,
                SUM(e.price * e.qty) FILTER (WHERE e.kind IN ('exit','trim','stop')) / NULLIF(SUM(e.qty) FILTER (WHERE e.kind IN ('exit','trim','stop')), 0) AS avg_exit,
                SUM(e.qty) FILTER (WHERE e.kind IN ('entry','add')) AS fill_qty
           FROM trade_executions e WHERE e.trade_id = t.id
       ) x ON TRUE
      WHERE t.trader IS NOT NULL AND TRIM(t.trader) <> '' AND t.deleted_at IS NULL AND ${closedSql()}
        AND LEFT(${CLOSE}, 10) BETWEEN $1 AND $2
      ORDER BY LEFT(${CLOSE}, 10) ASC, COALESCE(x.first_entry, t.created_at) ASC, t.id ASC`,
    [from, to],
  );
  return rows.map((r): BenchTrade => {
    const side = String(r.side ?? "").trim().toLowerCase();
    const fe = r.first_entry ? new Date(r.first_entry) : null;
    const lx = r.last_exit ? new Date(r.last_exit) : null;
    const fillHold = fe && lx && lx.getTime() >= fe.getTime() ? (lx.getTime() - fe.getTime()) / 60_000 : null;
    return {
      id: r.id,
      trader: r.trader,
      ticker: String(r.ticker ?? "").trim().toUpperCase() || "—",
      day: String(r.day),
      side: (side.startsWith("s") ? "short" : side.startsWith("l") || side.startsWith("b") ? "long" : null) as Side | null,
      result: (r.result as Result | null) ?? null,
      gross: num(r.gross),
      fees: num(r.fees) ?? 0,
      net: num(r.net),
      r: num(r.r),
      qty: num(r.fill_qty) ?? num(r.qty),
      entry: num(r.avg_entry) ?? num(r.entry),
      exit: num(r.avg_exit) ?? num(r.exit),
      entryMin: fe ? nyMinutes(fe) : null,
      exitMin: lx ? nyMinutes(lx) : null,
      holdMin: fillHold ?? parseHoldMinutes(r.hold_time),
    };
  });
}

function periodOf(req: Request) {
  const today = nyDate();
  const win = resolveWindow({ period: req.query.period ?? "quarter", days: req.query.days, from: req.query.from, to: req.query.to }, today);
  const to = win.to > today ? today : win.to;
  return { kind: win.kind, from: win.from, to };
}

function groupBy(trades: readonly BenchTrade[]): Map<string, BenchTrade[]> {
  const m = new Map<string, BenchTrade[]>();
  for (const t of trades) { const l = m.get(t.trader) ?? []; l.push(t); m.set(t.trader, l); }
  return m;
}

const addDays = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

router.get("/benchmark", asyncHandler(async (req, res): Promise<void> => {
  const viewer = await viewerOf(req, res);
  if (!viewer) return;
  const p = periodOf(req);
  const minRaw = req.query.minTrades != null && req.query.minTrades !== "" ? Math.floor(Number(req.query.minTrades)) : 1;
  const minTrades = Number.isFinite(minRaw) && minRaw >= 0 ? Math.min(minRaw, 10_000) : 1;
  const trendFrom = addDays(p.to, -55);
  const dataFrom = p.from < trendFrom ? p.from : trendFrom;
  const all = await loadTrades(dataFrom, p.to);
  const inPeriod = all.filter((t) => t.day >= p.from);
  const firstDay = inPeriod[0]?.day ?? null;

  // Metrics for the whole desk (percentiles and the median need everyone), filtered for output afterwards.
  const byTrader = groupBy(inPeriod);
  const deskRows = [...byTrader.entries()].map(([trader, ts]) => computeTraderMetrics(trader, ts));
  const qualified = deskRows.filter((r) => r.trades >= minTrades);
  const pct = percentiles(qualified);
  const median = deskMedian(qualified);
  const canSee = (t: string) => viewer.visible === null || viewer.visible.includes(t);

  const allBy = groupBy(all);
  const visibleNames = viewer.staff
    ? [...new Set([...byTrader.keys(), ...allBy.keys()])].filter(canSee).sort((a, b) => a.localeCompare(b, "ru"))
    : [viewer.name];

  const rows = deskRows
    .filter((r) => canSee(r.trader) && (viewer.staff || r.trader === viewer.name))
    .map((r) => ({
      ...r,
      qualified: r.trades >= minTrades,
      percentiles: pct[r.trader] ?? null,
      badges: badgesFor(r, pct[r.trader], qualified.length, 3, 10, langOf(req)),
    }))
    .sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity) || (b.totalR ?? -Infinity) - (a.totalR ?? -Infinity) || b.trades - a.trades);

  const trend = visibleNames
    .filter((n) => viewer.staff || n === viewer.name)
    .map((n) => trendFor(n, allBy.get(n) ?? [], p.to, 4))
    .filter((t) => t.curM.trades + t.prevM.trades > 0);

  res.json({
    period: { kind: p.kind, from: p.kind === "all" ? (firstDay ?? p.to) : p.from, to: p.to, today: nyDate() },
    viewer: { name: viewer.name, staff: viewer.staff, scope: viewer.visible === null ? "desk" : viewer.staff ? "assigned" : "own" },
    mode: viewer.staff ? "desk" : "self",
    minTrades,
    deskSize: qualified.length,
    rules: { consistencyWarn: CONSISTENCY_WARN, consistencyBreach: CONSISTENCY_BREACH, firstMinutes: FIRST_MINUTES, medianMinTraders: MEDIAN_MIN_TRADERS },
    metrics: metricDefs(langOf(req)).map((d) => ({ ...d, neutral: NEUTRAL_METRICS.has(d.key) })),
    rows,
    // Percentiles of other traders are only exposed to staff (a trader gets their own via rows[0].percentiles).
    percentiles: viewer.staff ? Object.fromEntries(Object.entries(pct).filter(([t]) => canSee(t))) : null,
    median,
    trend,
  });
}));

router.get("/benchmark/same-ticker", asyncHandler(async (req, res): Promise<void> => {
  const viewer = await viewerOf(req, res);
  if (!viewer) return;
  if (!viewer.staff) { sendError(res, new AppError("STAFF_COMPARE_ONLY", 403, undefined, { capability: "team.read" })); return; }
  const p = periodOf(req);
  const limRaw = Math.floor(Number(req.query.limit ?? 200));
  const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.min(limRaw, 1000) : 200;
  const trades = (await loadTrades(p.from, p.to)).filter((t) => viewer.visible === null || viewer.visible.includes(t.trader));
  const cases = sameTickerCases(trades);
  const pairs = new Map<string, number>();
  for (const c of cases) {
    const names = c.participants.map((x) => x.trader).sort((a, b) => a.localeCompare(b, "ru"));
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const k = `${names[i]}|${names[j]}`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
  }
  res.json({
    period: { kind: p.kind, from: p.from, to: p.to },
    total: cases.length,
    cases: cases.slice(0, limit),
    pairs: [...pairs.entries()].map(([k, n]) => { const [a, b] = k.split("|"); return { a, b, cases: n }; }).sort((x, y) => y.cases - x.cases),
  });
}));

export default router;
