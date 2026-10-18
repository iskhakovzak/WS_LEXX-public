/**
 * Simulator engine (/simulator, «Симулятор») — pure, no I/O. The server is the only place that knows the whole bar
 * series; the player only ever sees bars up to the cursor, and every number they see is computed here.
 *
 * Model
 *   - The game is an event log: orders (buy / sell / flat) and bracket changes (stop / target), each stamped with the
 *     bar index (`idx`) at whose CLOSE it happened. The state is always recomputed from the log (deterministic, so
 *     «undo the last order on the same bar» is just popping the log).
 *   - Orders fill at the close of their bar. Fees: `feePerShare` per share on every fill (the desk's real rate).
 *   - A bracket set on bar i is checked from bar i+1 on, against each bar's high / low: a stop fills at the stop or,
 *     when the bar opens beyond it (gap), at the open; same for the target. Both inside one bar → the stop first
 *     (conservative: we cannot know the path inside a bar).
 *   - A trade is one round trip flat → flat (adds and partial exits included). A flip closes one trade and opens the
 *     next one with the remainder.
 *   - R: risk per share is the stop distance set on the entry bar (floored at ¼ of the risk unit so a 1-cent stop
 *     cannot inflate R), otherwise the scenario's risk unit (ATR-based, see scenario.ts). Trade R = net $ / (risk per
 *     share × max shares held).
 */

export type SimBar = { t: number; o: number; h: number; l: number; c: number; v: number };

export type OrderKind = "buy" | "sell" | "flat";

/** `req` groups the events of one player request (an order with its bracket) so «undo» removes them together. */
export type SimEvent =
  | { seq: number; idx: number; req?: number; type: "order"; kind: OrderKind; qty: number; auto?: boolean }
  | { seq: number; idx: number; req?: number; type: "bracket"; stop: number | null; target: number | null };

export type FillReason = "buy" | "sell" | "flat" | "stop" | "target" | "end";

export type SimFill = { idx: number; price: number; qty: number; reason: FillReason; fee: number };

export type SimTrade = {
  n: number;
  side: "long" | "short";
  openIdx: number;
  closeIdx: number | null;
  entryAvg: number;
  exitAvg: number | null;
  maxQty: number;
  gross: number;
  fees: number;
  net: number;
  riskPerShare: number;
  /** Net R (closed trades; for an open trade: marked at the cursor). */
  r: number;
  /** Best / worst excursion per share while open (≥ 0). */
  mfe: number;
  mae: number;
  mfeR: number;
  maeR: number;
  hadStop: boolean;
  adds: number;
  addedToLoser: boolean;
  exitReason: FillReason | null;
};

export type SimConfig = {
  /** First bar the player may trade on (the last visible bar when the game starts). */
  startIdx: number;
  /** Last bar of the game: everything still open is closed at its close. */
  endIdx: number;
  feePerShare: number;
  /** Risk per share used when the player sets no stop on the entry bar. */
  riskUnit: number;
};

export type SimState = {
  cursor: number;
  pos: number;
  avg: number | null;
  stop: number | null;
  target: number | null;
  /** Gross realised $ (before fees). */
  realized: number;
  fees: number;
  unrealized: number;
  /** realized − fees + unrealized. */
  net: number;
  fills: SimFill[];
  trades: SimTrade[];
  /** Equity (net $) at the close of every bar from startIdx to cursor. */
  equity: number[];
};

const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** Signed share change of an order given the position before it (0 = nothing to do). */
export function orderDelta(kind: OrderKind, qty: number, pos: number): number {
  if (kind === "flat") return -pos;
  const q = Math.max(0, Math.floor(qty));
  return kind === "buy" ? q : -q;
}

type Open = SimTrade & { exitQty: number; exitValue: number };

export function simulate(bars: readonly SimBar[], cfg: SimConfig, events: readonly SimEvent[], cursor: number): SimState {
  const end = Math.min(cursor, cfg.endIdx, bars.length - 1);
  const fills: SimFill[] = [];
  const trades: SimTrade[] = [];
  const equity: number[] = [];
  let pos = 0;
  let avg: number | null = null;
  let stop: number | null = null;
  let target: number | null = null;
  let bracketFrom = Infinity;
  let realized = 0;
  let fees = 0;
  let open: Open | null = null;
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let ei = 0;

  const riskFloor = cfg.riskUnit * 0.25;

  const openTrade = (side: "long" | "short", idx: number, price: number, qty: number, fee: number) => {
    open = {
      n: trades.length + 1, side, openIdx: idx, closeIdx: null, entryAvg: price, exitAvg: null, maxQty: qty, gross: 0, fees: fee, net: 0,
      riskPerShare: cfg.riskUnit, r: 0, mfe: 0, mae: 0, mfeR: 0, maeR: 0, hadStop: false, adds: 0, addedToLoser: false, exitReason: null,
      exitQty: 0, exitValue: 0,
    };
  };

  const closeTrade = (idx: number, reason: FillReason) => {
    const t = open as Open | null;
    if (!t) return;
    t.closeIdx = idx;
    t.exitAvg = t.exitQty > 0 ? r4(t.exitValue / t.exitQty) : null;
    t.exitReason = reason;
    t.gross = r2(t.gross);
    t.fees = r2(t.fees);
    t.net = r2(t.gross - t.fees);
    finishR(t);
    const { exitQty: _q, exitValue: _v, ...plain } = t;
    trades.push(plain);
    open = null;
  };

  const finishR = (t: SimTrade, unrealized = 0) => {
    const risk = t.riskPerShare * t.maxQty;
    t.r = risk > 0 ? r2((t.gross + unrealized - t.fees) / risk) : 0;
    t.mfeR = t.riskPerShare > 0 ? r2(t.mfe / t.riskPerShare) : 0;
    t.maeR = t.riskPerShare > 0 ? r2(t.mae / t.riskPerShare) : 0;
  };

  const fill = (idx: number, price: number, delta: number, reason: FillReason) => {
    if (delta === 0) return;
    const absD = Math.abs(delta);
    const fee = r4(absD * cfg.feePerShare);
    fees += fee;
    fills.push({ idx, price: r4(price), qty: delta, reason, fee });
    if (pos === 0) {
      pos = delta;
      avg = price;
      openTrade(delta > 0 ? "long" : "short", idx, price, absD, fee);
      return;
    }
    const t = open as Open | null;
    if (Math.sign(delta) === Math.sign(pos)) {
      // Add: a loser if the add price is worse than the average (we are averaging into an adverse move).
      if (t && avg != null && (price - avg) * Math.sign(pos) < 0) t.addedToLoser = true;
      const n = Math.abs(pos) + absD;
      avg = ((avg ?? price) * Math.abs(pos) + price * absD) / n;
      pos += delta;
      if (t) { t.adds += 1; t.maxQty = Math.max(t.maxQty, Math.abs(pos)); t.fees += fee; t.entryAvg = r4(avg); }
      return;
    }
    // Reduce / close / flip.
    const closeQty = Math.min(absD, Math.abs(pos));
    const pnl = ((price - (avg ?? price)) * closeQty * Math.sign(pos));
    realized += pnl;
    const feeClose = fee * (closeQty / absD);
    if (t) { t.gross += pnl; t.fees += feeClose; t.exitQty += closeQty; t.exitValue += price * closeQty; }
    pos += Math.sign(delta) * closeQty;
    if (pos === 0) {
      avg = null;
      stop = null;
      target = null;
      bracketFrom = Infinity;
      closeTrade(idx, reason);
    }
    const rest = absD - closeQty;
    if (rest > 0) {
      pos = Math.sign(delta) * rest;
      avg = price;
      openTrade(delta > 0 ? "long" : "short", idx, price, rest, fee - feeClose);
    }
  };

  for (let i = cfg.startIdx; i <= end; i++) {
    const b = bars[i];
    if (!b) break;
    // 1) Intrabar: excursions and the bracket of an already open position.
    const t = open as Open | null;
    if (pos !== 0 && t && avg != null && i > t.openIdx) {
      const long = pos > 0;
      let exitPx: number | null = null;
      let reason: FillReason | null = null;
      if (i >= bracketFrom) {
        const stopHit = stop != null && (long ? b.l <= stop : b.h >= stop);
        const tgtHit = target != null && (long ? b.h >= target : b.l <= target);
        const openBeyondStop = stop != null && (long ? b.o <= stop : b.o >= stop);
        const openBeyondTgt = target != null && (long ? b.o >= target : b.o <= target);
        if (openBeyondStop) { exitPx = b.o; reason = "stop"; }
        else if (openBeyondTgt) { exitPx = b.o; reason = "target"; }
        else if (stopHit) { exitPx = stop; reason = "stop"; }
        else if (tgtHit) { exitPx = target; reason = "target"; }
      }
      if (exitPx != null && reason) {
        const move = (exitPx - avg) * (long ? 1 : -1);
        if (move < 0) t.mae = Math.max(t.mae, -move); else t.mfe = Math.max(t.mfe, move);
        fill(i, exitPx, -pos, reason);
      } else {
        t.mfe = Math.max(t.mfe, long ? b.h - avg : avg - b.l);
        t.mae = Math.max(t.mae, long ? avg - b.l : b.h - avg);
      }
    }
    // 2) The player's decisions at this bar's close (in the order they were made).
    while (ei < sorted.length && sorted[ei].idx < i) ei++; // events before startIdx (never valid) are ignored
    while (ei < sorted.length && sorted[ei].idx === i) {
      const e = sorted[ei++];
      if (e.type === "order") {
        const delta = orderDelta(e.kind, e.qty, pos);
        const reason: FillReason = e.auto ? "end" : e.kind === "flat" ? "flat" : e.kind;
        fill(i, b.c, delta, reason);
      } else if (pos !== 0) {
        stop = e.stop;
        target = e.target;
        bracketFrom = i + 1;
        const ot = open as Open | null;
        if (ot && e.stop != null) {
          if (!ot.hadStop && i === ot.openIdx) ot.riskPerShare = Math.max(Math.abs(ot.entryAvg - e.stop), riskFloor);
          ot.hadStop = true;
        }
      }
    }
    const unreal = pos !== 0 && avg != null ? (b.c - avg) * pos : 0;
    equity.push(r2(realized - fees + unreal));
  }

  const last = bars[end];
  const unrealized = pos !== 0 && avg != null && last ? r2((last.c - avg) * pos) : 0;
  const all = [...trades];
  const ot = open as Open | null;
  if (ot) {
    const copy: SimTrade = { ...ot };
    delete (copy as Partial<Open>).exitQty;
    delete (copy as Partial<Open>).exitValue;
    copy.gross = r2(copy.gross);
    copy.fees = r2(copy.fees);
    copy.net = r2(copy.gross + unrealized - copy.fees);
    finishR(copy, unrealized);
    all.push(copy);
  }
  return {
    cursor: end, pos, avg: avg != null ? r4(avg) : null, stop, target, realized: r2(realized), fees: r2(fees), unrealized,
    net: r2(realized - fees + unrealized), fills, trades: all, equity,
  };
}

/* ─────────────────────────── Finish: result, buy & hold, mistakes ─────────────────────────── */

export type MistakeKind = "heldLoser" | "gaveBack" | "cutWinner" | "addedToLoser" | "noStop" | "overtrading";
export type Mistake = { kind: MistakeKind; trade: number | null; value: number };

export type SimResult = {
  net: number;
  gross: number;
  fees: number;
  /** Net $ as % of the base position notional (default size × first price). */
  pct: number;
  /** Sum of closed trades' R. */
  r: number;
  trades: number;
  wins: number;
  bh: { entry: number; exit: number; qty: number; net: number; pct: number };
  /** pct − bh.pct (percentage points). */
  vsBh: number;
  beatBh: boolean;
  maxDrawdown: number;
  mistakes: Mistake[];
};

/** Thresholds of the mistake rules (exported for tests and the page's «how we judge» note). */
export const MISTAKE_RULES = {
  heldLoserR: -1.5,
  gaveBackMfeR: 2,
  gaveBackMaxR: 0.25,
  cutWinnerExtraR: 1.5,
  overtradingIntraday: 8,
  overtradingSwing: 6,
} as const;

export function mistakesOf(
  bars: readonly SimBar[],
  cfg: SimConfig,
  trades: readonly SimTrade[],
  opts: { lookAhead: number; overtrading: number },
): Mistake[] {
  const out: Mistake[] = [];
  for (const t of trades) {
    if (t.closeIdx == null) continue;
    if (t.r <= MISTAKE_RULES.heldLoserR) out.push({ kind: "heldLoser", trade: t.n, value: t.r });
    else if (t.mfeR >= MISTAKE_RULES.gaveBackMfeR && t.r <= MISTAKE_RULES.gaveBackMaxR) out.push({ kind: "gaveBack", trade: t.n, value: t.mfeR });
    if (t.r > 0 && t.exitAvg != null && t.exitReason !== "end") {
      // How far price kept going our way after the exit (within the look-ahead, never past the game).
      let best = 0;
      const to = Math.min(cfg.endIdx, t.closeIdx + opts.lookAhead);
      for (let i = t.closeIdx + 1; i <= to; i++) {
        const b = bars[i];
        if (!b) break;
        best = Math.max(best, t.side === "long" ? b.h - t.exitAvg : t.exitAvg - b.l);
      }
      const extraR = t.riskPerShare > 0 ? best / t.riskPerShare : 0;
      if (extraR >= MISTAKE_RULES.cutWinnerExtraR) out.push({ kind: "cutWinner", trade: t.n, value: r2(extraR) });
    }
    if (t.addedToLoser) out.push({ kind: "addedToLoser", trade: t.n, value: t.r });
    if (!t.hadStop && t.net < 0) out.push({ kind: "noStop", trade: t.n, value: t.r });
  }
  if (trades.length > opts.overtrading) out.push({ kind: "overtrading", trade: null, value: trades.length });
  return out;
}

export function maxDrawdown(equity: readonly number[]): number {
  let peak = 0, dd = 0;
  for (const e of equity) { peak = Math.max(peak, e); dd = Math.max(dd, peak - e); }
  return r2(dd);
}

export function resultOf(
  bars: readonly SimBar[],
  cfg: SimConfig,
  state: SimState,
  opts: { baseQty: number; lookAhead: number; overtrading: number },
): SimResult {
  const entry = bars[cfg.startIdx]?.c ?? 0;
  const exit = bars[cfg.endIdx]?.c ?? entry;
  const qty = Math.max(1, Math.floor(opts.baseQty));
  const bhFees = 2 * qty * cfg.feePerShare;
  const bhNet = r2((exit - entry) * qty - bhFees);
  const notional = entry * qty;
  const pct = notional > 0 ? r2((state.net / notional) * 100) : 0;
  const bhPct = notional > 0 ? r2((bhNet / notional) * 100) : 0;
  const closed = state.trades.filter((t) => t.closeIdx != null);
  return {
    net: state.net,
    gross: r2(state.realized + state.unrealized),
    fees: state.fees,
    pct,
    r: r2(closed.reduce((s, t) => s + t.r, 0)),
    trades: state.trades.length,
    wins: closed.filter((t) => t.net > 0).length,
    bh: { entry, exit, qty, net: bhNet, pct: bhPct },
    vsBh: r2(pct - bhPct),
    beatBh: state.net > bhNet,
    maxDrawdown: maxDrawdown(state.equity),
    mistakes: mistakesOf(bars, cfg, state.trades, opts),
  };
}
