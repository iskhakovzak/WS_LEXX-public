import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { logger } from "../lib/logger";
import { nyDate } from "../lib/tradingDate";
import {
  canCloseDay, computeStreaks, missingFields, missingList, nextTradingDay, type Streaks,
} from "../lib/eodLogic";
import { signedRSql, netPnlSql, closeDateSql, horizonSql, resultSql } from "../lib/tradeMath";
import { ensureJournalTable } from "./journal";
import { ensureCuratorTables } from "../lib/curatorStore";
import { QUEUE_DEFAULT_DAYS } from "../lib/curatorLogic";
import { can, requireCap } from "../lib/permissions";
import { notifyUser, notifyUsers } from "../lib/notifyUtils";
import { logActivity } from "../lib/activity";
import { activityTitle } from "../lib/activityText";
import { notifLinks } from "../lib/notificationCore";
import { claimOnce, inBackground, staffOrFallback } from "../lib/notifyEvents";
import { eodOverdueKey, fmtSignedUsd, preview as textPreview, selectOverdue } from "../lib/notifyEventsCore";
import { AppError, badRequest, errorMessage, notFound, unauthorized } from "../lib/http";
import { langOf, type Lang } from "../i18n";
import { reviewT } from "../i18n/ns";

/**
 * «Закрытие дня» (end-of-day close) + curator review queue.
 *
 * A trading day (New York calendar date) is CLOSED by its trader once every trade of the day has been reviewed
 * (setup + grade on the trade, plus followed-plan / mistakes / lesson in eod_trade_reviews) and the day summary is
 * written. Closed days queue up for a curator who leaves a comment + score 1–5 (reviewed).
 *
 * Trader endpoints (own days only):
 *   GET  /api/eod/day?date=YYYY-MM-DD[&trader=]       full EOD payload (trades of the day with review fields, carried
 *                                                     positions, missing items, reconcile numbers, game-plan tickers,
 *                                                     streaks). Curators/admins may pass trader=.
 *   PUT  /api/eod/trades/:id/review                   { followedPlan?, mistakes?, lesson? } — owner only, day must be open
 *   PUT  /api/eod/day/:date                           { discipline?, summary? } — save draft summary (day must be open)
 *   POST /api/eod/day/:date/close                     { discipline?, summary? } — validates; 422 { missing } when a MANUAL
 *                                                     trade lacks setup/grade (broker-imported trades never block the
 *                                                     close — they come back as `softMissing`, a reminder only);
 *                                                     stores closed_at; fills journal_days (today + tomorrow's plan)
 *                                                     where empty
 *   POST /api/eod/day/:date/reopen                    clears closed_at (curator review is kept)
 *   GET  /api/eod/streaks[?trader=]                   { closedStreak, reviewedStreak, closedTotal, lastClosed }
 *   GET  /api/eod/days?from=&to=[&trader=]            { trader, days: [{ date, status, closedAt, reviewedAt, reviewedBy,
 *                                                     curatorScore }] } — month calendar marks (range ≤ 120 days)
 *
 * Status (for dashboard / admin — contract):
 *   GET  /api/eod/status?date=YYYY-MM-DD[&trader=]
 *     → { date, today, traders: [{ trader, status: 'open'|'closed'|'reviewed', trades, reviewedTrades,
 *          missing: [{ tradeId, ticker, fields: ('setup'|'grade')[] }], closedAt, reviewedAt, curatorScore, discipline }] }
 *     Traders get only themselves; curators/admins get every active trader (plus anyone with trades or an EOD row that
 *     day), or one trader with trader=. "status: 'open'" with trades > 0 after the session ⇒ «не закрыл день».
 *
 * Curator queue (curator/admin):
 *   GET  /api/eod/queue?limit=50          closed & unreviewed days, oldest closed_at first, with hoursWaiting / overdue (>24h)
 *        &reviewed=1                      instead: days reviewed in the last 7 days, newest first (mode: 'reviewed')
 *   GET  /api/eod/queue/count             { count, overdue } — for the nav badge
 *   POST /api/eod/days/:id/review         { comment, score 1..5 } → sets reviewed_by/at; returns { day, next } where
 *                                         next = the next queue item (for the «Следующий» flow)
 *
 * Tables (additive, created idempotently at module load / first request):
 *   eod_days(trader, date, closed_at, discipline, summary jsonb, reviewed_by, reviewed_at, curator_comment, curator_score)
 *   eod_trade_reviews(trade_id, trader, followed_plan, mistakes text[], lesson)
 * Per-trade setup / grade live on the trade itself (trades PATCH API); only what's missing there is stored here.
 */
const router: IRouter = Router();

let ensured: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `CREATE TABLE IF NOT EXISTS eod_days (
           id SERIAL PRIMARY KEY,
           trader TEXT NOT NULL,
           date TEXT NOT NULL,
           closed_at TIMESTAMPTZ,
           discipline SMALLINT,
           summary JSONB NOT NULL DEFAULT '{}'::jsonb,
           reviewed_by TEXT,
           reviewed_at TIMESTAMPTZ,
           curator_comment TEXT,
           curator_score SMALLINT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           UNIQUE (trader, date)
         );
         CREATE INDEX IF NOT EXISTS eod_days_queue_idx ON eod_days (closed_at) WHERE closed_at IS NOT NULL AND reviewed_at IS NULL;
         CREATE TABLE IF NOT EXISTS eod_trade_reviews (
           trade_id INTEGER PRIMARY KEY,
           trader TEXT NOT NULL,
           followed_plan BOOLEAN,
           mistakes TEXT[] NOT NULL DEFAULT '{}',
           lesson TEXT NOT NULL DEFAULT '',
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         );`,
      )
      .then(() => undefined)
      .catch((err) => {
        ensured = null;
        throw err;
      });
  }
  return ensured;
}
ensureTables().catch((err) => logger.warn({ err }, "eod: ensure tables failed at init"));

// ── Helpers ───────────────────────────────────────────────────────────────────
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && ISO_DATE.test(v) && !isNaN(Date.parse(v + "T00:00:00Z"));
}

/**
 * Whose day are we looking at. Traders: always themselves; holders of journal.read.team (curators/admins,
 * permissions matrix, role from the DB): `claimed` or themselves.
 */
/** Throws 401 / 403 AppErrors. */
async function scopeTrader(req: Request, claimed: unknown): Promise<{ ok: true; trader: string }> {
  const auth = req.authUser;
  if (!auth) throw unauthorized();
  const name = typeof claimed === "string" && claimed.trim() ? claimed.trim().slice(0, 120) : null;
  if (!name || name === auth.name) return { ok: true, trader: auth.name };
  if (await can(req, "journal.read.team", { trader: name })) return { ok: true, trader: name };
  throw new AppError("EOD_OWN_ONLY");
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

// ── Validation ────────────────────────────────────────────────────────────────
const Position = z.object({
  tradeId: z.number().int().positive(),
  thesisValid: z.boolean().nullable().default(null),
  stop: z.number().finite().nullable().default(null),
  target: z.number().finite().nullable().default(null),
  gapNote: z.string().trim().max(1000).default(""),
});
const Summary = z.object({
  mood: z.number().int().min(1).max(5).nullable().default(null),
  repeat: z.string().trim().max(4000).default(""),
  stop: z.string().trim().max(4000).default(""),
  tomorrow: z.string().trim().max(6000).default(""),
  positions: z.array(Position).max(100).default([]),
  reconcile: z
    .object({
      brokerNet: z.number().finite().nullable().default(null),
      journalNet: z.number().finite().nullable().default(null),
      brokerTrades: z.number().int().nullable().default(null),
      journalTrades: z.number().int().nullable().default(null),
      note: z.string().trim().max(1000).default(""),
    })
    .optional(),
});
type SummaryT = z.infer<typeof Summary>;
const DayBody = z.object({
  discipline: z.number().int().min(1).max(5).nullable().optional(),
  summary: Summary.optional(),
});
const TradeReviewBody = z.object({
  followedPlan: z.boolean().nullable().optional(),
  mistakes: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  lesson: z.string().trim().max(2000).optional(),
});
const CuratorReviewBody = z.object({
  comment: z.string().trim().max(6000).default(""),
  score: z.number().int().min(1).max(5),
});


// ── Data ──────────────────────────────────────────────────────────────────────
const DAY_COLS = `d.id, d.trader, d.date, d.closed_at AS "closedAt", d.discipline, d.summary,
  d.reviewed_by AS "reviewedBy", d.reviewed_at AS "reviewedAt", d.curator_comment AS "curatorComment",
  d.curator_score AS "curatorScore", d.created_at AS "createdAt", d.updated_at AS "updatedAt"`;

type DayRow = {
  id: number; trader: string; date: string; closedAt: Date | null; discipline: number | null; summary: SummaryT;
  reviewedBy: string | null; reviewedAt: Date | null; curatorComment: string | null; curatorScore: number | null;
  createdAt: Date; updatedAt: Date;
};

export type DayStatus = "open" | "closed" | "reviewed";
function statusOf(d: DayRow | null): DayStatus {
  if (!d || !d.closedAt) return "open";
  return d.reviewedAt ? "reviewed" : "closed";
}

/**
 * Close rule (P1-8): trades imported from the broker never block the close — setup / grade on them is a soft
 * reminder (`soft`). Only manual trades still need setup + grade before the day can be closed.
 */
function isBrokerTrade(t: { source: string | null }): boolean {
  return t.source === "propreports";
}
function closeCheck(date: string, today: string, trades: TradeRow[]) {
  const check = canCloseDay({ date, today, trades: trades.filter((t) => !isBrokerTrade(t)) });
  return { ...check, soft: missingList(trades.filter(isBrokerTrade)) };
}

function serializeDay(d: DayRow | null) {
  if (!d) return null;
  return {
    ...d,
    closedAt: iso(d.closedAt), reviewedAt: iso(d.reviewedAt), createdAt: iso(d.createdAt), updatedAt: iso(d.updatedAt),
    status: statusOf(d),
  };
}

async function loadDay(trader: string, date: string): Promise<DayRow | null> {
  const { rows } = await pool.query<DayRow>(`SELECT ${DAY_COLS} FROM eod_days d WHERE d.trader = $1 AND d.date = $2`, [trader, date]);
  return rows[0] ?? null;
}
async function loadDayById(id: number): Promise<DayRow | null> {
  const { rows } = await pool.query<DayRow>(`SELECT ${DAY_COLS} FROM eod_days d WHERE d.id = $1`, [id]);
  return rows[0] ?? null;
}

// `to_jsonb(t)` lets us read the PropReports columns (source / external_id) even on a DB where the
// migration hasn't landed yet — the query never references a column that may not exist.
const TRADE_COLS = `t.id, t.ticker, LEFT(t.date, 10) AS date, t.side, t.setup, t.result, t.session,
  t.pnl::float8 AS pnl, t.fees::float8 AS fees, t.qty::float8 AS qty,
  t.entry::float8 AS entry, t.exit::float8 AS exit, t.stop::float8 AS stop,
  t.r_multiple::float8 AS "rMultiple", t.risk_usd::float8 AS "riskUsd",
  t.confidence_grade AS "confidenceGrade", t.tags, t.conclusion, t.pattern_id AS "patternId",
  t.horizon, t.exit_date AS "exitDate",
  COALESCE(to_jsonb(t) ->> 'source', t.context_snapshot ->> 'source') AS source,
  to_jsonb(t) ->> 'external_id' AS "externalId",
  ${signedRSql()} AS r, ${netPnlSql()} AS net, ${closeDateSql()} AS "closeDate",
  ${horizonSql()} AS "horizonEff", ${resultSql()} AS "resultNorm",
  rv.followed_plan AS "followedPlan", COALESCE(rv.mistakes, '{}') AS mistakes, COALESCE(rv.lesson, '') AS lesson,
  rv.updated_at AS "reviewUpdatedAt"`;

export type TradeRow = {
  id: number; ticker: string; date: string; side: string | null; setup: string | null; result: string; session: string | null;
  pnl: number | null; fees: number | null; qty: number | null; entry: number | null; exit: number | null; stop: number | null;
  rMultiple: number | null; riskUsd: number | null; confidenceGrade: string | null; tags: string | null; conclusion: string | null;
  patternId: number | null; horizon: string | null; exitDate: string | null; source: string | null; externalId: string | null;
  r: number | null; net: number | null; closeDate: string; horizonEff: string; resultNorm: string | null;
  followedPlan: boolean | null; mistakes: string[]; lesson: string; reviewUpdatedAt: Date | null;
};

/** Trades that belong to the day's review: entered on `date` or realised (closed) on `date`. */
async function loadDayTrades(trader: string, date: string): Promise<TradeRow[]> {
  const { rows } = await pool.query<TradeRow>(
    `SELECT ${TRADE_COLS}
       FROM trades t LEFT JOIN eod_trade_reviews rv ON rv.trade_id = t.id
      WHERE t.deleted_at IS NULL AND t.trader = $1
        AND (LEFT(t.date, 10) = $2 OR ${closeDateSql()} = $2)
      ORDER BY t.created_at ASC, t.id ASC`,
    [trader, date],
  );
  return rows;
}

/** Multi-day positions opened before `date` and still held on it (closed strictly later, or still open). */
async function loadCarried(trader: string, date: string): Promise<TradeRow[]> {
  const { rows } = await pool.query<TradeRow>(
    `SELECT ${TRADE_COLS}
       FROM trades t LEFT JOIN eod_trade_reviews rv ON rv.trade_id = t.id
      WHERE t.deleted_at IS NULL AND t.trader = $1
        AND LEFT(t.date, 10) < $2
        AND (${horizonSql()} <> 'intraday' OR NULLIF(t.exit_date, '') IS NOT NULL)
        AND ((NULLIF(t.exit_date, '') IS NOT NULL AND t.exit_date > $2)
             OR (NULLIF(t.exit_date, '') IS NULL AND ${resultSql()} = 'open'))
      ORDER BY t.date ASC, t.id ASC`,
    [trader, date],
  );
  return rows;
}

type Totals = { trades: number; closed: number; open: number; gross: number | null; fees: number; net: number | null };
function totals(rows: TradeRow[], date: string): Totals {
  let closed = 0, open = 0, gross: number | null = null, fees = 0, net: number | null = null;
  for (const t of rows) {
    if (t.resultNorm === "open" || t.resultNorm == null) { open++; continue; }
    if (t.closeDate !== date) continue; // entered today, realised later — not today's P&L
    closed++;
    if (t.pnl != null) {
      gross = (gross ?? 0) + t.pnl;
      fees += Math.abs(t.fees ?? 0);
      net = (net ?? 0) + (t.net ?? t.pnl);
    }
  }
  const r2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
  return { trades: rows.length, closed, open, gross: r2(gross), fees: Math.round(fees * 100) / 100, net: r2(net) };
}

async function loadPlanTickers(date: string): Promise<{ date: string; inPlay: Array<{ ticker: string; grade: string | null; horizon: string }> } | null> {
  try {
    const { rows } = await pool.query<{ in_play: unknown }>(
      `SELECT in_play FROM game_plans WHERE date = $1 AND deleted_at IS NULL LIMIT 1`,
      [date],
    );
    if (!rows[0]) return null;
    const raw = Array.isArray(rows[0].in_play) ? (rows[0].in_play as Array<Record<string, unknown>>) : [];
    return {
      date,
      inPlay: raw
        .filter((x) => x && typeof x.ticker === "string")
        .map((x) => ({
          ticker: String(x.ticker).toUpperCase(),
          grade: typeof x.grade === "string" ? x.grade : null,
          horizon: typeof x.horizon === "string" ? x.horizon : "intraday",
        })),
    };
  } catch {
    return null; // game_plans table may not exist yet
  }
}

// ── Streaks ───────────────────────────────────────────────────────────────────
async function loadStreaks(trader: string, today: string): Promise<Streaks> {
  const [{ rows: closed }, { rows: days }] = await Promise.all([
    pool.query<{ date: string }>(`SELECT date FROM eod_days WHERE trader = $1 AND closed_at IS NOT NULL`, [trader]),
    pool.query<{ d: string; n: number; reviewed: number }>(
      `SELECT ${closeDateSql()} AS d, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE NULLIF(TRIM(t.setup), '') IS NOT NULL AND t.confidence_grade IS NOT NULL AND rv.followed_plan IS NOT NULL)::int AS reviewed
         FROM trades t LEFT JOIN eod_trade_reviews rv ON rv.trade_id = t.id
        WHERE t.deleted_at IS NULL AND t.trader = $1 AND ${closeDateSql()} <= $2
        GROUP BY 1`,
      [trader, today],
    ),
  ]);
  return computeStreaks({
    today,
    closedDates: new Set(closed.map((r) => r.date)),
    tradeDays: new Map(days.map((r) => [r.d, { n: r.n, reviewed: r.reviewed }])),
  });
}

// ── Payload ───────────────────────────────────────────────────────────────────
async function buildDay(trader: string, date: string, lang: Lang = "ru") {
  const today = nyDate();
  const [day, trades, carried, plan, streaks] = await Promise.all([
    loadDay(trader, date), loadDayTrades(trader, date), loadCarried(trader, date), loadPlanTickers(date), loadStreaks(trader, today),
  ]);
  const inPlay = new Set((plan?.inPlay ?? []).map((p) => p.ticker));
  const serializeTrade = (t: TradeRow) => ({
    ...t,
    reviewUpdatedAt: iso(t.reviewUpdatedAt),
    enteredToday: t.date === date,
    closedToday: t.closeDate === date && t.resultNorm != null && t.resultNorm !== "open",
    onPlan: inPlay.has(t.ticker.toUpperCase()),
    missing: missingFields(t),
  });
  const check = closeCheck(date, today, trades);
  const brokerRows = trades.filter((t) => t.source === "propreports");
  const positions = [...trades, ...carried].filter((t) => t.resultNorm === "open");
  return {
    trader,
    date,
    today,
    day: serializeDay(day),
    status: statusOf(day),
    trades: trades.map(serializeTrade),
    carried: carried.map(serializeTrade),
    positions: positions.map((t) => t.id),
    missing: check.missing,
    softMissing: check.soft,
    canClose: check.ok,
    closeBlockedReason: check.reasonCode ? errorMessage(check.reasonCode, lang) : null,
    reconcile: {
      journal: totals(trades, date),
      broker: brokerRows.length ? totals(brokerRows, date) : null,
      manualUnmatched: trades.filter((t) => t.source !== "propreports" && t.closeDate === date).length,
    },
    plan,
    streaks,
  };
}

// ── Routes: trader ────────────────────────────────────────────────────────────
router.get("/eod/day", asyncHandler(async (req, res): Promise<void> => {
  const scope = await scopeTrader(req, req.query.trader);
  const date = req.query.date === undefined || req.query.date === "" ? nyDate() : req.query.date;
  if (!isIsoDate(date)) throw badRequest("INVALID_DATE");
  await ensureTables();
  res.json(await buildDay(scope.trader, date, langOf(req)));
}));

router.get("/eod/streaks", asyncHandler(async (req, res): Promise<void> => {
  const scope = await scopeTrader(req, req.query.trader);
  await ensureTables();
  res.json({ trader: scope.trader, ...(await loadStreaks(scope.trader, nyDate())) });
}));

/** Month calendar marks: EOD status per day for one trader. */
router.get("/eod/days", asyncHandler(async (req, res): Promise<void> => {
  const scope = await scopeTrader(req, req.query.trader);
  const { from, to } = req.query;
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) throw new AppError("INVALID_RANGE", 400, { max: 120 });
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 120) throw new AppError("INVALID_RANGE", 400, { max: 120 });
  await ensureTables();
  const { rows } = await pool.query<DayRow>(
    `SELECT ${DAY_COLS} FROM eod_days d WHERE d.trader = $1 AND d.date >= $2 AND d.date <= $3 ORDER BY d.date`,
    [scope.trader, from, to],
  );
  res.json({
    trader: scope.trader,
    days: rows.map((d) => ({
      date: d.date, status: statusOf(d), closedAt: iso(d.closedAt), reviewedAt: iso(d.reviewedAt),
      reviewedBy: d.reviewedBy, curatorScore: d.curatorScore,
    })),
  });
}));

router.put("/eod/trades/:id/review", asyncHandler(async (req, res): Promise<void> => {
  const me = req.authUser;
  if (!me) throw unauthorized();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const parsed = TradeReviewBody.safeParse(req.body ?? {});
  if (!parsed.success) throw parsed.error;
  await ensureTables();
  const { rows: tr } = await pool.query<{ trader: string | null; date: string; closeDate: string }>(
    `SELECT t.trader, LEFT(t.date, 10) AS date, ${closeDateSql()} AS "closeDate" FROM trades t WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [id],
  );
  if (!tr[0]) throw notFound("TRADE_NOT_FOUND");
  if (tr[0].trader !== me.name) throw new AppError("TRADE_REVIEW_OWN_ONLY");
  // The trade's review belongs to the day it is realised on (or entered, for still-open trades).
  for (const d of new Set([tr[0].date, tr[0].closeDate])) {
    const day = await loadDay(me.name, d);
    if (day?.closedAt) throw new AppError("EOD_DAY_CLOSED", 409, { date: d }, { date: d });
  }
  const b = parsed.data;
  const mistakes = b.mistakes ? Array.from(new Set(b.mistakes.map((m) => m.trim()).filter(Boolean))) : null;
  const { rows } = await pool.query(
    `INSERT INTO eod_trade_reviews (trade_id, trader, followed_plan, mistakes, lesson, updated_at)
     VALUES ($1, $2, $3, COALESCE($4::text[], '{}'), COALESCE($5, ''), NOW())
     ON CONFLICT (trade_id) DO UPDATE SET
       followed_plan = CASE WHEN $6 THEN EXCLUDED.followed_plan ELSE eod_trade_reviews.followed_plan END,
       mistakes = COALESCE($4::text[], eod_trade_reviews.mistakes),
       lesson = COALESCE($5, eod_trade_reviews.lesson),
       updated_at = NOW()
     RETURNING trade_id AS "tradeId", trader, followed_plan AS "followedPlan", mistakes, lesson, updated_at AS "updatedAt"`,
    [id, me.name, b.followedPlan ?? null, mistakes, b.lesson ?? null, b.followedPlan !== undefined],
  );
  res.json({ ...rows[0], updatedAt: iso(rows[0].updatedAt) });
}));

async function upsertDay(trader: string, date: string, b: z.infer<typeof DayBody>): Promise<DayRow> {
  const { rows } = await pool.query<DayRow>(
    `INSERT INTO eod_days AS d (trader, date, discipline, summary, updated_at)
     VALUES ($1, $2, $3, COALESCE($4::jsonb, '{}'::jsonb), NOW())
     ON CONFLICT (trader, date) DO UPDATE SET
       discipline = CASE WHEN $5 THEN EXCLUDED.discipline ELSE d.discipline END,
       summary = COALESCE($4::jsonb, d.summary),
       updated_at = NOW()
     RETURNING ${DAY_COLS}`,
    [trader, date, b.discipline ?? null, b.summary ? JSON.stringify(b.summary) : null, b.discipline !== undefined],
  );
  return rows[0];
}

router.put("/eod/day/:date", asyncHandler(async (req, res): Promise<void> => {
  const me = req.authUser;
  if (!me) throw unauthorized();
  const date = req.params.date;
  if (!isIsoDate(date)) throw badRequest("INVALID_DATE");
  const parsed = DayBody.safeParse(req.body ?? {});
  if (!parsed.success) throw parsed.error;
  await ensureTables();
  const existing = await loadDay(me.name, date);
  if (existing?.closedAt) throw new AppError("EOD_DAY_CLOSED", 409, { date: existing.date }, { date: existing.date });
  const day = await upsertDay(me.name, date, parsed.data);
  res.json(serializeDay(day));
}));

/** Fill the trader's journal_days row for `date` (and tomorrow's plan) where it is still empty — never overwrites text. */
async function prefillJournal(trader: string, date: string, day: DayRow, trades: TradeRow[]): Promise<void> {
  await ensureJournalTable();
  const s = day.summary ?? ({} as SummaryT);
  const lessonText = trades
    .filter((t) => t.lesson.trim())
    .map((t) => `• ${t.ticker}: ${t.lesson.trim()}`)
    .join("\n");
  const mistakeText = s.stop?.trim() ? s.stop.trim() : "";
  const followed = trades.length === 0 ? null : trades.every((t) => t.followedPlan === true) ? true : trades.some((t) => t.followedPlan === false) ? false : null;
  await pool.query(
    `INSERT INTO journal_days (trader, day, plan, well, mistakes, lessons, mood, discipline, followed_plan, tags, updated_at)
     VALUES ($1, $2, '', $3, $4, $5, $6, $7, $8, '[]'::jsonb, NOW())
     ON CONFLICT (trader, day) DO UPDATE SET
       well = CASE WHEN journal_days.well = '' THEN EXCLUDED.well ELSE journal_days.well END,
       mistakes = CASE WHEN journal_days.mistakes = '' THEN EXCLUDED.mistakes ELSE journal_days.mistakes END,
       lessons = CASE WHEN journal_days.lessons = '' THEN EXCLUDED.lessons ELSE journal_days.lessons END,
       mood = COALESCE(journal_days.mood, EXCLUDED.mood),
       discipline = COALESCE(journal_days.discipline, EXCLUDED.discipline),
       followed_plan = COALESCE(journal_days.followed_plan, EXCLUDED.followed_plan),
       updated_at = NOW()`,
    [trader, date, s.repeat ?? "", mistakeText, lessonText, s.mood ?? null, day.discipline ?? null, followed],
  );
  const tomorrow = (s.tomorrow ?? "").trim();
  if (tomorrow) {
    await pool.query(
      `INSERT INTO journal_days (trader, day, plan, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (trader, day) DO UPDATE SET
         plan = CASE WHEN journal_days.plan = '' THEN EXCLUDED.plan ELSE journal_days.plan END,
         updated_at = NOW()`,
      [trader, nextTradingDay(date), tomorrow],
    );
  }
}

router.post("/eod/day/:date/close", asyncHandler(async (req, res): Promise<void> => {
  const me = req.authUser;
  if (!me) throw unauthorized();
  const date = req.params.date;
  if (!isIsoDate(date)) throw badRequest("INVALID_DATE");
  const parsed = DayBody.safeParse(req.body ?? {});
  if (!parsed.success) throw parsed.error;
  await ensureTables();
  const today = nyDate();
  const trades = await loadDayTrades(me.name, date);
  const check = closeCheck(date, today, trades);
  if (!check.ok) {
    throw new AppError(check.reasonCode ?? "EOD_INCOMPLETE", 422, undefined, { missing: check.missing });
  }
  const existing = await loadDay(me.name, date);
  if (existing?.closedAt) throw new AppError("EOD_ALREADY_CLOSED", 409, undefined, { day: serializeDay(existing) });
  const saved = await upsertDay(me.name, date, parsed.data);
  const { rows } = await pool.query<DayRow>(
    `UPDATE eod_days d SET closed_at = NOW(), updated_at = NOW() WHERE d.id = $1 RETURNING ${DAY_COLS}`,
    [saved.id],
  );
  const day = rows[0];
  try {
    await prefillJournal(me.name, date, day, trades);
  } catch (err) {
    logger.warn({ err }, "eod: journal prefill failed");
  }
  // Day closed → it is in the curator queue: tell the trader's assigned staff (fallback: every curator/admin).
  // Once per day: close → reopen → close again must not ping the curator a second time.
  const trader = me.name;
  inBackground("eod.close", async () => {
    const t = totals(trades, date);
    const params = {
      trader, date, trades: t.trades,
      ...(t.net != null ? { net: fmtSignedUsd(t.net) } : {}),
      ...(day.discipline != null ? { discipline: day.discipline } : {}),
    };
    // Activity log details: RU text (stored), same parts as the notification.
    const tr = reviewT.tFor("ru");
    const parts = [tr("eod.trades", { count: t.trades })];
    if (params.net) parts.push(tr("eod.net", { net: params.net }));
    if (params.discipline != null) parts.push(tr("eod.discipline", { value: params.discipline }));
    if (await claimOnce(`eod:review_request:${day.id}`)) await notifyUsers(await staffOrFallback(trader), {
      type: "eod_review_request", actor: trader, source: "eod",
      params,
      link: notifLinks.journalDay(date, trader), entityType: "eod_day", entityId: day.id,
    }, trader);
    await logActivity({ action: "closed", section: "eod", entityId: date, entityTitle: date, trader, details: parts.join(", ") });
  });
  res.json({ day: serializeDay(day), streaks: await loadStreaks(me.name, today), journalPrefilled: true });
}));

router.post("/eod/day/:date/reopen", asyncHandler(async (req, res): Promise<void> => {
  const me = req.authUser;
  if (!me) throw unauthorized();
  const date = req.params.date;
  if (!isIsoDate(date)) throw badRequest("INVALID_DATE");
  await ensureTables();
  const { rows } = await pool.query<DayRow>(
    `UPDATE eod_days d SET closed_at = NULL, updated_at = NOW() WHERE d.trader = $1 AND d.date = $2 RETURNING ${DAY_COLS}`,
    [me.name, date],
  );
  if (!rows[0]) throw new AppError("EOD_DAY_NOT_FOUND");
  inBackground("eod.reopen", () => logActivity({ action: "reopened", section: "eod", entityId: date, entityTitle: date, trader: me.name }));
  res.json(serializeDay(rows[0]));
}));

// ── Status (dashboard / admin contract) ───────────────────────────────────────
router.get("/eod/status", asyncHandler(async (req, res): Promise<void> => {
  const auth = req.authUser;
  if (!auth) throw unauthorized();
  const date = req.query.date === undefined || req.query.date === "" ? nyDate() : req.query.date;
  if (!isIsoDate(date)) throw badRequest("INVALID_DATE");
  await ensureTables();
  const qTrader = typeof req.query.trader === "string" ? req.query.trader.trim() : "";
  let traders: string[];
  if (!(await can(req, "journal.read.team", { trader: qTrader || null }))) {
    if (qTrader && qTrader !== auth.name) throw new AppError("EOD_OWN_ONLY");
    traders = [auth.name];
  } else if (qTrader) {
    traders = [qTrader];
  } else {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM users WHERE active = true AND COALESCE(banned, false) = false AND role = 'trader'
       UNION SELECT trader FROM eod_days WHERE date = $1
       UNION SELECT trader FROM trades t WHERE t.deleted_at IS NULL AND t.trader IS NOT NULL AND (LEFT(t.date, 10) = $1 OR ${closeDateSql()} = $1)
       ORDER BY 1`,
      [date],
    );
    traders = rows.map((r) => r.name);
  }
  const out = await Promise.all(
    traders.map(async (trader) => {
      const [day, trades] = await Promise.all([loadDay(trader, date), loadDayTrades(trader, date)]);
      const missing = missingList(trades);
      return {
        trader,
        status: statusOf(day),
        trades: trades.length,
        reviewedTrades: trades.length - missing.length,
        missing,
        closedAt: iso(day?.closedAt ?? null),
        reviewedAt: iso(day?.reviewedAt ?? null),
        reviewedBy: day?.reviewedBy ?? null,
        curatorScore: day?.curatorScore ?? null,
        discipline: day?.discipline ?? null,
      };
    }),
  );
  res.json({ date, today: nyDate(), traders: out });
}));

// ── Curator queue ─────────────────────────────────────────────────────────────
const QUEUE_SQL = `
  SELECT ${DAY_COLS},
         EXTRACT(EPOCH FROM (NOW() - d.closed_at)) / 3600 AS "hoursWaiting",
         (SELECT COUNT(*)::int FROM trades t WHERE t.deleted_at IS NULL AND t.trader = d.trader
             AND (LEFT(t.date, 10) = d.date OR ${closeDateSql()} = d.date)) AS trades,
         (SELECT SUM(${netPnlSql()})::float8 FROM trades t WHERE t.deleted_at IS NULL AND t.trader = d.trader
             AND ${closeDateSql()} = d.date AND ${resultSql()} IN ('win','loss','be')) AS net
    FROM eod_days d
   WHERE d.closed_at IS NOT NULL AND d.reviewed_at IS NULL`;

/**
 * Same window as the /curator queue: days archived via «архивировать старые» (curator_queue_acks) never show, and
 * days closed more than QUEUE_DEFAULT_DAYS ago are hidden unless `?old=1` — otherwise a year of backfill buries the queue.
 */
function pendingWindowSql(includeOld: boolean): string {
  const acked = `AND NOT EXISTS (SELECT 1 FROM curator_queue_acks a WHERE a.revoked_at IS NULL AND a.item_id = 'eod:' || d.id)`;
  return includeOld ? acked : `${acked} AND d.closed_at > NOW() - INTERVAL '${QUEUE_DEFAULT_DAYS} days'`;
}

type QueueRow = DayRow & { hoursWaiting: number; trades: number; net: number | null };
const SLA_HOURS = 24;
function serializeQueue(r: QueueRow) {
  const hours = Math.round(Number(r.hoursWaiting) * 10) / 10;
  return {
    id: r.id, trader: r.trader, date: r.date, closedAt: iso(r.closedAt), discipline: r.discipline,
    trades: r.trades, net: r.net == null ? null : Math.round(r.net * 100) / 100,
    hoursWaiting: hours, overdue: hours > SLA_HOURS,
    mood: (r.summary as SummaryT | null)?.mood ?? null,
    reviewedAt: iso(r.reviewedAt), reviewedBy: r.reviewedBy, curatorScore: r.curatorScore,
  };
}

/** Recently reviewed days (last 7 days) — «Проверено» tab of the curator queue. hoursWaiting = closed → reviewed. */
const REVIEWED_SQL = `
  SELECT ${DAY_COLS},
         EXTRACT(EPOCH FROM (d.reviewed_at - d.closed_at)) / 3600 AS "hoursWaiting",
         (SELECT COUNT(*)::int FROM trades t WHERE t.deleted_at IS NULL AND t.trader = d.trader
             AND (LEFT(t.date, 10) = d.date OR ${closeDateSql()} = d.date)) AS trades,
         (SELECT SUM(${netPnlSql()})::float8 FROM trades t WHERE t.deleted_at IS NULL AND t.trader = d.trader
             AND ${closeDateSql()} = d.date AND ${resultSql()} IN ('win','loss','be')) AS net
    FROM eod_days d
   WHERE d.closed_at IS NOT NULL AND d.reviewed_at IS NOT NULL AND d.reviewed_at > NOW() - INTERVAL '7 days'`;

/**
 * eod_overdue: closed days waiting > SLA → the trader's assigned staff (fallback: every curator/admin), once per
 * closed day (dedup key = day id + closed_at, atomic across processes). There is no scheduler for this yet, so the
 * sweep piggybacks on the curator queue reads (badge polling), throttled to once per 5 minutes per process and
 * always run in the background.
 */
const OVERDUE_SWEEP_MS = 5 * 60 * 1000;
let lastOverdueSweep = 0;
function sweepOverdue(): void {
  const now = Date.now();
  if (now - lastOverdueSweep < OVERDUE_SWEEP_MS) return;
  lastOverdueSweep = now;
  inBackground("eod.overdue", async () => {
    const { rows } = await pool.query<{ id: number; trader: string; date: string; closedAt: Date; reviewedAt: Date | null }>(
      `SELECT d.id, d.trader, d.date, d.closed_at AS "closedAt", d.reviewed_at AS "reviewedAt"
         FROM eod_days d
        WHERE d.closed_at IS NOT NULL AND d.reviewed_at IS NULL AND d.closed_at < NOW() - INTERVAL '${SLA_HOURS} hours'
          AND d.closed_at > NOW() - INTERVAL '14 days' -- an old backlog must not flood inboxes on first run
        ORDER BY d.closed_at ASC LIMIT 200`,
    );
    for (const d of selectOverdue(rows, new Date(), SLA_HOURS)) {
      if (!(await claimOnce(eodOverdueKey(d.id, d.closedAt)))) continue;
      await notifyUsers(await staffOrFallback(d.trader), {
        type: "eod_overdue", source: "eod",
        params: { trader: d.trader, date: d.date, hours: d.hoursWaiting, sla: SLA_HOURS },
        link: notifLinks.journalDay(d.date, d.trader), entityType: "eod_day", entityId: d.id,
      }, d.trader);
    }
  });
}

router.get("/eod/queue", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  if (!(await requireCap(req, res, "journal.review", null, "STAFF_ONLY"))) return;
  const limitRaw = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;
  await ensureTables();
  sweepOverdue();
  if (req.query.reviewed === "1") {
    const { rows } = await pool.query<QueueRow>(`${REVIEWED_SQL} ORDER BY d.reviewed_at DESC LIMIT $1`, [limit]);
    res.json({ slaHours: SLA_HOURS, mode: "reviewed", items: rows.map(serializeQueue) });
    return;
  }
  await ensureCuratorTables();
  const { rows } = await pool.query<QueueRow>(`${QUEUE_SQL} ${pendingWindowSql(req.query.old === "1")} ORDER BY d.closed_at DESC LIMIT $1`, [limit]);
  res.json({ slaHours: SLA_HOURS, mode: "pending", windowDays: QUEUE_DEFAULT_DAYS, items: rows.map(serializeQueue) });
}));

router.get("/eod/queue/count", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  if (!(await requireCap(req, res, "journal.review", null, "STAFF_ONLY"))) return;
  await ensureTables();
  await ensureCuratorTables();
  sweepOverdue();
  const { rows } = await pool.query<{ count: number; overdue: number }>(
    `SELECT COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE d.closed_at < NOW() - INTERVAL '${SLA_HOURS} hours')::int AS overdue
       FROM eod_days d WHERE d.closed_at IS NOT NULL AND d.reviewed_at IS NULL ${pendingWindowSql(req.query.old === "1")}`,
  );
  res.json({ count: rows[0]?.count ?? 0, overdue: rows[0]?.overdue ?? 0, slaHours: SLA_HOURS });
}));

router.post("/eod/days/:id/review", asyncHandler(async (req, res): Promise<void> => {
  const me = req.authUser;
  if (!me) throw unauthorized();
  if (!(await requireCap(req, res, "journal.review", null, "STAFF_ONLY"))) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const parsed = CuratorReviewBody.safeParse(req.body ?? {});
  if (!parsed.success) throw parsed.error;
  await ensureTables();
  const existing = await loadDayById(id);
  if (!existing) throw new AppError("EOD_DAY_NOT_FOUND");
  if (!existing.closedAt) throw new AppError("EOD_NOT_CLOSED");
  const { rows } = await pool.query<DayRow>(
    `UPDATE eod_days d SET reviewed_by = $2, reviewed_at = NOW(), curator_comment = $3, curator_score = $4, updated_at = NOW()
      WHERE d.id = $1 RETURNING ${DAY_COLS}`,
    [id, me.name, parsed.data.comment, parsed.data.score],
  );
  const { rows: next } = await pool.query<QueueRow>(`${QUEUE_SQL} ${pendingWindowSql(false)} ORDER BY d.closed_at DESC LIMIT 1`);
  // Review done → tell the trader (never the reviewer about their own review).
  const reviewed = rows[0];
  if (reviewed && reviewed.trader !== me.name) {
    const reviewer = me.name;
    inBackground("eod.reviewed", () => notifyUser({
      userName: reviewed.trader, type: "eod_reviewed", actor: reviewer, source: "eod",
      params: {
        date: reviewed.date, score: reviewed.curatorScore ?? null, reviewer,
        comment: reviewed.curatorComment ? textPreview(reviewed.curatorComment, 140) : null,
      },
      link: notifLinks.journalDay(reviewed.date, reviewed.trader), entityType: "eod_day", entityId: reviewed.id,
    }));
  }
  // Лента активности: «разобран торговый день». entity_id = «дата|трейдер» — трейдер видит разбор своего дня (owner в /activity).
  if (reviewed) {
    const reviewer = me.name;
    inBackground("eod.reviewed.activity", () => logActivity({
      action: "reviewed", section: "eod", entityId: `${reviewed.date}|${reviewed.trader}`, entityTitle: activityTitle("eod_reviewed", { trader: reviewed.trader, date: reviewed.date }),
      params: { titleKey: "eod_reviewed", trader: reviewed.trader, date: reviewed.date },
      trader: reviewer, details: `${reviewed.curatorScore ?? "—"}/5${reviewed.curatorComment ? ` · ${textPreview(reviewed.curatorComment, 200)}` : ""}`,
    }));
  }
  res.json({ day: serializeDay(rows[0]), next: next[0] ? serializeQueue(next[0]) : null });
}));

export default router;
