import { Router, type IRouter, type Request } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { can } from "../lib/permissions";
import { AppError, badRequest, sendErrorWith, unauthorized } from "../lib/http";

/**
 * Day-by-day trading journal (pre-market plan + post-market review).
 *
 *   GET /api/journal/days?trader=&from=YYYY-MM-DD&to=YYYY-MM-DD
 *     Traders: always their own entries (trader param ignored).
 *     Curators/admins: one trader, or everyone when trader is omitted.
 *   GET /api/journal/days/:date   — the caller's own entry for that date (curators: ?trader=), 404 when none.
 *   PUT /api/journal/days/:date   — upsert the caller's own entry for that date.
 *     Optional `updatedAt` (ISO) = the version the client edited; when it differs from the stored row the
 *     write is refused with 409 { error, current } so two tabs never overwrite each other silently.
 *     An entry with every field empty deletes the row (so "has journal" flags clear).
 *   DELETE /api/journal/days/:date — remove the caller's own entry.
 *
 * Table is created lazily (additive, idempotent) on first use.
 */
const router: IRouter = Router();

const COLS = `id, trader, TO_CHAR(day, 'YYYY-MM-DD') AS date, plan, well, mistakes, lessons,
  mood, discipline, followed_plan AS "followedPlan", tags,
  updated_at AS "updatedAt", created_at AS "createdAt"`;

let ensured: Promise<void> | null = null;
/** Shared with routes/eod.ts (EOD close prefills the journal). */
export function ensureJournalTable(): Promise<void> {
  return ensureTable();
}
function ensureTable(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `CREATE TABLE IF NOT EXISTS journal_days (
           id SERIAL PRIMARY KEY,
           trader TEXT NOT NULL,
           day DATE NOT NULL,
           plan TEXT NOT NULL DEFAULT '',
           well TEXT NOT NULL DEFAULT '',
           mistakes TEXT NOT NULL DEFAULT '',
           lessons TEXT NOT NULL DEFAULT '',
           mood SMALLINT,
           discipline SMALLINT,
           followed_plan BOOLEAN,
           tags JSONB NOT NULL DEFAULT '[]'::jsonb,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           UNIQUE (trader, day)
         )`,
      )
      .then(() => undefined)
      .catch((err) => {
        ensured = null;
        throw err;
      });
  }
  return ensured;
}

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + "T00:00:00Z"));
}

/** journal.read.team (permissions matrix, DB role) — may read other traders' journal days. */
function canReadTeam(req: Request, trader?: string | null): Promise<boolean> {
  return can(req, "journal.read.team", trader ? { trader } : undefined);
}

const TEXT_MAX = 10_000;
const TAG_MAX = 40;
const TAGS_MAX = 24;

type Body = {
  plan?: unknown; well?: unknown; mistakes?: unknown; lessons?: unknown;
  mood?: unknown; discipline?: unknown; followedPlan?: unknown; tags?: unknown;
};

function parseBody(b: Body):
  | { ok: true; v: { plan: string; well: string; mistakes: string; lessons: string; mood: number | null; discipline: number | null; followedPlan: boolean | null; tags: string[] } }
  | { ok: false; field: string } {
  const text = (k: keyof Body): string | { error: string } => {
    const raw = b[k];
    if (raw == null) return "";
    if (typeof raw !== "string") return { error: String(k) };
    if (raw.length > TEXT_MAX) return { error: String(k) };
    return raw;
  };
  const scale = (k: "mood" | "discipline"): number | null | { error: string } => {
    const raw = b[k];
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 5) return { error: k };
    return n;
  };
  const plan = text("plan"), well = text("well"), mistakes = text("mistakes"), lessons = text("lessons");
  for (const t of [plan, well, mistakes, lessons]) if (typeof t !== "string") return { ok: false, field: t.error };
  const mood = scale("mood"), discipline = scale("discipline");
  for (const s of [mood, discipline]) if (s && typeof s === "object") return { ok: false, field: s.error };

  let followedPlan: boolean | null = null;
  if (b.followedPlan != null) {
    if (typeof b.followedPlan !== "boolean") return { ok: false, field: "followedPlan" };
    followedPlan = b.followedPlan;
  }

  let tags: string[] = [];
  if (b.tags != null) {
    if (!Array.isArray(b.tags)) return { ok: false, field: "tags" };
    const seen = new Set<string>();
    for (const t of b.tags) {
      if (typeof t !== "string") return { ok: false, field: "tags" };
      const s = t.trim();
      if (!s) continue;
      if (s.length > TAG_MAX) return { ok: false, field: "tags" };
      if (!seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); tags.push(s); }
    }
    if (tags.length > TAGS_MAX) return { ok: false, field: "tags" };
  }

  return {
    ok: true,
    v: {
      plan: plan as string, well: well as string, mistakes: mistakes as string, lessons: lessons as string,
      mood: mood as number | null, discipline: discipline as number | null, followedPlan, tags,
    },
  };
}

router.get("/journal/days", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  const from = req.query["from"];
  const to = req.query["to"];
  if (!isIsoDate(from) || !isIsoDate(to)) throw new AppError("INVALID_RANGE", undefined, { max: 400 });
  if (from > to) throw new AppError("INVALID_RANGE", undefined, { max: 400 });
  const spanDays = (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000;
  if (spanDays > 400) throw new AppError("RANGE_TOO_LONG", undefined, { max: 400 });

  await ensureTable();
  const params: unknown[] = [from, to];
  let sql = `SELECT ${COLS} FROM journal_days WHERE day BETWEEN $1 AND $2`;
  const qTrader = typeof req.query["trader"] === "string" ? (req.query["trader"] as string).trim() : "";
  if (!(await canReadTeam(req, qTrader || null))) {
    sql += ` AND trader = $3`;
    params.push(req.authUser.name);
  } else if (qTrader) {
    sql += ` AND trader = $3`;
    params.push(qTrader);
  }
  sql += ` ORDER BY day ASC, trader ASC`;
  const { rows } = await pool.query(sql, params);
  res.json(rows);
}));

router.get("/journal/days/:date", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  const date = req.params["date"];
  if (!isIsoDate(date)) throw badRequest("INVALID_DATE");
  const qTrader = typeof req.query["trader"] === "string" ? (req.query["trader"] as string).trim() : "";
  const trader = qTrader && (await canReadTeam(req, qTrader)) ? qTrader : req.authUser.name;
  await ensureTable();
  const { rows } = await pool.query(`SELECT ${COLS} FROM journal_days WHERE trader = $1 AND day = $2`, [trader, date]);
  if (!rows[0]) throw new AppError("NOT_FOUND");
  res.json(rows[0]);
}));

type EntryValues = Extract<ReturnType<typeof parseBody>, { ok: true }>["v"];
function isEmptyEntry(e: EntryValues): boolean {
  return !e.plan.trim() && !e.well.trim() && !e.mistakes.trim() && !e.lessons.trim()
    && e.mood == null && e.discipline == null && e.followedPlan == null && e.tags.length === 0;
}

router.delete("/journal/days/:date", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  const date = req.params["date"];
  if (!isIsoDate(date)) throw badRequest("INVALID_DATE");
  await ensureTable();
  await pool.query(`DELETE FROM journal_days WHERE trader = $1 AND day = $2`, [req.authUser.name, date]);
  res.json({ ok: true, trader: req.authUser.name, date });
}));

router.put("/journal/days/:date", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  const date = req.params["date"];
  if (!isIsoDate(date)) throw badRequest("INVALID_DATE");
  const parsed = parseBody((req.body ?? {}) as Body);
  if (!parsed.ok) throw new AppError("INVALID_FIELD", 400, { field: parsed.field });
  const v = parsed.v;

  await ensureTable();
  // Optimistic concurrency: the client sends the `updatedAt` it loaded; a newer row on the server wins.
  const baseRaw = (req.body as { updatedAt?: unknown } | undefined)?.updatedAt;
  if (typeof baseRaw === "string" && baseRaw) {
    const base = Date.parse(baseRaw);
    if (!Number.isFinite(base)) throw new AppError("INVALID_FIELD", undefined, { field: "updatedAt" });
    const { rows: cur } = await pool.query<{ updatedAt: Date } & Record<string, unknown>>(
      `SELECT ${COLS} FROM journal_days WHERE trader = $1 AND day = $2`,
      [req.authUser.name, date],
    );
    if (cur[0] && Math.abs(new Date(cur[0].updatedAt).getTime() - base) > 1000) {
      sendErrorWith(res, new AppError("JOURNAL_CONFLICT"), { current: cur[0] });
      return;
    }
  }
  if (isEmptyEntry(v)) {
    await pool.query(`DELETE FROM journal_days WHERE trader = $1 AND day = $2`, [req.authUser.name, date]);
    res.json({ trader: req.authUser.name, date, plan: "", well: "", mistakes: "", lessons: "", mood: null, discipline: null, followedPlan: null, tags: [], updatedAt: null, deleted: true });
    return;
  }
  // Entries are always written for the caller — nobody edits another trader's journal.
  const { rows } = await pool.query(
    `INSERT INTO journal_days (trader, day, plan, well, mistakes, lessons, mood, discipline, followed_plan, tags, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())
     ON CONFLICT (trader, day) DO UPDATE SET
       plan = EXCLUDED.plan, well = EXCLUDED.well, mistakes = EXCLUDED.mistakes, lessons = EXCLUDED.lessons,
       mood = EXCLUDED.mood, discipline = EXCLUDED.discipline, followed_plan = EXCLUDED.followed_plan,
       tags = EXCLUDED.tags, updated_at = NOW()
     RETURNING ${COLS}`,
    [req.authUser.name, date, v.plan, v.well, v.mistakes, v.lessons, v.mood, v.discipline, v.followedPlan, JSON.stringify(v.tags)],
  );
  res.json(rows[0]);
}));

export default router;
