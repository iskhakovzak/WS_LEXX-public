import { Router, type IRouter } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { logger } from "../lib/logger";
import { AppError, badRequest, sendErrorWith } from "../lib/http";

const router: IRouter = Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

type CallType = "BMO" | "AMC" | "TNS";

type CalendarRow = {
  ticker: string;
  company: string;
  callType: CallType;
  epsActual: number | null;
  epsEstimate: number | null;
  epsSurprisePct: number | null;
  marketCap: string | null;
  marketCapNum: number | null;
  fiscalQuarter: string | null;
  noOfEsts: number | null;
  lastYearEps: number | null;
  lastYearDate: string | null;
};

export type EarningsItem = CalendarRow & {
  price: number | null;
  priceMoveDay: number | null;
  pricePreMarket: number | null;
  pricePostMarket: number | null;
  volume: number | null;
  avgVolume: number | null;
  relVol: number | null;
};

function mapCallType(raw: string): CallType {
  const r = raw.toLowerCase();
  if (r.includes("pre") || r.includes("before") || r === "bmo") return "BMO";
  if (r.includes("after") || r.includes("post") || r === "amc") return "AMC";
  return "TNS";
}

function parseDollar(s: string | number | null | undefined): number | null {
  if (s == null) return null;
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  if (s === "N/A" || s === "--" || s.trim() === "") return null;
  const neg = /^\(.*\)$/.test(s.trim());
  const n = parseFloat(s.replace(/[$,()%]/g, "").trim());
  if (isNaN(n)) return null;
  return neg ? -n : n;
}

/** "M/D/YYYY" → "YYYY-MM-DD" (null when unparseable). */
function usDateToIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

const NASDAQ_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  Origin: "https://www.nasdaq.com",
  Referer: "https://www.nasdaq.com/",
};

// ── NASDAQ calendar (raw, no prices) — cached separately so "upcoming" doesn't hit Yahoo ──
const calendarCache = new Map<string, { ts: number; rows: CalendarRow[] }>();
const CALENDAR_TTL = 30 * 60 * 1000;

async function fetchNasdaqEarnings(date: string): Promise<CalendarRow[]> {
  try {
    const url = `https://api.nasdaq.com/api/calendar/earnings?date=${date}`;
    const resp = await fetch(url, { headers: NASDAQ_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      logger.warn({ status: resp.status, date }, "NASDAQ earnings API non-ok");
      return [];
    }
    const data = (await resp.json()) as any;
    const rows: any[] = data?.data?.rows ?? [];

    return rows
      .filter((r: any) => r.symbol && r.symbol.length >= 1 && r.symbol.length <= 7)
      .map((r: any): CalendarRow => {
        const epsActual = parseDollar(r.eps);
        const epsEstimate = parseDollar(r.epsForecast);
        let epsSurprisePct: number | null = null;
        if (r.surprise && r.surprise !== "N/A" && r.surprise !== "--") {
          const sp = parseDollar(r.surprise);
          if (sp != null) epsSurprisePct = sp;
        } else if (epsActual != null && epsEstimate != null && epsEstimate !== 0) {
          epsSurprisePct = +(((epsActual - epsEstimate) / Math.abs(epsEstimate)) * 100).toFixed(2);
        }
        const marketCap = r.marketCap && r.marketCap !== "N/A" ? String(r.marketCap) : null;
        return {
          ticker: String(r.symbol),
          company: r.name ?? r.symbol,
          callType: mapCallType(r.time ?? ""),
          epsActual,
          epsEstimate,
          epsSurprisePct,
          marketCap,
          marketCapNum: parseDollar(marketCap),
          fiscalQuarter: r.fiscalQuarterEnding ?? null,
          noOfEsts: parseDollar(r.noOfEsts),
          lastYearEps: parseDollar(r.lastYearEPS),
          lastYearDate: usDateToIso(r.lastYearRptDt),
        };
      });
  } catch (e: any) {
    logger.warn({ error: e?.message, date }, "NASDAQ earnings fetch failed");
    return [];
  }
}

async function getCalendar(date: string, force = false): Promise<CalendarRow[]> {
  const hit = calendarCache.get(date);
  if (!force && hit && Date.now() - hit.ts < CALENDAR_TTL) return hit.rows;
  const rows = await fetchNasdaqEarnings(date);
  // Don't cache an empty failure for long: keep the previous rows if the refetch came back empty.
  if (rows.length === 0 && hit) return hit.rows;
  calendarCache.set(date, { ts: Date.now(), rows });
  return rows;
}

const byMarketCapDesc = (a: CalendarRow, b: CalendarRow) => (b.marketCapNum ?? 0) - (a.marketCapNum ?? 0);

// Yahoo Finance quote: price snapshot for a ticker
async function fetchQuoteReaction(ticker: string) {
  const empty = {
    price: null,
    priceMoveDay: null,
    pricePreMarket: null,
    pricePostMarket: null,
    volume: null,
    avgVolume: null,
    relVol: null,
  };
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d&includePrePost=true`;
    const resp = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return empty;
    const data = (await resp.json()) as any;
    const result = data?.chart?.result?.[0] ?? {};
    const meta = result.meta ?? {};
    const closes: Array<number | null> = result?.indicators?.quote?.[0]?.close ?? [];
    const volumes: Array<number | null> = result?.indicators?.quote?.[0]?.volume ?? [];

    const price: number | null = meta.regularMarketPrice ?? null;
    // Previous *session* close: the second-to-last daily close (range=5d). chartPreviousClose is the
    // close before the whole range, which made "day %" a multi-day move.
    const validCloses = closes.filter((c): c is number => typeof c === "number");
    const prevClose: number | null =
      validCloses.length >= 2 ? validCloses[validCloses.length - 2] : meta.previousClose ?? meta.regularMarketPreviousClose ?? null;

    const priceMoveDay: number | null =
      meta.regularMarketChangePercent != null
        ? +Number(meta.regularMarketChangePercent).toFixed(2)
        : price != null && prevClose
          ? +(((price - prevClose) / prevClose) * 100).toFixed(2)
          : null;

    const preMarketPrice: number | null = meta.preMarketPrice ?? null;
    const pricePreMarket: number | null =
      preMarketPrice != null && prevClose
        ? +(((preMarketPrice - prevClose) / prevClose) * 100).toFixed(2)
        : meta.preMarketChangePercent != null
          ? +Number(meta.preMarketChangePercent).toFixed(2)
          : null;

    const postMarketPrice: number | null = meta.postMarketPrice ?? null;
    const pricePostMarket: number | null =
      postMarketPrice != null && price
        ? +(((postMarketPrice - price) / price) * 100).toFixed(2)
        : meta.postMarketChangePercent != null
          ? +Number(meta.postMarketChangePercent).toFixed(2)
          : null;

    const volume: number | null = meta.regularMarketVolume ?? null;
    const pastVols = volumes.slice(0, -1).filter((v): v is number => typeof v === "number" && v > 0);
    const avgVolume: number | null =
      meta.averageDailyVolume3Month ??
      meta.averageDailyVolume10Day ??
      (pastVols.length ? Math.round(pastVols.reduce((s, v) => s + v, 0) / pastVols.length) : null);
    const relVol: number | null = volume != null && avgVolume && avgVolume > 0 ? +(volume / avgVolume).toFixed(2) : null;

    return { price, priceMoveDay, pricePreMarket, pricePostMarket, volume, avgVolume, relVol };
  } catch {
    return empty;
  }
}

export function etDate(offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

// ── Watch cache (calendar + prices, 15 min per date) ──
const cache = new Map<string, { ts: number; items: EarningsItem[] }>();
const inflight = new Map<string, Promise<EarningsItem[]>>();
const CACHE_TTL = 15 * 60 * 1000;
/** A forced refresh is honoured at most once per this window (per date, and globally). */
const REFRESH_MIN_INTERVAL = 60 * 1000;
let lastForcedRefresh = 0;

export async function getEarnings(date: string, force = false): Promise<EarningsItem[]> {
  const now = Date.now();
  const hit = cache.get(date);
  if (!force && hit && now - hit.ts < CACHE_TTL) return hit.items;
  const running = inflight.get(date);
  if (running) return running;

  const p = (async () => {
    const raw = await getCalendar(date, force);
    // Price data only for the 30 largest names that have a market cap (keeps Yahoo calls bounded).
    const notable = raw.filter((e) => e.marketCapNum != null && e.marketCapNum > 0).sort(byMarketCapDesc).slice(0, 30);
    const withReaction = await Promise.all(
      notable.map(async (e) => ({ ...e, ...(await fetchQuoteReaction(e.ticker)) })),
    );
    if (withReaction.length === 0 && hit) return hit.items;
    cache.set(date, { ts: Date.now(), items: withReaction });
    return withReaction;
  })().finally(() => inflight.delete(date));
  inflight.set(date, p);
  return p;
}

function weekdayOf(isoDate: string) {
  return new Date(isoDate + "T12:00:00Z").getUTCDay();
}

// Find the most recent non-empty AMC date within the last N trading days
async function findRecentAmc(maxDaysBack: number, force: boolean): Promise<{ date: string; items: EarningsItem[] }> {
  const offsets: number[] = [];
  for (let i = 1; offsets.length < maxDaysBack && i <= 10; i++) {
    const wd = weekdayOf(etDate(-i));
    if (wd !== 0 && wd !== 6) offsets.push(-i);
  }
  for (const offset of offsets) {
    const date = etDate(offset);
    const items = await getEarnings(date, force && offset === offsets[0]);
    if (items.filter((e) => e.callType === "AMC").length >= 3) return { date, items };
  }
  const fallbackDate = etDate(offsets[0] ?? -1);
  return { date: fallbackDate, items: await getEarnings(fallbackDate) };
}

// GET /api/earnings/watch[?refresh=1]
router.get(
  "/earnings/watch",
  asyncHandler(async (req, res) => {
    const today = etDate(0);
    const wantRefresh = req.query.refresh === "1" || req.query.refresh === "true";
    const now = Date.now();
    const todayHit = cache.get(today);
    const cacheAge = todayHit ? now - todayHit.ts : Infinity;
    // Rate limit: ignore the bypass if someone (anyone) forced a refresh <60s ago or the data is <60s old.
    const throttled = wantRefresh && (now - lastForcedRefresh < REFRESH_MIN_INTERVAL || cacheAge < REFRESH_MIN_INTERVAL);
    const force = wantRefresh && !throttled;
    if (force) lastForcedRefresh = now;

    const [todayItems, amcResult] = await Promise.all([getEarnings(today, force), findRecentAmc(3, force)]);

    const bmo = todayItems
      .filter((e) => e.callType === "BMO" || e.callType === "TNS")
      .sort((a, b) => Math.abs(b.priceMoveDay ?? b.pricePreMarket ?? 0) - Math.abs(a.priceMoveDay ?? a.pricePreMarket ?? 0));

    const amc = amcResult.items
      .filter((e) => e.callType === "AMC" || e.callType === "TNS")
      .sort((a, b) => Math.abs(b.pricePostMarket ?? b.priceMoveDay ?? 0) - Math.abs(a.pricePostMarket ?? a.priceMoveDay ?? 0));

    const fetchedTs = cache.get(today)?.ts ?? now;
    const nextRefreshTs = Math.max(lastForcedRefresh, fetchedTs) + REFRESH_MIN_INTERVAL;
    res.json({
      date: today,
      amcDate: amcResult.date,
      bmo,
      amc,
      fetchedAt: new Date(fetchedTs).toISOString(),
      refreshed: force,
      throttled,
      nextRefreshAt: new Date(nextRefreshTs).toISOString(),
    });
  }),
);

// GET /api/earnings/upcoming?days=5[&tickers=NVDA,MU] — next N trading days (incl. today), calendar only.
// `tickers` (optional, ≤ 60): those symbols are always returned for each day, even when they fall outside
// the top-`limit` by market cap — the «Катализаторы» page asks for the trader's own tickers this way.
router.get(
  "/earnings/upcoming",
  asyncHandler(async (req, res) => {
    const daysRaw = Number(req.query.days ?? 5);
    const days = Number.isFinite(daysRaw) ? Math.min(10, Math.max(1, Math.floor(daysRaw))) : 5;
    const limitRaw = Number(req.query.limit ?? 25);
    const limit = Number.isFinite(limitRaw) ? Math.min(60, Math.max(5, Math.floor(limitRaw))) : 25;
    const wanted = new Set(
      String(req.query.tickers ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s))
        .slice(0, 60),
    );
    const pick = (list: CalendarRow[]) => {
      const sorted = [...list].sort(byMarketCapDesc);
      const top = sorted.slice(0, limit);
      if (!wanted.size) return top;
      const seen = new Set(top.map((r) => r.ticker));
      return top.concat(sorted.filter((r) => wanted.has(r.ticker) && !seen.has(r.ticker)));
    };

    const dates: string[] = [];
    for (let i = 0; dates.length < days && i <= 16; i++) {
      const d = etDate(i);
      const wd = weekdayOf(d);
      if (wd !== 0 && wd !== 6) dates.push(d);
    }
    const lists = await Promise.all(dates.map((d) => getCalendar(d)));
    res.json({
      today: etDate(0),
      days: dates.map((date, i) => ({
        date,
        total: lists[i].length,
        items: pick(lists[i]),
      })),
      fetchedAt: new Date().toISOString(),
    });
  }),
);

// ── Per-ticker history: last reported quarters + price reaction ──
type Candle = { date: string; open: number; close: number; high: number; low: number };

type HistoryQuarter = {
  fiscalQuarter: string | null;
  date: string;
  epsActual: number | null;
  epsEstimate: number | null;
  surprisePct: number | null;
  beat: boolean | null;
  reactionDate: string | null;
  gapPct: number | null;
  dayPct: number | null;
  closePct: number | null;
  rangePct: number | null;
};

type HistoryPayload = {
  ticker: string;
  timing: CallType | null;
  quarters: HistoryQuarter[];
  streak: { kind: "beat" | "miss" | null; count: number };
  beats: number;
  misses: number;
  avgAbsGap: number | null;
  avgAbsClose: number | null;
  upReactions: number;
  downReactions: number;
  fetchedAt: string;
};

const historyCache = new Map<string, { ts: number; data: HistoryPayload }>();
const HISTORY_TTL = 6 * 60 * 60 * 1000;
const HISTORY_CACHE_MAX = 400;

async function fetchDailyCandles(ticker: string): Promise<Candle[] | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`;
    const resp = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    const r = data?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const q = r?.indicators?.quote?.[0] ?? {};
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
    const out: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const open = q.open?.[i], close = q.close?.[i], high = q.high?.[i], low = q.low?.[i];
      if ([open, close, high, low].some((v) => typeof v !== "number")) continue;
      out.push({ date: fmt.format(new Date(ts[i] * 1000)), open, close, high, low });
    }
    return out;
  } catch {
    return null;
  }
}

async function fetchSurpriseHistory(ticker: string) {
  try {
    const url = `https://api.nasdaq.com/api/company/${encodeURIComponent(ticker)}/earnings-surprise`;
    const resp = await fetch(url, { headers: NASDAQ_HEADERS, signal: AbortSignal.timeout(12000) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    const rows: any[] = data?.data?.earningsSurpriseTable?.rows ?? [];
    return rows
      .map((r) => ({
        fiscalQuarter: r.fiscalQtrEnd ?? null,
        date: usDateToIso(r.dateReported),
        epsActual: parseDollar(r.eps),
        epsEstimate: parseDollar(r.consensusForecast),
        surprisePct: parseDollar(r.percentageSurprise),
      }))
      .filter((r): r is typeof r & { date: string } => !!r.date);
  } catch {
    return null;
  }
}

const pct = (a: number, b: number) => +(((a - b) / b) * 100).toFixed(2);

function reactionAt(candles: Candle[], idx: number) {
  if (idx <= 0 || idx >= candles.length) return null;
  const c = candles[idx];
  const prev = candles[idx - 1];
  return {
    reactionDate: c.date,
    gapPct: pct(c.open, prev.close),
    dayPct: pct(c.close, c.open),
    closePct: pct(c.close, prev.close),
    rangePct: pct(c.high, c.low),
  };
}

async function buildHistory(ticker: string, timing: CallType | null): Promise<HistoryPayload & { upstreamFailed: boolean }> {
  const [rowsRaw, candlesRaw] = await Promise.all([fetchSurpriseHistory(ticker), fetchDailyCandles(ticker)]);
  // null = upstream unreachable (503 + short negative cache), [] = genuinely nothing reported.
  const upstreamFailed = rowsRaw === null;
  const rows = rowsRaw ?? [];
  const candles = candlesRaw ?? [];
  const quarters: HistoryQuarter[] = rows
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((r) => {
      let surprisePct = r.surprisePct;
      if (surprisePct == null && r.epsActual != null && r.epsEstimate != null && r.epsEstimate !== 0) {
        surprisePct = pct(r.epsActual, r.epsEstimate) * Math.sign(r.epsEstimate);
      }
      const beat = r.epsActual != null && r.epsEstimate != null ? r.epsActual >= r.epsEstimate : null;
      // Index of the first session on/after the report date.
      const i = candles.findIndex((c) => c.date >= r.date);
      let reaction: ReturnType<typeof reactionAt> = null;
      if (i > 0) {
        const sameDay = candles[i].date === r.date;
        if (timing === "BMO") reaction = reactionAt(candles, i);
        else if (timing === "AMC") reaction = reactionAt(candles, sameDay ? i + 1 : i);
        else {
          // Unknown timing: the reaction session is whichever of report day / next day gapped harder.
          const a = reactionAt(candles, i);
          const b = sameDay ? reactionAt(candles, i + 1) : null;
          reaction = !b ? a : !a ? b : Math.abs(b.gapPct) > Math.abs(a.gapPct) ? b : a;
        }
      }
      return {
        fiscalQuarter: r.fiscalQuarter,
        date: r.date,
        epsActual: r.epsActual,
        epsEstimate: r.epsEstimate,
        surprisePct,
        beat,
        reactionDate: reaction?.reactionDate ?? null,
        gapPct: reaction?.gapPct ?? null,
        dayPct: reaction?.dayPct ?? null,
        closePct: reaction?.closePct ?? null,
        rangePct: reaction?.rangePct ?? null,
      };
    });

  let streak: HistoryPayload["streak"] = { kind: null, count: 0 };
  for (const q of quarters) {
    if (q.beat == null) break;
    const kind = q.beat ? "beat" : "miss";
    if (streak.kind == null) streak = { kind, count: 1 };
    else if (streak.kind === kind) streak.count++;
    else break;
  }
  const gaps = quarters.map((q) => q.gapPct).filter((v): v is number => v != null);
  const closes = quarters.map((q) => q.closePct).filter((v): v is number => v != null);
  const avg = (xs: number[]) => (xs.length ? +(xs.reduce((s, v) => s + Math.abs(v), 0) / xs.length).toFixed(2) : null);

  return {
    ticker,
    timing,
    quarters,
    streak,
    beats: quarters.filter((q) => q.beat === true).length,
    misses: quarters.filter((q) => q.beat === false).length,
    avgAbsGap: avg(gaps),
    avgAbsClose: avg(closes),
    upReactions: closes.filter((v) => v > 0).length,
    downReactions: closes.filter((v) => v < 0).length,
    fetchedAt: new Date().toISOString(),
    upstreamFailed,
  };
}

/** Upstream failures are remembered briefly so a dead calendar/quote host is not re-polled on every render. */
const historyNegative = new Map<string, number>();
const HISTORY_NEGATIVE_TTL = 5 * 60 * 1000;

// GET /api/earnings/history/:ticker[?timing=BMO|AMC]
router.get(
  "/earnings/history/:ticker",
  asyncHandler(async (req, res) => {
    const ticker = String(req.params.ticker ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
      throw badRequest("INVALID_TICKER");
    }
    const t = String(req.query.timing ?? "").toUpperCase();
    const timing: CallType | null = t === "BMO" || t === "AMC" ? t : null;
    const key = `${ticker}:${timing ?? "auto"}`;
    const hit = historyCache.get(key);
    if (hit && Date.now() - hit.ts < HISTORY_TTL) {
      res.json(hit.data);
      return;
    }
    const neg = historyNegative.get(key);
    if (neg && Date.now() - neg < HISTORY_NEGATIVE_TTL) {
      sendErrorWith(res, new AppError("UPSTREAM_UNAVAILABLE"), { retryAfterSec: Math.ceil((HISTORY_NEGATIVE_TTL - (Date.now() - neg)) / 1000) });
      return;
    }
    const { upstreamFailed, ...data } = await buildHistory(ticker, timing);
    if (upstreamFailed && data.quarters.length === 0) {
      if (historyNegative.size > HISTORY_CACHE_MAX) historyNegative.clear();
      historyNegative.set(key, Date.now());
      sendErrorWith(res, new AppError("UPSTREAM_UNAVAILABLE"), { retryAfterSec: Math.ceil(HISTORY_NEGATIVE_TTL / 1000) });
      return;
    }
    if (data.quarters.length > 0) {
      if (historyCache.size >= HISTORY_CACHE_MAX) {
        const oldest = historyCache.keys().next().value;
        if (oldest) historyCache.delete(oldest);
      }
      historyCache.set(key, { ts: Date.now(), data });
    }
    res.json(data);
  }),
);

export default router;
