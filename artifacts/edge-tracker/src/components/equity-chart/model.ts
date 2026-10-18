/**
 * Equity chart data model (pure, no React / DOM).
 *
 * The engine draws `EquityCandle[]` (see @/components/equity-candles/lib): one candle per trading day of the
 * cumulative result — open / close = start / end of the day, high / low = the intraday extremes of the curve.
 * Sources are normalised here:
 *   • trades                → buildDayCandles (intraday-accurate wicks, best / worst trade, fees);
 *   • dashboard API days    → fromDashboardDays (one cumulative point per day, no intraday wicks);
 *   • analytics-pro OHLC    → fromOhlc (wicks from the id-ordered path, trade count only).
 * Then folded into weeks / months and enriched with the running peak and the underwater curve.
 */
import { toWeekCandles, weekStart, type EquityCandle, type EquityUnit } from "@/components/equity-candles/lib";

export type EquityAgg = "day" | "week" | "month";
export type { EquityCandle, EquityUnit };

const round = (v: number) => Math.round(v * 1e6) / 1e6;

function blank(key: string, open: number, close: number): EquityCandle {
  return {
    key, from: key, to: key, days: 1,
    open, high: Math.max(open, close), low: Math.min(open, close), close, value: round(close - open),
    net: null, gross: null, fees: 0, trades: 0, wins: 0, losses: 0, be: 0, winRate: null,
    peakIn: round(Math.max(open, close) - open), troughIn: round(Math.min(open, close) - open),
    best: null, worst: null, drawdown: 0, closeDrawdown: 0, timeOrdered: false,
  };
}

/** Running peak (high-water mark incl. the 0 start) → drawdown fields of a chronological list (mutates). */
function chainDrawdown(list: EquityCandle[]): EquityCandle[] {
  let peak = 0;
  for (const c of list) {
    // Without the intraday order the low is measured against the peak before the day (conservative).
    c.drawdown = round(Math.min(0, c.low - Math.max(peak, c.open)));
    peak = Math.max(peak, c.high);
    c.closeDrawdown = round(Math.min(0, c.close - peak));
  }
  return list;
}

/** Day row of GET /api/dashboard/equity (net $ and R side by side, cumulative from the period start). */
export interface DashboardDayLike {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  be?: number;
  pnl: number | null;
  pnlGross: number | null;
  fees: number | null;
  r: number;
  cumPnl: number;
  cumR: number;
}

/** Dashboard days → day candles in `net` $ or R. No intraday path: the wicks equal the body. */
export function fromDashboardDays(days: DashboardDayLike[], unit: "net" | "r"): EquityCandle[] {
  const out: EquityCandle[] = [];
  let prev = 0;
  for (const d of days) {
    const close = unit === "r" ? d.cumR : d.cumPnl;
    const c = blank(d.date.slice(0, 10), prev, close);
    c.trades = d.trades; c.wins = d.wins; c.losses = d.losses; c.be = d.be ?? 0;
    c.winRate = d.wins + d.losses ? d.wins / (d.wins + d.losses) : null;
    if (d.pnl != null) { c.net = d.pnl; c.gross = d.pnlGross; c.fees = Math.abs(d.fees ?? 0); }
    out.push(c);
    prev = close;
  }
  return chainDrawdown(out);
}

/** analytics-pro OHLC (cumulative, `volume` = trade count) → day candles. */
export function fromOhlc(candles: { time: string; open: number; high: number; low: number; close: number; volume: number }[]): EquityCandle[] {
  return chainDrawdown(candles.map((k) => {
    const c = blank(k.time.slice(0, 10), k.open, k.close);
    c.high = Math.max(k.high, c.high);
    c.low = Math.min(k.low, c.low);
    c.peakIn = round(c.high - c.open);
    c.troughIn = round(c.low - c.open);
    c.trades = k.volume;
    return c;
  }));
}

/** First day (YYYY-MM-01) of the month that contains `date`. */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Folds day candles into monthly candles (key = the 1st of the month). */
export function toMonthCandles(days: EquityCandle[]): EquityCandle[] {
  const out: EquityCandle[] = [];
  for (const d of days) {
    const key = monthStart(d.from);
    const m = out[out.length - 1];
    if (m && m.key === key) {
      m.to = d.to;
      m.days += d.days;
      m.high = Math.max(m.high, d.high);
      m.low = Math.min(m.low, d.low);
      m.close = d.close;
      m.value = round(m.close - m.open);
      m.net = m.net == null && d.net == null ? null : round((m.net ?? 0) + (d.net ?? 0));
      m.gross = m.gross == null && d.gross == null ? null : round((m.gross ?? 0) + (d.gross ?? 0));
      m.fees = round(m.fees + d.fees);
      m.trades += d.trades; m.wins += d.wins; m.losses += d.losses; m.be += d.be;
      m.winRate = m.wins + m.losses ? m.wins / (m.wins + m.losses) : null;
      m.peakIn = round(m.high - m.open);
      m.troughIn = round(m.low - m.open);
      if (d.best && (!m.best || d.best.value > m.best.value)) m.best = d.best;
      if (d.worst && (!m.worst || d.worst.value < m.worst.value)) m.worst = d.worst;
      m.timeOrdered = m.timeOrdered && d.timeOrdered;
      m.drawdown = Math.min(m.drawdown, d.drawdown);
      m.closeDrawdown = d.closeDrawdown;
    } else {
      out.push({ ...d, key });
    }
  }
  return out;
}

export function aggregate(days: EquityCandle[], agg: EquityAgg): EquityCandle[] {
  if (agg === "week") return toWeekCandles(days);
  if (agg === "month") return toMonthCandles(days);
  return days;
}

/** Bucket key of a trading date for an aggregation (day itself / Monday / 1st of the month). */
export function bucketKey(date: string, agg: EquityAgg): string {
  return agg === "week" ? weekStart(date) : agg === "month" ? monthStart(date) : date;
}

/** Derived series the renderer needs: running peak, underwater curve and the landmark candles. */
export interface EquityDerived {
  /** Running high-water mark of the close (starts at 0). */
  peak: number[];
  /** close − peak (≤ 0). */
  underwater: number[];
  best: number;
  worst: number;
  /** Index of the deepest underwater close (−1 when never below the peak). */
  trough: number;
  maxDrawdown: number;
}

export function derive(bars: EquityCandle[]): EquityDerived {
  const peak: number[] = [];
  const underwater: number[] = [];
  let p = 0, best = -1, worst = -1, trough = -1, dd = 0;
  bars.forEach((b, i) => {
    p = Math.max(p, b.close);
    peak.push(p);
    const u = round(Math.min(0, b.close - p));
    underwater.push(u);
    if (u < dd) { dd = u; trough = i; }
    if (best < 0 || b.value > bars[best].value) best = i;
    if (worst < 0 || b.value < bars[worst].value) worst = i;
  });
  // A best day that lost money / a worst day that made money is not a landmark.
  if (best >= 0 && bars[best].value <= 0) best = -1;
  if (worst >= 0 && bars[worst].value >= 0) worst = -1;
  return { peak, underwater, best, worst, trough, maxDrawdown: dd };
}

/** Stats of an index window [i0, i1] (inclusive): result, green / red, max drawdown measured inside the window. */
export interface WindowStats {
  from: string;
  to: string;
  result: number;
  bars: number;
  green: number;
  red: number;
  trades: number;
  wins: number;
  losses: number;
  fees: number;
  maxDrawdown: number;
  best: EquityCandle | null;
  worst: EquityCandle | null;
}

export function windowStats(bars: EquityCandle[], i0: number, i1: number): WindowStats | null {
  const a = Math.max(0, Math.min(i0, i1));
  const b = Math.min(bars.length - 1, Math.max(i0, i1));
  if (!bars.length || a > b) return null;
  let green = 0, red = 0, trades = 0, wins = 0, losses = 0, fees = 0, dd = 0;
  let best: EquityCandle | null = null, worst: EquityCandle | null = null;
  let peak = bars[a].open;
  for (let i = a; i <= b; i++) {
    const c = bars[i];
    if (c.value > 0) green++;
    else if (c.value < 0) red++;
    trades += c.trades; wins += c.wins; losses += c.losses; fees += c.fees;
    peak = Math.max(peak, c.close);
    dd = Math.min(dd, c.close - peak);
    if (!best || c.value > best.value) best = c;
    if (!worst || c.value < worst.value) worst = c;
  }
  return {
    from: bars[a].from, to: bars[b].to, result: round(bars[b].close - bars[a].open), bars: b - a + 1,
    green, red, trades, wins, losses, fees: round(fees), maxDrawdown: round(dd), best, worst,
  };
}
