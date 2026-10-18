/**
 * «Позиция офиса» on the desk-day chart — the whole desk as ONE position on a ticker-day (owner 2026-10-18: «как позиция
 * офиса в целом по процентажу, где сколько кто зашёл, основную позу как офис полностью и где выходили»). Pure.
 *
 * Input: every trade of the ticker-day with its structure (lib/tradeStructure legs: opening flag, shares, time). Each
 * sized, timed leg moves the office's signed net position (long +, short −): a long's opening leg buys (+qty), its
 * closing leg sells (−qty); a short mirrors it. A position carried in from before the first fill (overnight) starts the
 * walk. Legs without shares or time (report-only trades) are left out and counted in `coverage`.
 *
 *   path        net position after every minute with a fill (step function; the client samples it per chart bar),
 *               as % of the day's maximum absolute office position — traders see the shape, never the size.
 *   peak        the maximum absolute position at a minute close (a scalp inside one minute is not the main position);
 *               its sign is the office's main side.
 *   avgEntry    VWAP of every opening leg of main-side trades; avgExit — of every closing leg of main-side trades.
 *   build zone  the core of the build-up: from the minute the position closed past 20 % of the peak to the minute it
 *               closed past 80 % (counted from the last minute the office was flat or on the other side before the
 *               peak); time = first / last fill that grew the position in that window, price range + VWAP of those fills.
 *   exit zone   the core of the unwind after the peak: from the minute it closed under 80 % to the one under 20 %.
 *               No exit zone when the office never got back under 20 % (held into the close / overnight).
 *   contributors  at the peak minute: each trader's position on the office's side ÷ the sum of all positions on that
 *               side (shares add up to 100 % even when someone is against the office), top 5; `against` counts the rest.
 *
 * Privacy (who gets shares / office $) is decided by the caller (lib/deskDay.ts): this file computes everything.
 * Unit-tested in __tests__/deskOffice.test.ts.
 */
import type { Side, TradeStructure } from "./tradeStructure";

/** One leg of the walk (exported for tests). */
export interface OfficeEvent {
  /** Epoch ms. */
  t: number;
  trader: string;
  /** Side of the trade the leg belongs to. */
  side: Side;
  opening: boolean;
  price: number;
  qty: number;
  /** Signed change of the office position (shares). */
  delta: number;
}

export interface OfficeZone {
  from: string;
  to: string;
  low: number;
  high: number;
  vwap: number;
}

export interface OfficeContributor {
  trader: string;
  /** Share of the office-side positions at the peak, 0–1 (positions against the office are not listed). */
  share: number;
}

export interface OfficePoint {
  /** Minute start, epoch seconds. */
  t: number;
  /** Signed % of the peak (−100…100). */
  pct: number;
  /** Signed shares (staff only; null otherwise). */
  shares: number | null;
}

export interface OfficePosition {
  side: Side;
  /** Traders whose legs moved the walk. */
  traders: number;
  peakAt: string;
  /** Signed peak in shares (staff only; null otherwise). */
  peakShares: number | null;
  /** % of the peak before the first fill (overnight carry; usually 0). */
  startPct: number;
  path: OfficePoint[];
  avgEntry: number | null;
  avgExit: number | null;
  build: OfficeZone | null;
  exit: OfficeZone | null;
  /** Office net $ of the ticker-day (all trades); null when unknown or hidden. */
  net: number | null;
  contributors: OfficeContributor[];
  /** Traders positioned against the office at the peak. */
  against: number;
  /** Share of the day's legs that carried shares + time (1 = every leg used). */
  coverage: number;
}

export const ZONE_FROM = 0.2;
export const ZONE_TO = 0.8;
export const TOP_CONTRIBUTORS = 5;

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** The walk's legs, oldest first, plus the carried-in start and coverage. */
export function officeEvents(
  trades: readonly { id: number; trader: string }[], structures: ReadonlyMap<number, TradeStructure>,
): { events: OfficeEvent[]; start: number; startBy: Map<string, number>; coverage: number } {
  const events: OfficeEvent[] = [];
  const startBy = new Map<string, number>();
  let start = 0, legs = 0, used = 0;
  for (const tr of trades) {
    const s = structures.get(tr.id);
    if (!s) continue;
    const side: Side = s.stats.side === "short" ? "short" : "long";
    const dir = side === "short" ? -1 : 1;
    const carry = s.legs[0]?.positionBefore ?? 0;
    if (carry > 0) { start += dir * carry; startBy.set(tr.trader, (startBy.get(tr.trader) ?? 0) + dir * carry); }
    for (const l of s.legs) {
      legs++;
      const t = l.at ? Date.parse(l.at) : Number.NaN;
      if (l.qty == null || !(l.qty > 0) || !Number.isFinite(t) || !(l.price > 0)) continue;
      used++;
      events.push({ t, trader: tr.trader, side, opening: l.opening, price: l.price, qty: l.qty, delta: dir * (l.opening ? 1 : -1) * l.qty });
    }
  }
  // Same instant: opening legs after closing ones (a flip through zero does not fake a double-size peak).
  events.sort((a, b) => a.t - b.t || Number(a.opening) - Number(b.opening));
  return { events, start, startBy, coverage: legs ? round(used / legs, 3) : 0 };
}

function zone(evs: readonly OfficeEvent[], from: number, to: number, grow: (e: OfficeEvent) => boolean): OfficeZone | null {
  let lo = Infinity, hi = -Infinity, pv = 0, q = 0, first = Infinity, last = -Infinity;
  for (const e of evs) {
    if (e.t < from || e.t > to || !grow(e)) continue;
    lo = Math.min(lo, e.price); hi = Math.max(hi, e.price); pv += e.price * e.qty; q += e.qty;
    first = Math.min(first, e.t); last = Math.max(last, e.t);
  }
  if (!q) return null;
  return { from: new Date(first).toISOString(), to: new Date(last).toISOString(), low: round(lo), high: round(hi), vwap: round(pv / q) };
}

const vwap = (evs: readonly OfficeEvent[]) => {
  let pv = 0, q = 0;
  for (const e of evs) { pv += e.price * e.qty; q += e.qty; }
  return q ? round(pv / q) : null;
};

/**
 * The office position of one ticker-day. `nets` = net $ per trade (null = unknown). Returns null when no leg carries
 * shares + time, or the office never held a position.
 */
export function officePosition(
  trades: readonly { id: number; trader: string }[], structures: ReadonlyMap<number, TradeStructure>,
  nets: readonly (number | null)[], withShares: boolean,
): OfficePosition | null {
  const { events, start, startBy, coverage } = officeEvents(trades, structures);
  if (!events.length) return null;

  // Walk per minute (the chart's finest bar): the position after the last fill of each minute with fills. The peak,
  // the zones and the contributors are read on these minute closes, so a scalp opened and closed inside one minute does
  // not become the «main position» — the pane shows exactly what the numbers say.
  const mins: { t: number; pos: number; last: number }[] = [];
  let p = start;
  for (let i = 0; i < events.length; i++) {
    p += events[i].delta;
    const m = Math.floor(events[i].t / 60_000) * 60_000;
    if (mins.length && mins[mins.length - 1].t === m) { mins[mins.length - 1].pos = p; mins[mins.length - 1].last = i; } else mins.push({ t: m, pos: p, last: i });
  }
  let peakMin = -1, peakAbs = Math.abs(start);
  for (let k = 0; k < mins.length; k++) if (Math.abs(mins[k].pos) > peakAbs + 1e-9) { peakAbs = Math.abs(mins[k].pos); peakMin = k; }
  if (peakMin < 0 || peakAbs <= 0) return null;
  const peak = mins[peakMin].pos;
  const s = peak > 0 ? 1 : -1;
  const side: Side = s > 0 ? "long" : "short";
  const pct = (x: number) => round((x / peakAbs) * 100, 1);
  const path: OfficePoint[] = mins.map((m) => ({ t: m.t / 1000, pct: pct(m.pos), shares: withShares ? round(m.pos, 2) : null }));

  // Build: counted from the last flat / other-side minute before the peak.
  let base = -1;
  for (let k = peakMin - 1; k >= 0; k--) if (s * mins[k].pos <= 0) { base = k; break; }
  const firstMin = (from: number, to: number, ok: (x: number) => boolean) => {
    for (let k = Math.max(0, from); k <= to; k++) if (ok(s * mins[k].pos)) return k;
    return -1;
  };
  const span = (a: number, b: number): [number, number] => [mins[a].t, mins[b].t + 59_999];
  const b0 = firstMin(base + 1, peakMin, (x) => x >= ZONE_FROM * peakAbs);
  const b1 = b0 >= 0 ? firstMin(b0, peakMin, (x) => x >= ZONE_TO * peakAbs) : -1;
  const build = b0 >= 0 && b1 >= 0 ? zone(events, ...span(b0, b1), (e) => s * e.delta > 0) : null;
  const e0 = firstMin(peakMin + 1, mins.length - 1, (x) => x <= ZONE_TO * peakAbs);
  const e1 = e0 >= 0 ? firstMin(e0, mins.length - 1, (x) => x <= ZONE_FROM * peakAbs) : -1;
  const exit = e0 >= 0 && e1 >= 0 ? zone(events, ...span(e0, e1), (e) => s * e.delta < 0) : null;
  const peakIdx = mins[peakMin].last;

  // Contributors at the peak.
  const at = new Map(startBy);
  for (let i = 0; i <= peakIdx; i++) at.set(events[i].trader, (at.get(events[i].trader) ?? 0) + events[i].delta);
  const gross = [...at.values()].reduce((a, q) => a + Math.max(0, s * q), 0) || 1;
  const shares = [...at].map(([trader, q]) => ({ trader, share: round((s * q) / gross, 3) }));
  const contributors = shares.filter((x) => x.share > 0.0005).sort((a, b) => b.share - a.share || a.trader.localeCompare(b.trader)).slice(0, TOP_CONTRIBUTORS);

  const main = events.filter((e) => e.side === side);
  return {
    side,
    traders: new Set(events.map((e) => e.trader)).size,
    peakAt: new Date(events[peakIdx].t).toISOString(),
    peakShares: withShares ? round(peak, 2) : null,
    startPct: pct(start),
    path,
    avgEntry: vwap(main.filter((e) => e.opening)),
    avgExit: vwap(main.filter((e) => !e.opening)),
    build,
    exit,
    net: nets.length && nets.every((n) => n != null) ? round(nets.reduce<number>((a, n) => a + (n as number), 0), 2) : null,
    contributors,
    against: shares.filter((x) => x.share < -0.0005).length,
    coverage,
  };
}
