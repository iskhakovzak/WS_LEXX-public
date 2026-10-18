import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { logActivity } from "../lib/activity";
import { asyncHandler } from "../lib/asyncHandler";
import { logger } from "../lib/logger";
import { canAccessTrade, getActor, requireMember } from "../lib/auth";
import { can } from "../lib/permissions";
import { notifyMentions, notifyUser } from "../lib/notifyUtils";
import { inBackground, staffOrFallback } from "../lib/notifyEvents";
import { preview as textPreview, uniqueRecipients } from "../lib/notifyEventsCore";
import { closeDateSql, horizonSql, netPnlSql, resultSql, signedRSql } from "../lib/tradeMath";
import {
  AUDIENCE_LABELS, AUDIENCE_STAGES, STAFF_TOKEN, audienceOf, audienceRecipients, audienceSql, cohortOf, cohortToken,
  filterVisibleNames, isPublicAudience, loadAudienceViewer, loadProfiles, parseAudience, viewerTokens, type AudienceViewer,
} from "../lib/discussionAudience";
import {
  CreateDiscussionBody,
  GetDiscussionParams,
  DeleteDiscussionParams,
  AddCommentParams,
  AddCommentBody,
  ListDiscussionsResponse,
  GetDiscussionResponse,
} from "@workspace/api-zod";
import { AppError, badRequest, notFound, sendError, unauthorized } from "../lib/http";

/**
 * Discussions ("Обсуждения") — the desk's threads, now contextual.
 *
 *   GET    /discussions?limit&cursor&status&ticker&q&type&tradeId&eventId&playbookId&ideaId   member; SQL-filtered,
 *          paginated (x-total-count / x-next-cursor headers), each thread carries context ids, readAt/unread/mentionsMe
 *   POST   /discussions                   author = authUser (never the body); context: tradeId/ideaId/playbookId/eventId/journalDate;
 *                                         @mentions → in-app notifications; review_request → the author's assigned curator
 *   GET    /discussions/unread-count, POST /discussions/read-all, POST /discussions/:id/read   (discussion_reads)
 *   GET    /discussions/unanswered        questions / review requests without replies (for digests)
 *   GET    /discussions/tickers, GET /discussions/ticker-context/:ticker
 *   GET    /discussions/:id, GET /discussions/:id/entity (linked trade / event / idea / playbook card)
 *   PATCH  /discussions/:id               author or staff (+ acceptedCommentId, context ids)
 *   DELETE /discussions/:id, POST /:id/restore
 *   POST   /discussions/:id/comments      author = authUser; mentions + reply notifications (in-app only)
 *   PATCH/DELETE /discussions/:id/comments/:commentId   own comments (staff moderation)
 *   GET    /discussions/votes/all         viewer = authUser (query ignored)
 *   POST   /discussions/:id/vote
 *   GET    /discussions/audience          options for «Кому видна тема»: groups (stages, curators, cohorts) with members
 *
 * Audience (lib/discussionAudience): `audience` TEXT[] on the thread, NULL = everyone. Every path above — list, search,
 * counts, tickers, votes, single thread, comments, votes, read marks — filters through audienceSql / the same loader, so
 * a thread outside the viewer's audience answers 404 exactly like a missing one. Notifications (new thread, mentions,
 * replies, accepted answer) only reach people who may read the thread.
 */
const router: IRouter = Router();

let ensured: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `ALTER TABLE discussions ADD COLUMN IF NOT EXISTS trade_id INTEGER;
         ALTER TABLE discussions ADD COLUMN IF NOT EXISTS idea_id INTEGER;
         ALTER TABLE discussions ADD COLUMN IF NOT EXISTS playbook_id INTEGER;
         ALTER TABLE discussions ADD COLUMN IF NOT EXISTS event_id INTEGER;
         ALTER TABLE discussions ADD COLUMN IF NOT EXISTS journal_date TEXT;
         ALTER TABLE discussions ADD COLUMN IF NOT EXISTS accepted_comment_id INTEGER;
         ALTER TABLE discussions ADD COLUMN IF NOT EXISTS audience TEXT[];
         CREATE INDEX IF NOT EXISTS discussions_ticker_upper_idx ON discussions (UPPER(ticker));
         CREATE INDEX IF NOT EXISTS discussions_trade_id_idx ON discussions (trade_id);
         CREATE INDEX IF NOT EXISTS comments_discussion_id_idx ON comments (discussion_id);
         CREATE TABLE IF NOT EXISTS discussion_reads (
           user_name TEXT NOT NULL,
           thread_id INTEGER NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
           read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           PRIMARY KEY (user_name, thread_id)
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
ensureTables().catch((err) => logger.warn({ err }, "discussions: ensure tables failed at init"));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOPIC_MAX = 300;
const COMMENT_MAX = 10000;
const NOTES_MAX = 20000;

/** Reserved tags used as thread flags (no dedicated columns → no schema change). */
const TAG_PINNED = "закреплено"; // i18n-ignore (stored tag, data)
const TAG_RESOLVED = "решено"; // i18n-ignore (stored tag, data)

function splitTags(tags: string | null | undefined): string[] {
  return (tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}

const strToNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function isBanned(name: string | null | undefined): Promise<boolean> {
  if (!name) return false;
  const { rows } = await pool.query<{ banned: boolean }>(`SELECT COALESCE(banned, false) AS banned FROM users WHERE name = $1 LIMIT 1`, [name]);
  return !!rows[0]?.banned;
}

async function isModerator(req: Request): Promise<boolean> {
  return can(req, "discussions.moderate");
}

/** Thread author or curator/admin. */
async function canModifyDiscussion(req: Request, author: string | null): Promise<boolean> {
  if (await isModerator(req)) return true;
  const actor = getActor(req);
  return !!actor && !!author && actor === author;
}

/** Own comments only; discussions.edit.any (admin) may edit/delete any, discussions.moderate (curator) may delete any. */
async function canModifyComment(req: Request, commentTrader: string | null, op: "edit" | "delete"): Promise<boolean> {
  if (await can(req, op === "delete" ? "discussions.moderate" : "discussions.edit.any")) return true;
  const actor = getActor(req);
  return !!actor && commentTrader === actor;
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { sendError(res, badRequest("INVALID_ID")); return null; }
  return id;
}

// ─── Rows ───────────────────────────────────────────────────────────────────

type ThreadRow = {
  id: number; topic: string; type: string | null; trader: string | null; ticker: string | null; notes: string | null; tags: string | null;
  created_at: Date; deleted_at: Date | null; trade_id: number | null; idea_id: number | null; playbook_id: number | null;
  event_id: number | null; journal_date: string | null; accepted_comment_id: number | null; audience: string[] | null; read_at?: Date | null;
};
type CommentRow = { id: number; discussion_id: number; trader: string | null; text: string; created_at: Date };

const T_COLS = `d.id, d.topic, d.type, d.trader, d.ticker, d.notes, d.tags, d.created_at, d.deleted_at, d.trade_id, d.idea_id, d.playbook_id, d.event_id, d.journal_date, d.accepted_comment_id, d.audience`;

async function commentsFor(ids: number[]): Promise<Map<number, CommentRow[]>> {
  const map = new Map<number, CommentRow[]>();
  if (!ids.length) return map;
  const { rows } = await pool.query<CommentRow>(`SELECT id, discussion_id, trader, text, created_at FROM comments WHERE discussion_id = ANY($1::int[]) ORDER BY created_at, id`, [ids]);
  for (const c of rows) {
    const list = map.get(c.discussion_id) ?? [];
    list.push(c);
    map.set(c.discussion_id, list);
  }
  return map;
}

function mentionsName(text: string | null | undefined, name: string | null): boolean {
  if (!text || !name) return false;
  const lower = text.toLowerCase();
  const needle = `@${name.toLowerCase()}`;
  let i = lower.indexOf(needle);
  while (i !== -1) {
    const after = lower[i + needle.length];
    if (after === undefined || !/[\p{L}\p{N}_]/u.test(after)) return true;
    i = lower.indexOf(needle, i + 1);
  }
  return false;
}

/** Generated shape (validated) + derived forum fields + context + read state for the viewer. */
function serializeThread(d: ThreadRow, comments: CommentRow[], viewer: string | null) {
  const base = {
    id: d.id, topic: d.topic, type: d.type, trader: d.trader, ticker: d.ticker, notes: d.notes, tags: d.tags,
    comments: comments.map((c) => ({ id: c.id, discussionId: c.discussion_id, trader: c.trader, text: c.text, createdAt: c.created_at.toISOString() })),
    createdAt: d.created_at.toISOString(),
  };
  const parsed = GetDiscussionResponse.parse(base);
  const last = comments.length ? comments[comments.length - 1] : null;
  const participants = Array.from(new Set([d.trader, ...comments.map((c) => c.trader)].filter((x): x is string => !!x)));
  const tags = splitTags(d.tags).map((t) => t.toLowerCase());
  const lastActivityAt = last ? last.created_at.toISOString() : d.created_at.toISOString();
  const readAt = d.read_at ? new Date(d.read_at).toISOString() : null;
  const unread = !!viewer && (readAt == null || readAt < lastActivityAt);
  const mentionsMe = !!viewer && (mentionsName(d.notes, viewer) || comments.some((c) => c.trader !== viewer && mentionsName(c.text, viewer)));
  return {
    ...parsed,
    commentCount: comments.length,
    lastActivityAt,
    lastActivityBy: last ? last.trader ?? null : d.trader ?? null,
    participants,
    pinned: tags.includes(TAG_PINNED),
    resolved: tags.includes(TAG_RESOLVED) || d.accepted_comment_id != null,
    tradeId: d.trade_id, ideaId: d.idea_id, playbookId: d.playbook_id, eventId: d.event_id, journalDate: d.journal_date,
    acceptedCommentId: d.accepted_comment_id,
    /** [] = everyone; otherwise stage / "staff" / "cohort:<id>" tokens. */
    audience: audienceOf(d.audience),
    readAt, unread, mentionsMe,
  };
}

/**
 * One thread; `av` restricts it to the viewer's audience (null when outside → callers answer 404).
 * Every request path passes `av`; only background jobs that already checked access may omit it.
 */
async function loadThread(id: number, viewer: string | null, av: AudienceViewer | null, includeDeleted = false): Promise<ThreadRow | null> {
  const params: unknown[] = [id, viewer];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const vis = av ? `AND ${audienceSql(av, p)}` : "";
  const { rows } = await pool.query<ThreadRow>(
    `SELECT ${T_COLS}, r.read_at FROM discussions d
       LEFT JOIN discussion_reads r ON r.thread_id = d.id AND r.user_name = $2
      WHERE d.id = $1 ${includeDeleted ? "" : "AND d.deleted_at IS NULL"} ${vis} LIMIT 1`,
    params,
  );
  return rows[0] ?? null;
}

async function fullThread(id: number, viewer: string | null, av: AudienceViewer) {
  const row = await loadThread(id, viewer, av);
  if (!row) return null;
  const cm = await commentsFor([id]);
  return serializeThread(row, cm.get(id) ?? [], viewer);
}

async function markRead(viewer: string | null, threadId: number): Promise<void> {
  if (!viewer) return;
  await pool.query(
    `INSERT INTO discussion_reads (user_name, thread_id, read_at) VALUES ($1, $2, NOW())
     ON CONFLICT (user_name, thread_id) DO UPDATE SET read_at = NOW()`,
    [viewer, threadId],
  );
}

const threadLink = (id: number) => `/discussions?thread=${id}`;

// ─── List ───────────────────────────────────────────────────────────────────

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.coerce.number().int().min(0).optional(),
  status: z.enum(["all", "open", "resolved", "pinned", "unread", "mine", "mentions"]).optional(),
  ticker: z.string().trim().max(12).optional(),
  type: z.string().trim().max(40).optional(),
  q: z.string().trim().max(200).optional(),
  tradeId: z.coerce.number().int().positive().optional(),
  eventId: z.coerce.number().int().positive().optional(),
  playbookId: z.coerce.number().int().positive().optional(),
  ideaId: z.coerce.number().int().positive().optional(),
  journalDate: z.string().regex(ISO_DATE).optional(),
  sort: z.enum(["activity", "created", "votes"]).optional(),
  /** "me" = restricted threads addressed to the viewer; "public" = for everyone; otherwise one audience token. */
  audience: z.string().trim().max(40).optional(),
});

router.get("/discussions", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!req.authUser) throw unauthorized();
  const viewer = req.authUser.name;
  const q = ListQuery.safeParse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== "" && v !== undefined)));
  if (!q.success) throw q.error;
  const f = q.data;
  const av = await loadAudienceViewer(req);
  const limit = f.limit ?? 200, cursor = f.cursor ?? 0;
  const where: string[] = ["d.deleted_at IS NULL"];
  const params: unknown[] = [viewer];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  where.push(audienceSql(av, p));
  if (f.audience === "public") where.push(`(d.audience IS NULL OR cardinality(d.audience) = 0)`);
  else if (f.audience === "me") {
    const mine = viewerTokens(av);
    where.push(mine.length ? `(cardinality(d.audience) > 0 AND d.audience && ${p(mine)}::text[])` : "FALSE");
  } else if (f.audience) {
    const parsedAud = parseAudience(f.audience);
    if (!parsedAud.ok || parsedAud.audience.length !== 1) throw new AppError("AUDIENCE_FILTER_INVALID");
    where.push(`${p(parsedAud.audience[0])} = ANY(d.audience)`);
  }
  if (f.ticker) where.push(`UPPER(d.ticker) = ${p(f.ticker.toUpperCase())}`);
  if (f.type) where.push(`LOWER(COALESCE(d.type, '')) = ${p(f.type.toLowerCase())}`);
  if (f.tradeId) where.push(`d.trade_id = ${p(f.tradeId)}`);
  if (f.eventId) where.push(`d.event_id = ${p(f.eventId)}`);
  if (f.playbookId) where.push(`d.playbook_id = ${p(f.playbookId)}`);
  if (f.ideaId) where.push(`d.idea_id = ${p(f.ideaId)}`);
  if (f.journalDate) where.push(`d.journal_date = ${p(f.journalDate)}`);
  if (f.q) {
    const like = p(`%${f.q}%`);
    where.push(`(d.topic ILIKE ${like} OR COALESCE(d.notes, '') ILIKE ${like} OR COALESCE(d.tags, '') ILIKE ${like} OR COALESCE(d.ticker, '') ILIKE ${like}
      OR EXISTS (SELECT 1 FROM comments c WHERE c.discussion_id = d.id AND c.text ILIKE ${like}))`);
  }
  const tagHas = (tag: string) => `(',' || LOWER(regexp_replace(COALESCE(d.tags, ''), '\\s*,\\s*', ',', 'g')) || ',') LIKE ${p(`%,${tag},%`)}`;
  switch (f.status) {
    case "open": where.push(`NOT ${tagHas(TAG_RESOLVED)} AND d.accepted_comment_id IS NULL`); break;
    case "resolved": where.push(`(${tagHas(TAG_RESOLVED)} OR d.accepted_comment_id IS NOT NULL)`); break;
    case "pinned": where.push(tagHas(TAG_PINNED)); break;
    case "mine": where.push(`(d.trader = $1 OR EXISTS (SELECT 1 FROM comments c WHERE c.discussion_id = d.id AND c.trader = $1))`); break;
    case "unread": where.push(`(r.read_at IS NULL OR r.read_at < la.last_at)`); break;
    case "mentions": where.push(`(d.notes ILIKE ${p(`%@${viewer}%`)} OR EXISTS (SELECT 1 FROM comments c WHERE c.discussion_id = d.id AND c.trader IS DISTINCT FROM $1 AND c.text ILIKE ${p(`%@${viewer}%`)}))`); break;
    default: break;
  }
  const order = f.sort === "created" ? "d.created_at DESC" : f.sort === "votes" ? "COALESCE(v.score, 0) DESC, la.last_at DESC" : "la.last_at DESC";
  const sql = `
    FROM discussions d
    LEFT JOIN discussion_reads r ON r.thread_id = d.id AND r.user_name = $1
    LEFT JOIN LATERAL (SELECT GREATEST(d.created_at, MAX(c.created_at)) AS last_at FROM comments c WHERE c.discussion_id = d.id) la ON TRUE
    LEFT JOIN LATERAL (SELECT COALESCE(SUM(value), 0)::int AS score FROM discussion_votes dv WHERE dv.discussion_id = d.id) v ON TRUE
    WHERE ${where.join(" AND ")}`;
  const total = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n ${sql}`, params);
  const { rows } = await pool.query<ThreadRow>(
    `SELECT ${T_COLS}, r.read_at ${sql}
      ORDER BY (${tagHas(TAG_PINNED)}) DESC, ${order}, d.id DESC
      LIMIT ${p(limit)} OFFSET ${p(cursor)}`,
    params,
  );
  const cm = await commentsFor(rows.map((d) => d.id));
  const items = rows.map((d) => serializeThread(d, cm.get(d.id) ?? [], viewer));
  ListDiscussionsResponse.parse(items);
  const n = Number(total.rows[0]?.n ?? 0);
  res.setHeader("x-total-count", String(n));
  res.setHeader("x-next-cursor", cursor + rows.length < n ? String(cursor + rows.length) : "");
  res.json(items);
}));

// ─── Create ─────────────────────────────────────────────────────────────────

const CreateExtra = z.object({
  tradeId: z.coerce.number().int().positive().nullish(),
  ideaId: z.coerce.number().int().positive().nullish(),
  playbookId: z.coerce.number().int().positive().nullish(),
  eventId: z.coerce.number().int().positive().nullish(),
  journalDate: z.string().regex(ISO_DATE).nullish(),
});

/** review_request → the author's assigned curator / risk / mentor (fallback: every curator/admin), never the author. */
async function notifyReviewRequest(author: string, threadId: number, topic: string, ticker: string | null): Promise<void> {
  try {
    const targets = uniqueRecipients(await staffOrFallback(author), author);
    for (const name of targets) {
      await notifyUser({
        userName: name, type: "review_request", actor: author,
        params: { author, ticker: ticker || null, preview: textPreview(topic, 120) },
        link: threadLink(threadId), entityType: "thread", entityId: threadId,
      });
    }
  } catch (e) {
    logger.warn({ err: e }, "discussions: review request notification failed");
  }
}

/**
 * Cohort tokens must name live cohorts; a member who is not staff may address only cohorts they study in.
 * `keep` = cohorts already on the thread (an edit may leave them as they are). Returns an error code or null.
 */
async function checkCohorts(audience: string[], av: AudienceViewer, keep: readonly string[] = []): Promise<"COHORT_NOT_FOUND" | "COHORT_OWN_ONLY" | null> {
  const ids = audience.filter((t) => !keep.includes(t)).map(cohortOf).filter((x): x is number => x != null);
  if (!ids.length) return null;
  let live: number[] = [];
  try {
    const { rows } = await pool.query<{ id: number }>(`SELECT id FROM academy_cohorts WHERE id = ANY($1::int[]) AND archived_at IS NULL`, [ids]);
    live = rows.map((r) => Number(r.id));
  } catch { /* academy tables not created yet */ }
  if (ids.some((id) => !live.includes(id))) return "COHORT_NOT_FOUND";
  if (!av.moderator && !av.staff && ids.some((id) => !av.cohorts.includes(id))) return "COHORT_OWN_ONLY";
  return null;
}

async function cohortNames(): Promise<Map<number, string>> {
  try {
    const { rows } = await pool.query<{ id: number; name: string }>(`SELECT id, name FROM academy_cohorts WHERE archived_at IS NULL ORDER BY id`);
    return new Map(rows.map((r) => [Number(r.id), String(r.name)]));
  } catch {
    return new Map();
  }
}

/**
 * New thread → in-app «Новая тема» to its audience (everyone for a public thread), never the author and never
 * people already notified (mentions). Review requests go to the curator only — no desk broadcast.
 */
async function notifyNewThread(o: { author: string; id: number; topic: string; ticker: string | null; type: string | null; audience: string[]; skip: Set<string> }): Promise<void> {
  if (o.type === "review_request") return;
  try {
    const targets = (await audienceRecipients(o.audience)).filter((n) => n !== o.author && !o.skip.has(n));
    if (!targets.length) return;
    // Audience as data (tokens + the cohort names it mentions): the label is rendered in each reader's language.
    const names = isPublicAudience(o.audience) ? null : await cohortNames();
    const cohorts = names ? Object.fromEntries(o.audience.map(cohortOf).filter((c): c is number => c != null && names.has(c)).map((c) => [c, names.get(c)!])) : {};
    for (const name of targets) {
      await notifyUser({
        userName: name, type: "thread_new", actor: o.author,
        params: {
          author: o.author, ticker: o.ticker || null, preview: textPreview(o.topic, 140),
          audience: isPublicAudience(o.audience) ? null : o.audience.join(","), cohorts: Object.keys(cohorts).length ? JSON.stringify(cohorts) : null,
        },
        link: threadLink(o.id), entityType: "thread", entityId: o.id,
      });
    }
  } catch (e) {
    logger.warn({ err: e }, "discussions: new thread notification failed");
  }
}

router.post("/discussions", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const parsed = CreateDiscussionBody.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const extra = CreateExtra.safeParse(req.body);
  if (!extra.success) throw extra.error;
  const topic = parsed.data.topic.trim();
  if (!topic) throw new AppError("TOPIC_REQUIRED");
  if (topic.length > TOPIC_MAX) throw new AppError("TEXT_TOO_LONG", 400, { field: "topic", max: TOPIC_MAX });
  if ((parsed.data.notes ?? "").length > NOTES_MAX) throw new AppError("TEXT_TOO_LONG", 400, { field: "notes", max: NOTES_MAX });
  // The authenticated user is the author — the body value is ignored.
  const author = req.authUser!.name;
  if (await isBanned(author)) throw new AppError("BANNED_ACTION");
  const type = parsed.data.type?.trim().slice(0, 40) || null;
  let ticker = parsed.data.ticker?.trim().toUpperCase() || null;
  const ctx = extra.data;
  // Audience: absent / "all" → everyone (the historic behaviour).
  const aud = parseAudience((req.body as { audience?: unknown } | undefined)?.audience);
  if (!aud.ok) throw new AppError(aud.code, 400, aud.params);
  const av = await loadAudienceViewer(req);
  const cohortErr = await checkCohorts(aud.audience, av);
  if (cohortErr) throw new AppError(cohortErr);
  const audience = aud.audience;
  // Linked trade: must be readable by the author; its ticker fills the thread ticker when absent.
  if (ctx.tradeId) {
    const access = await canAccessTrade(req, ctx.tradeId);
    if (access === null) throw notFound("TRADE_NOT_FOUND");
    if (!access) throw new AppError("TRADE_NOT_YOURS");
    if (!ticker) {
      const { rows } = await pool.query<{ ticker: string }>(`SELECT ticker FROM trades WHERE id = $1`, [ctx.tradeId]);
      ticker = rows[0]?.ticker?.toUpperCase() ?? null;
    }
  }
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO discussions (topic, type, trader, ticker, notes, tags, trade_id, idea_id, playbook_id, event_id, journal_date, audience)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [topic, type, author, ticker, parsed.data.notes ?? null, parsed.data.tags ?? null, ctx.tradeId ?? null, ctx.ideaId ?? null, ctx.playbookId ?? null, ctx.eventId ?? null, ctx.journalDate ?? null, audience.length ? audience : null],
  );
  const id = rows[0].id;
  await markRead(author, id);
  logActivity({ action: "created", section: "discussions", entityId: String(id), entityTitle: topic, trader: author, details: ctx.tradeId ? `trade #${ctx.tradeId}` : undefined });
  // In-app only (telegram: false) — mentions in the opening post, then «Новая тема» to the audience.
  // Off the critical path: the thread is already saved, notifications must not delay or fail the response.
  const row = { trader: author, audience };
  inBackground("discussions.create", async () => {
    const mentioned = await notifyMentions({
      text: `${topic}\n${parsed.data.notes ?? ""}`, authorName: author, where: { kind: "discussion", subject: ticker || null }, link: threadLink(id), telegram: false,
      filter: (names) => filterVisibleNames(names, row),
    });
    if (type === "review_request") await notifyReviewRequest(author, id, topic, ticker);
    await notifyNewThread({ author, id, topic, ticker, type, audience, skip: new Set(mentioned) });
  });
  const full = await fullThread(id, author, av);
  res.status(201).json(full);
}));

// ─── Static paths (before /:id) ─────────────────────────────────────────────

router.get("/discussions/tickers", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!req.authUser) throw unauthorized();
  const av = await loadAudienceViewer(req);
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const { rows } = await pool.query(
    `SELECT UPPER(d.ticker) AS ticker, COUNT(*)::int AS count FROM discussions d
     WHERE d.deleted_at IS NULL AND d.ticker IS NOT NULL AND d.ticker <> '' AND ${audienceSql(av, p)}
     GROUP BY 1 ORDER BY count DESC, ticker ASC`,
    params,
  );
  res.json(rows);
}));

/**
 * unread   threads with activity the viewer has not read; mentions — of those, ones that @mention them;
 * fresh    threads by others, created in the last 7 days, never opened; attention = fresh ∪ unread mentions
 *          (the nav badge). All within the viewer's audience.
 */
router.get("/discussions/unread-count", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!req.authUser) throw unauthorized();
  const viewer = req.authUser.name;
  const av = await loadAudienceViewer(req);
  const params: unknown[] = [viewer, `%@${viewer}%`];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const vis = audienceSql(av, p);
  const { rows } = await pool.query<{ unread: string; mentions: string; fresh: string; attention: string }>(
    `WITH x AS (
       SELECT (r.read_at IS NULL OR r.read_at < la.last_at) AS is_unread,
              (d.notes ILIKE $2 OR EXISTS (SELECT 1 FROM comments c WHERE c.discussion_id = d.id AND c.trader IS DISTINCT FROM $1 AND c.text ILIKE $2)) AS is_mention,
              (r.read_at IS NULL AND d.trader IS DISTINCT FROM $1 AND d.created_at > NOW() - INTERVAL '7 days') AS is_fresh
         FROM discussions d
         LEFT JOIN discussion_reads r ON r.thread_id = d.id AND r.user_name = $1
         LEFT JOIN LATERAL (SELECT GREATEST(d.created_at, MAX(c.created_at)) AS last_at FROM comments c WHERE c.discussion_id = d.id) la ON TRUE
        WHERE d.deleted_at IS NULL AND ${vis}
     )
     SELECT COUNT(*) FILTER (WHERE is_unread)::text AS unread,
            COUNT(*) FILTER (WHERE is_unread AND is_mention)::text AS mentions,
            COUNT(*) FILTER (WHERE is_fresh)::text AS fresh,
            COUNT(*) FILTER (WHERE is_fresh OR (is_unread AND is_mention))::text AS attention
       FROM x`,
    params,
  );
  const r = rows[0];
  res.json({ unread: Number(r?.unread ?? 0), mentions: Number(r?.mentions ?? 0), fresh: Number(r?.fresh ?? 0), attention: Number(r?.attention ?? 0) });
}));

router.post("/discussions/read-all", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const viewer = req.authUser!.name;
  const av = await loadAudienceViewer(req);
  const params: unknown[] = [viewer];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const { rowCount } = await pool.query(
    `INSERT INTO discussion_reads (user_name, thread_id, read_at)
     SELECT $1, d.id, NOW() FROM discussions d WHERE d.deleted_at IS NULL AND ${audienceSql(av, p)}
     ON CONFLICT (user_name, thread_id) DO UPDATE SET read_at = NOW()`,
    params,
  );
  res.json({ success: true, marked: rowCount ?? 0 });
}));

/**
 * «Кому видна тема» — groups the author may address, with their members (active, not banned), so the dialog can
 * say «увидят N человек» for any combination without another request. Cohorts: all live ones for staff, own otherwise.
 * `moderators` always see every thread (moderation); `viewer` drives the list tabs («Для меня»).
 */
router.get("/discussions/audience", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!req.authUser) throw unauthorized();
  const av = await loadAudienceViewer(req);
  const [people, names] = await Promise.all([loadProfiles(null), cohortNames()]);
  const sortRu = (a: string, b: string) => a.localeCompare(b, "ru");
  const members = (pred: (p: (typeof people)[number]) => boolean) => people.filter(pred).map((p) => p.name).sort(sortRu);
  const groups: { token: string; label: string; kind: "stage" | "staff" | "cohort"; members: string[] }[] = [
    ...AUDIENCE_STAGES.map((s) => ({ token: s as string, label: AUDIENCE_LABELS[s], kind: "stage" as const, members: members((p) => p.stage === s) })),
    { token: STAFF_TOKEN, label: AUDIENCE_LABELS[STAFF_TOKEN], kind: "staff", members: members((p) => p.staff) },
  ];
  for (const [id, name] of names) {
    if (!av.moderator && !av.staff && !av.cohorts.includes(id)) continue;
    groups.push({ token: cohortToken(id), label: name, kind: "cohort", members: members((p) => p.cohorts.includes(id)) });
  }
  res.json({
    everyone: people.map((p) => p.name).sort(sortRu),
    moderators: members((p) => p.moderator),
    groups,
    /** Labels for every live cohort (a thread may name one the viewer cannot address). */
    cohortLabels: Object.fromEntries(names),
    viewer: { name: av.name, stage: av.stage, staff: av.staff, moderator: av.moderator, cohorts: av.cohorts, tokens: viewerTokens(av) },
  });
}));

/** Questions / review requests nobody answered (for the curator digest and the "needs answer" filter). */
router.get("/discussions/unanswered", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!req.authUser) throw unauthorized();
  const hoursRaw = Number(req.query.hours);
  const hours = Number.isFinite(hoursRaw) && hoursRaw >= 0 ? Math.min(24 * 30, hoursRaw) : 2;
  const av = await loadAudienceViewer(req);
  const params: unknown[] = [hours];
  const vis = audienceSql(av, (v) => { params.push(v); return `$${params.length}`; });
  const { rows } = await pool.query<ThreadRow & { age_hours: string }>(
    // i18n-ignore (the SQL matches the stored tag «решено»)
    `SELECT ${T_COLS}, EXTRACT(EPOCH FROM (NOW() - d.created_at))::text AS age_hours
       FROM discussions d
      WHERE d.deleted_at IS NULL AND LOWER(COALESCE(d.type, '')) IN ('question', 'review_request')
        AND d.accepted_comment_id IS NULL
        AND NOT ((',' || LOWER(regexp_replace(COALESCE(d.tags, ''), '\\s*,\\s*', ',', 'g')) || ',') LIKE '%,решено,%')
        AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.discussion_id = d.id AND c.trader IS DISTINCT FROM d.trader)
        AND d.created_at < NOW() - ($1::int * INTERVAL '1 hour')
        AND ${vis}
      ORDER BY d.created_at ASC LIMIT 100`,
    params,
  );
  res.json({
    hours,
    items: rows.map((d) => ({
      id: d.id, topic: d.topic, type: d.type, trader: d.trader, ticker: d.ticker, tradeId: d.trade_id, createdAt: d.created_at.toISOString(),
      ageHours: Math.round(Number(d.age_hours) / 3600),
    })),
  });
}));

/**
 * Cross-section context for a ticker mentioned in discussions:
 * watchlist entries, trade ideas, team trades summary (one math) and thread count. Read-only.
 */
const TickerParam = z.object({ ticker: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9.\-]+$/) });

router.get("/discussions/ticker-context/:ticker", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!req.authUser) throw unauthorized();
  const params = TickerParam.safeParse(req.params);
  if (!params.success) throw badRequest("INVALID_TICKER");
  const ticker = params.data.ticker.toUpperCase();
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
  const [watch, ideas, trades, threads, events] = await Promise.all([
    pool.query<any>(
      `SELECT id, ticker, status, catalyst, target_price AS "targetPrice", stop_price AS "stopPrice", score, created_at AS "createdAt"
         FROM watchlist WHERE deleted_at IS NULL AND UPPER(ticker) = $1
         ORDER BY created_at DESC LIMIT 5`, [ticker]),
    pool.query<any>(
      `SELECT id, ticker, side, setup, status, trader, score, idea_date AS "ideaDate", created_at AS "createdAt"
         FROM trade_ideas WHERE deleted_at IS NULL AND UPPER(ticker) = $1
         ORDER BY created_at DESC LIMIT 5`, [ticker]),
    pool.query<any>(
      `SELECT COUNT(*)::int AS count, MAX(${closeDateSql("t")}) AS "lastDate",
              COUNT(DISTINCT t.trader)::int AS traders,
              COUNT(*) FILTER (WHERE ${resultSql("t")} = 'win')::int AS wins,
              COUNT(*) FILTER (WHERE ${resultSql("t")} = 'loss')::int AS losses,
              COUNT(*) FILTER (WHERE ${resultSql("t")} = 'be')::int AS be,
              SUM(${signedRSql("t")})::float AS "sumR",
              SUM(${netPnlSql("t")})::float AS "netPnl"
         FROM trades t WHERE t.deleted_at IS NULL AND UPPER(t.ticker) = $1`, [ticker]),
    loadAudienceViewer(req).then((av) => {
      const qp: unknown[] = [ticker];
      const vis = audienceSql(av, (v) => { qp.push(v); return `$${qp.length}`; });
      return pool.query<any>(`SELECT COUNT(*)::int AS count FROM discussions d WHERE d.deleted_at IS NULL AND UPPER(d.ticker) = $1 AND ${vis}`, qp);
    }),
    pool.query<any>(
      `SELECT id, substring(date, 1, 10) AS date, event_type AS "eventType", headline, percent_move::float AS "percentMove", session
         FROM market_events WHERE deleted_at IS NULL AND (',' || regexp_replace(UPPER(ticker), '[[:space:],;/]+', ',', 'g') || ',') LIKE ('%,' || $1 || ',%')
         ORDER BY date DESC LIMIT 5`, [ticker]),
  ]);
  const tr = trades.rows[0] ?? { count: 0, lastDate: null, traders: 0, wins: 0, losses: 0, be: 0, sumR: null, netPnl: null };
  const decided = Number(tr.wins) + Number(tr.losses);
  res.json({
    ticker,
    watchlist: watch.rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
    ideas: ideas.rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
    trades: { ...tr, winRate: decided ? Math.round((Number(tr.wins) / decided) * 100) : null },
    discussions: threads.rows[0]?.count ?? 0,
    events: events.rows,
  });
}));

router.get("/discussions/votes/all", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  // The viewer is the signed-in user; `?trader=` is ignored.
  const trader = req.authUser.name;
  // Only threads in the viewer's audience.
  const av = await loadAudienceViewer(req);
  const qp: unknown[] = [];
  const vis = audienceSql(av, (v) => { qp.push(v); return `$${qp.length}`; });
  const { rows: agg } = await pool.query<any>(
    `SELECT discussion_id AS "discussionId",
            COALESCE(SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END), 0)::int AS upvotes,
            COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0)::int AS downvotes,
            COALESCE(SUM(value), 0)::int AS score
       FROM discussion_votes WHERE discussion_id IN (SELECT d.id FROM discussions d WHERE ${vis}) GROUP BY discussion_id`,
    qp,
  );
  const map: Record<number, { upvotes: number; downvotes: number; score: number; myVote: number | null }> = {};
  for (const r of agg) map[r.discussionId] = { upvotes: r.upvotes, downvotes: r.downvotes, score: r.score, myVote: null };
  const { rows: mine } = await pool.query<any>(`SELECT discussion_id AS "discussionId", value FROM discussion_votes WHERE trader = $1`, [trader]);
  for (const r of mine) {
    if (!map[r.discussionId]) map[r.discussionId] = { upvotes: 0, downvotes: 0, score: 0, myVote: r.value };
    else map[r.discussionId].myVote = r.value;
  }
  res.json(map);
}));

// ─── Single thread ──────────────────────────────────────────────────────────

router.get("/discussions/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!req.authUser) throw unauthorized();
  const params = GetDiscussionParams.safeParse(req.params);
  if (!params.success) throw params.error;
  const full = await fullThread(params.data.id, req.authUser.name, await loadAudienceViewer(req));
  if (!full) throw notFound("DISCUSSION_NOT_FOUND");
  res.json(full);
}));

/** The entity a thread is about — for the header card (trade is scoped: own or staff). */
router.get("/discussions/:id/entity", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!req.authUser) throw unauthorized();
  const id = parseId(req, res); if (id == null) return;
  const d = await loadThread(id, req.authUser.name, await loadAudienceViewer(req));
  if (!d) throw notFound("DISCUSSION_NOT_FOUND");
  const out: Record<string, unknown> = { id, tradeId: d.trade_id, eventId: d.event_id, ideaId: d.idea_id, playbookId: d.playbook_id, journalDate: d.journal_date, ticker: d.ticker };
  if (d.trade_id) {
    const access = await canAccessTrade(req, d.trade_id);
    if (access) {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT t.id, t.ticker, t.date, t.exit_date, ${closeDateSql("t")} AS close_date, t.side, t.setup, t.result, ${resultSql("t")} AS res,
                ${horizonSql("t")} AS horizon, t.entry, t.exit, t.stop, t.qty, t.pnl, t.fees, ${netPnlSql("t")} AS net_pnl, ${signedRSql("t")} AS signed_r,
                t.trader, t.source, t.broker_account, t.playbook_id, t.screenshot_url
           FROM trades t WHERE t.id = $1 AND t.deleted_at IS NULL`, [d.trade_id]);
      const t = rows[0];
      out.trade = t ? {
        id: Number(t.id), ticker: t.ticker, date: String(t.date ?? "").slice(0, 10), exitDate: t.exit_date ?? null, closeDate: String(t.close_date ?? "").slice(0, 10),
        side: t.side ?? null, setup: t.setup ?? null, result: t.result ?? null, res: t.res ?? null, horizon: t.horizon, entry: strToNum(t.entry), exit: strToNum(t.exit),
        stop: strToNum(t.stop), qty: strToNum(t.qty), pnl: strToNum(t.pnl), fees: strToNum(t.fees), netPnl: strToNum(t.net_pnl), signedR: strToNum(t.signed_r),
        trader: t.trader ?? null, source: t.source ?? null, brokerAccount: t.broker_account ?? null, playbookId: t.playbook_id ?? null, screenshotUrl: t.screenshot_url ?? null,
      } : null;
    } else {
      out.trade = { id: d.trade_id, restricted: true };
    }
  }
  if (d.event_id) {
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT id, ticker, substring(date, 1, 10) AS date, event_type, headline, reaction, percent_move::float AS percent_move, session FROM market_events WHERE id = $1 AND deleted_at IS NULL`, [d.event_id]);
    const e = rows[0];
    out.event = e ? { id: Number(e.id), ticker: e.ticker, date: e.date, eventType: e.event_type, headline: e.headline, reaction: e.reaction ?? null, percentMove: strToNum(e.percent_move), session: e.session ?? null } : null;
  }
  if (d.idea_id) {
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT id, ticker, side, setup, status, trader, score, idea_date FROM trade_ideas WHERE id = $1 AND deleted_at IS NULL`, [d.idea_id]);
    const i = rows[0];
    out.idea = i ? { id: Number(i.id), ticker: i.ticker, side: i.side ?? null, setup: i.setup ?? null, status: i.status ?? null, trader: i.trader ?? null, score: strToNum(i.score), ideaDate: i.idea_date ?? null } : null;
  }
  if (d.playbook_id) {
    try {
      const { rows } = await pool.query<Record<string, unknown>>(`SELECT id, name FROM playbook WHERE id = $1 AND deleted_at IS NULL`, [d.playbook_id]);
      const pb = rows[0];
      out.playbook = pb ? { id: Number(pb.id), name: pb.name } : null;
    } catch {
      out.playbook = { id: d.playbook_id };
    }
  }
  res.json(out);
}));

router.post("/discussions/:id/read", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const id = parseId(req, res); if (id == null) return;
  const d = await loadThread(id, req.authUser!.name, await loadAudienceViewer(req));
  if (!d) throw notFound("DISCUSSION_NOT_FOUND");
  await markRead(req.authUser!.name, id);
  res.json({ id, readAt: new Date().toISOString() });
}));

router.delete("/discussions/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const params = DeleteDiscussionParams.safeParse(req.params);
  if (!params.success) throw params.error;
  const existing = await loadThread(params.data.id, null, await loadAudienceViewer(req));
  if (!existing) throw notFound("DISCUSSION_NOT_FOUND");
  if (!(await canModifyDiscussion(req, existing.trader))) throw new AppError("DISCUSSION_AUTHOR_ONLY");
  await pool.query(`UPDATE discussions SET deleted_at = NOW() WHERE id = $1`, [existing.id]);
  logActivity({ action: "deleted", section: "discussions", entityId: String(existing.id), entityTitle: existing.topic, trader: req.authUser!.name });
  res.sendStatus(204);
}));

const PatchDiscussionBody = z.object({
  topic: z.string().trim().min(1).max(TOPIC_MAX).optional(),
  type: z.string().trim().max(40).nullish(),
  ticker: z.string().trim().max(12).nullish(),
  notes: z.string().max(NOTES_MAX).nullish(),
  tags: z.string().max(1000).nullish(),
  tradeId: z.coerce.number().int().positive().nullish(),
  ideaId: z.coerce.number().int().positive().nullish(),
  playbookId: z.coerce.number().int().positive().nullish(),
  eventId: z.coerce.number().int().positive().nullish(),
  journalDate: z.string().regex(ISO_DATE).nullish(),
  acceptedCommentId: z.coerce.number().int().positive().nullish(),
  /** Tokens array / comma string; null, [] or "all" = everyone. */
  audience: z.union([z.array(z.string().max(40)).max(20), z.string().max(400)]).nullish(),
}).strict();

/** Edit a thread (author or curator/admin). Pin flag is curator/admin-only. */
router.patch("/discussions/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const id = parseId(req, res); if (id == null) return;
  const body = PatchDiscussionBody.safeParse(req.body);
  if (!body.success) throw body.error;
  const viewer = req.authUser!.name;
  const av = await loadAudienceViewer(req);
  const existing = await loadThread(id, viewer, av);
  if (!existing) throw notFound("DISCUSSION_NOT_FOUND");
  if (!(await canModifyDiscussion(req, existing.trader))) throw new AppError("DISCUSSION_AUTHOR_ONLY");
  if (await isBanned(viewer)) throw new AppError("BANNED_ACTION");
  const b = body.data;
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.topic !== undefined) set("topic", b.topic);
  if (b.type !== undefined) set("type", b.type || null);
  if (b.ticker !== undefined) set("ticker", b.ticker ? b.ticker.toUpperCase() : null);
  if (b.notes !== undefined) set("notes", b.notes || null);
  if (b.tags !== undefined) {
    const next = Array.from(new Set(splitTags(b.tags)));
    const wasPinned = splitTags(existing.tags).map((t) => t.toLowerCase()).includes(TAG_PINNED);
    const isPinned = next.map((t) => t.toLowerCase()).includes(TAG_PINNED);
    if (wasPinned !== isPinned && !(await isModerator(req))) throw new AppError("PIN_STAFF_ONLY");
    set("tags", next.length ? next.join(", ") : null);
  }
  if (b.tradeId !== undefined) {
    if (b.tradeId) {
      const access = await canAccessTrade(req, b.tradeId);
      if (access === null) throw notFound("TRADE_NOT_FOUND");
      if (!access) throw new AppError("TRADE_NOT_YOURS");
    }
    set("trade_id", b.tradeId ?? null);
  }
  if (b.ideaId !== undefined) set("idea_id", b.ideaId ?? null);
  if (b.playbookId !== undefined) set("playbook_id", b.playbookId ?? null);
  if (b.eventId !== undefined) set("event_id", b.eventId ?? null);
  if (b.journalDate !== undefined) set("journal_date", b.journalDate ?? null);
  if (b.audience !== undefined) {
    const aud = parseAudience(b.audience);
    if (!aud.ok) throw new AppError(aud.code, 400, aud.params);
    const cohortErr = await checkCohorts(aud.audience, av, audienceOf(existing.audience));
    if (cohortErr) throw new AppError(cohortErr);
    set("audience", aud.audience.length ? aud.audience : null);
  }
  if (b.acceptedCommentId !== undefined) {
    if (b.acceptedCommentId) {
      const { rows } = await pool.query(`SELECT 1 FROM comments WHERE id = $1 AND discussion_id = $2`, [b.acceptedCommentId, id]);
      if (!rows.length) throw new AppError("COMMENT_NOT_IN_THREAD");
    }
    set("accepted_comment_id", b.acceptedCommentId ?? null);
  }
  if (!sets.length) throw new AppError("NO_FIELDS");
  vals.push(id);
  await pool.query(`UPDATE discussions SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  if (b.acceptedCommentId) {
    const { rows } = await pool.query<{ trader: string | null }>(`SELECT trader FROM comments WHERE id = $1`, [b.acceptedCommentId]);
    const who = rows[0]?.trader;
    if (who && who !== viewer) {
      const row = { trader: existing.trader, audience: b.audience !== undefined ? (parseAudience(b.audience) as { audience?: string[] }).audience ?? [] : audienceOf(existing.audience) };
      inBackground("discussions.accept", async () => {
        if (!(await filterVisibleNames([who], row)).length) return;
        await notifyUser({
          userName: who, type: "reply", actor: viewer, params: { variant: "accepted", actor: viewer, preview: textPreview(existing.topic, 100) },
          link: threadLink(id), entityType: "thread", entityId: id,
        });
      });
    }
  }
  // The thread was turned into a review request → ask the author's curator (once, on the type change).
  if (b.type === "review_request" && existing.type !== "review_request" && existing.trader && existing.trader === viewer) {
    const author = existing.trader;
    const topic = b.topic ?? existing.topic;
    const ticker = b.ticker !== undefined ? (b.ticker ? b.ticker.toUpperCase() : null) : existing.ticker;
    inBackground("discussions.review_request", () => notifyReviewRequest(author, id, topic, ticker));
  }
  logActivity({ action: b.acceptedCommentId ? "resolved" : "updated", section: "discussions", entityId: String(id), entityTitle: b.topic ?? existing.topic, trader: viewer });
  res.json(await fullThread(id, viewer, av));
}));

router.post("/discussions/:id/restore", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const id = parseId(req, res); if (id == null) return;
  const existing = await loadThread(id, null, await loadAudienceViewer(req), true);
  if (!existing) throw notFound("DISCUSSION_NOT_FOUND");
  if (!(await canModifyDiscussion(req, existing.trader))) throw new AppError("DISCUSSION_AUTHOR_ONLY");
  await pool.query(`UPDATE discussions SET deleted_at = NULL WHERE id = $1`, [id]);
  logActivity({ action: "restored", section: "discussions", entityId: String(id), entityTitle: existing.topic, trader: req.authUser!.name });
  res.json({ success: true });
}));

// ─── Comments ───────────────────────────────────────────────────────────────

const RE_REPLY = /\[re:(\d+)\]/;
/** Comment text without the machine prefixes «[Наблюдаю] [re:12] » — what a person actually wrote (for notification previews). */
const COMMENT_PREFIX = /^(\[(?:Observing|In Position|Exited|Наблюдаю|В позиции|Вышел)\]\s*)?(\[re:\d+\]\s*)?/;
const plainComment = (text: string) => text.replace(COMMENT_PREFIX, "").trim();

router.post("/discussions/:id/comments", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const params = AddCommentParams.safeParse(req.params);
  if (!params.success) throw params.error;
  const parsed = AddCommentBody.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const text = parsed.data.text.trim();
  if (!text) throw new AppError("COMMENT_EMPTY");
  if (text.length > COMMENT_MAX) throw new AppError("TEXT_TOO_LONG", 400, { field: "text", max: COMMENT_MAX });
  const thread = await loadThread(params.data.id, null, await loadAudienceViewer(req));
  if (!thread) throw notFound("DISCUSSION_NOT_FOUND");
  const me = req.authUser!.name;
  if (await isBanned(me)) throw new AppError("BANNED_ACTION");
  const { rows } = await pool.query<CommentRow>(
    `INSERT INTO comments (discussion_id, trader, text) VALUES ($1, $2, $3) RETURNING id, discussion_id, trader, text, created_at`,
    [params.data.id, me, text],
  );
  const comment = rows[0];
  await markRead(me, params.data.id);
  logActivity({ action: "commented", section: "discussions", entityId: String(params.data.id), entityTitle: thread.topic, trader: me });

  // Notifications (in-app only, off the critical path): mentions, the author of the comment being replied to,
  // and the thread author. Each person gets at most one notification; the commenter never gets one.
  // Recipients outside the thread's audience are dropped (the thread author always reads it).
  const threadId = params.data.id;
  const topicShort = textPreview(thread.topic, 60);
  const row = { trader: thread.trader, audience: audienceOf(thread.audience) };
  inBackground("discussions.comment", async () => {
    const link = threadLink(threadId);
    const plain = plainComment(text);
    const mentioned = new Set(await notifyMentions({
      text: plain, authorName: me, where: { kind: "discussion", subject: topicShort }, link, telegram: false,
      filter: (names) => filterVisibleNames(names, row),
    }));
    const preview = textPreview(plain, 120);
    const notified = new Set<string>([me, ...mentioned]);
    const reTo = RE_REPLY.exec(text)?.[1];
    if (reTo) {
      const { rows: parent } = await pool.query<{ trader: string | null }>(`SELECT trader FROM comments WHERE id = $1 AND discussion_id = $2`, [Number(reTo), threadId]);
      const who = parent[0]?.trader;
      if (who && !notified.has(who) && (await filterVisibleNames([who], row)).length) {
        notified.add(who);
        await notifyUser({ userName: who, type: "reply", actor: me, params: { variant: "toYou", actor: me, topic: topicShort, preview }, link, entityType: "thread", entityId: threadId });
      }
    }
    if (thread.trader && !notified.has(thread.trader)) {
      await notifyUser({ userName: thread.trader, type: "reply", actor: me, params: { variant: "inYours", actor: me, topic: topicShort, preview }, link, entityType: "thread", entityId: threadId });
    }
  });
  res.status(201).json({ id: comment.id, discussionId: comment.discussion_id, trader: comment.trader, text: comment.text, createdAt: comment.created_at.toISOString() });
}));

const CommentParams = z.object({ id: z.coerce.number().int().positive(), commentId: z.coerce.number().int().positive() });
const PatchCommentBody = z.object({ text: z.string().min(1) });

router.patch("/discussions/:id/comments/:commentId", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const params = CommentParams.safeParse(req.params);
  if (!params.success) throw params.error;
  const body = PatchCommentBody.safeParse(req.body);
  if (!body.success) throw body.error;
  const text = body.data.text.trim();
  if (!text || text.length > COMMENT_MAX) throw new AppError("INVALID_FIELD", 400, { field: "text" });
  if (!(await loadThread(params.data.id, null, await loadAudienceViewer(req)))) throw notFound("COMMENT_NOT_FOUND");
  const { rows } = await pool.query<CommentRow>(`SELECT id, discussion_id, trader, text, created_at FROM comments WHERE id = $1 AND discussion_id = $2`, [params.data.commentId, params.data.id]);
  const existing = rows[0];
  if (!existing) throw notFound("COMMENT_NOT_FOUND");
  if (!(await canModifyComment(req, existing.trader, "edit"))) throw new AppError("COMMENT_OWN_ONLY");
  const { rows: upd } = await pool.query<CommentRow>(`UPDATE comments SET text = $1 WHERE id = $2 RETURNING id, discussion_id, trader, text, created_at`, [text, params.data.commentId]);
  const c = upd[0];
  res.json({ id: c.id, discussionId: c.discussion_id, trader: c.trader, text: c.text, createdAt: c.created_at.toISOString() });
}));

router.delete("/discussions/:id/comments/:commentId", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const params = CommentParams.safeParse(req.params);
  if (!params.success) throw params.error;
  if (!(await loadThread(params.data.id, null, await loadAudienceViewer(req)))) throw notFound("COMMENT_NOT_FOUND");
  const { rows } = await pool.query<CommentRow>(`SELECT id, discussion_id, trader, text, created_at FROM comments WHERE id = $1 AND discussion_id = $2`, [params.data.commentId, params.data.id]);
  const existing = rows[0];
  if (!existing) throw notFound("COMMENT_NOT_FOUND");
  if (!(await canModifyComment(req, existing.trader, "delete"))) throw new AppError("COMMENT_OWN_ONLY");
  await pool.query(`UPDATE discussions SET accepted_comment_id = NULL WHERE id = $1 AND accepted_comment_id = $2`, [params.data.id, params.data.commentId]);
  await pool.query(`DELETE FROM comments WHERE id = $1`, [params.data.commentId]);
  res.sendStatus(204);
}));

// ─── Votes ──────────────────────────────────────────────────────────────────

router.post("/discussions/:id/vote", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const id = parseId(req, res); if (id == null) return;
  const thread = await loadThread(id, null, await loadAudienceViewer(req));
  if (!thread) throw notFound("DISCUSSION_NOT_FOUND");
  const { value } = req.body as { value?: number };
  // One vote per authenticated user — the client never picks the voter.
  const trader = req.authUser!.name;
  if (value !== 1 && value !== -1 && value !== 0) throw new AppError("INVALID_FIELD", 400, { field: "value" });
  if (await isBanned(trader)) throw new AppError("BANNED_ACTION");
  if (value === 0) {
    await pool.query(`DELETE FROM discussion_votes WHERE discussion_id = $1 AND trader = $2`, [id, trader]);
  } else {
    await pool.query(
      `INSERT INTO discussion_votes (discussion_id, trader, value) VALUES ($1, $2, $3)
       ON CONFLICT (discussion_id, trader) DO UPDATE SET value = EXCLUDED.value, created_at = NOW()`,
      [id, trader, value],
    );
  }
  const { rows } = await pool.query<any>(
    `SELECT COALESCE(SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END), 0)::int AS upvotes,
            COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0)::int AS downvotes,
            COALESCE(SUM(value), 0)::int AS score
       FROM discussion_votes WHERE discussion_id = $1`, [id]);
  res.json({ discussionId: id, ...rows[0], myVote: value === 0 ? null : value });
}));

export default router;
