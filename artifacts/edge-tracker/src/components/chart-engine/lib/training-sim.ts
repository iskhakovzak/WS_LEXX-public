/**
 * Training simulator — pure. The trader watches bars one by one with the future hidden and trades a paper
 * position: «Купить» / «Продать» / «½» (close half) / «В ноль» with a size, a stop and an optional target. Orders
 * fill at the close of the bar on the cursor (the bar the trader has just seen complete); the stop and the target
 * are checked on every bar revealed after that — the stop first (when one bar touches both, assume the worse) — and
 * fill at their price, or at the bar's open when the bar gaps through.
 *
 * At the end the attempt is scored against what was possible in the same stretch of bars (the best single
 * round trip on closes, either direction — «идеал») and compared with the real trade per share and in R.
 * Money here is the trainee's own paper size, never another trader's $.
 */
import type { Side, TrainingResult } from "../types";
import { chartI18n } from "@/i18n/ns/chart";

export type SimAction = "buy" | "sell" | "flat" | "half";
export type SimFillReason = SimAction | "stop" | "target";

export type SimFill = {
  idx: number;
  t: number;
  price: number;
  /** Signed shares: + bought, − sold. */
  qty: number;
  reason: SimFillReason;
};

export type SimState = {
  /** Signed open position in shares (+ long, − short). */
  pos: number;
  /** Average price of the open position (null when flat). */
  avg: number | null;
  /** Realised P&L in $ of the paper size. */
  realized: number;
  stop: number | null;
  /** Take-profit of the open position (null = none). */
  target: number | null;
  fills: SimFill[];
  /** Largest absolute position held (for per-share figures). */
  maxAbs: number;
  /** Risk in $ of the first position opened (|entry − stop| × qty); null without a stop. */
  firstRiskUsd: number | null;
  /** Number of round trips closed. */
  roundTrips: number;
};

export const EMPTY_SIM: SimState = { pos: 0, avg: null, realized: 0, stop: null, target: null, fills: [], maxAbs: 0, firstRiskUsd: null, roundTrips: 0 };

const EPS = 1e-9;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Apply a signed fill (± shares at price) to the position: closes against the open side first, the rest opens. */
function applyFill(s: SimState, fill: SimFill, stopForNew: number | null, targetForNew: number | null = null): SimState {
  let { pos, avg, realized, stop, target, maxAbs, firstRiskUsd, roundTrips } = s;
  let q = fill.qty;
  if (pos !== 0 && Math.sign(q) !== Math.sign(pos)) {
    const closing = Math.min(Math.abs(q), Math.abs(pos)) * Math.sign(q);
    // closing a long (sell, q<0): (price − avg) per share; closing a short (buy, q>0): (avg − price)
    realized += (avg ?? fill.price) * closing - fill.price * closing;
    pos += closing;
    q -= closing;
    if (Math.abs(pos) < EPS) { pos = 0; avg = null; stop = null; target = null; roundTrips += 1; }
  }
  if (Math.abs(q) > EPS) {
    const wasFlat = pos === 0;
    avg = wasFlat ? fill.price : ((avg ?? fill.price) * Math.abs(pos) + fill.price * Math.abs(q)) / (Math.abs(pos) + Math.abs(q));
    pos += q;
    if (wasFlat) {
      stop = stopForNew;
      target = targetForNew;
      if (firstRiskUsd == null && stopForNew != null && Math.abs(fill.price - stopForNew) > EPS) firstRiskUsd = Math.abs(fill.price - stopForNew) * Math.abs(q);
    }
  }
  maxAbs = Math.max(maxAbs, Math.abs(pos));
  return { pos, avg, realized, stop, target, fills: [...s.fills, fill], maxAbs, firstRiskUsd, roundTrips };
}

/** Is a stop on the wrong side of the price for this direction (would trigger immediately)? */
export function stopInvalid(dir: 1 | -1, price: number, stop: number | null): boolean {
  return stop != null && (dir > 0 ? stop >= price : stop <= price);
}

/** Is a target on the wrong side of the price for this direction (would fill immediately)? */
export function targetInvalid(dir: 1 | -1, price: number, target: number | null): boolean {
  return target != null && (dir > 0 ? target <= price : target >= price);
}

/**
 * Place an order at `price` (the close of bar `idx`). `qty` is ignored for «flat» / «half» (half of the open
 * position rounded down; a 1-share position closes fully). `stop` / `target` apply when the order opens a new
 * position (or replace those of the open one when it adds in the same direction); ones on the wrong side of the
 * price are ignored.
 */
export function simOrder(
  s: SimState,
  o: { action: SimAction; idx: number; t: number; price: number; qty?: number; stop?: number | null; target?: number | null },
): SimState {
  if (!(o.price > 0)) return s;
  let signed: number;
  if (o.action === "flat") {
    if (s.pos === 0) return s;
    signed = -s.pos;
  } else if (o.action === "half") {
    if (s.pos === 0) return s;
    const abs = Math.abs(s.pos);
    signed = -Math.sign(s.pos) * (abs >= 2 ? Math.floor(abs / 2) : abs);
  } else {
    const q = Math.floor(Math.abs(o.qty ?? 0));
    if (q <= 0) return s;
    signed = o.action === "buy" ? q : -q;
  }
  const finalDir = Math.sign(s.pos + signed) as 1 | -1 | 0;
  const opening = o.action === "buy" || o.action === "sell";
  const stop = opening && finalDir !== 0 && o.stop != null && !stopInvalid(finalDir as 1 | -1, o.price, o.stop) ? o.stop : null;
  const target = opening && finalDir !== 0 && o.target != null && !targetInvalid(finalDir as 1 | -1, o.price, o.target) ? o.target : null;
  const next = applyFill(s, { idx: o.idx, t: o.t, price: o.price, qty: signed, reason: o.action }, stop, target);
  // Adding in the same direction with a new stop / target moves them.
  const adding = s.pos !== 0 && next.pos !== 0 && Math.sign(next.pos) === Math.sign(s.pos) && Math.abs(next.pos) > Math.abs(s.pos);
  if (adding && (stop != null || target != null)) return { ...next, stop: stop ?? next.stop, target: target ?? next.target };
  return next;
}

/** Move (or remove) the stop of the open position. A stop on the wrong side of `price` is rejected (state unchanged). */
export function simSetStop(s: SimState, stop: number | null, price: number): SimState {
  if (s.pos === 0) return s;
  if (stop != null && stopInvalid(s.pos > 0 ? 1 : -1, price, stop)) return s;
  return { ...s, stop };
}

/** Move (or remove) the target of the open position. A target on the wrong side of `price` is rejected. */
export function simSetTarget(s: SimState, target: number | null, price: number): SimState {
  if (s.pos === 0) return s;
  if (target != null && targetInvalid(s.pos > 0 ? 1 : -1, price, target)) return s;
  return { ...s, target };
}

const tickRound = (p: number) => (p >= 1 ? Math.round(p * 100) / 100 : Math.round(p * 10000) / 10000);

/** Can the stop go to breakeven (the average price) at this price — i.e. is the price already beyond it in profit? */
export function canBreakeven(s: SimState, price: number | null): boolean {
  if (s.pos === 0 || s.avg == null || price == null) return false;
  const be = tickRound(s.avg);
  return !stopInvalid(s.pos > 0 ? 1 : -1, price, be) && s.stop !== be;
}

/** Stop to the average price («в безубыток»). Unchanged when the price is not beyond it in profit. */
export function simBreakeven(s: SimState, price: number): SimState {
  if (!canBreakeven(s, price)) return s;
  return simSetStop(s, tickRound(s.avg as number), price);
}

/** Check the stop, then the target, against a newly revealed bar (bar `idx` comes after the order bar). */
export function simApplyBar(s: SimState, bar: { t: number; o: number; h: number; l: number }, idx: number): SimState {
  if (s.pos === 0 || (s.stop == null && s.target == null)) return s;
  const long = s.pos > 0;
  if (s.stop != null && (long ? bar.l <= s.stop : bar.h >= s.stop)) {
    const price = long ? Math.min(bar.o, s.stop) : Math.max(bar.o, s.stop);
    return applyFill(s, { idx, t: bar.t, price, qty: -s.pos, reason: "stop" }, null);
  }
  if (s.target != null && (long ? bar.h >= s.target : bar.l <= s.target)) {
    const price = long ? Math.max(bar.o, s.target) : Math.min(bar.o, s.target);
    return applyFill(s, { idx, t: bar.t, price, qty: -s.pos, reason: "target" }, null);
  }
  return s;
}

/** Open + realised P&L ($) marked at `price`. */
export function simMark(s: SimState, price: number): { unrealized: number; total: number } {
  const unrealized = s.pos !== 0 && s.avg != null ? (price - s.avg) * s.pos : 0;
  return { unrealized, total: s.realized + unrealized };
}

/** Planned reward : risk of a stop and a target around `price` (null when either is missing or both are on one side). */
export function plannedRR(price: number | null, stop: number | null, target: number | null): number | null {
  if (price == null || stop == null || target == null) return null;
  const risk = Math.abs(price - stop), reward = Math.abs(target - price);
  if (risk < EPS || reward < EPS) return null;
  if (Math.sign(target - price) === Math.sign(stop - price)) return null;
  return reward / risk;
}

/** Live R of the whole attempt (realised + open) at `price`, against the first stop's risk; null without a stop. */
export function simLiveR(s: SimState, price: number | null): number | null {
  if (price == null || !s.firstRiskUsd) return null;
  return simMark(s, price).total / s.firstRiskUsd;
}

/** Label of a paper fill for the decision log (UI language). */
export function simFillLabel(f: Pick<SimFill, "qty" | "reason">): string {
  if (f.reason === "stop") return chartI18n.t("training.fill.stop");
  if (f.reason === "target") return chartI18n.t("training.fill.target");
  if (f.reason === "half") return chartI18n.t("training.fill.half");
  if (f.reason === "flat") return chartI18n.t("training.fill.flat");
  return f.qty > 0 ? chartI18n.t("training.fill.buy") : chartI18n.t("training.fill.sell");
}

export type IdealMove = { perShare: number; side: Side; fromIdx: number; toIdx: number } | null;

/** Best single round trip on closes inside [from, to] — long (buy low, sell later higher) or short. O(n). */
export function idealMove(closes: readonly number[], from: number, to: number): IdealMove {
  const a = Math.max(0, from), b = Math.min(closes.length - 1, to);
  if (b <= a) return null;
  let best: IdealMove = null;
  let minI = a, maxI = a;
  for (let i = a + 1; i <= b; i++) {
    const c = closes[i];
    if (!Number.isFinite(c)) continue;
    const up = c - closes[minI];
    if (up > (best?.perShare ?? 0) + EPS) best = { perShare: up, side: "long", fromIdx: minI, toIdx: i };
    const down = closes[maxI] - c;
    if (down > (best?.perShare ?? 0) + EPS) best = { perShare: down, side: "short", fromIdx: maxI, toIdx: i };
    if (c < closes[minI]) minI = i;
    if (c > closes[maxI]) maxI = i;
  }
  return best;
}

export type TrainingOutcome = {
  /** Paper P&L in $ of the trainee's own size (open position marked at the last bar). */
  pnlUsd: number;
  /** P&L per share of the largest position held (null when no trade was taken). */
  perShare: number | null;
  /** In R of the first stop (null without a stop). */
  r: number | null;
  trades: number;
  /** Best possible move per share in the watched window. */
  idealPerShare: number | null;
  idealSide: Side | null;
  /** 0–100: share of the ideal move captured (negative results score 0). Null when nothing was possible or done. */
  score: number | null;
  /** Real trade per share (side-adjusted, from its average prices) and in R (when it had a stop). */
  realPerShare: number | null;
  realR: number | null;
  /** perShare − realPerShare (null when either is unknown). */
  vsRealPerShare: number | null;
};

/** Score the attempt. `lastClose` marks a still-open paper position. `real` is null for a ticker-day task (no trade). */
export function scoreTraining(
  s: SimState,
  ctx: { lastClose: number; ideal: IdealMove; real: { side: Side; avgEntry: number | null; avgExit: number | null; risk: number | null } | null },
): TrainingOutcome {
  const { total } = simMark(s, ctx.lastClose);
  const traded = s.fills.length > 0;
  const perShare = traded && s.maxAbs > 0 ? total / s.maxAbs : null;
  const r = traded && s.firstRiskUsd ? total / s.firstRiskUsd : null;
  const ideal = ctx.ideal && ctx.ideal.perShare > EPS ? ctx.ideal : null;
  const score = perShare != null && ideal ? Math.round(Math.max(0, Math.min(1, perShare / ideal.perShare)) * 100) : null;
  let realPerShare: number | null = null, realR: number | null = null;
  if (ctx.real) {
    const { side, avgEntry, avgExit, risk } = ctx.real;
    const dir = side === "short" ? -1 : 1;
    realPerShare = avgEntry != null && avgExit != null ? dir * (avgExit - avgEntry) : null;
    realR = realPerShare != null && risk ? realPerShare / risk : null;
  }
  return {
    pnlUsd: r2(total),
    perShare,
    r,
    trades: s.roundTrips + (s.pos !== 0 ? 1 : 0),
    idealPerShare: ideal?.perShare ?? null,
    idealSide: ideal?.side ?? null,
    score,
    realPerShare,
    realR,
    vsRealPerShare: perShare != null && realPerShare != null ? perShare - realPerShare : null,
  };
}

export type ScoreVerdict = { label: string; tone: "up" | "neutral" | "warn" | "down" };

export function trainingVerdict(o: Pick<TrainingOutcome, "score" | "trades" | "pnlUsd">): ScoreVerdict {
  if (o.trades === 0) return { label: chartI18n.t("training.verdict.noTrades"), tone: "neutral" };
  if (o.pnlUsd < 0) return { label: chartI18n.t("training.verdict.loss"), tone: "down" };
  const s = o.score ?? 0;
  if (s >= 70) return { label: chartI18n.t("training.verdict.great"), tone: "up" };
  if (s >= 40) return { label: chartI18n.t("training.verdict.good"), tone: "up" };
  if (s >= 15) return { label: chartI18n.t("training.verdict.little"), tone: "warn" };
  return { label: chartI18n.t("training.verdict.zero"), tone: "warn" };
}

/** Suggested stop for a new position: just beyond the extreme of the last `lookback` bars (incl. the cursor bar). */
export function suggestStop(bars: readonly { h: number; l: number }[], idx: number, dir: 1 | -1, lookback = 5): number | null {
  if (idx < 0 || idx >= bars.length) return null;
  let ext = dir > 0 ? Infinity : -Infinity;
  for (let i = Math.max(0, idx - lookback + 1); i <= idx; i++) ext = dir > 0 ? Math.min(ext, bars[i].l) : Math.max(ext, bars[i].h);
  if (!Number.isFinite(ext)) return null;
  const tick = ext >= 1 ? 0.01 : 0.0001;
  return Math.round((ext - dir * tick) / tick) * tick;
}

/** Target at `rr` × the stop distance from `price` (null without a valid stop). */
export function targetAtRR(price: number | null, stop: number | null, rr: number): number | null {
  if (price == null || stop == null || !(rr > 0)) return null;
  const risk = price - stop;
  if (Math.abs(risk) < EPS) return null;
  const t = tickRound(price + risk * rr);
  return t > 0 && t !== price ? t : null;
}

/* ─── Session history (localStorage, per browser) ───────────────────────── */

export type TrainingRecord = TrainingResult;

export const TRAINING_HISTORY_KEY = "ws-chart:training-history:v2";
export const TRAINING_HISTORY_MAX = 200;

/** Newest first; capped. */
export function pushHistory(list: readonly TrainingRecord[], rec: TrainingRecord): TrainingRecord[] {
  return [rec, ...list].slice(0, TRAINING_HISTORY_MAX);
}

export function parseHistory(raw: string | null): TrainingRecord[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is TrainingRecord => !!x && typeof x.at === "number" && typeof x.tradeId === "number" && typeof x.ticker === "string").slice(0, TRAINING_HISTORY_MAX) : [];
  } catch { return []; }
}

/** Streak of consecutive most-recent attempts that ended in plus (newest first in `list`). */
export function winStreak(list: readonly TrainingRecord[]): number {
  let n = 0;
  for (const x of list) { if (x.trades > 0 && x.pnlUsd > 0) n++; else break; }
  return n;
}

export type HistoryStats = {
  count: number;
  avgScore: number | null;
  /** Share of attempts with trades that ended in plus. */
  plusShare: number | null;
  streak: number;
  /** Attempts better than the real trade per share, out of `comparable` (attempts that had a real trade to compare). */
  beatReal: number;
  comparable: number;
  /** Average / total R over attempts that traded with a stop. */
  avgR: number | null;
  sumR: number | null;
  /** Average R of the real trades in the same attempts (where known) — «ты vs трейдер». */
  avgRealR: number | null;
};

export function historyStats(list: readonly TrainingRecord[]): HistoryStats {
  const scored = list.filter((x) => x.score != null);
  const traded = list.filter((x) => x.trades > 0);
  const withR = traded.filter((x) => x.r != null && Number.isFinite(x.r));
  const withRealR = list.filter((x) => x.realR != null && Number.isFinite(x.realR));
  const comparable = list.filter((x) => x.vsRealPerShare != null);
  const sumR = withR.reduce((s, x) => s + (x.r as number), 0);
  return {
    count: list.length,
    avgScore: scored.length ? Math.round(scored.reduce((s, x) => s + (x.score ?? 0), 0) / scored.length) : null,
    plusShare: traded.length ? traded.filter((x) => x.pnlUsd > 0).length / traded.length : null,
    streak: winStreak(list),
    beatReal: comparable.filter((x) => (x.vsRealPerShare as number) > 0).length,
    comparable: comparable.length,
    avgR: withR.length ? sumR / withR.length : null,
    sumR: withR.length ? sumR : null,
    avgRealR: withRealR.length ? withRealR.reduce((s, x) => s + (x.realR as number), 0) / withRealR.length : null,
  };
}

/** Attempts of the current session (made at or after `since`, epoch ms). */
export function sessionSlice(list: readonly TrainingRecord[], since: number): TrainingRecord[] {
  return list.filter((x) => x.at >= since);
}
