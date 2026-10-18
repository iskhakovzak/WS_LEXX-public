/**
 * «Академия → Обучение» (F1): программы, модули, уроки (markdown + видео + вложения), тесты с автопроверкой,
 * задания с проверкой наставником по рубрике, прогресс учеников и когорт, привязка уроков к сетапам плейбука.
 *
 * Чистая логика — lib/academyContent.ts. Таблицы academy_* создаются здесь (ensureTables, идемпотентно, лениво).
 * Удаление только мягкое (archived_at). Внешних отправок нет: уведомления — in-app через notifyUser.
 *
 * Ученик / любой участник (гость — только чтение опубликованного, без прогресса):
 *   GET  /academy/content/meta                          роль, есть ли когорты/зачисления F2, список когорт (staff)
 *   GET  /academy/content/programs?user=                каталог с прогрессом (staff видит черновики)
 *   GET  /academy/content/programs/:id?user=            дерево модулей и элементов + статусы + «что дальше»
 *   GET  /academy/content/lessons/by-setup?playbookId=&setup=   уроки «как торговать этот сетап»
 *   GET  /academy/content/lessons/:id?user=             урок + видео (allow-list) + сетапы + навигация
 *   POST /academy/content/lessons/:id/progress          {completed: boolean} — отметка пройден / начат
 *   GET  /academy/content/quizzes/:id?user=             тест без правильных ответов + попытки
 *   POST /academy/content/quizzes/:id/attempts          {answers} → автопроверка, попытка сохраняется
 *   GET  /academy/content/assignments/:id?user=&all=1   задание + сдачи (staff all=1 — все ученики)
 *   POST /academy/content/assignments/:id/submissions   {text,url,tradeIds} (только свои сделки)
 *   PATCH /academy/content/submissions/:id              правка своей сдачи, пока она не проверена
 *   POST /academy/content/submissions/:id/archive       отзыв своей непроверенной сдачи (staff — любой)
 *   GET  /academy/content/my-trades?q=&limit=&user=     свои сделки для привязки к сдаче
 * Наставник (curator/admin, requireStaff):
 *   GET  /academy/content/review-queue?status=&cohortId=
 *   POST /academy/content/submissions/:id/grade         {decision:'graded'|'returned', scores, comment}
 *   GET  /academy/content/progress?programId=&cohortId= матрица учеников × модули + сводка когорты
 *   GET  /academy/content/admin/tree?programId=&archived=1   полный контент (с ответами тестов)
 *   GET  /academy/content/setups                        сетапы плейбука (только чтение) для привязки
 *   POST/PATCH programs | modules | lessons | quizzes | assignments
 *   POST /academy/content/:kind/:id/archive | /restore
 *   POST /academy/content/programs/:id/reorder {moduleIds}
 *   POST /academy/content/modules/:id/reorder  {items:[{kind,id}]}
 *   POST /academy/content/items/move           {kind,id,moduleId}
 *   POST /academy/content/seed-demo            идемпотентный демо-курс «Основы проп-трейдинга WS»
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { isStaffRole, requireMember, requireStaff, scopeTrader, viewerRole } from "../lib/auth";
import { assignedStaffOf, notifyUsers, notifyUser } from "../lib/notifyUtils";
import { academyContentT } from "../lib/academyI18n";
import { AppError, sendError as sendAppError, type ErrorCode } from "../lib/http";
import { langOf, type Params } from "../i18n";
import { logger } from "../lib/logger";
import { netPnlSql, signedRSql, num } from "../lib/tradeMath";
import {
  DEMO_PROGRAM, applyIdOrder, applyOrder, attemptState, checkSubmission, clampPct, cohortSummary, computeProgress, feedbackFor,
  gradeQuiz, gradeRubric, itemKey, normalizeAttachments, normalizeQuestions, normalizeRubric, normalizeStage, parseTradeIds,
  publicQuestions, safeHttpUrl, slugify, videoEmbed,
  type ItemKind, type ProgressFacts, type ProgressItem, type QuizQuestion, type RubricCriterion,
} from "../lib/academyContent";

const router: IRouter = Router();
const P = "/academy/content";

/* ─── Схема ──────────────────────────────────────────────────────────────── */

let ensured: Promise<void> | null = null;
export function ensureAcademyContentTables(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(`
        CREATE TABLE IF NOT EXISTS academy_programs (
          id SERIAL PRIMARY KEY,
          slug TEXT UNIQUE,
          title TEXT NOT NULL,
          description TEXT,
          level TEXT,
          stage TEXT,
          published BOOLEAN NOT NULL DEFAULT false,
          position INTEGER NOT NULL DEFAULT 0,
          created_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          archived_at TIMESTAMPTZ
        );
        ALTER TABLE academy_programs ADD COLUMN IF NOT EXISTS stage TEXT;
        CREATE TABLE IF NOT EXISTS academy_modules (
          id SERIAL PRIMARY KEY,
          program_id INTEGER NOT NULL REFERENCES academy_programs(id),
          title TEXT NOT NULL,
          description TEXT,
          position INTEGER NOT NULL DEFAULT 0,
          seed_key TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          archived_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS academy_modules_program_idx ON academy_modules (program_id);
        CREATE TABLE IF NOT EXISTS academy_lessons (
          id SERIAL PRIMARY KEY,
          module_id INTEGER NOT NULL REFERENCES academy_modules(id),
          title TEXT NOT NULL,
          summary TEXT,
          body_md TEXT NOT NULL DEFAULT '',
          video_url TEXT,
          attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
          duration_min INTEGER,
          playbook_ids INTEGER[] NOT NULL DEFAULT '{}',
          setup_names TEXT[] NOT NULL DEFAULT '{}',
          position INTEGER NOT NULL DEFAULT 0,
          draft BOOLEAN NOT NULL DEFAULT false,
          seed_key TEXT,
          created_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          archived_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS academy_lessons_module_idx ON academy_lessons (module_id);
        CREATE INDEX IF NOT EXISTS academy_lessons_playbook_idx ON academy_lessons USING GIN (playbook_ids);
        CREATE TABLE IF NOT EXISTS academy_quizzes (
          id SERIAL PRIMARY KEY,
          module_id INTEGER NOT NULL REFERENCES academy_modules(id),
          title TEXT NOT NULL,
          description TEXT,
          questions JSONB NOT NULL DEFAULT '[]'::jsonb,
          pass_pct INTEGER NOT NULL DEFAULT 80,
          max_attempts INTEGER,
          position INTEGER NOT NULL DEFAULT 0,
          draft BOOLEAN NOT NULL DEFAULT false,
          seed_key TEXT,
          created_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          archived_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS academy_quizzes_module_idx ON academy_quizzes (module_id);
        CREATE TABLE IF NOT EXISTS academy_quiz_attempts (
          id SERIAL PRIMARY KEY,
          quiz_id INTEGER NOT NULL REFERENCES academy_quizzes(id),
          user_name TEXT NOT NULL,
          answers JSONB NOT NULL DEFAULT '{}'::jsonb,
          results JSONB NOT NULL DEFAULT '[]'::jsonb,
          score NUMERIC(10,2) NOT NULL DEFAULT 0,
          max_score NUMERIC(10,2) NOT NULL DEFAULT 0,
          pct NUMERIC(6,2) NOT NULL DEFAULT 0,
          passed BOOLEAN NOT NULL DEFAULT false,
          submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS academy_quiz_attempts_user_idx ON academy_quiz_attempts (user_name, quiz_id);
        CREATE TABLE IF NOT EXISTS academy_assignments (
          id SERIAL PRIMARY KEY,
          module_id INTEGER NOT NULL REFERENCES academy_modules(id),
          title TEXT NOT NULL,
          body_md TEXT NOT NULL DEFAULT '',
          rubric JSONB NOT NULL DEFAULT '[]'::jsonb,
          pass_pct INTEGER NOT NULL DEFAULT 70,
          min_trades INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL DEFAULT 0,
          draft BOOLEAN NOT NULL DEFAULT false,
          seed_key TEXT,
          created_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          archived_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS academy_assignments_module_idx ON academy_assignments (module_id);
        CREATE TABLE IF NOT EXISTS academy_submissions (
          id SERIAL PRIMARY KEY,
          assignment_id INTEGER NOT NULL REFERENCES academy_assignments(id),
          user_name TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          url TEXT,
          trade_ids INTEGER[] NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'submitted',
          scores JSONB,
          total NUMERIC(10,2),
          max_total NUMERIC(10,2),
          pct NUMERIC(6,2),
          passed BOOLEAN,
          mentor_comment TEXT,
          graded_by TEXT,
          graded_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          archived_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS academy_submissions_user_idx ON academy_submissions (user_name, assignment_id);
        CREATE INDEX IF NOT EXISTS academy_submissions_status_idx ON academy_submissions (status) WHERE archived_at IS NULL;
        CREATE TABLE IF NOT EXISTS academy_lesson_progress (
          user_name TEXT NOT NULL,
          lesson_id INTEGER NOT NULL REFERENCES academy_lessons(id),
          started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          completed_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (user_name, lesson_id)
        );
      `)
      .then(() => undefined)
      .catch((err) => {
        ensured = null;
        throw err;
      });
  }
  return ensured;
}

/* ─── Общие помощники ────────────────────────────────────────────────────── */

const KIND_TABLE: Record<ItemKind, string> = { lesson: "academy_lessons", quiz: "academy_quizzes", assignment: "academy_assignments" };
const ARCHIVE_TABLE: Record<string, string> = {
  programs: "academy_programs", modules: "academy_modules", lessons: "academy_lessons", quizzes: "academy_quizzes", assignments: "academy_assignments",
};

const idParam = (req: Request, key = "id"): number | null => {
  const n = Number(req.params[key]);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const qStr = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const qInt = (v: unknown): number | null => {
  const n = Number(qStr(v, 20));
  return qStr(v, 20) !== "" && Number.isInteger(n) && n > 0 ? n : null;
};
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

/** Error response by code (text translated by the error contract into the request language). */
function bad(res: Response, code: ErrorCode, status = 400, params?: Params, details?: unknown): void {
  sendAppError(res, new AppError(code, status, params, details));
}

/** Quiz / rubric validation problems (already in the request language) as one API error. */
function invalidContent(res: Response, errors: string[]): void {
  bad(res, "CONTENT_INVALID", 400, { reason: errors.join("; ") }, { errors });
}

async function isStaffReq(req: Request): Promise<boolean> {
  if (!req.authUser) return false;
  return isStaffRole(await viewerRole(req));
}

/**
 * Чей прогресс показывать. Трейдер — всегда свой; staff — `?user=` или свой; гость — sentinel (пусто).
 * Возвращает null, когда ответ 401 уже отправлен.
 */
async function progressUser(req: Request, res: Response): Promise<{ user: string; staff: boolean } | null> {
  const scoped = await scopeTrader(req, qStr(req.query.user, 120) || null);
  if (scoped === undefined) { bad(res, "AUTH_REQUIRED", 401); return null; }
  const staff = await isStaffReq(req);
  return { user: scoped ?? req.authUser!.name, staff };
}

async function tableExists(name: string): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ t: string | null }>(`SELECT to_regclass($1) AS t`, [`public.${name}`]);
    return !!rows[0]?.t;
  } catch {
    return false;
  }
}

/** Наставники ученика: закреплённые в users + наставник активной когорты (если таблицы F2 уже есть). */
async function mentorsOf(userName: string): Promise<string[]> {
  const out = new Set(await assignedStaffOf(userName));
  if ((await tableExists("academy_enrollments")) && (await tableExists("academy_cohorts"))) {
    try {
      const { rows } = await pool.query<{ mentor: string | null }>(
        `SELECT DISTINCT c.mentor FROM academy_enrollments e JOIN academy_cohorts c ON c.id = e.cohort_id
          WHERE e.user_name = $1 AND e.archived_at IS NULL AND c.archived_at IS NULL AND COALESCE(e.status, 'active') = 'active'`,
        [userName],
      );
      for (const r of rows) if (r.mentor && r.mentor !== userName) out.add(r.mentor);
    } catch (err) {
      logger.debug({ err }, "academy: cohort mentor lookup failed");
    }
  }
  return [...out];
}

const learnLink = {
  lesson: (id: number) => `/academy/lesson?id=${id}`,
  quiz: (id: number) => `/academy/lesson?quiz=${id}`,
  assignment: (id: number, extra = "") => `/academy/lesson?assignment=${id}${extra}`,
};

/* ─── Загрузка дерева и фактов прогресса ─────────────────────────────────── */

type ProgramRow = {
  id: number; slug: string | null; title: string; description: string | null; level: string | null; stage: string | null;
  published: boolean; position: number; created_by: string | null; created_at: Date; updated_at: Date; archived_at: Date | null;
};
type ModuleRow = { id: number; program_id: number; title: string; description: string | null; position: number; archived_at: Date | null };
type ItemRow = {
  kind: ItemKind; id: number; module_id: number; program_id: number; position: number; title: string; summary: string | null;
  duration_min: number | null; draft: boolean; question_count: number | null; pass_pct: number | null; min_trades: number | null;
  has_video: boolean | null; archived_at: Date | null;
};

function programJson(p: ProgramRow) {
  return {
    id: p.id, slug: p.slug, title: p.title, description: p.description, level: p.level, stage: normalizeStage(p.stage),
    published: p.published, position: p.position, createdBy: p.created_by, createdAt: iso(p.created_at), updatedAt: iso(p.updated_at),
    archivedAt: iso(p.archived_at),
  };
}

async function loadPrograms(opts: { staff: boolean; ids?: number[]; archived?: boolean }): Promise<ProgramRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.archived) where.push("archived_at IS NULL");
  if (!opts.staff) where.push("published = true");
  if (opts.ids) { params.push(opts.ids); where.push(`id = ANY($${params.length})`); }
  const { rows } = await pool.query<ProgramRow>(
    `SELECT * FROM academy_programs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY position, id`,
    params,
  );
  return rows;
}

async function loadModules(programIds: number[], archived = false): Promise<ModuleRow[]> {
  if (!programIds.length) return [];
  const { rows } = await pool.query<ModuleRow>(
    `SELECT id, program_id, title, description, position, archived_at FROM academy_modules
      WHERE program_id = ANY($1) ${archived ? "" : "AND archived_at IS NULL"} ORDER BY program_id, position, id`,
    [programIds],
  );
  return rows;
}

async function loadItems(programIds: number[], opts: { drafts: boolean; archived?: boolean }): Promise<ItemRow[]> {
  if (!programIds.length) return [];
  const live = (a: string) => `${opts.archived ? "TRUE" : `${a}.archived_at IS NULL AND m.archived_at IS NULL`}${opts.drafts ? "" : ` AND NOT ${a}.draft`}`;
  const { rows } = await pool.query<ItemRow>(
    `SELECT 'lesson'::text AS kind, l.id, l.module_id, m.program_id, l.position, l.title, l.summary, l.duration_min, l.draft,
            NULL::int AS question_count, NULL::int AS pass_pct, NULL::int AS min_trades, (l.video_url IS NOT NULL) AS has_video, l.archived_at
       FROM academy_lessons l JOIN academy_modules m ON m.id = l.module_id
      WHERE m.program_id = ANY($1) AND ${live("l")}
     UNION ALL
     SELECT 'quiz', q.id, q.module_id, m.program_id, q.position, q.title, q.description, NULL, q.draft,
            jsonb_array_length(q.questions), q.pass_pct, NULL, NULL, q.archived_at
       FROM academy_quizzes q JOIN academy_modules m ON m.id = q.module_id
      WHERE m.program_id = ANY($1) AND ${live("q")}
     UNION ALL
     SELECT 'assignment', a.id, a.module_id, m.program_id, a.position, a.title, LEFT(a.body_md, 240), NULL, a.draft,
            NULL, a.pass_pct, a.min_trades, NULL, a.archived_at
       FROM academy_assignments a JOIN academy_modules m ON m.id = a.module_id
      WHERE m.program_id = ANY($1) AND ${live("a")}`,
    [programIds],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), module_id: Number(r.module_id), program_id: Number(r.program_id) }));
}

type UserFacts = ProgressFacts & { lastActivity: string | null; lessonsCompletedAt: Map<number, string> };

async function loadFacts(users: string[]): Promise<Map<string, UserFacts>> {
  const out = new Map<string, UserFacts>();
  const get = (u: string): UserFacts => {
    let f = out.get(u);
    if (!f) {
      f = { lessonsDone: new Set(), lessonsStarted: new Set(), quizzes: new Map(), assignments: new Map(), lastActivity: null, lessonsCompletedAt: new Map() };
      out.set(u, f);
    }
    return f;
  };
  users.forEach(get);
  if (!users.length) return out;
  const bump = (f: UserFacts, t: unknown) => {
    const s = iso(t);
    if (s && (!f.lastActivity || s > f.lastActivity)) f.lastActivity = s;
  };
  const [lp, qa, sb] = await Promise.all([
    pool.query<{ user_name: string; lesson_id: number; completed_at: Date | null; updated_at: Date }>(
      `SELECT user_name, lesson_id, completed_at, updated_at FROM academy_lesson_progress WHERE user_name = ANY($1)`, [users]),
    pool.query<{ user_name: string; quiz_id: number; passed: boolean; best: string | null; last: Date }>(
      `SELECT user_name, quiz_id, bool_or(passed) AS passed, MAX(pct) AS best, MAX(submitted_at) AS last
         FROM academy_quiz_attempts WHERE user_name = ANY($1) GROUP BY user_name, quiz_id`, [users]),
    pool.query<{ user_name: string; assignment_id: number; status: string; passed: boolean | null; updated_at: Date }>(
      `SELECT DISTINCT ON (user_name, assignment_id) user_name, assignment_id, status, passed, updated_at
         FROM academy_submissions WHERE user_name = ANY($1) AND archived_at IS NULL
        ORDER BY user_name, assignment_id, created_at DESC, id DESC`, [users]),
  ]);
  for (const r of lp.rows) {
    const f = get(r.user_name);
    (f.lessonsStarted as Set<number>).add(Number(r.lesson_id));
    if (r.completed_at) { (f.lessonsDone as Set<number>).add(Number(r.lesson_id)); f.lessonsCompletedAt.set(Number(r.lesson_id), iso(r.completed_at)!); }
    bump(f, r.updated_at);
  }
  for (const r of qa.rows) {
    const f = get(r.user_name);
    (f.quizzes as Map<number, { passed: boolean; bestPct: number | null }>).set(Number(r.quiz_id), { passed: !!r.passed, bestPct: num(r.best) });
    bump(f, r.last);
  }
  for (const r of sb.rows) {
    const f = get(r.user_name);
    const status = r.status === "graded" || r.status === "returned" ? r.status : "submitted";
    (f.assignments as Map<number, { status: "submitted" | "graded" | "returned"; passed: boolean | null }>).set(Number(r.assignment_id), { status, passed: r.passed });
    bump(f, r.updated_at);
  }
  return out;
}

const toProgressItems = (items: ItemRow[]): ProgressItem[] =>
  items.filter((i) => !i.draft).map((i) => ({ kind: i.kind, id: i.id, moduleId: i.module_id, position: i.position, title: i.title }));

function progressJson(p: ReturnType<typeof computeProgress>) {
  return { total: p.total, done: p.done, pct: p.pct, byKind: p.byKind, modules: p.modules, next: p.next };
}

/** Порядок всех элементов программы (для навигации «назад/далее»). */
function orderedItems(modules: ModuleRow[], items: ItemRow[]): ItemRow[] {
  const mi = new Map(modules.map((m, i) => [m.id, i]));
  return items
    .filter((i) => mi.has(i.module_id))
    .sort((a, b) => mi.get(a.module_id)! - mi.get(b.module_id)! || a.position - b.position || a.id - b.id);
}

async function itemProgram(kind: ItemKind, id: number): Promise<{ moduleId: number; programId: number; draft: boolean; published: boolean; archived: boolean } | null> {
  const { rows } = await pool.query<{ module_id: number; program_id: number; draft: boolean; published: boolean; archived: boolean }>(
    `SELECT x.module_id, m.program_id, x.draft, p.published,
            (x.archived_at IS NOT NULL OR m.archived_at IS NOT NULL OR p.archived_at IS NOT NULL) AS archived
       FROM ${KIND_TABLE[kind]} x JOIN academy_modules m ON m.id = x.module_id JOIN academy_programs p ON p.id = m.program_id
      WHERE x.id = $1`,
    [id],
  );
  const r = rows[0];
  return r ? { moduleId: Number(r.module_id), programId: Number(r.program_id), draft: r.draft, published: r.published, archived: r.archived } : null;
}

/** Ученик видит элемент, только если программа опубликована, элемент не черновик и ничего не в архиве. */
async function visibleItem(req: Request, res: Response, kind: ItemKind, id: number, staff: boolean) {
  const info = await itemProgram(kind, id);
  if (!info || (!staff && (info.archived || info.draft || !info.published))) { bad(res, "NOT_FOUND", 404); return null; }
  return info;
}

async function navFor(programId: number, kind: ItemKind, id: number, staff: boolean) {
  const modules = await loadModules([programId]);
  const items = orderedItems(modules, await loadItems([programId], { drafts: staff }));
  const idx = items.findIndex((i) => i.kind === kind && i.id === id);
  const pick = (i: ItemRow | undefined) => (i ? { kind: i.kind, id: i.id, title: i.title } : null);
  const { rows } = await pool.query<{ title: string }>(`SELECT title FROM academy_programs WHERE id = $1`, [programId]);
  return {
    program: { id: programId, title: rows[0]?.title ?? "" },
    prev: idx > 0 ? pick(items[idx - 1]) : null,
    next: idx >= 0 ? pick(items[idx + 1]) : null,
    outline: modules.map((m) => ({
      id: m.id, title: m.title,
      items: items.filter((i) => i.module_id === m.id).map((i) => ({ kind: i.kind, id: i.id, title: i.title, draft: i.draft })),
    })),
  };
}

/* ─── Мета ───────────────────────────────────────────────────────────────── */

router.get(`${P}/meta`, asyncHandler(async (req, res): Promise<void> => {
  await ensureAcademyContentTables();
  const staff = await isStaffReq(req);
  const enrollmentsAvailable = await tableExists("academy_enrollments");
  const cohortsAvailable = await tableExists("academy_cohorts");
  let cohorts: { id: number; name: string; format: string | null; mentor: string | null }[] = [];
  if (staff && cohortsAvailable) {
    try {
      const { rows } = await pool.query<{ id: number; name: string; format: string | null; mentor: string | null }>(
        `SELECT id, name, format, mentor FROM academy_cohorts WHERE archived_at IS NULL ORDER BY id DESC LIMIT 200`);
      cohorts = rows.map((r) => ({ ...r, id: Number(r.id) }));
    } catch (err) {
      logger.debug({ err }, "academy: cohorts read failed");
    }
  }
  const pending = staff
    ? Number((await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM academy_submissions WHERE status = 'submitted' AND archived_at IS NULL`)).rows[0]?.n ?? 0)
    : 0;
  res.json({ staff, me: req.authUser?.name ?? null, enrollmentsAvailable, cohortsAvailable, cohorts, pendingReviews: pending });
}));

/* ─── Каталог и дерево программы ─────────────────────────────────────────── */

router.get(`${P}/programs`, asyncHandler(async (req, res): Promise<void> => {
  await ensureAcademyContentTables();
  const who = await progressUser(req, res);
  if (!who) return;
  const programs = await loadPrograms({ staff: who.staff });
  const ids = programs.map((p) => p.id);
  const [modules, items, facts] = await Promise.all([loadModules(ids), loadItems(ids, { drafts: false }), loadFacts([who.user])]);
  const f = facts.get(who.user)!;
  res.json({
    user: who.user,
    programs: programs.map((p) => {
      const mods = modules.filter((m) => m.program_id === p.id);
      const its = items.filter((i) => i.program_id === p.id);
      const prog = computeProgress(toProgressItems(its), mods.map((m) => m.id), f);
      return {
        ...programJson(p),
        modules: mods.length,
        counts: { lessons: its.filter((i) => i.kind === "lesson").length, quizzes: its.filter((i) => i.kind === "quiz").length, assignments: its.filter((i) => i.kind === "assignment").length },
        durationMin: its.reduce((s, i) => s + (i.duration_min ?? 0), 0),
        progress: progressJson(prog),
      };
    }),
  });
}));

router.get(`${P}/programs/:id`, asyncHandler(async (req, res): Promise<void> => {
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const who = await progressUser(req, res);
  if (!who) return;
  const [program] = await loadPrograms({ staff: who.staff, ids: [id] });
  if (!program) return bad(res, "PROGRAM_NOT_FOUND", 404);
  const [modules, items, facts] = await Promise.all([loadModules([id]), loadItems([id], { drafts: who.staff }), loadFacts([who.user])]);
  const f = facts.get(who.user)!;
  const prog = computeProgress(toProgressItems(items), modules.map((m) => m.id), f);
  const sorted = orderedItems(modules, items);
  res.json({
    user: who.user,
    program: programJson(program),
    progress: progressJson(prog),
    modules: modules.map((m) => ({
      id: m.id, title: m.title, description: m.description, position: m.position,
      progress: prog.modules.find((x) => x.moduleId === m.id) ?? null,
      items: sorted.filter((i) => i.module_id === m.id).map((i) => ({
        kind: i.kind, id: i.id, title: i.title, summary: i.summary, position: i.position, draft: i.draft,
        durationMin: i.duration_min, questionCount: i.question_count, passPct: i.pass_pct, minTrades: i.min_trades, hasVideo: !!i.has_video,
        status: prog.status.get(itemKey(i.kind, i.id)) ?? "not_started",
        bestPct: i.kind === "quiz" ? f.quizzes.get(i.id)?.bestPct ?? null : null,
        submission: i.kind === "assignment" ? f.assignments.get(i.id) ?? null : null,
      })),
    })),
  });
}));

/* ─── Уроки ──────────────────────────────────────────────────────────────── */

type LessonRow = {
  id: number; module_id: number; title: string; summary: string | null; body_md: string; video_url: string | null; attachments: unknown;
  duration_min: number | null; playbook_ids: number[] | null; setup_names: string[] | null; position: number; draft: boolean;
  created_by: string | null; created_at: Date; updated_at: Date; archived_at: Date | null;
};

function lessonJson(l: LessonRow) {
  return {
    id: Number(l.id), moduleId: Number(l.module_id), title: l.title, summary: l.summary, bodyMd: l.body_md, videoUrl: l.video_url,
    video: videoEmbed(l.video_url), attachments: normalizeAttachments(l.attachments), durationMin: l.duration_min,
    playbookIds: (l.playbook_ids ?? []).map(Number), setupNames: l.setup_names ?? [], position: l.position, draft: l.draft,
    createdBy: l.created_by, createdAt: iso(l.created_at), updatedAt: iso(l.updated_at), archivedAt: iso(l.archived_at),
  };
}

async function setupsByIds(ids: number[]) {
  if (!ids.length) return [];
  const { rows } = await pool.query<{ id: number; name: string; folder: string | null; setup_type: string | null }>(
    `SELECT id, name, folder, setup_type FROM playbook WHERE id = ANY($1) AND deleted_at IS NULL ORDER BY name`, [ids]);
  return rows.map((r) => ({ id: Number(r.id), name: r.name, folder: r.folder, setupType: r.setup_type }));
}

// Объявлен раньше /lessons/:id, чтобы "by-setup" не принимался за id.
router.get(`${P}/lessons/by-setup`, asyncHandler(async (req, res): Promise<void> => {
  await ensureAcademyContentTables();
  const staff = await isStaffReq(req);
  const playbookId = qInt(req.query.playbookId);
  let setup = qStr(req.query.setup, 120);
  if (!playbookId && !setup) return bad(res, "VALIDATION");
  if (playbookId && !setup) {
    const { rows } = await pool.query<{ name: string }>(`SELECT name FROM playbook WHERE id = $1 AND deleted_at IS NULL`, [playbookId]);
    setup = rows[0]?.name ?? "";
  }
  const { rows } = await pool.query<{ id: number; title: string; summary: string | null; duration_min: number | null; program_id: number; program_title: string; by_id: boolean }>(
    `SELECT l.id, l.title, l.summary, l.duration_min, p.id AS program_id, p.title AS program_title,
            ($1::int IS NOT NULL AND $1::int = ANY(l.playbook_ids)) AS by_id
       FROM academy_lessons l JOIN academy_modules m ON m.id = l.module_id JOIN academy_programs p ON p.id = m.program_id
      WHERE l.archived_at IS NULL AND m.archived_at IS NULL AND p.archived_at IS NULL
        ${staff ? "" : "AND p.published AND NOT l.draft"}
        AND (($1::int IS NOT NULL AND $1::int = ANY(l.playbook_ids))
             OR ($2 <> '' AND EXISTS (SELECT 1 FROM unnest(l.setup_names) n WHERE length(n) >= 3 AND lower($2) LIKE '%' || lower(n) || '%')))
      ORDER BY by_id DESC, p.position, m.position, l.position
      LIMIT 20`,
    [playbookId, setup],
  );
  res.json({
    playbookId, setup: setup || null,
    lessons: rows.map((r) => ({ id: Number(r.id), title: r.title, summary: r.summary, durationMin: r.duration_min, programId: Number(r.program_id), programTitle: r.program_title, match: r.by_id ? "playbook" : "name", href: learnLink.lesson(Number(r.id)) })),
  });
}));

router.get(`${P}/lessons/:id`, asyncHandler(async (req, res): Promise<void> => {
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const who = await progressUser(req, res);
  if (!who) return;
  const info = await visibleItem(req, res, "lesson", id, who.staff);
  if (!info) return;
  const { rows } = await pool.query<LessonRow>(`SELECT * FROM academy_lessons WHERE id = $1`, [id]);
  const lesson = rows[0];
  const [setups, nav, prog] = await Promise.all([
    setupsByIds((lesson.playbook_ids ?? []).map(Number)),
    navFor(info.programId, "lesson", id, who.staff),
    pool.query<{ started_at: Date; completed_at: Date | null }>(`SELECT started_at, completed_at FROM academy_lesson_progress WHERE user_name = $1 AND lesson_id = $2`, [who.user, id]),
  ]);
  const p = prog.rows[0];
  res.json({
    user: who.user, lesson: lessonJson(lesson), setups, nav,
    progress: { startedAt: iso(p?.started_at), completedAt: iso(p?.completed_at), completed: !!p?.completed_at },
  });
}));

router.post(`${P}/lessons/:id/progress`, asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const staff = await isStaffReq(req);
  if (!(await visibleItem(req, res, "lesson", id, staff))) return;
  const parsed = z.object({ completed: z.boolean().optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const user = req.authUser!.name;
  const completed = parsed.data.completed;
  // completed не передан — просто отметка «начат» (просмотр), прохождение не трогаем.
  const { rows } = await pool.query<{ started_at: Date; completed_at: Date | null }>(
    `INSERT INTO academy_lesson_progress (user_name, lesson_id, completed_at)
     VALUES ($1, $2, CASE WHEN $3::boolean THEN now() ELSE NULL END)
     ON CONFLICT (user_name, lesson_id) DO UPDATE SET
       completed_at = CASE WHEN $3::boolean IS NULL THEN academy_lesson_progress.completed_at
                           WHEN $3::boolean THEN COALESCE(academy_lesson_progress.completed_at, now()) ELSE NULL END,
       updated_at = now()
     RETURNING started_at, completed_at`,
    [user, id, completed ?? null],
  );
  res.json({ lessonId: id, startedAt: iso(rows[0].started_at), completedAt: iso(rows[0].completed_at), completed: !!rows[0].completed_at });
}));

/* ─── Тесты ──────────────────────────────────────────────────────────────── */

type QuizRow = {
  id: number; module_id: number; title: string; description: string | null; questions: QuizQuestion[]; pass_pct: number; max_attempts: number | null;
  position: number; draft: boolean; created_at: Date; updated_at: Date; archived_at: Date | null;
};
type AttemptRow = { id: number; answers: Record<string, unknown>; results: unknown; score: string; max_score: string; pct: string; passed: boolean; submitted_at: Date };

const attemptLite = (a: AttemptRow) => ({ pct: num(a.pct) ?? 0, passed: a.passed, submittedAt: iso(a.submitted_at)! });

function quizQuestions(q: QuizRow): QuizQuestion[] {
  const v = normalizeQuestions(q.questions);
  return v.ok ? v.value : [];
}

router.get(`${P}/quizzes/:id`, asyncHandler(async (req, res): Promise<void> => {
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const who = await progressUser(req, res);
  if (!who) return;
  const info = await visibleItem(req, res, "quiz", id, who.staff);
  if (!info) return;
  const { rows } = await pool.query<QuizRow>(`SELECT * FROM academy_quizzes WHERE id = $1`, [id]);
  const quiz = rows[0];
  const questions = quizQuestions(quiz);
  const attempts = (await pool.query<AttemptRow>(
    `SELECT id, answers, results, score, max_score, pct, passed, submitted_at FROM academy_quiz_attempts WHERE quiz_id = $1 AND user_name = $2 ORDER BY submitted_at, id`,
    [id, who.user],
  )).rows;
  const state = attemptState(attempts.map(attemptLite), { passPct: quiz.pass_pct, maxAttempts: quiz.max_attempts });
  const last = attempts[attempts.length - 1];
  const lastGrade = last ? gradeQuiz(questions, last.answers, quiz.pass_pct) : null;
  res.json({
    user: who.user,
    quiz: { id: Number(quiz.id), moduleId: Number(quiz.module_id), title: quiz.title, description: quiz.description, passPct: quiz.pass_pct, maxAttempts: quiz.max_attempts, draft: quiz.draft, questions: publicQuestions(questions) },
    state,
    attempts: attempts.map((a) => ({ id: Number(a.id), score: num(a.score), maxScore: num(a.max_score), pct: num(a.pct), passed: a.passed, submittedAt: iso(a.submitted_at) })),
    last: last && lastGrade ? { id: Number(last.id), answers: last.answers, grade: { score: lastGrade.score, maxScore: lastGrade.maxScore, pct: lastGrade.pct, passed: lastGrade.passed }, feedback: feedbackFor(questions, lastGrade, state.revealAnswers) } : null,
    nav: await navFor(info.programId, "quiz", id, who.staff),
  });
}));

router.post(`${P}/quizzes/:id/attempts`, asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const staff = await isStaffReq(req);
  if (!(await visibleItem(req, res, "quiz", id, staff))) return;
  const parsed = z.object({ answers: z.record(z.string(), z.unknown()) }).safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "QUIZ_ANSWERS_REQUIRED");
  const user = req.authUser!.name;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Сериализуем попытки одного ученика по одному тесту — лимит попыток не обходится двойным кликом.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`academy-quiz:${id}:${user}`]);
    const quiz = (await client.query<QuizRow>(`SELECT * FROM academy_quizzes WHERE id = $1`, [id])).rows[0];
    const questions = quizQuestions(quiz);
    if (!questions.length) { await client.query("ROLLBACK"); return bad(res, "QUIZ_EMPTY", 409); }
    const prev = (await client.query<AttemptRow>(`SELECT id, answers, results, score, max_score, pct, passed, submitted_at FROM academy_quiz_attempts WHERE quiz_id = $1 AND user_name = $2`, [id, user])).rows;
    const cfg = { passPct: quiz.pass_pct, maxAttempts: quiz.max_attempts };
    if (!attemptState(prev.map(attemptLite), cfg).canAttempt) { await client.query("ROLLBACK"); return bad(res, "QUIZ_NO_ATTEMPTS", 409); }
    // Сохраняем только ответы на существующие вопросы (без мусора из тела запроса).
    const answers: Record<string, unknown> = {};
    for (const q of questions) {
      const v = parsed.data.answers[q.id];
      if (v === undefined) continue;
      answers[q.id] = Array.isArray(v) ? v.slice(0, 20).map((x) => String(x).slice(0, 40)) : typeof v === "number" ? v : String(v).slice(0, 60);
    }
    const grade = gradeQuiz(questions, answers, quiz.pass_pct);
    const ins = await client.query<AttemptRow>(
      `INSERT INTO academy_quiz_attempts (quiz_id, user_name, answers, results, score, max_score, pct, passed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, answers, results, score, max_score, pct, passed, submitted_at`,
      [id, user, JSON.stringify(answers), JSON.stringify(grade.results), grade.score, grade.maxScore, grade.pct, grade.passed],
    );
    await client.query("COMMIT");
    const state = attemptState([...prev, ins.rows[0]].map(attemptLite), cfg);
    res.status(201).json({
      attempt: { id: Number(ins.rows[0].id), submittedAt: iso(ins.rows[0].submitted_at) },
      grade: { score: grade.score, maxScore: grade.maxScore, pct: grade.pct, passed: grade.passed },
      feedback: feedbackFor(questions, grade, state.revealAnswers),
      state,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}));

/* ─── Задания и сдачи ────────────────────────────────────────────────────── */

type AssignmentRow = {
  id: number; module_id: number; title: string; body_md: string; rubric: unknown; pass_pct: number; min_trades: number; position: number;
  draft: boolean; created_at: Date; updated_at: Date; archived_at: Date | null;
};
type SubmissionRow = {
  id: number; assignment_id: number; user_name: string; body: string; url: string | null; trade_ids: number[] | null; status: string;
  scores: Record<string, number> | null; total: string | null; max_total: string | null; pct: string | null; passed: boolean | null;
  mentor_comment: string | null; graded_by: string | null; graded_at: Date | null; created_at: Date; updated_at: Date; archived_at: Date | null;
};

const rubricOf = (raw: unknown): RubricCriterion[] => {
  const v = normalizeRubric(raw);
  return v.ok ? v.value : [];
};

function assignmentJson(a: AssignmentRow) {
  return {
    id: Number(a.id), moduleId: Number(a.module_id), title: a.title, bodyMd: a.body_md, rubric: rubricOf(a.rubric), passPct: a.pass_pct,
    minTrades: a.min_trades, position: a.position, draft: a.draft, createdAt: iso(a.created_at), updatedAt: iso(a.updated_at), archivedAt: iso(a.archived_at),
  };
}

async function tradesByIds(ids: number[]) {
  if (!ids.length) return new Map<number, unknown>();
  const { rows } = await pool.query<{ id: number; date: string; ticker: string; side: string | null; setup: string | null; playbook_id: number | null; trader: string | null; net: unknown; r: unknown; result: string | null }>(
    `SELECT t.id, t.date, t.ticker, t.side, t.setup, t.playbook_id, t.trader, ${netPnlSql("t")} AS net, ${signedRSql("t")} AS r, t.result
       FROM trades t WHERE t.id = ANY($1) AND t.deleted_at IS NULL`,
    [ids],
  );
  return new Map(rows.map((r) => [Number(r.id), { id: Number(r.id), date: r.date, ticker: r.ticker, side: r.side, setup: r.setup, playbookId: r.playbook_id, trader: r.trader, net: num(r.net), r: num(r.r), result: r.result }]));
}

async function submissionsJson(rows: SubmissionRow[]) {
  const trades = await tradesByIds([...new Set(rows.flatMap((r) => (r.trade_ids ?? []).map(Number)))]);
  return rows.map((s) => ({
    id: Number(s.id), assignmentId: Number(s.assignment_id), userName: s.user_name, text: s.body, url: s.url,
    tradeIds: (s.trade_ids ?? []).map(Number),
    trades: (s.trade_ids ?? []).map((t) => trades.get(Number(t)) ?? { id: Number(t), missing: true }),
    status: s.status, scores: s.scores, total: num(s.total), maxTotal: num(s.max_total), pct: num(s.pct), passed: s.passed,
    mentorComment: s.mentor_comment, gradedBy: s.graded_by, gradedAt: iso(s.graded_at), createdAt: iso(s.created_at), updatedAt: iso(s.updated_at),
  }));
}

router.get(`${P}/assignments/:id`, asyncHandler(async (req, res): Promise<void> => {
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const who = await progressUser(req, res);
  if (!who) return;
  const info = await visibleItem(req, res, "assignment", id, who.staff);
  if (!info) return;
  const a = (await pool.query<AssignmentRow>(`SELECT * FROM academy_assignments WHERE id = $1`, [id])).rows[0];
  const all = who.staff && qStr(req.query.all) === "1";
  const subs = (await pool.query<SubmissionRow>(
    `SELECT * FROM academy_submissions WHERE assignment_id = $1 AND archived_at IS NULL ${all ? "" : "AND user_name = $2"} ORDER BY created_at DESC, id DESC LIMIT 300`,
    all ? [id] : [id, who.user],
  )).rows;
  res.json({ user: who.user, all, assignment: assignmentJson(a), submissions: await submissionsJson(subs), nav: await navFor(info.programId, "assignment", id, who.staff) });
}));

const submissionBody = z.object({
  text: z.string().max(20000).optional().default(""),
  url: z.string().max(2000).optional().nullable(),
  tradeIds: z.array(z.union([z.number(), z.string()])).max(50).optional().default([]),
});

/** Проверяет, что все сделки принадлежат ученику; возвращает ошибку или null. */
/** Trade ids that are not the user's (first 10, comma-separated) or null. */
async function foreignTrades(ids: number[], user: string): Promise<string | null> {
  if (!ids.length) return null;
  const { rows } = await pool.query<{ id: number }>(`SELECT id FROM trades WHERE id = ANY($1) AND trader = $2 AND deleted_at IS NULL`, [ids, user]);
  const own = new Set(rows.map((r) => Number(r.id)));
  const foreign = ids.filter((i) => !own.has(i));
  return foreign.length ? foreign.slice(0, 10).join(", ") : null;
}

router.post(`${P}/assignments/:id/submissions`, asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const staff = await isStaffReq(req);
  if (!(await visibleItem(req, res, "assignment", id, staff))) return;
  const parsed = submissionBody.safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const user = req.authUser!.name;
  const a = (await pool.query<AssignmentRow>(`SELECT * FROM academy_assignments WHERE id = $1`, [id])).rows[0];
  const rawUrl = parsed.data.url?.trim() || "";
  const url = rawUrl ? safeHttpUrl(rawUrl) : null;
  if (rawUrl && !url) return bad(res, "INVALID_URL");
  const tradeIds = parseTradeIds(parsed.data.tradeIds);
  const chk = checkSubmission({ text: parsed.data.text, url, tradeIds }, a.min_trades);
  if (!chk.ok) return bad(res, chk.code, 400, chk.params);
  const foreign = await foreignTrades(tradeIds, user);
  if (foreign) return bad(res, "TRADES_NOT_YOURS", 400, { ids: foreign });
  const { rows } = await pool.query<SubmissionRow>(
    `INSERT INTO academy_submissions (assignment_id, user_name, body, url, trade_ids) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [id, user, parsed.data.text.trim(), url, tradeIds],
  );
  const sub = rows[0];
  const mentors = await mentorsOf(user);
  await notifyUsers(mentors, {
    type: "academy_submitted",
    // Text as data (lib/notificationRenderers/academyContent.ts): rendered in each reader's language.
    params: { title: a.title, user, n: tradeIds.length },
    link: learnLink.assignment(id, `&submission=${sub.id}`),
    entityType: "academy_submission", entityId: sub.id, actor: user, source: "academy",
  }, user);
  res.status(201).json({ submission: (await submissionsJson([sub]))[0], notified: mentors.length });
}));

router.patch(`${P}/submissions/:id`, asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const user = req.authUser!.name;
  const cur = (await pool.query<SubmissionRow>(`SELECT * FROM academy_submissions WHERE id = $1 AND archived_at IS NULL`, [id])).rows[0];
  if (!cur || cur.user_name !== user) return bad(res, "NOT_FOUND", 404);
  if (cur.status !== "submitted") return bad(res, "SUBMISSION_GRADED_EDIT", 409);
  const parsed = submissionBody.safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const a = (await pool.query<AssignmentRow>(`SELECT * FROM academy_assignments WHERE id = $1`, [cur.assignment_id])).rows[0];
  const rawUrl = parsed.data.url?.trim() || "";
  const url = rawUrl ? safeHttpUrl(rawUrl) : null;
  if (rawUrl && !url) return bad(res, "INVALID_URL");
  const tradeIds = parseTradeIds(parsed.data.tradeIds);
  const chk = checkSubmission({ text: parsed.data.text, url, tradeIds }, a.min_trades);
  if (!chk.ok) return bad(res, chk.code, 400, chk.params);
  const foreign = await foreignTrades(tradeIds, user);
  if (foreign) return bad(res, "TRADES_NOT_YOURS", 400, { ids: foreign });
  const { rows } = await pool.query<SubmissionRow>(
    `UPDATE academy_submissions SET body = $2, url = $3, trade_ids = $4, updated_at = now() WHERE id = $1 AND status = 'submitted' RETURNING *`,
    [id, parsed.data.text.trim(), url, tradeIds],
  );
  if (!rows[0]) return bad(res, "SUBMISSION_GRADED", 409);
  res.json({ submission: (await submissionsJson(rows))[0] });
}));

router.post(`${P}/submissions/:id/archive`, asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const staff = await isStaffReq(req);
  const cur = (await pool.query<SubmissionRow>(`SELECT * FROM academy_submissions WHERE id = $1 AND archived_at IS NULL`, [id])).rows[0];
  if (!cur || (!staff && cur.user_name !== req.authUser!.name)) return bad(res, "NOT_FOUND", 404);
  if (!staff && cur.status !== "submitted") return bad(res, "SUBMISSION_GRADED_WITHDRAW", 409);
  await pool.query(`UPDATE academy_submissions SET archived_at = now(), updated_at = now() WHERE id = $1`, [id]);
  res.json({ ok: true, id });
}));

router.get(`${P}/my-trades`, asyncHandler(async (req, res): Promise<void> => {
  const scoped = await scopeTrader(req, qStr(req.query.user, 120) || null);
  if (scoped === undefined) return bad(res, "AUTH_REQUIRED", 401);
  const user = scoped ?? req.authUser!.name;
  const q = qStr(req.query.q, 60);
  const limit = Math.min(200, Math.max(1, qInt(req.query.limit) ?? 60));
  const params: unknown[] = [user];
  let filter = "";
  if (q) { params.push(`%${q}%`); filter = `AND (t.ticker ILIKE $2 OR COALESCE(t.setup, '') ILIKE $2 OR t.date LIKE $2)`; }
  params.push(limit);
  const { rows } = await pool.query<{ id: number; date: string; ticker: string; side: string | null; setup: string | null; playbook_id: number | null; net: unknown; r: unknown; result: string | null }>(
    `SELECT t.id, t.date, t.ticker, t.side, t.setup, t.playbook_id, ${netPnlSql("t")} AS net, ${signedRSql("t")} AS r, t.result
       FROM trades t WHERE t.trader = $1 AND t.deleted_at IS NULL ${filter}
      ORDER BY t.date DESC, t.id DESC LIMIT $${params.length}`,
    params,
  );
  res.json({ user, trades: rows.map((r) => ({ id: Number(r.id), date: r.date, ticker: r.ticker, side: r.side, setup: r.setup, playbookId: r.playbook_id, net: num(r.net), r: num(r.r), result: r.result })) });
}));

/* ─── Проверка наставником ───────────────────────────────────────────────── */

async function cohortUsers(cohortId: number): Promise<string[] | null> {
  if (!(await tableExists("academy_enrollments"))) return null;
  try {
    const { rows } = await pool.query<{ user_name: string }>(
      `SELECT DISTINCT user_name FROM academy_enrollments WHERE cohort_id = $1 AND archived_at IS NULL`, [cohortId]);
    return rows.map((r) => r.user_name);
  } catch (err) {
    logger.debug({ err }, "academy: enrollments read failed");
    return null;
  }
}

router.get(`${P}/review-queue`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const status = qStr(req.query.status) || "submitted";
  const cohortId = qInt(req.query.cohortId);
  const params: unknown[] = [];
  const where = ["s.archived_at IS NULL"];
  if (status !== "all") {
    if (!["submitted", "graded", "returned"].includes(status)) return bad(res, "VALIDATION");
    params.push(status); where.push(`s.status = $${params.length}`);
  }
  if (cohortId) {
    const users = await cohortUsers(cohortId);
    if (users) { params.push(users); where.push(`s.user_name = ANY($${params.length})`); }
  }
  const { rows } = await pool.query<SubmissionRow & { assignment_title: string; program_id: number; program_title: string; module_title: string; rubric: unknown; pass_pct: number }>(
    `SELECT s.*, a.title AS assignment_title, a.rubric, a.pass_pct, m.title AS module_title, p.id AS program_id, p.title AS program_title
       FROM academy_submissions s
       JOIN academy_assignments a ON a.id = s.assignment_id
       JOIN academy_modules m ON m.id = a.module_id
       JOIN academy_programs p ON p.id = m.program_id
      WHERE ${where.join(" AND ")}
      ORDER BY ${status === "submitted" ? "s.created_at ASC" : "COALESCE(s.graded_at, s.created_at) DESC"}, s.id
      LIMIT 300`,
    params,
  );
  const subs = await submissionsJson(rows);
  res.json({
    status,
    items: rows.map((r, i) => ({
      ...subs[i], assignmentTitle: r.assignment_title, moduleTitle: r.module_title, programId: Number(r.program_id), programTitle: r.program_title,
      rubric: rubricOf(r.rubric), passPct: r.pass_pct,
    })),
  });
}));

router.post(`${P}/submissions/:id/grade`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const parsed = z.object({
    decision: z.enum(["graded", "returned"]),
    scores: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
    comment: z.string().max(10000).optional().default(""),
  }).safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const cur = (await pool.query<SubmissionRow>(`SELECT * FROM academy_submissions WHERE id = $1 AND archived_at IS NULL`, [id])).rows[0];
  if (!cur) return bad(res, "SUBMISSION_NOT_FOUND", 404);
  const a = (await pool.query<AssignmentRow>(`SELECT * FROM academy_assignments WHERE id = $1`, [cur.assignment_id])).rows[0];
  const rubric = rubricOf(a.rubric);
  const comment = parsed.data.comment.trim();
  const mentor = req.authUser!.name;
  let grade: ReturnType<typeof gradeRubric> | null = null;
  if (parsed.data.decision === "graded") {
    if (!rubric.length) return bad(res, "ASSIGNMENT_NO_RUBRIC", 409);
    grade = gradeRubric(rubric, parsed.data.scores ?? {}, a.pass_pct);
    if (grade.missing.length) return bad(res, "RUBRIC_INCOMPLETE", 400, { missing: grade.missing.map((k) => rubric.find((c) => c.key === k)?.label ?? k).join(", ") });
  } else if (!comment) {
    return bad(res, "RETURN_COMMENT_REQUIRED");
  }
  const { rows } = await pool.query<SubmissionRow>(
    `UPDATE academy_submissions SET status = $2, scores = $3, total = $4, max_total = $5, pct = $6, passed = $7,
            mentor_comment = $8, graded_by = $9, graded_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, parsed.data.decision, grade ? JSON.stringify(grade.scores) : null, grade?.total ?? null, grade?.maxTotal ?? null, grade?.pct ?? null,
      grade ? grade.passed : null, comment || null, mentor],
  );
  const sub = rows[0];
  const params = parsed.data.decision === "returned"
    ? { variant: "returned", title: a.title, mentor, comment: comment.slice(0, 300) }
    : { variant: grade!.passed ? "passed" : "failed", title: a.title, mentor, comment: comment ? comment.slice(0, 300) : null, total: grade!.total, max: grade!.maxTotal, pct: Math.round(grade!.pct) };
  await notifyUser({
    userName: cur.user_name, type: "academy_graded", params,
    severity: parsed.data.decision === "returned" || (grade && !grade.passed) ? "warn" : "info",
    link: learnLink.assignment(Number(a.id), `&submission=${id}`), entityType: "academy_submission", entityId: id, actor: mentor, source: "academy",
  });
  res.json({ submission: (await submissionsJson([sub]))[0] });
}));

/* ─── Прогресс учеников и когорт ─────────────────────────────────────────── */

router.get(`${P}/progress`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const programId = qInt(req.query.programId);
  const cohortId = qInt(req.query.cohortId);
  const programs = await loadPrograms({ staff: true });
  const program = programId ? programs.find((p) => p.id === programId) : programs[0];
  if (!program) { res.json({ program: null, programs: [], modules: [], students: [], summary: cohortSummary([], new Date().toISOString()), enrollmentsAvailable: await tableExists("academy_enrollments") }); return; }
  const enrollmentsAvailable = await tableExists("academy_enrollments");
  const [modules, items] = await Promise.all([loadModules([program.id]), loadItems([program.id], { drafts: false })]);
  const pItems = toProgressItems(items);

  // Кого показывать: ученики когорты (F2) → все зачисленные + все, у кого есть активность в этой программе.
  let users: string[] = [];
  const stageOf = new Map<string, string | null>();
  if (cohortId) {
    users = (await cohortUsers(cohortId)) ?? [];
  } else {
    if (enrollmentsAvailable) {
      try {
        const { rows } = await pool.query<{ user_name: string; stage: string | null }>(
          `SELECT DISTINCT ON (user_name) user_name, stage FROM academy_enrollments WHERE archived_at IS NULL ORDER BY user_name, joined_on DESC NULLS LAST`);
        for (const r of rows) { users.push(r.user_name); stageOf.set(r.user_name, r.stage); }
      } catch (err) {
        logger.debug({ err }, "academy: enrollments list failed");
      }
    }
    const lessonIds = items.filter((i) => i.kind === "lesson").map((i) => i.id);
    const quizIds = items.filter((i) => i.kind === "quiz").map((i) => i.id);
    const asgIds = items.filter((i) => i.kind === "assignment").map((i) => i.id);
    const { rows } = await pool.query<{ user_name: string }>(
      `SELECT user_name FROM academy_lesson_progress WHERE lesson_id = ANY($1)
       UNION SELECT user_name FROM academy_quiz_attempts WHERE quiz_id = ANY($2)
       UNION SELECT user_name FROM academy_submissions WHERE assignment_id = ANY($3) AND archived_at IS NULL`,
      [lessonIds, quizIds, asgIds],
    );
    for (const r of rows) if (!users.includes(r.user_name)) users.push(r.user_name);
  }
  users.sort((a, b) => a.localeCompare(b, "ru"));
  const facts = await loadFacts(users);
  const students = users.map((u) => {
    const f = facts.get(u)!;
    const p = computeProgress(pItems, modules.map((m) => m.id), f);
    return {
      userName: u, stage: stageOf.get(u) ?? null, pct: p.pct, done: p.done, total: p.total, byKind: p.byKind,
      modules: p.modules, next: p.next, lastActivity: f.lastActivity,
      quizBest: Object.fromEntries(items.filter((i) => i.kind === "quiz").map((i) => [i.id, f.quizzes.get(i.id)?.bestPct ?? null])),
      pendingReviews: items.filter((i) => i.kind === "assignment" && f.assignments.get(i.id)?.status === "submitted").length,
    };
  });
  res.json({
    program: programJson(program),
    programs: programs.map((p) => ({ id: p.id, title: p.title, published: p.published, stage: normalizeStage(p.stage) })),
    cohortId, enrollmentsAvailable,
    modules: modules.map((m) => ({ id: m.id, title: m.title, items: pItems.filter((i) => i.moduleId === m.id).length })),
    quizzes: items.filter((i) => i.kind === "quiz").map((i) => ({ id: i.id, title: i.title, passPct: i.pass_pct })),
    students,
    summary: cohortSummary(students, new Date().toISOString()),
  });
}));

/* ─── Админка контента ───────────────────────────────────────────────────── */

router.get(`${P}/setups`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  const { rows } = await pool.query<{ id: number; name: string; folder: string | null; setup_type: string | null; trader: string | null }>(
    `SELECT id, name, folder, setup_type, trader FROM playbook WHERE deleted_at IS NULL ORDER BY folder NULLS LAST, name LIMIT 1000`);
  res.json({ setups: rows.map((r) => ({ id: Number(r.id), name: r.name, folder: r.folder, setupType: r.setup_type, trader: r.trader })) });
}));

router.get(`${P}/admin/tree`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const archived = qStr(req.query.archived) === "1";
  const programs = await loadPrograms({ staff: true, archived });
  const programId = qInt(req.query.programId) ?? programs.find((p) => !p.archived_at)?.id ?? null;
  const program = programs.find((p) => p.id === programId) ?? null;
  if (!program) { res.json({ programs: programs.map(programJson), program: null, modules: [] }); return; }
  const modules = await loadModules([program.id], archived);
  const moduleIds = modules.map((m) => m.id);
  const [lessons, quizzes, assignments] = moduleIds.length
    ? await Promise.all([
      pool.query<LessonRow>(`SELECT * FROM academy_lessons WHERE module_id = ANY($1) ${archived ? "" : "AND archived_at IS NULL"}`, [moduleIds]),
      pool.query<QuizRow>(`SELECT * FROM academy_quizzes WHERE module_id = ANY($1) ${archived ? "" : "AND archived_at IS NULL"}`, [moduleIds]),
      pool.query<AssignmentRow>(`SELECT * FROM academy_assignments WHERE module_id = ANY($1) ${archived ? "" : "AND archived_at IS NULL"}`, [moduleIds]),
    ])
    : [{ rows: [] as LessonRow[] }, { rows: [] as QuizRow[] }, { rows: [] as AssignmentRow[] }];
  const items = [
    ...lessons.rows.map((l) => ({ kind: "lesson" as const, ...lessonJson(l) })),
    ...quizzes.rows.map((q) => ({
      kind: "quiz" as const, id: Number(q.id), moduleId: Number(q.module_id), title: q.title, description: q.description, questions: quizQuestions(q),
      passPct: q.pass_pct, maxAttempts: q.max_attempts, position: q.position, draft: q.draft, updatedAt: iso(q.updated_at), archivedAt: iso(q.archived_at),
    })),
    ...assignments.rows.map((a) => ({ kind: "assignment" as const, ...assignmentJson(a) })),
  ].sort((a, b) => a.position - b.position || a.id - b.id);
  res.json({
    programs: programs.map(programJson),
    program: programJson(program),
    modules: modules.map((m) => ({ id: m.id, title: m.title, description: m.description, position: m.position, archivedAt: iso(m.archived_at), items: items.filter((i) => i.moduleId === m.id) })),
  });
}));

const programBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional().nullable(),
  level: z.string().max(60).optional().nullable(),
  stage: z.string().max(20).optional().nullable(),
  published: z.boolean().optional(),
});

router.post(`${P}/programs`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const parsed = programBody.safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "NAME_REQUIRED");
  const d = parsed.data;
  const base = slugify(d.title);
  const { rows: ex } = await pool.query<{ slug: string }>(`SELECT slug FROM academy_programs WHERE slug LIKE $1`, [`${base}%`]);
  let slug = base;
  for (let i = 2; ex.some((r) => r.slug === slug); i++) slug = `${base}-${i}`;
  const { rows } = await pool.query<ProgramRow>(
    `INSERT INTO academy_programs (slug, title, description, level, stage, published, position, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE((SELECT MAX(position) FROM academy_programs), 0) + 10, $7) RETURNING *`,
    [slug, d.title, d.description ?? null, d.level ?? null, normalizeStage(d.stage), d.published ?? false, req.authUser!.name],
  );
  res.status(201).json({ program: programJson(rows[0]) });
}));

router.patch(`${P}/programs/:id`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const parsed = programBody.partial().safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const d = parsed.data;
  const { rows } = await pool.query<ProgramRow>(
    `UPDATE academy_programs SET
       title = COALESCE($2, title),
       description = CASE WHEN $3::boolean THEN $4 ELSE description END,
       level = CASE WHEN $5::boolean THEN $6 ELSE level END,
       stage = CASE WHEN $7::boolean THEN $8 ELSE stage END,
       published = COALESCE($9, published),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, d.title ?? null, d.description !== undefined, d.description ?? null, d.level !== undefined, d.level ?? null,
      d.stage !== undefined, normalizeStage(d.stage), d.published ?? null],
  );
  if (!rows[0]) return bad(res, "NOT_FOUND", 404);
  res.json({ program: programJson(rows[0]) });
}));

const moduleBody = z.object({ programId: z.number().int().positive(), title: z.string().trim().min(1).max(200), description: z.string().max(2000).optional().nullable() });

router.post(`${P}/modules`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const parsed = moduleBody.safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const d = parsed.data;
  const { rows } = await pool.query<ModuleRow>(
    `INSERT INTO academy_modules (program_id, title, description, position)
     SELECT $1, $2, $3, COALESCE((SELECT MAX(position) FROM academy_modules WHERE program_id = $1), 0) + 10
      WHERE EXISTS (SELECT 1 FROM academy_programs WHERE id = $1) RETURNING id, program_id, title, description, position, archived_at`,
    [d.programId, d.title, d.description ?? null],
  );
  if (!rows[0]) return bad(res, "PROGRAM_NOT_FOUND", 404);
  res.status(201).json({ module: rows[0] });
}));

router.patch(`${P}/modules/:id`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const parsed = moduleBody.omit({ programId: true }).partial().safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const d = parsed.data;
  const { rows } = await pool.query<ModuleRow>(
    `UPDATE academy_modules SET title = COALESCE($2, title), description = CASE WHEN $3::boolean THEN $4 ELSE description END, updated_at = now()
      WHERE id = $1 RETURNING id, program_id, title, description, position, archived_at`,
    [id, d.title ?? null, d.description !== undefined, d.description ?? null],
  );
  if (!rows[0]) return bad(res, "NOT_FOUND", 404);
  res.json({ module: rows[0] });
}));

const lessonBody = z.object({
  moduleId: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().max(1000).optional().nullable(),
  bodyMd: z.string().max(200_000).optional(),
  videoUrl: z.string().max(2000).optional().nullable(),
  attachments: z.array(z.object({ title: z.string().max(200).optional(), url: z.string().max(2000) })).max(20).optional(),
  durationMin: z.number().int().min(0).max(600).optional().nullable(),
  playbookIds: z.array(z.number().int().positive()).max(50).optional(),
  setupNames: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  draft: z.boolean().optional(),
});

/** Видео: пусто → null; иначе только allow-list (YouTube/Vimeo/Loom). */
function checkVideo(raw: string | null | undefined): { ok: true; value: string | null } | { ok: false } {
  const v = raw?.trim();
  if (!v) return { ok: true, value: null };
  return videoEmbed(v) ? { ok: true, value: v } : { ok: false };
}

async function validPlaybookIds(ids: number[] | undefined): Promise<number[] | undefined> {
  if (!ids) return undefined;
  if (!ids.length) return [];
  const { rows } = await pool.query<{ id: number }>(`SELECT id FROM playbook WHERE id = ANY($1) AND deleted_at IS NULL`, [ids]);
  const ok = new Set(rows.map((r) => Number(r.id)));
  return ids.filter((i, k) => ok.has(i) && ids.indexOf(i) === k);
}

const nextPos = (moduleId: number) => pool.query<{ p: number }>(
  `SELECT COALESCE(MAX(p), 0) + 10 AS p FROM (
     SELECT position AS p FROM academy_lessons WHERE module_id = $1 UNION ALL
     SELECT position FROM academy_quizzes WHERE module_id = $1 UNION ALL
     SELECT position FROM academy_assignments WHERE module_id = $1) x`, [moduleId]).then((r) => Number(r.rows[0].p));

async function moduleExists(id: number): Promise<boolean> {
  return (await pool.query(`SELECT 1 FROM academy_modules WHERE id = $1`, [id])).rowCount! > 0;
}

router.post(`${P}/lessons`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const parsed = lessonBody.safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const d = parsed.data;
  if (!(await moduleExists(d.moduleId))) return bad(res, "MODULE_NOT_FOUND", 404);
  const video = checkVideo(d.videoUrl);
  if (!video.ok) return bad(res, "VIDEO_URL_UNSUPPORTED");
  const { rows } = await pool.query<LessonRow>(
    `INSERT INTO academy_lessons (module_id, title, summary, body_md, video_url, attachments, duration_min, playbook_ids, setup_names, position, draft, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [d.moduleId, d.title, d.summary ?? null, d.bodyMd ?? "", video.value, JSON.stringify(normalizeAttachments(d.attachments ?? [])), d.durationMin ?? null,
      (await validPlaybookIds(d.playbookIds)) ?? [], d.setupNames ?? [], await nextPos(d.moduleId), d.draft ?? true, req.authUser!.name],
  );
  res.status(201).json({ lesson: lessonJson(rows[0]) });
}));

router.patch(`${P}/lessons/:id`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const parsed = lessonBody.omit({ moduleId: true }).partial().safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const d = parsed.data;
  const video = d.videoUrl !== undefined ? checkVideo(d.videoUrl) : ({ ok: true, value: null } as const);
  if (!video.ok) return bad(res, "VIDEO_URL_UNSUPPORTED");
  const pb = await validPlaybookIds(d.playbookIds);
  const { rows } = await pool.query<LessonRow>(
    `UPDATE academy_lessons SET
       title = COALESCE($2, title),
       summary = CASE WHEN $3::boolean THEN $4 ELSE summary END,
       body_md = COALESCE($5, body_md),
       video_url = CASE WHEN $6::boolean THEN $7 ELSE video_url END,
       attachments = COALESCE($8::jsonb, attachments),
       duration_min = CASE WHEN $9::boolean THEN $10 ELSE duration_min END,
       playbook_ids = COALESCE($11::int[], playbook_ids),
       setup_names = COALESCE($12::text[], setup_names),
       draft = COALESCE($13, draft),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, d.title ?? null, d.summary !== undefined, d.summary ?? null, d.bodyMd ?? null, d.videoUrl !== undefined, video.value,
      d.attachments ? JSON.stringify(normalizeAttachments(d.attachments)) : null, d.durationMin !== undefined, d.durationMin ?? null,
      pb ?? null, d.setupNames ?? null, d.draft ?? null],
  );
  if (!rows[0]) return bad(res, "NOT_FOUND", 404);
  res.json({ lesson: lessonJson(rows[0]) });
}));

const quizBody = z.object({
  moduleId: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional().nullable(),
  questions: z.array(z.unknown()).max(100).optional(),
  passPct: z.number().min(0).max(100).optional(),
  maxAttempts: z.number().int().min(1).max(100).optional().nullable(),
  draft: z.boolean().optional(),
});

function quizAdminJson(q: QuizRow) {
  return { kind: "quiz" as const, id: Number(q.id), moduleId: Number(q.module_id), title: q.title, description: q.description, questions: quizQuestions(q), passPct: q.pass_pct, maxAttempts: q.max_attempts, position: q.position, draft: q.draft, updatedAt: iso(q.updated_at), archivedAt: iso(q.archived_at) };
}

router.post(`${P}/quizzes`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const parsed = quizBody.safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const d = parsed.data;
  if (!(await moduleExists(d.moduleId))) return bad(res, "MODULE_NOT_FOUND", 404);
  let questions: QuizQuestion[] = [];
  if (d.questions && d.questions.length) {
    const v = normalizeQuestions(d.questions, langOf(req));
    if (!v.ok) return void invalidContent(res, v.errors);
    questions = v.value;
  }
  const { rows } = await pool.query<QuizRow>(
    `INSERT INTO academy_quizzes (module_id, title, description, questions, pass_pct, max_attempts, position, draft, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [d.moduleId, d.title, d.description ?? null, JSON.stringify(questions), clampPct(d.passPct), d.maxAttempts ?? null, await nextPos(d.moduleId), d.draft ?? true, req.authUser!.name],
  );
  res.status(201).json({ quiz: quizAdminJson(rows[0]) });
}));

router.patch(`${P}/quizzes/:id`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const parsed = quizBody.omit({ moduleId: true }).partial().safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const d = parsed.data;
  let questions: string | null = null;
  if (d.questions !== undefined) {
    const v = normalizeQuestions(d.questions, langOf(req));
    if (!v.ok) return void invalidContent(res, v.errors);
    questions = JSON.stringify(v.value);
  }
  const { rows } = await pool.query<QuizRow>(
    `UPDATE academy_quizzes SET
       title = COALESCE($2, title),
       description = CASE WHEN $3::boolean THEN $4 ELSE description END,
       questions = COALESCE($5::jsonb, questions),
       pass_pct = COALESCE($6, pass_pct),
       max_attempts = CASE WHEN $7::boolean THEN $8 ELSE max_attempts END,
       draft = COALESCE($9, draft),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, d.title ?? null, d.description !== undefined, d.description ?? null, questions, d.passPct != null ? clampPct(d.passPct) : null,
      d.maxAttempts !== undefined, d.maxAttempts ?? null, d.draft ?? null],
  );
  if (!rows[0]) return bad(res, "NOT_FOUND", 404);
  res.json({ quiz: quizAdminJson(rows[0]) });
}));

const assignmentBody = z.object({
  moduleId: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  bodyMd: z.string().max(100_000).optional(),
  rubric: z.array(z.unknown()).max(20).optional(),
  passPct: z.number().min(0).max(100).optional(),
  minTrades: z.number().int().min(0).max(50).optional(),
  draft: z.boolean().optional(),
});

router.post(`${P}/assignments`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const parsed = assignmentBody.safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const d = parsed.data;
  if (!(await moduleExists(d.moduleId))) return bad(res, "MODULE_NOT_FOUND", 404);
  // Default rubric of a new assignment: stored data, in the author's language (staff edit it afterwards).
  let rubric: RubricCriterion[] = [{ key: "quality", label: academyContentT.tFor(langOf(req))("defaultRubric"), maxPoints: 10 }];
  if (d.rubric && d.rubric.length) {
    const v = normalizeRubric(d.rubric, langOf(req));
    if (!v.ok) return void invalidContent(res, v.errors);
    rubric = v.value;
  }
  const { rows } = await pool.query<AssignmentRow>(
    `INSERT INTO academy_assignments (module_id, title, body_md, rubric, pass_pct, min_trades, position, draft, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [d.moduleId, d.title, d.bodyMd ?? "", JSON.stringify(rubric), clampPct(d.passPct, 70), d.minTrades ?? 0, await nextPos(d.moduleId), d.draft ?? true, req.authUser!.name],
  );
  res.status(201).json({ assignment: { kind: "assignment", ...assignmentJson(rows[0]) } });
}));

router.patch(`${P}/assignments/:id`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const parsed = assignmentBody.omit({ moduleId: true }).partial().safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const d = parsed.data;
  let rubric: string | null = null;
  if (d.rubric !== undefined) {
    const v = normalizeRubric(d.rubric, langOf(req));
    if (!v.ok) return void invalidContent(res, v.errors);
    rubric = JSON.stringify(v.value);
  }
  const { rows } = await pool.query<AssignmentRow>(
    `UPDATE academy_assignments SET
       title = COALESCE($2, title), body_md = COALESCE($3, body_md), rubric = COALESCE($4::jsonb, rubric),
       pass_pct = COALESCE($5, pass_pct), min_trades = COALESCE($6, min_trades), draft = COALESCE($7, draft), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, d.title ?? null, d.bodyMd ?? null, rubric, d.passPct != null ? clampPct(d.passPct, 70) : null, d.minTrades ?? null, d.draft ?? null],
  );
  if (!rows[0]) return bad(res, "NOT_FOUND", 404);
  res.json({ assignment: { kind: "assignment", ...assignmentJson(rows[0]) } });
}));

for (const action of ["archive", "restore"] as const) {
  router.post(`${P}/:kind/:id/${action}`, asyncHandler(async (req, res): Promise<void> => {
    const table = ARCHIVE_TABLE[String(req.params.kind)];
    if (!table) return bad(res, "VALIDATION", 404);
    if (!(await requireStaff(req, res))) return;
    await ensureAcademyContentTables();
    const id = idParam(req);
    if (!id) return bad(res, "INVALID_ID");
    const { rowCount } = await pool.query(
      `UPDATE ${table} SET archived_at = ${action === "archive" ? "COALESCE(archived_at, now())" : "NULL"}, updated_at = now() WHERE id = $1`, [id]);
    if (!rowCount) return bad(res, "NOT_FOUND", 404);
    res.json({ ok: true, kind: req.params.kind, id, archived: action === "archive" });
  }));
}

router.post(`${P}/programs/:id/reorder`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const parsed = z.object({ moduleIds: z.array(z.number().int().positive()).max(200) }).safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const cur = await loadModules([id]);
  const order = applyIdOrder(cur.map((m) => m.id), parsed.data.moduleIds);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const o of order) await client.query(`UPDATE academy_modules SET position = $2, updated_at = now() WHERE id = $1`, [o.id, o.position]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true, order });
}));

router.post(`${P}/programs-order`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const parsed = z.object({ programIds: z.array(z.number().int().positive()).max(200) }).safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const cur = await loadPrograms({ staff: true });
  const order = applyIdOrder(cur.map((p) => p.id), parsed.data.programIds);
  for (const o of order) await pool.query(`UPDATE academy_programs SET position = $2 WHERE id = $1`, [o.id, o.position]);
  res.json({ ok: true, order });
}));

const itemRef = z.object({ kind: z.enum(["lesson", "quiz", "assignment"]), id: z.number().int().positive() });

router.post(`${P}/modules/:id/reorder`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const id = idParam(req);
  if (!id) return bad(res, "INVALID_ID");
  const parsed = z.object({ items: z.array(itemRef).max(300) }).safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const { rows } = await pool.query<{ kind: ItemKind; id: number; position: number }>(
    `SELECT 'lesson'::text AS kind, id, position FROM academy_lessons WHERE module_id = $1 AND archived_at IS NULL
     UNION ALL SELECT 'quiz', id, position FROM academy_quizzes WHERE module_id = $1 AND archived_at IS NULL
     UNION ALL SELECT 'assignment', id, position FROM academy_assignments WHERE module_id = $1 AND archived_at IS NULL`, [id]);
  const order = applyOrder(rows.map((r) => ({ ...r, id: Number(r.id) })), parsed.data.items);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const o of order) await client.query(`UPDATE ${KIND_TABLE[o.kind]} SET position = $2, updated_at = now() WHERE id = $1`, [o.id, o.position]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true, order });
}));

router.post(`${P}/items/move`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const parsed = itemRef.extend({ moduleId: z.number().int().positive() }).safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "VALIDATION");
  const d = parsed.data;
  if (!(await moduleExists(d.moduleId))) return bad(res, "MODULE_NOT_FOUND", 404);
  const pos = await nextPos(d.moduleId);
  const { rowCount } = await pool.query(`UPDATE ${KIND_TABLE[d.kind]} SET module_id = $2, position = $3, updated_at = now() WHERE id = $1`, [d.id, d.moduleId, pos]);
  if (!rowCount) return bad(res, "NOT_FOUND", 404);
  res.json({ ok: true, kind: d.kind, id: d.id, moduleId: d.moduleId, position: pos });
}));

/* ─── Демо-курс ──────────────────────────────────────────────────────────── */

/**
 * Идемпотентно: программа по slug, модули и элементы по seed_key. Существующее (в том числе отредактированное
 * или архивное) не трогается — создаются только недостающие части. Уроки привязываются к сетапам плейбука по
 * совпадению названия (только чтение playbook).
 */
async function seedDemo(actor: string) {
  const created = { programs: 0, modules: 0, lessons: 0, quizzes: 0, assignments: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('academy-seed-demo'))`);
    const seed = DEMO_PROGRAM;
    let programId: number;
    const ex = await client.query<{ id: number }>(`SELECT id FROM academy_programs WHERE slug = $1`, [seed.slug]);
    if (ex.rows[0]) programId = Number(ex.rows[0].id);
    else {
      const ins = await client.query<{ id: number }>(
        `INSERT INTO academy_programs (slug, title, description, level, stage, published, position, created_by)
         VALUES ($1, $2, $3, $4, $5, true, COALESCE((SELECT MAX(position) FROM academy_programs), 0) + 10, $6) RETURNING id`,
        [seed.slug, seed.title, seed.description, seed.level, seed.stage, actor],
      );
      programId = Number(ins.rows[0].id);
      created.programs++;
    }
    const playbook = (await client.query<{ id: number; name: string }>(`SELECT id, name FROM playbook WHERE deleted_at IS NULL`)).rows;
    for (const [mi, m] of seed.modules.entries()) {
      let moduleId: number;
      const em = await client.query<{ id: number }>(`SELECT id FROM academy_modules WHERE program_id = $1 AND seed_key = $2`, [programId, m.key]);
      if (em.rows[0]) moduleId = Number(em.rows[0].id);
      else {
        const ins = await client.query<{ id: number }>(
          `INSERT INTO academy_modules (program_id, title, description, position, seed_key) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [programId, m.title, m.description, (mi + 1) * 10, m.key],
        );
        moduleId = Number(ins.rows[0].id);
        created.modules++;
      }
      for (const [ii, it] of m.items.entries()) {
        const table = KIND_TABLE[it.kind];
        const found = await client.query(
          `SELECT x.id FROM ${table} x JOIN academy_modules mm ON mm.id = x.module_id WHERE mm.program_id = $1 AND x.seed_key = $2`, [programId, it.key]);
        if (found.rowCount) continue;
        const pos = (ii + 1) * 10;
        if (it.kind === "lesson") {
          const names = (it.setupNames ?? []).map((s) => s.toLowerCase());
          const pbIds = playbook.filter((p) => names.some((n) => n.length >= 3 && p.name.toLowerCase().includes(n))).map((p) => Number(p.id)).slice(0, 20);
          await client.query(
            `INSERT INTO academy_lessons (module_id, title, summary, body_md, attachments, duration_min, playbook_ids, setup_names, position, draft, seed_key, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10, $11)`,
            [moduleId, it.title, it.summary, it.body, JSON.stringify(it.attachments ?? []), it.durationMin, pbIds, it.setupNames ?? [], pos, it.key, actor],
          );
          created.lessons++;
        } else if (it.kind === "quiz") {
          await client.query(
            `INSERT INTO academy_quizzes (module_id, title, description, questions, pass_pct, max_attempts, position, draft, seed_key, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9)`,
            [moduleId, it.title, it.description, JSON.stringify(it.questions), it.passPct, it.maxAttempts, pos, it.key, actor],
          );
          created.quizzes++;
        } else {
          await client.query(
            `INSERT INTO academy_assignments (module_id, title, body_md, rubric, pass_pct, min_trades, position, draft, seed_key, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9)`,
            [moduleId, it.title, it.body, JSON.stringify(it.rubric), it.passPct, it.minTrades, pos, it.key, actor],
          );
          created.assignments++;
        }
      }
    }
    await client.query("COMMIT");
    return { programId, created };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

router.post(`${P}/seed-demo`, asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  await ensureAcademyContentTables();
  const result = await seedDemo(req.authUser!.name);
  const total = Object.values(result.created).reduce((s, v) => s + v, 0);
  res.status(total ? 201 : 200).json({ ...result, alreadySeeded: total === 0 });
}));

export default router;
