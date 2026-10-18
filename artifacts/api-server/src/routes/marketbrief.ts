import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { requireAiConfigured } from "../lib/aiErrors";
import { asyncHandler } from "../lib/asyncHandler";
import { requireCap } from "../lib/permissions";
import { logger } from "../lib/logger";
import { getSectorStrength, SECTOR_ETFS } from "../lib/marketDataService";
import { nyDate } from "../lib/tradingDate";
import { langOf, type Lang } from "../i18n";
import { marketbriefT } from "../i18n/ns";
import { aiLanguageName } from "../i18n/ai";
import { localizeCalendarRow } from "../lib/calendarText";

const router: IRouter = Router();

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const YAHOO_HEADERS = { "User-Agent": UA, "Accept": "application/json", "Accept-Language": "en-US,en;q=0.9" };
const FUTURES = [
  // indexSymbol  → used for Friday session changePct (may be composite index for correct %)
  // pmIndexSymbol → used for premarket deviation % (must match futures price scale)
  { symbol: "ES=F",  name: "S&P 500",    indexSymbol: "^GSPC", pmIndexSymbol: "^GSPC" },
  { symbol: "NQ=F",  name: "Nasdaq 100", indexSymbol: "^IXIC", pmIndexSymbol: "^NDX"  },
  { symbol: "YM=F",  name: "Dow",        indexSymbol: "^DJI",  pmIndexSymbol: "^DJI"  },
  { symbol: "RTY=F", name: "Russell",    indexSymbol: "^RUT",  pmIndexSymbol: "^RUT"  },
];

const OVERNIGHT_INDICES = [
  { symbol: "^N225", name: "Nikkei 225", region: "Asia" },
  { symbol: "^HSI", name: "Hang Seng", region: "Asia" },
  { symbol: "000001.SS", name: "Shanghai", region: "Asia" },
  { symbol: "^KS11", name: "KOSPI", region: "Asia" },
  { symbol: "^GDAXI", name: "DAX", region: "Europe" },
  { symbol: "^FTSE", name: "FTSE 100", region: "Europe" },
  { symbol: "^STOXX50E", name: "Euro Stoxx 50", region: "Europe" },
  { symbol: "^FCHI", name: "CAC 40", region: "Europe" },
];

const MACRO_TICKERS = [
  { symbol: "^VIX", name: "VIX", kind: "vol" },
  { symbol: "DX-Y.NYB", name: "DXY", kind: "fx" },
  { symbol: "^TNX", name: "US10Y", kind: "rate" },
  { symbol: "CL=F", name: "WTI Oil", kind: "commodity" },
  { symbol: "GC=F", name: "Gold", kind: "commodity" },
  { symbol: "BTC-USD", name: "Bitcoin", kind: "crypto" },
];

const AI_MODEL = "claude-sonnet-4-6";
const AI_TIMEOUT_MS = 25_000;

type QuoteSnapshot = {
  price: number | null;
  changePct: number | null;
  prevClose: number | null;
  preMarketPrice: number | null;
  preMarketChangePct: number | null;
  postMarketPrice: number | null;
  postMarketChangePct: number | null;
};

const EMPTY_QUOTE: QuoteSnapshot = { price: null, changePct: null, prevClose: null, preMarketPrice: null, preMarketChangePct: null, postMarketPrice: null, postMarketChangePct: null };

type YahooV8Meta = {
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  preMarketPrice?: number;
  preMarketChangePercent?: number;
  postMarketPrice?: number;
  postMarketChangePercent?: number;
};
type YahooV8Result = {
  meta?: YahooV8Meta;
  timestamp?: number[];
  indicators?: { quote?: Array<{ close?: (number | null)[] }> };
};
type YahooV8Response = { chart?: { result?: YahooV8Result[] } };

async function fetchYahooQuote(symbol: string): Promise<QuoteSnapshot> {
  try {
    // range=5d gives enough history so chartPreviousClose / closes array reliably
    // reflects the last completed trading SESSION, not a stale or partial reference.
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d&includePrePost=false`;
    const resp = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return { ...EMPTY_QUOTE };
    const data = (await resp.json()) as YahooV8Response;
    const result = data?.chart?.result?.[0];
    if (!result) return { ...EMPTY_QUOTE };
    const meta = result.meta ?? {};
    const price = meta.regularMarketPrice ?? null;

    // Build validated closes list from OHLC bars
    const rawCloses = result.indicators?.quote?.[0]?.close ?? [];
    const timestamps = result.timestamp ?? [];
    const closes: number[] = [];
    for (let i = 0; i < rawCloses.length; i++) {
      const c = rawCloses[i];
      if (c != null && isFinite(c)) closes.push(c);
    }

    // Determine prevClose:
    // If the most recent bar's timestamp is TODAY (in progress), use closes[-2] as the last
    // completed session close; otherwise closes[-1] is the last completed close.
    let prevClose: number | null = null;
    if (closes.length >= 2) {
      const lastTs = timestamps[timestamps.length - 1];
      // session dates in New York (audit P1-12): UTC flips to "tomorrow" at 20:00 ET
      const todayDateStr = nyDate();
      const lastBarDateStr = lastTs ? nyDate(new Date(lastTs * 1000)) : null;
      const lastBarIsToday = lastBarDateStr === todayDateStr;
      if (lastBarIsToday) {
        // Partial bar (futures/crypto trading today): use closes[-2] = last completed session
        prevClose = closes[closes.length - 2];
      } else {
        // Closed market (cash index, premarket): closes[-1] = last session, closes[-2] = prev session
        prevClose = closes[closes.length - 2];
      }
    }
    prevClose = prevClose ?? meta.chartPreviousClose ?? meta.previousClose ?? null;

    const changePct = price != null && prevClose ? +(((price - prevClose) / prevClose) * 100).toFixed(3) : null;
    const preMarketPrice = meta.preMarketPrice ?? null;
    const preMarketChangePct = preMarketPrice != null && prevClose
      ? +(((preMarketPrice - prevClose) / prevClose) * 100).toFixed(3)
      : (meta.preMarketChangePercent != null ? +meta.preMarketChangePercent.toFixed(3) : null);
    const postMarketPrice = meta.postMarketPrice ?? null;
    const postMarketChangePct = postMarketPrice != null && price
      ? +(((postMarketPrice - price) / price) * 100).toFixed(3)
      : (meta.postMarketChangePercent != null ? +meta.postMarketChangePercent.toFixed(3) : null);
    return { price, changePct, prevClose, preMarketPrice, preMarketChangePct, postMarketPrice, postMarketChangePct };
  } catch {
    return { ...EMPTY_QUOTE };
  }
}

async function fetchBatchQuotes(symbols: string[]): Promise<Record<string, QuoteSnapshot>> {
  const entries = await Promise.all(symbols.map(async (s) => [s, await fetchYahooQuote(s)] as const));
  return Object.fromEntries(entries);
}

/** Live quotes part of the brief (futures, overnight, macro, watchlist movers). No AI, no DB writes. */
async function buildQuotes() {
  // Fetch watchlist tickers from DB first so we can batch all symbols together
  const { rows: watchRows } = await pool.query<any>(
    `SELECT id, ticker, catalyst, target_price, stop_price, status, sector
     FROM watchlist WHERE deleted_at IS NULL AND status = 'watching' ORDER BY created_at DESC LIMIT 50`
  );
  const watchTickers = watchRows.map((r: any) => r.ticker as string).slice(0, 12);

  // Single batch call for all symbols (futures + their underlying indices)
  const futuresIndexSymbols = [
    ...new Set([
      ...FUTURES.map((f) => f.indexSymbol),
      ...FUTURES.map((f) => f.pmIndexSymbol),
    ]),
  ];
  const allSymbols = [
    ...FUTURES.map((f) => f.symbol),
    ...futuresIndexSymbols,
    ...OVERNIGHT_INDICES.map((i) => i.symbol),
    ...MACRO_TICKERS.map((m) => m.symbol),
    ...watchTickers,
  ];
  const quotes = await fetchBatchQuotes(allSymbols);

  // For futures: use the underlying INDEX's changePct (last completed session = Friday's move)
  // and preMarketChangePct = deviation of futures price from the price-scale-matched index close.
  // This gives traders the Friday context (-2.64%) AND today's premarket indication (+0.46%).
  const futures = FUTURES.map((f) => {
    const q = quotes[f.symbol] ?? { ...EMPTY_QUOTE };            // futures contract
    const idx = quotes[f.indexSymbol] ?? { ...EMPTY_QUOTE };     // index for session changePct
    const pmIdx = quotes[f.pmIndexSymbol] ?? idx;                // price-scale-matched index for pmPct
    const futuresPrice = q.price;
    const pmIndexLastClose = pmIdx.price;  // last session close at same price scale as futures
    const sessionChangePct = idx.changePct;  // Friday session % from composite/cash index
    const preMarketChangePct = futuresPrice != null && pmIndexLastClose != null && pmIndexLastClose !== 0
      ? +(((futuresPrice - pmIndexLastClose) / pmIndexLastClose) * 100).toFixed(3)
      : null;
    return {
      symbol: f.symbol,
      name: f.name,
      price: futuresPrice,
      changePct: sessionChangePct,
      prevClose: idx.prevClose,
      preMarketPrice: futuresPrice,
      preMarketChangePct,
      postMarketPrice: q.postMarketPrice,
      postMarketChangePct: q.postMarketChangePct,
    };
  });

  const overnight = OVERNIGHT_INDICES.map((i) => {
    const q = quotes[i.symbol] ?? { ...EMPTY_QUOTE };
    return { symbol: i.symbol, name: i.name, region: i.region, price: q.price, changePct: q.changePct };
  });

  const macro = MACRO_TICKERS.map((m) => {
    const q = quotes[m.symbol] ?? { ...EMPTY_QUOTE };
    return { symbol: m.symbol, name: m.name, kind: m.kind, price: q.price, changePct: q.changePct };
  });

  const gapData: Record<string, QuoteSnapshot> = {};
  watchTickers.forEach((t: string) => { gapData[t] = quotes[t] ?? { ...EMPTY_QUOTE }; });

  const gapLeaders = watchRows
    .map((r: any) => ({ ...r, gap: gapData[r.ticker] }))
    .filter((r: any) => r.gap?.changePct != null && Math.abs(r.gap.changePct as number) > 1)
    .sort((a: any, b: any) => Math.abs(b.gap.changePct as number) - Math.abs(a.gap.changePct as number))
    .slice(0, 8)
    .map((r: any) => ({
      ticker: r.ticker,
      catalyst: r.catalyst,
      sector: r.sector,
      gapPct: r.gap.changePct,
      price: r.gap.price,
    }));

  // Premarket movers: ranked by abs(preMarketChangePct) when available
  const premarketMovers = watchRows
    .map((r: any) => ({ ...r, gap: gapData[r.ticker] }))
    .filter((r: any) => r.gap?.preMarketChangePct != null && Math.abs(r.gap.preMarketChangePct as number) > 0.5)
    .sort((a: any, b: any) => Math.abs(b.gap.preMarketChangePct as number) - Math.abs(a.gap.preMarketChangePct as number))
    .slice(0, 8)
    .map((r: any) => ({
      ticker: r.ticker,
      catalyst: r.catalyst,
      sector: r.sector,
      preMarketPct: r.gap.preMarketChangePct,
      preMarketPrice: r.gap.preMarketPrice,
      prevClose: r.gap.prevClose,
    }));

  return { futures, overnight, macro, premarketMovers, gapLeaders };
}

async function buildBrief(date: string, lang: Lang = "ru"): Promise<any> {
  const { futures, overnight, macro, premarketMovers, gapLeaders } = await buildQuotes();

  const sectors = await getSectorStrength().catch((): Awaited<ReturnType<typeof getSectorStrength>> => []);
  const sectorRotation = sectors
    .filter((s) => s.changePct != null)
    .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
    .map((s) => ({ symbol: s.symbol, name: s.name, changePct: s.changePct, trend5d: s.trend5d }));

  const today = date;
  const { startDate, endDate, label, days, kind } = lookbackWindow(today);
  const sevenDaysOut = new Date(new Date(today).getTime() + 7 * 86400_000).toISOString().slice(0, 10);

  const { rows: earningsToday } = await pool.query<any>(
    `SELECT ticker, headline FROM market_events
     WHERE event_type = 'earnings' AND date = $1 ORDER BY ticker LIMIT 30`,
    [today]
  ).catch(() => ({ rows: [] }));

  const { rows: economicEvents } = await pool.query<any>(
    `SELECT id, date, type, name, description, importance FROM holiday_calendar
     WHERE date >= $1 AND date <= $2 ORDER BY date ASC, CASE importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END ASC LIMIT 20`,
    [today, sevenDaysOut]
  ).catch(() => ({ rows: [] }));

  const { rows: lookbackThemes } = await pool.query<any>(
    `SELECT what_works_now, market_theme, best_tickers, date FROM daily_feed
     WHERE date >= $1 AND date <= $2 AND deleted_at IS NULL
     ORDER BY date DESC, created_at DESC LIMIT 1`,
    [startDate, endDate]
  ).catch(() => ({ rows: [] }));

  let { rows: topNews } = await pool.query<any>(
    `SELECT ticker, headline, event_type, date, percent_move, sector
     FROM market_events
     WHERE deleted_at IS NULL
       AND event_type IN ('news','catalyst','headline','rumor','upgrade','downgrade')
       AND date >= $1 AND date <= $2
     ORDER BY date DESC, ABS(COALESCE(percent_move, 0)) DESC NULLS LAST, created_at DESC
     LIMIT 15`,
    [startDate, endDate]
  ).catch(() => ({ rows: [] as any[] }));
  if (topNews.length === 0) {
    const fallback = await pool.query<any>(
      `SELECT ticker, headline, event_type, date, percent_move, sector
       FROM market_events
       WHERE deleted_at IS NULL AND event_type <> 'earnings'
         AND date >= $1 AND date <= $2
       ORDER BY date DESC, ABS(COALESCE(percent_move, 0)) DESC NULLS LAST, created_at DESC
       LIMIT 15`,
      [startDate, endDate]
    ).catch(() => ({ rows: [] as any[] }));
    topNews = fallback.rows;
  }

  const partial = {
    generatedAt: new Date().toISOString(),
    date: today,
    futures,
    overnight,
    macro,
    premarketMovers,
    gapLeaders,
    sectorRotation,
    earningsToday,
    economicEvents,
    yesterdayThemes: lookbackThemes[0] || null,
    topNews,
    lookback: { startDate, endDate, label, days, kind },
    sectorEtfs: SECTOR_ETFS,
  };

  const aiSummary = await generateAiSummary(partial, lang).catch((e) => {
    logger.warn({ error: e?.message }, "market brief AI summary failed");
    return null;
  });

  // The AI summary is cached per reader language; other languages are generated on first read (see GET /market-brief).
  return { ...partial, aiSummary, aiSummaries: { [lang]: aiSummary } };
}

function fmtPctSafe(p: number | null | undefined): string {
  if (p == null) return "—";
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
}

async function generateAiSummary(b: any, lang: Lang = "ru"): Promise<string | null> {
  // Prompt context is model input and stays in Russian; the answer language follows the reader.
  const lines: string[] = [];
  if (b.futures?.length) {
    lines.push("Фьючерсы US: " + b.futures.map((f: any) => `${f.name} ${fmtPctSafe(f.changePct)}`).join(", ")); // i18n-ignore (AI prompt context)
  }
  const asia = (b.overnight || []).filter((o: any) => o.region === "Asia" && o.changePct != null);
  const eu = (b.overnight || []).filter((o: any) => o.region === "Europe" && o.changePct != null);
  if (asia.length) lines.push("Азия: " + asia.map((o: any) => `${o.name} ${fmtPctSafe(o.changePct)}`).join(", ")); // i18n-ignore (AI prompt context)
  if (eu.length) lines.push("Европа: " + eu.map((o: any) => `${o.name} ${fmtPctSafe(o.changePct)}`).join(", ")); // i18n-ignore (AI prompt context)
  if (b.macro?.length) {
    lines.push("Макро: " + b.macro.map((m: any) => `${m.name} ${m.price != null ? m.price.toFixed(2) : "—"} (${fmtPctSafe(m.changePct)})`).join(", ")); // i18n-ignore (AI prompt context)
  }
  if (b.premarketMovers?.length) {
    lines.push("Premarket movers: " + b.premarketMovers.slice(0, 8).map((p: any) => `${p.ticker} ${fmtPctSafe(p.preMarketPct)}${p.catalyst ? " (" + p.catalyst + ")" : ""}`).join(", "));
  }
  if (b.sectorRotation?.length) {
    const top3 = b.sectorRotation.slice(0, 3).map((s: any) => `${s.symbol} ${fmtPctSafe(s.changePct)}`).join(", ");
    const bot3 = b.sectorRotation.slice(-3).map((s: any) => `${s.symbol} ${fmtPctSafe(s.changePct)}`).join(", ");
    lines.push(`Сектора лидеры: ${top3} | аутсайдеры: ${bot3}`); // i18n-ignore (AI prompt context)
  }
  if (b.earningsToday?.length) {
    lines.push("Earnings сегодня: " + b.earningsToday.slice(0, 12).map((e: any) => e.ticker).join(", ")); // i18n-ignore (AI prompt context)
  }
  if (b.economicEvents?.length) {
    lines.push("Макрособытия (7д): " + b.economicEvents.slice(0, 6).map((e: any) => `${e.date} ${e.name}${e.importance === "high" ? " [HIGH]" : ""}`).join("; ")); // i18n-ignore (AI prompt context)
  }
  if (b.topNews?.length) {
    lines.push("Новости (" + (b.lookback?.label || "последний день") + "):"); // i18n-ignore (AI prompt context)
    b.topNews.slice(0, 12).forEach((n: any) => {
      lines.push(`- ${n.ticker}${n.percent_move != null ? " " + (Number(n.percent_move) >= 0 ? "+" : "") + Number(n.percent_move).toFixed(1) + "%" : ""}: ${n.headline}`);
    });
  }
  if (b.yesterdayThemes?.what_works_now) {
    lines.push("Темы вчера: " + b.yesterdayThemes.what_works_now); // i18n-ignore (AI prompt context)
    if (b.yesterdayThemes.best_tickers) lines.push("Лучшие тикеры вчера: " + b.yesterdayThemes.best_tickers); // i18n-ignore (AI prompt context)
  }
  if (lines.length === 0) return null;

  // i18n-ignore-next (AI prompt — model input)
  const system = `Ты — рыночный аналитик для дей-трейдера. Дай краткий бриф открытия US-сессии ${aiLanguageName(lang)}: 4–6 предложений, плотный, без воды и общих фраз. Структура: (1) ночь Азия/Европа и общий риск-он/риск-офф; (2) что говорят фьючерсы и макро (VIX/DXY/доходности/нефть); (3) ключевые новости и катализаторы по тикерам; (4) сектора в фокусе; (5) что важно держать в голове на сегодня. Без markdown, без списков, обычным абзацем. Не выдумывай данные которых нет.`;
  const user = lines.join("\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const result = await anthropic.messages.create(
      { model: AI_MODEL, max_tokens: 600, system, messages: [{ role: "user", content: user }] },
      { signal: controller.signal as RequestInit["signal"] },
    );
    const block = result.content[0];
    const text = block && block.type === "text" ? block.text.trim() : "";
    return text || null;
  } finally {
    clearTimeout(timer);
  }
}

type LookbackKind = "weekend" | "friday" | "lastDay";
/** Lookback window; `label` is the RU text (prompt context / older cached rows), the reader gets `lookback.<kind>` in their language. */
function lookbackWindow(today: string): { startDate: string; endDate: string; label: string; days: number; kind: LookbackKind } {
  const ru = marketbriefT.tFor("ru");
  const d = new Date(today + "T12:00:00Z");
  const dow = d.getUTCDay();
  const subDays = (n: number): string => new Date(d.getTime() - n * 86400_000).toISOString().slice(0, 10);
  if (dow === 1) {
    return { startDate: subDays(3), endDate: subDays(1), label: ru("lookback.weekend"), days: 3, kind: "weekend" };
  }
  if (dow === 0) {
    return { startDate: subDays(2), endDate: subDays(2), label: ru("lookback.friday"), days: 1, kind: "friday" };
  }
  if (dow === 6) {
    return { startDate: subDays(1), endDate: subDays(1), label: ru("lookback.friday"), days: 1, kind: "friday" };
  }
  return { startDate: subDays(1), endDate: subDays(1), label: ru("lookback.lastDay"), days: 1, kind: "lastDay" };
}

// ──────────────────────────────────────────────────────────────────────────
// Auto daily-feed generation — runs once per day after the brief is built.
// Uses Claude to pick the theme, hot tickers, and trading notes from
// today's analyst actions + news_cache + the brief macro snapshot.
// ──────────────────────────────────────────────────────────────────────────

type AutoFeedResult = {
  created: boolean;
  date: string;
  market_theme: string | null;
  best_tickers: string | null;
  what_works_now: string | null;
  notes: string | null;
};

async function generateAutoFeed(date: string, brief: any): Promise<AutoFeedResult> {
  // Skip if today's feed already exists
  const { rows: existing } = await pool.query<any>(
    `SELECT id FROM daily_feed WHERE date = $1 AND deleted_at IS NULL LIMIT 1`,
    [date]
  );
  if (existing.length > 0) {
    return { created: false, date, market_theme: null, best_tickers: null, what_works_now: null, notes: null };
  }

  // Fetch today's top analyst actions (upgrades + high-PT maintains)
  const since = new Date(date + "T00:00:00Z").toISOString();
  const { rows: analystRows } = await pool.query<any>(
    `SELECT ticker, firm, action, to_grade, from_grade, price_target, price_target_from
     FROM analyst_actions_cache
     WHERE graded_at >= $1
     ORDER BY CASE action WHEN 'up' THEN 0 WHEN 'init' THEN 1 WHEN 'down' THEN 2 ELSE 3 END, graded_at DESC
     LIMIT 25`,
    [since]
  ).catch(() => ({ rows: [] as any[] }));

  // Fetch trending tickers from news_cache (most mentioned in last 48h)
  const since48 = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const { rows: newsRows } = await pool.query<any>(
    `SELECT ticker, COUNT(*) as cnt, MAX(title) as sample_title
     FROM news_cache
     WHERE published_at >= $1 AND ticker NOT IN ('^VIX','DX-Y.NYB','^TNX','CL=F','GC=F','BTC-USD','ES=F','NQ=F')
     GROUP BY ticker
     ORDER BY cnt DESC
     LIMIT 20`,
    [since48]
  ).catch(() => ({ rows: [] as any[] }));

  // Build the prompt context
  const lines: string[] = [];
  lines.push(`Дата: ${date}`); // i18n-ignore (AI prompt context)

  if (brief?.macro?.length) {
    lines.push("Макро: " + brief.macro.map((m: any) => `${m.name} ${m.price ?? "—"} (${m.changePct != null ? (m.changePct >= 0 ? "+" : "") + m.changePct.toFixed(2) + "%" : "—"})`).join(", ")); // i18n-ignore (AI prompt context)
  }
  if (brief?.sectorRotation?.length) {
    const top4 = brief.sectorRotation.slice(0, 4).map((s: any) => `${s.symbol} ${s.changePct != null ? (s.changePct >= 0 ? "+" : "") + s.changePct.toFixed(2) + "%" : ""}`).join(", ");
    lines.push(`Топ секторов: ${top4}`); // i18n-ignore (AI prompt context)
  }
  if (brief?.earningsToday?.length) {
    lines.push("Earnings сегодня: " + brief.earningsToday.slice(0, 10).map((e: any) => e.ticker).join(", ")); // i18n-ignore (AI prompt context)
  }

  if (analystRows.length > 0) {
    lines.push("\nДействия аналитиков сегодня:"); // i18n-ignore (AI prompt context)
    for (const r of analystRows) {
      const pt = r.price_target ? ` PT $${r.price_target}${r.price_target_from ? ` (был $${r.price_target_from})` : ""}` : ""; // i18n-ignore (AI prompt context)
      const grade = r.to_grade ? ` → ${r.to_grade}` : "";
      lines.push(`- ${r.ticker} ${r.action.toUpperCase()} ${r.firm}${grade}${pt}`);
    }
  }

  if (newsRows.length > 0) {
    lines.push("\nТрендовые тикеры в новостях (48ч):"); // i18n-ignore (AI prompt context)
    lines.push(newsRows.slice(0, 15).map((r: any) => `${r.ticker}(${r.cnt})`).join(", "));
  }

  // i18n-ignore-next (AI prompt — model input; the auto feed is desk content, written in the desk language)
  const system = `Ты — рыночный аналитик для дей-трейдера. На основе данных составь дневной торговый план.
Верни JSON (только JSON, без markdown):
{
  "market_theme": "2-4 слова — тема/настроение рынка сегодня",
  "best_tickers": "TICK1, TICK2, TICK3, ... — 6-12 лучших тикеров для торговли сегодня, через запятую",
  "what_works_now": "1-2 предложения — что работает: momentum, gap&go, short-squeeze и т.д.",
  "notes": "3-5 предложений — конкретная аналитика: почему именно эти тикеры, на что смотреть, риски"
}

Приоритет тикеров: апгрейды аналитиков > earnings movers > premarket gap > сектор-лидер > новостные катализаторы.
Выбирай ликвидные тикеры (>$500M капитализация). Не выдумывай данные которых нет.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  let feedData: AutoFeedResult = { created: false, date, market_theme: null, best_tickers: null, what_works_now: null, notes: null };

  try {
    const result = await anthropic.messages.create(
      { model: AI_MODEL, max_tokens: 900, system, messages: [{ role: "user", content: lines.join("\n") }] },
      { signal: controller.signal as RequestInit["signal"] },
    );
    const block = result.content[0];
    const raw = block && block.type === "text" ? block.text.trim() : "";
    // Strip possible ```json wrapper
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    let parsed: { market_theme?: string; best_tickers?: string; what_works_now?: string; notes?: string } = {};
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Try to salvage partial JSON by extracting fields with regex
      const theme = jsonStr.match(/"market_theme"\s*:\s*"([^"]+)"/)?.[1];
      const tickers = jsonStr.match(/"best_tickers"\s*:\s*"([^"]+)"/)?.[1];
      const works = jsonStr.match(/"what_works_now"\s*:\s*"([^"]+)"/)?.[1];
      const notes = jsonStr.match(/"notes"\s*:\s*"([\s\S]+?)(?:"\s*[,}]|$)/)?.[1];
      parsed = {
        market_theme: theme,
        best_tickers: tickers,
        what_works_now: works,
        notes: notes?.replace(/\\n/g, " ").replace(/\\"/g, '"'),
      };
      if (!theme && !tickers) throw new Error(`Unparseable JSON from Claude: ${jsonStr.slice(0, 200)}`);
    }
    feedData = {
      created: true,
      date,
      market_theme: parsed.market_theme ?? null,
      best_tickers: parsed.best_tickers ?? null,
      what_works_now: parsed.what_works_now ?? null,
      notes: parsed.notes ?? null,
    };
  } catch (e: any) {
    logger.warn({ error: e?.message, date }, "auto-feed Claude generation failed");
    return feedData;
  } finally {
    clearTimeout(timer);
  }

  // Insert the generated feed
  try {
    await pool.query(
      `INSERT INTO daily_feed (date, market_theme, best_tickers, what_works_now, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [date, feedData.market_theme, feedData.best_tickers, feedData.what_works_now, feedData.notes]
    );
    logger.info({ date, tickers: feedData.best_tickers }, "Auto daily feed generated");
  } catch (e: any) {
    logger.warn({ error: e?.message, date }, "auto-feed insert failed");
  }

  return feedData;
}

// POST /api/market-brief/generate-feed — manually trigger feed generation for today (or ?date=YYYY-MM-DD)
// Staff only (dailyfeed.manage — curators/admins by default), ?force=1 included: it spends an AI call and
// soft-deletes the day's feed entry. Checked before anything touches the AI or the DB.
router.post("/market-brief/generate-feed", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "dailyfeed.manage", null, "FEED_GENERATE_STAFF_ONLY"))) return;
  // generateAutoFeed swallows AI errors (created:false); say why up front instead (audit P2-3)
  if (!requireAiConfigured(res)) return;
  const date = typeof req.query.date === "string" && req.query.date.match(/^\d{4}-\d{2}-\d{2}$/)
    ? req.query.date
    : new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const force = req.query.force === "1" || req.query.force === "true";
  if (force) {
    // Delete existing entry so generateAutoFeed won't skip
    await pool.query(`UPDATE daily_feed SET deleted_at = NOW() WHERE date = $1 AND deleted_at IS NULL`, [date]).catch(() => {});
  }
  // Load latest cached brief as context
  const { rows } = await pool.query<any>(`SELECT data FROM market_open_brief_cache WHERE date = $1 ORDER BY fetched_at DESC LIMIT 1`, [date]).catch(() => ({ rows: [] }));
  const brief = rows[0]?.data ?? null;
  const result = await generateAutoFeed(date, brief);
  res.json(result);
}));

// GET /api/market-brief/quotes — live quotes only (futures / overnight / macro / watchlist movers).
// Used by the dashboard's premarket auto-refresh instead of ?force=1, which rebuilt the whole brief
// including the AI summary every minute. Memoised for 30s across users.
let quotesMemo: { at: number; data: Awaited<ReturnType<typeof buildQuotes>> } | null = null;
let quotesInFlight: Promise<Awaited<ReturnType<typeof buildQuotes>>> | null = null;
const QUOTES_TTL_MS = 30_000;

router.get("/market-brief/quotes", asyncHandler(async (_req, res): Promise<void> => {
  const now = Date.now();
  if (!quotesMemo || now - quotesMemo.at > QUOTES_TTL_MS) {
    if (!quotesInFlight) {
      quotesInFlight = buildQuotes().finally(() => { quotesInFlight = null; });
    }
    const data = await quotesInFlight;
    quotesMemo = { at: Date.now(), data };
  }
  res.json({ ...quotesMemo.data, quotesAt: new Date(quotesMemo.at).toISOString() });
}));

/** Brief payload for one reader: AI summary in their language (generated once per language and cached in the row), localized lookback label. */
async function briefFor(data: any, lang: Lang, date: string): Promise<any> {
  const summaries: Record<string, string | null> = { ...(data.aiSummaries ?? (data.aiSummary !== undefined ? { ru: data.aiSummary } : {})) };
  if (!(lang in summaries)) {
    summaries[lang] = await generateAiSummary(data, lang).catch((e) => {
      logger.warn({ error: e?.message, lang }, "market brief AI summary failed");
      return null;
    });
    await pool.query(
      `UPDATE market_open_brief_cache SET data = jsonb_set(data, '{aiSummaries}', $2::jsonb) WHERE date = $1`,
      [date, JSON.stringify(summaries)],
    ).catch(() => {});
  }
  const kind = data.lookback?.kind as LookbackKind | undefined;
  const lookback = data.lookback && kind ? { ...data.lookback, label: marketbriefT.tFor(lang)(`lookback.${kind}`) } : data.lookback;
  const economicEvents = Array.isArray(data.economicEvents) ? data.economicEvents.map((e: any) => localizeCalendarRow(e, lang)) : data.economicEvents;
  return { ...data, aiSummaries: undefined, aiSummary: summaries[lang] ?? null, lookback, economicEvents };
}

router.get("/market-brief", asyncHandler(async (req, res): Promise<void> => {
  const force = req.query.force === "1" || req.query.force === "true";
  const lang = langOf(req);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

  if (!force) {
    const { rows } = await pool.query<any>(
      `SELECT data, fetched_at FROM market_open_brief_cache WHERE date = $1 AND fetched_at > NOW() - INTERVAL '15 minutes'`,
      [today]
    );
    if (rows[0]) {
      res.json({ ...(await briefFor(rows[0].data, lang, today)), cached: true, fetchedAt: rows[0].fetched_at });
      return;
    }
  }

  try {
    const brief = await buildBrief(today, lang);
    await pool.query(
      `INSERT INTO market_open_brief_cache (date, data, fetched_at) VALUES ($1, $2, NOW())
       ON CONFLICT (date) DO UPDATE SET data=EXCLUDED.data, fetched_at=NOW()`,
      [today, JSON.stringify(brief)]
    ).catch(() => {});
    // Auto-generate daily feed after brief is built (fire-and-forget, no await)
    generateAutoFeed(today, brief).catch((e) =>
      logger.warn({ error: e?.message, date: today }, "auto daily-feed generation failed silently")
    );
    res.json({ ...(await briefFor(brief, lang, today)), cached: false });
  } catch (e: any) {
    logger.warn({ error: e.message }, "market brief build error");
    const { rows } = await pool.query<any>(
      `SELECT data, fetched_at FROM market_open_brief_cache WHERE date = $1 ORDER BY fetched_at DESC LIMIT 1`,
      [today]
    ).catch(() => ({ rows: [] }));
    if (rows[0]) {
      res.json({ ...(await briefFor(rows[0].data, lang, today)), cached: true, stale: true, fetchedAt: rows[0].fetched_at });
    } else {
      res.json({ generatedAt: new Date().toISOString(), date: today, futures: [], overnight: [], macro: [], premarketMovers: [], gapLeaders: [], sectorRotation: [], earningsToday: [], economicEvents: [], yesterdayThemes: null, topNews: [], aiSummary: null, lookback: null, error: e.message });
    }
  }
}));

export default router;
