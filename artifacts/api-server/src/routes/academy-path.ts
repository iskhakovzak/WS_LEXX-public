/**
 * «Путь трейдера и экзамены» (Academy F3) — stage ladder Стажёр → Джун → Трейдер → Сеньор, objective promotion
 * readiness from real trades, mentor approve/reject, and prop-style evaluation challenges.
 *
 * Ladder / readiness
 *   GET  /academy/path/config                     stages, criteria, metric meta, templates (any member; canEdit = staff)
 *   PUT  /academy/path/stages                     staff — names / descriptions / scaling tier per stage (keys are fixed)
 *   PUT  /academy/path/criteria                   staff — replace the criteria set (removed rows are archived, never deleted)
 *   GET  /academy/path/report?user=&date=         readiness report (trader: self only; staff: anyone)
 *   GET  /academy/path/funnel?date=               staff — everybody grouped by stage with readiness
 *   GET  /academy/path/requests?status=&user=     promotion requests (trader: own)
 *   POST /academy/path/requests                   {user?, comment?} — trader asks for self, staff for anyone
 *   POST /academy/path/requests/:id/approve       staff {comment?} — comment required when the report is not "ready"
 *   POST /academy/path/requests/:id/reject        staff {comment} (required)
 *   POST /academy/path/requests/:id/withdraw      the requester / the trader
 *   POST /academy/path/assign                     staff {user, stage, comment} — direct stage change (logged)
 *   GET  /academy/path/history?user=              stage changes (trader: own)
 * Challenges
 *   GET  /academy/challenges/templates
 *   GET  /academy/challenges?user=&status=&archived=   list with live status (trader: own; staff: all)
 *   GET  /academy/challenges/:id                  full evaluation: per-rule progress + day-by-day timeline
 *   POST /academy/challenges                      staff {user, templateKey, startsOn, endsOn?, name?, rules?, comment?}
 *   POST /academy/challenges/:id/archive          staff (soft delete)
 *   POST /academy/path/seed-demo                  staff — idempotent demo challenges (never called automatically)
 *
 * Evaluation is lazy: challenge status / readiness are recomputed on read; a status change is cached in the row and
 * produces one in-app notification (notifyUser) per transition. Tables are additive and created idempotently here.
 * Money = net of fees via lib/tradeMath, trading date = NY (lib/tradingDate). Optional sources are probed at runtime:
 * behaviour engine (routes/behavior + lib/behaviorEngine), F1 learning tables, F2 enrollments.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { academyPathT, stageDescriptionFor, stageNameFor } from "../lib/academyI18n";
import { langOf, type Lang } from "../i18n";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { logger } from "../lib/logger";
import { logAudit } from "../lib/audit";
import { isGuest, isStaffRole, requireMember, scopeTrader, viewerRole, GUEST_SCOPE } from "../lib/auth";
import { nyDate, nyMinutes } from "../lib/tradingDate";
import { closeDateSql, closedSql, netPnlSql, resultSql, signedRSql, num } from "../lib/tradeMath";
import { execSpanJoin } from "../lib/execSpan";
import { notifyUser, notifyUsers, assignedStaffOf } from "../lib/notifyUtils";
import { DEFAULT_TIERS, OPS, windowStart, type Op, type Tier } from "../lib/scalingEngine";
import {
  DEFAULT_CRITERIA, DEFAULT_STAGES, LEGACY_TRAINEE_DESCRIPTION, TRAINEE_DESCRIPTION, promoMetricsFor, PROMO_METRIC_KEYS, STAGE_KEYS, evaluatePromotion, isStageKey,
  resolveWindow, sortStages, type Criterion, type LearningInput, type PromoMetricKey, type PromoTrade, type PromotionInput,
  type ReadinessReport, type StageKey, type StageMeta,
} from "../lib/promotionEngine";
import {
  statusLabelsFor, templatesFor, challengeNameFor, TEMPLATE_BY_KEY, endDateFor, evaluateChallenge, normalizeRules,
  type ChallengeResult, type ChallengeRules, type ChallengeStatus, type ChallengeTrade,
} from "../lib/challengeEngine";
import { AppError, badRequest, conflict, notFound, sendError, unauthorized, type ErrorCode } from "../lib/http";

const router: IRouter = Router();

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const PATH_LINK = (user?: string | null) => (user ? `/academy/path?user=${encodeURIComponent(user)}` : "/academy/path");
const CH_LINK = (id: number) => `/academy/challenges?id=${id}`;
const usd = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("ru-RU", { maximumFractionDigits: 0 })}`;

// ─── tables ─────────────────────────────────────────────────────────────────

let ensured: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS academy_stages (
          key TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          description TEXT,
          scaling_tier TEXT,
          updated_by TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS academy_stage_criteria (
          id SERIAL PRIMARY KEY,
          from_stage TEXT NOT NULL,
          metric TEXT NOT NULL,
          op TEXT NOT NULL,
          value NUMERIC(14,4) NOT NULL,
          window_days INTEGER,
          label TEXT,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          updated_by TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS academy_stage_criteria_stage_idx ON academy_stage_criteria(from_stage) WHERE archived_at IS NULL;
        CREATE TABLE IF NOT EXISTS academy_trader_stage (
          user_name TEXT PRIMARY KEY,
          stage TEXT NOT NULL,
          since TEXT NOT NULL,
          updated_by TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS academy_stage_history (
          id SERIAL PRIMARY KEY,
          user_name TEXT NOT NULL,
          from_stage TEXT,
          to_stage TEXT NOT NULL,
          action TEXT NOT NULL,
          request_id INTEGER,
          actor TEXT NOT NULL,
          comment TEXT,
          report JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS academy_stage_history_user_idx ON academy_stage_history(user_name, created_at DESC);
        CREATE TABLE IF NOT EXISTS academy_promotion_requests (
          id SERIAL PRIMARY KEY,
          user_name TEXT NOT NULL,
          from_stage TEXT,
          to_stage TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          passed INTEGER NOT NULL DEFAULT 0,
          total INTEGER NOT NULL DEFAULT 0,
          ready BOOLEAN NOT NULL DEFAULT FALSE,
          report JSONB,
          comment TEXT,
          requested_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          decided_by TEXT,
          decided_at TIMESTAMPTZ,
          decision_comment TEXT,
          archived_at TIMESTAMPTZ
        );
        CREATE UNIQUE INDEX IF NOT EXISTS academy_promotion_requests_pending_uniq ON academy_promotion_requests(user_name) WHERE status = 'pending';
        CREATE INDEX IF NOT EXISTS academy_promotion_requests_user_idx ON academy_promotion_requests(user_name, created_at DESC);
        CREATE TABLE IF NOT EXISTS academy_readiness_notices (
          user_name TEXT NOT NULL,
          stage TEXT NOT NULL,
          notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_name, stage)
        );
        CREATE TABLE IF NOT EXISTS academy_challenges (
          id SERIAL PRIMARY KEY,
          user_name TEXT NOT NULL,
          template_key TEXT,
          name TEXT NOT NULL,
          rules JSONB NOT NULL,
          starts_on TEXT NOT NULL,
          ends_on TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          summary JSONB,
          notified_status TEXT,
          comment TEXT,
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at TIMESTAMPTZ,
          archived_by TEXT
        );
        CREATE INDEX IF NOT EXISTS academy_challenges_user_idx ON academy_challenges(user_name, starts_on DESC) WHERE archived_at IS NULL;
      `);
      const { rows: sc } = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM academy_stages`);
      if (Number(sc[0]?.n ?? 0) === 0) {
        for (const s of DEFAULT_STAGES) {
          await pool.query(
            `INSERT INTO academy_stages (key, name, sort_order, description, scaling_tier, updated_by) VALUES ($1,$2,$3,$4,$5,'system') ON CONFLICT (key) DO NOTHING`,
            [s.key, s.name, s.order, s.description, s.scalingTier],
          );
        }
        logger.info("academy-path: seeded default stages");
      }
      // The first seed described «Стажёр» via the selection / bootcamp funnel, which is not part of the ladder.
      await pool.query(
        `UPDATE academy_stages SET description = $1 WHERE key = 'trainee' AND description = $2 AND updated_by = 'system'`,
        [TRAINEE_DESCRIPTION, LEGACY_TRAINEE_DESCRIPTION],
      );
      const { rows: cc } = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM academy_stage_criteria`);
      if (Number(cc[0]?.n ?? 0) === 0) {
        let i = 0;
        for (const c of DEFAULT_CRITERIA) {
          await pool.query(
            `INSERT INTO academy_stage_criteria (from_stage, metric, op, value, window_days, label, enabled, sort_order, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'system')`,
            [c.fromStage, c.metric, c.op, c.value, c.windowDays, c.label, c.enabled, i++],
          );
        }
        logger.info("academy-path: seeded default criteria");
      }
    })().catch((err) => {
      ensured = null;
      throw err;
    });
  }
  return ensured;
}

// ─── viewer ─────────────────────────────────────────────────────────────────

type Viewer = { name: string; staff: boolean; guest: boolean };
async function viewer(req: Request, res: Response): Promise<Viewer | null> {
  const name = req.authUser?.name;
  if (!name) { sendError(res, unauthorized()); return null; }
  if (isGuest(req)) return { name, staff: false, guest: true };
  return { name, staff: isStaffRole(await viewerRole(req)), guest: false };
}
async function staffOnly(req: Request, res: Response): Promise<Viewer | null> {
  if (!requireMember(req, res)) return null;
  const v = await viewer(req, res);
  if (!v) return null;
  if (!v.staff) { sendError(res, new AppError("STAFF_ONLY")); return null; }
  return v;
}
/** Which single user a read is about: staff → requested or self; trader → self; guest → sentinel (empty). */
async function targetUser(req: Request, requested: unknown): Promise<string | undefined> {
  const want = typeof requested === "string" ? requested.trim() : "";
  const scope = await scopeTrader(req, want || null);
  if (scope === undefined) return undefined;
  return scope ?? req.authUser!.name;
}
function clientDate(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  return YMD_RE.test(s) ? s : nyDate();
}
function bad(res: Response, err: z.ZodError): void {
  sendError(res, badRequest("VALIDATION", err.issues.map((i) => ({ path: i.path.join("."), message: i.message }))));
}

/** Stage with its display name / description in `lang` (stored values are kept in `storedName` for editors). */
function localizeStage<T extends StageMeta | null>(s: T, lang: Lang): T {
  if (!s) return s;
  return { ...s, storedName: s.name, name: stageNameFor(s.key, s.name, lang), description: stageDescriptionFor(s.key, s.description, lang) } as T;
}

/** Stored decision comments written by the system (RU seed) → reader's language; a mentor's comment stays. */
function systemComment(c: string | null, lang: Lang): string | null {
  if (c === academyPathT.tFor("ru")("route.withdrawnDirect")) return academyPathT.tFor(lang)("route.withdrawnDirect");
  if (c === academyPathT.tFor("ru")("route.demo")) return academyPathT.tFor(lang)("route.demo");
  return c;
}

// ─── config loaders ─────────────────────────────────────────────────────────

async function loadStages(): Promise<StageMeta[]> {
  const { rows } = await pool.query(`SELECT * FROM academy_stages`);
  const byKey = new Map(rows.map((r: any) => [String(r.key), r]));
  return sortStages(DEFAULT_STAGES.map((d) => {
    const r: any = byKey.get(d.key);
    return r ? { key: d.key, name: String(r.name), order: Number(r.sort_order) || d.order, description: r.description ?? d.description, scalingTier: r.scaling_tier ?? null } : d;
  }));
}

function rowToCriterion(r: any): Criterion {
  return {
    id: Number(r.id), fromStage: r.from_stage as StageKey, metric: r.metric as PromoMetricKey, op: r.op as Op, value: Number(r.value),
    windowDays: r.window_days == null ? null : Number(r.window_days), label: r.label ?? null, enabled: r.enabled !== false,
  };
}
async function loadCriteria(): Promise<Criterion[]> {
  const { rows } = await pool.query(`SELECT * FROM academy_stage_criteria WHERE archived_at IS NULL ORDER BY sort_order, id`);
  return rows.map(rowToCriterion).filter((c) => isStageKey(c.fromStage) && PROMO_METRIC_KEYS.includes(c.metric));
}

/** Scaling tiers (read-only reuse of the scaling plan's table; defaults when it does not exist yet). */
async function loadTiers(): Promise<Tier[]> {
  try {
    const { rows } = await pool.query(`SELECT * FROM scaling_tiers WHERE active = TRUE`);
    if (!rows.length) return DEFAULT_TIERS;
    return rows.map((r: any) => ({
      key: String(r.key), name: String(r.name), order: Number(r.sort_order) || 0,
      accountSize: num(r.account_size), dailyLossLimit: num(r.daily_loss_limit), weeklyLossLimit: num(r.weekly_loss_limit), maxDrawdown: num(r.max_drawdown),
      maxRiskPerTrade: num(r.max_risk_per_trade), maxPositionUsd: num(r.max_position_usd), maxOvernightExposure: num(r.max_overnight_exposure),
      maxOpenPositions: r.max_open_positions == null ? null : Number(r.max_open_positions), allowOvernight: r.allow_overnight === true, allowSwing: r.allow_swing === true,
      description: r.description ?? null,
    }));
  } catch {
    return DEFAULT_TIERS;
  }
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: string | null }>(`SELECT to_regclass($1)::text AS ok`, [name]);
  return !!rows[0]?.ok;
}

// ─── stage resolution ───────────────────────────────────────────────────────

type StageInfo = { stage: StageKey | null; since: string | null; source: "path" | "enrollment" | "scaling" | null; cohortId: number | null };

/** Stage of each user: own table (set by approvals) → F2 enrollment → scaling tier of trader_risk_limits. */
async function loadStageInfo(users: string[] | null): Promise<Map<string, StageInfo>> {
  const out = new Map<string, StageInfo>();
  const filter = users ? `WHERE user_name = ANY($1::text[])` : "";
  const params = users ? [users] : [];
  const { rows: own } = await pool.query(`SELECT user_name, stage, since FROM academy_trader_stage ${filter}`, params);
  for (const r of own) if (isStageKey(r.stage)) out.set(String(r.user_name), { stage: r.stage, since: r.since ?? null, source: "path", cohortId: null });
  if (await tableExists("academy_enrollments")) {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (user_name) user_name, stage, joined_on::text AS joined_on, cohort_id
           FROM academy_enrollments
          WHERE archived_at IS NULL AND COALESCE(status, 'active') IN ('active','paused') ${users ? "AND user_name = ANY($1::text[])" : ""}
          ORDER BY user_name, joined_on DESC NULLS LAST, id DESC`,
        params,
      );
      for (const r of rows) {
        const name = String(r.user_name);
        const cur = out.get(name);
        if (cur) { cur.cohortId = r.cohort_id == null ? null : Number(r.cohort_id); continue; }
        if (isStageKey(r.stage)) out.set(name, { stage: r.stage, since: r.joined_on ? String(r.joined_on).slice(0, 10) : null, source: "enrollment", cohortId: r.cohort_id == null ? null : Number(r.cohort_id) });
      }
    } catch (err) {
      logger.warn({ err }, "academy-path: enrollments read failed");
    }
  }
  try {
    const { rows } = await pool.query(`SELECT trader, tier FROM trader_risk_limits ${users ? "WHERE trader = ANY($1::text[])" : ""}`, params);
    for (const r of rows) {
      const name = String(r.trader);
      if (!out.has(name) && isStageKey(r.tier)) out.set(name, { stage: r.tier, since: null, source: "scaling", cohortId: null });
    }
  } catch { /* scaling tables optional */ }
  return out;
}

// ─── optional sources ───────────────────────────────────────────────────────

/**
 * F1 learning progress, probed by table/column names (contract proposed to F1):
 *   academy_lessons(id, archived_at?, required?) · academy_lesson_progress(user_name, lesson_id, completed_at | status)
 *   academy_quiz_attempts(user_name, quiz_id, pct | score_pct | percent) — F1 ships `pct` (0..100); raw `score` is points, never used.
 * Returns null when the lesson tables are absent (criteria are then reported as "not counted").
 */
async function loadLearning(user: string): Promise<LearningInput | null> {
  try {
    const { rows } = await pool.query<{ t: string; c: string }>(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name IN ('academy_lessons','academy_lesson_progress','academy_quiz_attempts')`,
    );
    const cols = new Map<string, Set<string>>();
    for (const r of rows) (cols.get(r.t) ?? cols.set(r.t, new Set()).get(r.t)!).add(r.c);
    const L = cols.get("academy_lessons"), P = cols.get("academy_lesson_progress"), Q = cols.get("academy_quiz_attempts");
    if (!L || !P || !P.has("user_name") || !P.has("lesson_id")) return null;
    const lessonWhere = [L.has("archived_at") ? "l.archived_at IS NULL" : "TRUE", L.has("draft") ? "NOT l.draft" : "TRUE", L.has("required") ? "COALESCE(l.required, TRUE)" : "TRUE"].join(" AND ");
    const doneCond = P.has("completed_at") ? "p.completed_at IS NOT NULL" : P.has("status") ? "p.status IN ('completed','done','passed')" : "TRUE";
    const { rows: tot } = await pool.query<{ total: string; done: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM academy_lesson_progress p WHERE p.lesson_id = l.id AND p.user_name = $1 AND ${doneCond}))::text AS done
         FROM academy_lessons l WHERE ${lessonWhere}`,
      [user],
    );
    let quizAvg: number | null = null, quizzesTaken = 0;
    const scoreCol = Q ? ["pct", "score_pct", "percent"].find((c) => Q.has(c)) : undefined;
    if (Q && scoreCol && Q.has("user_name") && Q.has("quiz_id")) {
      const { rows: q } = await pool.query<{ avg: string | null; n: string }>(
        `SELECT AVG(best)::text AS avg, COUNT(*)::text AS n FROM (
           SELECT quiz_id, MAX(${scoreCol})::float8 AS best FROM academy_quiz_attempts WHERE user_name = $1 ${Q.has("archived_at") ? "AND archived_at IS NULL" : ""} GROUP BY quiz_id) s`,
        [user],
      );
      quizAvg = num(q[0]?.avg);
      quizzesTaken = Number(q[0]?.n ?? 0);
    }
    return { lessonsTotal: Number(tot[0]?.total ?? 0), lessonsDone: Number(tot[0]?.done ?? 0), quizAvg, quizzesTaken };
  } catch (err) {
    logger.warn({ err }, "academy-path: learning probe failed");
    return null;
  }
}

/** Behaviour engine daily discipline index (D3). Loaded lazily; null when the engine is unavailable. */
async function loadDiscipline(user: string, from: string, to: string): Promise<{ date: string; score: number }[] | null> {
  try {
    const [beh, eng] = await Promise.all([import("./behavior"), import("../lib/behaviorEngine")]);
    if (typeof beh.loadBehaviorRows !== "function" || typeof eng.analyzeBehavior !== "function") return null;
    const rows = await beh.loadBehaviorRows(user, from, to);
    const trades = rows.map(beh.rowToBehaviorTrade);
    const { contractDeltas } = await import("../lib/daily/discipline");
    const report = eng.analyzeBehavior(trades, {}, undefined, await contractDeltas(user, trades, from, to));
    return report.discipline.map((d) => ({ date: d.date, score: d.score }));
  } catch (err) {
    logger.debug({ err }, "academy-path: behaviour engine unavailable");
    return null;
  }
}

// ─── promotion input ────────────────────────────────────────────────────────

async function loadPromoTrades(user: string, from: string, to: string): Promise<PromoTrade[]> {
  const { rows } = await pool.query(
    `SELECT ${closeDateSql("t")} AS d, ${netPnlSql("t")}::float8 AS net, t.pnl::float8 AS gross, ABS(COALESCE(t.fees, 0))::float8 AS fees,
            ${signedRSql("t")}::float8 AS r, ${resultSql("t")} AS result,
            CASE WHEN t.source = 'propreports' OR t.context_snapshot ->> 'source' = 'propreports' THEN 'propreports' ELSE 'manual' END AS source
       FROM trades t
      WHERE t.deleted_at IS NULL AND t.trader = $1 AND ${closedSql("t")}
        AND ${closeDateSql("t")} >= $2 AND ${closeDateSql("t")} <= $3`,
    [user, from, to],
  );
  const out: PromoTrade[] = [];
  for (const r of rows) {
    const result = r.result as string | null;
    if (result !== "win" && result !== "loss" && result !== "be") continue;
    const d = String(r.d ?? "").slice(0, 10);
    if (!YMD_RE.test(d)) continue;
    out.push({ date: d, net: num(r.net), gross: num(r.gross), fees: num(r.fees) ?? 0, r: num(r.r), result, source: r.source === "propreports" ? "propreports" : "manual" });
  }
  return out;
}

async function loadViolationDates(user: string, from: string): Promise<string[]> {
  const out: string[] = [];
  const v = await pool.query(
    `SELECT COALESCE(NULLIF(day, ''), LEFT(occurred_at::text, 10)) AS d FROM rule_violations WHERE trader = $1 AND occurred_at >= $2::date AND archived_at IS NULL`,
    [user, from],
  ).catch(() => pool.query(`SELECT LEFT(occurred_at::text, 10) AS d FROM rule_violations WHERE trader = $1 AND occurred_at >= $2::date`, [user, from]).catch(() => ({ rows: [] as any[] })));
  for (const r of v.rows) out.push(String(r.d));
  const e = await pool.query(`SELECT LEFT(created_at::text, 10) AS d FROM trading_errors WHERE trader = $1 AND created_at >= $2::date`, [user, from]).catch(() => ({ rows: [] as any[] }));
  for (const r of e.rows) out.push(String(r.d));
  return out;
}

async function buildReport(user: string, today: string, ctx?: { stages: StageMeta[]; criteria: Criterion[]; tiers: Tier[]; info?: StageInfo }, lang: Lang = "ru"): Promise<ReadinessReport & { stageSource: StageInfo["source"]; cohortId: number | null }> {
  const [stages, criteria, tiers] = ctx ? [ctx.stages, ctx.criteria, ctx.tiers] : await Promise.all([loadStages(), loadCriteria(), loadTiers()]);
  const info = ctx?.info ?? (await loadStageInfo([user])).get(user) ?? { stage: null, since: null, source: null, cohortId: null };
  const mine = criteria.filter((c) => c.enabled && c.fromStage === info.stage);
  const maxWin = Math.max(20, ...mine.map((c) => resolveWindow(c.windowDays, info.since, today)));
  const from = windowStart(today, Math.min(600, maxWin * 2 + 10));
  const stage = stages.find((s) => s.key === info.stage);
  const tier = stage?.scalingTier ? tiers.find((t) => t.key === stage.scalingTier) ?? null : null;

  const [trades, violationDates, ratings, limits, discipline, learning, passed] = await Promise.all([
    loadPromoTrades(user, from, today),
    loadViolationDates(user, from),
    pool.query(`SELECT week::text AS week, discipline, overall FROM trader_ratings WHERE trader = $1 AND week::text >= $2`, [user, from]).then((r) => r.rows).catch(() => [] as any[]),
    pool.query(`SELECT account_size, daily_loss_limit, weekly_loss_limit, max_drawdown FROM trader_risk_limits WHERE trader = $1`, [user]).then((r) => r.rows[0] ?? null).catch(() => null),
    loadDiscipline(user, from, today),
    loadLearning(user),
    pool.query(`SELECT status, summary->>'passedOn' AS passed_on FROM academy_challenges WHERE user_name = $1 AND archived_at IS NULL AND status = 'passed'`, [user])
      .then((r) => r.rows.map((x: any) => String(x.passed_on ?? "")).filter((d: string) => YMD_RE.test(d)))
      .catch(() => null),
  ]);
  const input: PromotionInput = {
    user, stage: info.stage, stageSince: info.since, today, trades, violationDates,
    ratings: ratings.map((r: any) => ({ week: String(r.week).slice(0, 10), discipline: num(r.discipline), overall: num(r.overall) })),
    // Trader's own limits when set; otherwise the stage's scaling tier supplies them inside the engine.
    limits: limits
      ? { accountSize: num(limits.account_size) ?? tier?.accountSize ?? null, dailyLossLimit: num(limits.daily_loss_limit) ?? tier?.dailyLossLimit ?? null, weeklyLossLimit: num(limits.weekly_loss_limit) ?? tier?.weeklyLossLimit ?? null, maxDrawdown: num(limits.max_drawdown) ?? tier?.maxDrawdown ?? null }
      : null,
    disciplineDays: discipline,
    learning,
    challengesPassed: passed,
  };
  const report = evaluatePromotion(input, criteria, stages, tiers, lang);
  return { ...report, stage: localizeStage(report.stage, lang), nextStage: localizeStage(report.nextStage, lang), stageSource: info.source, cohortId: info.cohortId };
}

/** One notification per (user, stage) when the report first becomes "ready". */
async function maybeNotifyReady(report: ReadinessReport): Promise<void> {
  if (!report.ready || !report.stage || !report.nextStage) return;
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO academy_readiness_notices (user_name, stage) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [report.user, report.stage.key],
    );
    if (!rowCount) return;
    // Text as data: rendered per reader language (lib/notificationText.ts, i18n `notifications`).
    // Names in RU (fallback text); readers see the seeded stage names in their language via the keys.
    const params = { user: report.user, total: report.total, from: (report.stage as { storedName?: string }).storedName ?? report.stage.name, to: (report.nextStage as { storedName?: string }).storedName ?? report.nextStage.name, fromKey: report.stage.key, toKey: report.nextStage.key };
    await notifyUser({ userName: report.user, type: "academy_promotion_ready", params, link: PATH_LINK(), entityType: "academy_stage", entityId: report.stage.key, source: "academy" });
    const staff = await mentorsOf(report.user);
    await notifyUsers(staff, { type: "academy_promotion_ready", params: { ...params, variant: "staff" }, link: PATH_LINK(report.user), entityType: "academy_stage", entityId: report.stage.key, source: "academy" }, report.user);
  } catch (err) {
    logger.warn({ err }, "academy-path: readiness notice failed");
  }
}

/** Mentors of a user: assigned curator/mentor, the cohort mentor (F2), else every active curator/admin. */
async function mentorsOf(user: string): Promise<string[]> {
  const names = new Set(await assignedStaffOf(user));
  if (await tableExists("academy_cohorts").catch(() => false)) {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT c.mentor FROM academy_enrollments e JOIN academy_cohorts c ON c.id = e.cohort_id
          WHERE e.user_name = $1 AND e.archived_at IS NULL AND c.archived_at IS NULL AND c.mentor IS NOT NULL`,
        [user],
      );
      for (const r of rows) if (r.mentor) names.add(String(r.mentor));
    } catch { /* F2 optional */ }
  }
  if (!names.size) {
    const { rows } = await pool.query(`SELECT name FROM users WHERE role IN ('curator','admin') AND active = true AND COALESCE(banned, false) = false`);
    for (const r of rows) names.add(String(r.name));
  }
  names.delete(user);
  return [...names];
}

// ─── config endpoints ───────────────────────────────────────────────────────

router.get("/academy/path/config", asyncHandler(async (req, res): Promise<void> => {
  const v = await viewer(req, res);
  if (!v) return;
  await ensureTables();
  const [stages, criteria, tiers] = await Promise.all([loadStages(), loadCriteria(), loadTiers()]);
  res.json({
    stages, criteria, tiers: tiers.map((t) => ({ key: t.key, name: t.name, accountSize: t.accountSize, dailyLossLimit: t.dailyLossLimit, maxDrawdown: t.maxDrawdown })),
    meta: { metrics: promoMetricsFor(langOf(req)), ops: OPS }, templates: templatesFor(langOf(req)), canEdit: v.staff, me: v.name,
    // Display names of the (possibly seeded) stages in the reader's language; `stages` keeps the stored values for editing.
    stageLabels: Object.fromEntries(stages.map((s) => [s.key, stageNameFor(s.key, s.name, langOf(req))])),
  });
}));

const StageBody = z.object({
  key: z.enum(STAGE_KEYS as [StageKey, ...StageKey[]]),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).nullable().optional(),
  scalingTier: z.string().trim().max(40).nullable().optional(),
}).strict();

router.put("/academy/path/stages", asyncHandler(async (req, res): Promise<void> => {
  const v = await staffOnly(req, res);
  if (!v) return;
  await ensureTables();
  const parsed = z.array(StageBody).min(1).max(4).safeParse(req.body);
  if (!parsed.success) { bad(res, parsed.error); return; }
  for (const s of parsed.data) {
    const order = STAGE_KEYS.indexOf(s.key) + 1;
    await pool.query(
      `INSERT INTO academy_stages (key, name, sort_order, description, scaling_tier, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, scaling_tier = EXCLUDED.scaling_tier, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [s.key, s.name, order, s.description ?? null, s.scalingTier ?? null, v.name],
    );
  }
  await logAudit({ actor: v.name, action: "academy.stages.update", targetType: "academy_stages", details: { keys: parsed.data.map((s) => s.key) } });
  res.json({ stages: await loadStages() });
}));

const CriterionBody = z.object({
  id: z.number().int().positive().optional(),
  fromStage: z.enum(STAGE_KEYS as [StageKey, ...StageKey[]]),
  metric: z.enum(PROMO_METRIC_KEYS),
  op: z.enum([">=", ">", "<=", "<", "="]),
  value: z.number().finite().min(-1e9).max(1e9),
  windowDays: z.number().int().min(1).max(260).nullable().default(20),
  label: z.string().trim().max(120).nullable().optional().transform((s) => (s ? s : null)),
  enabled: z.boolean().default(true),
}).strict();

router.put("/academy/path/criteria", asyncHandler(async (req, res): Promise<void> => {
  const v = await staffOnly(req, res);
  if (!v) return;
  await ensureTables();
  const parsed = z.array(CriterionBody).max(120).safeParse(req.body);
  if (!parsed.success) { bad(res, parsed.error); return; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const keep: number[] = [];
    let order = 0;
    for (const c of parsed.data) {
      if (c.id) {
        const { rows } = await client.query(
          `UPDATE academy_stage_criteria SET from_stage=$2, metric=$3, op=$4, value=$5, window_days=$6, label=$7, enabled=$8, sort_order=$9, updated_by=$10, updated_at=NOW()
            WHERE id = $1 AND archived_at IS NULL RETURNING id`,
          [c.id, c.fromStage, c.metric, c.op, c.value, c.windowDays, c.label ?? null, c.enabled, order, v.name],
        );
        if (rows.length) { keep.push(c.id); order++; continue; }
      }
      const { rows } = await client.query(
        `INSERT INTO academy_stage_criteria (from_stage, metric, op, value, window_days, label, enabled, sort_order, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [c.fromStage, c.metric, c.op, c.value, c.windowDays, c.label ?? null, c.enabled, order++, v.name],
      );
      keep.push(Number(rows[0].id));
    }
    // Soft delete: rows left out of the new set are archived, never removed.
    await client.query(`UPDATE academy_stage_criteria SET archived_at = NOW(), updated_by = $2 WHERE archived_at IS NULL AND NOT (id = ANY($1::int[]))`, [keep, v.name]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await logAudit({ actor: v.name, action: "academy.criteria.update", targetType: "academy_stage_criteria", details: { count: parsed.data.length } });
  res.json({ criteria: await loadCriteria() });
}));

// ─── readiness ──────────────────────────────────────────────────────────────

router.get("/academy/path/report", asyncHandler(async (req, res): Promise<void> => {
  const v = await viewer(req, res);
  if (!v) return;
  await ensureTables();
  const user = await targetUser(req, req.query.user);
  if (user === undefined) throw unauthorized();
  const today = clientDate(req.query.date);
  if (user === GUEST_SCOPE) { res.json({ report: null, guest: true }); return; }
  const lang = langOf(req);
  const report = await buildReport(user, today, undefined, lang);
  const [{ rows: pending }, { rows: hist }] = await Promise.all([
    pool.query(`SELECT * FROM academy_promotion_requests WHERE user_name = $1 AND status = 'pending' AND archived_at IS NULL LIMIT 1`, [user]),
    pool.query(`SELECT * FROM academy_stage_history WHERE user_name = $1 ORDER BY created_at DESC LIMIT 20`, [user]),
  ]);
  res.json({ report, pendingRequest: pending[0] ? rowToRequest(pending[0], lang) : null, history: hist.map(rowToHistory), canDecide: v.staff && user !== v.name });
}));

router.get("/academy/path/funnel", asyncHandler(async (req, res): Promise<void> => {
  const v = await staffOnly(req, res);
  if (!v) return;
  await ensureTables();
  const today = clientDate(req.query.date);
  const lang = langOf(req);
  const [stages, criteria, tiers, info, usersRes, pendingRes] = await Promise.all([
    loadStages(), loadCriteria(), loadTiers(), loadStageInfo(null),
    pool.query(`SELECT name, role FROM users WHERE active = true AND COALESCE(banned, false) = false`),
    pool.query(`SELECT user_name, id, to_stage, created_at FROM academy_promotion_requests WHERE status = 'pending' AND archived_at IS NULL`),
  ]);
  const roles = new Map<string, string>(usersRes.rows.map((u: any) => [String(u.name), String(u.role)]));
  const pending = new Map<string, any>(pendingRes.rows.map((r: any) => [String(r.user_name), r]));
  // People on the ladder: anyone with a stage, plus active traders without one ("не назначена").
  const names = new Set<string>([...info.keys()].filter((n) => roles.has(n)));
  for (const [n, role] of roles) if (role === "trader") names.add(n);
  const people = await Promise.all([...names].map(async (name) => {
    const i = info.get(name) ?? { stage: null, since: null, source: null, cohortId: null };
    const r = await buildReport(name, today, { stages, criteria, tiers, info: i }, lang);
    const p = pending.get(name);
    return {
      user: name, role: roles.get(name) ?? null, stage: i.stage, since: i.since, stageSource: i.source, cohortId: i.cohortId,
      passed: r.passed, total: r.total, ready: r.ready, headline: r.headline, nextStage: r.nextStage?.key ?? null,
      failing: r.criteria.filter((c) => c.status !== "pass").map((c) => c.label).slice(0, 4),
      summary: r.summary, pendingRequestId: p ? Number(p.id) : null,
    };
  }));
  people.sort((a, b) => Number(b.ready) - Number(a.ready) || (b.total ? b.passed / b.total : 0) - (a.total ? a.passed / a.total : 0) || a.user.localeCompare(b.user, "ru"));
  const columns = [...stages.map((s) => ({ key: s.key as string, name: stageNameFor(s.key, s.name, lang), people: people.filter((p) => p.stage === s.key) })),
    { key: "none", name: academyPathT.tFor(lang)("stages.none"), people: people.filter((p) => !p.stage) }];
  res.json({ today, stages: stages.map((s) => localizeStage(s, lang)), columns, totals: { people: people.length, ready: people.filter((p) => p.ready).length, pending: pending.size } });
}));

// ─── promotion requests ─────────────────────────────────────────────────────

function rowToRequest(r: any, lang: Lang = "ru") {
  return {
    id: Number(r.id), user: String(r.user_name), fromStage: r.from_stage ?? null, toStage: String(r.to_stage), status: String(r.status),
    passed: Number(r.passed), total: Number(r.total), ready: r.ready === true, comment: r.comment ?? null, requestedBy: String(r.requested_by),
    createdAt: new Date(r.created_at).toISOString(), decidedBy: r.decided_by ?? null, decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    decisionComment: systemComment(r.decision_comment ?? null, lang), report: r.report ?? null,
  };
}
function rowToHistory(r: any) {
  return {
    id: Number(r.id), user: String(r.user_name), fromStage: r.from_stage ?? null, toStage: String(r.to_stage), action: String(r.action),
    requestId: r.request_id == null ? null : Number(r.request_id), actor: String(r.actor), comment: r.comment ?? null, createdAt: new Date(r.created_at).toISOString(),
  };
}

router.get("/academy/path/requests", asyncHandler(async (req, res): Promise<void> => {
  const v = await viewer(req, res);
  if (!v) return;
  await ensureTables();
  const want = typeof req.query.user === "string" ? req.query.user.trim() : "";
  const scope = await scopeTrader(req, want || null);
  if (scope === undefined) throw unauthorized();
  const status = typeof req.query.status === "string" && ["pending", "approved", "rejected", "withdrawn"].includes(req.query.status) ? req.query.status : null;
  const { rows } = await pool.query(
    `SELECT * FROM academy_promotion_requests WHERE archived_at IS NULL AND ($1::text IS NULL OR user_name = $1) AND ($2::text IS NULL OR status = $2)
      ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 200`,
    [scope, status],
  );
  const lang = langOf(req);
  res.json({ requests: rows.map((x) => rowToRequest(x, lang)) });
}));

const RequestBody = z.object({ user: z.string().trim().min(1).max(120).optional(), comment: z.string().trim().max(2000).optional() }).strict();

router.post("/academy/path/requests", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  const v = await viewer(req, res);
  if (!v) return;
  await ensureTables();
  const parsed = RequestBody.safeParse(req.body ?? {});
  if (!parsed.success) { bad(res, parsed.error); return; }
  const user = v.staff && parsed.data.user ? parsed.data.user : v.name;
  if (!v.staff && parsed.data.user && parsed.data.user !== v.name) throw new AppError("PROMOTION_SELF_ONLY");
  const report = await buildReport(user, nyDate());
  if (!report.stage) throw badRequest("STAGE_NOT_ASSIGNED");
  if (!report.nextStage) throw badRequest("STAGE_TOP");
  try {
    const { rows } = await pool.query(
      `INSERT INTO academy_promotion_requests (user_name, from_stage, to_stage, passed, total, ready, report, comment, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [user, report.stage.key, report.nextStage.key, report.passed, report.total, report.ready, JSON.stringify(report), parsed.data.comment ?? null, v.name],
    );
    const r = rowToRequest(rows[0]);
    // Text as data (lib/notificationRenderers/academy.ts): rendered per reader; RU title/body are filled from it.
    const params = {
      user, fromKey: report.stage.key, toKey: report.nextStage.key, passed: report.passed, total: report.total,
      from: (report.stage as { storedName?: string }).storedName ?? report.stage.name, to: (report.nextStage as { storedName?: string }).storedName ?? report.nextStage.name,
    };
    await notifyUsers(await mentorsOf(user), { type: "academy_promotion_request", params: { ...params, variant: "staff" }, link: PATH_LINK(user), entityType: "academy_promotion_request", entityId: r.id, actor: v.name, source: "academy" }, v.name);
    if (user !== v.name) await notifyUser({ userName: user, type: "academy_promotion_request", params: { ...params, variant: "user" }, link: PATH_LINK(), entityType: "academy_promotion_request", entityId: r.id, actor: v.name, source: "academy" });
    await logAudit({ actor: v.name, action: "academy.promotion.request", targetType: "academy_promotion_request", targetId: String(r.id), details: { user, to: report.nextStage.key, passed: report.passed, total: report.total } });
    res.status(201).json({ request: r });
  } catch (e: any) {
    if (e?.code === "23505") throw conflict("PROMOTION_PENDING_EXISTS");
    throw e;
  }
}));

async function setStage(user: string, from: StageKey | null, to: StageKey, actor: string, action: string, comment: string | null, requestId: number | null, report: unknown): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO academy_trader_stage (user_name, stage, since, updated_by, updated_at) VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (user_name) DO UPDATE SET stage = EXCLUDED.stage, since = EXCLUDED.since, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [user, to, nyDate(), actor],
    );
    await client.query(
      `INSERT INTO academy_stage_history (user_name, from_stage, to_stage, action, request_id, actor, comment, report) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [user, from, to, action, requestId, actor, comment, report == null ? null : JSON.stringify(report)],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const DecisionBody = z.object({ comment: z.string().trim().max(2000).optional() }).strict();

router.post("/academy/path/requests/:id/approve", asyncHandler(async (req, res): Promise<void> => {
  const v = await staffOnly(req, res);
  if (!v) return;
  await ensureTables();
  const id = Number(req.params.id);
  const parsed = DecisionBody.safeParse(req.body ?? {});
  if (!Number.isInteger(id) || !parsed.success) throw badRequest();
  const { rows } = await pool.query(`SELECT * FROM academy_promotion_requests WHERE id = $1 AND archived_at IS NULL`, [id]);
  const r = rows[0];
  if (!r) throw notFound("PROMOTION_REQUEST_NOT_FOUND");
  if (r.status !== "pending") throw conflict("PROMOTION_REQUEST_DECIDED");
  if (r.user_name === v.name) throw new AppError("PROMOTION_SELF_APPROVE");
  const report = await buildReport(String(r.user_name), nyDate());
  const comment = parsed.data.comment?.trim() || null;
  if (!report.ready && !comment) throw badRequest("PROMOTION_COMMENT_REQUIRED", undefined, { passed: report.passed, total: report.total });
  if (report.stage?.key !== r.from_stage) throw conflict("PROMOTION_STAGE_CHANGED");
  const upd = await pool.query(
    `UPDATE academy_promotion_requests SET status = 'approved', decided_by = $2, decided_at = NOW(), decision_comment = $3 WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, v.name, comment],
  );
  if (!upd.rows[0]) throw conflict("PROMOTION_REQUEST_DECIDED");
  await setStage(String(r.user_name), r.from_stage, r.to_stage, v.name, "promote", comment, id, report);
  const stages = await loadStages();
  const toName = stages.find((s) => s.key === r.to_stage)?.name ?? r.to_stage;
  await notifyUser({ userName: r.user_name, type: "academy_promotion_decision", params: { variant: "approved", actor: v.name, toKey: r.to_stage, to: toName, comment }, link: PATH_LINK(), entityType: "academy_promotion_request", entityId: id, actor: v.name, source: "academy" });
  await logAudit({ actor: v.name, action: "academy.promotion.approve", targetType: "academy_promotion_request", targetId: String(id), details: { user: r.user_name, from: r.from_stage, to: r.to_stage, ready: report.ready, passed: report.passed, total: report.total } });
  res.json({ request: rowToRequest(upd.rows[0]) });
}));

router.post("/academy/path/requests/:id/reject", asyncHandler(async (req, res): Promise<void> => {
  const v = await staffOnly(req, res);
  if (!v) return;
  await ensureTables();
  const id = Number(req.params.id);
  const parsed = DecisionBody.safeParse(req.body ?? {});
  if (!Number.isInteger(id) || !parsed.success) throw badRequest();
  const comment = parsed.data.comment?.trim();
  if (!comment) throw badRequest("PROMOTION_REJECT_REASON");
  const upd = await pool.query(
    `UPDATE academy_promotion_requests SET status = 'rejected', decided_by = $2, decided_at = NOW(), decision_comment = $3 WHERE id = $1 AND status = 'pending' AND archived_at IS NULL RETURNING *`,
    [id, v.name, comment],
  );
  const r = upd.rows[0];
  if (!r) throw conflict("PROMOTION_REQUEST_DECIDED");
  await pool.query(
    `INSERT INTO academy_stage_history (user_name, from_stage, to_stage, action, request_id, actor, comment) VALUES ($1,$2,$3,'reject',$4,$5,$6)`,
    [r.user_name, r.from_stage, r.to_stage, id, v.name, comment],
  );
  await notifyUser({ userName: r.user_name, type: "academy_promotion_decision", params: { variant: "rejected", actor: v.name, toKey: r.to_stage, to: r.to_stage, comment }, link: PATH_LINK(), entityType: "academy_promotion_request", entityId: id, actor: v.name, source: "academy", severity: "warn" });
  await logAudit({ actor: v.name, action: "academy.promotion.reject", targetType: "academy_promotion_request", targetId: String(id), details: { user: r.user_name } });
  res.json({ request: rowToRequest(r) });
}));

router.post("/academy/path/requests/:id/withdraw", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  const v = await viewer(req, res);
  if (!v) return;
  await ensureTables();
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest("INVALID_ID");
  const upd = await pool.query(
    `UPDATE academy_promotion_requests SET status = 'withdrawn', decided_by = $2, decided_at = NOW() WHERE id = $1 AND status = 'pending' AND (user_name = $2 OR requested_by = $2 OR $3) RETURNING *`,
    [id, v.name, v.staff],
  );
  if (!upd.rows[0]) throw notFound("PROMOTION_REQUEST_NOT_FOUND");
  res.json({ request: rowToRequest(upd.rows[0]) });
}));

const AssignBody = z.object({
  user: z.string().trim().min(1).max(120),
  stage: z.enum(STAGE_KEYS as [StageKey, ...StageKey[]]),
  comment: z.string().trim().min(3).max(2000),
}).strict();

router.post("/academy/path/assign", asyncHandler(async (req, res): Promise<void> => {
  const v = await staffOnly(req, res);
  if (!v) return;
  await ensureTables();
  const parsed = AssignBody.safeParse(req.body);
  if (!parsed.success) { bad(res, parsed.error); return; }
  const { user, stage, comment } = parsed.data;
  const exists = await pool.query(`SELECT 1 FROM users WHERE name = $1 AND active = true LIMIT 1`, [user]);
  if (!exists.rows.length) throw notFound("USER_NOT_FOUND");
  const cur = (await loadStageInfo([user])).get(user)?.stage ?? null;
  if (cur === stage) throw conflict("STAGE_ALREADY");
  const action = cur == null ? "assign" : STAGE_KEYS.indexOf(stage) > STAGE_KEYS.indexOf(cur) ? "promote" : "demote";
  await setStage(user, cur, stage, v.name, action, comment, null, null);
  // A pending request for the old stage no longer makes sense.
  await pool.query(`UPDATE academy_promotion_requests SET status = 'withdrawn', decided_by = $2, decided_at = NOW(), decision_comment = $3 WHERE user_name = $1 AND status = 'pending'`, [user, v.name, academyPathT.tFor("ru")("route.withdrawnDirect")]);
  const name = (await loadStages()).find((s) => s.key === stage)?.name ?? stage;
  await notifyUser({ userName: user, type: "academy_promotion_decision", params: { variant: "assigned", actor: v.name, toKey: stage, to: name, comment }, link: PATH_LINK(), entityType: "academy_stage", entityId: stage, actor: v.name, source: "academy", severity: action === "demote" ? "warn" : "info" });
  await logAudit({ actor: v.name, action: `academy.stage.${action}`, targetType: "academy_trader_stage", targetId: user, details: { from: cur, to: stage } });
  res.json({ ok: true, user, from: cur, to: stage, action });
}));

router.get("/academy/path/history", asyncHandler(async (req, res): Promise<void> => {
  const v = await viewer(req, res);
  if (!v) return;
  await ensureTables();
  const want = typeof req.query.user === "string" ? req.query.user.trim() : "";
  const scope = await scopeTrader(req, want || null);
  if (scope === undefined) throw unauthorized();
  const { rows } = await pool.query(`SELECT * FROM academy_stage_history WHERE ($1::text IS NULL OR user_name = $1) ORDER BY created_at DESC LIMIT 300`, [scope]);
  res.json({ history: rows.map(rowToHistory) });
}));

// ─── challenges ─────────────────────────────────────────────────────────────

let hasExec: boolean | null = null;

/** "2026-10-15T15:59:16" (ET wall time, no zone) → 959; ISO with zone → NY minutes of that instant. */
function wallMinutes(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? nyMinutes(new Date(t)) : null;
  }
  const m = /[T ](\d{2}):(\d{2})/.exec(iso);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function instMinutes(v: unknown): number | null {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? nyMinutes(new Date(t)) : null;
}

async function loadChallengeTrades(user: string, from: string, to: string): Promise<ChallengeTrade[]> {
  if (hasExec == null) hasExec = await tableExists("trade_executions").catch(() => false);
  // One trader, one window → per-trade index probe instead of aggregating the whole executions table.
  const exec = hasExec ? execSpanJoin("lateral") : "";
  const { rows } = await pool.query(
    `SELECT t.id, t.ticker, ${closeDateSql("t")} AS d, ${netPnlSql("t")}::float8 AS net, t.qty::float8 AS qty, t.entry::float8 AS entry,
            t.context_snapshot ->> 'openedAt' AS opened_at, t.context_snapshot ->> 'closedAt' AS closed_at
            ${hasExec ? ", e.first_entry, e.last_exit" : ""}
       FROM trades t ${exec}
      WHERE t.deleted_at IS NULL AND t.trader = $1 AND ${closedSql("t")}
        AND ${closeDateSql("t")} >= $2 AND ${closeDateSql("t")} <= $3`,
    [user, from, to],
  );
  return rows.map((r: any) => ({
    id: Number(r.id),
    ticker: String(r.ticker ?? "").toUpperCase(),
    date: String(r.d ?? "").slice(0, 10),
    net: num(r.net),
    qty: num(r.qty),
    entry: num(r.entry),
    entryMin: instMinutes(r.first_entry) ?? wallMinutes(r.opened_at),
    exitMin: instMinutes(r.last_exit) ?? wallMinutes(r.closed_at),
  }));
}

type ChallengeRow = {
  id: number; user: string; templateKey: string | null; name: string; rules: ChallengeRules; startsOn: string; endsOn: string;
  status: ChallengeStatus; comment: string | null; createdBy: string; createdAt: string; archivedAt: string | null;
};
function rowToChallenge(r: any): ChallengeRow | null {
  const rules = normalizeRules(r.rules);
  if (!rules) return null;
  return {
    id: Number(r.id), user: String(r.user_name), templateKey: r.template_key ?? null, name: String(r.name), rules,
    startsOn: String(r.starts_on), endsOn: String(r.ends_on), status: r.status as ChallengeStatus, comment: r.comment ?? null,
    createdBy: String(r.created_by), createdAt: new Date(r.created_at).toISOString(), archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
  };
}

/** Pure evaluation of a challenge against its trades — read paths only, writes nothing. */
async function evaluateRow(c: ChallengeRow, today: string, lang: Lang = "ru"): Promise<ChallengeResult> {
  const trades = await loadChallengeTrades(c.user, c.startsOn, c.endsOn < today ? c.endsOn : today);
  return evaluateChallenge({ startsOn: c.startsOn, endsOn: c.endsOn, rules: c.rules }, trades, today, lang);
}

/** A challenge row for display: built-in template name and system comment in `lang` (custom texts unchanged). */
function localizeChallenge(c: ChallengeRow, lang: Lang): ChallengeRow {
  return { ...c, name: challengeNameFor(c.templateKey, c.name, lang), comment: systemComment(c.comment, lang) };
}

/** Write path: caches a status change and notifies once per terminal transition (trader + mentors). */
async function persistResult(c: ChallengeRow, result: ChallengeResult, notifiedStatus: string | null): Promise<boolean> {
  if (c.archivedAt) return false;
  const summary = {
    status: result.status, reason: result.reason, passedOn: result.passedOn, failure: result.failure, net: result.stats.net,
    tradingDays: result.stats.tradingDays, progress: result.progress.map((p) => ({ key: p.key, pct: p.pct, state: p.state })),
  };
  const changed = result.status !== c.status;
  if (changed) {
    await pool.query(`UPDATE academy_challenges SET status = $2, summary = $3, updated_at = NOW() WHERE id = $1`, [c.id, result.status, JSON.stringify(summary)]);
  }
  if ((result.status === "passed" || result.status === "failed" || result.status === "expired") && notifiedStatus !== result.status) {
    const upd = await pool.query(`UPDATE academy_challenges SET notified_status = $2 WHERE id = $1 AND notified_status IS DISTINCT FROM $2 RETURNING id`, [c.id, result.status]);
    if (upd.rowCount) {
      const passed = result.status === "passed";
      const type = passed ? "academy_challenge_passed" : "academy_challenge_failed";
      // Text as data (lib/notificationText.ts). `reason` is the engine's Russian text until the challenge engine gets codes.
      // `reasonData` renders the reason in each reader's language (lib/notificationRenderers/academy.ts); `reason` is the RU fallback.
      const params = {
        name: c.name, templateKey: c.templateKey, user: c.user, outcome: result.status, net: usd(result.stats.net), days: result.stats.tradingDays,
        reason: passed ? null : result.reason, reasonData: passed ? null : JSON.stringify(result.reasonData),
      };
      await notifyUser({ userName: c.user, type, params, link: CH_LINK(c.id), entityType: "academy_challenge", entityId: c.id, source: "academy", severity: passed ? "info" : "warn" });
      await notifyUsers(await mentorsOf(c.user), { type, params: { ...params, variant: "staff" }, link: CH_LINK(c.id), entityType: "academy_challenge", entityId: c.id, source: "academy", severity: passed ? "info" : "warn" }, c.user);
    }
  }
  return changed;
}

/**
 * Re-evaluates challenges on the server's NY date, persists status and sends the terminal notices.
 * `users` given (a PropReports sync changed their trades) → every non-archived challenge of those users;
 * otherwise (periodic tick) → the ones whose status can still move by date alone (scheduled / active) plus terminal
 * ones whose notice has not gone out yet. GET endpoints never write — they evaluate on the fly.
 */
export async function refreshChallenges(users?: string[] | null): Promise<{ checked: number; changed: number }> {
  await ensureTables();
  const today = nyDate();
  const { rows } = await pool.query(
    users
      ? `SELECT * FROM academy_challenges WHERE archived_at IS NULL AND user_name = ANY($1::text[]) ORDER BY id`
      : `SELECT * FROM academy_challenges WHERE archived_at IS NULL
           AND (status IN ('scheduled','active') OR notified_status IS DISTINCT FROM status) ORDER BY id`,
    users ? [users] : [],
  );
  let changed = 0;
  for (const r of rows) {
    const c = rowToChallenge(r);
    if (!c) continue;
    try {
      if (await persistResult(c, await evaluateRow(c, today), r.notified_status ?? null)) changed++;
    } catch (err) {
      logger.warn({ err, id: c.id }, "academy-path: challenge refresh failed");
    }
  }
  return { checked: rows.length, changed };
}

/**
 * «Готов к переводу» notices (one per user and stage, academy_readiness_notices) — a write path run by the job registry
 * ("academy.readiness": every 15 min and after each PropReports sync). GET endpoints only evaluate, never notify.
 */
export async function refreshReadinessNotices(users?: string[] | null): Promise<{ checked: number; ready: number }> {
  await ensureTables();
  const today = nyDate();
  const [stages, criteria, tiers, info, usersRes] = await Promise.all([
    loadStages(), loadCriteria(), loadTiers(), loadStageInfo(null),
    pool.query(`SELECT name, role FROM users WHERE active = true AND COALESCE(banned, false) = false`),
  ]);
  const roles = new Map<string, string>(usersRes.rows.map((u: any) => [String(u.name), String(u.role)]));
  const names = new Set<string>([...info.keys()].filter((n) => roles.has(n)));
  for (const [n, role] of roles) if (role === "trader") names.add(n);
  const only = users?.length ? new Set(users) : null;
  let checked = 0, ready = 0;
  for (const name of names) {
    if (only && !only.has(name)) continue;
    const i = info.get(name) ?? { stage: null, since: null, source: null, cohortId: null };
    try {
      const r = await buildReport(name, today, { stages, criteria, tiers, info: i });
      checked++;
      if (r.ready) ready++;
      await maybeNotifyReady(r);
    } catch (err) {
      logger.warn({ err, user: name }, "academy-path: readiness check failed");
    }
  }
  return { checked, ready };
}

router.get("/academy/challenges/templates", asyncHandler(async (req, res): Promise<void> => {
  const v = await viewer(req, res);
  if (!v) return;
  res.json({ templates: templatesFor(langOf(req)), statuses: statusLabelsFor(langOf(req)) });
}));

router.get("/academy/challenges", asyncHandler(async (req, res): Promise<void> => {
  const v = await viewer(req, res);
  if (!v) return;
  await ensureTables();
  const want = typeof req.query.user === "string" ? req.query.user.trim() : "";
  const scope = await scopeTrader(req, want || null);
  if (scope === undefined) throw unauthorized();
  const archived = req.query.archived === "1";
  const today = clientDate(req.query.date);
  const lang = langOf(req);
  const { rows } = await pool.query(
    `SELECT * FROM academy_challenges WHERE ($1::text IS NULL OR user_name = $1) AND (${archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"})
      ORDER BY starts_on DESC, id DESC LIMIT 300`,
    [scope],
  );
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const items = [];
  for (const r of rows) {
    const c = rowToChallenge(r);
    if (!c) continue;
    const result = await evaluateRow(c, today, lang);
    if (status && result.status !== status) continue;
    const { timeline, ...light } = result;
    items.push({ ...localizeChallenge(c, lang), result: { ...light, lastDays: timeline.slice(-10).map((d) => ({ date: d.date, net: d.net, cum: d.cum, events: d.events.length })) } });
  }
  res.json({ challenges: items, today, canCreate: v.staff });
}));

router.get("/academy/challenges/:id", asyncHandler(async (req, res): Promise<void> => {
  const v = await viewer(req, res);
  if (!v) return;
  await ensureTables();
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest("INVALID_ID");
  const { rows } = await pool.query(`SELECT * FROM academy_challenges WHERE id = $1`, [id]);
  const r = rows[0];
  const c = r ? rowToChallenge(r) : null;
  if (!c) throw notFound("CHALLENGE_NOT_FOUND");
  const scope = await scopeTrader(req, c.user);
  if (scope !== c.user) throw notFound("CHALLENGE_NOT_FOUND");
  const today = clientDate(req.query.date);
  const lang = langOf(req);
  const result = await evaluateRow(c, today, lang);
  const template = c.templateKey ? templatesFor(lang).find((x) => x.key === c.templateKey) ?? null : null;
  res.json({ challenge: localizeChallenge(c, lang), result, template, canManage: v.staff });
}));

const RulesBody = z.object({
  accountSize: z.number().positive().max(1e9),
  profitTarget: z.number().positive().max(1e9).nullable(),
  dailyLossLimit: z.number().positive().max(1e9).nullable(),
  maxDrawdown: z.number().positive().max(1e9).nullable(),
  drawdownMode: z.enum(["static", "trailing", "trailing_eod"]),
  trailingStopsAtStart: z.boolean(),
  consistencyPct: z.number().positive().max(100).nullable(),
  minTradingDays: z.number().int().min(0).max(260).nullable(),
  maxPositionQty: z.number().positive().max(1e9).nullable(),
  maxPositionUsd: z.number().positive().max(1e10).nullable(),
  tradingWindow: z.object({ start: z.number().int().min(0).max(1439), end: z.number().int().min(1).max(1440) }).refine((w) => w.start < w.end, "start < end").nullable(),
  tradingWindowStrict: z.boolean(),
}).partial();

const ChallengeBody = z.object({
  user: z.string().trim().min(1).max(120),
  templateKey: z.string().trim().max(60),
  startsOn: z.string().regex(YMD_RE),
  endsOn: z.string().regex(YMD_RE).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  rules: RulesBody.optional(),
  comment: z.string().trim().max(2000).optional(),
}).strict();

async function createChallenge(user: string, templateKey: string, startsOn: string, endsOn: string | undefined, name: string | undefined, overrides: Partial<ChallengeRules> | undefined, comment: string | null, actor: string): Promise<{ id: number } | { error: ErrorCode }> {
  const tpl = TEMPLATE_BY_KEY[templateKey];
  if (!tpl) return { error: "CHALLENGE_TEMPLATE_NOT_FOUND" };
  const rules = normalizeRules({ ...tpl.rules, ...(overrides ?? {}) });
  if (!rules) return { error: "CHALLENGE_RULES_INVALID" };
  const end = endsOn ?? endDateFor(startsOn, tpl.durationTradingDays);
  if (end < startsOn) return { error: "DATE_RANGE_INVALID" };
  const { rows } = await pool.query(
    `INSERT INTO academy_challenges (user_name, template_key, name, rules, starts_on, ends_on, status, comment, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [user, tpl.key, name ?? tpl.name, JSON.stringify(rules), startsOn, end, startsOn > nyDate() ? "scheduled" : "active", comment, actor],
  );
  return { id: Number(rows[0].id) };
}

router.post("/academy/challenges", asyncHandler(async (req, res): Promise<void> => {
  const v = await staffOnly(req, res);
  if (!v) return;
  await ensureTables();
  const parsed = ChallengeBody.safeParse(req.body);
  if (!parsed.success) { bad(res, parsed.error); return; }
  const b = parsed.data;
  const exists = await pool.query(`SELECT 1 FROM users WHERE name = $1 AND active = true LIMIT 1`, [b.user]);
  if (!exists.rows.length) throw notFound("USER_NOT_FOUND");
  const out = await createChallenge(b.user, b.templateKey, b.startsOn, b.endsOn, b.name, b.rules as Partial<ChallengeRules> | undefined, b.comment ?? null, v.name);
  if ("error" in out) throw badRequest(out.error);
  await notifyUser({
    userName: b.user, type: "academy_challenge_assigned",
    params: { actor: v.name, name: b.name ?? TEMPLATE_BY_KEY[b.templateKey].name, templateKey: b.templateKey, date: b.startsOn },
    link: CH_LINK(out.id), entityType: "academy_challenge", entityId: out.id, actor: v.name, source: "academy",
  });
  await logAudit({ actor: v.name, action: "academy.challenge.create", targetType: "academy_challenge", targetId: String(out.id), details: { user: b.user, template: b.templateKey, startsOn: b.startsOn } });
  res.status(201).json({ id: out.id });
}));

router.post("/academy/challenges/:id/archive", asyncHandler(async (req, res): Promise<void> => {
  const v = await staffOnly(req, res);
  if (!v) return;
  await ensureTables();
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest("INVALID_ID");
  const upd = await pool.query(`UPDATE academy_challenges SET archived_at = NOW(), archived_by = $2 WHERE id = $1 AND archived_at IS NULL RETURNING id`, [id, v.name]);
  if (!upd.rowCount) throw notFound("CHALLENGE_NOT_FOUND");
  await logAudit({ actor: v.name, action: "academy.challenge.archive", targetType: "academy_challenge", targetId: String(id) });
  res.json({ ok: true });
}));

/** Demo: «Перевод Стажёр → Джун» from the 1st weekday of the current month for every member with broker trades. Idempotent. */
router.post("/academy/path/seed-demo", asyncHandler(async (req, res): Promise<void> => {
  const v = await staffOnly(req, res);
  if (!v) return;
  await ensureTables();
  const today = nyDate();
  const start = `${today.slice(0, 8)}01`;
  const { rows } = await pool.query(
    `SELECT DISTINCT t.trader FROM trades t JOIN users u ON u.name = t.trader AND u.active = true
      WHERE t.deleted_at IS NULL AND (t.source = 'propreports' OR t.context_snapshot ->> 'source' = 'propreports')`,
  );
  const created: { user: string; id: number }[] = [];
  for (const r of rows) {
    const user = String(r.trader);
    const ex = await pool.query(`SELECT id FROM academy_challenges WHERE user_name = $1 AND template_key = 'trainee_to_junior' AND starts_on = $2 AND archived_at IS NULL LIMIT 1`, [user, start]);
    if (ex.rows.length) continue;
    const out = await createChallenge(user, "trainee_to_junior", start, undefined, undefined, undefined, academyPathT.tFor("ru")("route.demo"), v.name);
    if ("id" in out) created.push({ user, id: out.id });
  }
  await logAudit({ actor: v.name, action: "academy.path.seed_demo", targetType: "academy_challenges", details: { created } });
  res.json({ created, skipped: rows.length - created.length });
}));

export default router;
