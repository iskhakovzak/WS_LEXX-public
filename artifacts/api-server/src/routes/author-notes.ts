import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { asyncHandler } from "../lib/asyncHandler";
import { aiTextLimiter } from "../lib/rateLimits";
import { can } from "../lib/permissions";
import { logger } from "../lib/logger";
import { requireAuth } from "../lib/auth";
import { nyDate } from "../lib/tradingDate";
import { netPnl, netPnlSql, signedR, signedRSql } from "../lib/tradeMath";
import { handleAiNotConfigured } from "../lib/aiErrors";
import { loadMoneyViewer } from "../lib/playbookAccess";
import {
  buildAudience, daySnapshot, groupTradesByDay, isAudienceStage,
  type AudienceMemberInput, type AudienceStage, type SnapshotTrade,
} from "../lib/authorNotesLogic";
import { AppError, badRequest, forbidden, notFound, sendError } from "../lib/http";
import { aiAnswerLanguage } from "../i18n/ai";
import { langOf } from "../i18n";

const router: IRouter = Router();
const AI_MODEL = "claude-sonnet-4-6";
const AI_TIMEOUT_MS = 40_000;

// DATE columns are returned as "YYYY-MM-DD" strings: node-pg would otherwise build a
// local-midnight Date that serialises to the previous day in UTC+N server timezones.
const WEEKLY_COLS = `id, trader, TO_CHAR(week_start, 'YYYY-MM-DD') AS week_start, TO_CHAR(week_end, 'YYYY-MM-DD') AS week_end, summary, quote_of_week, created_at`;
const NOTE_COLS = `id, trader, TO_CHAR(note_date, 'YYYY-MM-DD') AS note_date, raw_text, refined_text, mood, created_at, updated_at`;

const NOTE_COLS_N = `n.id, n.trader, TO_CHAR(n.note_date, 'YYYY-MM-DD') AS note_date, n.raw_text, n.refined_text, n.mood, n.created_at, n.updated_at`;

// Read receipts for the team feed ("прочитано"). Additive table, created lazily (same pattern as journal.ts).
let readsEnsured: Promise<void> | null = null;
function ensureReadsTable(): Promise<void> {
  if (!readsEnsured) {
    readsEnsured = pool
      .query(
        `CREATE TABLE IF NOT EXISTS author_note_reads (
           note_id INTEGER NOT NULL REFERENCES author_notes(id) ON DELETE CASCADE,
           reader TEXT NOT NULL,
           read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           PRIMARY KEY (note_id, reader)
         )`,
      )
      .then(() => undefined)
      .catch((err) => {
        readsEnsured = null;
        throw err;
      });
  }
  return readsEnsured;
}

// Looking at another author's day context / read receipts = journal.read.team (permissions matrix, DB role).

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: string | null }>(`SELECT to_regclass($1)::text AS ok`, [name]);
  return !!rows[0]?.ok;
}

/**
 * Academy stage per member, same precedence as routes/academy-path.ts loadStageInfo (not exported there):
 * academy_trader_stage → active academy_enrollments → trader_risk_limits.tier. Every source is optional.
 */
async function loadStages(names: string[]): Promise<Map<string, AudienceStage>> {
  const out = new Map<string, AudienceStage>();
  if (!names.length) return out;
  const fill = (rows: { name: unknown; stage: unknown }[]) => {
    for (const r of rows) {
      const n = String(r.name);
      if (!out.has(n) && isAudienceStage(r.stage)) out.set(n, r.stage);
    }
  };
  const sources: [string, string][] = [
    ["academy_trader_stage", `SELECT user_name AS name, stage FROM academy_trader_stage WHERE user_name = ANY($1::text[])`],
    ["academy_enrollments", `SELECT DISTINCT ON (user_name) user_name AS name, stage FROM academy_enrollments
                              WHERE archived_at IS NULL AND COALESCE(status, 'active') IN ('active','paused') AND user_name = ANY($1::text[])
                              ORDER BY user_name, joined_on DESC NULLS LAST, id DESC`],
    ["trader_risk_limits", `SELECT trader AS name, tier AS stage FROM trader_risk_limits WHERE trader = ANY($1::text[])`],
  ];
  for (const [table, sql] of sources) {
    try {
      if (!(await tableExists(table))) continue;
      fill((await pool.query(sql, [names])).rows);
    } catch (err) {
      logger.warn({ err, table }, "author-notes: stage source read failed");
    }
  }
  return out;
}

function addDaysIso(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0]!;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + "T00:00:00Z"));
}

// Trading day = New York calendar date (audit P0-2): after 20:00 ET the UTC date is already "tomorrow".
function todayNy(): string {
  return nyDate();
}

function parseLimit(v: unknown, def = 30, max = 100): number {
  const n = Math.floor(Number(v ?? def));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().split("T")[0]!;
}

function getWeekEnd(weekStart: string): string {
  const d = new Date(weekStart + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().split("T")[0]!;
}

router.get("/author-notes/team", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  const date = (req.query["date"] as string | undefined) || todayNy();
  if (!isIsoDate(date)) throw badRequest("INVALID_DATE");
  const { rows } = await pool.query(
    `SELECT ${NOTE_COLS}
     FROM author_notes WHERE note_date = $1 ORDER BY trader ASC`,
    [date],
  );
  res.json(rows);
}));

router.get("/author-notes", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  const trader = (req.query["trader"] as string | undefined) || req.authUser?.name;
  const date = (req.query["date"] as string | undefined) || todayNy();
  if (!trader) throw badRequest("TRADER_REQUIRED");
  if (!isIsoDate(date)) throw badRequest("INVALID_DATE");
  const { rows } = await pool.query(
    `SELECT ${NOTE_COLS}
     FROM author_notes WHERE trader = $1 AND note_date = $2 LIMIT 1`,
    [trader, date],
  );
  res.json(rows[0] ?? null);
}));

router.get("/author-notes/history", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  const trader = (req.query["trader"] as string | undefined) || req.authUser?.name;
  const limit = parseLimit(req.query["limit"], 30, 366);
  if (!trader) throw badRequest("TRADER_REQUIRED");
  const { rows } = await pool.query(
    `SELECT ${NOTE_COLS}
     FROM author_notes WHERE trader = $1 ORDER BY note_date DESC LIMIT $2`,
    [trader, limit],
  );
  res.json(rows);
}));

router.get("/author-notes/weekly-summary", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  const trader = (req.query["trader"] as string | undefined) || req.authUser?.name;
  const weekStart = (req.query["week_start"] as string | undefined) || getWeekStart(todayNy());
  if (!trader) throw badRequest("TRADER_REQUIRED");
  if (!isIsoDate(weekStart)) throw badRequest("INVALID_DATE");
  const { rows } = await pool.query(
    `SELECT ${WEEKLY_COLS}
     FROM author_weekly_summaries WHERE trader = $1 AND week_start = $2 LIMIT 1`,
    [trader, weekStart],
  );
  res.json(rows[0] ?? null);
}));

// Team feed: everyone's notes for a date range, with read receipts. Read-only for the viewer.
router.get("/author-notes/feed", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  const me = req.authUser!.name;
  const to = (req.query["to"] as string | undefined) || todayNy();
  const from = (req.query["from"] as string | undefined) || addDaysIso(to, -6);
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) throw new AppError("INVALID_RANGE", undefined, { max: 92 });
  if (Date.parse(to) - Date.parse(from) > 92 * 86_400_000) throw new AppError("RANGE_TOO_LONG", undefined, { max: 92 });
  const rawTrader = req.query["trader"];
  const trader = typeof rawTrader === "string" && rawTrader.trim() ? rawTrader.trim() : null;
  await ensureReadsTable();
  const params: unknown[] = [from, to];
  let traderSql = "";
  if (trader) { params.push(trader); traderSql = ` AND n.trader = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT ${NOTE_COLS_N},
            COALESCE(json_agg(json_build_object('reader', r.reader, 'read_at', r.read_at) ORDER BY r.read_at)
                     FILTER (WHERE r.reader IS NOT NULL), '[]'::json) AS reads
     FROM author_notes n
     LEFT JOIN author_note_reads r ON r.note_id = n.id
     WHERE n.note_date >= $1 AND n.note_date <= $2${traderSql}
       AND (btrim(n.raw_text) <> '' OR n.refined_text IS NOT NULL)
     GROUP BY n.id
     ORDER BY n.note_date DESC, n.trader ASC
     LIMIT 300`,
    params,
  );
  // The author's trading day per note (counts / W-L / Σ R / tickers) so readers see what the lesson is about.
  // $ only for the owner or staff (lib/playbookPrivacy) — a junior reading a senior's note gets R, never money.
  // Guests (no name) get no snapshot at all.
  const viewer = await loadMoneyViewer(req);
  const authors = Array.from(new Set(rows.map((r: { trader: string }) => r.trader)));
  let byDay = new Map<string, SnapshotTrade[]>();
  if (authors.length && viewer.name) {
    try {
      const { rows: trades } = await pool.query(
        `SELECT trader, date, ticker, side, result, pnl, fees, r_multiple, entry, exit, stop, risk_usd
         FROM trades
         WHERE trader = ANY($1::text[]) AND date >= $2 AND date <= $3 AND deleted_at IS NULL
         ORDER BY date ASC, created_at ASC
         LIMIT 5000`,
        [authors, from, to],
      );
      byDay = groupTradesByDay(trades);
    } catch (err) {
      logger.warn({ err }, "author-notes feed: day snapshot failed");
    }
  }
  res.json(rows.map((r: { trader: string; note_date: string; reads: { reader: string }[] }) => ({
    ...r,
    read_by_me: r.trader === me || r.reads.some(x => x.reader === me),
    day: daySnapshot(byDay.get(`${r.trader}|${r.note_date}`) ?? [], viewer, r.trader),
  })));
}));

// Day context for the editor: the author's trades on that date + positions still held (overnight / swing).
router.get("/author-notes/day-context", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  const auth = req.authUser!;
  const date = (req.query["date"] as string | undefined) || todayNy();
  if (!isIsoDate(date)) throw badRequest("INVALID_DATE");
  const rawTrader = req.query["trader"];
  const qTrader = typeof rawTrader === "string" ? rawTrader.trim() : "";
  // Traders only see their own book; curators/admins may look at anyone's.
  const trader = qTrader && qTrader !== auth.name && (await can(req, "journal.read.team", { trader: qTrader })) ? qTrader : auth.name;
  const lookback = addDaysIso(date, -90);
  const { rows } = await pool.query(
    `SELECT id, ticker, date, side, setup, result, pnl, r_multiple, fees, horizon, exit_date, entry, exit, stop, risk_usd
     FROM trades
     WHERE trader = $1 AND deleted_at IS NULL
       AND (
         date = $2
         OR (date < $2 AND date >= $3
             AND (result = 'open'
                  OR (COALESCE(horizon, 'intraday') IN ('overnight', 'swing')
                      AND exit_date IS NOT NULL AND exit_date <> '' AND exit_date > $2)))
       )
     ORDER BY date ASC, created_at ASC
     LIMIT 80`,
    [trader, date, lookback],
  );
  const shaped = rows.map((t: Record<string, unknown>) => {
    const pnl = num(t["pnl"]);
    const fees = num(t["fees"]);
    const net = netPnl(t);
    const h = t["horizon"];
    return {
      id: t["id"] as number,
      ticker: t["ticker"] as string,
      date: t["date"] as string,
      side: (t["side"] as string | null) ?? null,
      setup: (t["setup"] as string | null) ?? null,
      result: t["result"] as string,
      pnl,
      pnlNet: net == null ? null : Math.round(net * 100) / 100,
      rMultiple: num(t["r_multiple"]),
      rSigned: signedR(t),
      fees,
      horizon: (h === "overnight" || h === "swing" ? h : "intraday") as "intraday" | "overnight" | "swing",
      exitDate: (t["exit_date"] as string | null) || null,
    };
  });
  const today = shaped.filter(t => t.date === date);
  // Carried into the next session: still open, or a multi-day hold whose exit is after this date.
  const held = shaped.filter(t =>
    t.result === "open" || (t.horizon !== "intraday" && !!t.exitDate && t.exitDate > date),
  );
  const closed = today.filter(t => t.result !== "open");
  const withPnl = closed.filter(t => t.pnlNet != null);
  res.json({
    date,
    trader,
    trades: today,
    held,
    summary: {
      count: today.length,
      wins: closed.filter(t => t.result === "win").length,
      losses: closed.filter(t => t.result === "loss").length,
      pnlNet: withPnl.length ? Math.round(withPnl.reduce((s, t) => s + (t.pnlNet ?? 0), 0) * 100) / 100 : null,
      rSum: closed.some(t => t.rSigned != null)
        ? Math.round(closed.reduce((s, t) => s + (t.rSigned ?? 0), 0) * 100) / 100
        : null,
      byHorizon: {
        intraday: today.filter(t => t.horizon === "intraday").length,
        overnight: today.filter(t => t.horizon === "overnight").length,
        swing: today.filter(t => t.horizon === "swing").length,
      },
    },
  });
}));

// Who has read a note. Only the author (or a curator/admin) sees the list.
router.get("/author-notes/:id/reads", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  const auth = req.authUser!;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  await ensureReadsTable();
  const { rows: noteRows } = await pool.query(`SELECT trader FROM author_notes WHERE id = $1`, [id]);
  if (!noteRows[0]) throw notFound();
  if (noteRows[0].trader !== auth.name && !(await can(req, "journal.read.team", { trader: noteRows[0].trader }))) throw forbidden();
  const { rows } = await pool.query(
    `SELECT reader, read_at FROM author_note_reads WHERE note_id = $1 ORDER BY read_at ASC`,
    [id],
  );
  res.json(rows);
}));

// Reach of a note: every active member except the author, read or not, with academy stage (trainees first).
// Same access as /reads: the author, or a curator/admin with journal.read.team.
router.get("/author-notes/:id/audience", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  const auth = req.authUser!;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  await ensureReadsTable();
  const { rows: noteRows } = await pool.query(`SELECT trader FROM author_notes WHERE id = $1`, [id]);
  if (!noteRows[0]) throw notFound();
  const author = noteRows[0].trader as string;
  if (author !== auth.name && !(await can(req, "journal.read.team", { trader: author }))) throw forbidden();
  const [{ rows: users }, { rows: reads }] = await Promise.all([
    pool.query<{ name: string; role: string }>(
      `SELECT name, role FROM users
       WHERE active = true AND COALESCE(banned, false) = false AND role IN ('trader', 'curator', 'admin')
       ORDER BY name`,
    ),
    pool.query<{ reader: string; read_at: string }>(`SELECT reader, read_at FROM author_note_reads WHERE note_id = $1`, [id]),
  ]);
  const stages = await loadStages(users.map(u => u.name));
  const members: AudienceMemberInput[] = users.map(u => ({ name: u.name, role: u.role, stage: stages.get(u.name) ?? null }));
  res.json(buildAudience(members, reads, author));
}));

router.post("/author-notes/:id/read", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  const me = req.authUser!.name;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  await ensureReadsTable();
  const { rows: noteRows } = await pool.query(`SELECT trader FROM author_notes WHERE id = $1`, [id]);
  if (!noteRows[0]) throw notFound();
  if (noteRows[0].trader === me) throw new AppError("OWN_ENTRY");
  const { rows } = await pool.query(
    `INSERT INTO author_note_reads (note_id, reader) VALUES ($1, $2)
     ON CONFLICT (note_id, reader) DO UPDATE SET read_at = author_note_reads.read_at
     RETURNING reader, read_at`,
    [id, me],
  );
  res.json(rows[0]);
}));

router.delete("/author-notes/:id/read", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  const me = req.authUser!.name;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  await ensureReadsTable();
  await pool.query(`DELETE FROM author_note_reads WHERE note_id = $1 AND reader = $2`, [id, me]);
  res.json({ ok: true });
}));

router.put("/author-notes", asyncHandler(async (req, res): Promise<void> => {
  const trader = req.authUser!.name;
  const { raw_text, note_date, mood } = req.body as { raw_text?: string; note_date?: string; mood?: string };
  const date = note_date || todayNy();
  if (!isIsoDate(date)) throw badRequest("INVALID_DATE");
  if (raw_text != null && typeof raw_text !== "string") throw new AppError("INVALID_FIELD", undefined, { field: "raw_text" });
  const text = (raw_text ?? "").trim();
  if (text.length > 50_000) throw new AppError("TEXT_TOO_LONG", undefined, { field: "text", max: 20000 });
  if (mood != null && (typeof mood !== "string" || mood.length > 32)) throw new AppError("INVALID_FIELD", undefined, { field: "mood" });
  const { rows } = await pool.query(
    `INSERT INTO author_notes (trader, note_date, raw_text, mood, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (trader, note_date) DO UPDATE
       SET raw_text = EXCLUDED.raw_text,
           mood = EXCLUDED.mood,
           updated_at = NOW()
     RETURNING ${NOTE_COLS}`,
    [trader, date, text, mood || null],
  );
  res.json(rows[0]);
}));

router.patch("/author-notes/:id/refined", asyncHandler(async (req, res): Promise<void> => {
  const trader = req.authUser!.name;
  const id = Number(req.params["id"]);
  if (isNaN(id)) throw badRequest("INVALID_ID");
  const { refined_text } = req.body as { refined_text: string };
  const { rows } = await pool.query(
    `UPDATE author_notes SET refined_text = $1, updated_at = NOW()
     WHERE id = $2 AND trader = $3 RETURNING ${NOTE_COLS}`,
    [refined_text, id, trader],
  );
  if (!rows[0]) throw new AppError("NOTE_NOT_FOUND");
  res.json(rows[0]);
}));

router.delete("/author-notes/:id", asyncHandler(async (req, res): Promise<void> => {
  const trader = req.authUser!.name;
  const id = Number(req.params["id"]);
  if (isNaN(id)) throw badRequest("INVALID_ID");
  const { rowCount } = await pool.query(
    `DELETE FROM author_notes WHERE id = $1 AND trader = $2`,
    [id, trader],
  );
  if (!rowCount) throw notFound();
  res.json({ ok: true });
}));

router.patch("/author-notes/:id", asyncHandler(async (req, res): Promise<void> => {
  const trader = req.authUser!.name;
  const id = Number(req.params["id"]);
  if (isNaN(id)) throw badRequest("INVALID_ID");
  const { raw_text, mood } = req.body as { raw_text?: string; mood?: string };
  const { rows } = await pool.query(
    `UPDATE author_notes
     SET raw_text = COALESCE($1, raw_text),
         mood = $2,
         refined_text = NULL,
         updated_at = NOW()
     WHERE id = $3 AND trader = $4
     RETURNING ${NOTE_COLS}`,
    [raw_text ?? null, mood ?? null, id, trader],
  );
  if (!rows[0]) throw notFound();
  res.json(rows[0]);
}));

router.post("/author-notes/improve", aiTextLimiter, asyncHandler(async (req, res): Promise<void> => {
  const trader = req.authUser!.name;
  const { text, note_id, note_date } = req.body as { text: string; note_id?: number; note_date?: string };
  if (!text?.trim()) throw new AppError("COMMENT_EMPTY");

  const date = isIsoDate(note_date) ? note_date : todayNy();
  const tradesRes = await pool.query(
    `SELECT t.ticker, t.result, ROUND(${netPnlSql("t")}, 2) AS pnl_net, ROUND(${signedRSql("t")}, 2) AS r_signed, t.setup, t.notes, t.what_worked, t.what_failed
     FROM trades t WHERE t.trader = $1 AND t.date = $2 AND t.deleted_at IS NULL ORDER BY t.created_at LIMIT 15`,
    [trader, date],
  );
  const tradesContext = tradesRes.rows.length > 0 // i18n-ignore (AI prompt context)
    ? `\nТрейды ${trader} за ${date}:\n${tradesRes.rows.map(t => // i18n-ignore (AI prompt context)
        `- ${t.ticker}: ${t.result}${t.pnl_net != null ? ` | PnL нетто: $${t.pnl_net}` : ""}${t.r_signed != null ? ` | R: ${t.r_signed}` : ""}${t.setup ? ` | Сетап: ${t.setup}` : ""}`
      ).join("\n")}`
    : "";

  // i18n-ignore-next (AI prompt — model input; the answer language follows the reader)
  const prompt = `Ты — опытный ментор трейдеров. Трейдер ${trader} сделал голосовую (или текстовую) запись о своём торговом дне. Твоя задача — структурировать и улучшить его мысли, сохранив оригинальный голос и суть.
${tradesContext}

Оригинальная запись трейдера:
"""
${text.slice(0, 4000)}
"""

Улучши и структурируй текст по следующему формату (используй только те разделы, о которых говорит трейдер, не придумывай):

**📊 Главные наблюдения дня** — ключевые рыночные инсайты

**✅ Что сработало** — успешные паттерны, правильные решения

**❌ Ошибки / что улучшить** — честный разбор промахов

**⚡ Ситуации вне плана** — неожиданные события, нестандартные ситуации

**🎯 Фокус на завтра** — конкретный план или фокус

Пиши в живом разговорном стиле от первого лица. Сохраняй специфические тикеры, числа и термины из оригинала. Не добавляй ничего, чего трейдер не упоминал.
${aiAnswerLanguage(langOf(req))}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  try {
    const msg = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    }, { signal: ctrl.signal as AbortSignal });
    clearTimeout(t);
    const refined = msg.content[0]?.type === "text" ? msg.content[0].text : "";

    if (note_id) {
      await pool.query(
        `UPDATE author_notes SET refined_text = $1, updated_at = NOW() WHERE id = $2 AND trader = $3`,
        [refined, note_id, trader],
      );
    }
    res.json({ refined_text: refined });
  } catch (e: any) {
    clearTimeout(t);
    if (handleAiNotConfigured(e, res)) return;
    logger.warn({ error: e.message, trader }, "author-notes improve failed");
    sendError(res, new AppError("AI_UNAVAILABLE"));
  }
}));

router.post("/author-notes/weekly-summary", aiTextLimiter, asyncHandler(async (req, res): Promise<void> => {
  const trader = req.authUser!.name;
  const { week_start } = req.body as { week_start?: string };
  const weekStart = week_start || getWeekStart(todayNy());
  if (!isIsoDate(weekStart)) throw badRequest("INVALID_DATE");
  const weekEnd = getWeekEnd(weekStart);

  const { rows: notes } = await pool.query(
    `SELECT TO_CHAR(note_date, 'YYYY-MM-DD') AS note_date, raw_text, refined_text, mood FROM author_notes
     WHERE trader = $1 AND note_date >= $2 AND note_date <= $3 ORDER BY note_date`,
    [trader, weekStart, weekEnd],
  );
  if (notes.length === 0) throw new AppError("NOT_FOUND", 400);

  const { rows: trades } = await pool.query(
    `SELECT t.date, t.ticker, t.result, ROUND(${netPnlSql("t")}, 2) AS pnl_net, ROUND(${signedRSql("t")}, 2) AS r_signed, t.setup FROM trades t
     WHERE t.trader = $1 AND t.date >= $2 AND t.date <= $3 AND t.deleted_at IS NULL ORDER BY t.date, t.created_at`,
    [trader, weekStart, weekEnd],
  );

  const notesText = notes.map(n => // i18n-ignore (AI prompt context)
    `=== ${n.note_date} (настроение: ${n.mood || "не указано"}) ===\n${n.refined_text || n.raw_text}`
  ).join("\n\n");

  const tradesText = trades.length > 0 // i18n-ignore (AI prompt context)
    ? `\nРезультаты по трейдам за неделю:\n${trades.map((t: any) => // i18n-ignore (AI prompt context)
        `${t.date} | ${t.ticker} | ${t.result}${t.pnl_net != null ? ` | нетто $${t.pnl_net}` : ""}${t.r_signed != null ? ` | R:${t.r_signed}` : ""}${t.setup ? ` | ${t.setup}` : ""}`
      ).join("\n")}`
    : "";

  // i18n-ignore-next (AI prompt — model input)
  const prompt = `Ты — ментор трейдеров. Проведи детальный разбор недели ${weekStart} — ${weekEnd} для трейдера ${trader}.
${tradesText}

ЗАПИСИ ИЗ ДНЕВНИКА:
${notesText.slice(0, 8000)}

Сделай глубокий анализ — найди паттерны в мышлении, поведении и эмоциях трейдера. Структурируй по разделам:

**📊 Итог недели** — общая оценка, ключевые события и результаты

**🔄 Повторяющиеся паттерны** — что трейдер делал или замечал несколько раз (хорошего и плохого)

**💡 Главные инсайты недели** — самые ценные наблюдения из дневника

**⚠️ Точки роста** — конкретные ошибки с рекомендациями

**📈 Прогресс** — что улучшилось по сравнению с предыдущим периодом

**🎯 Фокус на следующую неделю** — 2-3 конкретные задачи

---
**Цитата недели:** «[самая точная или ценная фраза трейдера из его записей, дословно]»

Пиши живо и конкретно. Только то, что есть в записях. Цитату приводи дословно, на языке оригинала.
${aiAnswerLanguage(langOf(req))}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  try {
    const msg = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }],
    }, { signal: ctrl.signal as AbortSignal });
    clearTimeout(t);
    const summary = msg.content[0]?.type === "text" ? msg.content[0].text : "";

    const quoteMatch = summary.match(/[Цц]итата недели[^«"]*[«"]([^»"]+)[»"]/);
    const quoteOfWeek = quoteMatch?.[1]?.trim() ?? null;

    const { rows } = await pool.query(
      `INSERT INTO author_weekly_summaries (trader, week_start, week_end, summary, quote_of_week)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (trader, week_start) DO UPDATE
         SET summary = EXCLUDED.summary, quote_of_week = EXCLUDED.quote_of_week, created_at = NOW()
       RETURNING ${WEEKLY_COLS}`,
      [trader, weekStart, weekEnd, summary, quoteOfWeek],
    );
    res.json(rows[0]);
  } catch (e: any) {
    clearTimeout(t);
    if (handleAiNotConfigured(e, res)) return;
    logger.warn({ error: e.message, trader }, "author-notes weekly summary failed");
    sendError(res, new AppError("AI_UNAVAILABLE"));
  }
}));

router.post("/author-notes/team-summary", aiTextLimiter, asyncHandler(async (req, res): Promise<void> => {
  const raw = (req.body as { note_ids?: unknown }).note_ids;
  const note_ids = Array.isArray(raw) ? raw.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 100) : [];
  if (note_ids.length === 0) throw new AppError("SELECT_AT_LEAST_ONE");
  const { rows } = await pool.query(
    `SELECT trader, TO_CHAR(note_date, 'YYYY-MM-DD') AS note_date, raw_text, refined_text, mood
     FROM author_notes WHERE id = ANY($1) ORDER BY trader, note_date`,
    [note_ids],
  );
  if (rows.length === 0) throw new AppError("NOT_FOUND", 400);

  const notesText = rows.map((n: any) => // i18n-ignore (AI prompt context)
    `### ${n.trader} (${n.note_date}${n.mood ? `, настроение: ${n.mood}` : ""})\n${n.refined_text || n.raw_text}`
  ).join("\n\n");

  // i18n-ignore-next (AI prompt — model input)
  const prompt = `Ты — ментор проп трейдинг деска. Создай общую командную сводку на основе ежедневных записей трейдеров.

ЗАПИСИ КОМАНДЫ:
${notesText.slice(0, 8000)}

Создай структурированную командную сводку:

**📊 Общая атмосфера команды** — как команда провела день, общий эмоциональный фон

**🎯 Общие успешные паттерны** — что сработало у нескольких трейдеров

**⚠️ Общие точки роста** — повторяющиеся ошибки и зоны улучшения

**💡 Ключевые инсайты дня** — самые ценные наблюдения от команды

**🔮 Фокус команды на завтра** — что стоит держать в голове

Пиши конкретно, ссылайся на реальные примеры из записей. Не придумывай ничего, чего нет в записях.
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
    logger.warn({ error: e.message }, "author-notes team-summary failed");
    sendError(res, new AppError("AI_UNAVAILABLE"));
  }
}));

export default router;
