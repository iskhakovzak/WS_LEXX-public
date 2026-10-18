import { Router, type IRouter, type Request, type Response } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { nyDate } from "../lib/tradingDate";
import { intervalAllowedForAge, pickServedInterval } from "../lib/candleLimits";
import { dayWindowEpochSeconds, parseDateStrict } from "../lib/candleDay";
import {
  TF_SEC, ensureArchivedDay, isDayComplete,
  listArchivedDays, type ArchiveTf, type ArchivedDay,
} from "../lib/candleArchive";
import { z } from "zod";
import { AppError, badRequest, route, sendError } from "../lib/http";

const router: IRouter = Router();

import {
  ALLOWED_INTERVALS, ageDaysOf, barsFromArchive, collectTradingDays, computeSessionLevels, fetchDailyRange, fetchSingleDayWithCache,
  getPrevDailyCloseCached, pickIntervalForAge, storedIntervals, tradingDaysBetween, type Candle, type Interval, type SessionLevels,
} from "../lib/candles/market";

/** Long-lived HTTP caching for responses built only from archived (finished, immutable) days; 304 when unchanged. */
function setArchiveCaching(req: Request, res: Response, parts: readonly ArchivedDay[], variant: string): boolean {
  const etag = `"cv1-${variant}-${parts.map((p) => p.etag.replace(/"/g, "")).join(".")}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  if (req.headers["if-none-match"] === etag) { res.status(304).end(); return true; }
  return false;
}

// GET /candles/:ticker/range?from=&to=&interval=&extended=1
// Multi-day series for replay of overnight / swing trades: intraday bars per
// trading day (cache-first, ≤30 days) or a single daily call for `interval=1d`.
router.get("/candles/:ticker/range", asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const ticker = String(req.params.ticker || "").toUpperCase().trim();
  const fromStr = String(req.query.from || "").trim();
  const toStr = String(req.query.to || "").trim();
  const extended = req.query.extended === "1" || req.query.extended === "true";
  if (!ticker || !/^[A-Z][A-Z0-9.\-]{0,10}$/.test(ticker)) throw badRequest("INVALID_TICKER");
  const from = parseDateStrict(fromStr);
  const to = parseDateStrict(toStr);
  if (!from || !to || fromStr > toStr) throw new AppError("INVALID_RANGE", undefined, { max: 400 });

  const days = tradingDaysBetween(fromStr, toStr, 30);
  if (!days.length) { res.status(422).json({ error: "non_trading_day", reason: "weekend", ticker, from: fromStr, to: toStr }); return; }
  const oldestAge = ageDaysOf(days[0]);
  const requestedRaw = String(req.query.interval || "").toLowerCase().trim();
  const requested = ALLOWED_INTERVALS.has(requestedRaw as Interval) ? (requestedRaw as Interval) : null;
  let interval: Interval = requested && intervalAllowedForAge(requested, oldestAge) ? requested : pickIntervalForAge(oldestAge);
  let rangeDays = days;
  if (requested && requested !== "1d" && interval !== requested) {
    // Too old for the requested bars by age. Before coarsening, look in storage: a day archived (or cached) while it
    // was fresh keeps its 1m / 5m bars. Serve the finest interval the trailing run of days (always the trade day) has —
    // by age or stored — and drop older context days instead of coarsening the whole series (lib/candleLimits).
    const cached = await storedIntervals(ticker, days.map((d) => d.str), extended);
    const pick = pickServedInterval(days.map((d) => ({ str: d.str, age: ageDaysOf(d) })), requested, interval, cached);
    interval = pick.interval;
    rangeDays = days.slice(pick.fromIndex);
  }
  const spanDays = (Date.UTC(to.y, to.m - 1, to.d) - Date.UTC(from.y, from.m - 1, from.d)) / 86400000;
  if (spanDays > 45 && interval !== "1d") { interval = "1d"; rangeDays = days; }

  // `trim=1` (trade replay) is accepted for compatibility: the block above already keeps the finest bars and drops
  // older leading context days whenever the requested interval cannot be served for every day.

  let candles: Candle[] = [];
  let cached = true;
  const archivedParts: ArchivedDay[] = [];
  let allArchived = interval !== "1d";
  if (interval === "1d") {
    const daily = await fetchDailyRange(ticker, fromStr, toStr);
    candles = daily ?? [];
    cached = false;
  } else {
    for (const day of rangeDays) {
      const r = await fetchSingleDayWithCache(ticker, day, day.str, interval, extended, false, req.log);
      if (r) { candles.push(...r.candles); if (!r.cached) cached = false; }
      if (r?.archived) archivedParts.push(r.archived);
      // A day with no bars (holiday) is fine once it is over; a live / unarchived day makes the answer mutable.
      else if (r || !isDayComplete(day.str)) allArchived = false;
    }
  }
  candles.sort((a, b) => a.t - b.t);
  const dedup: Candle[] = [];
  let lastT = -1;
  for (const c of candles) if (c.t !== lastT) { dedup.push(c); lastT = c.t; }
  if (!dedup.length) throw new AppError("NO_DATA", 404, undefined, { ticker, from: fromStr, to: toStr, interval });

  // The response `from` / `days` say which days were actually served (older context days may have been dropped).
  const servedDays = interval === "1d" ? days : rangeDays;
  const servedFrom = servedDays[0]?.str ?? fromStr;
  const prevClose = await getPrevDailyCloseCached(ticker, servedDays[0] ?? from, servedFrom);
  // Built only from archived days ⇒ immutable: the browser keeps it, a revalidation is a 304.
  if (allArchived && archivedParts.length && setArchiveCaching(req, res, archivedParts, `r${interval}${extended ? "x" : ""}`)) return;
  const tfs = [...new Set(archivedParts.map((a) => a.tf))];
  res.json({
    ticker, from: servedFrom, to: toStr, interval, extended, days: servedDays.length, candles: dedup, prevClose, cached,
    source: allArchived && archivedParts.length ? "archive" : "live", archivedTf: tfs.length === 1 ? tfs[0] : null,
    fetchedAt: new Date().toISOString(),
  });
}));

// ── Candle archive endpoints ─────────────────────────────────────────────────
const tickerSchema = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9.\-]{0,10}$/);
const daySchema = z.string().refine((s) => parseDateStrict(s) != null, "YYYY-MM-DD");
const tfSchema = z.enum(["1m", "5m", "15m", "30m", "60m"]);
const boolFlag = z.enum(["0", "1", "true", "false"]).transform((v) => v === "1" || v === "true");

/**
 * GET /candles/:ticker/day/:date?tf=&extended=  — one whole trading day (04:00–20:00 ET by default).
 * A finished day comes from the permanent archive (fetched once for the desk if missing) at its archived bar size, or
 * aggregated to a coarser `tf`; immutable + ETag (304 on revalidation). The live day: best bars by age, no caching.
 * Response: { ticker, date, tf, archivedTf, extended, candles, prevClose, source: "archive" | "live", fetchedAt }.
 */
router.get("/candles/:ticker/day/:date", route({
  params: z.object({ ticker: tickerSchema, date: daySchema }),
  query: z.object({ tf: tfSchema.optional(), extended: boolFlag.optional() }),
}, async ({ params, query, req, res }) => {
  const { ticker, date } = params;
  const extended = query.extended ?? true;
  const parsed = parseDateStrict(date)!;
  const dow = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d)).getUTCDay();
  if (dow === 0 || dow === 6) throw new AppError("BAD_REQUEST", 422, undefined, { reason: "weekend" });
  if (date > nyDate()) throw new AppError("BAD_REQUEST", 422, undefined, { reason: "future" });

  if (isDayComplete(date)) {
    const a = await ensureArchivedDay(ticker, date, undefined, (d) => getPrevDailyCloseCached(ticker, parsed, d));
    if (a && (a.extended || !extended)) {
      const tf: ArchiveTf = query.tf && TF_SEC[query.tf] > TF_SEC[a.tf] ? query.tf : a.tf;
      const candles = barsFromArchive(a, tf, extended);
      if (candles) {
        if (setArchiveCaching(req, res, [a], `d${tf}${extended ? "x" : ""}`)) return;
        const prevClose = a.prevClose ?? await getPrevDailyCloseCached(ticker, parsed, date);
        return { ticker, date, tf, archivedTf: a.tf, extended, candles, prevClose, source: "archive", fetchedAt: a.fetchedAt };
      }
    }
  }
  // Live day, or nothing archivable: the old path at the finest bars the provider serves for a day this old.
  const best: Interval = query.tf ?? pickIntervalForAge(ageDaysOf(parsed));
  const live = await fetchSingleDayWithCache(ticker, parsed, date, best, extended, false, req.log);
  res.setHeader("Cache-Control", "private, no-cache");
  if (!live?.candles.length) throw new AppError("NOT_FOUND", 404, undefined, { reason: "no_candles" });
  return {
    ticker, date, tf: best, archivedTf: null, extended, candles: live.candles,
    prevClose: await getPrevDailyCloseCached(ticker, parsed, date), source: "live", fetchedAt: new Date().toISOString(),
  };
}));

/**
 * GET /candle-archive/days?from=&to=&symbol=&tf=&minRangePct=&minVolume=&limit=&offset=
 * Archived symbol-days with regular-session stats (simulator scenario picking, admin). Finest bar size per day.
 * Response: { items: ArchiveListItem[], total }.
 */
router.get("/candle-archive/days", route({
  query: z.object({
    from: daySchema.optional(),
    to: daySchema.optional(),
    symbol: tickerSchema.optional(),
    tf: tfSchema.optional(),
    minRangePct: z.coerce.number().min(0).max(1000).optional(),
    minVolume: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(2000).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
}, async ({ query }) => listArchivedDays(query)));

router.get("/candles/:ticker", asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const ticker = String(req.params.ticker || "").toUpperCase().trim();
  const dateStr = String(req.query.date || "").trim();
  const extended = req.query.extended === "1" || req.query.extended === "true";
  const force = req.query.force === "1";
  const daysBackRaw = Number(req.query.daysBack);
  const daysBack = Number.isFinite(daysBackRaw) ? Math.max(0, Math.min(10, Math.floor(daysBackRaw))) : 0;

  if (!ticker || !/^[A-Z][A-Z0-9.\-]{0,10}$/.test(ticker)) {
    throw badRequest("INVALID_TICKER");
  }
  const parsed = parseDateStrict(dateStr);
  if (!parsed) throw new AppError("INVALID_DATE");

  // Pre-check: weekend (Sat/Sun) → no trading
  const probe = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
  const dow = probe.getUTCDay(); // 0=Sun, 6=Sat
  if (dow === 0 || dow === 6) {
    res.status(422).json({
      error: "non_trading_day",
      reason: "weekend",
      ticker,
      date: dateStr,
    });
    return;
  }
  const todayStr = nyDate();
  if (dateStr > todayStr) {
    res.status(422).json({
      error: "non_trading_day",
      reason: "future",
      ticker,
      date: dateStr,
    });
    return;
  }

  // For multi-day requests, the OLDEST day's age determines what intervals
  // Yahoo will accept (e.g. 1m only works for the last 7 days). Auto-pick
  // and per-interval validation use the oldest age.
  const targetDays = collectTradingDays(parsed, daysBack);
  const oldestDay = targetDays[0];
  const oldestAge = ageDaysOf(oldestDay);

  const requestedRaw = String(req.query.interval || "").toLowerCase().trim();
  const requested = ALLOWED_INTERVALS.has(requestedRaw as Interval) ? (requestedRaw as Interval) : null;
  const auto = pickIntervalForAge(oldestAge);
  let interval: Interval = requested && intervalAllowedForAge(requested, oldestAge) ? requested : auto;
  if (requested && requested !== "1d" && interval !== requested && !force) {
    // Archived / cached days keep the bars they had while fresh (same rule as the range route): finest interval the
    // trade day has, older context days that cannot match are dropped.
    const stored = await storedIntervals(ticker, targetDays.map((d) => d.str), extended);
    const pick = pickServedInterval(targetDays.map((d) => ({ str: d.str, age: ageDaysOf(d) })), requested, interval, stored);
    interval = pick.interval;
    targetDays.splice(0, pick.fromIndex);
  }

  // Fetch each requested trading day (cache-first), concatenate.
  // Holidays / no-data days are silently skipped.
  const allCandles: Candle[] = [];
  let allCached = true;
  let anyFetched = false;
  for (const day of targetDays) {
    const r = await fetchSingleDayWithCache(ticker, day, day.str, interval, extended, force, req.log);
    if (r) {
      allCandles.push(...r.candles);
      anyFetched = true;
      if (!r.cached) allCached = false;
    } else {
      // missing day — not catastrophic for multi-day; only fatal if it's the
      // primary trade day and nothing else was fetched
      allCached = false;
    }
  }

  if (!anyFetched || allCandles.length === 0) {
    sendError(res, new AppError("NO_DATA", 404, undefined, { ticker, date: dateStr, interval, extended, daysBack }));
    return;
  }

  // Sort by epoch and de-duplicate (in case overlapping days share boundary
  // candles — defensive, normally Yahoo splits cleanly per day).
  // Yahoo sometimes appends the *current* live bar (e.g. today's 60m bar) to
  // historical responses — and those got cached. Drop anything outside the
  // requested [oldest day open, trade day close] window.
  const windowStart = dayWindowEpochSeconds(targetDays[0] ?? oldestDay, extended).start - (interval === "1d" ? 86400 : 0);
  const windowEnd = dayWindowEpochSeconds(parsed, extended).end + (interval === "1d" ? 86400 : 0);
  allCandles.sort((a, b) => a.t - b.t);
  const dedup: Candle[] = [];
  let lastT = -1;
  for (const c of allCandles) {
    if (c.t < windowStart || c.t > windowEnd) continue;
    if (c.t !== lastT) { dedup.push(c); lastT = c.t; }
  }
  if (dedup.length === 0) {
    sendError(res, new AppError("NO_DATA", 404, undefined, { ticker, date: dateStr, interval, extended, daysBack }));
    return;
  }

  // prevClose is the close of the trading day BEFORE the TRADE DATE itself
  // (Y.close semantically means "yesterday close" relative to the trade day,
  // even when older context days are also visible).
  const prevClose = await getPrevDailyCloseCached(ticker, parsed, dateStr);

  // Optional trade-day session levels (premarket high/low, regular OHLC).
  // Premarket needs extended-hours bars: when the main request was regular-
  // hours only, fetch (and cache) the extended series for the trade day.
  let sessionLevels: SessionLevels | null | undefined;
  if (req.query.levels === "1" || req.query.levels === "true") {
    try {
      let source: Candle[] = dedup;
      if (interval !== "1d" && !extended) {
        const ext = await fetchSingleDayWithCache(ticker, parsed, dateStr, interval, true, false, req.log);
        if (ext?.candles?.length) source = ext.candles;
      }
      sessionLevels = interval === "1d" ? null : computeSessionLevels(source, dateStr);
    } catch (err) {
      req.log?.warn?.({ err, ticker, dateStr }, "session levels failed");
      sessionLevels = null;
    }
  }

  res.json({
    ...(sessionLevels !== undefined ? { sessionLevels } : {}),
    ticker,
    date: dateStr,
    interval,
    extended,
    daysBack,
    candles: dedup,
    prevClose,
    cached: allCached,
    fetchedAt: new Date().toISOString(),
  });
}));

export default router;
