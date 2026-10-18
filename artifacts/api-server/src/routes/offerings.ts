import { Router, type IRouter } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { logger } from "../lib/logger";
import { fetchYahooWithSession } from "../lib/marketDataService";
import { nyDate } from "../lib/tradingDate";
import { pool } from "@workspace/db";
import { resolveTraderParam } from "../lib/permissions";
import { normResult, num } from "../lib/tradeMath";
import { fetchDailyRange } from "../lib/candles/market";
import {
  barIndexOnOrAfter, barsFromCandles, filingEvents, isWksi, nextWeekday, offeringDays, PRICED_FORM_RE, reactionDayFor, reactionOn,
  rollToWeekday, splitByOfferingDays, summarize,
  type Bar, type FilingEvent, type Reaction, type Session, type TradeLite,
} from "../lib/offeringReaction";
import { AppError, badRequest, unauthorized } from "../lib/http";
import { offeringsT } from "../i18n/ns";
import { langOf, type Lang } from "../i18n";

const router: IRouter = Router();

const EDGAR_UA = "wslexx/1.0 research@wslexx.com";
const SEC_ARCHIVES_UA = "WS_LEXX-Research research@wslexx.com";
const NASDAQ_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const NASDAQ_HEADERS = {
  "User-Agent": NASDAQ_UA,
  "Accept": "application/json, text/plain, */*",
  "Origin": "https://www.nasdaq.com",
  "Referer": "https://www.nasdaq.com/",
};

const cache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL = 10 * 60_000;

export type OfferingType = "IPO" | "Follow-on" | "ATM" | "Bought Deal" | "SPAC" | "Shelf" | "Other";
export type SellerType = "company" | "insiders" | "mixed" | "unknown";
/** Filing bucket for the dilution dashboard: priced takedown (424B), ATM program, shelf (S-3/F-3), registration (S-1/F-1), IPO. */
export type FilingKind = "IPO" | "424B" | "ATM" | "S-3" | "S-1";
export type RiskLevel = "high" | "medium" | "low";

export type Offering = {
  ticker: string;
  company: string;
  type: OfferingType;
  date: string;
  offerPrice: number | null;
  currentPrice: number | null;
  priceChangePct: number | null;
  dealSizeM: number | null;
  sharesOffered: number | null;
  sharesOutstandingBefore: number | null;
  sharesOutstandingAfter: number | null;
  dilutionPct: number | null;
  sellerType: SellerType;
  insiderShares: number | null;
  companyShares: number | null;
  underwriter: string | null;
  lockupDays: number | null;
  volume: number | null;
  avgVolume: number | null;
  relVol: number | null;
  marketCapM: number | null;
  sector: string | null;
  rating: number;
  ratingFactors: string[];
  /** ratingFactors as data (offerings namespace `rating.*`), re-rendered per request language. */
  ratingFactorItems?: FactorItem[];
  status: "upcoming" | "priced" | "trading" | "withdrawn" | "filed";
  source: "nasdaq" | "edgar";
  // ── Dilution-dashboard fields (additive) ──
  kind: FilingKind;
  /** Raw SEC form (424B5, S-3, S-1/A…) or "IPO" for the NASDAQ calendar. */
  form: string | null;
  filingUrl: string | null;
  cik: string | null;
  exchange: string | null;
  /** NASDAQ price range text for upcoming IPOs ("10.00-12.00"). */
  priceRange: string | null;
  /** Registered shelf / program size, $M (S-3 base shelf, ATM program). */
  shelfCapacityM: number | null;
  /** Small-cap S-3 (public float < $75M) can sell at most 1/3 of float per 12 months (General Instruction I.B.6). */
  babyShelf: boolean;
  babyShelfLimitM: number | null;
  /** Offering (or shelf) size as % of current market cap. */
  offerPctOfMcap: number | null;
  dealFlags: string[];
  dilutionRisk: number;
  riskLevel: RiskLevel;
  riskFactors: string[];
  /** riskFactors as data (offerings namespace `risk.*`). */
  riskFactorItems?: FactorItem[];
  // ── Intraday-trader fields (additive, optional: filled by augmentOfferings) ──
  /** SEC acceptance time, New York wall clock ("2026-10-15 16:31"). */
  acceptedAt?: string | null;
  session?: Session | null;
  /** First session that trades the deal (after-close acceptance → next weekday). */
  reactionDate?: string | null;
  /** Priced takedowns (424B1/4/5/7) in the 12 months before this one. */
  priorOfferings12m?: number | null;
  /** Close before the reaction session; discount = offer / prevClose − 1. */
  prevClose?: number | null;
  discountPct?: number | null;
  /** Daily reaction on the reaction session (live = today, bar still forming). */
  reaction?: (Pick<Reaction, "gapPct" | "o2cPct" | "dayPct" | "lowFromOpenPct" | "highFromOpenPct" | "relVol"> & { live: boolean }) | null;
  floatShares?: number | null;
  cashM?: number | null;
  /** Monthly operating cash burn, $M (0 = cash-flow positive). */
  burnM?: number | null;
  runwayMonths?: number | null;
  shortPctFloat?: number | null;
};

export type IpoCalendarItem = {
  ticker: string;
  company: string;
  date: string;
  status: "upcoming" | "priced" | "filed" | "withdrawn";
  priceRange: string | null;
  offerPrice: number | null;
  sharesOffered: number | null;
  dealSizeM: number | null;
  exchange: string | null;
};

type OfferingBase = Omit<Offering, "rating" | "ratingFactors" | "ratingFactorItems" | "dilutionRisk" | "riskLevel" | "riskFactors" | "riskFactorItems">;

/** A factor as data: key in the `offerings` namespace + params. */
export type FactorItem = { k: string; p?: Record<string, string | number> };
const factorText = (it: FactorItem, lang: Lang) => offeringsT.tryFor(lang, it.k, it.p) ?? it.k;
/** Re-render the factor texts of every offering in a payload in `lang` (cached payloads hold the data items). */
function localizeOfferings<T>(payload: T, lang: Lang): T {
  if (lang === "ru" || !payload || typeof payload !== "object") return payload;
  const p = payload as unknown as { offerings?: Offering[] };
  if (!Array.isArray(p.offerings)) return payload;
  return {
    ...payload,
    offerings: p.offerings.map((o) => ({
      ...o,
      ...(o.ratingFactorItems ? { ratingFactors: o.ratingFactorItems.map((it) => factorText(it, lang)) } : {}),
      ...(o.riskFactorItems ? { riskFactors: o.riskFactorItems.map((it) => factorText(it, lang)) } : {}),
    })),
  } as T;
}

const EMPTY_EXTRA = {
  form: null, filingUrl: null, cik: null, exchange: null, priceRange: null,
  shelfCapacityM: null, babyShelf: false, babyShelfLimitM: null, offerPctOfMcap: null, dealFlags: [] as string[],
};

// ── Concurrency / SEC fetch helpers ──────────────────────────────────────────

/** Run `fn` over items with at most `limit` in flight. Results keep input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { status: "fulfilled", value: await fn(items[i], i) }; }
      catch (reason) { out[i] = { status: "rejected", reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// SEC fair-access: ≤10 req/s. A global gate keeps parallel route calls from bursting past it.
let secInFlight = 0;
const secQueue: Array<() => void> = [];
async function secFetch(url: string, timeoutMs = 15000, accept = "application/json, text/html, */*"): Promise<Response> {
  if (secInFlight >= 6) await new Promise<void>((r) => secQueue.push(r));
  secInFlight++;
  try {
    const ua = url.includes("www.sec.gov/Archives") ? SEC_ARCHIVES_UA : EDGAR_UA;
    return await fetch(url, { headers: { "User-Agent": ua, Accept: accept }, signal: AbortSignal.timeout(timeoutMs) });
  } finally {
    secInFlight--;
    secQueue.shift()?.();
  }
}

function cikNumber(cik: string): string {
  return cik.replace(/^CIK/i, "").replace(/^0+/, "") || "0";
}
function archiveUrl(cik: string, adsh: string, file: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${cikNumber(cik)}/${adsh.replace(/-/g, "")}/${file}`;
}

// ── Parse helpers ─────────────────────────────────────────────────────────────

function parseDollar(s: string | null | undefined): number | null {
  if (!s || s === "N/A" || s === "--" || s === "") return null;
  const n = parseFloat(s.replace(/[$,\sMBK()]/g, "").trim());
  return isNaN(n) ? null : n;
}

function parseMillions(s: string | null | undefined): number | null {
  if (!s || s === "N/A" || s === "--") return null;
  const clean = s.replace(/[$,]/g, "").trim();
  if (/B$/i.test(clean)) return parseFloat(clean) * 1000;
  if (/M$/i.test(clean)) return parseFloat(clean);
  const n = parseFloat(clean);
  if (isNaN(n)) return null;
  return n > 1_000_000 ? n / 1_000_000 : n;
}

// NASDAQ returns dates as "MM/DD/YYYY"; EDGAR as "YYYY-MM-DD". Normalize to ISO
// so the client can sort/format consistently.
function normalizeDate(s: string | null | undefined, fallback: string): string {
  if (!s) return fallback;
  const str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return fallback;
}

function parseShares(s: string | null | undefined): number | null {
  if (!s || s === "N/A" || s === "--") return null;
  const n = parseFloat(s.replace(/,/g, "").trim());
  return isNaN(n) ? null : n;
}

// ── Underwriter tier (for algo rating) ───────────────────────────────────────

const TIER1_UW = ["Goldman", "Morgan Stanley", "JPMorgan", "J.P. Morgan", "Bank of America", "BofA", "Citigroup", "Citi", "Barclays", "Credit Suisse", "Deutsche Bank", "UBS"];
const TIER2_UW = ["Jefferies", "Piper Sandler", "Oppenheimer", "Needham", "Cowen", "Canaccord", "Stifel", "Raymond James", "RBC", "Guggenheim", "William Blair", "Baird", "Truist"];

function uwTier(uw: string | null): 1 | 2 | 3 {
  if (!uw) return 3;
  if (TIER1_UW.some(t => uw.includes(t))) return 1;
  if (TIER2_UW.some(t => uw.includes(t))) return 2;
  return 3;
}

// ── Bond issuer filter (skip from EDGAR equity follow-on list) ────────────────
const BOND_ISSUERS = new Set([
  "JPM", "GS", "MS", "BAC", "C", "WFC", "USB", "TFC", "BNS", "RY", "TD", "BMO",
  "DB", "UBS", "BCS", "HSBC", "SAN", "ING", "AIG", "MET", "PRU", "LNC", "AXP",
  "COF", "DFS", "SLM", "ALLY", "CMA", "ZION", "HBAN", "RF", "MTB", "CFG",
]);

// ── Algo rating ───────────────────────────────────────────────────────────────

/**
 * Dilution risk 0–100 for holders (overnight/swing) and short-side ideas:
 * size vs market cap, structure (ATM / shelf / warrants / registered direct), cap size, price vs offer.
 */
function computeRisk(o: OfferingBase): { dilutionRisk: number; riskLevel: RiskLevel; riskFactors: string[]; riskFactorItems: FactorItem[] } {
  let s = 15;
  const f: FactorItem[] = [];
  const pct = Math.max(o.offerPctOfMcap ?? 0, o.dilutionPct ?? 0);
  if (pct > 30) { s += 40; f.push({ k: "risk.size", p: { pct: pct.toFixed(0) } }); }
  else if (pct > 15) { s += 28; f.push({ k: "risk.size", p: { pct: pct.toFixed(0) } }); }
  else if (pct > 7) { s += 15; f.push({ k: "risk.size", p: { pct: pct.toFixed(1) } }); }
  else if (pct > 3) { s += 6; f.push({ k: "risk.size", p: { pct: pct.toFixed(1) } }); }

  if (o.kind === "ATM") { s += 15; f.push({ k: "risk.atm" }); }
  else if (o.kind === "S-3") {
    if (o.form?.toUpperCase().includes("ASR")) { s -= 10; f.push({ k: "risk.wksi" }); }
    else { s += 10; f.push({ k: "risk.newShelf" }); }
  } else if (o.kind === "S-1" && o.currentPrice != null) { s += 18; f.push({ k: "risk.s1" }); }

  if (o.babyShelf) { s += 6; f.push({ k: "risk.babyShelf" }); }
  if (o.marketCapM != null) {
    if (o.marketCapM < 50) { s += 20; f.push({ k: "risk.micro", p: { cap: o.marketCapM.toFixed(0) } }); }
    else if (o.marketCapM < 300) { s += 10; f.push({ k: "risk.small", p: { cap: o.marketCapM.toFixed(0) } }); }
    else if (o.marketCapM > 10_000) { s -= 15; f.push({ k: "risk.mega" }); }
  }
  if (o.dealFlags.includes("warrants")) { s += 12; f.push({ k: "risk.warrants" }); }
  if (o.dealFlags.includes("Pre-funded")) s += 5;
  if (o.dealFlags.includes("Registered direct") || o.dealFlags.includes("Best efforts")) { s += 10; f.push({ k: "risk.direct" }); }
  if (o.sellerType === "insiders" || o.sellerType === "mixed") { s += 5; f.push({ k: "risk.insiders" }); }
  if (o.priceChangePct != null && o.offerPrice != null) {
    if (o.priceChangePct > 20) { s += 8; f.push({ k: "risk.aboveOffer", p: { pct: o.priceChangePct.toFixed(0) } }); }
    else if (o.priceChangePct < -10) { f.push({ k: "risk.broken", p: { pct: o.priceChangePct.toFixed(0) } }); }
  }
  const dilutionRisk = Math.max(0, Math.min(100, Math.round(s)));
  const riskLevel: RiskLevel = dilutionRisk >= 60 ? "high" : dilutionRisk >= 35 ? "medium" : "low";
  return { dilutionRisk, riskLevel, riskFactors: f.map((it) => factorText(it, "ru")), riskFactorItems: f };
}

function finalize(base: OfferingBase): Offering {
  const offerPctOfMcap = base.marketCapM && base.marketCapM > 0
    ? (base.dealSizeM ?? base.shelfCapacityM) != null
      ? +((((base.dealSizeM ?? base.shelfCapacityM) as number) / base.marketCapM) * 100).toFixed(1)
      : null
    : null;
  const babyShelf = (base.kind === "S-3" || base.kind === "ATM") && base.marketCapM != null && base.marketCapM < 75;
  const withDerived: OfferingBase = {
    ...base,
    offerPctOfMcap,
    babyShelf,
    babyShelfLimitM: babyShelf && base.marketCapM != null ? +(base.marketCapM / 3).toFixed(1) : null,
  };
  const { rating, factors } = computeRating(withDerived);
  return { ...withDerived, rating, ratingFactors: factors.map((it) => factorText(it, "ru")), ratingFactorItems: factors, ...computeRisk(withDerived) };
}

function computeRating(o: OfferingBase): { rating: number; factors: FactorItem[] } {
  let score = 50;
  const factors: FactorItem[] = [];

  // Price vs offer — biggest signal
  if (o.priceChangePct !== null) {
    if (o.priceChangePct > 30) { score += 25; factors.push({ k: "rating.strongStart", p: { pct: o.priceChangePct.toFixed(1) } }); }
    else if (o.priceChangePct > 15) { score += 18; factors.push({ k: "rating.aboveOffer", p: { pct: o.priceChangePct.toFixed(1) } }); }
    else if (o.priceChangePct > 5) { score += 10; factors.push({ k: "rating.aboveOffer", p: { pct: o.priceChangePct.toFixed(1) } }); }
    else if (o.priceChangePct >= -5) { factors.push({ k: "rating.atOffer", p: { pct: o.priceChangePct.toFixed(1) } }); }
    else if (o.priceChangePct < -20) { score -= 25; factors.push({ k: "rating.farBelow", p: { pct: o.priceChangePct.toFixed(1) } }); }
    else if (o.priceChangePct < -10) { score -= 15; factors.push({ k: "rating.below", p: { pct: o.priceChangePct.toFixed(1) } }); }
    else { score -= 6; factors.push({ k: "rating.weakStart", p: { pct: o.priceChangePct.toFixed(1) } }); }
  }

  // Dilution
  if (o.dilutionPct !== null) {
    if (o.dilutionPct > 40) { score -= 18; factors.push({ k: "rating.dilCritical", p: { pct: o.dilutionPct.toFixed(1) } }); }
    else if (o.dilutionPct > 20) { score -= 10; factors.push({ k: "rating.dilHigh", p: { pct: o.dilutionPct.toFixed(1) } }); }
    else if (o.dilutionPct > 10) { score -= 4; factors.push({ k: "rating.dilModerate", p: { pct: o.dilutionPct.toFixed(1) } }); }
    else if (o.dilutionPct < 5 && o.dilutionPct > 0) { score += 8; factors.push({ k: "rating.dilLow", p: { pct: o.dilutionPct.toFixed(1) } }); }
  }

  // Who sells
  if (o.sellerType === "insiders") { score -= 22; factors.push({ k: "rating.insiders" }); }
  else if (o.sellerType === "mixed") { score -= 10; factors.push({ k: "rating.mixed" }); }
  else if (o.sellerType === "company") { score += 10; factors.push({ k: "rating.company" }); }

  // Volume relative
  if (o.relVol !== null) {
    if (o.relVol > 5) { score += 15; factors.push({ k: "rating.volExtreme", p: { x: o.relVol.toFixed(1) } }); }
    else if (o.relVol > 3) { score += 10; factors.push({ k: "rating.volHigh", p: { x: o.relVol.toFixed(1) } }); }
    else if (o.relVol > 1.5) { score += 5; factors.push({ k: "rating.volHigh", p: { x: o.relVol.toFixed(1) } }); }
    else if (o.relVol < 0.5) { score -= 10; factors.push({ k: "rating.volLow" }); }
  }

  // Offering type
  if (o.type === "IPO") { score += 5; factors.push({ k: "rating.ipo" }); }
  else if (o.type === "Bought Deal") { score += 8; factors.push({ k: "rating.bought" }); }
  else if (o.type === "ATM") { score -= 12; factors.push({ k: "rating.atm" }); }
  else if (o.type === "SPAC") { score -= 5; factors.push({ k: "rating.spac" }); }

  // Underwriter quality
  const tier = uwTier(o.underwriter);
  if (tier === 1) { score += 8; factors.push({ k: "rating.uw1", p: { name: String(o.underwriter) } }); }
  else if (tier === 2) { score += 4; factors.push({ k: "rating.uw2", p: { name: String(o.underwriter) } }); }

  // Lockup
  if (o.lockupDays !== null) {
    if (o.lockupDays < 60) { score -= 8; factors.push({ k: "rating.lockShortest", p: { days: o.lockupDays } }); }
    else if (o.lockupDays <= 90) { score -= 4; factors.push({ k: "rating.lockShort", p: { days: o.lockupDays } }); }
    else if (o.lockupDays >= 180) { score += 3; factors.push({ k: "rating.lockStandard", p: { days: o.lockupDays } }); }
  }

  // Deal size
  if (o.dealSizeM !== null) {
    if (o.dealSizeM > 1000) { score += 10; factors.push({ k: "rating.dealBig", p: { b: (o.dealSizeM / 1000).toFixed(1) } }); }
    else if (o.dealSizeM > 200) { score += 6; factors.push({ k: "rating.deal", p: { m: o.dealSizeM.toFixed(0) } }); }
    else if (o.dealSizeM < 15) { score -= 6; factors.push({ k: "rating.dealSmall", p: { m: o.dealSizeM.toFixed(0) } }); }
  }

  return { rating: Math.max(0, Math.min(100, Math.round(score))), factors };
}

// ── Yahoo Finance enrichment ──────────────────────────────────────────────────

type MarketQuote = {
  price: number | null;
  volume: number | null;
  avgVolume: number | null;
  relVol: number | null;
  marketCapM: number | null;
  shortName: string | null;
  sharesOutstanding: number | null;
  exchange: string | null;
  prevClose?: number | null;
};

const EMPTY_QUOTE: MarketQuote = { price: null, volume: null, avgVolume: null, relVol: null, marketCapM: null, shortName: null, sharesOutstanding: null, exchange: null, prevClose: null };

/** One batched v7 quote call per 40 symbols (needs the shared Yahoo cookie/crumb session). */
async function fetchYahooBatch(tickers: string[]): Promise<Map<string, MarketQuote>> {
  const out = new Map<string, MarketQuote>();
  for (let i = 0; i < tickers.length; i += 40) {
    const chunk = tickers.slice(i, i + 40);
    try {
      const resp = await fetchYahooWithSession((s) =>
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(chunk.join(","))}&crumb=${encodeURIComponent(s.crumb)}`,
      );
      if (!resp || !resp.ok) continue;
      const data = await resp.json() as { quoteResponse?: { result?: any[] } };
      for (const q of data?.quoteResponse?.result ?? []) {
        if (!q?.symbol) continue;
        const price: number | null = q.regularMarketPrice ?? null;
        const volume: number | null = q.regularMarketVolume ?? null;
        const avgVolume: number | null = q.averageDailyVolume3Month ?? q.averageDailyVolume10Day ?? null;
        out.set(String(q.symbol).toUpperCase(), {
          price, volume, avgVolume,
          relVol: volume && avgVolume && avgVolume > 0 ? +((volume / avgVolume).toFixed(2)) : null,
          marketCapM: q.marketCap ? q.marketCap / 1_000_000 : null,
          shortName: q.shortName ?? q.longName ?? null,
          sharesOutstanding: q.sharesOutstanding ?? null,
          exchange: q.fullExchangeName ?? q.exchange ?? null,
          prevClose: q.regularMarketPreviousClose ?? null,
        });
      }
    } catch (e: any) {
      logger.warn({ error: e?.message }, "Yahoo batch quote failed");
    }
  }
  return out;
}

/** Fallback when the crumb session is unavailable: v8 chart meta (price/volume only). */
async function fetchYahooChartQuote(ticker: string): Promise<MarketQuote> {
  try {
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`;
    const chartResp = await fetch(chartUrl, { headers: { "User-Agent": NASDAQ_UA }, signal: AbortSignal.timeout(8000) });
    if (!chartResp.ok) return EMPTY_QUOTE;
    const chartData = await chartResp.json() as any;
    const meta = chartData?.chart?.result?.[0]?.meta ?? {};
    const price: number | null = meta.regularMarketPrice ?? null;
    const volume: number | null = meta.regularMarketVolume ?? null;
    return {
      ...EMPTY_QUOTE,
      price, volume,
      marketCapM: meta.marketCap ? meta.marketCap / 1_000_000 : null,
      shortName: meta.shortName ?? meta.longName ?? null,
      exchange: meta.fullExchangeName ?? null,
    };
  } catch {
    return EMPTY_QUOTE;
  }
}

async function fetchMarketQuotes(tickers: string[]): Promise<Map<string, MarketQuote>> {
  const uniq = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
  const quotes = await fetchYahooBatch(uniq);
  const missing = uniq.filter((t) => !quotes.has(t));
  if (missing.length) {
    const res = await mapLimit(missing, 6, (t) => fetchYahooChartQuote(t));
    res.forEach((r, i) => { if (r.status === "fulfilled" && r.value.price != null) quotes.set(missing[i], r.value); });
  }
  return quotes;
}

// ── Source 1: NASDAQ IPO Calendar ────────────────────────────────────────────

// The NASDAQ endpoint only accepts a month (?date=YYYY-MM) and returns the whole month.
// We filter server-side so the day view only shows deals that belong to the chosen day:
//   upcoming → expected pricing date == day; priced → priced on day or the prior session
//   (an IPO priced last night trades today); withdrawn → withdrawn on day.
// The rest of the month is returned separately as a compact calendar strip.
async function fetchNasdaqIpo(day: string): Promise<{ offerings: Offering[]; ipoTickers: Set<string>; calendar: IpoCalendarItem[]; ok: boolean }> {
  const ipoTickers = new Set<string>();
  const calendar: IpoCalendarItem[] = [];
  try {
    const ym = day.slice(0, 7);
    const url = `https://api.nasdaq.com/api/ipo/calendar?date=${ym}`;
    const resp = await fetch(url, { headers: NASDAQ_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return { offerings: [], ipoTickers, calendar, ok: false };

    const data = await resp.json() as any;
    const upcoming: any[] = data?.data?.upcoming?.upcomingTable?.rows ?? [];
    const priced: any[] = data?.data?.priced?.rows ?? [];
    const withdrawn: any[] = data?.data?.withdrawn?.rows ?? [];
    const filed: any[] = data?.data?.filed?.rows ?? [];
    const prevDay = prevBusinessDay(day);

    const offerings: Offering[] = [];

    const mkBase = (r: any, ticker: string, date: string, status: Offering["status"]): OfferingBase => {
      const sharesOffered = parseShares(r.sharesOffered);
      const offerPrice = status === "withdrawn" ? null : parseDollar(r.proposedSharePrice ?? r.priceRange);
      const dealSizeM = r.dollarValueOfSharesOffered
        ? parseMillions(r.dollarValueOfSharesOffered)
        : sharesOffered && offerPrice ? (sharesOffered * offerPrice) / 1_000_000 : null;
      const name = String(r.companyName ?? ticker);
      const isSpac = /spac|blank check|acquisition corp/i.test(name);
      return {
        ticker, company: name,
        type: isSpac ? "SPAC" : "IPO",
        date,
        offerPrice, currentPrice: null, priceChangePct: null,
        dealSizeM, sharesOffered,
        sharesOutstandingBefore: null, sharesOutstandingAfter: null,
        dilutionPct: null, sellerType: status === "withdrawn" ? "unknown" : "company",
        insiderShares: null, companyShares: status === "withdrawn" ? null : sharesOffered,
        underwriter: r.leadUnderwriter ?? r.underwriter ?? null,
        lockupDays: status === "withdrawn" ? null : 180,
        volume: null, avgVolume: null, relVol: null, marketCapM: null,
        sector: null, status, source: "nasdaq",
        ...EMPTY_EXTRA,
        kind: "IPO", form: "IPO",
        exchange: r.proposedExchange ?? null,
        priceRange: r.proposedSharePrice ? String(r.proposedSharePrice) : null,
        dealFlags: [],
      };
    };

    const pushCal = (r: any, ticker: string, date: string, status: IpoCalendarItem["status"]) => {
      const sharesOffered = parseShares(r.sharesOffered);
      const offerPrice = parseDollar(r.proposedSharePrice ?? r.priceRange);
      calendar.push({
        ticker, company: String(r.companyName ?? ticker), date, status,
        priceRange: r.proposedSharePrice ? String(r.proposedSharePrice) : null,
        offerPrice, sharesOffered,
        dealSizeM: r.dollarValueOfSharesOffered ? parseMillions(r.dollarValueOfSharesOffered)
          : sharesOffered && offerPrice ? +((sharesOffered * offerPrice) / 1_000_000).toFixed(1) : null,
        exchange: r.proposedExchange ?? null,
      });
    };

    for (const r of upcoming) {
      const ticker = String(r.proposedTickerSymbol ?? r.symbol ?? "").trim().toUpperCase();
      if (!ticker) continue;
      ipoTickers.add(ticker);
      const date = normalizeDate(r.expectedPriceDate ?? r.ipoDate, "");
      if (date) pushCal(r, ticker, date, "upcoming");
      if (date === day) offerings.push(finalize(mkBase(r, ticker, date, "upcoming")));
    }
    for (const r of priced) {
      const ticker = String(r.proposedTickerSymbol ?? r.symbol ?? "").trim().toUpperCase();
      if (!ticker) continue;
      ipoTickers.add(ticker);
      const date = normalizeDate(r.pricedDate, "");
      if (date) pushCal(r, ticker, date, "priced");
      if (date === day || date === prevDay) offerings.push(finalize(mkBase(r, ticker, date, "priced")));
    }
    for (const r of withdrawn) {
      const ticker = String(r.proposedTickerSymbol ?? r.symbol ?? "").trim().toUpperCase();
      if (!ticker) continue;
      const date = normalizeDate(r.withdrawDate, "");
      if (date) pushCal(r, ticker, date, "withdrawn");
      if (date === day) offerings.push(finalize(mkBase(r, ticker, date, "withdrawn")));
    }
    for (const r of filed) {
      const ticker = String(r.proposedTickerSymbol ?? r.symbol ?? "").trim().toUpperCase();
      if (!ticker) continue;
      ipoTickers.add(ticker);
      const date = normalizeDate(r.filedDate, "");
      if (date) pushCal(r, ticker, date, "filed");
    }

    calendar.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
    logger.info({ ym, day, upcoming: upcoming.length, priced: priced.length, withdrawn: withdrawn.length, kept: offerings.length }, "NASDAQ IPO calendar fetched");
    return { offerings, ipoTickers, calendar, ok: true };
  } catch (e: any) {
    logger.warn({ error: e?.message }, "NASDAQ IPO calendar fetch failed");
    return { offerings: [], ipoTickers, calendar, ok: false };
  }
}


// ── Date helpers ──────────────────────────────────────────────────────────────

function prevBusinessDay(day: string): string {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  // Skip Sunday (0) → back 2 more, Saturday (6) → back 1 more
  const dow = d.getUTCDay();
  if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  else if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── Source 2: SEC EDGAR 424B4 + 424B5 with full filing parsing ────────────────

function extractTickerFromDisplayName(displayNames: string[]): string | null {
  for (const dn of displayNames ?? []) {
    const m = dn.match(/\(([A-Z]{1,5}(?:\.[A-Z]{1,2})?)\s*[,)]/);
    if (m) {
      const t = m[1].trim();
      if (!t.includes("-") && !/\d/.test(t)) return t;
    }
  }
  return null;
}

function extractCompanyFromDisplayName(dn: string): string {
  return dn
    .replace(/\s*\(CIK\s+\d+\)\s*$/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
}

// Parse offer details from SEC filing HTML text
function parseFilingDocument(html: string): {
  offerPrice: number | null;
  sharesOffered: number | null;
  dealSizeM: number | null;
  underwriter: string | null;
  sellerType: SellerType;
  lockupDays: number | null;
  sharesOutstandingBefore: number | null;
  isAtm: boolean;
  isDebt: boolean;
  isPreliminary: boolean;
  flags: string[];
} {
  // Strip styles, scripts, and HTML tags, normalize whitespace
  const plain = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ");

  const head = plain.slice(0, 80000);
  const coverPage = plain.slice(0, 4000);
  const coverLow = coverPage.toLowerCase();

  // ── Preliminary supplement detection (skip — price not yet set) ──
  // "preliminary prospectus supplement...not complete and may be changed" = pre-pricing
  const isPreliminary =
    /preliminary\s+prospectus\s+supplement/i.test(coverPage) &&
    /not\s+complete\s+and\s+may\s+be\s+changed/i.test(coverPage);

  // ── Debt offering detection (skip — we only want equity) ──
  // If cover mentions convertible notes, senior notes, debentures → debt instrument
  const isDebt =
    /convertible\s+(?:senior\s+)?notes?|senior\s+(?:unsecured\s+)?notes?|debentures?|subordinated\s+notes?/i.test(coverPage) &&
    !/common\s+stock|ordinary\s+shares?/i.test(coverPage.slice(0, 500));

  // ── ATM detection (before price parsing) ──
  // ATM = "at-the-market" explicit OR "Sales Agreement"+"Up to $" in cover
  //       AND cover has no fixed "Public Offering Price"
  // A Follow-on that references an old ATM program still says "Public Offering Price" in cover.
  const coverHasSalesAgreement = /sales\s+agreement|offering\s+agreement/i.test(coverPage);
  const coverHasFixedPriceLabel = /public\s+offering\s+price/i.test(coverPage);
  const isAtm =
    /at-the-market|at the market/i.test(coverPage) ||
    (coverHasSalesAgreement && /up\s+to\s+\$/i.test(coverPage) && !coverHasFixedPriceLabel);

  // ── Offer price (only for Follow-on / IPO — ATMs have no fixed price) ──
  // Priority: table prices ("Public offering price $ X.XX") BEFORE generic "$ X.XX per share"
  // to avoid matching reference/last-sale price like "last reported sale price was $95.29 per share"
  let offerPrice: number | null = null;
  if (!isAtm) {
    const pricePats: RegExp[] = [
      /[Pp]ublic\s+[Oo]ffering\s+[Pp]rice\s+\$\s*([\d,]+\.?\d*)/i,
      /[Pp]rice\s+to\s+[Pp]ublic\s+\$\s*([\d,]+\.?\d*)/i,
      /[Pp]rice\s+[Pp]er\s+[Ss]hare\s+\$\s*([\d,]+\.?\d*)/i,
      /[Oo]ffering\s+[Pp]rice\b[^$\d]{0,30}\$\s*([\d,]+\.?\d*)/i,
      // Generic "$ X.XX per share" — last resort (matches reference prices too)
      /\$\s*([\d]+\.[\d]{2})\s*per\s+(?:share|ADS|ADR|ordinary\s+share)/i,
      /per\s+(?:common\s+)?share\s+\$\s*([\d,]+\.?\d*)/i,
    ];
    for (const pat of pricePats) {
      const m = head.match(pat);
      if (m) {
        const n = parseFloat(m[1].replace(/,/g, ""));
        // Filter out par values (0.0001, 0.001, 0.01)
        if (n > 0.05 && n < 50000) { offerPrice = n; break; }
      }
    }
  }

  // ── Shares offered (for Follow-on; ATM has variable shares) ──
  let sharesOffered: number | null = null;
  if (!isAtm) {
    const sharePats: RegExp[] = [
      /([0-9,]+)\s+shares?\s+of\s+(?:our\s+)?(?:class\s+[a-z]\s+)?common\s+stock\s+(?:in\s+this\s+offering|to\s+be\s+(?:sold|offered)|being\s+offered|offered\s+hereby)/i,
      /offering\s+of\s+([0-9,]+)\s+(?:additional\s+)?shares?\s+of\s+(?:our\s+)?(?:class\s+[a-z]\s+)?common\s+stock/i,
      /([0-9,]+)\s+(?:additional\s+)?shares?\s+of\s+(?:our\s+)?common\s+stock\s+in\s+this\s+offering/i,
      /selling\s+([0-9,]+)\s+shares?\s+of\s+(?:our\s+)?common\s+stock/i,
    ];
    for (const pat of sharePats) {
      const m = head.match(pat);
      if (m) {
        const n = parseInt(m[1].replace(/,/g, ""), 10);
        if (n > 1000 && n < 10_000_000_000) { sharesOffered = n; break; }
      }
    }
  }

  // ── Deal size ──
  let dealSizeM: number | null = null;
  const dealPats: RegExp[] = [
    // Pricing table total: "Public offering price $ X.XX $ TOTAL"  (second $ column = aggregate)
    // e.g. "Public offering price $ 85.00 $ 225,000,015" → captures 225,000,015
    /[Pp]ublic\s+[Oo]ffering\s+[Pp]rice\s+\$\s*[\d,.]+\s*\$\s*([\d,]+)/i,
    // ATM: "Up to $500,000,000" / "Up to $500 million"
    /[Uu]p\s+to\s+\$\s*([\d,]+(?:\.\d+)?)\s*(million|billion|B\b|M\b)?/,
    /[Aa]ggregate\s+[Gg]ross\s+[Pp]roceeds[^$\d]{0,30}\$\s*([\d,]+(?:\.\d+)?)\s*(million|M\b)?/i,
    /[Gg]ross\s+[Pp]roceeds\s+to\s+(?:us|the\s+company)[^$\d]{0,40}\$\s*([\d,]+(?:\.\d+)?)\s*(million|M\b)?/i,
    /[Aa]ggregate\s+[Oo]ffering\s+[Pp]rice\b[^$\d]{0,30}\$\s*([\d,]+(?:\.\d+)?)/i,
  ];
  for (const pat of dealPats) {
    const m = head.match(pat);
    if (m) {
      let n = parseFloat(m[1].replace(/,/g, ""));
      const suffix = (m[2] ?? "").toLowerCase();
      if (suffix.startsWith("b")) n = n * 1000;
      else if (n > 1_000_000) n = n / 1_000_000;
      if (n > 0 && n < 500_000) { dealSizeM = n; break; }
    }
  }
  if (!dealSizeM && offerPrice && sharesOffered) {
    dealSizeM = (offerPrice * sharesOffered) / 1_000_000;
  }

  // ── Underwriter / Agent ──
  // Helper: clean extracted underwriter name
  const cleanUw = (s: string): string =>
    s.trim()
      .replace(/\s+&\s*$/, "")        // trailing "& Co." stopped at &
      .replace(/\s+(LLC|Inc|Ltd|Corp|LLP|Co)\s*$/i, "")
      .replace(/[,&.]\s*$/, "")
      .slice(0, 60)
      .trim();

  let underwriter: string | null = null;
  if (isAtm) {
    // ATM: extract lead agent/sales agent named after "with" or as "Sales Agent"
    // Patterns cover:
    //   "Sales Agreement") with Barclays Capital Inc., Cantor..."
    //   "Offering Agreement) with H.C. Wainwright Co., LLC"
    //   "at-the-market offering agreement ... with H.C. Wainwright"
    //   "Sales Agent), dated..."  or  "Sales Agent, H.C. Wainwright"
    const atmPats: RegExp[] = [
      // "equity distribution agreement (the ...) with Goldman Sachs Co. LLC, J.P. Morgan..."
      /equity\s+distribution\s+agreement[^)]{0,80}\)\s+with\s+([A-Z][A-Za-z\s.&]{3,55}?)(?:\s*(?:,|\(|LLC|Inc|Ltd|Co\.))/i,
      /equity\s+distribution\s+agreement\s+with\s+([A-Z][A-Za-z\s.&]{3,55}?)(?:\s*(?:,|\(|LLC|Inc|Ltd|Co\.))/i,
      // "Sales/Offering Agreement (the ...) with [Name]"
      /(?:[Ss]ales|[Oo]ffering)\s+[Aa]greement[^)]{0,60}\)\s+with\s+([A-Z][A-Za-z\s.&]{3,55}?)(?:\s*(?:,|\(|LLC|Inc|Ltd|Co\.))/,
      /(?:[Ss]ales|[Oo]ffering)\s+[Aa]greement\s+with\s+([A-Z][A-Za-z\s.&]{3,55}?)(?:\s*(?:,|\(|LLC|Inc|Ltd|Co\.))/,
      // "at-the-market offering agreement ... with [Name]"
      /at-the-market\s+(?:offering\s+)?agreement[^)]{0,60}\)\s+with\s+([A-Z][A-Za-z\s.&]{3,55}?)(?:\s*(?:,|\())/i,
      /at-the-market\s+(?:offering\s+)?agreement\s+with\s+([A-Z][A-Za-z\s.&]{3,55}?)(?:\s*(?:,|\())/i,
      // "(the Sales Agent) [Name]" or "Sales Agent: [Name]"
      /\(\s*(?:the\s+)?"[Ss]ales\s+[Aa]gent"\s*\)[\s,]*([A-Z][A-Za-z\s.&]{3,55}?)(?:\s*(?:,|\())/,
      /[Ss]ales\s+[Aa]gent[^A-Z\n]{0,10}([A-Z][A-Za-z\s.&]{3,55}?)(?:\s*(?:,|\(|LLC|Inc))/,
      /[Ss]ales\s+[Aa]gents?\s*:\s*([A-Z][A-Za-z\s.&]{3,55}?)(?:,|\.|and\b|\n)/i,
    ];
    for (const pat of atmPats) {
      const m = head.match(pat);
      if (m) { underwriter = cleanUw(m[1]); break; }
    }
  } else {
    // Follow-on / IPO: standard underwriter patterns.
    // Known banks (handles periods in "J.P. Morgan"):
    const BANKS = "J\\.P\\.\\s+Morgan|JPMorgan|Goldman\\s+Sachs|Morgan\\s+Stanley|Bank\\s+of\\s+America|Citigroup|Barclays|Wells\\s+Fargo|Jefferies|Piper\\s+Sandler|RBC\\s+Capital|Canaccord|Stifel|Raymond\\s+James";
    const banksPat = new RegExp(BANKS, "i");
    // Generic name (no dots, for less known banks):
    const genName = "([A-Z][A-Za-z\\s.&]{4,55}?)";

    // Priority 1 (highest): Cover-page naked bank list before "The date of this prospectus"
    //   e.g. "Morgan Stanley J.P. Morgan The date of this prospectus supplement is..."
    //   Use [\s\S]{0,150}? to skip J.P. periods and other cover-page content.
    const coverDateM = head.match(
      new RegExp(`\\b(${BANKS})\\b[\\s\\S]{0,150}?The\\s+date\\s+of\\s+this\\s+prospectus`, "i")
    );
    if (coverDateM) {
      underwriter = cleanUw(coverDateM[1]);
    }

    if (!underwriter) {
      const uwPats: RegExp[] = [
        // Sole/Joint Book-Running Manager(s) — with named banks (handles periods)
        new RegExp(`(?:[Ss]ole|[Jj]oint)\\s+[Bb]ook-?[Rr]unning\\s+[Mm]anager[s]?\\s+(${BANKS})`, "i"),
        // Plain "Book-Running Manager(s)" — named banks
        new RegExp(`[Bb]ook-?[Rr]unning\\s+[Mm]anager[s]?\\s+(${BANKS})`, "i"),
        // Lead Manager — named banks
        new RegExp(`[Ll]ead\\s+[Mm]anager[s]?\\s+(${BANKS})`, "i"),
        // Placement Agent — generic name
        /[Pp]lacement\s+[Aa]gent[^A-Z\n]{0,10}([A-Z][A-Za-z\s.&]{4,55}?)(?:\s+(?:and\b|LLC|Inc|Ltd|Corp)|\.|,|\n)/,
        // Underwritten by — generic name
        /[Uu]nderwritten\s+by[^A-Z\n]{0,10}([A-Z][A-Za-z\s.&]{4,55}?)(?:\s+(?:and\b|LLC|Inc|Ltd|Corp)|\.|,|\n)/,
        // "Titan Partners Group LLC ... (the Underwriter)" pattern
        /([A-Z][A-Za-z\s.&,]{4,60}?)\s*(?:LLC|Inc|Corp|Ltd)[^)]{0,30}\(\s*the\s+[Uu]nderwriter\s*\)/,
        // "payable to [Name] LLC" (lower priority — catches J.P. Morgan but less reliable for lead)
        /[Pp]ayable\s+to\s+([A-Z][A-Za-z\s.&]{4,55}?)(?:LLC|Inc|Corp|Ltd)/,
      ];
      for (const pat of uwPats) {
        const m = head.match(pat);
        if (m) {
          // For named-bank patterns the capture group contains the full bank name.
          // For generic patterns strip trailing junk.
          const raw = m[1] ?? m[0];
          // If capture is one of the BANKS alternations, use it directly.
          underwriter = cleanUw(raw);
          break;
        }
      }
    }
  }

  // ── Shares outstanding BEFORE offering (for dilution) ──
  let sharesOutstandingBefore: number | null = null;
  const soPats: RegExp[] = [
    /([0-9,]{7,})\s+shares?\s+of\s+(?:our\s+)?(?:class\s+[a-z]\s+)?common\s+stock\s+(?:were|are)\s+outstanding/i,
    /([0-9,]{7,})\s+shares?\s+of\s+(?:our\s+)?common\s+stock\s+outstanding\s+(?:as\s+of|prior\s+to)/i,
    /outstanding\s+prior\s+to\s+this\s+offering[^0-9]{0,30}([0-9,]{7,})/i,
    /([0-9,]{7,})\s+shares?\s+outstanding\s+as\s+of/i,
  ];
  for (const pat of soPats) {
    const m = head.match(pat);
    if (m) {
      const n = parseInt(m[1].replace(/,/g, ""), 10);
      if (n > 100_000) { sharesOutstandingBefore = n; break; }
    }
  }
  // Fallback: search wider
  if (!sharesOutstandingBefore) {
    const m = plain.match(/([0-9,]{8,})\s+(?:shares?\s+)?outstanding/i);
    if (m) {
      const n = parseInt(m[1].replace(/,/g, ""), 10);
      if (n > 100_000 && n < 50_000_000_000) sharesOutstandingBefore = n;
    }
  }

  // ── Seller type ──
  const hasSecondary = /[Ss]elling\s+(?:[Ss]tockholders?|[Ss]hareholders?)|[Ss]econdary\s+[Oo]ffering/.test(head);
  const hasPrimary = /[Pp]rimary\s+[Oo]ffering|[Ff]resh\s+[Ii]ssue|[Nn]ew\s+[Ss]hares|proceeds\s+to\s+(?:us|the\s+company)/i.test(head);
  let sellerType: SellerType = "company";
  if (hasSecondary && hasPrimary) sellerType = "mixed";
  else if (hasSecondary) sellerType = "insiders";

  // ── Lockup ──
  let lockupDays: number | null = null;
  const lockupM = head.match(/(\d+)[\s-]*(?:trading\s+)?(?:calendar\s+)?days?\s*lock-?up/i);
  if (lockupM) lockupDays = parseInt(lockupM[1], 10);
  else if (/180[\s-]*day\s+lock/i.test(head)) lockupDays = 180;
  else if (/90[\s-]*day\s+lock/i.test(head)) lockupDays = 90;

  // ── Deal-structure flags (cover + first pages): toxic small-cap structures raise dilution risk ──
  const flagZone = plain.slice(0, 12000);
  const flags: string[] = [];
  if (/pre-?funded\s+warrants?/i.test(flagZone)) flags.push("Pre-funded");
  if (/(?:common|accompanying|series\s+[a-z])\s+warrants?|warrants?\s+to\s+purchase/i.test(flagZone)) flags.push("warrants");
  if (/registered\s+direct/i.test(flagZone)) flags.push("Registered direct");
  if (/best[\s-]+efforts/i.test(flagZone)) flags.push("Best efforts");
  if (/concurrent\s+private\s+placement/i.test(flagZone)) flags.push("private_placement");
  if (/convertible\s+preferred/i.test(flagZone)) flags.push("convertible_preferred");

  return { offerPrice, sharesOffered, dealSizeM, underwriter, sellerType, lockupDays, sharesOutstandingBefore, isAtm, isDebt, isPreliminary, flags };
}

// ── SEC submissions (per-company filing index), cached ───────────────────────

type Submissions = {
  name?: string;
  tickers?: string[];
  sicDescription?: string;
  filings?: { recent?: { accessionNumber?: string[]; filingDate?: string[]; form?: string[]; primaryDocument?: string[]; primaryDocDescription?: string[]; acceptanceDateTime?: string[] } };
};
const subsCache = new Map<string, { data: Submissions | null; ts: number }>();
const SUBS_TTL = 30 * 60_000;

async function getSubmissions(cikPadded: string): Promise<Submissions | null> {
  const key = `CIK${cikNumber(cikPadded).padStart(10, "0")}`;
  const hit = subsCache.get(key);
  if (hit && Date.now() - hit.ts < SUBS_TTL) return hit.data;
  try {
    const resp = await secFetch(`https://data.sec.gov/submissions/${key}.json`, 8000);
    const data = resp.ok ? (await resp.json() as Submissions) : null;
    if (subsCache.size > 500) subsCache.clear();
    subsCache.set(key, { data, ts: Date.now() });
    return data;
  } catch {
    return null;
  }
}

// Fallback: primary document name from the submissions index (when the EFTS hit id has no file name)
async function getFilingDocName(cikPadded: string, adsh: string): Promise<string | null> {
  const data = await getSubmissions(cikPadded);
  const recent = data?.filings?.recent ?? {};
  const adshList: string[] = recent.accessionNumber ?? [];
  const docs: string[] = recent.primaryDocument ?? [];
  const targetClean = adsh.replace(/-/g, "");
  const idx = adshList.findIndex((a: string) => a.replace(/-/g, "") === targetClean);
  return idx >= 0 ? (docs[idx] ?? null) : null;
}

type FilingDetails = ReturnType<typeof parseFilingDocument>;
const EMPTY_DETAILS: FilingDetails = {
  offerPrice: null, sharesOffered: null, dealSizeM: null,
  underwriter: null, sellerType: "company", lockupDays: null,
  sharesOutstandingBefore: null, isAtm: false, isDebt: false, isPreliminary: false, flags: [],
};

// Fetch & parse SEC filing document for deal details
async function fetchFilingDetails(cikPadded: string, adsh: string, file: string | null): Promise<{ details: FilingDetails; url: string | null }> {
  try {
    const docName = file ?? await getFilingDocName(cikPadded, adsh);
    if (!docName) return { details: EMPTY_DETAILS, url: null };
    const url = archiveUrl(cikPadded, adsh, docName);
    const resp = await secFetch(url, 20000, "text/html, */*");
    if (!resp.ok) return { details: EMPTY_DETAILS, url };
    const buffer = await resp.arrayBuffer();
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer.slice(0, 150000));
    return { details: parseFilingDocument(text), url };
  } catch (e: any) {
    logger.warn({ cikPadded, adsh, error: e?.message }, "EDGAR filing doc parse failed");
    return { details: EMPTY_DETAILS, url: null };
  }
}

// ── Source 2: SEC EDGAR (424B takedowns, ATM programs, S-3 shelves, S-1 registrations) ──

const EDGAR_FORMS = ["424B1", "424B4", "424B5", "424B7", "S-1", "F-1", "S-3", "S-3ASR", "F-3"];
const MAX_EDGAR_CANDIDATES = 60;

function kindOfForm(form: string): FilingKind | null {
  const f = form.toUpperCase();
  if (f.startsWith("424B")) return "424B";
  if (/^(S-3|F-3)/.test(f)) return "S-3";
  if (/^(S-1|F-1)/.test(f)) return "S-1";
  return null;
}
const KIND_RANK: Record<FilingKind, number> = { "424B": 3, ATM: 3, IPO: 3, "S-1": 2, "S-3": 1 };

// Searches D-1 AND D: companies price at close of Day T, file 424B5 morning of T+1.
// So "today's" offerings = filings from yesterday + today.
async function fetchEdgarOfferings(day: string, ipoTickers: Set<string>): Promise<{ offerings: OfferingBase[]; ok: boolean }> {
  try {
    const prevDay = prevBusinessDay(day);
    const base = `https://efts.sec.gov/LATEST/search-index?forms=${EDGAR_FORMS.join(",")}&dateRange=custom&startdt=${prevDay}&enddt=${day}`;
    const pages = await Promise.allSettled([0, 100].map(async (from) => {
      const resp = await secFetch(from ? `${base}&from=${from}` : base, 15000);
      if (!resp.ok) throw new Error(`EFTS HTTP ${resp.status}`);
      const data = await resp.json() as any;
      return (data?.hits?.hits ?? []) as any[];
    }));
    if (pages[0].status === "rejected") throw pages[0].reason;
    const hits = pages.flatMap((p) => (p.status === "fulfilled" ? p.value : []));
    logger.info({ day, prevDay, count: hits.length }, "EDGAR EFTS fetched");

    // One filing per ticker: priced takedown (424B) beats registration (S-1) beats shelf (S-3); then latest date.
    type Cand = { ticker: string; company: string; form: string; kind: FilingKind; fileDate: string; cikPadded: string; adsh: string; file: string | null };
    const tickerMap = new Map<string, Cand>();
    for (const hit of hits) {
      const s = hit._source ?? {};
      const form = String(s.form ?? s.file_type ?? "");
      const kind = kindOfForm(form);
      if (!kind) continue;
      const displayNames: string[] = s.display_names ?? [];
      const ticker = extractTickerFromDisplayName(displayNames);
      if (!ticker || BOND_ISSUERS.has(ticker)) continue;
      const company = displayNames[0] ? extractCompanyFromDisplayName(displayNames[0]) : ticker;
      const cikRaw: string = (s.ciks ?? [])[0] ?? "";
      const cikPadded = `CIK${cikRaw.replace(/^0+/, "").padStart(10, "0")}`;
      const fileDate: string = s.file_date ?? day;
      const adsh: string = s.adsh ?? "";
      const idStr = String(hit._id ?? "");
      const file = idStr.includes(":") ? idStr.slice(idStr.indexOf(":") + 1) || null : null;
      const cand: Cand = { ticker, company, form, kind, fileDate, cikPadded, adsh, file };
      const existing = tickerMap.get(ticker);
      if (!existing
        || KIND_RANK[kind] > KIND_RANK[existing.kind]
        || (KIND_RANK[kind] === KIND_RANK[existing.kind] && fileDate > existing.fileDate)) {
        tickerMap.set(ticker, cand);
      }
    }

    const candidates = Array.from(tickerMap.values())
      .sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind] || b.fileDate.localeCompare(a.fileDate))
      .slice(0, MAX_EDGAR_CANDIDATES);

    const detailResults = await mapLimit(candidates, 6, (c) => fetchFilingDetails(c.cikPadded, c.adsh, c.file));

    const offerings: OfferingBase[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const dr = detailResults[i];
      const { details, url } = dr.status === "fulfilled" ? dr.value : { details: EMPTY_DETAILS, url: null };

      // Priced takedowns only: skip preliminary supplements. Registrations (S-1/S-3) are pre-pricing by nature.
      if (c.kind === "424B" && details.isPreliminary) continue;
      if (details.isDebt) continue;

      const isShelf = c.kind === "S-3";
      const kind: FilingKind = c.kind === "424B" && details.isAtm ? "ATM" : c.kind;
      const type: OfferingType = isShelf ? "Shelf"
        : ipoTickers.has(c.ticker) ? "IPO"
        : kind === "ATM" ? "ATM"
        : "Follow-on";

      const sharesOffered = isShelf ? null : details.sharesOffered;
      let dilutionPct: number | null = null;
      let sharesOutstandingAfter: number | null = null;
      if (details.sharesOutstandingBefore && sharesOffered) {
        sharesOutstandingAfter = details.sharesOutstandingBefore + sharesOffered;
        dilutionPct = +((sharesOffered / details.sharesOutstandingBefore) * 100).toFixed(2);
      }
      const flags = [...details.flags];
      if (kind === "ATM" && !flags.includes("ATM")) flags.unshift("ATM");

      offerings.push({
        ticker: c.ticker,
        company: c.company,
        type,
        date: c.fileDate,
        offerPrice: isShelf ? null : details.offerPrice,
        currentPrice: null,
        priceChangePct: null,
        dealSizeM: isShelf ? null : details.dealSizeM,
        sharesOffered,
        sharesOutstandingBefore: details.sharesOutstandingBefore,
        sharesOutstandingAfter,
        dilutionPct,
        sellerType: details.sellerType,
        insiderShares: null,
        companyShares: details.sellerType !== "insiders" ? sharesOffered : null,
        underwriter: details.underwriter,
        lockupDays: c.kind === "424B" ? details.lockupDays ?? 90 : details.lockupDays,
        volume: null, avgVolume: null, relVol: null, marketCapM: null,
        sector: null, status: c.kind === "424B" ? "priced" : "filed", source: "edgar",
        ...EMPTY_EXTRA,
        kind,
        form: c.form,
        filingUrl: url ?? (c.file ? archiveUrl(c.cikPadded, c.adsh, c.file) : null),
        cik: c.cikPadded,
        shelfCapacityM: isShelf ? details.dealSizeM : kind === "ATM" ? details.dealSizeM : null,
        dealFlags: flags,
      });
    }
    return { offerings, ok: true };
  } catch (e: any) {
    logger.warn({ error: e?.message }, "EDGAR EFTS offerings fetch failed");
    return { offerings: [], ok: false };
  }
}

// ── Enrich all with market data ───────────────────────────────────────────────

async function enrichWithMarketData(list: Array<OfferingBase | Offering>): Promise<{ offerings: Offering[]; ok: boolean }> {
  const toEnrich = list.filter((o) => o.status !== "withdrawn");
  const quotes = toEnrich.length ? await fetchMarketQuotes(toEnrich.map((o) => o.ticker)) : new Map<string, MarketQuote>();

  const offerings = list.map((o): Offering => {
    const q = o.status === "withdrawn" ? undefined : quotes.get(o.ticker.toUpperCase());
    if (!q) return finalize(o);
    const { price, volume, avgVolume, relVol, marketCapM, shortName, sharesOutstanding, exchange } = q;

    const priceChangePct = price && o.offerPrice
      ? +((((price - o.offerPrice) / o.offerPrice) * 100).toFixed(2))
      : null;

    let dilutionPct = o.dilutionPct;
    let sharesOutstandingAfter = o.sharesOutstandingAfter;
    let sharesOutstandingBefore = o.sharesOutstandingBefore;
    if (sharesOutstanding && o.sharesOffered && sharesOutstanding > o.sharesOffered) {
      sharesOutstandingAfter = sharesOutstanding;
      sharesOutstandingBefore = sharesOutstanding - o.sharesOffered;
      if (sharesOutstandingBefore > 0) dilutionPct = +((o.sharesOffered / sharesOutstandingBefore) * 100).toFixed(2);
    } else if (!sharesOutstandingAfter && marketCapM && price && price > 0) {
      sharesOutstandingAfter = Math.round((marketCapM * 1_000_000) / price);
      sharesOutstandingBefore = o.sharesOffered ? sharesOutstandingAfter - o.sharesOffered : null;
      if (sharesOutstandingBefore && sharesOutstandingBefore > 0 && o.sharesOffered) {
        dilutionPct = +((o.sharesOffered / sharesOutstandingBefore) * 100).toFixed(2);
      }
    }

    const company = shortName && shortName.length > 2 ? shortName : o.company;
    const status: Offering["status"] = o.status === "filed" ? "filed" : price ? "trading" : o.status;
    // S-1 from an already-listed company is a follow-on registration, not an IPO.
    const type: OfferingType = o.kind === "S-1" ? (price ? "Follow-on" : "IPO") : o.type;

    return finalize({
      ...o, company, type, currentPrice: price, priceChangePct,
      volume, avgVolume, relVol, marketCapM,
      sharesOutstandingBefore, sharesOutstandingAfter, dilutionPct,
      exchange: o.exchange ?? exchange,
      status,
      prevClose: q.prevClose ?? null,
    });
  });
  return { offerings, ok: toEnrich.length === 0 || quotes.size > 0 };
}

// ── Insider transactions (Form 4) ─────────────────────────────────────────────

export type InsiderTxn = {
  date: string;
  owner: string;
  title: string | null;
  code: string;
  shares: number;
  price: number | null;
  usd: number | null;
  acquired: boolean;
  plan: boolean;
  url: string;
};
export type InsiderSummary = {
  ticker: string;
  cik: string;
  company: string | null;
  windowDays: number;
  buys: { count: number; shares: number; usd: number };
  sells: { count: number; shares: number; usd: number };
  otherCount: number;
  netUsd: number;
  buyers: number;
  sellers: number;
  lastBuyDate: string | null;
  lastSellDate: string | null;
  planSellPct: number | null;
  filingsScanned: number;
  txns: InsiderTxn[];
};

let tickerCikMap: { map: Map<string, string>; ts: number } | null = null;
async function cikForTicker(ticker: string): Promise<string | null> {
  if (!tickerCikMap || Date.now() - tickerCikMap.ts > 24 * 3600_000) {
    try {
      const resp = await secFetch("https://www.sec.gov/files/company_tickers.json", 15000);
      if (resp.ok) {
        const data = await resp.json() as Record<string, { cik_str: number; ticker: string }>;
        const map = new Map<string, string>();
        for (const v of Object.values(data)) map.set(String(v.ticker).toUpperCase(), `CIK${String(v.cik_str).padStart(10, "0")}`);
        tickerCikMap = { map, ts: Date.now() };
      }
    } catch (e: any) {
      logger.warn({ error: e?.message }, "SEC company_tickers fetch failed");
    }
  }
  const t = ticker.toUpperCase();
  return tickerCikMap?.map.get(t) ?? tickerCikMap?.map.get(t.replace(".", "-")) ?? null;
}

function xmlVal(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return null;
  const inner = m[1];
  const v = inner.match(/<value>([\s\S]*?)<\/value>/i);
  return (v ? v[1] : inner).replace(/<[^>]+>/g, "").trim() || null;
}

function parseForm4(xml: string, url: string): InsiderTxn[] {
  const owner = xmlVal(xml, "rptOwnerName") ?? "—";
  const officerTitle = xmlVal(xml, "officerTitle");
  const isDirector = /<isDirector>\s*(1|true)\s*</i.test(xml);
  const isTen = /<isTenPercentOwner>\s*(1|true)\s*</i.test(xml);
  const title = officerTitle ?? (isDirector ? "Director" : isTen ? "10% owner" : null);
  const plan = /<aff10b5One>\s*(1|true)\s*</i.test(xml) || /10b5-1/i.test(xml);
  const out: InsiderTxn[] = [];
  const re = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const code = (xmlVal(b, "transactionCode") ?? "").toUpperCase();
    const shares = parseFloat(xmlVal(b, "transactionShares") ?? "");
    if (!code || !Number.isFinite(shares) || shares <= 0) continue;
    const priceRaw = parseFloat(xmlVal(b, "transactionPricePerShare") ?? "");
    const price = Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null;
    const ad = (xmlVal(b, "transactionAcquiredDisposedCode") ?? "").toUpperCase();
    out.push({
      date: (xmlVal(b, "transactionDate") ?? "").slice(0, 10),
      owner, title, code, shares,
      price, usd: price != null ? Math.round(price * shares) : null,
      acquired: ad === "A", plan, url,
    });
  }
  return out;
}

const insiderCache = new Map<string, { data: InsiderSummary; ts: number }>();
const INSIDER_TTL = 60 * 60_000;
const INSIDER_WINDOW_DAYS = 90;
const MAX_FORM4 = 12;

async function getInsiderSummary(ticker: string, cikPadded: string, subs: Submissions | null): Promise<InsiderSummary> {
  const key = ticker.toUpperCase();
  const hit = insiderCache.get(key);
  if (hit && Date.now() - hit.ts < INSIDER_TTL) return hit.data;

  const since = new Date(Date.now() - INSIDER_WINDOW_DAYS * 86400_000).toISOString().slice(0, 10);
  const recent = subs?.filings?.recent ?? {};
  const forms = recent.form ?? [];
  const docs: Array<{ adsh: string; file: string; date: string }> = [];
  for (let i = 0; i < forms.length && docs.length < MAX_FORM4; i++) {
    if (forms[i] !== "4") continue;
    const date = recent.filingDate?.[i] ?? "";
    if (date < since) break; // recent[] is newest-first
    const adsh = recent.accessionNumber?.[i];
    const raw = recent.primaryDocument?.[i];
    if (!adsh || !raw) continue;
    // primaryDocument points at the XSL-rendered view ("xslF345X05/form4.xml"); the raw XML sits next to it.
    docs.push({ adsh, file: raw.replace(/^xsl[^/]+\//i, ""), date });
  }

  const results = await mapLimit(docs, 4, async (d) => {
    const url = archiveUrl(cikPadded, d.adsh, d.file);
    const resp = await secFetch(url, 10000, "application/xml, text/xml, */*");
    if (!resp.ok) return [] as InsiderTxn[];
    return parseForm4(await resp.text(), url);
  });
  const txns = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .sort((a, b) => b.date.localeCompare(a.date));

  const buys = { count: 0, shares: 0, usd: 0 };
  const sells = { count: 0, shares: 0, usd: 0 };
  const buyerSet = new Set<string>();
  const sellerSet = new Set<string>();
  let otherCount = 0;
  let planSellUsd = 0;
  let lastBuyDate: string | null = null;
  let lastSellDate: string | null = null;
  for (const t of txns) {
    if (t.code === "P") {
      buys.count++; buys.shares += t.shares; buys.usd += t.usd ?? 0; buyerSet.add(t.owner);
      if (!lastBuyDate || t.date > lastBuyDate) lastBuyDate = t.date;
    } else if (t.code === "S") {
      sells.count++; sells.shares += t.shares; sells.usd += t.usd ?? 0; sellerSet.add(t.owner);
      if (t.plan) planSellUsd += t.usd ?? 0;
      if (!lastSellDate || t.date > lastSellDate) lastSellDate = t.date;
    } else {
      otherCount++;
    }
  }
  const data: InsiderSummary = {
    ticker: key, cik: cikPadded, company: subs?.name ?? null,
    windowDays: INSIDER_WINDOW_DAYS,
    buys, sells, otherCount,
    netUsd: buys.usd - sells.usd,
    buyers: buyerSet.size, sellers: sellerSet.size,
    lastBuyDate, lastSellDate,
    planSellPct: sells.usd > 0 ? Math.round((planSellUsd / sells.usd) * 100) : null,
    filingsScanned: docs.length,
    txns: txns.slice(0, 30),
  };
  if (insiderCache.size > 300) insiderCache.clear();
  insiderCache.set(key, { data, ts: Date.now() });
  return data;
}

// ── Route ─────────────────────────────────────────────────────────────────────

// Default day = New York trading date (audit P1-12), not the UTC date.
function todayNy(): string {
  return nyDate();
}

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

router.get("/offerings/watch", asyncHandler(async (req, res): Promise<void> => {
  const day = req.query.day
    ? String(req.query.day)
    : req.query.week
    ? String(req.query.week)
    : todayNy();

  // Validate: the value is interpolated into upstream URLs and cache keys.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(Date.parse(day + "T00:00:00Z"))) throw new AppError("INVALID_DATE");

  // Drop expired entries so the per-day cache doesn't grow unbounded.
  for (const [k, v] of cache) {
    if (Date.now() - v.ts >= CACHE_TTL) cache.delete(k);
  }

  const cacheKey = `offerings_day_${day}`;
  const cached = cache.get(cacheKey);
  const force = req.query.force === "1" && (!cached || Date.now() - cached.ts > 60_000);
  if (!force && cached && Date.now() - cached.ts < CACHE_TTL) {
    res.json(localizeOfferings(cached.data, langOf(req)));
    return;
  }

  try {
    // NASDAQ (month feed, filtered to the day) and EDGAR (D-1..D) in parallel
    const [nasdaqResult, edgarResult] = await Promise.all([
      fetchNasdaqIpo(day),
      fetchEdgarOfferings(day, new Set<string>()),
    ]);

    const { offerings: nasdaqOfferings, ipoTickers, calendar } = nasdaqResult;

    // Re-classify EDGAR items that are actually IPOs
    const edgarOfferings = edgarResult.offerings.map((o): OfferingBase =>
      ipoTickers.has(o.ticker) && o.kind !== "S-3" ? { ...o, type: "IPO", kind: o.kind === "424B" ? "IPO" : o.kind } : o,
    );

    // Merge: NASDAQ takes priority, EDGAR adds missing (but keeps its SEC link on the NASDAQ row)
    const edgarByTicker = new Map(edgarOfferings.map((o) => [o.ticker, o]));
    const nasdaqWithLinks = nasdaqOfferings.map((o) => {
      const e = edgarByTicker.get(o.ticker);
      return e ? { ...o, filingUrl: e.filingUrl, cik: e.cik, form: e.form ?? o.form } : o;
    });
    const nasdaqTickers = new Set(nasdaqOfferings.map((o) => o.ticker));
    const merged: Array<OfferingBase | Offering> = [...nasdaqWithLinks, ...edgarOfferings.filter((o) => !nasdaqTickers.has(o.ticker))];

    const { offerings: enriched, ok: yahooOk } = await enrichWithMarketData(merged);

    // Sort: highest dilution risk first, then rating
    enriched.sort((a, b) => b.dilutionRisk - a.dilutionRisk || b.rating - a.rating);

    // IPO calendar strip: a week back, three weeks ahead
    const from = new Date(Date.parse(day + "T12:00:00Z") - 7 * 86400_000).toISOString().slice(0, 10);
    const to = new Date(Date.parse(day + "T12:00:00Z") + 21 * 86400_000).toISOString().slice(0, 10);
    const ipoCalendar = calendar.filter((c) => c.date >= from && c.date <= to).slice(0, 80);

    // Timing / discount / reaction / cash (time-boxed; whatever misses the budget keeps warming the caches).
    const complete = await augmentOfferings(enriched, day, AUGMENT_BUDGET_MS);

    const payload = {
      day,
      fetchedAt: Date.now(),
      count: enriched.length,
      offerings: enriched,
      ipoCalendar,
      sources: { nasdaq: nasdaqResult.ok, edgar: edgarResult.ok, market: yahooOk },
      enrichment: { complete },
    };
    // An incomplete payload lives ~90 s so the next poll picks up the warmed caches.
    cache.set(cacheKey, { data: payload, ts: complete ? Date.now() : Date.now() - CACHE_TTL + 90_000 });
    res.json(localizeOfferings(payload, langOf(req)));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ day, error: msg }, "Offerings watch error");
    if (e instanceof AppError) throw e;
    throw new AppError("UPSTREAM_FAILED");
  }
}));

/**
 * GET /api/offerings/ticker/:ticker — dilution history (12m of S-1/S-3/424B/EFFECT/S-8)
 * and Form 4 insider summary (90d) for the detail sheet.
 */
const tickerCache = new Map<string, { data: unknown; ts: number }>();
const DILUTIVE_FORM_RE = /^(S-1|S-3|F-1|F-3|424B[1-8]|S-8|EFFECT)/i;

router.get("/offerings/ticker/:ticker", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  const ticker = String(req.params.ticker ?? "").trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) throw badRequest("INVALID_TICKER");

  const hit = tickerCache.get(ticker);
  if (hit && Date.now() - hit.ts < INSIDER_TTL) { res.json(hit.data); return; }

  const cik = await cikForTicker(ticker);
  if (!cik) throw new AppError("TICKER_NOT_IN_SEC");
  const subs = await getSubmissions(cik);
  if (!subs) throw new AppError("UPSTREAM_FAILED");

  const recent = subs.filings?.recent ?? {};
  const forms = recent.form ?? [];
  const yearAgo = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
  const threeYearsAgo = new Date(Date.now() - 3 * 365 * 86400_000).toISOString().slice(0, 10);
  const filings: Array<{ form: string; date: string; url: string | null; description: string | null }> = [];
  let offerings12m = 0;
  let lastShelfDate: string | null = null;
  let lastOfferingDate: string | null = null;
  let lastEffectDate: string | null = null;
  let atm12m = 0;
  for (let i = 0; i < forms.length; i++) {
    const form = forms[i] ?? "";
    const date = recent.filingDate?.[i] ?? "";
    if (!DILUTIVE_FORM_RE.test(form)) continue;
    if (date < threeYearsAgo) break;
    if (/^(S-3|F-3)/i.test(form) && !/\/A$/i.test(form) && !lastShelfDate) lastShelfDate = date;
    if (/^EFFECT/i.test(form) && !lastEffectDate) lastEffectDate = date;
    if (date < yearAgo) continue;
    const desc = recent.primaryDocDescription?.[i] ?? null;
    if (/^424B/i.test(form)) {
      offerings12m++;
      if (!lastOfferingDate) lastOfferingDate = date;
      if (desc && /at[- ]the[- ]market|sales agreement|atm/i.test(desc)) atm12m++;
    }
    const adsh = recent.accessionNumber?.[i];
    const doc = recent.primaryDocument?.[i];
    if (filings.length < 40) {
      filings.push({ form, date, url: adsh && doc ? archiveUrl(cik, adsh, doc) : null, description: desc });
    }
  }

  let insiders: InsiderSummary | null = null;
  try { insiders = await getInsiderSummary(ticker, cik, subs); }
  catch (e: any) { logger.warn({ ticker, error: e?.message }, "insider summary failed"); }

  const data = {
    ticker,
    cik,
    company: subs.name ?? null,
    sic: subs.sicDescription ?? null,
    edgarUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cikNumber(cik)}&owner=include&count=40`,
    stats: {
      offerings12m,
      atm12m,
      lastShelfDate,
      lastOfferingDate,
      lastEffectDate,
      /** Shelf registered within 3 years (S-3 shelves stay usable for 3 years). */
      activeShelf: !!lastShelfDate,
      serialDiluter: offerings12m >= 3,
    },
    filings,
    insiders,
  };
  if (tickerCache.size > 300) tickerCache.clear();
  tickerCache.set(ticker, { data, ts: Date.now() });
  res.json(data);
}));

/** GET /api/offerings/insiders?tickers=A,B,C — compact Form 4 summaries (max 8 tickers). */
router.get("/offerings/insiders", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  const tickers = Array.from(new Set(String(req.query.tickers ?? "")
    .split(",").map((t) => t.trim().toUpperCase()).filter((t) => TICKER_RE.test(t)))).slice(0, 8);
  if (!tickers.length) throw new AppError("FIELD_REQUIRED", undefined, { field: "tickers" });

  const results = await mapLimit(tickers, 2, async (t) => {
    const cik = await cikForTicker(t);
    if (!cik) return null;
    const subs = await getSubmissions(cik);
    const s = await getInsiderSummary(t, cik, subs);
    return { ...s, txns: s.txns.slice(0, 5) };
  });
  const items: InsiderSummary[] = [];
  const missing: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) items.push(r.value);
    else missing.push(tickers[i]);
  });
  res.json({ fetchedAt: Date.now(), items, missing });
}));

// ══ Intraday-trader layer (Wave I): timing, discount, reaction, history, my stats, IPO/lock-up ══

// ── Yahoo gate: ≤2 in flight, ≥250 ms between starts, 2 min cooldown after 429 / a burst of failures ──
let yInFlight = 0;
let yNextStart = 0;
let yCooldownUntil = 0;
let yFailStreak = 0;
const yQueue: Array<() => void> = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function yahooCooling(): boolean {
  return Date.now() < yCooldownUntil;
}
function yahooFailed(status?: number): void {
  yFailStreak++;
  if (status === 429 || yFailStreak >= 6) {
    yCooldownUntil = Date.now() + 2 * 60_000;
    yFailStreak = 0;
    logger.warn({ status }, "offerings: Yahoo cooldown 2m");
  }
}
async function viaYahoo<T>(fn: () => Promise<T | null>): Promise<T | null> {
  if (yahooCooling()) return null;
  while (yInFlight >= 2) await new Promise<void>((r) => yQueue.push(r));
  yInFlight++;
  try {
    const now = Date.now();
    const start = Math.max(now, yNextStart);
    yNextStart = start + 250;
    if (start > now) await sleep(start - now);
    if (yahooCooling()) return null;
    const out = await fn();
    if (out == null) yahooFailed(); else yFailStreak = 0;
    return out;
  } finally {
    yInFlight--;
    yQueue.shift()?.();
  }
}

/** Resolve `p`, or `fallback` once `ms` passes (p keeps running and fills caches). */
function withBudget<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => fallback)]);
}

// ── DB cache (survives API restarts): offering_ticker_cache(ticker, kind) ──
let ensureCachePromise: Promise<void> | null = null;
function ensureOfferingCache(): Promise<void> {
  if (!ensureCachePromise) {
    ensureCachePromise = pool.query(
      `CREATE TABLE IF NOT EXISTS offering_ticker_cache (
         ticker TEXT NOT NULL,
         kind TEXT NOT NULL,
         payload JSONB NOT NULL,
         fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (ticker, kind)
       )`,
    ).then(() => undefined).catch((e) => { ensureCachePromise = null; throw e; });
  }
  return ensureCachePromise;
}
async function dbCacheRead<T>(kind: string, tickers: string[], ttlMs: number): Promise<Map<string, { data: T; ts: number }>> {
  const out = new Map<string, { data: T; ts: number }>();
  if (!tickers.length) return out;
  try {
    await ensureOfferingCache();
    const { rows } = await pool.query<{ ticker: string; payload: T; fetched_at: Date }>(
      `SELECT ticker, payload, fetched_at FROM offering_ticker_cache WHERE kind = $1 AND ticker = ANY($2::text[])`,
      [kind, tickers],
    );
    for (const r of rows) {
      const ts = new Date(r.fetched_at).getTime();
      if (Date.now() - ts < ttlMs) out.set(r.ticker, { data: r.payload, ts });
    }
  } catch (e: any) {
    logger.warn({ kind, error: e?.message }, "offering cache read failed");
  }
  return out;
}
async function dbCacheWrite(kind: string, ticker: string, data: unknown): Promise<void> {
  try {
    await ensureOfferingCache();
    await pool.query(
      `INSERT INTO offering_ticker_cache (ticker, kind, payload, fetched_at) VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (ticker, kind) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = NOW()`,
      [ticker, kind, JSON.stringify(data)],
    );
  } catch (e: any) {
    logger.warn({ kind, ticker, error: e?.message }, "offering cache write failed");
  }
}

// ── Fundamentals: float, cash, burn (Yahoo quoteSummary), 12 h ──
export type FundLite = {
  floatShares: number | null;
  sharesOutstanding: number | null;
  shortPctFloat: number | null;
  cashM: number | null;
  burnM: number | null;
  runwayMonths: number | null;
  fetchedAt: number;
};
const FUND_TTL = 12 * 3600_000;
const fundMem = new Map<string, { data: FundLite | null; ts: number }>();

async function fetchFundLite(ticker: string): Promise<FundLite | null> {
  return viaYahoo(async () => {
    const resp = await fetchYahooWithSession((s) =>
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=defaultKeyStatistics,financialData&crumb=${encodeURIComponent(s.crumb)}`,
    );
    if (!resp) return null;
    if (resp.status === 429) { yahooFailed(429); return null; }
    if (resp.status === 404) return { floatShares: null, sharesOutstanding: null, shortPctFloat: null, cashM: null, burnM: null, runwayMonths: null, fetchedAt: Date.now() };
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const r = data?.quoteSummary?.result?.[0] ?? {};
    const ks = r.defaultKeyStatistics ?? {};
    const fd = r.financialData ?? {};
    const cash: number | null = fd.totalCash?.raw ?? null;
    const opcf: number | null = fd.operatingCashflow?.raw ?? null;
    const cashM = cash != null ? +(cash / 1e6).toFixed(1) : null;
    const burnM = opcf != null ? (opcf < 0 ? +((-opcf / 12) / 1e6).toFixed(2) : 0) : null;
    return {
      floatShares: ks.floatShares?.raw ?? null,
      sharesOutstanding: ks.sharesOutstanding?.raw ?? null,
      shortPctFloat: ks.shortPercentOfFloat?.raw != null ? +(ks.shortPercentOfFloat.raw * 100).toFixed(1) : null,
      cashM,
      burnM,
      runwayMonths: cashM != null && burnM ? +(cashM / burnM).toFixed(1) : null,
      fetchedAt: Date.now(),
    };
  });
}

async function getFundLite(tickers: string[]): Promise<Map<string, FundLite>> {
  const out = new Map<string, FundLite>();
  const need: string[] = [];
  for (const t of tickers) {
    const hit = fundMem.get(t);
    if (hit && Date.now() - hit.ts < FUND_TTL) { if (hit.data) out.set(t, hit.data); }
    else need.push(t);
  }
  if (!need.length) return out;
  const fromDb = await dbCacheRead<FundLite>("fund", need, FUND_TTL);
  const fetchList: string[] = [];
  for (const t of need) {
    const hit = fromDb.get(t);
    if (hit) { fundMem.set(t, { data: hit.data, ts: hit.ts }); out.set(t, hit.data); }
    else fetchList.push(t);
  }
  await mapLimit(fetchList, 2, async (t) => {
    const f = await fetchFundLite(t);
    if (!f) return;
    if (fundMem.size > 800) fundMem.clear();
    fundMem.set(t, { data: f, ts: Date.now() });
    out.set(t, f);
    void dbCacheWrite("fund", t, f);
  });
  return out;
}

// ── Daily bars (≈3 y), via fetchDailyRange + the gate, 12 h memory (5 min when today's bar is in) ──
const barsMem = new Map<string, { bars: Bar[]; from: string; ts: number }>();
const BARS_TTL = 12 * 3600_000;
const BARS_TODAY_TTL = 5 * 60_000;

async function getBars(ticker: string, from: string): Promise<Bar[] | null> {
  const today = nyDate();
  const hit = barsMem.get(ticker);
  if (hit && hit.from <= from && Date.now() - hit.ts < (hit.bars.at(-1)?.d === today ? BARS_TODAY_TTL : BARS_TTL)) return hit.bars;
  const candles = await viaYahoo(() => fetchDailyRange(ticker, from, today));
  if (!candles) return hit?.bars ?? null;
  const bars = barsFromCandles(candles);
  if (barsMem.size > 400) barsMem.clear();
  barsMem.set(ticker, { bars, from, ts: Date.now() });
  return bars;
}

function adshFromUrl(url: string | null | undefined): string | null {
  const m = String(url ?? "").match(/\/data\/\d+\/(\d{18})\//);
  return m ? m[1] : null;
}
function shiftDay(d: string, n: number): string {
  return new Date(Date.parse(d + "T12:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
}

/**
 * Adds acceptance time / session / reaction day, prior offerings (12m), prev close + discount,
 * the reaction-day move and cash/float to each offering — in place. Returns true when every
 * lookup finished inside the budget (the rest keeps running and warms the caches).
 */
const AUGMENT_BUDGET_MS = 6000;
/** Offer vs the last close. Outside −70%…+25% the parsed offer price is almost surely wrong (warrant / pre-split price). */
function setDiscount(o: Offering): void {
  if (o.offerPrice == null || !o.prevClose) { o.discountPct = null; return; }
  const d = ((o.offerPrice / o.prevClose) - 1) * 100;
  o.discountPct = d >= -70 && d <= 25 ? +d.toFixed(2) : null;
}
async function augmentOfferings(list: Offering[], day: string, budgetMs: number): Promise<boolean> {
  const today = nyDate();
  const yearAgo = shiftDay(day, -365);

  // IPO rows: priced in the evening, trade the next session.
  for (const o of list) {
    if (o.kind === "IPO" && o.source === "nasdaq") {
      o.reactionDate = o.status === "priced" || o.status === "trading" ? nextWeekday(o.date) : o.status === "upcoming" ? rollToWeekday(o.date) : null;
    }
  }

  // 1) SEC timing + frequency (submissions are cached 30 min).
  const secJobs = list.filter((o) => o.source === "edgar" && o.cik && o.kind !== "S-3").slice(0, 45);
  const secWork = mapLimit(secJobs, 4, async (o) => {
    const subs = await getSubmissions(o.cik!);
    const recent = subs?.filings?.recent;
    if (!recent) return;
    const adsh = adshFromUrl(o.filingUrl);
    const idx = adsh ? (recent.accessionNumber ?? []).findIndex((a) => a.replace(/-/g, "") === adsh) : -1;
    const t = reactionDayFor(o.date, idx >= 0 ? recent.acceptanceDateTime?.[idx] : null);
    o.acceptedAt = t.acceptedAt;
    o.session = t.session;
    o.reactionDate = o.status === "filed" ? null : t.day;
    const thisDay = o.reactionDate;
    o.priorOfferings12m = filingEvents(recent, yearAgo)
      .filter((e) => e.reactionDay && e.reactionDay !== thisDay && e.filingDate <= o.date).length;
  });

  // 2) Fundamentals for traded names (dilution context: float, cash runway).
  const fundTickers = Array.from(new Set(list.filter((o) => o.status !== "withdrawn" && o.currentPrice != null).map((o) => o.ticker))).slice(0, 40);
  const fundWork = getFundLite(fundTickers).then((m) => {
    for (const o of list) {
      const f = m.get(o.ticker);
      if (!f) continue;
      o.floatShares = f.floatShares; o.cashM = f.cashM; o.burnM = f.burnM; o.runwayMonths = f.runwayMonths; o.shortPctFloat = f.shortPctFloat;
    }
  });

  // 3) Prev close / discount / reaction (needs the reaction day → after SEC timing).
  const barsWork = secWork.then(async () => {
    const traded = list.filter((o) => o.currentPrice != null && o.status !== "filed");
    // Quote-based guess first so a budget miss still shows a discount for today's deals.
    for (const o of traded) {
      const rd = o.reactionDate ?? rollToWeekday(o.date);
      if (o.kind === "IPO") { o.prevClose = null; continue; }
      if (rd > today) o.prevClose = o.currentPrice;
      else if (rd !== today) o.prevClose = null; // quote prev close belongs to today only
      setDiscount(o);
    }
    await mapLimit(traded.filter((o) => (o.reactionDate ?? o.date) <= today), 2, async (o) => {
      const rd = o.reactionDate ?? rollToWeekday(o.date);
      const bars = await getBars(o.ticker, shiftDay(rd, -45));
      if (!bars) return;
      if (o.kind === "IPO") {
        // First session vs the IPO price: no prior close, no discount.
        const i = barIndexOnOrAfter(bars, rd);
        if (i < 0 || !o.offerPrice) return;
        const b = bars[i];
        const pct = (x: number, base: number) => +(((x / base) - 1) * 100).toFixed(2);
        o.prevClose = null;
        o.discountPct = null;
        o.reaction = { gapPct: pct(b.o, o.offerPrice), o2cPct: pct(b.c, b.o), dayPct: pct(b.c, o.offerPrice), lowFromOpenPct: pct(b.l, b.o), highFromOpenPct: pct(b.h, b.o), relVol: null, live: b.d === today };
        return;
      }
      const r = reactionOn(bars, rd);
      if (!r) return;
      o.prevClose = r.prevClose;
      o.reaction = { gapPct: r.gapPct, o2cPct: r.o2cPct, dayPct: r.dayPct, lowFromOpenPct: r.lowFromOpenPct, highFromOpenPct: r.highFromOpenPct, relVol: r.relVol, live: r.day === today };
      setDiscount(o);
    });
  });

  const all = Promise.allSettled([secWork, fundWork, barsWork]).then(() => true);
  return withBudget(all, budgetMs, false);
}

// ── GET /offerings/history/:ticker — 3 y timeline + reaction per priced takedown ──
type HistoryEvent = FilingEvent & { url: string | null; reaction: Reaction | null };
type HistoryPayload = {
  ticker: string;
  cik: string;
  company: string | null;
  fetchedAt: number;
  events: HistoryEvent[];
  summary: ReturnType<typeof summarize>;
  stats: { priced12m: number; priced36m: number; atm12m: number; lastShelfDate: string | null; activeShelf: boolean; lastPricedDate: string | null; wksi: boolean };
  fundamentals: FundLite | null;
  barsOk: boolean;
};
const HISTORY_TTL = 12 * 3600_000;
const historyMem = new Map<string, { data: HistoryPayload; ts: number }>();

async function buildHistory(ticker: string): Promise<HistoryPayload | { error: "TICKER_NOT_IN_SEC" | "UPSTREAM_FAILED"; status: number }> {
  const cik = await cikForTicker(ticker);
  if (!cik) return { error: "TICKER_NOT_IN_SEC", status: 404 };
  const subs = await getSubmissions(cik);
  if (!subs) return { error: "UPSTREAM_FAILED", status: 502 };
  const today = nyDate();
  const since = shiftDay(today, -3 * 365);
  const yearAgo = shiftDay(today, -365);
  const events = filingEvents(subs.filings?.recent, since);
  const days = offeringDays(events);

  let bars: Bar[] | null = null;
  if (days.length) bars = await getBars(ticker, shiftDay(days[0], -45));
  const withReaction: HistoryEvent[] = events.map((e) => ({
    ...e,
    url: e.adsh && e.doc ? archiveUrl(cik, e.adsh, e.doc) : null,
    reaction: e.reactionDay && bars ? reactionOn(bars, e.reactionDay) : null,
  }));
  const reactions = withReaction.map((e) => e.reaction).filter((r): r is Reaction => !!r && r.day < today);
  const priced = withReaction.filter((e) => e.reactionDay);
  const lastShelf = withReaction.find((e) => e.kind === "shelf" && !/\/A$/i.test(e.form));
  const fund = (await getFundLite([ticker])).get(ticker) ?? null;
  return {
    ticker, cik,
    company: subs.name ?? null,
    fetchedAt: Date.now(),
    events: withReaction.slice(0, 60),
    summary: summarize(reactions),
    stats: {
      priced12m: priced.filter((e) => e.filingDate >= yearAgo).length,
      priced36m: priced.length,
      atm12m: priced.filter((e) => e.kind === "atm" && e.filingDate >= yearAgo).length,
      lastShelfDate: lastShelf?.filingDate ?? null,
      activeShelf: !!lastShelf,
      lastPricedDate: priced[0]?.filingDate ?? null,
      wksi: isWksi(subs.filings?.recent, since),
    },
    fundamentals: fund,
    barsOk: !days.length || !!bars,
  };
}

router.get("/offerings/history/:ticker", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  const ticker = String(req.params.ticker ?? "").trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) throw badRequest("INVALID_TICKER");

  const mem = historyMem.get(ticker);
  if (mem && Date.now() - mem.ts < HISTORY_TTL) { res.json(mem.data); return; }
  const db = (await dbCacheRead<HistoryPayload>("history", [ticker], HISTORY_TTL)).get(ticker);
  if (db && db.data.barsOk) { historyMem.set(ticker, db); res.json(db.data); return; }

  const built = await buildHistory(ticker);
  if ("error" in built) throw new AppError(built.error, built.status);
  if (built.barsOk) {
    if (historyMem.size > 300) historyMem.clear();
    historyMem.set(ticker, { data: built, ts: Date.now() });
    void dbCacheWrite("history", ticker, built);
  }
  res.json(built);
}));

// ── GET /offerings/my-stats?trader=&window=0|1 — trader's net / WR on offering days vs normal days ──
/** Priced takedown days of one ticker; `wksi` = automatic-shelf issuer (its 424B5s are mostly notes). */
type TickerDays = { wksi: boolean; days: { d: string; f: string }[] };
const EVENTS_KIND = "events2";
const EVENTS_TTL = 24 * 3600_000;
const eventsMem = new Map<string, { data: TickerDays; ts: number }>();
const MY_STATS_SEC_PER_CALL = 40;

async function tickerOfferingDays(ticker: string): Promise<TickerDays | null> {
  const cik = await cikForTicker(ticker);
  if (!cik) return { wksi: false, days: [] };
  const subs = await getSubmissions(cik);
  if (!subs) return null;
  const recent = subs.filings?.recent;
  return {
    wksi: isWksi(recent, shiftDay(nyDate(), -3 * 365)),
    days: filingEvents(recent, shiftDay(nyDate(), -2 * 365))
      .filter((e) => e.reactionDay && PRICED_FORM_RE.test(e.form))
      .map((e) => ({ d: e.reactionDay!, f: e.kind === "atm" ? "ATM" : e.form.toUpperCase() })),
  };
}

const MEGA_CAP_M = 30_000;
const capMem = new Map<string, { capM: number | null; ts: number }>();
async function megaCapMap(tickers: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const need = tickers.filter((t) => {
    const hit = capMem.get(t);
    if (hit && Date.now() - hit.ts < 24 * 3600_000) { if (hit.capM != null) out.set(t, hit.capM); return false; }
    return true;
  });
  if (need.length) {
    const quotes = await withBudget(fetchMarketQuotes(need), 6000, new Map<string, MarketQuote>());
    for (const t of need) {
      const capM = quotes.get(t)?.marketCapM ?? null;
      if (quotes.size) capMem.set(t, { capM, ts: Date.now() });
      if (capM != null) out.set(t, capM);
    }
  }
  return out;
}

router.get("/offerings/my-stats", asyncHandler(async (req, res): Promise<void> => {
  const scope = await resolveTraderParam(req, "trades.read.team", req.query.trader);
  if (!scope.ok) throw scope.appError;
  const trader = scope.trader;
  if (!trader) throw badRequest("TRADER_REQUIRED");
  const window: 0 | 1 = req.query.window === "1" ? 1 : 0;
  const includeWksi = req.query.wksi === "1";

  const { rows } = await pool.query<{ id: number; ticker: string; date: string; pnl: unknown; fees: unknown; result: unknown }>(
    `SELECT t.id, UPPER(TRIM(t.ticker)) AS ticker, LEFT(t.date, 10) AS date, t.pnl, t.fees, t.result
       FROM trades t
      WHERE t.trader = $1 AND t.deleted_at IS NULL AND t.ticker IS NOT NULL AND TRIM(t.ticker) <> ''
      ORDER BY t.date ASC, t.id ASC
      LIMIT 20000`,
    [trader],
  );
  const trades: TradeLite[] = rows.map((r) => ({
    id: Number(r.id), ticker: r.ticker, date: r.date,
    pnl: num(r.pnl), fees: num(r.fees), result: normResult(r.result),
  }));
  const tickers = Array.from(new Set(trades.map((t) => t.ticker))).filter((t) => TICKER_RE.test(t));

  // Offering days per ticker: memory → DB → SEC (bounded per call; the client polls while `pending` > 0).
  const days = new Map<string, TickerDays>();
  let need = tickers.filter((t) => {
    const hit = eventsMem.get(t);
    if (hit && Date.now() - hit.ts < EVENTS_TTL) { days.set(t, hit.data); return false; }
    return true;
  });
  if (need.length) {
    const fromDb = await dbCacheRead<TickerDays>(EVENTS_KIND, need, EVENTS_TTL);
    for (const [t, v] of fromDb) { days.set(t, v.data); eventsMem.set(t, v); }
    need = need.filter((t) => !fromDb.has(t));
  }
  await withBudget(mapLimit(need.slice(0, MY_STATS_SEC_PER_CALL), 4, async (t) => {
    const d = await tickerOfferingDays(t);
    if (d == null) return;
    if (eventsMem.size > 2000) eventsMem.clear();
    eventsMem.set(t, { data: d, ts: Date.now() });
    days.set(t, d);
    void dbCacheWrite(EVENTS_KIND, t, d);
  }), 12_000, []);

  const daysByTicker = new Map<string, string[]>();
  const formByKey = new Map<string, string>();
  // Large automatic-shelf issuers (≥ $30B): their 424B5 days are notes, not dilution. Smaller WKSI names
  // (converts / ATMs of $1–30B growth names) stay in. Without quotes every WKSI name is left out.
  const wksiCandidates = includeWksi ? [] : Array.from(days).filter(([, v]) => v.wksi && v.days.length).map(([t]) => t);
  const caps = await megaCapMap(wksiCandidates);
  const wksiTickers: string[] = [];
  for (const [t, v] of days) {
    if (v.wksi && !includeWksi && v.days.length && (caps.get(t) ?? Infinity) >= MEGA_CAP_M) { wksiTickers.push(t); continue; }
    daysByTicker.set(t, v.days.map((x) => x.d));
    for (const x of v.days) formByKey.set(`${t}|${x.d}`, x.f);
  }
  const covered = new Set(days.keys());
  const coveredTrades = trades.filter((t) => covered.has(t.ticker));
  const split = splitByOfferingDays(coveredTrades, daysByTicker, window);
  const dayOf = (t: TradeLite) => split.matched.get(String(t.id)) ?? t.date;

  // Breakdown by form and by ticker.
  const byForm = new Map<string, TradeLite[]>();
  const byTicker = new Map<string, TradeLite[]>();
  for (const t of split.offeringTrades) {
    const f = formByKey.get(`${t.ticker}|${dayOf(t)}`) ?? "424B";
    byForm.set(f, [...(byForm.get(f) ?? []), t]);
    byTicker.set(t.ticker, [...(byTicker.get(t.ticker) ?? []), t]);
  }
  const agg = (list: TradeLite[]) => splitByOfferingDays(list, new Map(), 0).normal;
  const traded: Record<string, { trades: number; net: number; lastDate: string }> = {};
  for (const t of trades) {
    const x = traded[t.ticker] ?? { trades: 0, net: 0, lastDate: t.date };
    x.trades++;
    if (t.pnl != null && t.result !== "open") x.net = +(x.net + t.pnl - Math.abs(t.fees ?? 0)).toFixed(2);
    if (t.date > x.lastDate) x.lastDate = t.date;
    traded[t.ticker] = x;
  }

  res.json({
    trader,
    window,
    fetchedAt: Date.now(),
    coverage: { tickers: tickers.length, covered: covered.size, pending: Math.max(0, tickers.length - covered.size), trades: trades.length, coveredTrades: coveredTrades.length },
    /** Large automatic-shelf issuers left out (their 424B5 days are mostly debt), unless ?wksi=1. */
    excludedWksi: includeWksi ? [] : wksiTickers.sort(),
    offering: split.offering,
    normal: split.normal,
    byForm: Array.from(byForm, ([form, list]) => ({ form, ...agg(list) })).sort((a, b) => b.trades - a.trades),
    byTicker: Array.from(byTicker, ([ticker, list]) => ({
      ticker, ...agg(list),
      days: Array.from(new Set(list.map(dayOf))).sort().reverse(),
    })).sort((a, b) => b.trades - a.trades).slice(0, 40),
    recent: split.offeringTrades.slice(-40).reverse().map((t) => ({
      id: t.id, ticker: t.ticker, date: t.date,
      net: t.pnl == null ? null : +(t.pnl - Math.abs(t.fees ?? 0)).toFixed(2),
      result: t.result,
      offeringDay: dayOf(t),
      form: formByKey.get(`${t.ticker}|${dayOf(t)}`) ?? null,
    })),
    traded,
  });
}));

// ── GET /offerings/ipo-calendar — upcoming IPOs, recent IPOs, lock-up expirations (IPO + 180 d) ──
type IpoRow = {
  ticker: string; company: string; date: string; status: "upcoming" | "priced" | "filed" | "withdrawn";
  offerPrice: number | null; priceRange: string | null; sharesOffered: number | null; dealSizeM: number | null;
  exchange: string | null; underwriter: string | null;
};
const ipoMonthMem = new Map<string, { rows: IpoRow[]; ok: boolean; ts: number }>();
const LOCKUP_DAYS = 180;

async function nasdaqMonth(ym: string): Promise<{ rows: IpoRow[]; ok: boolean }> {
  const ttl = ym < nyDate().slice(0, 7) ? 24 * 3600_000 : 6 * 3600_000;
  const hit = ipoMonthMem.get(ym);
  if (hit && hit.ok && Date.now() - hit.ts < ttl) return hit;
  try {
    const resp = await fetch(`https://api.nasdaq.com/api/ipo/calendar?date=${ym}`, { headers: NASDAQ_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return hit ?? { rows: [], ok: false };
    const data = await resp.json() as any;
    const rows: IpoRow[] = [];
    const push = (r: any, status: IpoRow["status"], dateRaw: unknown) => {
      const ticker = String(r.proposedTickerSymbol ?? r.symbol ?? "").trim().toUpperCase();
      const date = normalizeDate(dateRaw == null ? null : String(dateRaw), "");
      if (!ticker || !date) return;
      const sharesOffered = parseShares(r.sharesOffered);
      const offerPrice = status === "withdrawn" ? null : parseDollar(r.proposedSharePrice ?? r.priceRange);
      rows.push({
        ticker, company: String(r.companyName ?? ticker), date, status,
        offerPrice,
        priceRange: r.proposedSharePrice ? String(r.proposedSharePrice) : null,
        sharesOffered,
        dealSizeM: r.dollarValueOfSharesOffered ? parseMillions(r.dollarValueOfSharesOffered)
          : sharesOffered && offerPrice ? +((sharesOffered * offerPrice) / 1e6).toFixed(1) : null,
        exchange: r.proposedExchange ?? null,
        underwriter: r.leadUnderwriter ?? r.underwriter ?? null,
      });
    };
    for (const r of data?.data?.upcoming?.upcomingTable?.rows ?? []) push(r, "upcoming", r.expectedPriceDate ?? r.ipoDate);
    for (const r of data?.data?.priced?.rows ?? []) push(r, "priced", r.pricedDate);
    for (const r of data?.data?.withdrawn?.rows ?? []) push(r, "withdrawn", r.withdrawDate);
    const out = { rows, ok: true, ts: Date.now() };
    ipoMonthMem.set(ym, out);
    return out;
  } catch (e: any) {
    logger.warn({ ym, error: e?.message }, "NASDAQ IPO month fetch failed");
    return hit ?? { rows: [], ok: false };
  }
}

let ipoCalCache: { data: unknown; ts: number } | null = null;
router.get("/offerings/ipo-calendar", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  if (ipoCalCache && Date.now() - ipoCalCache.ts < CACHE_TTL) { res.json(ipoCalCache.data); return; }
  const today = nyDate();
  const months: string[] = [];
  const lastYm = shiftDay(today, 31).slice(0, 7);
  for (let d = shiftDay(today, -(LOCKUP_DAYS + 20)); d.slice(0, 7) <= lastYm; d = shiftDay(d.slice(0, 7) + "-01", 32)) {
    if (!months.includes(d.slice(0, 7))) months.push(d.slice(0, 7));
  }
  const results = await mapLimit(months, 3, (ym) => nasdaqMonth(ym));
  const rows = results.flatMap((r) => (r.status === "fulfilled" ? r.value.rows : []));
  const ok = results.some((r) => r.status === "fulfilled" && r.value.ok);

  const seen = new Set<string>();
  const priced = rows.filter((r) => r.status === "priced" && !seen.has(r.ticker) && !!seen.add(r.ticker));
  const upcoming = rows.filter((r) => r.status === "upcoming" && r.date >= shiftDay(today, -3)).sort((a, b) => a.date.localeCompare(b.date));
  const recent = priced.filter((r) => r.date >= shiftDay(today, -30) && r.date <= today).sort((a, b) => b.date.localeCompare(a.date));
  const isSpac = (r: IpoRow) => /acquisition|blank check|\bspac\b|capital corp/i.test(r.company) || (/U$/.test(r.ticker) && r.offerPrice === 10);
  const lockups = priced
    .filter((r) => !isSpac(r))
    .map((r) => ({ ...r, lockupDate: rollToWeekday(shiftDay(r.date, LOCKUP_DAYS)) }))
    .filter((r) => r.lockupDate >= shiftDay(today, -7) && r.lockupDate <= shiftDay(today, 45))
    .sort((a, b) => a.lockupDate.localeCompare(b.lockupDate));

  const quotes = await withBudget(
    fetchMarketQuotes(Array.from(new Set([...recent, ...lockups].map((r) => r.ticker)))),
    8000, new Map<string, MarketQuote>(),
  );
  const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400_000);
  const withQuote = <T extends IpoRow>(r: T) => {
    const q = quotes.get(r.ticker);
    const price = q?.price ?? null;
    return {
      ...r,
      currentPrice: price,
      pctFromIpo: price != null && r.offerPrice ? +(((price / r.offerPrice) - 1) * 100).toFixed(1) : null,
      marketCapM: q?.marketCapM != null ? +q.marketCapM.toFixed(1) : null,
      avgVolume: q?.avgVolume ?? null,
      sharesOutstanding: q?.sharesOutstanding ?? null,
    };
  };
  const data = {
    fetchedAt: Date.now(),
    today,
    lockupDays: LOCKUP_DAYS,
    upcoming: upcoming.slice(0, 60),
    recent: recent.slice(0, 40).map((r) => ({ ...withQuote(r), spac: isSpac(r) })),
    lockups: lockups.slice(0, 60).map((r) => {
      const x = withQuote(r);
      return {
        ...x,
        daysLeft: daysBetween(today, r.lockupDate),
        /** Locked shares relative to the IPO float (rough: (outstanding − offered) / offered). */
        unlockMultiple: x.sharesOutstanding && r.sharesOffered && x.sharesOutstanding > r.sharesOffered
          ? +((x.sharesOutstanding - r.sharesOffered) / r.sharesOffered).toFixed(1) : null,
      };
    }),
    sources: { nasdaq: ok, market: quotes.size > 0 },
  };
  if (ok) ipoCalCache = { data, ts: Date.now() };
  res.json(data);
}));

export default router;
