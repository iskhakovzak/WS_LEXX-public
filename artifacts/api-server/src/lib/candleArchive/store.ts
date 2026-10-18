/**
 * Candle archive — SQL (candle_archive, candle_archive_misses, plus read-only candles_cache / trades / playbook /
 * ideas / simulator lookups). No provider calls here; logic lives in service.ts.
 */
import { pool } from "@workspace/db";
import { cleanCandles } from "../candleClean";
import { decodeBars, type Bar } from "./codec";
import { TF_SEC, isArchiveTf, type ArchiveTf, type DayStats, type SymbolDay } from "./days";

export type ArchivedDay = {
  symbol: string;
  day: string;
  tf: ArchiveTf;
  extended: boolean;
  bars: Bar[];
  source: "yahoo" | "cache";
  fetchedAt: string;
  prevClose: number | null;
  /** Strong validator for HTTP caching: the row never changes once written. */
  etag: string;
};

export type NewArchiveRow = {
  symbol: string;
  day: string;
  tf: ArchiveTf;
  enc: number;
  extended: boolean;
  barCount: number;
  payload: Buffer;
  source: "yahoo" | "cache";
  fetchedAt: Date;
  stats: DayStats;
  prevClose: number | null;
};

const num = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

type ArchiveDbRow = {
  symbol: string; day: string; tf: string; enc: number; extended: boolean; payload: Buffer; source: string;
  fetched_at: Date | string; prev_close: string | number | null; id: number;
};

function toArchivedDay(r: ArchiveDbRow): ArchivedDay | null {
  if (!isArchiveTf(r.tf)) return null;
  const { bars } = decodeBars(r.payload);
  const fetchedAt = new Date(r.fetched_at).toISOString();
  return {
    symbol: r.symbol, day: r.day, tf: r.tf, extended: r.extended, bars,
    source: r.source === "cache" ? "cache" : "yahoo", fetchedAt, prevClose: num(r.prev_close),
    etag: `"ca${r.enc}-${r.id}-${r.tf}-${Date.parse(fetchedAt).toString(36)}"`,
  };
}

/** The finest archived timeframe of each requested day of one symbol (decoded). */
export async function getArchivedDays(symbol: string, days: readonly string[]): Promise<Map<string, ArchivedDay>> {
  const out = new Map<string, ArchivedDay>();
  if (!days.length) return out;
  const { rows } = await pool.query<ArchiveDbRow>(
    `SELECT DISTINCT ON (day) id, symbol, day::text AS day, tf, enc, extended, payload, source, fetched_at, prev_close
       FROM candle_archive
      WHERE symbol = $1 AND day = ANY($2::date[])
      ORDER BY day, CASE tf WHEN '1m' THEN 1 WHEN '5m' THEN 2 WHEN '15m' THEN 3 WHEN '30m' THEN 4 ELSE 5 END, extended DESC`,
    [symbol, days],
  );
  for (const r of rows) {
    const d = toArchivedDay(r);
    if (d) out.set(d.day, d);
  }
  return out;
}

/** Finest archived timeframe per day, without decoding (interval pickers). */
export async function archivedTfs(symbol: string, days: readonly string[]): Promise<Map<string, { tf: ArchiveTf; extended: boolean }>> {
  const out = new Map<string, { tf: ArchiveTf; extended: boolean }>();
  if (!days.length) return out;
  const { rows } = await pool.query<{ day: string; tf: string; extended: boolean }>(
    `SELECT day::text AS day, tf, extended FROM candle_archive WHERE symbol = $1 AND day = ANY($2::date[])`,
    [symbol, days],
  );
  for (const r of rows) {
    if (!isArchiveTf(r.tf)) continue;
    const cur = out.get(r.day);
    if (!cur || TF_SEC[r.tf] < TF_SEC[cur.tf] || (TF_SEC[r.tf] === TF_SEC[cur.tf] && r.extended && !cur.extended)) out.set(r.day, { tf: r.tf, extended: r.extended });
  }
  return out;
}

/** Keys (`SYMBOL|day`) of targets that are already archived at any timeframe. */
export async function archivedKeys(targets: readonly SymbolDay[]): Promise<Set<string>> {
  if (!targets.length) return new Set();
  const { rows } = await pool.query<{ k: string }>(
    `SELECT DISTINCT a.symbol || '|' || a.day::text AS k
       FROM candle_archive a
       JOIN unnest($1::text[], $2::date[]) AS t(symbol, day) ON a.symbol = t.symbol AND a.day = t.day`,
    [targets.map((t) => t.symbol), targets.map((t) => t.day)],
  );
  return new Set(rows.map((r) => r.k));
}

/** Keys of targets with a recorded miss that must not be retried yet (retry_after in the future or never). */
export async function blockedMissKeys(targets: readonly SymbolDay[], now: Date): Promise<Set<string>> {
  if (!targets.length) return new Set();
  const { rows } = await pool.query<{ k: string }>(
    `SELECT m.symbol || '|' || m.day::text AS k
       FROM candle_archive_misses m
       JOIN unnest($1::text[], $2::date[]) AS t(symbol, day) ON m.symbol = t.symbol AND m.day = t.day
      WHERE m.retry_after IS NULL OR m.retry_after > $3`,
    [targets.map((t) => t.symbol), targets.map((t) => t.day), now],
  );
  return new Set(rows.map((r) => r.k));
}

/** Insert once; a row that already exists is never overwritten (archived days are immutable). Returns true if written. */
export async function saveArchivedDay(r: NewArchiveRow): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO candle_archive (symbol, day, tf, enc, extended, bar_count, payload, source, fetched_at,
                                 rth_open, rth_high, rth_low, rth_close, volume, prev_close)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (symbol, day, tf) DO NOTHING`,
    [r.symbol, r.day, r.tf, r.enc, r.extended, r.barCount, r.payload, r.source, r.fetchedAt,
      r.stats.rthOpen, r.stats.rthHigh, r.stats.rthLow, r.stats.rthClose, Math.round(r.stats.volume), r.prevClose],
  );
  await pool.query(`DELETE FROM candle_archive_misses WHERE symbol = $1 AND day = $2::date`, [r.symbol, r.day]).catch(() => undefined);
  return (res.rowCount ?? 0) > 0;
}

/** Record that the provider had nothing; `retryAfter` null = never ask again. */
export async function recordMiss(symbol: string, day: string, reason: "empty" | "too_old", retryAfter: Date | null): Promise<void> {
  await pool.query(
    `INSERT INTO candle_archive_misses (symbol, day, reason, retry_after) VALUES ($1, $2::date, $3, $4)
     ON CONFLICT (symbol, day) DO UPDATE SET reason = EXCLUDED.reason, attempts = candle_archive_misses.attempts + 1,
       retry_after = CASE WHEN candle_archive_misses.attempts >= 2 THEN NULL ELSE EXCLUDED.retry_after END, updated_at = now()`,
    [symbol, day, reason, retryAfter],
  );
}

/** Bars of one candles_cache row (cleaned), or null. Read-only: the archive copies what is already there. */
export async function readCacheDay(symbol: string, day: string, tf: ArchiveTf, extended: boolean): Promise<{ bars: Bar[]; fetchedAt: Date } | null> {
  const { rows } = await pool.query<{ ohlcv: Bar[] | null; fetched_at: Date }>(
    `SELECT ohlcv, fetched_at FROM candles_cache WHERE ticker = $1 AND date = $2 AND interval = $3 AND extended = $4
      ORDER BY fetched_at DESC LIMIT 1`,
    [symbol, day, tf, extended],
  );
  const raw = rows[0]?.ohlcv;
  if (!Array.isArray(raw) || !raw.length) return null;
  const bars = cleanCandles(raw);
  return bars.length ? { bars, fetchedAt: new Date(rows[0].fetched_at) } : null;
}

/**
 * Every (symbol, day) the desk needs archived, straight from the data (the caller de-duplicates): each weekday a
 * real trade spans (entry day … exit day, capped at 45 calendar days), playbook examples (their trade's day, even if
 * the trade is gone from the journal), trade ideas (idea day), and intraday simulator games already played.
 * Demo seed trades (external_id DEMO|…) are left out — they are not real days anyone reviews.
 */
export async function collectTargetRows(): Promise<{ symbol: string; day: string }[]> {
  const parts = [
    `SELECT t.ticker AS symbol, gs::date::text AS day
       FROM trades t
       CROSS JOIN LATERAL generate_series(
         left(t.date, 10)::date,
         LEAST(GREATEST(left(t.date, 10)::date,
                        CASE WHEN t.exit_date ~ '^\\d{4}-\\d{2}-\\d{2}' THEN left(t.exit_date, 10)::date ELSE left(t.date, 10)::date END),
               left(t.date, 10)::date + 45),
         interval '1 day') AS gs
      WHERE t.deleted_at IS NULL AND t.date ~ '^\\d{4}-\\d{2}-\\d{2}' AND COALESCE(t.external_id, '') NOT LIKE 'DEMO|%'`,
    `SELECT t.ticker, left(t.date, 10)
       FROM playbook_examples e JOIN trades t ON t.id = e.trade_id
      WHERE e.deleted_at IS NULL AND t.date ~ '^\\d{4}-\\d{2}-\\d{2}'`,
    `SELECT ticker, left(idea_date, 10) FROM trade_ideas WHERE deleted_at IS NULL AND idea_date ~ '^\\d{4}-\\d{2}-\\d{2}'`,
  ];
  const { rows: reg } = await pool.query<{ sim: string | null }>(`SELECT to_regclass('public.sim_games')::text AS sim`);
  if (reg[0]?.sim) parts.push(`SELECT ticker, left(day, 10) FROM sim_games WHERE mode = 'intraday' AND day ~ '^\\d{4}-\\d{2}-\\d{2}'`);
  const { rows } = await pool.query<{ symbol: string; day: string }>(parts.join("\nUNION\n"));
  return rows;
}

export type ArchiveListFilter = {
  from?: string;
  to?: string;
  symbol?: string;
  tf?: ArchiveTf;
  /** Only days whose regular-session range is at least this % of the open. */
  minRangePct?: number;
  minVolume?: number;
  limit?: number;
  offset?: number;
};

export type ArchiveListItem = {
  symbol: string;
  day: string;
  tf: ArchiveTf;
  extended: boolean;
  bars: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  prevClose: number | null;
  /** (high − low) / open, %. */
  rangePct: number | null;
  /** (open − prevClose) / prevClose, %, when the previous close is known. */
  gapPct: number | null;
  volume: number;
  /** Desk trades on that symbol-day. */
  deskTrades: number;
};

/** Archived symbol-days with stats (finest timeframe per day), newest first. */
export async function listArchivedDays(f: ArchiveListFilter): Promise<{ items: ArchiveListItem[]; total: number }> {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll("?", `$${params.length}`)); };
  if (f.from) add("a.day >= ?::date", f.from);
  if (f.to) add("a.day <= ?::date", f.to);
  if (f.symbol) add("a.symbol = ?", f.symbol);
  if (f.tf) add(`a.tf = ?`, f.tf);
  if (f.minVolume != null) add("a.volume >= ?", f.minVolume);
  if (f.minRangePct != null) add("a.rth_open > 0 AND (a.rth_high - a.rth_low) / a.rth_open * 100 >= ?", f.minRangePct);
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 2000);
  const offset = Math.max(f.offset ?? 0, 0);
  const sql = `
    WITH best AS (
      SELECT DISTINCT ON (a.symbol, a.day) a.*
        FROM candle_archive a
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY a.symbol, a.day, CASE a.tf WHEN '1m' THEN 1 WHEN '5m' THEN 2 WHEN '15m' THEN 3 WHEN '30m' THEN 4 ELSE 5 END)
    SELECT b.symbol, b.day::text AS day, b.tf, b.extended, b.bar_count, b.rth_open, b.rth_high, b.rth_low, b.rth_close,
           b.prev_close, b.volume, count(*) OVER () AS total,
           (SELECT count(*)::int FROM trades t WHERE t.ticker = b.symbol AND left(t.date, 10) = b.day::text AND t.deleted_at IS NULL) AS desk
      FROM best b
     ORDER BY b.day DESC, b.symbol
     LIMIT ${limit} OFFSET ${offset}`;
  const { rows } = await pool.query(sql, params);
  const items: ArchiveListItem[] = rows.map((r) => {
    const open = num(r.rth_open), high = num(r.rth_high), low = num(r.rth_low), prev = num(r.prev_close);
    return {
      symbol: r.symbol, day: r.day, tf: r.tf, extended: !!r.extended, bars: Number(r.bar_count),
      open, high, low, close: num(r.rth_close), prevClose: prev,
      rangePct: open && high != null && low != null ? Math.round(((high - low) / open) * 10_000) / 100 : null,
      gapPct: open && prev ? Math.round(((open - prev) / prev) * 10_000) / 100 : null,
      volume: Number(r.volume) || 0,
      deskTrades: Number(r.desk) || 0,
    };
  });
  return { items, total: rows.length ? Number(rows[0].total) : 0 };
}

/** Size of the archive (report / admin). */
export async function archiveTotals(): Promise<{ days: number; bytes: number; byTf: Record<string, { days: number; bytes: number }> }> {
  const { rows } = await pool.query<{ tf: string; n: number; b: string }>(
    `SELECT tf, count(*)::int AS n, sum(octet_length(payload))::bigint AS b FROM candle_archive GROUP BY tf`,
  );
  const byTf: Record<string, { days: number; bytes: number }> = {};
  let days = 0, bytes = 0;
  for (const r of rows) { byTf[r.tf] = { days: r.n, bytes: Number(r.b) }; days += r.n; bytes += Number(r.b); }
  return { days, bytes, byTf };
}
