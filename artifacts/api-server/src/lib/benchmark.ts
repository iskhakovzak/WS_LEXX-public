/**
 * «Бенчмарк деска» — pure metric engine (no DB, no I/O). Fed by routes/benchmark.ts, tested in
 * lib/__tests__/benchmark.test.ts.
 *
 * Inputs are closed journal trades already normalised by the route through lib/tradeMath
 * (net = pnl − |fees|, signed R, canonical result) and dated on the New York trading calendar
 * (close date = exit_date ?? date; entry minute = nyMinutes(first entry fill), lib/tradingDate).
 *
 * Conventions (PHASE2 shared math):
 *   - money is NET unless the field says gross;
 *   - win rate = W / (W + L), break-even excluded;
 *   - profit factor = Σ⁺ / |Σ⁻|, null (never ∞) when there is no losing side;
 *   - R metrics only over trades that have an R (stop / stored R / risk $) — `rCoverage` says how many.
 */
import { benchmarkT } from "../i18n/ns";
import type { Lang } from "../i18n";

// ─── types ──────────────────────────────────────────────────────────────────

export type Result = "win" | "loss" | "be";
export type Side = "long" | "short";

export interface BenchTrade {
  id: number;
  trader: string;
  ticker: string;
  /** NY trading date the result is realised (YYYY-MM-DD). */
  day: string;
  side: Side | null;
  result: Result | null;
  gross: number | null;
  /** |fees| (≥ 0). */
  fees: number;
  net: number | null;
  r: number | null;
  qty: number | null;
  /** Qty-weighted average entry / exit price (fills, else the trade row). */
  entry: number | null;
  exit: number | null;
  /** NY minutes since midnight of the first entry fill (9:30 → 570); null when unknown. */
  entryMin: number | null;
  /** NY minutes of the last exit fill. */
  exitMin: number | null;
  /** Holding time in minutes (fills, else parsed hold_time text). */
  holdMin: number | null;
}

export interface DayPoint { day: string; net: number; cum: number }

export interface DrawdownInfo {
  /** Peak-to-trough depth (≥ 0), in the series unit. */
  maxDd: number;
  peakDay: string | null;
  troughDay: string | null;
  /** First day equity got back to the prior peak; null while still under water. */
  recoveredDay: string | null;
  /** Trading days from trough to recovery (null = not recovered yet). */
  recoveryDays: number | null;
  /** Trading days from the peak to the trough. */
  ddDays: number | null;
  /** Current depth below the running peak (≥ 0). */
  currentDd: number;
}

export interface TraderMetrics {
  trader: string;
  trades: number;
  /** Trades that carry a $ result (pnl present). */
  pnlTrades: number;
  days: number;
  tradesPerDay: number | null;
  wins: number; losses: number; be: number;
  winRate: number | null;
  net: number | null; gross: number | null; fees: number | null;
  /** fees / gross, only when gross > 0 (share of the gross profit eaten by fees). */
  feeShare: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  avgWin: number | null; avgLoss: number | null;
  /** avgWin / |avgLoss|. */
  payoff: number | null;
  bestTrade: number | null; worstTrade: number | null;
  dailyMean: number | null;
  dailyVol: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDd: number | null;
  recoveryDays: number | null;
  ddRecovered: boolean | null;
  ddDays: number | null;
  currentDd: number | null;
  greenDays: number; redDays: number;
  greenShare: number | null;
  bestDay: { day: string; net: number } | null;
  worstDay: { day: string; net: number } | null;
  /** Best day / total net profit (prop-firm consistency rule); null when net ≤ 0. */
  bestDayShare: number | null;
  consistencyFlag: "ok" | "warn" | "breach" | null;
  maxWinStreak: number; maxLossStreak: number;
  /** +n = n wins in a row now, −n = n losses. */
  currentStreak: number;
  avgHoldMin: number | null;
  avgHoldWinMin: number | null; avgHoldLossMin: number | null;
  first15Trades: number;
  first15Share: number | null;
  first15Net: number | null;
  rTrades: number;
  rCoverage: number | null;
  totalR: number | null;
  expectancyR: number | null;
  profitFactorR: number | null;
  firstDay: string | null; lastDay: string | null;
  /** Daily equity: net $ when any $ exists, otherwise cumulative R. */
  equityUnit: "usd" | "r" | null;
  equity: DayPoint[];
}

// ─── small math helpers ─────────────────────────────────────────────────────

const OPEN_MIN = 570; // 9:30 ET
export const FIRST_MINUTES = 15;
export const CONSISTENCY_WARN = 0.3;
export const CONSISTENCY_BREACH = 0.4;
/** Minimum trading days for Sharpe / Sortino / volatility to be shown. */
export const MIN_DAYS_RATIO = 5;
/** k-anonymity for the desk median shown to traders: a metric needs ≥ K traders with a value. */
export const MEDIAN_MIN_TRADERS = 3;

export const r2 = (x: number) => Math.round(x * 100) / 100;
export const r4 = (x: number) => Math.round(x * 10000) / 10000;
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: readonly number[]) => (xs.length ? sum(xs) / xs.length : null);

/** Sample standard deviation (n − 1); null for fewer than 2 points. */
export function stdev(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = sum(xs) / xs.length;
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

/** Annualised Sharpe-like ratio of daily results: mean / sd × √252. Null below `minDays` or with sd = 0. */
export function sharpeRatio(daily: readonly number[], minDays = MIN_DAYS_RATIO): number | null {
  if (daily.length < Math.max(2, minDays)) return null;
  const sd = stdev(daily);
  if (sd == null || !(sd > 0)) return null;
  return (sum(daily) / daily.length / sd) * Math.sqrt(252);
}

/**
 * Annualised Sortino: mean / downside deviation × √252, downside deviation = √(Σ min(0, x)² / n).
 * Null below `minDays` or when there is no losing day (no downside to divide by).
 */
export function sortinoRatio(daily: readonly number[], minDays = MIN_DAYS_RATIO): number | null {
  if (daily.length < Math.max(2, minDays)) return null;
  const dd = Math.sqrt(sum(daily.map((x) => Math.min(0, x) ** 2)) / daily.length);
  if (!(dd > 0)) return null;
  return (sum(daily) / daily.length / dd) * Math.sqrt(252);
}

/** Σ positives / |Σ negatives|; null when there are no negatives (never ∞) or no values. */
export function profitFactor(values: readonly number[]): number | null {
  let pos = 0, neg = 0;
  for (const v of values) { if (v > 0) pos += v; else if (v < 0) neg += v; }
  if (neg === 0) return null;
  return pos / Math.abs(neg);
}

/**
 * Drawdown of the cumulative series built from per-day results (chronological, equity starts at 0).
 * Recovery = first day the equity is back at (or above) the peak preceding the deepest trough.
 */
export function drawdownInfo(points: readonly { day: string; net: number }[]): DrawdownInfo {
  let cum = 0, peak = 0, peakIdx = -1;
  let maxDd = 0, ddPeakIdx = -1, ddTroughIdx = -1;
  for (let i = 0; i < points.length; i++) {
    cum += points[i].net;
    if (cum > peak) { peak = cum; peakIdx = i; }
    const dd = peak - cum;
    if (dd > maxDd) { maxDd = dd; ddPeakIdx = peakIdx; ddTroughIdx = i; }
  }
  const currentDd = peak - cum;
  if (maxDd <= 0 || ddTroughIdx < 0) {
    return { maxDd: 0, peakDay: null, troughDay: null, recoveredDay: null, recoveryDays: null, ddDays: null, currentDd: Math.max(0, currentDd) };
  }
  // equity level at the peak preceding the trough
  let level = 0;
  for (let i = 0; i <= ddPeakIdx; i++) level += points[i].net;
  let c = level;
  for (let i = ddPeakIdx + 1; i <= ddTroughIdx; i++) c += points[i].net;
  let recIdx = -1;
  for (let i = ddTroughIdx + 1; i < points.length; i++) {
    c += points[i].net;
    if (c >= level - 1e-9) { recIdx = i; break; }
  }
  return {
    maxDd,
    peakDay: ddPeakIdx >= 0 ? points[ddPeakIdx].day : null,
    troughDay: points[ddTroughIdx].day,
    recoveredDay: recIdx >= 0 ? points[recIdx].day : null,
    recoveryDays: recIdx >= 0 ? recIdx - ddTroughIdx : null,
    ddDays: ddTroughIdx - (ddPeakIdx >= 0 ? ddPeakIdx : -1),
    currentDd: Math.max(0, currentDd),
  };
}

/** Best day / total net profit; null when total ≤ 0 or no days. */
export function bestDayShare(daily: readonly number[]): number | null {
  if (!daily.length) return null;
  const total = sum(daily);
  if (!(total > 0)) return null;
  return Math.max(...daily) / total;
}

export function consistencyFlag(share: number | null, warn = CONSISTENCY_WARN, breach = CONSISTENCY_BREACH): "ok" | "warn" | "breach" | null {
  if (share == null) return null;
  if (share > breach) return "breach";
  if (share > warn) return "warn";
  return "ok";
}

/** Longest win / loss runs and the current run (+wins / −losses) over results in order. BE breaks a run. */
export function streaks(results: readonly (Result | null)[]): { maxWin: number; maxLoss: number; current: number } {
  let cur = 0, maxWin = 0, maxLoss = 0;
  for (const r of results) {
    if (r === "win") { cur = cur > 0 ? cur + 1 : 1; maxWin = Math.max(maxWin, cur); }
    else if (r === "loss") { cur = cur < 0 ? cur - 1 : -1; maxLoss = Math.max(maxLoss, -cur); }
    else if (r === "be") cur = 0;
  }
  return { maxWin, maxLoss, current: cur };
}

/**
 * Parse the free-text hold_time of the journal into minutes: "5m", "2h 29m", "1:05", "45s", "2часа", "3 мин", "1д".
 * Null when nothing recognisable.
 */
export function parseHoldMinutes(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase().replace(",", ".");
  if (!s) return null;
  const hm = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]) + (hm[3] ? Number(hm[3]) / 60 : 0);
  let total = 0, found = false;
  const re = /(\d+(?:\.\d+)?)\s*(d|д|дн|день|дня|дней|h|hr|hrs|ч|час|часа|часов|m|min|mins|м|мин|минут|минуты|s|sec|с|сек)?/g; // i18n-ignore (parses RU / EN hold-time input)
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (!m[1]) continue;
    const v = Number(m[1]);
    const u = m[2] ?? "m";
    found = true;
    if (/^(d|д)/.test(u)) total += v * 1440; // i18n-ignore (input parsing)
    else if (/^(h|ч)/.test(u)) total += v * 60; // i18n-ignore (input parsing)
    else if (/^(s|с)/.test(u)) total += v / 60; // i18n-ignore (input parsing)
    else total += v;
  }
  return found ? total : null;
}

// ─── per-trader metrics ─────────────────────────────────────────────────────

/** Net $ per trading day (only trades with a $ result), chronological. */
export function dailyNet(trades: readonly BenchTrade[]): { day: string; net: number }[] {
  const by = new Map<string, number>();
  for (const t of trades) if (t.net != null) by.set(t.day, (by.get(t.day) ?? 0) + t.net);
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, net]) => ({ day, net }));
}

function dailyR(trades: readonly BenchTrade[]): { day: string; net: number }[] {
  const by = new Map<string, number>();
  for (const t of trades) if (t.r != null) by.set(t.day, (by.get(t.day) ?? 0) + t.r);
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, net]) => ({ day, net }));
}

/** All benchmark metrics of one trader. `trades` must be that trader's closed trades in chronological order. */
export function computeTraderMetrics(trader: string, trades: readonly BenchTrade[]): TraderMetrics {
  const n = trades.length;
  const days = new Set(trades.map((t) => t.day));
  let wins = 0, losses = 0, be = 0;
  for (const t of trades) { if (t.result === "win") wins++; else if (t.result === "loss") losses++; else if (t.result === "be") be++; }
  const money = trades.filter((t) => t.net != null);
  const nets = money.map((t) => t.net as number);
  const net = money.length ? sum(nets) : null;
  const gross = money.length ? sum(money.map((t) => t.gross ?? 0)) : null;
  const fees = money.length ? sum(money.map((t) => t.fees)) : null;
  const winNets = nets.filter((v) => v > 0);
  const lossNets = nets.filter((v) => v < 0);
  const avgWin = mean(winNets);
  const avgLoss = mean(lossNets);

  const daily = dailyNet(trades);
  const dVals = daily.map((d) => d.net);
  const dd = daily.length ? drawdownInfo(daily) : null;
  const green = daily.filter((d) => d.net > 0).length;
  const red = daily.filter((d) => d.net < 0).length;
  const best = daily.length ? daily.reduce((a, b) => (b.net > a.net ? b : a)) : null;
  const worst = daily.length ? daily.reduce((a, b) => (b.net < a.net ? b : a)) : null;
  const share = bestDayShare(dVals);

  const st = streaks(trades.map((t) => t.result));
  const holds = trades.map((t) => t.holdMin).filter((v): v is number => v != null && Number.isFinite(v) && v >= 0);
  const holdOf = (pred: (t: BenchTrade) => boolean) =>
    mean(trades.filter((t) => pred(t) && t.holdMin != null && t.holdMin >= 0).map((t) => t.holdMin as number));

  const timed = trades.filter((t) => t.entryMin != null);
  const first = timed.filter((t) => (t.entryMin as number) >= OPEN_MIN && (t.entryMin as number) < OPEN_MIN + FIRST_MINUTES);
  const firstMoney = first.filter((t) => t.net != null);

  const rs = trades.map((t) => t.r).filter((v): v is number => v != null && Number.isFinite(v));

  let equityUnit: TraderMetrics["equityUnit"] = null;
  let base = daily;
  if (daily.length) equityUnit = "usd";
  else if (rs.length) { equityUnit = "r"; base = dailyR(trades); }
  let cum = 0;
  const equity = base.map((d) => ({ day: d.day, net: r2(d.net), cum: r2((cum += d.net)) }));

  const dmean = mean(dVals);
  const vol = dVals.length >= MIN_DAYS_RATIO ? stdev(dVals) : null;
  const sh = sharpeRatio(dVals);
  const so = sortinoRatio(dVals);
  const pf = profitFactor(nets);
  const pfR = profitFactor(rs);
  const sortedDays = [...days].sort();

  return {
    trader,
    trades: n,
    pnlTrades: money.length,
    days: days.size,
    tradesPerDay: days.size ? r2(n / days.size) : null,
    wins, losses, be,
    winRate: wins + losses > 0 ? r4(wins / (wins + losses)) : null,
    net: net == null ? null : r2(net),
    gross: gross == null ? null : r2(gross),
    fees: fees == null ? null : r2(fees),
    feeShare: gross != null && gross > 0 && fees != null ? r4(fees / gross) : null,
    profitFactor: pf == null ? null : r2(pf),
    expectancy: money.length && net != null ? r2(net / money.length) : null,
    avgWin: avgWin == null ? null : r2(avgWin),
    avgLoss: avgLoss == null ? null : r2(avgLoss),
    payoff: avgWin != null && avgLoss != null && avgLoss < 0 ? r2(avgWin / Math.abs(avgLoss)) : null,
    bestTrade: nets.length ? r2(Math.max(...nets)) : null,
    worstTrade: nets.length ? r2(Math.min(...nets)) : null,
    dailyMean: dmean == null ? null : r2(dmean),
    dailyVol: vol == null ? null : r2(vol),
    sharpe: sh == null ? null : r2(sh),
    sortino: so == null ? null : r2(so),
    maxDd: dd ? r2(dd.maxDd) : null,
    recoveryDays: dd ? dd.recoveryDays : null,
    ddRecovered: dd ? (dd.maxDd > 0 ? dd.recoveredDay != null : true) : null,
    ddDays: dd ? dd.ddDays : null,
    currentDd: dd ? r2(dd.currentDd) : null,
    greenDays: green, redDays: red,
    greenShare: daily.length ? r4(green / daily.length) : null,
    bestDay: best ? { day: best.day, net: r2(best.net) } : null,
    worstDay: worst ? { day: worst.day, net: r2(worst.net) } : null,
    bestDayShare: share == null ? null : r4(share),
    consistencyFlag: consistencyFlag(share),
    maxWinStreak: st.maxWin, maxLossStreak: st.maxLoss, currentStreak: st.current,
    avgHoldMin: holds.length ? r2(sum(holds) / holds.length) : null,
    avgHoldWinMin: ((v) => (v == null ? null : r2(v)))(holdOf((t) => t.result === "win")),
    avgHoldLossMin: ((v) => (v == null ? null : r2(v)))(holdOf((t) => t.result === "loss")),
    first15Trades: first.length,
    first15Share: timed.length ? r4(first.length / timed.length) : null,
    first15Net: firstMoney.length ? r2(sum(firstMoney.map((t) => t.net as number))) : null,
    rTrades: rs.length,
    rCoverage: n ? r4(rs.length / n) : null,
    totalR: rs.length ? r2(sum(rs)) : null,
    expectancyR: rs.length ? r2(sum(rs) / rs.length) : null,
    profitFactorR: pfR == null ? null : r2(pfR),
    firstDay: sortedDays[0] ?? null,
    lastDay: sortedDays[sortedDays.length - 1] ?? null,
    equityUnit,
    equity,
  };
}

// ─── metric catalogue (heatmap, radar, median) ──────────────────────────────

export type MetricUnit = "usd" | "pct" | "ratio" | "count" | "min" | "r" | "days";

export interface MetricDef {
  key: keyof TraderMetrics & string;
  label: string;
  unit: MetricUnit;
  /** true = more is better, false = less is better. */
  better: "higher" | "lower";
  hint: string;
  /** Shown on the radar of the two-trader comparison. */
  radar?: boolean;
}

const METRIC_BASE: readonly Omit<MetricDef, "label" | "hint">[] = [
  { key: "net", unit: "usd", better: "higher", radar: true },
  { key: "expectancy", unit: "usd", better: "higher", radar: true },
  { key: "winRate", unit: "pct", better: "higher", radar: true },
  { key: "profitFactor", unit: "ratio", better: "higher", radar: true },
  { key: "payoff", unit: "ratio", better: "higher" },
  { key: "sharpe", unit: "ratio", better: "higher", radar: true },
  { key: "sortino", unit: "ratio", better: "higher" },
  { key: "dailyVol", unit: "usd", better: "lower" },
  { key: "maxDd", unit: "usd", better: "lower", radar: true },
  { key: "recoveryDays", unit: "days", better: "lower" },
  { key: "greenShare", unit: "pct", better: "higher", radar: true },
  { key: "bestDayShare", unit: "pct", better: "lower", radar: true },
  { key: "feeShare", unit: "pct", better: "lower" },
  { key: "tradesPerDay", unit: "count", better: "higher" },
  { key: "maxLossStreak", unit: "count", better: "lower" },
  { key: "avgHoldMin", unit: "min", better: "higher" },
  { key: "first15Share", unit: "pct", better: "lower" },
  { key: "expectancyR", unit: "r", better: "higher" },
];
/** Metric catalogue with labels / hints in `lang` (benchmark namespace `metric.*`). */
export function metricDefs(lang: Lang = "ru"): MetricDef[] {
  const t = benchmarkT.tFor(lang);
  return METRIC_BASE.map((d) => ({ ...d, label: benchmarkT.tryFor(lang, `metric.${d.key}.label`) ?? d.key, hint: benchmarkT.tryFor(lang, `metric.${d.key}.hint`) ?? "" }));
}
/** RU catalogue (kept for older imports). */
export const METRIC_DEFS: readonly MetricDef[] = metricDefs("ru");

/** Metrics whose direction is a style choice, not quality — shown on the heatmap greyed, excluded from badges. */
export const NEUTRAL_METRICS: ReadonlySet<string> = new Set(["tradesPerDay", "avgHoldMin", "first15Share"]);

/**
 * Percentile rank of `v` among `values` in [0, 1], oriented so 1 = best on the desk.
 * Mid-rank for ties; a single value ranks 0.5.
 */
export function percentileRank(v: number, values: readonly number[], better: "higher" | "lower" = "higher"): number {
  if (values.length <= 1) return 0.5;
  let below = 0, equal = 0;
  for (const x of values) { if (x < v) below++; else if (x === v) equal++; }
  const p = (below + Math.max(0, equal - 1) / 2) / (values.length - 1);
  const clamped = Math.max(0, Math.min(1, p));
  return better === "higher" ? clamped : 1 - clamped;
}

export type PercentileMap = Record<string, number | null>;

/** Per trader, per metric percentile (null when that trader has no value). */
export function percentiles(rows: readonly TraderMetrics[], defs: readonly MetricDef[] = METRIC_DEFS): Record<string, PercentileMap> {
  const out: Record<string, PercentileMap> = {};
  for (const r of rows) out[r.trader] = {};
  for (const d of defs) {
    const vals = rows.map((r) => r[d.key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    for (const r of rows) {
      const v = r[d.key];
      out[r.trader][d.key] = typeof v === "number" && Number.isFinite(v) ? r4(percentileRank(v, vals, d.better)) : null;
    }
  }
  return out;
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Desk median per metric; null where fewer than `minTraders` have a value (keeps it anonymous). */
export function deskMedian(rows: readonly TraderMetrics[], defs: readonly MetricDef[] = METRIC_DEFS, minTraders = MEDIAN_MIN_TRADERS): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const d of defs) {
    const vals = rows.map((r) => r[d.key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const m = vals.length >= minTraders ? median(vals) : null;
    out[d.key] = m == null ? null : r4(m);
  }
  return out;
}

// ─── badges ─────────────────────────────────────────────────────────────────

export interface Badge { kind: "strength" | "weakness"; key: string; label: string; detail: string }

/**
 * Strengths / weaknesses of one trader: absolute prop-desk rules always; desk-relative ones (top / bottom
 * quartile) only when the desk has ≥ `minPeers` traders and this trader has ≥ `minTrades` trades (no badges off one trade).
 */
export function badgesFor(m: TraderMetrics, pct: PercentileMap | undefined, deskSize: number, minPeers = 3, minTrades = 10, lang: Lang = "ru"): Badge[] {
  const t = benchmarkT.tFor(lang);
  const out: Badge[] = [];
  const pctTxt = (x: number) => `${Math.round(x * 100)}%`;
  if (m.consistencyFlag === "breach" && m.bestDay) out.push({ kind: "weakness", key: "consistency", label: t("badge.consistencyBreach"), detail: t("badge.consistencyBreachDetail", { day: m.bestDay.day, share: pctTxt(m.bestDayShare ?? 0) }) });
  else if (m.consistencyFlag === "warn" && m.bestDay) out.push({ kind: "weakness", key: "consistency", label: t("badge.consistencyWarn"), detail: t("badge.consistencyWarnDetail", { share: pctTxt(m.bestDayShare ?? 0) }) });
  else if (m.consistencyFlag === "ok" && m.days >= 10) out.push({ kind: "strength", key: "consistency", label: t("badge.consistencyOk"), detail: t("badge.consistencyOkDetail", { share: pctTxt(m.bestDayShare ?? 0) }) });
  if (m.feeShare != null && m.feeShare > 0.3) out.push({ kind: "weakness", key: "fees", label: t("badge.fees"), detail: t("badge.feesDetail", { share: pctTxt(m.feeShare) }) });
  if (m.profitFactor != null && m.pnlTrades >= 20 && m.profitFactor >= 2) out.push({ kind: "strength", key: "pf", label: t("badge.pfHigh"), detail: `PF ${m.profitFactor.toFixed(2)}` });
  if (m.profitFactor != null && m.pnlTrades >= 20 && m.profitFactor < 1) out.push({ kind: "weakness", key: "pf", label: t("badge.pfLow"), detail: t("badge.pfLowDetail", { pf: m.profitFactor.toFixed(2) }) });
  if (m.payoff != null && m.payoff < 0.7 && (m.winRate ?? 0) < 0.6) out.push({ kind: "weakness", key: "payoff", label: t("badge.payoff"), detail: t("badge.payoffDetail", { value: m.payoff.toFixed(2) }) });
  if (m.maxLossStreak >= 6) out.push({ kind: "weakness", key: "streak", label: t("badge.streak"), detail: t("badge.streakDetail", { n: m.maxLossStreak }) });
  if (m.first15Trades >= 10 && m.first15Net != null && m.first15Net < 0) out.push({ kind: "weakness", key: "open", label: t("badge.open"), detail: t("badge.openDetail", { n: m.first15Trades, net: r2(m.first15Net) }) });
  if (m.ddRecovered === false && (m.maxDd ?? 0) > 0) out.push({ kind: "weakness", key: "dd", label: t("badge.dd"), detail: t("badge.ddDetail", { value: String(m.maxDd) }) });
  if (m.avgHoldWinMin != null && m.avgHoldLossMin != null && m.wins >= 10 && m.losses >= 10 && m.avgHoldLossMin > m.avgHoldWinMin * 1.5)
    out.push({ kind: "weakness", key: "hold", label: t("badge.hold"), detail: t("badge.holdDetail", { loss: Math.round(m.avgHoldLossMin), win: Math.round(m.avgHoldWinMin) }) });
  if (pct && deskSize >= minPeers && m.trades >= minTrades) {
    for (const d of metricDefs(lang)) {
      if (NEUTRAL_METRICS.has(d.key) || out.some((b) => b.key === d.key)) continue;
      const p = pct[d.key];
      if (p == null) continue;
      if (p >= 0.75 && out.filter((b) => b.kind === "strength").length < 4) out.push({ kind: "strength", key: d.key, label: t("badge.top", { metric: d.label }), detail: t("badge.percentile", { p: Math.round(p * 100) }) });
      else if (p <= 0.25 && out.filter((b) => b.kind === "weakness").length < 4) out.push({ kind: "weakness", key: d.key, label: t("badge.bottom", { metric: d.label }), detail: t("badge.percentile", { p: Math.round(p * 100) }) });
    }
  }
  return out;
}

// ─── trend: last N weeks vs previous N ──────────────────────────────────────

export interface TrendWindow { from: string; to: string }
export interface TrendResult {
  trader: string;
  cur: TrendWindow; prev: TrendWindow;
  curM: TrendSlice; prevM: TrendSlice;
  weeks: { week: string; net: number | null; r: number | null; trades: number }[];
  verdict: "better" | "worse" | "flat" | "nodata";
}
export type TrendSlice = Pick<TraderMetrics,
  "trades" | "days" | "net" | "winRate" | "profitFactor" | "expectancy" | "sharpe" | "greenShare" | "maxDd" | "feeShare" | "tradesPerDay" | "bestDayShare" | "totalR" | "expectancyR">;

function slice(m: TraderMetrics): TrendSlice {
  return {
    trades: m.trades, days: m.days, net: m.net, winRate: m.winRate, profitFactor: m.profitFactor, expectancy: m.expectancy,
    sharpe: m.sharpe, greenShare: m.greenShare, maxDd: m.maxDd, feeShare: m.feeShare, tradesPerDay: m.tradesPerDay,
    bestDayShare: m.bestDayShare, totalR: m.totalR, expectancyR: m.expectancyR,
  };
}

function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Monday of the week containing `ymd`. */
export function mondayOfYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDaysYmd(ymd, -((wd + 6) % 7));
}

/** Last `weeks` weeks (ending `asOf`, inclusive) vs the `weeks` weeks before, calendar windows of 7·weeks days. */
export function trendFor(trader: string, trades: readonly BenchTrade[], asOf: string, weeks = 4): TrendResult {
  const len = weeks * 7;
  const cur = { from: addDaysYmd(asOf, -(len - 1)), to: asOf };
  const prev = { from: addDaysYmd(cur.from, -len), to: addDaysYmd(cur.from, -1) };
  const inW = (w: TrendWindow) => trades.filter((t) => t.day >= w.from && t.day <= w.to);
  const curM = computeTraderMetrics(trader, inW(cur));
  const prevM = computeTraderMetrics(trader, inW(prev));
  const wk: TrendResult["weeks"] = [];
  const firstMon = mondayOfYmd(prev.from);
  for (let mon = firstMon; mon <= asOf; mon = addDaysYmd(mon, 7)) {
    const end = addDaysYmd(mon, 6);
    const ts = trades.filter((t) => t.day >= mon && t.day <= end && t.day >= prev.from && t.day <= asOf);
    const money = ts.filter((t) => t.net != null);
    const rr = ts.filter((t) => t.r != null);
    wk.push({ week: mon, net: money.length ? r2(sum(money.map((t) => t.net as number))) : null, r: rr.length ? r2(sum(rr.map((t) => t.r as number))) : null, trades: ts.length });
  }
  let verdict: TrendResult["verdict"] = "nodata";
  if (curM.trades && prevM.trades) {
    let score = 0;
    const cmp = (a: number | null, b: number | null, tol: number) => (a == null || b == null ? 0 : a - b > tol ? 1 : b - a > tol ? -1 : 0);
    score += cmp(curM.expectancy ?? curM.expectancyR, prevM.expectancy ?? prevM.expectancyR, 0.01);
    score += cmp(curM.winRate, prevM.winRate, 0.03);
    score += cmp(curM.profitFactor, prevM.profitFactor, 0.1);
    score += cmp(curM.greenShare, prevM.greenShare, 0.05);
    score -= cmp(curM.maxDd, prevM.maxDd, 1);
    verdict = score >= 2 ? "better" : score <= -2 ? "worse" : "flat";
  }
  return { trader, cur, prev, curM: slice(curM), prevM: slice(prevM), weeks: wk, verdict };
}

// ─── «same ticker, same day» ────────────────────────────────────────────────

export interface SameTickerParticipant {
  trader: string;
  trades: number;
  side: Side | "mixed" | null;
  qty: number | null;
  avgEntry: number | null;
  avgExit: number | null;
  firstEntryMin: number | null;
  lastExitMin: number | null;
  holdMin: number | null;
  net: number | null;
  r: number | null;
  /** Price move captured per share, side-aware ((exit − entry) for long, (entry − exit) for short). */
  capturePerShare: number | null;
  /** capturePerShare as % of the average entry (size-independent). */
  capturePct: number | null;
  /** Entry vs the best entry of the same side in the group, in % (0 = best; positive = worse fill). */
  entryGapPct: number | null;
  /** Exit vs the best exit of the same side in the group, in % (0 = best). */
  exitGapPct: number | null;
  rank: number | null;
  tradeIds: number[];
}

export interface SameTickerCase {
  ticker: string;
  day: string;
  traders: number;
  sameSide: boolean;
  /** Unit the participants were ranked in (null = no common unit → no ranking). */
  rankBy: "net" | "r" | "capture" | null;
  /** Net spread best − worst ($), null without $ on at least two participants. */
  spread: number | null;
  participants: SameTickerParticipant[];
}

function wavg(pairs: readonly { p: number | null; q: number | null }[]): number | null {
  let pq = 0, qq = 0, plain = 0, n = 0;
  for (const { p, q } of pairs) {
    if (p == null) continue;
    plain += p; n++;
    if (q != null && q > 0) { pq += p * q; qq += q; }
  }
  if (qq > 0) return pq / qq;
  return n ? plain / n : null;
}

/** Cases where ≥ 2 traders traded the same ticker on the same day, with an execution comparison. */
export function sameTickerCases(trades: readonly BenchTrade[]): SameTickerCase[] {
  const groups = new Map<string, BenchTrade[]>();
  for (const t of trades) {
    const k = `${t.day}|${t.ticker.toUpperCase()}`;
    const l = groups.get(k) ?? [];
    l.push(t);
    groups.set(k, l);
  }
  const out: SameTickerCase[] = [];
  for (const [k, ts] of groups) {
    const byTrader = new Map<string, BenchTrade[]>();
    for (const t of ts) { const l = byTrader.get(t.trader) ?? []; l.push(t); byTrader.set(t.trader, l); }
    if (byTrader.size < 2) continue;
    const [day, ticker] = k.split("|");
    const parts: SameTickerParticipant[] = [...byTrader.entries()].map(([trader, list]) => {
      const sides = new Set(list.map((t) => t.side).filter(Boolean));
      const side = sides.size === 1 ? ([...sides][0] as Side) : sides.size > 1 ? "mixed" : null;
      const money = list.filter((t) => t.net != null);
      const rr = list.filter((t) => t.r != null);
      const entries = list.map((t) => t.entryMin).filter((v): v is number => v != null);
      const exits = list.map((t) => t.exitMin).filter((v): v is number => v != null);
      const holds = list.map((t) => t.holdMin).filter((v): v is number => v != null);
      const qtys = list.map((t) => t.qty).filter((v): v is number => v != null);
      const avgEntry = wavg(list.map((t) => ({ p: t.entry, q: t.qty })));
      const avgExit = wavg(list.map((t) => ({ p: t.exit, q: t.qty })));
      const capture = avgEntry != null && avgExit != null && (side === "long" || side === "short")
        ? (side === "long" ? avgExit - avgEntry : avgEntry - avgExit) : null;
      return {
        trader, trades: list.length, side,
        qty: qtys.length ? sum(qtys) : null,
        avgEntry: avgEntry == null ? null : r4(avgEntry),
        avgExit: avgExit == null ? null : r4(avgExit),
        firstEntryMin: entries.length ? Math.min(...entries) : null,
        lastExitMin: exits.length ? Math.max(...exits) : null,
        holdMin: holds.length ? r2(sum(holds) / holds.length) : null,
        net: money.length ? r2(sum(money.map((t) => t.net as number))) : null,
        r: rr.length ? r2(sum(rr.map((t) => t.r as number))) : null,
        capturePerShare: capture == null ? null : r4(capture),
        capturePct: capture == null || avgEntry == null || !(avgEntry > 0) ? null : r4((capture / avgEntry) * 100),
        entryGapPct: null, exitGapPct: null, rank: null,
        tradeIds: list.map((t) => t.id),
      };
    });
    for (const s of ["long", "short"] as const) {
      const same = parts.filter((p) => p.side === s);
      const ents = same.map((p) => p.avgEntry).filter((v): v is number => v != null && v > 0);
      const exs = same.map((p) => p.avgExit).filter((v): v is number => v != null && v > 0);
      if (ents.length >= 1) {
        const bestE = s === "long" ? Math.min(...ents) : Math.max(...ents);
        for (const p of same) if (p.avgEntry != null && p.avgEntry > 0) p.entryGapPct = r4(((s === "long" ? p.avgEntry - bestE : bestE - p.avgEntry) / bestE) * 100);
      }
      if (exs.length >= 1) {
        const bestX = s === "long" ? Math.max(...exs) : Math.min(...exs);
        for (const p of same) if (p.avgExit != null && p.avgExit > 0) p.exitGapPct = r4(((s === "long" ? bestX - p.avgExit : p.avgExit - bestX) / bestX) * 100);
      }
    }
    // Rank only in one unit shared by every participant: net $, else R, else % of price captured.
    const rankBy: SameTickerCase["rankBy"] =
      parts.every((p) => p.net != null) ? "net" : parts.every((p) => p.r != null) ? "r" : parts.every((p) => p.capturePct != null) ? "capture" : null;
    if (rankBy) {
      const score = (p: SameTickerParticipant) => (rankBy === "net" ? p.net : rankBy === "r" ? p.r : p.capturePct) as number;
      [...parts].sort((a, b) => score(b) - score(a)).forEach((p, i) => { p.rank = i + 1; });
    }
    parts.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.trader.localeCompare(b.trader));
    const nets = parts.map((p) => p.net).filter((v): v is number => v != null);
    const sides = new Set(parts.map((p) => p.side));
    out.push({
      ticker, day, traders: parts.length,
      sameSide: sides.size === 1 && !sides.has("mixed") && !sides.has(null),
      rankBy,
      spread: nets.length >= 2 ? r2(Math.max(...nets) - Math.min(...nets)) : null,
      participants: parts,
    });
  }
  out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : (b.spread ?? 0) - (a.spread ?? 0)));
  return out;
}
