import { Router, type IRouter } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { logger } from "../lib/logger";
import { requireMember, scopeTrader, GUEST_SCOPE } from "../lib/auth";
import { loadMoneyViewer } from "../lib/playbookAccess";
import { canSeeTradeMoney } from "../lib/playbookPrivacy";
import { AppError, unauthorized } from "../lib/http";

/**
 * Indicator notes + favourites ("Мой набор") per user — audit P1-6 (they lived only in localStorage).
 *
 *   GET /api/indicator-notes?user=        my notes/favourites; staff may read another member (?user=, scopeTrader)
 *       → { user, items: [{ key, note, favorite, updatedAt }] }   (rows with an empty note and favorite=false are omitted)
 *   PUT /api/indicator-notes/:key         upsert MY row: { note?: string, favorite?: boolean } (omitted field = unchanged)
 *       → { key, note, favorite, updatedAt }
 *   PUT /api/indicator-notes              bulk upsert of MY rows: { items: [{ key, note?, favorite? }], onlyIfEmpty?: boolean }
 *       onlyIfEmpty=true (one-time migration from the browser): a note is written only where the server note is empty,
 *       a favourite is only ever turned ON — never clears what the server already has.  → same shape as GET
 *
 * Clearing a note / un-starring keeps the row (note '' / favorite false) — no deletes.
 * Table is created idempotently (additive) once per process.
 */
const router: IRouter = Router();

let ensured: Promise<void> | null = null;
export function ensureIndicatorNotesTable(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `CREATE TABLE IF NOT EXISTS indicator_notes (
           user_name TEXT NOT NULL,
           key TEXT NOT NULL,
           note TEXT NOT NULL DEFAULT '',
           favorite BOOLEAN NOT NULL DEFAULT FALSE,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           PRIMARY KEY (user_name, key)
         );`,
      )
      .then(() => undefined)
      .catch((err) => {
        ensured = null;
        throw err;
      });
  }
  return ensured;
}
ensureIndicatorNotesTable().catch((err) => logger.warn({ err }, "indicator-notes: ensure table failed at init"));

const KEY_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const NOTE_MAX = 4000;
const keySchema = z.string().regex(KEY_RE);
const rowPatch = z.object({
  note: z.string().max(NOTE_MAX).optional(),
  favorite: z.boolean().optional(),
});
const bulkBody = z.object({
  items: z.array(rowPatch.extend({ key: keySchema })).max(500),
  onlyIfEmpty: z.boolean().optional(),
});

type Row = { key: string; note: string; favorite: boolean; updated_at: Date | string };
const shape = (r: Row) => ({
  key: r.key,
  note: r.note ?? "",
  favorite: !!r.favorite,
  updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
});

async function listFor(user: string) {
  const { rows } = await pool.query<Row>(
    `SELECT key, note, favorite, updated_at FROM indicator_notes
      WHERE user_name = $1 AND (favorite OR note <> '')
      ORDER BY updated_at ASC, key ASC`,
    [user],
  );
  return rows.map(shape);
}

router.get("/indicator-notes", asyncHandler(async (req, res): Promise<void> => {
  const requested = typeof req.query.user === "string" ? req.query.user : null;
  const scope = await scopeTrader(req, requested);
  if (scope === undefined) throw unauthorized();
  await ensureIndicatorNotesTable();
  const user = scope ?? req.authUser?.name ?? null;
  if (!user || user === GUEST_SCOPE) { res.json({ user: null, items: [] }); return; }
  res.json({ user, items: await listFor(user) });
}));

router.put("/indicator-notes/:key", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  const key = keySchema.safeParse(req.params.key);
  if (!key.success) throw new AppError("INVALID_FIELD", undefined, { field: "key" });
  const body = rowPatch.safeParse(req.body ?? {});
  if (!body.success) throw body.error;
  if (body.data.note === undefined && body.data.favorite === undefined) throw new AppError("FIELD_REQUIRED", undefined, { field: "note / favorite" });
  await ensureIndicatorNotesTable();
  const user = req.authUser!.name;
  const note = body.data.note === undefined ? null : body.data.note.trim();
  const fav = body.data.favorite === undefined ? null : body.data.favorite;
  const { rows } = await pool.query<Row>(
    `INSERT INTO indicator_notes (user_name, key, note, favorite, updated_at)
     VALUES ($1, $2, COALESCE($3::text, ''), COALESCE($4::boolean, FALSE), NOW())
     ON CONFLICT (user_name, key) DO UPDATE SET
       note = COALESCE($3::text, indicator_notes.note),
       favorite = COALESCE($4::boolean, indicator_notes.favorite),
       updated_at = NOW()
     RETURNING key, note, favorite, updated_at`,
    [user, key.data, note, fav],
  );
  res.json(shape(rows[0]!));
}));

router.put("/indicator-notes", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  const body = bulkBody.safeParse(req.body ?? {});
  if (!body.success) throw body.error;
  await ensureIndicatorNotesTable();
  const user = req.authUser!.name;
  const onlyIfEmpty = !!body.data.onlyIfEmpty;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const it of body.data.items) {
      const note = it.note === undefined ? null : it.note.trim();
      const fav = it.favorite === undefined ? null : it.favorite;
      if (note === null && fav === null) continue;
      if (onlyIfEmpty) {
        await client.query(
          `INSERT INTO indicator_notes (user_name, key, note, favorite, updated_at)
           VALUES ($1, $2, COALESCE($3::text, ''), COALESCE($4::boolean, FALSE), NOW())
           ON CONFLICT (user_name, key) DO UPDATE SET
             note = CASE WHEN indicator_notes.note = '' AND $3::text IS NOT NULL THEN $3::text ELSE indicator_notes.note END,
             favorite = indicator_notes.favorite OR COALESCE($4::boolean, FALSE),
             updated_at = NOW()`,
          [user, it.key, note, fav],
        );
      } else {
        await client.query(
          `INSERT INTO indicator_notes (user_name, key, note, favorite, updated_at)
           VALUES ($1, $2, COALESCE($3::text, ''), COALESCE($4::boolean, FALSE), NOW())
           ON CONFLICT (user_name, key) DO UPDATE SET
             note = COALESCE($3::text, indicator_notes.note),
             favorite = COALESCE($4::boolean, indicator_notes.favorite),
             updated_at = NOW()`,
          [user, it.key, note, fav],
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  res.json({ user, items: await listFor(user) });
}));

/**
 * GET /api/indicators/tagged-trades — the slim book behind «Индикаторы → Справочник» stats (P1-5 follow-up).
 * The page used to pull GET /api/trades?tagged=1 — every column of every tagged trade (a curator: the whole desk,
 * ~60 MB of JSON) — to read ten fields. Same rows, same scope and $ rule as GET /api/trades:
 *   - scope via scopeTrader (staff may pass ?trader=, none = whole desk; members get their own book; guests nothing);
 *   - pnl / fees are null on rows whose $ the viewer may not see (lib/playbookPrivacy canSeeTradeMoney).
 * Columnar, strings dictionary-coded:
 *   → { n, dict: string[], id[], ticker[], date[], result[], r[], pnl[], fees[], tags[], setup[], horizon[] }
 *     ticker / result / tags / setup / horizon hold indexes into `dict` (-1 = null); date is YYYY-MM-DD.
 */
router.get("/indicators/tagged-trades", asyncHandler(async (req, res): Promise<void> => {
  const requested = typeof req.query.trader === "string" ? req.query.trader : null;
  const scope = await scopeTrader(req, requested);
  if (scope === undefined) throw unauthorized();
  const params: unknown[] = [];
  let where = `deleted_at IS NULL
    AND (NULLIF(TRIM(COALESCE(setup, '')), '') IS NOT NULL OR NULLIF(TRIM(COALESCE(tags, '')), '') IS NOT NULL)`;
  if (scope !== null) { params.push(scope); where += ` AND trader = $1`; }
  const { rows } = await pool.query<{
    id: number; ticker: string; date: string; result: string; r_multiple: string | null; pnl: string | null; fees: string | null;
    tags: string | null; setup: string | null; horizon: string | null; trader: string | null;
  }>(`SELECT id, ticker, date, result, r_multiple, pnl, fees, tags, setup, horizon, trader FROM trades WHERE ${where} ORDER BY id`, params);
  const viewer = await loadMoneyViewer(req);
  const dict: string[] = [];
  const at = new Map<string, number>();
  const code = (v: string | null | undefined): number => {
    if (v == null) return -1;
    let k = at.get(v);
    if (k === undefined) { k = dict.length; dict.push(v); at.set(v, k); }
    return k;
  };
  const num = (v: string | null): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const out = {
    n: rows.length, dict,
    id: [] as number[], ticker: [] as number[], date: [] as string[], result: [] as number[], r: [] as (number | null)[],
    pnl: [] as (number | null)[], fees: [] as (number | null)[], tags: [] as number[], setup: [] as number[], horizon: [] as number[],
  };
  for (const t of rows) {
    const money = canSeeTradeMoney(viewer, t.trader);
    out.id.push(t.id);
    out.ticker.push(code(t.ticker));
    out.date.push(String(t.date ?? "").slice(0, 10));
    out.result.push(code(t.result));
    out.r.push(num(t.r_multiple));
    out.pnl.push(money ? num(t.pnl) : null);
    out.fees.push(money ? num(t.fees) : null);
    out.tags.push(code(t.tags));
    out.setup.push(code(t.setup));
    out.horizon.push(code(t.horizon));
  }
  res.json(out);
}));

export default router;
