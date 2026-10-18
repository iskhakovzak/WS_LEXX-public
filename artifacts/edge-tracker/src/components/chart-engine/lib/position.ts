/**
 * Fills → bars, running position, P&L per bar, MFE/MAE. Pure.
 *
 * Quantity handling: when every execution carries a qty, $ figures are exact (average-cost
 * method, partial exits realise against the running average). When some executions have no qty,
 * each fill counts as one unit and the whole position is scaled by the trade's qty (`qtyAssumed`).
 */
import type { Candle, ExcursionResult, Execution, ExecutionKind, Fill, PositionPoint, PositionState, Side, StructureLeg, TradeLike } from "../types";
import { barIndexForTime, etParts, isoToEpoch } from "./time";
import { fillLabelOf, roleFromKind, roleOf } from "./structure";
import { chartI18n } from "@/i18n/ns/chart";

/** Stored execution kinds in the UI language (getters). */
export const KIND_LABEL: Readonly<Record<ExecutionKind, string>> = {
  get entry() { return chartI18n.t("kind.entry"); },
  get add() { return chartI18n.t("kind.add"); },
  get trim() { return chartI18n.t("kind.trim"); },
  get exit() { return chartI18n.t("kind.exit"); },
  get stop() { return chartI18n.t("kind.stop"); },
};

export function sideOf(trade: Pick<TradeLike, "side">): Side {
  return (trade.side || "").toLowerCase().includes("short") ? "short" : "long";
}

export function toNum(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function isOpening(kind: ExecutionKind): boolean {
  return kind === "entry" || kind === "add";
}

type MergedExec = { ex: Execution; price: number; qty: number | null; pieces: number };

/**
 * Consecutive executions of one structure leg (one order filled in pieces — same `legIndex` from the API) become
 * one marker at their VWAP; executions without a leg stay as they are.
 */
function mergeLegs(sorted: readonly Execution[]): MergedExec[] {
  const out: MergedExec[] = [];
  let group: Execution[] = [];
  const flush = () => {
    if (!group.length) return;
    const known = group.every((e) => toNum(e.qty) != null);
    const priced = group.filter((e) => toNum(e.price) != null);
    if (priced.length) {
      const w = (e: Execution) => (known ? (toNum(e.qty) as number) : 1);
      const tw = priced.reduce((s, e) => s + w(e), 0);
      const price = tw > 0 ? priced.reduce((s, e) => s + (toNum(e.price) as number) * w(e), 0) / tw : (toNum(priced[0].price) as number);
      out.push({ ex: priced[0], price, qty: known ? group.reduce((s, e) => s + (toNum(e.qty) as number), 0) : null, pieces: group.length });
    }
    group = [];
  };
  for (const e of sorted) {
    const prev = group[group.length - 1];
    if (prev && (e.legIndex == null || prev.legIndex !== e.legIndex)) flush();
    group.push(e);
  }
  flush();
  return out;
}

/**
 * Place executions on `bars` (bar length `barSec`). Timestamped fills land in the bar containing
 * the instant; untimed fills are matched by price in chronological order after the previous fill.
 * Pieces of one order (same structure leg) are one marker; `legs` (GET …/executions → structure.legs) adds the
 * leg's numbers (position after, share of the size, R, reason) to each marker.
 * With no executions at all, a synthetic entry/exit pair is built from the trade's prices (`dayKey`
 * restricts the price search to the trade day).
 */
export function resolveFills(
  bars: readonly Candle[], barSec: number, executions: readonly Execution[],
  fallback: { entry: number | null; exit: number | null; qty: number | null; dayKey: string; exitDayKey?: string | null },
  legs: readonly StructureLeg[] = [],
): Fill[] {
  if (!bars.length) return [];
  const out: Fill[] = [];
  const sorted = [...executions].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const legByIndex = new Map(legs.map((l) => [l.index, l]));
  let cursor = 0;
  for (const { ex, price, qty, pieces } of mergeLegs(sorted)) {
    const role = roleOf(ex);
    const inferred = !!ex.roleInferred;
    const leg = ex.legIndex != null ? legByIndex.get(ex.legIndex) ?? null : null;
    const base = { id: ex.id, kind: ex.kind, price, qty, role, inferred, pieces, leg, label: fillLabelOf(role, inferred, price, qty) };
    const t = isoToEpoch(ex.executedAt);
    if (Number.isFinite(t)) {
      const idx = barIndexForTime(bars, t, barSec);
      out.push({ ...base, time: t, idx, byPrice: false });
      cursor = Math.max(cursor, idx);
      continue;
    }
    const idx = matchByPrice(bars, price, cursor);
    out.push({ ...base, time: null, idx, byPrice: true });
    cursor = Math.min(bars.length - 1, idx + 1);
  }
  if (!out.length) {
    const { entry, exit, qty, dayKey } = fallback;
    let first = bars.findIndex((c) => etParts(c.t).dayKey === dayKey);
    if (first < 0) first = 0;
    const synthetic = (id: number, kind: ExecutionKind, price: number, idx: number): Fill => {
      const role = roleFromKind(kind);
      return { id, kind, price, qty, time: null, idx, byPrice: true, role, inferred: false, pieces: 1, leg: null, label: fillLabelOf(role, false, price, qty) };
    };
    if (entry != null) {
      const idx = matchByPrice(bars, entry, first);
      out.push(synthetic(-1, "entry", entry, idx));
      if (exit != null) {
        const idx2 = matchByPrice(bars, exit, Math.min(bars.length - 1, idx + 1));
        out.push(synthetic(-2, "exit", exit, idx2));
      }
    }
  }
  out.sort((a, b) => a.idx - b.idx || (a.time ?? 0) - (b.time ?? 0) || a.id - b.id);
  return out;
}

function matchByPrice(bars: readonly Candle[], price: number, start: number): number {
  const s = Math.max(0, Math.min(start, bars.length - 1));
  for (let i = s; i < bars.length; i++) if (price >= bars[i].l && price <= bars[i].h) return i;
  let best = s, bestD = Infinity;
  for (let i = s; i < bars.length; i++) {
    const d = Math.abs((bars[i].h + bars[i].l) / 2 - price);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export function firstEntryIdx(fills: readonly Fill[]): number | null {
  const f = fills.find((x) => isOpening(x.kind));
  return f ? f.idx : null;
}
export function lastExitIdx(fills: readonly Fill[]): number | null {
  let idx: number | null = null;
  for (const f of fills) if (!isOpening(f.kind)) idx = idx == null ? f.idx : Math.max(idx, f.idx);
  return idx;
}

/** Volume-weighted average of the opening fills (null without any). */
export function avgEntryPrice(fills: readonly Fill[]): number | null {
  return weightedAvg(fills.filter((f) => isOpening(f.kind)));
}
/** Volume-weighted average of the closing fills. */
export function avgExitPrice(fills: readonly Fill[]): number | null {
  return weightedAvg(fills.filter((f) => !isOpening(f.kind)));
}
function weightedAvg(fs: Fill[]): number | null {
  if (!fs.length) return null;
  const anyNoQty = fs.some((f) => f.qty == null);
  let s = 0, q = 0;
  for (const f of fs) { const u = anyNoQty ? 1 : (f.qty as number); s += f.price * u; q += u; }
  return q > 0 ? s / q : null;
}

/** Shares of the position at its largest, when known. */
export function positionSize(fills: readonly Fill[], tradeQty: number | null): number | null {
  const opening = fills.filter((f) => isOpening(f.kind));
  if (opening.length && opening.every((f) => f.qty != null)) return opening.reduce((s, f) => s + (f.qty as number), 0);
  return tradeQty != null && tradeQty > 0 ? tradeQty : null;
}

type Acc = { qty: number; cost: number; realized: number; n: number };

function applyFill(acc: Acc, f: Fill, dir: 1 | -1, unit: number): void {
  acc.n++;
  if (isOpening(f.kind)) { acc.cost += f.price * unit; acc.qty += unit; return; }
  const q = Math.min(unit, acc.qty);
  if (q > 0) {
    const avg = acc.cost / acc.qty;
    acc.realized += dir * (f.price - avg) * q;
    acc.cost -= avg * q;
    acc.qty -= q;
  }
}

/** Position after every fill with `idx <= cursor`, marked at `mark`. */
export function positionAt(fills: readonly Fill[], cursor: number, side: Side, mark: number, tradeQty: number | null): PositionState {
  const dir: 1 | -1 = side === "short" ? -1 : 1;
  const anyNoQty = fills.some((f) => f.qty == null);
  const scale = anyNoQty ? (tradeQty != null && tradeQty > 0 ? tradeQty : null) : 1;
  const acc: Acc = { qty: 0, cost: 0, realized: 0, n: 0 };
  for (const f of fills) { if (f.idx > cursor) break; applyFill(acc, f, dir, anyNoQty ? 1 : (f.qty as number)); }
  const avg = acc.qty > 1e-9 ? acc.cost / acc.qty : null;
  const unrealPerShare = avg != null ? dir * (mark - avg) : null;
  const realized = scale != null ? acc.realized * scale : 0;
  const unrealized = unrealPerShare != null && scale != null ? unrealPerShare * acc.qty * scale : null;
  return {
    // Unknown size (no fill qty and no trade qty): no share count and no $ — only per-share moves are meaningful.
    qty: scale != null ? acc.qty * scale : 0,
    avg,
    realized,
    unrealized,
    total: scale == null ? null : unrealized != null ? unrealized + realized : acc.n ? realized : null,
    fillsSoFar: acc.n,
    qtyAssumed: anyNoQty,
  };
}

/**
 * Mark-to-market P&L for every bar from the first entry to the last exit (inclusive).
 * Empty when quantities cannot be established.
 */
export function positionSeries(bars: readonly Candle[], fills: readonly Fill[], side: Side, tradeQty: number | null): PositionPoint[] {
  const start = firstEntryIdx(fills);
  if (start == null) return [];
  const end = lastExitIdx(fills) ?? bars.length - 1;
  const dir: 1 | -1 = side === "short" ? -1 : 1;
  const anyNoQty = fills.some((f) => f.qty == null);
  const scale = anyNoQty ? (tradeQty != null && tradeQty > 0 ? tradeQty : null) : 1;
  if (scale == null) return [];
  const acc: Acc = { qty: 0, cost: 0, realized: 0, n: 0 };
  const out: PositionPoint[] = [];
  let fi = 0;
  for (let i = start; i <= end && i < bars.length; i++) {
    while (fi < fills.length && fills[fi].idx <= i) { applyFill(acc, fills[fi], dir, anyNoQty ? 1 : (fills[fi].qty as number)); fi++; }
    const avg = acc.qty > 1e-9 ? acc.cost / acc.qty : null;
    const unrealized = avg != null ? dir * (bars[i].c - avg) * acc.qty * scale : 0;
    const realized = acc.realized * scale;
    out.push({ idx: i, t: bars[i].t, qty: acc.qty * scale, avg, unrealized, realized, total: unrealized + realized });
  }
  return out;
}

/**
 * MFE / MAE from the moment of entry to the exit (or the end of the data when still open).
 *
 * The entry bar's high/low may have printed before the fill, so inside it only the fill price and
 * the bar close are used; the same applies to the exit bar (fill price + bar open). When that
 * exclusion drops any range the result is flagged `approximate`. With sub-bar data (e.g. 1m bars
 * under a 5m chart) call this with the finest bars available — that is what the engine does.
 */
export function excursion(
  bars: readonly Candle[], fills: readonly Fill[], side: Side,
  opts: { qty: number | null; riskPerShare: number | null },
): ExcursionResult | null {
  const entryIdx = firstEntryIdx(fills);
  const avg = avgEntryPrice(fills);
  if (entryIdx == null || avg == null || !bars.length) return null;
  const exitIdx = lastExitIdx(fills);
  const end = exitIdx ?? bars.length - 1;
  const dir = side === "short" ? -1 : 1;
  const entryFill = fills.find((f) => isOpening(f.kind))!;
  const exitFills = fills.filter((f) => !isOpening(f.kind) && f.idx === exitIdx);
  let hi = -Infinity, lo = Infinity, hiAt = 0, loAt = 0, approximate = false, used = 0;
  const consider = (price: number, t: number) => {
    if (price > hi) { hi = price; hiAt = t; }
    if (price < lo) { lo = price; loAt = t; }
  };
  for (let i = entryIdx; i <= end && i < bars.length; i++) {
    const b = bars[i];
    const isEntryBar = i === entryIdx;
    const isExitBar = exitIdx != null && i === exitIdx;
    if (isEntryBar || isExitBar) {
      // Partial bar: the fill itself plus the known side of the bar (close after an entry, open before an exit).
      if (isEntryBar) { consider(entryFill.price, b.t); if (!isExitBar) consider(b.c, b.t); }
      if (isExitBar) { for (const f of exitFills) consider(f.price, f.time ?? b.t); if (!isEntryBar) consider(b.o, b.t); }
      if (b.h > hi || b.l < lo) approximate = true;
      if (isEntryBar && entryFill.time != null && entryFill.time === b.t) {
        // Fill exactly at the bar open: the whole bar is after the entry.
        consider(b.h, b.t); consider(b.l, b.t); approximate = false;
      }
    } else {
      consider(b.h, b.t); consider(b.l, b.t);
    }
    used++;
  }
  if (!Number.isFinite(hi)) return null;
  const mfe = Math.max(0, dir === 1 ? hi - avg : avg - lo);
  const mae = Math.max(0, dir === 1 ? avg - lo : hi - avg);
  const qty = opts.qty;
  const r = opts.riskPerShare && opts.riskPerShare > 0 ? opts.riskPerShare : null;
  return {
    mfe, mae,
    mfeUsd: qty != null ? mfe * qty : null,
    maeUsd: qty != null ? -mae * qty : null,
    mfePct: avg > 0 ? (mfe / avg) * 100 : null,
    maePct: avg > 0 ? -(mae / avg) * 100 : null,
    mfeR: r ? mfe / r : null,
    maeR: r ? -mae / r : null,
    mfeAt: dir === 1 ? hiAt : loAt,
    maeAt: dir === 1 ? loAt : hiAt,
    mfePrice: dir === 1 ? hi : lo,
    maePrice: dir === 1 ? lo : hi,
    approximate,
    barsUsed: used,
  };
}

/** Risk per share from the stop (null without one). */
export function riskPerShare(avgEntry: number | null, stop: number | null): number | null {
  if (avgEntry == null || stop == null) return null;
  const r = Math.abs(avgEntry - stop);
  return r > 1e-9 ? r : null;
}

/** Gross result from fills in $ (null when qty is unknown). */
export function grossFromFills(fills: readonly Fill[], side: Side, tradeQty: number | null): number | null {
  const last = fills.length ? fills[fills.length - 1].idx : -1;
  const st = positionAt(fills, last, side, 0, tradeQty);
  if (fills.some((f) => f.qty == null) && (tradeQty == null || tradeQty <= 0)) return null;
  return st.realized;
}
