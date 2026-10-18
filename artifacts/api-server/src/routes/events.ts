import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { sanitizeMultiLineUrls } from "../lib/safe-url";
import { logger } from "../lib/logger";
import { logActivity } from "../lib/activity";
import { activityTitle } from "../lib/activityText";
import { canAccessTrade, isStaffRole, requireMember, requireStaff, scopeTrader, viewerRole, GUEST_SCOPE } from "../lib/auth";
import { closeDateSql, horizonSql, netPnlSql, resultSql, signedRSql } from "../lib/tradeMath";
import { addDays, isWeekend, nyDate } from "../lib/tradingDate";
import { getEarnings } from "./earnings";
import {
  ListEventsQueryParams,
  CreateEventBody,
  GetEventParams,
  UpdateEventParams,
  UpdateEventBody,
  DeleteEventParams,
  ListEventsResponse,
  GetEventResponse,
  UpdateEventResponse,
} from "@workspace/api-zod";
import { AppError, badRequest, notFound, sendError, sendErrorWith, unauthorized } from "../lib/http";
import { eventsT } from "../i18n/ns";
import { langOf } from "../i18n";

/**
 * Market events ("События") — catalysts the desk trades around.
 *
 *   GET    /events?ticker&eventType&session&from&to&q&limit&offset   (member; SQL-filtered)
 *   GET    /events/today                 "В игре сегодня": today's events + open positions + earnings BMO/AMC
 *   GET    /events/holding               catalysts inside the holding window of open overnight/swing positions
 *   GET    /events/stats?ticker&type&from&to   post-event edge table (move stats + linked trade stats, net)
 *   POST   /events                       member; author = authUser; 409 on duplicate (ticker+date+type) unless force
 *   POST   /events/import-earnings?days=5      staff; upsert earnings from the calendar (session BMO/AMC)
 *   GET    /events/:id
 *   PATCH  /events/:id                   owner or staff
 *   POST   /events/:id/outcome           any member fills reaction/percentMove/volume
 *   DELETE /events/:id, POST /events/:id/restore   owner or staff
 *   GET    /events/:id/trades            scoped trades + net stats (one math: lib/tradeMath)
 *   POST   /events/:id/link-trade        {tradeId, unlink?} — set/clear trades.event_id (own trade or staff)
 *
 * Additive columns (created_by, session, pattern_id) are ensured here, never in migrate.ts.
 */
const router: IRouter = Router();

let ensured: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `ALTER TABLE market_events ADD COLUMN IF NOT EXISTS created_by TEXT;
         ALTER TABLE market_events ADD COLUMN IF NOT EXISTS session TEXT;
         ALTER TABLE market_events ADD COLUMN IF NOT EXISTS pattern_id INTEGER;
         CREATE INDEX IF NOT EXISTS market_events_date_idx ON market_events (date);
         CREATE INDEX IF NOT EXISTS market_events_ticker_upper_idx ON market_events (UPPER(ticker));`,
      )
      .then(() => undefined)
      .catch((err) => {
        ensured = null;
        throw err;
      });
  }
  return ensured;
}
ensureTables().catch((err) => logger.warn({ err }, "events: ensure columns failed at init"));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SESSIONS = ["BMO", "RTH", "AMC"] as const;
type Session = (typeof SESSIONS)[number];

/** "XOM, cvx / BP" -> ["XOM","CVX","BP"] */
function splitTickers(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,;/]+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
}

const strToNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const numToStr = (v: number | null | undefined): string | null | undefined =>
  v === undefined ? undefined : v === null ? null : String(v);

type EventRow = {
  id: number; ticker: string; date: string; event_type: string; headline: string; reaction: string | null;
  percent_move: string | null; volume: string | null; summary: string | null; screenshot_url: string | null;
  screenshot_notes: string | null; tags: string | null; market_cap: string | null; float: string | null; adv: string | null;
  atr: string | null; relative_volume: string | null; beta: string | null; short_interest: string | null; sector: string | null;
  long_name: string | null; created_at: Date; deleted_at: Date | null; created_by: string | null; session: string | null;
  pattern_id: number | null;
};

const EVENT_COLS = `id, ticker, date, event_type, headline, reaction, percent_move, volume, summary, screenshot_url, screenshot_notes,
  tags, market_cap, float, adv, atr, relative_volume, beta, short_interest, sector, long_name, created_at, deleted_at, created_by, session, pattern_id`;

function serializeEvent(e: EventRow) {
  const base = {
    id: e.id,
    ticker: e.ticker,
    date: e.date,
    eventType: e.event_type,
    headline: e.headline,
    reaction: e.reaction,
    percentMove: strToNum(e.percent_move),
    volume: e.volume,
    summary: e.summary,
    screenshotUrl: e.screenshot_url,
    screenshotNotes: e.screenshot_notes,
    tags: e.tags,
    marketCap: e.market_cap,
    float: e.float,
    adv: e.adv,
    atr: strToNum(e.atr),
    relativeVolume: strToNum(e.relative_volume),
    beta: strToNum(e.beta),
    shortInterest: strToNum(e.short_interest),
    sector: e.sector,
    longName: e.long_name,
    createdAt: e.created_at.toISOString(),
  };
  // Fields outside the generated schema are appended after the parse (zod strips unknown keys).
  const extra = { createdBy: e.created_by, session: normSession(e.session), patternId: e.pattern_id };
  return { ...GetEventResponse.parse(base), ...extra };
}

function normSession(v: unknown): Session | null {
  const s = String(v ?? "").trim().toUpperCase();
  return (SESSIONS as readonly string[]).includes(s) ? (s as Session) : null;
}

async function loadEvent(id: number, includeDeleted = false): Promise<EventRow | null> {
  const { rows } = await pool.query<EventRow>(
    `SELECT ${EVENT_COLS} FROM market_events WHERE id = $1 ${includeDeleted ? "" : "AND deleted_at IS NULL"} LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Owner (created_by) or staff; legacy rows without an author are editable by any member. */
async function canModifyEvent(req: Request, e: EventRow): Promise<boolean> {
  if (!req.authUser) return false;
  if (isStaffRole(await viewerRole(req))) return true;
  return e.created_by == null || e.created_by === req.authUser.name;
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { sendError(res, badRequest("INVALID_ID")); return null; }
  return id;
}

/** SQL fragment matching an exact ticker inside a multi-ticker field ("XOM, CVX"). */
const TICKER_MATCH = (param: string) =>
  `(',' || regexp_replace(UPPER(ticker), '[[:space:],;/]+', ',', 'g') || ',') LIKE ('%,' || ${param} || ',%')`;

// ─── Shared trade stats (one math) ─────────────────────────────────────────

type TradeStats = {
  n: number; wins: number; losses: number; be: number; open: number; winRate: number | null;
  sumR: number | null; grossPnl: number | null; fees: number | null; netPnl: number | null;
  byAccount: { account: string; n: number; grossPnl: number | null; fees: number | null; netPnl: number | null }[];
};

type TradeLite = {
  id: number; ticker: string; date: string; exitDate: string | null; closeDate: string; side: string | null; setup: string | null;
  result: string | null; horizon: string; pnl: number | null; fees: number | null; netPnl: number | null; rMultiple: number | null;
  signedR: number | null; trader: string | null; source: string | null; brokerAccount: string | null; qty: number | null; linked: boolean;
};

const TRADE_SELECT = `t.id, t.ticker, t.date, t.exit_date, ${closeDateSql("t")} AS close_date, t.side, t.setup, t.result,
  ${horizonSql("t")} AS horizon, t.pnl, t.fees, ${netPnlSql("t")} AS net_pnl, t.r_multiple, ${signedRSql("t")} AS signed_r,
  ${resultSql("t")} AS res, t.trader, t.source, t.broker_account, t.qty, t.event_id, t.pattern_id, t.created_at`;

function tradeLite(r: Record<string, unknown>, linkedKey: "event_id" | "pattern_id", linkedId: number): TradeLite {
  return {
    id: Number(r.id), ticker: String(r.ticker ?? ""), date: String(r.date ?? "").slice(0, 10),
    exitDate: r.exit_date ? String(r.exit_date) : null, closeDate: String(r.close_date ?? "").slice(0, 10),
    side: (r.side as string | null) ?? null, setup: (r.setup as string | null) ?? null, result: (r.result as string | null) ?? null,
    horizon: String(r.horizon ?? "intraday"), pnl: strToNum(r.pnl), fees: strToNum(r.fees), netPnl: strToNum(r.net_pnl),
    rMultiple: strToNum(r.r_multiple), signedR: strToNum(r.signed_r), trader: (r.trader as string | null) ?? null,
    source: (r.source as string | null) ?? null, brokerAccount: (r.broker_account as string | null) ?? null, qty: strToNum(r.qty),
    linked: Number(r[linkedKey]) === linkedId,
  };
}

/** Aggregate stats over rows produced by TRADE_SELECT. Win rate = W/(W+L), BE excluded; money is net unless labelled gross. */
export function statsOf(rows: Record<string, unknown>[]): TradeStats {
  let wins = 0, losses = 0, be = 0, open = 0, sumR = 0, hasR = false, gross = 0, fees = 0, hasPnl = false;
  const acc = new Map<string, { n: number; gross: number; fees: number; has: boolean }>();
  for (const r of rows) {
    const res = String(r.res ?? "");
    if (res === "win") wins++; else if (res === "loss") losses++; else if (res === "be") be++; else if (res === "open") open++;
    const sr = strToNum(r.signed_r);
    if (sr != null) { sumR += sr; hasR = true; }
    const pnl = strToNum(r.pnl);
    const f = Math.abs(strToNum(r.fees) ?? 0);
    const a = acc.get(String(r.broker_account ?? "")) ?? { n: 0, gross: 0, fees: 0, has: false };
    a.n++;
    if (pnl != null) { gross += pnl; fees += f; hasPnl = true; a.gross += pnl; a.fees += f; a.has = true; }
    acc.set(String(r.broker_account ?? ""), a);
  }
  const decided = wins + losses;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    n: rows.length, wins, losses, be, open,
    winRate: decided ? r2((wins / decided) * 100) : null,
    sumR: hasR ? r2(sumR) : null,
    grossPnl: hasPnl ? r2(gross) : null,
    fees: hasPnl ? r2(fees) : null,
    netPnl: hasPnl ? r2(gross - fees) : null,
    byAccount: Array.from(acc.entries())
      .filter(([k]) => k !== "")
      .map(([account, a]) => ({ account, n: a.n, grossPnl: a.has ? r2(a.gross) : null, fees: a.has ? r2(a.fees) : null, netPnl: a.has ? r2(a.gross - a.fees) : null })),
  };
}

// ─── List / create ─────────────────────────────────────────────────────────

const ListExtra = z.object({
  from: z.string().regex(ISO_DATE).optional(),
  to: z.string().regex(ISO_DATE).optional(),
  session: z.string().trim().max(3).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

router.get("/events", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!req.authUser) throw unauthorized();
  const query = ListEventsQueryParams.safeParse(req.query);
  if (!query.success) throw query.error;
  const extra = ListExtra.safeParse({
    from: typeof req.query.from === "string" && req.query.from.trim() ? req.query.from.trim() : undefined,
    to: typeof req.query.to === "string" && req.query.to.trim() ? req.query.to.trim() : undefined,
    session: typeof req.query.session === "string" && req.query.session.trim() ? req.query.session : undefined,
    q: typeof req.query.q === "string" && req.query.q.trim() ? req.query.q : undefined,
    limit: req.query.limit, offset: req.query.offset,
  });
  if (!extra.success) throw new AppError("INVALID_RANGE", undefined, { max: 2000 });
  const { ticker, eventType } = query.data;
  const { from, to, session, q, limit = 500, offset = 0 } = extra.data;

  const where: string[] = ["deleted_at IS NULL"];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (ticker?.trim()) where.push(TICKER_MATCH(p(ticker.trim().toUpperCase())));
  if (eventType?.trim()) where.push(`LOWER(TRIM(event_type)) = ${p(eventType.trim().toLowerCase())}`);
  const ses = normSession(session);
  if (ses) where.push(`UPPER(COALESCE(session, '')) = ${p(ses)}`);
  if (from) where.push(`substring(date, 1, 10) >= ${p(from)}`);
  if (to) where.push(`substring(date, 1, 10) <= ${p(to)}`);
  if (q) {
    const like = p(`%${q}%`);
    where.push(`(headline ILIKE ${like} OR COALESCE(summary, '') ILIKE ${like} OR COALESCE(tags, '') ILIKE ${like} OR UPPER(ticker) ILIKE ${like})`);
  }
  const { rows } = await pool.query<EventRow>(
    `SELECT ${EVENT_COLS} FROM market_events WHERE ${where.join(" AND ")}
      ORDER BY date DESC, created_at DESC LIMIT ${p(limit)} OFFSET ${p(offset)}`,
    params,
  );
  const items = rows.map(serializeEvent);
  // Validate the generated shape, then re-attach the additive fields.
  ListEventsResponse.parse(items);
  res.setHeader("x-limit", String(limit));
  res.setHeader("x-offset", String(offset));
  res.json(items);
}));

const CreateExtra = z.object({
  session: z.string().trim().max(3).nullish(),
  patternId: z.coerce.number().int().positive().nullish(),
  force: z.coerce.boolean().optional(),
});

async function findDuplicate(ticker: string, date: string, eventType: string, excludeId?: number): Promise<number | null> {
  const first = splitTickers(ticker)[0];
  if (!first) return null;
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM market_events
      WHERE deleted_at IS NULL AND ${TICKER_MATCH("$1")} AND substring(date, 1, 10) = $2 AND LOWER(TRIM(event_type)) = $3
        AND ($4::int IS NULL OR id <> $4)
      ORDER BY id LIMIT 1`,
    [first, date.slice(0, 10), eventType.trim().toLowerCase(), excludeId ?? null],
  );
  return rows[0]?.id ?? null;
}

router.post("/events", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const parsed = CreateEventBody.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const extra = CreateExtra.safeParse(req.body);
  if (!extra.success) throw extra.error;
  const d = parsed.data;
  if (!ISO_DATE.test(d.date.slice(0, 10))) throw badRequest("INVALID_DATE");
  const ticker = splitTickers(d.ticker).join(", ");
  if (!ticker) throw badRequest("TICKER_REQUIRED");
  const dup = await findDuplicate(ticker, d.date, d.eventType);
  if (dup && !extra.data.force) {
    sendErrorWith(res, new AppError("DUPLICATE"), { existingId: dup });
    return;
  }
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO market_events (ticker, date, event_type, headline, reaction, percent_move, volume, summary, screenshot_url, screenshot_notes,
       tags, market_cap, float, adv, atr, relative_volume, beta, short_interest, sector, long_name, created_by, session, pattern_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     RETURNING ${EVENT_COLS}`,
    [
      ticker, d.date.slice(0, 10), d.eventType.trim(), d.headline.trim(), d.reaction ?? null, numToStr(d.percentMove) ?? null,
      d.volume ?? null, d.summary ?? null, d.screenshotUrl != null ? sanitizeMultiLineUrls(d.screenshotUrl) : null,
      d.screenshotNotes ?? null, d.tags ?? null, d.marketCap ?? null, d.float ?? null, d.adv ?? null, numToStr(d.atr) ?? null,
      numToStr(d.relativeVolume) ?? null, numToStr(d.beta) ?? null, numToStr(d.shortInterest) ?? null, d.sector ?? null,
      d.longName ?? null, req.authUser!.name, normSession(extra.data.session), extra.data.patternId ?? null,
    ],
  );
  const event = rows[0];
  logActivity({ action: "created", section: "events", entityId: String(event.id), entityTitle: `${event.ticker} · ${event.headline}`, trader: req.authUser!.name });
  res.status(201).json(serializeEvent(event));
}));

// ─── Desk views (static paths before /:id) ─────────────────────────────────

/** Open positions carried by the scoped trader(s): result 'open', or multi-day horizon without an exit yet. */
const OPEN_POSITION_SQL = `(${resultSql("t")} = 'open' OR (t.result IS NULL AND ${horizonSql("t")} <> 'intraday' AND NULLIF(t.exit_date, '') IS NULL))`;

async function openPositions(scope: string | null) {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT ${TRADE_SELECT} FROM trades t
      WHERE t.deleted_at IS NULL AND ${OPEN_POSITION_SQL} AND ($1::text IS NULL OR t.trader = $1)
      ORDER BY t.date DESC, t.id DESC LIMIT 200`,
    [scope],
  );
  return rows.map((r) => tradeLite(r, "event_id", -1));
}

type EarningsLite = { ticker: string; date: string; session: Session; company: string | null; epsEstimate: number | null; marketCap: string | null };

/** Upcoming earnings (today .. +days weekdays) from the calendar cache; never throws (returns [] on upstream trouble). */
async function upcomingEarnings(days: number): Promise<EarningsLite[]> {
  const out: EarningsLite[] = [];
  let d = nyDate();
  let n = 0;
  for (let guard = 0; n < days && guard < 14; guard++, d = addDays(d, 1)) {
    if (isWeekend(d)) continue;
    n++;
    try {
      const items = await getEarnings(d);
      for (const it of items) {
        if (it.callType !== "BMO" && it.callType !== "AMC") continue;
        out.push({ ticker: it.ticker.toUpperCase(), date: d, session: it.callType, company: it.company ?? null, epsEstimate: it.epsEstimate ?? null, marketCap: it.marketCap ?? null });
      }
    } catch (err) {
      logger.warn({ err, date: d }, "events: earnings calendar unavailable");
    }
  }
  return out;
}

router.get("/events/today", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const scope = await scopeTrader(req, typeof req.query.trader === "string" ? req.query.trader : null);
  if (scope === undefined) throw unauthorized();
  const date = typeof req.query.date === "string" && ISO_DATE.test(req.query.date) ? req.query.date : nyDate();
  const [events, positions, tradesToday] = await Promise.all([
    pool.query<EventRow>(`SELECT ${EVENT_COLS} FROM market_events WHERE deleted_at IS NULL AND substring(date, 1, 10) = $1 ORDER BY session NULLS LAST, created_at`, [date]),
    scope === GUEST_SCOPE ? Promise.resolve([] as TradeLite[]) : openPositions(scope),
    pool.query<{ ticker: string; n: string }>(
      `SELECT UPPER(t.ticker) AS ticker, COUNT(*)::text AS n FROM trades t
        WHERE t.deleted_at IS NULL AND substring(t.date, 1, 10) = $1 AND ($2::text IS NULL OR t.trader = $2) GROUP BY 1`,
      [date, scope],
    ),
  ]);
  const tradedBy = new Map(tradesToday.rows.map((r) => [r.ticker, Number(r.n)]));
  const held = new Set(positions.map((p) => p.ticker.toUpperCase()));
  let earnings: EarningsLite[] | null = null;
  if (date === nyDate() && req.query.earnings !== "0") {
    const all = await upcomingEarnings(1);
    earnings = all.filter((e) => e.date === date);
  }
  res.json({
    date,
    scope,
    events: events.rows.map((e) => ({
      ...serializeEvent(e),
      tradesToday: splitTickers(e.ticker).reduce((s, t) => s + (tradedBy.get(t) ?? 0), 0),
      holding: splitTickers(e.ticker).some((t) => held.has(t)),
    })),
    earnings,
    positions,
  });
}));

/**
 * Catalysts inside the holding window of open overnight/swing positions: DB events dated today..+`days`
 * for the held tickers, plus scheduled earnings (BMO/AMC) from the calendar.
 */
router.get("/events/holding", asyncHandler(async (req, res): Promise<void> => {
  const evT = eventsT.tFor(langOf(req));
  await ensureTables();
  const scope = await scopeTrader(req, typeof req.query.trader === "string" ? req.query.trader : null);
  if (scope === undefined) throw unauthorized();
  const daysRaw = Number(req.query.days);
  const days = Number.isFinite(daysRaw) ? Math.min(30, Math.max(1, Math.floor(daysRaw))) : 10;
  const today = nyDate();
  const until = addDays(today, days);
  const positions = scope === GUEST_SCOPE ? [] : await openPositions(scope);
  const tickers = Array.from(new Set(positions.map((p) => p.ticker.toUpperCase()).filter(Boolean)));
  if (tickers.length === 0) { res.json({ date: today, until, positions: [], items: [] }); return; }
  const { rows: events } = await pool.query<EventRow>(
    `SELECT ${EVENT_COLS} FROM market_events
      WHERE deleted_at IS NULL AND substring(date, 1, 10) BETWEEN $1 AND $2
        AND EXISTS (SELECT 1 FROM unnest($3::text[]) tk WHERE ${TICKER_MATCH("tk")})
      ORDER BY date, created_at`,
    [today, until, tickers],
  );
  const earnings = req.query.earnings === "0" ? [] : (await upcomingEarnings(Math.min(days, 5))).filter((e) => tickers.includes(e.ticker));
  const byTicker = new Map<string, { position: TradeLite; catalysts: { kind: "event" | "earnings"; date: string; session: Session | null; title: string; eventId: number | null; eventType: string | null }[] }>();
  for (const p of positions) {
    const t = p.ticker.toUpperCase();
    if (!byTicker.has(t)) byTicker.set(t, { position: p, catalysts: [] });
  }
  for (const e of events) {
    for (const t of splitTickers(e.ticker)) {
      const slot = byTicker.get(t);
      if (slot) slot.catalysts.push({ kind: "event", date: e.date.slice(0, 10), session: normSession(e.session), title: e.headline, eventId: e.id, eventType: e.event_type });
    }
  }
  for (const er of earnings) {
    const slot = byTicker.get(er.ticker);
    if (!slot) continue;
    const already = slot.catalysts.some((c) => c.date === er.date && (c.eventType ?? "").toLowerCase() === "earnings");
    if (!already) slot.catalysts.push({ kind: "earnings", date: er.date, session: er.session, title: `${evT("earnings.catalyst")}${er.company ? evT("earnings.company", { company: er.company }) : ""}${er.epsEstimate != null ? evT("earnings.epsEst", { eps: String(er.epsEstimate) }) : ""}`, eventId: null, eventType: "earnings" });
  }
  const items = Array.from(byTicker.entries())
    .map(([ticker, v]) => ({ ticker, position: v.position, held: positions.filter((p) => p.ticker.toUpperCase() === ticker).length, catalysts: v.catalysts.sort((a, b) => a.date.localeCompare(b.date)) }))
    .sort((a, b) => (b.catalysts.length - a.catalysts.length) || a.ticker.localeCompare(b.ticker));
  res.json({ date: today, until, positions, items });
}));

/** Post-event edge table: per event type — reaction stats and the (scoped) trade stats around those events. */
router.get("/events/stats", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const scope = await scopeTrader(req, typeof req.query.trader === "string" ? req.query.trader : null);
  if (scope === undefined) throw unauthorized();
  const ticker = typeof req.query.ticker === "string" ? req.query.ticker.trim().toUpperCase() : "";
  const type = typeof req.query.type === "string" ? req.query.type.trim().toLowerCase() : "";
  const from = typeof req.query.from === "string" && ISO_DATE.test(req.query.from) ? req.query.from : null;
  const to = typeof req.query.to === "string" && ISO_DATE.test(req.query.to) ? req.query.to : null;
  const where: string[] = ["e.deleted_at IS NULL"];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (ticker) where.push(`(',' || regexp_replace(UPPER(e.ticker), '[[:space:],;/]+', ',', 'g') || ',') LIKE ('%,' || ${p(ticker)} || ',%')`);
  if (type) where.push(`LOWER(TRIM(e.event_type)) = ${p(type)}`);
  if (from) where.push(`substring(e.date, 1, 10) >= ${p(from)}`);
  if (to) where.push(`substring(e.date, 1, 10) <= ${p(to)}`);
  const scopeParam = p(scope);
  const { rows } = await pool.query<Record<string, unknown>>( // i18n-ignore (SQL matches stored RU / EN reaction text)
    `WITH ev AS (
       SELECT e.id, LOWER(TRIM(e.event_type)) AS event_type, UPPER(COALESCE(e.session, '')) AS session, substring(e.date, 1, 10) AS d,
              e.percent_move, LOWER(COALESCE(e.reaction, '')) AS reaction, e.ticker
         FROM market_events e WHERE ${where.join(" AND ")}
     ),
     tr AS (
       SELECT ev.event_type, ev.session, t.id AS trade_id, ${resultSql("t")} AS res, ${signedRSql("t")} AS signed_r, t.pnl, t.fees
         FROM ev JOIN trades t ON t.deleted_at IS NULL
          AND (t.event_id = ev.id OR (substring(t.date, 1, 10) = ev.d AND (',' || regexp_replace(UPPER(ev.ticker), '[[:space:],;/]+', ',', 'g') || ',') LIKE ('%,' || UPPER(t.ticker) || ',%')))
          AND (${scopeParam}::text IS NULL OR t.trader = ${scopeParam})
     )
     SELECT ev.event_type, ev.session,
            COUNT(DISTINCT ev.id)::int AS n,
            COUNT(ev.percent_move)::int AS with_move,
            AVG(ev.percent_move)::float AS avg_move,
            AVG(ABS(ev.percent_move))::float AS avg_abs_move,
            COUNT(*) FILTER (WHERE ev.percent_move > 0)::int AS up,
            COUNT(*) FILTER (WHERE ev.percent_move < 0)::int AS down,
            COUNT(*) FILTER (WHERE ev.reaction LIKE '%up%' OR ev.reaction LIKE '%рост%' OR ev.reaction LIKE '%гэп вверх%')::int AS reaction_up,
            (SELECT COUNT(DISTINCT trade_id) FROM tr WHERE tr.event_type = ev.event_type AND tr.session = ev.session)::int AS trades,
            (SELECT COUNT(DISTINCT trade_id) FILTER (WHERE res = 'win') FROM tr WHERE tr.event_type = ev.event_type AND tr.session = ev.session)::int AS wins,
            (SELECT COUNT(DISTINCT trade_id) FILTER (WHERE res = 'loss') FROM tr WHERE tr.event_type = ev.event_type AND tr.session = ev.session)::int AS losses,
            (SELECT COUNT(DISTINCT trade_id) FILTER (WHERE res = 'be') FROM tr WHERE tr.event_type = ev.event_type AND tr.session = ev.session)::int AS be,
            (SELECT SUM(signed_r) FROM (SELECT DISTINCT trade_id, signed_r FROM tr WHERE tr.event_type = ev.event_type AND tr.session = ev.session) x)::float AS sum_r,
            (SELECT SUM(pnl) FROM (SELECT DISTINCT trade_id, pnl FROM tr WHERE tr.event_type = ev.event_type AND tr.session = ev.session) x)::float AS gross,
            (SELECT SUM(ABS(COALESCE(fees, 0))) FILTER (WHERE pnl IS NOT NULL) FROM (SELECT DISTINCT trade_id, pnl, fees FROM tr WHERE tr.event_type = ev.event_type AND tr.session = ev.session) x)::float AS fees
       FROM ev
      GROUP BY ev.event_type, ev.session
      ORDER BY n DESC, ev.event_type`,
    params,
  );
  const r2 = (v: unknown) => { const n = strToNum(v); return n == null ? null : Math.round(n * 100) / 100; };
  res.json({
    scope, ticker: ticker || null, type: type || null, from, to,
    groups: rows.map((r) => {
      const wins = Number(r.wins), losses = Number(r.losses), decided = wins + losses;
      const gross = r2(r.gross), fees = r2(r.fees);
      return {
        eventType: String(r.event_type), session: normSession(r.session),
        n: Number(r.n), withMove: Number(r.with_move), avgMove: r2(r.avg_move), avgAbsMove: r2(r.avg_abs_move),
        up: Number(r.up), down: Number(r.down), upPct: Number(r.with_move) ? Math.round((Number(r.up) / Number(r.with_move)) * 100) : null,
        trades: {
          n: Number(r.trades), wins, losses, be: Number(r.be), winRate: decided ? Math.round((wins / decided) * 1000) / 10 : null,
          sumR: r2(r.sum_r), grossPnl: gross, fees, netPnl: gross == null ? null : Math.round((gross - (fees ?? 0)) * 100) / 100,
        },
      };
    }),
  });
}));

/** Staff: upsert earnings events from the calendar for the next N weekdays (session BMO/AMC, EPS estimate in summary). */
router.post("/events/import-earnings", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const evT = eventsT.tFor(langOf(req));
  if (!(await requireStaff(req, res))) return;
  const daysRaw = Number(req.query.days ?? req.body?.days);
  const days = Number.isFinite(daysRaw) ? Math.min(10, Math.max(1, Math.floor(daysRaw))) : 5;
  const items = await upcomingEarnings(days);
  let created = 0, skipped = 0;
  const createdIds: number[] = [];
  for (const it of items) {
    const dup = await findDuplicate(it.ticker, it.date, "earnings");
    if (dup) { skipped++; continue; }
    const summary = [it.company, it.epsEstimate != null ? evT("earnings.eps", { eps: String(it.epsEstimate) }) : null, it.marketCap ? evT("earnings.cap", { cap: String(it.marketCap) }) : null].filter(Boolean).join(" · ");
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO market_events (ticker, date, event_type, headline, summary, tags, long_name, market_cap, created_by, session)
       VALUES ($1, $2, 'earnings', $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [it.ticker, it.date, evT("earnings.headline", { ticker: it.ticker, session: String(it.session) }), summary || null, "earnings, auto", it.company, it.marketCap, req.authUser!.name, it.session],
    );
    createdIds.push(rows[0].id);
    created++;
  }
  if (created) logActivity({ action: "imported", section: "events", entityTitle: activityTitle("earnings_import", { count: created, days }), trader: req.authUser!.name, params: { titleKey: "earnings_import", count: created, days } });
  res.json({ days, fetched: items.length, created, skipped, createdIds });
}));

// ─── Single event ──────────────────────────────────────────────────────────

router.get("/events/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!req.authUser) throw unauthorized();
  const params = GetEventParams.safeParse(req.params);
  if (!params.success) throw params.error;
  const event = await loadEvent(params.data.id);
  if (!event) throw notFound("EVENT_NOT_FOUND");
  res.json(serializeEvent(event));
}));

const PatchExtra = z.object({
  session: z.string().trim().max(3).nullish(),
  patternId: z.coerce.number().int().positive().nullish(),
});

const COL: Record<string, string> = {
  ticker: "ticker", date: "date", eventType: "event_type", headline: "headline", reaction: "reaction", percentMove: "percent_move",
  volume: "volume", summary: "summary", screenshotUrl: "screenshot_url", screenshotNotes: "screenshot_notes", tags: "tags",
  marketCap: "market_cap", float: "float", adv: "adv", atr: "atr", relativeVolume: "relative_volume", beta: "beta",
  shortInterest: "short_interest", sector: "sector", longName: "long_name", session: "session", patternId: "pattern_id",
};

async function applyPatch(id: number, patch: Record<string, unknown>): Promise<EventRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !COL[k]) continue;
    params.push(v);
    sets.push(`${COL[k]} = $${params.length}`);
  }
  if (!sets.length) return loadEvent(id);
  params.push(id);
  const { rows } = await pool.query<EventRow>(
    `UPDATE market_events SET ${sets.join(", ")} WHERE id = $${params.length} AND deleted_at IS NULL RETURNING ${EVENT_COLS}`,
    params,
  );
  return rows[0] ?? null;
}

router.patch("/events/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const params = UpdateEventParams.safeParse(req.params);
  if (!params.success) throw params.error;
  const parsed = UpdateEventBody.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const extra = PatchExtra.safeParse(req.body);
  if (!extra.success) throw extra.error;
  const existing = await loadEvent(params.data.id);
  if (!existing) throw notFound("EVENT_NOT_FOUND");
  if (!(await canModifyEvent(req, existing))) throw new AppError("AUTHOR_OR_STAFF_ONLY");
  const d = parsed.data;
  if (d.date !== undefined && !ISO_DATE.test(String(d.date).slice(0, 10))) throw badRequest("INVALID_DATE");
  const ticker = d.ticker !== undefined ? splitTickers(d.ticker).join(", ") : undefined;
  if (ticker !== undefined && !ticker) throw badRequest("TICKER_REQUIRED");
  const dup = await findDuplicate(ticker ?? existing.ticker, d.date ?? existing.date, d.eventType ?? existing.event_type, existing.id);
  if (dup && (ticker !== undefined || d.date !== undefined || d.eventType !== undefined)) {
    sendErrorWith(res, new AppError("DUPLICATE"), { existingId: dup });
    return;
  }
  const patch: Record<string, unknown> = {
    ...d,
    ticker,
    date: d.date !== undefined ? String(d.date).slice(0, 10) : undefined,
    percentMove: numToStr(d.percentMove), atr: numToStr(d.atr), relativeVolume: numToStr(d.relativeVolume),
    beta: numToStr(d.beta), shortInterest: numToStr(d.shortInterest),
    screenshotUrl: d.screenshotUrl !== undefined ? sanitizeMultiLineUrls(d.screenshotUrl) : undefined,
    session: extra.data.session !== undefined ? normSession(extra.data.session) : undefined,
    patternId: extra.data.patternId !== undefined ? extra.data.patternId : undefined,
  };
  const event = await applyPatch(existing.id, patch);
  if (!event) throw notFound("EVENT_NOT_FOUND");
  logActivity({ action: "updated", section: "events", entityId: String(event.id), entityTitle: `${event.ticker} · ${event.headline}`, trader: req.authUser!.name });
  const out = serializeEvent(event);
  UpdateEventResponse.parse(out);
  res.json(out);
}));

/** Outcome after the fact (reaction / move / volume / summary): any member may fill it in. */
const OutcomeBody = z.object({
  reaction: z.string().trim().max(60).nullish(),
  percentMove: z.coerce.number().min(-1000).max(10000).nullish(),
  volume: z.string().trim().max(60).nullish(),
  summary: z.string().max(20000).nullish(),
}).strict();

router.post("/events/:id/outcome", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const id = parseId(req, res); if (id == null) return;
  const body = OutcomeBody.safeParse(req.body);
  if (!body.success) throw body.error;
  const existing = await loadEvent(id);
  if (!existing) throw notFound("EVENT_NOT_FOUND");
  const b = body.data;
  const event = await applyPatch(id, {
    reaction: b.reaction, percentMove: b.percentMove !== undefined ? numToStr(b.percentMove) : undefined, volume: b.volume, summary: b.summary,
  });
  if (!event) throw notFound("EVENT_NOT_FOUND");
  logActivity({ action: "outcome", section: "events", entityId: String(id), entityTitle: `${event.ticker} · ${event.headline}`, trader: req.authUser!.name, details: b.percentMove != null ? `${b.percentMove}%` : undefined });
  res.json(serializeEvent(event));
}));

router.delete("/events/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const params = DeleteEventParams.safeParse(req.params);
  if (!params.success) throw params.error;
  const existing = await loadEvent(params.data.id);
  if (!existing) throw notFound("EVENT_NOT_FOUND");
  if (!(await canModifyEvent(req, existing))) throw new AppError("AUTHOR_OR_STAFF_ONLY");
  await pool.query(`UPDATE market_events SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`, [existing.id]);
  logActivity({ action: "deleted", section: "events", entityId: String(existing.id), entityTitle: `${existing.ticker} · ${existing.headline}`, trader: req.authUser!.name });
  res.sendStatus(204);
}));

router.post("/events/:id/restore", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const id = parseId(req, res); if (id == null) return;
  const existing = await loadEvent(id, true);
  if (!existing || !existing.deleted_at) throw notFound("EVENT_NOT_FOUND");
  if (!(await canModifyEvent(req, existing))) throw new AppError("AUTHOR_OR_STAFF_ONLY");
  await pool.query(`UPDATE market_events SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL`, [id]);
  logActivity({ action: "restored", section: "events", entityId: String(id), entityTitle: `${existing.ticker} · ${existing.headline}`, trader: req.authUser!.name });
  res.json({ success: true });
}));

/**
 * Trades connected to an event: explicitly linked (trades.event_id) or taken on the event day in one of its tickers.
 * Scoped by role (trader → own trades) and aggregated with the shared math (net P&L, signed R, W/(W+L)).
 */
router.get("/events/:id/trades", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const id = parseId(req, res); if (id == null) return;
  const scope = await scopeTrader(req, typeof req.query.trader === "string" ? req.query.trader : null);
  if (scope === undefined) throw unauthorized();
  const event = await loadEvent(id);
  if (!event) throw notFound("EVENT_NOT_FOUND");
  const tickers = splitTickers(event.ticker).slice(0, 25);
  const day = event.date.slice(0, 10);
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT ${TRADE_SELECT} FROM trades t
      WHERE t.deleted_at IS NULL
        AND (t.event_id = $1 OR (substring(t.date, 1, 10) = $2 AND UPPER(t.ticker) = ANY($3::text[])))
        AND ($4::text IS NULL OR t.trader = $4)
      ORDER BY (t.event_id = $1) DESC, t.date DESC, t.id DESC
      LIMIT 100`,
    [id, day, tickers, scope],
  );
  res.json({ scope, trades: rows.map((r) => tradeLite(r, "event_id", id)), stats: statsOf(rows) });
}));

const LinkBody = z.object({ tradeId: z.coerce.number().int().positive(), unlink: z.coerce.boolean().optional() });

router.post("/events/:id/link-trade", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const id = parseId(req, res); if (id == null) return;
  const body = LinkBody.safeParse(req.body);
  if (!body.success) throw new AppError("FIELD_REQUIRED", undefined, { field: "tradeId" });
  const event = await loadEvent(id);
  if (!event) throw notFound("EVENT_NOT_FOUND");
  const access = await canAccessTrade(req, body.data.tradeId);
  if (access === null) throw notFound("TRADE_NOT_FOUND");
  if (!access) throw new AppError("OWN_TRADES_ONLY");
  await pool.query(`UPDATE trades SET event_id = $1 WHERE id = $2 AND deleted_at IS NULL`, [body.data.unlink ? null : id, body.data.tradeId]);
  logActivity({ action: body.data.unlink ? "unlinked" : "linked", section: "events", entityId: String(id), entityTitle: `${event.ticker} · ${event.headline}`, trader: req.authUser!.name, details: `trade #${body.data.tradeId}` });
  res.json({ success: true, eventId: body.data.unlink ? null : id, tradeId: body.data.tradeId });
}));

export default router;
