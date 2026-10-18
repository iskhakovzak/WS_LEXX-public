import { netPnl, normResult, num, signedR, type TradeRowLike } from "./tradeMath";

/** A trade row as needed for edge stats: raw columns, interpreted through the shared trade math. */
export type EdgeTrade = TradeRowLike & {
  id: number;
  date?: string | null;
  exitDate?: string | null;
  horizon?: string | null;
  session: string | null;
  contextSnapshot: any | null;
  setupScore: number | null;
};

export type EdgeStats = {
  count: number;
  wins: number;
  losses: number;
  be: number;
  open: number;
  /** W / (W + L), break-even excluded; null without decided trades. */
  winrate: number | null;
  /** Mean signed R over closed trades with an R; null without R. */
  avgR: number | null;
  /** Same as avgR (expectancy per trade in R); kept for the client. */
  expectancy: number | null;
  /** ΣR⁺ / |ΣR⁻|; null when there is no losing R (never ∞). */
  profitFactor: number | null;
  /** Peak-to-trough on cumulative NET $ (≥ 0); null without $ data. */
  maxDrawdown: number | null;
  sharpe: number | null;
  /** Σ net P&L (gross − |fees|); null without $ data. */
  totalPnl: number | null;
  totalPnlGross: number | null;
  fees: number;
  pnlCount: number;
  /** Trades that carry an R (basis for avgR / expectancy / sharpe). */
  rCount: number;
};

const EMPTY: EdgeStats = {
  count: 0, wins: 0, losses: 0, be: 0, open: 0, winrate: null, avgR: null, expectancy: null, profitFactor: null,
  maxDrawdown: null, sharpe: null, totalPnl: null, totalPnlGross: null, fees: 0, pnlCount: 0, rCount: 0,
};

const r3 = (v: number) => Number(v.toFixed(3));
const r2 = (v: number) => Number(v.toFixed(2));

/** Chronological order by close date (exit date for multi-day holds), then id. */
export function byCloseDate<T extends EdgeTrade>(trades: T[]): T[] {
  return [...trades].sort((a, b) => {
    const da = (a.exitDate || a.date || "") as string;
    const db = (b.exitDate || b.date || "") as string;
    return da.localeCompare(db) || a.id - b.id;
  });
}

export function computeEdge(trades: EdgeTrade[]): EdgeStats {
  if (trades.length === 0) return EMPTY;
  let wins = 0, losses = 0, be = 0, open = 0;
  let sumR = 0, posR = 0, negR = 0;
  const rs: number[] = [];
  let gross = 0, net = 0, fees = 0, pnlCount = 0;
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of byCloseDate(trades)) {
    const res = normResult(t.result);
    if (res === "open") { open++; continue; }
    if (res === "win") wins++;
    else if (res === "loss") losses++;
    else if (res === "be") be++;
    const r = signedR(t);
    if (r != null) {
      rs.push(r); sumR += r;
      if (r > 0) posR += r; else if (r < 0) negR += r;
    }
    const g = num(t.pnl);
    if (g != null) {
      const n = netPnl(t)!;
      gross += g; net += n; fees += Math.abs(num(t.fees) ?? 0); pnlCount++;
      cum += n;
      if (cum > peak) peak = cum;
      if (peak - cum > maxDD) maxDD = peak - cum;
    }
  }
  const decided = wins + losses;
  const rCount = rs.length;
  const avgR = rCount ? sumR / rCount : null;
  const variance = rCount > 1 && avgR != null ? rs.reduce((s, x) => s + (x - avgR) ** 2, 0) / (rCount - 1) : 0;
  const stdev = Math.sqrt(variance);
  return {
    count: trades.length, wins, losses, be, open,
    winrate: decided ? Number((wins / decided).toFixed(4)) : null,
    avgR: avgR == null ? null : r3(avgR),
    expectancy: avgR == null ? null : r3(avgR),
    profitFactor: negR < 0 ? r2(posR / Math.abs(negR)) : null,
    maxDrawdown: pnlCount ? r2(maxDD) : null,
    sharpe: avgR != null && stdev > 0 ? r2((avgR / stdev) * Math.sqrt(rCount)) : null,
    totalPnl: pnlCount ? r2(net) : null,
    totalPnlGross: pnlCount ? r2(gross) : null,
    fees: r2(fees),
    pnlCount,
    rCount,
  };
}

/**
 * Sample-size-aware edge score used to rank setups ("best edge" sort).
 * Shrinks expectancy toward 0 with a prior of PRIOR_TRADES pseudo-trades, so a setup
 * with 2 lucky trades doesn't outrank a proven one with 40.
 */
const PRIOR_TRADES = 8;
export function edgeScore(expectancy: number, sampleSize: number): number {
  if (!sampleSize || !Number.isFinite(expectancy)) return 0;
  return Number(((expectancy * sampleSize) / (sampleSize + PRIOR_TRADES)).toFixed(4));
}

export function bucketBy<T>(items: T[], keyFn: (t: T) => string | null): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item) ?? "—";
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

export function vixBucket(vix: number | null | undefined): string {
  if (vix == null || isNaN(Number(vix))) return "—";
  const v = Number(vix);
  if (v < 15) return "<15";
  if (v < 20) return "15-20";
  if (v < 25) return "20-25";
  if (v < 30) return "25-30";
  return "30+";
}

export function scoreBucket(score: number | null | undefined): string {
  if (score == null) return "—";
  if (score < 50) return "<50%";
  if (score < 70) return "50-70%";
  if (score < 90) return "70-90%";
  return "90-100%";
}

// ─── $-first stats (R is often null: PropReports trades carry no stop) ──────

export type UsdStats = {
  /** Trades with a $ result (closed, pnl present). */
  n: number;
  wins: number;
  losses: number;
  /** W / (W + L) on $ results; null without decided trades. */
  winrate: number | null;
  /** Σ net $. */
  net: number | null;
  /** Mean net $ per trade (expectancy in $). */
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** avgWin / |avgLoss|; null without both sides. */
  payoff: number | null;
  /** Σ net⁺ / |Σ net⁻|; null without losses (never ∞). */
  profitFactor: number | null;
  best: number | null;
  worst: number | null;
};

/** $ expectancy block over closed trades (net = pnl − |fees|; result from the shared math, $ sign as fallback). */
export function computeUsdStats(trades: TradeRowLike[]): UsdStats {
  let n = 0, wins = 0, losses = 0, net = 0, pos = 0, neg = 0, posN = 0, negN = 0;
  let best: number | null = null, worst: number | null = null;
  for (const t of trades) {
    const res = normResult(t.result);
    if (res === "open") continue;
    const v = netPnl(t);
    if (v == null) continue;
    n++; net += v;
    const outcome = res ?? (v > 0 ? "win" : v < 0 ? "loss" : "be");
    if (outcome === "win") wins++; else if (outcome === "loss") losses++;
    if (v > 0) { pos += v; posN++; } else if (v < 0) { neg += v; negN++; }
    if (best == null || v > best) best = v;
    if (worst == null || v < worst) worst = v;
  }
  const avgWin = posN ? pos / posN : null;
  const avgLoss = negN ? neg / negN : null;
  return {
    n, wins, losses,
    winrate: wins + losses ? Number((wins / (wins + losses)).toFixed(4)) : null,
    net: n ? r2(net) : null,
    expectancy: n ? r2(net / n) : null,
    avgWin: avgWin == null ? null : r2(avgWin),
    avgLoss: avgLoss == null ? null : r2(avgLoss),
    payoff: avgWin != null && avgLoss != null && avgLoss < 0 ? r2(avgWin / Math.abs(avgLoss)) : null,
    profitFactor: neg < 0 ? r2(pos / Math.abs(neg)) : null,
    best: best == null ? null : r2(best),
    worst: worst == null ? null : r2(worst),
  };
}

/** NY entry-time slot: "pre" (< 9:30), "09:30", "10:00" … "15:30" (30-minute slots), "post" (≥ 16:00). */
export function timeSlotOf(entryMin: number | null | undefined): string | null {
  if (entryMin == null || !Number.isFinite(entryMin)) return null;
  if (entryMin < 570) return "pre";
  if (entryMin >= 960) return "post";
  const slot = Math.floor(entryMin / 30) * 30;
  return `${String(Math.floor(slot / 60)).padStart(2, "0")}:${String(slot % 60).padStart(2, "0")}`;
}

/** Minutes since NY midnight from an ET wall-clock string ("2026-03-02 09:41:05" / ISO with offset). */
export function etWallMinutes(v: unknown, nyMinutesOf: (d: Date) => number): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? nyMinutesOf(new Date(t)) : null;
  }
  const m = /[T ](\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

export type SlotStat = { slot: string; n: number; net: number; expectancy: number; winrate: number | null };

/**
 * $ result by entry slot, sorted by time. `best` = top slots by Σ net with ≥ minN trades (positive only).
 */
export function slotStats<T extends TradeRowLike & { entryMin: number | null }>(trades: T[], minN = 3): { slots: SlotStat[]; best: SlotStat[] } {
  const groups = bucketBy(trades, (t) => timeSlotOf(t.entryMin));
  const order = (s: string) => (s === "pre" ? -1 : s === "post" ? 9999 : Number(s.slice(0, 2)) * 60 + Number(s.slice(3)));
  const slots: SlotStat[] = [];
  for (const [slot, list] of Object.entries(groups)) {
    if (slot === "—") continue;
    const u = computeUsdStats(list);
    if (!u.n) continue;
    slots.push({ slot, n: u.n, net: u.net ?? 0, expectancy: u.expectancy ?? 0, winrate: u.winrate });
  }
  slots.sort((a, b) => order(a.slot) - order(b.slot));
  const best = slots.filter((s) => s.n >= minN && s.net > 0).sort((a, b) => b.net - a.net).slice(0, 3);
  return { slots, best };
}
