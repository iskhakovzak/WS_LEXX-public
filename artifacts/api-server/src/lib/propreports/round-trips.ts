/**
 * Round-trip builder: fills → journal trades.
 *
 * Per (account, symbol), fills are replayed in time order and the signed position is tracked:
 *   0 → ≠0 → 0 is one round trip. Fills that increase |position| are entry/add, fills that reduce it
 *   are trim/exit. A fill that crosses zero (long 100 → sell 300) is split: 100 closes the long trip,
 *   200 opens a new short trip at the same timestamp.
 *
 * Numbers (average-cost method, same as PropReports "Trades" report):
 *   avgEntry  = qty-weighted average of opening-direction fills
 *   avgExit   = qty-weighted average of closing-direction fills
 *   grossPnl  = Σ closing qty × (price − avgCostAtThatMoment) × dir      (realized; == total when closed)
 *   fees      = Σ every fee column over all fills of the trip; net = gross − fees
 *   qty       = max |position| reached (what the desk calls "size")
 *
 * Dates: `date` = trade (session) date of the opening fill, `exitDate` = trade date of the last closing fill.
 * horizon: same session → intraday; closed on the next trading day → overnight; later → swing.
 * Still-open positions at the end of the data become `result: "open"` trades (what routes/risk.ts and the
 * trades page treat as the open book: LOWER(result) = 'open'); their grossPnl is the realized part only.
 * Session (premarket/regular/postmarket) from the ET open time like the legacy XLS parser.
 */
import { round2, round4 } from "./csv";
import type { FeeBreakdown, Fill, FillSide, Horizon, RoundTrip, RoundTripExecution, Session } from "./types";

export function sessionFor(time: string): Session {
  const [hh, mm] = time.split(":").map(Number);
  const minutes = (hh || 0) * 60 + (mm || 0);
  if (minutes < 9 * 60 + 30) return "premarket";
  if (minutes >= 16 * 60) return "postmarket";
  return "regular";
}

export function holdHuman(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function ymdToUtc(ymd: string): Date {
  return new Date(`${ymd}T12:00:00Z`);
}

/** Next weekday (NYSE holidays are not modelled; a Friday→Monday hold still counts as overnight). */
export function nextTradingDay(ymd: string): string {
  const d = ymdToUtc(ymd);
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

export function horizonFor(openDate: string, closeDate: string): Horizon {
  if (closeDate <= openDate) return "intraday";
  if (closeDate === nextTradingDay(openDate)) return "overnight";
  return "swing";
}

/** "YYYY-MM-DD HH:MM:SS.mmm" (naive ET) → epoch seconds treating the wall time as UTC (only differences matter). */
function wallSeconds(dt: string): number {
  const t = Date.parse(dt.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? t / 1000 : 0;
}

function isoSeconds(dt: string): string {
  return dt.slice(0, 19).replace(" ", "T");
}

function signedQty(side: FillSide, qty: number): number {
  return side === "B" || side === "C" ? qty : -qty;
}

function sumFees(f: FeeBreakdown): number {
  let s = 0;
  for (const k of Object.keys(f)) s += f[k] || 0;
  return s;
}

interface OpenTrip {
  account: string;
  symbol: string;
  dir: 1 | -1;
  openedAt: string;
  date: string;
  pos: number; // signed
  maxAbs: number;
  avgCost: number;
  entryQty: number;
  entryNotional: number;
  exitQty: number;
  exitNotional: number;
  realized: number;
  fees: FeeBreakdown;
  executions: RoundTripExecution[];
  fillCount: number;
  lastAt: string;
  lastTradeDate: string;
}

export interface BuildOptions {
  /** Last session date present in the data; open trips measure days-held against it. Defaults to max tradeDate. */
  asOfDate?: string;
}

export interface BuildResult {
  trips: RoundTrip[];
  /** Fills that closed a position that was not opened inside the data (position carried in from before the range). */
  orphanFills: Fill[];
}

export function buildRoundTrips(fillsIn: Fill[], opts: BuildOptions = {}): BuildResult {
  const fills = [...fillsIn].sort((a, b) =>
    a.account.localeCompare(b.account) || a.symbol.localeCompare(b.symbol) || a.dateTime.localeCompare(b.dateTime) || a.line - b.line,
  );
  const asOf = opts.asOfDate ?? fills.reduce((m, f) => (f.tradeDate > m ? f.tradeDate : m), "");
  const trips: RoundTrip[] = [];
  const orphanFills: Fill[] = [];
  const open = new Map<string, OpenTrip>();
  const idSeen = new Map<string, number>();

  const finish = (t: OpenTrip, closed: boolean) => {
    const closedAt = closed ? t.lastAt : null;
    const closeDate = closed ? t.lastTradeDate : asOf || t.date;
    const horizon = horizonFor(t.date, closeDate);
    // 4 decimals per trip (fees go down to $0.0001); cents are only for display (audit P0-1)
    const totalFees = round4(sumFees(t.fees));
    const gross = round4(t.realized);
    const net = round4(gross - totalFees);
    const holdSeconds = closed ? Math.max(0, wallSeconds(t.lastAt) - wallSeconds(t.openedAt)) : null;
    const side = t.dir === 1 ? "Long" : "Short";
    const base = `${t.account}|${t.symbol}|${isoSeconds(t.openedAt)}|${side}`;
    const n = (idSeen.get(base) ?? 0) + 1;
    idSeen.set(base, n);
    trips.push({
      externalId: n === 1 ? base : `${base}#${n}`,
      account: t.account,
      symbol: t.symbol,
      side,
      openedAt: isoSeconds(t.openedAt),
      closedAt: closedAt ? isoSeconds(closedAt) : null,
      date: t.date,
      exitDate: closed && t.lastTradeDate !== t.date ? t.lastTradeDate : null,
      horizon,
      session: sessionFor(t.openedAt.slice(11, 19)),
      qty: t.maxAbs,
      closedQty: t.exitQty,
      openQty: Math.abs(t.pos),
      avgEntry: round4(t.entryQty ? t.entryNotional / t.entryQty : 0),
      avgExit: t.exitQty ? round4(t.exitNotional / t.exitQty) : null,
      grossPnl: gross,
      fees: { ...t.fees },
      totalFees,
      netPnl: net,
      result: !closed ? "open" : net > 0 ? "win" : net < 0 ? "loss" : "breakeven",
      holdTime: holdSeconds != null ? holdHuman(holdSeconds) : null,
      holdSeconds,
      executions: t.executions,
      fillCount: t.fillCount,
      open: !closed,
    });
  };

  for (const f of fills) {
    const key = `${f.account}\u0000${f.symbol}`;
    let remaining = f.qty;
    const sq = signedQty(f.side, 1);
    const feeTotal = sumFees(f.fees);
    // fee share is pro-rated when a fill is split across two trips
    const feePart = (q: number): FeeBreakdown => {
      const out: FeeBreakdown = {};
      for (const k of Object.keys(f.fees)) out[k] = (f.fees[k] || 0) * (q / f.qty);
      return out;
    };
    const addFees = (t: OpenTrip, part: FeeBreakdown) => { for (const k of Object.keys(part)) t.fees[k] = (t.fees[k] || 0) + part[k]; };

    while (remaining > 0) {
      let t = open.get(key);
      if (!t) {
        // Only B (buy) / T (short) open a position. S / C with nothing open = the position was carried in
        // from before the date range: report it as an orphan instead of inventing a trade.
        // Exception: the leftover of a fill that just crossed zero (remaining < f.qty) legitimately opens
        // the opposite side (long 100 → sell 300 = short 200).
        if ((f.side === "S" || f.side === "C") && remaining === f.qty) { orphanFills.push(f); break; }
        const dir: 1 | -1 = sq > 0 ? 1 : -1;
        t = {
          account: f.account, symbol: f.symbol, dir, openedAt: f.dateTime, date: f.tradeDate,
          pos: 0, maxAbs: 0, avgCost: 0, entryQty: 0, entryNotional: 0, exitQty: 0, exitNotional: 0,
          realized: 0, fees: {}, executions: [], fillCount: 0, lastAt: f.dateTime, lastTradeDate: f.tradeDate,
        };
        open.set(key, t);
      }
      const increases = Math.sign(sq) === t.dir || t.pos === 0;
      if (increases) {
        const q = remaining;
        const absPos = Math.abs(t.pos);
        t.avgCost = absPos + q > 0 ? (t.avgCost * absPos + f.price * q) / (absPos + q) : f.price;
        t.pos += sq * q;
        t.maxAbs = Math.max(t.maxAbs, Math.abs(t.pos));
        t.entryQty += q;
        t.entryNotional += f.price * q;
        const part = feePart(q);
        t.executions.push({ kind: t.executions.length ? "add" : "entry", side: f.side, qty: q, price: f.price, at: isoSeconds(f.dateTime), fees: round4(feeTotal * (q / f.qty)), feesByType: part, fillId: f.fillId, orderId: f.orderId });
        addFees(t, part);
        t.fillCount++;
        t.lastAt = f.dateTime; t.lastTradeDate = f.tradeDate;
        remaining = 0;
      } else {
        const absPos = Math.abs(t.pos);
        const q = Math.min(remaining, absPos);
        t.realized += (f.price - t.avgCost) * q * t.dir;
        t.pos -= t.dir * q;
        t.exitQty += q;
        t.exitNotional += f.price * q;
        const closesAll = Math.abs(t.pos) < 1e-9;
        const part = feePart(q);
        t.executions.push({ kind: closesAll ? "exit" : "trim", side: f.side, qty: q, price: f.price, at: isoSeconds(f.dateTime), fees: round4(feeTotal * (q / f.qty)), feesByType: part, fillId: f.fillId, orderId: f.orderId });
        addFees(t, part);
        t.fillCount++;
        t.lastAt = f.dateTime; t.lastTradeDate = f.tradeDate;
        remaining -= q;
        if (closesAll) {
          t.pos = 0;
          finish(t, true);
          open.delete(key);
          // leftover `remaining` reopens in the opposite direction on the next loop iteration
        }
      }
    }
  }
  for (const t of open.values()) finish(t, false);
  trips.sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.symbol.localeCompare(b.symbol));
  return { trips, orphanFills };
}

/** Totals for a preview/summary panel. */
export function summarizeTrips(trips: RoundTrip[]) {
  const closed = trips.filter((t) => !t.open);
  const dates = [...new Set(trips.map((t) => t.date))].sort();
  return {
    trips: trips.length,
    closed: closed.length,
    open: trips.length - closed.length,
    wins: closed.filter((t) => t.result === "win").length,
    losses: closed.filter((t) => t.result === "loss").length,
    breakeven: closed.filter((t) => t.result === "breakeven").length,
    gross: round2(trips.reduce((s, t) => s + t.grossPnl, 0)),
    fees: round2(trips.reduce((s, t) => s + t.totalFees, 0)),
    net: round2(trips.reduce((s, t) => s + t.netPnl, 0)),
    byHorizon: {
      intraday: trips.filter((t) => t.horizon === "intraday").length,
      overnight: trips.filter((t) => t.horizon === "overnight").length,
      swing: trips.filter((t) => t.horizon === "swing").length,
    },
    accounts: [...new Set(trips.map((t) => t.account))].sort(),
    symbols: new Set(trips.map((t) => t.symbol)).size,
    minDate: dates[0] ?? null,
    maxDate: dates[dates.length - 1] ?? null,
    tradingDays: dates.length,
  };
}
