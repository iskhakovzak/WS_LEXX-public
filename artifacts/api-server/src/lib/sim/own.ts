/**
 * Simulator «Мои худшие дни» (own mode) — pure helpers, no I/O. The trader relives one of their OWN losing intraday
 * trades on the archived bars of that day and decides again.
 *
 * Game shape
 *   - Bars: the previous regular session (context, when archived at the same timeframe) + the day's premarket + the
 *     whole regular session (+ the after-hours bars up to the real exit when the trade ran past 16:00).
 *   - Decision bar = the last bar that CLOSED before the real first fill (an order there fills at its close ≈ the real
 *     entry). The game starts a short lead-in before it (30 one-minute / 6 five-minute bars, never before the last
 *     premarket bar when the entry was in the session), the server pauses the autoplay on the decision bar, then the
 *     rest of the day plays on. Nothing about the real trade except «it was here» is sent before the reveal.
 *   - Size = the real maximum position; fees = the trade's real fee per share; 1R per share = the real risk.
 *
 * Fairness: the ticker and the date are known to the player (their own trade), so own games never enter the weekly
 * desk board or the fair-game progress (lib/sim/store weeklyBoard / service myStats).
 *
 * Mistakes of the real trade use the daily-loop ids (lib/daily/types MistakeId): «structure:averaging» (an add below
 * the average of a long / above it for a short) and «structure:held_past_stop» (the exit went through the stop by
 * more than a tenth of the risk). The service adds whatever lib/daily mistakeCosts attributes to the trade.
 */
import { classifyTrade, type ExecIn, type LegRole } from "../tradeStructure";
import { sideOfRow } from "../tradeStructureStore";
import type { SimBar, SimResult } from "./engine";
import { PRE_OPEN, RTH_CLOSE, RTH_OPEN, etOf, riskUnitOf, type Levels, type SimTf } from "./scenario";

export type OwnPick = "worst" | "random" | "trade";
export const OWN_PICKS: readonly OwnPick[] = ["worst", "random", "trade"];
export const OWN_WINDOW_DAYS = 30;

/** A losing own trade as read from the DB (lib/sim/ownStore). */
export type OwnTradeRow = {
  id: number; ticker: string; day: string; side: string | null;
  entry: string | null; exit: string | null; stop: string | null; qty: string | null;
  pnl: string | null; fees: string | null; risk_usd: string | null;
  tf: "1m" | "5m";
  execs: { id: number; kind: string; price: string; qty: string | null; at: string | null }[];
};

export type OwnLeg = { role: LegRole; price: number; qty: number | null; at: string | null; idx: number | null };

/** Everything about the real trade the game needs; kept in sim_games.params.own (server only until the reveal). */
export type OwnParams = {
  tradeId: number;
  pick: OwnPick;
  ticker: string;
  date: string;
  side: "long" | "short";
  decisionIdx: number;
  entryIdx: number;
  exitIdx: number | null;
  realNet: number;
  realGross: number;
  realFees: number;
  maxQty: number;
  avgEntry: number | null;
  avgExit: number | null;
  stop: number | null;
  riskUsd: number;
  riskSource: "trade" | "stop" | "atr";
  legs: OwnLeg[];
  mistakes: string[];
};

/** What an active own game may show: it is the player's own trade, so the ticker and the date are not secret. */
export type OwnPublic = { tradeId: number; pick: OwnPick; ticker: string; date: string; decisionIdx: number; riskSource: OwnParams["riskSource"] };

export type OwnVerdict = "better" | "same" | "worse" | "skipped";
export type OwnCompare = { realNet: number; realR: number; simNet: number; simR: number; diff: number; riskUsd: number; verdict: OwnVerdict };

/** The reveal block of an own game. */
export type OwnReveal = OwnParams & { compare: OwnCompare };

const r2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: string | number | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const netOf = (t: Pick<OwnTradeRow, "pnl" | "fees">): number => r2((num(t.pnl) ?? 0) - Math.abs(num(t.fees) ?? 0));

export const publicOf = (o: OwnParams): OwnPublic => ({ tradeId: o.tradeId, pick: o.pick, ticker: o.ticker, date: o.date, decisionIdx: o.decisionIdx, riskSource: o.riskSource });

/* ─────────────────────────── The real trade ─────────────────────────── */

const KIND: Record<string, ExecIn["kind"]> = { entry: "entry", add: "add", trim: "trim", exit: "exit", stop: "stop" };

function execsOf(t: OwnTradeRow): ExecIn[] {
  return t.execs
    .map((e, i) => ({ id: Number(e.id) || i + 1, kind: KIND[e.kind] ?? "exit", price: Number(e.price), qty: num(e.qty), at: e.at ? new Date(e.at).toISOString() : null, sortOrder: i }))
    .filter((e) => Number.isFinite(e.price) && e.price > 0);
}

/** Legs, averages, max size and the stop of the real trade (lib/tradeStructure.classifyTrade over its fills). */
export function realStructure(t: OwnTradeRow) {
  const side = sideOfRow(t.side);
  const s = classifyTrade(execsOf(t), { side, source: "fills", stop: num(t.stop), riskUsd: num(t.risk_usd), tradeQty: num(t.qty) });
  const maxQty = Math.max(1, Math.round(s.stats.maxPosition ?? num(t.qty) ?? 1));
  return { side, legs: s.legs, stats: s.stats, maxQty };
}

/** Daily-loop mistake ids the real trade shows by itself (structure only; the service merges lib/daily on top). */
export function realMistakes(t: OwnTradeRow): string[] {
  const { side, legs, stats } = realStructure(t);
  const dir = side === "short" ? -1 : 1;
  const out: string[] = [];
  let prevAvg: number | null = null;
  let prevAt: number | null = null;
  for (const l of legs) {
    const at = l.at ? Date.parse(l.at) : null;
    // An add priced worse than the running average, placed later than the previous opening (not a split fill).
    if (l.role === "add" && prevAvg != null && dir * (l.price - prevAvg) < -1e-6 && (at == null || prevAt == null || at - prevAt >= 1000)) {
      out.push("structure:averaging");
      break;
    }
    if (l.opening) prevAt = at;
    prevAvg = l.avgAfter ?? prevAvg;
  }
  const stop = stats.stopPrice;
  const exit = [...legs].reverse().find((l) => !l.opening)?.price ?? num(t.exit);
  const risk = stats.riskPerShare;
  if (stop != null && exit != null && risk != null && netOf(t) < 0) {
    const tol = Math.max(0.01, risk * 0.1);
    if (dir * (stop - exit) > tol) out.push("structure:held_past_stop");
  }
  return out;
}

/** 1R of the real trade in $: its risk $, else the stop distance × max size, else the ATR unit × max size. */
export function riskOf(t: OwnTradeRow, maxQty: number, avgEntry: number | null, atrUnit: number): { usd: number; source: OwnParams["riskSource"] } {
  const risk = num(t.risk_usd);
  if (risk != null && risk > 0) return { usd: r2(risk), source: "trade" };
  const stop = num(t.stop);
  if (stop != null && avgEntry != null && Math.abs(avgEntry - stop) > 1e-9) return { usd: r2(Math.abs(avgEntry - stop) * maxQty), source: "stop" };
  return { usd: Math.max(0.01, r2(atrUnit * maxQty)), source: "atr" };
}

/* ─────────────────────────── The bars ─────────────────────────── */

export type OwnBuilt = {
  bars: SimBar[];
  startIdx: number;
  endIdx: number;
  decisionIdx: number;
  entryIdx: number;
  exitIdx: number | null;
  levels: Levels;
  /** ATR-based risk per share at the decision (fallback 1R and the sim's auto stop when the trade has no risk). */
  atrUnit: number;
  tf: SimTf;
};

/** Index of the bar containing `epoch` (the last bar that started at or before it); null before the first bar. */
export function barIndexAt(bars: readonly SimBar[], epoch: number): number | null {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= epoch) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans < 0 ? null : ans;
}

const LEAD_BARS: Record<"1m" | "5m", number> = { "1m": 30, "5m": 6 };

export function buildOwn(input: {
  day: string;
  tf: "1m" | "5m";
  dayBars: readonly SimBar[];
  prevBars: readonly SimBar[];
  prevLevels: { h: number; l: number; c: number } | null;
  /** Epoch seconds of the first and the last real fill. */
  firstAt: number;
  lastAt: number | null;
}): OwnBuilt | null {
  const sec = input.tf === "5m" ? 300 : 60;
  const day = input.dayBars.filter((b) => etOf(b.t).date === input.day);
  const lastMin = input.lastAt != null ? etOf(input.lastAt).min : RTH_CLOSE;
  const endMin = lastMin >= RTH_CLOSE ? Math.min(20 * 60, lastMin + 15) : RTH_CLOSE;
  const pre = day.filter((b) => { const m = etOf(b.t).min; return m >= PRE_OPEN && m < RTH_OPEN; });
  const rest = day.filter((b) => { const m = etOf(b.t).min; return m >= RTH_OPEN && m < endMin; });
  // A day archived mid-session (or a half day) has no «rest of the day» to play.
  if (rest.length < ((RTH_CLOSE - RTH_OPEN) / (sec / 60)) * 0.6) return null;
  const prev = input.prevBars.filter((b) => { const m = etOf(b.t).min; return m >= RTH_OPEN && m < RTH_CLOSE; });
  const bars = [...prev, ...pre, ...rest];
  const entryIdx = barIndexAt(bars, input.firstAt);
  if (entryIdx == null || entryIdx < 1 || etOf(input.firstAt).date !== input.day) return null;
  const decisionIdx = entryIdx - 1;
  const endIdx = bars.length - 1;
  if (endIdx - decisionIdx < 5) return null;
  const lastPre = prev.length + pre.length - 1;
  let startIdx = decisionIdx - LEAD_BARS[input.tf];
  if (decisionIdx > lastPre && lastPre >= 0) startIdx = Math.max(startIdx, lastPre);
  startIdx = Math.min(decisionIdx, Math.max(startIdx, Math.min(decisionIdx, 15)));
  const exitIdx = input.lastAt != null ? barIndexAt(bars, input.lastAt) : null;
  let pmh: number | null = null, pml: number | null = null;
  for (const b of pre) { pmh = pmh == null ? b.h : Math.max(pmh, b.h); pml = pml == null ? b.l : Math.min(pml, b.l); }
  const pl = input.prevLevels ?? (prev.length ? { h: Math.max(...prev.map((b) => b.h)), l: Math.min(...prev.map((b) => b.l)), c: prev[prev.length - 1].c } : null);
  const visible = bars.slice(0, decisionIdx + 1);
  return {
    bars, startIdx, endIdx, decisionIdx, entryIdx, exitIdx: exitIdx != null && exitIdx <= endIdx ? exitIdx : null,
    levels: { pdh: pl?.h ?? null, pdl: pl?.l ?? null, pdc: pl?.c ?? null, pmh, pml },
    atrUnit: riskUnitOf(visible, input.tf, visible[visible.length - 1]?.c ?? 0),
    tf: input.tf,
  };
}

/** The real trade + the built day → OwnParams (legs placed on the bars). */
export function ownParamsOf(t: OwnTradeRow, built: OwnBuilt, pick: OwnPick, mistakes: string[]): OwnParams {
  const { side, legs, stats, maxQty } = realStructure(t);
  const avgEntry = stats.avgEntry ?? num(t.entry);
  const risk = riskOf(t, maxQty, avgEntry, built.atrUnit);
  const gross = num(t.pnl) ?? 0;
  return {
    tradeId: t.id, pick, ticker: t.ticker, date: t.day, side,
    decisionIdx: built.decisionIdx, entryIdx: built.entryIdx, exitIdx: built.exitIdx,
    realNet: netOf(t), realGross: r2(gross), realFees: r2(Math.abs(num(t.fees) ?? 0)), maxQty,
    avgEntry, avgExit: stats.avgExit ?? num(t.exit), stop: stats.stopPrice,
    riskUsd: risk.usd, riskSource: risk.source,
    legs: legs.map((l) => {
      const at = l.at ? Date.parse(l.at) / 1000 : null;
      const idx = at != null ? barIndexAt(built.bars, at) : null;
      return { role: l.role, price: l.price, qty: l.qty, at: l.at, idx: idx != null && idx <= built.endIdx ? idx : null };
    }),
    mistakes: [...new Set(mistakes)],
  };
}

/** Real fee per share per fill when it is sane (else null → the desk rate). */
export function feePerShareOf(t: OwnTradeRow, maxQty: number): number | null {
  const fees = Math.abs(num(t.fees) ?? NaN);
  if (!Number.isFinite(fees) || maxQty <= 0) return null;
  const v = fees / (2 * maxQty);
  return v >= 0.0005 && v <= 0.05 ? Math.round(v * 100000) / 100000 : null;
}

/* ─────────────────────────── Comparison ─────────────────────────── */

/** The real trade vs the sim decision, both in $ and in the real trade's R. */
export function compareOwn(o: Pick<OwnParams, "realNet" | "riskUsd">, sim: Pick<SimResult, "net" | "trades">): OwnCompare {
  const risk = o.riskUsd > 0 ? o.riskUsd : 1;
  const diff = r2(sim.net - o.realNet);
  const same = Math.abs(diff) < Math.max(1, risk * 0.05);
  return {
    realNet: o.realNet, realR: r2(o.realNet / risk), simNet: sim.net, simR: r2(sim.net / risk), diff, riskUsd: o.riskUsd,
    verdict: sim.trades === 0 ? "skipped" : same ? "same" : diff > 0 ? "better" : "worse",
  };
}

/* ─────────────────────────── Picking ─────────────────────────── */

export type OwnCandidate = { id: number; day: string; net: number; riskUsd: number | null; mistakes: string[] };

/**
 * Order in which to try candidates.
 *   worst  — the biggest net loss of the last 30 days not played yet; then older unplayed ones; then the ones played
 *            longest ago (a replay is still useful once everything was played).
 *   random — unplayed first, weighted by the loss in R (or $ / 50 without risk) × (1 + 0.6 per mistake).
 */
export function pickOrder(
  cands: readonly OwnCandidate[],
  pick: Exclude<OwnPick, "trade">,
  played: ReadonlyMap<number, number>,
  lastDay: string,
  windowFrom: string,
  rnd: () => number = Math.random,
): OwnCandidate[] {
  const fresh = cands.filter((c) => !played.has(c.id));
  const replay = cands.filter((c) => played.has(c.id)).sort((a, b) => (played.get(a.id) ?? 0) - (played.get(b.id) ?? 0));
  if (pick === "worst") {
    const byLoss = (a: OwnCandidate, b: OwnCandidate) => a.net - b.net || b.day.localeCompare(a.day);
    const inWindow = fresh.filter((c) => c.day >= windowFrom && c.day <= lastDay).sort(byLoss);
    const older = fresh.filter((c) => !(c.day >= windowFrom && c.day <= lastDay)).sort(byLoss);
    return [...inWindow, ...older, ...replay];
  }
  const weight = (c: OwnCandidate) => {
    const lossR = c.riskUsd && c.riskUsd > 0 ? -c.net / c.riskUsd : -c.net / 50;
    return Math.max(0.05, lossR) * (1 + 0.6 * c.mistakes.length);
  };
  const keyed = (xs: OwnCandidate[]) => xs
    .map((c) => ({ c, k: Math.pow(Math.max(rnd(), 1e-12), 1 / weight(c)) }))
    .sort((a, b) => b.k - a.k)
    .map((e) => e.c);
  return [...keyed(fresh), ...keyed(replay)];
}
