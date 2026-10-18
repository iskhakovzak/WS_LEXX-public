// Team activity feed + trade reactions/reviews.
//
// Visibility (../lib/auth): staff see everything and may filter `?trader=`; everyone else sees
// their own items, reviews/reactions on their own trades and the public sections (ideas,
// discussions, playbook, research, feed, events, watchlist, game plan). Curator review texts on
// other people's trades never leave the server for a non-staff caller.
// Identity for mutations is always req.authUser — never the body or the query string.
import { Router, type IRouter } from "express";
import { desc, eq, and } from "drizzle-orm";
import { db, activityLogTable, tradeReactionsTable, tradeReviewsTable } from "@workspace/db";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { z } from "zod";
import { scopeTrader, requireMember, canAccessTrade, GUEST_SCOPE } from "../lib/auth";
import { can, requireCap } from "../lib/permissions";
import { signedRSql, netPnlSql, closeDateSql, closedSql, decidedSql, resultSql } from "../lib/tradeMath";
import { nyDate } from "../lib/tradingDate";
import { logActivity } from "../lib/activity";
import { activityTitle, localizeActivity } from "../lib/activityText";
import { audienceSql, loadAudienceViewer } from "../lib/discussionAudience";
import { spaceSql } from "../lib/playbookAccess";
import { AppError, notFound, unauthorized } from "../lib/http";
import { langOf } from "../i18n";

const GetActivityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
});

const GetTradeIdParams = z.object({ id: z.coerce.number().int().positive() });
const PostReactionBody = z.object({ reactionType: z.string().min(1).max(40) });
const PostReviewBody = z.object({ comment: z.string().min(1).max(8000), rating: z.string().max(40).optional() });
const DeleteReviewParams = z.object({ tradeId: z.coerce.number().int().positive(), reviewId: z.coerce.number().int().positive() });

const router: IRouter = Router();

/* ------------------------------------------------------------------ */
/* Unified team feed: activity_log + trade reviews/reactions,          */
/* idea reactions and discussion comments, cursor-paginated.           */
/* ------------------------------------------------------------------ */

const csv = z
  .string()
  .max(500)
  .optional()
  .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20) : undefined));

const FeedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(40),
  before: z.string().regex(/^\d{1,20}_[a-z]+:\d+$/).optional(),
  sections: csv,
  actions: csv,
  trader: z.string().min(1).max(100).optional(),
  q: z.string().max(100).optional(),
});

/** Sections every signed-in member may read in full (no personal money / review texts inside). */
const PUBLIC_SECTIONS = ["trade-ideas", "discussions", "playbook", "research", "dailyfeed", "events", "watchlist", "game-plan", "digest", "offerings"];

/** `owner` = the trader whose trade/idea the row is about (lets a trader see reviews of their own trades). */
const FEED_CTE = `
WITH feed AS (
  SELECT 'log:' || l.id AS uid, l.action, l.section, l.entity_id, l.entity_title, l.trader, l.details,
         NULL::text AS rating, l.created_at, l.params,
         CASE WHEN l.section = 'trades' AND l.entity_id ~ '^[0-9]+$' THEN (SELECT t0.trader FROM trades t0 WHERE t0.id = l.entity_id::int)
              -- curator day review: entity_id = "YYYY-MM-DD|trader" — the trader sees the review of their own day
              WHEN l.section = 'eod' AND l.entity_id LIKE '%|%' THEN split_part(l.entity_id, '|', 2)
              ELSE NULL END AS owner
    FROM activity_log l
  UNION ALL
  SELECT 'rev:' || r.id, 'reviewed', 'trades', r.trade_id::text, t.ticker, r.curator, r.comment, r.rating, r.created_at, NULL::jsonb, t.trader
    FROM trade_reviews r LEFT JOIN trades t ON t.id = r.trade_id
  UNION ALL
  SELECT 'rx:' || x.id, 'liked', 'trades', x.trade_id::text, t.ticker, x.trader, x.reaction_type, NULL, x.created_at, NULL::jsonb, t.trader
    FROM trade_reactions x LEFT JOIN trades t ON t.id = x.trade_id
  UNION ALL
  SELECT 'irx:' || x.id, 'reacted', 'trade-ideas', x.trade_idea_id::text, i.ticker, x.trader,
         CASE WHEN x.comment IS NOT NULL AND x.comment <> '' THEN x.reaction || ': ' || x.comment ELSE x.reaction END,
         NULL, x.created_at, NULL::jsonb, i.trader
    FROM trade_idea_reactions x LEFT JOIN trade_ideas i ON i.id = x.trade_idea_id
  UNION ALL
  SELECT 'cm:' || c.id, 'commented', 'discussions', c.discussion_id::text, d.topic, c.trader, c.text, NULL, c.created_at, NULL::jsonb, NULL
    FROM comments c LEFT JOIN discussions d ON d.id = c.discussion_id
)`;

type FeedRow = {
  uid: string;
  action: string;
  section: string;
  entity_id: string | null;
  entity_title: string | null;
  trader: string | null;
  details: string | null;
  rating: string | null;
  created_at: Date;
  params: Record<string, string | number | boolean | null> | null;
  ts_us: string;
};

type Visibility = { staff: boolean; me: string; filterTrader: string | null };

/** Resolve who may see what; `requested` is the `?trader=` filter (staff only). */
async function visibility(req: Parameters<typeof scopeTrader>[0], requested?: string | null): Promise<Visibility | null> {
  const scope = await scopeTrader(req, requested ?? null);
  if (scope === undefined) return null;
  const staff = await can(req, "trades.read.team");
  const me = scope === GUEST_SCOPE ? GUEST_SCOPE : req.authUser!.name;
  return { staff, me, filterTrader: staff ? scope : null };
}

/** SQL predicate for a non-staff viewer (params appended via `p`). */
function memberVisibleSql(v: Visibility, p: (x: unknown) => string): string {
  const me = p(v.me);
  // «playbook» is public only for setups the viewer may read (lib/playbookAccess): personal setups stay private
  // unless shared — otherwise others' «Мой» names and copies leak through the feed.
  const pbVisible = `(section <> 'playbook' OR entity_id IS NULL OR entity_id !~ '^[0-9]{1,9}$' OR EXISTS (
      SELECT 1 FROM playbook pb WHERE pb.id = entity_id::int AND (
        ${spaceSql("pb")} = 'office' OR pb.visibility = 'all' OR pb.trader = ${me}
        OR (pb.visibility = 'custom' AND COALESCE(pb.shared_with->'users', '[]'::jsonb) ? ${me}))))`;
  return `(trader = ${me} OR owner = ${me} OR (section = ANY(${p(PUBLIC_SECTIONS)}::text[]) AND action NOT IN ('reviewed','rated') AND ${pbVisible}))`;
}

/**
 * Discussion rows (log entries, comments) only for threads in the caller's audience (lib/discussionAudience);
 * "TRUE" for moderators. Applies to staff too — trades.read.team does not open restricted threads.
 */
async function discussionsVisibleSql(req: Parameters<typeof loadAudienceViewer>[0], p: (x: unknown) => string): Promise<string> {
  const av = await loadAudienceViewer(req);
  if (av.moderator) return "TRUE";
  return `(section <> 'discussions' OR EXISTS (SELECT 1 FROM discussions d
            WHERE d.id = CASE WHEN entity_id ~ '^[0-9]{1,9}$' THEN entity_id::int END AND ${audienceSql(av, p)}))`;
}

router.get("/activity/feed", asyncHandler(async (req, res): Promise<void> => {
  const parsed = FeedQuery.safeParse(req.query);
  if (!parsed.success) throw parsed.error;
  const { limit, before, sections, actions, trader, q } = parsed.data;
  const v = await visibility(req, trader ?? null);
  if (!v) throw unauthorized();

  const where: string[] = [];
  const params: unknown[] = [];
  const p = (x: unknown) => { params.push(x); return `$${params.length}`; };

  if (before) {
    const [ts, uid] = before.split("_");
    where.push(`(ts_us, uid) < (${p(ts)}::bigint, ${p(uid)}::text)`);
  }
  if (sections?.length) where.push(`section = ANY(${p(sections)}::text[])`);
  if (actions?.length) where.push(`action = ANY(${p(actions)}::text[])`);
  if (v.staff) {
    if (v.filterTrader) where.push(`trader = ${p(v.filterTrader)}`);
  } else {
    where.push(memberVisibleSql(v, p));
  }
  where.push(await discussionsVisibleSql(req, p));
  if (q && q.trim()) {
    const like = `%${q.trim().replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    const ph = p(like);
    where.push(`(entity_title ILIKE ${ph} OR details ILIKE ${ph} OR trader ILIKE ${ph})`);
  }

  const sql = `${FEED_CTE},
  feed2 AS (SELECT *, (extract(epoch FROM created_at) * 1000000)::bigint AS ts_us FROM feed)
  SELECT uid, action, section, entity_id, entity_title, trader, details, rating, created_at, params, ts_us::text AS ts_us
    FROM feed2
   ${where.length ? "WHERE " + where.join(" AND ") : ""}
   ORDER BY ts_us DESC, uid DESC
   LIMIT ${p(limit + 1)}`;

  const { rows } = await pool.query<FeedRow>(sql, params);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const lang = langOf(req);
  res.json({
    items: page.map((r) => ({
      uid: r.uid,
      action: r.action,
      section: r.section,
      entityId: r.entity_id,
      ...localizeActivity({ entityTitle: r.entity_title, details: r.details, params: r.params }, lang),
      trader: r.trader,
      rating: r.rating,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    nextCursor: hasMore && last ? `${last.ts_us}_${last.uid}` : null,
    scope: v.staff ? (v.filterTrader ?? "team") : "me",
  });
}));

const SummaryQuery = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  trader: z.string().min(1).max(100).optional(),
});

/** Daily digest for the feed header: activity counts for [from,to) + trades closed on `date` (NY). Also returns 30-day facets. */
router.get("/activity/summary", asyncHandler(async (req, res): Promise<void> => {
  const parsed = SummaryQuery.safeParse(req.query);
  if (!parsed.success) throw parsed.error;
  const { from, to } = parsed.data;
  const date = parsed.data.date ?? nyDate();
  if (new Date(to).getTime() <= new Date(from).getTime() || new Date(to).getTime() - new Date(from).getTime() > 8 * 86400000) throw new AppError("INVALID_RANGE", undefined, { max: 400 });
  const v = await visibility(req, parsed.data.trader ?? null);
  if (!v) throw unauthorized();

  // Feed visibility predicate ($3.. for the feed queries), trade scope for the trades block.
  const feedParams: unknown[] = [from, to];
  const fp = (x: unknown) => { feedParams.push(x); return `$${feedParams.length}`; };
  const feedWhere = `${v.staff ? (v.filterTrader ? `AND trader = ${fp(v.filterTrader)}` : "") : `AND ${memberVisibleSql(v, fp)}`} AND ${await discussionsVisibleSql(req, fp)}`;
  const tradeScope = v.staff ? v.filterTrader : v.me;
  const CLOSE = closeDateSql();
  const R = signedRSql();

  const [bySection, byTrader, trades, best, facets, facetTraders] = await Promise.all([
    pool.query<{ section: string; action: string; n: string }>(
      `${FEED_CTE} SELECT section, action, count(*)::text AS n FROM feed
        WHERE created_at >= $1 AND created_at < $2 ${feedWhere} GROUP BY section, action`, feedParams),
    pool.query<{ trader: string; n: string }>(
      `${FEED_CTE} SELECT trader, count(*)::text AS n FROM feed
        WHERE created_at >= $1 AND created_at < $2 ${feedWhere} AND trader IS NOT NULL AND trader <> 'system'
        GROUP BY trader ORDER BY count(*) DESC LIMIT 6`, feedParams),
    pool.query<{ n: string; wins: string; losses: string; be: string; sum_r: string | null; avg_r: string | null; net: string | null; pnl_count: string; traders: string }>(
      `SELECT count(*)::text AS n,
              count(*) FILTER (WHERE ${resultSql()} = 'win')::text AS wins,
              count(*) FILTER (WHERE ${resultSql()} = 'loss')::text AS losses,
              count(*) FILTER (WHERE ${resultSql()} = 'be')::text AS be,
              sum(${R})::text AS sum_r,
              avg(${R})::text AS avg_r,
              sum(${netPnlSql()})::text AS net,
              count(t.pnl)::text AS pnl_count,
              count(DISTINCT t.trader)::text AS traders
         FROM trades t WHERE t.deleted_at IS NULL AND ${closedSql()} AND ${CLOSE} = $1 AND ($2::text IS NULL OR t.trader = $2)`, [date, tradeScope]),
    pool.query<{ id: number; ticker: string; trader: string | null; r: string | null; side: string | null }>(
      `SELECT t.id, t.ticker, t.trader, ${R}::text AS r, t.side FROM trades t
        WHERE t.deleted_at IS NULL AND ${decidedSql()} AND ${CLOSE} = $1 AND ($2::text IS NULL OR t.trader = $2) AND ${R} IS NOT NULL
        ORDER BY ${R} DESC LIMIT 1`, [date, tradeScope]),
    pool.query<{ section: string; n: string }>(
      `${FEED_CTE} SELECT section, count(*)::text AS n FROM feed
        WHERE created_at >= now() - interval '30 days' ${feedWhere.replace(/\$(\d+)/g, (_m, i) => `$${Number(i) - 2}`)} GROUP BY section`, feedParams.slice(2)),
    v.staff
      ? pool.query<{ trader: string; n: string }>(
          `${FEED_CTE} SELECT trader, count(*)::text AS n FROM feed
            WHERE created_at >= now() - interval '90 days' AND trader IS NOT NULL
            GROUP BY trader ORDER BY count(*) DESC LIMIT 40`)
      : Promise.resolve({ rows: [{ trader: v.me, n: "0" }] }),
  ]);

  const t = trades.rows[0];
  const b = best.rows[0];
  const num = (s: string | null | undefined) => (s == null ? null : Number(s));
  res.json({
    range: { from, to, date },
    scope: v.staff ? (v.filterTrader ?? "team") : "me",
    total: bySection.rows.reduce((s, r) => s + Number(r.n), 0),
    bySection: bySection.rows.map((r) => ({ section: r.section, action: r.action, count: Number(r.n) })),
    topTraders: byTrader.rows.map((r) => ({ trader: r.trader, count: Number(r.n) })),
    trades: {
      count: Number(t?.n ?? 0),
      wins: Number(t?.wins ?? 0),
      losses: Number(t?.losses ?? 0),
      be: Number(t?.be ?? 0),
      sumR: num(t?.sum_r),
      avgR: num(t?.avg_r),
      /** Net $ (gross − |fees|), null until P&L is recorded. */
      net: Number(t?.pnl_count ?? 0) > 0 ? num(t?.net) : null,
      traders: Number(t?.traders ?? 0),
      best: b ? { id: b.id, ticker: b.ticker, trader: b.trader, rMultiple: num(b.r), side: b.side } : null,
    },
    facets: {
      sections30d: facets.rows.map((r) => ({ section: r.section, count: Number(r.n) })),
      traders: facetTraders.rows.map((r) => r.trader),
    },
  });
}));

/** Raw activity_log: staff see all, members their own rows. */
router.get("/activity", asyncHandler(async (req, res): Promise<void> => {
  const query = GetActivityQuery.safeParse(req.query);
  if (!query.success) {
    throw query.error;
  }
  const scope = await scopeTrader(req, null);
  if (scope === undefined) throw unauthorized();
  const base = db.select().from(activityLogTable);
  const logs = await (scope === null ? base : base.where(eq(activityLogTable.trader, scope)))
    .orderBy(desc(activityLogTable.createdAt))
    .limit(query.data.limit);
  const lang = langOf(req);
  res.json(logs.map((l) => ({ ...l, ...localizeActivity({ entityTitle: l.entityTitle, details: l.details, params: (l as { params?: Record<string, string | number | boolean | null> | null }).params ?? null }, lang), createdAt: l.createdAt.toISOString() })));
}));

router.get("/trades/:id/reactions", asyncHandler(async (req, res): Promise<void> => {
  const params = GetTradeIdParams.safeParse(req.params);
  if (!params.success) throw params.error;
  if (!req.authUser) throw unauthorized();
  const reactions = await db.select().from(tradeReactionsTable).where(eq(tradeReactionsTable.tradeId, params.data.id));
  res.json(reactions.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
}));

router.post("/trades/:id/reactions", asyncHandler(async (req, res): Promise<void> => {
  const params = GetTradeIdParams.safeParse(req.params);
  if (!params.success) throw params.error;
  const body = PostReactionBody.safeParse(req.body);
  if (!body.success) throw body.error;
  if (!requireMember(req, res)) return;
  const trader = req.authUser!.name;
  const { reactionType } = body.data;
  const existing = await db.select().from(tradeReactionsTable)
    .where(and(eq(tradeReactionsTable.tradeId, params.data.id), eq(tradeReactionsTable.trader, trader)));
  if (existing.length > 0) {
    await db.delete(tradeReactionsTable)
      .where(and(eq(tradeReactionsTable.tradeId, params.data.id), eq(tradeReactionsTable.trader, trader)));
    res.json({ removed: true });
    return;
  }
  const [reaction] = await db.insert(tradeReactionsTable).values({ tradeId: params.data.id, trader, reactionType }).returning();
  res.status(201).json({ ...reaction, createdAt: reaction.createdAt.toISOString() });
}));

router.get("/trades/:id/reviews", asyncHandler(async (req, res): Promise<void> => {
  const params = GetTradeIdParams.safeParse(req.params);
  if (!params.success) throw params.error;
  if (!req.authUser) throw unauthorized();
  // Curator reviews are personal feedback: the trade's owner and staff only.
  const ok = await canAccessTrade(req, params.data.id);
  if (ok === null) throw notFound("TRADE_NOT_FOUND");
  if (!ok) throw new AppError("OWN_TRADES_ONLY");
  const reviews = await db.select().from(tradeReviewsTable)
    .where(eq(tradeReviewsTable.tradeId, params.data.id))
    .orderBy(desc(tradeReviewsTable.createdAt));
  res.json(reviews.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
}));

router.post("/trades/:id/reviews", asyncHandler(async (req, res): Promise<void> => {
  const params = GetTradeIdParams.safeParse(req.params);
  if (!params.success) throw params.error;
  const body = PostReviewBody.safeParse(req.body);
  if (!body.success) throw body.error;
  if (!(await requireCap(req, res, "trades.review"))) return;
  const curator = req.authUser!.name;
  const { comment, rating } = body.data;
  const [review] = await db.insert(tradeReviewsTable).values({ tradeId: params.data.id, curator, comment, rating: rating ?? null }).returning();
  res.status(201).json({ ...review, createdAt: review.createdAt.toISOString() });
}));

router.delete("/trades/:tradeId/reviews/:reviewId", asyncHandler(async (req, res): Promise<void> => {
  const params = DeleteReviewParams.safeParse(req.params);
  if (!params.success) throw params.error;
  if (!(await requireCap(req, res, "trades.review"))) return;
  const [existing] = await db.select().from(tradeReviewsTable).where(eq(tradeReviewsTable.id, params.data.reviewId));
  if (!existing || existing.tradeId !== params.data.tradeId) throw new AppError("BREACH_REVIEW_NOT_FOUND");
  if (existing.curator !== req.authUser!.name && !(await can(req, "trades.review.delete.any"))) throw new AppError("REVIEW_DELETE_OWN_ONLY");
  await db.delete(tradeReviewsTable).where(eq(tradeReviewsTable.id, params.data.reviewId));
  await logActivity({ action: "deleted", section: "trades", entityId: String(params.data.tradeId), entityTitle: activityTitle("trade_review", { reviewId: params.data.reviewId }), trader: req.authUser!.name, params: { titleKey: "trade_review", reviewId: params.data.reviewId } });
  res.sendStatus(204);
}));

export default router;
