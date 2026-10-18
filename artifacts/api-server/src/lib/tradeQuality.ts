/**
 * Execution quality (MFE / MAE / efficiency) of one trade, computed from OHLC bars between
 * the first entry and the final exit. Pure: no I/O, no Date.now(), no timezone lookups
 * (the caller injects `dayKeyOf`), so it can be unit-tested with synthetic bars.
 *
 * Conventions
 * - `dir` = +1 long / −1 short. "Favourable" = price moved in the trade's direction.
 * - Position is rebuilt from fills (entry/add/trim/exit/stop) with average cost; a fill without
 *   quantity counts as one "unit" (`qtyAssumed`), $ figures then scale by trade qty when known.
 * - Partial bars (v2). When fill times are known to the second, the bar that opens the position and
 *   the bar that closes it are NOT taken with their full high/low — a bar's low that printed before the
 *   fill is not an adverse excursion of the trade. The known price path inside such a bar is reduced to
 *   the points we are sure of, in order: [bar open if the position was already open at bar start] →
 *   fill prices inside the bar → [bar close if the position is still open at bar end]. So:
 *     entry bar  → range between the entry fill and the bar close,
 *     exit bar   → range between the bar open and the exit fill,
 *     same bar   → range between entry and exit fills only,
 *     middle bars→ full high/low (the position was open the whole bar).
 *   Bars with untimed fills keep their full range (reported as `fills_placed_by_price`).
 * - Times: `entryAt` / `exitAt` / excursion `at` are fill times when known (else bar times);
 *   `seconds` fields are exact, `minutes` are rounded for display compatibility.
 * - Overnight gaps are inside the window automatically (next-day bars are just more bars),
 *   and are reported separately as `gaps`.
 */

export type QBar = { t: number; o: number; h: number; l: number; c: number; v?: number };

export type QFillKind = "entry" | "add" | "trim" | "exit" | "stop";

export type QFill = {
  kind: QFillKind;
  price: number;
  /** null ⇒ unknown (equal-weight unit). */
  qty: number | null;
  /** Epoch seconds, null ⇒ placed by price. */
  t: number | null;
  order: number;
};

export type QualityInput = {
  side: "long" | "short";
  /** Ascending by `t`. */
  bars: QBar[];
  interval: string;
  barSeconds: number;
  fills: QFill[];
  entry: number | null;
  exit: number | null;
  stop: number | null;
  qty: number | null;
  riskUsd: number | null;
  atr: number | null;
  isOpen: boolean;
  tradeDate: string;
  exitDate: string | null;
  afterExitMinutes: number;
  /** Trading-day key (YYYY-MM-DD in exchange time) of a bar timestamp. */
  dayKeyOf: (t: number) => string;
};

export type Excursion = {
  perShare: number;
  r: number | null;
  usd: number | null;
  /** Epoch seconds of the excursion point (fill time / bar boundary, see header). */
  at: number;
  /** Exact seconds after the entry fill (≥ 0). */
  seconds: number;
  /** Rounded minutes after the entry fill. */
  minutes: number;
  bars: number;
  price: number;
};

export type QualityReason =
  | "no_bars"
  | "no_entry"
  | "open_position"
  | "fills_placed_by_price"
  | "qty_assumed"
  | "no_bars_after_exit"
  | "coarse_bars"
  | "no_stop"
  | "no_risk"
  | "exit_not_in_bars"
  | "entry_not_in_bars"
  | "atr_from_day_range"
  | "no_atr";

export type TradeQuality = {
  version: 2;
  status: "ok" | "partial" | "unavailable";
  reasons: QualityReason[];
  interval: string;
  barsUsed: number;
  side: "long" | "short";
  qty: number | null;
  qtyAssumed: boolean;
  avgEntry: number | null;
  avgExit: number | null;
  stop: number | null;
  riskPerShare: number | null;
  riskSource: "stop" | "riskUsd" | null;
  /** First entry fill time (fill time when known, else the bar time). */
  entryAt: number | null;
  /** Final exit fill time (fill time when known, else the bar time); null while open. */
  exitAt: number | null;
  /** Exact hold in seconds (fill-to-fill when timed, else bar-based). */
  holdSeconds: number | null;
  holdMinutes: number | null;
  /** True when every fill carried a timestamp (partial-bar rule applied). */
  timedFills: boolean;
  mfe: Excursion | null;
  mae: Excursion | null;
  /** Realised per share / R / $ (null while open). */
  captured: { perShare: number; r: number | null; usd: number | null } | null;
  /** Mark-to-last-bar for open positions. */
  unrealised: { perShare: number; r: number | null; usd: number | null } | null;
  /** captured / MFE (1 = exited at the best price). Null when MFE = 0 or open. */
  exitEfficiency: number | null;
  /** Where the exit sits inside the trade's price range, 0 = worst price … 1 = best. */
  rangeEfficiency: number | null;
  leftOnTable: {
    perShare: number;
    r: number | null;
    usd: number | null;
    windowMinutes: number;
    bars: number;
    bestPrice: number;
    at: number;
    /** Same measure until the end of the exit day. */
    toCloseOfDay: number | null;
  } | null;
  /** 0..1 inside the entry bar's range, 1 = bought the low (sold the high). Weighted over openings. */
  entryEfficiency: number | null;
  heat: { perShare: number; r: number | null; usd: number | null; workedAtSeconds: number | null; workedAtMinutes: number | null; threshold: "1R" | "mfe" } | null;
  stopAtr: { atr: number; source: "trade" | "dayRange"; distanceAtr: number } | null;
  gaps: { count: number; worstPerShare: number | null; worstR: number | null; list: { day: string; perShare: number; r: number | null }[] } | null;
  placement: "time" | "price" | "mixed";
  fillsUsed: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

function inR(v: number, risk: number | null): number | null {
  return risk != null && risk > 0 ? r2(v / risk) : null;
}

/** Index of the bar containing `t` (or the nearest one). */
function barIndexAt(bars: QBar[], t: number, barSeconds: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (t >= b.t && t < b.t + barSeconds) return i;
    const d = Math.abs(b.t - t);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/** First bar whose [l, h] contains `price`, scanning from `from`; nearest-by-midpoint fallback. */
function barIndexByPrice(bars: QBar[], price: number, from: number, to = bars.length - 1): { idx: number; exact: boolean } {
  const start = Math.max(0, Math.min(from, bars.length - 1));
  const end = Math.max(start, Math.min(to, bars.length - 1));
  for (let i = start; i <= end; i++) {
    if (price >= bars[i].l && price <= bars[i].h) return { idx: i, exact: true };
  }
  let best = start;
  let bestDist = Infinity;
  for (let i = start; i <= end; i++) {
    const d = Math.abs((bars[i].h + bars[i].l) / 2 - price);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return { idx: best, exact: false };
}

/** A known price point inside a bar, with the time we attribute to it. */
type PricePoint = { price: number; at: number };

/**
 * Effective price path of bar `b` for a position that is `openAtStart` / `openAtEnd`, given the timed
 * fills that happened inside the bar (sorted by time). Full high/low when the position was open the whole
 * bar or when a fill inside it has no time; otherwise the hull of the certain points (see header).
 */
export function effectiveBarRange(
  b: QBar,
  barSeconds: number,
  openAtStart: boolean,
  openAtEnd: boolean,
  fillsInBar: { price: number; t: number | null }[],
): { lo: PricePoint; hi: PricePoint; partial: boolean } {
  const anyUntimed = fillsInBar.some((f) => f.t == null);
  if ((openAtStart && openAtEnd) || anyUntimed || !fillsInBar.length) {
    return { lo: { price: b.l, at: b.t }, hi: { price: b.h, at: b.t }, partial: false };
  }
  const pts: PricePoint[] = [];
  if (openAtStart) pts.push({ price: b.o, at: b.t });
  for (const f of fillsInBar) pts.push({ price: f.price, at: f.t as number });
  if (openAtEnd) pts.push({ price: b.c, at: b.t + barSeconds });
  let lo = pts[0], hi = pts[0];
  for (const p of pts) {
    if (p.price < lo.price) lo = p;
    if (p.price > hi.price) hi = p;
  }
  return { lo, hi, partial: true };
}

export function computeTradeQuality(input: QualityInput): TradeQuality {
  const { bars, barSeconds, side, dayKeyOf } = input;
  const dir = side === "short" ? -1 : 1;
  const reasons: QualityReason[] = [];
  const base: TradeQuality = {
    version: 2, status: "unavailable", reasons, interval: input.interval, barsUsed: bars.length,
    side, qty: input.qty, qtyAssumed: false, avgEntry: null, avgExit: null, stop: input.stop,
    riskPerShare: null, riskSource: null, entryAt: null, exitAt: null, holdSeconds: null, holdMinutes: null, timedFills: false,
    mfe: null, mae: null, captured: null, unrealised: null, exitEfficiency: null, rangeEfficiency: null,
    leftOnTable: null, entryEfficiency: null, heat: null, stopAtr: null, gaps: null, placement: "time", fillsUsed: 0,
  };
  if (!bars.length) { reasons.push("no_bars"); return base; }

  // ── Fills: real ones, or synthesised from entry/exit ──────────────────────
  let fills = input.fills
    .filter((f) => Number.isFinite(f.price) && f.price > 0)
    .sort((a, b) => a.order - b.order);
  const hasOpening = fills.some((f) => f.kind === "entry" || f.kind === "add");
  if (!hasOpening) {
    if (input.entry == null || !(input.entry > 0)) { reasons.push("no_entry"); return base; }
    fills = [{ kind: "entry", price: input.entry, qty: input.qty, t: null, order: 0 }];
    if (input.exit != null && input.exit > 0) fills.push({ kind: "exit", price: input.exit, qty: input.qty, t: null, order: 1 });
  }
  const anyNoQty = fills.some((f) => f.qty == null || !(f.qty > 0));
  const qtyAssumed = anyNoQty;
  if (qtyAssumed) reasons.push("qty_assumed");
  const unitOf = (f: QFill) => (qtyAssumed ? 1 : (f.qty as number));

  // ── Place fills on bars ───────────────────────────────────────────────────
  const firstTradeDayIdx = Math.max(0, bars.findIndex((b) => dayKeyOf(b.t) === input.tradeDate));
  let cursor = firstTradeDayIdx;
  let byTime = 0, byPrice = 0;
  const placed: { fill: QFill; idx: number }[] = [];
  for (const f of fills) {
    let idx: number;
    if (f.t != null && Number.isFinite(f.t)) {
      idx = barIndexAt(bars, f.t, barSeconds);
      byTime++;
    } else {
      const isClosing = f.kind === "exit" || f.kind === "trim" || f.kind === "stop";
      const from = placed.length ? Math.min(bars.length - 1, cursor) : firstTradeDayIdx;
      let to = bars.length - 1;
      if (isClosing && input.exitDate) {
        // Keep a synthesised/untimed exit on the exit day when that day is loaded.
        const lastOnExitDay = (() => { let j = -1; for (let i = 0; i < bars.length; i++) if (dayKeyOf(bars[i].t) === input.exitDate) j = i; return j; })();
        if (lastOnExitDay >= from) to = lastOnExitDay;
      } else if (!isClosing && !placed.length) {
        const lastOnTradeDay = (() => { let j = -1; for (let i = 0; i < bars.length; i++) if (dayKeyOf(bars[i].t) === input.tradeDate) j = i; return j; })();
        if (lastOnTradeDay >= from) to = lastOnTradeDay;
      }
      const r = barIndexByPrice(bars, f.price, from, to);
      idx = r.idx;
      if (!r.exact) reasons.push(isClosing ? "exit_not_in_bars" : "entry_not_in_bars");
      byPrice++;
    }
    placed.push({ fill: f, idx });
    cursor = Math.max(cursor, idx);
  }
  if (byPrice) reasons.push("fills_placed_by_price");
  base.placement = byTime && byPrice ? "mixed" : byPrice ? "price" : "time";
  base.fillsUsed = placed.length;
  base.qtyAssumed = qtyAssumed;
  base.timedFills = byPrice === 0;

  // ── Walk bars, rebuilding the position ────────────────────────────────────
  const openings = placed.filter((p) => p.fill.kind === "entry" || p.fill.kind === "add");
  const entryIdx = Math.min(...openings.map((p) => p.idx));
  const sortedPlaced = [...placed].sort((a, b) => a.idx - b.idx || (a.fill.t ?? 0) - (b.fill.t ?? 0) || a.fill.order - b.fill.order);
  const firstOpening = openings.reduce((m, p) => (p.idx < m.idx || (p.idx === m.idx && (p.fill.t ?? 0) < (m.fill.t ?? 0)) ? p : m), openings[0]);
  const entryFillT: number | null = firstOpening.fill.t != null ? firstOpening.fill.t : null;
  const entryT = entryFillT ?? bars[entryIdx].t; // reference point for "time after entry"

  let posQty = 0, posCost = 0, realised = 0;
  let openUnits = 0, openValue = 0, closeUnits = 0, closeValue = 0;
  let flatIdx: number | null = null;
  let lastClosingT: number | null = null;
  let fi = 0;
  let mfe: { v: number; i: number; price: number; at: number } | null = null;
  let mae: { v: number; i: number; price: number; at: number } | null = null;
  let maxUsd = -Infinity, minUsd = Infinity;
  let hi = -Infinity, lo = Infinity;
  const gaps: { day: string; perShare: number; r: number | null }[] = [];
  let prevDay = dayKeyOf(bars[entryIdx].t);
  let lastIdx = entryIdx;
  const favSeries: number[] = [];
  const advSeries: number[] = [];
  const favAt: number[] = [];

  for (let i = entryIdx; i < bars.length; i++) {
    const b = bars[i];
    const openAtStart = posQty > 1e-9;
    // Fills on this bar: openings are applied before the bar's excursion (the position exists during the bar),
    // closings after it (the exit bar's range still counts, with the pre-exit quantity for $ figures).
    const todays: QFill[] = [];
    while (fi < sortedPlaced.length && sortedPlaced[fi].idx === i) todays.push(sortedPlaced[fi++].fill);
    for (const fill of todays) {
      if (fill.kind !== "entry" && fill.kind !== "add") continue;
      const u = unitOf(fill);
      posCost += fill.price * u; posQty += u; openUnits += u; openValue += fill.price * u;
    }
    const day = dayKeyOf(b.t);
    if (day !== prevDay && i > entryIdx) {
      const gap = dir * (b.o - bars[i - 1].c);
      gaps.push({ day, perShare: r4(gap), r: null });
      prevDay = day;
    }
    const avg = posQty > 0 ? posCost / posQty : (openUnits ? openValue / openUnits : 0);
    const q = posQty > 0 ? posQty : 0;
    // Will the position still be open at the end of this bar? (closings are applied below)
    let qAfter = posQty;
    for (const fill of todays) {
      if (fill.kind === "entry" || fill.kind === "add") continue;
      qAfter -= Math.min(unitOf(fill), Math.max(qAfter, 0));
    }
    const openAtEnd = qAfter > 1e-9;
    const rng = effectiveBarRange(b, barSeconds, openAtStart, openAtEnd, todays.map((f) => ({ price: f.price, t: f.t })));
    const favPt = dir > 0 ? rng.hi : rng.lo;
    const advPt = dir > 0 ? rng.lo : rng.hi;
    const clampAt = (at: number) => Math.max(entryT, at);
    const fav = dir * (favPt.price - avg);
    const adv = dir * (avg - advPt.price);
    hi = Math.max(hi, rng.hi.price); lo = Math.min(lo, rng.lo.price);
    favSeries.push(fav); advSeries.push(adv); favAt.push(clampAt(favPt.at));
    if (!mfe || fav > mfe.v) mfe = { v: fav, i, price: favPt.price, at: clampAt(favPt.at) };
    if (!mae || adv > mae.v) mae = { v: adv, i, price: advPt.price, at: clampAt(advPt.at) };
    // $ excursion of the whole position (open P&L at best/worst + realised so far).
    maxUsd = Math.max(maxUsd, fav * q + realised);
    minUsd = Math.min(minUsd, -adv * q + realised);
    for (const fill of todays) {
      if (fill.kind === "entry" || fill.kind === "add") continue;
      const u = unitOf(fill);
      const qc = Math.min(u, posQty);
      if (qc > 0) {
        const a = posCost / posQty;
        realised += dir * (fill.price - a) * qc;
        posCost -= a * qc; posQty -= qc;
      }
      closeUnits += u; closeValue += fill.price * u;
      if (fill.t != null) lastClosingT = fill.t;
    }
    if (posQty <= 1e-9) flatIdx = i;
    lastIdx = i;
    if (flatIdx != null) break;
  }

  const avgEntry = openUnits ? openValue / openUnits : null;
  const avgExit = closeUnits ? closeValue / closeUnits : null;
  const isOpen = flatIdx == null;
  if (isOpen) reasons.push("open_position");
  const exitIdx = flatIdx ?? lastIdx;
  const exitFillT: number | null = !isOpen && base.timedFills ? lastClosingT : null;

  // Risk per share.
  let risk: number | null = null;
  let riskSource: TradeQuality["riskSource"] = null;
  if (avgEntry != null && input.stop != null && input.stop > 0 && Math.abs(avgEntry - input.stop) > 1e-9) {
    risk = Math.abs(avgEntry - input.stop); riskSource = "stop";
  } else if (input.riskUsd != null && input.riskUsd > 0 && input.qty != null && input.qty > 0) {
    risk = input.riskUsd / input.qty; riskSource = "riskUsd";
    if (input.stop == null) reasons.push("no_stop");
  } else {
    reasons.push(input.stop == null ? "no_stop" : "no_risk");
  }
  // $ scale: real quantities, or trade qty spread over assumed units.
  const usdScale: number | null = !qtyAssumed ? 1 : input.qty != null && input.qty > 0 && openUnits > 0 ? input.qty / openUnits : null;
  const usd = (perShareTimesUnits: number) => (usdScale == null ? null : r2(perShareTimesUnits * usdScale));

  const mk = (e: { v: number; i: number; price: number; at: number } | null, usdV: number): Excursion | null => e == null ? null : ({
    perShare: r4(Math.max(0, e.v)),
    r: inR(Math.max(0, e.v), risk),
    usd: usdScale == null ? null : r2(Math.max(0, usdV) * usdScale),
    at: e.at,
    seconds: Math.max(0, e.at - entryT),
    minutes: Math.round(Math.max(0, e.at - entryT) / 60),
    bars: e.i - entryIdx,
    price: r4(e.price),
  });
  base.mfe = mk(mfe, Number.isFinite(maxUsd) ? maxUsd : 0);
  base.mae = mk(mae, Number.isFinite(minUsd) ? -minUsd : 0);
  base.avgEntry = avgEntry != null ? r4(avgEntry) : null;
  base.avgExit = avgExit != null ? r4(avgExit) : null;
  base.riskPerShare = risk != null ? r4(risk) : null;
  base.riskSource = riskSource;
  base.entryAt = entryT;
  const exitT = isOpen ? null : (exitFillT ?? bars[exitIdx].t + barSeconds);
  base.exitAt = isOpen ? null : (exitFillT ?? bars[exitIdx].t);
  base.holdSeconds = exitT != null ? Math.max(0, exitT - entryT) : Math.max(0, bars[exitIdx].t + barSeconds - entryT);
  base.holdMinutes = Math.round(base.holdSeconds / 60);
  base.qty = input.qty ?? (qtyAssumed ? null : openUnits);
  // Timed fills inside one bar: the bar is coarser than the trade — excursions are the fill-to-fill path only.
  if (!isOpen && base.timedFills && base.holdSeconds < barSeconds && entryIdx === exitIdx) reasons.push("coarse_bars");

  for (const g of gaps) g.r = inR(g.perShare, risk);
  base.gaps = gaps.length
    ? { count: gaps.length, worstPerShare: r4(Math.min(...gaps.map((g) => g.perShare))), worstR: inR(Math.min(...gaps.map((g) => g.perShare)), risk), list: gaps }
    : null;

  // Captured / unrealised.
  if (!isOpen && avgEntry != null && avgExit != null) {
    const per = dir * (avgExit - avgEntry);
    base.captured = { perShare: r4(per), r: inR(per, risk), usd: usd(realised) };
    if (base.mfe && base.mfe.perShare > 0) base.exitEfficiency = r4(per / base.mfe.perShare);
    const range = hi - lo;
    if (range > 0) base.rangeEfficiency = r4(Math.max(0, Math.min(1, dir > 0 ? (avgExit - lo) / range : (hi - avgExit) / range)));
  } else if (avgEntry != null) {
    const last = bars[exitIdx].c;
    const per = dir * (last - avgEntry);
    base.unrealised = { perShare: r4(per), r: inR(per, risk), usd: usd(per * posQty + realised) };
  }

  // Left on the table after the exit (bars strictly after the exit bar; the rest of the exit bar is unknown).
  if (!isOpen && avgExit != null) {
    const exitRef = exitFillT ?? bars[exitIdx].t;
    const exitDay = dayKeyOf(bars[exitIdx].t);
    const limit = exitRef + Math.max(input.afterExitMinutes, 0) * 60;
    let best: number | null = null, bestAt = exitRef, n = 0;
    let bestDay: number | null = null;
    for (let i = exitIdx + 1; i < bars.length; i++) {
      const b = bars[i];
      if (dayKeyOf(b.t) !== exitDay) break;
      const p = dir > 0 ? b.h : b.l;
      const better = bestDay == null || dir * (p - bestDay) > 0;
      if (better) bestDay = p;
      if (b.t < limit) {
        n++;
        if (best == null || dir * (p - best) > 0) { best = p; bestAt = b.t; }
      }
    }
    if (best != null) {
      const per = Math.max(0, dir * (best - avgExit));
      base.leftOnTable = {
        perShare: r4(per), r: inR(per, risk), usd: usd(per * closeUnits),
        windowMinutes: input.afterExitMinutes, bars: n, bestPrice: r4(best), at: bestAt,
        toCloseOfDay: bestDay != null ? r4(Math.max(0, dir * (bestDay - avgExit))) : null,
      };
    } else {
      reasons.push(barSeconds >= 3600 ? "coarse_bars" : "no_bars_after_exit");
    }
  }

  // Entry efficiency inside the fill bars (weighted by units).
  {
    let wsum = 0, w = 0;
    for (const p of placed) {
      if (p.fill.kind !== "entry" && p.fill.kind !== "add") continue;
      const b = bars[p.idx];
      const rng = b.h - b.l;
      if (!(rng > 0)) continue;
      const eff = dir > 0 ? (b.h - p.fill.price) / rng : (p.fill.price - b.l) / rng;
      const u = unitOf(p.fill);
      wsum += Math.max(0, Math.min(1, eff)) * u; w += u;
    }
    base.entryEfficiency = w > 0 ? r4(wsum / w) : null;
  }

  // Heat before the trade "worked" (+1R, or the MFE point when R is unknown).
  if (mae && mfe) {
    let workIdx: number | null = null;
    if (risk != null) {
      for (let k = 0; k < favSeries.length; k++) if (favSeries[k] >= risk) { workIdx = k; break; }
    } else {
      workIdx = mfe.v > 0 ? mfe.i - entryIdx : null;
    }
    const until = workIdx ?? advSeries.length - 1;
    let heat = 0;
    for (let k = 0; k <= until; k++) heat = Math.max(heat, advSeries[k]);
    const workedAtSeconds = workIdx != null ? Math.max(0, (risk != null ? favAt[workIdx] : mfe.at) - entryT) : null;
    const heatUnits = openUnits > 0 ? openUnits : 1;
    base.heat = {
      perShare: r4(heat), r: inR(heat, risk),
      usd: usd(heat * heatUnits),
      workedAtSeconds,
      workedAtMinutes: workedAtSeconds != null ? Math.round(workedAtSeconds / 60) : null,
      threshold: risk != null ? "1R" : "mfe",
    };
  }

  // Stop distance in ATR.
  if (risk != null) {
    let atr: number | null = input.atr != null && input.atr > 0 ? input.atr : null;
    let source: "trade" | "dayRange" = "trade";
    if (atr == null) {
      let dh = -Infinity, dl = Infinity;
      for (const b of bars) if (dayKeyOf(b.t) === input.tradeDate) { dh = Math.max(dh, b.h); dl = Math.min(dl, b.l); }
      if (Number.isFinite(dh) && dh - dl > 0) { atr = dh - dl; source = "dayRange"; reasons.push("atr_from_day_range"); }
    }
    if (atr != null) base.stopAtr = { atr: r4(atr), source, distanceAtr: r2(risk / atr) };
    else reasons.push("no_atr");
  }

  base.status = isOpen || reasons.some((r) => r === "exit_not_in_bars" || r === "entry_not_in_bars" || r === "no_bars_after_exit" || r === "coarse_bars") ? "partial" : "ok";
  // Dedupe reasons, keep order.
  base.reasons = Array.from(new Set(reasons));
  return base;
}

/** Stable key of everything the computation depends on (for cache invalidation). */
export function qualityInputsKey(parts: unknown[]): string {
  return JSON.stringify(parts);
}
