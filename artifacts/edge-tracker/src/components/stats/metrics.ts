/**
 * Pure, client-side scorecard maths for /stats.
 * Everything is computed from /api/trades; "value" is either R-multiple or $ P&L depending on the chosen metric.
 */
import type { Trade } from "@workspace/api-client-react";
import {
  signedR, grossPnl, netPnl, feesOf as feesOfTrade, isOpen, isClosed as isClosedTrade, resultOf, closeDate,
  horizonOf as horizonOfTrade,
} from "@/lib/trade-math";
import { fmtR, fmtUsd, fmtWeekday } from "@/lib/format";
import { statsI18n } from "@/i18n/ns/stats";

/*
 * R / P&L / result buckets come from @/lib/trade-math — the single desk definition shared with /analytics,
 * the dashboard and the API. Do not re-derive them here.
 */

/** r = R-multiple, usd = gross $ P&L (as entered), net = P&L minus fees. */
export type Metric = "r" | "usd" | "net";
export const isUsd = (m: Metric) => m !== "r";
export const metricUnit = (m: Metric) => (m === "r" ? "R" : m === "net" ? "net P&L" : "P&L");

/** Prop-desk fields (nullable). Declared locally so this compiles whether or not the client .d.ts has been rebuilt yet. */
export type TradeX = Trade & { horizon?: string | null; exitDate?: string | null; qty?: number | null; fees?: number | null; riskUsd?: number | null };
export const tx = (t: Trade) => t as TradeX;

export type Horizon = "intraday" | "overnight" | "swing";
export type HorizonFilter = "all" | Horizon;
const HORIZON_FILTERS: HorizonFilter[] = ["all", "intraday", "overnight", "swing"];
/** Horizon filter options (labels are getters: they follow the UI language). */
export const HORIZON_OPTIONS: { value: HorizonFilter; readonly label: string }[] = HORIZON_FILTERS.map((value) => ({
  value, get label() { return statsI18n.t(`horizon.${value}`); },
}));
/** "Интрадей" / "Intraday" — read at call time. */
export const horizonLabel = (h: Horizon): string => statsI18n.t(`horizon.${h}`);
/** Null / unknown horizon is treated as intraday. */
export function horizonOf(t: Trade): Horizon {
  return horizonOfTrade(t);
}
export type PeriodKey = "7d" | "30d" | "90d" | "ytd" | "all";

const PERIOD_KEYS: PeriodKey[] = ["7d", "30d", "90d", "ytd", "all"];
/** Period options (labels are getters: they follow the UI language). */
export const PERIOD_OPTIONS: { value: PeriodKey; readonly label: string; readonly long: string }[] = PERIOD_KEYS.map((value) => ({
  value,
  get label() { return statsI18n.t(`period.${value}.label`); },
  get long() { return statsI18n.t(`period.${value}.long`); },
}));

/** Short weekday for a Monday-first index 0–6 (weekdayIdx): «Пн» / «Mon» / «Du». Language read at call time. */
export function weekdayLabel(i: number): string {
  const s = fmtWeekday((i + 1) % 7, "short");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ───────────── dates ───────────── */

/** Trading day a result belongs to: the close date (exit date for multi-day holds, else the entry date). */
export function dayKey(t: Pick<Trade, "date" | "exitDate">): string {
  return String(closeDate(t) ?? "").substring(0, 10);
}

/** Entry date (for display next to the ticker). */
export function entryKey(t: Pick<Trade, "date">): string {
  return String(t.date ?? "").substring(0, 10);
}

export function toKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseKey(k: string): Date {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** Monday-based weekday index 0..6 for a YYYY-MM-DD key. */
export function weekdayIdx(k: string): number {
  return (parseKey(k).getDay() + 6) % 7;
}

export type Range = { from: string | null; to: string | null };

/** Current range and the equally long range right before it (null for "all"). */
export function periodRanges(period: PeriodKey, now = new Date()): { cur: Range; prev: Range | null } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shift = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  if (period === "all") return { cur: { from: null, to: null }, prev: null };
  if (period === "ytd") {
    const from = new Date(today.getFullYear(), 0, 1);
    const prevFrom = new Date(today.getFullYear() - 1, 0, 1);
    const prevTo = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
    return { cur: { from: toKey(from), to: null }, prev: { from: toKey(prevFrom), to: toKey(prevTo) } };
  }
  const n = period === "7d" ? 7 : period === "30d" ? 30 : 90;
  const from = shift(today, -(n - 1));
  return {
    cur: { from: toKey(from), to: null },
    prev: { from: toKey(shift(from, -n)), to: toKey(shift(from, -1)) },
  };
}

export function inRange(trades: Trade[], r: Range): Trade[] {
  return trades.filter((t) => {
    const k = dayKey(t);
    if (r.from && k < r.from) return false;
    if (r.to && k > r.to) return false;
    return true;
  });
}

/* ───────────── values ───────────── */

export function feesOf(t: Trade): number {
  return feesOfTrade(t);
}

/** Per-trade value: signed R (shared rule) · gross $ · net $ (gross − fees). Open trades ⇒ null. */
export function valueOf(t: Trade, metric: Metric): number | null {
  if (isOpen(t)) return null;
  if (metric === "r") return signedR(t);
  return metric === "net" ? netPnl(t) : grossPnl(t);
}

export type FeeStats = { gross: number | null; fees: number; net: number | null; withFees: number; withPnl: number };

/** Gross vs net over closed trades with a P&L. Fees of trades without a P&L are not counted (net must match gross − fees). */
export function feeStats(trades: Trade[]): FeeStats {
  let gross = 0;
  let fees = 0;
  let withPnl = 0;
  let withFees = 0;
  for (const t of trades) {
    if (!isClosed(t)) continue;
    const g = grossPnl(t);
    if (g == null) continue;
    const f = feesOf(t);
    if (f > 0) withFees++;
    fees += f;
    gross += g;
    withPnl++;
  }
  return { gross: withPnl ? gross : null, fees, net: withPnl ? gross - fees : null, withFees, withPnl };
}

/** Closed = win / loss / break-even in any spelling (legacy «прибыль/убыток» included). */
export const isClosed = (t: Trade) => isClosedTrade(t);
export const isWin = (t: Trade) => resultOf(t) === "win";
export const isLoss = (t: Trade) => resultOf(t) === "loss";

/** Chronological by close date, then entry date, creation time and id. */
export function chrono(trades: Trade[]): Trade[] {
  return [...trades].sort(
    (a, b) => dayKey(a).localeCompare(dayKey(b)) || entryKey(a).localeCompare(entryKey(b))
      || String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || a.id - b.id,
  );
}

/** Which metric has more data — used as the default when nothing is remembered. */
export function preferredMetric(trades: Trade[]): Metric {
  const usd = trades.filter((t) => valueOf(t, "usd") != null).length;
  const r = trades.filter((t) => valueOf(t, "r") != null).length;
  return usd >= r && usd > 0 ? "net" : "r";
}

/* ───────────── KPIs ───────────── */

export type Kpis = {
  total: number;
  closed: number;
  open: number;
  wins: number;
  losses: number;
  breakeven: number;
  valued: number; // closed trades with a value for the metric
  missing: number; // closed trades without a value
  winRate: number | null;
  net: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  payoff: number | null;
  expectancy: number | null;
  profitFactor: number | null; // null when there are no losses (never Infinity)
  maxDrawdown: number | null; // <= 0
  bestTrade: number | null;
  worstTrade: number | null;
  longestWin: number;
  longestLoss: number;
  current: { kind: "win" | "loss" | null; len: number };
  tradingDays: number;
  greenDays: number;
  redDays: number;
};

export function computeKpis(trades: Trade[], metric: Metric): Kpis {
  const closed = chrono(trades.filter(isClosed));
  const wins = closed.filter(isWin).length;
  const losses = closed.filter(isLoss).length;
  const breakeven = closed.length - wins - losses;
  const vals = closed.map((t) => valueOf(t, metric)).filter((v): v is number => v != null);
  const pos = vals.filter((v) => v > 0);
  const neg = vals.filter((v) => v < 0);
  const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
  const gp = sum(pos);
  const gl = Math.abs(sum(neg));
  const net = vals.length ? sum(vals) : null;
  const avgWin = pos.length ? gp / pos.length : null;
  const avgLoss = neg.length ? -gl / neg.length : null;

  // Drawdown on the cumulative curve (starts at 0).
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const v of vals) {
    cum += v;
    peak = Math.max(peak, cum);
    dd = Math.min(dd, cum - peak);
  }

  // Streaks over closed trades (breakeven breaks a streak).
  let longestWin = 0;
  let longestLoss = 0;
  let runKind: "win" | "loss" | null = null;
  let run = 0;
  for (const t of closed) {
    const k = isWin(t) ? "win" : isLoss(t) ? "loss" : null;
    if (k && k === runKind) run++;
    else {
      runKind = k;
      run = k ? 1 : 0;
    }
    if (runKind === "win") longestWin = Math.max(longestWin, run);
    if (runKind === "loss") longestLoss = Math.max(longestLoss, run);
  }

  const days = dailySeries(trades, metric);
  return {
    total: trades.length,
    closed: closed.length,
    open: trades.length - closed.length,
    wins,
    losses,
    breakeven,
    valued: vals.length,
    missing: closed.length - vals.length,
    // W / (W + L): break-even trades are reported separately, never in the denominator.
    winRate: wins + losses ? wins / (wins + losses) : null,
    net,
    avgWin,
    avgLoss,
    payoff: avgWin != null && avgLoss != null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null,
    expectancy: vals.length ? sum(vals) / vals.length : null,
    profitFactor: gl > 0 ? gp / gl : null,
    maxDrawdown: vals.length ? dd : null,
    bestTrade: vals.length ? Math.max(...vals) : null,
    worstTrade: vals.length ? Math.min(...vals) : null,
    longestWin,
    longestLoss,
    current: { kind: runKind, len: run },
    tradingDays: days.length,
    greenDays: days.filter((d) => d.value != null && d.value > 0).length,
    redDays: days.filter((d) => d.value != null && d.value < 0).length,
  };
}

/* ───────────── series ───────────── */

export type DayStat = { key: string; count: number; wins: number; losses: number; value: number | null; trades: Trade[] };

export function dailySeries(trades: Trade[], metric: Metric): DayStat[] {
  const map = new Map<string, DayStat>();
  for (const t of trades) {
    const k = dayKey(t);
    if (!k) continue;
    const d = map.get(k) ?? { key: k, count: 0, wins: 0, losses: 0, value: null, trades: [] };
    d.count++;
    d.trades.push(t);
    if (isWin(t)) d.wins++;
    if (isLoss(t)) d.losses++;
    const v = isClosed(t) ? valueOf(t, metric) : null;
    if (v != null) d.value = (d.value ?? 0) + v;
    map.set(k, d);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export type EquityPoint = { idx: number; equity: number; drawdown: number; label: string; id: number };

export function equitySeries(trades: Trade[], metric: Metric): EquityPoint[] {
  let cum = 0;
  let peak = 0;
  const out: EquityPoint[] = [];
  for (const t of chrono(trades.filter(isClosed))) {
    const v = valueOf(t, metric);
    if (v == null) continue;
    cum += v;
    peak = Math.max(peak, cum);
    out.push({ idx: out.length + 1, equity: cum, drawdown: cum - peak, label: `${t.ticker} · ${dayKey(t)}`, id: t.id });
  }
  return out;
}

export function monthlySeries(trades: Trade[], metric: Metric) {
  const map = new Map<string, { month: string; value: number; count: number }>();
  for (const t of trades) {
    if (!isClosed(t)) continue;
    const v = valueOf(t, metric);
    if (v == null) continue;
    const m = dayKey(t).substring(0, 7);
    const e = map.get(m) ?? { month: m, value: 0, count: 0 };
    e.value += v;
    e.count++;
    map.set(m, e);
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/* ───────────── groupings ───────────── */

export type GroupStat = {
  key: string;
  count: number;
  closed: number;
  wins: number;
  winRate: number | null;
  value: number | null;
  avg: number | null;
  valued: number;
};

export function groupBy(trades: Trade[], keyFn: (t: Trade) => string | null | undefined, metric: Metric): GroupStat[] {
  const map = new Map<string, { count: number; closed: number; wins: number; losses: number; sum: number; valued: number }>();
  for (const t of trades) {
    const k = (keyFn(t) ?? "").toString().trim() || "—";
    const e = map.get(k) ?? { count: 0, closed: 0, wins: 0, losses: 0, sum: 0, valued: 0 };
    e.count++;
    if (isClosed(t)) {
      e.closed++;
      if (isWin(t)) e.wins++;
      if (isLoss(t)) e.losses++;
      const v = valueOf(t, metric);
      if (v != null) {
        e.sum += v;
        e.valued++;
      }
    }
    map.set(k, e);
  }
  return [...map.entries()].map(([key, e]) => ({
    key,
    count: e.count,
    closed: e.closed,
    wins: e.wins,
    winRate: e.wins + e.losses ? e.wins / (e.wins + e.losses) : null,
    value: e.valued ? e.sum : null,
    avg: e.valued ? e.sum / e.valued : null,
    valued: e.valued,
  }));
}

/** Raw session values → session code. */
const SESSION_CODES: Record<string, "premarket" | "regular" | "afterhours"> = {
  premarket: "premarket",
  pre: "premarket",
  regular: "regular",
  rth: "regular",
  afterhours: "afterhours",
  "after-hours": "afterhours",
  postmarket: "afterhours",
  after: "afterhours",
};

export function sessionKey(t: Trade): string {
  const s = (t.session ?? "").toString().trim().toLowerCase();
  if (!s) return "none";
  return SESSION_CODES[s] ?? s;
}

/** Display text of a session code; unknown raw values are shown as they are. */
export function sessionLabel(k: string): string {
  if (k === "none" || k === "premarket" || k === "regular" || k === "afterhours") return statsI18n.t(`session.${k}`);
  const code = SESSION_CODES[k];
  return code ? statsI18n.t(`session.${code}`) : k;
}


/* ───────────── formatting ───────────── */

/** Value of the selected metric: +0.21R or +$1,234 / −$12.50 (no cents from $1,000). */
export function fmtValue(v: number | null | undefined, metric: Metric, opts: { sign?: boolean } = {}): string {
  const signed = opts.sign !== false;
  return metric === "r" ? fmtR(v, { signed }) : fmtUsd(v, { signed, decimals: "auto" });
}

/** Compact value for tiny cells and axes: +1.2R / +$1.2K; "" when missing. */
export function fmtMetricCompact(v: number | null | undefined, metric: Metric): string {
  if (metric === "r") return fmtR(v, { decimals: v != null && Math.abs(v) >= 10 ? 0 : 1, fallback: "" });
  return fmtUsd(v, { signed: true, compact: true, fallback: "" });
}

/** Background colour for a heat cell: intensity ∝ |v| / max. Uses theme tokens only. */
export function heatBg(v: number | null | undefined, max: number): string | undefined {
  if (v == null || !Number.isFinite(v) || v === 0 || max <= 0) return undefined;
  const a = 0.12 + 0.48 * Math.min(1, Math.abs(v) / max);
  return v > 0 ? `hsl(var(--up) / ${a.toFixed(2)})` : `hsl(var(--down) / ${a.toFixed(2)})`;
}
