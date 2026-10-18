// One definition of R, P&L and the core KPIs for the whole app. Every page that shows results
// must use these (server mirror: api-server/src/lib/tradeMath.ts) so the same book never shows
// different numbers on different screens.
import { normalizeResult, type TradeResult } from "@/lib/trade-result";
import { commonI18n } from "@/i18n/ns/common";

/** Loose trade shape: works with api-client types and raw JSON (numbers may arrive as strings). */
export interface TradeLike {
  result?: string | null;
  side?: string | null;
  entry?: number | string | null;
  exit?: number | string | null;
  stop?: number | string | null;
  rMultiple?: number | string | null;
  pnl?: number | string | null;
  fees?: number | string | null;
  riskUsd?: number | string | null;
  horizon?: string | null;
  date?: string | null;
  exitDate?: string | null;
}

export type Horizon = "intraday" | "overnight" | "swing";

const R_CLAMP = 20;

export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "string" && v.trim() === "") return null; // Number("  ") === 0 — a blank cell is not a zero
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function resultOf(t: TradeLike): TradeResult {
  return normalizeResult(t.result);
}

/** Open = no decided result yet (result "open", empty or unknown). */
export function isOpen(t: TradeLike): boolean {
  return t.result?.trim().toLowerCase() === "open";
}

export function isClosed(t: TradeLike): boolean {
  return resultOf(t) !== null;
}

/** Win or loss (break-even excluded): the denominator for win rate. */
export function isDecided(t: TradeLike): boolean {
  const r = resultOf(t);
  return r === "win" || r === "loss";
}

export function horizonOf(t: TradeLike): Horizon {
  return t.horizon === "overnight" || t.horizon === "swing" ? t.horizon : "intraday";
}

/** The day the result is realised: exit date for multi-day holds, else the trade date. */
export function closeDate(t: TradeLike): string | null {
  return t.exitDate || t.date || null;
}

function isShort(t: TradeLike): boolean {
  return (t.side ?? "").trim().toLowerCase().startsWith("s");
}

const clampR = (r: number) => Math.max(-R_CLAMP, Math.min(R_CLAMP, r));

/** R from prices (side-aware). Null when entry/exit/stop are missing or stop == entry. */
export function priceR(t: TradeLike): number | null {
  const entry = num(t.entry), exit = num(t.exit), stop = num(t.stop);
  if (entry == null || exit == null || stop == null) return null;
  const risk = Math.abs(entry - stop);
  if (risk === 0) return null;
  const move = isShort(t) ? entry - exit : exit - entry;
  return clampR(move / risk);
}

/**
 * Signed R of a closed trade.
 * 1. stored rMultiple, sign taken from the result (win ⇒ +, loss ⇒ −, be ⇒ 0);
 * 2. else price-derived R;
 * 3. else pnl / riskUsd.
 * Open trades ⇒ null. Clamped to ±20R.
 */
export function signedR(t: TradeLike): number | null {
  if (isOpen(t)) return null;
  const res = resultOf(t);
  if (res === "be") return 0;
  const stored = num(t.rMultiple);
  if (stored != null) {
    const abs = Math.abs(stored);
    if (res === "win") return clampR(abs);
    if (res === "loss") return clampR(-abs);
    return clampR(stored);
  }
  const p = priceR(t);
  if (p != null) return p;
  const pnl = num(t.pnl), risk = num(t.riskUsd);
  if (pnl != null && risk != null && risk > 0) return clampR(pnl / risk);
  return null;
}

/** Gross P&L as stored (`pnl` is always gross). */
export function grossPnl(t: TradeLike): number | null {
  return num(t.pnl);
}

/** Net P&L = gross − |fees|. Null when gross is unknown. */
export function netPnl(t: TradeLike): number | null {
  const g = num(t.pnl);
  if (g == null) return null;
  return g - Math.abs(num(t.fees) ?? 0);
}

export function feesOf(t: TradeLike): number {
  return Math.abs(num(t.fees) ?? 0);
}

/** True when the result contradicts the price move (e.g. "loss" on a long that exited above entry). */
export function resultConflictsWithPrice(t: TradeLike): boolean {
  const res = resultOf(t);
  const p = priceR(t);
  if (p == null || (res !== "win" && res !== "loss")) return false;
  return (res === "win" && p < 0) || (res === "loss" && p > 0);
}

// ─── KPIs over a set of trades ───

export interface Kpis {
  trades: number;
  closed: number;
  wins: number;
  losses: number;
  be: number;
  open: number;
  /** wins / (wins + losses); break-even excluded. Null when no decided trades. */
  winRate: number | null;
  totalR: number;
  rCount: number;
  /** Mean signed R over closed trades with an R. */
  expectancyR: number | null;
  /** ΣR⁺ / |ΣR⁻|; null when there are no losing R (never ∞). */
  profitFactorR: number | null;
  grossPnl: number | null;
  netPnl: number | null;
  fees: number;
  pnlCount: number;
  /** Peak-to-trough on cumulative R (≤ 0). */
  maxDrawdownR: number;
  /** Peak-to-trough on cumulative net $ (≤ 0); null without $ data. */
  maxDrawdownNet: number | null;
}

/** Drawdown (≤ 0) of a cumulative series built from per-trade values in chronological order. */
export function maxDrawdown(values: number[]): number {
  let cum = 0, peak = 0, dd = 0;
  for (const v of values) {
    cum += v;
    if (cum > peak) peak = cum;
    if (cum - peak < dd) dd = cum - peak;
  }
  return dd;
}

/** Chronological order by close date (then trade date). */
export function byCloseDate<T extends TradeLike>(trades: T[]): T[] {
  return [...trades].sort((a, b) => (closeDate(a) ?? "").localeCompare(closeDate(b) ?? ""));
}

export function computeKpis(trades: TradeLike[]): Kpis {
  const ordered = byCloseDate(trades);
  let wins = 0, losses = 0, be = 0, open = 0, closed = 0;
  let totalR = 0, rCount = 0, posR = 0, negR = 0;
  let gross = 0, net = 0, fees = 0, pnlCount = 0;
  const rSeries: number[] = [];
  const netSeries: number[] = [];
  for (const t of ordered) {
    if (isOpen(t)) { open++; continue; }
    const res = resultOf(t);
    if (res === null) continue;
    closed++;
    if (res === "win") wins++;
    else if (res === "loss") losses++;
    else be++;
    const r = signedR(t);
    if (r != null) {
      totalR += r; rCount++; rSeries.push(r);
      if (r > 0) posR += r; else if (r < 0) negR += r;
    }
    const g = grossPnl(t);
    if (g != null) {
      const n = netPnl(t)!;
      gross += g; net += n; fees += feesOf(t); pnlCount++; netSeries.push(n);
    }
  }
  const decided = wins + losses;
  return {
    trades: trades.length,
    closed, wins, losses, be, open,
    winRate: decided ? wins / decided : null,
    totalR, rCount,
    expectancyR: rCount ? totalR / rCount : null,
    profitFactorR: negR < 0 ? posR / Math.abs(negR) : null,
    grossPnl: pnlCount ? gross : null,
    netPnl: pnlCount ? net : null,
    fees, pnlCount,
    maxDrawdownR: maxDrawdown(rSeries),
    maxDrawdownNet: pnlCount ? maxDrawdown(netSeries) : null,
  };
}

/** Formula hints for KPI tooltips, in the UI language (getters: read at render, never frozen at import). */
export const KPI_FORMULAS = {
  get winRate() { return commonI18n.t("kpiFormulas.winRate"); },
  get expectancyR() { return commonI18n.t("kpiFormulas.expectancyR"); },
  get profitFactorR() { return commonI18n.t("kpiFormulas.profitFactorR"); },
  get netPnl() { return commonI18n.t("kpiFormulas.netPnl"); },
  get maxDrawdown() { return commonI18n.t("kpiFormulas.maxDrawdown"); },
};
