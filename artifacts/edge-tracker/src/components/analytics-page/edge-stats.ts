/**
 * Edge-finder maths: seeded RNG, bootstrap confidence intervals, Monte Carlo on a trade distribution,
 * "what if" rule simulation and desk percentiles. Pure functions, no DOM, no imports — runs in a Web Worker
 * and in the offline node check (scratchpad/edge-check.mjs).
 */

/* ───────────────────────── RNG ───────────────────────── */

/** Deterministic 32-bit PRNG (mulberry32). Same seed ⇒ same simulation on every machine. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable string hash (FNV-1a) — turns "trader + filters" into a seed. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* ───────────────────────── Basic stats ───────────────────────── */

export function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Quantile of a *sorted ascending* array, linear interpolation. */
export function quantileSorted(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function quantile(xs: number[], q: number): number {
  return quantileSorted([...xs].sort((a, b) => a - b), q);
}

/** Peak-to-trough drawdown (≤ 0) of a cumulative series built from per-trade values. */
export function maxDrawdownOf(values: number[]): number {
  let cum = 0, peak = 0, dd = 0;
  for (const v of values) {
    cum += v;
    if (cum > peak) peak = cum;
    if (cum - peak < dd) dd = cum - peak;
  }
  return dd;
}

export type ValueKpis = {
  n: number;
  total: number;
  wins: number;
  losses: number;
  /** wins / (wins + losses) over non-zero values; null when nothing is decided. */
  winRate: number | null;
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** Σ⁺ / |Σ⁻|; null when there are no losses (never ∞). */
  profitFactor: number | null;
  maxDrawdown: number;
  maxLossStreak: number;
};

/** KPIs of a value series (signed R or net $) in chronological order. */
export function kpisOf(values: number[]): ValueKpis {
  let total = 0, wins = 0, losses = 0, sumW = 0, sumL = 0, streak = 0, maxStreak = 0;
  for (const v of values) {
    total += v;
    if (v > 0) { wins++; sumW += v; streak = 0; }
    else if (v < 0) { losses++; sumL += v; streak++; if (streak > maxStreak) maxStreak = streak; }
    else streak = 0;
  }
  const n = values.length;
  return {
    n, total, wins, losses,
    winRate: wins + losses ? wins / (wins + losses) : null,
    expectancy: n ? total / n : null,
    avgWin: wins ? sumW / wins : null,
    avgLoss: losses ? sumL / losses : null,
    profitFactor: sumL < 0 ? sumW / Math.abs(sumL) : null,
    maxDrawdown: maxDrawdownOf(values),
    maxLossStreak: maxStreak,
  };
}

/* ───────────────────────── Bootstrap CI ───────────────────────── */

export type BootstrapCI = { mean: number; lo: number; hi: number; n: number; iters: number; /** CI excludes zero on the positive side. */ significant: boolean };

/**
 * Percentile bootstrap CI of the mean (default 95%). Resamples with replacement `iters` times.
 * Returns null for n < 2 (a single observation has no spread).
 */
export function bootstrapMeanCI(values: number[], opts: { iters?: number; alpha?: number; seed?: number } = {}): BootstrapCI | null {
  const n = values.length;
  if (n < 2) return null;
  const iters = opts.iters ?? 1000;
  const alpha = opts.alpha ?? 0.05;
  const rnd = mulberry32(opts.seed ?? 20240917);
  const means = new Float64Array(iters);
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[(rnd() * n) | 0];
    means[b] = s / n;
  }
  const sorted = Array.from(means).sort((a, b) => a - b);
  const lo = quantileSorted(sorted, alpha / 2);
  const hi = quantileSorted(sorted, 1 - alpha / 2);
  return { mean: mean(values)!, lo, hi, n, iters, significant: lo > 0 };
}

/* ───────────────────────── Monte Carlo ───────────────────────── */

export type MonteCarloInput = {
  /** Historical per-trade outcomes (signed R or net $). Sampled with replacement. */
  values: number[];
  /** Simulated trades per run. */
  horizon: number;
  runs?: number;
  seed?: number;
  /** Trades per simulated day (≥ 1) — groups the path into days/weeks for the limit checks. */
  tradesPerDay?: number;
  /** Positive magnitudes in the same unit as `values`; null ⇒ not checked. */
  dailyLossLimit?: number | null;
  weeklyLossLimit?: number | null;
  /** Equity floor below the start (positive magnitude) that counts as ruin, e.g. account size or max drawdown limit. */
  ruinLevel?: number | null;
  /** Step between recorded band points (default: every trade, or coarser for long horizons). */
  bandStep?: number;
};

export type MonteCarloBand = { i: number; p5: number; p25: number; p50: number; p75: number; p95: number };

export type MonteCarloResult = {
  runs: number;
  horizon: number;
  tradesPerDay: number;
  bands: MonteCarloBand[];
  final: { p5: number; p25: number; p50: number; p75: number; p95: number; mean: number };
  /** Share of runs ending above zero. */
  probProfit: number;
  /** Share of runs with at least one day worse than −dailyLossLimit (null when no limit). */
  probDailyLimit: number | null;
  probWeeklyLimit: number | null;
  /** Share of runs whose equity ever fell below −ruinLevel. */
  probRuin: number | null;
  /** Expected number of daily-limit days per run (null when no limit). */
  limitDaysPerRun: number | null;
  maxDrawdown: { p50: number; p95: number; worst: number };
  maxLossStreak: { p50: number; p95: number; worst: number };
  /** Historical input summary. */
  input: { n: number; mean: number; winRate: number | null };
};

/** Run `runs` bootstrap paths of `horizon` trades. ~1000×500 is well under 50 ms; call from a worker anyway. */
export function monteCarlo(inp: MonteCarloInput): MonteCarloResult | null {
  const values = inp.values.filter((v) => Number.isFinite(v));
  const n = values.length;
  if (n < 2 || inp.horizon < 1) return null;
  const runs = Math.max(10, Math.min(20000, inp.runs ?? 1000));
  const horizon = Math.max(1, Math.min(5000, Math.round(inp.horizon)));
  const tpd = Math.max(1, Math.round(inp.tradesPerDay ?? 1));
  const daily = inp.dailyLossLimit != null && inp.dailyLossLimit > 0 ? inp.dailyLossLimit : null;
  const weekly = inp.weeklyLossLimit != null && inp.weeklyLossLimit > 0 ? inp.weeklyLossLimit : null;
  const ruin = inp.ruinLevel != null && inp.ruinLevel > 0 ? inp.ruinLevel : null;
  const step = Math.max(1, inp.bandStep ?? Math.ceil(horizon / 100));
  const rnd = mulberry32(inp.seed ?? 1337);

  const stepIdx: number[] = [];
  for (let i = step; i <= horizon; i += step) stepIdx.push(i);
  if (stepIdx[stepIdx.length - 1] !== horizon) stepIdx.push(horizon);
  const bandsRaw = stepIdx.map(() => new Float64Array(runs));

  const finals = new Float64Array(runs);
  const dds = new Float64Array(runs);
  const streaks = new Float64Array(runs);
  let hitDaily = 0, hitWeekly = 0, hitRuin = 0, profit = 0, limitDays = 0;

  for (let r = 0; r < runs; r++) {
    let cum = 0, peak = 0, dd = 0, streak = 0, maxStreak = 0;
    let daySum = 0, weekSum = 0, dayHit = false, weekHit = false, ruined = false;
    let k = 0;
    for (let i = 1; i <= horizon; i++) {
      const v = values[(rnd() * n) | 0];
      cum += v;
      daySum += v;
      weekSum += v;
      if (cum > peak) peak = cum;
      if (cum - peak < dd) dd = cum - peak;
      if (v < 0) { streak++; if (streak > maxStreak) maxStreak = streak; } else streak = 0;
      if (ruin != null && cum <= -ruin) ruined = true;
      if (i % tpd === 0 || i === horizon) {
        if (daily != null && daySum <= -daily) { dayHit = true; limitDays++; }
        daySum = 0;
        const dayNo = Math.ceil(i / tpd);
        if (dayNo % 5 === 0 || i === horizon) {
          if (weekly != null && weekSum <= -weekly) weekHit = true;
          weekSum = 0;
        }
      }
      if (i === stepIdx[k]) { bandsRaw[k][r] = cum; k++; }
    }
    finals[r] = cum;
    dds[r] = dd;
    streaks[r] = maxStreak;
    if (cum > 0) profit++;
    if (dayHit) hitDaily++;
    if (weekHit) hitWeekly++;
    if (ruined) hitRuin++;
  }

  const bands: MonteCarloBand[] = stepIdx.map((i, k) => {
    const s = Array.from(bandsRaw[k]).sort((a, b) => a - b);
    return { i, p5: quantileSorted(s, 0.05), p25: quantileSorted(s, 0.25), p50: quantileSorted(s, 0.5), p75: quantileSorted(s, 0.75), p95: quantileSorted(s, 0.95) };
  });
  const fs = Array.from(finals).sort((a, b) => a - b);
  const ds = Array.from(dds).sort((a, b) => a - b); // most negative first
  const ss = Array.from(streaks).sort((a, b) => a - b);
  const wins = values.filter((v) => v > 0).length, losses = values.filter((v) => v < 0).length;
  return {
    runs, horizon, tradesPerDay: tpd, bands,
    final: { p5: quantileSorted(fs, 0.05), p25: quantileSorted(fs, 0.25), p50: quantileSorted(fs, 0.5), p75: quantileSorted(fs, 0.75), p95: quantileSorted(fs, 0.95), mean: mean(fs)! },
    probProfit: profit / runs,
    probDailyLimit: daily != null ? hitDaily / runs : null,
    probWeeklyLimit: weekly != null ? hitWeekly / runs : null,
    probRuin: ruin != null ? hitRuin / runs : null,
    limitDaysPerRun: daily != null ? limitDays / runs : null,
    maxDrawdown: { p50: quantileSorted(ds, 0.5), p95: quantileSorted(ds, 0.05), worst: ds[0] },
    maxLossStreak: { p50: quantileSorted(ss, 0.5), p95: quantileSorted(ss, 0.95), worst: ss[ss.length - 1] },
    input: { n, mean: mean(values)!, winRate: wins + losses ? wins / (wins + losses) : null },
  };
}

/* ───────────────────────── What-if rules ───────────────────────── */

export type SimTrade = {
  id: number;
  /** Trading day (close date), YYYY-MM-DD. */
  day: string;
  /** Minutes since midnight ET of the entry; null when unknown. */
  entryMin: number | null;
  setup: string;
  grade: string | null;
  horizon: "intraday" | "overnight" | "swing";
  r: number | null;
  net: number | null;
  /** Secondary order inside a day. */
  seq: number;
};

export type WhatIfRuleId = "dropWorstSetup" | "onlyAGrade" | "noEarly" | "capLoss1R" | "stopAfter2Losses" | "noOvernight";

/** Rule ids in display order (labels: analytics namespace `whatIf.rule.<id>`). */
export const WHAT_IF_RULE_IDS: WhatIfRuleId[] = ["dropWorstSetup", "onlyAGrade", "noEarly", "capLoss1R", "stopAfter2Losses", "noOvernight"];

/** Why a rule could not be applied (display: analytics namespace `whatIf.skip.<code>`). */
export type WhatIfSkip = "noLosingSetup" | "noGrades" | "noEntryTime" | "noMultiDay" | "noR";

export type WhatIfResult = {
  values: number[];
  trades: SimTrade[];
  removed: number;
  modified: number;
  /** Rules that could not be applied (no data) with the reason. */
  skipped: { rule: WhatIfRuleId; reason: WhatIfSkip }[];
  worstSetup: string | null;
};

export function worstSetupOf(trades: SimTrade[], unit: "r" | "usd", minN = 3): string | null {
  const sums = new Map<string, { total: number; n: number }>();
  for (const t of trades) {
    const v = unit === "r" ? t.r : t.net;
    if (v == null || !t.setup) continue;
    const e = sums.get(t.setup) ?? { total: 0, n: 0 };
    e.total += v; e.n++;
    sums.set(t.setup, e);
  }
  let worst: string | null = null, worstV = 0;
  for (const [k, e] of sums) {
    if (e.n < minN) continue;
    if (worst == null || e.total < worstV) { worst = k; worstV = e.total; }
  }
  return worst != null && worstV < 0 ? worst : null;
}

/** Sort by day, then entry time, then sequence. */
export function sortSim(trades: SimTrade[]): SimTrade[] {
  return [...trades].sort((a, b) => a.day.localeCompare(b.day) || (a.entryMin ?? 1e9) - (b.entryMin ?? 1e9) || a.seq - b.seq || a.id - b.id);
}

export function applyWhatIf(input: SimTrade[], rules: ReadonlySet<WhatIfRuleId>, unit: "r" | "usd"): WhatIfResult {
  const skipped: WhatIfResult["skipped"] = [];
  let trades = sortSim(input);
  let removed = 0, modified = 0;
  const valueOf = (t: SimTrade) => (unit === "r" ? t.r : t.net);

  let worstSetup: string | null = null;
  if (rules.has("dropWorstSetup")) {
    worstSetup = worstSetupOf(trades, unit);
    if (!worstSetup) skipped.push({ rule: "dropWorstSetup", reason: "noLosingSetup" });
    else { const before = trades.length; trades = trades.filter((t) => t.setup !== worstSetup); removed += before - trades.length; }
  }
  if (rules.has("onlyAGrade")) {
    if (!trades.some((t) => t.grade)) skipped.push({ rule: "onlyAGrade", reason: "noGrades" });
    else { const before = trades.length; trades = trades.filter((t) => t.grade === "A" || t.grade === "A+"); removed += before - trades.length; }
  }
  if (rules.has("noEarly")) {
    if (!trades.some((t) => t.entryMin != null)) skipped.push({ rule: "noEarly", reason: "noEntryTime" });
    else { const before = trades.length; trades = trades.filter((t) => t.entryMin == null || t.entryMin >= 9 * 60 + 45); removed += before - trades.length; }
  }
  if (rules.has("noOvernight")) {
    const before = trades.length;
    trades = trades.filter((t) => t.horizon === "intraday");
    removed += before - trades.length;
    if (before === trades.length) skipped.push({ rule: "noOvernight", reason: "noMultiDay" });
  }
  if (rules.has("stopAfter2Losses")) {
    const kept: SimTrade[] = [];
    let day = "", lossRun = 0, stopped = false;
    for (const t of trades) {
      if (t.day !== day) { day = t.day; lossRun = 0; stopped = false; }
      if (stopped) { removed++; continue; }
      kept.push(t);
      const v = valueOf(t);
      if (v != null && v < 0) { lossRun++; if (lossRun >= 2) stopped = true; } else if (v != null && v > 0) lossRun = 0;
    }
    trades = kept;
  }
  if (rules.has("capLoss1R")) {
    if (!trades.some((t) => t.r != null)) skipped.push({ rule: "capLoss1R", reason: "noR" });
    else {
      trades = trades.map((t) => {
        if (t.r == null || t.r >= -1) return t;
        modified++;
        const scale = -1 / t.r; // shrink the $ loss proportionally
        return { ...t, r: -1, net: t.net != null && t.net < 0 ? t.net * scale : t.net };
      });
    }
  }
  const values = trades.map(valueOf).filter((v): v is number => v != null);
  return { values, trades, removed, modified, skipped, worstSetup };
}

/* ───────────────────────── Percentiles vs desk ───────────────────────── */

/** Percentile rank 0..100 of `value` within `population` (share strictly below + half of ties). */
export function percentileRank(value: number, population: number[]): number | null {
  const pop = population.filter((v) => Number.isFinite(v));
  if (!pop.length) return null;
  let below = 0, ties = 0;
  for (const v of pop) { if (v < value) below++; else if (v === value) ties++; }
  return Math.round(((below + ties / 2) / pop.length) * 100);
}

/** Cumulative equity series from per-trade values. */
export function equityCurve(values: number[]): number[] {
  let cum = 0;
  return values.map((v) => (cum += v));
}
