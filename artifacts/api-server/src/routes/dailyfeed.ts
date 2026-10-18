import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { sanitizeMultiLineUrls } from "../lib/safe-url";
import { logger } from "../lib/logger";
import { logActivity } from "../lib/activity";
import { activityDetails, activityTitle } from "../lib/activityText";
import { requireMember, scopeTrader } from "../lib/auth";
import { can, readScope, requireCap, resolveActor } from "../lib/permissions";
import { closeDateSql, horizonSql, netPnlSql, resultSql, signedRSql } from "../lib/tradeMath";
import { addDays, nyDate } from "../lib/tradingDate";
import { buildFeedStream, getLastSeen, markSeen, type FeedViewer } from "../lib/feedStream";
import { isConfigured as propReportsConfigured, schedulerStatus } from "../lib/propreports";
import {
  CreateDailyFeedBody,
  GetDailyFeedParams,
  UpdateDailyFeedParams,
  UpdateDailyFeedBody,
  DeleteDailyFeedParams,
  ListDailyFeedResponse,
  GetDailyFeedResponse,
  UpdateDailyFeedResponse,
} from "@workspace/api-zod";
import { AppError, badRequest, notFound, sendError, unauthorized } from "../lib/http";
import { langOf, localeTagFor } from "../i18n";
import { feedT } from "../i18n/ns";

/**
 * Daily feed ("Дейли-фид") — the desk's briefing per trading date.
 *
 *   GET    /dailyfeed?from&to&limit&offset   member; entries + per-entry acks (read / ack / trading_this) and the viewer's own
 *   GET    /dailyfeed/stream?to&days         auto feed (lib/feedStream): day results, achievements, discipline, reviews, ideas,
 *                                            playbook, threads, game plans, market events; privacy by readScope; + lastSeenAt
 *   POST   /dailyfeed/stream/seen            member; «last visit» = now (for «новое с последнего визита»)
 *   GET    /dailyfeed/context?from&to&trader session context per day, scoped by role (trader → own trades), net money via lib/tradeMath,
 *                                            per broker account, synced flag (PropReports)
 *   POST   /dailyfeed                        member; author = authUser
 *   POST   /dailyfeed/eod?date=&force=       staff; EOD recap entry (waits for the PropReports sync when configured)
 *   GET    /dailyfeed/:id, PATCH, DELETE, POST /:id/restore   owner or staff; soft-delete aware
 *   POST   /dailyfeed/:id/ack               {kind: read|ack|trading_this, on?: boolean}
 *   GET    /dailyfeed/:id/acks              who read / acknowledged / is trading this
 */
const router: IRouter = Router();

let ensured: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `ALTER TABLE daily_feed ADD COLUMN IF NOT EXISTS created_by TEXT;
         CREATE INDEX IF NOT EXISTS daily_feed_date_idx ON daily_feed (date);
         CREATE TABLE IF NOT EXISTS feed_acks (
           entry_id INTEGER NOT NULL REFERENCES daily_feed(id) ON DELETE CASCADE,
           user_name TEXT NOT NULL,
           kind TEXT NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           PRIMARY KEY (entry_id, user_name, kind)
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
ensureTables().catch((err) => logger.warn({ err }, "dailyfeed: ensure tables failed at init"));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACK_KINDS = ["read", "ack", "trading_this"] as const;
type AckKind = (typeof ACK_KINDS)[number];

const r2 = (v: number) => Math.round(v * 100) / 100;
const strToNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

type FeedRow = {
  id: number; date: string; what_works_now: string | null; what_doesnt_work: string | null; best_tickers: string | null;
  market_theme: string | null; notes: string | null; tags: string | null; screenshot_url: string | null; screenshot_notes: string | null;
  created_at: Date; deleted_at: Date | null; created_by: string | null;
};
const COLS = `id, date, what_works_now, what_doesnt_work, best_tickers, market_theme, notes, tags, screenshot_url, screenshot_notes, created_at, deleted_at, created_by`;

type AckSummary = { counts: Record<AckKind, number>; mine: AckKind[]; users: Record<AckKind, string[]> };

function emptyAcks(): AckSummary {
  return { counts: { read: 0, ack: 0, trading_this: 0 }, mine: [], users: { read: [], ack: [], trading_this: [] } };
}

async function acksFor(ids: number[], viewer: string | null): Promise<Map<number, AckSummary>> {
  const out = new Map<number, AckSummary>();
  if (!ids.length) return out;
  const { rows } = await pool.query<{ entry_id: number; user_name: string; kind: string }>(
    `SELECT entry_id, user_name, kind FROM feed_acks WHERE entry_id = ANY($1::int[]) ORDER BY created_at`,
    [ids],
  );
  for (const r of rows) {
    const kind = r.kind as AckKind;
    if (!ACK_KINDS.includes(kind)) continue;
    const s = out.get(r.entry_id) ?? emptyAcks();
    s.counts[kind]++;
    if (s.users[kind].length < 12) s.users[kind].push(r.user_name);
    if (viewer && r.user_name === viewer) s.mine.push(kind);
    out.set(r.entry_id, s);
  }
  return out;
}

function serializeFeed(r: FeedRow, acks?: AckSummary) {
  const base = {
    id: r.id, date: r.date, whatWorksNow: r.what_works_now, whatDoesntWork: r.what_doesnt_work, bestTickers: r.best_tickers,
    marketTheme: r.market_theme, notes: r.notes, tags: r.tags, screenshotUrl: r.screenshot_url, screenshotNotes: r.screenshot_notes,
    createdAt: r.created_at.toISOString(),
  };
  return { ...GetDailyFeedResponse.parse(base), createdBy: r.created_by, acks: acks ?? emptyAcks() };
}

async function loadFeed(id: number, includeDeleted = false): Promise<FeedRow | null> {
  const { rows } = await pool.query<FeedRow>(`SELECT ${COLS} FROM daily_feed WHERE id = $1 ${includeDeleted ? "" : "AND deleted_at IS NULL"} LIMIT 1`, [id]);
  return rows[0] ?? null;
}

async function canModify(req: Request, r: FeedRow): Promise<boolean> {
  if (!req.authUser) return false;
  if (r.created_by != null && r.created_by === req.authUser.name) return true;
  if (await can(req, "dailyfeed.manage", r.created_by ? { trader: r.created_by } : undefined)) return true;
  return r.created_by == null;
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { sendError(res, badRequest("INVALID_ID")); return null; }
  return id;
}

const ListQuery = z.object({
  from: z.string().regex(ISO_DATE).optional(),
  to: z.string().regex(ISO_DATE).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

router.get("/dailyfeed", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!req.authUser) throw unauthorized();
  const q = ListQuery.safeParse({ from: req.query.from || undefined, to: req.query.to || undefined, limit: req.query.limit, offset: req.query.offset });
  if (!q.success) throw new AppError("INVALID_RANGE", undefined, { max: 2000 });
  const where: string[] = ["deleted_at IS NULL"];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (q.data.from) where.push(`substring(date, 1, 10) >= ${p(q.data.from)}`);
  if (q.data.to) where.push(`substring(date, 1, 10) <= ${p(q.data.to)}`);
  const limit = q.data.limit ?? 1000, offset = q.data.offset ?? 0;
  const { rows } = await pool.query<FeedRow>(
    `SELECT ${COLS} FROM daily_feed WHERE ${where.join(" AND ")} ORDER BY date DESC, created_at DESC LIMIT ${p(limit)} OFFSET ${p(offset)}`,
    params,
  );
  const acks = await acksFor(rows.map((r) => r.id), req.authUser.name);
  const items = rows.map((r) => serializeFeed(r, acks.get(r.id)));
  ListDailyFeedResponse.parse(items);
  res.json(items);
}));

/**
 * Per-day session context for the feed's day headers: what the scoped trader(s) actually traded (net, by close date)
 * and which market events were logged on each date in [from, to].
 */
const ContextQuery = z.object({
  from: z.string().regex(ISO_DATE),
  to: z.string().regex(ISO_DATE),
});

type AccountCtx = { account: string; n: number; grossPnl: number | null; fees: number | null; netPnl: number | null; synced: boolean };
type DayContext = {
  trades: number; wins: number; losses: number; be: number; open: number; traders: number;
  sumR: number | null; grossPnl: number | null; fees: number | null; netPnl: number | null;
  synced: boolean; lastSyncedAt: string | null;
  byAccount: AccountCtx[];
  tickers: { ticker: string; n: number }[];
  events: number;
  eventItems: { id: number; ticker: string; eventType: string; headline: string; percentMove: number | null; session: string | null }[];
};

router.get("/dailyfeed/context", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const scope = await scopeTrader(req, typeof req.query.trader === "string" ? req.query.trader : null);
  if (scope === undefined) throw unauthorized();
  const parsed = ContextQuery.safeParse(req.query);
  if (!parsed.success) throw new AppError("INVALID_RANGE", undefined, { max: 400 });
  const { from, to } = parsed.data;
  const span = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (!Number.isFinite(span) || span < 0 || span > 400) throw new AppError("RANGE_TOO_LONG", undefined, { max: 400 });

  const D = `substring(${closeDateSql("t")}, 1, 10)`;
  const base = `FROM trades t WHERE t.deleted_at IS NULL AND ${D} BETWEEN $1 AND $2 AND ($3::text IS NULL OR t.trader = $3)`;
  const [tradeAgg, byAccount, tradeTickers, events] = await Promise.all([
    pool.query<Record<string, unknown>>(
      `SELECT ${D} AS d,
              COUNT(*)::text AS n,
              COUNT(*) FILTER (WHERE ${resultSql("t")} = 'win')::text AS wins,
              COUNT(*) FILTER (WHERE ${resultSql("t")} = 'loss')::text AS losses,
              COUNT(*) FILTER (WHERE ${resultSql("t")} = 'be')::text AS be,
              COUNT(*) FILTER (WHERE ${resultSql("t")} = 'open')::text AS open,
              COUNT(DISTINCT t.trader)::text AS traders,
              SUM(${signedRSql("t")})::text AS sum_r,
              SUM(t.pnl)::text AS gross,
              SUM(ABS(COALESCE(t.fees, 0))) FILTER (WHERE t.pnl IS NOT NULL)::text AS fees,
              SUM(${netPnlSql("t")})::text AS net,
              BOOL_OR(t.source = 'propreports') AS synced,
              MAX(t.synced_at) AS last_synced
         ${base} GROUP BY 1`, [from, to, scope]),
    pool.query<Record<string, unknown>>(
      `SELECT ${D} AS d, COALESCE(t.broker_account, '') AS account, COUNT(*)::text AS n,
              SUM(t.pnl)::text AS gross, SUM(ABS(COALESCE(t.fees, 0))) FILTER (WHERE t.pnl IS NOT NULL)::text AS fees,
              BOOL_OR(t.source = 'propreports') AS synced
         ${base} GROUP BY 1, 2 ORDER BY 1, 2`, [from, to, scope]),
    pool.query<{ d: string; ticker: string; n: string }>(
      `SELECT ${D} AS d, UPPER(t.ticker) AS ticker, COUNT(*)::text AS n ${base} GROUP BY 1, 2 ORDER BY 1, COUNT(*) DESC`, [from, to, scope]),
    pool.query<{ id: number; d: string; ticker: string; event_type: string; headline: string; percent_move: string | null; session: string | null }>(
      `SELECT id, substring(date, 1, 10) AS d, UPPER(ticker) AS ticker, event_type, headline, percent_move::text AS percent_move, session
         FROM market_events
        WHERE deleted_at IS NULL AND substring(date, 1, 10) BETWEEN $1 AND $2
        ORDER BY 2, ABS(COALESCE(percent_move, 0)) DESC`, [from, to]),
  ]);

  const days: Record<string, DayContext> = {};
  const day = (d: string): DayContext =>
    (days[d] ??= { trades: 0, wins: 0, losses: 0, be: 0, open: 0, traders: 0, sumR: null, grossPnl: null, fees: null, netPnl: null, synced: false, lastSyncedAt: null, byAccount: [], tickers: [], events: 0, eventItems: [] });

  for (const r of tradeAgg.rows) {
    const c = day(String(r.d));
    c.trades = Number(r.n); c.wins = Number(r.wins); c.losses = Number(r.losses); c.be = Number(r.be); c.open = Number(r.open);
    c.traders = Number(r.traders);
    const sr = strToNum(r.sum_r); c.sumR = sr == null ? null : r2(sr);
    const gross = strToNum(r.gross); const fees = strToNum(r.fees); const net = strToNum(r.net);
    c.grossPnl = gross == null ? null : r2(gross);
    c.fees = gross == null ? null : r2(fees ?? 0);
    c.netPnl = net == null ? null : r2(net);
    c.synced = !!r.synced;
    c.lastSyncedAt = r.last_synced instanceof Date ? r.last_synced.toISOString() : r.last_synced ? String(r.last_synced) : null;
  }
  for (const r of byAccount.rows) {
    const c = day(String(r.d));
    const gross = strToNum(r.gross); const fees = strToNum(r.fees);
    if (c.byAccount.length < 10) c.byAccount.push({ account: String(r.account), n: Number(r.n), grossPnl: gross == null ? null : r2(gross), fees: gross == null ? null : r2(fees ?? 0), netPnl: gross == null ? null : r2(gross - (fees ?? 0)), synced: !!r.synced });
  }
  for (const r of tradeTickers.rows) {
    const c = day(r.d);
    if (c.tickers.length < 12) c.tickers.push({ ticker: r.ticker, n: Number(r.n) });
  }
  for (const r of events.rows) {
    const c = day(r.d);
    c.events += 1;
    if (c.eventItems.length < 8) {
      const pm = r.percent_move != null ? Number(r.percent_move) : null;
      c.eventItems.push({ id: r.id, ticker: r.ticker, eventType: r.event_type, headline: r.headline, percentMove: pm != null && Number.isFinite(pm) ? pm : null, session: r.session });
    }
  }
  res.json({ from, to, scope, days });
}));

// ─── Auto feed («Лента деска») ──────────────────────────────────────────────

const StreamQuery = z.object({
  /** Last day of the window (inclusive), default = today (NY). Paging: pass the previous response's `from` − 1 day. */
  to: z.string().regex(ISO_DATE).optional(),
  days: z.coerce.number().int().min(1).max(62).optional(),
});

/**
 * GET /dailyfeed/stream?to=&days=  — items assembled from trades, academy, rules/risk, reviews, ideas, playbook,
 * discussions, game plans and market events (lib/feedStream). Privacy: a trader gets only their own private items
 * plus public desk items; staff (team.read) get every trader; risk breaches need risk.read.team.
 * `lastSeenAt` = the viewer's previous visit (POST /dailyfeed/stream/seen moves it).
 */
router.get("/dailyfeed/stream", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  const actor = await resolveActor(req);
  if (!actor) throw unauthorized();
  const parsed = StreamQuery.safeParse({ to: req.query.to || undefined, days: req.query.days || undefined });
  if (!parsed.success) throw new AppError("INVALID_RANGE", undefined, { max: 62 });
  const today = nyDate();
  const to = parsed.data.to && parsed.data.to < today ? parsed.data.to : today;
  const from = addDays(to, -((parsed.data.days ?? 14) - 1));
  const traders = actor.guest ? [] : await readScope(req, "team.read");
  const viewer: FeedViewer = {
    name: actor.guest ? null : actor.name,
    traders,
    staff: !actor.guest && traders === null,
    riskTeam: !actor.guest && (await can(req, "risk.read.team")),
  };
  const [stream, lastSeenAt] = await Promise.all([
    buildFeedStream(viewer, from, to, new Date(), langOf(req)),
    actor.guest ? Promise.resolve(null) : getLastSeen(actor.name).catch(() => null),
  ]);
  res.json({
    ...stream,
    viewer: viewer.name,
    staff: viewer.staff,
    lastSeenAt,
    hasMore: !!stream.earliest && stream.earliest < from,
    nextTo: addDays(from, -1),
  });
}));

router.post("/dailyfeed/stream/seen", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  res.json(await markSeen(req.authUser!.name));
}));

router.post("/dailyfeed", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const parsed = CreateDailyFeedBody.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const d = parsed.data as Record<string, unknown> & { date: string };
  if (!ISO_DATE.test(String(d.date).slice(0, 10))) throw badRequest("INVALID_DATE");
  const { rows } = await pool.query<FeedRow>(
    `INSERT INTO daily_feed (date, what_works_now, what_doesnt_work, best_tickers, market_theme, notes, tags, screenshot_url, screenshot_notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLS}`,
    [
      String(d.date).slice(0, 10), d.whatWorksNow ?? null, d.whatDoesntWork ?? null, d.bestTickers ?? null, d.marketTheme ?? null,
      d.notes ?? null, d.tags ?? null, d.screenshotUrl != null ? sanitizeMultiLineUrls(String(d.screenshotUrl)) : null,
      d.screenshotNotes ?? null, req.authUser!.name,
    ],
  );
  const entry = rows[0];
  logActivity({ action: "created", section: "dailyfeed", entityId: String(entry.id), entityTitle: `${entry.date}${entry.market_theme ? ` · ${entry.market_theme}` : ""}`, trader: req.authUser!.name });
  res.status(201).json(serializeFeed(entry));
}));

// ─── EOD recap (staff) ──────────────────────────────────────────────────────

const EOD_TAG = "eod";

type EodTrader = { trader: string; n: number; wins: number; losses: number; be: number; open: number; sumR: number | null; gross: number | null; fees: number | null; net: number | null; synced: boolean };

/**
 * Build the end-of-day recap for a date from closed trades (net money, shared math) and open carries.
 * Returns 409 while the PropReports sync for that day is still pending (configured + nothing synced for the date), unless ?force=1.
 */
router.post("/dailyfeed/eod", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!(await requireCap(req, res, "dailyfeed.manage"))) return;
  const date = typeof req.query.date === "string" && ISO_DATE.test(req.query.date) ? req.query.date : nyDate();
  const force = req.query.force === "1" || req.query.force === "true" || req.body?.force === true;
  const dryRun = req.query.dry === "1";

  if (propReportsConfigured() && !force) {
    const sched = schedulerStatus();
    if (sched.running) {
      throw new AppError("SYNC_RUNNING", 409, undefined, { scheduler: sched });
    }
    const { rows } = await pool.query<{ last: Date | null; n: string }>(
      `SELECT MAX(synced_at) AS last, COUNT(*)::text AS n FROM trades WHERE deleted_at IS NULL AND source = 'propreports' AND substring(${closeDateSql("trades")}, 1, 10) = $1`,
      [date],
    );
    const synced = Number(rows[0]?.n ?? 0);
    if (synced === 0) {
      throw new AppError("SYNC_PENDING", 409, undefined, { date, lastSyncedAt: rows[0]?.last ? new Date(rows[0].last).toISOString() : null, scheduler: sched });
    }
  }

  const D = `substring(${closeDateSql("t")}, 1, 10)`;
  // The EOD entry is a post by the curator who runs it → written in their language.
  const lang = langOf(req);
  const tr = feedT.tFor(lang);
  const [perTrader, perSetup, perTicker, carries] = await Promise.all([
    pool.query<Record<string, unknown>>(
      `SELECT COALESCE(t.trader, '—') AS trader, COUNT(*)::text AS n,
              COUNT(*) FILTER (WHERE ${resultSql("t")} = 'win')::text AS wins,
              COUNT(*) FILTER (WHERE ${resultSql("t")} = 'loss')::text AS losses,
              COUNT(*) FILTER (WHERE ${resultSql("t")} = 'be')::text AS be,
              COUNT(*) FILTER (WHERE ${resultSql("t")} = 'open')::text AS open,
              SUM(${signedRSql("t")})::text AS sum_r, SUM(t.pnl)::text AS gross,
              SUM(ABS(COALESCE(t.fees, 0))) FILTER (WHERE t.pnl IS NOT NULL)::text AS fees, SUM(${netPnlSql("t")})::text AS net,
              BOOL_OR(t.source = 'propreports') AS synced
         FROM trades t WHERE t.deleted_at IS NULL AND ${D} = $1 GROUP BY 1 ORDER BY SUM(${netPnlSql("t")}) DESC NULLS LAST, 1`, [date]),
    pool.query<Record<string, unknown>>(
      `SELECT COALESCE(NULLIF(TRIM(t.setup), ''), $2) AS setup, COUNT(*)::text AS n,
              COUNT(*) FILTER (WHERE ${resultSql("t")} = 'win')::text AS wins, COUNT(*) FILTER (WHERE ${resultSql("t")} = 'loss')::text AS losses,
              SUM(${signedRSql("t")})::text AS sum_r, SUM(${netPnlSql("t")})::text AS net
         FROM trades t WHERE t.deleted_at IS NULL AND ${D} = $1 GROUP BY 1 ORDER BY SUM(${netPnlSql("t")}) DESC NULLS LAST, SUM(${signedRSql("t")}) DESC NULLS LAST`, [date, tr("eod.noSetup")]),
    pool.query<Record<string, unknown>>(
      `SELECT UPPER(t.ticker) AS ticker, COUNT(*)::text AS n, SUM(${netPnlSql("t")})::text AS net, SUM(${signedRSql("t")})::text AS sum_r
         FROM trades t WHERE t.deleted_at IS NULL AND ${D} = $1 GROUP BY 1 ORDER BY SUM(${netPnlSql("t")}) DESC NULLS LAST, COUNT(*) DESC LIMIT 8`, [date]),
    pool.query<Record<string, unknown>>(
      `SELECT t.trader, UPPER(t.ticker) AS ticker, t.side, ${horizonSql("t")} AS horizon, t.qty
         FROM trades t WHERE t.deleted_at IS NULL AND substring(t.date, 1, 10) <= $1
          AND (${resultSql("t")} = 'open' OR (t.result IS NULL AND ${horizonSql("t")} <> 'intraday' AND NULLIF(t.exit_date, '') IS NULL))
         ORDER BY t.trader, t.ticker LIMIT 50`, [date]),
  ]);

  const money = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}$${Math.abs(v).toLocaleString(localeTagFor(lang), { maximumFractionDigits: 0 })}`);
  const rr = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}R`);
  const traders: EodTrader[] = perTrader.rows.map((r) => {
    const gross = strToNum(r.gross), fees = strToNum(r.fees), net = strToNum(r.net), sr = strToNum(r.sum_r);
    return {
      trader: String(r.trader), n: Number(r.n), wins: Number(r.wins), losses: Number(r.losses), be: Number(r.be), open: Number(r.open),
      sumR: sr == null ? null : r2(sr), gross: gross == null ? null : r2(gross), fees: gross == null ? null : r2(fees ?? 0), net: net == null ? null : r2(net), synced: !!r.synced,
    };
  });
  const totalNet = traders.some((t) => t.net != null) ? r2(traders.reduce((s, t) => s + (t.net ?? 0), 0)) : null;
  const totalR = traders.some((t) => t.sumR != null) ? r2(traders.reduce((s, t) => s + (t.sumR ?? 0), 0)) : null;
  const totalN = traders.reduce((s, t) => s + t.n, 0);
  const setups = perSetup.rows.map((r) => ({ setup: String(r.setup), n: Number(r.n), wins: Number(r.wins), losses: Number(r.losses), sumR: strToNum(r.sum_r), net: strToNum(r.net) }));
  const good = setups.filter((s) => (s.net != null ? s.net > 0 : (s.sumR ?? 0) > 0));
  const bad = setups.filter((s) => (s.net != null ? s.net < 0 : (s.sumR ?? 0) < 0));
  const fmtSetup = (s: typeof setups[number]) => tr("eod.setupLine", { setup: s.setup, n: s.n, wins: s.wins, losses: s.losses, result: s.net != null ? tr("eod.net", { money: money(s.net) }) : rr(s.sumR) });
  const tickers = perTicker.rows.map((r) => String(r.ticker)).filter(Boolean);

  const lines: string[] = [];
  lines.push(tr("eod.head", { date, trades: tr("eod.trades", { count: totalN }), result: totalNet != null ? tr("eod.net", { money: money(totalNet) }) : tr("eod.pnlMissing"), r: totalR != null ? `, ${rr(totalR)}` : "" }));
  for (const t of traders) {
    const decided = t.wins + t.losses;
    const wr = decided ? `${Math.round((t.wins / decided) * 100)}% WR` : "WR —";
    lines.push(tr("eod.traderLine", {
      trader: t.trader, n: t.n, wl: `${t.wins}W/${t.losses}L${t.be ? `/${t.be}BE` : ""}`, open: t.open ? tr("eod.open", { n: t.open }) : "",
      result: t.net != null ? tr("eod.netDetail", { net: money(t.net), gross: money(t.gross), fees: `$${(t.fees ?? 0).toFixed(0)}` }) : rr(t.sumR),
      wr, manual: t.synced ? "" : tr("eod.manual"),
    }));
  }
  if (carries.rows.length) {
    lines.push("");
    lines.push(tr("eod.carries"));
    for (const c of carries.rows) lines.push(`• ${c.trader ?? "—"}: ${c.ticker} ${String(c.side ?? "").toUpperCase()}${c.qty != null ? ` ×${strToNum(c.qty)}` : ""} (${c.horizon})`);
  }
  const whatWorks = good.slice(0, 5).map(fmtSetup).join("\n") || null;
  const whatFails = bad.slice(0, 5).map(fmtSetup).join("\n") || null;
  const payload = {
    date, marketTheme: tr("eod.theme", { value: totalNet != null ? tr("eod.net", { money: money(totalNet) }) : tr("eod.trades", { count: totalN }) }),
    whatWorksNow: whatWorks, whatDoesntWork: whatFails, bestTickers: tickers.join(", ") || null, notes: lines.join("\n"),
    tags: EOD_TAG, stats: { traders, setups, tickers: perTicker.rows.map((r) => ({ ticker: String(r.ticker), n: Number(r.n), net: strToNum(r.net), sumR: strToNum(r.sum_r) })), totalNet, totalR, totalN, carries: carries.rows.length },
  };
  if (dryRun) { res.json({ dryRun: true, entry: null, ...payload }); return; }

  // One EOD entry per date: update the existing one instead of duplicating.
  const { rows: existing } = await pool.query<FeedRow>(
    `SELECT ${COLS} FROM daily_feed WHERE deleted_at IS NULL AND substring(date, 1, 10) = $1 AND (',' || LOWER(regexp_replace(COALESCE(tags, ''), '\\s*,\\s*', ',', 'g')) || ',') LIKE '%,eod,%' ORDER BY id LIMIT 1`,
    [date],
  );
  let entry: FeedRow;
  if (existing[0]) {
    const { rows } = await pool.query<FeedRow>(
      `UPDATE daily_feed SET market_theme = $2, what_works_now = $3, what_doesnt_work = $4, best_tickers = $5, notes = $6 WHERE id = $1 RETURNING ${COLS}`,
      [existing[0].id, payload.marketTheme, payload.whatWorksNow, payload.whatDoesntWork, payload.bestTickers, payload.notes],
    );
    entry = rows[0];
  } else {
    const { rows } = await pool.query<FeedRow>(
      `INSERT INTO daily_feed (date, market_theme, what_works_now, what_doesnt_work, best_tickers, notes, tags, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLS}`,
      [date, payload.marketTheme, payload.whatWorksNow, payload.whatDoesntWork, payload.bestTickers, payload.notes, EOD_TAG, req.authUser!.name],
    );
    entry = rows[0];
  }
  logActivity({ action: existing[0] ? "eod_updated" : "eod_created", section: "dailyfeed", entityId: String(entry.id), entityTitle: activityTitle("eod_day", { date }), trader: req.authUser!.name, details: totalNet != null ? activityDetails("eodNet", { net: totalNet }) : undefined, params: { titleKey: "eod_day", ...(totalNet != null ? { detailsKey: "eodNet" } : {}), date, net: totalNet ?? null } });
  res.status(existing[0] ? 200 : 201).json({ entry: serializeFeed(entry), updated: !!existing[0], ...payload });
}));

// ─── Single entry ──────────────────────────────────────────────────────────

router.get("/dailyfeed/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!req.authUser) throw unauthorized();
  const params = GetDailyFeedParams.safeParse(req.params);
  if (!params.success) throw params.error;
  const entry = await loadFeed(params.data.id);
  if (!entry) throw notFound("FEED_ENTRY_NOT_FOUND");
  const acks = await acksFor([entry.id], req.authUser.name);
  res.json(serializeFeed(entry, acks.get(entry.id)));
}));

const COL: Record<string, string> = {
  date: "date", whatWorksNow: "what_works_now", whatDoesntWork: "what_doesnt_work", bestTickers: "best_tickers", marketTheme: "market_theme",
  notes: "notes", tags: "tags", screenshotUrl: "screenshot_url", screenshotNotes: "screenshot_notes",
};

router.patch("/dailyfeed/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const params = UpdateDailyFeedParams.safeParse(req.params);
  if (!params.success) throw params.error;
  const parsed = UpdateDailyFeedBody.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const existing = await loadFeed(params.data.id);
  if (!existing) throw notFound("FEED_ENTRY_NOT_FOUND");
  if (!(await canModify(req, existing))) throw new AppError("AUTHOR_OR_STAFF_ONLY");
  const d = parsed.data as Record<string, unknown>;
  if (d.date !== undefined && !ISO_DATE.test(String(d.date).slice(0, 10))) throw badRequest("INVALID_DATE");
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || !COL[k]) continue;
    vals.push(k === "screenshotUrl" ? sanitizeMultiLineUrls(v as string | null) : k === "date" ? String(v).slice(0, 10) : v);
    sets.push(`${COL[k]} = $${vals.length}`);
  }
  let entry = existing;
  if (sets.length) {
    vals.push(existing.id);
    const { rows } = await pool.query<FeedRow>(`UPDATE daily_feed SET ${sets.join(", ")} WHERE id = $${vals.length} AND deleted_at IS NULL RETURNING ${COLS}`, vals);
    if (!rows[0]) throw notFound("FEED_ENTRY_NOT_FOUND");
    entry = rows[0];
  }
  logActivity({ action: "updated", section: "dailyfeed", entityId: String(entry.id), entityTitle: `${entry.date}${entry.market_theme ? ` · ${entry.market_theme}` : ""}`, trader: req.authUser!.name });
  const acks = await acksFor([entry.id], req.authUser!.name);
  const out = serializeFeed(entry, acks.get(entry.id));
  UpdateDailyFeedResponse.parse(out);
  res.json(out);
}));

router.delete("/dailyfeed/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const params = DeleteDailyFeedParams.safeParse(req.params);
  if (!params.success) throw params.error;
  const existing = await loadFeed(params.data.id);
  if (!existing) throw notFound("FEED_ENTRY_NOT_FOUND");
  if (!(await canModify(req, existing))) throw new AppError("AUTHOR_OR_STAFF_ONLY");
  await pool.query(`UPDATE daily_feed SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`, [existing.id]);
  logActivity({ action: "deleted", section: "dailyfeed", entityId: String(existing.id), entityTitle: existing.date, trader: req.authUser!.name });
  res.sendStatus(204);
}));

router.post("/dailyfeed/:id/restore", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const id = parseId(req, res); if (id == null) return;
  const existing = await loadFeed(id, true);
  if (!existing || !existing.deleted_at) throw notFound("FEED_ENTRY_NOT_FOUND");
  if (!(await canModify(req, existing))) throw new AppError("AUTHOR_OR_STAFF_ONLY");
  await pool.query(`UPDATE daily_feed SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL`, [id]);
  logActivity({ action: "restored", section: "dailyfeed", entityId: String(id), entityTitle: existing.date, trader: req.authUser!.name });
  res.json({ success: true });
}));

// ─── Acks ───────────────────────────────────────────────────────────────────

const AckBody = z.object({ kind: z.enum(ACK_KINDS), on: z.coerce.boolean().optional() });

router.post("/dailyfeed/:id/ack", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const id = parseId(req, res); if (id == null) return;
  const body = AckBody.safeParse(req.body);
  if (!body.success) throw new AppError("INVALID_FIELD", undefined, { field: "kind" });
  const existing = await loadFeed(id);
  if (!existing) throw notFound("FEED_ENTRY_NOT_FOUND");
  const on = body.data.on ?? true;
  const me = req.authUser!.name;
  if (on) {
    await pool.query(`INSERT INTO feed_acks (entry_id, user_name, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, me, body.data.kind]);
    // Any acknowledgement implies the entry was read.
    if (body.data.kind !== "read") await pool.query(`INSERT INTO feed_acks (entry_id, user_name, kind) VALUES ($1, $2, 'read') ON CONFLICT DO NOTHING`, [id, me]);
  } else {
    await pool.query(`DELETE FROM feed_acks WHERE entry_id = $1 AND user_name = $2 AND kind = $3`, [id, me, body.data.kind]);
  }
  if (on && body.data.kind !== "read") logActivity({ action: body.data.kind, section: "dailyfeed", entityId: String(id), entityTitle: existing.date, trader: me });
  const acks = await acksFor([id], me);
  res.json({ id, acks: acks.get(id) ?? emptyAcks() });
}));

router.get("/dailyfeed/:id/acks", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!req.authUser) throw unauthorized();
  const id = parseId(req, res); if (id == null) return;
  const existing = await loadFeed(id);
  if (!existing) throw notFound("FEED_ENTRY_NOT_FOUND");
  const { rows } = await pool.query<{ user_name: string; kind: string; created_at: Date }>(
    `SELECT user_name, kind, created_at FROM feed_acks WHERE entry_id = $1 ORDER BY created_at`, [id],
  );
  const byKind: Record<AckKind, { user: string; at: string }[]> = { read: [], ack: [], trading_this: [] };
  for (const r of rows) if ((ACK_KINDS as readonly string[]).includes(r.kind)) byKind[r.kind as AckKind].push({ user: r.user_name, at: r.created_at.toISOString() });
  // Who has NOT read it yet (active members) — only meaningful for staff; traders see counts only.
  let unread: string[] | null = null;
  if (await can(req, "dailyfeed.manage")) {
    const { rows: users } = await pool.query<{ name: string }>(`SELECT name FROM users WHERE active = true AND COALESCE(banned, false) = false AND role IN ('trader', 'curator', 'admin') ORDER BY name`);
    const readers = new Set(byKind.read.map((x) => x.user));
    unread = users.map((u) => u.name).filter((n) => !readers.has(n));
  }
  res.json({ id, date: existing.date, acks: byKind, unread, viewer: req.authUser.name });
}));

export default router;
