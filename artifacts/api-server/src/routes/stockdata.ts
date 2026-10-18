import { Router, type IRouter } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { logger } from "../lib/logger";
import { getTickerFundamentals } from "../lib/marketDataService";
import { AppError, badRequest, sendError } from "../lib/http";

type YahooStockMeta = {
  regularMarketPrice?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketTime?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  longName?: string;
  shortName?: string;
};

type YahooStockQuote = {
  open?: Array<number | null>;
  high?: Array<number | null>;
  low?: Array<number | null>;
  close?: Array<number | null>;
  volume?: Array<number | null>;
};

type YahooStockResult = {
  meta?: YahooStockMeta;
  timestamp?: number[];
  indicators?: { quote?: YahooStockQuote[] };
};

type YahooStockResponse = {
  chart?: { result?: YahooStockResult[] };
};

const router: IRouter = Router();

router.get("/stockdata/fundamentals", asyncHandler(async (req, res): Promise<void> => {
  const ticker = String(req.query.ticker || "").toUpperCase().trim();
  if (!ticker) throw badRequest("TICKER_REQUIRED");
  const force = req.query.force === "1" || req.query.force === "true";
  const data = await getTickerFundamentals(ticker, { force });
  if (!data) throw new AppError("NO_DATA", 404, undefined, { ticker });
  res.json(data);
}));

/**
 * Bounded LRU: one entry per symbol (quotes) or per chart key, so a request for {A,B} reuses
 * the quote fetched for {A} a moment ago, and the map can never grow beyond MAX_CACHE entries.
 */
const cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 60_000;
const MAX_CACHE = 500;
function cacheGet(key: string, ttl: number): any | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.ts >= ttl) { cache.delete(key); return undefined; }
  cache.delete(key); cache.set(key, hit); // refresh recency
  return hit.data;
}
function cacheSet(key: string, data: any): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { data, ts: Date.now() });
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

const SYMBOL_RE = /^[A-Z0-9.\-^=]{1,12}$/;
const nyDate = (sec: number) => new Date(sec * 1000).toLocaleDateString("en-US", { timeZone: "America/New_York" });

router.get("/stockdata/quote", asyncHandler(async (req, res): Promise<void> => {
  // `?symbol=X` (single) returns a flat quote object with `symbol`; `?symbols=A,B` returns a map.
  const single = req.query.symbols == null && req.query.symbol != null
    ? String(req.query.symbol).toUpperCase().trim()
    : null;
  const symbols = Array.from(new Set(
    (single ?? String(req.query.symbols || "")).toUpperCase().split(",").map((s) => s.trim()).filter(Boolean),
  ));
  if (!symbols.length) throw new AppError("FIELD_REQUIRED", undefined, { field: "symbols" });
  if (symbols.length > 50) throw new AppError("TOO_MANY", undefined, { field: "symbols", max: 50 });
  const bad = symbols.find((s) => !SYMBOL_RE.test(s));
  if (bad) throw new AppError("INVALID_SYMBOL", 400, undefined, { symbol: bad });

  const respond = (data: Record<string, any>) => {
    if (!single) { res.json(data); return; }
    const q = data[single];
    if (!q) { sendError(res, new AppError("NO_DATA", 404, undefined, { symbol: single })); return; }
    res.json({ symbol: single, ...q });
  };

  // Per-symbol cache: only the symbols missing from the cache are fetched upstream.
  const results: Record<string, any> = {};
  const missing: string[] = [];
  for (const sym of symbols) {
    const hit = cacheGet(`q_${sym}`, CACHE_TTL);
    if (hit) results[sym] = hit; else missing.push(sym);
  }
  if (!missing.length) { respond(results); return; }

  try {
    await Promise.all(missing.map(async (sym) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1mo&interval=1d&includePrePost=true`;
        const resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
          signal: AbortSignal.timeout(8_000),
        });
        if (!resp.ok) return;
        const data = (await resp.json()) as YahooStockResponse;
        const chart = data?.chart?.result?.[0];
        if (!chart) return;

        const meta = chart.meta || {};
        const quote = chart.indicators?.quote?.[0] || {};
        const timestamps = chart.timestamp || [];
        const closes = quote.close || [];
        const volumes = quote.volume || [];
        const highs = quote.high || [];
        const lows = quote.low || [];
        const opens = quote.open || [];

        // chartPreviousClose is the close BEFORE the 1-month range, not yesterday's close.
        // Derive the previous session close from the daily bars instead.
        const lastIdx = timestamps.length - 1;
        const lastIsToday = lastIdx >= 0 && meta.regularMarketTime != null
          && nyDate(timestamps[lastIdx]) === nyDate(meta.regularMarketTime);
        const prevIdx = lastIsToday ? lastIdx - 1 : lastIdx;
        let prevClose: number | null = null;
        for (let i = prevIdx; i >= 0; i--) {
          const c = closes[i];
          if (c != null && c > 0) { prevClose = c; break; }
        }
        if (prevClose == null) prevClose = meta.previousClose ?? null;
        const open = lastIsToday ? opens[lastIdx] ?? null : null;
        const gapPct = prevClose && open ? +(((open - prevClose) / prevClose) * 100).toFixed(2) : null;

        const pastVols = (lastIsToday ? volumes.slice(0, -1) : volumes)
          .filter((v): v is number => typeof v === "number" && v > 0);
        const avgVol = pastVols.length
          ? Math.round(pastVols.reduce((a, b) => a + b, 0) / pastVols.length)
          : null;
        const currentVol = lastIsToday ? volumes[lastIdx] ?? null : null;
        const rvol = avgVol && currentVol ? +(currentVol / avgVol).toFixed(2) : null;

        const candles = timestamps.map((_ts, i) => ({
          h: highs[i] ?? 0, l: lows[i] ?? 0, c: closes[i] ?? 0
        })).filter((c) => c.c > 0);
        const atr = calcATR(candles);

        results[sym] = {
          price: meta.regularMarketPrice ?? null,
          change: prevClose && meta.regularMarketPrice
            ? +(((meta.regularMarketPrice - prevClose) / prevClose) * 100).toFixed(2) : null,
          open,
          high: meta.regularMarketDayHigh ?? null,
          low: meta.regularMarketDayLow ?? null,
          prevClose,
          volume: meta.regularMarketVolume ?? currentVol,
          avgVolume: avgVol,
          relativeVolume: rvol,
          preMarketPrice: null,
          preMarketChange: null,
          high52w: meta.fiftyTwoWeekHigh ?? null,
          low52w: meta.fiftyTwoWeekLow ?? null,
          marketCap: null,
          name: meta.longName ?? meta.shortName ?? sym,
          gapPct,
          atr,
          // Additive: last ~22 daily closes for list sparklines + quote timestamp (ms).
          spark: closes.filter((c): c is number => typeof c === "number" && c > 0).slice(-22).map((c) => +c.toFixed(4)),
          marketTime: meta.regularMarketTime != null ? meta.regularMarketTime * 1000 : null,
          // NY session date of the quote — lets clients tell «today's bar» from a stale after-hours print.
          marketDate: meta.regularMarketTime != null ? nyDate(meta.regularMarketTime) : null,
        };
        cacheSet(`q_${sym}`, results[sym]);
      } catch (err: any) {
        logger.warn({ symbol: sym, error: err.message }, "Failed to fetch single symbol");
      }
    }));

    respond(results);
  } catch (e: any) {
    logger.warn({ error: e.message }, "Yahoo Finance quote error");
    if (e instanceof AppError) throw e;
    throw new AppError("UPSTREAM_FAILED");
  }
}));

router.get("/stockdata/chart", asyncHandler(async (req, res): Promise<void> => {
  const symbol = String(req.query.symbol || "").toUpperCase();
  const range = String(req.query.range || "5d");
  const interval = String(req.query.interval || "1d");
  if (!symbol) throw new AppError("TICKER_REQUIRED");
  if (!/^[A-Z0-9.\-^=]{1,12}$/.test(symbol)) throw new AppError("INVALID_SYMBOL");
  if (!/^[a-z0-9]{1,5}$/.test(range)) throw new AppError("INVALID_RANGE", undefined, { max: 400 });
  if (!/^[a-z0-9]{1,5}$/.test(interval)) throw new AppError("INVALID_FIELD", undefined, { field: "interval" });

  const cKey = `chart_${symbol}_${range}_${interval}`;
  const cachedChart = cacheGet(cKey, CACHE_TTL * 5);
  if (cachedChart) { res.json(cachedChart); return; }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) throw new Error(`Yahoo chart: ${resp.status}`);
    const data = (await resp.json()) as YahooStockResponse;

    const result = data?.chart?.result?.[0];
    if (!result) { res.json({ candles: [] }); return; }

    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const candles = timestamps.map((ts, i) => ({
      t: ts * 1000,
      o: quote.open?.[i] ?? null,
      h: quote.high?.[i] ?? null,
      l: quote.low?.[i] ?? null,
      c: quote.close?.[i] ?? null,
      v: quote.volume?.[i] ?? null,
    })).filter((c) => c.c !== null);

    const meta = result.meta || {};
    const atrCandles = candles
      .filter((c): c is typeof c & { h: number; l: number; c: number } =>
        c.h != null && c.l != null && c.c != null)
      .map((c) => ({ h: c.h, l: c.l, c: c.c }));
    const chartData = {
      candles,
      atr: calcATR(atrCandles),
      prevClose: meta.chartPreviousClose ?? null,
    };

    cacheSet(cKey, chartData);
    res.json(chartData);
  } catch (e: any) {
    logger.warn({ error: e.message }, "Yahoo Finance chart error");
    throw new AppError("UPSTREAM_FAILED");
  }
}));

function calcATR(candles: { h: number; l: number; c: number }[]): number | null {
  if (candles.length < 15) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prevC = candles[i - 1].c;
    const h = candles[i].h;
    const l = candles[i].l;
    trs.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
  }
  const last14 = trs.slice(-14);
  return +(last14.reduce((a, b) => a + b, 0) / last14.length).toFixed(2);
}

export default router;
