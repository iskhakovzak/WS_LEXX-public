import { Router, type IRouter } from "express";
import { eq, and, desc, isNull, sql, inArray } from "drizzle-orm";
import { db, pool, tradeIdeasTable, tradeIdeaReactionsTable, tradesTable } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { logActivity } from "../lib/activity";
import { logger } from "../lib/logger";
import { sanitizeMultiLineUrls } from "../lib/safe-url";
import { notifyReviewersOnPublish, applyIdeaReview } from "../lib/notifyUtils";
import { GUEST_SCOPE, isGuest, requireMember, scopeTrader } from "../lib/auth";
import { can, requireCap } from "../lib/permissions";
import { nyDate } from "../lib/tradingDate";
import { defaultValidUntil, ensureIdeaLinkColumns, ensureIdeaLinksFresh } from "../lib/ideaTradeMatch";
import { loadMoneyViewer } from "../lib/playbookAccess";
import { redactTradeRow, type MoneyViewer } from "../lib/playbookPrivacy";
import { signedR, netPnl, normResult } from "../lib/tradeMath";
import { AppError, badRequest, notFound, sendError, unauthorized } from "../lib/http";
import { reviewT } from "../i18n/ns";
import { langOf } from "../i18n";

const router: IRouter = Router();

// ─── Additive columns (not in the drizzle schema): horizon + valid_until ────
// `horizon` ('intraday' | 'overnight' | 'swing') used to live only as a tag («Интрадей/Овернайт/Свинг»);
// it is now a real column (migrated once from tags). `valid_until` (YYYY-MM-DD, NY calendar) is when a
// published idea expires: intraday = same session, overnight = next session, swing = +10 sessions.
let ensured: Promise<void> | null = null;
function ensureIdeaColumns(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query( // i18n-ignore (migration matches stored RU tags)
        `ALTER TABLE trade_ideas ADD COLUMN IF NOT EXISTS horizon TEXT;
         ALTER TABLE trade_ideas ADD COLUMN IF NOT EXISTS valid_until TEXT;
         UPDATE trade_ideas SET horizon = CASE
             WHEN LOWER(tags) ~ '(^|,)\\s*(интрадей|интрадэй|intraday|day)\\s*(,|$)' THEN 'intraday'
             WHEN LOWER(tags) ~ '(^|,)\\s*(овернайт|overnight)\\s*(,|$)' THEN 'overnight'
             WHEN LOWER(tags) ~ '(^|,)\\s*(свинг|swing)\\s*(,|$)' THEN 'swing'
           END
          WHERE horizon IS NULL AND tags IS NOT NULL;`,
      )
      .then(() => undefined)
      .catch((err) => { ensured = null; throw err; });
  }
  return ensured;
}
ensureIdeaColumns().catch((err) => logger.warn({ err }, "trade-ideas: ensure columns failed at init"));

const HORIZONS = new Set(["intraday", "overnight", "swing"]);
const IDEA_STATUSES = new Set(["draft", "published", "converted"]);
const IDEA_TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,11}$/;

function parseHorizon(v: unknown): "intraday" | "overnight" | "swing" | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "интрадей" || s === "day") return "intraday"; // i18n-ignore (input parsing)
  if (s === "овернайт") return "overnight"; // i18n-ignore (input parsing)
  if (s === "свинг") return "swing"; // i18n-ignore (input parsing)
  return HORIZONS.has(s) ? (s as "intraday" | "overnight" | "swing") : null;
}

export { defaultValidUntil };

function parseDateOrNull(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** 'all' = every idea; otherwise drafts are only visible to their author (staff see all; guests see no drafts). */
type Visibility = { mode: "all" } | { mode: "limited"; viewer: string | null };
async function ideaVisibility(req: import("express").Request): Promise<Visibility | null> {
  if (!req.authUser) return null;
  if (isGuest(req)) return { mode: "limited", viewer: null };
  if (await can(req, "ideas.review")) return { mode: "all" };
  return { mode: "limited", viewer: req.authUser.name };
}
function isVisible(v: Visibility, row: { status: string; trader: string | null }): boolean {
  if (v.mode === "all") return true;
  if (row.status !== "draft") return true;
  return !!v.viewer && row.trader === v.viewer;
}

/** Parses a positive integer route id; responds 400 and returns null when invalid (avoids 500 from Postgres on NaN). */
function parseId(raw: unknown, res: import("express").Response): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) { sendError(res, badRequest("INVALID_ID")); return null; }
  return id;
}

type IdeaRow = { id: number; convertedTradeId?: number | null; [k: string]: unknown };
type ReactionRow = { id: number; tradeIdeaId: number; trader: string; reaction: string; comment: string | null; createdAt: Date };
type LinkedTrade = {
  id: number; result: string; pnl: string | null; rMultiple: string | null; date: string;
  // Fill data for idea → trade comparison (planned entry/stop vs actual fill) — one math via lib/tradeMath.
  side: string | null; entry: string | null; exit: string | null; stop: string | null; fees: string | null;
  riskUsd: string | null; qty: string | null; horizon: string | null; exitDate: string | null; trader: string | null;
  /** Signed R (shared rule) and net P&L (gross − |fees|); null while open. */
  r: number | null; net: number | null; outcome: "win" | "loss" | "be" | "open" | null;
};

async function attachReactions<T extends IdeaRow>(rows: T[]): Promise<(T & { reactions: ReactionRow[] })[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const reactions = await db
    .select()
    .from(tradeIdeaReactionsTable)
    .where(inArray(tradeIdeaReactionsTable.tradeIdeaId, ids));
  const map = new Map<number, ReactionRow[]>();
  for (const r of reactions) {
    const arr = map.get(r.tradeIdeaId) ?? [];
    arr.push(r as ReactionRow);
    map.set(r.tradeIdeaId, arr);
  }
  return rows.map((r) => ({ ...r, reactions: map.get(r.id) ?? [] }));
}

/**
 * Linked trade of each idea. $ facts (P&L, fees, size, risk $) follow the desk privacy rule (lib/playbookPrivacy):
 * only the trade's owner and staff see them; others keep prices, R and the outcome. Ideas are team-wide and now
 * auto-link to the author's broker trade, so this matters for every published idea.
 */
async function attachLinkedTrades<T extends IdeaRow>(rows: T[], viewer: MoneyViewer): Promise<(T & { linkedTrade: (LinkedTrade & { redacted: boolean }) | null })[]> {
  const tradeIds = rows.map((r) => r.convertedTradeId).filter((v): v is number => typeof v === "number");
  if (tradeIds.length === 0) return rows.map((r) => ({ ...r, linkedTrade: null }));
  const trades = await db
    .select({
      id: tradesTable.id,
      result: tradesTable.result,
      pnl: tradesTable.pnl,
      rMultiple: tradesTable.rMultiple,
      date: tradesTable.date,
      deletedAt: tradesTable.deletedAt,
      side: tradesTable.side,
      entry: tradesTable.entry,
      exit: tradesTable.exit,
      stop: tradesTable.stop,
      fees: tradesTable.fees,
      riskUsd: tradesTable.riskUsd,
      qty: tradesTable.qty,
      horizon: tradesTable.horizon,
      exitDate: tradesTable.exitDate,
      trader: tradesTable.trader,
    })
    .from(tradesTable)
    .where(inArray(tradesTable.id, tradeIds));
  const tradeMap = new Map<number, LinkedTrade & { redacted: boolean }>();
  for (const t of trades) {
    if (t.deletedAt) continue;
    const row = redactTradeRow({
      id: t.id, result: t.result, pnl: t.pnl, rMultiple: t.rMultiple, date: t.date,
      side: t.side, entry: t.entry, exit: t.exit, stop: t.stop, fees: t.fees, riskUsd: t.riskUsd, qty: t.qty,
      horizon: t.horizon, exitDate: t.exitDate, trader: t.trader,
      r: signedR(t), net: netPnl(t), outcome: normResult(t.result),
    }, viewer);
    tradeMap.set(t.id, row.redacted ? { ...row, net: null } : row); // `net` is not in TRADE_MONEY_FIELDS
  }
  return rows.map((r) => ({ ...r, linkedTrade: r.convertedTradeId ? tradeMap.get(r.convertedTradeId) ?? null : null }));
}

type IdeaMeta = {
  review_status: string | null; review_reason: string | null; reviewed_by: string | null; reviewed_at: string | null;
  commentCount: number; lastCommentAt: string | null; unreadCount: number;
  /** Real columns (see ensureIdeaColumns). `expired` = published, not converted, valid_until < NY today. */
  horizon: "intraday" | "overnight" | "swing" | null; validUntil: string | null; expired: boolean;
  /** How `convertedTradeId` was set: 'auto' = matched to the author's PropReports trade (lib/ideaTradeMatch),
   *  'manual' = linked by hand (legacy); null without a link. */
  tradeLinkSource: "auto" | "manual" | null; tradeLinkedAt: string | null;
};

/**
 * Review columns live outside the drizzle schema (added by migrate.ts), so `db.select()` never returned them.
 * Also attaches per-viewer comment counts (respecting private-comment visibility) and unread notification counts.
 */
async function attachMeta<T extends IdeaRow>(rows: T[], viewer: { name?: string; role?: string } | undefined): Promise<(T & IdeaMeta)[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const viewerName = viewer?.name ?? null;
  const isReviewer = viewer?.role === "curator" || viewer?.role === "admin";
  const empty = { rows: [] as unknown[] };
  await ensureIdeaColumns().catch(() => undefined);
  await ensureIdeaLinkColumns().catch(() => undefined);
  const [review, comments, unread] = await Promise.all([
    pool.query(
      `SELECT id, review_status, review_reason, reviewed_by, reviewed_at, horizon, valid_until, trade_link_source, trade_linked_at
         FROM trade_ideas WHERE id = ANY($1::int[])`,
      [ids],
    ),
    pool.query(
      `SELECT c.idea_id, COUNT(*)::int AS cnt, MAX(c.created_at) AS last_at
         FROM trade_idea_comments c
         JOIN trade_ideas i ON i.id = c.idea_id
        WHERE c.idea_id = ANY($1::int[])
          AND (c.is_private = FALSE OR $2::boolean OR c.author_name = $3 OR i.trader = $3)
        GROUP BY c.idea_id`,
      [ids, isReviewer, viewerName],
    ).catch(() => empty),
    viewerName
      ? pool.query(
          `SELECT idea_id, COUNT(*)::int AS cnt FROM notifications
            WHERE user_name = $1 AND is_read = FALSE AND idea_id = ANY($2::int[])
            GROUP BY idea_id`,
          [viewerName, ids],
        ).catch(() => empty)
      : Promise.resolve(empty),
  ]);
  type ReviewRow = {
    id: number; review_status: string | null; review_reason: string | null; reviewed_by: string | null; reviewed_at: string | null;
    horizon: string | null; valid_until: string | null; trade_link_source: string | null; trade_linked_at: Date | string | null;
  };
  const reviewMap = new Map((review.rows as ReviewRow[]).map((r) => [r.id, r]));
  const commentMap = new Map((comments.rows as { idea_id: number; cnt: number; last_at: string | null }[]).map((r) => [r.idea_id, r]));
  const unreadMap = new Map((unread.rows as { idea_id: number; cnt: number }[]).map((r) => [r.idea_id, r.cnt]));
  const today = nyDate();
  return rows.map((r) => {
    const rv = reviewMap.get(r.id);
    const cm = commentMap.get(r.id);
    const horizon = parseHorizon(rv?.horizon);
    const validUntil = rv?.valid_until ?? null;
    const status = String((r as { status?: unknown }).status ?? "");
    return {
      ...r,
      review_status: rv?.review_status ?? null,
      review_reason: rv?.review_reason ?? null,
      reviewed_by: rv?.reviewed_by ?? null,
      reviewed_at: rv?.reviewed_at ?? null,
      commentCount: cm?.cnt ?? 0,
      lastCommentAt: cm?.last_at ?? null,
      unreadCount: unreadMap.get(r.id) ?? 0,
      horizon,
      validUntil,
      expired: status === "published" && !r.convertedTradeId && !!validUntil && validUntil < today,
      tradeLinkSource: r.convertedTradeId ? (rv?.trade_link_source === "auto" ? "auto" : "manual") : null,
      tradeLinkedAt: r.convertedTradeId && rv?.trade_linked_at ? new Date(rv.trade_linked_at).toISOString() : null,
    };
  });
}

/** Author of the idea, or a curator/admin (role read from the DB — token roles can be stale). Unowned ideas: staff only. */
async function canManageIdea(req: import("express").Request, ideaTrader: string | null): Promise<boolean> {
  const actor = req.authUser;
  if (!actor || isGuest(req)) return false;
  if (!!ideaTrader && ideaTrader === actor.name) return true;
  return can(req, "ideas.review", ideaTrader ? { trader: ideaTrader } : undefined);
}

// ─── Live outcome tracking ──────────────────────────────────────────────────
// For published ideas with numeric levels we scan hourly bars since publication and report whether the first
// target or the stop was touched first, plus MFE/MAE in R and the current price. Read-only (Yahoo chart API).

/** All numbers inside a free-form level string: "180.5-181.2", "185 / 187", "$178". */
function parseLevelNumbers(raw: string | null | undefined): number[] {
  if (!raw) return [];
  const out: number[] = [];
  const normalized = String(raw).replace(/(\d),(\d{3})(?!\d)/g, "$1$2").replace(/(\d),(\d)/g, "$1.$2");
  for (const m of normalized.matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

type IdeaLevels = { isShort: boolean; entry: number; stop: number; target: number; finalTarget: number };

function ideaLevels(idea: { side: string | null; entryZone: string | null; stop: string | null; target: string | null }): IdeaLevels | null {
  const entries = parseLevelNumbers(idea.entryZone);
  const stops = parseLevelNumbers(idea.stop);
  const targets = parseLevelNumbers(idea.target);
  if (!entries.length || !stops.length || !targets.length) return null;
  const isShort = (idea.side ?? "").toLowerCase() === "short";
  const entry = entries.reduce((a, b) => a + b, 0) / entries.length;
  const stop = stops[0];
  const target = isShort ? Math.max(...targets) : Math.min(...targets);
  const finalTarget = isShort ? Math.min(...targets) : Math.max(...targets);
  // Levels on the wrong side of entry cannot be tracked meaningfully.
  if (isShort ? !(stop > entry && target < entry) : !(stop < entry && target > entry)) return null;
  return { isShort, entry, stop, target, finalTarget };
}

type Bar = { t: number; h: number; l: number; c: number };
type Series = { price: number | null; bars: Bar[] };
const seriesCache = new Map<string, { ts: number; data: Series | null }>();
const SERIES_TTL = 2 * 60 * 1000;
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,10}$/;

async function fetchSeries(sym: string): Promise<Series | null> {
  const hit = seriesCache.get(sym);
  if (hit && Date.now() - hit.ts < SERIES_TTL) return hit.data;
  let data: Series | null = null;
  try {
    const resp = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=3mo&interval=60m`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const json = (await resp.json()) as {
        chart?: { result?: Array<{
          meta?: { regularMarketPrice?: number };
          timestamp?: number[];
          indicators?: { quote?: Array<{ high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[] }> };
        }> };
      };
      const r = json.chart?.result?.[0];
      if (r) {
        const q = r.indicators?.quote?.[0] ?? {};
        const bars: Bar[] = [];
        (r.timestamp ?? []).forEach((t, i) => {
          const h = q.high?.[i]; const l = q.low?.[i]; const c = q.close?.[i];
          if (h != null && l != null && c != null && h > 0 && l > 0) bars.push({ t: t * 1000, h, l, c });
        });
        data = { price: r.meta?.regularMarketPrice ?? (bars.length ? bars[bars.length - 1].c : null), bars };
      }
    }
  } catch { data = null; }
  seriesCache.set(sym, { ts: Date.now(), data });
  if (seriesCache.size > 300) {
    const oldest = seriesCache.keys().next().value;
    if (oldest) seriesCache.delete(oldest);
  }
  return data;
}

type IdeaTracking = {
  ticker: string; price: number | null;
  hit: "target" | "final_target" | "stop" | null; hitAt: string | null; ambiguous: boolean;
  rNow: number | null; mfeR: number | null; maeR: number | null; plannedR: number;
  since: string;
};

function evaluateTracking(lv: IdeaLevels, series: Series, since: Date, ticker: string): IdeaTracking {
  const risk = Math.abs(lv.entry - lv.stop);
  const toR = (px: number) => (lv.isShort ? lv.entry - px : px - lv.entry) / risk;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  let hit: IdeaTracking["hit"] = null; let hitAt: string | null = null; let ambiguous = false;
  let mfe: number | null = null; let mae: number | null = null;
  for (const b of series.bars) {
    // Hourly bar timestamps mark the bar open; include the bar that contains the publish moment.
    if (b.t + 60 * 60 * 1000 <= since.getTime()) continue;
    const favR = toR(lv.isShort ? b.l : b.h);
    const advR = toR(lv.isShort ? b.h : b.l);
    mfe = mfe == null ? favR : Math.max(mfe, favR);
    mae = mae == null ? advR : Math.min(mae, advR);
    const stopTouched = lv.isShort ? b.h >= lv.stop : b.l <= lv.stop;
    const targetTouched = lv.isShort ? b.l <= lv.target : b.h >= lv.target;
    if (stopTouched || targetTouched) {
      // Same bar touched both: conservative — count as stop and flag the ambiguity.
      ambiguous = stopTouched && targetTouched;
      if (stopTouched) hit = "stop";
      else hit = (lv.isShort ? b.l <= lv.finalTarget : b.h >= lv.finalTarget) ? "final_target" : "target";
      hitAt = new Date(b.t).toISOString();
      break;
    }
  }
  return {
    ticker, price: series.price,
    hit, hitAt, ambiguous,
    rNow: series.price != null ? r2(toR(series.price)) : null,
    mfeR: mfe != null ? r2(mfe) : null,
    maeR: mae != null ? r2(mae) : null,
    plannedR: r2(Math.abs(lv.target - lv.entry) / risk),
    since: since.toISOString(),
  };
}

router.get("/trade-ideas/tracking", asyncHandler(async (req, res): Promise<void> => {
  const idsParam = typeof req.query.ids === "string" ? req.query.ids : "";
  const requested = idsParam
    ? new Set(idsParam.split(",").map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200))
    : null;
  let rows = await db.select().from(tradeIdeasTable)
    .where(and(isNull(tradeIdeasTable.deletedAt), inArray(tradeIdeasTable.status, ["published", "converted"])))
    .orderBy(desc(tradeIdeasTable.createdAt));
  if (requested) rows = rows.filter((r) => requested.has(r.id));
  const candidates: { row: typeof rows[number]; lv: IdeaLevels }[] = [];
  for (const row of rows) {
    const lv = ideaLevels(row);
    if (lv && TICKER_RE.test(row.ticker.toUpperCase())) candidates.push({ row, lv });
  }
  const tickers = Array.from(new Set(candidates.map((c) => c.row.ticker.toUpperCase()))).slice(0, 40);
  const seriesByTicker = new Map<string, Series | null>();
  // Small worker pool so a board with many tickers doesn't fan out 40 requests at once.
  const queue = [...tickers];
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const t = queue.shift()!;
      seriesByTicker.set(t, await fetchSeries(t));
    }
  }));
  const items: Record<number, IdeaTracking> = {};
  for (const { row, lv } of candidates) {
    const s = seriesByTicker.get(row.ticker.toUpperCase());
    if (!s) continue;
    items[row.id] = evaluateTracking(lv, s, new Date(row.publishedAt ?? row.createdAt), row.ticker.toUpperCase());
  }
  res.json({ generatedAt: new Date().toISOString(), items });
}));

/**
 * GET /trade-ideas?status&trader&ticker&horizon&expired=1
 * Published/converted ideas are team-wide; drafts are visible only to their author (staff see everything,
 * guests see no drafts). Filters are applied in SQL.
 */
router.get("/trade-ideas", asyncHandler(async (req, res): Promise<void> => {
  const vis = await ideaVisibility(req);
  if (!vis) throw unauthorized();
  await ensureIdeaLinksFresh(); // idea → PropReports trade auto-links (cached 5 min, also refreshed after a sync)
  const { status, trader, ticker, horizon, expired } = req.query as Record<string, string | undefined>;
  const conds = [isNull(tradeIdeasTable.deletedAt)];
  if (status && IDEA_STATUSES.has(status)) conds.push(eq(tradeIdeasTable.status, status));
  if (trader) conds.push(eq(tradeIdeasTable.trader, trader));
  if (ticker) conds.push(eq(tradeIdeasTable.ticker, ticker.trim().toUpperCase()));
  if (vis.mode === "limited") {
    conds.push(vis.viewer
      ? sql`(${tradeIdeasTable.status} <> 'draft' OR ${tradeIdeasTable.trader} = ${vis.viewer})`
      : sql`${tradeIdeasTable.status} <> 'draft'`);
  }
  const rows = await db.select().from(tradeIdeasTable)
    .where(and(...conds))
    .orderBy(desc(tradeIdeasTable.createdAt))
    .limit(2000);
  const withReactions = await attachReactions(rows);
  const withLinked = await attachLinkedTrades(withReactions, await loadMoneyViewer(req));
  let out = await attachMeta(withLinked, req.authUser);
  const h = parseHorizon(horizon);
  if (h) out = out.filter((r) => r.horizon === h);
  if (expired === "1" || expired === "true") out = out.filter((r) => r.expired);
  res.json(out);
}));

/**
 * GET /trade-ideas/stats?trader&from&to — aggregate hit rate / R / net P&L over converted ideas.
 * One math: signed R and net P&L from lib/tradeMath; win rate = W/(W+L), BE excluded; dates are NY calendar.
 * Scoped: a trader only gets own numbers; staff may pass ?trader= (or none = team).
 */
router.get("/trade-ideas/stats", asyncHandler(async (req, res): Promise<void> => {
  const scope = await scopeTrader(req, typeof req.query.trader === "string" ? req.query.trader : null);
  if (scope === undefined) throw unauthorized();
  await ensureIdeaLinksFresh(); // idea → PropReports trade auto-links (cached 5 min, also refreshed after a sync)
  const from = parseDateOrNull(req.query.from);
  const to = parseDateOrNull(req.query.to);
  const conds = [isNull(tradeIdeasTable.deletedAt)];
  if (scope !== null) conds.push(eq(tradeIdeasTable.trader, scope));
  const ideas = (await db.select().from(tradeIdeasTable).where(and(...conds))).filter((i) => {
    const d = i.ideaDate ?? (i.createdAt ? nyDate(new Date(i.createdAt)) : null);
    if (from && d && d < from) return false;
    if (to && d && d > to) return false;
    return true;
  });
  const ideaIds = ideas.map((i) => i.id);
  const tradeIds = ideas.map((i) => i.convertedTradeId).filter((v): v is number => typeof v === "number");

  const reactions = ideaIds.length > 0
    ? await db.select().from(tradeIdeaReactionsTable).where(inArray(tradeIdeaReactionsTable.tradeIdeaId, ideaIds))
    : [];
  const reactionsByIdea = new Map<number, ReactionRow[]>();
  for (const r of reactions) {
    const arr = reactionsByIdea.get(r.tradeIdeaId) ?? [];
    arr.push(r as ReactionRow);
    reactionsByIdea.set(r.tradeIdeaId, arr);
  }

  const trades = tradeIds.length > 0
    ? await db.select({
        id: tradesTable.id,
        result: tradesTable.result,
        pnl: tradesTable.pnl,
        fees: tradesTable.fees,
        rMultiple: tradesTable.rMultiple,
        side: tradesTable.side,
        entry: tradesTable.entry,
        exit: tradesTable.exit,
        stop: tradesTable.stop,
        riskUsd: tradesTable.riskUsd,
        deletedAt: tradesTable.deletedAt,
      }).from(tradesTable).where(inArray(tradesTable.id, tradeIds))
    : [];
  const tradeMap = new Map<number, { outcome: "win" | "loss" | "be" | "open" | null; r: number | null; net: number | null; gross: number | null }>();
  for (const t of trades) {
    if (t.deletedAt) continue;
    tradeMap.set(t.id, { outcome: normResult(t.result), r: signedR(t), net: netPnl(t), gross: t.pnl != null ? Number(t.pnl) : null });
  }

  type Bucket = {
    ideasTotal: number; published: number; converted: number;
    wins: number; losses: number; breakeven: number; open: number;
    rSum: number; rCount: number; rPos: number; rNeg: number; netSum: number; grossSum: number; pnlCount: number;
  };
  const blank = (): Bucket => ({ ideasTotal: 0, published: 0, converted: 0, wins: 0, losses: 0, breakeven: 0, open: 0, rSum: 0, rCount: 0, rPos: 0, rNeg: 0, netSum: 0, grossSum: 0, pnlCount: 0 });

  function tally(bucket: Bucket, idea: typeof ideas[number]): void {
    bucket.ideasTotal += 1;
    if (idea.status === "published" || idea.status === "converted") bucket.published += 1;
    if (idea.convertedTradeId) {
      const t = tradeMap.get(idea.convertedTradeId);
      if (t) {
        bucket.converted += 1;
        if (t.outcome === "win") bucket.wins += 1;
        else if (t.outcome === "loss") bucket.losses += 1;
        else if (t.outcome === "be") bucket.breakeven += 1;
        else bucket.open += 1;
        if (t.r != null) { bucket.rSum += t.r; bucket.rCount += 1; if (t.r > 0) bucket.rPos += t.r; else if (t.r < 0) bucket.rNeg += t.r; }
        if (t.gross != null) { bucket.grossSum += t.gross; bucket.netSum += t.net ?? t.gross; bucket.pnlCount += 1; }
      }
    }
  }

  type Finalized = {
    ideasTotal: number; published: number; converted: number; conversionRate: number | null;
    wins: number; losses: number; breakeven: number; open: number;
    /** W/(W+L); null without decided trades. */
    winRate: number | null; avgR: number | null; totalR: number; rCount: number; profitFactorR: number | null;
    /** Net P&L («нетто», gross − fees); `totalPnlGross` for reference. Null without $ data. */
    totalPnl: number | null; totalPnlGross: number | null;
  };
  function finalize(b: Bucket): Finalized {
    const decided = b.wins + b.losses;
    return {
      ideasTotal: b.ideasTotal,
      published: b.published,
      converted: b.converted,
      conversionRate: b.published > 0 ? b.converted / b.published : null,
      wins: b.wins, losses: b.losses, breakeven: b.breakeven, open: b.open,
      winRate: decided > 0 ? b.wins / decided : null,
      avgR: b.rCount > 0 ? b.rSum / b.rCount : null,
      totalR: b.rSum,
      rCount: b.rCount,
      profitFactorR: b.rNeg < 0 ? b.rPos / Math.abs(b.rNeg) : null,
      totalPnl: b.pnlCount ? b.netSum : null,
      totalPnlGross: b.pnlCount ? b.grossSum : null,
    };
  }

  function majority(rxns: ReactionRow[]): "thumbs_up" | "warning" | "thumbs_down" | "none" {
    if (rxns.length === 0) return "none";
    const counts: Record<string, number> = { thumbs_up: 0, warning: 0, thumbs_down: 0 };
    for (const r of rxns) if (r.reaction in counts) counts[r.reaction] += 1;
    const total = rxns.length;
    for (const k of ["thumbs_up", "warning", "thumbs_down"] as const) {
      if (counts[k] > total / 2) return k;
    }
    return "none";
  }

  const rt = reviewT.tFor(langOf(req));
  const traderBuckets = new Map<string, Bucket>();
  const reactionBuckets = new Map<string, Bucket>();
  const overall = blank();

  for (const idea of ideas) {
    tally(overall, idea);
    const tname = idea.trader ?? rt("ideas.noTrader");
    const tb = traderBuckets.get(tname) ?? blank();
    tally(tb, idea);
    traderBuckets.set(tname, tb);

    const m = majority(reactionsByIdea.get(idea.id) ?? []);
    const rb = reactionBuckets.get(m) ?? blank();
    tally(rb, idea);
    reactionBuckets.set(m, rb);
  }

  const byTrader = Array.from(traderBuckets.entries())
    .map(([trader, b]) => ({ trader, ...finalize(b) }))
    .sort((a, b) => b.published - a.published);

  const byReactionMajority = (["thumbs_up", "warning", "thumbs_down", "none"] as const)
    .map((k) => ({ majority: k, ...finalize(reactionBuckets.get(k) ?? blank()) }));

  res.json({
    scope: scope === GUEST_SCOPE ? null : scope,
    overall: finalize(overall),
    byTrader,
    byReactionMajority,
    formulas: { winRate: rt("ideas.formulaWinRate"), r: "signed R (lib/tradeMath)", totalPnl: rt("ideas.formulaNet") },
  });
}));

router.get("/trade-ideas/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id, res); if (id == null) return;
  const vis = await ideaVisibility(req);
  if (!vis) throw unauthorized();
  await ensureIdeaLinksFresh(); // idea → PropReports trade auto-links (cached 5 min, also refreshed after a sync)
  const [row] = await db.select().from(tradeIdeasTable).where(eq(tradeIdeasTable.id, id));
  // Another trader's draft is indistinguishable from a missing idea (no draft leaks).
  if (!row || row.deletedAt || !isVisible(vis, row)) throw notFound();
  const [withR] = await attachReactions([row]);
  const [withLinked] = await attachLinkedTrades([withR], await loadMoneyViewer(req));
  const [withMeta] = await attachMeta([withLinked], req.authUser);
  res.json(withMeta);
}));

function parseSide(v: unknown): "Long" | "Short" | null | "invalid" {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (s === "long" || s === "лонг" || s === "buy") return "Long"; // i18n-ignore (input parsing)
  if (s === "short" || s === "шорт" || s === "sell") return "Short"; // i18n-ignore (input parsing)
  return "invalid";
}

/**
 * POST /trade-ideas — author = the signed-in member (staff may create on behalf of another trader via `trader`).
 * status: draft | published (converted is set only by the convert flow); score 0..100; horizon enum;
 * validUntil defaults by horizon when publishing. Reviewers are notified only on publish.
 */
router.post("/trade-ideas", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  await ensureIdeaColumns().catch(() => undefined);
  const b = req.body as Record<string, unknown>;
  const ticker = String(b.ticker ?? "").trim().toUpperCase();
  if (!ticker) throw badRequest("TICKER_REQUIRED");
  if (!IDEA_TICKER_RE.test(ticker)) throw badRequest("INVALID_TICKER");
  const side = parseSide(b.side);
  if (side === "invalid") throw new AppError("INVALID_FIELD", undefined, { field: "side" });
  const status = b.status === undefined || b.status === null || b.status === "" ? "draft" : String(b.status);
  if (status !== "draft" && status !== "published") throw new AppError("INVALID_FIELD", undefined, { field: "status" });
  if (b.score !== undefined && b.score !== null && b.score !== "" && (typeof b.score !== "number" || !Number.isFinite(b.score) || b.score < 0 || b.score > 100)) throw new AppError("INVALID_FIELD", undefined, { field: "score" });
  if (b.horizon !== undefined && b.horizon !== null && b.horizon !== "" && !parseHorizon(b.horizon)) throw new AppError("INVALID_FIELD", undefined, { field: "horizon" });
  if (b.validUntil !== undefined && b.validUntil !== null && b.validUntil !== "" && !parseDateOrNull(b.validUntil)) throw new AppError("INVALID_FIELD", undefined, { field: "validUntil" });
  const staff = await can(req, "ideas.review");
  // Identity comes from the token; only staff may author an idea for someone else.
  const trader = staff && b.trader ? String(b.trader).trim() : req.authUser!.name;
  const horizon = parseHorizon(b.horizon);
  const today = nyDate();
  const validUntil = parseDateOrNull(b.validUntil) ?? (status === "published" ? defaultValidUntil(horizon, today) : null);
  const numOrNull = (v: unknown) => (v !== undefined && v !== null && v !== "" ? String(v) : null);
  const [row] = await db.insert(tradeIdeasTable).values({
    ticker,
    side,
    setup: b.setup ? String(b.setup) : null,
    entryZone: b.entryZone ? String(b.entryZone) : null,
    target: b.target ? String(b.target) : null,
    stop: b.stop ? String(b.stop) : null,
    thesis: b.thesis ? String(b.thesis) : null,
    score: typeof b.score === "number" ? b.score : null,
    scoreBreakdown: b.scoreBreakdown ? (typeof b.scoreBreakdown === "string" ? b.scoreBreakdown : JSON.stringify(b.scoreBreakdown)) : null,
    status,
    trader,
    ideaDate: parseDateOrNull(b.ideaDate) ?? today,
    publishedAt: status === "published" ? new Date() : null,
    playbookId: typeof b.playbookId === "number" ? b.playbookId : null,
    watchlistId: typeof b.watchlistId === "number" ? b.watchlistId : null,
    screenshotUrl: sanitizeMultiLineUrls(b.screenshotUrl as string | null | undefined),
    tags: b.tags ? String(b.tags) : null,
    marketCap: b.marketCap ? String(b.marketCap) : null,
    float: b.float ? String(b.float) : null,
    adv: b.adv ? String(b.adv) : null,
    atr: numOrNull(b.atr),
    relativeVolume: numOrNull(b.relativeVolume),
    beta: numOrNull(b.beta),
    shortInterest: numOrNull(b.shortInterest),
    sector: b.sector ? String(b.sector) : null,
    longName: b.longName ? String(b.longName) : null,
    riskAmount: numOrNull(b.riskAmount),
    setupQuality: b.setupQuality ? String(b.setupQuality) : null,
  }).returning();
  await pool.query(`UPDATE trade_ideas SET horizon = $2, valid_until = $3 WHERE id = $1`, [row.id, horizon, validUntil]).catch(() => undefined);
  logActivity({ action: "created", section: "trade-ideas", entityId: String(row.id), entityTitle: row.ticker, trader: row.trader ?? undefined, details: `${row.side ?? ""} ${row.setup ?? ""}`.trim() });
  const [withMeta] = await attachMeta([{ ...row, reactions: [], linkedTrade: null }], req.authUser);
  res.status(201).json(withMeta);
  if (status === "published") notifyReviewersOnPublish(row as Parameters<typeof notifyReviewersOnPublish>[0]).catch(() => {});
}));

router.patch("/trade-ideas/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id, res); if (id == null) return;
  if (!requireMember(req, res)) return;
  await ensureIdeaColumns().catch(() => undefined);
  const b = req.body as Record<string, unknown>;
  const [existing] = await db.select({ trader: tradeIdeasTable.trader, deletedAt: tradeIdeasTable.deletedAt, status: tradeIdeasTable.status })
    .from(tradeIdeasTable).where(eq(tradeIdeasTable.id, id));
  if (!existing || existing.deletedAt) throw notFound();
  const staff = await can(req, "ideas.review", existing.trader ? { trader: existing.trader } : undefined);
  const manager = staff || (!!existing.trader && existing.trader === req.authUser!.name);
  if (!manager) {
    // Non-authors may only link a published idea to the trade they opened from it (trades page "fromIdea" flow).
    const keys = Object.keys(b);
    const linkOnly = keys.length > 0 && keys.every((k) => k === "status" || k === "convertedTradeId")
      && (b.status === undefined || b.status === "converted") && existing.status !== "draft";
    if (!linkOnly) throw new AppError("AUTHOR_OR_STAFF_ONLY");
  }
  if (b.status !== undefined && !["draft", "published", "converted"].includes(String(b.status))) throw new AppError("INVALID_FIELD", undefined, { field: "status" });
  if (b.score !== undefined && b.score !== null && (typeof b.score !== "number" || b.score < 0 || b.score > 100)) throw new AppError("INVALID_FIELD", undefined, { field: "score" });
  if (b.trader !== undefined && !staff) throw new AppError("STAFF_ONLY");
  if (b.ticker !== undefined && !IDEA_TICKER_RE.test(String(b.ticker).trim().toUpperCase())) throw badRequest("INVALID_TICKER");
  const side = b.side !== undefined ? parseSide(b.side) : undefined;
  if (side === "invalid") throw new AppError("INVALID_FIELD", undefined, { field: "side" });
  if (b.horizon !== undefined && b.horizon !== null && b.horizon !== "" && !parseHorizon(b.horizon)) throw new AppError("INVALID_FIELD", undefined, { field: "horizon" });
  if (b.validUntil !== undefined && b.validUntil !== null && b.validUntil !== "" && !parseDateOrNull(b.validUntil)) throw new AppError("INVALID_FIELD", undefined, { field: "validUntil" });
  if (b.convertedTradeId !== undefined && b.convertedTradeId !== null) {
    const tid = Number(b.convertedTradeId);
    const { rows: tr } = await pool.query<{ trader: string | null }>(`SELECT trader FROM trades WHERE id = $1 AND deleted_at IS NULL`, [tid]);
    if (!tr[0]) throw new AppError("TRADE_NOT_FOUND", 400);
    if (!staff && tr[0].trader !== req.authUser!.name) throw new AppError("OWN_TRADES_ONLY");
  }
  const update: Record<string, unknown> = {};
  if (b.ticker !== undefined) update.ticker = String(b.ticker).trim().toUpperCase();
  if (side !== undefined) update.side = side;
  if (b.setup !== undefined) update.setup = b.setup ? String(b.setup) : null;
  if (b.entryZone !== undefined) update.entryZone = b.entryZone ? String(b.entryZone) : null;
  if (b.target !== undefined) update.target = b.target ? String(b.target) : null;
  if (b.stop !== undefined) update.stop = b.stop ? String(b.stop) : null;
  if (b.thesis !== undefined) update.thesis = b.thesis ? String(b.thesis) : null;
  if (b.score !== undefined) update.score = typeof b.score === "number" ? b.score : null;
  if (b.scoreBreakdown !== undefined) update.scoreBreakdown = b.scoreBreakdown ? (typeof b.scoreBreakdown === "string" ? b.scoreBreakdown : JSON.stringify(b.scoreBreakdown)) : null;
  if (b.status !== undefined) update.status = String(b.status);
  if (b.trader !== undefined) update.trader = b.trader ? String(b.trader) : null;
  if (b.playbookId !== undefined) update.playbookId = typeof b.playbookId === "number" ? b.playbookId : null;
  if (b.watchlistId !== undefined) update.watchlistId = typeof b.watchlistId === "number" ? b.watchlistId : null;
  if (b.screenshotUrl !== undefined) update.screenshotUrl = sanitizeMultiLineUrls(b.screenshotUrl as string | null | undefined);
  if (b.tags !== undefined) update.tags = b.tags ? String(b.tags) : null;
  if (b.convertedTradeId !== undefined) update.convertedTradeId = typeof b.convertedTradeId === "number" ? b.convertedTradeId : null;
  const numOrNull = (v: unknown) => (v !== undefined && v !== null && v !== "" ? String(v) : null);
  if (b.marketCap !== undefined) update.marketCap = b.marketCap ? String(b.marketCap) : null;
  if (b.float !== undefined) update.float = b.float ? String(b.float) : null;
  if (b.adv !== undefined) update.adv = b.adv ? String(b.adv) : null;
  if (b.atr !== undefined) update.atr = numOrNull(b.atr);
  if (b.relativeVolume !== undefined) update.relativeVolume = numOrNull(b.relativeVolume);
  if (b.beta !== undefined) update.beta = numOrNull(b.beta);
  if (b.shortInterest !== undefined) update.shortInterest = numOrNull(b.shortInterest);
  if (b.sector !== undefined) update.sector = b.sector ? String(b.sector) : null;
  if (b.longName !== undefined) update.longName = b.longName ? String(b.longName) : null;
  if (b.riskAmount !== undefined) update.riskAmount = numOrNull(b.riskAmount);
  if (b.setupQuality !== undefined) update.setupQuality = b.setupQuality ? String(b.setupQuality) : null;
  if (b.ideaDate !== undefined) update.ideaDate = parseDateOrNull(b.ideaDate);
  if (b.status === "published" && existing.status !== "published") update.publishedAt = new Date();
  const extra: { horizon?: string | null; validUntil?: string | null } = {};
  if (b.horizon !== undefined) extra.horizon = parseHorizon(b.horizon);
  if (b.validUntil !== undefined) extra.validUntil = parseDateOrNull(b.validUntil);
  if (Object.keys(update).length === 0 && Object.keys(extra).length === 0) throw new AppError("NO_FIELDS");
  const [row] = Object.keys(update).length
    ? await db.update(tradeIdeasTable).set(update).where(and(eq(tradeIdeasTable.id, id), isNull(tradeIdeasTable.deletedAt))).returning()
    : await db.select().from(tradeIdeasTable).where(and(eq(tradeIdeasTable.id, id), isNull(tradeIdeasTable.deletedAt)));
  if (!row) throw notFound();
  if (extra.horizon !== undefined) await pool.query(`UPDATE trade_ideas SET horizon = $2 WHERE id = $1`, [id, extra.horizon]);
  if (extra.validUntil !== undefined) await pool.query(`UPDATE trade_ideas SET valid_until = $2 WHERE id = $1`, [id, extra.validUntil]);
  if (b.convertedTradeId !== undefined) {
    // A hand-set link is never moved by the auto-matcher; a hand-removed one switches auto-matching off for the idea.
    await ensureIdeaLinkColumns().catch(() => undefined);
    await pool.query(
      `UPDATE trade_ideas SET trade_link_source = CASE WHEN converted_trade_id IS NULL THEN 'off' ELSE 'manual' END, trade_linked_at = NOW() WHERE id = $1`,
      [id],
    ).catch(() => undefined);
  }
  const [withMeta] = await attachMeta([{ ...row, reactions: [], linkedTrade: null }], req.authUser);
  res.json(withMeta);
}));

router.post("/trade-ideas/:id/publish", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id, res); if (id == null) return;
  if (!requireMember(req, res)) return;
  await ensureIdeaColumns().catch(() => undefined);
  const [existing] = await db.select({ trader: tradeIdeasTable.trader, deletedAt: tradeIdeasTable.deletedAt, status: tradeIdeasTable.status })
    .from(tradeIdeasTable).where(eq(tradeIdeasTable.id, id));
  if (!existing || existing.deletedAt) throw notFound();
  if (!(await canManageIdea(req, existing.trader))) throw new AppError("AUTHOR_OR_STAFF_ONLY");
  if (existing.status === "converted") throw new AppError("IDEA_ALREADY_TRADED");
  const [row] = await db.update(tradeIdeasTable)
    .set({ status: "published", publishedAt: new Date() })
    .where(and(eq(tradeIdeasTable.id, id), isNull(tradeIdeasTable.deletedAt)))
    .returning();
  if (!row) throw notFound();
  // Expiry starts at publish: intraday = this session, overnight = next, swing = +10 sessions (unless set by hand).
  const { rows: hv } = await pool.query<{ horizon: string | null; valid_until: string | null }>(`SELECT horizon, valid_until FROM trade_ideas WHERE id = $1`, [id]);
  if (hv[0] && !hv[0].valid_until) {
    await pool.query(`UPDATE trade_ideas SET valid_until = $2 WHERE id = $1`, [id, defaultValidUntil(parseHorizon(hv[0].horizon), nyDate())]);
  }
  logActivity({ action: "published", section: "trade-ideas", entityId: String(row.id), entityTitle: row.ticker, trader: row.trader ?? undefined });
  const [withMeta] = await attachMeta([{ ...row, reactions: [], linkedTrade: null }], req.authUser);
  res.json(withMeta);
  notifyReviewersOnPublish(row as Parameters<typeof notifyReviewersOnPublish>[0]).catch(() => {});
}));

/** Author sends an idea marked "needs work" (or rejected) back to the review queue after editing it. */
router.post("/trade-ideas/:id/resubmit", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id, res); if (id == null) return;
  if (!requireMember(req, res)) return;
  const [idea] = await db.select().from(tradeIdeasTable).where(eq(tradeIdeasTable.id, id));
  if (!idea || idea.deletedAt) throw notFound();
  if (!(await canManageIdea(req, idea.trader))) throw new AppError("AUTHOR_OR_STAFF_ONLY");
  if (idea.status === "converted") throw new AppError("IDEA_ALREADY_TRADED");
  await pool.query(
    `UPDATE trade_ideas SET review_status = NULL, status = 'published', published_at = COALESCE(published_at, NOW()) WHERE id = $1`,
    [id],
  );
  logActivity({ action: "resubmitted", section: "trade-ideas", entityId: String(id), entityTitle: idea.ticker, trader: idea.trader ?? undefined });
  const [fresh] = await db.select().from(tradeIdeasTable).where(eq(tradeIdeasTable.id, id));
  const [withMeta] = await attachMeta([fresh], req.authUser);
  res.json(withMeta);
  notifyReviewersOnPublish(fresh as Parameters<typeof notifyReviewersOnPublish>[0]).catch(() => {});
}));

router.post("/trade-ideas/:id/review", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id, res); if (id == null) return;
  if (!(await requireCap(req, res, "ideas.review"))) return;
  const { review_status, review_reason } = req.body as { review_status?: string; review_reason?: string };
  const reviewer = req.authUser!.name;

  if (!review_status || !["approved", "rejected", "needs_work"].includes(review_status)) throw new AppError("INVALID_FIELD", undefined, { field: "review_status" });
  if (review_reason && String(review_reason).length > 2000) throw new AppError("TEXT_TOO_LONG", undefined, { field: "reviewComment", max: 2000 });

  const updated = await applyIdeaReview(
    id,
    review_status as "approved" | "rejected" | "needs_work",
    review_reason?.trim() || null,
    reviewer,
  );
  if (!updated) throw notFound();

  const [fresh] = await db.select().from(tradeIdeasTable).where(eq(tradeIdeasTable.id, id));
  const [withMeta] = await attachMeta([fresh], req.authUser);
  res.json(withMeta);
}));

/**
 * POST /trade-ideas/:id/convert — retired. It created a manual trade, but trades come only from PropReports now:
 * a published idea is linked to the author's broker trade automatically (lib/ideaTradeMatch).
 */
router.post("/trade-ideas/:id/convert", (_req, _res): void => {
  throw new AppError("IDEA_CONVERT_RETIRED");
});

router.delete("/trade-ideas/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id, res); if (id == null) return;
  if (!requireMember(req, res)) return;
  const [existing] = await db.select({ trader: tradeIdeasTable.trader, deletedAt: tradeIdeasTable.deletedAt })
    .from(tradeIdeasTable).where(eq(tradeIdeasTable.id, id));
  if (!existing || existing.deletedAt) throw notFound();
  // Only the author or a curator/admin may delete an idea (unowned ideas: staff only).
  if (!(await canManageIdea(req, existing.trader))) throw new AppError("AUTHOR_OR_STAFF_ONLY");
  const [row] = await db.update(tradeIdeasTable)
    .set({ deletedAt: new Date() })
    .where(eq(tradeIdeasTable.id, id))
    .returning();
  if (!row) throw notFound();
  res.json({ success: true });
}));

/** Undo of DELETE (the page offers it for a few seconds): author or staff, only for an idea that is soft-deleted. */
router.post("/trade-ideas/:id/restore", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id, res); if (id == null) return;
  if (!requireMember(req, res)) return;
  const [existing] = await db.select({ trader: tradeIdeasTable.trader, deletedAt: tradeIdeasTable.deletedAt })
    .from(tradeIdeasTable).where(eq(tradeIdeasTable.id, id));
  if (!existing || !existing.deletedAt) throw new AppError("IDEA_NOT_FOUND");
  if (!(await canManageIdea(req, existing.trader))) throw new AppError("AUTHOR_OR_STAFF_ONLY");
  await db.update(tradeIdeasTable).set({ deletedAt: null }).where(eq(tradeIdeasTable.id, id));
  res.json({ success: true });
}));

router.post("/trade-ideas/:id/reactions", asyncHandler(async (req, res): Promise<void> => {
  const tradeIdeaId = parseId(req.params.id, res); if (tradeIdeaId == null) return;
  if (!requireMember(req, res)) return;
  const { reaction, comment } = req.body as Record<string, unknown>;
  // Reactions are always attributed to the authenticated user (body `trader` is ignored to prevent spoofing).
  const trader = req.authUser!.name;
  if (!reaction) throw new AppError("FIELD_REQUIRED", undefined, { field: "reaction" });
  const vis = await ideaVisibility(req);
  const [idea] = await db.select({ status: tradeIdeasTable.status, trader: tradeIdeasTable.trader, deletedAt: tradeIdeasTable.deletedAt })
    .from(tradeIdeasTable).where(eq(tradeIdeasTable.id, tradeIdeaId));
  if (!idea || idea.deletedAt || !vis || !isVisible(vis, idea)) throw notFound();
  const reactionStr = String(reaction);
  if (!["thumbs_up", "warning", "thumbs_down"].includes(reactionStr)) throw new AppError("INVALID_FIELD", undefined, { field: "reaction" });
  await db.delete(tradeIdeaReactionsTable).where(
    and(
      eq(tradeIdeaReactionsTable.tradeIdeaId, tradeIdeaId),
      eq(tradeIdeaReactionsTable.trader, String(trader)),
    ),
  );
  const [row] = await db.insert(tradeIdeaReactionsTable).values({
    tradeIdeaId,
    trader: String(trader),
    reaction: reactionStr,
    comment: comment ? String(comment).slice(0, 2000) : null,
  }).returning();
  res.status(201).json(row);
}));

router.delete("/trade-ideas/:id/reactions", asyncHandler(async (req, res): Promise<void> => {
  const tradeIdeaId = parseId(req.params.id, res); if (tradeIdeaId == null) return;
  if (!requireMember(req, res)) return;
  // Only the caller's own reaction can be removed (query/body `trader` is ignored).
  const trader = req.authUser!.name;
  await db.delete(tradeIdeaReactionsTable).where(
    and(
      eq(tradeIdeaReactionsTable.tradeIdeaId, tradeIdeaId),
      eq(tradeIdeaReactionsTable.trader, trader),
    ),
  );
  res.json({ success: true });
}));

export default router;
