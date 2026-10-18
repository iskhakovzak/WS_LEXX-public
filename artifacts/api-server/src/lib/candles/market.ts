/**
 * Market candles: provider fetches (Yahoo via marketDataService), the candles_cache read path, the permanent
 * candle archive and daily ranges. Pure data access — no Express. HTTP handlers live in routes/candles.ts.
 */
import { fetchYahooWithSession } from "../marketDataService";
import { pool } from "@workspace/db";
import { nyDate } from "../tradingDate";
import { INTRADAY_LADDER, intervalForAge, type CandleInterval } from "../candleLimits";
import { cleanCandles } from "../candleClean";
import { dayWindowEpochSeconds, etWallToUtcSeconds, parseDateStrict } from "../candleDay";
import {
  TF_SEC, aggregateBars, archivedTfs, ensureArchivedDay, isArchiveTf, isDayComplete, readArchivedDays, regularOnly,type ArchiveTf, type ArchivedDay,
} from "../candleArchive";

export type Interval = "1m" | "5m" | "15m" | "30m" | "60m" | "1d";

export const ALLOWED_INTERVALS: ReadonlySet<Interval> = new Set(["1m", "5m", "15m", "30m", "60m", "1d"]);

/** Bar length in seconds per interval (shared with trade quality / replay). */
export const INTERVAL_SECONDS: Record<Interval, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "60m": 3600, "1d": 86400 };

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export { parseDateStrict, etWallToUtcSeconds, dayWindowEpochSeconds };

/** Finest bars the provider serves for a day this old (lib/candleLimits; the archive may hold finer ones). */
export function pickIntervalForAge(ageDays: number): Interval {
  return intervalForAge(ageDays);
}

export function ageDaysOf(parsed: { y: number; m: number; d: number }): number {
  return (Date.now() - Date.UTC(parsed.y, parsed.m - 1, parsed.d)) / (1000 * 60 * 60 * 24);
}

function fmtDate(p: { y: number; m: number; d: number }): string {
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

// Walk back N trading days from `parsed`, returning [oldest, ..., parsed].
// Skips Sat/Sun. Does not (yet) check for US market holidays — those
// just yield empty candles from Yahoo and get filtered out at assembly.
export function collectTradingDays(parsed: { y: number; m: number; d: number }, daysBack: number): { y: number; m: number; d: number; str: string }[] {
  const out: { y: number; m: number; d: number; str: string }[] = [
    { ...parsed, str: fmtDate(parsed) },
  ];
  let cur = parsed;
  for (let i = 0; i < daysBack; i++) {
    const dt = new Date(Date.UTC(cur.y, cur.m - 1, cur.d));
    do {
      dt.setUTCDate(dt.getUTCDate() - 1);
    } while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6);
    cur = { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
    out.push({ ...cur, str: fmtDate(cur) });
  }
  return out.reverse(); // oldest first
}

export type SessionLevels = {
  pmHigh: number | null;
  pmLow: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
};

const ET_PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

// Premarket = 04:00–09:29 ET, regular = 09:30–15:59 ET, for bars on `dateStr` (ET).
export function computeSessionLevels(candles: Candle[], dateStr: string): SessionLevels {
  const out: SessionLevels = { pmHigh: null, pmLow: null, open: null, high: null, low: null, close: null };
  for (const c of candles) {
    const parts = ET_PARTS_FMT.formatToParts(new Date(c.t * 1000));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    if (`${get("year")}-${get("month")}-${get("day")}` !== dateStr) continue;
    const mins = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
    if (mins >= 240 && mins < 570) {
      out.pmHigh = out.pmHigh == null ? c.h : Math.max(out.pmHigh, c.h);
      out.pmLow = out.pmLow == null ? c.l : Math.min(out.pmLow, c.l);
    } else if (mins >= 570 && mins < 960) {
      if (out.open == null) out.open = c.o;
      out.high = out.high == null ? c.h : Math.max(out.high, c.h);
      out.low = out.low == null ? c.l : Math.min(out.low, c.l);
      out.close = c.c;
    }
  }
  return out;
}

// In-memory cache for previous-trading-day closes. Keyed by `TICKER:YYYY-MM-DD`.
// Past days are stable forever; today's value is refreshed every 5 minutes so
// intraday updates to the prior close (rare, e.g. corporate actions) propagate.
const prevCloseCache = new Map<string, { value: number | null; fetchedAt: number }>();
const PREV_CLOSE_TTL_MS = 5 * 60 * 1000;

export async function getPrevDailyCloseCached(ticker: string, parsed: { y: number; m: number; d: number }, dateStr: string): Promise<number | null> {
  const key = `${ticker}:${dateStr}`;
  // Trading date = New York date: a day is "past" (stable) only once the ET calendar has moved on.
  const today = nyDate();
  const isPast = dateStr < today;
  const cached = prevCloseCache.get(key);
  if (cached && (isPast || Date.now() - cached.fetchedAt < PREV_CLOSE_TTL_MS)) {
    return cached.value;
  }
  // An archived day carries its previous close: years later the chart needs no provider call for PDC.
  if (isPast) {
    const archived = (await readArchivedDays(ticker, [dateStr]).catch(() => new Map<string, ArchivedDay>())).get(dateStr);
    if (archived?.prevClose != null) {
      prevCloseCache.set(key, { value: archived.prevClose, fetchedAt: Date.now() });
      return archived.prevClose;
    }
  }
  const value = await fetchPrevDailyClose(ticker, parsed);
  prevCloseCache.set(key, { value, fetchedAt: Date.now() });
  return value;
}

async function fetchPrevDailyClose(ticker: string, parsed: { y: number; m: number; d: number }): Promise<number | null> {
  // Fetch ~14 calendar days of daily candles ending the day before `date` and
  // return the last available close. This robustly handles weekends and
  // holidays (just picks the most recent trading day).
  const targetMidnight = Math.floor(Date.UTC(parsed.y, parsed.m - 1, parsed.d) / 1000);
  const start = targetMidnight - 14 * 86400;
  const end = targetMidnight; // exclusive upper bound: we want closes BEFORE the trade date
  const params = (s: { cookie: string; crumb: string }) => {
    const p = new URLSearchParams({
      period1: String(start),
      period2: String(end),
      interval: "1d",
      events: "div,split",
      crumb: s.crumb,
    });
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${p.toString()}`;
  };
  try {
    const resp = await fetchYahooWithSession(params);
    if (!resp || !resp.ok) return null;
    const data: any = await resp.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const ts: number[] = result.timestamp || [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close || [];
    for (let i = closes.length - 1; i >= 0; i--) {
      const c = closes[i];
      if (c != null && Number.isFinite(c) && ts[i] < targetMidnight) return Number(c);
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchYahooCandles(ticker: string, parsed: { y: number; m: number; d: number }, interval: Interval, extended: boolean): Promise<Candle[] | null> {
  const { start, end } = dayWindowEpochSeconds(parsed, extended);
  const params = (s: { cookie: string; crumb: string }) => {
    const p = new URLSearchParams({
      period1: String(start),
      period2: String(end),
      interval,
      includePrePost: extended ? "true" : "false",
      events: "div,split",
      crumb: s.crumb,
    });
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${p.toString()}`;
  };
  try {
    const resp = await fetchYahooWithSession(params);
    if (!resp || !resp.ok) return null;
    const data: any = await resp.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const ts: number[] = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const candles: Candle[] = ts.map((t, i) => ({
      t,
      o: q.open?.[i],
      h: q.high?.[i],
      l: q.low?.[i],
      c: q.close?.[i],
      v: q.volume?.[i] ?? 0,
    })).filter((c: Candle) => c.o != null && c.h != null && c.l != null && c.c != null);
    // Stray Yahoo prints (lib/candleClean): absurd wicks clamped, single-bar spikes dropped; bodies untouched.
    return cleanCandles(candles);
  } catch {
    return null;
  }
}

/** Archived bars of a day served at `interval` (aggregated from finer bars, extended hours cut when not asked), or null
 *  when the archive holds coarser bars than asked or only regular hours while extended ones are asked. */
export function barsFromArchive(a: ArchivedDay, interval: Interval, extended: boolean): Candle[] | null {
  if (interval === "1d") return null;
  const want = INTERVAL_SECONDS[interval];
  if (TF_SEC[a.tf] > want || (extended && !a.extended)) return null;
  let bars: Candle[] = aggregateBars(a.bars, TF_SEC[a.tf], want, a.day);
  if (!extended) bars = regularOnly(bars, a.day);
  return bars.length ? bars : null;
}

/**
 * Stored read of one day (no Yahoo call): the permanent archive first, then candles_cache. Lets trade quality / replay
 * use a finer interval than Yahoo still serves for an old day. Past days are stable; today's cache rows must be fresh.
 */
export async function readCachedDay(ticker: string, dateStr: string, interval: Interval, extended: boolean): Promise<Candle[] | null> {
  if (interval !== "1d" && isDayComplete(dateStr)) {
    const a = (await readArchivedDays(ticker, [dateStr]).catch(() => new Map<string, ArchivedDay>())).get(dateStr);
    const fromArchive = a ? barsFromArchive(a, interval, extended) : null;
    if (fromArchive) return fromArchive;
  }
  const isPast = dateStr < nyDate();
  const cacheCondition = isPast
    ? `ticker = $1 AND date = $2 AND interval = $3 AND extended = $4`
    : `ticker = $1 AND date = $2 AND interval = $3 AND extended = $4 AND fetched_at > NOW() - INTERVAL '5 minutes'`;
  const { rows } = await pool.query(
    `SELECT ohlcv FROM candles_cache WHERE ${cacheCondition} ORDER BY fetched_at DESC LIMIT 1`,
    [ticker, dateStr, interval, extended],
  );
  const cached = rows[0]?.ohlcv as Candle[] | undefined;
  // Days cached before the bad-tick filter existed may still hold stray wicks — clean on every read.
  const clean = cached && cached.length > 0 ? cleanCandles(cached) : [];
  return clean.length > 0 ? clean : null;
}

/**
 * One day of bars. A FINISHED day comes from the permanent archive (lib/candleArchive): if it is not archived yet it is
 * fetched once for the whole desk (single flight), stored, and served from there — every later open costs zero
 * provider calls. The live day (and anything the archive cannot serve) keeps the old path: candles_cache (5 min for
 * today) → Yahoo → cache write. Returns null if there is no data for that day (holiday, new listing).
 */
export async function fetchSingleDayWithCache(
  ticker: string,
  parsed: { y: number; m: number; d: number },
  dateStr: string,
  interval: Interval,
  extended: boolean,
  force: boolean,
  log?: any
): Promise<{ candles: Candle[]; cached: boolean; archived?: ArchivedDay } | null> {
  if (!force && interval !== "1d" && isDayComplete(dateStr)) {
    try {
      const a = await ensureArchivedDay(ticker, dateStr, undefined, (d) => getPrevDailyCloseCached(ticker, parsed, d));
      const bars = a ? barsFromArchive(a, interval, extended) : null;
      if (a && bars) return { candles: bars, cached: true, archived: a };
    } catch (err) {
      log?.warn?.({ err, ticker, dateStr }, "candle archive read failed — live path");
    }
  }
  if (!force) {
    const cached = await readCachedDay(ticker, dateStr, interval, extended);
    if (cached) return { candles: cached, cached: true };
  }

  const candles = await fetchYahooCandles(ticker, parsed, interval, extended);
  if (!candles || candles.length === 0) return null;

  try {
    await pool.query(
      `INSERT INTO candles_cache (ticker, date, interval, extended, ohlcv, fetched_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
       ON CONFLICT (ticker, date, interval, extended) DO UPDATE SET
         ohlcv = EXCLUDED.ohlcv,
         fetched_at = NOW()`,
      [ticker, dateStr, interval, extended, JSON.stringify(candles)]
    );
  } catch (err) {
    log?.warn?.({ err, ticker, dateStr, interval, extended }, "candles cache write failed");
  }

  return { candles, cached: false };
}

/** Intervals each day can be served at from storage (archive: its bar size and every coarser one; cache: as stored). */
export async function storedIntervals(ticker: string, days: readonly string[], extended: boolean): Promise<Map<CandleInterval, Set<string>>> {
  const out = new Map<CandleInterval, Set<string>>();
  const mark = (iv: CandleInterval, d: string) => { if (!out.has(iv)) out.set(iv, new Set()); out.get(iv)!.add(d); };
  const [{ rows }, arch] = await Promise.all([
    pool.query(
      `SELECT DISTINCT interval, date AS d FROM candles_cache WHERE ticker = $1 AND extended = $2 AND date = ANY($3::text[]) AND interval = ANY($4::text[])`,
      [ticker, extended, days, INTRADAY_LADDER],
    ).catch(() => ({ rows: [] as { interval: string; d: string }[] })),
    archivedTfs(ticker, days).catch(() => new Map<string, { tf: ArchiveTf; extended: boolean }>()),
  ]);
  for (const r of rows) mark(r.interval as CandleInterval, String(r.d).slice(0, 10));
  for (const [d, a] of arch) {
    if (extended && !a.extended) continue;
    for (const iv of INTRADAY_LADDER) if (isArchiveTf(iv) && TF_SEC[iv] >= TF_SEC[a.tf]) mark(iv, d);
  }
  return out;
}

// ── Daily bars over a date range (one Yahoo call, in-memory TTL cache) ──────
// Used by trade replay / execution quality for multi-week swings. Keyed by
// ticker + from + to; past ranges are stable, ranges touching today expire.
const dailyRangeCache = new Map<string, { candles: Candle[]; fetchedAt: number }>();
const DAILY_RANGE_TTL_MS = 5 * 60 * 1000;
const DAILY_RANGE_MAX = 200;

export async function fetchDailyRange(ticker: string, fromStr: string, toStr: string): Promise<Candle[] | null> {
  const from = parseDateStrict(fromStr);
  const to = parseDateStrict(toStr);
  if (!from || !to || fromStr > toStr) return null;
  const key = `${ticker}:${fromStr}:${toStr}`;
  const stable = toStr < nyDate();
  const hit = dailyRangeCache.get(key);
  if (hit && (stable || Date.now() - hit.fetchedAt < DAILY_RANGE_TTL_MS)) return hit.candles;

  const start = Math.floor(Date.UTC(from.y, from.m - 1, from.d) / 1000);
  const end = Math.floor(Date.UTC(to.y, to.m - 1, to.d) / 1000) + 86400; // inclusive upper day
  const params = (s: { cookie: string; crumb: string }) => {
    const p = new URLSearchParams({
      period1: String(start),
      period2: String(end),
      interval: "1d",
      events: "div,split",
      crumb: s.crumb,
    });
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${p.toString()}`;
  };
  try {
    const resp = await fetchYahooWithSession(params);
    if (!resp || !resp.ok) return null;
    const data: any = await resp.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const ts: number[] = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const candles: Candle[] = ts
      .map((t, i) => ({ t, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i] ?? 0 }))
      .filter((c: Candle) => c.o != null && c.h != null && c.l != null && c.c != null);
    if (dailyRangeCache.size > DAILY_RANGE_MAX) {
      const oldest = dailyRangeCache.keys().next().value;
      if (oldest) dailyRangeCache.delete(oldest);
    }
    dailyRangeCache.set(key, { candles, fetchedAt: Date.now() });
    return candles;
  } catch {
    return null;
  }
}

// Trading days in [fromStr, toStr] (weekends skipped; holidays yield no bars and are dropped by callers).
export function tradingDaysBetween(fromStr: string, toStr: string, cap = 30): { y: number; m: number; d: number; str: string }[] {
  const from = parseDateStrict(fromStr);
  const to = parseDateStrict(toStr);
  if (!from || !to || fromStr > toStr) return [];
  const out: { y: number; m: number; d: number; str: string }[] = [];
  const dt = new Date(Date.UTC(from.y, from.m - 1, from.d));
  const endMs = Date.UTC(to.y, to.m - 1, to.d);
  while (dt.getTime() <= endMs && out.length < cap) {
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const p = { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
      out.push({ ...p, str: fmtDate(p) });
    }
    dt.setUTCDate(dt.getUTCDate() + 1);
  }
  return out;
}
