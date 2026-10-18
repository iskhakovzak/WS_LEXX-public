/**
 * Big 7 context model — pure functions (no React, no DOM), covered by context.test.ts.
 *
 * Inputs: 5-minute extended-hours candles for the last few sessions (GET /api/candles/:t/range, server
 * caches them), the 60-second quote and the daily gap/RS stats. Output: one row per ticker with
 * change, gap/premarket, RS vs QQQ, time-of-day RVOL, VWAP distance, key levels and correlation,
 * plus board breadth, cap-weighted move, contribution to QQQ/SPY and the market tone.
 */
import { dayLevels } from "@/components/chart-engine/lib/levels";
import { sessionVwap } from "@/components/chart-engine/lib/vwap";
import { etParts, RTH_OPEN_MIN, RTH_CLOSE_MIN, PRE_OPEN_MIN } from "@/components/chart-engine/lib/time";
import type { Candle } from "@/components/chart-engine/types";
import { nyDate, prevWeekday } from "@/lib/trading-date";
import { fmtNum } from "@/lib/format";
import type { GapStats, StockQuote } from "./lib";
import { big7I18n } from "@/i18n/ns/big7";

// ─── session date / phase ───────────────────────────────────────────────────
export type Phase = "pre" | "rth" | "post" | "closed";

function nyMinutes(d: Date): number {
  const p = etParts(Math.floor(d.getTime() / 1000));
  return p.mod;
}
function isWeekendKey(day: string): boolean {
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
  return wd === 0 || wd === 6;
}

/** Session the board describes: today from 04:00 ET on a weekday, otherwise the previous weekday. */
export function referenceSession(now: Date = new Date()): string {
  const today = nyDate(now);
  if (!isWeekendKey(today) && nyMinutes(now) >= PRE_OPEN_MIN) return today;
  return prevWeekday(today);
}

export function phaseOf(day: string, now: Date = new Date()): Phase {
  if (day !== nyDate(now)) return "closed";
  const m = nyMinutes(now);
  if (m < RTH_OPEN_MIN) return "pre";
  if (m < RTH_CLOSE_MIN) return "rth";
  return "post";
}

/** First day of the candle window: `n` weekdays before the session (prior day + spare for holidays). */
export function windowStart(day: string, n = 3): string {
  let d = day;
  for (let i = 0; i < n; i++) d = prevWeekday(d);
  return d;
}

// ─── per-ticker session snapshot from 5m bars ───────────────────────────────
export type SessionSnap = {
  /** Session day actually present in the bars (YYYY-MM-DD, ET). */
  day: string;
  pdc: number | null;
  pdh: number | null;
  pdl: number | null;
  pmh: number | null;
  pml: number | null;
  open: number | null;
  hod: number | null;
  lod: number | null;
  orb15: { h: number; l: number } | null;
  /** Last premarket close, last RTH close, last bar close of any session. */
  pmLast: number | null;
  rthClose: number | null;
  extLast: number | null;
  vwap: number | null;
  /** Regular-hours volume so far. */
  rthVol: number;
  /** Minutes of the regular session covered by bars (0…390). */
  rthMinutes: number;
  /** Session-day closes (premarket + regular), downsampled for sparklines. */
  spark: number[];
  /** Closes by bar time for the session day: premarket and regular separately. */
  pre: Array<{ t: number; c: number }>;
  rth: Array<{ t: number; c: number }>;
};

export function downsample(xs: number[], max = 64): number[] {
  if (xs.length <= max) return xs;
  const out: number[] = [];
  const step = (xs.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(xs[Math.round(i * step)]);
  return out;
}

export function buildSnap(candles: readonly Candle[], prevCloseHint: number | null = null): SessionSnap | null {
  const bars = candles.filter((c) => Number.isFinite(c.c) && Number.isFinite(c.h) && Number.isFinite(c.l) && c.h >= c.l).slice().sort((a, b) => a.t - b.t);
  if (!bars.length) return null;
  const day = etParts(bars[bars.length - 1].t).dayKey;
  const lv = dayLevels(bars, day, prevCloseHint);
  let hod: number | null = null, lod: number | null = null, rthClose: number | null = null, pmLast: number | null = null, extLast: number | null = null;
  let rthVol = 0, lastRthEnd = 0;
  const pre: Array<{ t: number; c: number }> = [];
  const rth: Array<{ t: number; c: number }> = [];
  for (const c of bars) {
    const p = etParts(c.t);
    if (p.dayKey !== day) continue;
    extLast = c.c;
    if (p.mod >= PRE_OPEN_MIN && p.mod < RTH_OPEN_MIN) { pmLast = c.c; pre.push({ t: c.t, c: c.c }); }
    else if (p.mod >= RTH_OPEN_MIN && p.mod < RTH_CLOSE_MIN) {
      hod = hod == null ? c.h : Math.max(hod, c.h);
      lod = lod == null ? c.l : Math.min(lod, c.l);
      rthClose = c.c;
      rthVol += Number.isFinite(c.v) && c.v > 0 ? c.v : 0;
      lastRthEnd = Math.max(lastRthEnd, p.mod - RTH_OPEN_MIN + 5);
      rth.push({ t: c.t, c: c.c });
    }
  }
  const vw = sessionVwap(bars.filter((c) => etParts(c.t).dayKey === day));
  return {
    day,
    pdc: lv.pdc, pdh: lv.pdh, pdl: lv.pdl, pmh: lv.pmh, pml: lv.pml, open: lv.open, orb15: lv.orb15,
    hod, lod, pmLast, rthClose, extLast,
    vwap: vw.length ? vw[vw.length - 1].vwap : null,
    rthVol,
    rthMinutes: Math.min(390, lastRthEnd),
    spark: downsample([...pre, ...rth].map((x) => x.c)),
    pre, rth,
  };
}

// ─── RVOL by time of day ────────────────────────────────────────────────────
/** Typical cumulative share of a US large-cap's regular-session volume by minutes after the open (U-shape). */
const CUM_VOL: Array<[number, number]> = [
  [0, 0], [15, 0.09], [30, 0.15], [60, 0.24], [90, 0.31], [120, 0.37], [180, 0.47], [240, 0.56], [300, 0.66], [360, 0.8], [390, 1],
];
export function cumVolFrac(min: number): number {
  if (min <= 0) return 0;
  if (min >= 390) return 1;
  for (let i = 1; i < CUM_VOL.length; i++) {
    const [m1, f1] = CUM_VOL[i];
    if (min <= m1) {
      const [m0, f0] = CUM_VOL[i - 1];
      return f0 + ((f1 - f0) * (min - m0)) / (m1 - m0);
    }
  }
  return 1;
}
/** Volume so far vs the average day's volume expected by this time. Null before 10 minutes of trading. */
export function timeRvol(rthVol: number, rthMinutes: number, avgDailyVol: number | null | undefined): number | null {
  if (!avgDailyVol || avgDailyVol <= 0 || rthVol <= 0 || rthMinutes < 10) return null;
  return rthVol / (avgDailyVol * cumVolFrac(rthMinutes));
}

// ─── correlation / RS path ──────────────────────────────────────────────────
function returns(series: Array<{ t: number; c: number }>): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1].c, b = series[i].c;
    if (a > 0) m.set(series[i].t, b / a - 1);
  }
  return m;
}
/** Pearson correlation and beta of 5m returns vs the benchmark (aligned by bar time). Null with < 12 pairs. */
export function corrBeta(sym: Array<{ t: number; c: number }>, bench: Array<{ t: number; c: number }>): { corr: number; beta: number } | null {
  const rs = returns(sym), rb = returns(bench);
  const xs: number[] = [], ys: number[] = [];
  for (const [t, y] of rs) {
    const x = rb.get(t);
    if (x != null) { xs.push(x); ys.push(y); }
  }
  const n = xs.length;
  if (n < 12) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  if (sxx <= 0 || syy <= 0) return null;
  return { corr: sxy / Math.sqrt(sxx * syy), beta: sxy / sxx };
}

/** RS line (ticker % − benchmark % from their prior closes) by bar time. */
export function rsPath(sym: Array<{ t: number; c: number }>, symBase: number | null, bench: Array<{ t: number; c: number }>, benchBase: number | null): number[] {
  if (!symBase || !benchBase) return [];
  const bm = new Map(bench.map((b) => [b.t, b.c]));
  const out: number[] = [];
  for (const s of sym) {
    const q = bm.get(s.t);
    if (q == null) continue;
    out.push((s.c / symBase - 1) * 100 - (q / benchBase - 1) * 100);
  }
  return out;
}
/** Change of the RS line over the last `bars` bars (30 min on 5m bars). */
export function rsMomentum(path: number[], bars = 6): number | null {
  if (path.length < bars + 1) return null;
  return path[path.length - 1] - path[path.length - 1 - bars];
}

// ─── index weights (approximate) ────────────────────────────────────────────
/**
 * Approximate index weights, %, of the mega-caps (2026 level; Alphabet = both share classes).
 * Used only for the cap-weighted move and the «contribution to QQQ/SPY» estimate, labelled «≈».
 */
export const QQQ_WEIGHT: Record<string, number> = {
  NVDA: 9.0, MSFT: 8.4, AAPL: 7.9, AMZN: 5.6, GOOGL: 5.1, GOOG: 5.1, META: 3.6, TSLA: 3.2, AVGO: 5.0, NFLX: 1.3, COST: 2.4,
};
export const SPY_WEIGHT: Record<string, number> = {
  NVDA: 7.3, MSFT: 6.6, AAPL: 6.3, AMZN: 3.9, GOOGL: 4.0, GOOG: 4.0, META: 2.9, TSLA: 2.2, AVGO: 2.6, NFLX: 0.8, COST: 1.0,
};

// ─── row model ──────────────────────────────────────────────────────────────
export type LevelKey = "pmh" | "pml" | "pdh" | "pdl" | "pdc" | "open" | "vwap" | "hod" | "lod" | "orbh" | "orbl";
export const LEVEL_NAME: Record<LevelKey, string> = {
  pmh: "PM high", pml: "PM low", pdh: "PDH", pdl: "PDL", pdc: "PDC", open: "Open", vwap: "VWAP", hod: "HOD", lod: "LOD", orbh: "ORB15 high", orbl: "ORB15 low",
};
export type LevelPoint = { key: LevelKey; label: string; price: number; distPct: number | null; distAtr: number | null };

export type Big7Row = {
  symbol: string;
  price: number | null;
  pdc: number | null;
  chg: number | null;
  /** Opening gap (or the premarket move before the open). */
  gap: number | null;
  pmChg: number | null;
  rsQqq: number | null;
  rs30: number | null;
  rvol: number | null;
  vwap: number | null;
  vwapDist: number | null;
  atr: number | null;
  /** Today's range as % of ATR. */
  atrUsed: number | null;
  corr: number | null;
  beta: number | null;
  rs5: number | null;
  levels: LevelPoint[];
  above: LevelPoint | null;
  below: LevelPoint | null;
  spark: number[];
  wQqq: number | null;
  wSpy: number | null;
  /** Contribution to the index move, percentage points (≈ weight × change). */
  contribQqq: number | null;
  contribSpy: number | null;
};

const pct = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null && b > 0 ? (a / b - 1) * 100 : null);

export function livePrice(snap: SessionSnap | null, phase: Phase, quote?: StockQuote): number | null {
  if (!snap) return quote?.price ?? null;
  if (phase === "pre") return snap.pmLast ?? snap.rthClose ?? snap.extLast;
  if (phase === "rth") return quote?.price ?? snap.rthClose ?? snap.extLast;
  return snap.rthClose ?? quote?.price ?? snap.extLast;
}

export function buildRow(input: {
  symbol: string;
  snap: SessionSnap | null;
  quote?: StockQuote;
  stats?: GapStats;
  phase: Phase;
  qqq: { snap: SessionSnap | null; chg: number | null };
}): Big7Row {
  const { symbol, snap, quote, stats, phase, qqq } = input;
  const price = livePrice(snap, phase, quote);
  const pdc = snap?.pdc ?? quote?.prevClose ?? null;
  const chg = snap ? pct(price, pdc) : quote?.change ?? null;
  const pmChg = snap ? pct(snap.pmLast, pdc) : null;
  const gap = snap ? (snap.open != null ? pct(snap.open, pdc) : pmChg) : quote?.gapPct ?? stats?.todayGapPct ?? null;
  const rsQqq = chg != null && qqq.chg != null ? chg - qqq.chg : null;
  const useRth = phase !== "pre" && (snap?.rth.length ?? 0) > 0;
  const path = snap && qqq.snap ? rsPath(useRth ? snap.rth : snap.pre, pdc, useRth ? qqq.snap.rth : qqq.snap.pre, qqq.snap.pdc) : [];
  const cb = snap && qqq.snap ? corrBeta(snap.rth, qqq.snap.rth) : null;
  const atr = stats?.atr ?? quote?.atr ?? null;
  const hod = snap?.hod ?? quote?.high ?? null;
  const lod = snap?.lod ?? quote?.low ?? null;
  const rvol = snap ? timeRvol(snap.rthVol, snap.rthMinutes, quote?.avgVolume) : quote?.relativeVolume ?? null;
  const vwap = snap?.vwap ?? null;

  const raw: Array<[LevelKey, number | null | undefined]> = [
    ["pmh", snap?.pmh], ["pml", snap?.pml], ["pdh", snap?.pdh], ["pdl", snap?.pdl], ["pdc", pdc],
    ["open", snap?.open ?? quote?.open], ["vwap", vwap], ["orbh", snap?.orb15?.h], ["orbl", snap?.orb15?.l],
    ["hod", phase === "pre" ? null : hod], ["lod", phase === "pre" ? null : lod],
  ];
  const levels: LevelPoint[] = raw
    .filter((x): x is [LevelKey, number] => x[1] != null && Number.isFinite(x[1]) && x[1] > 0)
    .map(([key, p]) => ({
      key, label: LEVEL_NAME[key], price: p,
      distPct: price ? ((p - price) / price) * 100 : null,
      distAtr: price != null && atr ? (p - price) / atr : null,
    }))
    .sort((a, b) => b.price - a.price);
  // Nearest reference levels around the price; HOD/LOD and VWAP are shown separately.
  const refs = levels.filter((l) => l.key !== "hod" && l.key !== "lod" && l.key !== "vwap" && l.distPct != null && Math.abs(l.distPct) > 0.02);
  // Price outside every reference level → the day's extreme is the nearest meaningful mark.
  const extreme = (k: LevelKey) => levels.find((l) => l.key === k && l.distPct != null && Math.abs(l.distPct) > 0.02) ?? null;
  const above = refs.filter((l) => (l.distPct ?? 0) > 0).sort((a, b) => a.price - b.price)[0] ?? extreme("hod");
  const below = refs.filter((l) => (l.distPct ?? 0) < 0).sort((a, b) => b.price - a.price)[0] ?? extreme("lod");

  const wQqq = QQQ_WEIGHT[symbol] ?? null;
  const wSpy = SPY_WEIGHT[symbol] ?? null;
  return {
    symbol, price, pdc, chg, gap, pmChg, rsQqq,
    rs30: rsMomentum(path),
    rvol,
    vwap,
    vwapDist: price != null && vwap ? ((price - vwap) / vwap) * 100 : null,
    atr,
    atrUsed: atr && hod != null && lod != null && phase !== "pre" ? ((hod - lod) / atr) * 100 : null,
    corr: cb?.corr ?? null,
    beta: cb?.beta ?? null,
    rs5: stats?.rs5Qqq ?? null,
    levels, above, below,
    spark: snap?.spark.length ? snap.spark : quote?.spark ?? stats?.spark ?? [],
    wQqq, wSpy,
    contribQqq: wQqq != null && chg != null ? (wQqq * chg) / 100 : null,
    contribSpy: wSpy != null && chg != null ? (wSpy * chg) / 100 : null,
  };
}

// ─── board aggregate + tone ─────────────────────────────────────────────────
export type BoardAgg = {
  n: number;
  up: number;
  down: number;
  /** Cap-weighted change of the board, % (weights from QQQ_WEIGHT; equal weight when unknown). */
  weighted: number | null;
  contribQqq: number | null;
  contribSpy: number | null;
  /** Share of the QQQ move explained by the board (0…1+, null when QQQ is flat). */
  shareQqq: number | null;
  leaders: Big7Row[];
  laggards: Big7Row[];
};

export function boardAgg(rows: Big7Row[], qqqChg: number | null): BoardAgg {
  const live = rows.filter((r) => r.chg != null);
  const up = live.filter((r) => (r.chg ?? 0) > 0.02).length;
  const down = live.filter((r) => (r.chg ?? 0) < -0.02).length;
  let wSum = 0, wChg = 0;
  for (const r of live) { const w = r.wQqq ?? 1; wSum += w; wChg += w * (r.chg as number); }
  // Alphabet's two classes on one board would double count: keep the first one.
  const seen = new Set<string>();
  let cq = 0, cs = 0, hasQ = false, hasS = false;
  for (const r of live) {
    const k = r.symbol === "GOOG" ? "GOOGL" : r.symbol;
    if (seen.has(k)) continue;
    seen.add(k);
    if (r.contribQqq != null) { cq += r.contribQqq; hasQ = true; }
    if (r.contribSpy != null) { cs += r.contribSpy; hasS = true; }
  }
  const byRs = live.filter((r) => r.rsQqq != null).sort((a, b) => (b.rsQqq as number) - (a.rsQqq as number));
  return {
    n: live.length,
    up, down,
    weighted: wSum > 0 ? wChg / wSum : null,
    contribQqq: hasQ ? cq : null,
    contribSpy: hasS ? cs : null,
    shareQqq: hasQ && qqqChg != null && Math.abs(qqqChg) >= 0.1 ? cq / qqqChg : null,
    leaders: byRs.filter((r) => (r.rsQqq as number) >= 0.3).slice(0, 2),
    laggards: byRs.filter((r) => (r.rsQqq as number) <= -0.3).reverse().slice(0, 2),
  };
}

export type ToneKind = "on" | "off" | "mixed";
export type Tone = { kind: ToneKind; label: string; score: number; reasons: string[]; divergence: boolean };

const clamp1 = (x: number) => Math.max(-1, Math.min(1, x));

/**
 * Risk-on / risk-off from five signals, each in [−1, 1] with a weight:
 * QQQ change (1.5), breadth of the board (1), cap-weighted board move (1), QQQ vs VWAP (1, regular hours),
 * QQQ vs SMA20 (0.5). Score = weighted mean; ≥ 0.33 risk-on, ≤ −0.33 risk-off, otherwise mixed.
 */
export function marketTone(i: {
  qqqChg: number | null;
  spyChg: number | null;
  qqqVwapDist: number | null;
  qqqAboveSma20: boolean | null;
  agg: BoardAgg;
  phase: Phase;
}): Tone | null {
  const parts: Array<[number, number]> = [];
  if (i.qqqChg != null) parts.push([clamp1(i.qqqChg / 0.75), 1.5]);
  if (i.agg.n > 0) parts.push([(i.agg.up - i.agg.down) / i.agg.n, 1]);
  if (i.agg.weighted != null) parts.push([clamp1(i.agg.weighted / 1), 1]);
  if (i.qqqVwapDist != null && i.phase !== "pre") parts.push([clamp1(i.qqqVwapDist / 0.3), 1]);
  if (i.qqqAboveSma20 != null) parts.push([i.qqqAboveSma20 ? 1 : -1, 0.5]);
  if (!parts.length) return null;
  const wsum = parts.reduce((a, [, w]) => a + w, 0);
  const score = parts.reduce((a, [v, w]) => a + v * w, 0) / wsum;
  const kind: ToneKind = score >= 0.33 ? "on" : score <= -0.33 ? "off" : "mixed";
  const divergence = i.agg.weighted != null && i.qqqChg != null && Math.abs(i.agg.weighted) >= 0.25 && Math.abs(i.qqqChg) >= 0.15
    && Math.sign(i.agg.weighted) !== Math.sign(i.qqqChg);

  const t = big7I18n.t;
  const reasons: string[] = [];
  if (i.agg.n > 0) reasons.push(t("tone.upOf", { up: i.agg.up, n: i.agg.n }));
  if (i.qqqVwapDist != null && i.phase !== "pre") reasons.push(t(i.qqqVwapDist >= 0 ? "tone.qqqAboveVwap" : "tone.qqqBelowVwap"));
  if (divergence) reasons.push(t("tone.rotation"));
  else if (i.agg.shareQqq != null && i.agg.contribQqq != null && Math.abs(i.agg.shareQqq) >= 0.15)
    reasons.push(t("tone.megacapsShare", { value: fmtNum(i.agg.contribQqq, { signed: true }) }));
  if (i.qqqAboveSma20 != null && reasons.length < 3) reasons.push(t(i.qqqAboveSma20 ? "tone.qqqAboveSma" : "tone.qqqBelowSma"));

  const label = kind === "on" ? "Risk-on" : kind === "off" ? "Risk-off" : t("tone.mixed");
  return { kind, label, score, reasons: reasons.slice(0, 3), divergence };
}

/** One-line playbook hint for the tone. */
export function toneHint(t: Tone): string {
  if (t.divergence) return big7I18n.t("tone.hintDivergence");
  if (t.kind === "on") return big7I18n.t("tone.hintOn");
  if (t.kind === "off") return big7I18n.t("tone.hintOff");
  return big7I18n.t("tone.hintMixed");
}
