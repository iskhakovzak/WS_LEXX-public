import { Router, type IRouter, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { logger } from "../lib/logger";
import { isStaffRole, viewerRole, isGuestUser } from "../lib/auth";
import { nyDate } from "../lib/tradingDate";
import { num } from "../lib/tradeMath";
import { computeTradeQuality, type QBar, type QFill, type TradeQuality } from "../lib/tradeQuality";
import {
  type Candle,
  type Interval,
  INTERVAL_SECONDS,
  parseDateStrict,
  ageDaysOf,
  pickIntervalForAge,
  tradingDaysBetween,
  fetchSingleDayWithCache,
  fetchDailyRange,
  readCachedDay,
} from "../lib/candles/market";
import { AppError, badRequest, notFound } from "../lib/http";

/**
 * Execution quality (MFE / MAE / exit efficiency / left on the table…) of journal trades,
 * computed server-side from the bars between the first entry and the final exit.
 *
 *   GET /api/trades/:id/quality?afterExit=30&refresh=1    one trade (cached in trade_quality)
 *   GET /api/trade-quality?ids=1,2,3&afterExit=30          batch for the trades table (no N+1)
 *   GET /api/trades/quality?ids=…                          alias of the batch endpoint — only reachable
 *                                                          if this router is registered BEFORE tradesRouter
 *                                                          (otherwise GET /trades/:id swallows it with a 400).
 *
 * The cache row stores a hash of every input (trade fields, executions, window, algorithm version) and is
 * recomputed when the hash changes, when `?refresh=1` is passed, or — for open positions — once per NY day.
 * Table is created idempotently (additive) once per process.
 */
const router: IRouter = Router();

/** v2: partial entry/exit bars + second-precision fill times (lib/tradeQuality.ts). Bump ⇒ every cache row recomputes. */
const QUALITY_VERSION = 2;
const DEFAULT_AFTER_EXIT_MIN = 30;
const MAX_BATCH = 300;
const MAX_UNCACHED_PER_BATCH = 6;
const BATCH_CONCURRENCY = 2;
const MAX_INTRADAY_DAYS = 30;

let ensured: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `CREATE TABLE IF NOT EXISTS trade_quality (
           trade_id INTEGER PRIMARY KEY,
           inputs_hash TEXT NOT NULL,
           after_exit_min INTEGER NOT NULL DEFAULT 30,
           payload JSONB NOT NULL,
           computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      )
      .then(() => undefined)
      .catch((err) => { ensured = null; throw err; });
  }
  return ensured;
}
ensureTables().catch((err) => logger.warn({ err }, "trade-quality: ensure tables failed at init"));

type TradeRow = {
  id: number;
  ticker: string;
  date: string;
  side: string | null;
  entry: string | null;
  exit: string | null;
  stop: string | null;
  qty: string | null;
  risk_usd: string | null;
  atr: string | null;
  result: string | null;
  horizon: string | null;
  exit_date: string | null;
  trader: string | null;
  synced_at: string | null;
};

type ExecRow = { id: number; kind: QFill["kind"]; price: string; qty: string | null; executed_at: string | null; sort_order: number };

const ET_DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const etDayOf = (t: number) => ET_DAY_FMT.format(new Date(t * 1000));
const ET_HM_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
/** Minutes since midnight ET of an epoch-seconds instant. */
function etMinutesOf(t: number): number {
  const parts = ET_HM_FMT.formatToParts(new Date(t * 1000));
  const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
}

const BAR_SECONDS: Record<Interval, number> = INTERVAL_SECONDS;
/** Intraday intervals, finest first — candidates finer than the one Yahoo would serve today. */
const INTRADAY_FINEST_FIRST: Interval[] = ["1m", "5m", "15m", "30m", "60m"];

function parseAfterExit(q: unknown): number {
  const n = Number(q);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 24 * 60) : DEFAULT_AFTER_EXIT_MIN;
}

async function loadTrades(ids: number[]): Promise<TradeRow[]> {
  if (!ids.length) return [];
  const { rows } = await pool.query<TradeRow>(
    `SELECT id, ticker, date, side, entry, exit, stop, qty, risk_usd, atr, result, horizon, exit_date, trader,
            synced_at::text AS synced_at
       FROM trades WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
    [ids],
  );
  return rows;
}

async function loadExecutions(ids: number[]): Promise<Map<number, ExecRow[]>> {
  const out = new Map<number, ExecRow[]>();
  if (!ids.length) return out;
  const { rows } = await pool.query<ExecRow & { trade_id: number }>(
    `SELECT id, trade_id, kind, price, qty, executed_at::text AS executed_at, sort_order
       FROM trade_executions WHERE trade_id = ANY($1::int[]) ORDER BY sort_order ASC, id ASC`,
    [ids],
  );
  for (const r of rows) {
    const list = out.get(r.trade_id) ?? [];
    list.push(r);
    out.set(r.trade_id, list);
  }
  return out;
}

/** Which trades may the caller read? Staff: all; member: own; guest/anonymous: none. */
async function visibleTrades(req: Request, rows: TradeRow[]): Promise<TradeRow[]> {
  const auth = req.authUser;
  if (!auth || isGuestUser(auth)) return [];
  if (isStaffRole(await viewerRole(req))) return rows;
  return rows.filter((r) => r.trader === auth.name);
}

function isOpenTrade(t: TradeRow): boolean {
  const r = String(t.result ?? "").toLowerCase();
  return r === "open" || (num(t.exit) == null && !["win", "loss", "be"].includes(r));
}

/** Exit day for bar loading: explicit exitDate, else last executed fill day, else trade date (intraday). */
function exitDayOf(t: TradeRow, execs: ExecRow[]): string {
  if (t.exit_date && /^\d{4}-\d{2}-\d{2}$/.test(t.exit_date) && t.exit_date >= t.date) return t.exit_date;
  let last: string | null = null;
  for (const e of execs) {
    if (!e.executed_at) continue;
    const d = etDayOf(Math.floor(new Date(e.executed_at).getTime() / 1000));
    if (!last || d > last) last = d;
  }
  if (last && last >= t.date) return last;
  return t.date;
}

function inputsHash(t: TradeRow, execs: ExecRow[], afterExit: number, open: boolean): string {
  const parts = [
    QUALITY_VERSION, t.ticker, t.date, t.side, t.entry, t.exit, t.stop, t.qty, t.risk_usd, t.atr, t.result, t.horizon, t.exit_date,
    afterExit,
    execs.map((e) => [e.id, e.kind, e.price, e.qty, e.executed_at, e.sort_order]),
    open ? nyDate() : null,
  ];
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex");
}

type Loaded = { bars: QBar[]; interval: Interval; from: string; to: string; daysRequested: number; daysLoaded: number; fromCacheOnly: boolean };

function dedupSorted(all: Candle[]): QBar[] {
  all.sort((a, b) => a.t - b.t);
  const bars: QBar[] = [];
  let lastT = -1;
  for (const c of all) if (c.t !== lastT) { bars.push(c); lastT = c.t; }
  return bars;
}

/**
 * Bars for the trade window. Interval: the finest Yahoo still serves for the trade's age (1m ≤ 7 days,
 * 5m ≤ 60 days, 60m ≤ 2 years), BUT a finer series already sitting in candles_cache (fetched while the
 * trade was fresh — the chart/replay tabs cache 1m extended bars) wins: a 1-minute scalp measured on
 * 60-minute bars is meaningless. `execs` tells whether the fills stay inside regular hours, in which case
 * an RTH-only cached series is also acceptable.
 */
async function loadBars(t: TradeRow, exitDay: string, open: boolean, execs: ExecRow[], log: unknown): Promise<Loaded | null> {
  const from = t.date;
  const today = nyDate();
  let to = exitDay;
  if (open) to = today; // open position: everything since the entry
  if (to > today) to = today;
  if (to < from) to = from;
  const fromParsed = parseDateStrict(from);
  if (!fromParsed) return null;

  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
  const oldestAge = ageDaysOf(fromParsed);
  let interval: Interval = pickIntervalForAge(oldestAge);
  // Multi-week holds: daily bars (one Yahoo call); very long intraday loops are not worth N cache lookups.
  if (spanDays > 14 || interval === "1d") interval = "1d";

  const days = tradingDaysBetween(from, to, MAX_INTRADAY_DAYS);

  // Finer cached series first (cache-only, no Yahoo traffic). Needs every trading day of the window.
  if (days.length && (interval !== "1d" || spanDays <= 14)) {
    const fillTimes = execs.map((e) => (e.executed_at ? Math.floor(new Date(e.executed_at).getTime() / 1000) : null));
    const allTimed = fillTimes.length > 0 && fillTimes.every((x) => x != null);
    const rthOnly = allTimed && fillTimes.every((x) => { const m = etMinutesOf(x as number); return m >= 9 * 60 + 30 && m < 16 * 60; });
    const finer = INTRADAY_FINEST_FIRST.filter((iv) => interval === "1d" || BAR_SECONDS[iv] < BAR_SECONDS[interval]);
    for (const iv of finer) {
      for (const extended of rthOnly ? [true, false] : [true]) {
        const all: Candle[] = [];
        let ok = true;
        for (const day of days) {
          const c = await readCachedDay(t.ticker, day.str, iv, extended);
          if (!c) { ok = false; break; }
          all.push(...c);
        }
        if (ok && all.length) return { bars: dedupSorted(all), interval: iv, from, to, daysRequested: days.length, daysLoaded: days.length, fromCacheOnly: true };
      }
    }
  }

  if (interval === "1d") {
    const daily = await fetchDailyRange(t.ticker, from, to);
    if (!daily?.length) return null;
    const bars = daily.filter((c) => { const d = etDayOf(c.t); return d >= from && d <= to; });
    return { bars, interval, from, to, daysRequested: 0, daysLoaded: bars.length, fromCacheOnly: false };
  }

  const all: Candle[] = [];
  let loaded = 0;
  for (const day of days) {
    const r = await fetchSingleDayWithCache(t.ticker, day, day.str, interval, true, false, log);
    if (r?.candles?.length) { all.push(...r.candles); loaded++; }
  }
  if (!all.length) return null;
  return { bars: dedupSorted(all), interval, from, to, daysRequested: days.length, daysLoaded: loaded, fromCacheOnly: false };
}

export type QualityRecord = {
  tradeId: number;
  afterExitMinutes: number;
  computedAt: string;
  cached: boolean;
  window: { from: string; to: string; interval: string; daysLoaded: number; fromCacheOnly?: boolean } | null;
  quality: TradeQuality;
};

async function computeOne(t: TradeRow, execs: ExecRow[], afterExit: number, log: unknown): Promise<QualityRecord> {
  const open = isOpenTrade(t);
  const exitDay = exitDayOf(t, execs);
  const side: "long" | "short" = String(t.side ?? "").toLowerCase().startsWith("s") ? "short" : "long";
  const loaded = await loadBars(t, exitDay, open, execs, log);
  const fills: QFill[] = execs.map((e, i) => ({
    kind: e.kind,
    price: Number(e.price),
    qty: e.qty != null ? Number(e.qty) : null,
    t: e.executed_at ? Math.floor(new Date(e.executed_at).getTime() / 1000) : null,
    order: (Number.isFinite(e.sort_order) ? e.sort_order : i) * 1000 + i,
  }));
  const quality = computeTradeQuality({
    side,
    bars: loaded?.bars ?? [],
    interval: loaded?.interval ?? "none",
    barSeconds: loaded ? BAR_SECONDS[loaded.interval] : 60,
    fills,
    entry: num(t.entry),
    exit: num(t.exit),
    stop: num(t.stop),
    qty: num(t.qty),
    riskUsd: num(t.risk_usd),
    atr: num(t.atr),
    isOpen: open,
    tradeDate: t.date,
    exitDate: open ? null : exitDay,
    afterExitMinutes: afterExit,
    dayKeyOf: etDayOf,
  });
  return {
    tradeId: t.id,
    afterExitMinutes: afterExit,
    computedAt: new Date().toISOString(),
    cached: false,
    window: loaded ? { from: loaded.from, to: loaded.to, interval: loaded.interval, daysLoaded: loaded.daysLoaded, fromCacheOnly: loaded.fromCacheOnly } : null,
    quality,
  };
}

type CacheRow = { trade_id: number; inputs_hash: string; after_exit_min: number; payload: QualityRecord; computed_at: string };

async function readCache(ids: number[]): Promise<Map<number, CacheRow>> {
  const out = new Map<number, CacheRow>();
  if (!ids.length) return out;
  const { rows } = await pool.query<CacheRow>(
    `SELECT trade_id, inputs_hash, after_exit_min, payload, computed_at::text AS computed_at FROM trade_quality WHERE trade_id = ANY($1::int[])`,
    [ids],
  );
  for (const r of rows) out.set(r.trade_id, r);
  return out;
}

async function writeCache(tradeId: number, hash: string, afterExit: number, rec: QualityRecord): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO trade_quality (trade_id, inputs_hash, after_exit_min, payload, computed_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())
       ON CONFLICT (trade_id) DO UPDATE SET inputs_hash = EXCLUDED.inputs_hash, after_exit_min = EXCLUDED.after_exit_min,
         payload = EXCLUDED.payload, computed_at = NOW()`,
      [tradeId, hash, afterExit, JSON.stringify(rec)],
    );
  } catch (err) {
    logger.warn({ err, tradeId }, "trade-quality: cache write failed");
  }
}

/**
 * Resolve quality for a set of trades: cache hits are returned at once, up to `maxCompute` misses are computed
 * in this request (bounded Yahoo traffic), the rest are reported in `pending` so the client can poll again.
 */
async function resolveMany(req: Request, trades: TradeRow[], afterExit: number, refresh: boolean, maxCompute: number) {
  await ensureTables();
  const ids = trades.map((t) => t.id);
  const [execsMap, cache] = await Promise.all([loadExecutions(ids), readCache(ids)]);
  const items: QualityRecord[] = [];
  const toCompute: { t: TradeRow; hash: string }[] = [];
  for (const t of trades) {
    const execs = execsMap.get(t.id) ?? [];
    const hash = inputsHash(t, execs, afterExit, isOpenTrade(t));
    const hit = cache.get(t.id);
    if (!refresh && hit && hit.inputs_hash === hash && hit.after_exit_min === afterExit) {
      items.push({ ...hit.payload, cached: true, computedAt: new Date(hit.computed_at).toISOString() });
    } else {
      toCompute.push({ t, hash });
    }
  }
  const now = toCompute.slice(0, maxCompute);
  const pending = toCompute.slice(maxCompute).map((x) => x.t.id);
  let cursor = 0;
  const worker = async () => {
    while (cursor < now.length) {
      const job = now[cursor++];
      try {
        const rec = await computeOne(job.t, execsMap.get(job.t.id) ?? [], afterExit, req.log);
        items.push(rec);
        await writeCache(job.t.id, job.hash, afterExit, rec);
      } catch (err) {
        req.log?.warn?.({ err, tradeId: job.t.id }, "trade-quality: compute failed");
        pending.push(job.t.id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, now.length) }, worker));
  return { items, pending };
}

function parseIds(raw: unknown): number[] {
  const s = Array.isArray(raw) ? raw.join(",") : String(raw ?? "");
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) out.add(n);
    if (out.size >= MAX_BATCH) break;
  }
  return [...out];
}

async function batchHandler(req: Request, res: Response): Promise<void> {
  const ids = parseIds(req.query.ids);
  if (!ids.length) throw new AppError("IDS_REQUIRED");
  const afterExit = parseAfterExit(req.query.afterExit);
  const refresh = req.query.refresh === "1";
  const trades = await visibleTrades(req, await loadTrades(ids));
  const { items, pending } = await resolveMany(req, trades, afterExit, refresh, MAX_UNCACHED_PER_BATCH);
  res.json({ afterExitMinutes: afterExit, items, pending, version: QUALITY_VERSION });
}

// Batch: GET /api/trade-quality?ids=1,2,3  (and alias /api/trades/quality — see header comment)
router.get("/trade-quality", asyncHandler(batchHandler));
router.get("/trades/quality", asyncHandler(batchHandler));

// Single: GET /api/trades/:id/quality
router.get("/trades/:id/quality", asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  const afterExit = parseAfterExit(req.query.afterExit);
  const refresh = req.query.refresh === "1";
  const rows = await loadTrades([id]);
  if (!rows.length) throw notFound("TRADE_NOT_FOUND");
  const visible = await visibleTrades(req, rows);
  if (!visible.length) throw new AppError("OWN_TRADES_ONLY");
  const { items } = await resolveMany(req, visible, afterExit, refresh, 1);
  if (!items.length) throw new AppError("NO_DATA", 503, undefined, { tradeId: id });
  res.json(items[0]);
}));

export default router;
