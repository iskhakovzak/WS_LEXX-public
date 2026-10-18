/**
 * «План масштабирования» — rules-based tier ladder & buying power.
 *
 *   GET  /scaling/config                      tiers + rules + metric meta (any authenticated user)
 *   PUT  /scaling/tiers                       curator/admin — replace the ladder (bulk, transactional)
 *   PUT  /scaling/rules                       curator/admin — replace the rule set (bulk, transactional)
 *   GET  /scaling/evaluate?trader=&date=      curator: whole desk; trader: self — tier, rule pass/fail, recommendation
 *   GET  /scaling/proposals?status=&trader=   pending/decided proposals (trader: own)
 *   POST /scaling/proposals                   curator — manual proposal {trader, action?, toTier?, comment?}
 *   POST /scaling/proposals/auto              curator — turn every promote/demote recommendation into a proposal
 *   POST /scaling/proposals/:id/approve       curator — applies the tier's limits to trader_risk_limits + history + audit
 *   POST /scaling/proposals/:id/reject        curator
 *   POST /scaling/assign                      curator — direct tier assignment {trader, tierKey, comment?}
 *   GET  /scaling/history?trader=&limit=      timeline (trader: own)
 *   exported: loadTierTemplates(), applyTierTemplate() — tiers as limit templates for /risk/templates/*
 *
 * Money metrics use broker rows (source='propreports') when the trader has any, otherwise the journal.
 * All per-trade math comes from lib/tradeMath.ts (shared R / net / close-date definitions).
 * Tables are created idempotently (additive) and seeded with defaults on first run.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { logger } from "../lib/logger";
import { logAudit } from "../lib/audit";
import { nyDate } from "../lib/tradingDate";
import { closeDateSql, closedSql, netPnlSql, resultSql, signedRSql } from "../lib/tradeMath";
import { can, requireCap, type Capability } from "../lib/permissions";
import {
  DEFAULT_RULES, DEFAULT_TIERS, OPS, evaluateTrader, metricsMeta, renderStoredReasons, sortTiers, unitsMeta, windowStart,
  type ReasonItem,
  type Evaluation, type MetricKey, type Op, type Rule, type RuleKind, type Tier, type TraderInput, type Unit,
} from "../lib/scalingEngine";
import { notifyUser, notifyUsers } from "../lib/notifyUtils";
import { notifLinks } from "../lib/notificationCore";
import { inBackground, staffOrFallback } from "../lib/notifyEvents";
import { uniqueRecipients } from "../lib/notifyEventsCore";
import { AppError, errorMessage, badRequest, conflict, notFound, sendError, unauthorized } from "../lib/http";
import { langOf, type Lang } from "../i18n";
import { scalingT } from "../i18n/ns";

const router: IRouter = Router();

// ─── tables ─────────────────────────────────────────────────────────────────

let ensured: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS scaling_tiers (
          key TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          account_size NUMERIC(14,2),
          daily_loss_limit NUMERIC(12,2),
          weekly_loss_limit NUMERIC(12,2),
          max_drawdown NUMERIC(12,2),
          max_risk_per_trade NUMERIC(12,2),
          max_position_usd NUMERIC(14,2),
          max_overnight_exposure NUMERIC(14,2),
          max_open_positions INTEGER,
          allow_overnight BOOLEAN NOT NULL DEFAULT FALSE,
          allow_swing BOOLEAN NOT NULL DEFAULT FALSE,
          description TEXT,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          updated_by TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS scaling_rules (
          id SERIAL PRIMARY KEY,
          kind TEXT NOT NULL,
          metric TEXT NOT NULL,
          op TEXT NOT NULL,
          value NUMERIC(14,4) NOT NULL,
          unit TEXT NOT NULL DEFAULT 'abs',
          window_days INTEGER NOT NULL DEFAULT 20,
          tier_key TEXT,
          label TEXT,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          updated_by TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS scaling_proposals (
          id SERIAL PRIMARY KEY,
          trader TEXT NOT NULL,
          action TEXT NOT NULL,
          from_tier TEXT,
          to_tier TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          source TEXT NOT NULL DEFAULT 'auto',
          reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
          snapshot JSONB,
          comment TEXT,
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          decided_by TEXT,
          decided_at TIMESTAMPTZ,
          decision_comment TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS scaling_proposals_pending_uniq ON scaling_proposals(trader) WHERE status = 'pending';
        CREATE INDEX IF NOT EXISTS scaling_proposals_trader_idx ON scaling_proposals(trader, created_at DESC);
        CREATE TABLE IF NOT EXISTS scaling_history (
          id SERIAL PRIMARY KEY,
          trader TEXT NOT NULL,
          action TEXT NOT NULL,
          from_tier TEXT,
          to_tier TEXT NOT NULL,
          proposal_id INTEGER,
          actor TEXT NOT NULL,
          comment TEXT,
          limits JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS scaling_history_trader_idx ON scaling_history(trader, created_at DESC);
      `);
      const { rows: tc } = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM scaling_tiers`);
      if (Number(tc[0]?.n ?? 0) === 0) {
        for (const t of DEFAULT_TIERS) await upsertTier(pool, t, "system");
        logger.info("scaling: seeded default tiers");
      }
      const { rows: rc } = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM scaling_rules`);
      if (Number(rc[0]?.n ?? 0) === 0) {
        let i = 0;
        for (const r of DEFAULT_RULES) await insertRule(pool, r, i++, "system");
        logger.info("scaling: seeded default rules");
      }
    })().catch((err) => {
      ensured = null;
      throw err;
    });
  }
  return ensured;
}
ensureTables().catch((err) => logger.warn({ err }, "scaling: ensure tables failed at init"));

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

async function upsertTier(q: Queryable, t: Tier, actor: string): Promise<void> {
  await q.query(
    `INSERT INTO scaling_tiers (key, name, sort_order, account_size, daily_loss_limit, weekly_loss_limit, max_drawdown, max_risk_per_trade,
        max_position_usd, max_overnight_exposure, max_open_positions, allow_overnight, allow_swing, description, active, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,TRUE,$15,NOW())
     ON CONFLICT (key) DO UPDATE SET
        name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, account_size = EXCLUDED.account_size,
        daily_loss_limit = EXCLUDED.daily_loss_limit, weekly_loss_limit = EXCLUDED.weekly_loss_limit, max_drawdown = EXCLUDED.max_drawdown,
        max_risk_per_trade = EXCLUDED.max_risk_per_trade, max_position_usd = EXCLUDED.max_position_usd,
        max_overnight_exposure = EXCLUDED.max_overnight_exposure, max_open_positions = EXCLUDED.max_open_positions,
        allow_overnight = EXCLUDED.allow_overnight, allow_swing = EXCLUDED.allow_swing, description = EXCLUDED.description,
        active = TRUE, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [t.key, t.name, t.order, t.accountSize, t.dailyLossLimit, t.weeklyLossLimit, t.maxDrawdown, t.maxRiskPerTrade, t.maxPositionUsd,
      t.maxOvernightExposure, t.maxOpenPositions, t.allowOvernight, t.allowSwing, t.description ?? null, actor],
  );
}

async function insertRule(q: Queryable, r: Omit<Rule, "id">, order: number, actor: string): Promise<number> {
  const { rows } = await q.query(
    `INSERT INTO scaling_rules (kind, metric, op, value, unit, window_days, tier_key, label, enabled, sort_order, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()) RETURNING id`,
    [r.kind, r.metric, r.op, r.value, r.unit, r.windowDays, r.tierKey, r.label, r.enabled, order, actor],
  );
  return Number(rows[0].id);
}

// ─── helpers ────────────────────────────────────────────────────────────────

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

// Access goes through the permissions matrix (lib/permissions.ts): `staff` = scaling.read.team (desk reads),
// tiers/rules = scaling.configure, proposals/assign = scaling.approve. Role comes from the DB, not the token.
type Viewer = { name: string; staff: boolean };
async function viewer(req: Request, res: Response): Promise<Viewer | null> {
  const name = req.authUser?.name;
  if (!name) { sendError(res, unauthorized()); return null; }
  return { name, staff: await can(req, "scaling.read.team") };
}
async function staffOnly(req: Request, res: Response, cap: Capability): Promise<Viewer | null> {
  if (!(await requireCap(req, res, cap, null, "STAFF_ONLY"))) return null;
  return { name: req.authUser!.name, staff: true };
}

function clientDate(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  return YMD_RE.test(s) ? s : nyDate();
}

function rowToTier(r: any): Tier {
  return {
    key: String(r.key),
    name: String(r.name),
    order: Number(r.sort_order) || 0,
    accountSize: num(r.account_size),
    dailyLossLimit: num(r.daily_loss_limit),
    weeklyLossLimit: num(r.weekly_loss_limit),
    maxDrawdown: num(r.max_drawdown),
    maxRiskPerTrade: num(r.max_risk_per_trade),
    maxPositionUsd: num(r.max_position_usd),
    maxOvernightExposure: num(r.max_overnight_exposure),
    maxOpenPositions: r.max_open_positions == null ? null : Number(r.max_open_positions),
    allowOvernight: r.allow_overnight === true,
    allowSwing: r.allow_swing === true,
    description: r.description ?? null,
  };
}

function rowToRule(r: any): Rule {
  return {
    id: Number(r.id),
    kind: r.kind as RuleKind,
    metric: r.metric as MetricKey,
    op: r.op as Op,
    value: Number(r.value),
    unit: (r.unit ?? "abs") as Unit,
    windowDays: Number(r.window_days) || 20,
    tierKey: r.tier_key ?? null,
    label: r.label ?? null,
    enabled: r.enabled !== false,
  };
}

async function loadTiers(): Promise<Tier[]> {
  const { rows } = await pool.query(`SELECT * FROM scaling_tiers WHERE active = TRUE ORDER BY sort_order ASC, key ASC`);
  return sortTiers(rows.map(rowToTier));
}
async function loadRules(): Promise<Rule[]> {
  const { rows } = await pool.query(`SELECT * FROM scaling_rules ORDER BY sort_order ASC, id ASC`);
  return rows.map(rowToRule);
}

type LimitsRow = {
  trader: string; tier: string | null; accountSize: number | null; dailyLossLimit: number | null; weeklyLossLimit: number | null;
  maxDrawdown: number | null; maxRiskPerTrade: number | null; maxPositionUsd: number | null; maxOvernightExposure: number | null;
  maxOpenPositions: number | null; allowOvernight: boolean; allowSwing: boolean; updatedBy: string | null; updatedAt: string | null;
};
function rowToLimits(r: any): LimitsRow {
  return {
    trader: String(r.trader),
    tier: r.tier ?? null,
    accountSize: num(r.account_size),
    dailyLossLimit: num(r.daily_loss_limit),
    weeklyLossLimit: num(r.weekly_loss_limit),
    maxDrawdown: num(r.max_drawdown),
    maxRiskPerTrade: num(r.max_risk_per_trade),
    maxPositionUsd: num(r.max_position_usd),
    maxOvernightExposure: num(r.max_overnight_exposure),
    maxOpenPositions: r.max_open_positions == null ? null : Number(r.max_open_positions),
    allowOvernight: r.allow_overnight !== false,
    allowSwing: r.allow_swing !== false,
    updatedBy: r.updated_by ?? null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}
async function loadLimits(trader: string | null): Promise<Map<string, LimitsRow>> {
  const { rows } = await pool
    .query(`SELECT * FROM trader_risk_limits WHERE ($1::text IS NULL OR trader = $1)`, [trader])
    .catch(() => ({ rows: [] as any[] }));
  return new Map(rows.map((r: any) => [String(r.trader), rowToLimits(r)]));
}

type Proposal = {
  id: number; trader: string; action: string; fromTier: string | null; toTier: string; status: string; source: string;
  reasons: string[]; comment: string | null; createdBy: string; createdAt: string; decidedBy: string | null; decidedAt: string | null;
  decisionComment: string | null; snapshot?: unknown;
};
const PROPOSAL_COLS = `id, trader, action, from_tier, to_tier, status, source, reasons, comment, created_by, created_at, decided_by, decided_at, decision_comment`;
/** `lang` renders stored reason items (legacy rows keep their stored RU strings). */
function rowToProposal(r: any, withSnapshot = false, lang: Lang = "ru"): Proposal {
  const p: Proposal = {
    id: Number(r.id), trader: String(r.trader), action: String(r.action), fromTier: r.from_tier ?? null, toTier: String(r.to_tier),
    status: String(r.status), source: String(r.source ?? "auto"), reasons: renderStoredReasons(r.reasons, lang),
    comment: r.comment ?? null, createdBy: String(r.created_by), createdAt: new Date(r.created_at).toISOString(),
    decidedBy: r.decided_by ?? null, decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null, decisionComment: r.decision_comment ?? null,
  };
  if (withSnapshot) p.snapshot = r.snapshot ?? null;
  return p;
}

type HistoryRow = { id: number; trader: string; action: string; fromTier: string | null; toTier: string; proposalId: number | null; actor: string; comment: string | null; limits: unknown; createdAt: string };
function rowToHistory(r: any): HistoryRow {
  return {
    id: Number(r.id), trader: String(r.trader), action: String(r.action), fromTier: r.from_tier ?? null, toTier: String(r.to_tier),
    proposalId: r.proposal_id == null ? null : Number(r.proposal_id), actor: String(r.actor), comment: r.comment ?? null, limits: r.limits ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

// ─── data for the engine ────────────────────────────────────────────────────

/** Loads everything the engine needs for the roster (null trader ⇒ whole desk). */
async function loadInputs(trader: string | null, today: string, rules: Rule[]): Promise<{ inputs: Map<string, TraderInput>; limits: Map<string, LimitsRow> }> {
  const maxWindow = Math.max(20, ...rules.map((r) => r.windowDays || 20));
  // one extra week so the week-based metrics can see the full first week of the window
  const from = windowStart(today, maxWindow + 5);
  const [tradesRes, ratingsRes, violRes, errRes, usersRes, limits] = await Promise.all([
    pool.query(
      `SELECT t.trader, ${closeDateSql("t")} AS d, ${netPnlSql("t")}::float AS net, ${signedRSql("t")}::float AS r, ${resultSql("t")} AS result,
              CASE WHEN t.source = 'propreports' OR t.context_snapshot ->> 'source' = 'propreports' THEN 'propreports' ELSE 'manual' END AS source
         FROM trades t
        WHERE t.deleted_at IS NULL AND t.trader IS NOT NULL AND t.trader <> ''
          AND ($1::text IS NULL OR t.trader = $1)
          AND ${closedSql("t")}
          AND ${closeDateSql("t")} >= $2 AND ${closeDateSql("t")} <= $3`,
      [trader, from, today],
    ),
    pool.query(
      `SELECT trader, week::text AS week, discipline, overall FROM trader_ratings
        WHERE ($1::text IS NULL OR trader = $1) AND week::text >= $2`,
      [trader, from],
    ).catch(() => ({ rows: [] as any[] })),
    pool.query(
      `SELECT trader, LEFT(occurred_at::text, 10) AS d FROM rule_violations
        WHERE ($1::text IS NULL OR trader = $1) AND archived_at IS NULL AND occurred_at >= $2::date`,
      [trader, from],
    ).catch(() => ({ rows: [] as any[] })),
    pool.query(
      `SELECT trader, LEFT(created_at::text, 10) AS d FROM trading_errors
        WHERE ($1::text IS NULL OR trader = $1) AND created_at >= $2::date`,
      [trader, from],
    ).catch(() => ({ rows: [] as any[] })),
    pool.query(`SELECT name, role FROM users WHERE active = true AND COALESCE(banned, false) = false AND ($1::text IS NULL OR name = $1)`, [trader]),
    loadLimits(trader),
  ]);

  const inputs = new Map<string, TraderInput>();
  const get = (name: string): TraderInput => {
    let x = inputs.get(name);
    if (!x) {
      const l = limits.get(name) ?? null;
      x = {
        trader: name,
        tierKey: l?.tier ?? null,
        limits: l ? { accountSize: l.accountSize, dailyLossLimit: l.dailyLossLimit, weeklyLossLimit: l.weeklyLossLimit, maxDrawdown: l.maxDrawdown } : null,
        trades: [],
        ratings: [],
        violationDates: [],
        today,
      };
      inputs.set(name, x);
    }
    return x;
  };
  if (trader) get(trader);
  else {
    for (const u of usersRes.rows) if (u.role === "trader") get(String(u.name));
    for (const name of limits.keys()) get(name);
  }
  for (const r of tradesRes.rows) {
    const result = r.result as "win" | "loss" | "be" | null;
    if (!result || result === ("open" as string)) continue;
    const d = String(r.d ?? "").slice(0, 10);
    if (!YMD_RE.test(d)) continue;
    get(String(r.trader)).trades.push({ date: d, net: num(r.net), r: num(r.r), result, source: r.source === "propreports" ? "propreports" : "manual" });
  }
  for (const r of ratingsRes.rows) get(String(r.trader)).ratings.push({ week: String(r.week).slice(0, 10), discipline: num(r.discipline), overall: num(r.overall) });
  for (const r of violRes.rows) get(String(r.trader)).violationDates.push(String(r.d));
  for (const r of errRes.rows) get(String(r.trader)).violationDates.push(String(r.d));
  return { inputs, limits };
}

async function loadPending(trader: string | null): Promise<Map<string, Proposal>> {
  const { rows } = await pool.query(
    `SELECT ${PROPOSAL_COLS} FROM scaling_proposals WHERE status = 'pending' AND ($1::text IS NULL OR trader = $1)`,
    [trader],
  );
  return new Map(rows.map((r: any) => [String(r.trader), rowToProposal(r)]));
}

type EvaluatedTrader = Evaluation & { limits: LimitsRow | null; pendingProposal: Proposal | null; role: string | null };

async function evaluateScope(trader: string | null, today: string): Promise<{ tiers: Tier[]; rules: Rule[]; traders: EvaluatedTrader[] }> {
  const [tiers, rules] = await Promise.all([loadTiers(), loadRules()]);
  const [{ inputs, limits }, pending, usersRes] = await Promise.all([
    loadInputs(trader, today, rules),
    loadPending(trader),
    pool.query(`SELECT name, role FROM users WHERE ($1::text IS NULL OR name = $1)`, [trader]),
  ]);
  const roles = new Map<string, string>(usersRes.rows.map((u: any) => [String(u.name), String(u.role)]));
  const ACTION_ORDER: Record<string, number> = { demote: 0, promote: 1, assign: 2, hold: 3 };
  const traders = [...inputs.values()]
    .map((input) => ({
      ...evaluateTrader(input, tiers, rules),
      limits: limits.get(input.trader) ?? null,
      pendingProposal: pending.get(input.trader) ?? null,
      role: roles.get(input.trader) ?? null,
    }))
    .sort((a, b) =>
      (ACTION_ORDER[a.recommendation.action] ?? 9) - (ACTION_ORDER[b.recommendation.action] ?? 9)
      || (b.progress ?? -1) - (a.progress ?? -1)
      || a.trader.localeCompare(b.trader, "ru"),
    );
  return { tiers, rules, traders };
}

/** One trader's evaluation now (lib/daily tier progress «to Junior: 3 of 5»); null when the trader is unknown. */
export async function evaluateTraderNow(trader: string, today: string): Promise<Evaluation | null> {
  await ensureTables();
  return (await evaluateScope(trader, today)).traders.find((t) => t.trader === trader) ?? null;
}

// ─── config ─────────────────────────────────────────────────────────────────

const meta = (lang: Lang) => ({ metrics: metricsMeta(lang), ops: OPS, units: unitsMeta(lang) });

router.get("/scaling/config", asyncHandler(async (req, res): Promise<void> => {
  const v = await viewer(req, res);
  if (!v) return;
  await ensureTables();
  const [tiers, rules] = await Promise.all([loadTiers(), loadRules()]);
  res.json({ tiers, rules, meta: meta(langOf(req)), canEdit: v.staff });
}));

const money = z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/).transform(Number)])
  .pipe(z.number().finite().min(0).max(1e12)).nullable().optional();

const TierBody = z.object({
  key: z.string().trim().regex(/^[a-z0-9_-]{1,40}$/),
  name: z.string().trim().min(1).max(60),
  order: z.number().int().min(0).max(1000).optional(),
  accountSize: money,
  dailyLossLimit: money,
  weeklyLossLimit: money,
  maxDrawdown: money,
  maxRiskPerTrade: money,
  maxPositionUsd: money,
  maxOvernightExposure: money,
  maxOpenPositions: z.number().int().min(0).max(1000).nullable().optional(),
  allowOvernight: z.boolean().optional(),
  allowSwing: z.boolean().optional(),
  description: z.string().trim().max(300).nullable().optional(),
}).strict();

router.put("/scaling/tiers", asyncHandler(async (req, res): Promise<void> => {
  const v = await staffOnly(req, res, "scaling.configure");
  if (!v) return;
  await ensureTables();
  const parsed = z.array(TierBody).min(1).max(20).safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const keys = new Set<string>();
  for (const t of parsed.data) {
    if (keys.has(t.key)) throw new AppError("TIER_KEY_DUPLICATE", 400, { key: t.key });
    keys.add(t.key);
  }
  const tiers: Tier[] = parsed.data.map((t, i) => ({
    key: t.key, name: t.name, order: t.order ?? i + 1,
    accountSize: t.accountSize ?? null, dailyLossLimit: t.dailyLossLimit ?? null, weeklyLossLimit: t.weeklyLossLimit ?? null,
    maxDrawdown: t.maxDrawdown ?? null, maxRiskPerTrade: t.maxRiskPerTrade ?? null, maxPositionUsd: t.maxPositionUsd ?? null,
    maxOvernightExposure: t.maxOvernightExposure ?? null, maxOpenPositions: t.maxOpenPositions ?? null,
    allowOvernight: t.allowOvernight ?? false, allowSwing: t.allowSwing ?? false, description: t.description ?? null,
  }));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const t of tiers) await upsertTier(client, t, v.name);
    await client.query(`UPDATE scaling_tiers SET active = FALSE, updated_by = $2, updated_at = NOW() WHERE NOT (key = ANY($1::text[])) AND active = TRUE`, [[...keys], v.name]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await logAudit({ actor: v.name, action: "scaling.tiers.update", targetType: "scaling_tiers", details: { keys: [...keys] } });
  res.json({ tiers: await loadTiers() });
}));

const METRIC_KEYS = metricsMeta().map((m) => m.key) as [MetricKey, ...MetricKey[]];
const RuleBody = z.object({
  id: z.number().int().positive().optional(),
  kind: z.enum(["promote", "demote"]),
  metric: z.enum(METRIC_KEYS),
  op: z.enum([">=", ">", "<=", "<", "="]),
  value: z.number().finite().min(-1e9).max(1e9),
  unit: z.enum(["abs", "x_daily_limit", "pct_account"]).default("abs"),
  windowDays: z.number().int().min(1).max(260).default(20),
  tierKey: z.string().trim().max(40).nullable().optional().transform((s) => (s ? s : null)),
  label: z.string().trim().max(120).nullable().optional().transform((s) => (s ? s : null)),
  enabled: z.boolean().default(true),
}).strict();

router.put("/scaling/rules", asyncHandler(async (req, res): Promise<void> => {
  const v = await staffOnly(req, res, "scaling.configure");
  if (!v) return;
  await ensureTables();
  const parsed = z.array(RuleBody).max(100).safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const tierKeys = new Set((await loadTiers()).map((t) => t.key));
  for (const r of parsed.data) {
    if (r.tierKey && !tierKeys.has(r.tierKey)) throw new AppError("TIER_NOT_FOUND", 400, { tier: r.tierKey });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const keep: number[] = [];
    let order = 0;
    for (const r of parsed.data) {
      const body: Omit<Rule, "id"> = { kind: r.kind, metric: r.metric, op: r.op, value: r.value, unit: r.unit, windowDays: r.windowDays, tierKey: r.tierKey ?? null, label: r.label ?? null, enabled: r.enabled };
      if (r.id) {
        const { rows } = await client.query(
          `UPDATE scaling_rules SET kind=$2, metric=$3, op=$4, value=$5, unit=$6, window_days=$7, tier_key=$8, label=$9, enabled=$10, sort_order=$11, updated_by=$12, updated_at=NOW()
            WHERE id = $1 RETURNING id`,
          [r.id, body.kind, body.metric, body.op, body.value, body.unit, body.windowDays, body.tierKey, body.label, body.enabled, order, v.name],
        );
        if (rows.length) { keep.push(r.id); order++; continue; }
      }
      keep.push(await insertRule(client, body, order++, v.name));
    }
    await client.query(`DELETE FROM scaling_rules WHERE NOT (id = ANY($1::int[]))`, [keep]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await logAudit({ actor: v.name, action: "scaling.rules.update", targetType: "scaling_rules", details: { count: parsed.data.length } });
  res.json({ rules: await loadRules() });
}));

// ─── evaluation ─────────────────────────────────────────────────────────────

router.get("/scaling/evaluate", asyncHandler(async (req, res): Promise<void> => {
  const v = await viewer(req, res);
  if (!v) return;
  await ensureTables();
  const raw = typeof req.query.trader === "string" ? req.query.trader.trim() : "";
  if (raw.length > 100) throw badRequest("INVALID_TRADER");
  if (!v.staff && raw && raw !== v.name) throw new AppError("SCALING_OWN_ONLY");
  const trader = v.staff ? (raw || null) : v.name;
  const today = clientDate(req.query.date);
  const { tiers, rules, traders } = await evaluateScope(trader, today);
  const summary = {
    traders: traders.length,
    promote: traders.filter((t) => t.recommendation.action === "promote").length,
    demote: traders.filter((t) => t.recommendation.action === "demote").length,
    assign: traders.filter((t) => t.recommendation.action === "assign").length,
    hold: traders.filter((t) => t.recommendation.action === "hold").length,
    warnings: traders.filter((t) => t.recommendation.warning).length,
    pending: traders.filter((t) => t.pendingProposal).length,
  };
  res.json({ date: today, tiers, rules, meta: meta(langOf(req)), summary, traders, canEdit: v.staff });
}));

// ─── proposals ──────────────────────────────────────────────────────────────

router.get("/scaling/proposals", asyncHandler(async (req, res): Promise<void> => {
  const v = await viewer(req, res);
  if (!v) return;
  await ensureTables();
  const status = typeof req.query.status === "string" && ["pending", "approved", "rejected", "all"].includes(req.query.status) ? req.query.status : "pending";
  const raw = typeof req.query.trader === "string" ? req.query.trader.trim() : "";
  const trader = v.staff ? (raw || null) : v.name;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const { rows } = await pool.query(
    `SELECT ${PROPOSAL_COLS} FROM scaling_proposals
      WHERE ($1::text IS NULL OR trader = $1) AND ($2::text = 'all' OR status = $2::text)
      ORDER BY (status = 'pending') DESC, created_at DESC LIMIT $3`,
    [trader, status, limit],
  );
  res.json({ proposals: rows.map((r) => rowToProposal(r)) });
}));

/** Compact snapshot stored with a proposal (rules + windows, no raw trades). */
function snapshotOf(e: Evaluation) {
  return {
    today: e.today,
    tierKey: e.tierKey,
    recommendation: e.recommendation.action,
    progress: e.progress,
    rules: e.rules.map((r) => ({ metric: r.metric, label: r.label, kind: r.kind, op: r.op, threshold: r.threshold, actual: r.actual, status: r.status })),
    metrics: e.windows.find((w) => w.windowDays === 20)?.values ?? null,
  };
}

async function createProposal(opts: {
  trader: string; action: "promote" | "demote" | "assign"; fromTier: string | null; toTier: string; source: "auto" | "manual";
  /** Stored as data (ReasonItem objects), rendered per reader by rowToProposal. */
  reasons: ReasonItem[]; snapshot: unknown; comment: string | null; actor: string; lang?: Lang;
}): Promise<Proposal | null> {
  const { rows } = await pool.query(
    `INSERT INTO scaling_proposals (trader, action, from_tier, to_tier, status, source, reasons, snapshot, comment, created_by)
     VALUES ($1,$2,$3,$4,'pending',$5,$6::jsonb,$7::jsonb,$8,$9)
     ON CONFLICT (trader) WHERE status = 'pending' DO NOTHING
     RETURNING ${PROPOSAL_COLS}`,
    [opts.trader, opts.action, opts.fromTier, opts.toTier, opts.source, JSON.stringify(opts.reasons), JSON.stringify(opts.snapshot ?? null), opts.comment, opts.actor],
  );
  return rows[0] ? rowToProposal(rows[0], false, opts.lang ?? "ru") : null;
}

// ─── notifications (background, never block / fail the operation) ─────────────

/** Tier name by key (null when the trader has no tier — the renderer writes «без тира» in the reader's language). */
const tierName = (tiers: Tier[], key: string | null | undefined): string | null => (key ? tiers.find((t) => t.key === key)?.name ?? key : null);
const tierLimitParams = (tier: Tier | null) => (tier ? {
  ...(tier.dailyLossLimit != null ? { daily: tier.dailyLossLimit } : {}),
  ...(tier.weeklyLossLimit != null ? { weekly: tier.weeklyLossLimit } : {}),
  ...(tier.maxDrawdown != null ? { dd: tier.maxDrawdown } : {}),
} : {});

/** scaling_proposal → the trader's assigned staff (fallback: every curator/admin), except the curator who created it. */
function notifyProposalCreated(p: Proposal, tiers: Tier[], actor: string, reasonItems: ReasonItem[]): void {
  inBackground("scaling.proposal", async () => {
    await notifyUsers(await staffOrFallback(p.trader), {
      type: "scaling_proposal", actor, source: "scaling",
      params: {
        trader: p.trader, actionCode: p.action, from: tierName(tiers, p.fromTier), to: tierName(tiers, p.toTier) ?? p.toTier,
        source: p.source, actor, ...(reasonItems.length ? { reasonsJson: JSON.stringify(reasonItems.slice(0, 2)) } : {}),
      },
      link: notifLinks.scaling(p.trader), entityType: "scaling_proposal", entityId: p.id,
    }, actor);
  });
}

/** scaling_decision → the trader and the proposal's author (never the curator who decided). */
function notifyDecision(p: Proposal, approved: boolean, actor: string, comment: string | null, tier: Tier | null): void {
  inBackground("scaling.decision", async () => {
    const tiers = tier ? [tier] : await loadTiers();
    const base = {
      trader: p.trader, approved: approved ? 1 : 0, actionCode: p.action, to: tierName(tiers, p.toTier) ?? p.toTier, actor,
      ...(approved ? tierLimitParams(tier) : {}), ...(comment ? { comment } : {}),
    };
    for (const name of uniqueRecipients([p.trader, p.createdBy], actor)) {
      await notifyUser({
        userName: name, type: "scaling_decision", actor, source: "scaling",
        params: { ...base, variant: name === p.trader ? "trader" : "staff" },
        link: notifLinks.scaling(p.trader), entityType: "scaling_proposal", entityId: p.id,
      });
    }
  });
}

const ProposalBody = z.object({
  trader: z.string().trim().min(1).max(100),
  action: z.enum(["promote", "demote", "assign"]).optional(),
  toTier: z.string().trim().max(40).optional(),
  comment: z.string().trim().max(2000).optional(),
}).strict();

router.post("/scaling/proposals", asyncHandler(async (req, res): Promise<void> => {
  const v = await staffOnly(req, res, "scaling.approve");
  if (!v) return;
  await ensureTables();
  const parsed = ProposalBody.safeParse(req.body ?? {});
  if (!parsed.success) throw parsed.error;
  const b = parsed.data;
  const { rows: known } = await pool.query(`SELECT 1 FROM users WHERE name = $1 LIMIT 1`, [b.trader]);
  if (!known.length) throw notFound("TRADER_NOT_FOUND");
  const today = nyDate();
  const { tiers, traders } = await evaluateScope(b.trader, today);
  const e = traders[0];
  if (!e) throw notFound("TRADER_NO_DATA");
  if (e.pendingProposal) throw conflict("PROPOSAL_PENDING", { proposal: e.pendingProposal });

  let toTier: Tier | null = null;
  let action = b.action ?? (e.recommendation.action === "hold" ? null : e.recommendation.action);
  if (b.toTier) {
    toTier = tiers.find((t) => t.key === b.toTier) ?? null;
    if (!toTier) throw new AppError("TIER_NOT_FOUND", 400, { tier: b.toTier });
    if (!action) {
      const cur = e.tier;
      action = !cur ? "assign" : toTier.order > cur.order ? "promote" : toTier.order < cur.order ? "demote" : "assign";
    }
  } else {
    toTier = action === "promote" ? e.nextTier : action === "demote" ? e.prevTier : action === "assign" ? (e.recommendation.toTier ?? tiers[0] ?? null) : null;
  }
  if (!action || !toTier) throw new AppError("PROPOSAL_TARGET_REQUIRED");
  if (toTier.key === e.tierKey) throw new AppError("ALREADY_ON_TIER");

  const manual: ReasonItem[] = b.action || b.toTier ? [b.comment ? { code: "manualWith", comment: b.comment } : { code: "manual" }] : [];
  const reasons = [...manual, ...e.recommendation.reasonItems];
  const p = await createProposal({ trader: b.trader, action, fromTier: e.tierKey, toTier: toTier.key, source: "manual", reasons, snapshot: snapshotOf(e), comment: b.comment ?? null, actor: v.name, lang: langOf(req) });
  if (!p) throw conflict("PROPOSAL_PENDING");
  await logAudit({ actor: v.name, action: "scaling.proposal.create", targetType: "scaling_proposal", targetId: String(p.id), details: { trader: b.trader, action, toTier: toTier.key, source: "manual" } });
  notifyProposalCreated(p, tiers, v.name, reasons);
  res.status(201).json(p);
}));

router.post("/scaling/proposals/auto", asyncHandler(async (req, res): Promise<void> => {
  const v = await staffOnly(req, res, "scaling.approve");
  if (!v) return;
  await ensureTables();
  const today = clientDate(req.body?.date);
  const { tiers, traders } = await evaluateScope(null, today);
  const created: (Proposal & { reasonItems: ReasonItem[] })[] = [];
  for (const e of traders) {
    const a = e.recommendation.action;
    if ((a !== "promote" && a !== "demote") || !e.recommendation.toTier || e.pendingProposal) continue;
    const p = await createProposal({ trader: e.trader, action: a, fromTier: e.tierKey, toTier: e.recommendation.toTier.key, source: "auto", reasons: e.recommendation.reasonItems, snapshot: snapshotOf(e), comment: null, actor: v.name, lang: langOf(req) });
    if (p) created.push({ ...p, reasonItems: e.recommendation.reasonItems });
  }
  if (created.length) {
    await logAudit({ actor: v.name, action: "scaling.proposal.auto", targetType: "scaling_proposal", details: { count: created.length, traders: created.map((p) => p.trader) } });
    for (const p of created) notifyProposalCreated(p, tiers, v.name, p.reasonItems);
  }
  res.json({ created: created.length, proposals: created.map(({ reasonItems: _items, ...p }) => p) });
}));

function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
const DecisionBody = z.object({ comment: z.string().trim().max(2000).optional() }).strict();

/** Writes the tier's limits into trader_risk_limits (keeps notes) and records history. Caller owns the transaction. */
async function applyTier(client: Queryable, trader: string, tier: Tier, actor: string, opts: { action: string; fromTier: string | null; proposalId: number | null; comment: string | null }) {
  await client.query(
    `INSERT INTO trader_risk_limits AS l (
       trader, account_size, daily_loss_limit, weekly_loss_limit, max_drawdown, max_risk_per_trade,
       max_position_usd, max_overnight_exposure, max_open_positions, allow_overnight, allow_swing, tier, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
     ON CONFLICT (trader) DO UPDATE SET
       account_size = EXCLUDED.account_size,
       daily_loss_limit = EXCLUDED.daily_loss_limit,
       weekly_loss_limit = EXCLUDED.weekly_loss_limit,
       max_drawdown = EXCLUDED.max_drawdown,
       max_risk_per_trade = EXCLUDED.max_risk_per_trade,
       max_position_usd = EXCLUDED.max_position_usd,
       max_overnight_exposure = EXCLUDED.max_overnight_exposure,
       max_open_positions = EXCLUDED.max_open_positions,
       allow_overnight = EXCLUDED.allow_overnight,
       allow_swing = EXCLUDED.allow_swing,
       tier = EXCLUDED.tier,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [trader, tier.accountSize, tier.dailyLossLimit, tier.weeklyLossLimit, tier.maxDrawdown, tier.maxRiskPerTrade, tier.maxPositionUsd,
      tier.maxOvernightExposure, tier.maxOpenPositions, tier.allowOvernight, tier.allowSwing, tier.key, actor],
  );
  const { rows } = await client.query(
    `INSERT INTO scaling_history (trader, action, from_tier, to_tier, proposal_id, actor, comment, limits)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id`,
    [trader, opts.action, opts.fromTier, tier.key, opts.proposalId, actor, opts.comment, JSON.stringify(tier)],
  );
  return Number(rows[0].id);
}

router.post("/scaling/proposals/:id/approve", asyncHandler(async (req, res): Promise<void> => {
  const v = await staffOnly(req, res, "scaling.approve");
  if (!v) return;
  await ensureTables();
  const id = parseId(req.params.id);
  if (!id) throw badRequest("INVALID_ID");
  const parsed = DecisionBody.safeParse(req.body ?? {});
  if (!parsed.success) throw new AppError("TEXT_TOO_LONG", 400, { field: "comment", max: 2000 });
  const comment = parsed.data.comment || null;
  const tiers = await loadTiers();

  const client = await pool.connect();
  let result: { proposal: Proposal; historyId: number; tier: Tier } | null = null;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT ${PROPOSAL_COLS} FROM scaling_proposals WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) { await client.query("ROLLBACK"); throw notFound("PROPOSAL_NOT_FOUND"); }
    const p = rowToProposal(rows[0]);
    if (p.status !== "pending") { await client.query("ROLLBACK"); throw conflict("PROPOSAL_DECIDED", { proposal: p }); }
    const tier = tiers.find((t) => t.key === p.toTier);
    if (!tier) { await client.query("ROLLBACK"); throw new AppError("PROPOSAL_TIER_GONE", 400, { tier: p.toTier }); }
    const { rows: cur } = await client.query(`SELECT tier FROM trader_risk_limits WHERE trader = $1`, [p.trader]);
    const fromTier = cur[0]?.tier ?? p.fromTier ?? null;
    const historyId = await applyTier(client, p.trader, tier, v.name, { action: p.action, fromTier, proposalId: p.id, comment });
    const { rows: upd } = await client.query(
      `UPDATE scaling_proposals SET status = 'approved', decided_by = $2, decided_at = NOW(), decision_comment = $3 WHERE id = $1 RETURNING ${PROPOSAL_COLS}`,
      [id, v.name, comment],
    );
    await client.query("COMMIT");
    result = { proposal: rowToProposal(upd[0]), historyId, tier };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await logAudit({
    actor: v.name, action: "scaling.proposal.approve", targetType: "scaling_proposal", targetId: String(id),
    details: { trader: result.proposal.trader, action: result.proposal.action, fromTier: result.proposal.fromTier, toTier: result.tier.key, historyId: result.historyId, comment },
  });
  notifyDecision(result.proposal, true, v.name, comment, result.tier);
  res.json(result);
}));

router.post("/scaling/proposals/:id/reject", asyncHandler(async (req, res): Promise<void> => {
  const v = await staffOnly(req, res, "scaling.approve");
  if (!v) return;
  await ensureTables();
  const id = parseId(req.params.id);
  if (!id) throw badRequest("INVALID_ID");
  const parsed = DecisionBody.safeParse(req.body ?? {});
  if (!parsed.success) throw new AppError("TEXT_TOO_LONG", 400, { field: "comment", max: 2000 });
  const comment = parsed.data.comment || null;
  const { rows } = await pool.query(
    `UPDATE scaling_proposals SET status = 'rejected', decided_by = $2, decided_at = NOW(), decision_comment = $3
      WHERE id = $1 AND status = 'pending' RETURNING ${PROPOSAL_COLS}`,
    [id, v.name, comment],
  );
  if (!rows[0]) {
    const { rows: ex } = await pool.query(`SELECT ${PROPOSAL_COLS} FROM scaling_proposals WHERE id = $1`, [id]);
    if (!ex[0]) throw notFound("PROPOSAL_NOT_FOUND");
    throw conflict("PROPOSAL_DECIDED", { proposal: rowToProposal(ex[0], false, langOf(req)) });
  }
  const p = rowToProposal(rows[0]);
  await logAudit({ actor: v.name, action: "scaling.proposal.reject", targetType: "scaling_proposal", targetId: String(id), details: { trader: p.trader, action: p.action, toTier: p.toTier, comment } });
  notifyDecision(p, false, v.name, comment, null);
  res.json({ proposal: p });
}));

const AssignBody = z.object({
  trader: z.string().trim().min(1).max(100),
  tierKey: z.string().trim().min(1).max(40),
  comment: z.string().trim().max(2000).optional(),
}).strict();

router.post("/scaling/assign", asyncHandler(async (req, res): Promise<void> => {
  const v = await staffOnly(req, res, "scaling.approve");
  if (!v) return;
  await ensureTables();
  const parsed = AssignBody.safeParse(req.body ?? {});
  if (!parsed.success) throw parsed.error;
  const b = parsed.data;
  const { rows: known } = await pool.query(`SELECT 1 FROM users WHERE name = $1 LIMIT 1`, [b.trader]);
  if (!known.length) throw notFound("TRADER_NOT_FOUND");
  const tiers = await loadTiers();
  const tier = tiers.find((t) => t.key === b.tierKey);
  if (!tier) throw new AppError("TIER_NOT_FOUND", 400, { tier: b.tierKey });

  const client = await pool.connect();
  let out: { fromTier: string | null; historyId: number } | null = null;
  try {
    await client.query("BEGIN");
    const { rows: cur } = await client.query(`SELECT tier FROM trader_risk_limits WHERE trader = $1 FOR UPDATE`, [b.trader]);
    const fromTier: string | null = cur[0]?.tier ?? null;
    if (fromTier === tier.key) { await client.query("ROLLBACK"); throw new AppError("ALREADY_ON_TIER"); }
    const fromOrder = tiers.find((t) => t.key === fromTier)?.order;
    const action = fromOrder == null ? "assign" : tier.order > fromOrder ? "promote" : "demote";
    const historyId = await applyTier(client, b.trader, tier, v.name, { action, fromTier, proposalId: null, comment: b.comment ?? null });
    // a pending proposal for this trader is now stale
    // Stored decision note, in the curator's language (staff read it on the proposal card).
    await client.query(
      `UPDATE scaling_proposals SET status = 'rejected', decided_by = $2, decided_at = NOW(), decision_comment = $3 WHERE trader = $1 AND status = 'pending'`,
      [b.trader, v.name, scalingT.tFor(langOf(req))("assignDecision")],
    );
    await client.query("COMMIT");
    out = { fromTier, historyId };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await logAudit({ actor: v.name, action: "scaling.assign", targetType: "trader_risk_limits", targetId: b.trader, details: { fromTier: out.fromTier, toTier: tier.key, historyId: out.historyId, comment: b.comment ?? null } });
  if (b.trader !== v.name) {
    const fromName = tierName(tiers, out.fromTier);
    const actor = v.name;
    inBackground("scaling.assign", () => notifyUser({
      userName: b.trader, type: "limit_change", actor, source: "scaling",
      params: { variant: "assign", actor, from: fromName, to: tier.name, ...tierLimitParams(tier), ...(b.comment ? { comment: b.comment } : {}) },
      link: notifLinks.scaling(b.trader), entityType: "scaling_tier", entityId: b.trader,
    }));
  }
  res.json({ trader: b.trader, fromTier: out.fromTier, tier, historyId: out.historyId });
}));

// ─── limit templates (used by routes/risk.ts «Применить шаблон тира» and the curator cabinet) ─────────────

/** Active tiers = limit templates (Стажёр / Джун / Трейдер / Сеньор / Лид). Ensures + seeds the tables. */
export async function loadTierTemplates(): Promise<Tier[]> {
  await ensureTables();
  return loadTiers();
}

/**
 * Apply a tier's limits to a trader in one transaction (also when the tier is unchanged — a resync of drifted
 * limits). Writes scaling_history (promote / demote / assign — the actions the scaling UI knows); a pending
 * proposal is closed only when the tier actually changes. Notes in trader_risk_limits are kept.
 */
export async function applyTierTemplate(trader: string, tierKey: string, actor: string, comment: string | null, lang: Lang = "ru"): Promise<
  { ok: true; tier: Tier; fromTier: string | null; historyId: number; resync: boolean } | { ok: false; status: number; error: string; code: "TIER_NOT_FOUND" }
> {
  await ensureTables();
  const tiers = await loadTiers();
  const tier = tiers.find((t) => t.key === tierKey);
  if (!tier) return { ok: false, status: 400, code: "TIER_NOT_FOUND", error: errorMessage("TIER_NOT_FOUND", lang, { tier: tierKey }) };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: cur } = await client.query(`SELECT tier FROM trader_risk_limits WHERE trader = $1 FOR UPDATE`, [trader]);
    const fromTier: string | null = cur[0]?.tier ?? null;
    const fromOrder = tiers.find((t) => t.key === fromTier)?.order;
    const resync = fromTier === tier.key;
    const action = resync || fromOrder == null ? "assign" : tier.order > fromOrder ? "promote" : "demote";
    const historyId = await applyTier(client, trader, tier, actor, { action, fromTier, proposalId: null, comment: comment ?? (resync ? scalingT.tFor(lang)("templateResync") : null) });
    if (!resync) {
      await client.query(
        `UPDATE scaling_proposals SET status = 'rejected', decided_by = $2, decided_at = NOW(), decision_comment = $3 WHERE trader = $1 AND status = 'pending'`,
        [trader, actor, scalingT.tFor(lang)("templateDecision")],
      );
    }
    await client.query("COMMIT");
    return { ok: true, tier, fromTier, historyId, resync };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ─── history ────────────────────────────────────────────────────────────────

router.get("/scaling/history", asyncHandler(async (req, res): Promise<void> => {
  const v = await viewer(req, res);
  if (!v) return;
  await ensureTables();
  const raw = typeof req.query.trader === "string" ? req.query.trader.trim() : "";
  if (raw.length > 100) throw badRequest("INVALID_TRADER");
  if (!v.staff && raw && raw !== v.name) throw new AppError("SCALING_OWN_ONLY");
  const trader = v.staff ? (raw || null) : v.name;
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const { rows } = await pool.query(
    `SELECT * FROM scaling_history WHERE ($1::text IS NULL OR trader = $1) ORDER BY created_at DESC, id DESC LIMIT $2`,
    [trader, limit],
  );
  res.json({ trader, history: rows.map(rowToHistory) });
}));

export default router;
