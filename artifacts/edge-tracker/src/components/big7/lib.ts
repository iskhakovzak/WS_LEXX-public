/**
 * Big 7 board — shared types, constants and localStorage-backed day state.
 * Storage keys are unchanged from the legacy page so traders keep their plans.
 */
import type { LucideIcon } from "lucide-react";
import {
  BarChart3, Landmark, DollarSign, Rocket, TrendingUp, Newspaper,
} from "lucide-react";
import type { Tone } from "@/components/ds";
import { nyDate } from "@/lib/trading-date";
import { fmtWeekday } from "@/lib/format";
import { big7I18n } from "@/i18n/ns/big7";

const bt = big7I18n.t;

// ─── dates ──────────────────────────────────────────────────────────────────
/** Local YYYY-MM-DD (toISOString is UTC and jumps a day in the evening). */
export function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
/**
 * Trading date (New York) — the desk convention; the browser's local date jumps a day for Asian time zones.
 * Read at call time (not once at module load): a tab left open overnight must roll over to the new day.
 * Components re-render on the NY date change through useBig7Today() (use-big7.ts).
 */
export function big7Today(): string {
  return nyDate();
}

export function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
export function isWeekend(d: Date) {
  const w = d.getDay();
  return w === 0 || w === 6;
}
/** Today + n trading days (weekends skipped, holidays ignored). n=0 → today (or next weekday). */
export function addTradingDays(from: string, n: number): string {
  const d = parseLocalDate(from);
  while (isWeekend(d)) d.setDate(d.getDate() + 1);
  let left = n;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (!isWeekend(d)) left--;
  }
  return localDateStr(d);
}
/** Trading days from `from` to `to` (0 = same day, negative if past). */
export function tradingDaysUntil(to: string, from = big7Today()): number {
  if (to === from) return 0;
  const sign = to > from ? 1 : -1;
  const d = parseLocalDate(from);
  let count = 0;
  const target = to;
  for (let guard = 0; guard < 400; guard++) {
    d.setDate(d.getDate() + sign);
    if (!isWeekend(d)) count += sign;
    const s = localDateStr(d);
    if ((sign > 0 && s >= target) || (sign < 0 && s <= target)) break;
  }
  return count;
}
export function mondayOf(dateStr: string): string {
  const d = parseLocalDate(dateStr);
  const w = d.getDay();
  const diff = w === 0 ? -6 : 1 - w;
  d.setDate(d.getDate() + diff);
  return localDateStr(d);
}
export function addDays(dateStr: string, n: number): string {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}
/** «Пн», «Вт»… in the UI language, capitalised for column heads. */
export function weekdayShort(dateStr: string) {
  const s = fmtWeekday(parseLocalDate(dateStr), "short");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export function relDayLabel(dateStr: string): string {
  const today = big7Today();
  if (dateStr === today) return bt("rel.today");
  const n = tradingDaysUntil(dateStr, today);
  if (dateStr === addTradingDays(today, 1)) return bt("rel.tomorrow");
  if (n > 0) return bt("rel.inDays", { count: n });
  return bt("rel.daysAgo", { count: Math.abs(n) });
}

// ─── numbers ────────────────────────────────────────────────────────────────
/** Parse user-entered number; returns null for empty/invalid (no NaN/Infinity leaks). */
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(",", ".").replace(/[$%\s]/g, "");
  if (s === "" || s === "+" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ─── localStorage ───────────────────────────────────────────────────────────
export function ls<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function lsSet(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / private mode */ }
}
export function lsRaw(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function lsRawSet(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* noop */ }
}

export const DAY_CHANGE_EVENT = "big7-day-change";
export function notifyDayChange() {
  try { window.dispatchEvent(new Event(DAY_CHANGE_EVENT)); } catch { /* noop */ }
}

export type Bias = "" | "bullish" | "bearish" | "neutral" | "watching";
export type TickerDay = {
  bias: Bias;
  notes: string;
  inPlay: boolean;
  rs: number;
  gapPct: string;
  atr: string;
  sessionScore: number;
  sessionNotes: string;
  openPrice: string;
  prevClose: string;
};
export const DEFAULT_DAY: TickerDay = {
  bias: "", notes: "", inPlay: false, rs: 0, gapPct: "", atr: "",
  sessionScore: 0, sessionNotes: "", openPrice: "", prevClose: "",
};
export function getTickerDay(ticker: string): TickerDay {
  return { ...DEFAULT_DAY, ...ls<Partial<TickerDay>>(`big7_day_${ticker}_${big7Today()}`, {}) };
}
export function updateTickerDayField<K extends keyof TickerDay>(ticker: string, key: K, val: TickerDay[K]): TickerDay {
  const next = { ...getTickerDay(ticker), [key]: val };
  lsSet(`big7_day_${ticker}_${big7Today()}`, next);
  notifyDayChange();
  return next;
}

export type TickerStats = { atr: string; avgVol: string; float: string; shortInt: string; sector: string };
export function getTickerStats(ticker: string): TickerStats {
  return { atr: "", avgVol: "", float: "", shortInt: "", sector: "", ...ls<Partial<TickerStats>>(`big7_stats_${ticker}`, {}) };
}
export function saveTickerStats(ticker: string, stats: TickerStats) {
  lsSet(`big7_stats_${ticker}`, stats);
  notifyDayChange();
}

export type MarketCtx = { spyBias: Bias; qqBias: Bias; vixLevel: string; marketNotes: string; gapDirection: string };
export function getMarketContext(): MarketCtx {
  return { spyBias: "", qqBias: "", vixLevel: "", marketNotes: "", gapDirection: "", ...ls<Partial<MarketCtx>>(`big7_market_${big7Today()}`, {}) };
}
export function saveMarketContext(ctx: MarketCtx) {
  lsSet(`big7_market_${big7Today()}`, ctx);
  notifyDayChange();
}

export function parseTickerSymbols(raw: string): string[] {
  return Array.from(new Set(
    raw
      .split(/[\s,;\n\r\t|]+/)
      .map((s) => s.trim().toUpperCase().replace(/^\$/, ""))
      .filter((s) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)),
  ));
}

// ─── domain constants ───────────────────────────────────────────────────────
export const DEFAULT_BIG7: Array<{ symbol: string; name: string; exchange: string }> = [
  { symbol: "AAPL", name: "Apple", exchange: "NASDAQ" },
  { symbol: "MSFT", name: "Microsoft", exchange: "NASDAQ" },
  { symbol: "NVDA", name: "NVIDIA", exchange: "NASDAQ" },
  { symbol: "AMZN", name: "Amazon", exchange: "NASDAQ" },
  { symbol: "META", name: "Meta Platforms", exchange: "NASDAQ" },
  { symbol: "GOOGL", name: "Alphabet", exchange: "NASDAQ" },
  { symbol: "TSLA", name: "Tesla", exchange: "NASDAQ" },
];

type CatalystType = "earnings" | "fomc" | "ex-div" | "product" | "sector" | "news";
const catalystType = (value: CatalystType, icon: LucideIcon, tone: Tone) => ({
  value: value as string,
  icon,
  tone,
  get label() { return bt(`catalyst.type.${value}`); },
});
/** Catalyst types (stored as codes); labels are getters in the UI language. */
export const CATALYST_TYPES: Array<{ value: string; readonly label: string; icon: LucideIcon; tone: Tone }> = [
  catalystType("earnings", BarChart3, "warn"),
  catalystType("fomc", Landmark, "accent"),
  catalystType("ex-div", DollarSign, "up"),
  catalystType("product", Rocket, "purple"),
  catalystType("sector", TrendingUp, "accent"),
  catalystType("news", Newspaper, "neutral"),
];
export const catalystMeta = (t: string) => CATALYST_TYPES.find((c) => c.value === t) ?? CATALYST_TYPES[CATALYST_TYPES.length - 1];

/** Catalysts on these pseudo-tickers (or of type FOMC) affect every name on the board. */
export const MARKET_WIDE = new Set(["SPY", "QQQ", "ALL", "MKT", "MARKET", "ES", "NQ"]);
export const isMarketWide = (c: { ticker: string; type: string }) => MARKET_WIDE.has(c.ticker) || c.type === "fomc";

export const LEVEL_LABELS = [
  "support", "resistance", "pivot", "vwap", "pre-market high", "pre-market low", "ath",
  "gap fill", "open", "yesterday close", "yesterday high", "yesterday low",
];
/** Level kinds shown as codes in every language (the rest go through `levels.kind.*`). */
const LEVEL_LABEL_CODE: Record<string, string> = {
  vwap: "VWAP",
  "pre-market high": "PM high",
  "pre-market low": "PM low",
  ath: "ATH",
  atl: "ATL",
  "yesterday close": "PDC",
  "yesterday high": "PDH",
  "yesterday low": "PDL",
  "52w high": "52w high",
  "52w low": "52w low",
};
export const levelLabel = (l: string) => {
  const k = l.toLowerCase();
  return LEVEL_LABEL_CODE[k] ?? big7I18n.tryT(`levels.kind.${k}`) ?? l;
};
export const ACTION_OPTIONS = ["buy", "sell", "watch", "add size", "trim", "breakout long", "breakdown short", "fade"];
/** Display name of a level action code (unknown codes stay as written). */
export const actionLabel = (a: string) => big7I18n.tryT(`levels.action.${a}`) ?? a;
export function actionTone(a: string): Tone {
  if (a === "buy" || a === "breakout long" || a === "add size") return "up";
  if (a === "sell" || a === "breakdown short" || a === "trim") return "down";
  if (a === "fade") return "warn";
  return "accent";
}
/** Level notes carry the action as a "[action] note" prefix (legacy format, kept). */
export function splitLevelNotes(notes: string | null | undefined): { action: string; note: string } {
  const s = notes ?? "";
  const m = s.match(/^\[([^\]]+)\]\s*/);
  return m ? { action: m[1], note: s.replace(m[0], "") } : { action: "", note: s };
}

// ─── API shapes ─────────────────────────────────────────────────────────────
export type Catalyst = {
  id: number;
  ticker: string;
  date: string;
  type: string;
  description: string | null;
  impact: string;
  /** Author (server created_by). null = legacy → staff-only edit/delete. */
  createdBy?: string | null;
};
/** Earnings found in the shared earnings calendar (not stored in big7_catalysts). */
export type AutoEarning = { ticker: string; date: string; callType: string; epsEstimate: number | null };

export type StockQuote = {
  price: number | null;
  change: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number | null;
  avgVolume: number | null;
  relativeVolume: number | null;
  preMarketPrice: number | null;
  preMarketChange: number | null;
  high52w: number | null;
  low52w: number | null;
  marketCap: number | null;
  name: string;
  gapPct: number | null;
  atr: number | null;
  spark?: number[];
  marketTime?: number | null;
};

export type GapStats = {
  lastClose: number;
  atr: number | null;
  atrPct: number | null;
  avgGapPct20: number | null;
  avgGapPct60: number | null;
  p90GapPct60: number | null;
  maxGap60: { pct: number; date: string } | null;
  gapsOver1Pct: number | null;
  todayGapPct: number | null;
  ret5: number | null;
  ret20: number | null;
  sma20: number | null;
  sma50: number | null;
  trend: "up" | "down" | "mixed";
  spark: number[];
  rs5Spy?: number | null;
  rs20Spy?: number | null;
  rs5Qqq?: number | null;
  rs20Qqq?: number | null;
};
export type GapRiskResponse = {
  asOf: string;
  benchmarks: { SPY: GapStats | null; QQQ: GapStats | null };
  symbols: Record<string, GapStats>;
  missing: string[];
};

export type RiskLimitsLite = {
  accountSize: number | null;
  maxRiskPerTrade: number | null;
  maxPositionUsd: number | null;
  maxOvernightExposure: number | null;
  allowOvernight: boolean;
  allowSwing: boolean;
  tier: string | null;
};
export type RiskMeLite = {
  limits: RiskLimitsLite | null;
  today?: { overnightExposureUsd?: number; openRiskUsd?: number; dailyRemainingUsd?: number | null };
};

/** One board row with everything the tiles need. */
export type BoardTicker = {
  symbol: string;
  name: string;
  exchange: string;
  group: "core" | "hot";
  id: number;
  position: number;
};

/** Next upcoming catalyst for a ticker (own or market-wide), merged with auto earnings. */
export type MergedCatalyst = {
  key: string;
  ticker: string;
  date: string;
  type: string;
  description: string | null;
  impact: string;
  auto: boolean;
  marketWide: boolean;
  /** Report timing of an auto (calendar) earnings row. */
  callType?: "BMO" | "AMC" | null;
  id?: number;
  createdBy?: string | null;
};
export function mergeCatalysts(catalysts: Catalyst[], auto: AutoEarning[]): MergedCatalyst[] {
  const out: MergedCatalyst[] = catalysts.map((c) => ({
    key: `c${c.id}`, ticker: c.ticker, date: c.date, type: c.type, description: c.description,
    impact: c.impact, auto: false, marketWide: isMarketWide(c), id: c.id, createdBy: c.createdBy ?? null,
  }));
  const manualEarnings = new Set(catalysts.filter((c) => c.type === "earnings").map((c) => `${c.ticker}|${c.date}`));
  for (const a of auto) {
    if (manualEarnings.has(`${a.ticker}|${a.date}`)) continue;
    out.push({
      key: `a${a.ticker}${a.date}`, ticker: a.ticker, date: a.date, type: "earnings",
      description: `${bt(a.callType === "BMO" ? "earnings.bmo" : a.callType === "AMC" ? "earnings.amc" : "earnings.unknown")}${a.epsEstimate != null ? ` · EPS est ${a.epsEstimate}` : ""}`,
      impact: "high", auto: true, marketWide: false, callType: a.callType === "BMO" || a.callType === "AMC" ? a.callType : null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
}
export function catalystsFor(symbol: string, merged: MergedCatalyst[]) {
  return merged.filter((c) => c.ticker === symbol || c.marketWide);
}
