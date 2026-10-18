import { Router, type IRouter } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, pool, watchlistTable } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { calcWatchlistScore } from "../lib/scoreEngine";
import { logger } from "../lib/logger";
import { requireMember } from "../lib/auth";
import { resolveActor } from "../lib/permissions";
import { canModifyOwnedRow } from "../lib/accessRules";
import { creatorName, requireRowOwnerOrStaff } from "../lib/ownedRows";
import { nyDate } from "../lib/tradingDate";
import { AppError, badRequest, notFound, unauthorized } from "../lib/http";

const router: IRouter = Router();

/**
 * Auto-status «Торговал»: any row still «watching» whose ticker has a trade dated today (NY)
 * flips to `traded` (idempotent; never touches passed/traded rows). Returns the ids flipped.
 */
async function autoMarkTraded(): Promise<number[]> {
  try {
    const { rows } = await pool.query<{ id: number }>(
      `UPDATE watchlist w SET status = 'traded'
         WHERE w.deleted_at IS NULL AND LOWER(COALESCE(w.status, '')) IN ('watching', 'active')
           AND EXISTS (SELECT 1 FROM trades t WHERE t.deleted_at IS NULL AND UPPER(t.ticker) = UPPER(w.ticker) AND t.date = $1)
         RETURNING w.id`,
      [nyDate()],
    );
    return rows.map((r) => r.id);
  } catch (err) {
    logger.warn({ err }, "watchlist: auto-mark traded failed");
    return [];
  }
}

const STATUSES = new Set(["watching", "passed", "traded"]);
// Legacy rows were seeded with "Active"; treat it (and other casings) as "watching".
function normalizeStatus(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (s === "active") return "watching";
  return STATUSES.has(s) ? s : null;
}
function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
/** Returns an error message when a price field is present but not a non-negative number. */
/** The field name when the price is not a non-negative number, else null. */
function invalidPrice(v: unknown, label: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) && n >= 0 && n < 1e8 ? null : label;
}
function priceOrNull(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  return String(Number(String(v).replace(",", ".")));
}

/** Parses the «В игре» flag from a request body: true/false (or "true"/"false"/1/0); undefined when absent; "invalid" otherwise. */
function parseInPlay(v: unknown): boolean | undefined | "invalid" {
  if (v === undefined) return undefined;
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0" || v === null) return false;
  return "invalid";
}

type InPlayInfo = { inPlay: boolean; inPlayAt: string | null };
/**
 * Reads the team-shared in_play flag (raw SQL: the column is added by migrate.ts and is not in the drizzle schema).
 * Returns null when the column does not exist yet, so responses simply omit the field.
 */
async function readInPlay(ids: number[]): Promise<Map<number, InPlayInfo> | null> {
  if (!ids.length) return new Map();
  try {
    const { rows } = await pool.query<{ id: number; in_play: boolean; in_play_at: Date | null }>(
      `SELECT id, in_play, in_play_at FROM watchlist WHERE id = ANY($1::int[])`, [ids],
    );
    return new Map(rows.map((r) => [r.id, { inPlay: !!r.in_play, inPlayAt: r.in_play_at ? new Date(r.in_play_at).toISOString() : null }]));
  } catch (err) {
    logger.warn({ err }, "watchlist: in_play column unavailable (migrations not applied yet?)");
    return null;
  }
}
async function writeInPlay(ids: number[], inPlay: boolean): Promise<number> {
  // Keep the working list in sync: «В игре» ⇔ list «Сегодня».
  const hasList = await ensureListColumn();
  const { rowCount } = await pool.query(
    hasList
      ? `UPDATE watchlist SET in_play = $1, in_play_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
           list_name = CASE WHEN $1 THEN 'today' WHEN list_name IS NULL OR list_name = 'today' THEN 'watch' ELSE list_name END
          WHERE id = ANY($2::int[]) AND deleted_at IS NULL`
      : `UPDATE watchlist SET in_play = $1, in_play_at = CASE WHEN $1 THEN NOW() ELSE NULL END
          WHERE id = ANY($2::int[]) AND deleted_at IS NULL`,
    [inPlay, ids],
  );
  return rowCount ?? 0;
}

/**
 * Working lists of the watchlist: «Сегодня» (today), «Свинги» (swing), «Наблюдаю» (watch).
 * Stored in watchlist.list_name (added lazily, additive). Rows without a value fall back to
 * in_play ? today : watch, so the list view works for rows created before the column existed.
 */
const LISTS = new Set(["today", "swing", "watch"]);
type ListName = "today" | "swing" | "watch";
function parseList(v: unknown): ListName | undefined | "invalid" {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).trim().toLowerCase();
  return LISTS.has(s) ? (s as ListName) : "invalid";
}

let listColumn: Promise<boolean> | null = null;
/** Idempotent: ALTER TABLE … ADD COLUMN IF NOT EXISTS list_name. Resolves false (and retries next call) on failure. */
function ensureListColumn(): Promise<boolean> {
  if (!listColumn) {
    listColumn = pool
      .query(`ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS list_name TEXT`)
      .then(() => true)
      .catch((err) => {
        logger.warn({ err }, "watchlist: ensure list_name column failed");
        listColumn = null;
        return false;
      });
  }
  return listColumn;
}

async function readLists(ids: number[]): Promise<Map<number, ListName | null> | null> {
  if (!(await ensureListColumn())) return null;
  if (!ids.length) return new Map();
  try {
    const { rows } = await pool.query<{ id: number; list_name: string | null }>(
      `SELECT id, list_name FROM watchlist WHERE id = ANY($1::int[])`, [ids],
    );
    return new Map(rows.map((r) => [r.id, r.list_name && LISTS.has(r.list_name) ? (r.list_name as ListName) : null]));
  } catch (err) {
    logger.warn({ err }, "watchlist: list_name read failed");
    return null;
  }
}

/** Moves rows to a list; «Сегодня» also raises the team «В игре» flag (and leaving it clears the flag). */
async function writeList(ids: number[], list: ListName): Promise<number> {
  if (!ids.length) return 0;
  if (!(await ensureListColumn())) throw new Error("list_name column unavailable");
  let rowCount: number | null = null;
  try {
    ({ rowCount } = await pool.query(
      `UPDATE watchlist SET list_name = $1, in_play = ($1 = 'today'),
         in_play_at = CASE WHEN $1 = 'today' THEN CASE WHEN in_play THEN in_play_at ELSE NOW() END ELSE NULL END
        WHERE id = ANY($2::int[]) AND deleted_at IS NULL`,
      [list, ids],
    ));
  } catch {
    // in_play not migrated yet — the list alone still works.
    ({ rowCount } = await pool.query(
      `UPDATE watchlist SET list_name = $1 WHERE id = ANY($2::int[]) AND deleted_at IS NULL`, [list, ids],
    ));
  }
  return rowCount ?? 0;
}

async function withList<T extends { id: number; inPlay?: boolean }>(row: T): Promise<T & { list?: ListName }> {
  const m = await readLists([row.id]);
  if (!m) return row;
  return { ...row, list: m.get(row.id) ?? (row.inPlay ? "today" : "watch") };
}
async function withInPlay<T extends { id: number }>(row: T): Promise<T & Partial<InPlayInfo>> {
  const m = await readInPlay([row.id]);
  const info = m?.get(row.id);
  return info ? { ...row, ...info } : row;
}

router.get("/watchlist", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  const autoTraded = await autoMarkTraded();
  const inPlayOnly = req.query.inPlay === "1" || req.query.inPlay === "today";
  const rows = await db.select().from(watchlistTable)
    .where(isNull(watchlistTable.deletedAt))
    .orderBy(sql`COALESCE(${watchlistTable.score}, -1) DESC, ${watchlistTable.createdAt} DESC`)
    .limit(2000);
  // Additive cross-links: how many ideas / trades exist for each ticker (best-effort, never fails the list).
  const tickers = Array.from(new Set(rows.map((r) => r.ticker.toUpperCase())));
  const ideaStats = new Map<string, { count: number; last: string | null }>();
  const tradeStats = new Map<string, { count: number; last: string | null }>();
  // Open positions per ticker (result = 'open'), with who holds them — the row badge «В позиции».
  const openStats = new Map<string, { count: number; traders: string[]; ids: number[] }>();
  if (tickers.length) {
    try {
      const { rows: orows } = await pool.query<{ t: string; c: string; traders: string[] | null; ids: number[] | null }>(
        `SELECT UPPER(ticker) AS t, COUNT(*) AS c,
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT trader), NULL) AS traders,
                ARRAY_AGG(id ORDER BY id DESC) AS ids
           FROM trades WHERE deleted_at IS NULL AND LOWER(TRIM(result)) = 'open' AND UPPER(ticker) = ANY($1::text[])
           GROUP BY UPPER(ticker)`,
        [tickers],
      );
      for (const r of orows) openStats.set(r.t, { count: Number(r.c) || 0, traders: r.traders ?? [], ids: (r.ids ?? []).slice(0, 5) });
    } catch (err) { logger.warn({ err }, "watchlist list: open positions failed"); }
    try {
      const { rows: ir } = await pool.query<{ t: string; c: string; last: Date | null }>(
        `SELECT UPPER(ticker) AS t, COUNT(*) AS c, MAX(created_at) AS last
           FROM trade_ideas WHERE deleted_at IS NULL AND UPPER(ticker) = ANY($1::text[]) GROUP BY UPPER(ticker)`,
        [tickers],
      );
      for (const r of ir) ideaStats.set(r.t, { count: Number(r.c) || 0, last: r.last ? new Date(r.last).toISOString() : null });
    } catch (err) { logger.warn({ err }, "watchlist list: idea stats failed"); }
    try {
      const { rows: tr } = await pool.query<{ t: string; c: string; last: string | null }>(
        `SELECT UPPER(ticker) AS t, COUNT(*) AS c, MAX(date) AS last
           FROM trades WHERE deleted_at IS NULL AND UPPER(ticker) = ANY($1::text[]) GROUP BY UPPER(ticker)`,
        [tickers],
      );
      for (const r of tr) tradeStats.set(r.t, { count: Number(r.c) || 0, last: r.last ?? null });
    } catch (err) { logger.warn({ err }, "watchlist list: trade stats failed"); }
  }
  const inPlay = await readInPlay(rows.map((r) => r.id));
  const lists = await readLists(rows.map((r) => r.id));
  const today = nyDate();
  const out = rows.map((r) => {
    const t = r.ticker.toUpperCase();
    const ideas = ideaStats.get(t);
    const trades = tradeStats.get(t);
    const open = openStats.get(t);
    const ip = inPlay?.get(r.id);
    return {
      ...r,
      // Team-shared «В игре» flag; omitted entirely when the column is not migrated yet (clients fall back).
      ...(inPlay ? { inPlay: ip?.inPlay ?? false, inPlayAt: ip?.inPlayAt ?? null } : {}),
      // Working list (today | swing | watch); omitted when the column is unavailable (clients fall back).
      ...(lists ? { list: lists.get(r.id) ?? (ip?.inPlay ? "today" : "watch") } : {}),
      status: normalizeStatus(r.status) ?? r.status,
      ideaCount: ideas?.count ?? 0,
      lastIdeaAt: ideas?.last ?? null,
      tradeCount: trades?.count ?? 0,
      lastTradeDate: trades?.last ?? null,
      // Open-position badge (from trades with result = 'open').
      openPositions: open?.count ?? 0,
      openTraders: open?.traders ?? [],
      openTradeIds: open?.ids ?? [],
      tradedToday: trades?.last === today,
      autoTraded: autoTraded.includes(r.id),
    };
  });
  res.json(inPlayOnly ? out.filter((r) => (r as { inPlay?: boolean }).inPlay) : out);
}));

/**
 * POST /api/watchlist/bulk — { ids: number[], action: "status" | "delete" | "restore" | "inplay", status?, inPlay? }
 * Bulk status change / soft delete / restore (undo) for multi-select in the list.
 */
router.post("/watchlist/bulk", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(b.ids)
    ? Array.from(new Set(b.ids.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)))
    : [];
  if (!ids.length) throw new AppError("IDS_REQUIRED");
  if (ids.length > 200) throw new AppError("TOO_MANY", undefined, { field: "ids", max: 200 });
  const action = String(b.action ?? "");
  // Soft delete / restore remove a shared row for everyone → only rows the caller created (staff: any).
  // Workflow flags (status / inplay / list) stay open to every member (watchlist.manage). Rows the caller may
  // not touch are skipped and reported back in `denied`.
  let denied: number[] = [];
  if (action === "delete" || action === "restore") {
    const actor = await resolveActor(req);
    const owners = await db.select({ id: watchlistTable.id, createdBy: watchlistTable.createdBy }).from(watchlistTable)
      .where(inArray(watchlistTable.id, ids));
    const allowed = new Set(owners.filter((r) => canModifyOwnedRow(actor, r.createdBy)).map((r) => r.id));
    denied = ids.filter((id) => owners.some((r) => r.id === id) && !allowed.has(id));
    ids.splice(0, ids.length, ...ids.filter((id) => allowed.has(id)));
    if (!ids.length) {
      throw new AppError("NOT_OWNER", 403, undefined, { denied });
    }
  }
  if (action === "status") {
    const status = normalizeStatus(b.status);
    if (!status) throw new AppError("INVALID_FIELD", undefined, { field: "status" });
    const rows = await db.update(watchlistTable).set({ status })
      .where(and(inArray(watchlistTable.id, ids), isNull(watchlistTable.deletedAt))).returning({ id: watchlistTable.id });
    res.json({ success: true, count: rows.length });
    return;
  }
  if (action === "delete") {
    const rows = await db.update(watchlistTable).set({ deletedAt: new Date() })
      .where(and(inArray(watchlistTable.id, ids), isNull(watchlistTable.deletedAt))).returning({ id: watchlistTable.id });
    res.json({ success: true, count: rows.length, ids: rows.map((r) => r.id), denied });
    return;
  }
  if (action === "inplay") {
    const flag = parseInPlay(b.inPlay);
    if (flag === undefined || flag === "invalid") throw new AppError("INVALID_FIELD", undefined, { field: "inPlay" });
    try {
      const count = await writeInPlay(ids, flag);
      res.json({ success: true, count });
    } catch (err) {
      logger.warn({ err }, "watchlist bulk inplay failed");
      throw new AppError("NOT_AVAILABLE_YET");
    }
    return;
  }
  if (action === "restore") {
    const rows = await db.update(watchlistTable).set({ deletedAt: null })
      .where(inArray(watchlistTable.id, ids)).returning({ id: watchlistTable.id });
    res.json({ success: true, count: rows.length, denied });
    return;
  }
  if (action === "list") {
    const list = parseList(b.list);
    if (list === undefined || list === "invalid") throw new AppError("INVALID_FIELD", undefined, { field: "list" });
    try {
      const count = await writeList(ids, list);
      res.json({ success: true, count });
    } catch (err) {
      logger.warn({ err }, "watchlist bulk list failed");
      throw new AppError("NOT_AVAILABLE_YET");
    }
    return;
  }
  throw new AppError("INVALID_FIELD", undefined, { field: "action" });
}));

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,11}$/;
const QUICK_MAX = 30;

/** Scores freshly quick-added rows after the response (bounded concurrency; the engine calls external APIs). */
function scoreInBackground(rows: { id: number; ticker: string }[]): void {
  if (!rows.length) return;
  const queue = [...rows];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try {
        const result = await calcWatchlistScore({ ticker: item.ticker, catalyst: null, sector: null });
        await db.update(watchlistTable)
          .set({ score: result.total, scoreBreakdown: JSON.stringify(result), scoredAt: new Date() })
          .where(eq(watchlistTable.id, item.id));
      } catch (err) {
        logger.warn({ err, id: item.id, ticker: item.ticker }, "watchlist quick-add: background score failed");
      }
    }
  };
  void Promise.all(Array.from({ length: Math.min(2, rows.length) }, worker));
}

/**
 * POST /api/watchlist/quick — { tickers: string[] (≤30), list?: "today" | "swing" | "watch" }
 * Fast multi-add from the watchlist input (comma/space separated or a pasted list): creates the missing
 * tickers without waiting for the score (scored in the background), moves already active ones to `list`.
 * → { created: Row[], moved: { id, ticker }[], restored: number[], existing, invalid: string[] }
 */
router.post("/watchlist/quick", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(b.tickers) ? b.tickers : typeof b.tickers === "string" ? b.tickers.split(/[\s,;]+/) : [];
  const list = parseList(b.list);
  if (list === "invalid") throw new AppError("INVALID_FIELD", undefined, { field: "list" });
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const v of raw) {
    const t = String(v ?? "").trim().toUpperCase().replace(/^\$/, "");
    if (!t || seen.has(t)) continue;
    seen.add(t);
    if (TICKER_RE.test(t)) valid.push(t); else invalid.push(t.slice(0, 16));
  }
  if (!valid.length) throw new AppError("INVALID_TICKER", 400, undefined, { invalid });
  if (valid.length > QUICK_MAX) throw new AppError("TOO_MANY", undefined, { field: "tickers", max: QUICK_MAX });

  const existingRows = await db.select({ id: watchlistTable.id, ticker: watchlistTable.ticker, status: watchlistTable.status }).from(watchlistTable)
    .where(and(inArray(watchlistTable.ticker, valid), isNull(watchlistTable.deletedAt)));
  const existing = existingRows.map((r) => ({ id: r.id, ticker: r.ticker }));
  const existingSet = new Set(existing.map((r) => r.ticker.toUpperCase()));
  const toCreate = valid.filter((t) => !existingSet.has(t));
  const createdBy = toCreate.length ? await creatorName(req) : null;
  const created = toCreate.length
    ? await db.insert(watchlistTable).values(toCreate.map((ticker) => ({ ticker, status: "watching", createdBy }))).returning()
    : [];
  // Re-adding an archived («Пропустил») ticker brings it back to the working lists.
  const restored = existingRows.filter((r) => String(r.status ?? "").toLowerCase() === "passed").map((r) => r.id);
  if (restored.length) {
    await db.update(watchlistTable).set({ status: "watching" }).where(inArray(watchlistTable.id, restored));
  }
  const target: ListName = list ?? "watch";
  try {
    await writeList([...created.map((r) => r.id), ...(list ? existing.map((r) => r.id) : restored)], target);
  } catch (err) {
    logger.warn({ err }, "watchlist quick-add: list write failed (rows created without a list)");
  }
  scoreInBackground(created.map((r) => ({ id: r.id, ticker: r.ticker })));
  const inPlay = await readInPlay(created.map((r) => r.id));
  const lists = await readLists(created.map((r) => r.id));
  res.json({
    created: created.map((r) => ({
      ...r,
      ...(inPlay ? { inPlay: inPlay.get(r.id)?.inPlay ?? false, inPlayAt: inPlay.get(r.id)?.inPlayAt ?? null } : {}),
      ...(lists ? { list: lists.get(r.id) ?? target } : {}),
    })),
    moved: list ? existing : [],
    restored,
    existing,
    invalid,
  });
}));

router.post("/watchlist", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  const b = req.body as Record<string, unknown>;
  const { ticker, catalyst, targetPrice, stopPrice, status, notes, sector, tags } = b;
  if (!ticker || !String(ticker).trim()) throw badRequest("TICKER_REQUIRED");
  const tickerUp = String(ticker).trim().toUpperCase();
  if (!TICKER_RE.test(tickerUp)) throw badRequest("INVALID_TICKER");
  if (status != null && status !== "" && !normalizeStatus(status)) throw new AppError("INVALID_FIELD", undefined, { field: "status" });
  // One active row per ticker: point the client at the existing one instead of creating a duplicate.
  const [dup] = await db.select({ id: watchlistTable.id }).from(watchlistTable)
    .where(and(eq(watchlistTable.ticker, tickerUp), isNull(watchlistTable.deletedAt))).limit(1);
  if (dup) throw new AppError("ALREADY_IN_WATCHLIST", 409, { ticker: tickerUp }, { id: dup.id });
  const priceErr = invalidPrice(targetPrice, "targetPrice") ?? invalidPrice(stopPrice, "stopPrice");
  if (priceErr) throw new AppError("INVALID_FIELD", 400, { field: priceErr });
  const sectorStr = sector ? String(sector) : null;
  const catalystStr = catalyst ? String(catalyst) : null;
  const numOrNull = (v: unknown) => (v !== undefined && v !== null && v !== "" ? String(v) : null);

  let score: number | null = null;
  let scoreBreakdown: string | null = null;
  let scoredAt: Date | null = null;
  try {
    const result = await calcWatchlistScore({ ticker: tickerUp, catalyst: catalystStr, sector: sectorStr });
    score = result.total;
    scoreBreakdown = JSON.stringify(result);
    scoredAt = new Date();
  } catch (err) {
    logger.warn({ err, ticker: tickerUp }, "watchlist create: score calculation failed (will save without score)");
  }

  const [row] = await db.insert(watchlistTable).values({
    ticker: tickerUp,
    catalyst: catalystStr,
    targetPrice: priceOrNull(targetPrice),
    stopPrice: priceOrNull(stopPrice),
    status: normalizeStatus(status) ?? "watching",
    notes: notes ? String(notes) : null,
    sector: sectorStr,
    tags: tags ? String(tags) : null,
    score,
    scoreBreakdown,
    scoredAt,
    marketCap: b.marketCap ? String(b.marketCap) : null,
    float: b.float ? String(b.float) : null,
    adv: b.adv ? String(b.adv) : null,
    atr: numOrNull(b.atr),
    relativeVolume: numOrNull(b.relativeVolume),
    beta: numOrNull(b.beta),
    shortInterest: numOrNull(b.shortInterest),
    longName: b.longName ? String(b.longName) : null,
    createdBy: await creatorName(req),
  }).returning();
  const createList = parseList(b.list);
  if (createList && createList !== "invalid") {
    try { await writeList([row.id], createList); } catch (err) { logger.warn({ err, id: row.id }, "watchlist create: list write failed"); }
  } else if (parseInPlay(b.inPlay) === true) {
    try { await writeInPlay([row.id], true); } catch (err) { logger.warn({ err, id: row.id }, "watchlist create: in_play write failed"); }
  }
  res.json(await withList(await withInPlay(row)));
}));

router.patch("/watchlist/:id", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  const id = parseId(String(req.params.id));
  if (id == null) throw badRequest("INVALID_ID");
  const b = req.body as Record<string, unknown>;
  const { ticker, catalyst, targetPrice, stopPrice, status, notes, sector, tags } = b;
  if (status != null && status !== "" && !normalizeStatus(status)) throw new AppError("INVALID_FIELD", undefined, { field: "status" });
  if (ticker && String(ticker).trim()) {
    const up = String(ticker).trim().toUpperCase();
    if (!TICKER_RE.test(up)) throw badRequest("INVALID_TICKER");
    const [dup] = await db.select({ id: watchlistTable.id }).from(watchlistTable)
      .where(and(eq(watchlistTable.ticker, up), isNull(watchlistTable.deletedAt))).limit(1);
    if (dup && dup.id !== id) throw new AppError("ALREADY_IN_WATCHLIST", 409, { ticker: up }, { id: dup.id });
  }
  const priceErr = invalidPrice(targetPrice, "targetPrice") ?? invalidPrice(stopPrice, "stopPrice");
  if (priceErr) throw new AppError("INVALID_FIELD", 400, { field: priceErr });
  const inPlayFlag = parseInPlay(b.inPlay);
  if (inPlayFlag === "invalid") throw new AppError("INVALID_FIELD", undefined, { field: "inPlay" });
  const listFlag = parseList(b.list);
  if (listFlag === "invalid") throw new AppError("INVALID_FIELD", undefined, { field: "list" });
  const numOrNull = (v: unknown) => (v !== undefined && v !== null && v !== "" ? String(v) : null);
  const patch = {
    ticker: ticker && String(ticker).trim() ? String(ticker).trim().toUpperCase() : undefined,
    catalyst: catalyst !== undefined ? (catalyst ? String(catalyst) : null) : undefined,
    targetPrice: targetPrice !== undefined ? priceOrNull(targetPrice) : undefined,
    stopPrice: stopPrice !== undefined ? priceOrNull(stopPrice) : undefined,
    status: normalizeStatus(status) ?? undefined,
    notes: notes !== undefined ? (notes ? String(notes) : null) : undefined,
    sector: sector !== undefined ? (sector ? String(sector) : null) : undefined,
    tags: tags !== undefined ? (tags ? String(tags) : null) : undefined,
    ...(b.marketCap !== undefined && { marketCap: b.marketCap ? String(b.marketCap) : null }),
    ...(b.float !== undefined && { float: b.float ? String(b.float) : null }),
    ...(b.adv !== undefined && { adv: b.adv ? String(b.adv) : null }),
    ...(b.atr !== undefined && { atr: numOrNull(b.atr) }),
    ...(b.relativeVolume !== undefined && { relativeVolume: numOrNull(b.relativeVolume) }),
    ...(b.beta !== undefined && { beta: numOrNull(b.beta) }),
    ...(b.shortInterest !== undefined && { shortInterest: numOrNull(b.shortInterest) }),
    ...(b.longName !== undefined && { longName: b.longName ? String(b.longName) : null }),
  };
  const hasColumnPatch = Object.values(patch).some((v) => v !== undefined);
  // Content (ticker, catalyst, levels, notes, sector, tags, fundamentals) is the author's: owner or staff.
  // Status / list / inPlay are desk workflow flags any member may flip (watchlist.manage).
  const { status: _status, ...contentPatch } = patch;
  if (Object.values(contentPatch).some((v) => v !== undefined)) {
    const [owned] = await db.select({ createdBy: watchlistTable.createdBy }).from(watchlistTable)
      .where(and(eq(watchlistTable.id, id), isNull(watchlistTable.deletedAt)));
    if (!owned) throw notFound();
    if (!(await requireRowOwnerOrStaff(req, res, owned.createdBy))) return;
  }
  // A flag-only PATCH ({ inPlay }) must not hit drizzle with an empty SET.
  const [row] = hasColumnPatch
    ? await db.update(watchlistTable).set(patch)
      .where(and(eq(watchlistTable.id, id), isNull(watchlistTable.deletedAt))).returning()
    : await db.select().from(watchlistTable).where(and(eq(watchlistTable.id, id), isNull(watchlistTable.deletedAt)));
  if (!row) throw notFound();
  if (listFlag !== undefined) {
    try {
      await writeList([id], listFlag);
    } catch (err) {
      logger.warn({ err, id }, "watchlist patch: list write failed");
      throw new AppError("NOT_AVAILABLE_YET");
    }
  } else if (inPlayFlag !== undefined) {
    try {
      await writeInPlay([id], inPlayFlag);
    } catch (err) {
      logger.warn({ err, id }, "watchlist patch: in_play write failed");
      throw new AppError("NOT_AVAILABLE_YET");
    }
  }

  const scoreFieldsTouched =
    ticker !== undefined || catalyst !== undefined || sector !== undefined;
  if (scoreFieldsTouched) {
    try {
      const result = await calcWatchlistScore({ ticker: row.ticker, catalyst: row.catalyst, sector: row.sector });
      const [rescored] = await db.update(watchlistTable)
        .set({ score: result.total, scoreBreakdown: JSON.stringify(result), scoredAt: new Date() })
        .where(eq(watchlistTable.id, id))
        .returning();
      res.json(await withList(await withInPlay(rescored)));
      return;
    } catch (err) {
      logger.warn({ err, id, ticker: row.ticker }, "watchlist patch: auto-recalc failed (returning row without rescored values)");
    }
  }
  res.json(await withList(await withInPlay(row)));
}));

router.post("/watchlist/:id/score", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  const id = parseId(String(req.params.id));
  if (id == null) throw badRequest("INVALID_ID");
  const [item] = await db.select().from(watchlistTable)
    .where(and(eq(watchlistTable.id, id), isNull(watchlistTable.deletedAt)));
  if (!item) throw notFound();
  const result = await calcWatchlistScore({ ticker: item.ticker, catalyst: item.catalyst, sector: item.sector });
  const [updated] = await db.update(watchlistTable)
    .set({ score: result.total, scoreBreakdown: JSON.stringify(result), scoredAt: new Date() })
    .where(eq(watchlistTable.id, id))
    .returning();
  res.json({ row: updated, breakdown: result });
}));

const SCORE_ALL_MAX_ROWS = 300;
const SCORE_ALL_WORKERS = 4;
let scoreAllRunning = false;

router.post("/watchlist/score-all", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  if (scoreAllRunning) throw new AppError("SYNC_RUNNING");
  scoreAllRunning = true;
  try {
    const rows = await db.select().from(watchlistTable).where(isNull(watchlistTable.deletedAt))
      .orderBy(sql`${watchlistTable.scoredAt} ASC NULLS FIRST`).limit(SCORE_ALL_MAX_ROWS);
    let count = 0;
    const failures: { id: number; ticker: string; error: string }[] = [];
    // Bounded concurrency: 4 workers over a shared queue (the score engine hits external APIs).
    const queue = [...rows];
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          const result = await calcWatchlistScore({ ticker: item.ticker, catalyst: item.catalyst, sector: item.sector });
          await db.update(watchlistTable)
            .set({ score: result.total, scoreBreakdown: JSON.stringify(result), scoredAt: new Date() })
            .where(eq(watchlistTable.id, item.id));
          count++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ err, id: item.id, ticker: item.ticker }, "watchlist score-all: failed for one row (continuing)");
          failures.push({ id: item.id, ticker: item.ticker, error: msg });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCORE_ALL_WORKERS, rows.length) }, worker));
    res.json({ success: true, count, failed: failures.length, failures, truncated: rows.length === SCORE_ALL_MAX_ROWS });
  } finally {
    scoreAllRunning = false;
  }
}));

router.delete("/watchlist/:id", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  const id = parseId(String(req.params.id));
  if (id == null) throw badRequest("INVALID_ID");
  const [owned] = await db.select({ createdBy: watchlistTable.createdBy }).from(watchlistTable).where(eq(watchlistTable.id, id));
  if (!owned) throw notFound();
  if (!(await requireRowOwnerOrStaff(req, res, owned.createdBy))) return;
  const [row] = await db.update(watchlistTable)
    .set({ deletedAt: new Date() })
    .where(eq(watchlistTable.id, id))
    .returning();
  if (!row) throw notFound();
  res.json({ success: true });
}));

router.post("/watchlist/:id/restore", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  const id = parseId(String(req.params.id));
  if (id == null) throw badRequest("INVALID_ID");
  const [owned] = await db.select({ createdBy: watchlistTable.createdBy }).from(watchlistTable).where(eq(watchlistTable.id, id));
  if (!owned) throw notFound();
  if (!(await requireRowOwnerOrStaff(req, res, owned.createdBy))) return;
  const [row] = await db.update(watchlistTable)
    .set({ deletedAt: null })
    .where(eq(watchlistTable.id, id))
    .returning();
  if (!row) throw notFound();
  res.json({ success: true });
}));

export default router;
