import type { Tone } from "@/components/ds";
import { fmtDate, fmtDateCustom, fmtPct, fmtPrice, fmtRelative, fmtUsd, type DateStyle } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { offeringsI18n } from "@/i18n/ns/offerings";

/** Record whose values are read from the dictionary at access time (never frozen at import). */
function liveRecord<K extends string>(keys: readonly K[], label: (k: K) => string): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const k of keys) Object.defineProperty(out, k, { get: () => label(k), enumerable: true });
  return out;
}

export type OfferingType = "IPO" | "Follow-on" | "ATM" | "Bought Deal" | "SPAC" | "Shelf" | "Other";
export type SellerType = "company" | "insiders" | "mixed" | "unknown";
export type OfferingStatus = "upcoming" | "priced" | "trading" | "withdrawn" | "filed";
export type FilingKind = "IPO" | "424B" | "ATM" | "S-3" | "S-1";
export type RiskLevel = "high" | "medium" | "low";

export interface Offering {
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
  status: OfferingStatus;
  source: "nasdaq" | "edgar";
  // Added by the dilution dashboard API. Optional so an older server build still renders.
  kind?: FilingKind;
  form?: string | null;
  filingUrl?: string | null;
  cik?: string | null;
  exchange?: string | null;
  priceRange?: string | null;
  shelfCapacityM?: number | null;
  babyShelf?: boolean;
  babyShelfLimitM?: number | null;
  offerPctOfMcap?: number | null;
  dealFlags?: string[];
  dilutionRisk?: number;
  riskLevel?: RiskLevel;
  riskFactors?: string[];
  // Intraday fields (server augmentOfferings). Optional: an older server build simply omits them.
  /** SEC acceptance, New York wall clock ("2026-10-15 16:31"). */
  acceptedAt?: string | null;
  session?: "pre" | "rth" | "post" | null;
  /** First session that trades the deal (after-close acceptance → next weekday). */
  reactionDate?: string | null;
  /** Priced takedowns in the 12 months before this one. */
  priorOfferings12m?: number | null;
  /** Close before the reaction session; discount = offer / prevClose − 1. */
  prevClose?: number | null;
  discountPct?: number | null;
  reaction?: {
    gapPct: number; o2cPct: number; dayPct: number; lowFromOpenPct: number; highFromOpenPct: number;
    relVol: number | null; live: boolean;
  } | null;
  floatShares?: number | null;
  cashM?: number | null;
  /** Monthly operating cash burn, $M (0 = cash-flow positive). */
  burnM?: number | null;
  runwayMonths?: number | null;
  shortPctFloat?: number | null;
  /** Client-only: opened from insiders / deep link with no filing that day (show SEC history only). */
  stub?: boolean;
}

export interface IpoCalendarItem {
  ticker: string;
  company: string;
  date: string;
  status: "upcoming" | "priced" | "filed" | "withdrawn";
  priceRange: string | null;
  offerPrice: number | null;
  sharesOffered: number | null;
  dealSizeM: number | null;
  exchange: string | null;
}

export interface OfferingsResponse {
  day: string;
  fetchedAt: number;
  count: number;
  offerings: Offering[];
  ipoCalendar?: IpoCalendarItem[];
  sources?: { nasdaq: boolean; edgar: boolean; market: boolean };
  /** false while the server is still filling timing / reaction / fundamentals (refetch a bit later). */
  enrichment?: { complete: boolean };
}

// ── GET /offerings/history/:ticker ──
export type TimelineKind = "priced" | "atm" | "shelf" | "s1" | "effect";
export interface DailyReaction {
  day: string;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  close: number;
  gapPct: number;
  o2cPct: number;
  dayPct: number;
  lowFromOpenPct: number;
  highFromOpenPct: number;
  nextDayPct: number | null;
  relVol: number | null;
}
export interface ReactionSummary {
  n: number;
  avgGap: number | null;
  medianGap: number | null;
  avgO2c: number | null;
  avgDay: number | null;
  redShare: number | null;
  avgLowFromOpen: number | null;
  avgHighFromOpen: number | null;
  avgNextDay: number | null;
}
export interface HistoryEvent {
  form: string;
  kind: TimelineKind;
  filingDate: string;
  acceptedAt: string | null;
  session: "pre" | "rth" | "post" | null;
  reactionDay: string | null;
  url: string | null;
  description: string | null;
  reaction: DailyReaction | null;
}
export interface Fundamentals {
  floatShares: number | null;
  sharesOutstanding: number | null;
  shortPctFloat: number | null;
  cashM: number | null;
  burnM: number | null;
  runwayMonths: number | null;
  fetchedAt: number;
}
export interface TickerHistory {
  ticker: string;
  cik: string;
  company: string | null;
  fetchedAt: number;
  events: HistoryEvent[];
  summary: ReactionSummary;
  stats: { priced12m: number; priced36m: number; atm12m: number; lastShelfDate: string | null; activeShelf: boolean; lastPricedDate: string | null; wksi: boolean };
  fundamentals: Fundamentals | null;
  barsOk: boolean;
}

// ── GET /offerings/my-stats ──
export interface DayBucket {
  trades: number;
  decided: number;
  wins: number;
  losses: number;
  winRate: number | null;
  net: number;
  avgNet: number | null;
  best: number | null;
  worst: number | null;
  tickers: number;
}
export interface MyOfferingStats {
  trader: string | null;
  window: 0 | 1;
  fetchedAt: number;
  coverage: { tickers: number; covered: number; pending: number; trades: number; coveredTrades: number };
  excludedWksi: string[];
  offering: DayBucket;
  normal: DayBucket;
  byForm: Array<DayBucket & { form: string }>;
  byTicker: Array<DayBucket & { ticker: string; days: string[] }>;
  recent: Array<{ id: number; ticker: string; date: string; net: number | null; result: string | null; offeringDay: string; form: string | null }>;
  traded: Record<string, { trades: number; net: number; lastDate: string }>;
}

// ── GET /offerings/ipo-calendar ──
export interface IpoRow {
  ticker: string;
  company: string;
  date: string;
  status: "upcoming" | "priced" | "filed" | "withdrawn";
  offerPrice: number | null;
  priceRange: string | null;
  sharesOffered: number | null;
  dealSizeM: number | null;
  exchange: string | null;
  underwriter: string | null;
}
export interface IpoQuoted extends IpoRow {
  currentPrice: number | null;
  pctFromIpo: number | null;
  marketCapM: number | null;
  avgVolume: number | null;
  sharesOutstanding: number | null;
}
export interface IpoCalendarResponse {
  fetchedAt: number;
  today: string;
  lockupDays: number;
  upcoming: IpoRow[];
  recent: Array<IpoQuoted & { spac: boolean }>;
  lockups: Array<IpoQuoted & { lockupDate: string; daysLeft: number; unlockMultiple: number | null }>;
  sources: { nasdaq: boolean; market: boolean };
}

/** Minimal trade row from GET /api/trades/page. */
export interface TradeRow {
  id: number;
  ticker: string;
  date: string;
  side?: string | null;
  pnl?: number | string | null;
  fees?: number | string | null;
  result?: string | null;
  setup?: string | null;
  trader?: string | null;
}

export interface InsiderTxn {
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
}

export interface InsiderSummary {
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
}

export interface TickerDetail {
  ticker: string;
  cik: string;
  company: string | null;
  sic: string | null;
  edgarUrl: string;
  stats: {
    offerings12m: number;
    atm12m: number;
    lastShelfDate: string | null;
    lastOfferingDate: string | null;
    lastEffectDate: string | null;
    activeShelf: boolean;
    serialDiluter: boolean;
  };
  filings: Array<{ form: string; date: string; url: string | null; description: string | null }>;
  insiders: InsiderSummary | null;
}

/** Minimal open-trade shape read from GET /api/trades?result=open. */
export interface OpenTrade {
  id: number;
  ticker: string;
  side?: string | null;
  horizon?: "intraday" | "overnight" | "swing" | null;
  date?: string;
  trader?: string | null;
  entry?: number | null;
}

export interface WatchItem {
  id: number;
  ticker: string;
  status?: string | null;
}

/** Exposure of the user/desk to a ticker: open position(s) and/or watchlist. */
export interface Exposure {
  held: OpenTrade[];
  watched: boolean;
}

// ── Derived helpers (work with older API payloads too) ────────────────────────

export function kindOf(o: Offering): FilingKind {
  if (o.kind) return o.kind;
  if (o.type === "ATM") return "ATM";
  if (o.type === "IPO" || o.type === "SPAC") return "IPO";
  return "424B";
}

export function riskOf(o: Offering): { score: number; level: RiskLevel } {
  if (o.riskLevel && o.dilutionRisk != null) return { score: o.dilutionRisk, level: o.riskLevel };
  const d = o.dilutionPct ?? 0;
  const score = Math.min(100, Math.round(20 + d * 1.5 + (o.type === "ATM" ? 15 : 0)));
  return { score, level: score >= 60 ? "high" : score >= 35 ? "medium" : "low" };
}

/** Size as % of market cap: server value, else derived. */
export function pctOfMcap(o: Offering): number | null {
  if (o.offerPctOfMcap != null) return o.offerPctOfMcap;
  const size = o.dealSizeM ?? o.shelfCapacityM ?? null;
  if (size != null && o.marketCapM) return +((size / o.marketCapM) * 100).toFixed(1);
  return o.dilutionPct ?? null;
}

export const RISK_LABEL: Record<RiskLevel, string> = liveRecord(["high", "medium", "low"] as const, (k) => offeringsI18n.t(`risk.${k}`));
export const RISK_TONE: Record<RiskLevel, Tone> = { high: "down", medium: "warn", low: "up" };

const FILING_KINDS = ["424B", "ATM", "S-3", "S-1", "IPO"] as const;
export const KIND_LABEL: Record<FilingKind, string> = liveRecord(FILING_KINDS, (k) => (k === "S-3" ? offeringsI18n.t("kind.shelf") : k));
export const KIND_HINT: Record<FilingKind, string> = liveRecord(FILING_KINDS, (k) => offeringsI18n.t(`kind.hint.${k}`));
export const KIND_TONE: Record<FilingKind, Tone> = {
  "424B": "purple",
  ATM: "warn",
  "S-3": "neutral",
  "S-1": "accent",
  IPO: "accent",
};

export const STATUS_LABEL: Record<OfferingStatus, string> = liveRecord(
  ["trading", "priced", "upcoming", "withdrawn", "filed"] as const, (k) => offeringsI18n.t(`status.${k}`));

export const SELLER_LABEL: Record<SellerType, string> = liveRecord(
  ["company", "insiders", "mixed", "unknown"] as const, (k) => (k === "unknown" ? "—" : offeringsI18n.t(`seller.${k}`)));

/** Horizon codes → lower-case label in the UI language (common trading words). */
export const HORIZON_LABEL: Record<string, string> = liveRecord(
  ["intraday", "overnight", "swing"] as const, (k) => commonI18n.t(`trading.${k}`).toLowerCase());

// ── Formatters ────────────────────────────────────────────────────────────────

/** Amount given in millions of dollars → "$12.3M" / "$1.2B". */
export function fmtM(n: number | null | undefined): string {
  return fmtUsd(n == null ? null : n * 1e6, { compact: true });
}
/** Percent that can be absurd (tiny caps, stale share counts): capped at «>1000%». */
export function fmtPctCap(n: number | null | undefined, digits = 1): string {
  if (n != null && n > 1000) return ">1000%";
  return fmtPct(n, { decimals: n != null && n >= 100 ? 0 : digits, signed: false });
}

// Market day is defined in New York time.
export function todayNY(): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().split("T")[0];
  }
}
export function addDays(d: string, n: number): string {
  const dt = new Date(d + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().split("T")[0];
}
/** Step over weekends when moving between market days. */
export function addBusinessDays(d: string, dir: 1 | -1): string {
  let x = addDays(d, dir);
  for (let i = 0; i < 3; i++) {
    const dow = new Date(x + "T12:00:00Z").getUTCDay();
    if (dow !== 0 && dow !== 6) break;
    x = addDays(x, dir);
  }
  return x;
}
/** Market day (API date, possibly with a time part) in the UI language; non-dates pass through. */
export function fmtDay(d: string | null | undefined, style: DateStyle | Intl.DateTimeFormatOptions = "dayMonth"): string {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return d || "—";
  const ymd = d.slice(0, 10);
  return typeof style === "string" ? fmtDate(ymd, style) : fmtDateCustom(ymd, style);
}
export function dayTitle(d: string): string {
  const isToday = d === todayNY();
  const weekday = fmtDay(d, { weekday: "short" });
  const date = fmtDay(d, "dayMonthLong");
  return isToday ? offeringsI18n.t("format.today", { date }) : offeringsI18n.t("format.weekdayDate", { weekday, date });
}
export function fmtAgo(ts: number, now = Date.now()): string {
  return fmtRelative(ts, { now, style: "short" });
}

export function offeringKey(o: Offering): string {
  return `${o.ticker}|${o.status}|${o.date}|${o.form ?? o.type}`;
}


/** One-line catalyst text for the watchlist entry. */
export function watchCatalyst(o: Offering): string {
  const k = kindOf(o);
  const t = offeringsI18n.t;
  const parts = [t("watch.offering", { form: o.form && o.form !== "IPO" ? o.form : KIND_LABEL[k] })];
  const size = o.dealSizeM ?? o.shelfCapacityM;
  if (size != null) parts.push(fmtM(size));
  const pct = pctOfMcap(o);
  if (pct != null) parts.push(t("watch.pctMcap", { pct: fmtPctCap(pct, 0) }));
  if (o.discountPct != null) parts.push(t("watch.discount", { pct: Math.abs(o.discountPct).toFixed(1) }));
  if (o.offerPrice != null) parts.push(t("watch.offer", { price: fmtPrice(o.offerPrice, { dollar: true }) }));
  return parts.join(" · ");
}
