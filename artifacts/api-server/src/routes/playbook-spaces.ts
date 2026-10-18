import express, { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { logActivity } from "../lib/activity";
import { accessCustomParams, activityDetails, localizeActivity } from "../lib/activityText";
import { canAccessTrade, isGuest, scopeTrader } from "../lib/auth";
import { requireCap } from "../lib/permissions";
import { closeDateSql, horizonSql, netPnlSql, resultSql, signedR, signedRSql } from "../lib/tradeMath";
import { execSpanJoin } from "../lib/execSpan";
import { nyMinutes } from "../lib/tradingDate";
import { sniffImageMime } from "../lib/planMedia";
import { computeEdge, computeUsdStats, etWallMinutes, slotStats, bucketBy, type EdgeTrade } from "../lib/playbookEdge";
import {
  accessHints, canEditSetupRow, canReadPure, canSharePure, ensurePlaybookSpaces, loadSetupAccess, loadViewer,
  loadMoneyViewer, mayShareAny, normSharedWith, spaceOf, spaceSql, visibleSql, type PlaybookViewer,
} from "../lib/playbookAccess";
import { inboxDays, labelScore, rankInbox, suggestSetup, suggestTier, type InboxSetup } from "../lib/playbookInbox";
import {
  canSeeAggregateMoney, canSeeTradeMoney, equityByR, redactEdgeStats, redactSlot, redactTradeRow, redactUsdStats,
  type MoneyViewer,
} from "../lib/playbookPrivacy";
import { AppError, badRequest, notFound, sendError, unauthorized } from "../lib/http";
import { langOf } from "../i18n";
import { playbookT } from "../i18n/ns";

/**
 * Playbook spaces, tiered examples, gallery, trade picker, sharing, copy / promote, $-stats and media (Wave J3).
 * Access rules live in lib/playbookAccess.ts; every endpoint re-checks them on the server.
 *
 * Examples («эталоны») — table playbook_examples: a trade attached to a setup with a tier
 *   1 = textbook («показательная»), 2 = good, 3 = execution mistake / anti-example,
 *   a short note, checklist marks ({ itemId: boolean }) and an optional screenshot (playbook_media id).
 *   Who may add: own trades (or, for staff, any trade they may read) to a setup they may edit, or to an «Офис» setup.
 *   Who may change/remove an example: whoever added it, or an editor of the setup. Soft delete only.
 *
 * Privacy (lib/playbookPrivacy.ts): every response with trade facts goes through redactTradeRow — the $ facts
 * (net / pnl / fees / qty …) of a trade are visible only to its owner and to staff; others get null + redacted: true.
 * Aggregates ($-stats) keep counts / win rate / R and null their $ unless every included trade is the viewer's own.
 *
 *   GET    /playbook/:id/examples                       list (with trade facts)
 *   POST   /playbook/:id/examples                       { tradeIds | tradeId, tier?, note?, checklistMarks?, link? }
 *   PATCH  /playbook/:id/examples/:exampleId            { tier?, note?, checklistMarks?, mediaId?, sortOrder?, playbookId? (move) }
 *   DELETE /playbook/:id/examples/:exampleId            soft delete
 *   POST   /playbook/:id/examples/reorder               { tier, ids } — drag-and-drop inside / across tiers
 *   GET    /playbook-tools/gallery                      ?tier=1&setupId=&trader=&space=office|personal|shared
 *   GET    /playbook-tools/trade-picker                 ?setupId=&trader=&q=&from=&to=&result=win|loss&match=1&limit=
 *   GET    /playbook-tools/for-trade/:tradeId           setups for the 1-click popover (recent, suggested, already in)
 *   GET    /playbook-tools/inbox                        ?days=14&limit= — own recent trades not in any setup yet (+ suggestion)
 *   POST   /playbook-tools/inbox/dismiss  DELETE same   { tradeIds } — «Не для плейбука» (hide from the inbox) / undo
 *   GET    /playbook/:id/activity                       the setup's journal (activity_log rows for this setup)
 *   GET    /playbook-tools/share-targets                people + cohorts for the share dialog
 *   POST   /playbook/:id/share                          { visibility: private|all|custom, users?, cohorts? }
 *   POST   /playbook/:id/copy                           copy into «Мой» with attribution
 *   POST   /playbook/:id/propose   DELETE same          owner proposes a personal setup for «Офис» / withdraws (or curator declines)
 *   POST   /playbook/:id/promote                        curator: copy a personal setup (with its examples) into «Офис»
 *   GET    /playbook/:id/stats                          $-first stats, best entry slots, equity, tickers
 *   POST   /playbook-media?playbookId=&w=&h=            raw image (webp/jpeg/png ≤ 2.5 MB)
 *   GET    /playbook-media/:id   DELETE same            bytes (reader of the setup) / soft delete
 */
const router: IRouter = Router();

const MEDIA_MAX_BYTES = 2_500_000;
const MEDIA_DAILY_LIMIT = 150;
const rawImage = express.raw({ type: ["image/webp", "image/jpeg", "image/png"], limit: MEDIA_MAX_BYTES });

const numOrNull = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const parseId = (raw: unknown): number | null => {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const tierOf = (v: unknown): 1 | 2 | 3 | null => (v === 1 || v === 2 || v === 3 ? v : v === "1" || v === "2" || v === "3" ? (Number(v) as 1 | 2 | 3) : null);
const noteOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 2000) : null);
function marksOf(v: unknown): Record<string, boolean> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, boolean> = {};
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "boolean" || !k || k.length > 64) continue;
    out[k] = val;
    if (++n >= 60) break;
  }
  return out;
}

let suggestionsTable: Promise<boolean> | null = null;
/** Auto-classifier results (routes/setups-auto.ts) are read-only here; the table may not exist yet. */
function hasSuggestions(): Promise<boolean> {
  if (!suggestionsTable) {
    suggestionsTable = pool
      .query<{ t: string | null }>(`SELECT to_regclass('public.trade_setup_suggestions')::text AS t`)
      .then((r) => !!r.rows[0]?.t)
      .catch(() => false)
      .then((ok) => { if (!ok) setTimeout(() => { suggestionsTable = null; }, 60_000); return ok; });
  }
  return suggestionsTable;
}
async function suggestionJoin(alias = "t"): Promise<{ join: string; cols: string }> {
  if (!(await hasSuggestions())) return { join: "", cols: `NULL::text AS "autoSetup", NULL::numeric AS "autoConfidence"` };
  return {
    join: `LEFT JOIN LATERAL (
             SELECT s.setup, s.confidence FROM trade_setup_suggestions s
              WHERE s.trade_id = ${alias}.id AND s.status <> 'rejected'
              ORDER BY s.updated_at DESC, s.id DESC LIMIT 1
           ) sg ON TRUE`,
    cols: `sg.setup AS "autoSetup", sg.confidence AS "autoConfidence"`,
  };
}

/** Does an auto-class name ("Пробой HOD") fit a setup (name / type / tags)? Loose, case-insensitive, both ways. */
export function autoMatchesSetup(auto: string | null | undefined, setup: { name?: string | null; setupType?: string | null; tags?: string | null }): boolean {
  const a = (auto ?? "").trim().toLowerCase();
  if (a.length < 3) return false;
  const terms = [setup.name, setup.setupType, ...(setup.tags ?? "").split(",")]
    .map((x) => (x ?? "").trim().toLowerCase())
    .filter((x) => x.length >= 3);
  return terms.some((t) => t.includes(a) || a.includes(t));
}

async function setupForRead(req: Request, res: Response, id: number | null) {
  if (!id) { sendError(res, badRequest("INVALID_ID")); return null; }
  await ensurePlaybookSpaces();
  const row = await loadSetupAccess(id);
  const v = await loadViewer(req);
  if (!row || !canReadPure(v, row)) throw new AppError("SETUP_NOT_FOUND");
  return { row, v };
}

const EXAMPLE_SELECT = `
  e.id, e.playbook_id AS "playbookId", e.trade_id AS "tradeId", e.tier, e.note,
  e.checklist_marks AS "checklistMarks", e.media_id AS "mediaId", e.sort_order AS "sortOrder",
  e.added_by AS "addedBy", e.created_at AS "createdAt", e.updated_at AS "updatedAt",
  t.ticker, t.date, ${closeDateSql("t")} AS "closeDate", t.side, ${resultSql("t")} AS result,
  ${netPnlSql("t")} AS "netPnl", t.pnl, t.fees, ${signedRSql("t")} AS "signedR", ${horizonSql("t")} AS horizon,
  t.trader, t.qty, t.entry, t.exit,
  (SELECT MIN(x.executed_at) FROM trade_executions x WHERE x.trade_id = t.id AND x.kind IN ('entry', 'add')) AS "entryTime",
  (SELECT MAX(x.executed_at) FROM trade_executions x WHERE x.trade_id = t.id AND x.kind NOT IN ('entry', 'add')) AS "exitTime"
`;
/** Example row → API shape, with the $ facts redacted for viewers who neither own the trade nor are staff. */
function shapeExample(r: any, mv: MoneyViewer) {
  return redactTradeRow({
    ...r,
    tier: Number(r.tier),
    netPnl: numOrNull(r.netPnl),
    pnl: numOrNull(r.pnl),
    fees: numOrNull(r.fees),
    signedR: numOrNull(r.signedR),
    qty: numOrNull(r.qty),
    entry: numOrNull(r.entry),
    exit: numOrNull(r.exit),
    entryTime: iso(r.entryTime),
    exitTime: iso(r.exitTime),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  }, mv);
}

async function loadExample(id: number) {
  const { rows } = await pool.query<any>(
    `SELECT id, playbook_id AS "playbookId", trade_id AS "tradeId", tier, added_by AS "addedBy"
       FROM playbook_examples WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
}

/** Whoever added the example, or an editor of its setup. */
async function canChangeExample(req: Request, v: PlaybookViewer, ex: { addedBy: string | null }, setup: Parameters<typeof canEditSetupRow>[1]) {
  if (v.guest || !v.name) return false;
  if (ex.addedBy && ex.addedBy === v.name) return true;
  return canEditSetupRow(req, setup);
}

// ─── Examples ────────────────────────────────────────────────────────────────

router.get("/playbook/:id/examples", asyncHandler(async (req, res): Promise<void> => {
  const ctx = await setupForRead(req, res, parseId(req.params.id));
  if (!ctx) return;
  const { rows } = await pool.query<any>(
    `SELECT ${EXAMPLE_SELECT}
       FROM playbook_examples e JOIN trades t ON t.id = e.trade_id AND t.deleted_at IS NULL
      WHERE e.playbook_id = $1 AND e.deleted_at IS NULL
      ORDER BY e.tier, e.sort_order, e.created_at DESC`,
    [ctx.row.id],
  );
  const mv = await loadMoneyViewer(req);
  res.json(rows.map((r) => shapeExample(r, mv)));
}));

router.post("/playbook/:id/examples", asyncHandler(async (req, res): Promise<void> => {
  if (isGuest(req)) throw new AppError("GUEST_READ_ONLY");
  const ctx = await setupForRead(req, res, parseId(req.params.id));
  if (!ctx) return;
  const { row, v } = ctx;
  if (!accessHints(v, row).canAddExamples) throw new AppError("EXAMPLE_SETUP_FORBIDDEN");
  const body = req.body as Record<string, unknown>;
  const ids = (Array.isArray(body.tradeIds) ? body.tradeIds : body.tradeId != null ? [body.tradeId] : [])
    .map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  const uniq = [...new Set(ids)].slice(0, 100);
  if (!uniq.length) throw new AppError("TRADE_IDS_REQUIRED");
  const tier = tierOf(body.tier) ?? 2;
  const note = noteOf(body.note);
  const marks = marksOf(body.checklistMarks);
  const link = body.link !== false;
  const added: number[] = [];
  // For the «Отменить» toast: ids created by this call, the previous tier / note of re-added ones, trades linked here.
  const created: number[] = [];
  const previous: { id: number; tier: number; note: string | null }[] = [];
  const linkedTradeIds: number[] = [];
  const skipped: { tradeId: number; reason: string }[] = [];
  let linked = 0;
  for (const tradeId of uniq) {
    const access = await canAccessTrade(req, tradeId, "read");
    if (access !== true) { skipped.push({ tradeId, reason: access === null ? "not_found" : "forbidden" }); continue; }
    const { rows: live } = await pool.query<{ id: number; tier: number; note: string | null }>(
      `SELECT id, tier, note FROM playbook_examples WHERE playbook_id = $1 AND trade_id = $2 AND deleted_at IS NULL`,
      [row.id, tradeId],
    );
    if (live[0]) {
      previous.push({ id: live[0].id, tier: Number(live[0].tier), note: live[0].note });
      // Re-adding the same trade updates its tier / note instead of duplicating it.
      await pool.query(
        `UPDATE playbook_examples SET tier = $2, note = COALESCE($3, note), checklist_marks = COALESCE($4::jsonb, checklist_marks), updated_at = NOW() WHERE id = $1`,
        [live[0].id, tier, note, marks ? JSON.stringify(marks) : null],
      );
      added.push(live[0].id);
    } else {
      const { rows: ins } = await pool.query<{ id: number }>(
        `INSERT INTO playbook_examples (playbook_id, trade_id, tier, note, checklist_marks, added_by, sort_order)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6,
                 COALESCE((SELECT MAX(sort_order) + 1 FROM playbook_examples WHERE playbook_id = $1 AND tier = $3 AND deleted_at IS NULL), 0))
         RETURNING id`,
        [row.id, tradeId, tier, note, marks ? JSON.stringify(marks) : null, v.name],
      );
      added.push(ins[0]!.id);
      created.push(ins[0]!.id);
    }
    // Link the trade to the setup for stats when it is unlinked and the caller may write it.
    if (link && (await canAccessTrade(req, tradeId, "write")) === true) {
      const { rowCount } = await pool.query(`UPDATE trades SET playbook_id = $1 WHERE id = $2 AND playbook_id IS NULL AND deleted_at IS NULL`, [row.id, tradeId]);
      linked += rowCount ?? 0;
      if (rowCount) linkedTradeIds.push(tradeId);
    }
  }
  if (added.length) {
    await logActivity({
      action: "created", section: "playbook", entityId: String(row.id), entityTitle: row.name,
      trader: v.name ?? undefined, details: activityDetails("examplesAdded", { tier, count: added.length }), params: { detailsKey: "examplesAdded", tier, count: added.length },
    });
  }
  const { rows } = added.length
    ? await pool.query<any>(
        `SELECT ${EXAMPLE_SELECT} FROM playbook_examples e JOIN trades t ON t.id = e.trade_id WHERE e.id = ANY($1::int[])`,
        [added],
      )
    : { rows: [] as any[] };
  const mv = await loadMoneyViewer(req);
  res.status(201).json({ examples: rows.map((r) => shapeExample(r, mv)), skipped, linked, created, previous, linkedTradeIds });
}));

router.post("/playbook/:id/examples/reorder", asyncHandler(async (req, res): Promise<void> => {
  if (isGuest(req)) throw new AppError("GUEST_READ_ONLY");
  const ctx = await setupForRead(req, res, parseId(req.params.id));
  if (!ctx) return;
  const { row, v } = ctx;
  const body = req.body as { tier?: unknown; ids?: unknown };
  const tier = tierOf(body.tier);
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 300) : [];
  if (!tier || !ids.length) throw new AppError("FIELD_REQUIRED", undefined, { field: "tier, ids" });
  const { rows } = await pool.query<{ id: number; added_by: string | null }>(
    `SELECT id, added_by FROM playbook_examples WHERE playbook_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL`,
    [row.id, ids],
  );
  const editor = await canEditSetupRow(req, row);
  if (!editor && rows.some((r) => r.added_by !== v.name)) throw new AppError("SETUP_EDITOR_ONLY");
  const known = new Set(rows.map((r) => r.id));
  let order = 0;
  for (const id of ids) {
    if (!known.has(id)) continue;
    await pool.query(`UPDATE playbook_examples SET tier = $2, sort_order = $3, updated_at = NOW() WHERE id = $1`, [id, tier, order++]);
  }
  res.json({ success: true, updated: order });
}));

router.patch("/playbook/:id/examples/:exampleId", asyncHandler(async (req, res): Promise<void> => {
  if (isGuest(req)) throw new AppError("GUEST_READ_ONLY");
  const ctx = await setupForRead(req, res, parseId(req.params.id));
  if (!ctx) return;
  const { row, v } = ctx;
  const exId = parseId(req.params.exampleId);
  const ex = exId ? await loadExample(exId) : null;
  if (!ex || ex.playbookId !== row.id) throw new AppError("EXAMPLE_NOT_FOUND");
  if (!(await canChangeExample(req, v, ex, row))) throw new AppError("SETUP_EDITOR_ONLY");
  const body = req.body as Record<string, unknown>;
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, val: unknown, cast = "") => { vals.push(val); sets.push(`${col} = $${vals.length}${cast}`); };
  if (body.tier !== undefined) {
    const t = tierOf(body.tier);
    if (!t) throw new AppError("INVALID_FIELD", undefined, { field: "tier" });
    push("tier", t);
  }
  if (body.note !== undefined) push("note", noteOf(body.note));
  if (body.checklistMarks !== undefined) { const m = marksOf(body.checklistMarks); push("checklist_marks", m ? JSON.stringify(m) : null, "::jsonb"); }
  if (body.mediaId !== undefined) push("media_id", body.mediaId == null ? null : parseId(body.mediaId));
  if (body.sortOrder !== undefined && Number.isInteger(Number(body.sortOrder))) push("sort_order", Number(body.sortOrder));

  // Move to another setup (drag between setups): needs add rights there; merges into an existing example of the same trade.
  const target = body.playbookId !== undefined ? parseId(body.playbookId) : null;
  if (target && target !== row.id) {
    const dest = await loadSetupAccess(target);
    if (!dest || !canReadPure(v, dest)) throw new AppError("SETUP_NOT_FOUND");
    if (!accessHints(v, dest).canAddExamples) throw new AppError("EXAMPLE_SETUP_FORBIDDEN");
    const { rows: clash } = await pool.query<{ id: number }>(
      `SELECT id FROM playbook_examples WHERE playbook_id = $1 AND trade_id = $2 AND deleted_at IS NULL`,
      [target, ex.tradeId],
    );
    if (clash[0]) {
      await pool.query(`UPDATE playbook_examples SET deleted_at = NOW() WHERE id = $1`, [ex.id]);
      if (sets.length) { vals.push(clash[0].id); await pool.query(`UPDATE playbook_examples SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${vals.length}`, vals); }
      const { rows } = await pool.query<any>(`SELECT ${EXAMPLE_SELECT} FROM playbook_examples e JOIN trades t ON t.id = e.trade_id WHERE e.id = $1`, [clash[0].id]);
      res.json({ ...shapeExample(rows[0], await loadMoneyViewer(req)), merged: true });
      return;
    }
    push("playbook_id", target);
    // Keep stats consistent: the trade follows its example when it was linked to the old setup and is writable.
    if ((await canAccessTrade(req, ex.tradeId, "write")) === true) {
      await pool.query(`UPDATE trades SET playbook_id = $1 WHERE id = $2 AND playbook_id = $3`, [target, ex.tradeId, row.id]);
    }
  }
  if (!sets.length) throw badRequest("NO_FIELDS");
  vals.push(ex.id);
  await pool.query(`UPDATE playbook_examples SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${vals.length}`, vals);
  const { rows } = await pool.query<any>(`SELECT ${EXAMPLE_SELECT} FROM playbook_examples e JOIN trades t ON t.id = e.trade_id WHERE e.id = $1`, [ex.id]);
  res.json(shapeExample(rows[0], await loadMoneyViewer(req)));
}));

router.delete("/playbook/:id/examples/:exampleId", asyncHandler(async (req, res): Promise<void> => {
  if (isGuest(req)) throw new AppError("GUEST_READ_ONLY");
  const ctx = await setupForRead(req, res, parseId(req.params.id));
  if (!ctx) return;
  const { row, v } = ctx;
  const exId = parseId(req.params.exampleId);
  const ex = exId ? await loadExample(exId) : null;
  if (!ex || ex.playbookId !== row.id) throw new AppError("EXAMPLE_NOT_FOUND");
  if (!(await canChangeExample(req, v, ex, row))) throw new AppError("SETUP_EDITOR_ONLY");
  await pool.query(`UPDATE playbook_examples SET deleted_at = NOW() WHERE id = $1`, [ex.id]);
  // ?unlink=1 (undo of a fresh add): also drop the trade → setup link, only when it points at this setup and
  // the caller may write the trade.
  let unlinked = false;
  if (req.query.unlink === "1" && (await canAccessTrade(req, ex.tradeId, "write")) === true) {
    const { rowCount } = await pool.query(`UPDATE trades SET playbook_id = NULL WHERE id = $1 AND playbook_id = $2`, [ex.tradeId, row.id]);
    unlinked = !!rowCount;
  }
  await logActivity({ action: "deleted", section: "playbook", entityId: String(row.id), entityTitle: row.name, trader: v.name ?? undefined, details: activityDetails("exampleRemoved", { trade: ex.tradeId }), params: { detailsKey: "exampleRemoved", trade: ex.tradeId } });
  res.json({ success: true, unlinked });
}));

// ─── Gallery of Tier-1 examples ─────────────────────────────────────────────

router.get("/playbook-tools/gallery", asyncHandler(async (req, res): Promise<void> => {
  await ensurePlaybookSpaces();
  const v = await loadViewer(req);
  const params: unknown[] = [];
  const where: string[] = ["e.deleted_at IS NULL", "p.deleted_at IS NULL", "t.deleted_at IS NULL"];
  where.push(visibleSql(v, params, "p"));
  const tier = tierOf(req.query.tier);
  if (tier) { params.push(tier); where.push(`e.tier = $${params.length}`); }
  const setupId = parseId(req.query.setupId);
  if (setupId) { params.push(setupId); where.push(`e.playbook_id = $${params.length}`); }
  const trader = typeof req.query.trader === "string" && req.query.trader.trim() ? req.query.trader.trim().slice(0, 120) : null;
  if (trader) { params.push(trader); where.push(`t.trader = $${params.length}`); }
  const galleryDate = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof req.query.from === "string" && galleryDate.test(req.query.from)) { params.push(req.query.from); where.push(`${closeDateSql("t")} >= $${params.length}`); }
  if (typeof req.query.to === "string" && galleryDate.test(req.query.to)) { params.push(req.query.to); where.push(`${closeDateSql("t")} <= $${params.length}`); }
  const space = req.query.space;
  if (space === "office") where.push(`${spaceSql("p")} = 'office'`);
  else if (space === "personal") { params.push(v.name ?? ""); where.push(`${spaceSql("p")} = 'personal' AND p.trader = $${params.length}`); }
  else if (space === "shared") { params.push(v.name ?? ""); where.push(`${spaceSql("p")} = 'personal' AND COALESCE(p.visibility, 'private') <> 'private' AND p.trader IS DISTINCT FROM $${params.length}`); }
  const limit = Math.min(Math.max(Number(req.query.limit) || 120, 1), 300);
  params.push(limit);
  const { rows } = await pool.query<any>(
    `SELECT ${EXAMPLE_SELECT}, p.name AS "setupName", p.folder AS "setupFolder", ${spaceSql("p")} AS "setupSpace", p.trader AS "setupOwner"
       FROM playbook_examples e
       JOIN playbook p ON p.id = e.playbook_id
       JOIN trades t ON t.id = e.trade_id
      WHERE ${where.join(" AND ")}
      ORDER BY e.tier, ${closeDateSql("t")} DESC, e.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const mv = await loadMoneyViewer(req);
  res.json(rows.map((r) => shapeExample(r, mv)));
}));

// ─── Trade picker («Добавить примеры») ───────────────────────────────────────

router.get("/playbook-tools/trade-picker", asyncHandler(async (req, res): Promise<void> => {
  await ensurePlaybookSpaces();
  const requested = typeof req.query.trader === "string" ? req.query.trader : null;
  const scope = await scopeTrader(req, requested, "trades.read.team");
  if (scope === undefined) throw unauthorized();
  const v = await loadViewer(req);
  const setupId = parseId(req.query.setupId);
  let setup: { id: number; name: string; setupType: string | null; tags: string | null } | null = null;
  if (setupId) {
    const acc = await loadSetupAccess(setupId);
    if (!acc || !canReadPure(v, acc)) throw new AppError("SETUP_NOT_FOUND");
    const { rows } = await pool.query<any>(`SELECT id, name, setup_type AS "setupType", tags FROM playbook WHERE id = $1`, [setupId]);
    setup = rows[0] ?? null;
  }
  const params: unknown[] = [];
  const where: string[] = ["t.deleted_at IS NULL"];
  if (scope) { params.push(scope); where.push(`t.trader = $${params.length}`); }
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 40) : "";
  if (q) { params.push(`%${q.toUpperCase()}%`); where.push(`UPPER(t.ticker) LIKE $${params.length}`); }
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof req.query.from === "string" && dateRe.test(req.query.from)) { params.push(req.query.from); where.push(`${closeDateSql("t")} >= $${params.length}`); }
  if (typeof req.query.to === "string" && dateRe.test(req.query.to)) { params.push(req.query.to); where.push(`${closeDateSql("t")} <= $${params.length}`); }
  if (req.query.result === "win") where.push(`${netPnlSql("t")} > 0`);
  else if (req.query.result === "loss") where.push(`${netPnlSql("t")} < 0`);
  const mv = await loadMoneyViewer(req);
  const minNet = numOrNull(req.query.minNet);
  const maxNet = numOrNull(req.query.maxNet);
  // $ filters must not become a probe into other traders' $: for non-staff they only ever match own trades.
  if ((minNet != null || maxNet != null) && !mv.staff) { params.push(mv.name ?? ""); where.push(`t.trader = $${params.length}`); }
  if (minNet != null) { params.push(minNet); where.push(`${netPnlSql("t")} >= $${params.length}`); }
  if (maxNet != null) { params.push(maxNet); where.push(`${netPnlSql("t")} <= $${params.length}`); }
  const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 600);
  const sg = await suggestionJoin("t");
  let inSetup = `FALSE AS "inSetup"`;
  if (setupId) { params.push(setupId); inSetup = `EXISTS (SELECT 1 FROM playbook_examples e WHERE e.trade_id = t.id AND e.playbook_id = $${params.length} AND e.deleted_at IS NULL) AS "inSetup"`; }
  params.push(limit);
  const { rows } = await pool.query<any>(
    `SELECT t.id, t.ticker, t.date, ${closeDateSql("t")} AS "closeDate", t.side, ${resultSql("t")} AS result,
            ${netPnlSql("t")} AS "netPnl", ${signedRSql("t")} AS "signedR", ${horizonSql("t")} AS horizon, t.trader, t.setup,
            t.playbook_id AS "playbookId", pb.name AS "playbookName", ${sg.cols}, ${inSetup}
       FROM trades t
       LEFT JOIN playbook pb ON pb.id = t.playbook_id AND pb.deleted_at IS NULL
       ${sg.join}
      WHERE ${where.join(" AND ")}
      ORDER BY ${closeDateSql("t")} DESC, t.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const out = rows.map((r) => {
    const autoMatch = setup ? autoMatchesSetup(r.autoSetup, setup) : false;
    const textMatch = setup ? !!r.setup && autoMatchesSetup(r.setup, setup) : false;
    return redactTradeRow({
      ...r,
      netPnl: numOrNull(r.netPnl),
      signedR: numOrNull(r.signedR),
      autoConfidence: numOrNull(r.autoConfidence),
      linkedHere: !!setupId && r.playbookId === setupId,
      matchesSetup: autoMatch || textMatch || (!!setupId && r.playbookId === setupId),
      autoMatch,
    }, mv);
  });
  const filtered = req.query.match === "1" ? out.filter((r) => r.matchesSetup) : out;
  res.json({ trader: scope, setup, trades: filtered, truncated: rows.length >= limit });
}));

// ─── 1-click popover from a trade ────────────────────────────────────────────

router.get("/playbook-tools/for-trade/:tradeId", asyncHandler(async (req, res): Promise<void> => {
  await ensurePlaybookSpaces();
  const tradeId = parseId(req.params.tradeId);
  if (!tradeId) throw badRequest("INVALID_ID");
  const access = await canAccessTrade(req, tradeId, "read");
  if (access === null) throw notFound("TRADE_NOT_FOUND");
  if (!access) throw new AppError("TRADE_FORBIDDEN");
  const v = await loadViewer(req);
  const sg = await suggestionJoin("t");
  const { rows: tr } = await pool.query<any>(
    `SELECT t.id, t.ticker, t.date, t.side, t.trader, t.setup, t.playbook_id AS "playbookId", ${netPnlSql("t")} AS "netPnl",
            ${resultSql("t")} AS result, ${signedRSql("t")} AS "signedR", ${sg.cols}
       FROM trades t ${sg.join} WHERE t.id = $1`,
    [tradeId],
  );
  const trade = tr[0];
  const params: unknown[] = [];
  const vis = visibleSql(v, params, "p");
  const { rows: setups } = await pool.query<any>(
    `SELECT p.id, p.name, p.folder, p.trader, p.setup_type AS "setupType", p.tags, ${spaceSql("p")} AS space,
            COALESCE(p.visibility, 'private') AS visibility, p.shared_with AS "sharedWith", p.checklist_items AS "checklistItems", p.checklist
       FROM playbook p WHERE p.deleted_at IS NULL AND ${vis}
      ORDER BY p.name`,
    params,
  );
  const light = setups.map((s) => {
    const a = accessHints(v, s);
    return { id: s.id, name: s.name, folder: s.folder, space: a.space, mine: a.mine, shared: a.shared, owner: s.trader, canAddExamples: a.canAddExamples, setupType: s.setupType, tags: s.tags, checklistItems: s.checklistItems, checklist: s.checklist };
  });
  const byId = new Map(light.map((s) => [s.id, s]));
  // Recent: setups I added examples to, then setups my trades were linked to lately.
  const recent: number[] = [];
  if (v.name) {
    const { rows: r1 } = await pool.query<{ playbook_id: number }>(
      `SELECT playbook_id FROM playbook_examples WHERE added_by = $1 AND deleted_at IS NULL
        GROUP BY playbook_id ORDER BY MAX(created_at) DESC LIMIT 8`,
      [v.name],
    );
    const { rows: r2 } = await pool.query<{ playbook_id: number }>(
      `SELECT playbook_id FROM trades WHERE trader = $1 AND playbook_id IS NOT NULL AND deleted_at IS NULL
        GROUP BY playbook_id ORDER BY MAX(${closeDateSql("trades")}) DESC LIMIT 8`,
      [v.name],
    );
    for (const id of [...r1.map((r) => r.playbook_id), ...r2.map((r) => r.playbook_id)]) {
      if (byId.has(id) && !recent.includes(id)) recent.push(id);
      if (recent.length >= 6) break;
    }
  }
  const suggested: { id: number; reason: string }[] = [];
  const addSug = (id: number, reason: string) => { if (byId.has(id) && !suggested.some((s) => s.id === id)) suggested.push({ id, reason }); };
  const pt = playbookT.tFor(langOf(req));
  if (trade?.playbookId) addSug(trade.playbookId, pt("suggest.linkedHere"));
  // Closest name first (exact > partial name > type/tag), writable setups before read-only ones.
  const byLabel = (label: string) => light
    .map((s) => ({ s, sc: labelScore(label, s) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc || Number(b.s.canAddExamples) - Number(a.s.canAddExamples) || Number(b.s.mine) - Number(a.s.mine));
  if (trade?.autoSetup) for (const { s } of byLabel(trade.autoSetup)) addSug(s.id, pt("suggest.auto", { label: trade.autoSetup }));
  if (trade?.setup) for (const { s } of byLabel(trade.setup)) addSug(s.id, pt("suggest.text", { label: trade.setup }));
  const { rows: ex } = await pool.query<any>(
    `SELECT id, playbook_id AS "playbookId", tier, note FROM playbook_examples WHERE trade_id = $1 AND deleted_at IS NULL`,
    [tradeId],
  );
  const mv = await loadMoneyViewer(req);
  res.json({
    trade: trade ? redactTradeRow({ ...trade, netPnl: numOrNull(trade.netPnl), signedR: numOrNull(trade.signedR), autoConfidence: numOrNull(trade.autoConfidence) }, mv) : null,
    setups: light,
    recent,
    suggested: suggested.slice(0, 5),
    examples: ex.filter((e) => byId.has(e.playbookId)),
    viewer: { name: v.name, editOwn: v.editOwn, editAny: v.editAny },
  });
}));

// ─── Inbox: own recent trades without an example ────────────────────────────

/**
 * GET /playbook-tools/inbox?days=14&limit=40[&trader=] — the viewer's recent trades (staff: ?trader=) that are not an
 * example of any live setup yet, newest first, each with a best-guess setup and tier (lib/playbookInbox.ts).
 * Feeds «Разобрать сделки» on the playbook home. Trade $ go through redactTradeRow like everywhere else.
 */
router.get("/playbook-tools/inbox", asyncHandler(async (req, res): Promise<void> => {
  await Promise.all([ensurePlaybookSpaces(), ensureInboxExtras()]);
  const requested = typeof req.query.trader === "string" && req.query.trader.trim() ? req.query.trader.trim() : null;
  const scope = await scopeTrader(req, requested, "trades.read.team");
  if (scope === undefined) throw unauthorized();
  const v = await loadViewer(req);
  const who = scope ?? v.name;
  if (!who || v.guest) { res.json({ trader: null, days: 0, total: 0, trades: [] }); return; }
  const days = inboxDays(req.query.days);
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
  const sg = await suggestionJoin("t");
  const base = `FROM trades t
       LEFT JOIN playbook pb ON pb.id = t.playbook_id AND pb.deleted_at IS NULL
       ${sg.join}
      WHERE t.deleted_at IS NULL AND t.trader = $1
        AND ${closeDateSql("t")} >= to_char((NOW() AT TIME ZONE 'America/New_York')::date - $2::int, 'YYYY-MM-DD')
        AND NOT EXISTS (
          SELECT 1 FROM playbook_examples e JOIN playbook p ON p.id = e.playbook_id AND p.deleted_at IS NULL
           WHERE e.trade_id = t.id AND e.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM playbook_inbox_dismissed d WHERE d.trade_id = t.id)`;
  const [{ rows }, { rows: cnt }] = await Promise.all([
    pool.query<any>(
      `SELECT t.id, t.ticker, t.date, ${closeDateSql("t")} AS "closeDate", t.side, ${resultSql("t")} AS result,
              ${netPnlSql("t")} AS "netPnl", ${signedRSql("t")} AS "signedR", ${horizonSql("t")} AS horizon, t.trader, t.setup,
              t.playbook_id AS "playbookId", pb.name AS "playbookName", ${sg.cols}
         ${base}
        ORDER BY ${closeDateSql("t")} DESC, t.id DESC
        LIMIT $3`,
      [who, days, limit],
    ),
    pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n ${base}`, [who, days]),
  ]);
  const params: unknown[] = [];
  const vis = visibleSql(v, params, "p");
  const { rows: setupRows } = await pool.query<any>(
    `SELECT p.id, p.name, p.trader, p.setup_type AS "setupType", p.tags, ${spaceSql("p")} AS space,
            COALESCE(p.visibility, 'private') AS visibility, p.shared_with AS "sharedWith"
       FROM playbook p WHERE p.deleted_at IS NULL AND ${vis}`,
    params,
  );
  const setups: InboxSetup[] = setupRows.map((s) => {
    const a = accessHints(v, s);
    return { id: s.id, name: s.name, setupType: s.setupType, tags: s.tags, canAddExamples: a.canAddExamples, mine: a.mine, space: a.space };
  });
  const mv = await loadMoneyViewer(req);
  const shaped = rows.map((r) => {
    const t = { ...r, netPnl: numOrNull(r.netPnl), signedR: numOrNull(r.signedR), autoConfidence: numOrNull(r.autoConfidence), closeDate: iso(r.closeDate)?.slice(0, 10) ?? null };
    return redactTradeRow({ ...t, suggestion: suggestSetup(t, setups, langOf(req)), suggestedTier: suggestTier(t) }, mv);
  });
  res.json({ trader: who, days, total: Number(cnt[0]?.n ?? shaped.length), trades: rankInbox(shaped) });
}));

let inboxExtras: Promise<void> | null = null;
/**
 * Additive, idempotent: «Не для плейбука» marks for the inbox, and an index for the per-setup journal
 * (GET /playbook/:id/activity filters activity_log by section + entity_id).
 */
function ensureInboxExtras(): Promise<void> {
  if (!inboxExtras) {
    inboxExtras = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS playbook_inbox_dismissed (
        trade_id INTEGER PRIMARY KEY,
        dismissed_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE INDEX IF NOT EXISTS activity_log_section_entity_idx ON activity_log (section, entity_id, created_at DESC)`);
    })().catch((e) => { inboxExtras = null; throw e; });
  }
  return inboxExtras;
}

/**
 * POST   /playbook-tools/inbox/dismiss { tradeIds } — «Не для плейбука»: hide own trades from «Разобрать сделки».
 * DELETE /playbook-tools/inbox/dismiss { tradeIds } — undo. Staff may do it for any trader's trades.
 */
async function inboxDismiss(req: Request, res: Response, on: boolean): Promise<void> {
  if (isGuest(req)) { sendError(res, new AppError("GUEST_READ_ONLY")); return; }
  await ensureInboxExtras();
  const v = await loadViewer(req);
  if (!v.name) { sendError(res, unauthorized()); return; }
  const body = req.body as { tradeIds?: unknown };
  const ids = [...new Set((Array.isArray(body.tradeIds) ? body.tradeIds : []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 200);
  if (!ids.length) throw new AppError("TRADE_IDS_REQUIRED");
  // Own trades only (staff: any) — the same people who see them in the inbox.
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM trades WHERE id = ANY($1::int[]) AND deleted_at IS NULL AND (trader = $2 OR $3::boolean)`,
    [ids, v.name, v.editAny],
  );
  const allowed = rows.map((r) => r.id);
  if (!allowed.length) throw new AppError("NOT_FOUND");
  if (on) {
    await pool.query(
      `INSERT INTO playbook_inbox_dismissed (trade_id, dismissed_by) SELECT x, $2 FROM UNNEST($1::int[]) AS x ON CONFLICT (trade_id) DO NOTHING`,
      [allowed, v.name],
    );
  } else {
    await pool.query(`DELETE FROM playbook_inbox_dismissed WHERE trade_id = ANY($1::int[])`, [allowed]);
  }
  res.json({ success: true, tradeIds: allowed });
}
router.post("/playbook-tools/inbox/dismiss", asyncHandler((req, res) => inboxDismiss(req, res, true)));
router.delete("/playbook-tools/inbox/dismiss", asyncHandler((req, res) => inboxDismiss(req, res, false)));

/**
 * GET /playbook/:id/activity — the setup's own journal (created / edited / examples …) for its «История» tab.
 * Anyone who may read the setup sees it; the global /api/activity only returns the newest rows (and, for traders,
 * only their own), so a setup's history used to look empty.
 */
router.get("/playbook/:id/activity", asyncHandler(async (req, res): Promise<void> => {
  const ctx = await setupForRead(req, res, parseId(req.params.id));
  if (!ctx) return;
  await ensureInboxExtras();
  const { rows } = await pool.query<any>(
    `SELECT id, action, section, entity_id AS "entityId", entity_title AS "entityTitle", trader, details, params, created_at AS "createdAt"
       FROM activity_log
      WHERE section = 'playbook' AND (entity_id = $1 OR (entity_id IS NULL AND entity_title = $2))
      ORDER BY created_at DESC, id DESC
      LIMIT 100`,
    [String(ctx.row.id), ctx.row.name],
  );
  const lang = langOf(req);
  res.json(rows.map(({ params, ...r }) => ({ ...r, ...localizeActivity({ entityTitle: r.entityTitle, details: r.details, params }, lang), createdAt: iso(r.createdAt) })));
}));

// ─── Sharing ─────────────────────────────────────────────────────────────────

router.get("/playbook-tools/share-targets", asyncHandler(async (req, res): Promise<void> => {
  const v = await loadViewer(req);
  if (!mayShareAny(v)) throw new AppError("SHARE_SENIOR_ONLY");
  const { rows: users } = await pool.query<{ name: string; role: string }>(
    `SELECT name, role FROM users WHERE active = true AND COALESCE(banned, false) = false ORDER BY name LIMIT 500`,
  );
  let cohorts: { id: number; name: string; members: number }[] = [];
  try {
    const { rows } = await pool.query<any>(
      `SELECT c.id, c.name, COUNT(e.id)::int AS members
         FROM academy_cohorts c LEFT JOIN academy_enrollments e ON e.cohort_id = c.id AND e.archived_at IS NULL
        WHERE c.archived_at IS NULL GROUP BY c.id, c.name ORDER BY c.name`,
    );
    cohorts = rows;
  } catch { /* academy not set up */ }
  res.json({ users: users.filter((u) => u.name !== v.name).map((u) => ({ name: u.name, role: u.role })), cohorts });
}));

router.post("/playbook/:id/share", asyncHandler(async (req, res): Promise<void> => {
  const ctx = await setupForRead(req, res, parseId(req.params.id));
  if (!ctx) return;
  const { row, v } = ctx;
  if (!canSharePure(v, row)) {
    throw new AppError(spaceOf(row) === "office" ? "OFFICE_ALREADY_PUBLIC" : "SHARE_SENIOR_ONLY");
  }
  const body = req.body as { visibility?: unknown; users?: unknown; cohorts?: unknown };
  const vis = body.visibility === "all" || body.visibility === "custom" || body.visibility === "private" ? body.visibility : null;
  if (!vis) throw new AppError("INVALID_FIELD", undefined, { field: "visibility" });
  const sw = normSharedWith({ users: body.users, cohorts: body.cohorts });
  if (vis === "custom" && !sw.users.length && !sw.cohorts.length) throw new AppError("FIELD_REQUIRED", undefined, { field: "audience" });
  await pool.query(
    `UPDATE playbook SET visibility = $2, shared_with = $3::jsonb,
            shared_at = CASE WHEN $2 = 'private' THEN NULL ELSE COALESCE(shared_at, NOW()) END,
            shared_by = CASE WHEN $2 = 'private' THEN NULL ELSE $4 END
      WHERE id = $1`,
    [row.id, vis, vis === "custom" ? JSON.stringify(sw) : null, v.name],
  );
  const access = vis === "private" ? { details: activityDetails("accessClosed"), params: { detailsKey: "accessClosed" } }
    : vis === "all" ? { details: activityDetails("accessAll"), params: { detailsKey: "accessAll" } }
    : accessCustomParams(sw.users, sw.cohorts);
  await logActivity({ action: "updated", section: "playbook", entityId: String(row.id), entityTitle: row.name, trader: v.name ?? undefined, ...access });
  res.json({ success: true, visibility: vis, sharedWith: vis === "custom" ? sw : null });
}));

const COPY_COLUMNS = [
  "name", "folder", "setup_type", "conditions", "checklist", "checklist_items", "notes", "confidence_level",
  "screenshot_url", "screenshot_notes", "screenshots", "tags", "ticker", "market_cap", "float", "adv", "atr",
  "relative_volume", "beta", "short_interest", "sector", "long_name",
  "context_text", "trigger_text", "entry_text", "stop_text", "targets_text", "management_text", "invalidation_text",
  "ideal_conditions", "time_of_day", "horizon", "media",
];

router.post("/playbook/:id/copy", asyncHandler(async (req, res): Promise<void> => {
  if (isGuest(req)) throw new AppError("GUEST_READ_ONLY");
  const ctx = await setupForRead(req, res, parseId(req.params.id));
  if (!ctx) return;
  const { row, v } = ctx;
  if (!v.name || !(v.editOwn || v.editAny)) throw new AppError("FORBIDDEN");
  const body = req.body as { folder?: unknown };
  const folder = typeof body.folder === "string" ? body.folder.trim().slice(0, 120) || null : undefined;
  const cols = COPY_COLUMNS.join(", ");
  const { rows } = await pool.query<{ id: number; name: string }>( // i18n-ignore ('Офис' = stored author label of the office space)
    `INSERT INTO playbook (${cols}, trader, space, visibility, created_by, copied_from_id, copied_from_author, source_type, source_id, updated_at)
     SELECT ${COPY_COLUMNS.map((c) => (c === "folder" && folder !== undefined ? "$3" : c)).join(", ")},
            $2, 'personal', 'private', $2, p.id,
            COALESCE(CASE WHEN ${spaceSql("p")} = 'office' THEN 'Офис' END, p.trader, p.created_by, 'Офис'),
            p.source_type, p.source_id, NOW()
       FROM playbook p WHERE p.id = $1
     RETURNING id, name`,
    folder !== undefined ? [row.id, v.name, folder] : [row.id, v.name],
  );
  const copy = rows[0]!;
  await logActivity({ action: "created", section: "playbook", entityId: String(copy.id), entityTitle: copy.name, trader: v.name, details: activityDetails("copiedToMine", { id: row.id }), params: { detailsKey: "copiedToMine", id: row.id } });
  res.status(201).json({ id: copy.id, name: copy.name });
}));

router.post("/playbook/:id/propose", asyncHandler(async (req, res): Promise<void> => {
  const ctx = await setupForRead(req, res, parseId(req.params.id));
  if (!ctx) return;
  const { row, v } = ctx;
  if (spaceOf(row) !== "personal" || row.trader !== v.name || v.guest) throw new AppError("SETUP_OWN_ONLY");
  const note = noteOf((req.body as { note?: unknown })?.note);
  await pool.query(`UPDATE playbook SET office_proposed_at = NOW(), office_proposed_by = $2, office_proposed_note = $3 WHERE id = $1`, [row.id, v.name, note]);
  await logActivity({ action: "updated", section: "playbook", entityId: String(row.id), entityTitle: row.name, trader: v.name ?? undefined, details: activityDetails("proposedOffice"), params: { detailsKey: "proposedOffice" } });
  res.json({ success: true });
}));

router.delete("/playbook/:id/propose", asyncHandler(async (req, res): Promise<void> => {
  const ctx = await setupForRead(req, res, parseId(req.params.id));
  if (!ctx) return;
  const { row, v } = ctx;
  if (!(row.trader === v.name || v.review) || v.guest) throw new AppError("FORBIDDEN");
  await pool.query(`UPDATE playbook SET office_proposed_at = NULL, office_proposed_by = NULL, office_proposed_note = NULL WHERE id = $1`, [row.id]);
  res.json({ success: true });
}));

router.post("/playbook/:id/promote", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "playbook.review", null, "PROMOTE_STAFF_ONLY"))) return;
  const ctx = await setupForRead(req, res, parseId(req.params.id));
  if (!ctx) return;
  const { row, v } = ctx;
  if (spaceOf(row) !== "personal") throw new AppError("SETUP_ALREADY_OFFICE", 400);
  const body = req.body as { folder?: unknown; withExamples?: unknown };
  const folder = typeof body.folder === "string" ? body.folder.trim().slice(0, 120) || null : undefined;
  const cols = COPY_COLUMNS.join(", ");
  const { rows } = await pool.query<{ id: number; name: string }>(
    `INSERT INTO playbook (${cols}, trader, space, visibility, created_by, promoted_from_id, copied_from_author, source_type, source_id, updated_at)
     SELECT ${COPY_COLUMNS.map((c) => (c === "folder" && folder !== undefined ? "$2" : c)).join(", ")},
            NULL, 'office', 'private', p.trader, p.id, p.trader, p.source_type, p.source_id, NOW()
       FROM playbook p WHERE p.id = $1
     RETURNING id, name`,
    folder !== undefined ? [row.id, folder] : [row.id],
  );
  const office = rows[0]!;
  let examples = 0;
  if (body.withExamples !== false) {
    const r = await pool.query(
      `INSERT INTO playbook_examples (playbook_id, trade_id, tier, note, checklist_marks, media_id, sort_order, added_by)
       SELECT $2, trade_id, tier, note, checklist_marks, media_id, sort_order, added_by
         FROM playbook_examples WHERE playbook_id = $1 AND deleted_at IS NULL`,
      [row.id, office.id],
    );
    examples = r.rowCount ?? 0;
  }
  await pool.query(`UPDATE playbook SET office_proposed_at = NULL, office_proposed_by = NULL, office_proposed_note = NULL WHERE id = $1`, [row.id]);
  await logActivity({ action: "created", section: "playbook", entityId: String(office.id), entityTitle: office.name, trader: v.name ?? undefined, details: activityDetails("movedToOffice", { trader: String(row.trader), count: examples }), params: { detailsKey: "movedToOffice", trader: String(row.trader), count: examples } });
  res.status(201).json({ id: office.id, name: office.name, examples });
}));

// ─── $-first stats ───────────────────────────────────────────────────────────

router.get("/playbook/:id/stats", asyncHandler(async (req, res): Promise<void> => {
  const ctx = await setupForRead(req, res, parseId(req.params.id));
  if (!ctx) return;
  const requested = typeof req.query.userKey === "string" ? req.query.userKey : typeof req.query.trader === "string" ? req.query.trader : null;
  const scope = await scopeTrader(req, requested);
  if (scope === undefined) throw unauthorized();
  const params: unknown[] = [ctx.row.id];
  let filter = "";
  if (scope) { params.push(scope); filter = `AND t.trader = $2`; }
  const { rows } = await pool.query<any>(
    `SELECT t.id, t.result, t.side, t.entry, t.exit, t.stop, t.pnl, t.fees, t.risk_usd AS "riskUsd",
            t.r_multiple AS "rMultiple", t.date, NULLIF(t.exit_date, '') AS "exitDate", t.horizon, t.session,
            t.context_snapshot AS "contextSnapshot", t.setup_score AS "setupScore", t.ticker, t.trader,
            ${closeDateSql("t")} AS "closeDate", e.first_entry AS "firstEntry", t.context_snapshot->>'openedAt' AS "openedAt"
       FROM trades t ${execSpanJoin("lateral")}
      WHERE t.playbook_id = $1 AND t.deleted_at IS NULL ${filter}`,
    params,
  );
  const trades = rows.map((r) => ({
    id: r.id, result: r.result, side: r.side, entry: r.entry, exit: r.exit, stop: r.stop, pnl: r.pnl, fees: r.fees,
    riskUsd: r.riskUsd, rMultiple: r.rMultiple, date: r.date, exitDate: r.exitDate, horizon: r.horizon,
    session: r.session ?? null, contextSnapshot: r.contextSnapshot ?? null, setupScore: numOrNull(r.setupScore),
    ticker: String(r.ticker ?? "").toUpperCase(), trader: r.trader as string | null, closeDate: String(r.closeDate ?? ""),
    entryMin: r.firstEntry ? nyMinutes(new Date(r.firstEntry)) : etWallMinutes(r.openedAt, nyMinutes),
  }));
  const mv = await loadMoneyViewer(req);
  // $ of the whole block only when every trade is the viewer's own (or the viewer is staff); buckets are checked
  // on their own trades, so an own-only bucket (e.g. the viewer's row in «Трейдеры») keeps its $.
  const showMoney = canSeeAggregateMoney(mv, trades.map((t) => t.trader));
  const usdOf = (list: typeof trades) => {
    const u = computeUsdStats(list);
    return canSeeAggregateMoney(mv, list.map((t) => t.trader)) ? u : redactUsdStats(u);
  };
  const edgeRaw = computeEdge(trades as EdgeTrade[]);
  const edge = showMoney ? edgeRaw : redactEdgeStats(edgeRaw);
  const usd = usdOf(trades);
  const slotsRaw = slotStats(trades, 3);
  const slots = showMoney ? slotsRaw : { slots: slotsRaw.slots.map(redactSlot), best: slotsRaw.best.map(redactSlot) };
  // Equity by close day (net $) — hidden with the rest of the $; equityR (cumulative signed R) is always there.
  const byDay = new Map<string, number>();
  for (const t of trades) {
    const u = computeUsdStats([t]);
    if (u.net == null) continue;
    byDay.set(t.closeDate, (byDay.get(t.closeDate) ?? 0) + u.net);
  }
  let cum = 0;
  const equityUsd = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, net]) => ({ day, net: Number(net.toFixed(2)), cum: Number((cum += net).toFixed(2)) }));
  const equityR = equityByR(trades.map((t) => ({ closeDate: t.closeDate, r: signedR(t) })));
  const days = [...new Set(trades.map((t) => t.closeDate).filter(Boolean))].sort();
  const tickers = Object.entries(bucketBy(trades, (t) => t.ticker || null))
    .map(([ticker, list]) => ({ ticker, raw: computeUsdStats(list), u: usdOf(list) }))
    .filter((t) => t.raw.n > 0)
    .sort((a, b) => b.raw.n - a.raw.n || (showMoney ? (b.raw.net ?? 0) - (a.raw.net ?? 0) : a.ticker.localeCompare(b.ticker)))
    .slice(0, 8)
    .map(({ ticker, u }) => ({ ticker, ...u }));
  const byHorizon = Object.fromEntries(
    Object.entries(bucketBy(trades, (t) => (t.horizon === "overnight" || t.horizon === "swing" ? t.horizon : "intraday")))
      .map(([k, list]) => [k, usdOf(list)]),
  );
  const ordered = [...trades].sort((a, b) => b.closeDate.localeCompare(a.closeDate) || b.id - a.id);
  const recent = usdOf(ordered.slice(0, 20));
  const traders = scope
    ? null
    : Object.entries(bucketBy(trades, (t) => t.trader))
      .map(([trader, list]) => {
        const raw = computeUsdStats(list);
        return { trader, raw, u: canSeeTradeMoney(mv, trader) ? raw : redactUsdStats(raw) };
      })
      .sort((a, b) => (showMoney ? (b.raw.net ?? 0) - (a.raw.net ?? 0) : b.raw.n - a.raw.n))
      .slice(0, 10)
      .map(({ trader, u }) => ({ trader, ...u }));
  res.json({
    trader: scope,
    count: trades.length,
    /** True when the $ fields were nulled (trades of other traders, viewer is not staff). */
    redacted: !showMoney,
    usd,
    recent,
    edge,
    slots: slots.slots,
    bestSlots: slots.best,
    timeCoverage: trades.length ? Number((trades.filter((t) => t.entryMin != null).length / trades.length).toFixed(3)) : null,
    equity: showMoney ? equityUsd : [],
    equityR,
    tickers,
    byHorizon,
    traders,
    firstDate: (showMoney ? equityUsd[0]?.day : equityR[0]?.day) ?? days[0] ?? null,
    lastDate: (showMoney ? equityUsd[equityUsd.length - 1]?.day : equityR[equityR.length - 1]?.day) ?? days[days.length - 1] ?? null,
  });
}));

// ─── Media (pasted screenshots) ──────────────────────────────────────────────

router.post(
  "/playbook-media",
  (req, res, next) => {
    rawImage(req, res, (err: unknown) => {
      if (!err) return next();
      const tooBig = (err as { type?: string })?.type === "entity.too.large";
      sendError(res, tooBig ? new AppError("IMAGE_TOO_LARGE", 413, { max: "2.5 MB" }) : new AppError("IMAGE_UNREADABLE"));
    });
  },
  asyncHandler(async (req, res): Promise<void> => {
    if (isGuest(req)) throw new AppError("GUEST_READ_ONLY");
    const ctx = await setupForRead(req, res, parseId(req.query.playbookId));
    if (!ctx) return;
    const { row, v } = ctx;
    const hints = accessHints(v, row);
    if (!hints.canEdit && !hints.canAddExamples) throw new AppError("SETUP_EDITOR_ONLY");
    const body = req.body;
    const mime = Buffer.isBuffer(body) && body.length ? sniffImageMime(body) : null;
    if (!mime) throw new AppError("IMAGE_TYPE", 415);
    const { rows: quota } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM playbook_media WHERE owner = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [v.name],
    );
    if ((quota[0]?.n ?? 0) >= MEDIA_DAILY_LIMIT) throw new AppError("MEDIA_DAILY_LIMIT", undefined, { max: MEDIA_DAILY_LIMIT });
    const dim = (x: unknown) => { const n = Number(x); return Number.isInteger(n) && n > 0 && n <= 10000 ? n : null; };
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO playbook_media (playbook_id, owner, mime, bytes, size_bytes, width, height) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [row.id, v.name, mime, body, body.length, dim(req.query.w), dim(req.query.h)],
    );
    const id = rows[0]!.id;
    res.status(201).json({ id, url: `/api/playbook-media/${id}`, mime, size: body.length });
  }),
);

router.get("/playbook-media/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) throw badRequest("INVALID_ID");
  if (!req.authUser) throw unauthorized();
  await ensurePlaybookSpaces();
  const { rows } = await pool.query<any>(`SELECT playbook_id, mime, bytes, size_bytes FROM playbook_media WHERE id = $1 AND deleted_at IS NULL`, [id]);
  const m = rows[0];
  const setup = m ? await loadSetupAccess(m.playbook_id, true) : null;
  if (!m || !setup || !canReadPure(await loadViewer(req), setup)) throw notFound();
  res.setHeader("Content-Type", m.mime);
  res.setHeader("Content-Length", String(m.size_bytes));
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.end(m.bytes);
}));

router.delete("/playbook-media/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) throw badRequest("INVALID_ID");
  await ensurePlaybookSpaces();
  const v = await loadViewer(req);
  const { rows } = await pool.query<any>(`SELECT playbook_id, owner FROM playbook_media WHERE id = $1 AND deleted_at IS NULL`, [id]);
  const m = rows[0];
  if (!m) throw notFound();
  const setup = await loadSetupAccess(m.playbook_id, true);
  const ok = !v.guest && !!v.name && (m.owner === v.name || (setup ? await canEditSetupRow(req, setup) : false));
  if (!ok) throw new AppError("SETUP_EDITOR_ONLY");
  await pool.query(`UPDATE playbook_media SET deleted_at = NOW() WHERE id = $1`, [id]);
  res.json({ success: true });
}));

export default router;
