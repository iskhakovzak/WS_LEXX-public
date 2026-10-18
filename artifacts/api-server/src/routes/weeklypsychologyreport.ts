import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { isStaffRole, isGuestUser, viewerRole, requirePersonalAccess } from "../lib/auth";
import { nyDate } from "../lib/tradingDate";
import {
  generateWeeklyReport,
  getLatestWeeklyReport,
  getPreviousWeeklyReport,
  getWeeklyReportHistory,
  getCurrentWeekBounds,
  weekBoundsFor,
  buildInsights,
  isValidYmd,
  addDaysYmd,
  getWeeklyReportById,
} from "../lib/weeklyPsychologyReport";
import { AppError, badRequest, unauthorized } from "../lib/http";
import { langOf, type Lang } from "../i18n";

const router: IRouter = Router();

/**
 * Personal data: the owner, or a member whose journal.read.team grant covers that trader (curators/admins by
 * default) — lib/auth requirePersonalAccess. Guests never. Generating someone else's report needs journal.review.
 * Returns the effective userId or null after sending an error response.
 */
function resolveUserId(req: Request, res: Response, raw: unknown, mode: "read" | "write" = "read"): Promise<string | null> {
  return requirePersonalAccess(req, res, raw, mode === "write" ? "journal.review" : "journal.read.team");
}

type ReportRow = NonNullable<Awaited<ReturnType<typeof getLatestWeeklyReport>>>;

/**
 * Live trade count per stored week (same filter as generateWeeklyReport: trader, not deleted,
 * date between weekStart and weekEnd 23:59:59). One query for all rows.
 */
async function liveTradeCounts(userId: string, rows: ReportRow[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!rows.length) return out;
  const { rows: counts } = await pool.query<{ id: number; n: number }>(
    `SELECT w.id, COUNT(t.id)::int AS n
       FROM unnest($2::int[], $3::text[], $4::text[]) AS w(id, ws, we)
       LEFT JOIN trades t
         ON t.trader = $1 AND t.deleted_at IS NULL AND t.date >= w.ws AND t.date <= w.we || 'T23:59:59'
      GROUP BY w.id`,
    [userId, rows.map((r) => r.id), rows.map((r) => r.weekStart), rows.map((r) => r.weekEnd)],
  );
  for (const c of counts) out.set(Number(c.id), Number(c.n));
  return out;
}

/**
 * Re-render insights in the reader's language from stored stats and flag stale reports (P1-10):
 * `stale` = the week's trades changed since generation (typically a report saved with totalTrades 0 before a
 * PropReports import) — the UI offers «Пересчитать». `liveTrades` = trades in the week right now.
 */
function present(row: ReportRow, prev: ReportRow | null, lang: Lang, live?: Map<number, number>) {
  const liveTrades = live?.get(row.id);
  const stale = liveTrades != null && liveTrades !== row.totalTrades;
  return {
    ...row,
    keyInsights: buildInsights(row, prev, lang),
    liveTrades: liveTrades ?? null,
    stale,
    staleReason: !stale ? null : row.totalTrades === 0 ? "trades_appeared" : "trades_changed",
  };
}

/** Monday of the current and of the previous trading week (America/New_York calendar). */
function recalcWeeks(): { current: string; last: string } {
  const current = weekBoundsFor(nyDate()).weekStart;
  return { current, last: addDaysYmd(current, -7) };
}

/** Compact summary of the previous week for trend deltas in the UI. */
function summary(row: ReportRow | null) {
  if (!row) return null;
  const raw = (row.rawStats ?? {}) as { avgR?: number | null; avgReadiness?: number | null };
  return {
    weekStart: row.weekStart,
    weekEnd: row.weekEnd,
    totalTrades: row.totalTrades,
    totalCheckins: row.totalCheckins,
    winRate: Number(row.winRate) || 0,
    totalPnl: Number(row.totalPnl) || 0,
    avgR: raw.avgR ?? null,
    avgReadiness: raw.avgReadiness ?? null,
  };
}

router.get("/psychology/weekly-report", asyncHandler(async (req, res): Promise<void> => {
  const userId = await resolveUserId(req, res, req.query.userId);
  if (!userId) return;
  const report = await getLatestWeeklyReport(userId);
  if (!report) {
    res.json({ report: null, previous: null, currentWeek: getCurrentWeekBounds() });
    return;
  }
  const prev = await getPreviousWeeklyReport(userId, report.weekStart);
  const live = await liveTradeCounts(userId, [report]);
  res.json({ report: present(report, prev, langOf(req), live), previous: summary(prev), currentWeek: getCurrentWeekBounds() });
}));

router.get("/psychology/weekly-report/history", asyncHandler(async (req, res): Promise<void> => {
  const userId = await resolveUserId(req, res, req.query.userId);
  if (!userId) return;
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 52) : 8;
  const rows = await getWeeklyReportHistory(userId, limit + 1);
  const shown = rows.slice(0, limit);
  const live = await liveTradeCounts(userId, shown);
  const lang = langOf(req);
  const reports = shown.map((r, i) => present(r, rows[i + 1] ?? null, lang, live));
  const weeks = recalcWeeks();
  res.json({ reports, recalcWeeks: [weeks.current, weeks.last] });
}));

router.post("/psychology/weekly-report/generate", asyncHandler(async (req, res): Promise<void> => {
  const userId = await resolveUserId(req, res, req.body?.userId ?? req.query.userId, "write");
  if (!userId) return;
  const rawStart = typeof req.body?.weekStart === "string" ? req.body.weekStart.trim() : undefined;
  const rawEnd = typeof req.body?.weekEnd === "string" ? req.body.weekEnd.trim() : undefined;
  if ((rawStart && !isValidYmd(rawStart)) || (rawEnd && !isValidYmd(rawEnd))) throw badRequest("INVALID_DATE");
  // Always normalise to the Monday–Friday of the given week, so a client in any
  // timezone (or an old client sending a Sunday) lands on the same row.
  let weekStart: string | undefined;
  let weekEnd: string | undefined;
  if (rawStart) {
    ({ weekStart, weekEnd } = weekBoundsFor(rawStart));
  }
  if (weekStart && weekEnd && rawEnd && rawEnd < weekStart) throw badRequest("DATE_RANGE_INVALID");
  const id = await generateWeeklyReport(userId, weekStart, weekEnd);
  const report = await getLatestWeeklyReport(userId);
  const prev = report ? await getPreviousWeeklyReport(userId, report.weekStart) : null;
  res.status(201).json({
    id,
    report: report ? present(report, prev, langOf(req)) : null,
    previous: summary(prev),
    currentWeek: getCurrentWeekBounds(),
  });
}));

/**
 * «Пересчитать» (P1-10): rebuild the report of the CURRENT or the LAST trading week from today's data.
 * Body: { userId, weekStart? }  weekStart = Monday of the current or previous NY week (default: current;
 * any day of those weeks is accepted and normalised). Only the owner or staff (curator/admin, DB role).
 * → { id, report (the recalculated week, with stale=false), previous, currentWeek }
 */
router.post("/psychology/weekly-report/recalculate", asyncHandler(async (req, res): Promise<void> => {
  const auth = req.authUser;
  if (!auth) throw unauthorized();
  if (isGuestUser(auth)) throw new AppError("GUEST_READ_ONLY");
  const userId = typeof (req.body?.userId ?? req.query.userId) === "string" ? String(req.body?.userId ?? req.query.userId).trim() : "";
  if (!userId) throw badRequest("TRADER_REQUIRED");
  if (auth.name !== userId && !isStaffRole(await viewerRole(req))) throw new AppError("WEEKLY_REPORT_OWN_ONLY", 403);
  const weeks = recalcWeeks();
  const raw = typeof req.body?.weekStart === "string" ? req.body.weekStart.trim() : "";
  if (raw && !isValidYmd(raw)) throw badRequest("INVALID_DATE");
  const { weekStart, weekEnd } = weekBoundsFor(raw || weeks.current);
  if (weekStart !== weeks.current && weekStart !== weeks.last) {
    throw badRequest("WEEKLY_REPORT_WEEK_LOCKED", { allowed: [weeks.current, weeks.last] });
  }
  const id = await generateWeeklyReport(userId, weekStart, weekEnd);
  const report = await getWeeklyReportById(userId, id);
  const prev = report ? await getPreviousWeeklyReport(userId, report.weekStart) : null;
  const live = report ? await liveTradeCounts(userId, [report]) : undefined;
  res.status(201).json({
    id,
    report: report ? present(report, prev, langOf(req), live) : null,
    previous: summary(prev),
    currentWeek: getCurrentWeekBounds(),
  });
}));

export default router;
