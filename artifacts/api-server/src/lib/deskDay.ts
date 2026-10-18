/**
 * «Деск на тикере» — one ticker-day across the whole desk: every trader's legs (entry / add / partial exit / exit /
 * stop from lib/tradeStructure), side, result, R and hold time, plus a few deterministic takeaways.
 *
 * Pure (no DB): the store (lib/deskDayStore.ts) loads the rows and the structures, this file shapes the answer and
 * applies the money rule of lib/playbookPrivacy — a viewer gets $ and share counts only for trades they may see money
 * for (own trades; staff see all). For everyone else the answer keeps prices, times, roles, side, result and R, and
 * drops every field that would let the client compute $ (qty, position sizes, realized $, net, fees, risk $).
 *
 * Unit-tested in __tests__/deskDay.test.ts.
 */
import { canSeeTradeMoney, type MoneyViewer } from "./playbookPrivacy";
import { netPnl, normResult, signedR } from "./tradeMath";
import { nyMinutes } from "./tradingDate";
import type { LegRole, Side, TradeStructure } from "./tradeStructure";

export type DayResult = "win" | "loss" | "be" | "open";

/** One trade row as the store reads it (trades table). */
export interface DeskTradeRow {
  id: number;
  trader: string;
  side: string | null;
  result: string | null;
  entry: string | number | null;
  exit: string | number | null;
  stop: string | number | null;
  r_multiple: string | number | null;
  pnl: string | number | null;
  fees: string | number | null;
  risk_usd: string | number | null;
  qty: string | number | null;
}

export interface DeskLeg {
  role: LegRole;
  price: number;
  at: string | null;
  atEnd: string | null;
  opening: boolean;
  /** The leg bought (long opening / short closing) — markers point up from under the price. */
  buy: boolean;
  pieces: number;
  inferred: boolean;
  /** Share of the trade's max position (a ratio, no size). */
  fraction: number | null;
  /** Closing legs: per-share move against the average cost. */
  perShare: number | null;
  r: number | null;
  /** Money viewers only (null otherwise). */
  qty: number | null;
  realized: number | null;
}

export interface DeskTrade {
  id: number;
  trader: string;
  side: Side;
  result: DayResult | null;
  r: number | null;
  firstAt: string | null;
  lastAt: string | null;
  holdSec: number | null;
  avgEntry: number | null;
  avgExit: number | null;
  stopPrice: number | null;
  stopHit: boolean;
  reentryIndex: number;
  adds: number;
  partials: number;
  /** An add placed against the position (below the average for a long, above it for a short). */
  addedAgainst: boolean;
  fidelity: "fills" | "averages";
  /** Money viewers only (null otherwise). */
  net: number | null;
  qty: number | null;
  redacted: boolean;
  legs: DeskLeg[];
}

export interface DeskTrader {
  name: string;
  me: boolean;
  side: Side | "both";
  trades: number;
  result: DayResult | null;
  /** Sum of signed R; null when some closed trade has no R. */
  r: number | null;
  firstAt: string | null;
  lastAt: string | null;
  holdSec: number | null;
  addedAgainst: boolean;
  /** Money viewers only (null otherwise). */
  net: number | null;
  redacted: boolean;
}

/** Deterministic one-liners (the client words them). Times are ISO instants, R is signed. */
export type DeskTakeaway =
  | { kind: "best"; trader: string; r: number; side: Side; at: string; minutesFromOpen: number }
  | { kind: "averaging"; losers: number; averaged: number }
  | { kind: "timing"; winnersAt: string; losersAt: string; winners: number; losers: number }
  | { kind: "sides"; long: { traders: number; winners: number }; short: { traders: number; winners: number } };

export interface DeskDay {
  ticker: string;
  date: string;
  /** Viewer's name (null for none). */
  me: string | null;
  traders: DeskTrader[];
  trades: DeskTrade[];
  takeaways: DeskTakeaway[];
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const epoch = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t / 1000 : null;
};
const sideOf = (s: string | null | undefined): Side => ((s || "").toLowerCase().includes("short") ? "short" : "long");

/** Did any add go against the position (worse than the average cost before it)? Uses full data, answers a boolean. */
export function addedAgainst(s: TradeStructure): boolean {
  const dir = s.stats.side === "short" ? -1 : 1;
  let sum = 0, n = 0;
  for (const l of s.legs) {
    if (!l.opening) continue;
    if (l.role === "add" && n > 0 && dir * (l.price - sum / n) < 0) return true;
    // Unit-weighted when sizes are unknown; the average after the leg when they are.
    if (l.avgAfter != null) { sum = l.avgAfter; n = 1; } else { sum += l.price; n++; }
  }
  return false;
}

/** One trade with its legs, money fields only when the viewer may see them. */
export function shapeTrade(row: DeskTradeRow, s: TradeStructure, viewer: MoneyViewer): DeskTrade {
  const money = canSeeTradeMoney(viewer, row.trader);
  const side = s.stats.side ?? sideOf(row.side);
  const dir = side === "short" ? -1 : 1;
  const result = normResult(row.result);
  const firstAt = s.stats.firstAt, lastAt = s.stats.lastAt;
  const a = epoch(firstAt), b = epoch(lastAt);
  return {
    id: row.id,
    trader: row.trader,
    side,
    result,
    r: (() => { const r = signedR(row); return r == null ? null : round(r, 2); })(),
    firstAt,
    lastAt,
    holdSec: result !== "open" && a != null && b != null ? Math.max(0, Math.round(b - a)) : null,
    avgEntry: s.stats.avgEntry,
    avgExit: s.stats.avgExit,
    stopPrice: s.stats.stopPrice,
    stopHit: s.stats.stopHit,
    reentryIndex: s.stats.reentryIndex,
    adds: s.stats.adds,
    partials: s.stats.partials,
    addedAgainst: addedAgainst(s),
    fidelity: s.stats.fidelity,
    net: money ? (() => { const n = netPnl(row); return n == null ? null : round(n, 2); })() : null,
    qty: money ? s.stats.maxPosition : null,
    redacted: !money,
    legs: s.legs.map((l) => ({
      role: l.role,
      price: l.price,
      at: l.at,
      atEnd: l.atEnd,
      opening: l.opening,
      buy: (dir === 1) === l.opening,
      pieces: l.pieces,
      inferred: l.inferred,
      fraction: l.fraction,
      perShare: l.perShare,
      r: l.r,
      qty: money ? l.qty : null,
      realized: money ? l.realized : null,
    })),
  };
}

/** Day result of a set of trades: open if any is open; else the sign of the summed net; else the sign of summed R. */
export function dayResult(rows: readonly { result: DayResult | null; netFull: number | null; r: number | null }[]): DayResult | null {
  if (!rows.length) return null;
  if (rows.some((r) => r.result === "open")) return "open";
  const nets = rows.map((r) => r.netFull);
  if (nets.every((n) => n != null)) {
    const sum = nets.reduce<number>((s, n) => s + (n as number), 0);
    return sum > 0.005 ? "win" : sum < -0.005 ? "loss" : "be";
  }
  const rs = rows.map((r) => r.r);
  if (rs.every((r) => r != null)) {
    const sum = rs.reduce<number>((s, r) => s + (r as number), 0);
    return sum > 0 ? "win" : sum < 0 ? "loss" : "be";
  }
  const decided = rows.map((r) => r.result).filter((r): r is DayResult => r != null);
  if (!decided.length) return null;
  const w = decided.filter((r) => r === "win").length, l = decided.filter((r) => r === "loss").length;
  return w > l ? "win" : l > w ? "loss" : "be";
}

const RESULT_RANK: Record<DayResult, number> = { win: 3, be: 2, open: 1, loss: 0 };

/** Per-trader rows, best first (R, then result), the viewer's money rule applied. */
export function shapeTraders(rows: readonly DeskTradeRow[], trades: readonly DeskTrade[], viewer: MoneyViewer): DeskTrader[] {
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const byTrader = new Map<string, DeskTrade[]>();
  for (const t of trades) {
    const l = byTrader.get(t.trader);
    if (l) l.push(t); else byTrader.set(t.trader, [t]);
  }
  const out: DeskTrader[] = [];
  for (const [name, list] of byTrader) {
    const money = canSeeTradeMoney(viewer, name);
    const closed = list.filter((t) => t.result !== "open");
    const rKnown = closed.length > 0 && closed.every((t) => t.r != null);
    const sides = new Set(list.map((t) => t.side));
    const firsts = list.map((t) => t.firstAt).filter((x): x is string => !!x).sort();
    const lasts = list.map((t) => t.lastAt).filter((x): x is string => !!x).sort();
    const holds = list.map((t) => t.holdSec);
    const nets = list.map((t) => netPnl(rowById.get(t.id) ?? {}));
    out.push({
      name,
      me: !!viewer.name && viewer.name === name,
      side: sides.size > 1 ? "both" : [...sides][0],
      trades: list.length,
      result: dayResult(list.map((t, i) => ({ result: t.result, netFull: nets[i], r: t.r }))),
      r: rKnown ? round(closed.reduce((s, t) => s + (t.r as number), 0), 2) : null,
      firstAt: firsts[0] ?? null,
      lastAt: lasts[lasts.length - 1] ?? null,
      holdSec: holds.every((h) => h != null) ? holds.reduce<number>((s, h) => s + (h as number), 0) : null,
      addedAgainst: list.some((t) => t.addedAgainst),
      net: money && nets.every((n) => n != null) ? round(nets.reduce<number>((s, n) => s + (n as number), 0), 2) : null,
      redacted: !money,
    });
  }
  return out.sort((a, b) =>
    (b.r ?? -Infinity) - (a.r ?? -Infinity)
    || (b.result ? RESULT_RANK[b.result] : -1) - (a.result ? RESULT_RANK[a.result] : -1)
    || (a.firstAt ?? "").localeCompare(b.firstAt ?? "")
    || a.name.localeCompare(b.name));
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Minimum gap between the winners' and losers' typical entry time worth a line. */
const TIMING_MIN_GAP_SEC = 10 * 60;

/** Deterministic takeaways, most useful first. Only facts the data shows; nothing when the desk is a single trader. */
export function takeaways(traders: readonly DeskTrader[], trades: readonly DeskTrade[]): DeskTakeaway[] {
  const out: DeskTakeaway[] = [];
  if (traders.length < 2) return out;

  // Best single trade by R, with its first entry time.
  const best = trades.filter((t) => t.r != null && t.r > 0 && t.firstAt).sort((a, b) => (b.r as number) - (a.r as number))[0];
  if (best?.firstAt) {
    const mins = nyMinutes(new Date(best.firstAt)) - (9 * 60 + 30);
    out.push({ kind: "best", trader: best.trader, r: best.r as number, side: best.side, at: best.firstAt, minutesFromOpen: mins });
  }

  const losers = traders.filter((t) => t.result === "loss");
  const winners = traders.filter((t) => t.result === "win");
  const averaged = losers.filter((t) => t.addedAgainst).length;
  if (losers.length >= 2 && averaged >= 1) out.push({ kind: "averaging", losers: losers.length, averaged });

  const at = (list: DeskTrader[]) => median(list.map((t) => epoch(t.firstAt)).filter((x): x is number => x != null));
  const wAt = at(winners), lAt = at(losers);
  if (wAt != null && lAt != null && Math.abs(wAt - lAt) >= TIMING_MIN_GAP_SEC) {
    out.push({
      kind: "timing", winners: winners.length, losers: losers.length,
      winnersAt: new Date(Math.round(wAt) * 1000).toISOString(), losersAt: new Date(Math.round(lAt) * 1000).toISOString(),
    });
  }

  const bySide = (s: Side) => {
    const list = traders.filter((t) => t.side === s);
    return { traders: list.length, winners: list.filter((t) => t.result === "win").length };
  };
  const long = bySide("long"), short = bySide("short");
  if (long.traders > 0 && short.traders > 0) out.push({ kind: "sides", long, short });
  return out;
}

/** The whole answer from rows + their structures (rows without a structure are skipped). */
export function buildDeskDay(
  ticker: string, date: string, rows: readonly DeskTradeRow[], structures: ReadonlyMap<number, TradeStructure>, viewer: MoneyViewer,
): DeskDay {
  const trades = rows
    .filter((r) => structures.has(r.id))
    .map((r) => shapeTrade(r, structures.get(r.id)!, viewer))
    .sort((a, b) => (a.firstAt ?? "").localeCompare(b.firstAt ?? "") || a.id - b.id);
  const traders = shapeTraders(rows, trades, viewer);
  return { ticker, date, me: viewer.name, traders, trades, takeaways: takeaways(traders, trades) };
}
