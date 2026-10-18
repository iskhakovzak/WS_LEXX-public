// Top results model: periods on the New York trading calendar (Mon–Fri weeks) and the row
// shape of GET /api/leaderboard?format=desk. All numbers are computed by the API with the shared
// trade math (net = gross − |fees|, signed R, W/(W+L), PF = ΣR⁺/|ΣR⁻|); nothing is recomputed here.
import type { Trade } from "@workspace/api-client-react";
import { addDays, nyDate } from "@/lib/trading-date";
import { closeDate, isClosed, netPnl, signedR } from "@/lib/trade-math";
import { fmtDate, fmtDateRange } from "@/lib/format";
import { teamI18n } from "@/i18n/ns/team";
import { commonI18n } from "@/i18n/ns/common";

/** `{ key: label }` whose labels are read in the current language on every access (safe at module scope). */
function liveLabels<K extends string>(keys: readonly K[], label: (k: K) => string): Record<K, string> {
  const o = {} as Record<K, string>;
  for (const k of keys) Object.defineProperty(o, k, { get: () => label(k), enumerable: true });
  return o;
}

export type Period = "week" | "month" | "quarter" | "all";
export type Metric = "score" | "net" | "r" | "expectancy" | "pf" | "consistency" | "drawdown" | "winrate";

const METRICS: readonly Metric[] = ["score", "net", "r", "expectancy", "pf", "consistency", "drawdown", "winrate"];
/** Metric → label in the current language (getters, so `METRIC_LABEL[m]` follows a language switch). */
export const METRIC_LABEL: Record<Metric, string> = liveLabels(METRICS, (m) => teamI18n.t(`metric.${m}`));

export type Range = { kind: Period; from: string | null; to: string | null; label: string };

function parts(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y, m, d };
}
const pad = (n: number) => String(n).padStart(2, "0");
const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Monday of the NY week containing `ymd`. */
export function mondayOf(ymd: string): string {
  const { y, m, d } = parts(ymd);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(ymd, -((wd + 6) % 7));
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** «17 октября» / «17 октября 2026 г.» */
export function fmtDay(ymd: string, withYear = false): string {
  return fmtDate(ymd, withYear ? "long" : "dayMonthLong");
}

/** Window for an anchor date: Mon–Fri week, calendar month, calendar quarter, or everything. */
export function periodRange(anchor: string, period: Period): Range {
  if (period === "all") return { kind: "all", from: null, to: null, label: teamI18n.t("period.all") };
  const { y, m } = parts(anchor);
  if (period === "week") {
    const from = mondayOf(anchor);
    const to = addDays(from, 4);
    // «12–16 октября 2026 г.» / «October 12 – 16, 2026» / «2026-yil 12–16-oktabr» (shared range formatter).
    return { kind: "week", from, to, label: fmtDateRange(from, to) };
  }
  if (period === "month") {
    return { kind: "month", from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}`, label: capFirst(fmtDate(`${y}-${pad(m)}-01`, "monthYear")) };
  }
  const q = Math.floor((m - 1) / 3);
  const fm = q * 3 + 1, lm = fm + 2;
  return { kind: "quarter", from: `${y}-${pad(fm)}-01`, to: `${y}-${pad(lm)}-${pad(lastDayOfMonth(y, lm))}`, label: teamI18n.t("period.quarter", { q: q + 1, year: y }) };
}

export function shiftAnchor(anchor: string, period: Period, dir: -1 | 1): string {
  if (period === "all") return anchor;
  if (period === "week") return addDays(mondayOf(anchor), dir * 7);
  const { y, m } = parts(anchor);
  const n = period === "month" ? 1 : 3;
  const t = new Date(Date.UTC(y, m - 1 + dir * n, 1));
  return t.toISOString().slice(0, 10);
}

export function inRange(date: string | null, r: Range): boolean {
  if (!date) return false;
  if (!r.from || !r.to) return true;
  return date >= r.from && date <= r.to;
}

/** Today's NY date. */
export const todayNy = () => nyDate();

/* ───────────── API row shape (GET /api/leaderboard?format=desk) ───────────── */

export type ScorePart = "expectancy" | "profitFactor" | "net" | "consistency" | "drawdown" | "discipline";

const SCORE_PARTS: readonly ScorePart[] = ["expectancy", "profitFactor", "net", "consistency", "drawdown", "discipline"];
export const SCORE_PART_LABEL: Record<ScorePart, string> = liveLabels(SCORE_PARTS, (k) => teamI18n.t(`scorePart.${k}`));

export type TraderRow = {
  trader: string;
  rank: number | null;
  qualified: boolean;
  minTrades: number;
  closed: number;
  totalTrades: number;
  open: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number | null;
  net: number | null;
  gross: number | null;
  fees: number | null;
  pnlCount: number;
  /** null = no trade with a known R (no stop, e.g. broker imports) — shown as «—», never 0R. */
  totalR: number | null;
  avgR: number | null;
  rCount: number;
  expectancyR: number | null;
  profitFactorR: number | null;
  bestR: number | null;
  worstR: number | null;
  bestTrade: number;
  worstTrade: number;
  tradingDays: number;
  greenDays: number;
  consistency: number | null;
  maxDrawdownR: number;
  maxDrawdownNet: number | null;
  sharpeDaily: number | null;
  sharpeDailyR: number | null;
  currentStreak: number;
  bestStreak: number;
  worstStreak: number;
  lastTradeDate: string | null;
  sparkR: number[];
  violations: number;
  violationsPerWeek: number;
  score: number | null;
  scoreParts: Record<ScorePart, number | null>;
  tier: string | null;
  accountSize: number | null;
  dailyLossLimit: number | null;
  maxDrawdownLimit: number | null;
  rating: { avg: number; n: number } | null;
  prevScore: number | null;
  deltaScore: number | null;
  prev: {
    totalTrades: number;
    winrate: number;
    totalPnl: number;
    totalR: number | null;
    avgR: number | null;
    expectancy: number;
    expectancyR: number | null;
    score: number | null;
    closed: number;
    net: number | null;
    qualified: boolean;
  } | null;
};

export type DeskLeaderboard = {
  period: { kind: string; from: string; to: string; prevFrom: string | null; prevTo: string | null; today: string };
  metric: Metric;
  minTrades: number;
  weights: Record<ScorePart, number>;
  qualifiedCount: number;
  totalTraders: number;
  mostImproved: { trader: string; deltaScore: number | null; score: number | null; prevScore: number | null } | null;
  viewer: { name: string; staff: boolean };
  rows: TraderRow[];
};

/** The number a row is ranked by for the chosen metric (null = not measurable). */
export function metricValue(r: TraderRow, metric: Metric): number | null {
  switch (metric) {
    case "net": return r.net;
    case "r": return r.totalR;
    case "expectancy": return r.expectancyR;
    case "pf": return r.profitFactorR;
    case "consistency": return r.consistency;
    case "drawdown": return r.maxDrawdownNet ?? r.maxDrawdownR;
    case "winrate": return r.winRate;
    default: return r.score;
  }
}

/** Team-level summary over the visible rows (sums / weighted ratios of API numbers, no trade math). */
export function teamKpis(rows: TraderRow[]) {
  let closed = 0, wins = 0, losses = 0, r = 0, net = 0, hasNet = false, rCount = 0;
  for (const x of rows) {
    closed += x.closed; wins += x.wins; losses += x.losses; r += x.totalR ?? 0; rCount += x.rCount;
    if (x.net != null) { net += x.net; hasNet = true; }
  }
  return {
    traders: rows.length,
    qualified: rows.filter((x) => x.qualified).length,
    closed,
    wins,
    losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    totalR: rCount > 0 ? r : null,
    expectancyR: rCount > 0 ? r / rCount : null,
    net: hasNet ? net : null,
    plus: rows.filter((x) => (x.net ?? x.totalR ?? 0) > 0).length,
    minus: rows.filter((x) => (x.net ?? x.totalR ?? 0) < 0).length,
  };
}

/* ───────────── Trade-level helpers for the best / review cards (shared math) ───────────── */

export function setupOf(t: Trade): string {
  const s = t.setup?.trim();
  if (s) return s;
  const tag = t.tags?.split(",")[0]?.trim();
  if (tag) return tag;
  return commonI18n.t("trading.noSetup");
}

/** Closed trades of the window by close date (NY calendar). */
export function tradesInRange(trades: Trade[], r: Range): Trade[] {
  return trades.filter((t) => isClosed(t) && inRange(closeDate(t), r));
}

/** Value used to rank single trades: net $ when known, else signed R. */
export function tradeValue(t: Trade, prefer: "net" | "r"): number | null {
  const n = netPnl(t), rr = signedR(t);
  return prefer === "net" ? (n ?? rr) : (rr ?? n);
}

export type SetupRow = { setup: string; count: number; r: number; net: number | null; wins: number; losses: number; winRate: number | null };

/** Setups of the window: Σ signed R, Σ net $, W/(W+L). */
export function rollupSetups(trades: Trade[]): SetupRow[] {
  const map = new Map<string, SetupRow & { hasNet: boolean }>();
  for (const t of trades) {
    const k = setupOf(t);
    let row = map.get(k);
    if (!row) { row = { setup: k, count: 0, r: 0, net: 0, wins: 0, losses: 0, winRate: null, hasNet: false }; map.set(k, row); }
    row.count++;
    row.r += signedR(t) ?? 0;
    const n = netPnl(t);
    if (n != null) { row.net = (row.net ?? 0) + n; row.hasNet = true; }
    const res = (t.result ?? "").toLowerCase().trim();
    if (res === "win") row.wins++;
    else if (res === "loss") row.losses++;
  }
  return [...map.values()]
    .map(({ hasNet, ...row }) => ({ ...row, net: hasNet ? row.net : null, winRate: row.wins + row.losses ? row.wins / (row.wins + row.losses) : null }))
    .sort((a, b) => b.r - a.r || b.count - a.count);
}

export type SymbolGroup = { symbol: string; trades: Trade[]; net: number | null; r: number; tags: string };

export function groupBySymbol(trades: Trade[]): SymbolGroup[] {
  const map = new Map<string, SymbolGroup & { hasNet: boolean }>();
  for (const t of trades) {
    let g = map.get(t.ticker);
    if (!g) { g = { symbol: t.ticker, trades: [], net: 0, r: 0, tags: "", hasNet: false }; map.set(t.ticker, g); }
    g.trades.push(t);
    const n = netPnl(t);
    if (n != null) { g.net = (g.net ?? 0) + n; g.hasNet = true; }
    g.r += signedR(t) ?? 0;
    if (t.tags) {
      const set = new Set([...g.tags.split(", ").filter(Boolean), ...t.tags.split(",").map((s) => s.trim()).filter(Boolean)]);
      g.tags = [...set].join(", ");
    }
  }
  return [...map.values()].map(({ hasNet, ...g }) => ({ ...g, net: hasNet ? g.net : null })).sort((a, b) => b.r - a.r || (b.net ?? 0) - (a.net ?? 0));
}
