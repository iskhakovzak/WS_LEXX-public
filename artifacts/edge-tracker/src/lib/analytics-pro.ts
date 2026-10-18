import type { Trade } from "@workspace/api-client-react";
import { signedR, priceR, netPnl, isOpen, closeDate, resultOf } from "@/lib/trade-math";
import { fmtDate, fmtMonth, fmtWeekday } from "@/lib/format";
import { analyticsProI18n } from "@/i18n/ns/analyticsPro";

export type TimeBucket =
  | "before-8:30"
  | "8:30-9:30"
  | "9:30-9:50"
  | "9:50-10:10"
  | "10:10-11:15"
  | "11:15-13:30"
  | "13:30-15:30"
  | "15:30-16:00"
  | "after-16:00"
  | "unknown";

/** Entry-time buckets; ids are stable codes (filters, URL), labels are read at call time (UI language). */
export const TIME_BUCKETS: { id: TimeBucket; readonly label: string }[] = [
  { id: "before-8:30", get label() { return analyticsProI18n.t("time.before"); } },
  { id: "8:30-9:30", label: "8:30–9:30" },
  { id: "9:30-9:50", label: "9:30–9:50" },
  { id: "9:50-10:10", label: "9:50–10:10" },
  { id: "10:10-11:15", label: "10:10–11:15" },
  { id: "11:15-13:30", label: "11:15–13:30" },
  { id: "13:30-15:30", label: "13:30–15:30" },
  { id: "15:30-16:00", label: "15:30–16:00" },
  { id: "after-16:00", get label() { return analyticsProI18n.t("time.after"); } },
  { id: "unknown", get label() { return analyticsProI18n.t("time.unknown"); } },
];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Weekday filter options Mon…Sun ("Пн"); id = Date#getDay(). Built at call time (follows the UI language). */
export function dayOfWeekOptions(): { id: string; label: string }[] {
  return [1, 2, 3, 4, 5, 6, 0].map((d) => ({ id: String(d), label: cap(fmtWeekday(d, "short")) }));
}
/** Month filter options ("Янв."); id = 1…12. Built at call time (follows the UI language). */
export function monthOptions(): { id: string; label: string }[] {
  return Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), label: cap(fmtMonth(i, "short")) }));
}

export function dateOnly(d: string): string {
  return (d ?? "").substring(0, 10);
}

function parseDate(d: string): Date | null {
  if (!d) return null;
  const dt = new Date(d.length <= 10 ? `${d}T00:00:00` : d);
  return isNaN(dt.getTime()) ? null : dt;
}

export function timeBucketFor(t: Trade): TimeBucket {
  const raw = t.date ?? "";
  if (raw.length <= 10) return "unknown";
  const dt = parseDate(raw);
  if (!dt) return "unknown";
  const hour = dt.getHours();
  const min = dt.getMinutes();
  const m = hour * 60 + min;
  if (m < 8 * 60 + 30) return "before-8:30";
  if (m < 9 * 60 + 30) return "8:30-9:30";
  if (m < 9 * 60 + 50) return "9:30-9:50";
  if (m < 10 * 60 + 10) return "9:50-10:10";
  if (m < 11 * 60 + 15) return "10:10-11:15";
  if (m < 13 * 60 + 30) return "11:15-13:30";
  if (m < 15 * 60 + 30) return "13:30-15:30";
  if (m < 16 * 60) return "15:30-16:00";
  return "after-16:00";
}

export function dayOfWeek(t: Trade): number {
  const dt = parseDate(t.date ?? "");
  return dt ? dt.getDay() : -1;
}

export function yearOf(t: Trade): string {
  return dateOnly(t.date ?? "").substring(0, 4) || "—";
}

export function monthOf(t: Trade): string {
  const m = dateOnly(t.date ?? "").substring(5, 7);
  return m ? String(parseInt(m, 10)) : "—";
}

export function tagsOf(t: Trade): string[] {
  return (t.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Net P&L (gross − fees) as a number, 0 when unknown. */
export function pnlOf(t: Trade): number {
  return pnlValue(t) ?? 0;
}

/** Day the result is realised (exit date for multi-day holds, else the trade date). */
export function closeKey(t: Trade): string {
  return dateOnly(closeDate(t) ?? "");
}

/** Chronological by close date, then entry date, creation time and id — same ordering as the Overview tab. */
export function chrono(trades: Trade[]): Trade[] {
  return [...trades].sort((a, b) =>
    closeKey(a).localeCompare(closeKey(b)) || (a.date ?? "").localeCompare(b.date ?? "")
    || (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || (a.id ?? 0) - (b.id ?? 0));
}

/* ── Metric: money (net P&L) or R-multiples — all from @/lib/trade-math ───── */

export type Metric = "pnl" | "r";
/** Per-trade value getter: number when the trade has a value in this metric, else null. */
export type ValueFn = (t: Trade) => number | null;

/** Net P&L (gross − |fees|), or null when the trade has no P&L recorded or is still open. */
export function pnlValue(t: Trade): number | null {
  return isOpen(t) ? null : netPnl(t);
}

/** R computed from prices (side-aware); null without entry/exit/stop. */
export function realizedR(t: Trade): number | null {
  const r = priceR(t);
  return r == null ? null : Math.round(r * 100) / 100;
}

/** Signed R for a trade — the shared definition (stored R signed by result → price R → pnl/risk). */
export function rOf(t: Trade): number | null {
  return signedR(t);
}

export function valueFnFor(metric: Metric): ValueFn {
  return metric === "r" ? rOf : pnlValue;
}

/** Pick a sensible default metric: money when any trade has P&L, otherwise R. */
export function autoMetric(trades: Trade[]): Metric {
  if (trades.some((t) => t.pnl != null)) return "pnl";
  if (trades.some((t) => rOf(t) != null)) return "r";
  return "pnl";
}

export type Filters = {
  accounts: string[];
  symbols: string[];
  years: string[];
  months: string[];
  daysOfWeek: string[];
  timeBuckets: TimeBucket[];
  strategies: string[];
  types: string[];
  globalTags: string[];
  personalTags: string[];
};

export const EMPTY_FILTERS: Filters = {
  accounts: [], symbols: [], years: [], months: [], daysOfWeek: [],
  timeBuckets: [], strategies: [], types: [], globalTags: [], personalTags: [],
};

const FILTER_KEYS = [
  "accounts","symbols","years","months","daysOfWeek","timeBuckets",
  "strategies","types","globalTags","personalTags",
] as const;
export type FilterKey = typeof FILTER_KEYS[number];

const PREDS: Record<FilterKey, (t: Trade) => string[]> = {
  accounts: (t) => [t.trader ?? "—"],
  symbols: (t) => [t.ticker ?? "—"],
  years: (t) => [yearOf(t)],
  months: (t) => [monthOf(t)],
  daysOfWeek: (t) => [String(dayOfWeek(t))],
  timeBuckets: (t) => [timeBucketFor(t)],
  strategies: (t) => [t.setup ?? "—"],
  types: (t) => [t.side ?? "—"],
  globalTags: (t) => tagsOf(t),
  personalTags: (t) => tagsOf(t),
};

function passesGroup(t: Trade, key: FilterKey, sel: string[]): boolean {
  if (!sel.length) return true;
  const vals = PREDS[key](t);
  return vals.some((v) => sel.includes(v));
}

export function applyFilters(trades: Trade[], filters: Filters): Trade[] {
  return trades.filter((t) =>
    FILTER_KEYS.every((k) => passesGroup(t, k, filters[k] as string[]))
  );
}

export function applyFiltersExcept(trades: Trade[], filters: Filters, exclude: FilterKey): Trade[] {
  return trades.filter((t) =>
    FILTER_KEYS.every((k) => k === exclude || passesGroup(t, k, filters[k] as string[]))
  );
}

export function optionContribution(
  trades: Trade[],
  filters: Filters,
  key: FilterKey,
  optionId: string,
  val: ValueFn = pnlValue,
): { net: number; count: number } {
  const base = applyFiltersExcept(trades, filters, key);
  const subset = base.filter((t) => PREDS[key](t).includes(optionId));
  return { net: subset.reduce((s, t) => s + (val(t) ?? 0), 0), count: subset.length };
}

export type DaySummary = {
  date: string;
  net: number;
  trades: number;
  wins: number;
  losses: number;
  tickers: string[];
  /** Trades of the day that have a value in the active metric. */
  valued?: number;
};

export function groupByDay(trades: Trade[], val: ValueFn = pnlValue): DaySummary[] {
  const map = new Map<string, DaySummary>();
  for (const t of trades) {
    const d = closeKey(t);
    if (!d) continue;
    let row = map.get(d);
    if (!row) {
      row = { date: d, net: 0, trades: 0, wins: 0, losses: 0, tickers: [], valued: 0 };
      map.set(d, row);
    }
    const v = val(t);
    row.net += v ?? 0;
    if (v != null) row.valued = (row.valued ?? 0) + 1;
    row.trades += 1;
    const res = resultOf(t);
    if (res === "win") row.wins += 1;
    if (res === "loss") row.losses += 1;
    if (t.ticker && !row.tickers.includes(t.ticker)) row.tickers.push(t.ticker);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function isoWeekKey(d: Date): string {
  // Monday-based week, returning year-week token.
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((+tmp - +yearStart) / 86400000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function mondayOf(d: Date): Date {
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
  return m;
}

/**
 * Mon–Sun range in the UI language: «13 окт. – 19 окт.» / "Oct 13 – Oct 19" / «13-okt – 19-okt»;
 * with `year` the end carries it: «… – 19 окт. 2026 г.» / "… – Oct 19, 2026" / «… – 19-okt, 2026».
 */
export function fmtWeekRange(monday: Date, opts: { year?: boolean } = {}): string {
  const sun = new Date(monday); sun.setDate(monday.getDate() + 6);
  return `${fmtDate(monday, "dayMonth")} – ${fmtDate(sun, opts.year ? "medium" : "dayMonth")}`;
}

/** Week range without the year (recent weeks). Kept for callers of the old name. */
export function fmtRange(monday: Date): string {
  return fmtWeekRange(monday);
}

/** ISO week key "2026-W42" → «12 окт. – 18 окт. 2026 г.» (Monday of that ISO week); other strings unchanged. */
export function fmtIsoWeekKey(key: string): string {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(key);
  if (!m) return key;
  const jan4 = new Date(Number(m[1]), 0, 4);
  const week1Monday = mondayOf(jan4);
  const monday = new Date(week1Monday.getFullYear(), week1Monday.getMonth(), week1Monday.getDate() + (Number(m[2]) - 1) * 7);
  return fmtWeekRange(monday, { year: true });
}

export type WeekSummary = {
  label: string;
  range: string;
  totalNet: number;
  totalVolume: number | null;
  tradingDays: number;
  avgDayNet: number | null;
  profitDays: number;
  avgProfitNet: number | null;
  lossDays: number;
  avgLossNet: number | null;
};

function summarizeWeek(label: string, monday: Date, days: DaySummary[]): WeekSummary {
  const sun = new Date(monday); sun.setDate(monday.getDate() + 6);
  const startStr = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
  const endStr = `${sun.getFullYear()}-${String(sun.getMonth() + 1).padStart(2, "0")}-${String(sun.getDate()).padStart(2, "0")}`;
  const within = days.filter((d) => d.date >= startStr && d.date <= endStr);
  const profit = within.filter((d) => d.net > 0);
  const loss = within.filter((d) => d.net < 0);
  const totalNet = within.reduce((s, d) => s + d.net, 0);
  return {
    label,
    range: fmtRange(monday),
    totalNet,
    totalVolume: null,
    tradingDays: within.length,
    avgDayNet: within.length ? totalNet / within.length : null,
    profitDays: profit.length,
    avgProfitNet: profit.length ? profit.reduce((s, d) => s + d.net, 0) / profit.length : null,
    lossDays: loss.length,
    avgLossNet: loss.length ? loss.reduce((s, d) => s + d.net, 0) / loss.length : null,
  };
}

export function buildWeeklySummaries(days: DaySummary[], now: Date = new Date()): WeekSummary[] {
  const cur = mondayOf(now);
  const prev = new Date(cur); prev.setDate(cur.getDate() - 7);
  const prev2 = new Date(cur); prev2.setDate(cur.getDate() - 14);
  return [
    summarizeWeek(analyticsProI18n.t("week.current"), cur, days),
    summarizeWeek(analyticsProI18n.t("week.previous"), prev, days),
    summarizeWeek(analyticsProI18n.t("week.beforePrevious"), prev2, days),
  ];
}

function maxStreak(arr: number[], positive: boolean): number {
  let best = 0, cur = 0;
  for (const v of arr) {
    const ok = positive ? v > 0 : v < 0;
    if (ok) { cur++; if (cur > best) best = cur; } else cur = 0;
  }
  return best;
}

export type OhlcTotals = {
  totalNet: number;
  totalGross: number | null;
  totalVolume: number | null;
  netPerShare: number | null;
  netPerDay: number | null;
  lossDays: number;
  maxDayLoss: number;
  avgDayLoss: number | null;
  profitDays: number;
  avgDayProfit: number | null;
  maxDayProfit: number;
  totalDays: number;
  /** W/(W+L) as a fraction; null when there are no decided trades (shown as «—», never 0%). */
  winPct: number | null;
  lossPct: number | null;
  maxLossDaysRow: number;
  maxProfitDaysRow: number;
  maxLossWeekRow: number;
  maxProfitWeekRow: number;
  maxLossMonthRow: number;
  maxProfitMonthRow: number;
  avgHighFixRate: number | null;
  bestTrade: { value: number; date: string; ticker: string } | null;
  bestDay: { value: number; date: string; tickers: string[] } | null;
  bestWeek: { value: number; range: string } | null;
  bestMonth: { value: number; key: string } | null;
};

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(it);
  }
  return m;
}

export function computeOhlc(trades: Trade[], days: DaySummary[], val: ValueFn = pnlValue): OhlcTotals {
  const tradesWithPnl = trades.filter((t) => val(t) != null);
  const totalNet = tradesWithPnl.reduce((s, t) => s + (val(t) ?? 0), 0);
  const hasPnl = tradesWithPnl.length > 0;
  const profit = days.filter((d) => d.net > 0);
  const loss = days.filter((d) => d.net < 0);
  const dayNets = days.map((d) => d.net);
  const wins = tradesWithPnl.filter((t) => resultOf(t) === "win").length;
  const losses = tradesWithPnl.filter((t) => resultOf(t) === "loss").length;
  const totalDays = days.length;

  const weekMap = groupBy(days, (d) => isoWeekKey(new Date(`${d.date}T00:00:00`)));
  const weekNets = [...weekMap.entries()].map(([k, ds]) => ({ k, net: ds.reduce((s, d) => s + d.net, 0) }));
  const monthMap = groupBy(days, (d) => d.date.substring(0, 7));
  const monthNets = [...monthMap.entries()].map(([k, ds]) => ({ k, net: ds.reduce((s, d) => s + d.net, 0) }));

  const bestTradeT = tradesWithPnl.reduce<Trade | null>(
    (best, t) => (best == null || (val(t) ?? 0) > (val(best) ?? 0) ? t : best), null);
  const bestDay = days.reduce<DaySummary | null>(
    (best, d) => (best == null || d.net > best.net ? d : best), null);
  const bestWeek = weekNets.reduce<{ k: string; net: number } | null>(
    (best, w) => (best == null || w.net > best.net ? w : best), null);
  const bestMonth = monthNets.reduce<{ k: string; net: number } | null>(
    (best, m) => (best == null || m.net > best.net ? m : best), null);

  // High fix rate: share of profit days where day net >= 50% of running max single-day profit.
  const maxDayProfit = profit.reduce((m, d) => Math.max(m, d.net), 0);
  const avgHighFixRate = profit.length && maxDayProfit > 0
    ? profit.filter((d) => d.net >= maxDayProfit * 0.5).length / profit.length
    : null;

  return {
    totalNet,
    totalGross: null,
    totalVolume: null,
    netPerShare: null,
    netPerDay: totalDays ? totalNet / totalDays : null,
    lossDays: loss.length,
    maxDayLoss: loss.reduce((m, d) => Math.min(m, d.net), 0),
    avgDayLoss: loss.length ? loss.reduce((s, d) => s + d.net, 0) / loss.length : null,
    profitDays: profit.length,
    avgDayProfit: profit.length ? profit.reduce((s, d) => s + d.net, 0) / profit.length : null,
    maxDayProfit,
    totalDays,
    winPct: wins + losses ? wins / (wins + losses) : null,
    lossPct: wins + losses ? losses / (wins + losses) : null,
    maxLossDaysRow: maxStreak(dayNets, false),
    maxProfitDaysRow: maxStreak(dayNets, true),
    maxLossWeekRow: maxStreak(weekNets.map((w) => w.net), false),
    maxProfitWeekRow: maxStreak(weekNets.map((w) => w.net), true),
    maxLossMonthRow: maxStreak(monthNets.map((m) => m.net), false),
    maxProfitMonthRow: maxStreak(monthNets.map((m) => m.net), true),
    avgHighFixRate,
    bestTrade: bestTradeT
      ? { value: val(bestTradeT) ?? 0, date: dateOnly(bestTradeT.date), ticker: bestTradeT.ticker }
      : null,
    // Without any PnL every day/week/month nets to 0 — "best" would be an arbitrary $0 entry.
    bestDay: bestDay && hasPnl ? { value: bestDay.net, date: bestDay.date, tickers: bestDay.tickers.slice(0, 6) } : null,
    bestWeek: bestWeek && hasPnl ? { value: bestWeek.net, range: bestWeek.k } : null,
    bestMonth: bestMonth && hasPnl ? { value: bestMonth.net, key: bestMonth.k } : null,
  };
}

export type ClosureStats = {
  stopLossOpenings: number;
  closedPositive: number;
  closedFlat: number;
  closedNegative: number;
  lostThreePlusInRow: number;
};

export function computeClosureStats(trades: Trade[], val: ValueFn = pnlValue): ClosureStats {
  const withPnl = trades.filter((t) => val(t) != null);
  let stopOpenings = 0;
  let pos = 0, flat = 0, neg = 0;
  for (const t of trades) {
    if (t.stop != null) stopOpenings += 1;
  }
  for (const t of withPnl) {
    const p = val(t) ?? 0;
    if (p > 0) pos += 1;
    else if (p < 0) neg += 1;
    else flat += 1;
  }
  // Series of 3+ losses (consecutive losses by chronological order).
  const sorted = chrono(trades);
  let lossStreaks3plus = 0;
  let cur = 0;
  for (const t of sorted) {
    if (isOpen(t)) continue;
    const v = val(t);
    if (resultOf(t) === "loss" || (v != null && v < 0)) {
      cur += 1;
      if (cur === 3) lossStreaks3plus += 1;
    } else {
      cur = 0;
    }
  }
  return { stopLossOpenings: stopOpenings, closedPositive: pos, closedFlat: flat, closedNegative: neg, lostThreePlusInRow: lossStreaks3plus };
}

export type DayPnlPoint = { date: string; net: number; cum: number };

export function buildDailyPnl(days: DaySummary[]): DayPnlPoint[] {
  let cum = 0;
  return days.map((d) => { cum += d.net; return { date: d.date, net: d.net, cum }; });
}

export type OhlcCandle = {
  time: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // trade count for the day
};

/** Build per-day OHLC candles of *cumulative equity*, with intraday wicks
 *  approximated by the running max/min reached as trades close in id order. */
export function buildOhlcCandles(trades: Trade[], val: ValueFn = pnlValue): OhlcCandle[] {
  const withDate = chrono(trades.filter((t) => closeKey(t)));
  const out: OhlcCandle[] = [];
  let cum = 0;
  let curDate: string | null = null;
  let open = 0, high = 0, low = 0, vol = 0;
  const flush = () => {
    if (curDate == null) return;
    out.push({ time: curDate, open, high, low, close: cum, volume: vol });
  };
  for (const t of withDate) {
    const d = closeKey(t);
    if (d !== curDate) {
      flush();
      curDate = d;
      open = cum;
      high = cum;
      low = cum;
      vol = 0;
    }
    cum += val(t) ?? 0;
    if (cum > high) high = cum;
    if (cum < low) low = cum;
    vol += 1;
  }
  flush();
  return out;
}

export type GroupBreakdown = {
  key: string;
  label: string;
  profit: number;
  loss: number;
  net: number;
  count: number;
};

export function buildGroupBreakdown(
  trades: Trade[],
  bucket: (t: Trade) => { id: string; label: string },
  val: ValueFn = pnlValue,
): GroupBreakdown[] {
  const map = new Map<string, GroupBreakdown>();
  for (const t of trades) {
    const { id, label } = bucket(t);
    let row = map.get(id);
    if (!row) { row = { key: id, label, profit: 0, loss: 0, net: 0, count: 0 }; map.set(id, row); }
    const p = val(t) ?? 0;
    row.net += p;
    row.count += 1;
    if (p >= 0) row.profit += p; else row.loss += p;
  }
  return [...map.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
}

/* ── Edge stats (per-trade) ───────────────────────────────────────────────── */

export type EdgeStats = {
  /** Trades that have a value in the active metric. */
  count: number;
  total: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** Average value per trade. */
  expectancy: number | null;
  profitFactor: number | null;
  /** Largest peak-to-trough drop of the cumulative curve (≤ 0). */
  maxDrawdown: number;
  /** Current streak of green (+) / red (−) trading days, newest first. */
  dayStreak: { kind: "up" | "down" | "flat"; length: number };
};

export function computeEdgeStats(trades: Trade[], days: DaySummary[], val: ValueFn = pnlValue): EdgeStats {
  const vals: number[] = [];
  let resWins = 0, resLosses = 0;
  for (const t of chrono(trades)) {
    const v = val(t);
    if (v == null) continue;
    vals.push(v);
    const res = resultOf(t);
    if (res === "win") resWins++;
    else if (res === "loss") resLosses++;
  }
  const winsArr = vals.filter((v) => v > 0);
  const lossArr = vals.filter((v) => v < 0);
  const sumW = winsArr.reduce((s, v) => s + v, 0);
  const sumL = lossArr.reduce((s, v) => s + v, 0);
  let cum = 0, peak = 0, mdd = 0;
  for (const v of vals) {
    cum += v;
    if (cum > peak) peak = cum;
    if (cum - peak < mdd) mdd = cum - peak;
  }
  let streak: EdgeStats["dayStreak"] = { kind: "flat", length: 0 };
  const valuedDays = days.filter((d) => (d.valued ?? d.trades) > 0);
  for (let i = valuedDays.length - 1; i >= 0; i--) {
    const k = valuedDays[i].net > 0 ? "up" : valuedDays[i].net < 0 ? "down" : "flat";
    if (streak.length === 0) streak = { kind: k, length: 1 };
    else if (streak.kind === k) streak.length += 1;
    else break;
  }
  return {
    count: vals.length,
    total: cum,
    wins: resWins,
    losses: resLosses,
    // Result-based: W / (W + L), break-even excluded — the shared desk definition.
    winRate: resWins + resLosses ? resWins / (resWins + resLosses) : null,
    avgWin: winsArr.length ? sumW / winsArr.length : null,
    avgLoss: lossArr.length ? sumL / lossArr.length : null,
    expectancy: vals.length ? cum / vals.length : null,
    profitFactor: sumL < 0 ? sumW / Math.abs(sumL) : null,
    maxDrawdown: mdd,
    dayStreak: streak,
  };
}

/* ── Period extremes: best / worst day, week, month ───────────────────────── */

export type PeriodPoint = {
  /** Day: YYYY-MM-DD · week: YYYY-MM-DD of Monday · month: YYYY-MM */
  key: string;
  label: string;
  net: number;
  trades: number;
};

export type PeriodExtremes = {
  bestDay: PeriodPoint | null; worstDay: PeriodPoint | null;
  bestWeek: PeriodPoint | null; worstWeek: PeriodPoint | null;
  bestMonth: PeriodPoint | null; worstMonth: PeriodPoint | null;
};

/** "Октябрь" (capitalised month name in the UI language); `i` = 0…11. */
export function monthName(i: number): string {
  return cap(fmtMonth(i, "long"));
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function fmtMonthKey(key: string): string {
  const [y, m] = key.split("-");
  const i = Number(m) - 1;
  return i >= 0 && i < 12 ? cap(fmtDate(new Date(Number(y), i, 1), "monthYear")) : key;
}

function aggregate(days: DaySummary[], keyOf: (d: DaySummary) => string): Map<string, { net: number; trades: number; valued: number }> {
  const m = new Map<string, { net: number; trades: number; valued: number }>();
  for (const d of days) {
    const k = keyOf(d);
    const row = m.get(k) ?? { net: 0, trades: 0, valued: 0 };
    row.net += d.net;
    row.trades += d.trades;
    row.valued += d.valued ?? d.trades;
    m.set(k, row);
  }
  return m;
}

export function weekStartKey(date: string): string {
  return ymd(mondayOf(new Date(`${date}T00:00:00`)));
}

export function computePeriodExtremes(days: DaySummary[]): PeriodExtremes {
  const pick = (pts: PeriodPoint[]) => {
    if (!pts.length) return { best: null, worst: null };
    let best = pts[0], worst = pts[0];
    for (const p of pts) { if (p.net > best.net) best = p; if (p.net < worst.net) worst = p; }
    return { best: best.net > 0 ? best : null, worst: worst.net < 0 ? worst : null };
  };
  const dayPts: PeriodPoint[] = days
    .filter((d) => (d.valued ?? d.trades) > 0)
    .map((d) => ({ key: d.date, label: fmtDate(d.date, "long"), net: d.net, trades: d.trades }));
  const weekPts: PeriodPoint[] = [...aggregate(days, (d) => weekStartKey(d.date)).entries()]
    .filter(([, v]) => v.valued > 0)
    .map(([k, v]) => ({ key: k, label: fmtWeekRange(new Date(`${k}T00:00:00`), { year: true }), net: v.net, trades: v.trades }));

  const monthPts: PeriodPoint[] = [...aggregate(days, (d) => d.date.substring(0, 7)).entries()]
    .filter(([, v]) => v.valued > 0)
    .map(([k, v]) => ({ key: k, label: fmtMonthKey(k), net: v.net, trades: v.trades }));
  const d = pick(dayPts), w = pick(weekPts), mo = pick(monthPts);
  return {
    bestDay: d.best, worstDay: d.worst,
    bestWeek: w.best, worstWeek: w.worst,
    bestMonth: mo.best, worstMonth: mo.worst,
  };
}

/* ── Calendar grids ───────────────────────────────────────────────────────── */

/** Weeks (Mon–Sun) covering a month; cells outside the month are null. month is 0-based. */
export function monthMatrix(year: number, month: number): (string | null)[][] {
  const first = new Date(year, month, 1);
  const start = mondayOf(first);
  const weeks: (string | null)[][] = [];
  const cur = new Date(start);
  while (true) {
    const week: (string | null)[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(cur.getMonth() === month && cur.getFullYear() === year ? ymd(cur) : null);
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
    if (cur.getFullYear() > year || (cur.getFullYear() === year && cur.getMonth() > month)) break;
  }
  return weeks;
}
