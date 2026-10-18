// Analyst actions → market reaction (pure, no DB / network). Used by routes/analyst-actions.ts.
//
// Reaction day: the first session in which the market can trade the call.
//   published before 16:00 ET (incl. premarket / date-only stamps) → that New York date;
//   published at/after 16:00 ET → the next weekday; weekend dates roll to Monday.
//   Holidays simply have no bar: the first bar on/after the reaction day is used (≤ 4 calendar days later).
// Per event (daily bars, prev = the bar before the reaction bar):
//   gap  = open / prevClose − 1          — what the trader sees in premarket
//   day  = close / prevClose − 1         — full reaction of the day
//   o2c  = close / open − 1              — follow-through after the open (what an intraday trader can catch)
//   ratio = |day| / median |day| of the 20 sessions before — «во сколько раз сильнее обычного»
// Direction: upgrade +1, downgrade −1, initiation by stance (buy +1 / sell −1 / hold 0), PT change by sign.
// «В сторону рейтинга» (hit) = sign(day) equals the direction.

export type Bar = { d: string; o: number; h: number; l: number; c: number; v: number };

export type EventKind = "up" | "down" | "init" | "ptUp" | "ptDown";

export type ReactionAgg = {
  n: number;
  avgGap: number | null;
  avgDay: number | null;
  avgO2c: number | null;
  /** Mean of day move × direction (positive = the market followed the call). */
  avgSignedDay: number | null;
  /** Share of events where the day closed in the call's direction. */
  hitRate: number | null;
  /** Mean of |day| / typical |day| — the «weight» of the calls. */
  avgRatio: number | null;
};

export type Reaction = {
  day: string;
  gap: number | null;
  dayMove: number;
  o2c: number;
  ratio: number | null;
  volRatio: number | null;
};

const NY = "America/New_York";
const nyFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function addDays(date: string, days: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}
function weekday(date: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/** New York date + minutes since midnight for an instant. */
export function nyStamp(at: Date): { day: string; minutes: number } {
  const p: Record<string, string> = {};
  for (const x of nyFmt.formatToParts(at)) p[x.type] = x.value;
  const hh = p.hour === "24" ? 0 : Number(p.hour);
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: hh * 60 + Number(p.minute) };
}

/** First session that can react to a call published at `at` (see header). */
export function reactionDay(at: Date): string {
  const { day, minutes } = nyStamp(at);
  let d = minutes >= 16 * 60 ? addDays(day, 1) : day;
  const wd = weekday(d);
  if (wd === 6) d = addDays(d, 2);
  else if (wd === 0) d = addDays(d, 1);
  return d;
}

const BUY_RE = /(strong\s*buy|buy|outperform|overweight|accumulate|positive|add|conviction|top pick)/i;
const SELL_RE = /(sell|underperform|underweight|reduce|negative)/i;
export function stanceDir(grade: string | null | undefined): 1 | -1 | 0 {
  if (!grade) return 0;
  if (SELL_RE.test(grade)) return -1;
  if (BUY_RE.test(grade)) return 1;
  return 0;
}

export function parsePrice(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Minimal |PT change| (%) for a target-only update to count as an event. */
export const PT_EVENT_MIN = 5;

/** Classify an action row. Rating changes win over PT changes; maintain/reiterate count only through the PT. */
export function classifyAction(row: {
  action: string; to_grade?: string | null; price_target?: unknown; price_target_from?: unknown;
}): { kind: EventKind; dir: 1 | -1; rating: boolean; ptChg: number | null } | null {
  const a = String(row.action || "").toLowerCase();
  const pt = parsePrice(row.price_target);
  const ptf = parsePrice(row.price_target_from);
  const ptChg = pt != null && ptf != null ? ((pt - ptf) / ptf) * 100 : null;
  if (a === "up") return { kind: "up", dir: 1, rating: true, ptChg };
  if (a === "down") return { kind: "down", dir: -1, rating: true, ptChg };
  if (a === "init") {
    const s = stanceDir(row.to_grade ?? null);
    return s === 0 ? null : { kind: "init", dir: s, rating: true, ptChg };
  }
  if (ptChg != null && Math.abs(ptChg) >= PT_EVENT_MIN && Math.abs(ptChg) < 200) {
    return ptChg > 0 ? { kind: "ptUp", dir: 1, rating: false, ptChg } : { kind: "ptDown", dir: -1, rating: false, ptChg };
  }
  return null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Index of the first bar with d ≥ day (bars sorted ascending), or -1. */
export function barIndexOnOrAfter(bars: Bar[], day: string): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].d < day) lo = mid + 1; else hi = mid;
  }
  return lo < bars.length ? lo : -1;
}

/** Reaction of the session `day` (null when the bar or the previous close is missing). */
export function reactionOn(bars: Bar[], day: string): Reaction | null {
  const i = barIndexOnOrAfter(bars, day);
  if (i <= 0) return null;
  const b = bars[i];
  // A bar far after the reaction day means a hole in the data, not a holiday.
  if (b.d > addDays(day, 4)) return null;
  const prev = bars[i - 1];
  if (!(prev.c > 0) || !(b.c > 0)) return null;
  const gap = b.o > 0 ? ((b.o - prev.c) / prev.c) * 100 : null;
  const dayMove = ((b.c - prev.c) / prev.c) * 100;
  const o2c = b.o > 0 ? ((b.c - b.o) / b.o) * 100 : 0;
  const moves: number[] = [];
  const vols: number[] = [];
  for (let j = Math.max(1, i - 20); j < i; j++) {
    const p = bars[j - 1].c;
    if (p > 0 && bars[j].c > 0) moves.push(Math.abs((bars[j].c - p) / p) * 100);
    if (bars[j].v > 0) vols.push(bars[j].v);
  }
  const typical = moves.length >= 5 ? median(moves) : null;
  const typicalVol = vols.length >= 5 ? median(vols) : null;
  return {
    day: b.d,
    gap: gap == null ? null : +gap.toFixed(2),
    dayMove: +dayMove.toFixed(2),
    o2c: +o2c.toFixed(2),
    ratio: typical != null && typical > 0.05 ? +(Math.abs(dayMove) / typical).toFixed(2) : null,
    volRatio: typicalVol != null && typicalVol > 0 && b.v > 0 ? +(b.v / typicalVol).toFixed(2) : null,
  };
}

type AggInput = { dir: 1 | -1; r: Reaction };

export function aggregate(list: AggInput[]): ReactionAgg {
  const n = list.length;
  if (!n) return { n: 0, avgGap: null, avgDay: null, avgO2c: null, avgSignedDay: null, hitRate: null, avgRatio: null };
  let g = 0, gN = 0, d = 0, o = 0, s = 0, hit = 0, ra = 0, raN = 0;
  for (const { dir, r } of list) {
    if (r.gap != null) { g += r.gap; gN++; }
    d += r.dayMove;
    o += r.o2c;
    s += r.dayMove * dir;
    if (Math.sign(r.dayMove) === dir) hit++;
    if (r.ratio != null) { ra += Math.min(r.ratio, 15); raN++; }
  }
  const f = (x: number) => +x.toFixed(2);
  return {
    n,
    avgGap: gN ? f(g / gN) : null,
    avgDay: f(d / n),
    avgO2c: f(o / n),
    avgSignedDay: f(s / n),
    hitRate: +(hit / n).toFixed(3),
    avgRatio: raN ? f(ra / raN) : null,
  };
}

/** Bars from Yahoo-style candles ({t: epoch s, o,h,l,c,v}) → compact, New York dated, ascending, de-duplicated. */
export function barsFromCandles(candles: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>): Bar[] {
  const byDay = new Map<string, Bar>();
  for (const k of candles) {
    if (!(k.c > 0)) continue;
    const d = nyStamp(new Date(k.t * 1000)).day;
    byDay.set(d, { d, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: Number(k.v) || 0 });
  }
  return Array.from(byDay.values()).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}

/** Firm «weight» summary: needs a minimum sample before the number is shown. */
export const FIRM_WEIGHT_MIN_N = 5;
