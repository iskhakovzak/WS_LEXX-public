import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { sanitizeMultiLineUrls } from "../lib/safe-url";
import { logger } from "../lib/logger";
import { logActivity } from "../lib/activity";
import { canAccessTrade, isStaffRole, requireMember, scopeTrader, viewerRole, GUEST_SCOPE } from "../lib/auth";
import { closeDateSql, horizonSql, netPnlSql, resultSql, signedRSql } from "../lib/tradeMath";
import { nyDate } from "../lib/tradingDate";
import { loadViewer, visibleSql } from "../lib/playbookAccess";
import {
  CreateResearchBody,
  GetResearchParams,
  UpdateResearchParams,
  UpdateResearchBody,
  DeleteResearchParams,
  ListResearchResponse,
  GetResearchResponse,
  UpdateResearchResponse,
} from "@workspace/api-zod";
import { AppError, badRequest, notFound, sendError, unauthorized } from "../lib/http";

/**
 * Research notes ("Ресёрч") — patterns the desk keeps studying.
 *
 *   GET    /research?ticker&q&tag&limit&offset   member; SQL-filtered; each note carries derived evidence
 *                                                (tradeCount / winRate / sumR / netPnl from trades.pattern_id, scoped) + viewer pin
 *   POST   /research                             member; author = authUser, date = NY trading date unless given
 *   GET    /research/:id
 *   PATCH  /research/:id                         owner or staff (also {date, playbookId} lineage)
 *   DELETE /research/:id, POST /research/:id/restore
 *   GET    /research/:id/trades                  scoped trades linked via pattern_id + net stats
 *   GET    /research/:id/setups                  playbook setups promoted from the note (viewer-visible, lean)
 *   GET    /research/:id/candidates              scoped trades in the note's ticker(s) not linked to it yet (≤12)
 *   POST   /research/:id/link-trade              {tradeId, unlink?}
 *   POST   /research/:id/pin                     {pinned} — per-user pin (research_pins)
 *
 * Additive columns/tables are ensured here (never in migrate.ts).
 */
const router: IRouter = Router();

let ensured: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `ALTER TABLE research ADD COLUMN IF NOT EXISTS created_by TEXT;
         ALTER TABLE research ADD COLUMN IF NOT EXISTS date TEXT;
         ALTER TABLE research ADD COLUMN IF NOT EXISTS playbook_id INTEGER;
         CREATE TABLE IF NOT EXISTS research_pins (
           user_name TEXT NOT NULL,
           research_id INTEGER NOT NULL REFERENCES research(id) ON DELETE CASCADE,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           PRIMARY KEY (user_name, research_id)
         );
         CREATE INDEX IF NOT EXISTS research_ticker_upper_idx ON research (UPPER(ticker));`,
      )
      .then(() => undefined)
      .catch((err) => {
        ensured = null;
        throw err;
      });
  }
  return ensured;
}
ensureTables().catch((err) => logger.warn({ err }, "research: ensure tables failed at init"));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const strToNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const numToStr = (v: number | null | undefined): string | null | undefined =>
  v === undefined ? undefined : v === null ? null : String(v);
const r2 = (v: number) => Math.round(v * 100) / 100;

type ResearchRow = {
  id: number; pattern_name: string; ticker: string | null; context: string | null; market_condition: string | null;
  what_worked: string | null; what_failed: string | null; repeat_count: number | null; confidence_level: number | null;
  screenshot_url: string | null; screenshot_notes: string | null; tags: string | null; market_cap: string | null; float: string | null;
  adv: string | null; atr: string | null; relative_volume: string | null; beta: string | null; short_interest: string | null;
  sector: string | null; long_name: string | null; created_at: Date; deleted_at: Date | null; created_by: string | null;
  date: string | null; playbook_id: number | null;
  // derived (joined)
  trade_count?: string; wins?: string; losses?: string; be?: string; sum_r?: string | null; gross?: string | null; fees?: string | null; pinned?: boolean;
};

const COLS = `r.id, r.pattern_name, r.ticker, r.context, r.market_condition, r.what_worked, r.what_failed, r.repeat_count, r.confidence_level,
  r.screenshot_url, r.screenshot_notes, r.tags, r.market_cap, r.float, r.adv, r.atr, r.relative_volume, r.beta, r.short_interest,
  r.sector, r.long_name, r.created_at, r.deleted_at, r.created_by, r.date, r.playbook_id`;

/** Scoped evidence per note: trades linked via pattern_id (one math, net money). */
const EVIDENCE = (scopeParam: string) => `LEFT JOIN LATERAL (
    SELECT COUNT(*)::text AS trade_count,
           COUNT(*) FILTER (WHERE ${resultSql("t")} = 'win')::text AS wins,
           COUNT(*) FILTER (WHERE ${resultSql("t")} = 'loss')::text AS losses,
           COUNT(*) FILTER (WHERE ${resultSql("t")} = 'be')::text AS be,
           SUM(${signedRSql("t")})::text AS sum_r,
           SUM(t.pnl)::text AS gross,
           SUM(ABS(COALESCE(t.fees, 0))) FILTER (WHERE t.pnl IS NOT NULL)::text AS fees
      FROM trades t
     WHERE t.deleted_at IS NULL AND t.pattern_id = r.id AND (${scopeParam}::text IS NULL OR t.trader = ${scopeParam})
  ) ev ON TRUE`;

function serializeResearch(r: ResearchRow, viewer: string | null) {
  const base = {
    id: r.id, patternName: r.pattern_name, ticker: r.ticker, context: r.context, marketCondition: r.market_condition,
    whatWorked: r.what_worked, whatFailed: r.what_failed, repeatCount: r.repeat_count, confidenceLevel: r.confidence_level,
    screenshotUrl: r.screenshot_url, screenshotNotes: r.screenshot_notes, tags: r.tags, marketCap: r.market_cap, float: r.float,
    adv: r.adv, atr: strToNum(r.atr), relativeVolume: strToNum(r.relative_volume), beta: strToNum(r.beta),
    shortInterest: strToNum(r.short_interest), sector: r.sector, longName: r.long_name, createdAt: r.created_at.toISOString(),
  };
  const n = Number(r.trade_count ?? 0), wins = Number(r.wins ?? 0), losses = Number(r.losses ?? 0), be = Number(r.be ?? 0);
  const gross = strToNum(r.gross), fees = strToNum(r.fees);
  const decided = wins + losses;
  const evidence = {
    tradeCount: n, wins, losses, be,
    winRate: decided ? r2((wins / decided) * 100) : null,
    sumR: strToNum(r.sum_r) == null ? null : r2(strToNum(r.sum_r)!),
    grossPnl: gross == null ? null : r2(gross), fees: gross == null ? null : r2(fees ?? 0), netPnl: gross == null ? null : r2(gross - (fees ?? 0)),
  };
  // Derived confidence: manual slider until there is real evidence (≥5 decided trades), then the observed win rate.
  const derivedConfidence = decided >= 5 ? evidence.winRate : null;
  const extra = {
    createdBy: r.created_by,
    date: r.date ?? r.created_at.toISOString().slice(0, 10),
    playbookId: r.playbook_id,
    evidence,
    derivedConfidence,
    confidenceSource: derivedConfidence != null ? "trades" : "manual",
    pinned: !!r.pinned,
    viewer,
  };
  return { ...GetResearchResponse.parse(base), ...extra };
}

async function loadResearch(id: number, viewer: string | null, scope: string | null, includeDeleted = false): Promise<ResearchRow | null> {
  const { rows } = await pool.query<ResearchRow>(
    `SELECT ${COLS}, ev.*, (p.research_id IS NOT NULL) AS pinned
       FROM research r
       ${EVIDENCE("$2")}
       LEFT JOIN research_pins p ON p.research_id = r.id AND p.user_name = $3
      WHERE r.id = $1 ${includeDeleted ? "" : "AND r.deleted_at IS NULL"} LIMIT 1`,
    [id, scope, viewer],
  );
  return rows[0] ?? null;
}

async function canModify(req: Request, r: ResearchRow): Promise<boolean> {
  if (!req.authUser) return false;
  if (isStaffRole(await viewerRole(req))) return true;
  return r.created_by == null || r.created_by === req.authUser.name;
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { sendError(res, badRequest("INVALID_ID")); return null; }
  return id;
}

/** Trader scope for evidence: staff → everyone (or ?trader), trader → own, guest → nothing. */
async function evidenceScope(req: Request): Promise<string | null | undefined> {
  const scope = await scopeTrader(req, typeof req.query.trader === "string" ? req.query.trader : null);
  return scope;
}

const ListQuery = z.object({
  ticker: z.string().trim().max(12).optional(),
  q: z.string().trim().max(200).optional(),
  tag: z.string().trim().max(60).optional(),
  pinned: z.enum(["1", "true"]).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

router.get("/research", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const scope = await evidenceScope(req);
  if (scope === undefined) throw unauthorized();
  const q = ListQuery.safeParse({
    ticker: req.query.ticker || undefined, q: req.query.q || undefined, tag: req.query.tag || undefined,
    pinned: req.query.pinned || undefined, limit: req.query.limit, offset: req.query.offset,
  });
  if (!q.success) throw q.error;
  const viewer = req.authUser?.name ?? null;
  const where: string[] = ["r.deleted_at IS NULL"];
  const params: unknown[] = [scope, viewer];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (q.data.ticker) where.push(`(',' || regexp_replace(UPPER(COALESCE(r.ticker, '')), '[[:space:],;/]+', ',', 'g') || ',') LIKE ('%,' || ${p(q.data.ticker.toUpperCase())} || ',%')`);
  if (q.data.tag) where.push(`(',' || LOWER(regexp_replace(COALESCE(r.tags, ''), '\\s*,\\s*', ',', 'g')) || ',') LIKE ('%,' || ${p(q.data.tag.toLowerCase())} || ',%')`);
  if (q.data.q) {
    const like = p(`%${q.data.q}%`);
    where.push(`(r.pattern_name ILIKE ${like} OR COALESCE(r.context, '') ILIKE ${like} OR COALESCE(r.what_worked, '') ILIKE ${like}
      OR COALESCE(r.what_failed, '') ILIKE ${like} OR COALESCE(r.market_condition, '') ILIKE ${like} OR COALESCE(r.tags, '') ILIKE ${like} OR COALESCE(r.ticker, '') ILIKE ${like})`);
  }
  if (q.data.pinned) where.push(`p.research_id IS NOT NULL`);
  const limit = q.data.limit ?? 500, offset = q.data.offset ?? 0;
  const { rows } = await pool.query<ResearchRow>(
    `SELECT ${COLS}, ev.*, (p.research_id IS NOT NULL) AS pinned
       FROM research r
       ${EVIDENCE("$1")}
       LEFT JOIN research_pins p ON p.research_id = r.id AND p.user_name = $2
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(r.date, substring(r.created_at::text, 1, 10)) DESC, r.created_at DESC
      LIMIT ${p(limit)} OFFSET ${p(offset)}`,
    params,
  );
  const items = rows.map((r) => serializeResearch(r, viewer));
  ListResearchResponse.parse(items);
  res.json(items);
}));

const CreateExtra = z.object({
  date: z.string().regex(ISO_DATE).nullish(),
  playbookId: z.coerce.number().int().positive().nullish(),
});

router.post("/research", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const parsed = CreateResearchBody.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const extra = CreateExtra.safeParse(req.body);
  if (!extra.success) throw extra.error;
  const d = parsed.data;
  const name = d.patternName.trim();
  if (!name) throw new AppError("NAME_REQUIRED_GENERIC");
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO research (pattern_name, ticker, context, market_condition, what_worked, what_failed, repeat_count, confidence_level,
       screenshot_url, screenshot_notes, tags, market_cap, float, adv, atr, relative_volume, beta, short_interest, sector, long_name,
       created_by, date, playbook_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
    [
      name, d.ticker ? d.ticker.trim().toUpperCase() : null, d.context ?? null, d.marketCondition ?? null, d.whatWorked ?? null, d.whatFailed ?? null,
      d.repeatCount ?? null, d.confidenceLevel ?? null, d.screenshotUrl != null ? sanitizeMultiLineUrls(d.screenshotUrl) : null,
      d.screenshotNotes ?? null, d.tags ?? null, d.marketCap ?? null, d.float ?? null, d.adv ?? null, numToStr(d.atr) ?? null,
      numToStr(d.relativeVolume) ?? null, numToStr(d.beta) ?? null, numToStr(d.shortInterest) ?? null, d.sector ?? null, d.longName ?? null,
      req.authUser!.name, extra.data.date ?? nyDate(), extra.data.playbookId ?? null,
    ],
  );
  const scope = (await evidenceScope(req)) ?? null;
  const entry = await loadResearch(rows[0].id, req.authUser!.name, scope);
  logActivity({ action: "created", section: "research", entityId: String(rows[0].id), entityTitle: name, trader: req.authUser!.name });
  res.status(201).json(serializeResearch(entry!, req.authUser!.name));
}));

router.get("/research/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const scope = await evidenceScope(req);
  if (scope === undefined) throw unauthorized();
  const params = GetResearchParams.safeParse(req.params);
  if (!params.success) throw params.error;
  const viewer = req.authUser?.name ?? null;
  const entry = await loadResearch(params.data.id, viewer, scope);
  if (!entry) throw notFound("RESEARCH_NOT_FOUND");
  res.json(serializeResearch(entry, viewer));
}));

const PatchExtra = z.object({
  date: z.string().regex(ISO_DATE).nullish(),
  playbookId: z.coerce.number().int().positive().nullish(),
});

const COL: Record<string, string> = {
  patternName: "pattern_name", ticker: "ticker", context: "context", marketCondition: "market_condition", whatWorked: "what_worked",
  whatFailed: "what_failed", repeatCount: "repeat_count", confidenceLevel: "confidence_level", screenshotUrl: "screenshot_url",
  screenshotNotes: "screenshot_notes", tags: "tags", marketCap: "market_cap", float: "float", adv: "adv", atr: "atr",
  relativeVolume: "relative_volume", beta: "beta", shortInterest: "short_interest", sector: "sector", longName: "long_name",
  date: "date", playbookId: "playbook_id",
};

router.patch("/research/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const params = UpdateResearchParams.safeParse(req.params);
  if (!params.success) throw params.error;
  const parsed = UpdateResearchBody.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const extra = PatchExtra.safeParse(req.body);
  if (!extra.success) throw extra.error;
  const viewer = req.authUser!.name;
  const scope = (await evidenceScope(req)) ?? null;
  const existing = await loadResearch(params.data.id, viewer, scope);
  if (!existing) throw notFound("RESEARCH_NOT_FOUND");
  if (!(await canModify(req, existing))) throw new AppError("AUTHOR_OR_STAFF_ONLY");
  const d = parsed.data;
  const patch: Record<string, unknown> = {
    ...d,
    patternName: d.patternName != null ? d.patternName.trim() : undefined,
    ticker: d.ticker !== undefined ? (d.ticker ? d.ticker.trim().toUpperCase() : null) : undefined,
    atr: numToStr(d.atr), relativeVolume: numToStr(d.relativeVolume), beta: numToStr(d.beta), shortInterest: numToStr(d.shortInterest),
    screenshotUrl: d.screenshotUrl !== undefined ? sanitizeMultiLineUrls(d.screenshotUrl) : undefined,
    date: extra.data.date !== undefined ? extra.data.date : undefined,
    playbookId: extra.data.playbookId !== undefined ? extra.data.playbookId : undefined,
  };
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !COL[k]) continue;
    vals.push(v);
    sets.push(`${COL[k]} = $${vals.length}`);
  }
  if (sets.length) {
    vals.push(existing.id);
    await pool.query(`UPDATE research SET ${sets.join(", ")} WHERE id = $${vals.length} AND deleted_at IS NULL`, vals);
  }
  const entry = await loadResearch(existing.id, viewer, scope);
  if (!entry) throw notFound("RESEARCH_NOT_FOUND");
  logActivity({ action: extra.data.playbookId ? "promoted" : "updated", section: "research", entityId: String(entry.id), entityTitle: entry.pattern_name, trader: viewer, details: extra.data.playbookId ? `playbook #${extra.data.playbookId}` : undefined });
  const out = serializeResearch(entry, viewer);
  UpdateResearchResponse.parse(out);
  res.json(out);
}));

router.delete("/research/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const params = DeleteResearchParams.safeParse(req.params);
  if (!params.success) throw params.error;
  const existing = await loadResearch(params.data.id, req.authUser!.name, GUEST_SCOPE);
  if (!existing) throw notFound("RESEARCH_NOT_FOUND");
  if (!(await canModify(req, existing))) throw new AppError("AUTHOR_OR_STAFF_ONLY");
  await pool.query(`UPDATE research SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`, [existing.id]);
  logActivity({ action: "deleted", section: "research", entityId: String(existing.id), entityTitle: existing.pattern_name, trader: req.authUser!.name });
  res.sendStatus(204);
}));

router.post("/research/:id/restore", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const id = parseId(req, res); if (id == null) return;
  const existing = await loadResearch(id, req.authUser!.name, GUEST_SCOPE, true);
  if (!existing || !existing.deleted_at) throw notFound("RESEARCH_NOT_FOUND");
  if (!(await canModify(req, existing))) throw new AppError("AUTHOR_OR_STAFF_ONLY");
  await pool.query(`UPDATE research SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL`, [id]);
  logActivity({ action: "restored", section: "research", entityId: String(id), entityTitle: existing.pattern_name, trader: req.authUser!.name });
  res.json({ success: true });
}));

// ─── Evidence: linked trades ───────────────────────────────────────────────

const TRADE_SELECT = `t.id, t.ticker, t.date, t.exit_date, ${closeDateSql("t")} AS close_date, t.side, t.setup, t.result,
  ${horizonSql("t")} AS horizon, t.pnl, t.fees, ${netPnlSql("t")} AS net_pnl, t.r_multiple, ${signedRSql("t")} AS signed_r,
  ${resultSql("t")} AS res, t.trader, t.source, t.broker_account, t.qty, t.pattern_id`;

router.get("/research/:id/trades", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const id = parseId(req, res); if (id == null) return;
  const scope = await evidenceScope(req);
  if (scope === undefined) throw unauthorized();
  const { rows: exists } = await pool.query(`SELECT 1 FROM research WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!exists.length) throw notFound("RESEARCH_NOT_FOUND");
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT ${TRADE_SELECT} FROM trades t
      WHERE t.deleted_at IS NULL AND t.pattern_id = $1 AND ($2::text IS NULL OR t.trader = $2)
      ORDER BY ${closeDateSql("t")} DESC, t.id DESC LIMIT 200`,
    [id, scope],
  );
  let wins = 0, losses = 0, be = 0, open = 0, sumR = 0, hasR = false, gross = 0, fees = 0, hasPnl = false;
  const trades = rows.map((r) => {
    const resv = String(r.res ?? "");
    if (resv === "win") wins++; else if (resv === "loss") losses++; else if (resv === "be") be++; else if (resv === "open") open++;
    const sr = strToNum(r.signed_r); if (sr != null) { sumR += sr; hasR = true; }
    const pnl = strToNum(r.pnl); if (pnl != null) { gross += pnl; fees += Math.abs(strToNum(r.fees) ?? 0); hasPnl = true; }
    return {
      id: Number(r.id), ticker: String(r.ticker ?? ""), date: String(r.date ?? "").slice(0, 10), exitDate: r.exit_date ? String(r.exit_date) : null,
      closeDate: String(r.close_date ?? "").slice(0, 10), side: (r.side as string | null) ?? null, setup: (r.setup as string | null) ?? null,
      result: (r.result as string | null) ?? null, horizon: String(r.horizon ?? "intraday"), pnl, fees: strToNum(r.fees), netPnl: strToNum(r.net_pnl),
      rMultiple: strToNum(r.r_multiple), signedR: sr, trader: (r.trader as string | null) ?? null, source: (r.source as string | null) ?? null,
      brokerAccount: (r.broker_account as string | null) ?? null, qty: strToNum(r.qty), linked: true,
    };
  });
  const decided = wins + losses;
  res.json({
    scope, trades,
    stats: {
      n: rows.length, wins, losses, be, open, winRate: decided ? r2((wins / decided) * 100) : null, sumR: hasR ? r2(sumR) : null,
      grossPnl: hasPnl ? r2(gross) : null, fees: hasPnl ? r2(fees) : null, netPnl: hasPnl ? r2(gross - fees) : null,
    },
  });
}));

/**
 * Playbook setups promoted from this note (source_type = 'research', or the note's own playbook_id), limited to what
 * the viewer may read. The note preview used to load the whole /playbook list (~300 KB) just for this lookup.
 */
router.get("/research/:id/setups", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const id = parseId(req, res); if (id == null) return;
  const { rows: exists } = await pool.query<{ playbook_id: number | null }>(`SELECT playbook_id FROM research WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!exists.length) throw notFound("RESEARCH_NOT_FOUND");
  const params: unknown[] = [id, exists[0].playbook_id];
  const vis = visibleSql(await loadViewer(req), params, "p");
  const { rows } = await pool.query<{ id: number; name: string; folder: string | null; source_type: string | null; source_id: number | null }>(
    `SELECT p.id, p.name, p.folder, p.source_type, p.source_id
       FROM playbook p
      WHERE p.deleted_at IS NULL AND ((p.source_type = 'research' AND p.source_id = $1) OR p.id = $2::int) AND ${vis}
      ORDER BY p.created_at ASC LIMIT 20`,
    params,
  );
  res.json(rows.map((r) => ({ id: r.id, name: r.name, folder: r.folder, sourceType: r.source_type, sourceId: r.source_id })));
}));

/**
 * Trades the viewer could link to this note: same ticker(s), not linked to this note yet, newest first (scoped like
 * /research/:id/trades — a trader sees only their own). Saves looking up trade IDs in the journal.
 */
router.get("/research/:id/candidates", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  const id = parseId(req, res); if (id == null) return;
  const scope = await evidenceScope(req);
  if (scope === undefined) throw unauthorized();
  if (scope === GUEST_SCOPE) { res.json([]); return; }
  const { rows: exists } = await pool.query<{ ticker: string | null }>(`SELECT ticker FROM research WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!exists.length) throw notFound("RESEARCH_NOT_FOUND");
  const tickers = [...new Set((exists[0].ticker ?? "").toUpperCase().split(/[\s,;/]+/).map((t) => t.trim()).filter((t) => /^[A-Z][A-Z0-9.\-]{0,11}$/.test(t)))];
  if (!tickers.length) { res.json([]); return; }
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT ${TRADE_SELECT} FROM trades t
      WHERE t.deleted_at IS NULL AND UPPER(t.ticker) = ANY($1::text[]) AND t.pattern_id IS DISTINCT FROM $2
        AND ($3::text IS NULL OR t.trader = $3)
      ORDER BY ${closeDateSql("t")} DESC, t.id DESC LIMIT 12`,
    [tickers, id, scope],
  );
  res.json(rows.map((r) => ({
    id: Number(r.id), ticker: String(r.ticker ?? ""), date: String(r.date ?? "").slice(0, 10), side: (r.side as string | null) ?? null,
    setup: (r.setup as string | null) ?? null, result: (r.result as string | null) ?? null, netPnl: strToNum(r.net_pnl),
    signedR: strToNum(r.signed_r), trader: (r.trader as string | null) ?? null, patternId: r.pattern_id == null ? null : Number(r.pattern_id),
  })));
}));

const LinkBody = z.object({ tradeId: z.coerce.number().int().positive(), unlink: z.coerce.boolean().optional() });

router.post("/research/:id/link-trade", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const id = parseId(req, res); if (id == null) return;
  const body = LinkBody.safeParse(req.body);
  if (!body.success) throw new AppError("FIELD_REQUIRED", undefined, { field: "tradeId" });
  const { rows: exists } = await pool.query<{ pattern_name: string }>(`SELECT pattern_name FROM research WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!exists.length) throw notFound("RESEARCH_NOT_FOUND");
  const access = await canAccessTrade(req, body.data.tradeId);
  if (access === null) throw notFound("TRADE_NOT_FOUND");
  if (!access) throw new AppError("OWN_TRADES_ONLY");
  await pool.query(`UPDATE trades SET pattern_id = $1 WHERE id = $2 AND deleted_at IS NULL`, [body.data.unlink ? null : id, body.data.tradeId]);
  logActivity({ action: body.data.unlink ? "unlinked" : "linked", section: "research", entityId: String(id), entityTitle: exists[0].pattern_name, trader: req.authUser!.name, details: `trade #${body.data.tradeId}` });
  res.json({ success: true, patternId: body.data.unlink ? null : id, tradeId: body.data.tradeId });
}));

const PinBody = z.object({ pinned: z.coerce.boolean() });

router.post("/research/:id/pin", asyncHandler(async (req, res): Promise<void> => {
  await ensureTables();
  if (!requireMember(req, res)) return;
  const id = parseId(req, res); if (id == null) return;
  const body = PinBody.safeParse(req.body);
  if (!body.success) throw new AppError("INVALID_FIELD", undefined, { field: "pinned" });
  const { rows: exists } = await pool.query(`SELECT 1 FROM research WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!exists.length) throw notFound("RESEARCH_NOT_FOUND");
  if (body.data.pinned) {
    await pool.query(`INSERT INTO research_pins (user_name, research_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.authUser!.name, id]);
  } else {
    await pool.query(`DELETE FROM research_pins WHERE user_name = $1 AND research_id = $2`, [req.authUser!.name, id]);
  }
  res.json({ id, pinned: body.data.pinned });
}));

export default router;
