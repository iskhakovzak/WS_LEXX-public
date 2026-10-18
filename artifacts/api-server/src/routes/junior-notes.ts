import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { asyncHandler } from "../lib/asyncHandler";
import { aiTextLimiter } from "../lib/rateLimits";
import { getEffectiveMatrix, readableTraders, resolveActor } from "../lib/permissions";
import { logger } from "../lib/logger";
import { requireAuth } from "../lib/auth";
import { nyDate } from "../lib/tradingDate";
import { horizonSql, netPnlSql, resultSql, signedRSql } from "../lib/tradeMath";
import { handleAiNotConfigured } from "../lib/aiErrors";
import { canSeeTradeMoney } from "../lib/playbookPrivacy";
import {
  attentionOf, buildDayTrades, buildReviewScope, canReadJuniorNotes, canReviewTrader, juniorTeamFilter, missedRun, repeatedMistakes,
  reviewTraderFilter, scoreTrend, type ContextTradeRow, type JuniorNotesViewer, type ReviewScope,
} from "../lib/juniorReview";
import { AppError, badRequest, notFound, sendError, unauthorized } from "../lib/http";
import { aiAnswerLanguage } from "../i18n/ai";
import { langOf } from "../i18n";

const router: IRouter = Router();
const AI_MODEL = "claude-sonnet-4-6";
const AI_TIMEOUT_MS = 40_000;

// DATE columns are returned as "YYYY-MM-DD" strings: node-pg would otherwise build a
// local-midnight Date that serialises to the previous day in UTC+N server timezones.
const NOTE_COLS = `id, trader, TO_CHAR(note_date, 'YYYY-MM-DD') AS note_date, raw_text, refined_text, mood,
  sections, curator_feedback, curator_score, reviewed_by, reviewed_at, feedback_seen_at,
  created_at, updated_at`;

/* ------------------------------------------------------------------ */
/* Additive schema: structured sections, curator review, reminders.    */
/* Guarded init promise — runs once per process, retried on failure.   */
/* ------------------------------------------------------------------ */
let ensured: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await pool.query(`ALTER TABLE junior_notes ADD COLUMN IF NOT EXISTS sections JSONB`);
      await pool.query(`ALTER TABLE junior_notes ADD COLUMN IF NOT EXISTS curator_feedback TEXT`);
      await pool.query(`ALTER TABLE junior_notes ADD COLUMN IF NOT EXISTS curator_score SMALLINT`);
      await pool.query(`ALTER TABLE junior_notes ADD COLUMN IF NOT EXISTS reviewed_by TEXT`);
      await pool.query(`ALTER TABLE junior_notes ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE junior_notes ADD COLUMN IF NOT EXISTS feedback_seen_at TIMESTAMPTZ`);
      await pool.query(
        `CREATE TABLE IF NOT EXISTS junior_note_reminders (
           id SERIAL PRIMARY KEY,
           trader TEXT NOT NULL,
           note_date DATE NOT NULL,
           curator TEXT NOT NULL,
           message TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           dismissed_at TIMESTAMPTZ,
           UNIQUE (trader, note_date)
         )`,
      );
    })().catch((e) => {
      ensured = null;
      throw e;
    });
  }
  return ensured;
}

const SECTION_KEYS = ["free", "plan", "intraday", "overnight", "swing", "mistakes", "lessons", "focus"] as const;
type SectionKey = (typeof SECTION_KEYS)[number];
type Sections = Partial<Record<SectionKey, string>>;
/** Headings inside the stored flat text (search / AI / older clients) — stored data, kept in Russian. */
const SECTION_TITLES: Record<SectionKey, string> = {
  free: "",
  plan: "План", // i18n-ignore (stored text heading)
  intraday: "Сделки — интрадей", // i18n-ignore (stored text heading)
  overnight: "Сделки — овернайт", // i18n-ignore (stored text heading)
  swing: "Сделки — свинг", // i18n-ignore (stored text heading)
  mistakes: "Ошибки", // i18n-ignore (stored text heading)
  lessons: "Уроки", // i18n-ignore (stored text heading)
  focus: "Фокус на завтра", // i18n-ignore (stored text heading)
};
const MAX_SECTION_LEN = 6000;

/** Validates and normalises the `sections` payload; returns null when absent/invalid. */
function parseSections(v: unknown): Sections | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Sections = {};
  for (const k of SECTION_KEYS) {
    const raw = (v as Record<string, unknown>)[k];
    if (typeof raw === "string" && raw.trim()) out[k] = raw.slice(0, MAX_SECTION_LEN);
  }
  return out;
}

/** Flat text used by search, AI and older clients. The untitled `free` block comes first without a heading. */
function composeSections(s: Sections): string {
  return SECTION_KEYS
    .filter((k) => s[k]?.trim())
    .map((k) => (SECTION_TITLES[k] ? `${SECTION_TITLES[k]}:\n${s[k]!.trim()}` : s[k]!.trim()))
    .join("\n\n");
}

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + "T00:00:00Z"));
}

// Trading day = New York calendar date (audit P0-3), never UTC / the DB session's CURRENT_DATE.
function todayNy(): string {
  return nyDate();
}

function parseLimit(v: unknown, def = 30, max = 100): number {
  const n = Math.floor(Number(v ?? def));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

function cleanMood(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 32) : null;
}

/* ------------------------------------------------------------------ */
/* Reviewer scope (lib/juniorReview.ts).                               */
/* journal.review (desk) → every junior; journal.review (assigned) or  */
/* an academy mentor (trader included) → only their juniors.           */
/* ------------------------------------------------------------------ */
type ReviewCtx = {
  me: string;
  scope: ReviewScope;
  staff: boolean;
  guest: boolean;
  /** journal.read.team readable traders: null = whole desk, string[] = only these (lib/juniorReview canReadJuniorNotes). */
  teamScope: string[] | null;
};

declare global {
  namespace Express {
    interface Request {
      juniorReview?: ReviewCtx | null;
    }
  }
}

/** Live academy mentees of `me`: users.assigned_mentor + enrollments of active cohorts `me` mentors. */
async function menteesOf(me: string): Promise<string[]> {
  const out = new Set<string>();
  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM users WHERE assigned_mentor = $1 AND active = true AND COALESCE(banned, false) = false`,
    [me],
  );
  rows.forEach((r) => out.add(r.name));
  // Academy tables are created lazily by routes/academy-cohorts.ts — absent on a fresh DB.
  const t = await pool.query<{ ok: boolean }>(
    `SELECT to_regclass('academy_cohorts') IS NOT NULL AND to_regclass('academy_enrollments') IS NOT NULL AS ok`,
  );
  if (t.rows[0]?.ok) {
    const { rows: e } = await pool.query<{ name: string }>(
      `SELECT DISTINCT e.user_name AS name
       FROM academy_enrollments e JOIN academy_cohorts c ON c.id = e.cohort_id
       JOIN users u ON u.name = e.user_name AND u.active = true AND COALESCE(u.banned, false) = false
       WHERE c.mentor = $1 AND c.archived_at IS NULL AND e.archived_at IS NULL AND e.status IN ('active','paused')`,
      [me],
    );
    e.forEach((r) => out.add(r.name));
  }
  return [...out];
}

/** Reviewer context of the caller (memoised per request); null = anonymous / inactive. */
async function reviewCtx(req: import("express").Request): Promise<ReviewCtx | null> {
  if (req.juniorReview !== undefined) return req.juniorReview;
  const actor = await resolveActor(req);
  if (!actor) return (req.juniorReview = null);
  if (actor.guest) return (req.juniorReview = { me: actor.name, scope: { kind: "none" }, staff: false, guest: true, teamScope: [] });
  const matrix = await getEffectiveMatrix();
  const cell = matrix[actor.role]?.["journal.review"];
  const [mentees, curated] = await Promise.all([
    menteesOf(actor.name),
    pool.query<{ name: string }>(
      `SELECT name FROM users WHERE assigned_curator = $1 AND active = true AND COALESCE(banned, false) = false`,
      [actor.name],
    ).then((r) => r.rows.map((x) => x.name)),
  ]);
  const scope = buildReviewScope({
    me: actor.name,
    guest: false,
    capAllowed: !!cell?.allowed,
    capScope: cell?.scope ?? null,
    wards: actor.wards,
    mentees,
    curated,
  });
  return (req.juniorReview = {
    me: actor.name,
    scope,
    staff: actor.role === "curator" || actor.role === "admin",
    guest: false,
    teamScope: readableTraders(matrix, actor, "journal.read.team"),
  });
}

const viewerOf = (ctx: ReviewCtx): JuniorNotesViewer => ({ me: ctx.me, guest: ctx.guest, teamScope: ctx.teamScope });

/**
 * Sends 401/403 and returns false unless the caller may read `trader`'s summaries (incl. curator feedback and
 * score): the junior themself, their reviewer (curator / mentor), or journal.read.team covering them.
 */
async function requireNotesReader(
  req: import("express").Request, res: import("express").Response, trader: string,
): Promise<boolean> {
  const ctx = await reviewCtx(req);
  if (!ctx) { sendError(res, unauthorized()); return false; }
  if (!canReadJuniorNotes(viewerOf(ctx), ctx.scope, trader)) {
    sendError(res, new AppError("NOTES_ACCESS"));
    return false;
  }
  return true;
}

/** Sends 401/403 and returns null unless the caller reviews someone. */
async function requireReviewer(
  req: import("express").Request, res: import("express").Response, code: "REVIEWER_ONLY" | "RATE_REVIEWER_ONLY" = "REVIEWER_ONLY",
): Promise<ReviewCtx | null> {
  const ctx = await reviewCtx(req);
  if (!ctx) { sendError(res, unauthorized()); return null; }
  if (ctx.scope.kind === "none") { sendError(res, new AppError(code)); return null; }
  return ctx;
}

const mineOnly = (v: unknown) => v === "mine" || v === "1";

/* Trading-day helpers (Mon–Fri; exchange holidays are not modelled). */
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isWeekend(iso: string): boolean {
  const wd = new Date(iso + "T00:00:00Z").getUTCDay();
  return wd === 0 || wd === 6;
}
function prevTradingDay(iso: string): string {
  let d = addDays(iso, -1);
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}
/** Consecutive trading days with a note, ending at `date` (or the trading day before if `date` has none yet). */
function streakEndingAt(dates: Set<string>, date: string): number {
  let d = date;
  while (isWeekend(d)) d = prevTradingDay(d);
  if (!dates.has(d)) d = prevTradingDay(d);
  let n = 0;
  while (dates.has(d) && n < 400) { n++; d = prevTradingDay(d); }
  return n;
}

router.get("/junior-notes/team", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  await ensureSchema();
  const date = (req.query["date"] as string | undefined) || todayNy();
  if (!isIsoDate(date)) throw badRequest("INVALID_DATE");
  const ctx = await reviewCtx(req);
  if (!ctx) throw unauthorized();
  // Desk reviewers / desk-wide journal.read.team: every junior; mentors & assigned curators: their juniors + own;
  // everyone else: only their own summary. Guests: nothing.
  const filter = juniorTeamFilter(viewerOf(ctx), ctx.scope);
  if (filter && filter.length === 0) { res.json([]); return; }
  const { rows } = await pool.query(
    `SELECT ${NOTE_COLS}
     FROM junior_notes WHERE note_date = $1 AND ($2::text[] IS NULL OR trader = ANY($2::text[])) ORDER BY trader ASC`,
    [date, filter],
  );
  res.json(rows);
}));

/** What the caller may review: drives the senior's UI (tabs, «Мои джуны», review form, money columns). */
router.get("/junior-notes/reviewer", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  const ctx = await reviewCtx(req);
  if (!ctx) throw unauthorized();
  const s = ctx.scope;
  res.json({
    kind: s.kind,
    via: s.kind === "scoped" ? s.via : s.kind === "desk" ? "desk" : null,
    traders: s.kind === "scoped" ? s.traders : null,
    mine: s.kind === "none" ? [] : s.mine,
    money: ctx.staff,
  });
}));

/**
 * Senior desk overview for one day: every junior in the reviewer's scope — whether they wrote, streak, missed run,
 * review state, score trend, repeated mistakes, attention flags (sorted client-side by `priority`) and reminder.
 * `?scope=mine` narrows a desk reviewer to their own juniors (assigned curator / mentor).
 */
router.get("/junior-notes/overview", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  await ensureSchema();
  const ctx = await requireReviewer(req, res);
  if (!ctx) return;
  const date = (req.query["date"] as string | undefined) || todayNy();
  const lang = langOf(req);
  if (!isIsoDate(date)) throw badRequest("INVALID_DATE");
  const filter = reviewTraderFilter(ctx.scope, mineOnly(req.query["scope"]));
  const from = addDays(date, -90);

  const [usersRes, notesRes, remindersRes] = await Promise.all([
    pool.query<{ name: string }>(
      `SELECT name FROM users WHERE role = 'trader' AND active = true AND COALESCE(banned, false) = false ORDER BY name`,
    ),
    pool.query<{
      id: number; trader: string; note_date: string; mood: string | null; raw_text: string; mistakes: string | null;
      has_sections: boolean; curator_score: number | null; reviewed_at: string | null; reviewed_by: string | null; updated_at: string;
    }>(
      `SELECT id, trader, TO_CHAR(note_date, 'YYYY-MM-DD') AS note_date, mood, raw_text,
              sections->>'mistakes' AS mistakes, (sections IS NOT NULL) AS has_sections,
              curator_score, reviewed_at, reviewed_by, updated_at
       FROM junior_notes
       WHERE note_date BETWEEN $1 AND $2 AND LENGTH(TRIM(raw_text)) > 0
         AND ($3::text[] IS NULL OR trader = ANY($3::text[]))
       ORDER BY note_date DESC`,
      [from, date, filter],
    ),
    pool.query<{ id: number; trader: string; curator: string; created_at: string; dismissed_at: string | null }>(
      `SELECT id, trader, curator, created_at, dismissed_at FROM junior_note_reminders WHERE note_date = $1`,
      [date],
    ),
  ]);

  const byTrader = new Map<string, typeof notesRes.rows>();
  for (const n of notesRes.rows) {
    const list = byTrader.get(n.trader) ?? [];
    list.push(n);
    byTrader.set(n.trader, list);
  }
  // Desk (all): active traders + anyone who wrote that day. Scoped / «мои»: exactly that list.
  const names = new Set(filter ?? usersRes.rows.map((u) => u.name));
  if (!filter) for (const n of notesRes.rows) if (n.note_date === date) names.add(n.trader);
  names.delete(ctx.me);
  const reminders = new Map(remindersRes.rows.map((r) => [r.trader, r]));
  const mine = new Set(ctx.scope.kind === "none" ? [] : ctx.scope.mine);

  const rows = [...names].sort((a, b) => a.localeCompare(b, "ru")).map((trader) => {
    const notes = byTrader.get(trader) ?? [];
    const dates = new Set(notes.map((n) => n.note_date));
    const today = notes.find((n) => n.note_date === date) ?? null;
    const last14 = addDays(date, -14);
    const scores = notes.filter((n) => n.curator_score != null).map((n) => n.curator_score!);
    const r = reminders.get(trader);
    const trend = scoreTrend(notes, 10);
    // «Ошибки» of structured notes; legacy free-form notes are scanned whole.
    const repeated = repeatedMistakes(
      notes.slice(0, 20).map((n) => ({ note_date: n.note_date, text: n.has_sections ? n.mistakes : n.raw_text })),
      { lang },
    );
    const unreviewed14 = notes.filter((n) => n.note_date > last14 && !n.reviewed_at).length;
    const missed = missedRun(dates, date, 10);
    const attention = attentionOf({
      wrote: !!today,
      reviewed: !!today?.reviewed_at,
      unreviewed14,
      missed,
      everWrote: notes.length > 0,
      trend,
      repeated,
    }, lang);
    return {
      trader,
      mine: mine.has(trader),
      note: today && {
        id: today.id,
        mood: today.mood,
        words: today.raw_text.trim().split(/\s+/).filter(Boolean).length,
        preview: today.raw_text.trim().slice(0, 180),
        curator_score: today.curator_score,
        reviewed_at: today.reviewed_at,
        reviewed_by: today.reviewed_by,
        updated_at: today.updated_at,
      },
      streak: streakEndingAt(dates, date),
      missed_run: missed,
      last_note_date: notes[0]?.note_date ?? null,
      notes_30d: notes.filter((n) => n.note_date > addDays(date, -30)).length,
      unreviewed_14d: unreviewed14,
      avg_score: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
      trend,
      repeated,
      attention: attention.flags,
      priority: attention.priority,
      reminder: r && !r.dismissed_at ? { id: r.id, curator: r.curator, created_at: r.created_at } : null,
    };
  });
  res.json({ date, scope: mineOnly(req.query["scope"]) && ctx.scope.kind === "desk" ? "mine" : "all", rows });
}));

/** Review queue: written notes without an answer over the last N days, oldest first (reviewer's scope). */
router.get("/junior-notes/queue", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  await ensureSchema();
  const ctx = await requireReviewer(req, res);
  if (!ctx) return;
  const days = parseLimit(req.query["days"], 14, 60);
  const filter = reviewTraderFilter(ctx.scope, mineOnly(req.query["scope"]));
  const { rows } = await pool.query(
    `SELECT ${NOTE_COLS}
     FROM junior_notes
     WHERE reviewed_at IS NULL AND LENGTH(TRIM(raw_text)) > 0
       AND note_date >= $3::date - $1::int AND trader <> $2
       AND ($4::text[] IS NULL OR trader = ANY($4::text[]))
     ORDER BY note_date ASC, trader ASC
     LIMIT 100`,
    [days, ctx.me, todayNy(), filter],
  );
  res.json(rows);
}));

/**
 * Everything a reviewer needs next to one note: the junior's trades that day (R always; $ only for staff / the
 * owner — lib/playbookPrivacy), the previous summary's «Фокус на завтра» + mistakes (follow-through check),
 * recent answers, score trend and repeated mistakes. Owner or a reviewer of that junior only.
 */
router.get("/junior-notes/:id/context", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  await ensureSchema();
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const ctx = await reviewCtx(req);
  if (!ctx) throw unauthorized();
  const { rows: noteRows } = await pool.query<{ trader: string; note_date: string }>(
    `SELECT trader, TO_CHAR(note_date, 'YYYY-MM-DD') AS note_date FROM junior_notes WHERE id = $1`,
    [id],
  );
  const note = noteRows[0];
  if (!note) throw notFound();
  if (ctx.guest || (note.trader !== ctx.me && !canReviewTrader(ctx.scope, note.trader, ctx.me))) {
    sendError(res, new AppError("NOTES_ACCESS"));
    return;
  }
  const { trader, note_date: date } = note;

  const [tradesRes, historyRes] = await Promise.all([
    pool.query<ContextTradeRow>(
      `SELECT t.id, t.trader, t.ticker, t.side, t.setup, ${horizonSql("t")} AS horizon, ${resultSql("t")} AS result,
              LEFT(t.date::text, 10) AS date, NULLIF(LEFT(COALESCE(t.exit_date::text, ''), 10), '') AS exit_date,
              ROUND((${signedRSql("t")})::numeric, 2)::float8 AS r,
              ROUND((${netPnlSql("t")})::numeric, 2)::float8 AS pnl_net
       FROM trades t
       WHERE t.trader = $1 AND t.deleted_at IS NULL
         AND LEFT(t.date::text, 10) BETWEEN $3 AND $2
         AND (LEFT(t.date::text, 10) = $2 OR ${horizonSql("t")} <> 'intraday')
       ORDER BY t.date, t.created_at
       LIMIT 200`,
      [trader, date, addDays(date, -45)],
    ),
    pool.query<{
      id: number; note_date: string; sections: Record<string, unknown> | null; raw_text: string;
      curator_feedback: string | null; curator_score: number | null; reviewed_by: string | null; reviewed_at: string | null;
    }>(
      `SELECT id, TO_CHAR(note_date, 'YYYY-MM-DD') AS note_date, sections, raw_text,
              curator_feedback, curator_score, reviewed_by, reviewed_at
       FROM junior_notes
       WHERE trader = $1 AND note_date <= $2 AND LENGTH(TRIM(raw_text)) > 0
       ORDER BY note_date DESC
       LIMIT 30`,
      [trader, date],
    ),
  ]);

  const day = buildDayTrades(tradesRes.rows, date, trader, { name: ctx.me, staff: ctx.staff }, canSeeTradeMoney);
  const hist = historyRes.rows;
  const before = hist.filter((n) => n.note_date < date);
  const prev = before[0] ?? null;
  const sec = (n: (typeof hist)[number] | null, k: string): string | null => {
    const v = n?.sections && typeof n.sections === "object" ? n.sections[k] : null;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  res.json({
    note_id: id,
    trader,
    date,
    trades: day,
    prev: prev && {
      id: prev.id,
      note_date: prev.note_date,
      focus: sec(prev, "focus"),
      mistakes: sec(prev, "mistakes"),
      lessons: sec(prev, "lessons"),
      curator_feedback: prev.curator_feedback,
      curator_score: prev.curator_score,
      reviewed_by: prev.reviewed_by,
    },
    recent_feedback: before
      .filter((n) => n.reviewed_at)
      .slice(0, 3)
      .map((n) => ({ note_date: n.note_date, score: n.curator_score, feedback: n.curator_feedback, reviewed_by: n.reviewed_by })),
    trend: scoreTrend(hist, 10),
    repeated: repeatedMistakes(
      hist.slice(0, 20).map((n) => ({ note_date: n.note_date, text: n.sections ? sec(n, "mistakes") : n.raw_text })),
      { lang: langOf(req) },
    ),
    streak: streakEndingAt(new Set(hist.map((n) => n.note_date)), date),
  });
}));

router.get("/junior-notes/history", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  await ensureSchema();
  const trader = (req.query["trader"] as string | undefined) || req.authUser?.name;
  const limit = parseLimit(req.query["limit"], 30, 400);
  const q = typeof req.query["q"] === "string" ? req.query["q"].trim().slice(0, 100) : "";
  if (!trader) throw badRequest("TRADER_REQUIRED");
  if (!(await requireNotesReader(req, res, trader))) return;
  const params: unknown[] = [trader, limit];
  let where = `trader = $1`;
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`);
    where += ` AND (raw_text ILIKE $3 OR COALESCE(curator_feedback, '') ILIKE $3)`;
  }
  const { rows } = await pool.query(
    `SELECT ${NOTE_COLS}
     FROM junior_notes WHERE ${where} ORDER BY note_date DESC LIMIT $2`,
    params,
  );
  res.json(rows);
}));

/** In-app reminders addressed to the current user that are still open (no note written yet). */
router.get("/junior-notes/reminders/me", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  await ensureSchema();
  const me = req.authUser!.name;
  const { rows } = await pool.query(
    `SELECT r.id, r.trader, TO_CHAR(r.note_date, 'YYYY-MM-DD') AS note_date, r.curator, r.message, r.created_at
     FROM junior_note_reminders r
     WHERE r.trader = $1 AND r.dismissed_at IS NULL AND r.note_date >= $2::date - 14
       AND NOT EXISTS (
         SELECT 1 FROM junior_notes n
         WHERE n.trader = r.trader AND n.note_date = r.note_date AND LENGTH(TRIM(n.raw_text)) > 0
       )
     ORDER BY r.note_date DESC`,
    [me, todayNy()],
  );
  res.json(rows);
}));

router.get("/junior-notes", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  await ensureSchema();
  const trader = (req.query["trader"] as string | undefined) || req.authUser?.name;
  const date = (req.query["date"] as string | undefined) || todayNy();
  if (!trader) throw badRequest("TRADER_REQUIRED");
  if (!isIsoDate(date)) throw badRequest("INVALID_DATE");
  if (!(await requireNotesReader(req, res, trader))) return;
  const { rows } = await pool.query(
    `SELECT ${NOTE_COLS}
     FROM junior_notes WHERE trader = $1 AND note_date = $2 LIMIT 1`,
    [trader, date],
  );
  res.json(rows[0] ?? null);
}));

router.put("/junior-notes", asyncHandler(async (req, res): Promise<void> => {
  await ensureSchema();
  const trader = req.authUser!.name;
  const { raw_text, note_date, mood } = req.body as { raw_text?: string; note_date?: string; mood?: string };
  const sections = parseSections((req.body as { sections?: unknown }).sections);
  const date = note_date || todayNy();
  if (!isIsoDate(date)) throw badRequest("INVALID_DATE");
  if (date > addDays(todayNy(), 1)) throw new AppError("DAY_IN_FUTURE");
  const text = sections ? composeSections(sections) : (typeof raw_text === "string" ? raw_text : "").trim().slice(0, 40_000);
  const { rows } = await pool.query(
    `INSERT INTO junior_notes (trader, note_date, raw_text, mood, sections, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (trader, note_date) DO UPDATE
       SET raw_text = EXCLUDED.raw_text,
           mood = EXCLUDED.mood,
           sections = EXCLUDED.sections,
           updated_at = NOW()
     RETURNING ${NOTE_COLS}`,
    [trader, date, text, cleanMood(mood), sections ? JSON.stringify(sections) : null],
  );
  res.json(rows[0]);
}));

router.patch("/junior-notes/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureSchema();
  const trader = req.authUser!.name;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const { raw_text, mood } = req.body as { raw_text?: string; mood?: string };
  const sections = parseSections((req.body as { sections?: unknown }).sections);
  const text = sections ? composeSections(sections) : (typeof raw_text === "string" ? raw_text.slice(0, 40_000) : null);
  const { rows } = await pool.query(
    `UPDATE junior_notes
     SET raw_text = COALESCE($1, raw_text),
         mood = $2,
         sections = CASE WHEN $5::boolean THEN $6::jsonb ELSE sections END,
         refined_text = NULL,
         updated_at = NOW()
     WHERE id = $3 AND trader = $4
     RETURNING ${NOTE_COLS}`,
    [text, cleanMood(mood), id, trader, !!sections, sections ? JSON.stringify(sections) : null],
  );
  if (!rows[0]) throw notFound();
  res.json(rows[0]);
}));

/**
 * Review: written feedback + 1–5 score. Empty feedback and no score clears the review.
 * Curators/admins review anyone; a mentor (trader included) only their own mentees; nobody their own note.
 */
router.post("/junior-notes/:id/review", asyncHandler(async (req, res): Promise<void> => {
  await ensureSchema();
  const ctx = await requireReviewer(req, res, "RATE_REVIEWER_ONLY");
  if (!ctx) return;
  const curator = ctx.me;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const owner = await pool.query<{ trader: string }>(`SELECT trader FROM junior_notes WHERE id = $1`, [id]);
  if (!owner.rows[0]) throw notFound();
  if (!canReviewTrader(ctx.scope, owner.rows[0].trader, ctx.me)) {
    sendError(res, new AppError("OWN_JUNIORS_ONLY"));
    return;
  }
  const body = req.body as { feedback?: unknown; score?: unknown };
  const feedback = typeof body.feedback === "string" ? body.feedback.trim().slice(0, 4000) : "";
  let score: number | null = null;
  if (body.score != null && body.score !== "") {
    const n = Number(body.score);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new AppError("INVALID_FIELD", undefined, { field: "score" });
    score = n;
  }
  const clear = !feedback && score == null;
  const { rows } = await pool.query(
    `UPDATE junior_notes
     SET curator_feedback = $1,
         curator_score = $2,
         reviewed_by = CASE WHEN $4::boolean THEN NULL ELSE $3 END,
         reviewed_at = CASE WHEN $4::boolean THEN NULL ELSE NOW() END,
         feedback_seen_at = NULL
     WHERE id = $5
     RETURNING ${NOTE_COLS}`,
    [feedback || null, score, curator, clear, id],
  );
  if (!rows[0]) throw notFound();
  res.json(rows[0]);
}));

/** Owner marks curator feedback as read (clears the unread marker). */
router.post("/junior-notes/:id/seen", asyncHandler(async (req, res): Promise<void> => {
  await ensureSchema();
  const trader = req.authUser!.name;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const { rows } = await pool.query(
    `UPDATE junior_notes SET feedback_seen_at = NOW()
     WHERE id = $1 AND trader = $2 AND reviewed_at IS NOT NULL
     RETURNING ${NOTE_COLS}`,
    [id, trader],
  );
  if (!rows[0]) throw notFound();
  res.json(rows[0]);
}));

/** Reviewer → junior in-app reminder for a missing summary (no external sends). Mentors: own mentees only. */
router.post("/junior-notes/reminders", asyncHandler(async (req, res): Promise<void> => {
  await ensureSchema();
  const ctx = await requireReviewer(req, res);
  if (!ctx) return;
  const curator = ctx.me;
  const body = req.body as { trader?: unknown; date?: unknown; message?: unknown };
  const trader = typeof body.trader === "string" ? body.trader.trim() : "";
  const date = isIsoDate(body.date) ? body.date : todayNy();
  const message = typeof body.message === "string" && body.message.trim() ? body.message.trim().slice(0, 300) : null;
  if (!trader) throw badRequest("TRADER_REQUIRED");
  if (!canReviewTrader(ctx.scope, trader, ctx.me)) {
    sendError(res, new AppError("OWN_JUNIORS_ONLY"));
    return;
  }
  const exists = await pool.query(`SELECT 1 FROM users WHERE name = $1 AND active = true LIMIT 1`, [trader]);
  if (!exists.rows.length) throw notFound("TRADER_NOT_FOUND");
  const { rows } = await pool.query(
    `INSERT INTO junior_note_reminders (trader, note_date, curator, message)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (trader, note_date) DO UPDATE
       SET curator = EXCLUDED.curator, message = EXCLUDED.message, created_at = NOW(), dismissed_at = NULL
     RETURNING id, trader, TO_CHAR(note_date, 'YYYY-MM-DD') AS note_date, curator, message, created_at`,
    [trader, date, curator, message],
  );
  res.json(rows[0]);
}));

router.post("/junior-notes/reminders/:id/dismiss", asyncHandler(async (req, res): Promise<void> => {
  await ensureSchema();
  const me = req.authUser!.name;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const { rowCount } = await pool.query(
    `UPDATE junior_note_reminders SET dismissed_at = NOW() WHERE id = $1 AND trader = $2`,
    [id, me],
  );
  if (!rowCount) throw notFound();
  res.json({ ok: true });
}));

router.delete("/junior-notes/:id", asyncHandler(async (req, res): Promise<void> => {
  const trader = req.authUser!.name;
  const id = Number(req.params["id"]);
  if (isNaN(id)) throw badRequest("INVALID_ID");
  const { rowCount } = await pool.query(
    `DELETE FROM junior_notes WHERE id = $1 AND trader = $2`,
    [id, trader],
  );
  if (!rowCount) throw notFound();
  res.json({ ok: true });
}));

router.post("/junior-notes/improve", aiTextLimiter, asyncHandler(async (req, res): Promise<void> => {
  const trader = req.authUser!.name;
  const { text, note_id, note_date } = req.body as { text: string; note_id?: number; note_date?: string };
  if (!text?.trim()) throw new AppError("COMMENT_EMPTY");

  const date = isIsoDate(note_date) ? note_date : todayNy();
  const tradesRes = await pool.query(
    `SELECT t.ticker, t.result, ROUND(${netPnlSql("t")}, 2) AS pnl_net, ROUND(${signedRSql("t")}, 2) AS r_signed, t.setup
     FROM trades t WHERE t.trader = $1 AND t.date = $2 AND t.deleted_at IS NULL ORDER BY t.created_at LIMIT 10`,
    [trader, date],
  );
  const tradesContext = tradesRes.rows.length > 0 // i18n-ignore (AI prompt context)
    ? `\nТрейды ${trader} за ${date}:\n${tradesRes.rows.map((t: any) => // i18n-ignore (AI prompt context)
        `- ${t.ticker}: ${t.result}${t.pnl_net != null ? ` | PnL нетто: $${t.pnl_net}` : ""}${t.r_signed != null ? ` | R: ${t.r_signed}` : ""}${t.setup ? ` | Сетап: ${t.setup}` : ""}`
      ).join("\n")}`
    : "";

  // i18n-ignore-next (AI prompt — model input; the answer language follows the reader)
  const prompt = `Ты — ментор для начинающих трейдеров. Трейдер ${trader} написал сводку о своём торговом дне. Твоя задача — помочь структурировать мысли, задать направляющие вопросы и поддержать обучение.
${tradesContext}

Оригинальная запись:
"""
${text.slice(0, 3000)}
"""

Улучши и структурируй текст. Используй только те разделы, о которых пишет трейдер:

**📊 Что наблюдал сегодня** — рыночные ситуации, которые заметил

**✅ Что получилось** — правильные действия и решения

**❌ Что можно улучшить** — ошибки и зоны роста

**❓ Вопросы на разбор** — что непонятно, что хочешь разобрать с куратором

**🎯 Фокус на завтра** — конкретный фокус

Пиши кратко, по-деловому, от первого лица. Сохраняй тикеры и цифры из оригинала.
${aiAnswerLanguage(langOf(req))}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  try {
    const msg = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }, { signal: ctrl.signal as AbortSignal });
    clearTimeout(t);
    const refined = msg.content[0]?.type === "text" ? msg.content[0].text : "";
    if (note_id) {
      await pool.query(
        `UPDATE junior_notes SET refined_text = $1, updated_at = NOW() WHERE id = $2 AND trader = $3`,
        [refined, note_id, trader],
      );
    }
    res.json({ refined_text: refined });
  } catch (e: any) {
    clearTimeout(t);
    if (handleAiNotConfigured(e, res)) return;
    logger.warn({ error: e.message, trader }, "junior-notes improve failed");
    sendError(res, new AppError("AI_UNAVAILABLE"));
  }
}));

router.post("/junior-notes/team-summary", asyncHandler(async (req, res): Promise<void> => {
  const ctx = await requireReviewer(req, res);
  if (!ctx) return;
  const raw = (req.body as { note_ids?: unknown }).note_ids;
  const note_ids = Array.isArray(raw) ? raw.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 100) : [];
  if (note_ids.length === 0) throw new AppError("SELECT_AT_LEAST_ONE");
  const { rows } = await pool.query(
    `SELECT trader, TO_CHAR(note_date, 'YYYY-MM-DD') AS note_date, raw_text, refined_text, mood
     FROM junior_notes WHERE id = ANY($1) ORDER BY trader, note_date`,
    [note_ids],
  );
  // Mentors summarise only their own mentees' notes.
  const scoped = rows.filter((n: { trader: string }) => ctx.scope.kind === "desk" || canReviewTrader(ctx.scope, n.trader, ctx.me));
  if (scoped.length === 0) throw new AppError("NOT_FOUND", 400);

  const notesText = scoped.map((n: any) => // i18n-ignore (AI prompt context)
    `### ${n.trader} (${n.note_date}${n.mood ? `, настроение: ${n.mood}` : ""})\n${n.refined_text || n.raw_text}`
  ).join("\n\n");

  // i18n-ignore-next (AI prompt — model input)
  const prompt = `Ты — куратор начинающих трейдеров. Создай общую сводку по записям джунов за день.

ЗАПИСИ ДЖУНОВ:
${notesText.slice(0, 8000)}

Создай структурированную кураторскую сводку:

**📊 Общий прогресс группы** — как джуны провели день, общая динамика

**✅ Что хорошо получается** — повторяющиеся успехи и правильные паттерны у нескольких трейдеров

**❌ Общие ошибки** — что стоит разобрать с группой

**❓ Вопросы для разбора** — вопросы и непонятные ситуации от джунов, которые нужно объяснить

**📋 Рекомендации куратора** — конкретные задачи и фокусы на следующий день для группы

Пиши конкретно, ссылайся на реальные примеры. Не придумывай ничего, чего нет в записях.
${aiAnswerLanguage(langOf(req))}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  try {
    const msg = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }, { signal: ctrl.signal as AbortSignal });
    clearTimeout(t);
    const summary = msg.content[0]?.type === "text" ? msg.content[0].text : "";
    res.json({ summary });
  } catch (e: any) {
    clearTimeout(t);
    if (handleAiNotConfigured(e, res)) return;
    logger.warn({ error: e.message }, "junior-notes team-summary failed");
    sendError(res, new AppError("AI_UNAVAILABLE"));
  }
}));

export default router;
