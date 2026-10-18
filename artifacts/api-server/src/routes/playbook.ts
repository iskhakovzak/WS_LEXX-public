import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { handleAiNotConfigured } from "../lib/aiErrors";
import { asyncHandler } from "../lib/asyncHandler";
import { logActivity } from "../lib/activity";
import { activityDetails, activityTitle } from "../lib/activityText";
import { logger } from "../lib/logger";
import { config } from "../config";
import { sanitizeMultiLineUrls } from "../lib/safe-url";
import { computeEdge, bucketBy, vixBucket, scoreBucket, edgeScore, type EdgeTrade } from "../lib/playbookEdge";
import { canAccessTrade, isGuest, requireAuth, scopeTrader } from "../lib/auth";
import { can, requireCap } from "../lib/permissions";
import { closeDateSql, decidedSql, horizonSql, netPnlSql, resultSql, signedRSql } from "../lib/tradeMath";
import {
  accessHints, canEditSetupRow, canReadPure, ensurePlaybookSpaces, loadMoneyViewer, loadSetupAccess, loadViewer, mayShareAny,
  spaceOf, spaceSql, visibleSql,
} from "../lib/playbookAccess";
import { canSeeAggregateMoney, canSeeTradeMoney, redactEdgeStats, redactSummaryRow, redactTradeRow } from "../lib/playbookPrivacy";
import { AppError, badRequest, notFound, sendError, sendErrorWith, unauthorized } from "../lib/http";
import { aiLanguageEn } from "../i18n/ai";
import { langOf } from "../i18n";

/**
 * Playbook (setups) + per-setup edge.
 *
 * Access model (spaces: lib/playbookAccess.ts):
 *  - «Офис» setups are read by everyone and edited by curators; personal («Мой») setups are read by the owner,
 *    staff within team.read scope, and whoever the owner shared them with («Общие»). Every list/read endpoint
 *    filters with visibleSql / canReadPure; a setup you may not read answers 404.
 *  - Anything derived from trades (summary, health, edge, linked trades, AI critique) is scoped with
 *    scopeTrader(): staff may pass ?userKey= (null = whole desk); a trader always sees their own book.
 *  - $ privacy (lib/playbookPrivacy.ts): $ facts of a trade (net / pnl / fees / qty / risk $) are shown only to its
 *    owner and to staff. Linked trades are redacted per row (redacted: true); aggregates (summary, edge) keep
 *    counts / win rate / R and null their $ unless every included trade is the viewer's own.
 *  - Mutations: canEditSetupRow (office → curators, personal → owner / staff). Curator-only: review verdicts,
 *    office folder rename/delete. Examples, sharing, copy, promote, media: routes/playbook-spaces.ts.
 *  - AI endpoints are explicit (never auto-fired), author/staff only, 1 call per 10 min per setup.
 */
const router: IRouter = Router();

type ChecklistItem = { id: string; text: string };
type Screenshot = { url: string; notes?: string; addedBy?: string | null; addedAt?: string };

function itemIdFromText(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return `t${(h >>> 0).toString(36)}`;
}
function normChecklistItems(input: unknown): ChecklistItem[] | null {
  if (!Array.isArray(input)) return null;
  const out: ChecklistItem[] = [];
  for (const it of input) {
    if (!it || typeof it !== "object") continue;
    const text = String((it as any).text ?? "").trim();
    if (!text) continue;
    const id = String((it as any).id ?? "").trim() || itemIdFromText(text);
    out.push({ id, text });
  }
  return out;
}
function itemsFromChecklistText(text: string | null | undefined): ChecklistItem[] {
  if (!text) return [];
  return text.split("\n")
    .map((l) => l.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean)
    .map((t) => ({ id: itemIdFromText(t), text: t }));
}
function checklistItemsToText(items: ChecklistItem[]): string {
  return items.map((it) => `- ${it.text}`).join("\n");
}
function normScreenshots(input: unknown): Screenshot[] | null {
  if (!Array.isArray(input)) return null;
  const out: Screenshot[] = [];
  for (const it of input) {
    if (!it || typeof it !== "object") continue;
    const url = String((it as any).url ?? "").trim();
    if (!url) continue;
    out.push({
      url,
      notes: typeof (it as any).notes === "string" ? (it as any).notes : "",
      addedBy: (it as any).addedBy ?? null,
      addedAt: typeof (it as any).addedAt === "string" ? (it as any).addedAt : new Date().toISOString(),
    });
  }
  return out;
}
function screenshotsToLegacy(items: Screenshot[]): { url: string | null; notes: string | null } {
  if (!items.length) return { url: null, notes: null };
  return {
    url: items.map((s) => s.url).join("\n"),
    notes: JSON.stringify(items.map((s) => s.notes ?? "")),
  };
}

const PLAYBOOK_SELECT_FIELDS = `
  id, name, folder,
  setup_type        AS "setupType",
  conditions, checklist, notes,
  checklist_items   AS "checklistItems",
  screenshots,
  confidence_level  AS "confidenceLevel",
  screenshot_url    AS "screenshotUrl",
  screenshot_notes  AS "screenshotNotes",
  tags,
  source_type       AS "sourceType",
  source_id         AS "sourceId",
  trader,
  deleted_at        AS "deletedAt",
  created_at        AS "createdAt",
  parent_id         AS "parentId",
  ticker,
  market_cap        AS "marketCap",
  float,
  adv,
  atr,
  relative_volume   AS "relativeVolume",
  beta,
  short_interest    AS "shortInterest",
  sector,
  long_name         AS "longName",
  reviewed,
  reviewed_by       AS "reviewedBy",
  reviewed_at       AS "reviewedAt",
  COALESCE(space, CASE WHEN trader IS NULL THEN 'office' ELSE 'personal' END) AS space,
  COALESCE(visibility, 'private') AS visibility,
  shared_with       AS "sharedWith",
  shared_at         AS "sharedAt",
  shared_by         AS "sharedBy",
  created_by        AS "createdBy",
  copied_from_id    AS "copiedFromId",
  copied_from_author AS "copiedFromAuthor",
  promoted_from_id  AS "promotedFromId",
  office_proposed_at AS "officeProposedAt",
  office_proposed_by AS "officeProposedBy",
  office_proposed_note AS "officeProposedNote",
  context_text      AS "contextText",
  trigger_text      AS "triggerText",
  entry_text        AS "entryText",
  stop_text         AS "stopText",
  targets_text      AS "targetsText",
  management_text   AS "managementText",
  invalidation_text AS "invalidationText",
  ideal_conditions  AS "idealConditions",
  time_of_day       AS "timeOfDay",
  horizon,
  media,
  updated_at        AS "updatedAt"
`;

/** Structured card fields: body key → column. */
const STRUCTURED_FIELDS: [string, string][] = [
  ["contextText", "context_text"],
  ["triggerText", "trigger_text"],
  ["entryText", "entry_text"],
  ["stopText", "stop_text"],
  ["targetsText", "targets_text"],
  ["managementText", "management_text"],
  ["invalidationText", "invalidation_text"],
  ["idealConditions", "ideal_conditions"],
  ["timeOfDay", "time_of_day"],
];
const HORIZONS = new Set(["intraday", "overnight", "swing"]);
/** Pasted screenshots: [{ id: playbook_media.id, note }] (≤ 24). */
function normMedia(input: unknown): { id: number; note: string }[] | null {
  if (!Array.isArray(input)) return null;
  const out: { id: number; note: string }[] = [];
  for (const it of input) {
    const id = Number((it as any)?.id);
    if (!Number.isInteger(id) || id <= 0 || out.some((m) => m.id === id)) continue;
    out.push({ id, note: typeof (it as any)?.note === "string" ? String((it as any).note).slice(0, 500) : "" });
    if (out.length >= 24) break;
  }
  return out;
}
const textOrNull = (v: unknown, max = 8000): string | null => {
  if (v == null) return null;
  const s = String(v);
  return s.trim() ? s.slice(0, max) : null;
};

// ─── Schema (additive; idempotent) ───────────────────────────────────────────
// playbook_reviews: curator verdict history (approved | needs_work | retired).

let ensured: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!ensured) {
    ensured = ensurePlaybookSpaces().then(() => pool
      .query(
        `CREATE TABLE IF NOT EXISTS playbook_reviews (
           id SERIAL PRIMARY KEY,
           playbook_id INTEGER NOT NULL,
           reviewer TEXT NOT NULL,
           verdict TEXT NOT NULL,
           comment TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         );
         CREATE INDEX IF NOT EXISTS playbook_reviews_playbook_idx ON playbook_reviews (playbook_id, created_at DESC);`,
      ))
      .then(() => undefined)
      .catch((err) => { ensured = null; throw err; });
  }
  return ensured;
}
ensureTables().catch((err) => logger.warn({ err }, "playbook: ensure tables failed at init"));

// ─── Auth helpers ────────────────────────────────────────────────────────────

/** Trade scope for trade-derived reads. Sends 401 and returns undefined for anonymous callers. */
async function tradeScope(req: Request, res: Response): Promise<string | null | undefined> {
  const requested = typeof req.query.userKey === "string" ? req.query.userKey : typeof req.query.trader === "string" ? req.query.trader : null;
  const scope = await scopeTrader(req, requested);
  if (scope === undefined) sendError(res, unauthorized());
  return scope;
}

/** Space-aware edit rule (lib/playbookAccess): «Офис» → curators, personal → owner / staff. Guests never. */
async function canEditSetup(req: Request, row: { trader: string | null; space?: string | null }): Promise<boolean> {
  if (!req.authUser || isGuest(req)) return false;
  return canEditSetupRow(req, row);
}

/** 403 unless the caller may edit setup `id`; returns the row otherwise. A setup the caller cannot read → 404. */
async function requireSetupEditor(req: Request, res: Response, id: number, includeDeleted = false) {
  if (!Number.isInteger(id) || id <= 0) { sendError(res, badRequest("INVALID_ID")); return null; }
  const row = await loadSetupAccess(id, includeDeleted);
  if (!row) { sendError(res, notFound()); return null; }
  const v = await loadViewer(req);
  if (!canReadPure(v, row)) { sendError(res, notFound()); return null; }
  if (!(await canEditSetup(req, row))) {
    sendError(res, new AppError(spaceOf(row) === "office" ? "OFFICE_PLAYBOOK_STAFF_EDIT" : "SETUP_EDITOR_ONLY"));
    return null;
  }
  return row;
}

/** 404 unless the caller may read setup `id`. */
async function requireSetupReader(req: Request, res: Response, id: number) {
  if (!Number.isInteger(id) || id <= 0) { sendError(res, badRequest("INVALID_ID")); return null; }
  const row = await loadSetupAccess(id);
  if (!row || !canReadPure(await loadViewer(req), row)) { sendError(res, notFound()); return null; }
  return row;
}

/** Trade ownership for link/checklist writes (shared canAccessTrade: staff any, member own, guest never). */
/** Throws 401 / 404 / 403 AppErrors unless the caller may touch the trade. */
async function canTouchTrade(req: Request, tradeId: number): Promise<{ ok: true }> {
  if (!req.authUser) throw new AppError("AUTH_REQUIRED");
  const access = await canAccessTrade(req, tradeId);
  if (access === null) throw new AppError("TRADE_NOT_FOUND");
  if (!access) throw new AppError("OWN_TRADES_ONLY");
  return { ok: true };
}

/** Curator review actions (verdicts, folder rename/delete) = playbook.review. */
async function requireStaffOr403(req: Request, res: Response): Promise<boolean> {
  return requireCap(req, res, "playbook.review", null, "STAFF_ONLY");
}

const AI_COOLDOWN_MS = 10 * 60 * 1000;
const aiLastCall = new Map<string, number>();
function aiRateLimited(key: string): number {
  const last = aiLastCall.get(key) ?? 0;
  const left = last + AI_COOLDOWN_MS - Date.now();
  if (left > 0) return left;
  aiLastCall.set(key, Date.now());
  return 0;
}

const numOrNull = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

// ─── Setup documents ─────────────────────────────────────────────────────────

/**
 * Setup list, filtered to what the caller may read. Each row carries `access` hints computed on the server
 * (space, shared, mine, canEdit, canShare, canPromote, canAddExamples). Optional ?space=office|personal|shared.
 * The response header X-Playbook-Viewer carries the viewer's own flags (mayShare, editAny, review, stage).
 */
router.get("/playbook", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const v = await loadViewer(req);
  const params: unknown[] = [];
  const vis = visibleSql(v, params, "p");
  // ?lite=1 — ids / names / folders / source only (duplicate checks, pickers): no review join, no access hints.
  if (req.query.lite === "1") {
    const { rows } = await pool.query<any>(
      `SELECT p.id, p.name, p.folder, p.parent_id AS "parentId", p.source_type AS "sourceType", p.source_id AS "sourceId"
         FROM playbook p WHERE p.deleted_at IS NULL AND ${vis}
        ORDER BY p.created_at DESC`,
      params,
    );
    res.json(rows);
    return;
  }
  const { rows } = await pool.query<any>(
    `SELECT q.*, rv.verdict AS "reviewVerdict", rv.created_at AS "reviewVerdictAt"
       FROM (SELECT ${PLAYBOOK_SELECT_FIELDS} FROM playbook p WHERE p.deleted_at IS NULL AND ${vis}) q
       LEFT JOIN LATERAL (SELECT verdict, created_at FROM playbook_reviews r WHERE r.playbook_id = q.id ORDER BY created_at DESC LIMIT 1) rv ON TRUE
      ORDER BY q."createdAt" DESC`,
    params,
  );
  const want = typeof req.query.space === "string" ? req.query.space : null;
  const out = [];
  for (const r of rows) {
    const access = accessHints(v, r);
    if (want === "office" && access.space !== "office") continue;
    if (want === "personal" && !access.mine) continue;
    if (want === "shared" && !(access.shared && !access.mine)) continue;
    out.push({ ...r, access });
  }
  res.setHeader("X-Playbook-Viewer", encodeURIComponent(JSON.stringify({
    name: v.name, mayShare: mayShareAny(v), editAny: v.editAny, review: v.review, editOwn: v.editOwn, stage: v.stage,
  })));
  res.json(out);
}));

/** The caller's own playbook capabilities (sharing needs the academy stage «Сеньор» or staff). */
router.get("/playbook/me", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const v = await loadViewer(req);
  res.json({ name: v.name, guest: v.guest, mayShare: mayShareAny(v), editOwn: v.editOwn, editAny: v.editAny, review: v.review, stage: v.stage, cohorts: v.cohorts, teamWide: v.teamScope === null });
}));

router.get("/playbook/folders", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const params: unknown[] = [];
  const vis = visibleSql(await loadViewer(req), params, "p");
  const { rows } = await pool.query<{ folder: string }>(
    `SELECT DISTINCT folder FROM playbook p WHERE p.deleted_at IS NULL AND p.folder IS NOT NULL AND ${vis}`, params
  );
  const folders = rows.map(r => r.folder).filter(Boolean) as string[];
  folders.sort((a, b) => a.localeCompare(b));
  res.json(folders);
}));

router.get("/playbook/tags", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const params: unknown[] = [];
  const vis = visibleSql(await loadViewer(req), params, "p");
  const { rows } = await pool.query<any>(
    `SELECT tag, COUNT(*)::int AS count FROM (
       SELECT TRIM(unnest(string_to_array(p.tags, ','))) AS tag
       FROM playbook p
       WHERE p.deleted_at IS NULL AND p.tags IS NOT NULL AND p.tags != '' AND ${vis}
     ) t WHERE tag != ''
     GROUP BY tag ORDER BY count DESC, tag ASC`, params
  );
  res.json(rows);
}));

/** A setup counts as "stale" only once it has a track record that went quiet. */
const STALE_AFTER_DAYS = 60;
/** A never-traded setup is "untested" only after it had time to be tried (not the day it was written). */
const UNTESTED_GRACE_DAYS = 21;

/** «Не торговался N дней»: last linked trade (close date, NY) older than this. */
const IDLE_AFTER_DAYS = 30;

router.get("/playbook/health", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const scope = await tradeScope(req, res);
  if (scope === undefined) return;
  const v = await loadViewer(req);
  const params: unknown[] = [];
  let traderTradeFilter = "";
  if (scope) { params.push(scope); traderTradeFilter = `AND t.trader = $1`; }
  const vis = visibleSql(v, params, "p");
  const { rows } = await pool.query<any>(`
    SELECT p.id, p.name, p.folder, p.confidence_level AS "confidenceLevel", p.trader,
           ${spaceSql("p")} AS space,
           p.parent_id AS "parentId", p.created_at AS "createdAt",
           COUNT(t.id)::int AS "tradeCount",
           COUNT(t.id) FILTER (WHERE ${resultSql()} = 'win')::int AS "wins",
           COUNT(t.id) FILTER (WHERE ${decidedSql()})::int AS "decided",
           AVG(${signedRSql()}) AS "avgR",
           MAX(${closeDateSql()}) AS "lastTradeDate",
           MAX(t.created_at) AS "lastTradeAt",
           (SELECT MAX(r.created_at) FROM playbook_checklist_runs r WHERE r.playbook_id = p.id) AS "lastRunAt",
           (SELECT COUNT(*) FROM playbook_examples e WHERE e.playbook_id = p.id AND e.deleted_at IS NULL)::int AS "exampleCount",
           (SELECT COUNT(*) FROM playbook_examples e WHERE e.playbook_id = p.id AND e.deleted_at IS NULL AND e.tier = 1)::int AS "tier1Count"
    FROM playbook p
    LEFT JOIN trades t ON t.playbook_id = p.id AND t.deleted_at IS NULL ${traderTradeFilter}
    WHERE p.deleted_at IS NULL AND ${vis}
    GROUP BY p.id, p.name, p.folder, p.confidence_level, p.trader, p.space, p.parent_id, p.created_at
  `, params);
  const now = Date.now();
  const daysSince = (d: unknown) => (d ? Math.floor((now - new Date(d as string).getTime()) / 86400000) : null);
  const stale: any[] = [], untested: any[] = [], lowSampleHighConf: any[] = [], underperforming: any[] = [];
  const noExamples: any[] = [], noTier1: any[] = [], idle: any[] = [];
  const totalDecided = rows.reduce((a, r) => a + Number(r.decided), 0);
  const totalWins = rows.reduce((a, r) => a + Number(r.wins), 0);
  // Desk win rate = W / (W + L), break-even excluded.
  const globalWinrate = totalDecided > 0 ? totalWins / totalDecided : null;
  for (const r of rows) {
    const tradeCount = Number(r.tradeCount);
    const { lastRunAt, createdAt, decided, wins, avgR, exampleCount, tier1Count, ...base } = r;
    const days = daysSince(r.lastTradeAt);
    const ex = Number(exampleCount), t1 = Number(tier1Count);
    if (ex === 0) noExamples.push({ ...base, tradeCount, exampleCount: ex });
    else if (t1 === 0) noTier1.push({ ...base, tradeCount, exampleCount: ex });
    const lastDay = r.lastTradeDate ? daysSince(`${String(r.lastTradeDate).slice(0, 10)}T12:00:00Z`) : null;
    if (tradeCount > 0 && lastDay != null && lastDay > IDLE_AFTER_DAYS) idle.push({ ...base, tradeCount, days: lastDay });
    if (tradeCount === 0) {
      // Never traded: flag only after the grace period, and only if nobody ran its checklist recently either.
      const ageDays = daysSince(createdAt) ?? 0;
      const runDays = daysSince(lastRunAt);
      if (ageDays >= UNTESTED_GRACE_DAYS && (runDays == null || runDays > UNTESTED_GRACE_DAYS)) {
        untested.push({ ...base, tradeCount, days: null, ageDays });
      }
    } else if (days != null && days > STALE_AFTER_DAYS) {
      stale.push({ ...base, tradeCount, days });
    }
    if ((r.confidenceLevel ?? 0) >= 70 && tradeCount > 0 && tradeCount < 5) {
      lowSampleHighConf.push({ ...base, tradeCount });
    }
    // Comparing with the desk average only makes sense once the desk itself has a sample.
    const dec = Number(decided);
    if (dec >= 5 && totalDecided >= 20 && globalWinrate != null) {
      const wr = Number(wins) / dec;
      if (wr < globalWinrate - 0.1) underperforming.push({ ...base, tradeCount, winrate: wr, avgR: numOrNull(avgR) });
    }
  }
  stale.sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  untested.sort((a, b) => (b.confidenceLevel ?? 0) - (a.confidenceLevel ?? 0));
  idle.sort((a, b) => (a.days ?? 0) - (b.days ?? 0));
  // Setups the viewer actually trades come first in the example-gap lists.
  noExamples.sort((a, b) => b.tradeCount - a.tradeCount);
  noTier1.sort((a, b) => b.tradeCount - a.tradeCount);
  res.json({
    trader: scope,
    globalWinrate,
    staleAfterDays: STALE_AFTER_DAYS,
    untestedGraceDays: UNTESTED_GRACE_DAYS,
    idleAfterDays: IDLE_AFTER_DAYS,
    total: rows.length,
    noExamples,
    noTier1,
    idle,
    stale,
    untested,
    lowSampleHighConf,
    underperforming,
  });
}));

/**
 * Per-setup aggregates for the library view (list badges, KPI strip, "best edge" /
 * "used today" sorts, compare). Shared trade math: win rate W/(W+L), signed R, NET P&L,
 * PF = ΣR⁺/|ΣR⁻| (null when no losses), horizon split, last-20 trend + edge-decay flag.
 */
const RECENT_N = 20;

router.get("/playbook/summary", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const scope = await tradeScope(req, res);
  if (scope === undefined) return;
  const params: unknown[] = [];
  let tradeFilter = "";
  if (scope) { params.push(scope); tradeFilter = `AND t.trader = $1`; }
  const mv = await loadMoneyViewer(req);
  params.push(mv.name);
  const viewerIdx = params.length;
  const vis = visibleSql(await loadViewer(req), params, "p");
  const hz = (h: string, expr: string, extra = "") => `${expr} FILTER (WHERE hz = '${h}'${extra ? ` AND ${extra}` : ""})`;
  const { rows } = await pool.query<any>(`
    SELECT p.id,
           COALESCE(s.n, 0)::int        AS "tradeCount",
           COALESCE(s.wins, 0)::int     AS "wins",
           COALESCE(s.losses, 0)::int   AS "losses",
           COALESCE(s.be, 0)::int       AS "be",
           COALESCE(s.open_n, 0)::int   AS "open",
           COALESCE(s.r_count, 0)::int  AS "rCount",
           s.avg_r                      AS "avgR",
           s.pos_r, s.neg_r,
           s.net_pnl                    AS "netPnl",
           s.gross_pnl                  AS "grossPnl",
           COALESCE(s.pnl_count, 0)::int AS "pnlCount",
           s.recent_avg_r               AS "recentAvgR",
           COALESCE(s.recent_r_count, 0)::int AS "recentRCount",
           s.last_trade_date            AS "lastTradeDate",
           s.last_trade_at              AS "lastTradeAt",
           s.hz_json                    AS "byHorizon",
           r.last_run_at                AS "lastRunAt",
           m.last_mark_at               AS "lastMarkAt",
           rv.verdict                   AS "reviewVerdict",
           COALESCE(i.n, 0)::int        AS "ideaCount",
           COALESCE(ex.n, 0)::int       AS "exampleCount",
           COALESCE(ex.t1, 0)::int      AS "tier1Count",
           s.pos_usd, s.neg_usd,
           COALESCE(s.pos_n, 0)::int    AS pos_n,
           COALESCE(s.neg_n, 0)::int    AS neg_n,
           COALESCE(c.n, 0)::int        AS "childCount",
           COALESCE(s.foreign_n, 0)::int AS foreign_n
    FROM playbook p
    LEFT JOIN (
      SELECT playbook_id,
             COUNT(*) AS n,
             COUNT(*) FILTER (WHERE res = 'win') AS wins,
             COUNT(*) FILTER (WHERE res = 'loss') AS losses,
             COUNT(*) FILTER (WHERE res = 'be') AS be,
             COUNT(*) FILTER (WHERE res = 'open') AS open_n,
             COUNT(sr) AS r_count,
             AVG(sr) AS avg_r,
             COALESCE(SUM(sr) FILTER (WHERE sr > 0), 0) AS pos_r,
             COALESCE(SUM(sr) FILTER (WHERE sr < 0), 0) AS neg_r,
             SUM(np) AS net_pnl,
             SUM(pnl) AS gross_pnl,
             COUNT(pnl) AS pnl_count,
             COALESCE(SUM(np) FILTER (WHERE np > 0 AND res <> 'open'), 0) AS pos_usd,
             COALESCE(SUM(np) FILTER (WHERE np < 0 AND res <> 'open'), 0) AS neg_usd,
             COUNT(*) FILTER (WHERE np > 0 AND res <> 'open') AS pos_n,
             COUNT(*) FILTER (WHERE np < 0 AND res <> 'open') AS neg_n,
             AVG(sr) FILTER (WHERE rn <= ${RECENT_N}) AS recent_avg_r,
             COUNT(sr) FILTER (WHERE rn <= ${RECENT_N}) AS recent_r_count,
             MAX(cd) AS last_trade_date,
             COUNT(*) FILTER (WHERE trader IS DISTINCT FROM $${viewerIdx}::text) AS foreign_n,
             MAX(created_at) AS last_trade_at,
             json_build_object(
               'intraday',  json_build_object('n', ${hz("intraday", "COUNT(*)")}, 'wins', ${hz("intraday", "COUNT(*)", "res = 'win'")}, 'losses', ${hz("intraday", "COUNT(*)", "res = 'loss'")}, 'avgR', ${hz("intraday", "AVG(sr)")}, 'netPnl', ${hz("intraday", "SUM(np)")}),
               'overnight', json_build_object('n', ${hz("overnight", "COUNT(*)")}, 'wins', ${hz("overnight", "COUNT(*)", "res = 'win'")}, 'losses', ${hz("overnight", "COUNT(*)", "res = 'loss'")}, 'avgR', ${hz("overnight", "AVG(sr)")}, 'netPnl', ${hz("overnight", "SUM(np)")}),
               'swing',     json_build_object('n', ${hz("swing", "COUNT(*)")}, 'wins', ${hz("swing", "COUNT(*)", "res = 'win'")}, 'losses', ${hz("swing", "COUNT(*)", "res = 'loss'")}, 'avgR', ${hz("swing", "AVG(sr)")}, 'netPnl', ${hz("swing", "SUM(np)")})
             ) AS hz_json
      FROM (
        SELECT t.playbook_id, t.pnl, t.created_at, t.trader,
               ${resultSql()} AS res, ${signedRSql()} AS sr, ${netPnlSql()} AS np,
               ${horizonSql()} AS hz, ${closeDateSql()} AS cd,
               ROW_NUMBER() OVER (PARTITION BY t.playbook_id ORDER BY ${closeDateSql()} DESC, t.id DESC) AS rn
          FROM trades t
         WHERE t.playbook_id IS NOT NULL AND t.deleted_at IS NULL ${tradeFilter}
      ) x
      GROUP BY playbook_id
    ) s ON s.playbook_id = p.id
    LEFT JOIN (
      SELECT playbook_id, MAX(created_at) AS last_run_at FROM playbook_checklist_runs GROUP BY playbook_id
    ) r ON r.playbook_id = p.id
    LEFT JOIN (
      SELECT playbook_id, MAX(updated_at) AS last_mark_at FROM playbook_checklist_marks GROUP BY playbook_id
    ) m ON m.playbook_id = p.id
    LEFT JOIN LATERAL (SELECT verdict FROM playbook_reviews pr WHERE pr.playbook_id = p.id ORDER BY created_at DESC LIMIT 1) rv ON TRUE
    LEFT JOIN (
      SELECT playbook_id, COUNT(*) AS n FROM trade_ideas
      WHERE playbook_id IS NOT NULL AND deleted_at IS NULL GROUP BY playbook_id
    ) i ON i.playbook_id = p.id
    LEFT JOIN (
      SELECT playbook_id, COUNT(*) AS n, COUNT(*) FILTER (WHERE tier = 1) AS t1 FROM playbook_examples
      WHERE deleted_at IS NULL GROUP BY playbook_id
    ) ex ON ex.playbook_id = p.id
    LEFT JOIN (
      SELECT parent_id, COUNT(*) AS n FROM playbook
      WHERE parent_id IS NOT NULL AND deleted_at IS NULL GROUP BY parent_id
    ) c ON c.parent_id = p.id
    WHERE p.deleted_at IS NULL AND ${vis}
  `, params);
  const r3 = (v: number | null) => (v == null ? null : Number(v.toFixed(3)));
  const r2 = (v: number | null) => (v == null ? null : Number(v.toFixed(2)));
  const shapeHz = (h: any) => {
    const n = Number(h?.n ?? 0), wins = Number(h?.wins ?? 0), losses = Number(h?.losses ?? 0);
    return { n, wins, losses, winrate: wins + losses ? Number((wins / (wins + losses)).toFixed(4)) : null, avgR: r3(numOrNull(h?.avgR)), netPnl: r2(numOrNull(h?.netPnl)) };
  };
  res.json(rows.map((r) => {
    const row = shapeSummaryRow(r);
    // $ only when every linked trade in scope is the viewer's own (or the viewer is staff).
    return mv.staff || Number(r.foreign_n) === 0 ? { ...row, redacted: false } : redactSummaryRow(row);
  }));
  function shapeSummaryRow(r: any) {
    const n = Number(r.tradeCount);
    const wins = Number(r.wins), losses = Number(r.losses);
    const rCount = Number(r.rCount);
    const winrate = wins + losses ? wins / (wins + losses) : null;
    const avgR = numOrNull(r.avgR);
    const posR = numOrNull(r.pos_r) ?? 0, negR = numOrNull(r.neg_r) ?? 0;
    const recentAvgR = numOrNull(r.recentAvgR);
    const recentRCount = Number(r.recentRCount);
    // Edge decay: enough history, and the last 20 trades run clearly below the lifetime expectancy.
    const edgeDecay = rCount >= 30 && recentRCount >= RECENT_N && avgR != null && recentAvgR != null && recentAvgR < avgR - 0.25;
    // $-first metrics (R is null for broker trades without a stop).
    const pnlCount = Number(r.pnlCount);
    const netPnl = numOrNull(r.netPnl);
    const posUsd = numOrNull(r.pos_usd) ?? 0, negUsd = numOrNull(r.neg_usd) ?? 0;
    const posN = Number(r.pos_n), negN = Number(r.neg_n);
    const lastUsedAt = [iso(r.lastTradeAt), iso(r.lastRunAt), iso(r.lastMarkAt)]
      .filter((x): x is string => !!x)
      .sort()
      .pop() ?? null;
    return {
      id: r.id,
      tradeCount: n,
      wins, losses,
      be: Number(r.be),
      open: Number(r.open),
      rCount,
      winrate: winrate != null ? Number(winrate.toFixed(4)) : null,
      avgR: r3(avgR),
      expectancy: r3(avgR),
      profitFactor: negR < 0 ? r2(posR / Math.abs(negR)) : null,
      edgeScore: avgR != null ? edgeScore(avgR, rCount) : null,
      netPnl: r2(numOrNull(r.netPnl)),
      grossPnl: r2(numOrNull(r.grossPnl)),
      /** @deprecated use netPnl */
      totalPnl: r2(numOrNull(r.netPnl)),
      pnlCount,
      expectancyUsd: pnlCount && netPnl != null ? r2(netPnl / pnlCount) : null,
      avgWinUsd: posN ? r2(posUsd / posN) : null,
      avgLossUsd: negN ? r2(negUsd / negN) : null,
      profitFactorUsd: negUsd < 0 ? r2(posUsd / Math.abs(negUsd)) : null,
      recentAvgR: r3(recentAvgR),
      recentRCount,
      edgeDecay,
      byHorizon: {
        intraday: shapeHz(r.byHorizon?.intraday),
        overnight: shapeHz(r.byHorizon?.overnight),
        swing: shapeHz(r.byHorizon?.swing),
      },
      reviewVerdict: r.reviewVerdict ?? null,
      lastTradeDate: r.lastTradeDate ?? null,
      lastTradeAt: iso(r.lastTradeAt),
      lastRunAt: iso(r.lastRunAt),
      lastUsedAt,
      exampleCount: Number(r.exampleCount),
      tier1Count: Number(r.tier1Count),
      ideaCount: Number(r.ideaCount),
      childCount: Number(r.childCount),
    };
  }
}));

/**
 * Trades not linked to a setup whose free-text `setup` matches a playbook name (or ticker-specific setup).
 * Lets the journal auto-link broker-imported round trips to the trader's playbook.
 */
router.get("/playbook/unlinked-suggestions", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const scope = await tradeScope(req, res);
  if (scope === undefined) return;
  const params: unknown[] = [];
  let traderFilter = "";
  if (scope) { params.push(scope); traderFilter = `AND t.trader = $1`; }
  const { rows } = await pool.query<any>(`
    SELECT t.id AS "tradeId", t.ticker, t.date, t.trader, t.setup, t.source,
           p.id AS "playbookId", p.name AS "playbookName"
      FROM trades t
      JOIN playbook p ON p.deleted_at IS NULL
           AND LOWER(TRIM(p.name)) = LOWER(TRIM(t.setup))
           AND (${spaceSql("p")} = 'office' OR p.trader = t.trader)
     WHERE t.deleted_at IS NULL AND t.playbook_id IS NULL AND NULLIF(TRIM(t.setup), '') IS NOT NULL ${traderFilter}
     ORDER BY t.date DESC, t.id DESC
     LIMIT 200
  `, params);
  res.json(rows);
}));

/** Apply suggestions: links each trade (own trades for traders; any for staff) to the matching setup. */
router.post("/playbook/auto-link", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const auth = req.authUser!;
  const staff = await can(req, "playbook.edit.any");
  const body = req.body as { tradeIds?: unknown };
  const ids = Array.isArray(body?.tradeIds) ? body.tradeIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : null;
  const params: unknown[] = [];
  const where: string[] = [`t.deleted_at IS NULL`, `t.playbook_id IS NULL`, `NULLIF(TRIM(t.setup), '') IS NOT NULL`];
  if (!staff) { params.push(auth.name); where.push(`t.trader = $${params.length}`); }
  if (ids) { params.push(ids); where.push(`t.id = ANY($${params.length}::int[])`); }
  const { rowCount } = await pool.query(`
    UPDATE trades t SET playbook_id = p.id
      FROM playbook p
     WHERE p.deleted_at IS NULL AND LOWER(TRIM(p.name)) = LOWER(TRIM(t.setup)) AND (${spaceSql("p")} = 'office' OR p.trader = t.trader)
       AND ${where.join(" AND ")}
  `, params);
  if (rowCount) await logActivity({ action: "updated", section: "playbook", entityTitle: activityTitle("autolink"), trader: auth.name, details: activityDetails("autolinked", { count: rowCount }), params: { titleKey: "autolink", detailsKey: "autolinked", count: rowCount } });
  res.json({ success: true, linked: rowCount ?? 0 });
}));

router.patch("/playbook/rename-folder", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const { from: fromRaw, to: toRaw, merge, space } = req.body as { from?: unknown; to?: unknown; merge?: unknown; space?: unknown };
  // space: 'personal' renames the caller's own folder in «Мой»; otherwise the «Офис» folder (curators).
  const personal = space === "personal";
  if (personal) {
    if (!(await requireCap(req, res, "playbook.edit", { trader: req.authUser?.name ?? "" }))) return;
  } else if (!(await requireStaffOr403(req, res))) return;
  const actor = req.authUser!.name;
  const scopeParams: unknown[] = personal ? [actor] : [];
  const scopeWhere = personal ? `AND ${spaceSql("playbook")} = 'personal' AND trader = $3` : `AND ${spaceSql("playbook")} = 'office'`;
  const fromName = typeof fromRaw === "string" ? fromRaw : "";
  const toName = typeof toRaw === "string" ? toRaw.trim() : "";
  if (!fromName || !toName) throw new AppError("INVALID_RANGE", undefined, { max: 400 });
  if (toName.length > 120) throw new AppError("TEXT_TOO_LONG", undefined, { field: "folder", max: 80 });
  if (toName === fromName) { res.json({ success: true, moved: 0, merged: false }); return; }
  // Renaming onto an existing folder used to merge the two silently. Now it's an explicit choice (merge: true).
  const { rows: existing } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM playbook WHERE folder = $1 AND deleted_at IS NULL AND $2::int IS NULL ${scopeWhere}`,
    [toName, null, ...scopeParams],
  );
  const targetCount = existing[0]?.n ?? 0;
  if (targetCount > 0 && merge !== true) {
    sendErrorWith(res, new AppError("FOLDER_EXISTS", 409, { folder: toName, count: targetCount }), { targetCount });
    return;
  }
  const { rowCount } = await pool.query(`UPDATE playbook SET folder = $1 WHERE folder = $2 ${scopeWhere}`, [toName, fromName, ...scopeParams]);
  // folder_name is unique: on merge keep the target's settings and drop ours (the old UPDATE would 500 here).
  const { rows: targetSettings } = personal ? { rows: [] as unknown[] } : await pool.query(`SELECT 1 FROM playbook_folder_settings WHERE folder_name = $1`, [toName]);
  if (personal) {
    // Folder colours are keyed by name and shared; a personal rename leaves them alone.
  } else if (targetSettings.length) {
    await pool.query(`DELETE FROM playbook_folder_settings WHERE folder_name = $1`, [fromName]);
  } else {
    await pool.query(
      `UPDATE playbook_folder_settings SET folder_name = $1, updated_at = NOW() WHERE folder_name = $2`,
      [toName, fromName]
    );
  }
  const folderKey = targetCount > 0 ? "folderMerged" : "folderRenamed";
  await logActivity({ action: "updated", section: "playbook", entityTitle: fromName, trader: actor, details: activityDetails(folderKey, { from: fromName, to: toName }), params: { detailsKey: folderKey, from: fromName, to: toName } });
  res.json({ success: true, moved: rowCount ?? 0, merged: targetCount > 0 });
}));

/** Curator review: flag + verdict history (approved | needs_work | retired). */
const VERDICTS = new Set(["approved", "needs_work", "retired"]);

router.post("/playbook/:id/reviewed", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!(await requireStaffOr403(req, res))) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const reviewer = req.authUser!.name;
  const { reviewed, verdict, comment } = req.body as { reviewed?: unknown; verdict?: unknown; comment?: unknown };
  const v = typeof verdict === "string" && VERDICTS.has(verdict) ? verdict : null;
  if (verdict !== undefined && verdict !== null && !v) throw new AppError("INVALID_FIELD", undefined, { field: "verdict" });
  const flag = typeof reviewed === "boolean" ? reviewed : v != null ? v === "approved" : null;
  if (flag == null && !v) throw new AppError("FIELD_REQUIRED", undefined, { field: "reviewed / verdict" });
  const { rows } = await pool.query<any>(`SELECT name FROM playbook WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound();
  if (flag != null) {
    await pool.query(
      `UPDATE playbook SET reviewed = $1, reviewed_by = $2, reviewed_at = $3 WHERE id = $4`,
      [flag, flag ? reviewer : null, flag ? new Date() : null, id]
    );
  }
  if (v) {
    await pool.query(
      `INSERT INTO playbook_reviews (playbook_id, reviewer, verdict, comment) VALUES ($1, $2, $3, $4)`,
      [id, reviewer, v, typeof comment === "string" && comment.trim() ? comment.trim().slice(0, 2000) : null],
    );
  }
  const labelKey = v === "approved" ? "verdictApproved" : v === "needs_work" ? "verdictNeedsWork" : v === "retired" ? "verdictRetired" : flag ? "reviewed" : "unreviewed";
  await logActivity({ action: "updated", section: "playbook", entityId: String(id), entityTitle: rows[0].name, trader: reviewer, details: activityDetails(labelKey), params: { detailsKey: labelKey } });
  res.json({ success: true, reviewed: flag ?? undefined, verdict: v });
}));

router.get("/playbook/:id/reviews", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const id = Number(req.params.id);
  if (!(await requireSetupReader(req, res, id))) return;
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const { rows } = await pool.query<any>(
    `SELECT id, playbook_id AS "playbookId", reviewer, verdict, comment, created_at AS "createdAt"
       FROM playbook_reviews WHERE playbook_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [id],
  );
  res.json(rows);
}));

router.get("/playbook/folder-settings", asyncHandler(async (_req, res): Promise<void> => {
  const { rows } = await pool.query<{ folder_name: string; color_index: number | null; sort_order: number }>(
    `SELECT folder_name, color_index, sort_order FROM playbook_folder_settings ORDER BY sort_order ASC`
  );
  res.json(rows.map(r => ({ folderName: r.folder_name, colorIndex: r.color_index, sortOrder: r.sort_order })));
}));

/** One row of PATCH /playbook/folder-settings; null fields = «leave as is». Exported for tests. */
export function parseFolderSettingUpdates(body: unknown): { folderName: string; colorIndex: number | null; sortOrder: number | null }[] | null {
  if (!Array.isArray(body) || body.length === 0 || body.length > 500) return null;
  const out: { folderName: string; colorIndex: number | null; sortOrder: number | null }[] = [];
  for (const raw of body) {
    if (!raw || typeof raw !== "object") continue;
    const u = raw as Record<string, unknown>;
    const folderName = typeof u.folderName === "string" ? u.folderName.trim().slice(0, 200) : "";
    if (!folderName) continue;
    const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100_000 ? v : null);
    out.push({ folderName, colorIndex: int(u.colorIndex), sortOrder: int(u.sortOrder) });
  }
  return out;
}

// Folder order / colours are desk-wide (the office library's folders): only staff change them. A field that is not
// sent keeps its value — an update without `sortOrder` used to write 0 and jump the folder to the top.
router.patch("/playbook/folder-settings", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaffOr403(req, res))) return;
  const updates = parseFolderSettingUpdates(req.body);
  if (!updates) throw new AppError("VALIDATION");
  for (const u of updates) {
    await pool.query(
      `INSERT INTO playbook_folder_settings (folder_name, color_index, sort_order, updated_at)
       VALUES ($1, $2, COALESCE($3::int, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM playbook_folder_settings)), NOW())
       ON CONFLICT (folder_name) DO UPDATE
       SET color_index = COALESCE($2, playbook_folder_settings.color_index),
           sort_order  = COALESCE($3::int, playbook_folder_settings.sort_order),
           updated_at  = NOW()`,
      [u.folderName, u.colorIndex, u.sortOrder]
    );
  }
  res.json({ success: true });
}));

router.delete("/playbook/delete-folder", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!(await requireStaffOr403(req, res))) return;
  const actor = req.authUser!.name;
  const { folder, password } = req.body as { folder: string; password?: string };
  if (!folder) throw new AppError("FIELD_REQUIRED", undefined, { field: "folder" });
  const expected = config.playbookPassword;
  if (!expected) throw new AppError("NOT_CONFIGURED", 500, { what: "PLAYBOOK_PASSWORD" });
  if (password !== expected) throw new AppError("WRONG_PASSWORD");
  const { rowCount } = await pool.query(
    `UPDATE playbook SET deleted_at = NOW() WHERE folder = $1 AND deleted_at IS NULL AND ${spaceSql("playbook")} = 'office'`,
    [folder]
  );
  await logActivity({ action: "deleted", section: "playbook", entityTitle: folder, trader: actor, details: activityDetails("folderDeleted", { count: rowCount ?? 0 }), params: { detailsKey: "folderDeleted", count: rowCount ?? 0 } });
  res.json({ success: true, deleted: rowCount });
}));

router.post("/playbook", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const auth = req.authUser!;
  if (isGuest(req)) throw new AppError("GUEST_READ_ONLY");
  const v = await loadViewer(req);
  const staff = v.editAny;
  const body = req.body as Record<string, unknown>;
  const { name, folder, setupType, conditions, checklist, checklistItems, notes, confidenceLevel, screenshotUrl, screenshotNotes, screenshots, tags, sourceType, sourceId, parentId, trader, ticker, marketCap, float: floatVal, adv, atr, relativeVolume, beta, shortInterest, sector, longName } = body;
  if (!name) throw new AppError("NAME_REQUIRED_GENERIC");
  // Space: explicit body.space wins. Legacy callers: staff with trader null → «Офис»; everyone else → «Мой».
  const requestedSpace = body.space === "office" || body.space === "personal" ? body.space : null;
  const space = requestedSpace ?? (staff && trader === null ? "office" : "personal");
  if (space === "office" && !staff) throw new AppError("OFFICE_PLAYBOOK_STAFF_ONLY");
  if (space === "personal" && !v.editOwn && !staff) throw new AppError("FORBIDDEN");
  // Identity comes from the session: office setups have no owner (author kept in created_by); a personal setup belongs
  // to the caller — staff may file one for a trader.
  const owner = space === "office" ? null : staff && typeof trader === "string" && trader.trim() ? trader.trim() : auth.name;
  const horizon = typeof body.horizon === "string" && HORIZONS.has(body.horizon) ? body.horizon : null;
  let items = normChecklistItems(checklistItems);
  if (!items && checklist) items = itemsFromChecklistText(String(checklist));
  const finalChecklistText = items && items.length ? checklistItemsToText(items) : (checklist ? String(checklist) : null);
  const finalChecklistJson = items && items.length ? JSON.stringify(items) : null;
  const screens = normScreenshots(screenshots);
  const legacy = screens ? screenshotsToLegacy(screens) : { url: sanitizeMultiLineUrls(screenshotUrl as string | null | undefined), notes: screenshotNotes ? String(screenshotNotes) : null };
  const { rows } = await pool.query<any>(
    `INSERT INTO playbook (name, folder, setup_type, conditions, checklist, checklist_items, notes, confidence_level, screenshot_url, screenshot_notes, screenshots, tags, source_type, source_id, parent_id, trader, ticker, market_cap, float, adv, atr, relative_volume, beta, short_interest, sector, long_name)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
     RETURNING ${PLAYBOOK_SELECT_FIELDS}`,
    [
      String(name),
      folder ? String(folder) : null,
      setupType ? String(setupType) : null,
      conditions ? String(conditions) : null,
      finalChecklistText,
      finalChecklistJson,
      notes ? String(notes) : null,
      confidenceLevel ? Number(confidenceLevel) : null,
      legacy.url,
      legacy.notes,
      screens ? JSON.stringify(screens) : null,
      tags ? String(tags) : null,
      sourceType ? String(sourceType) : null,
      sourceId ? Number(sourceId) : null,
      parentId ? Number(parentId) : null,
      owner,
      ticker ? String(ticker).toUpperCase() : null,
      marketCap ? String(marketCap) : null,
      floatVal ? String(floatVal) : null,
      adv ? String(adv) : null,
      atr ? Number(atr) : null,
      relativeVolume ? Number(relativeVolume) : null,
      beta ? Number(beta) : null,
      shortInterest ? Number(shortInterest) : null,
      sector ? String(sector) : null,
      longName ? String(longName) : null,
    ]
  );
  let row = rows[0];
  // Space / structured card (separate UPDATE keeps the legacy INSERT column list intact).
  const sets = [`space = $2`, `visibility = 'private'`, `created_by = $3`, `horizon = $4`, `updated_at = NOW()`];
  const vals: unknown[] = [row.id, space, auth.name, horizon];
  for (const [key, col] of STRUCTURED_FIELDS) {
    if (body[key] === undefined) continue;
    vals.push(textOrNull(body[key]));
    sets.push(`${col} = $${vals.length}`);
  }
  const copiedFrom = Number(body.copiedFromId);
  if (Number.isInteger(copiedFrom) && copiedFrom > 0) {
    vals.push(copiedFrom, textOrNull(body.copiedFromAuthor, 120));
    sets.push(`copied_from_id = $${vals.length - 1}`, `copied_from_author = $${vals.length}`);
  }
  const upd = await pool.query<any>(`UPDATE playbook SET ${sets.join(", ")} WHERE id = $1 RETURNING ${PLAYBOOK_SELECT_FIELDS}`, vals);
  row = upd.rows[0] ?? row;
  await logActivity({ action: "created", section: "playbook", entityId: String(row.id), entityTitle: String(name), trader: auth.name, ...(() => { const k = `created${space === "office" ? "Office" : "Mine"}${folder ? "Folder" : ""}`; return { details: activityDetails(k, folder ? { folder: String(folder) } : {}), params: { detailsKey: k, ...(folder ? { folder: String(folder) } : {}) } }; })() });
  res.json({ ...row, access: accessHints(v, row) });
}));

router.patch("/playbook/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const id = Number(req.params.id);
  const auth = req.authUser!;
  // `trader` is NOT read here: editors send the whole form (owner included), and for staff that silently took over a
  // trader's personal setup. Re-assigning the owner needs the explicit `reassignTo` (staff, personal setups only).
  const { name, folder, setupType, conditions, checklist, checklistItems, notes, confidenceLevel, screenshotUrl, screenshotNotes, screenshots, tags, parentId, reassignTo, ticker, marketCap, float: floatVal, adv, atr, relativeVolume, beta, shortInterest, sector, longName } = req.body as Record<string, unknown>;

  const { rows: prevRows } = await pool.query<any>(`SELECT ${PLAYBOOK_SELECT_FIELDS} FROM playbook WHERE id = $1`, [id]);
  if (!prevRows[0]) throw notFound();
  const v = await loadViewer(req);
  if (!canReadPure(v, prevRows[0])) throw notFound();
  if (!(await canEditSetup(req, prevRows[0]))) {
    throw new AppError(prevRows[0].space === "office" ? "OFFICE_PLAYBOOK_STAFF_EDIT" : "SETUP_EDITOR_ONLY");
  }
  const staff = v.editAny;
  const body = req.body as Record<string, unknown>;
  // Autosave sends many small PATCHes: keep one snapshot per editor per 10-minute session (the state before it).
  await pool.query(
    `INSERT INTO playbook_revisions (playbook_id, trader, snapshot)
     SELECT $1, $2, $3::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM playbook_revisions WHERE playbook_id = $1 AND trader = $2 AND created_at > NOW() - INTERVAL '10 minutes')`,
    [id, auth.name, JSON.stringify(prevRows[0])]
  ).catch(() => {});

  const fields: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); vals.push(name ? String(name) : null); }
  if (folder !== undefined) { fields.push(`folder = $${i++}`); vals.push(folder ? String(folder) : null); }
  if (setupType !== undefined) { fields.push(`setup_type = $${i++}`); vals.push(setupType ? String(setupType) : null); }
  if (conditions !== undefined) { fields.push(`conditions = $${i++}`); vals.push(conditions ? String(conditions) : null); }
  if (checklistItems !== undefined) {
    const items = normChecklistItems(checklistItems) ?? [];
    fields.push(`checklist_items = $${i++}::jsonb`); vals.push(items.length ? JSON.stringify(items) : null);
    fields.push(`checklist = $${i++}`); vals.push(items.length ? checklistItemsToText(items) : null);
  } else if (checklist !== undefined) {
    const items = checklist ? itemsFromChecklistText(String(checklist)) : [];
    fields.push(`checklist = $${i++}`); vals.push(checklist ? String(checklist) : null);
    fields.push(`checklist_items = $${i++}::jsonb`); vals.push(items.length ? JSON.stringify(items) : null);
  }
  if (notes !== undefined) { fields.push(`notes = $${i++}`); vals.push(notes ? String(notes) : null); }
  if (confidenceLevel !== undefined) { fields.push(`confidence_level = $${i++}`); vals.push(confidenceLevel ? Number(confidenceLevel) : null); }
  if (screenshots !== undefined) {
    const items = normScreenshots(screenshots) ?? [];
    const legacy = screenshotsToLegacy(items);
    fields.push(`screenshots = $${i++}::jsonb`); vals.push(items.length ? JSON.stringify(items) : null);
    fields.push(`screenshot_url = $${i++}`); vals.push(legacy.url);
    fields.push(`screenshot_notes = $${i++}`); vals.push(legacy.notes);
  } else {
    if (screenshotUrl !== undefined) { fields.push(`screenshot_url = $${i++}`); vals.push(sanitizeMultiLineUrls(screenshotUrl as string | null | undefined)); }
    if (screenshotNotes !== undefined) { fields.push(`screenshot_notes = $${i++}`); vals.push(screenshotNotes ? String(screenshotNotes) : null); }
  }
  if (tags !== undefined) { fields.push(`tags = $${i++}`); vals.push(tags ? String(tags) : null); }
  if (parentId !== undefined) { fields.push(`parent_id = $${i++}`); vals.push(parentId ? Number(parentId) : null); }
  // Reassigning authorship of a personal setup is a curator action (explicit `reassignTo`); traders get 403.
  // Office setups stay ownerless (moving between spaces = copy / promote endpoints).
  const newOwner = typeof reassignTo === "string" ? reassignTo.trim().slice(0, 120) : "";
  if (reassignTo !== undefined) {
    if (!staff) throw new AppError("STAFF_ONLY");
    if (prevRows[0].space !== "personal") throw new AppError("OFFICE_SETUP_NO_AUTHOR");
    if (!newOwner) throw new AppError("TRADER_REQUIRED");
    const { rowCount } = await pool.query(`SELECT 1 FROM users WHERE name = $1`, [newOwner]);
    if (!rowCount) throw new AppError("TRADER_NOT_FOUND", 400);
    fields.push(`trader = $${i++}`); vals.push(newOwner);
  }
  for (const [key, col] of STRUCTURED_FIELDS) {
    if (body[key] === undefined) continue;
    fields.push(`${col} = $${i++}`); vals.push(textOrNull(body[key]));
  }
  if (body.horizon !== undefined) {
    fields.push(`horizon = $${i++}`); vals.push(typeof body.horizon === "string" && HORIZONS.has(body.horizon) ? body.horizon : null);
  }
  if (body.media !== undefined) {
    const m = normMedia(body.media) ?? [];
    fields.push(`media = $${i++}::jsonb`); vals.push(m.length ? JSON.stringify(m) : null);
  }
  if (ticker !== undefined) { fields.push(`ticker = $${i++}`); vals.push(ticker ? String(ticker).toUpperCase() : null); }
  if (marketCap !== undefined) { fields.push(`market_cap = $${i++}`); vals.push(marketCap ? String(marketCap) : null); }
  if (floatVal !== undefined) { fields.push(`float = $${i++}`); vals.push(floatVal ? String(floatVal) : null); }
  if (adv !== undefined) { fields.push(`adv = $${i++}`); vals.push(adv ? String(adv) : null); }
  if (atr !== undefined) { fields.push(`atr = $${i++}`); vals.push(atr ? Number(atr) : null); }
  if (relativeVolume !== undefined) { fields.push(`relative_volume = $${i++}`); vals.push(relativeVolume ? Number(relativeVolume) : null); }
  if (beta !== undefined) { fields.push(`beta = $${i++}`); vals.push(beta ? Number(beta) : null); }
  if (shortInterest !== undefined) { fields.push(`short_interest = $${i++}`); vals.push(shortInterest ? Number(shortInterest) : null); }
  if (sector !== undefined) { fields.push(`sector = $${i++}`); vals.push(sector ? String(sector) : null); }
  if (longName !== undefined) { fields.push(`long_name = $${i++}`); vals.push(longName ? String(longName) : null); }
  if (!fields.length) throw badRequest("NO_FIELDS");
  fields.push(`updated_at = NOW()`);
  vals.push(id);
  const { rows } = await pool.query<any>(
    `UPDATE playbook SET ${fields.join(", ")} WHERE id = $${i}
     RETURNING ${PLAYBOOK_SELECT_FIELDS}`,
    vals
  );
  if (!rows[0]) throw notFound();
  await logActivity({ action: "updated", section: "playbook", entityId: String(id), entityTitle: rows[0].name, trader: auth.name, details: activityDetails("setupUpdated"), params: { detailsKey: "setupUpdated" } });
  res.json({ ...rows[0], access: accessHints(v, rows[0]) });
}));

router.get("/playbook/:id/children", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const id = Number(req.params.id);
  if (!(await requireSetupReader(req, res, id))) return;
  const v = await loadViewer(req);
  const params: unknown[] = [id];
  const vis = visibleSql(v, params, "p");
  const { rows } = await pool.query<any>(`
    SELECT ${PLAYBOOK_SELECT_FIELDS}
    FROM playbook p
    WHERE p.parent_id = $1 AND p.deleted_at IS NULL AND ${vis}
    ORDER BY p.created_at DESC
  `, params);
  res.json(rows.map((r) => ({ ...r, access: accessHints(v, r) })));
}));

const EDGE_TRADE_SELECT = `
  SELECT t.id, t.trader, t.result, t.side, t.entry, t.exit, t.stop, t.pnl, t.fees, t.risk_usd AS "riskUsd",
         t.r_multiple AS "rMultiple", t.date, NULLIF(t.exit_date, '') AS "exitDate", t.horizon, t.session,
         t.context_snapshot AS "contextSnapshot", t.setup_score AS "setupScore"
    FROM trades t
`;
function toEdgeTrade(r: any): EdgeTrade {
  return {
    id: r.id, result: r.result, side: r.side, entry: r.entry, exit: r.exit, stop: r.stop, pnl: r.pnl, fees: r.fees,
    riskUsd: r.riskUsd, rMultiple: r.rMultiple, date: r.date, exitDate: r.exitDate, horizon: r.horizon,
    session: r.session ?? null, contextSnapshot: r.contextSnapshot ?? null, setupScore: numOrNull(r.setupScore),
  };
}

router.get("/playbook/:id/edge", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!(await requireSetupReader(req, res, id))) return;
  if (isNaN(id)) throw badRequest("INVALID_ID");
  const scope = await tradeScope(req, res);
  if (scope === undefined) return;
  const params: unknown[] = [id];
  let filter = "";
  if (scope) { params.push(scope); filter = `AND t.trader = $2`; }
  const { rows } = await pool.query<any>(`${EDGE_TRADE_SELECT} WHERE t.playbook_id = $1 AND t.deleted_at IS NULL ${filter}`, params);
  const trades: EdgeTrade[] = rows.map(toEdgeTrade);
  // $ (total / drawdown / fees) only when every trade is the viewer's own or the viewer is staff.
  const showMoney = canSeeAggregateMoney(await loadMoneyViewer(req), rows.map((r) => r.trader as string | null));
  const edgeOf = (list: EdgeTrade[]) => (showMoney ? computeEdge(list) : redactEdgeStats(computeEdge(list)));
  const overall = edgeOf(trades);
  const split = (keyFn: (t: EdgeTrade) => string | null) =>
    Object.fromEntries(Object.entries(bucketBy(trades, keyFn)).map(([k, v]) => [k, edgeOf(v)]));
  const byRegime = split((t) => t.contextSnapshot?.marketRegime ?? null);
  const bySession = split((t) => t.session);
  const byVix = split((t) => {
    const v = t.contextSnapshot?.vix?.level ?? t.contextSnapshot?.vix ?? null;
    return vixBucket(typeof v === "number" ? v : null);
  });
  const byScore = split((t) => scoreBucket(t.setupScore));
  const byHorizon = split((t) => (t.horizon === "overnight" || t.horizon === "swing" ? t.horizon : "intraday"));
  res.json({ trader: scope, redacted: !showMoney, overall, byRegime, bySession, byVix, byScore, byHorizon });
}));

router.post("/playbook/:id/checklist-run", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) throw badRequest("INVALID_ID");
  const auth = req.authUser!;
  const { tradeId: rawTradeId, checkedItems, score, total } = req.body as any;
  if (!Array.isArray(checkedItems) || typeof score !== "number" || typeof total !== "number") throw new AppError("VALIDATION");
  const tradeId = rawTradeId ? Number(rawTradeId) : null;
  if (tradeId) {
    // Writing a setup score onto a trade requires owning that trade (or being staff).
    const own = await canTouchTrade(req, tradeId);
    await pool.query(`DELETE FROM playbook_checklist_runs WHERE playbook_id = $1 AND trade_id = $2`, [id, tradeId]);
    await pool.query(`UPDATE trades SET setup_score = $1 WHERE id = $2`, [score, tradeId]).catch(() => {});
  } else {
    await pool.query(`DELETE FROM playbook_checklist_runs WHERE playbook_id = $1 AND trade_id IS NULL AND trader = $2`, [id, auth.name]);
  }
  const { rows } = await pool.query<any>(
    `INSERT INTO playbook_checklist_runs (playbook_id, trade_id, trader, checked_items, score, total)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING *`,
    [id, tradeId, auth.name, JSON.stringify(checkedItems), score, total]
  );
  res.json({
    ...rows[0],
    score: Number(rows[0].score),
    checkedItems: rows[0].checked_items,
    tradeId: rows[0].trade_id,
    playbookId: rows[0].playbook_id,
    createdAt: rows[0].created_at,
  });
}));

router.get("/playbook/:id/checklist-runs", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!(await requireSetupReader(req, res, id))) return;
  if (isNaN(id)) throw badRequest("INVALID_ID");
  const scope = await tradeScope(req, res);
  if (scope === undefined) return;
  const tradeId = req.query.tradeId ? Number(req.query.tradeId) : null;
  const where: string[] = ["playbook_id = $1"];
  const params: any[] = [id];
  if (scope) { where.push(`trader = $${params.length + 1}`); params.push(scope); }
  if (tradeId) { where.push(`trade_id = $${params.length + 1}`); params.push(tradeId); }
  const { rows } = await pool.query<any>(
    `SELECT id, playbook_id AS "playbookId", trade_id AS "tradeId", trader,
            checked_items AS "checkedItems", score, total, created_at AS "createdAt"
     FROM playbook_checklist_runs WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC LIMIT 50`,
    params
  );
  res.json(rows.map((r) => ({ ...r, score: r.score != null ? Number(r.score) : 0 })));
}));

router.get("/playbook/:id/marks", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!(await requireSetupReader(req, res, id))) return;
  if (isNaN(id)) throw badRequest("INVALID_ID");
  const trader = req.authUser?.name ?? "";
  const { rows } = await pool.query<{ item_id: string; scope: string; trader: string; done: boolean }>(
    `SELECT item_id, scope, trader, done
     FROM playbook_checklist_marks
     WHERE playbook_id = $1 AND (scope = 'shared' OR (scope = 'personal' AND trader = $2))`,
    [id, trader]
  );
  const shared: Record<string, boolean> = {};
  const personal: Record<string, boolean> = {};
  for (const r of rows) {
    if (r.scope === "shared") shared[r.item_id] = r.done;
    else if (r.scope === "personal" && r.trader === trader) personal[r.item_id] = r.done;
  }
  res.json({ shared, personal });
}));

router.put("/playbook/:id/marks/:itemId", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const itemId = String(req.params.itemId);
  if (isNaN(id) || !itemId) throw badRequest("INVALID_ID");
  const { scope, done } = req.body as { scope?: string; done?: boolean };
  if (scope !== "shared" && scope !== "personal") throw new AppError("INVALID_FIELD", undefined, { field: "scope" });
  if (typeof done !== "boolean") throw new AppError("FIELD_REQUIRED", undefined, { field: "done" });
  const sessionTrader = req.authUser?.name ?? "";
  if (scope === "personal" && !sessionTrader) throw new AppError("TRADER_REQUIRED");
  const traderKey = scope === "personal" ? sessionTrader : "";
  await pool.query(
    `INSERT INTO playbook_checklist_marks (playbook_id, item_id, scope, trader, done, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (playbook_id, item_id, scope, trader)
     DO UPDATE SET done = EXCLUDED.done, updated_at = NOW()`,
    [id, itemId, scope, traderKey, done]
  );
  res.json({ ok: true });
}));

router.get("/playbook/:id/revisions", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!(await requireSetupReader(req, res, id))) return;
  if (isNaN(id)) throw badRequest("INVALID_ID");
  const { rows } = await pool.query<any>(
    `SELECT id, playbook_id AS "playbookId", trader, snapshot, created_at AS "createdAt"
     FROM playbook_revisions WHERE playbook_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [id]
  );
  res.json(rows);
}));

// ─── AI (explicit, author/staff only, 1 call per 10 min per setup) ───────────

router.post("/playbook/:id/ai-critique", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const id = Number(req.params.id);
  if (isNaN(id)) throw badRequest("INVALID_ID");
  const { rows: pbRows } = await pool.query<any>(`SELECT ${PLAYBOOK_SELECT_FIELDS} FROM playbook WHERE id = $1`, [id]);
  if (!pbRows[0]) throw notFound();
  const pb = pbRows[0];
  if (!(await canEditSetup(req, pb))) throw new AppError("SETUP_EDITOR_ONLY");
  const scope = await tradeScope(req, res);
  if (scope === undefined) return;
  const left = aiRateLimited(`critique:${id}`);
  if (left > 0) { sendErrorWith(res, new AppError("AI_COOLDOWN", 429, { minutes: Math.ceil(left / 60000) }), { retryAfterMs: left }); return; }
  const params: unknown[] = [id];
  let filter = "";
  if (scope) { params.push(scope); filter = `AND t.trader = $2`; }
  const { rows: trRows } = await pool.query<any>(
    `SELECT t.ticker, t.trader, t.date, t.side, ${resultSql()} AS result, ${netPnlSql()} AS "netPnl", ${signedRSql()} AS "signedR",
            t.relative_volume AS "relativeVolume", t.session, ${horizonSql()} AS horizon,
            t.what_worked AS "whatWorked", t.what_failed AS "whatFailed", t.conclusion, t.notes
       FROM trades t WHERE t.playbook_id = $1 AND t.deleted_at IS NULL ${filter}
       ORDER BY ${closeDateSql()} DESC, t.id DESC LIMIT 20`,
    params,
  );
  // Never hand other traders' $ to the model (its answer is shown to the caller): R and result stay.
  const mvAi = await loadMoneyViewer(req);
  for (const t of trRows) if (!canSeeTradeMoney(mvAi, t.trader)) t.netPnl = null;

  const sys = "You are a senior trading coach reviewing a saved playbook setup against its actual linked trades. Reply in " + aiLanguageEn(langOf(req)) + ". Be terse, factual, structured. No emojis. Identify contradictions between the description/conditions/checklist and what actually happened, missing rules, vague language. End with 1-3 concrete edits to the playbook text.";
  const fmt = (v: unknown, d = 2) => (v == null ? "—" : Number(v).toFixed(d));
  // i18n-ignore-next (AI prompt — model input)
  const usr = `Сетап: ${pb.name}
Тип: ${pb.setupType ?? "—"}
Уверенность: ${pb.confidenceLevel ?? "—"}
Папка: ${pb.folder ?? "—"}
Теги: ${pb.tags ?? "—"}

Условия входа:
${pb.conditions ?? "—"}

Чек-лист:
${pb.checklist ?? "—"}

Заметки:
${pb.notes ?? "—"}

Последние ${trRows.length} трейдов (P&L нетто, R со знаком):
${trRows.map((t: any, i: number) => // i18n-ignore (AI prompt context)
   `${i + 1}. ${t.ticker} ${t.date} ${t.side ?? ""} ${t.result ?? "?"} net=${fmt(t.netPnl, 0)} R=${fmt(t.signedR)} hz=${t.horizon} rVol=${t.relativeVolume ?? "—"} ses=${t.session ?? "—"}${t.whatFailed ? " | fail: " + String(t.whatFailed).slice(0, 80) : ""}${t.conclusion ? " | вывод: " + String(t.conclusion).slice(0, 80) : ""}`).join("\n")}`;

  try {
    const result: any = await anthropic.messages.create({
      model: config.ai.anthropicModel,
      max_tokens: 1500,
      system: sys,
      messages: [{ role: "user", content: usr }],
    });
    const text = Array.isArray(result?.content)
      ? result.content.map((c: any) => c?.text ?? "").join("\n").trim()
      : "";
    res.json({ critique: text, tradesAnalyzed: trRows.length, generatedAt: new Date().toISOString() });
  } catch (e: any) {
    aiLastCall.delete(`critique:${id}`);
    if (handleAiNotConfigured(e, res)) return; // 503 ai_not_configured (audit P2-3)
    sendError(res, new AppError("AI_UNAVAILABLE", 500));
  }
}));

router.post("/playbook/:id/generate-checklist", requireAuth, asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) throw badRequest("INVALID_ID");
  await ensureTables();
  const { rows } = await pool.query<any>(`SELECT name, trader, space, setup_type AS "setupType", conditions, notes, checklist FROM playbook WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound();
  const pb = rows[0];
  if (!(await canEditSetup(req, pb))) throw new AppError("SETUP_EDITOR_ONLY");
  const body = req.body as Record<string, unknown>;
  const conditions = (body.conditions && typeof body.conditions === "string" ? body.conditions : pb.conditions) ?? "";
  const notes = (body.notes && typeof body.notes === "string" ? body.notes : pb.notes) ?? "";
  if (!conditions && !notes) throw new AppError("SETUP_TEXT_REQUIRED");
  const left = aiRateLimited(`checklist:${id}`);
  if (left > 0) { sendErrorWith(res, new AppError("AI_COOLDOWN", 429, { minutes: Math.ceil(left / 60000) }), { retryAfterMs: left }); return; }
  const sys = "You generate concise pre-trade checklists in " + aiLanguageEn(langOf(req)) + " for a day-trading playbook setup. Return ONLY a plain text list of 6-12 short imperative items, one per line, no numbering, no bullets, no comments, no preamble, no markdown. Each item must be verifiable before taking the trade. No emojis.";
  // i18n-ignore-next (AI prompt — model input)
  const usr = `Сетап: ${pb.name}
Тип: ${pb.setupType ?? "—"}

Условия входа:
${conditions || "—"}

Заметки:
${notes || "—"}

${pb.checklist ? /* i18n-ignore (AI prompt) */ `Текущий чек-лист (улучши, не дублируй):\n${pb.checklist}` : ""}`;
  try {
    const result: any = await anthropic.messages.create({
      model: config.ai.anthropicModel,
      max_tokens: 800,
      system: sys,
      messages: [{ role: "user", content: usr }],
    });
    const text = Array.isArray(result?.content)
      ? result.content.map((c: any) => c?.text ?? "").join("\n").trim()
      : "";
    const cleaned = text
      .split("\n")
      .map((l: string) => l.replace(/^[\s\-\*•\d\.\)]+/, "").trim())
      .filter((l: string) => l.length > 0)
      .join("\n");
    res.json({ checklist: cleaned });
  } catch (e: any) {
    aiLastCall.delete(`checklist:${id}`);
    if (handleAiNotConfigured(e, res)) return; // 503 ai_not_configured (audit P2-3)
    sendError(res, new AppError("GENERATION_FAILED", 500));
  }
}));

router.delete("/playbook/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const row = await requireSetupEditor(req, res, id);
  if (!row) return;
  const actor = req.authUser!.name;
  await pool.query(`UPDATE playbook SET deleted_at = NOW() WHERE id = $1`, [id]);
  await logActivity({ action: "deleted", section: "playbook", entityId: String(id), entityTitle: row.name ?? `#${id}`, trader: actor, details: row.folder ? activityDetails("folder", { folder: row.folder }) : undefined, params: row.folder ? { detailsKey: "folder", folder: row.folder } : undefined });
  res.json({ success: true });
}));

router.post("/playbook/:id/restore", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const row = await requireSetupEditor(req, res, id, true);
  if (!row) return;
  const actor = req.authUser!.name;
  await pool.query(`UPDATE playbook SET deleted_at = NULL WHERE id = $1`, [id]);
  await logActivity({ action: "created", section: "playbook", entityId: String(id), entityTitle: row.name ?? `#${id}`, trader: actor, details: activityDetails("restored"), params: { detailsKey: "restored" } });
  res.json({ success: true });
}));

// ─── Linked trades ───────────────────────────────────────────────────────────

const LINKED_TRADE_SELECT = `
  SELECT t.id, t.ticker, t.date, NULLIF(t.exit_date, '') AS "exitDate", ${closeDateSql()} AS "closeDate",
         t.side, t.result, t.setup, t.entry, t.exit, t.stop, t.qty, t.pnl, t.fees, t.risk_usd AS "riskUsd",
         t.r_multiple AS "rMultiple", ${signedRSql()} AS "signedR", ${netPnlSql()} AS "netPnl",
         t.slippage, t.relative_volume AS "relativeVolume", ${horizonSql()} AS horizon, t.session, t.trader,
         t.source, t.external_id AS "externalId", t.broker_account AS "brokerAccount", t.synced_at AS "syncedAt",
         t.setup_score AS "setupScore", t.playbook_id AS "playbookId", t.created_at AS "createdAt"
    FROM trades t
`;
function shapeLinkedTrade(t: any) {
  return {
    ...t,
    entry: numOrNull(t.entry),
    exit: numOrNull(t.exit),
    stop: numOrNull(t.stop),
    qty: numOrNull(t.qty),
    pnl: numOrNull(t.pnl),
    fees: numOrNull(t.fees),
    riskUsd: numOrNull(t.riskUsd),
    rMultiple: numOrNull(t.rMultiple),
    signedR: numOrNull(t.signedR),
    netPnl: numOrNull(t.netPnl),
    slippage: numOrNull(t.slippage),
    relativeVolume: numOrNull(t.relativeVolume),
    setupScore: numOrNull(t.setupScore),
    source: t.source === "propreports" || t.source === "manual" ? t.source : null,
    syncedAt: iso(t.syncedAt),
    createdAt: iso(t.createdAt),
  };
}

router.get("/playbook/trades/bulk", asyncHandler(async (req, res): Promise<void> => {
  const idsParam = req.query.ids;
  if (!idsParam || typeof idsParam !== "string") { res.json([]); return; }
  const ids = idsParam.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) { res.json([]); return; }
  const scope = await tradeScope(req, res);
  if (scope === undefined) return;
  const params: unknown[] = [ids];
  let filter = "";
  if (scope) { params.push(scope); filter = `AND t.trader = $2`; }
  const { rows } = await pool.query<any>(
    `${LINKED_TRADE_SELECT} WHERE t.playbook_id = ANY($1) AND t.deleted_at IS NULL ${filter} ORDER BY ${closeDateSql()} DESC, t.id DESC`,
    params
  );
  const mv = await loadMoneyViewer(req);
  const grouped: Record<number, any[]> = {};
  for (const id of ids) grouped[id] = [];
  for (const t of rows) {
    const pid = t.playbookId;
    if (grouped[pid]) grouped[pid].push(redactTradeRow(shapeLinkedTrade(t), mv));
  }
  res.json(Object.entries(grouped).map(([entryId, trades]) => ({ entryId: Number(entryId), trades })));
}));

router.get("/playbook/:id/trades", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!(await requireSetupReader(req, res, id))) return;
  if (isNaN(id)) throw badRequest("INVALID_ID");
  const scope = await tradeScope(req, res);
  if (scope === undefined) return;
  const params: unknown[] = [id];
  let filter = "";
  if (scope) { params.push(scope); filter = `AND t.trader = $2`; }
  const { rows } = await pool.query<any>(
    `${LINKED_TRADE_SELECT} WHERE t.playbook_id = $1 AND t.deleted_at IS NULL ${filter} ORDER BY ${closeDateSql()} DESC, t.id DESC`,
    params
  );
  const mv = await loadMoneyViewer(req);
  res.json(rows.map((t) => redactTradeRow(shapeLinkedTrade(t), mv)));
}));

router.post("/playbook/:id/link-trade", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { tradeId } = req.body as { tradeId: number };
  if (isNaN(id) || !tradeId) throw new AppError("VALIDATION");
  const pb = await loadSetupAccess(id);
  if (!pb || !canReadPure(await loadViewer(req), pb)) throw new AppError("SETUP_NOT_FOUND");
  const own = await canTouchTrade(req, Number(tradeId));
  await pool.query(`UPDATE trades SET playbook_id = $1 WHERE id = $2`, [id, Number(tradeId)]);
  res.json({ success: true });
}));

router.delete("/playbook/:id/link-trade/:tradeId", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const tradeId = Number(req.params.tradeId);
  if (isNaN(tradeId)) throw badRequest("INVALID_ID");
  const own = await canTouchTrade(req, tradeId);
  await pool.query(`UPDATE trades SET playbook_id = NULL WHERE id = $1 AND ($2::int IS NULL OR playbook_id = $2)`, [tradeId, Number.isInteger(id) ? id : null]);
  res.json({ success: true });
}));

// ─── Examples (trade ideas attached to a setup) ──────────────────────────────

const EXAMPLE_STATUSES = ["watching", "worked", "partial", "failed", "studying"];

const PLAYBOOK_IDEA_SELECT = `
  id, ticker, side, entry_zone, target, stop, status, notes,
  idea_date AS date,
  market_cap, float, adv, atr, relative_volume, beta, short_interest, sector, long_name,
  playbook_id AS playbook_entry_id,
  created_at AS "createdAt"
`;

router.get("/playbook/:id/ideas", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!(await requireSetupReader(req, res, id))) return;
  if (isNaN(id)) throw badRequest("INVALID_ID");
  const { rows } = await pool.query<any>(
    `SELECT ${PLAYBOOK_IDEA_SELECT} FROM trade_ideas
     WHERE playbook_id = $1 AND deleted_at IS NULL AND status = ANY($2)
     ORDER BY created_at DESC`,
    [id, EXAMPLE_STATUSES]
  );
  res.json(rows);
}));

router.post("/playbook/:id/ideas", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const setup = await requireSetupEditor(req, res, id);
  if (!setup) return;
  const b = req.body as Record<string, unknown>;
  const { ticker, side, entryZone, target, stop, status, notes, date } = b;
  if (!ticker) throw badRequest("TICKER_REQUIRED");
  const n = (v: unknown) => (v !== undefined && v !== null && v !== "" ? String(v) : null);
  const { rows } = await pool.query<any>(
    `INSERT INTO trade_ideas
      (playbook_id, ticker, side, entry_zone, target, stop, status, notes, idea_date,
       market_cap, float, adv, atr, relative_volume, beta, short_interest, sector, long_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING ${PLAYBOOK_IDEA_SELECT}`,
    [id, String(ticker).toUpperCase(), side ?? null, entryZone ?? null, target ?? null, stop ?? null, status ?? "watching", notes ?? null, date ?? null,
     n(b.marketCap), n(b.float), n(b.adv), n(b.atr), n(b.relativeVolume), n(b.beta), n(b.shortInterest), n(b.sector), n(b.longName)]
  );
  await logActivity({ action: "created", section: "playbook", entityId: String(id), entityTitle: activityTitle("example", { ticker: rows[0].ticker }), trader: req.authUser!.name, params: { titleKey: "example", ticker: rows[0].ticker } });
  res.json(rows[0]);
}));

router.patch("/playbook/:id/ideas/:ideaId", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const ideaId = Number(req.params.ideaId);
  if (isNaN(ideaId) || isNaN(id)) throw badRequest("INVALID_ID");
  const setup = await requireSetupEditor(req, res, id);
  if (!setup) return;
  const b = req.body as Record<string, unknown>;
  const n = (v: unknown) => (v !== undefined && v !== null && v !== "" ? String(v) : null);
  // Only touch columns present in the body — a partial PATCH (e.g. status cycle) must not wipe other fields.
  const cols: [string, string, (v: unknown) => unknown][] = [
    ["ticker", "ticker", (v) => (v ? String(v).toUpperCase() : null)],
    ["side", "side", n], ["entryZone", "entry_zone", n], ["target", "target", n], ["stop", "stop", n],
    ["status", "status", n], ["notes", "notes", n], ["date", "idea_date", n],
    ["marketCap", "market_cap", n], ["float", "float", n], ["adv", "adv", n], ["atr", "atr", n],
    ["relativeVolume", "relative_volume", n], ["beta", "beta", n], ["shortInterest", "short_interest", n],
    ["sector", "sector", n], ["longName", "long_name", n],
  ];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, col, conv] of cols) {
    if (b[key] === undefined) continue;
    if ((key === "ticker" || key === "status") && !b[key]) continue;
    vals.push(conv(b[key]));
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) throw badRequest("NO_FIELDS");
  vals.push(ideaId, id);
  const { rows } = await pool.query<any>(
    `UPDATE trade_ideas SET ${sets.join(", ")}
     WHERE id = $${vals.length - 1} AND playbook_id = $${vals.length} AND deleted_at IS NULL
     RETURNING ${PLAYBOOK_IDEA_SELECT}`,
    vals
  );
  if (!rows[0]) throw notFound();
  await logActivity({ action: "updated", section: "playbook", entityId: String(id), entityTitle: activityTitle("example", { ticker: rows[0].ticker }), trader: req.authUser!.name, params: { titleKey: "example", ticker: rows[0].ticker } });
  res.json(rows[0]);
}));

router.delete("/playbook/:id/ideas/:ideaId", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const ideaId = Number(req.params.ideaId);
  if (isNaN(ideaId) || isNaN(id)) throw badRequest("INVALID_ID");
  const setup = await requireSetupEditor(req, res, id);
  if (!setup) return;
  const { rows: prev } = await pool.query<any>(`SELECT ticker FROM trade_ideas WHERE id = $1 AND playbook_id = $2`, [ideaId, id]);
  await pool.query(
    `UPDATE trade_ideas SET deleted_at = NOW() WHERE id = $1 AND playbook_id = $2`,
    [ideaId, id]
  );
  await logActivity({ action: "deleted", section: "playbook", entityId: String(id), entityTitle: prev[0]?.ticker ? activityTitle("example", { ticker: prev[0].ticker }) : `#${ideaId}`, trader: req.authUser!.name, params: prev[0]?.ticker ? { titleKey: "example", ticker: prev[0].ticker } : undefined });
  res.json({ success: true });
}));

export default router;
