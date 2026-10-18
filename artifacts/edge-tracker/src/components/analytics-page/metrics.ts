import type { CSSProperties } from "react";
import type { Trade } from "@workspace/api-client-react";
import { TIME_BUCKETS, timeBucketFor, dayOfWeek, tagsOf } from "@/lib/analytics-pro";
import {
  signedR, netPnl, grossPnl as grossOf, feesOf as feesOfTrade, isOpen, isClosed, resultOf, closeDate,
  horizonOf as horizonOfTrade, maxDrawdown as maxDrawdownOf, type Horizon,
} from "@/lib/trade-math";
import { fmtNum, fmtWeekday } from "@/lib/format";
import { analyticsI18n } from "@/i18n/ns/analytics";
import { personName } from "@/i18n";

/*
 * All R / P&L numbers on the analytics page come from @/lib/trade-math (signedR, netPnl …) — the one
 * definition shared with /stats, the dashboard and the API. Never re-derive R here.
 */

/* ───────────────────────── Global filters ───────────────────────── */

export type Period = "7d" | "30d" | "90d" | "ytd" | "all";
export type SideFilter = "" | "long" | "short";
export type { Horizon };
export type HorizonFilter = "" | Horizon;
/** "" = all · "manual" · "propreports" */
export type SourceFilter = "" | "manual" | "propreports";

export type AnalyticsFilters = {
  period: Period;
  trader: string;
  setup: string; // "" = all, "__none__" = no setup
  ticker: string;
  side: SideFilter;
  horizon: HorizonFilter;
  /** Broker account (PropReports `brokerAccount`); "" = all. */
  account: string;
  source: SourceFilter;
};

export const DEFAULT_FILTERS: AnalyticsFilters = {
  period: "all", trader: "", setup: "", ticker: "", side: "", horizon: "", account: "", source: "",
};

export const HORIZONS: Horizon[] = ["intraday", "overnight", "swing"];
/** "Интрадей" / "Intraday" — read at call time. */
export const horizonLabel = (h: Horizon): string => analyticsI18n.t(`horizon.${h}`);

/** Holding horizon; a missing value means intraday (legacy trades). */
export function horizonOf(t: Trade): Horizon {
  return horizonOfTrade(t);
}

/** Broker fields arrive only after the PropReports rebuild — read them defensively. */
export function accountOf(t: Trade): string {
  const a = (t as { brokerAccount?: string | null }).brokerAccount;
  return typeof a === "string" ? a.trim() : "";
}
export function sourceOf(t: Trade): "manual" | "propreports" {
  const s = (t as { source?: string | null }).source;
  return s === "propreports" ? "propreports" : "manual";
}

export const PERIODS: Period[] = ["7d", "30d", "90d", "ytd", "all"];
/** Period options for a Segmented — call in render (labels follow the UI language). */
export function periodOptions(): { value: Period; label: string }[] {
  return PERIODS.map((value) => ({ value, label: analyticsI18n.t(`period.${value}`) }));
}

export function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Inclusive [from, to] range for a period, plus the equal-length previous range for comparison. */
export function periodRange(period: Period, now = new Date()): { from: string; to: string; prevFrom: string; prevTo: string } | null {
  if (period === "all") return null;
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let start: Date;
  if (period === "ytd") start = new Date(end.getFullYear(), 0, 1);
  else start = new Date(end.getTime() - ((period === "7d" ? 7 : period === "30d" ? 30 : 90) - 1) * 86400000);
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const prevEnd = new Date(start.getTime() - 86400000);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86400000);
  return { from: isoDay(start), to: isoDay(end), prevFrom: isoDay(prevStart), prevTo: isoDay(prevEnd) };
}

/** Trading day a result belongs to: the close date (exit date for multi-day holds, else the trade date). */
export const day = (t: Trade) => (closeDate(t) ?? "").substring(0, 10);
export const sideOf = (t: Trade): "long" | "short" | "" => {
  const s = (t.side ?? "").trim().toLowerCase();
  return s.startsWith("l") ? "long" : s.startsWith("s") ? "short" : "";
};

/** Apply everything except the period. */
export function applyNonPeriodFilters(trades: Trade[], f: AnalyticsFilters): Trade[] {
  return trades.filter((t) => {
    if (f.trader && (t.trader ?? "") !== f.trader) return false;
    if (f.side && sideOf(t) !== f.side) return false;
    if (f.horizon && horizonOf(t) !== f.horizon) return false;
    if (f.ticker && (t.ticker ?? "").toUpperCase() !== f.ticker.toUpperCase()) return false;
    if (f.setup === "__none__" ? !!t.setup : f.setup && (t.setup ?? "") !== f.setup) return false;
    if (f.account && accountOf(t) !== f.account) return false;
    if (f.source && sourceOf(t) !== f.source) return false;
    return true;
  });
}

export function applyAnalyticsFilters(trades: Trade[], f: AnalyticsFilters): { current: Trade[]; previous: Trade[] | null } {
  const base = applyNonPeriodFilters(trades, f);
  const r = periodRange(f.period);
  if (!r) return { current: base, previous: null };
  return {
    current: base.filter((t) => day(t) >= r.from && day(t) <= r.to),
    previous: base.filter((t) => day(t) >= r.prevFrom && day(t) <= r.prevTo),
  };
}

export function activeFilterCount(f: AnalyticsFilters): number {
  return (f.period !== "all" ? 1 : 0) + (f.trader ? 1 : 0) + (f.setup ? 1 : 0) + (f.ticker ? 1 : 0) + (f.side ? 1 : 0)
    + (f.horizon ? 1 : 0) + (f.account ? 1 : 0) + (f.source ? 1 : 0);
}

/* ───────────────────────── Trade-level metrics (thin wrappers over @/lib/trade-math) ───────────────────────── */

export const isWin = (t: Trade) => resultOf(t) === "win";
export const isLoss = (t: Trade) => resultOf(t) === "loss";
export const isBe = (t: Trade) => resultOf(t) === "be";
export { isOpen, isClosed };

/** Signed realised R (shared definition: stored R signed by result → price R → pnl/risk; open ⇒ null). */
export function realizedR(t: Trade): number | null {
  return signedR(t);
}

/** P&L as entered (gross, before fees). */
export function grossPnl(t: Trade): number | null {
  return grossOf(t);
}

export function feesOf(t: Trade): number {
  return feesOfTrade(t);
}

/** Net P&L = gross − fees. This is what "$" means across the analytics page. Open trades ⇒ null. */
export function pnlValue(t: Trade): number | null {
  return isOpen(t) ? null : netPnl(t);
}

/** Calendar days held for multi-day trades (exitDate − date); null when unknown. */
export function holdDays(t: Trade): number | null {
  if (!t.exitDate) return null;
  const a = new Date(`${(t.date ?? "").substring(0, 10)}T00:00:00`);
  const b = new Date(`${t.exitDate.substring(0, 10)}T00:00:00`);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86400000));
}

/** Free-text hold time ("47m", "2часа", "1h 30m", "1:15") → minutes. */
export function parseHoldMinutes(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(",", ".");
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const re = /(\d+(?:\.\d+)?)\s*([a-zа-яё]*)/g;
  let total = 0;
  let found = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const v = Number(m[1]);
    const u = m[2];
    let mult = 1;
    if (/^(d|д)/.test(u)) mult = 1440;
    else if (/^(h|ч)/.test(u)) mult = 60;
    else if (/^(s|с)/.test(u)) mult = 1 / 60;
    total += v * mult;
    found = true;
  }
  return found ? total : null;
}

/* ───────────────────────── Group stats ───────────────────────── */

export type Stats = {
  n: number;
  wins: number;
  losses: number;
  /** Break-even trades (reported separately, never in the win-rate denominator). */
  be: number;
  /** Still open (no result yet) — excluded from every ratio. */
  open: number;
  /** wins + losses — the win-rate denominator. */
  decided: number;
  winRate: number; // 0..1 (0 when nothing is decided)
  wrLow: number;
  wrHigh: number;
  rN: number;
  totalR: number;
  avgR: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  /** ΣR⁺ / |ΣR⁻|; null when there are no losing R (never ∞). */
  pfR: number | null;
  pnlN: number;
  /** Net of fees. */
  totalPnl: number;
  avgPnl: number | null;
  avgWinPnl: number | null;
  avgLossPnl: number | null;
  pfPnl: number | null;
  /** Sum of entered P&L before fees (same trades as totalPnl). */
  grossPnl: number;
  totalFees: number;
  feesN: number;
};

/** Wilson 95% interval for a proportion. */
export function wilson(wins: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - margin) / denom), Math.min(1, (centre + margin) / denom)];
}

export function computeStats(trades: Trade[]): Stats {
  let wins = 0, losses = 0, be = 0, open = 0;
  let rN = 0, totalR = 0, winRSum = 0, winRN = 0, lossRSum = 0, lossRN = 0;
  let pnlN = 0, totalPnl = 0, winPnlSum = 0, winPnlN = 0, lossPnlSum = 0, lossPnlN = 0, gross = 0, fees = 0, feesN = 0;
  for (const t of trades) {
    if (isOpen(t)) { open++; continue; }
    const res = resultOf(t);
    if (res === "win") wins++;
    else if (res === "loss") losses++;
    else if (res === "be") be++;
    const r = realizedR(t);
    if (r != null) {
      rN++; totalR += r;
      if (r > 0) { winRSum += r; winRN++; } else if (r < 0) { lossRSum += r; lossRN++; }
    }
    const p = pnlValue(t);
    if (p != null) {
      // Fees count only where a P&L exists — otherwise "net" would be understated against "gross".
      if (t.fees != null) { feesN++; fees += feesOf(t); }
      gross += grossPnl(t) ?? 0;
      pnlN++; totalPnl += p;
      if (p > 0) { winPnlSum += p; winPnlN++; } else if (p < 0) { lossPnlSum += p; lossPnlN++; }
    }
  }
  const n = trades.length;
  const decided = wins + losses;
  const [lo, hi] = wilson(wins, decided);
  return {
    n, wins, losses, be, open, decided,
    winRate: decided ? wins / decided : 0,
    wrLow: lo, wrHigh: hi,
    rN, totalR,
    avgR: rN ? totalR / rN : null,
    avgWinR: winRN ? winRSum / winRN : null,
    avgLossR: lossRN ? lossRSum / lossRN : null,
    pfR: lossRSum < 0 ? winRSum / Math.abs(lossRSum) : null,
    pnlN, totalPnl,
    avgPnl: pnlN ? totalPnl / pnlN : null,
    avgWinPnl: winPnlN ? winPnlSum / winPnlN : null,
    avgLossPnl: lossPnlN ? lossPnlSum / lossPnlN : null,
    pfPnl: lossPnlSum < 0 ? winPnlSum / Math.abs(lossPnlSum) : null,
    grossPnl: gross,
    totalFees: fees,
    feesN,
  };
}

export type Reliability = { level: "low" | "medium" | "high"; label: string; hint: string };

export function reliability(n: number): Reliability {
  const t = analyticsI18n.t;
  if (n < 5) return { level: "low", label: t("reliability.low"), hint: t("reliability.lowHint", { n }) };
  if (n < 20) return { level: "medium", label: t("reliability.medium"), hint: t("reliability.mediumHint", { n }) };
  return { level: "high", label: t("reliability.high"), hint: t("reliability.highHint", { n }) };
}

/* ───────────────────────── Streaks / equity / drawdown ───────────────────────── */

/** Chronological by close date, then entry date, creation time and id (same-day ties are stable everywhere). */
export function sortChrono(trades: Trade[]): Trade[] {
  return [...trades].sort((a, b) =>
    day(a).localeCompare(day(b)) || (a.date ?? "").localeCompare(b.date ?? "")
    || (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id - b.id);
}

export function streaks(trades: Trade[]): { maxWin: number; maxLoss: number; current: number } {
  let maxWin = 0, maxLoss = 0, cur = 0;
  for (const t of sortChrono(trades)) {
    if (isOpen(t)) continue;
    if (isWin(t)) cur = cur > 0 ? cur + 1 : 1;
    else if (isLoss(t)) cur = cur < 0 ? cur - 1 : -1;
    else cur = 0;
    maxWin = Math.max(maxWin, cur);
    maxLoss = Math.min(maxLoss, cur);
  }
  return { maxWin, maxLoss: Math.abs(maxLoss), current: cur };
}

export type Unit = "r" | "usd";

/** Per-trade value in the chosen unit (signed R or net $); null when unknown / open. */
export function valueIn(t: Trade, unit: Unit): number | null {
  return unit === "r" ? realizedR(t) : pnlValue(t);
}

export type EquityPoint = { i: number; date: string; ticker: string; value: number; cum: number; dd: number; cumGross: number };

export function equitySeries(trades: Trade[], unit: Unit): EquityPoint[] {
  let cum = 0, peak = 0, cumGross = 0;
  const out: EquityPoint[] = [];
  for (const t of sortChrono(trades)) {
    const v = valueIn(t, unit);
    if (v == null) continue;
    cum += v;
    cumGross += unit === "r" ? v : grossPnl(t) ?? 0;
    peak = Math.max(peak, cum);
    out.push({ i: out.length + 1, date: day(t), ticker: t.ticker, value: v, cum: round2(cum), dd: round2(cum - peak), cumGross: round2(cumGross) });
  }
  return out;
}

export function maxDrawdown(series: EquityPoint[]): number {
  return maxDrawdownOf(series.map((p) => p.value));
}

export type HistBin = { label: string; from: number; count: number; tone: "up" | "down" };

/** Histogram of realised R in 1R bins, tails clamped at ≤−3R and ≥6R. */
export function rHistogram(trades: Trade[]): HistBin[] {
  const MIN = -3, MAX = 6;
  const bins = new Map<number, number>();
  for (let b = MIN; b <= MAX; b++) bins.set(b, 0);
  for (const t of trades) {
    const r = realizedR(t);
    if (r == null) continue;
    const b = Math.max(MIN, Math.min(MAX, Math.floor(r)));
    bins.set(b, (bins.get(b) ?? 0) + 1);
  }
  return [...bins.entries()].map(([b, count]) => ({
    from: b,
    count,
    tone: b < 0 ? "down" : "up",
    label: b === MIN ? `≤${fmtNum(MIN + 1, { decimals: 0, signed: true })}` : b === MAX ? `≥+${MAX}` : `${fmtNum(b, { decimals: 0, signed: true })}…${fmtNum(b + 1, { decimals: 0, signed: true })}`,
  }));
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* ───────────────────────── Dimensions (edge breakdowns) ───────────────────────── */

export type DimensionKey =
  | "horizon" | "holdDays" | "setup" | "tag" | "time" | "session" | "weekday" | "hold" | "price" | "gap" | "event" | "side" | "ticker" | "trader"
  | "grade" | "conviction" | "cap" | "float" | "account" | "source";

/**
 * Group keys are stable codes (bucket ids) or user data (setup, tag, ticker, trader, account names). Keys that start
 * with "~" are the "nothing known" buckets (no setup, no time, …): they are listed but never picked as a leader.
 * Display text comes from `labelOf(key)` at call time, so it follows the UI language.
 */
type Dimension = {
  key: DimensionKey;
  readonly label: string;
  /** Group keys for a trade (multi for tags). */
  keys: (t: Trade) => string[];
  /** Display text of a key; default: the key itself (user data). */
  labelOf?: (key: string) => string;
  /** Natural order for ordinal dimensions; undefined = sort by sample size. */
  order?: string[];
  /** Global filter this dimension can drill into. */
  drill?: "setup" | "ticker" | "side" | "trader" | "horizon" | "account" | "source";
  readonly emptyHint?: string;
  /** Only these trades enter the breakdown (e.g. multi-day holds). */
  scope?: (t: Trade) => boolean;
  readonly scopeLabel?: string;
};

const t = analyticsI18n.t;
/** The "nothing known" bucket of every dimension. */
export const NONE = "~none";
export const isEmptyKey = (k: string) => k.startsWith("~");

const SESSION_CODE: Record<string, "premarket" | "regular" | "afterhours"> = {
  premarket: "premarket", pre: "premarket", regular: "regular", rth: "regular",
  afterhours: "afterhours", "after-hours": "afterhours", after: "afterhours", postmarket: "afterhours",
};
const EVENT_CODES = ["earnings", "news", "other", "fda", "offering", "guidance", "macro", "ipo"] as const;
type EventCode = (typeof EVENT_CODES)[number];
const isEventCode = (s: string): s is EventCode => (EVENT_CODES as readonly string[]).includes(s);

/** "Пн" (capitalised short weekday in the UI language); 0 = Sunday. */
const weekdayLabel = (d: number) => { const s = fmtWeekday(d, "short"); return s.charAt(0).toUpperCase() + s.slice(1); };

const HOLD_ORDER = ["lt5", "m5_15", "m15_60", "h1_4", "gt4h", NONE] as const;
const PRICE_ORDER = ["lt5", "p5_20", "p20_50", "p50_100", "p100_300", "gt300", NONE] as const;
const GAP_ORDER = ["up", "down", "other", "~nogap"] as const;
const HOLD_DAYS_ORDER = ["d1", "d2_3", "d4_7", "d8_20", "gt20", NONE] as const;
const CAP_ORDER = ["nano", "micro", "small", "mid", "large", NONE] as const;
const FLOAT_ORDER = ["lt10", "f10_50", "f50_200", "f200_1b", "gt1b", NONE] as const;
type HoldCode = Exclude<(typeof HOLD_ORDER)[number], typeof NONE>;
type PriceCode = Exclude<(typeof PRICE_ORDER)[number], typeof NONE>;
type HoldDaysCode = Exclude<(typeof HOLD_DAYS_ORDER)[number], typeof NONE>;
type CapCode = Exclude<(typeof CAP_ORDER)[number], typeof NONE>;
type FloatCode = Exclude<(typeof FLOAT_ORDER)[number], typeof NONE>;

function holdDaysBucket(tr: Trade): string {
  const d = holdDays(tr);
  if (d == null) return NONE;
  if (d <= 1) return "d1";
  if (d <= 3) return "d2_3";
  if (d <= 7) return "d4_7";
  if (d <= 20) return "d8_20";
  return "gt20";
}

function holdBucket(tr: Trade): string {
  const m = parseHoldMinutes(tr.holdTime);
  if (m == null) return NONE;
  if (m < 5) return "lt5";
  if (m < 15) return "m5_15";
  if (m < 60) return "m15_60";
  if (m < 240) return "h1_4";
  return "gt4h";
}

function priceBucket(tr: Trade): string {
  const p = Number(tr.entry);
  if (tr.entry == null || !Number.isFinite(p) || p <= 0) return NONE;
  if (p < 5) return "lt5";
  if (p < 20) return "p5_20";
  if (p < 50) return "p20_50";
  if (p < 100) return "p50_100";
  if (p < 300) return "p100_300";
  return "gt300";
}

function gapBucket(tr: Trade): string {
  const tags = tagsOf(tr).map((s) => s.toLowerCase());
  if (tags.some((s) => s.includes("gap up") || s.includes("gap and go long"))) return "up";
  if (tags.some((s) => s.includes("gap down") || s.includes("gap and go short"))) return "down";
  if (tags.some((s) => s.includes("gap"))) return "other";
  return "~nogap";
}

/** "652 M", "45,43B", "632m", "28.5" (bare ⇒ millions) → dollars; null when unparsable. */
export function parseMoneyText(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.replace(/\s+/g, "").replace(",", ".").toLowerCase();
  const m = s.match(/^\$?([0-9]+(?:\.[0-9]+)?)([kmbt])?$/);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const mult = m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : m[2] === "t" ? 1e12 : v < 1e4 ? 1e6 : 1;
  return v * mult;
}

/** Market-cap bucket code (nano … large, or "~none"). */
export function capBucket(tr: Trade): string {
  const v = parseMoneyText(tr.marketCap);
  if (v == null) return NONE;
  if (v < 50e6) return "nano";
  if (v < 300e6) return "micro";
  if (v < 2e9) return "small";
  if (v < 10e9) return "mid";
  return "large";
}
/** Float bucket code (lt10 … gt1b, or "~none"). */
export function floatBucket(tr: Trade): string {
  const v = parseMoneyText(tr.float);
  if (v == null) return NONE;
  if (v < 10e6) return "lt10";
  if (v < 50e6) return "f10_50";
  if (v < 200e6) return "f50_200";
  if (v < 1e9) return "f200_1b";
  return "gt1b";
}
const GRADE_ORDER = ["A+", "A", "B", "C", NONE];
const CONVICTION_ORDER = ["5", "4", "3", "2", "1", NONE];

const label = (none: string, map?: (k: string) => string) => (k: string) => (k === NONE ? none : map ? map(k) : k);

export const DIMENSIONS: Dimension[] = [
  { key: "horizon", get label() { return t("dim.horizon"); }, keys: (tr) => [horizonOf(tr)],
    labelOf: (k) => (HORIZONS as string[]).includes(k) ? horizonLabel(k as Horizon) : k,
    order: HORIZONS, drill: "horizon" },
  { key: "holdDays", get label() { return t("dim.holdDays"); }, keys: (tr) => [holdDaysBucket(tr)], order: [...HOLD_DAYS_ORDER],
    labelOf: (k) => (k === NONE ? t("bucket.noExitDate") : t(`bucket.holdDays.${k as HoldDaysCode}`)),
    scope: (tr) => horizonOf(tr) !== "intraday", get scopeLabel() { return t("dimScope.multiDay"); },
    get emptyHint() { return t("dimEmpty.holdDays"); } },
  { key: "setup", get label() { return t("dim.setup"); }, keys: (tr) => [tr.setup?.trim() || NONE], drill: "setup",
    get labelOf() { return label(t("bucket.noSetup")); },
    get emptyHint() { return t("dimEmpty.setup"); } },
  { key: "tag", get label() { return t("dim.tag"); }, keys: (tr) => { const g = tagsOf(tr); return g.length ? g : [NONE]; },
    get labelOf() { return label(t("bucket.noTags")); } },
  { key: "time", get label() { return t("dim.time"); },
    keys: (tr) => { const id = timeBucketFor(tr); return [id === "unknown" ? NONE : id]; },
    labelOf: (k) => (k === NONE ? t("bucket.noTime") : TIME_BUCKETS.find((b) => b.id === k)?.label ?? k),
    order: [...TIME_BUCKETS.filter((b) => b.id !== "unknown").map((b) => b.id as string), NONE],
    get emptyHint() { return t("dimEmpty.time"); } },
  { key: "session", get label() { return t("dim.session"); },
    keys: (tr) => { const s = (tr.session ?? "").trim(); return [s ? SESSION_CODE[s.toLowerCase()] ?? s : NONE]; },
    labelOf: (k) => (k === NONE ? t("bucket.notSetF") : k === "premarket" || k === "regular" || k === "afterhours" ? t(`bucket.session.${k}`) : k),
    order: ["premarket", "regular", "afterhours"] },
  { key: "weekday", get label() { return t("dim.weekday"); }, keys: (tr) => { const d = dayOfWeek(tr); return [d >= 0 ? String(d) : NONE]; },
    labelOf: (k) => (k === NONE ? "—" : weekdayLabel(Number(k))),
    order: ["1", "2", "3", "4", "5", "6", "0", NONE] },
  { key: "hold", get label() { return t("dim.hold"); }, keys: (tr) => [holdBucket(tr)], order: [...HOLD_ORDER],
    labelOf: (k) => (k === NONE ? t("bucket.notSet") : t(`bucket.hold.${k as HoldCode}`)),
    scope: (tr) => horizonOf(tr) === "intraday", get scopeLabel() { return t("dimScope.intraday"); } },
  { key: "price", get label() { return t("dim.price"); }, keys: (tr) => [priceBucket(tr)], order: [...PRICE_ORDER],
    labelOf: (k) => (k === NONE ? t("bucket.noPrice") : t(`bucket.price.${k as PriceCode}`)) },
  { key: "gap", get label() { return t("dim.gap"); }, keys: (tr) => [gapBucket(tr)], order: [...GAP_ORDER],
    labelOf: (k) => (k === "~nogap" ? t("bucket.gap.none") : k === "up" || k === "down" || k === "other" ? t(`bucket.gap.${k}`) : k) },
  { key: "event", get label() { return t("dim.event"); },
    keys: (tr) => { const e = (tr.eventType ?? "").trim(); return [!e ? NONE : isEventCode(e.toLowerCase()) ? e.toLowerCase() : e]; },
    labelOf: (k) => (k === NONE ? t("bucket.notSetM") : isEventCode(k) ? t(`bucket.event.${k}`) : k) },
  { key: "side", get label() { return t("dim.side"); }, keys: (tr) => [sideOf(tr) || NONE],
    labelOf: (k) => (k === "long" || k === "short" ? t(`bucket.side.${k}`) : t("bucket.notSet")),
    order: ["long", "short", NONE], drill: "side" },
  { key: "grade", get label() { return t("dim.grade"); }, keys: (tr) => [tr.confidenceGrade?.trim() || NONE], order: GRADE_ORDER,
    get labelOf() { return label(t("bucket.noGrade")); },
    get emptyHint() { return t("dimEmpty.grade"); } },
  { key: "conviction", get label() { return t("dim.conviction"); }, order: CONVICTION_ORDER,
    keys: (tr) => [tr.conviction == null ? NONE : String(Math.max(1, Math.min(5, Math.round(tr.conviction))))],
    labelOf: (k) => (k === NONE ? t("bucket.notSetF") : k === "5" ? t("bucket.conviction.max") : k === "1" ? t("bucket.conviction.min") : k) },
  { key: "cap", get label() { return t("dim.cap"); }, keys: (tr) => [capBucket(tr)], order: [...CAP_ORDER],
    labelOf: (k) => (k === NONE ? t("bucket.noCap") : t(`bucket.cap.${k as CapCode}`)) },
  { key: "float", get label() { return t("dim.float"); }, keys: (tr) => [floatBucket(tr)], order: [...FLOAT_ORDER],
    labelOf: (k) => (k === NONE ? t("bucket.noFloat") : t(`bucket.float.${k as FloatCode}`)) },
  { key: "ticker", get label() { return t("dim.ticker"); }, keys: (tr) => [(tr.ticker ?? "—").toUpperCase()], drill: "ticker" },
  { key: "trader", get label() { return t("dim.trader"); }, keys: (tr) => [tr.trader || NONE], drill: "trader",
    get labelOf() { return label(t("bucket.notSetM"), personName); } },
  { key: "account", get label() { return t("dim.account"); }, keys: (tr) => [accountOf(tr) || NONE], drill: "account",
    get labelOf() { return label(t("bucket.noAccount")); },
    get emptyHint() { return t("dimEmpty.account"); } },
  { key: "source", get label() { return t("dim.source"); }, keys: (tr) => [sourceOf(tr) === "propreports" ? "propreports" : "~manual"],
    labelOf: (k) => (k === "propreports" ? "PropReports" : t("bucket.manual")), order: ["propreports", "~manual"], drill: "source" },
];

export function dimensionOf(key: DimensionKey): Dimension {
  return DIMENSIONS.find((d) => d.key === key)!;
}

/** Display text of a group key of a dimension (follows the UI language). */
export function groupLabel(dimKey: DimensionKey, key: string): string {
  const d = dimensionOf(dimKey);
  return d.labelOf ? d.labelOf(key) : key;
}

export type GroupRow = Stats & { key: string; label: string; share: number };

export function scopedTrades(trades: Trade[], dimKey: DimensionKey): Trade[] {
  const dim = dimensionOf(dimKey);
  return dim.scope ? trades.filter(dim.scope) : trades;
}

export function breakdown(allTrades: Trade[], dimKey: DimensionKey): GroupRow[] {
  const dim = dimensionOf(dimKey);
  const trades = scopedTrades(allTrades, dimKey);
  const groups = new Map<string, Trade[]>();
  for (const tr of trades) {
    for (const k of dim.keys(tr)) {
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(tr);
    }
  }
  const rows = [...groups.entries()].map(([key, g]) => ({
    key, label: dim.labelOf ? dim.labelOf(key) : key, share: trades.length ? g.length / trades.length : 0, ...computeStats(g),
  }));
  if (dim.order) rows.sort((a, b) => idx(dim.order!, a.key) - idx(dim.order!, b.key));
  else rows.sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  return rows;
}

function idx(order: string[], k: string) {
  const i = order.indexOf(k);
  return i < 0 ? order.length : i;
}

/** The single key a drillable row maps to in the global filter. */
export function drillValue(dimKey: DimensionKey, rowKey: string): string | null {
  switch (dimKey) {
    case "setup": return rowKey === NONE ? "__none__" : rowKey;
    case "ticker": return rowKey === "—" ? null : rowKey;
    case "trader": return rowKey === NONE ? null : rowKey;
    case "side": return rowKey === "long" || rowKey === "short" ? rowKey : null;
    case "horizon": return (HORIZONS as string[]).includes(rowKey) ? rowKey : null;
    case "account": return rowKey === NONE ? null : rowKey;
    case "source": return rowKey === "propreports" ? "propreports" : rowKey === "~manual" ? "manual" : null;
    default: return null;
  }
}

/** Strongest and weakest groups across all dimensions (n ≥ minN), by avg R or win rate. */
export function edgeLeaders(trades: Trade[], useR: boolean, minN = 3) {
  const all: { dimKey: DimensionKey; dim: string; key: string; label: string; n: number; score: number; stats: Stats }[] = [];
  for (const d of DIMENSIONS) {
    if (d.key === "trader" || d.key === "ticker") continue;
    const scoped = scopedTrades(trades, d.key);
    for (const row of breakdown(trades, d.key)) {
      if (row.n < minN || row.n === scoped.length) continue;
      if (isEmptyKey(row.key)) continue;
      const score = useR ? row.avgR : row.winRate;
      if (score == null) continue;
      all.push({ dimKey: d.key, dim: d.label, key: row.key, label: row.label, n: row.n, score, stats: row });
    }
  }
  const best = [...all].sort((a, b) => b.score - a.score || b.n - a.n).slice(0, 3);
  const worst = [...all].sort((a, b) => a.score - b.score || b.n - a.n).filter((w) => !best.includes(w)).slice(0, 3);
  return { best, worst };
}

/* ───────────────────────── Formatting ───────────────────────── */

export function round2(v: number) {
  return Math.round(v * 100) / 100;
}

/* Number / money / percent / plural formatters live in @/lib/format (fmtUsd, fmtR, fmtRate, fmtRatio, commonI18n units). */

/* ───────────────────────── CSV ───────────────────────── */

export function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = "﻿" + [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ───────────────────────── Chart styling ───────────────────────── */

export const CHART_TOOLTIP_STYLE: CSSProperties = {
  backgroundColor: "hsl(var(--popover) / 0.92)",
  border: "1px solid hsl(var(--border))",
  color: "hsl(var(--popover-foreground))",
  borderRadius: 12,
  fontSize: 12,
  boxShadow: "0 8px 32px rgb(0 0 0 / 0.3)",
  backdropFilter: "blur(24px)",
  fontVariantNumeric: "tabular-nums",
};
export const CHART_CURSOR = { fill: "hsl(var(--muted-foreground) / 0.08)" };
export const AXIS = { stroke: "hsl(var(--muted-foreground))", fontSize: 11, tickLine: false, axisLine: false } as const;
export const GRID = "hsl(var(--border))";
