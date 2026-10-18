/**
 * «Академия» → когорты и наставничество (агент F2). Экспорт по умолчанию — router (регистрирует лид в routes/index.ts).
 *
 * Таблицы (создаются лениво, идемпотентно, только CREATE/ALTER … IF NOT EXISTS; удаление — только archived_at):
 *   academy_cohorts, academy_enrollments, academy_enrollment_history, academy_sessions, academy_attendance,
 *   academy_one_on_ones, academy_action_items, academy_idp_goals.
 *
 * Доступ: мутации наставника — requireStaff (curator/admin); студент видит только своё (req.authUser.name),
 * гость — пустые ответы / 403 на запись. Время — timestamptz; занятия хранят настенное время + зону.
 * Чистая логика (повторы, окно самоотметки, метрики ИПР, отстающие) — lib/academyCohorts.ts.
 *
 *   GET    /academy/cohorts                       ?archived=1          список когорт (студент — свои)
 *   POST   /academy/cohorts                                            создать (staff)
 *   GET    /academy/cohorts/:id                                        карточка: студенты + посещаемость, занятия
 *   PATCH  /academy/cohorts/:id                                        изменить (staff)
 *   POST   /academy/cohorts/:id/archive | /restore                     мягкое удаление (staff)
 *   POST   /academy/cohorts/seed-demo                                  демо-данные, идемпотентно (staff)
 *   POST   /academy/enrollments                                        зачислить существующего пользователя (staff)
 *   PATCH  /academy/enrollments/:id                                    ступень / статус / дата / заметка (staff) → история
 *   POST   /academy/enrollments/:id/archive                            (staff)
 *   GET    /academy/enrollments/:id/history                            история ступеней/статусов
 *   GET    /academy/sessions                      ?cohortId&from&to    вхождения расписания (студент — свои когорты)
 *   POST   /academy/sessions | PATCH /academy/sessions/:id | POST /academy/sessions/:id/archive   (staff)
 *   GET    /academy/sessions/:id/roster           ?date                список на занятие + отметки (staff)
 *   POST   /academy/attendance                                         отметки наставника пачкой (staff)
 *   POST   /academy/checkin                                            самоотметка студента (окно −10…+15 мин, время сервера)
 *   GET    /academy/attendance/stats              ?cohortId | ?user    статистика посещаемости
 *   GET    /academy/one-on-ones                   ?student&mentor      журнал 1:1 (студент — свои, без приватных заметок)
 *   POST   /academy/one-on-ones | PATCH /academy/one-on-ones/:id | POST /academy/one-on-ones/:id/archive   (staff)
 *   GET    /academy/action-items                  ?student&status      договорённости
 *   POST   /academy/action-items (staff) | PATCH /academy/action-items/:id (staff; студент — статус своих)
 *   GET    /academy/idp/metrics                                        каталог метрик ИПР
 *   GET    /academy/idp                           ?student             цели ИПР с прогрессом (пересчёт + уведомления)
 *   POST   /academy/idp (staff) | PATCH /academy/idp/:id | POST /academy/idp/:id/archive (staff)
 *   GET    /academy/my                            ?user (staff)        дашборд студента
 *   GET    /academy/mentor                        ?all=1               дашборд наставника (staff)
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { isGuest, isStaffRole, viewerRole } from "../lib/auth";
import { notifyUser } from "../lib/notifyUtils";
import { safeHttpUrl } from "../lib/safe-url";
import { addDays, nyDate } from "../lib/tradingDate";
import { closeDateSql, num, resultSql } from "../lib/tradeMath";
import { logger } from "../lib/logger";
import {
  ACTION_STATUSES, ATTENDANCE_STATUSES, CHECKIN_AFTER_MIN, CHECKIN_BEFORE_MIN, COHORT_FORMATS, COMPARATORS, ENROLLMENT_STATUSES,
  GOAL_STATUSES, LATE_GRACE_MIN, METRICS, METRIC_KEYS, NY_TZ, RECURRENCES, SESSION_KINDS, SESSION_MODES,
  STAGES, enrollmentStatusLabelFor, metricsFor, stageLabelFor,
  dateInTz, describeGoal, describeRule, evaluateCheckin, evaluateGoal, goalTransition, isOccurrence, isValidTimeZone, lagReasons,
  lagScore, mergeSummaries, nextOccurrence, occurrenceAt, occurrences, summarizeAttendance,
  type AttendanceStatus, type AttendanceSummary, type Comparator, type EnrollmentStatus, type GoalEval, type GoalStatus, type IdpTrade,
  type MetricKey, type SessionRule, type Stage,
} from "../lib/academyCohorts";
import { AppError, conflict, forbidden, notFound, sendError, unauthorized, type ErrorCode } from "../lib/http";
import { ruCohorts } from "../lib/academyI18n";
import { DEMO, DEMO_URL } from "../lib/academyCohortsDemo";
import { langOf, type Lang, type Params } from "../i18n";

const router: IRouter = Router();

/* ─── Схема ───────────────────────────────────────────────────────────────── */

let ensured: Promise<void> | null = null;
export function ensureAcademyCohortTables(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `CREATE TABLE IF NOT EXISTS academy_cohorts (
           id SERIAL PRIMARY KEY,
           name TEXT NOT NULL,
           format TEXT NOT NULL DEFAULT 'office',
           mentor TEXT,
           starts_on DATE,
           ends_on DATE,
           timezone TEXT NOT NULL DEFAULT 'America/New_York',
           description TEXT NOT NULL DEFAULT '',
           room TEXT,
           meeting_url TEXT,
           created_by TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           archived_at TIMESTAMPTZ
         );
         CREATE UNIQUE INDEX IF NOT EXISTS academy_cohorts_name_live_uq ON academy_cohorts (name) WHERE archived_at IS NULL;
         CREATE TABLE IF NOT EXISTS academy_enrollments (
           id SERIAL PRIMARY KEY,
           cohort_id INTEGER NOT NULL REFERENCES academy_cohorts(id),
           user_name TEXT NOT NULL,
           stage TEXT NOT NULL DEFAULT 'trainee',
           status TEXT NOT NULL DEFAULT 'active',
           joined_on DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'America/New_York')::date),
           note TEXT NOT NULL DEFAULT '',
           created_by TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           archived_at TIMESTAMPTZ
         );
         CREATE UNIQUE INDEX IF NOT EXISTS academy_enrollments_live_uq ON academy_enrollments (cohort_id, user_name) WHERE archived_at IS NULL;
         CREATE INDEX IF NOT EXISTS academy_enrollments_user_idx ON academy_enrollments (user_name);
         CREATE TABLE IF NOT EXISTS academy_enrollment_history (
           id SERIAL PRIMARY KEY,
           enrollment_id INTEGER NOT NULL,
           cohort_id INTEGER,
           user_name TEXT NOT NULL,
           from_stage TEXT,
           to_stage TEXT,
           from_status TEXT,
           to_status TEXT,
           changed_by TEXT,
           note TEXT NOT NULL DEFAULT '',
           changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         );
         CREATE INDEX IF NOT EXISTS academy_enrollment_history_enr_idx ON academy_enrollment_history (enrollment_id, changed_at DESC);
         CREATE INDEX IF NOT EXISTS academy_enrollment_history_user_idx ON academy_enrollment_history (user_name, changed_at DESC);
         CREATE TABLE IF NOT EXISTS academy_sessions (
           id SERIAL PRIMARY KEY,
           cohort_id INTEGER NOT NULL REFERENCES academy_cohorts(id),
           title TEXT NOT NULL,
           kind TEXT NOT NULL DEFAULT 'lecture',
           recurrence TEXT NOT NULL DEFAULT 'none',
           weekdays SMALLINT[] NOT NULL DEFAULT '{}',
           start_date DATE NOT NULL,
           end_date DATE,
           start_time TEXT NOT NULL,
           duration_min INTEGER NOT NULL DEFAULT 60,
           timezone TEXT NOT NULL DEFAULT 'America/New_York',
           mode TEXT NOT NULL DEFAULT 'office',
           room TEXT,
           meeting_url TEXT,
           host TEXT,
           description TEXT NOT NULL DEFAULT '',
           created_by TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           archived_at TIMESTAMPTZ
         );
         CREATE INDEX IF NOT EXISTS academy_sessions_cohort_idx ON academy_sessions (cohort_id);
         CREATE TABLE IF NOT EXISTS academy_attendance (
           id SERIAL PRIMARY KEY,
           session_id INTEGER NOT NULL REFERENCES academy_sessions(id),
           occurrence_date DATE NOT NULL,
           user_name TEXT NOT NULL,
           status TEXT NOT NULL,
           source TEXT NOT NULL DEFAULT 'mentor',
           checked_in_at TIMESTAMPTZ,
           marked_by TEXT,
           note TEXT NOT NULL DEFAULT '',
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           UNIQUE (session_id, occurrence_date, user_name)
         );
         CREATE INDEX IF NOT EXISTS academy_attendance_user_idx ON academy_attendance (user_name, occurrence_date DESC);
         CREATE TABLE IF NOT EXISTS academy_one_on_ones (
           id SERIAL PRIMARY KEY,
           student TEXT NOT NULL,
           mentor TEXT NOT NULL,
           cohort_id INTEGER,
           met_at TIMESTAMPTZ NOT NULL,
           duration_min INTEGER,
           format TEXT NOT NULL DEFAULT 'office',
           agenda TEXT NOT NULL DEFAULT '',
           notes TEXT NOT NULL DEFAULT '',
           private_notes TEXT NOT NULL DEFAULT '',
           created_by TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           archived_at TIMESTAMPTZ
         );
         CREATE INDEX IF NOT EXISTS academy_one_on_ones_student_idx ON academy_one_on_ones (student, met_at DESC);
         CREATE TABLE IF NOT EXISTS academy_action_items (
           id SERIAL PRIMARY KEY,
           meeting_id INTEGER,
           student TEXT NOT NULL,
           owner TEXT NOT NULL DEFAULT 'student',
           title TEXT NOT NULL,
           due_on DATE,
           status TEXT NOT NULL DEFAULT 'open',
           done_at TIMESTAMPTZ,
           overdue_notified_at TIMESTAMPTZ,
           created_by TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           archived_at TIMESTAMPTZ
         );
         CREATE INDEX IF NOT EXISTS academy_action_items_student_idx ON academy_action_items (student, status);
         CREATE TABLE IF NOT EXISTS academy_idp_goals (
           id SERIAL PRIMARY KEY,
           student TEXT NOT NULL,
           title TEXT NOT NULL,
           metric TEXT NOT NULL,
           comparator TEXT NOT NULL,
           target NUMERIC NOT NULL,
           window_n INTEGER,
           start_date DATE NOT NULL,
           due_on DATE,
           status TEXT NOT NULL DEFAULT 'active',
           manual_progress NUMERIC,
           note TEXT NOT NULL DEFAULT '',
           last_value NUMERIC,
           last_progress NUMERIC,
           last_evaluated_at TIMESTAMPTZ,
           achieved_at TIMESTAMPTZ,
           missed_at TIMESTAMPTZ,
           created_by TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           archived_at TIMESTAMPTZ
         );
         CREATE INDEX IF NOT EXISTS academy_idp_goals_student_idx ON academy_idp_goals (student, status);`,
      )
      .then(() => undefined)
      .catch((err) => {
        ensured = null;
        throw err;
      });
  }
  return ensured;
}

/* ─── Общие помощники ─────────────────────────────────────────────────────── */

type Viewer = { me: string | null; staff: boolean; guest: boolean };

async function viewer(req: Request): Promise<Viewer> {
  if (!req.authUser) return { me: null, staff: false, guest: false };
  if (isGuest(req)) return { me: null, staff: false, guest: true };
  const role = await viewerRole(req);
  if (!role) return { me: null, staff: false, guest: false };
  return { me: req.authUser.name, staff: isStaffRole(role), guest: false };
}

/** Общий вход для всех маршрутов: схема + личность. Отвечает 401 сам. */
async function enter(req: Request, res: Response): Promise<Viewer | null> {
  await ensureAcademyCohortTables();
  const v = await viewer(req);
  if (!v.me && !v.guest) { sendError(res, unauthorized()); return null; }
  return v;
}

function needMember(v: Viewer, res: Response): v is Viewer & { me: string } {
  if (v.guest || !v.me) { sendError(res, new AppError("GUEST_READ_ONLY")); return false; }
  return true;
}

function needStaff(v: Viewer, res: Response): v is Viewer & { me: string } {
  if (!needMember(v, res)) return false;
  if (!v.staff) { sendError(res, new AppError("STAFF_ONLY")); return false; }
  return true;
}

/** 400 with an error code (text translated by the middleware), or VALIDATION with the zod issues in `details`. */
function badRequest(res: Response, err: z.ZodError | ErrorCode, params?: Params): void {
  if (typeof err === "string") { sendError(res, new AppError(err, 400, params)); return; }
  sendError(res, new AppError("VALIDATION", 400, undefined, err.issues.map((i) => ({ path: i.path.join(".") || "body", message: i.message }))));
}

function idParam(req: Request): number | null {
  const n = Number(req.params.id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function qs(req: Request, k: string): string | undefined {
  const v = req.query[k];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.trim() !== "" ? s.trim() : undefined;
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date YYYY-MM-DD").refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "invalid date");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time HH:MM");
const tz = z.string().trim().refine(isValidTimeZone, "unknown time zone");
const name = z.string().trim().min(1).max(120);
const urlField = z.string().trim().max(500).nullable().optional()
  .refine((s) => s == null || s === "" || safeHttpUrl(s) != null, "the link must start with http(s)://");
const cleanUrl = (s: string | null | undefined): string | null => (s ? safeHttpUrl(s) : null);
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

async function userExists(n: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM users WHERE name = $1 AND active = true AND COALESCE(banned, false) = false AND role <> 'guest' LIMIT 1`, [n]);
  return rows.length > 0;
}

/** Наставники студента: наставники его активных когорт + users.assigned_mentor / assigned_curator. */
async function mentorsOf(student: string): Promise<string[]> {
  const { rows } = await pool.query<{ m: string | null }>(
    `SELECT c.mentor AS m FROM academy_enrollments e JOIN academy_cohorts c ON c.id = e.cohort_id
      WHERE e.user_name = $1 AND e.archived_at IS NULL AND c.archived_at IS NULL AND e.status IN ('active','paused')
     UNION SELECT assigned_mentor FROM users WHERE name = $1
     UNION SELECT assigned_curator FROM users WHERE name = $1`,
    [student],
  );
  return [...new Set(rows.map((r) => r.m).filter((m): m is string => !!m && m !== student))];
}

async function notifySafe(opts: Parameters<typeof notifyUser>[0]): Promise<void> {
  try { await notifyUser(opts); } catch (err) { logger.warn({ err }, "academy: notify failed"); }
}

/* ─── Мапперы ─────────────────────────────────────────────────────────────── */

const COHORT_COLS = `c.id, c.name, c.format, c.mentor, c.starts_on::text AS starts_on, c.ends_on::text AS ends_on, c.timezone, c.description,
  c.room, c.meeting_url, c.created_by, c.created_at, c.updated_at, c.archived_at`;

type CohortRow = {
  id: number; name: string; format: string; mentor: string | null; starts_on: string | null; ends_on: string | null; timezone: string;
  description: string; room: string | null; meeting_url: string | null; created_by: string | null; created_at: Date; updated_at: Date; archived_at: Date | null;
};
function mapCohort(r: CohortRow) {
  return {
    id: r.id, name: r.name, format: r.format, mentor: r.mentor, startsOn: r.starts_on, endsOn: r.ends_on, timezone: r.timezone,
    description: r.description, room: r.room, meetingUrl: r.meeting_url, createdBy: r.created_by, createdAt: r.created_at,
    updatedAt: r.updated_at, archivedAt: r.archived_at,
  };
}

const ENR_COLS = `e.id, e.cohort_id, e.user_name, e.stage, e.status, e.joined_on::text AS joined_on, e.note, e.created_at, e.updated_at, e.archived_at`;
type EnrollmentRow = {
  id: number; cohort_id: number; user_name: string; stage: string; status: string; joined_on: string; note: string;
  created_at: Date; updated_at: Date; archived_at: Date | null;
};
function mapEnrollment(r: EnrollmentRow, lang: Lang = "ru") {
  const stage = (STAGES as readonly string[]).includes(r.stage) ? (r.stage as Stage) : "trainee";
  const status = (ENROLLMENT_STATUSES as readonly string[]).includes(r.status) ? (r.status as EnrollmentStatus) : "active";
  return {
    id: r.id, cohortId: r.cohort_id, userName: r.user_name, stage, stageLabel: stageLabelFor(stage, lang), status, statusLabel: enrollmentStatusLabelFor(status, lang),
    joinedOn: r.joined_on, note: r.note, createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at,
  };
}

const SES_COLS = `s.id, s.cohort_id, s.title, s.kind, s.recurrence, s.weekdays, s.start_date::text AS start_date, s.end_date::text AS end_date,
  s.start_time, s.duration_min, s.timezone, s.mode, s.room, s.meeting_url, s.host, s.description, s.archived_at, s.created_at`;
type SessionRow = {
  id: number; cohort_id: number; title: string; kind: string; recurrence: string; weekdays: number[] | null; start_date: string; end_date: string | null;
  start_time: string; duration_min: number; timezone: string; mode: string; room: string | null; meeting_url: string | null; host: string | null;
  description: string; archived_at: Date | null; created_at: Date;
};
function ruleOf(s: SessionRow): SessionRule {
  return {
    recurrence: (RECURRENCES as readonly string[]).includes(s.recurrence) ? (s.recurrence as SessionRule["recurrence"]) : "none",
    weekdays: (s.weekdays ?? []).map(Number).filter((d) => d >= 0 && d <= 6),
    startDate: s.start_date,
    endDate: s.end_date,
    startTime: s.start_time,
    durationMin: s.duration_min,
    timezone: isValidTimeZone(s.timezone) ? s.timezone : NY_TZ,
  };
}
function mapSession(s: SessionRow, lang: Lang = "ru", nowMs = Date.now()) {
  const rule = ruleOf(s);
  const next = s.archived_at ? null : nextOccurrence(rule, nowMs);
  return {
    id: s.id, cohortId: s.cohort_id, title: s.title, kind: s.kind, recurrence: rule.recurrence, weekdays: rule.weekdays,
    startDate: s.start_date, endDate: s.end_date, startTime: s.start_time, durationMin: s.duration_min, timezone: rule.timezone,
    mode: s.mode, room: s.room, meetingUrl: s.meeting_url, host: s.host, description: s.description, archivedAt: s.archived_at,
    ruleText: describeRule(rule, lang),
    next: next ? { date: next.date, startUtc: new Date(next.startMs).toISOString(), endUtc: new Date(next.endMs).toISOString() } : null,
  };
}

/* ─── Расписание: вхождения ───────────────────────────────────────────────── */

type OccView = {
  sessionId: number; cohortId: number; cohortName: string; title: string; kind: string; mode: string; room: string | null; meetingUrl: string | null;
  host: string | null; description: string; date: string; startUtc: string; endUtc: string; timezone: string; startTimeLocal: string; ruleText: string;
  startMs: number; endMs: number;
};

async function loadSessions(cohortIds: number[], includeArchived = false): Promise<SessionRow[]> {
  if (!cohortIds.length) return [];
  const { rows } = await pool.query<SessionRow>(
    `SELECT ${SES_COLS} FROM academy_sessions s WHERE s.cohort_id = ANY($1::int[]) ${includeArchived ? "" : "AND s.archived_at IS NULL"} ORDER BY s.start_time, s.id`,
    [cohortIds],
  );
  return rows;
}

/** Вхождения в [from, to] (даты в зоне занятия). Для архивных занятий — только до момента архивации. */
function expand(sessions: SessionRow[], cohortNames: Map<number, string>, from: string, to: string, lang: Lang = "ru"): OccView[] {
  const out: OccView[] = [];
  for (const s of sessions) {
    const rule = ruleOf(s);
    const cut = s.archived_at ? new Date(s.archived_at).getTime() : Infinity;
    for (const o of occurrences(rule, from, to, 400)) {
      if (o.startMs >= cut) continue;
      out.push({
        sessionId: s.id, cohortId: s.cohort_id, cohortName: cohortNames.get(s.cohort_id) ?? "", title: s.title, kind: s.kind, mode: s.mode,
        room: s.room, meetingUrl: s.meeting_url, host: s.host, description: s.description, date: o.date,
        startUtc: new Date(o.startMs).toISOString(), endUtc: new Date(o.endMs).toISOString(), timezone: rule.timezone, startTimeLocal: rule.startTime,
        ruleText: describeRule(rule, lang), startMs: o.startMs, endMs: o.endMs,
      });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.sessionId - b.sessionId);
}

function stripMs<T extends { startMs: number; endMs: number }>(o: T): Omit<T, "startMs" | "endMs"> {
  const { startMs: _s, endMs: _e, ...rest } = o;
  return rest;
}

async function cohortNameMap(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const { rows } = await pool.query<{ id: number; name: string }>(`SELECT id, name FROM academy_cohorts WHERE id = ANY($1::int[])`, [ids]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

/* ─── Посещаемость ────────────────────────────────────────────────────────── */

type AttRow = { session_id: number; occurrence_date: string; user_name: string; status: string; source: string; checked_in_at: Date | null; marked_by: string | null; note: string };

/**
 * Посещаемость студентов когорты: по всем прошедшим вхождениям занятий когорты с даты зачисления.
 * Возвращает итог за всё время и за последние 30 дней.
 */
async function cohortAttendance(cohortId: number, students: { name: string; joinedOn: string }[]): Promise<Map<string, { all: AttendanceSummary; last30: AttendanceSummary }>> {
  const result = new Map<string, { all: AttendanceSummary; last30: AttendanceSummary }>();
  if (!students.length) return result;
  const sessions = await loadSessions([cohortId], true);
  const now = Date.now();
  const today = nyDate();
  const minJoin = students.reduce((m, s) => (s.joinedOn < m ? s.joinedOn : m), today);
  const occ = expand(sessions, new Map(), addDays(minJoin, -1), addDays(today, 1)).filter((o) => o.endMs <= now);
  const { rows } = sessions.length
    ? await pool.query<AttRow>(
        `SELECT session_id, occurrence_date::text AS occurrence_date, user_name, status, source, checked_in_at, marked_by, note
           FROM academy_attendance WHERE session_id = ANY($1::int[]) AND user_name = ANY($2::text[])`,
        [sessions.map((s) => s.id), students.map((s) => s.name)],
      )
    : { rows: [] as AttRow[] };
  const marks = new Map(rows.map((r) => [`${r.session_id}|${r.occurrence_date}|${r.user_name}`, r.status as AttendanceStatus]));
  const cutoff30 = now - 30 * 86_400_000;
  for (const st of students) {
    const mine = occ.filter((o) => o.date >= st.joinedOn);
    const list = mine.map((o) => marks.get(`${o.sessionId}|${o.date}|${st.name}`) ?? null);
    const list30 = mine.filter((o) => o.startMs >= cutoff30).map((o) => marks.get(`${o.sessionId}|${o.date}|${st.name}`) ?? null);
    result.set(st.name, { all: summarizeAttendance(list), last30: summarizeAttendance(list30) });
  }
  return result;
}

/* ─── Сделки и дневник для ИПР ────────────────────────────────────────────── */

async function loadIdpTrades(student: string): Promise<IdpTrade[]> {
  const { rows } = await pool.query<{ id: number; date: string; gross: unknown; fees: unknown; result: string | null; first_at: Date | null }>(
    `WITH tt AS (
       SELECT t.id, LEFT(${closeDateSql("t")}, 10) AS date, t.pnl AS gross, t.fees, ${resultSql("t")} AS result
         FROM trades t
        WHERE t.trader = $1 AND t.deleted_at IS NULL
        ORDER BY 2 DESC, t.id DESC
        LIMIT 3000
     )
     SELECT tt.*, ex.first_at
       FROM tt LEFT JOIN (
         SELECT trade_id, MIN(executed_at) AS first_at FROM trade_executions
          WHERE trade_id IN (SELECT id FROM tt) AND executed_at IS NOT NULL GROUP BY trade_id
       ) ex ON ex.trade_id = tt.id`,
    [student],
  ).catch(async (err) => {
    // trade_executions может отсутствовать на старой БД — без времени входа порядок внутри дня по id.
    logger.debug({ err }, "academy: executions join failed, falling back");
    return pool.query<{ id: number; date: string; gross: unknown; fees: unknown; result: string | null; first_at: Date | null }>(
      `SELECT t.id, LEFT(${closeDateSql("t")}, 10) AS date, t.pnl AS gross, t.fees, ${resultSql("t")} AS result, NULL::timestamptz AS first_at
         FROM trades t WHERE t.trader = $1 AND t.deleted_at IS NULL ORDER BY 2 DESC, t.id DESC LIMIT 3000`,
      [student],
    );
  });
  return rows.map((r) => ({
    date: String(r.date ?? "").slice(0, 10),
    seq: r.first_at ? new Date(r.first_at).getTime() : Number(r.id),
    gross: num(r.gross),
    fees: num(r.fees),
    result: r.result === "win" || r.result === "loss" || r.result === "be" || r.result === "open" ? r.result : null,
  }));
}

let journalTables: { journal: boolean; eod: boolean; exp: number } | null = null;
async function journalTablesPresent(): Promise<{ journal: boolean; eod: boolean }> {
  if (journalTables && journalTables.exp > Date.now()) return journalTables;
  const { rows } = await pool.query<{ j: string | null; e: string | null }>(`SELECT to_regclass('journal_days')::text AS j, to_regclass('eod_days')::text AS e`);
  journalTables = { journal: !!rows[0]?.j, eod: !!rows[0]?.e, exp: Date.now() + 60_000 };
  return journalTables;
}

/** Даты (NY) «дневника с разбором»: заполнены поля дневника (что получилось / ошибки / уроки) или день закрыт в EOD. */
async function loadJournalDates(student: string): Promise<string[]> {
  const t = await journalTablesPresent();
  const parts: string[] = [];
  if (t.journal) parts.push(`SELECT to_char(day, 'YYYY-MM-DD') AS d FROM journal_days WHERE trader = $1 AND (btrim(well) <> '' OR btrim(mistakes) <> '' OR btrim(lessons) <> '')`);
  if (t.eod) parts.push(`SELECT LEFT(date, 10) AS d FROM eod_days WHERE trader = $1 AND closed_at IS NOT NULL`);
  if (!parts.length) return [];
  const { rows } = await pool.query<{ d: string }>(parts.join(" UNION "), [student]);
  return [...new Set(rows.map((r) => r.d))].sort();
}

/* ─── ИПР ─────────────────────────────────────────────────────────────────── */

const GOAL_COLS = `g.id, g.student, g.title, g.metric, g.comparator, g.target, g.window_n, g.start_date::text AS start_date, g.due_on::text AS due_on,
  g.status, g.manual_progress, g.note, g.last_value, g.last_progress, g.last_evaluated_at, g.achieved_at, g.missed_at, g.created_by, g.created_at, g.updated_at`;
type GoalRow = {
  id: number; student: string; title: string; metric: string; comparator: string; target: number; window_n: number | null; start_date: string; due_on: string | null;
  status: string; manual_progress: number | null; note: string; last_value: number | null; last_progress: number | null; last_evaluated_at: Date | null;
  achieved_at: Date | null; missed_at: Date | null; created_by: string | null; created_at: Date; updated_at: Date;
};

export type GoalView = ReturnType<typeof mapGoal>;
function mapGoal(g: GoalRow, ev: GoalEval, lang: Lang = "ru") {
  const metric = (METRIC_KEYS as readonly string[]).includes(g.metric) ? (g.metric as MetricKey) : "manual";
  const comparator = (COMPARATORS as readonly string[]).includes(g.comparator) ? (g.comparator as Comparator) : METRICS[metric].comparator;
  const defs = metricsFor(lang);
  return {
    id: g.id, student: g.student, title: g.title, metric, metricLabel: defs[metric].label, unit: defs[metric].unit, comparator,
    target: Number(g.target), window: g.window_n, startDate: g.start_date, dueOn: g.due_on, status: g.status as GoalStatus,
    manualProgress: g.manual_progress, note: g.note, formula: describeGoal({ metric, target: Number(g.target), comparator, window: g.window_n }, lang),
    achievedAt: g.achieved_at, missedAt: g.missed_at, createdBy: g.created_by, createdAt: g.created_at,
    eval: ev,
  };
}

/**
 * Цели студента с пересчитанным прогрессом. Активные цели переводятся в achieved / missed (одной UPDATE … WHERE status='active',
 * поэтому уведомление уходит ровно один раз): студенту и его наставникам.
 */
async function goalsFor(student: string, actor: string | null, lang: Lang = "ru"): Promise<GoalView[]> {
  const { rows } = await pool.query<GoalRow>(
    `SELECT ${GOAL_COLS} FROM academy_idp_goals g WHERE g.student = $1 AND g.archived_at IS NULL
      ORDER BY (g.status = 'active') DESC, g.due_on NULLS LAST, g.id`,
    [student],
  );
  if (!rows.length) return [];
  const needsTrades = rows.some((g) => g.metric !== "manual" && g.metric !== "journal_days");
  const needsJournal = rows.some((g) => g.metric === "journal_days");
  const [trades, journalDates] = await Promise.all([needsTrades ? loadIdpTrades(student) : [], needsJournal ? loadJournalDates(student) : []]);
  const today = nyDate();
  const out: GoalView[] = [];
  let mentors: string[] | null = null;
  for (const g of rows) {
    const metric = (METRIC_KEYS as readonly string[]).includes(g.metric) ? (g.metric as MetricKey) : "manual";
    const comparator = (COMPARATORS as readonly string[]).includes(g.comparator) ? (g.comparator as Comparator) : METRICS[metric].comparator;
    const ev = evaluateGoal(
      { metric, target: Number(g.target), comparator, window: g.window_n, startDate: g.start_date, dueOn: g.due_on, manualProgress: g.manual_progress },
      { trades, journalDates, today },
      lang,
    );
    const next = goalTransition(g.status as GoalStatus, ev, g.due_on, today);
    if (g.status === "active") {
      const upd = await pool.query<{ id: number }>(
        `UPDATE academy_idp_goals SET last_value = $2, last_progress = $3, last_evaluated_at = NOW(),
                status = COALESCE($4, status),
                achieved_at = CASE WHEN $4 = 'achieved' THEN NOW() ELSE achieved_at END,
                missed_at = CASE WHEN $4 = 'missed' THEN NOW() ELSE missed_at END,
                updated_at = CASE WHEN $4 IS NULL THEN updated_at ELSE NOW() END
          WHERE id = $1 AND status = 'active' RETURNING id`,
        [g.id, ev.value, Math.round(ev.progress * 1000) / 1000, next],
      );
      if (next && upd.rows.length) {
        g.status = next;
        if (next === "achieved") g.achieved_at = new Date(); else g.missed_at = new Date();
        mentors ??= await mentorsOf(student);
        // Text as data (lib/notificationRenderers/academyCohorts.ts): the detail is re-rendered per reader from detailMsg.
        const params = { student, title: g.title, due: g.due_on ?? "", detailMsg: JSON.stringify(ev.detailMsg) };
        const type = next === "achieved" ? "academy_goal_achieved" : "academy_goal_missed";
        const severity = next === "achieved" ? "info" : "warn";
        await notifySafe({ userName: student, type, params, severity, link: "/academy/my", entityType: "academy_goal", entityId: g.id, actor, source: "academy" });
        for (const m of mentors) {
          await notifySafe({ userName: m, type, params, severity, link: `/academy/mentor?student=${encodeURIComponent(student)}`, entityType: "academy_goal", entityId: g.id, actor, source: "academy" });
        }
      }
    }
    out.push(mapGoal(g, ev, lang));
  }
  return out;
}

/* ─── Договорённости ──────────────────────────────────────────────────────── */

const ACT_COLS = `a.id, a.meeting_id, a.student, a.owner, a.title, a.due_on::text AS due_on, a.status, a.done_at, a.created_by, a.created_at, a.updated_at`;
type ActionRow = { id: number; meeting_id: number | null; student: string; owner: string; title: string; due_on: string | null; status: string; done_at: Date | null; created_by: string | null; created_at: Date; updated_at: Date };
function mapAction(a: ActionRow, today = nyDate()) {
  return {
    id: a.id, meetingId: a.meeting_id, student: a.student, owner: a.owner === "mentor" ? "mentor" : "student", title: a.title, dueOn: a.due_on,
    status: a.status, doneAt: a.done_at, createdBy: a.created_by, createdAt: a.created_at,
    overdue: a.status === "open" && !!a.due_on && a.due_on < today,
  };
}

/** Просроченные открытые договорённости → одно уведомление студенту и наставникам (overdue_notified_at). */
async function notifyOverdueActions(students: string[]): Promise<void> {
  if (!students.length) return;
  const today = nyDate();
  const { rows } = await pool.query<{ id: number; student: string; title: string; due_on: string }>(
    `UPDATE academy_action_items SET overdue_notified_at = NOW()
      WHERE student = ANY($1::text[]) AND status = 'open' AND archived_at IS NULL AND due_on IS NOT NULL AND due_on < $2::date
        AND overdue_notified_at IS NULL
      RETURNING id, student, title, due_on::text AS due_on`,
    [students, today],
  );
  for (const r of rows) {
    const params = { student: r.student, title: r.title, due: r.due_on };
    await notifySafe({ userName: r.student, type: "academy_action_overdue", params, severity: "warn", link: "/academy/my", entityType: "academy_action", entityId: r.id, source: "academy" });
    for (const m of await mentorsOf(r.student)) {
      await notifySafe({ userName: m, type: "academy_action_overdue", params, severity: "warn", link: `/academy/mentor?student=${encodeURIComponent(r.student)}`, entityType: "academy_action", entityId: r.id, source: "academy" });
    }
  }
}

async function actionsFor(students: string[], opts: { status?: string } = {}): Promise<ReturnType<typeof mapAction>[]> {
  if (!students.length) return [];
  await notifyOverdueActions(students);
  const params: unknown[] = [students];
  let where = `a.student = ANY($1::text[]) AND a.archived_at IS NULL`;
  if (opts.status && (ACTION_STATUSES as readonly string[]).includes(opts.status)) { params.push(opts.status); where += ` AND a.status = $${params.length}`; }
  const { rows } = await pool.query<ActionRow>(
    `SELECT ${ACT_COLS} FROM academy_action_items a WHERE ${where}
      ORDER BY (a.status = 'open') DESC, a.due_on NULLS LAST, a.id DESC LIMIT 500`,
    params,
  );
  const today = nyDate();
  return rows.map((r) => mapAction(r, today));
}

/* ─── 1:1 ─────────────────────────────────────────────────────────────────── */

const MEET_COLS = `m.id, m.student, m.mentor, m.cohort_id, m.met_at, m.duration_min, m.format, m.agenda, m.notes, m.private_notes, m.created_by, m.created_at, m.updated_at`;
type MeetRow = { id: number; student: string; mentor: string; cohort_id: number | null; met_at: Date; duration_min: number | null; format: string; agenda: string; notes: string; private_notes: string; created_by: string | null; created_at: Date; updated_at: Date };
function mapMeeting(m: MeetRow, staff: boolean) {
  return {
    id: m.id, student: m.student, mentor: m.mentor, cohortId: m.cohort_id, metAt: m.met_at, durationMin: m.duration_min, format: m.format,
    agenda: m.agenda, notes: m.notes, privateNotes: staff ? m.private_notes : undefined, createdBy: m.created_by, createdAt: m.created_at,
  };
}

/* ─── Изменение ступени/статуса (экспорт для F3 — продвижение по лестнице) ─── */

export async function changeEnrollment(
  enrollmentId: number,
  patch: { stage?: Stage; status?: EnrollmentStatus; joinedOn?: string; note?: string },
  actor: string | null,
  historyNote = "",
  lang: Lang = "ru",
): Promise<ReturnType<typeof mapEnrollment> | null> {
  await ensureAcademyCohortTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<EnrollmentRow>(`SELECT ${ENR_COLS} FROM academy_enrollments e WHERE e.id = $1 AND e.archived_at IS NULL FOR UPDATE`, [enrollmentId]);
    const before = cur.rows[0];
    if (!before) { await client.query("ROLLBACK"); return null; }
    const stage = patch.stage ?? before.stage;
    const status = patch.status ?? before.status;
    const upd = await client.query<EnrollmentRow>(
      `UPDATE academy_enrollments e SET stage = $2, status = $3, joined_on = COALESCE($4::date, joined_on), note = COALESCE($5, note), updated_at = NOW()
        WHERE e.id = $1 RETURNING ${ENR_COLS}`,
      [enrollmentId, stage, status, patch.joinedOn ?? null, patch.note ?? null],
    );
    const changed = stage !== before.stage || status !== before.status;
    if (changed) {
      await client.query(
        `INSERT INTO academy_enrollment_history (enrollment_id, cohort_id, user_name, from_stage, to_stage, from_status, to_status, changed_by, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [enrollmentId, before.cohort_id, before.user_name, before.stage, stage, before.status, status, actor, historyNote.slice(0, 1000)],
      );
    }
    await client.query("COMMIT");
    const after = mapEnrollment(upd.rows[0], lang);
    if (changed && before.user_name !== actor) {
      // Codes as data: stage / status names are rendered in the reader's language (notificationRenderers/academyCohorts.ts).
      await notifySafe({
        userName: before.user_name, type: "academy_stage_change",
        params: {
          fromStage: stage !== before.stage ? before.stage : null, toStage: stage !== before.stage ? stage : null,
          fromStatus: status !== before.status ? before.status : null, toStatus: status !== before.status ? status : null, note: historyNote || null,
        },
        link: "/academy/my", entityType: "academy_enrollment", entityId: enrollmentId, actor, source: "academy",
      });
    }
    return after;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ═══ Когорты ═══════════════════════════════════════════════════════════════ */

const cohortBody = z.object({
  name: z.string().trim().min(2).max(120),
  format: z.enum(COHORT_FORMATS),
  mentor: name.nullable().optional(),
  startsOn: ymd.nullable().optional(),
  endsOn: ymd.nullable().optional(),
  timezone: tz.optional(),
  description: z.string().max(4000).optional(),
  room: nullableText(200),
  meetingUrl: urlField,
});

/** Когорты, видимые зрителю: staff — все; студент — где у него есть запись. */
async function visibleCohorts(v: Viewer, archived: boolean): Promise<CohortRow[]> {
  if (!v.me) return [];
  const arch = archived ? "c.archived_at IS NOT NULL" : "c.archived_at IS NULL";
  if (v.staff) {
    const { rows } = await pool.query<CohortRow>(`SELECT ${COHORT_COLS} FROM academy_cohorts c WHERE ${arch} ORDER BY c.starts_on DESC NULLS LAST, c.id DESC`);
    return rows;
  }
  const { rows } = await pool.query<CohortRow>(
    `SELECT ${COHORT_COLS} FROM academy_cohorts c
      WHERE ${arch} AND EXISTS (SELECT 1 FROM academy_enrollments e WHERE e.cohort_id = c.id AND e.user_name = $1 AND e.archived_at IS NULL)
      ORDER BY c.starts_on DESC NULLS LAST, c.id DESC`,
    [v.me],
  );
  return rows;
}

router.get("/academy/cohorts", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v) return;
  const cohorts = await visibleCohorts(v, qs(req, "archived") === "1");
  const ids = cohorts.map((c) => c.id);
  const counts = new Map<number, Record<string, number>>();
  const sessCounts = new Map<number, number>();
  if (ids.length) {
    const { rows } = await pool.query<{ cohort_id: number; status: string; n: number }>(
      `SELECT cohort_id, status, COUNT(*)::int AS n FROM academy_enrollments WHERE cohort_id = ANY($1::int[]) AND archived_at IS NULL GROUP BY 1, 2`, [ids]);
    for (const r of rows) { const m = counts.get(r.cohort_id) ?? {}; m[r.status] = r.n; counts.set(r.cohort_id, m); }
    const s = await pool.query<{ cohort_id: number; n: number }>(`SELECT cohort_id, COUNT(*)::int AS n FROM academy_sessions WHERE cohort_id = ANY($1::int[]) AND archived_at IS NULL GROUP BY 1`, [ids]);
    for (const r of s.rows) sessCounts.set(r.cohort_id, r.n);
  }
  res.json({
    staff: v.staff,
    cohorts: cohorts.map((c) => {
      const m = counts.get(c.id) ?? {};
      return { ...mapCohort(c), counts: { active: m.active ?? 0, paused: m.paused ?? 0, graduated: m.graduated ?? 0, dropped: m.dropped ?? 0 }, sessions: sessCounts.get(c.id) ?? 0 };
    }),
  });
}));

router.post("/academy/cohorts", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const p = cohortBody.safeParse(req.body ?? {});
  if (!p.success) return badRequest(res, p.error);
  const b = p.data;
  if (b.startsOn && b.endsOn && b.endsOn < b.startsOn) return badRequest(res, "DATE_RANGE_INVALID");
  if (b.mentor && !(await userExists(b.mentor))) return void sendError(res, notFound("USER_NOT_FOUND"));
  try {
    const { rows } = await pool.query<CohortRow>(
      `INSERT INTO academy_cohorts (name, format, mentor, starts_on, ends_on, timezone, description, room, meeting_url, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${COHORT_COLS.replace(/c\./g, "")}`,
      [b.name, b.format, b.mentor ?? null, b.startsOn ?? null, b.endsOn ?? null, b.timezone ?? NY_TZ, b.description ?? "", b.room ?? null, cleanUrl(b.meetingUrl), v.me],
    );
    res.status(201).json(mapCohort(rows[0]));
  } catch (err: any) {
    if (err?.code === "23505") { sendError(res, conflict("COHORT_NAME_TAKEN")); return; }
    throw err;
  }
}));

router.post("/academy/cohorts/seed-demo", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const summary = await seedDemo(v.me);
  res.json(summary);
}));

router.get("/academy/cohorts/:id", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v) return;
  const id = idParam(req); if (!id) return badRequest(res, "INVALID_ID");
  const { rows } = await pool.query<CohortRow>(`SELECT ${COHORT_COLS} FROM academy_cohorts c WHERE c.id = $1`, [id]);
  const c = rows[0];
  if (!c) throw notFound("COHORT_NOT_FOUND");
  if (!v.staff) {
    const own = v.me ? await pool.query(`SELECT 1 FROM academy_enrollments WHERE cohort_id = $1 AND user_name = $2 AND archived_at IS NULL`, [id, v.me]) : { rows: [] };
    if (!own.rows.length) throw notFound("COHORT_NOT_FOUND");
  }
  const enr = await pool.query<EnrollmentRow>(
    `SELECT ${ENR_COLS} FROM academy_enrollments e WHERE e.cohort_id = $1 AND e.archived_at IS NULL ORDER BY e.status = 'active' DESC, e.user_name`, [id]);
  const enrollments = enr.rows.map((r) => mapEnrollment(r, langOf(req)));
  // Студент видит состав когорты, но посещаемость — только свою.
  const statsFor = v.staff ? enrollments : enrollments.filter((e) => e.userName === v.me);
  const att = await cohortAttendance(id, statsFor.map((e) => ({ name: e.userName, joinedOn: e.joinedOn })));
  const sessions = (await loadSessions([id])).map((s) => mapSession(s, langOf(req)));
  const history = v.staff
    ? (await pool.query(
        `SELECT id, enrollment_id AS "enrollmentId", user_name AS "userName", from_stage AS "fromStage", to_stage AS "toStage",
                from_status AS "fromStatus", to_status AS "toStatus", changed_by AS "changedBy", note, changed_at AS "changedAt"
           FROM academy_enrollment_history WHERE cohort_id = $1 ORDER BY changed_at DESC, id DESC LIMIT 50`, [id])).rows
    : [];
  const summaries = [...att.values()].map((x) => x.all);
  res.json({
    cohort: mapCohort(c),
    enrollments: enrollments.map((e) => ({ ...e, attendance: att.get(e.userName)?.all ?? null, attendance30: att.get(e.userName)?.last30 ?? null })),
    attendance: mergeSummaries(summaries),
    sessions,
    history,
  });
}));

router.patch("/academy/cohorts/:id", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const id = idParam(req); if (!id) return badRequest(res, "INVALID_ID");
  const p = cohortBody.partial().safeParse(req.body ?? {});
  if (!p.success) return badRequest(res, p.error);
  const b = p.data;
  if (b.mentor && !(await userExists(b.mentor))) return void sendError(res, notFound("USER_NOT_FOUND"));
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (b.name !== undefined) set("name", b.name);
  if (b.format !== undefined) set("format", b.format);
  if (b.mentor !== undefined) set("mentor", b.mentor);
  if (b.startsOn !== undefined) set("starts_on", b.startsOn);
  if (b.endsOn !== undefined) set("ends_on", b.endsOn);
  if (b.timezone !== undefined) set("timezone", b.timezone);
  if (b.description !== undefined) set("description", b.description);
  if (b.room !== undefined) set("room", b.room || null);
  if (b.meetingUrl !== undefined) set("meeting_url", cleanUrl(b.meetingUrl));
  if (!sets.length) return badRequest(res, "NO_FIELDS");
  try {
    const { rows } = await pool.query<CohortRow>(
      `UPDATE academy_cohorts c SET ${sets.join(", ")}, updated_at = NOW() WHERE c.id = $1 RETURNING ${COHORT_COLS}`, params);
    if (!rows[0]) { sendError(res, notFound("COHORT_NOT_FOUND")); return; }
    const r = rows[0];
    if (r.starts_on && r.ends_on && r.ends_on < r.starts_on) return badRequest(res, "DATE_RANGE_INVALID");
    res.json(mapCohort(r));
  } catch (err: any) {
    if (err?.code === "23505") { sendError(res, conflict("COHORT_NAME_TAKEN")); return; }
    throw err;
  }
}));

for (const [path, archive] of [["archive", true], ["restore", false]] as const) {
  router.post(`/academy/cohorts/:id/${path}`, asyncHandler(async (req, res) => {
    const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
    const id = idParam(req); if (!id) return badRequest(res, "INVALID_ID");
    try {
      const { rows } = await pool.query<CohortRow>(
        `UPDATE academy_cohorts c SET archived_at = ${archive ? "NOW()" : "NULL"}, updated_at = NOW() WHERE c.id = $1 RETURNING ${COHORT_COLS}`, [id]);
      if (!rows[0]) { sendError(res, notFound("COHORT_NOT_FOUND")); return; }
      res.json(mapCohort(rows[0]));
    } catch (err: any) {
      if (err?.code === "23505") { sendError(res, conflict("COHORT_NAME_TAKEN_ACTIVE")); return; }
      throw err;
    }
  }));
}

/* ═══ Зачисления ════════════════════════════════════════════════════════════ */

const enrollBody = z.object({
  cohortId: z.number().int().positive(),
  userName: name,
  stage: z.enum(STAGES).default("trainee"),
  status: z.enum(ENROLLMENT_STATUSES).default("active"),
  joinedOn: ymd.optional(),
  note: z.string().max(2000).optional(),
});

router.post("/academy/enrollments", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const p = enrollBody.safeParse(req.body ?? {});
  if (!p.success) return badRequest(res, p.error);
  const b = p.data;
  if (!(await userExists(b.userName))) return void sendError(res, notFound("USER_NOT_FOUND"));
  const c = await pool.query<{ name: string }>(`SELECT name FROM academy_cohorts WHERE id = $1 AND archived_at IS NULL`, [b.cohortId]);
  if (!c.rows[0]) throw notFound("COHORT_NOT_FOUND");
  try {
    const { rows } = await pool.query<EnrollmentRow>(
      `INSERT INTO academy_enrollments (cohort_id, user_name, stage, status, joined_on, note, created_by)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, (NOW() AT TIME ZONE 'America/New_York')::date), $6, $7)
       RETURNING id, cohort_id, user_name, stage, status, joined_on::text AS joined_on, note, created_at, updated_at, archived_at`,
      [b.cohortId, b.userName, b.stage, b.status, b.joinedOn ?? null, b.note ?? "", v.me],
    );
    const e = rows[0];
    await pool.query(
      `INSERT INTO academy_enrollment_history (enrollment_id, cohort_id, user_name, from_stage, to_stage, from_status, to_status, changed_by, note)
       VALUES ($1, $2, $3, NULL, $4, NULL, $5, $6, $7)`,
      [e.id, e.cohort_id, e.user_name, e.stage, e.status, v.me, ruCohorts.history.enrolled],
    );
    if (e.user_name !== v.me) {
      await notifySafe({
        userName: e.user_name, type: "academy_enrolled", params: { cohort: String(c.rows[0].name), stage: e.stage }, link: "/academy/my",
        entityType: "academy_enrollment", entityId: e.id, actor: v.me, source: "academy",
      });
    }
    res.status(201).json(mapEnrollment(e, langOf(req)));
  } catch (err: any) {
    if (err?.code === "23505") { sendError(res, conflict("ALREADY_ENROLLED", undefined, { user: b.userName })); return; }
    throw err;
  }
}));

const enrollPatch = z.object({
  stage: z.enum(STAGES).optional(),
  status: z.enum(ENROLLMENT_STATUSES).optional(),
  joinedOn: ymd.optional(),
  note: z.string().max(2000).optional(),
  reason: z.string().max(1000).optional(),
});

router.patch("/academy/enrollments/:id", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const id = idParam(req); if (!id) return badRequest(res, "INVALID_ID");
  const p = enrollPatch.safeParse(req.body ?? {});
  if (!p.success) return badRequest(res, p.error);
  const { reason, ...patch } = p.data;
  const e = await changeEnrollment(id, patch, v.me, reason ?? "", langOf(req));
  if (!e) throw notFound();
  res.json(e);
}));

router.post("/academy/enrollments/:id/archive", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const id = idParam(req); if (!id) return badRequest(res, "INVALID_ID");
  const { rows } = await pool.query<EnrollmentRow>(
    `UPDATE academy_enrollments e SET archived_at = NOW(), updated_at = NOW() WHERE e.id = $1 AND e.archived_at IS NULL RETURNING ${ENR_COLS}`, [id]);
  if (!rows[0]) throw notFound();
  await pool.query(
    `INSERT INTO academy_enrollment_history (enrollment_id, cohort_id, user_name, from_stage, to_stage, from_status, to_status, changed_by, note)
     VALUES ($1, $2, $3, $4, $4, $5, $5, $6, $7)`,
    [id, rows[0].cohort_id, rows[0].user_name, rows[0].stage, rows[0].status, v.me, ruCohorts.history.archived],
  );
  res.json(mapEnrollment(rows[0], langOf(req)));
}));

router.get("/academy/enrollments/:id/history", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v) return;
  const id = idParam(req); if (!id) return badRequest(res, "INVALID_ID");
  const own = await pool.query<{ user_name: string }>(`SELECT user_name FROM academy_enrollments WHERE id = $1`, [id]);
  if (!own.rows[0] || (!v.staff && own.rows[0].user_name !== v.me)) throw notFound();
  const { rows } = await pool.query(
    `SELECT id, from_stage AS "fromStage", to_stage AS "toStage", from_status AS "fromStatus", to_status AS "toStatus",
            changed_by AS "changedBy", note, changed_at AS "changedAt"
       FROM academy_enrollment_history WHERE enrollment_id = $1 ORDER BY changed_at DESC, id DESC`, [id]);
  res.json({ history: rows });
}));

/* ═══ Занятия ═══════════════════════════════════════════════════════════════ */

const sessionBody = z.object({
  cohortId: z.number().int().positive(),
  title: z.string().trim().min(2).max(200),
  kind: z.enum(SESSION_KINDS).default("lecture"),
  recurrence: z.enum(RECURRENCES).default("none"),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  startDate: ymd,
  endDate: ymd.nullable().optional(),
  startTime: hhmm,
  durationMin: z.number().int().min(5).max(600).default(60),
  timezone: tz.default(NY_TZ),
  mode: z.enum(SESSION_MODES).default("office"),
  room: nullableText(200),
  meetingUrl: urlField,
  host: name.nullable().optional(),
  description: z.string().max(4000).optional(),
});

function sessionProblems(b: { recurrence?: string; endDate?: string | null; startDate?: string; mode?: string; room?: string | null; meetingUrl?: string | null }): ErrorCode | null {
  if (b.endDate && b.startDate && b.endDate < b.startDate) return "DATE_RANGE_INVALID";
  if (b.mode === "office" && !b.room) return "SESSION_ROOM_REQUIRED";
  if (b.mode === "online" && !b.meetingUrl) return "SESSION_URL_REQUIRED";
  if (b.mode === "hybrid" && (!b.room || !b.meetingUrl)) return "SESSION_ROOM_URL_REQUIRED";
  return null;
}

router.get("/academy/sessions", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v) return;
  const today = nyDate();
  const from = qs(req, "from") ?? today;
  const to = qs(req, "to") ?? addDays(from, 13);
  if (!ymd.safeParse(from).success || !ymd.safeParse(to).success || to < from) return badRequest(res, "INVALID_DATE");
  if (addDays(from, 92) < to) return badRequest(res, "RANGE_TOO_LONG", { max: 92 });
  const cohortId = qs(req, "cohortId") ? Number(qs(req, "cohortId")) : null;
  let cohorts = (await visibleCohorts(v, false)).map((c) => c.id);
  if (cohortId) cohorts = cohorts.filter((c) => c === cohortId);
  const names = await cohortNameMap(cohorts);
  const sessions = await loadSessions(cohorts);
  const occ = expand(sessions, names, addDays(from, -1), addDays(to, 1), langOf(req))
    .filter((o) => dateInTz(o.startMs, NY_TZ) >= from && dateInTz(o.startMs, NY_TZ) <= to);
  res.json({ from, to, serverNow: new Date().toISOString(), sessions: sessions.map((s) => mapSession(s, langOf(req))), occurrences: occ.map(stripMs) });
}));

router.post("/academy/sessions", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const p = sessionBody.safeParse(req.body ?? {});
  if (!p.success) return badRequest(res, p.error);
  const b = p.data;
  const problem = sessionProblems(b);
  if (problem) return badRequest(res, problem);
  const c = await pool.query(`SELECT 1 FROM academy_cohorts WHERE id = $1 AND archived_at IS NULL`, [b.cohortId]);
  if (!c.rows.length) throw notFound("COHORT_NOT_FOUND");
  if (b.host && !(await userExists(b.host))) return void sendError(res, notFound("USER_NOT_FOUND"));
  const { rows } = await pool.query<SessionRow>(
    `INSERT INTO academy_sessions (cohort_id, title, kind, recurrence, weekdays, start_date, end_date, start_time, duration_min, timezone, mode, room, meeting_url, host, description, created_by)
     VALUES ($1, $2, $3, $4, $5::smallint[], $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING ${SES_COLS.replace(/s\./g, "")}`,
    [b.cohortId, b.title, b.kind, b.recurrence, b.recurrence === "weekly" ? b.weekdays : [], b.startDate, b.endDate ?? null, b.startTime, b.durationMin,
      b.timezone, b.mode, b.room || null, cleanUrl(b.meetingUrl), b.host ?? null, b.description ?? "", v.me],
  );
  res.status(201).json(mapSession(rows[0], langOf(req)));
}));

router.patch("/academy/sessions/:id", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const id = idParam(req); if (!id) return badRequest(res, "INVALID_ID");
  const p = sessionBody.omit({ cohortId: true }).partial().safeParse(req.body ?? {});
  if (!p.success) return badRequest(res, p.error);
  const cur = await pool.query<SessionRow>(`SELECT ${SES_COLS} FROM academy_sessions s WHERE s.id = $1 AND s.archived_at IS NULL`, [id]);
  const s = cur.rows[0];
  if (!s) throw notFound("SESSION_NOT_FOUND");
  const b = p.data;
  const merged = {
    recurrence: b.recurrence ?? s.recurrence, startDate: b.startDate ?? s.start_date, endDate: b.endDate !== undefined ? b.endDate : s.end_date,
    mode: b.mode ?? s.mode, room: b.room !== undefined ? b.room : s.room, meetingUrl: b.meetingUrl !== undefined ? cleanUrl(b.meetingUrl) : s.meeting_url,
  };
  const problem = sessionProblems(merged);
  if (problem) return badRequest(res, problem);
  if (b.host && !(await userExists(b.host))) return void sendError(res, notFound("USER_NOT_FOUND"));
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, val: unknown, cast = "") => { params.push(val); sets.push(`${col} = $${params.length}${cast}`); };
  if (b.title !== undefined) set("title", b.title);
  if (b.kind !== undefined) set("kind", b.kind);
  if (b.recurrence !== undefined) set("recurrence", b.recurrence);
  if (b.weekdays !== undefined || b.recurrence !== undefined) set("weekdays", merged.recurrence === "weekly" ? (b.weekdays ?? s.weekdays ?? []) : [], "::smallint[]");
  if (b.startDate !== undefined) set("start_date", b.startDate);
  if (b.endDate !== undefined) set("end_date", b.endDate);
  if (b.startTime !== undefined) set("start_time", b.startTime);
  if (b.durationMin !== undefined) set("duration_min", b.durationMin);
  if (b.timezone !== undefined) set("timezone", b.timezone);
  if (b.mode !== undefined) set("mode", b.mode);
  if (b.room !== undefined) set("room", b.room || null);
  if (b.meetingUrl !== undefined) set("meeting_url", merged.meetingUrl);
  if (b.host !== undefined) set("host", b.host);
  if (b.description !== undefined) set("description", b.description);
  if (!sets.length) return badRequest(res, "NO_FIELDS");
  const { rows } = await pool.query<SessionRow>(`UPDATE academy_sessions s SET ${sets.join(", ")}, updated_at = NOW() WHERE s.id = $1 RETURNING ${SES_COLS}`, params);
  res.json(mapSession(rows[0], langOf(req)));
}));

router.post("/academy/sessions/:id/archive", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const id = idParam(req); if (!id) return badRequest(res, "INVALID_ID");
  const { rows } = await pool.query<SessionRow>(`UPDATE academy_sessions s SET archived_at = NOW(), updated_at = NOW() WHERE s.id = $1 AND s.archived_at IS NULL RETURNING ${SES_COLS}`, [id]);
  if (!rows[0]) throw notFound("SESSION_NOT_FOUND");
  res.json(mapSession(rows[0], langOf(req)));
}));

async function sessionById(id: number): Promise<SessionRow | null> {
  const { rows } = await pool.query<SessionRow>(`SELECT ${SES_COLS} FROM academy_sessions s WHERE s.id = $1`, [id]);
  return rows[0] ?? null;
}

router.get("/academy/sessions/:id/roster", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const id = idParam(req); if (!id) return badRequest(res, "INVALID_ID");
  const s = await sessionById(id);
  if (!s) throw notFound("SESSION_NOT_FOUND");
  const rule = ruleOf(s);
  const date = qs(req, "date") ?? dateInTz(Date.now(), rule.timezone);
  if (!isOccurrence(rule, date)) return badRequest(res, "NOT_SESSION_DAY", { date });
  const occ = occurrenceAt(rule, date);
  const enr = await pool.query<EnrollmentRow>(
    `SELECT ${ENR_COLS} FROM academy_enrollments e WHERE e.cohort_id = $1 AND e.archived_at IS NULL AND e.status IN ('active','paused') AND e.joined_on <= $2::date
      ORDER BY e.user_name`, [s.cohort_id, date]);
  const att = await pool.query<AttRow>(
    `SELECT session_id, occurrence_date::text AS occurrence_date, user_name, status, source, checked_in_at, marked_by, note
       FROM academy_attendance WHERE session_id = $1 AND occurrence_date = $2::date`, [id, date]);
  const byUser = new Map(att.rows.map((r) => [r.user_name, r]));
  res.json({
    session: mapSession(s, langOf(req)),
    occurrence: { date, startUtc: new Date(occ.startMs).toISOString(), endUtc: new Date(occ.endMs).toISOString() },
    roster: enr.rows.map((e) => {
      const a = byUser.get(e.user_name);
      return {
        enrollment: mapEnrollment(e, langOf(req)),
        status: (a?.status as AttendanceStatus | undefined) ?? null, source: a?.source ?? null, checkedInAt: a?.checked_in_at ?? null,
        markedBy: a?.marked_by ?? null, note: a?.note ?? "",
      };
    }),
  });
}));

const attendanceBody = z.object({
  sessionId: z.number().int().positive(),
  date: ymd,
  marks: z.array(z.object({ userName: name, status: z.enum(ATTENDANCE_STATUSES), note: z.string().max(500).optional() })).min(1).max(200),
});

router.post("/academy/attendance", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const p = attendanceBody.safeParse(req.body ?? {});
  if (!p.success) return badRequest(res, p.error);
  const b = p.data;
  const s = await sessionById(b.sessionId);
  if (!s) throw notFound("SESSION_NOT_FOUND");
  const rule = ruleOf(s);
  if (!isOccurrence(rule, b.date)) return badRequest(res, "NOT_SESSION_DAY", { date: b.date });
  const occ = occurrenceAt(rule, b.date);
  // Заранее можно отметить только «уважительная причина»; присутствие/пропуск — когда занятие уже началось.
  const started = Date.now() >= occ.startMs - CHECKIN_BEFORE_MIN * 60000;
  if (!started && b.marks.some((m) => m.status !== "excused")) return badRequest(res, "SESSION_NOT_STARTED");
  const enrolled = await pool.query<{ user_name: string }>(
    `SELECT user_name FROM academy_enrollments WHERE cohort_id = $1 AND archived_at IS NULL AND user_name = ANY($2::text[])`,
    [s.cohort_id, b.marks.map((m) => m.userName)]);
  const ok = new Set(enrolled.rows.map((r) => r.user_name));
  const skipped = b.marks.filter((m) => !ok.has(m.userName)).map((m) => m.userName);
  let saved = 0;
  for (const m of b.marks) {
    if (!ok.has(m.userName)) continue;
    await pool.query(
      `INSERT INTO academy_attendance (session_id, occurrence_date, user_name, status, source, marked_by, note)
       VALUES ($1, $2::date, $3, $4, 'mentor', $5, $6)
       ON CONFLICT (session_id, occurrence_date, user_name)
       DO UPDATE SET status = EXCLUDED.status, source = 'mentor', marked_by = EXCLUDED.marked_by,
                     note = CASE WHEN $7 THEN EXCLUDED.note ELSE academy_attendance.note END, updated_at = NOW()`,
      [b.sessionId, b.date, m.userName, m.status, v.me, m.note ?? "", m.note !== undefined],
    );
    saved++;
  }
  res.json({ saved, skipped });
}));

router.post("/academy/checkin", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needMember(v, res)) return;
  const p = z.object({ sessionId: z.number().int().positive(), date: ymd.optional() }).safeParse(req.body ?? {});
  if (!p.success) return badRequest(res, p.error);
  const s = await sessionById(p.data.sessionId);
  if (!s || s.archived_at) throw notFound("SESSION_NOT_FOUND");
  if (s.mode === "office") return badRequest(res, "OFFICE_ONLY");
  const enr = await pool.query<{ id: number }>(
    `SELECT id FROM academy_enrollments WHERE cohort_id = $1 AND user_name = $2 AND archived_at IS NULL AND status = 'active'`, [s.cohort_id, v.me]);
  if (!enr.rows.length) throw forbidden(undefined, "NOT_ENROLLED");
  const rule = ruleOf(s);
  const nowMs = Date.now();
  const date = p.data.date ?? dateInTz(nowMs, rule.timezone);
  if (!isOccurrence(rule, date)) return badRequest(res, "NO_OCCURRENCE");
  const occ = occurrenceAt(rule, date);
  const verdict = evaluateCheckin(occ.startMs, nowMs);
  if (!verdict.ok) {
    const early = verdict.reason === "too_early";
    throw conflict(early ? "TOO_EARLY" : "TOO_LATE",
      { opensAt: new Date(verdict.opensMs).toISOString(), closesAt: new Date(verdict.closesMs).toISOString(), serverNow: new Date(nowMs).toISOString() },
      { min: early ? CHECKIN_BEFORE_MIN : CHECKIN_AFTER_MIN });
  }
  const existing = await pool.query<AttRow>(
    `SELECT session_id, occurrence_date::text AS occurrence_date, user_name, status, source, checked_in_at, marked_by, note
       FROM academy_attendance WHERE session_id = $1 AND occurrence_date = $2::date AND user_name = $3`, [s.id, date, v.me]);
  if (existing.rows[0]) {
    const e = existing.rows[0];
    res.json({ already: true, status: e.status, source: e.source, checkedInAt: e.checked_in_at, serverNow: new Date(nowMs).toISOString() });
    return;
  }
  const { rows } = await pool.query<{ status: string; checked_in_at: Date }>(
    `INSERT INTO academy_attendance (session_id, occurrence_date, user_name, status, source, checked_in_at, marked_by)
     VALUES ($1, $2::date, $3, $4, 'self', NOW(), $3)
     ON CONFLICT (session_id, occurrence_date, user_name) DO NOTHING
     RETURNING status, checked_in_at`,
    [s.id, date, v.me, verdict.status],
  );
  res.status(201).json({ already: false, status: rows[0]?.status ?? verdict.status, checkedInAt: rows[0]?.checked_in_at ?? new Date(nowMs), minutesFromStart: verdict.minutesFromStart, serverNow: new Date(nowMs).toISOString() });
}));

router.get("/academy/attendance/stats", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v) return;
  if (!v.me) { res.json({ cohorts: [] }); return; }
  const user = qs(req, "user");
  const target = v.staff ? user ?? null : v.me;
  const cohortId = qs(req, "cohortId") ? Number(qs(req, "cohortId")) : null;
  const params: unknown[] = [];
  let where = "e.archived_at IS NULL AND c.archived_at IS NULL";
  if (target) { params.push(target); where += ` AND e.user_name = $${params.length}`; }
  if (cohortId) { params.push(cohortId); where += ` AND e.cohort_id = $${params.length}`; }
  const { rows } = await pool.query<EnrollmentRow & { cohort_name: string }>(
    `SELECT ${ENR_COLS}, c.name AS cohort_name FROM academy_enrollments e JOIN academy_cohorts c ON c.id = e.cohort_id WHERE ${where} ORDER BY c.name, e.user_name`, params);
  const byCohort = new Map<number, { name: string; list: EnrollmentRow[] }>();
  for (const r of rows) { const x = byCohort.get(r.cohort_id) ?? { name: r.cohort_name, list: [] }; x.list.push(r); byCohort.set(r.cohort_id, x); }
  const out = [];
  for (const [cid, x] of byCohort) {
    const att = await cohortAttendance(cid, x.list.map((e) => ({ name: e.user_name, joinedOn: e.joined_on })));
    out.push({
      cohortId: cid, cohortName: x.name,
      total: mergeSummaries([...att.values()].map((a) => a.all)),
      students: x.list.map((e) => ({ userName: e.user_name, all: att.get(e.user_name)?.all ?? null, last30: att.get(e.user_name)?.last30 ?? null })),
    });
  }
  res.json({ cohorts: out });
}));

/* ═══ 1:1 и договорённости ══════════════════════════════════════════════════ */

const actionInput = z.object({
  title: z.string().trim().min(2).max(300),
  dueOn: ymd.nullable().optional(),
  owner: z.enum(["student", "mentor"]).default("student"),
});

const meetingBody = z.object({
  student: name,
  mentor: name.optional(),
  cohortId: z.number().int().positive().nullable().optional(),
  metAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "metAt: ISO time"),
  durationMin: z.number().int().min(5).max(480).nullable().optional(),
  format: z.enum(["office", "online"]).default("office"),
  agenda: z.string().max(4000).default(""),
  notes: z.string().max(10000).default(""),
  privateNotes: z.string().max(10000).default(""),
  actionItems: z.array(actionInput).max(30).default([]),
});

async function insertAction(student: string, a: z.infer<typeof actionInput>, meetingId: number | null, actor: string): Promise<ActionRow> {
  const { rows } = await pool.query<ActionRow>(
    `INSERT INTO academy_action_items (meeting_id, student, owner, title, due_on, created_by) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, meeting_id, student, owner, title, due_on::text AS due_on, status, done_at, created_by, created_at, updated_at`,
    [meetingId, student, a.owner, a.title, a.dueOn ?? null, actor],
  );
  if (a.owner === "student" && student !== actor) {
    await notifySafe({
      userName: student, type: "academy_action_assigned", params: { title: a.title, due: a.dueOn ?? null },
      link: "/academy/my", entityType: "academy_action", entityId: rows[0].id, actor, source: "academy",
    });
  }
  return rows[0];
}

router.get("/academy/one-on-ones", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v) return;
  if (!v.me) { res.json({ meetings: [] }); return; }
  const params: unknown[] = [];
  let where = "m.archived_at IS NULL";
  const student = v.staff ? qs(req, "student") : v.me;
  if (student) { params.push(student); where += ` AND m.student = $${params.length}`; }
  const mentor = v.staff ? qs(req, "mentor") : undefined;
  if (mentor) { params.push(mentor); where += ` AND m.mentor = $${params.length}`; }
  const { rows } = await pool.query<MeetRow>(`SELECT ${MEET_COLS} FROM academy_one_on_ones m WHERE ${where} ORDER BY m.met_at DESC, m.id DESC LIMIT 200`, params);
  const ids = rows.map((r) => r.id);
  const acts = ids.length
    ? (await pool.query<ActionRow>(`SELECT ${ACT_COLS} FROM academy_action_items a WHERE a.meeting_id = ANY($1::int[]) AND a.archived_at IS NULL ORDER BY a.id`, [ids])).rows
    : [];
  const today = nyDate();
  res.json({ meetings: rows.map((m) => ({ ...mapMeeting(m, v.staff), actionItems: acts.filter((a) => a.meeting_id === m.id).map((a) => mapAction(a, today)) })) });
}));

router.post("/academy/one-on-ones", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const p = meetingBody.safeParse(req.body ?? {});
  if (!p.success) return badRequest(res, p.error);
  const b = p.data;
  if (!(await userExists(b.student))) return void sendError(res, notFound("USER_NOT_FOUND"));
  const mentor = b.mentor ?? v.me;
  if (mentor !== v.me && !(await userExists(mentor))) return void sendError(res, notFound("USER_NOT_FOUND"));
  const { rows } = await pool.query<MeetRow>(
    `INSERT INTO academy_one_on_ones (student, mentor, cohort_id, met_at, duration_min, format, agenda, notes, private_notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${MEET_COLS.replace(/m\./g, "")}`,
    [b.student, mentor, b.cohortId ?? null, new Date(b.metAt), b.durationMin ?? null, b.format, b.agenda, b.notes, b.privateNotes, v.me],
  );
  const items = [];
  for (const a of b.actionItems) items.push(mapAction(await insertAction(b.student, a, rows[0].id, v.me)));
  res.status(201).json({ ...mapMeeting(rows[0], true), actionItems: items });
}));

router.patch("/academy/one-on-ones/:id", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const id = idParam(req); if (!id) return badRequest(res, "INVALID_ID");
  const p = meetingBody.omit({ student: true, actionItems: true }).partial().safeParse(req.body ?? {});
  if (!p.success) return badRequest(res, p.error);
  const b = p.data;
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (b.mentor !== undefined) set("mentor", b.mentor);
  if (b.cohortId !== undefined) set("cohort_id", b.cohortId);
  if (b.metAt !== undefined) set("met_at", new Date(b.metAt));
  if (b.durationMin !== undefined) set("duration_min", b.durationMin);
  if (b.format !== undefined) set("format", b.format);
  if (b.agenda !== undefined) set("agenda", b.agenda);
  if (b.notes !== undefined) set("notes", b.notes);
  if (b.privateNotes !== undefined) set("private_notes", b.privateNotes);
  if (!sets.length) return badRequest(res, "NO_FIELDS");
  const { rows } = await pool.query<MeetRow>(`UPDATE academy_one_on_ones m SET ${sets.join(", ")}, updated_at = NOW() WHERE m.id = $1 AND m.archived_at IS NULL RETURNING ${MEET_COLS}`, params);
  if (!rows[0]) throw notFound("MEETING_NOT_FOUND");
  res.json(mapMeeting(rows[0], true));
}));

router.post("/academy/one-on-ones/:id/archive", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const id = idParam(req); if (!id) return badRequest(res, "INVALID_ID");
  const { rows } = await pool.query<MeetRow>(`UPDATE academy_one_on_ones m SET archived_at = NOW(), updated_at = NOW() WHERE m.id = $1 AND m.archived_at IS NULL RETURNING ${MEET_COLS}`, [id]);
  if (!rows[0]) throw notFound("MEETING_NOT_FOUND");
  res.json(mapMeeting(rows[0], true));
}));

router.get("/academy/action-items", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v) return;
  if (!v.me) { res.json({ items: [] }); return; }
  let students: string[];
  if (v.staff) {
    const s = qs(req, "student");
    students = s ? [s] : (await pool.query<{ student: string }>(`SELECT DISTINCT student FROM academy_action_items WHERE archived_at IS NULL`)).rows.map((r) => r.student);
  } else students = [v.me];
  res.json({ items: await actionsFor(students, { status: qs(req, "status") }) });
}));

router.post("/academy/action-items", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const p = actionInput.extend({ student: name, meetingId: z.number().int().positive().nullable().optional() }).safeParse(req.body ?? {});
  if (!p.success) return badRequest(res, p.error);
  if (!(await userExists(p.data.student))) return void sendError(res, notFound("USER_NOT_FOUND"));
  const row = await insertAction(p.data.student, p.data, p.data.meetingId ?? null, v.me);
  res.status(201).json(mapAction(row));
}));

router.patch("/academy/action-items/:id", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needMember(v, res)) return;
  const id = idParam(req); if (!id) return badRequest(res, "INVALID_ID");
  const p = z.object({
    status: z.enum(ACTION_STATUSES).optional(), title: z.string().trim().min(2).max(300).optional(), dueOn: ymd.nullable().optional(),
    owner: z.enum(["student", "mentor"]).optional(),
  }).safeParse(req.body ?? {});
  if (!p.success) return badRequest(res, p.error);
  const cur = await pool.query<ActionRow>(`SELECT ${ACT_COLS} FROM academy_action_items a WHERE a.id = $1 AND a.archived_at IS NULL`, [id]);
  const a = cur.rows[0];
  if (!a || (!v.staff && a.student !== v.me)) throw notFound("ACTION_NOT_FOUND");
  const b = p.data;
  // Студент может только отметить выполнение своей договорённости (open ⇄ done); правки — наставнику.
  if (!v.staff && (b.title !== undefined || b.dueOn !== undefined || b.owner !== undefined || b.status === "dropped")) {
    throw new AppError("ACTION_STUDENT_DONE_ONLY");
  }
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (b.status !== undefined) { set("status", b.status); sets.push(`done_at = ${b.status === "done" ? "COALESCE(done_at, NOW())" : "NULL"}`); }
  if (b.title !== undefined) set("title", b.title);
  if (b.dueOn !== undefined) { set("due_on", b.dueOn); sets.push("overdue_notified_at = NULL"); }
  if (b.owner !== undefined) set("owner", b.owner);
  if (!sets.length) return badRequest(res, "NO_FIELDS");
  const { rows } = await pool.query<ActionRow>(`UPDATE academy_action_items a SET ${sets.join(", ")}, updated_at = NOW() WHERE a.id = $1 RETURNING ${ACT_COLS}`, params);
  res.json(mapAction(rows[0]));
}));

router.post("/academy/action-items/:id/archive", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const id = idParam(req); if (!id) return badRequest(res, "INVALID_ID");
  const { rows } = await pool.query<ActionRow>(`UPDATE academy_action_items a SET archived_at = NOW(), updated_at = NOW() WHERE a.id = $1 AND a.archived_at IS NULL RETURNING ${ACT_COLS}`, [id]);
  if (!rows[0]) throw notFound("ACTION_NOT_FOUND");
  res.json(mapAction(rows[0]));
}));

/* ═══ ИПР ═══════════════════════════════════════════════════════════════════ */

router.get("/academy/idp/metrics", asyncHandler(async (req, res) => {
  const defs = metricsFor(langOf(req));
  res.json({ metrics: METRIC_KEYS.map((k) => defs[k]) });
}));

router.get("/academy/idp", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v) return;
  if (!v.me) { res.json({ goals: [] }); return; }
  const student = v.staff ? qs(req, "student") ?? v.me : v.me;
  res.json({ student, goals: await goalsFor(student, v.me, langOf(req)) });
}));

const goalBody = z.object({
  student: name,
  title: z.string().trim().min(2).max(300),
  metric: z.enum(METRIC_KEYS),
  comparator: z.enum(COMPARATORS).optional(),
  target: z.number().finite().optional(),
  window: z.number().int().min(1).max(1000).nullable().optional(),
  startDate: ymd.optional(),
  dueOn: ymd.nullable().optional(),
  manualProgress: z.number().min(0).max(100).nullable().optional(),
  note: z.string().max(2000).optional(),
});

router.post("/academy/idp", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const p = goalBody.safeParse(req.body ?? {});
  if (!p.success) return badRequest(res, p.error);
  const b = p.data;
  if (!(await userExists(b.student))) return void sendError(res, notFound("USER_NOT_FOUND"));
  const def = METRICS[b.metric];
  const start = b.startDate ?? nyDate();
  if (b.dueOn && b.dueOn < start) return badRequest(res, "DATE_RANGE_INVALID");
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO academy_idp_goals (student, title, metric, comparator, target, window_n, start_date, due_on, manual_progress, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [b.student, b.title, b.metric, b.comparator ?? def.comparator, b.target ?? def.defaultTarget,
      def.windowKind === "days" || def.windowKind === "trades" ? (b.window ?? def.defaultWindow) : null,
      start, b.dueOn ?? null, b.metric === "manual" ? (b.manualProgress ?? 0) : null, b.note ?? "", v.me],
  );
  if (b.student !== v.me) {
    await notifySafe({
      userName: b.student, type: "academy_goal_assigned",
      params: { title: b.title, metric: b.metric, target: b.target ?? def.defaultTarget, comparator: b.comparator ?? def.comparator, window: b.window ?? def.defaultWindow ?? null, due: b.dueOn ?? null },
      link: "/academy/my", entityType: "academy_goal", entityId: rows[0].id, actor: v.me, source: "academy",
    });
  }
  const goals = await goalsFor(b.student, v.me, langOf(req));
  res.status(201).json(goals.find((g) => g.id === rows[0].id) ?? { id: rows[0].id });
}));

router.patch("/academy/idp/:id", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needMember(v, res)) return;
  const id = idParam(req); if (!id) return badRequest(res, "INVALID_ID");
  const p = goalBody.omit({ student: true, metric: true }).partial().extend({ status: z.enum(GOAL_STATUSES).optional() }).safeParse(req.body ?? {});
  if (!p.success) return badRequest(res, p.error);
  const cur = await pool.query<GoalRow>(`SELECT ${GOAL_COLS} FROM academy_idp_goals g WHERE g.id = $1 AND g.archived_at IS NULL`, [id]);
  const g = cur.rows[0];
  if (!g || (!v.staff && g.student !== v.me)) throw notFound("GOAL_NOT_FOUND");
  const b = p.data;
  if (!v.staff) {
    // Студент может отмечать прогресс только своих ручных целей.
    const keys = Object.keys(b);
    if (g.metric !== "manual" || keys.some((k) => k !== "manualProgress")) throw new AppError("GOAL_STUDENT_MANUAL_ONLY");
  }
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (b.title !== undefined) set("title", b.title);
  if (b.comparator !== undefined) set("comparator", b.comparator);
  if (b.target !== undefined) set("target", b.target);
  if (b.window !== undefined) set("window_n", b.window);
  if (b.startDate !== undefined) set("start_date", b.startDate);
  if (b.dueOn !== undefined) set("due_on", b.dueOn);
  if (b.manualProgress !== undefined && g.metric === "manual") set("manual_progress", b.manualProgress);
  if (b.note !== undefined) set("note", b.note);
  if (b.status !== undefined) {
    // Вручную: отменить или вернуть в работу (achieved/missed ставит пересчёт).
    if (b.status !== "cancelled" && b.status !== "active") return badRequest(res, "GOAL_STATUS_MANUAL");
    set("status", b.status);
    if (b.status === "active") sets.push("achieved_at = NULL", "missed_at = NULL");
  }
  if (!sets.length) return badRequest(res, "NO_FIELDS");
  await pool.query(`UPDATE academy_idp_goals SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1`, params);
  const goals = await goalsFor(g.student, v.me, langOf(req));
  res.json(goals.find((x) => x.id === id) ?? null);
}));

router.post("/academy/idp/:id/archive", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const id = idParam(req); if (!id) return badRequest(res, "INVALID_ID");
  const { rows } = await pool.query<{ id: number }>(`UPDATE academy_idp_goals SET archived_at = NOW(), updated_at = NOW() WHERE id = $1 AND archived_at IS NULL RETURNING id`, [id]);
  if (!rows[0]) throw notFound("GOAL_NOT_FOUND");
  res.json({ id, archived: true });
}));

/* ═══ Дашборды ══════════════════════════════════════════════════════════════ */

async function attendanceStateFor(user: string, occ: OccView[]) {
  if (!occ.length) return new Map<string, AttRow>();
  const minDate = occ.reduce((m, o) => (o.date < m ? o.date : m), occ[0].date);
  const { rows } = await pool.query<AttRow>(
    `SELECT session_id, occurrence_date::text AS occurrence_date, user_name, status, source, checked_in_at, marked_by, note
       FROM academy_attendance WHERE user_name = $1 AND session_id = ANY($2::int[]) AND occurrence_date >= $3::date`,
    [user, [...new Set(occ.map((o) => o.sessionId))], minDate],
  );
  return new Map(rows.map((r) => [`${r.session_id}|${r.occurrence_date}`, r]));
}

router.get("/academy/my", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v) return;
  const nowMs = Date.now();
  const base = { serverNow: new Date(nowMs).toISOString(), checkin: { beforeMin: CHECKIN_BEFORE_MIN, afterMin: CHECKIN_AFTER_MIN, graceMin: LATE_GRACE_MIN } };
  if (!v.me) { res.json({ ...base, user: null, enrollments: [], upcoming: [], recent: [], goals: [], actionItems: [], meetings: [], attendance: null }); return; }
  const user = v.staff ? qs(req, "user") ?? v.me : v.me;
  const { rows: enrRows } = await pool.query<EnrollmentRow & { c_name: string; c_format: string; c_mentor: string | null; c_starts_on: string | null; c_ends_on: string | null; c_timezone: string; c_description: string; c_room: string | null; c_meeting_url: string | null }>(
    `SELECT ${ENR_COLS}, c.name AS c_name, c.format AS c_format, c.mentor AS c_mentor, c.starts_on::text AS c_starts_on, c.ends_on::text AS c_ends_on,
            c.timezone AS c_timezone, c.description AS c_description, c.room AS c_room, c.meeting_url AS c_meeting_url
       FROM academy_enrollments e JOIN academy_cohorts c ON c.id = e.cohort_id
      WHERE e.user_name = $1 AND e.archived_at IS NULL AND c.archived_at IS NULL
      ORDER BY (e.status = 'active') DESC, e.joined_on DESC`,
    [user],
  );
  const enrollments = enrRows.map((r) => ({
    ...mapEnrollment(r, langOf(req)),
    cohort: {
      id: r.cohort_id, name: r.c_name, format: r.c_format, mentor: r.c_mentor, startsOn: r.c_starts_on, endsOn: r.c_ends_on, timezone: r.c_timezone,
      description: r.c_description, room: r.c_room, meetingUrl: r.c_meeting_url,
    },
  }));
  const activeCohorts = enrollments.filter((e) => e.status === "active" || e.status === "paused").map((e) => e.cohortId);
  const names = new Map(enrollments.map((e) => [e.cohortId, e.cohort.name]));
  const sessions = await loadSessions(activeCohorts);
  const todayNy = nyDate(new Date(nowMs));
  const upcoming = expand(sessions, names, addDays(todayNy, -1), addDays(todayNy, 14), langOf(req)).filter((o) => o.endMs > nowMs).slice(0, 30);
  const recentOcc = expand(sessions, names, addDays(todayNy, -14), addDays(todayNy, 1), langOf(req)).filter((o) => o.endMs <= nowMs).slice(-20);
  const marks = await attendanceStateFor(user, [...recentOcc, ...upcoming]);
  const activeSet = new Set(enrollments.filter((e) => e.status === "active").map((e) => e.cohortId));
  const upcomingView = upcoming.map((o) => {
    const m = marks.get(`${o.sessionId}|${o.date}`);
    const verdict = evaluateCheckin(o.startMs, nowMs);
    const selfAllowed = o.mode !== "office" && activeSet.has(o.cohortId) && user === v.me;
    return {
      ...stripMs(o),
      attendance: m ? { status: m.status, source: m.source, checkedInAt: m.checked_in_at } : null,
      checkinOpensAt: new Date(o.startMs - CHECKIN_BEFORE_MIN * 60000).toISOString(),
      checkinClosesAt: new Date(o.startMs + CHECKIN_AFTER_MIN * 60000).toISOString(),
      selfCheckin: selfAllowed,
      canCheckIn: selfAllowed && !m && verdict.ok,
    };
  });
  const recentView = recentOcc.reverse().map((o) => {
    const m = marks.get(`${o.sessionId}|${o.date}`);
    return { ...stripMs(o), attendance: m ? { status: m.status, source: m.source, checkedInAt: m.checked_in_at } : null };
  });
  const attByCohort = [];
  for (const e of enrollments) {
    const a = await cohortAttendance(e.cohortId, [{ name: user, joinedOn: e.joinedOn }]);
    attByCohort.push({ cohortId: e.cohortId, cohortName: e.cohort.name, ...(a.get(user) ?? { all: summarizeAttendance([]), last30: summarizeAttendance([]) }) });
  }
  const [goals, actionItems, meetings] = await Promise.all([
    goalsFor(user, v.me, langOf(req)),
    actionsFor([user]),
    pool.query<MeetRow>(`SELECT ${MEET_COLS} FROM academy_one_on_ones m WHERE m.student = $1 AND m.archived_at IS NULL ORDER BY m.met_at DESC LIMIT 10`, [user]),
  ]);
  const history = enrollments.length
    ? (await pool.query(
        `SELECT id, enrollment_id AS "enrollmentId", from_stage AS "fromStage", to_stage AS "toStage", from_status AS "fromStatus", to_status AS "toStatus",
                changed_by AS "changedBy", note, changed_at AS "changedAt"
           FROM academy_enrollment_history WHERE user_name = $1 ORDER BY changed_at DESC, id DESC LIMIT 20`, [user])).rows
    : [];
  res.json({
    ...base,
    user,
    viewingOther: user !== v.me,
    enrollments,
    upcoming: upcomingView,
    recent: recentView,
    attendance: { byCohort: attByCohort, total: mergeSummaries(attByCohort.map((a) => a.all)) },
    goals,
    actionItems: actionItems.filter((a) => a.status === "open" || (a.doneAt && Date.now() - new Date(a.doneAt).getTime() < 30 * 86_400_000)),
    meetings: meetings.rows.map((m) => mapMeeting(m, v.staff)),
    history,
  });
}));

router.get("/academy/mentor", asyncHandler(async (req, res) => {
  const v = await enter(req, res); if (!v || !needStaff(v, res)) return;
  const nowMs = Date.now();
  const today = nyDate(new Date(nowMs));
  const all = qs(req, "all") === "1";
  const { rows: allCohorts } = await pool.query<CohortRow>(`SELECT ${COHORT_COLS} FROM academy_cohorts c WHERE c.archived_at IS NULL ORDER BY c.name`);
  const mine = allCohorts.filter((c) => c.mentor === v.me);
  const cohorts = all || !mine.length ? allCohorts : mine;
  const cohortIds = cohorts.map((c) => c.id);
  const names = new Map(cohorts.map((c) => [c.id, c.name]));
  const { rows: enr } = cohortIds.length
    ? await pool.query<EnrollmentRow>(
        `SELECT ${ENR_COLS} FROM academy_enrollments e WHERE e.cohort_id = ANY($1::int[]) AND e.archived_at IS NULL AND e.status IN ('active','paused') ORDER BY e.user_name`,
        [cohortIds])
    : { rows: [] as EnrollmentRow[] };

  // Посещаемость по когортам
  const att = new Map<string, { all: AttendanceSummary; last30: AttendanceSummary }>();
  for (const cid of cohortIds) {
    const list = enr.filter((e) => e.cohort_id === cid);
    const m = await cohortAttendance(cid, list.map((e) => ({ name: e.user_name, joinedOn: e.joined_on })));
    for (const e of list) { const x = m.get(e.user_name); if (x) att.set(`${cid}|${e.user_name}`, x); }
  }

  const students = [...new Set(enr.map((e) => e.user_name))];
  const actions = await actionsFor(students);
  const lastTrade = new Map<string, string>();
  const lastJournal = new Map<string, string>();
  if (students.length) {
    const lt = await pool.query<{ trader: string; d: string }>(
      `SELECT t.trader, MAX(LEFT(${closeDateSql("t")}, 10)) AS d FROM trades t WHERE t.trader = ANY($1::text[]) AND t.deleted_at IS NULL GROUP BY t.trader`, [students]);
    for (const r of lt.rows) lastTrade.set(r.trader, r.d);
    for (const s of students) { const j = await loadJournalDates(s); if (j.length) lastJournal.set(s, j[j.length - 1]); }
  }
  const goalsByStudent = new Map<string, GoalView[]>();
  for (const s of students) goalsByStudent.set(s, await goalsFor(s, v.me, langOf(req)));

  const rows = enr.map((e) => {
    const en = mapEnrollment(e, langOf(req));
    const a = att.get(`${e.cohort_id}|${e.user_name}`) ?? { all: summarizeAttendance([]), last30: summarizeAttendance([]) };
    const goals = goalsByStudent.get(e.user_name) ?? [];
    const myActions = actions.filter((x) => x.student === e.user_name);
    const atRisk = goals.filter((g) => g.status === "active" && g.dueOn && g.dueOn >= today && g.dueOn <= addDays(today, 3) && g.eval.progress < 0.7).length;
    const reasons = lagReasons({
      today, stage: en.stage, status: en.status, joinedOn: e.joined_on, attendance: a.last30.total ? a.last30 : a.all,
      overdueActions: myActions.filter((x) => x.overdue).length, missedGoals: goals.filter((g) => g.status === "missed").length, atRiskGoals: atRisk,
      lastTradeDate: lastTrade.get(e.user_name) ?? null, lastJournalDate: lastJournal.get(e.user_name) ?? null,
    }, langOf(req));
    return {
      enrollment: en, cohortName: names.get(e.cohort_id) ?? "", attendance: a.all, attendance30: a.last30,
      goals: {
        active: goals.filter((g) => g.status === "active").length, achieved: goals.filter((g) => g.status === "achieved").length,
        missed: goals.filter((g) => g.status === "missed").length, atRisk,
        avgProgress: goals.filter((g) => g.status === "active").length
          ? goals.filter((g) => g.status === "active").reduce((s, g) => s + g.eval.progress, 0) / goals.filter((g) => g.status === "active").length
          : null,
        list: goals.map((g) => ({ id: g.id, title: g.title, status: g.status, formula: g.formula, progress: g.eval.progress, value: g.eval.value, unit: g.unit, dueOn: g.dueOn, detail: g.eval.detail })),
      },
      openActions: myActions.filter((x) => x.status === "open").length,
      overdueActions: myActions.filter((x) => x.overdue).length,
      lastTradeDate: lastTrade.get(e.user_name) ?? null,
      lastJournalDate: lastJournal.get(e.user_name) ?? null,
      reasons, score: lagScore(reasons),
    };
  }).sort((a, b) => b.score - a.score || a.enrollment.userName.localeCompare(b.enrollment.userName, "ru"));

  // Сегодняшние занятия (по дате NY) + сколько отмечено
  const sessions = await loadSessions(cohortIds);
  const todays = expand(sessions, names, addDays(today, -1), addDays(today, 1), langOf(req)).filter((o) => dateInTz(o.startMs, NY_TZ) === today);
  const todaysView = [];
  for (const o of todays) {
    const expected = enr.filter((e) => e.cohort_id === o.cohortId && e.joined_on <= o.date).length;
    const { rows: m } = await pool.query<{ status: string; n: number }>(
      `SELECT status, COUNT(*)::int AS n FROM academy_attendance WHERE session_id = $1 AND occurrence_date = $2::date GROUP BY status`, [o.sessionId, o.date]);
    const by: Record<string, number> = {};
    for (const r of m) by[r.status] = r.n;
    todaysView.push({
      ...stripMs(o), expected, marked: Object.values(by).reduce((s, n) => s + n, 0), byStatus: by,
      phase: nowMs < o.startMs ? "upcoming" : nowMs <= o.endMs ? "live" : "done",
    });
  }

  const meetings = students.length
    ? (await pool.query<MeetRow>(`SELECT ${MEET_COLS} FROM academy_one_on_ones m WHERE m.student = ANY($1::text[]) AND m.archived_at IS NULL ORDER BY m.met_at DESC LIMIT 30`, [students])).rows
    : [];
  const lastMeeting = new Map<string, Date>();
  for (const m of meetings) if (!lastMeeting.has(m.student)) lastMeeting.set(m.student, m.met_at);

  res.json({
    serverNow: new Date(nowMs).toISOString(),
    scope: all || !mine.length ? "all" : "mine",
    hasOwnCohorts: mine.length > 0,
    cohorts: cohorts.map(mapCohort),
    students: rows.map((r) => ({ ...r, lastMeetingAt: lastMeeting.get(r.enrollment.userName) ?? null })),
    lagging: rows.filter((r) => r.score > 0).length,
    today: todaysView,
    openActions: actions.filter((a) => a.status === "open"),
    meetings: meetings.map((m) => mapMeeting(m, true)),
  });
}));

/* ═══ Демо-данные ═══════════════════════════════════════════════════════════ */

/**
 * Идемпотентный сид. Только существующие пользователи (новые аккаунты не создаются; отсутствующие пропускаются).
 *  - «Офис — осень 2026» (office, наставник Антон): Закир (стажёр), Артур (джун), Рахматулло (стажёр) и Ориф (трейдер) —
 *    Ориф записан демо-студентом, потому что только у него есть реальные сделки (910 шт.) и метрики ИПР показывают живой прогресс.
 *  - «Удалённо — осень 2026» (remote, наставник Ориф — чтобы под его входом был виден и дашборд наставника): Умид (стажёр), Максат (джун).
 *  Занятия: премаркет-брифинг по будням 09:00 ET, разбор недели по пятницам 16:30 ET, по одному разовому занятию.
 *  Отметки за прошедшие брифинги последних 7 дней, 1:1 с договорённостями, цели ИПР.
 */
export async function seedDemo(actor: string | null): Promise<Record<string, unknown>> {
  await ensureAcademyCohortTables();
  const { rows: users } = await pool.query<{ name: string }>(`SELECT name FROM users WHERE active = true AND COALESCE(banned, false) = false`);
  const have = new Set(users.map((u) => u.name));
  const pick = (n: string) => (have.has(n) ? n : null);
  const created: Record<string, number> = { cohorts: 0, enrollments: 0, sessions: 0, attendance: 0, meetings: 0, actionItems: 0, goals: 0 };
  const skippedUsers = new Set<string>();
  const today = nyDate();

  async function cohort(nameC: string, format: string, mentor: string | null, room: string | null, url: string | null, description: string): Promise<number> {
    const ex = await pool.query<{ id: number }>(`SELECT id FROM academy_cohorts WHERE name = $1 AND archived_at IS NULL`, [nameC]);
    if (ex.rows[0]) return ex.rows[0].id;
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO academy_cohorts (name, format, mentor, starts_on, ends_on, timezone, description, room, meeting_url, created_by)
       VALUES ($1, $2, $3, '2026-09-01', '2026-12-18', 'America/New_York', $4, $5, $6, $7) RETURNING id`,
      [nameC, format, mentor, description, room, url, actor]);
    created.cohorts++;
    return rows[0].id;
  }
  async function enroll(cohortId: number, user: string, stage: Stage, joinedOn: string): Promise<void> {
    if (!have.has(user)) { skippedUsers.add(user); return; }
    const ex = await pool.query(`SELECT 1 FROM academy_enrollments WHERE cohort_id = $1 AND user_name = $2 AND archived_at IS NULL`, [cohortId, user]);
    if (ex.rows.length) return;
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO academy_enrollments (cohort_id, user_name, stage, status, joined_on, created_by) VALUES ($1, $2, $3, 'active', $4, $5) RETURNING id`,
      [cohortId, user, stage, joinedOn, actor]);
    await pool.query(
      `INSERT INTO academy_enrollment_history (enrollment_id, cohort_id, user_name, from_stage, to_stage, from_status, to_status, changed_by, note)
       VALUES ($1, $2, $3, NULL, $4, NULL, 'active', $5, $6)`, [rows[0].id, cohortId, user, stage, actor, DEMO.historyNote]);
    created.enrollments++;
  }
  async function session(cohortId: number, s: { title: string; kind: string; recurrence: string; weekdays?: number[]; startDate: string; startTime: string; durationMin: number; mode: string; room?: string | null; url?: string | null; host: string | null; description: string }): Promise<number> {
    const ex = await pool.query<{ id: number }>(`SELECT id FROM academy_sessions WHERE cohort_id = $1 AND title = $2 AND archived_at IS NULL`, [cohortId, s.title]);
    if (ex.rows[0]) return ex.rows[0].id;
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO academy_sessions (cohort_id, title, kind, recurrence, weekdays, start_date, start_time, duration_min, timezone, mode, room, meeting_url, host, description, created_by)
       VALUES ($1, $2, $3, $4, $5::smallint[], $6, $7, $8, 'America/New_York', $9, $10, $11, $12, $13, $14) RETURNING id`,
      [cohortId, s.title, s.kind, s.recurrence, s.weekdays ?? [], s.startDate, s.startTime, s.durationMin, s.mode, s.room ?? null, s.url ?? null, s.host, s.description, actor]);
    created.sessions++;
    return rows[0].id;
  }
  async function marks(sessionId: number, pattern: Record<string, AttendanceStatus[]>, mentor: string | null): Promise<void> {
    const s = await sessionById(sessionId);
    if (!s) return;
    const now = Date.now();
    const past = occurrences(ruleOf(s), addDays(today, -7), today).filter((o) => o.endMs <= now).map((o) => o.date);
    for (const [user, seq] of Object.entries(pattern)) {
      if (!have.has(user)) continue;
      for (let i = 0; i < past.length; i++) {
        const status = seq[(past.length - 1 - i) % seq.length]; // seq[0] — самое свежее занятие
        const r = await pool.query(
          `INSERT INTO academy_attendance (session_id, occurrence_date, user_name, status, source, marked_by, checked_in_at)
           VALUES ($1, $2::date, $3, $4, $5, $6, NULL) ON CONFLICT (session_id, occurrence_date, user_name) DO NOTHING`,
          [sessionId, past[i], user, status, "mentor", mentor]);
        created.attendance += r.rowCount ?? 0;
      }
    }
  }
  async function goal(student: string, g: { title: string; metric: MetricKey; target: number; comparator: Comparator; window: number | null; startDate: string; dueOn: string | null; manualProgress?: number }): Promise<void> {
    if (!have.has(student)) return;
    const ex = await pool.query(`SELECT 1 FROM academy_idp_goals WHERE student = $1 AND title = $2 AND archived_at IS NULL`, [student, g.title]);
    if (ex.rows.length) return;
    await pool.query(
      `INSERT INTO academy_idp_goals (student, title, metric, comparator, target, window_n, start_date, due_on, manual_progress, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [student, g.title, g.metric, g.comparator, g.target, g.window, g.startDate, g.dueOn, g.manualProgress ?? null, actor]);
    created.goals++;
  }
  async function meeting(student: string, mentor: string | null, metAtIso: string, m: { agenda: string; notes: string; privateNotes: string; format: string; actions: { title: string; dueOn: string; owner: "student" | "mentor"; status?: ActionStatusT }[] }): Promise<void> {
    if (!have.has(student) || !mentor) return;
    const ex = await pool.query<{ id: number }>(`SELECT id FROM academy_one_on_ones WHERE student = $1 AND mentor = $2 AND met_at = $3 AND archived_at IS NULL`, [student, mentor, metAtIso]);
    let id = ex.rows[0]?.id;
    if (!id) {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO academy_one_on_ones (student, mentor, met_at, duration_min, format, agenda, notes, private_notes, created_by)
         VALUES ($1, $2, $3, 45, $4, $5, $6, $7, $8) RETURNING id`,
        [student, mentor, metAtIso, m.format, m.agenda, m.notes, m.privateNotes, actor]);
      id = rows[0].id;
      created.meetings++;
    }
    for (const a of m.actions) {
      const exA = await pool.query(`SELECT 1 FROM academy_action_items WHERE student = $1 AND title = $2 AND archived_at IS NULL`, [student, a.title]);
      if (exA.rows.length) continue;
      const status = a.status ?? "open";
      // Сид не рассылает уведомления: просроченные договорённости помечаются как уже уведомлённые.
      await pool.query(
        `INSERT INTO academy_action_items (meeting_id, student, owner, title, due_on, status, done_at, overdue_notified_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, student, a.owner, a.title, a.dueOn, status, status === "done" ? new Date() : null, a.dueOn < today ? new Date() : null, actor]);
      created.actionItems++;
    }
  }

  // Demo data lives in lib/academyCohortsDemo.ts (seed rows: user content afterwards).
  const mentorOf = { office: pick(DEMO.mentors.office), remote: pick(DEMO.mentors.remote) };
  const office = await cohort(DEMO.cohorts.office.name, DEMO.cohorts.office.format, mentorOf.office, DEMO.cohorts.office.room, DEMO.cohorts.office.url, DEMO.cohorts.office.description);
  const remote = await cohort(DEMO.cohorts.remote.name, DEMO.cohorts.remote.format, mentorOf.remote, DEMO.cohorts.remote.room, DEMO.cohorts.remote.url, DEMO.cohorts.remote.description);
  const cohortId = { office, remote };

  for (const e of DEMO.enrollments) await enroll(cohortId[e.cohort], e.user, e.stage, e.joinedOn);
  const sessionIds: Record<string, number> = {};
  for (const x of DEMO.sessions) {
    sessionIds[x.key] = await session(cohortId[x.cohort], {
      title: x.title, kind: x.kind, recurrence: x.recurrence, weekdays: x.weekdays, startDate: x.startDate, startTime: x.startTime, durationMin: x.durationMin,
      mode: x.mode, room: x.room ?? null, url: x.url ?? null, host: mentorOf[x.cohort], description: x.description,
    });
  }
  for (const m of DEMO.marks) await marks(sessionIds[m.session], m.pattern, mentorOf[m.mentor]);
  for (const g of DEMO.goals) {
    const { student, ...rest } = g;
    await goal(student, rest);
  }
  for (const m of DEMO.meetings) {
    await meeting(m.student, mentorOf[m.mentor], m.metAt, { format: m.format, agenda: m.agenda, notes: m.notes, privateNotes: m.privateNotes, actions: m.actions });
  }
  void DEMO_URL;

  return { ok: true, cohorts: { office, remote }, created, skippedUsers: [...skippedUsers] };
}
type ActionStatusT = (typeof ACTION_STATUSES)[number];

export default router;
