import { Router, type IRouter, type Request } from "express";
import { eq } from "drizzle-orm";
import { db, pool, tradingErrorsTable } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { can } from "../lib/permissions";
import { ensureRulesSchema } from "../lib/rulesEngine";
import { closeDateSql, netPnlSql, resultSql, signedRSql } from "../lib/tradeMath";
import { addDays, nyDate } from "../lib/tradingDate";
import { AppError, badRequest, forbidden, notFound, unauthorized } from "../lib/http";

const router: IRouter = Router();

// ─── Ownership ────────────────────────────────────────────────────────────────
// The mistake log is personal. The trader is always taken from the logged-in user;
// curators/admins may act on behalf of a trader by passing `trader` (query or body).

type Scope = { ok: true; trader: string | null; staff: boolean };

// errors.manage.team (permissions matrix, DB role) = act on other traders' mistakes.
async function resolveScope(req: Request, claimed: unknown, opts: { allowAll?: boolean } = {}): Promise<Scope> {
  const auth = req.authUser;
  if (!auth) throw unauthorized();
  const claimedName = typeof claimed === "string" && claimed.trim() ? claimed.trim() : null;
  const staff = await can(req, "errors.manage.team", claimedName && claimedName !== auth.name ? { trader: claimedName } : undefined);
  if (staff) return { ok: true, trader: claimedName ?? (opts.allowAll ? null : auth.name), staff };
  if (claimedName && claimedName !== auth.name) {
    throw new AppError("MISTAKES_OWN_ONLY");
  }
  return { ok: true, trader: auth.name, staff };
}

async function canTouch(req: Request, owner: string | null | undefined): Promise<boolean> {
  const auth = req.authUser;
  if (!auth) return false;
  if (!!owner && owner === auth.name) return true;
  return can(req, "errors.manage.team", owner ? { trader: owner } : undefined);
}

const VALID_SEVERITIES = ["low", "medium", "high", "critical"];
const VALID_RESOLVED = ["yes", "no"];
const MAX_TYPE = 80;
const MAX_TEXT = 4000;

function cleanTicker(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toUpperCase();
  return t ? t.slice(0, 12) : null;
}

/** Returns the trade's ticker if the trade exists and belongs to `trader`, else null. */
async function ownedTrade(tradeId: number, trader: string): Promise<{ ticker: string } | null> {
  const { rows } = await pool.query<any>(
    `SELECT ticker FROM trades WHERE id = $1 AND trader = $2 AND deleted_at IS NULL`,
    [tradeId, trader],
  );
  return rows[0] ?? null;
}

const ERROR_SELECT = `
  SELECT e.id, e.trader, e.error_type AS "errorType", e.description,
         COALESCE(e.ticker, t.ticker) AS ticker, e.trade_id AS "tradeId",
         e.severity, e.lesson, e.resolved, e.created_at AS "createdAt",
         t.date AS "tradeDate", ${closeDateSql()} AS "tradeCloseDate", ${resultSql()} AS "tradeResult",
         ${signedRSql()}::float AS "tradeR", t.pnl::float AS "tradePnl", ${netPnlSql()}::float AS "tradeNetPnl",
         t.side AS "tradeSide"
    FROM trading_errors e
    LEFT JOIN trades t ON t.id = e.trade_id`;

function serialize(r: any) {
  return { ...r, createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt };
}

async function loadOne(id: number) {
  const { rows } = await pool.query<any>(`${ERROR_SELECT} WHERE e.id = $1`, [id]);
  return rows[0] ? serialize(rows[0]) : null;
}

router.get("/errors", asyncHandler(async (req, res): Promise<void> => {
  const scope = await resolveScope(req, req.query.trader, { allowAll: true });
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 1000) : 300;
  const params: unknown[] = [];
  let sql = ERROR_SELECT;
  if (scope.trader) { sql += ` WHERE e.trader = $1`; params.push(scope.trader); }
  sql += ` ORDER BY e.created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);
  const { rows } = await pool.query<any>(sql, params);
  res.json(rows.map(serialize));
}));

router.post("/errors", asyncHandler(async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const scope = await resolveScope(req, body.trader);
  const trader = scope.trader!;

  const errorType = typeof body.errorType === "string" ? body.errorType.trim() : "";
  if (!errorType) throw new AppError("INVALID_FIELD", undefined, { field: "errorType" });
  if (errorType.length > MAX_TYPE) throw new AppError("TEXT_TOO_LONG", 400, { field: "errorType", max: MAX_TYPE });
  const description = typeof body.description === "string" && body.description.trim() ? body.description.trim() : errorType;
  if (description.length > MAX_TEXT) throw new AppError("TEXT_TOO_LONG", undefined, { field: "description", max: MAX_TEXT });
  const severity = body.severity === undefined || body.severity === null || body.severity === "" ? "medium" : String(body.severity);
  if (!VALID_SEVERITIES.includes(severity)) throw new AppError("INVALID_FIELD", undefined, { field: "severity" });
  const lesson = typeof body.lesson === "string" && body.lesson.trim() ? body.lesson.trim().slice(0, MAX_TEXT) : null;

  let tradeId: number | null = null;
  let ticker = cleanTicker(body.ticker);
  if (body.tradeId !== undefined && body.tradeId !== null && body.tradeId !== "") {
    const tid = Number(body.tradeId);
    if (!Number.isInteger(tid) || tid <= 0) throw badRequest("INVALID_ID");
    const trade = await ownedTrade(tid, trader);
    if (!trade) throw new AppError("TRADE_NOT_OWNED");
    tradeId = tid;
    ticker = ticker ?? trade.ticker;
  }

  const [row] = await db.insert(tradingErrorsTable).values({
    trader, errorType, description, ticker, tradeId, severity, lesson,
  }).returning({ id: tradingErrorsTable.id });
  res.status(201).json(await loadOne(row.id));
}));

router.patch("/errors/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const [existing] = await db.select({ trader: tradingErrorsTable.trader }).from(tradingErrorsTable).where(eq(tradingErrorsTable.id, id));
  if (!existing) throw notFound();
  if (!(await canTouch(req, existing.trader))) throw new AppError("MISTAKE_EDIT_OWN_ONLY");

  const updates: Partial<typeof tradingErrorsTable.$inferInsert> = {};
  const body = (req.body ?? {}) as Record<string, any>;
  if (body.resolved !== undefined) {
    if (!VALID_RESOLVED.includes(body.resolved)) throw new AppError("INVALID_FIELD", undefined, { field: "resolved" });
    updates.resolved = body.resolved;
  }
  if (body.lesson !== undefined) {
    updates.lesson = typeof body.lesson === "string" && body.lesson.trim() ? body.lesson.trim().slice(0, MAX_TEXT) : null;
  }
  if (body.severity !== undefined) {
    if (!VALID_SEVERITIES.includes(body.severity)) throw new AppError("INVALID_FIELD", undefined, { field: "severity" });
    updates.severity = body.severity;
  }
  if (body.description !== undefined) {
    const d = String(body.description ?? "").trim();
    if (!d) throw new AppError("DESCRIPTION_REQUIRED");
    updates.description = d.slice(0, MAX_TEXT);
  }
  if (body.errorType !== undefined) {
    const t = String(body.errorType ?? "").trim();
    if (!t || t.length > MAX_TYPE) throw new AppError("INVALID_FIELD", undefined, { field: "errorType" });
    updates.errorType = t;
  }
  if (body.ticker !== undefined) updates.ticker = cleanTicker(body.ticker);
  if (body.tradeId !== undefined) {
    if (body.tradeId === null || body.tradeId === "") {
      updates.tradeId = null;
    } else {
      const tid = Number(body.tradeId);
      if (!Number.isInteger(tid) || tid <= 0) throw badRequest("INVALID_ID");
      const trade = await ownedTrade(tid, existing.trader);
      if (!trade) throw new AppError("TRADE_NOT_OWNED");
      updates.tradeId = tid;
      if (body.ticker === undefined) updates.ticker = trade.ticker;
    }
  }
  if (Object.keys(updates).length === 0) throw badRequest("NO_FIELDS");
  await db.update(tradingErrorsTable).set(updates).where(eq(tradingErrorsTable.id, id));
  res.json(await loadOne(id));
}));

/**
 * Removing a mistake never loses it: the row is archived (trading_errors_archive) and then removed from the live table,
 * so every other reader (dashboard, scaling, weekly review…) stops counting it. Undo: POST /errors/:id/restore.
 */
router.delete("/errors/:id", asyncHandler(async (req, res): Promise<void> => {
  await ensureRulesSchema();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const { rows: existing } = await pool.query<any>(`SELECT * FROM trading_errors WHERE id = $1`, [id]);
  if (!existing[0]) throw notFound();
  if (!(await canTouch(req, existing[0].trader))) throw new AppError("MISTAKE_DELETE_OWN_ONLY");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO trading_errors_archive (original_id, trader, payload, archived_by) VALUES ($1, $2, $3, $4)`,
      [id, existing[0].trader, existing[0], req.authUser?.name ?? null],
    );
    await client.query(`DELETE FROM trading_errors WHERE id = $1`, [id]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true, archived: true });
}));

/** Undo a removal: re-inserts the archived row with its original id. */
router.post("/errors/:id/restore", asyncHandler(async (req, res): Promise<void> => {
  await ensureRulesSchema();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const { rows } = await pool.query<any>(
    `SELECT id, trader, payload FROM trading_errors_archive WHERE original_id = $1 AND restored_at IS NULL ORDER BY archived_at DESC LIMIT 1`,
    [id],
  );
  const a = rows[0];
  if (!a) throw notFound();
  if (!(await canTouch(req, a.trader))) throw forbidden();
  const p = a.payload ?? {};
  await pool.query(
    `INSERT INTO trading_errors (id, trader, error_type, description, ticker, trade_id, severity, lesson, resolved, created_at)
     VALUES ($1, $2, $3, $4, $5, (SELECT id FROM trades WHERE id = $6), $7, $8, $9, COALESCE($10::timestamptz, NOW()))
     ON CONFLICT (id) DO NOTHING`,
    [id, a.trader, p.error_type, p.description ?? p.error_type, p.ticker ?? null, p.trade_id ?? null, p.severity ?? "medium", p.lesson ?? null, p.resolved ?? "no", p.created_at ?? null],
  );
  await pool.query(`UPDATE trading_errors_archive SET restored_at = NOW() WHERE id = $1`, [a.id]);
  res.json(await loadOne(id));
}));

/**
 * Quick tagging: one category for several trades at once.
 *   POST /errors/bulk { trader?, errorType, tradeIds: number[], severity?, lesson? } → { created: Mistake[], skipped: number[] }
 * Trades that already carry this category are skipped (idempotent).
 */
router.post("/errors/bulk", asyncHandler(async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const scope = await resolveScope(req, body.trader);
  const trader = scope.trader!;
  const errorType = typeof body.errorType === "string" ? body.errorType.trim() : "";
  if (!errorType || errorType.length > MAX_TYPE) throw new AppError("INVALID_FIELD", undefined, { field: "errorType" });
  const severity = body.severity == null || body.severity === "" ? "medium" : String(body.severity);
  if (!VALID_SEVERITIES.includes(severity)) throw new AppError("INVALID_FIELD", undefined, { field: "severity" });
  const lesson = typeof body.lesson === "string" && body.lesson.trim() ? body.lesson.trim().slice(0, MAX_TEXT) : null;
  const ids = Array.isArray(body.tradeIds) ? [...new Set(body.tradeIds.map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 200) : [];
  if (!ids.length) throw new AppError("TRADE_IDS_REQUIRED");
  const { rows: trades } = await pool.query<any>(
    `SELECT t.id, t.ticker FROM trades t
      WHERE t.id = ANY($1::int[]) AND t.trader = $2 AND t.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM trading_errors e WHERE e.trade_id = t.id AND e.error_type = $3)`,
    [ids, trader, errorType],
  );
  const created: unknown[] = [];
  for (const t of trades) {
    const [row] = await db.insert(tradingErrorsTable).values({
      trader, errorType, description: errorType, ticker: t.ticker ?? null, tradeId: Number(t.id), severity, lesson,
    }).returning({ id: tradingErrorsTable.id });
    created.push(await loadOne(row.id));
  }
  const done = new Set(trades.map((t: any) => Number(t.id)));
  res.status(201).json({ created, skipped: ids.filter((x) => !done.has(x)) });
}));

/**
 * Top mistakes by $ for a period + losing trades without a tag (for quick tagging).
 *   GET /errors/summary?trader&days=90 | from&to
 * Day of a mistake = the trade's realised New York day (or the record's day without a trade). Money is NET; a trade
 * tagged with several categories counts in each category but once in the totals.
 */
router.get("/errors/summary", asyncHandler(async (req, res): Promise<void> => {
  const scope = await resolveScope(req, req.query.trader);
  const trader = scope.trader!;
  const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const to = isDay(req.query.to) ? req.query.to : nyDate();
  const rawDays = Number(req.query.days);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(Math.floor(rawDays), 730) : 90;
  const from = isDay(req.query.from) ? req.query.from : addDays(to, -days);
  const dayExpr = `COALESCE(${closeDateSql()}, to_char(e.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD'))`;

  const { rows } = await pool.query<any>(
    `SELECT e.id, e.error_type, e.severity, e.resolved, e.trade_id, ${dayExpr} AS day, ${netPnlSql()}::float AS net
       FROM trading_errors e LEFT JOIN trades t ON t.id = e.trade_id AND t.deleted_at IS NULL
      WHERE e.trader = $1 AND ${dayExpr} >= $2 AND ${dayExpr} <= $3`,
    [trader, from, to],
  );
  type Agg = { type: string; count: number; tradeIds: Set<number>; net: number; netTrades: number; lastDay: string | null; open: number; severe: number };
  const by = new Map<string, Agg>();
  const tradeNet = new Map<number, number>();
  for (const r of rows) {
    const a = by.get(r.error_type) ?? { type: r.error_type, count: 0, tradeIds: new Set<number>(), net: 0, netTrades: 0, lastDay: null, open: 0, severe: 0 };
    a.count++;
    if (r.resolved !== "yes") a.open++;
    if (r.severity === "high" || r.severity === "critical") a.severe++;
    if (!a.lastDay || r.day > a.lastDay) a.lastDay = r.day;
    if (r.trade_id != null && !a.tradeIds.has(Number(r.trade_id))) {
      a.tradeIds.add(Number(r.trade_id));
      if (r.net != null) { a.net += Number(r.net); a.netTrades++; tradeNet.set(Number(r.trade_id), Number(r.net)); }
    }
    by.set(r.error_type, a);
  }
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const byType = [...by.values()]
    .map((a) => ({ type: a.type, count: a.count, trades: a.tradeIds.size, net: r2(a.net), avgNet: a.netTrades ? r2(a.net / a.netTrades) : null, lastDay: a.lastDay, open: a.open, severe: a.severe }))
    .sort((x, y) => x.net - y.net || y.count - x.count);
  let taggedNet = 0;
  for (const v of tradeNet.values()) taggedNet += v;

  const { rows: untagged } = await pool.query<any>(
    `SELECT t.id, t.ticker, t.side, ${closeDateSql()} AS day, ${netPnlSql()}::float AS net, t.qty::float AS qty,
            t.context_snapshot->>'openedAt' AS "openedAt"
       FROM trades t
      WHERE t.trader = $1 AND t.deleted_at IS NULL AND ${closeDateSql()} >= $2 AND ${closeDateSql()} <= $3
        AND ${netPnlSql()} < 0
        AND NOT EXISTS (SELECT 1 FROM trading_errors e WHERE e.trade_id = t.id)
      ORDER BY ${netPnlSql()} ASC, t.id DESC
      LIMIT 12`,
    [trader, from, to],
  );
  const { rows: lossRow } = await pool.query<any>(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(${netPnlSql()}), 0)::float AS net FROM trades t
      WHERE t.trader = $1 AND t.deleted_at IS NULL AND ${closeDateSql()} >= $2 AND ${closeDateSql()} <= $3 AND ${netPnlSql()} < 0`,
    [trader, from, to],
  );
  res.json({
    trader, from, to,
    totals: { mistakes: rows.length, trades: tradeNet.size, net: r2(taggedNet), losingTrades: lossRow[0]?.n ?? 0, losingNet: r2(Number(lossRow[0]?.net ?? 0)) },
    byType,
    untagged: untagged.map((t: any) => ({
      id: Number(t.id), ticker: t.ticker, side: t.side ?? null, day: t.day, net: t.net == null ? null : Number(t.net),
      qty: t.qty == null ? null : Number(t.qty), time: typeof t.openedAt === "string" && t.openedAt.length >= 16 ? t.openedAt.slice(11, 16) : null,
    })),
  });
}));

router.get("/errors/stats", asyncHandler(async (req, res): Promise<void> => {
  const scope = await resolveScope(req, req.query.trader, { allowAll: true });
  const params: unknown[] = [];
  let where = "";
  if (scope.trader) { params.push(scope.trader); where = `WHERE trader = $1`; }
  const { rows } = await pool.query<any>(
    `SELECT error_type, severity, resolved, COUNT(*)::int AS n FROM trading_errors ${where} GROUP BY error_type, severity, resolved`,
    params,
  );
  let total = 0;
  let resolved = 0;
  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const r of rows) {
    total += r.n;
    if (r.resolved === "yes") resolved += r.n;
    byType[r.error_type] = (byType[r.error_type] || 0) + r.n;
    bySeverity[r.severity] = (bySeverity[r.severity] || 0) + r.n;
  }
  const topErrors = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 5);
  res.json({ total, resolved, unresolved: total - resolved, byType, bySeverity, topErrors });
}));

export default router;
