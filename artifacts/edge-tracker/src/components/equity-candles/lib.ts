/**
 * Equity curve as candles (pure functions, no React / DOM).
 *
 * One candle = one trading day (or week) of the cumulative result:
 *   open  = cumulative at the start of the day,
 *   close = cumulative at the end of the day,
 *   high / low = the best / worst point the cumulative curve reached inside the day (the wicks).
 *
 * Intraday order: trades are walked in the order they were closed (PropReports `contextSnapshot.closedAt`,
 * ET wall time "2026-10-15T15:59:16"); without times — by trade id (the order they were booked).
 * Money is net by default (net = gross − |fees|, @/lib/trade-math); the day is the close date (NY trading date).
 */
import { closeDate, feesOf, grossPnl, isOpen, netPnl, resultOf, signedR, type TradeLike } from "@/lib/trade-math";
import { addDays, nyDate } from "@/lib/trading-date";
import { dayHref } from "@/lib/period-links";
import { fmtDate, fmtR, fmtUsd, fmtWeekday } from "@/lib/format";

export type EquityUnit = "net" | "gross" | "r";
export type EquityAgg = "day" | "week";
export type EquityPeriod = "1m" | "3m" | "ytd" | "all";

/** Loose trade input: api-client `Trade` and raw JSON both fit. */
export interface EquityTradeInput extends TradeLike {
  id?: number | null;
  ticker?: string | null;
  trader?: string | null;
  contextSnapshot?: unknown;
}

export interface TradeBrief { id: number | null; ticker: string; value: number }

export interface EquityCandle {
  /** Candle key: the trading date (day) or the Monday of the week (week). */
  key: string;
  /** First / last trading date inside the candle. */
  from: string;
  to: string;
  /** Trading days inside the candle (1 for a day candle). */
  days: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Result of the candle in the chosen unit (close − open). */
  value: number;
  /** $ figures (null when the unit is R or no $ data). */
  net: number | null;
  gross: number | null;
  fees: number;
  trades: number;
  wins: number;
  losses: number;
  be: number;
  /** W / (W + L); null without decided trades. */
  winRate: number | null;
  /** Best / worst point of the candle relative to its open (≥ 0 / ≤ 0). */
  peakIn: number;
  troughIn: number;
  best: TradeBrief | null;
  worst: TradeBrief | null;
  /** Deepest drawdown inside the candle from the running peak of the cumulative curve (≤ 0, intraday-accurate). */
  drawdown: number;
  /** Close minus the running peak (≤ 0): how far below the high-water mark the candle ended. */
  closeDrawdown: number;
  /** True when every trade of the candle had a close time (real intraday order). */
  timeOrdered: boolean;
}

export interface EquitySummary {
  total: number;
  candles: number;
  green: number;
  red: number;
  maxDrawdown: number;
  best: EquityCandle | null;
  worst: EquityCandle | null;
  trades: number;
  fees: number;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Sortable close-time key: snapshot `closedAt` (ET wall time or ISO). Null when unknown. */
export function closeTimeKey(t: EquityTradeInput): string | null {
  const snap = t.contextSnapshot && typeof t.contextSnapshot === "object" ? (t.contextSnapshot as Record<string, unknown>) : null;
  return str(snap?.closedAt) ?? str((t as Record<string, unknown>).closedAt);
}

/** Value of one closed trade in the unit; null when it can't be counted (open, no P&L / R). */
export function tradeValue(t: EquityTradeInput, unit: EquityUnit): number | null {
  if (isOpen(t)) return null;
  if (unit === "r") return signedR(t);
  return unit === "gross" ? grossPnl(t) : netPnl(t);
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Monday (YYYY-MM-DD) of the week that contains `date`. */
export function weekStart(date: string): string {
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

type Row = { t: EquityTradeInput; v: number; day: string; tk: string | null; id: number };

/** Daily candles in chronological order (only days with at least one counted trade). */
export function buildDayCandles(trades: EquityTradeInput[], unit: EquityUnit = "net"): EquityCandle[] {
  const rows: Row[] = [];
  for (const t of trades) {
    const v = tradeValue(t, unit);
    const day = closeDate(t);
    if (v == null || !day) continue;
    rows.push({ t, v, day: day.slice(0, 10), tk: closeTimeKey(t), id: typeof t.id === "number" ? t.id : Number.MAX_SAFE_INTEGER });
  }
  const byDay = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byDay.get(r.day);
    if (list) list.push(r);
    else byDay.set(r.day, [r]);
  }
  const days = [...byDay.keys()].sort();
  const out: EquityCandle[] = [];
  let cum = 0;
  let peak = 0;
  for (const day of days) {
    const list = byDay.get(day)!;
    // Timed trades first in close-time order, then the rest by id (the order they were booked).
    list.sort((a, b) => {
      if (a.tk && b.tk) return a.tk.localeCompare(b.tk) || a.id - b.id;
      if (a.tk) return -1;
      if (b.tk) return 1;
      return a.id - b.id;
    });
    const open = cum;
    let hi = open, lo = open;
    let wins = 0, losses = 0, be = 0, fees = 0, gross = 0, net = 0, hasUsd = false;
    let best: TradeBrief | null = null, worst: TradeBrief | null = null;
    let dd = Math.min(0, open - peak);
    for (const r of list) {
      cum = round(cum + r.v);
      if (cum > hi) hi = cum;
      if (cum < lo) lo = cum;
      if (cum > peak) peak = cum;
      if (cum - peak < dd) dd = cum - peak;
      const res = resultOf(r.t);
      if (res === "win") wins++;
      else if (res === "loss") losses++;
      else if (res === "be") be++;
      fees += feesOf(r.t);
      const g = grossPnl(r.t);
      if (g != null) { hasUsd = true; gross += g; net += netPnl(r.t)!; }
      const brief = { id: r.id === Number.MAX_SAFE_INTEGER ? null : r.id, ticker: (r.t.ticker ?? "").toUpperCase() || "—", value: r.v };
      if (!best || r.v > best.value) best = brief;
      if (!worst || r.v < worst.value) worst = brief;
    }
    const decided = wins + losses;
    out.push({
      key: day, from: day, to: day, days: 1,
      open, high: hi, low: lo, close: cum, value: round(cum - open),
      net: hasUsd ? round(net) : null, gross: hasUsd ? round(gross) : null, fees: round(fees),
      trades: list.length, wins, losses, be, winRate: decided ? wins / decided : null,
      peakIn: round(hi - open), troughIn: round(lo - open),
      best, worst,
      drawdown: round(dd),
      closeDrawdown: round(Math.min(0, cum - peak)),
      timeOrdered: list.every((r) => r.tk != null),
    });
  }
  return out;
}

/** Folds day candles into weekly candles (Monday key). */
export function toWeekCandles(days: EquityCandle[]): EquityCandle[] {
  const out: EquityCandle[] = [];
  for (const d of days) {
    const key = weekStart(d.from);
    const w = out[out.length - 1];
    if (w && w.key === key) {
      w.to = d.to;
      w.days += 1;
      w.high = Math.max(w.high, d.high);
      w.low = Math.min(w.low, d.low);
      w.close = d.close;
      w.value = round(w.close - w.open);
      w.net = w.net == null && d.net == null ? null : round((w.net ?? 0) + (d.net ?? 0));
      w.gross = w.gross == null && d.gross == null ? null : round((w.gross ?? 0) + (d.gross ?? 0));
      w.fees = round(w.fees + d.fees);
      w.trades += d.trades; w.wins += d.wins; w.losses += d.losses; w.be += d.be;
      w.winRate = w.wins + w.losses ? w.wins / (w.wins + w.losses) : null;
      w.peakIn = round(w.high - w.open);
      w.troughIn = round(w.low - w.open);
      if (d.best && (!w.best || d.best.value > w.best.value)) w.best = d.best;
      if (d.worst && (!w.worst || d.worst.value < w.worst.value)) w.worst = d.worst;
      w.timeOrdered = w.timeOrdered && d.timeOrdered;
      w.drawdown = Math.min(w.drawdown, d.drawdown);
      w.closeDrawdown = d.closeDrawdown;
    } else {
      out.push({ ...d, key });
    }
  }
  return out;
}

/** First trading date of the period (inclusive) or null for «Всё». */
export function periodStart(period: EquityPeriod, today: string = nyDate()): string | null {
  if (period === "all") return null;
  if (period === "ytd") return `${today.slice(0, 4)}-01-01`;
  const [y, m, d] = today.split("-").map(Number);
  const back = period === "1m" ? 1 : 3;
  const dt = new Date(Date.UTC(y, m - 1 - back, d));
  return dt.toISOString().slice(0, 10);
}

/** Trades whose close date falls inside the period. */
export function filterPeriod<T extends EquityTradeInput>(trades: T[], period: EquityPeriod, today?: string): T[] {
  const from = periodStart(period, today);
  if (!from) return trades;
  return trades.filter((t) => (closeDate(t) ?? "") >= from);
}

export function buildCandles(trades: EquityTradeInput[], opts: { unit?: EquityUnit; agg?: EquityAgg } = {}): EquityCandle[] {
  const days = buildDayCandles(trades, opts.unit ?? "net");
  return opts.agg === "week" ? toWeekCandles(days) : days;
}

export function summarize(candles: EquityCandle[]): EquitySummary {
  let green = 0, red = 0, dd = 0, trades = 0, fees = 0;
  let best: EquityCandle | null = null, worst: EquityCandle | null = null;
  for (const c of candles) {
    if (c.value > 0) green++;
    else if (c.value < 0) red++;
    if (c.drawdown < dd) dd = c.drawdown;
    trades += c.trades;
    fees += c.fees;
    if (!best || c.value > best.value) best = c;
    if (!worst || c.value < worst.value) worst = c;
  }
  return { total: candles.at(-1)?.close ?? 0, candles: candles.length, green, red, maxDrawdown: dd, best, worst, trades, fees: round(fees) };
}

/** The only trader of the set, or null when the trades belong to several (or none). */
export function soleTrader(trades: EquityTradeInput[]): string | null {
  let name: string | null = null;
  for (const t of trades) {
    const n = (t.trader ?? "").trim();
    if (!n) continue;
    if (name == null) name = n;
    else if (name !== n) return null;
  }
  return name;
}

/** «Разбор дня» deep link — alias of the shared `dayHref` (lib/period-links). */
export function dayReportHref(date: string, trader?: string | null): string {
  return dayHref(date, trader);
}

// ─── Formatting ───

/** «пятница» (ymd is a calendar date, read as such). */
export function weekdayRu(ymd: string): string {
  return fmtWeekday(ymd, "long");
}

/** «15 октября» / «15 октября 2026 г.» (year only when it differs from the current one). */
export function dateRu(ymd: string, withYear = ymd.slice(0, 4) !== nyDate().slice(0, 4)): string {
  return fmtDate(ymd, withYear ? "long" : "dayMonthLong");
}

/** «13–17 окт.» / «29 сент. – 3 окт.» */
export function rangeRu(from: string, to: string): string {
  if (from === to) return fmtDate(from, "dayMonth");
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}–${fmtDate(to, "dayMonth")}`;
  return `${fmtDate(from, "dayMonth")} – ${fmtDate(to, "dayMonth")}`;
}

export function fmtValue(v: number | null | undefined, unit: EquityUnit, signed = true): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (unit === "r") return fmtR(v, { decimals: Math.abs(v) >= 100 ? 0 : 2, signed });
  return fmtUsd(v, { signed });
}

/** Compact axis label: +$1.2K / −$85 / +3.5R. */
export function fmtAxis(v: number, unit: EquityUnit): string {
  if (Math.abs(v) < 1e-9) return unit === "r" ? "0R" : "$0";
  const a = Math.abs(v);
  if (unit === "r") return fmtR(v, { decimals: a >= 10 ? 0 : 1, signed: false });
  return fmtUsd(v, { compact: true, decimals: a >= 10 ? 0 : 2 });
}
