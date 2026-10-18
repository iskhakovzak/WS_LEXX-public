import { pool } from "@workspace/db";
import { logger } from "./logger";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";
/** Outbound request budget: a hung upstream (Yahoo / Nasdaq / RSS) must not hold a request or a job forever. */
const FETCH_TIMEOUT_MS = 12_000;

export type TickerFundamentals = {
  ticker: string;
  marketCap: string | null;
  float: string | null;
  sharesOutstanding: string | null;
  shortInterest: number | null;
  atr: number | null;
  relativeVolume: number | null;
  beta: number | null;
  averageDailyVolume: string | null;
  sector: string | null;
  industry: string | null;
  longName: string | null;
};

export type NewsItem = {
  guid: string;
  title: string;
  source: string | null;
  url: string | null;
  category: string;
  summary: string | null;
  publishedAt: Date | null;
};

export type SectorPoint = {
  symbol: string;
  name: string;
  price: number | null;
  changePct: number | null;
  prevClose: number | null;
  trend5d: number | null;
  fetchedAt: Date;
};

const FUND_TTL_MS = 15 * 60 * 1000;
const NEWS_TTL_MS = 60 * 60 * 1000;
const SECTOR_TTL_MS = 15 * 60 * 1000;

// ──────────────────────────────────────────────────────────────────────────
// Yahoo Finance API response shapes (partial; only fields we actually read)
// ──────────────────────────────────────────────────────────────────────────

type YahooRaw<T> = { raw?: T; fmt?: string } | null | undefined;
type YahooMaybeWrapped<T> = YahooRaw<T> | T;

type YahooQuoteResult = {
  marketCap?: number;
  sharesOutstanding?: number;
  shortPercentOfFloat?: number;
  beta?: number;
  averageDailyVolume3Month?: number;
  regularMarketVolume?: number;
  longName?: string;
  shortName?: string;
  sector?: string;
  industry?: string;
};

type YahooQuoteResponse = {
  quoteResponse?: { result?: YahooQuoteResult[] };
};

type YahooSummaryDetail = {
  marketCap?: YahooRaw<number>;
  averageVolume?: YahooRaw<number>;
  beta?: YahooRaw<number>;
};

type YahooKeyStatistics = {
  sharesOutstanding?: YahooRaw<number>;
  floatShares?: YahooRaw<number>;
  shortPercentOfFloat?: YahooRaw<number>;
};

type YahooAssetProfile = {
  sector?: string;
  industry?: string;
};

type YahooPriceModule = {
  marketCap?: YahooRaw<number>;
  longName?: string;
};

type YahooQuoteSummaryResult = {
  summaryDetail?: YahooSummaryDetail;
  defaultKeyStatistics?: YahooKeyStatistics;
  assetProfile?: YahooAssetProfile;
  price?: YahooPriceModule;
  upgradeDowngradeHistory?: { history?: YahooUpgradeDowngradeEntry[] };
};

type YahooQuoteSummaryResponse = {
  quoteSummary?: { result?: YahooQuoteSummaryResult[] };
};

type YahooChartIndicators = {
  quote?: Array<{
    high?: Array<number | null>;
    low?: Array<number | null>;
    close?: Array<number | null>;
    open?: Array<number | null>;
    volume?: Array<number | null>;
  }>;
};

type YahooChartMeta = {
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
};

type YahooChartResult = {
  meta?: YahooChartMeta;
  timestamp?: number[];
  indicators?: YahooChartIndicators;
};

type YahooChartResponse = {
  chart?: { result?: YahooChartResult[] };
};

type YahooUpgradeDowngradeEntry = {
  firm?: string;
  toGrade?: string;
  fromGrade?: string;
  action?: string;
  epochGradeDate?: number;
  // Actual field names returned by Yahoo Finance API
  currentPriceTarget?: number;
  priorPriceTarget?: number;
  priceTargetAction?: string;
  // Legacy/alternative field names (fallback)
  priceTarget?: YahooMaybeWrapped<number>;
  priceTargetFrom?: YahooMaybeWrapped<number>;
  previousPriceTarget?: YahooMaybeWrapped<number>;
  target?: YahooMaybeWrapped<number>;
};

export const SECTOR_ETFS: { symbol: string; name: string }[] = [
  { symbol: "XLK", name: "Technology" },
  { symbol: "XLE", name: "Energy" },
  { symbol: "XLF", name: "Financials" },
  { symbol: "XBI", name: "Biotech" },
  { symbol: "SMH", name: "Semiconductors" },
  { symbol: "IWM", name: "Russell 2000" },
  { symbol: "XLY", name: "Consumer Disc." },
  { symbol: "XLV", name: "Healthcare" },
];

function formatLargeNumber(n: number | null | undefined): string | null {
  if (n == null || !isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return String(n);
}

function classifyNews(title: string, summary?: string): string {
  const t = `${title} ${summary || ""}`.toLowerCase();
  if (/earnings|eps|revenue|quarterly|q[1-4]\s+results/.test(t)) return "earnings";
  if (/\bfda\b|approval|trial|phase\s*[123]/.test(t)) return "fda";
  if (/upgrade|raised\s+to|raises?\s+(price|target)/.test(t)) return "upgrade";
  if (/downgrade|lowered\s+to|cuts?\s+(price|target)/.test(t)) return "downgrade";
  if (/insider|form\s*4\b/.test(t)) return "insider";
  if (/merger|acquisition|acquires?|m&a|takeover|buyout/.test(t)) return "m&a";
  if (/offering|secondary|atm\s+offering|shelf|dilution/.test(t)) return "offering";
  if (/guidance|outlook|forecast|raises\s+(guidance|forecast)/.test(t)) return "guidance";
  if (/sec\s+filing|10-k|10-q|8-k|13[dgf]/i.test(t)) return "sec";
  return "news";
}

// Yahoo session: cookie + crumb cached for 1 hour. Required for v7/quote and quoteSummary endpoints.
// Single-flight: concurrent callers share the same in-flight refresh promise to avoid stampedes.
let yahooSession: { cookie: string; crumb: string; expiresAt: number } | null = null;
let yahooSessionInflight: Promise<{ cookie: string; crumb: string } | null> | null = null;

async function buildYahooSession(): Promise<{ cookie: string; crumb: string } | null> {
  try {
    const consentResp = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const setCookie = consentResp.headers.get("set-cookie") || "";
    const cookies = setCookie.split(/,(?=\s*\w+=)/).map((c) => c.split(";")[0].trim()).filter(Boolean);
    const cookie = cookies.join("; ");
    if (!cookie) return null;

    const crumbResp = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, Cookie: cookie },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!crumbResp.ok) return null;
    const crumb = (await crumbResp.text()).trim();
    if (!crumb) return null;

    yahooSession = { cookie, crumb, expiresAt: Date.now() + 60 * 60 * 1000 };
    return yahooSession;
  } catch (e: any) {
    logger.warn({ error: e.message }, "Yahoo crumb session failed");
    return null;
  }
}

async function getYahooSession(forceRefresh = false): Promise<{ cookie: string; crumb: string } | null> {
  if (!forceRefresh && yahooSession && yahooSession.expiresAt > Date.now()) return yahooSession;
  if (forceRefresh) yahooSession = null;
  if (yahooSessionInflight) return yahooSessionInflight;
  yahooSessionInflight = buildYahooSession().finally(() => { yahooSessionInflight = null; });
  return yahooSessionInflight;
}

export async function fetchYahooWithSession(url: (s: { cookie: string; crumb: string }) => string): Promise<Response | null> {
  let session = await getYahooSession();
  if (!session) return null;
  let resp = await fetch(url(session), { headers: { "User-Agent": UA, Accept: "application/json", Cookie: session.cookie }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (resp.status === 401 || resp.status === 403) {
    // Self-heal: refresh once and retry the call with the new session
    session = await getYahooSession(true);
    if (!session) return null;
    resp = await fetch(url(session), { headers: { "User-Agent": UA, Accept: "application/json", Cookie: session.cookie }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  }
  return resp;
}

async function fetchYahooQuote(ticker: string): Promise<YahooQuoteResult | null> {
  const resp = await fetchYahooWithSession((s) =>
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}&crumb=${encodeURIComponent(s.crumb)}`,
  );
  if (!resp || !resp.ok) return null;
  const data = (await resp.json()) as YahooQuoteResponse;
  return data?.quoteResponse?.result?.[0] || null;
}

async function fetchYahooQuoteSummary(ticker: string): Promise<YahooQuoteSummaryResult | null> {
  const modules = ["summaryDetail", "defaultKeyStatistics", "assetProfile", "price"].join(",");
  const resp = await fetchYahooWithSession((s) =>
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(s.crumb)}`,
  );
  if (!resp || !resp.ok) return null;
  const data = (await resp.json()) as YahooQuoteSummaryResponse;
  return data?.quoteSummary?.result?.[0] || null;
}

async function fetchYahooChart(ticker: string): Promise<YahooChartResult | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1mo&interval=1d`;
  const resp = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) return null;
  const data = (await resp.json()) as YahooChartResponse;
  return data?.chart?.result?.[0] || null;
}

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

export async function getTickerFundamentals(rawTicker: string, opts: { force?: boolean } = {}): Promise<TickerFundamentals | null> {
  const ticker = rawTicker.toUpperCase().trim();
  if (!ticker) return null;

  if (!opts.force) {
    const { rows } = await pool.query<any>(
      `SELECT * FROM ticker_data_cache WHERE ticker = $1 AND fetched_at > NOW() - INTERVAL '15 minutes'`,
      [ticker]
    );
    if (rows[0]) {
      return {
        ticker: rows[0].ticker,
        marketCap: rows[0].market_cap,
        float: rows[0].float,
        sharesOutstanding: rows[0].shares_outstanding,
        shortInterest: rows[0].short_interest != null ? Number(rows[0].short_interest) : null,
        atr: rows[0].atr != null ? Number(rows[0].atr) : null,
        relativeVolume: rows[0].relative_volume != null ? Number(rows[0].relative_volume) : null,
        beta: rows[0].beta != null ? Number(rows[0].beta) : null,
        averageDailyVolume: rows[0].average_daily_volume,
        sector: rows[0].sector,
        industry: rows[0].industry,
        longName: rows[0].long_name,
      };
    }
  }

  try {
    const [quote, summary, chart] = await Promise.all([
      fetchYahooQuote(ticker).catch(() => null),
      fetchYahooQuoteSummary(ticker).catch(() => null),
      fetchYahooChart(ticker).catch(() => null),
    ]);

    if (!quote && !summary && !chart) return null;

    const sd = summary?.summaryDetail || {};
    const ks = summary?.defaultKeyStatistics || {};
    const ap = summary?.assetProfile || {};
    const pr = summary?.price || {};

    const marketCap = quote?.marketCap ?? sd.marketCap?.raw ?? pr.marketCap?.raw ?? null;
    const sharesOut = quote?.sharesOutstanding ?? ks.sharesOutstanding?.raw ?? null;
    const float = ks.floatShares?.raw ?? sharesOut ?? null;
    const shortInterest = ks.shortPercentOfFloat?.raw ?? quote?.shortPercentOfFloat ?? null;
    const beta = sd.beta?.raw ?? quote?.beta ?? null;
    const avgVol = quote?.averageDailyVolume3Month ?? sd.averageVolume?.raw ?? null;
    const longName = quote?.longName || quote?.shortName || pr.longName || ticker;
    const sector = ap.sector || quote?.sector || null;
    const industry = ap.industry || quote?.industry || null;

    let atr: number | null = null;
    let rvol: number | null = quote?.regularMarketVolume && avgVol ? +(quote.regularMarketVolume / avgVol).toFixed(2) : null;
    if (chart) {
      const tsArr = chart.timestamp || [];
      const q = chart.indicators?.quote?.[0] || {};
      const candles = tsArr.map((_t, i) => ({
        h: q.high?.[i] ?? 0, l: q.low?.[i] ?? 0, c: q.close?.[i] ?? 0,
      })).filter((c) => c.c > 0);
      atr = calcATR(candles);
      if (rvol == null) {
        const vols = (q.volume || []).filter((v): v is number => typeof v === "number" && v > 0);
        if (vols.length >= 2) {
          const avg = vols.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(vols.length - 1, 1);
          const cur = vols[vols.length - 1];
          if (avg > 0 && cur > 0) rvol = +(cur / avg).toFixed(2);
        }
      }
    }

    const result: TickerFundamentals = {
      ticker,
      marketCap: formatLargeNumber(marketCap),
      float: formatLargeNumber(float),
      sharesOutstanding: formatLargeNumber(sharesOut),
      shortInterest: shortInterest != null ? +(Number(shortInterest) * (Number(shortInterest) < 1 ? 100 : 1)).toFixed(2) : null,
      atr,
      relativeVolume: rvol,
      beta: beta != null ? +Number(beta).toFixed(2) : null,
      averageDailyVolume: formatLargeNumber(avgVol),
      sector,
      industry,
      longName,
    };

    await pool.query(
      `INSERT INTO ticker_data_cache (ticker, market_cap, float, shares_outstanding, short_interest, atr, relative_volume, beta, average_daily_volume, sector, industry, long_name, raw, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT (ticker) DO UPDATE SET
         market_cap=EXCLUDED.market_cap, float=EXCLUDED.float, shares_outstanding=EXCLUDED.shares_outstanding,
         short_interest=EXCLUDED.short_interest, atr=EXCLUDED.atr, relative_volume=EXCLUDED.relative_volume,
         beta=EXCLUDED.beta, average_daily_volume=EXCLUDED.average_daily_volume, sector=EXCLUDED.sector,
         industry=EXCLUDED.industry, long_name=EXCLUDED.long_name, raw=EXCLUDED.raw, fetched_at=NOW()`,
      [
        result.ticker, result.marketCap, result.float, result.sharesOutstanding,
        result.shortInterest, result.atr, result.relativeVolume, result.beta,
        result.averageDailyVolume, result.sector, result.industry, result.longName,
        JSON.stringify({ quote, summary: !!summary, chart: !!chart }),
      ]
    ).catch((e) => logger.warn({ error: e.message, ticker }, "ticker cache write failed"));

    return result;
  } catch (e: any) {
    logger.warn({ error: e.message, ticker }, "getTickerFundamentals error");
    return null;
  }
}

function parseRssPubDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function canonicalKey(url: string | null, guid: string): string {
  if (url) {
    try {
      const u = new URL(url);
      return `${u.hostname}${u.pathname}`;
    } catch {
      return url;
    }
  }
  return guid;
}

type RichNewsItem = NewsItem & { fromRss: boolean; dedupeKey: string; relatedTickers?: string[] };

function parseYahooRss(xml: string, ticker: string): Array<RichNewsItem> {
  const items: Array<RichNewsItem> = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const getText = (tag: string) => {
      const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i").exec(block);
      return r ? r[1].trim() : null;
    };
    const title = getText("title") || "";
    const link = getText("link") || getText("guid") || null;
    const rawGuid = link || title;
    const source = getText("source") || "Yahoo Finance";
    const pubDate = parseRssPubDate(getText("pubDate"));
    const summary = getText("description") || null;
    if (!title) continue;
    const dedupeKey = canonicalKey(link, rawGuid);
    items.push({
      guid: `rss:${ticker}:${rawGuid}`,
      title,
      source,
      url: link,
      category: classifyNews(title, summary || ""),
      summary,
      publishedAt: pubDate,
      fromRss: true,
      dedupeKey,
    });
  }
  return items;
}

async function fetchTickerRss(ticker: string): Promise<Array<RichNewsItem>> {
  try {
    const url = `https://finance.yahoo.com/rss/headline?s=${encodeURIComponent(ticker)}`;
    const resp = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) return [];
    const xml = await resp.text();
    return parseYahooRss(xml, ticker);
  } catch {
    return [];
  }
}

async function getCompanyName(ticker: string): Promise<string | null> {
  try {
    const { rows } = await pool.query<any>(
      `SELECT long_name FROM ticker_data_cache WHERE ticker = $1 LIMIT 1`,
      [ticker]
    );
    return rows[0]?.long_name || null;
  } catch {
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsToken(haystack: string, needle: string): boolean {
  if (!needle || !haystack) return false;
  const esc = escapeRegex(needle);
  return new RegExp(`(?:^|[^a-zA-Z0-9])${esc}(?:[^a-zA-Z0-9]|$)`, "i").test(haystack);
}

function shortCompanyName(companyName: string | null): string | null {
  if (!companyName) return null;
  const stripped = companyName
    .replace(/\b(?:inc|corp|corporation|incorporated|ltd|llc|plc|holdings|group|co|company)\.?\b/gi, "")
    .replace(/[,]/g, "")
    .trim();
  return stripped.length >= 3 ? stripped : null;
}

function isRelevant(item: NewsItem & { fromRss?: boolean }, ticker: string, companyName: string | null): boolean {
  if (item.fromRss) return true;
  const hay = `${item.title} ${item.summary || ""}`;
  if (containsToken(hay, ticker)) return true;
  const shortName = shortCompanyName(companyName);
  if (shortName && containsToken(hay, shortName)) return true;
  return false;
}

function isTickerSpecific(item: RichNewsItem, ticker: string): boolean {
  if (item.fromRss) return true;
  if (item.relatedTickers && item.relatedTickers.includes(ticker)) return true;
  if (containsToken(item.title, ticker)) return true;
  if (!item.relatedTickers || item.relatedTickers.length === 0) {
    if (containsToken(item.summary || "", ticker)) return true;
  }
  return false;
}

const SOURCE_CREDIBILITY_TIERS: Array<{ bonus: number; patterns: RegExp[] }> = [
  {
    bonus: 30,
    patterns: [
      /\bbloomberg\b/i,
      /\breuters\b/i,
      /\bwall\s*street\s*journal\b/i,
      /\bwsj\b/i,
      /\bfinancial\s*times\b/i,
      /\bft\.com\b/i,
      /\bassociated\s*press\b/i,
      /\bap\s*news\b/i,
      /\bcnbc\b/i,
      /\bnew\s*york\s*times\b/i,
      /\bnytimes\b/i,
      /\bbarron'?s\b/i,
      /\bthe\s*economist\b/i,
      /\bdow\s*jones\b/i,
    ],
  },
  {
    bonus: 15,
    patterns: [
      /\bmarketwatch\b/i,
      /\bforbes\b/i,
      /\byahoo\s*finance\b/i,
      /\bbusiness\s*insider\b/i,
      /\bfortune\b/i,
      /\bwashington\s*post\b/i,
      /\bbbc\b/i,
      /\bnpr\b/i,
      /\binvestor'?s\s*business\s*daily\b/i,
      /\bibd\b/i,
      /\baxios\b/i,
      /\bguardian\b/i,
    ],
  },
  {
    bonus: 5,
    patterns: [
      /\bseeking\s*alpha\b/i,
      /\binvesting\.com\b/i,
      /\bbenzinga\b/i,
      /\bmotley\s*fool\b/i,
      /\bzacks\b/i,
      /\bthestreet\b/i,
      /\bkiplinger\b/i,
    ],
  },
];

function sourceCredibilityBonus(item: NewsItem): number {
  const candidates: string[] = [];
  if (item.source) candidates.push(item.source);
  if (item.url) {
    try {
      const host = new URL(item.url).hostname.replace(/^www\./i, "");
      candidates.push(host);
    } catch {
      // ignore malformed urls
    }
  }
  if (candidates.length === 0) return 0;
  const haystack = candidates.join(" ");
  for (const tier of SOURCE_CREDIBILITY_TIERS) {
    if (tier.patterns.some((re) => re.test(haystack))) return tier.bonus;
  }
  return 0;
}

function relevanceScore(item: NewsItem & { fromRss?: boolean }, ticker: string, companyName: string | null): number {
  const title = item.title;
  const summary = item.summary || "";

  let score = 0;

  if (containsToken(title, ticker)) score += 100;

  if (item.fromRss) score += 50;

  const shortName = shortCompanyName(companyName);
  if (shortName) {
    if (containsToken(title, shortName)) score += 40;
    else if (containsToken(summary, shortName)) score += 20;
  }

  if (containsToken(summary, ticker)) score += 10;

  score += sourceCredibilityBonus(item);

  return score;
}

function parseYahooSearchItems(rawItems: any[]): Array<RichNewsItem> {
  return rawItems.map((it) => {
    const rawGuid = String(it.uuid || it.link || it.title);
    const title = String(it.title || "");
    const source = it.publisher || null;
    const itemUrl = it.link || null;
    const summary = it.summary || null;
    const ts = it.providerPublishTime ? new Date(Number(it.providerPublishTime) * 1000) : null;
    const relatedTickers: string[] = Array.isArray(it.relatedTickers)
      ? it.relatedTickers.map((rt: any) => String(rt?.symbol || rt || "").toUpperCase().trim()).filter(Boolean)
      : [];
    return {
      guid: rawGuid, title, source, url: itemUrl,
      category: classifyNews(title, summary || ""),
      summary, publishedAt: ts, fromRss: false,
      dedupeKey: canonicalKey(itemUrl, rawGuid),
      relatedTickers,
    };
  }).filter((i) => i.title);
}

async function fetchYahooSearch(ticker: string, newsCount: number): Promise<Array<RichNewsItem>> {
  try {
    const searchUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=${newsCount}&quotesCount=0&enableCb=true&enableEnhancedTrivialQuery=true`;
    const resp = await fetch(searchUrl, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) {
      logger.warn({ status: resp.status, ticker }, "yahoo news search non-ok");
      return [];
    }
    const data: any = await resp.json();
    return parseYahooSearchItems(data?.news || []);
  } catch (err: any) {
    logger.warn({ error: err.message, ticker }, "yahoo news search failed");
    return [];
  }
}

function mergeNewsItems(rssItems: Array<RichNewsItem>, searchItems: Array<RichNewsItem>): Array<RichNewsItem> {
  const seenKeys = new Set<string>();
  const merged: Array<RichNewsItem> = [];
  for (const item of rssItems) {
    if (!seenKeys.has(item.dedupeKey)) { seenKeys.add(item.dedupeKey); merged.push(item); }
  }
  for (const item of searchItems) {
    if (!seenKeys.has(item.dedupeKey)) { seenKeys.add(item.dedupeKey); merged.push(item); }
  }
  return merged;
}

function sortByRelevance(items: Array<RichNewsItem>, ticker: string, companyName: string | null): Array<RichNewsItem> {
  return [...items].sort((a, b) => {
    const sa = relevanceScore(a, ticker, companyName);
    const sb = relevanceScore(b, ticker, companyName);
    if (sb !== sa) return sb - sa;
    const ta = a.publishedAt ? a.publishedAt.getTime() : 0;
    const tb = b.publishedAt ? b.publishedAt.getTime() : 0;
    return tb - ta;
  });
}

const MIN_SPECIFIC_RESULTS = 3;

export async function getTickerNews(rawTicker: string, opts: { limit?: number; force?: boolean; before?: Date | null } = {}): Promise<NewsItem[]> {
  const ticker = rawTicker.toUpperCase().trim();
  const limit = opts.limit ?? 15;
  if (!ticker) return [];

  // Point-in-time mode: when `before` is provided we read ONLY from cache and
  // hard-filter by published_at. Yahoo's RSS/search only returns recent news so
  // there's no value in hitting the upstream for historical trade contexts.
  const beforeIso = opts.before ? opts.before.toISOString() : null;
  if (beforeIso) {
    const { rows } = await pool.query<any>(
      `SELECT guid, title, source, url, category, summary, published_at
       FROM news_cache
       WHERE ticker = $1
         AND is_ticker_specific = TRUE
         AND published_at IS NOT NULL
         AND published_at <= $2
       ORDER BY published_at DESC
       LIMIT $3`,
      [ticker, beforeIso, limit]
    ).catch(() => ({ rows: [] }));
    const companyName = await getCompanyName(ticker).catch(() => null);
    const items = rows.map((r: any) => ({
      guid: r.guid, title: r.title, source: r.source, url: r.url, category: r.category,
      summary: r.summary,
      publishedAt: r.published_at ? new Date(r.published_at) : null,
      fromRss: String(r.guid).startsWith(`rss:${ticker}:`),
      dedupeKey: String(r.guid),
      relatedTickers: [] as string[],
    }));
    const sorted = sortByRelevance(items, ticker, companyName);
    return sorted.map(({ fromRss: _fr, dedupeKey: _dk, relatedTickers: _rt, ...rest }) => rest);
  }

  if (!opts.force) {
    const { rows: cacheRows } = await pool.query<any>(
      `SELECT guid, title, source, url, category, summary, published_at, is_ticker_specific,
              MAX(fetched_at) OVER () AS last_fetched
       FROM news_cache WHERE ticker = $1 ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT $2`,
      [ticker, limit]
    ).catch(() => ({ rows: [] }));

    if (cacheRows.length > 0) {
      const last = cacheRows[0].last_fetched ? new Date(cacheRows[0].last_fetched).getTime() : 0;
      const isFresh = Date.now() - last < NEWS_TTL_MS && last > 0;
      const hasSpecificRows = cacheRows.some((r: any) => r.is_ticker_specific === true);

      if (isFresh && hasSpecificRows) {
        const items = cacheRows
          .filter((r: any) => r.is_ticker_specific === true)
          .map((r: any) => ({
            guid: r.guid, title: r.title, source: r.source, url: r.url, category: r.category,
            summary: r.summary,
            publishedAt: r.published_at ? new Date(r.published_at) : null,
            fromRss: String(r.guid).startsWith(`rss:${ticker}:`),
            dedupeKey: String(r.guid),
            relatedTickers: [] as string[],
          }));
        const companyName = await getCompanyName(ticker);
        const sorted = sortByRelevance(items, ticker, companyName);
        return sorted.map(({ fromRss: _fr, dedupeKey: _dk, relatedTickers: _rt, ...rest }) => rest);
      }
    }
  }

  let companyName: string | null = null;

  const mapStaleRows = (rows: any[]): NewsItem[] => {
    const items: Array<RichNewsItem> = rows.map((r) => ({
      guid: r.guid, title: r.title, source: r.source, url: r.url, category: r.category,
      summary: r.summary, publishedAt: r.published_at ? new Date(r.published_at) : null,
      fromRss: String(r.guid).startsWith(`rss:${ticker}:`),
      dedupeKey: String(r.guid),
      relatedTickers: [],
    }));
    const relevant = items.filter((it) => isRelevant(it, ticker, companyName));
    const sorted = sortByRelevance(relevant, ticker, companyName);
    return sorted.map(({ fromRss: _fr, dedupeKey: _dk, relatedTickers: _rt, ...rest }) => rest);
  };

  try {
    const [rssItems, name] = await Promise.all([
      fetchTickerRss(ticker),
      getCompanyName(ticker),
    ]);
    companyName = name;

    const initialSearchItems = await fetchYahooSearch(ticker, Math.max(limit * 2, 20));
    let merged = mergeNewsItems(rssItems, initialSearchItems);

    let specific = merged.filter((item) => isTickerSpecific(item, ticker));

    if (specific.length < MIN_SPECIFIC_RESULTS && initialSearchItems.length > 0) {
      logger.info({ ticker, found: specific.length }, "strict filter yielded few results, retrying with larger newsCount=50");
      const extendedSearchItems = await fetchYahooSearch(ticker, 50);
      merged = mergeNewsItems(rssItems, extendedSearchItems);
      specific = merged.filter((item) => isTickerSpecific(item, ticker));
    }

    const gotUpstreamData = merged.length > 0;

    const sorted = sortByRelevance(specific, ticker, companyName);
    const final = sorted.slice(0, limit);

    if (gotUpstreamData) {
      for (const it of final) {
        await pool.query(
          `INSERT INTO news_cache (ticker, guid, title, source, url, category, summary, published_at, fetched_at, is_ticker_specific)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),TRUE)
           ON CONFLICT (ticker, guid) DO UPDATE SET
             title=EXCLUDED.title, source=EXCLUDED.source, url=EXCLUDED.url, category=EXCLUDED.category,
             summary=EXCLUDED.summary, published_at=EXCLUDED.published_at, fetched_at=NOW(),
             is_ticker_specific=TRUE`,
          [ticker, it.guid, it.title, it.source, it.url, it.category, it.summary, it.publishedAt]
        ).catch(() => {});
      }

      // Historical preservation: prune ONLY rows older than 90 days to keep
      // table size bounded. Never wipe by current freshness — older news must
      // remain available for point-in-time trade context queries.
      await pool.query(
        `DELETE FROM news_cache WHERE ticker = $1 AND COALESCE(published_at, fetched_at) < NOW() - INTERVAL '90 days'`,
        [ticker]
      ).catch(() => {});

      return final.map(({ fromRss: _fr, dedupeKey: _dk, relatedTickers: _rt, ...rest }) => rest);
    }

    const { rows: staleRows } = await pool.query<any>(
      `SELECT guid, title, source, url, category, summary, published_at FROM news_cache WHERE ticker = $1 ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT $2`,
      [ticker, limit]
    ).catch(() => ({ rows: [] }));
    return mapStaleRows(staleRows);
  } catch (e: any) {
    logger.warn({ error: e.message, ticker }, "getTickerNews error");
    if (companyName === null) {
      companyName = await getCompanyName(ticker);
    }
    const { rows: stale } = await pool.query<any>(
      `SELECT guid, title, source, url, category, summary, published_at FROM news_cache WHERE ticker = $1 ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT $2`,
      [ticker, limit]
    ).catch(() => ({ rows: [] }));
    return mapStaleRows(stale);
  }
}

export async function getSectorStrength(opts: { force?: boolean } = {}): Promise<SectorPoint[]> {
  if (!opts.force) {
    const { rows } = await pool.query<any>(
      `SELECT * FROM sector_strength_cache WHERE fetched_at > NOW() - INTERVAL '15 minutes'`
    );
    if (rows.length >= SECTOR_ETFS.length) {
      return rows.map((r: any) => ({
        symbol: r.symbol, name: r.name, price: r.price != null ? Number(r.price) : null,
        changePct: r.change_pct != null ? Number(r.change_pct) : null,
        prevClose: r.prev_close != null ? Number(r.prev_close) : null,
        trend5d: r.trend_5d != null ? Number(r.trend_5d) : null,
        fetchedAt: r.fetched_at,
      }));
    }
  }

  const results: SectorPoint[] = [];
  await Promise.all(SECTOR_ETFS.map(async (etf) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${etf.symbol}?range=5d&interval=1d`;
      const resp = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!resp.ok) return;
      const data = (await resp.json()) as YahooChartResponse;
      const r = data?.chart?.result?.[0];
      if (!r) return;
      const meta = r.meta || {};
      const closes = (r.indicators?.quote?.[0]?.close || []).filter((c): c is number => c != null);
      const price = meta.regularMarketPrice ?? closes[closes.length - 1] ?? null;
      const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? closes[closes.length - 2] ?? null;
      const changePct = price != null && prevClose ? +(((price - prevClose) / prevClose) * 100).toFixed(3) : null;
      const trend5d = closes.length >= 2 && closes[0] ? +(((closes[closes.length - 1] - closes[0]) / closes[0]) * 100).toFixed(3) : null;

      const point: SectorPoint = {
        symbol: etf.symbol, name: etf.name, price, changePct, prevClose, trend5d, fetchedAt: new Date(),
      };
      results.push(point);

      await pool.query(
        `INSERT INTO sector_strength_cache (symbol, name, price, change_pct, prev_close, trend_5d, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (symbol) DO UPDATE SET
           name=EXCLUDED.name, price=EXCLUDED.price, change_pct=EXCLUDED.change_pct,
           prev_close=EXCLUDED.prev_close, trend_5d=EXCLUDED.trend_5d, fetched_at=NOW()`,
        [point.symbol, point.name, point.price, point.changePct, point.prevClose, point.trend5d]
      ).catch(() => {});
    } catch (e: any) {
      logger.warn({ error: e.message, symbol: etf.symbol }, "sector fetch failed");
    }
  }));

  if (results.length === 0) {
    const { rows } = await pool.query<any>(`SELECT * FROM sector_strength_cache`).catch(() => ({ rows: [] }));
    return rows.map((r: any) => ({
      symbol: r.symbol, name: r.name, price: r.price != null ? Number(r.price) : null,
      changePct: r.change_pct != null ? Number(r.change_pct) : null,
      prevClose: r.prev_close != null ? Number(r.prev_close) : null,
      trend5d: r.trend_5d != null ? Number(r.trend_5d) : null,
      fetchedAt: r.fetched_at,
    }));
  }

  results.sort((a, b) => SECTOR_ETFS.findIndex(s => s.symbol === a.symbol) - SECTOR_ETFS.findIndex(s => s.symbol === b.symbol));
  return results;
}

// ──────────────────────────────────────────────────────────────────────────
// Analyst actions (upgrades / downgrades / initiations) — direct from Yahoo
// quoteSummary.upgradeDowngradeHistory module. Per-firm structured rows.
// ──────────────────────────────────────────────────────────────────────────

export type AnalystActionRow = {
  firm: string;
  toGrade: string | null;
  fromGrade: string | null;
  action: string; // 'up' | 'down' | 'init' | 'main' | 'reit'
  gradedAt: Date;
  priceTarget: string | null;
  priceTargetFrom: string | null;
};

export async function fetchYahooUpgradeDowngrade(rawTicker: string): Promise<AnalystActionRow[]> {
  const ticker = rawTicker.toUpperCase().trim();
  if (!ticker) return [];
  const resp = await fetchYahooWithSession((s) =>
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=upgradeDowngradeHistory&crumb=${encodeURIComponent(s.crumb)}`,
  );
  if (!resp || !resp.ok) return [];
  try {
    const data = (await resp.json()) as YahooQuoteSummaryResponse;
    const history: YahooUpgradeDowngradeEntry[] =
      data?.quoteSummary?.result?.[0]?.upgradeDowngradeHistory?.history || [];
    const unwrap = (v: YahooMaybeWrapped<number> | undefined): number | null => {
      if (v == null) return null;
      if (typeof v === "number") return v;
      const r = (v as { raw?: number }).raw;
      return typeof r === "number" ? r : null;
    };
    return history
      .filter((h): h is Required<Pick<YahooUpgradeDowngradeEntry, "firm" | "action" | "epochGradeDate">> & YahooUpgradeDowngradeEntry =>
        !!(h && h.firm && h.action && h.epochGradeDate))
      .map((h) => {
        // Yahoo Finance returns currentPriceTarget/priorPriceTarget as plain numbers
        const ptRaw = (typeof h.currentPriceTarget === "number" ? h.currentPriceTarget : null)
          ?? unwrap(h.priceTarget) ?? unwrap(h.target);
        const ptFromRaw = (typeof h.priorPriceTarget === "number" ? h.priorPriceTarget : null)
          ?? unwrap(h.priceTargetFrom) ?? unwrap(h.previousPriceTarget);
        const ptStr = (ptRaw != null && Number.isFinite(ptRaw)) ? String(ptRaw) : null;
        const ptFromStr = (ptFromRaw != null && Number.isFinite(ptFromRaw)) ? String(ptFromRaw) : null;
        return {
          firm: String(h.firm),
          toGrade: h.toGrade ? String(h.toGrade) : null,
          fromGrade: h.fromGrade ? String(h.fromGrade) : null,
          action: String(h.action).toLowerCase(),
          gradedAt: new Date(Number(h.epochGradeDate) * 1000),
          priceTarget: ptStr,
          priceTargetFrom: ptFromStr,
        };
      });
  } catch {
    return [];
  }
}

// Watchlist — large/popular US tickers across sectors. Approx 130.
export const ANALYST_WATCHLIST: string[] = [
  // Mega caps
  "AAPL","MSFT","GOOGL","GOOG","AMZN","NVDA","META","TSLA","BRK.B","AVGO","TSM","LLY","JPM","V","UNH","XOM","WMT","MA","JNJ","COST","HD","PG","ORCL","BAC","NFLX","KO","CVX","ABBV","CRM","MRK","PEP","ADBE","TMO","WFC","CSCO","ABT","DIS","ACN","MCD","DHR","LIN","NKE","NOW","SPOT","PANW",
  // Tech / growth
  "AMD","INTC","QCOM","SHOP","UBER","PYPL","COIN","PLTR","SNOW","CRWD","DDOG","MDB","NET","ZS","OKTA","SNAP","PINS","ROKU","SQ","SOFI","AFRM","RBLX","DKNG","HOOD","SMCI","ARM","ANET","MSTR","DELL","HPQ","IBM","TXN","INTU","AMAT","LRCX","KLAC","ASML","MU","NXPI","ON","MRVL","WDC","STX",
  // Cloud / SaaS
  "DOCN","GTLB","HUBS","ESTC","CFLT","BILL","TTD","MNDY","TEAM","WDAY","VEEV","ZM","RNG","TWLO","BRZE","PCTY","PAYC","APP","ASAN","BSY","IOT","JAMF","NCNO","FOUR","ZI","SMAR","DOMO","PSTG","NTAP","PEGA","ALRM","YEXT","CART","YELP","ETSY","W","CHWY",
  // Semiconductor
  "WOLF","SWKS","QRVO","MTSI","FORM","ACLS","ONTO","RMBS","CRUS","SITM","MLNX","COHU",
  // Finance
  "GS","MS","C","BLK","SCHW","AXP","COF","USB","PNC","TFC","FUTU","LC","NRDS","UPST","OPFI","FICO",
  // Healthcare / biotech
  "REGN","VRTX","GILD","BIIB","AMGN","MRNA","BNTX","BMY","PFE","EXAS","NTRA","ILMN","HOLX","TDOC","HIMS","ACAD","RXRX","ROIV","ARWR","IONS","ALNY","BLUE","SEER",
  // Energy
  "COP","SLB","EOG","PSX","MPC","OXY","HAL","AR","EQT","CTRA","DVN","FANG","MRO",
  // Consumer
  "TGT","SBUX","ABNB","BKNG","MAR","MDLZ","PM","CL","LYFT","DASH","DRVN","MNTN","ONON","DECK","LULU","RH","CVNA","VVV",
  // Industrial / aero
  "BA","CAT","GE","RTX","LMT","NOC","DE","UPS","FDX","HON","MMM","GEV","AXON","ROK","EMR","ITW","PH","ETN",
  // Telecom / media
  "T","VZ","TMUS","CMCSA","WBD","PARA","LYV","SIRI","FUBO",
  // Auto / EV
  "F","GM","RIVN","LCID","NIO","LI","XPEV","BLNK","CHPT","NKLA",
  // China / international
  "BABA","JD","PDD","BIDU","TCOM","TME",
  // Crypto miners / spec
  "MARA","RIOT","CLSK","WULF","CIFR","HUT",
];

// Merge ANALYST_WATCHLIST with tickers currently in the app's watchlist table
async function getEffectiveAnalystTickers(overrideTickers?: string[]): Promise<string[]> {
  if (overrideTickers && overrideTickers.length > 0) {
    return [...new Set(overrideTickers.map((t) => t.toUpperCase().trim()).filter(Boolean))];
  }
  let dbTickers: string[] = [];
  try {
    const res = await pool.query<{ ticker: string }>(
      `SELECT DISTINCT ticker FROM watchlist WHERE deleted_at IS NULL AND ticker IS NOT NULL`,
    );
    dbTickers = res.rows.map((r) => r.ticker.toUpperCase().trim()).filter(Boolean);
  } catch { /* table may not exist in some envs */ }
  const merged = [...new Set([...ANALYST_WATCHLIST, ...dbTickers])];
  return merged;
}

export type AnalystScanResult = {
  scanned: number;
  tickersWithData: number;
  rowsTotal: number;
  rowsInserted: number;
  errors: number;
  durationMs: number;
};

export async function scanWatchlistAnalystActions(opts: { concurrency?: number; tickers?: string[]; fetchFundamentals?: boolean } = {}): Promise<AnalystScanResult> {
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 4));
  const tickers = await getEffectiveAnalystTickers(opts.tickers);
  const fetchFundamentals = opts.fetchFundamentals ?? true;
  const start = Date.now();
  let tickersWithData = 0;
  let rowsTotal = 0;
  let rowsInserted = 0;
  let errors = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < tickers.length) {
      const i = cursor++;
      const ticker = tickers[i];
      try {
        const rows = await fetchYahooUpgradeDowngrade(ticker);
        if (rows.length > 0) {
          tickersWithData++;
          rowsTotal += rows.length;
          // Yahoo analysis page is the canonical source for these rows — there is
          // no per-action URL in upgradeDowngradeHistory, so we link the whole
          // analysis page (firm/action are visible there).
          const yahooUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/analysis`;
          for (const r of rows) {
            try {
              const ins = await pool.query(
                `INSERT INTO analyst_actions_cache (ticker, graded_at, firm, action, to_grade, from_grade, source, source_url, price_target, price_target_from)
                 VALUES ($1, $2, $3, $4, $5, $6, 'yahoo', $7, $8, $9)
                 ON CONFLICT (ticker, graded_at, firm, action) DO UPDATE
                   SET source_url = COALESCE(analyst_actions_cache.source_url, EXCLUDED.source_url),
                       price_target = COALESCE(EXCLUDED.price_target, analyst_actions_cache.price_target),
                       price_target_from = COALESCE(EXCLUDED.price_target_from, analyst_actions_cache.price_target_from)`,
                [ticker, r.gradedAt.toISOString(), r.firm, r.action, r.toGrade, r.fromGrade, yahooUrl, r.priceTarget, r.priceTargetFrom]
              );
              rowsInserted += ins.rowCount || 0;
            } catch (e: any) {
              logger.warn({ error: e.message, ticker, firm: r.firm }, "analyst action insert failed");
            }
          }
          if (fetchFundamentals) {
            // Best-effort: backfill marketCap/sector for new tickers (cheap if cached).
            await getTickerFundamentals(ticker).catch(() => null);
          }
        }
        // Small delay to avoid hammering Yahoo
        await new Promise((res) => setTimeout(res, 60));
      } catch (e: any) {
        errors++;
        logger.warn({ error: e.message, ticker }, "analyst scan worker error");
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { scanned: tickers.length, tickersWithData, rowsTotal, rowsInserted, errors, durationMs: Date.now() - start };
}

// ──────────────────────────────────────────────────────────────────────────
// Dynamic ticker discovery — beyond the hardcoded watchlist.
// Pulls from: user trades, watchlist table, recent news, and the static
// ANALYST_WATCHLIST. Yahoo's per-ticker call is cheap so we can scan more.
// ──────────────────────────────────────────────────────────────────────────

export async function getDynamicAnalystTickers(opts: { newsDays?: number } = {}): Promise<string[]> {
  const newsDays = opts.newsDays ?? 14;
  const set = new Set<string>(ANALYST_WATCHLIST.map((t) => t.toUpperCase().trim()));
  try {
    const { rows } = await pool.query<{ ticker: string }>(
      `SELECT DISTINCT ticker FROM trades WHERE ticker IS NOT NULL AND ticker <> '' LIMIT 500`,
    );
    rows.forEach((r) => r.ticker && set.add(r.ticker.toUpperCase().trim()));
  } catch (e: any) {
    logger.warn({ error: e.message }, "getDynamicAnalystTickers: trades query failed");
  }
  try {
    const { rows } = await pool.query<{ ticker: string }>(
      `SELECT DISTINCT ticker FROM watchlist WHERE ticker IS NOT NULL AND ticker <> '' LIMIT 500`,
    );
    rows.forEach((r) => r.ticker && set.add(r.ticker.toUpperCase().trim()));
  } catch {
    // watchlist table may not exist on all installs — silently skip
  }
  try {
    const { rows } = await pool.query<{ ticker: string }>(
      `SELECT DISTINCT ticker FROM news_cache
       WHERE ticker IS NOT NULL AND ticker <> ''
         AND published_at >= NOW() - ($1 || ' days')::interval
       LIMIT 1000`,
      [String(newsDays)],
    );
    rows.forEach((r) => r.ticker && set.add(r.ticker.toUpperCase().trim()));
  } catch (e: any) {
    logger.warn({ error: e.message }, "getDynamicAnalystTickers: news query failed");
  }
  // Ignore obviously-bad tickers (spaces, $-prefixes from social feeds, etc.)
  return Array.from(set).filter((t) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(t));
}

// ──────────────────────────────────────────────────────────────────────────
// News-based analyst signal extraction.
// Yahoo's structured upgradeDowngradeHistory only covers tickers we poll.
// News headlines mention analyst calls on a much wider universe — we extract
// firm + action from "Wells Fargo downgrades Apple…" style headlines and
// insert them as source='news' rows.
// ──────────────────────────────────────────────────────────────────────────

// Curated list of broker/research firm names that commonly appear in
// upgrade/downgrade headlines. Sorted longest-first at module load so we
// always match the most specific name (e.g. "Mizuho Securities" before
// "Mizuho", "Goldman Sachs" before "Goldman").
const BROKER_NAMES: string[] = [
  "Morgan Stanley", "Goldman Sachs", "JP Morgan", "JPMorgan", "Wells Fargo",
  "Bank of America", "B of A Securities", "BofA", "Citigroup", "Citi",
  "Deutsche Bank", "Barclays", "UBS", "HSBC", "Credit Suisse", "BNP Paribas",
  "Macquarie", "Mizuho Securities", "Mizuho", "Nomura", "Jefferies", "Wedbush",
  "Wolfe Research", "Baird", "Raymond James", "Stifel", "Piper Sandler",
  "Oppenheimer", "Needham", "BMO Capital", "RBC Capital", "Scotiabank",
  "TD Cowen", "Cowen", "Cantor Fitzgerald", "Cantor", "Bernstein",
  "Evercore ISI", "Evercore", "Guggenheim", "Loop Capital", "Argus", "Truist",
  "KeyBanc", "DA Davidson", "Davidson", "Susquehanna", "Roth MKM",
  "Roth Capital", "Benchmark", "Citizens", "Rosenblatt", "Canaccord Genuity",
  "Canaccord", "Berenberg", "Redburn", "Northland", "JMP Securities", "JMP",
  "Craig-Hallum", "Lake Street", "B. Riley", "BTIG", "Maxim Group",
  "Hudson Square", "Atlantic Equities", "Tigress Financial",
  "New Street Research", "Rothschild", "Pivotal Research", "Phillip Securities",
  "Daiwa", "CFRA", "Zacks", "Morningstar", "Seaport", "Compass Point", "JPM",
].slice().sort((a, b) => b.length - a.length);

const GRADE_TOKENS: string[] = [
  "Strong Buy", "Outperform", "Overweight", "Buy", "Accumulate", "Add",
  "Equal-Weight", "Equal Weight", "Equalweight", "Market Perform", "Neutral",
  "Hold", "In-Line", "In Line", "Sector Perform", "Sector Weight",
  "Underweight", "Underperform", "Reduce", "Sell", "Strong Sell", "Market Outperform",
];

export type ParsedAnalystSignal = {
  firm: string;
  action: "up" | "down" | "init" | "main" | "reit";
  toGrade: string | null;
  fromGrade: string | null;
  priceTarget: string | null;
  priceTargetFrom: string | null;
};

function detectFirmInText(text: string): string | null {
  for (const name of BROKER_NAMES) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) return name;
  }
  return null;
}

function findFirstGradeToken(text: string): { grade: string; index: number } | null {
  // Returns the earliest-appearing canonical grade token in text, or null.
  let bestPos = Infinity;
  let bestGrade: string | null = null;
  for (const g of GRADE_TOKENS) {
    const idx = text.search(new RegExp(`\\b${g.replace(/[\s-]/g, "[\\s-]?")}\\b`, "i"));
    if (idx >= 0 && idx < bestPos) {
      bestPos = idx;
      bestGrade = g;
    }
  }
  return bestGrade ? { grade: bestGrade, index: bestPos } : null;
}

function normalizeGradePhrase(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  // Try to map a free-text phrase back to a canonical grade token.
  const m = findFirstGradeToken(t);
  if (m) return m.grade;
  // Fallback: capitalize the cleaned phrase
  return t.replace(/\s+/g, " ").slice(0, 30);
}

export function parseAnalystSignalFromHeadline(title: string, summary?: string): ParsedAnalystSignal | null {
  const text = `${title} ${summary || ""}`.trim();
  if (!text) return null;
  const firm = detectFirmInText(text);
  if (!firm) return null; // Need a firm to attribute the action

  const lower = text.toLowerCase();
  let action: ParsedAnalystSignal["action"] | null = null;
  if (/\b(?:upgrades?|upgraded|raises?\s+(?:rating|to)|raised\s+to)\b/.test(lower)) action = "up";
  else if (/\b(?:downgrades?|downgraded|cuts?\s+(?:rating|to)|lowered\s+to|lowers\s+rating)\b/.test(lower)) action = "down";
  else if (/\b(?:initiates?|initiated|starts?\s+coverage|begins?\s+coverage|launches\s+coverage)\b/.test(lower)) action = "init";
  else if (/\b(?:reiterates?|reiterated|reaffirms?|reaffirmed)\b/.test(lower)) action = "reit";
  else if (/\b(?:maintains?|maintained|keeps?\s+(?:buy|sell|hold|outperform|neutral))\b/.test(lower)) action = "main";
  // Price-target moves without explicit upgrade verb → treat as reiteration
  else if (/\b(?:raises?|raised|lifts?|lifted|boosts?)\s+(?:price\s+target|target|pt)\b/.test(lower)) action = "reit";
  else if (/\b(?:cuts?|lowers?|lowered|trims?|reduces?)\s+(?:price\s+target|target|pt)\b/.test(lower)) action = "reit";
  if (!action) return null;

  // Grade extraction priority:
  //   1) "from X to Y" (or "to Y from X")  →  fromGrade=X, toGrade=Y
  //   2) "to Y" / "at Y"                   →  toGrade=Y
  //   3) For up/down only: bare grade token after the action verb
  let toGrade: string | null = null;
  let fromGrade: string | null = null;
  const fromTo = text.match(/from\s+([A-Za-z][A-Za-z\s-]{1,25}?)\s+to\s+([A-Za-z][A-Za-z\s-]{1,25}?)(?=[,.;:]|\s+(?:on|at|with|citing|by)\b|$)/i);
  const toFrom = !fromTo ? text.match(/to\s+([A-Za-z][A-Za-z\s-]{1,25}?)\s+from\s+([A-Za-z][A-Za-z\s-]{1,25}?)(?=[,.;:]|\s+(?:on|at|with|citing|by)\b|$)/i) : null;
  if (fromTo) {
    fromGrade = normalizeGradePhrase(fromTo[1]);
    toGrade = normalizeGradePhrase(fromTo[2]);
  } else if (toFrom) {
    toGrade = normalizeGradePhrase(toFrom[1]);
    fromGrade = normalizeGradePhrase(toFrom[2]);
  } else {
    const toOnly = text.match(/\b(?:to|at)\s+([A-Za-z][A-Za-z\s-]{2,25}?)(?=[,.;:]|\s+(?:on|at|with|citing|by|from|—|-)\b|$)/i);
    if (toOnly) toGrade = normalizeGradePhrase(toOnly[1]);
    if (!toGrade && (action === "up" || action === "down" || action === "reit" || action === "init" || action === "main")) {
      // Last resort: any grade token in headline (only safe when no from/to phrasing exists,
      // so we won't be misled by "from Buy to Hold")
      const tok = findFirstGradeToken(text);
      if (tok) toGrade = tok.grade;
    }
  }

  let priceTarget: string | null = null;
  let priceTargetFrom: string | null = null;
  const ptFromTo = text.match(/(?:price\s+target|target|pt)\s+from\s+\$?([0-9]+(?:\.[0-9]+)?)\s+to\s+\$?([0-9]+(?:\.[0-9]+)?)/i)
    || text.match(/from\s+\$([0-9]+(?:\.[0-9]+)?)\s+to\s+\$([0-9]+(?:\.[0-9]+)?)/i);
  if (ptFromTo) {
    priceTargetFrom = ptFromTo[1];
    priceTarget = ptFromTo[2];
  } else {
    const ptToFrom = text.match(/(?:price\s+target|target|pt)\s+(?:to\s+)?\$?([0-9]+(?:\.[0-9]+)?)\s+from\s+\$?([0-9]+(?:\.[0-9]+)?)/i)
      || text.match(/to\s+\$([0-9]+(?:\.[0-9]+)?)\s+from\s+\$([0-9]+(?:\.[0-9]+)?)/i);
    if (ptToFrom) {
      priceTarget = ptToFrom[1];
      priceTargetFrom = ptToFrom[2];
    } else {
      const ptOnly = text.match(/(?:price\s+target|target|pt)(?:\s+(?:to|of|at|raised\s+to|cut\s+to|lowered\s+to|lifted\s+to))?\s*[:=]?\s*\$([0-9]+(?:\.[0-9]+)?)/i)
        || text.match(/\$([0-9]+(?:\.[0-9]+)?)\s+(?:price\s+)?target/i);
      if (ptOnly) priceTarget = ptOnly[1];
    }
  }

  return { firm, action, toGrade, fromGrade, priceTarget, priceTargetFrom };
}

export type NewsScanResult = {
  scanned: number;
  matched: number;
  inserted: number;
  durationMs: number;
};

export async function scanNewsForAnalystActions(opts: { sinceDays?: number } = {}): Promise<NewsScanResult> {
  const sinceDays = Math.max(1, Math.min(60, opts.sinceDays ?? 14));
  const start = Date.now();
  let scanned = 0, matched = 0, inserted = 0;
  try {
    const { rows } = await pool.query<{
      ticker: string; title: string; summary: string | null; published_at: string | null; url: string | null;
    }>(
      `SELECT ticker, title, summary, published_at, url
       FROM news_cache
       WHERE published_at IS NOT NULL
         AND published_at >= NOW() - ($1 || ' days')::interval
         AND title ~* 'upgrad|downgrad|reiterat|initiat|raises?\\s+(?:price\\s+)?target|cuts?\\s+(?:price\\s+)?target|lowered\\s+to|raised\\s+to|begins?\\s+coverage|starts?\\s+coverage|maintains?\\s+(?:buy|sell|hold|outperform|neutral)'
       ORDER BY published_at DESC
       LIMIT 5000`,
      [String(sinceDays)],
    );
    scanned = rows.length;
    for (const r of rows) {
      const sig = parseAnalystSignalFromHeadline(r.title, r.summary || undefined);
      if (!sig) continue;
      matched++;
      const gradedAt = r.published_at ? new Date(r.published_at) : new Date();
      // Validate URL at the storage boundary too — defence in depth so we
      // never persist javascript:/data: URLs from a poisoned upstream RSS feed.
      let safeUrl: string | null = null;
      if (r.url) {
        try {
          const u = new URL(String(r.url).trim());
          if (u.protocol === "http:" || u.protocol === "https:") safeUrl = u.toString();
        } catch { /* ignore malformed URL */ }
      }
      try {
        // When this action is also seen in the news feed, prefer the article
        // URL over the generic Yahoo analysis link AND flip source='news' so
        // the UI label ("новость ↗") matches the destination.
        const ins = await pool.query(
          `INSERT INTO analyst_actions_cache (ticker, graded_at, firm, action, to_grade, from_grade, source, source_url, price_target, price_target_from)
           VALUES ($1, $2, $3, $4, $5, $6, 'news', $7, $8, $9)
           ON CONFLICT (ticker, graded_at, firm, action) DO UPDATE
             SET source_url = COALESCE(EXCLUDED.source_url, analyst_actions_cache.source_url),
                 source = CASE WHEN EXCLUDED.source_url IS NOT NULL THEN 'news' ELSE analyst_actions_cache.source END,
                 price_target = COALESCE(EXCLUDED.price_target, analyst_actions_cache.price_target),
                 price_target_from = COALESCE(EXCLUDED.price_target_from, analyst_actions_cache.price_target_from)`,
          [r.ticker.toUpperCase().trim(), gradedAt.toISOString(), sig.firm, sig.action, sig.toGrade, sig.fromGrade, safeUrl, sig.priceTarget, sig.priceTargetFrom],
        );
        inserted += ins.rowCount || 0;
      } catch (e: any) {
        logger.warn({ error: e.message, ticker: r.ticker }, "news-based analyst insert failed");
      }
    }
  } catch (e: any) {
    logger.warn({ error: e.message }, "scanNewsForAnalystActions failed");
  }
  return { scanned, matched, inserted, durationMs: Date.now() - start };
}

// ──────────────────────────────────────────────────────────────────────────
// Additional analyst sources (multi-source coverage):
//   • Seeking Alpha per-ticker RSS — independent firehose of headlines
//   • NASDAQ public ratings JSON   — structured rows when populated
//   • General finance RSS feeds    — MarketWatch / Investing.com / Reuters
// All extracted rows go into analyst_actions_cache with their own source tag
// so the UI can show provenance and the dedup constraint catches overlaps.
// ──────────────────────────────────────────────────────────────────────────

export type ExtraScanResult = {
  scanned: number;
  matched: number;
  inserted: number;
  errors: number;
  durationMs: number;
};

async function fetchSeekingAlphaTickerRss(ticker: string): Promise<Array<{ title: string; link: string | null; publishedAt: Date | null }>> {
  try {
    const url = `https://seekingalpha.com/api/sa/combined/${encodeURIComponent(ticker)}.xml`;
    const resp = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) return [];
    const xml = await resp.text();
    const items: Array<{ title: string; link: string | null; publishedAt: Date | null }> = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(xml)) !== null) {
      const block = m[1];
      const get = (tag: string): string | null => {
        const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i").exec(block);
        return r ? r[1].trim() : null;
      };
      const title = get("title") || "";
      if (!title) continue;
      const link = get("link");
      const publishedAt = parseRssPubDate(get("pubDate"));
      items.push({ title, link, publishedAt });
    }
    return items;
  } catch {
    return [];
  }
}

export async function scanSeekingAlphaForAnalystActions(opts: { concurrency?: number; tickers?: string[] } = {}): Promise<ExtraScanResult> {
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 4));
  const tickers = await getEffectiveAnalystTickers(opts.tickers);
  const start = Date.now();
  let scanned = 0, matched = 0, inserted = 0, errors = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < tickers.length) {
      const i = cursor++;
      const ticker = tickers[i];
      try {
        const items = await fetchSeekingAlphaTickerRss(ticker);
        scanned += items.length;
        for (const it of items) {
          const sig = parseAnalystSignalFromHeadline(it.title);
          if (!sig) continue;
          matched++;
          const gradedAt = it.publishedAt || new Date();
          let safeUrl: string | null = null;
          if (it.link) {
            try {
              const u = new URL(String(it.link).trim());
              if (u.protocol === "http:" || u.protocol === "https:") safeUrl = u.toString();
            } catch { /* ignore */ }
          }
          try {
            const ins = await pool.query(
              `INSERT INTO analyst_actions_cache (ticker, graded_at, firm, action, to_grade, from_grade, source, source_url, price_target, price_target_from)
               VALUES ($1, $2, $3, $4, $5, $6, 'seekingalpha', $7, $8, $9)
               ON CONFLICT (ticker, graded_at, firm, action) DO UPDATE
                 SET source_url = COALESCE(analyst_actions_cache.source_url, EXCLUDED.source_url),
                     price_target = COALESCE(EXCLUDED.price_target, analyst_actions_cache.price_target),
                     price_target_from = COALESCE(EXCLUDED.price_target_from, analyst_actions_cache.price_target_from)`,
              [ticker, gradedAt.toISOString(), sig.firm, sig.action, sig.toGrade, sig.fromGrade, safeUrl, sig.priceTarget, sig.priceTargetFrom],
            );
            inserted += ins.rowCount || 0;
          } catch (e: any) {
            logger.warn({ error: e.message, ticker, firm: sig.firm }, "seekingalpha analyst insert failed");
          }
        }
        await new Promise((res) => setTimeout(res, 80));
      } catch (e: any) {
        errors++;
        logger.warn({ error: e.message, ticker }, "seekingalpha worker error");
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { scanned, matched, inserted, errors, durationMs: Date.now() - start };
}

type NasdaqRating = {
  date?: string;
  company?: string;
  oldGrade?: string;
  newGrade?: string;
  action?: string;
};
type NasdaqRatingsResponse = {
  data?: { upgradesDowngrades?: NasdaqRating[] };
};

function mapNasdaqAction(raw: string | undefined): "up" | "down" | "init" | "main" | "reit" | null {
  const a = (raw || "").toLowerCase();
  if (a.includes("upgrad")) return "up";
  if (a.includes("downgrad")) return "down";
  if (a.includes("initiat") || a.includes("start")) return "init";
  if (a.includes("reiterat") || a.includes("reaffirm")) return "reit";
  if (a.includes("maintain")) return "main";
  return null;
}

function parseNasdaqDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d;
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) {
    const dt = new Date(`${m[3]}-${m[1]}-${m[2]}T00:00:00Z`);
    if (!isNaN(dt.getTime())) return dt;
  }
  return null;
}

export async function scanNasdaqAnalystActions(opts: { concurrency?: number; tickers?: string[] } = {}): Promise<ExtraScanResult> {
  const concurrency = Math.max(1, Math.min(6, opts.concurrency ?? 3));
  const tickers = await getEffectiveAnalystTickers(opts.tickers);
  const start = Date.now();
  let scanned = 0, matched = 0, inserted = 0, errors = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < tickers.length) {
      const i = cursor++;
      const ticker = tickers[i];
      try {
        const url = `https://api.nasdaq.com/api/analyst/${encodeURIComponent(ticker)}/ratings`;
        const resp = await fetch(url, {
          headers: { "User-Agent": UA, Accept: "application/json" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!resp.ok) { await new Promise((r) => setTimeout(r, 100)); continue; }
        const data = (await resp.json()) as NasdaqRatingsResponse;
        const rows = data?.data?.upgradesDowngrades || [];
        scanned += rows.length;
        const sourceUrl = `https://www.nasdaq.com/market-activity/stocks/${encodeURIComponent(ticker.toLowerCase())}/analyst-research`;
        for (const r of rows) {
          const action = mapNasdaqAction(r.action);
          if (!action) continue;
          const firm = (r.company || "").trim();
          if (!firm) continue;
          const gradedAt = parseNasdaqDate(r.date);
          if (!gradedAt) continue;
          matched++;
          try {
            const ins = await pool.query(
              `INSERT INTO analyst_actions_cache (ticker, graded_at, firm, action, to_grade, from_grade, source, source_url)
               VALUES ($1, $2, $3, $4, $5, $6, 'nasdaq', $7)
               ON CONFLICT (ticker, graded_at, firm, action) DO UPDATE
                 SET source_url = COALESCE(analyst_actions_cache.source_url, EXCLUDED.source_url)`,
              [ticker, gradedAt.toISOString(), firm, action, (r.newGrade || "").trim() || null, (r.oldGrade || "").trim() || null, sourceUrl],
            );
            inserted += ins.rowCount || 0;
          } catch (e: any) {
            logger.warn({ error: e.message, ticker, firm }, "nasdaq analyst insert failed");
          }
        }
        await new Promise((res) => setTimeout(res, 120));
      } catch (e: any) {
        errors++;
        logger.warn({ error: e.message, ticker }, "nasdaq worker error");
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { scanned, matched, inserted, errors, durationMs: Date.now() - start };
}

const GENERAL_FINANCE_FEEDS: Array<{ url: string; name: string }> = [
  { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", name: "MarketWatch" },
  { url: "https://feeds.content.dowjones.io/public/rss/mw_marketpulse", name: "MarketWatch Pulse" },
  { url: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain", name: "MarketWatch Markets" },
  { url: "https://www.investing.com/rss/news_25.rss", name: "Investing.com Stocks" },
  { url: "https://www.investing.com/rss/news_285.rss", name: "Investing.com Analysis" },
];

function extractTickerFromHeadline(text: string, knownTickers: Set<string>): string | null {
  // Try $TICKER first, then standalone uppercase tokens.
  const dollar = text.match(/\$([A-Z][A-Z0-9.-]{0,9})\b/);
  if (dollar && knownTickers.has(dollar[1])) return dollar[1];
  const paren = text.match(/\(([A-Z][A-Z0-9.-]{0,9}):[A-Z]+\)/);
  if (paren && knownTickers.has(paren[1])) return paren[1];
  const bare = text.match(/\b([A-Z]{2,6})\b/g);
  if (bare) {
    for (const tok of bare) {
      if (knownTickers.has(tok)) return tok;
    }
  }
  return null;
}

export async function scanGeneralFinanceFeedsForAnalystActions(opts: { tickers?: string[] } = {}): Promise<ExtraScanResult> {
  const start = Date.now();
  const knownTickers = new Set<string>(
    (opts.tickers && opts.tickers.length ? opts.tickers : ANALYST_WATCHLIST)
      .map((t) => t.toUpperCase().trim())
      .filter(Boolean),
  );
  let scanned = 0, matched = 0, inserted = 0, errors = 0;

  for (const feed of GENERAL_FINANCE_FEEDS) {
    try {
      const resp = await fetch(feed.url, {
        headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) continue;
      const xml = await resp.text();
      const itemRe = /<item>([\s\S]*?)<\/item>/gi;
      let m: RegExpExecArray | null;
      while ((m = itemRe.exec(xml)) !== null) {
        const block = m[1];
        const get = (tag: string): string | null => {
          const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i").exec(block);
          return r ? r[1].trim() : null;
        };
        const title = get("title") || "";
        const summary = get("description") || "";
        const link = get("link");
        const pub = parseRssPubDate(get("pubDate"));
        if (!title) continue;
        scanned++;
        // Cheap pre-filter: must mention upgrade/downgrade/coverage to be worth parsing.
        if (!/upgrad|downgrad|reiterat|initiat|raises?\s+(?:price\s+)?target|cuts?\s+(?:price\s+)?target|begins?\s+coverage|starts?\s+coverage|maintains?\s+(?:buy|sell|hold|outperform|neutral)/i.test(`${title} ${summary}`)) continue;
        const sig = parseAnalystSignalFromHeadline(title, summary);
        if (!sig) continue;
        const ticker = extractTickerFromHeadline(`${title} ${summary}`, knownTickers);
        if (!ticker) continue;
        matched++;
        const gradedAt = pub || new Date();
        let safeUrl: string | null = null;
        if (link) {
          try {
            const u = new URL(String(link).trim());
            if (u.protocol === "http:" || u.protocol === "https:") safeUrl = u.toString();
          } catch { /* ignore */ }
        }
        try {
          const ins = await pool.query(
            `INSERT INTO analyst_actions_cache (ticker, graded_at, firm, action, to_grade, from_grade, source, source_url, price_target, price_target_from)
             VALUES ($1, $2, $3, $4, $5, $6, 'rss', $7, $8, $9)
             ON CONFLICT (ticker, graded_at, firm, action) DO UPDATE
               SET source_url = COALESCE(analyst_actions_cache.source_url, EXCLUDED.source_url),
                   price_target = COALESCE(EXCLUDED.price_target, analyst_actions_cache.price_target),
                   price_target_from = COALESCE(EXCLUDED.price_target_from, analyst_actions_cache.price_target_from)`,
            [ticker, gradedAt.toISOString(), sig.firm, sig.action, sig.toGrade, sig.fromGrade, safeUrl, sig.priceTarget, sig.priceTargetFrom],
          );
          inserted += ins.rowCount || 0;
        } catch (e: any) {
          logger.warn({ error: e.message, ticker, firm: sig.firm }, "rss analyst insert failed");
        }
      }
    } catch (e: any) {
      errors++;
      logger.warn({ error: e.message, feed: feed.url }, "general finance feed error");
    }
  }

  return { scanned, matched, inserted, errors, durationMs: Date.now() - start };
}

// Background scans — scheduled by the job registry (src/jobs/definitions.ts: "market.analyst-actions", "market.sectors").

/** One analyst-actions scan over the dynamic ticker list (Yahoo, news, Seeking Alpha, NASDAQ, general RSS). */
export async function runAnalystActionsScan(): Promise<Record<string, unknown>> {
  // 1) Build dynamic ticker list (watchlist + trades + watchlist table + recent news tickers)
  const tickers = await getDynamicAnalystTickers({ newsDays: 14 });
  logger.info({ count: tickers.length }, "Analyst scan: dynamic ticker list built");
  const r = await scanWatchlistAnalystActions({ concurrency: 5, tickers, fetchFundamentals: false });
  logger.info(r, "Yahoo analyst actions scan complete");
  // 2) Parse news_cache for analyst headlines on tickers Yahoo may have missed
  const n = await scanNewsForAnalystActions({ sinceDays: 14 });
  logger.info(n, "News-based analyst scan complete");
  // 3) Seeking Alpha per-ticker RSS — independent firehose
  const sa = await scanSeekingAlphaForAnalystActions({ concurrency: 4, tickers });
  logger.info(sa, "Seeking Alpha analyst scan complete");
  // 4) NASDAQ structured ratings JSON
  const nq = await scanNasdaqAnalystActions({ concurrency: 3, tickers });
  logger.info(nq, "NASDAQ analyst scan complete");
  // 5) General finance feeds (MarketWatch + Investing.com)
  const rss = await scanGeneralFinanceFeedsForAnalystActions({ tickers });
  logger.info(rss, "General finance RSS analyst scan complete");
  return { tickers: tickers.length };
}

/** Sector strength refresh (the job's cron limits it to weekdays 09:00–16:59 New York). */
export async function runSectorRefresh(): Promise<Record<string, unknown>> {
  const points = await getSectorStrength({ force: true });
  return { sectors: points.length };
}
