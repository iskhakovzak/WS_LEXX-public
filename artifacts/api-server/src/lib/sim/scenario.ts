/**
 * Simulator scenarios — pure helpers (no I/O): difficulty presets, bar aggregation, day features, the bar series of an
 * intraday / swing game, the risk unit, the default size, and the fake timeline the player sees.
 *
 * Fairness: the player never gets real timestamps before the reveal. Intraday bars keep their New York wall-clock time
 * (9:30, 10:15 — needed to read the session) on a fixed fake date (January 2001, EST, so session shading works);
 * swing bars get a plain daily index. The real ticker and dates exist only on the server until the game is over.
 */
import type { SimBar } from "./engine";

export type SimMode = "intraday" | "swing";
export type Difficulty = "easy" | "medium" | "hard";
export type SimTf = "1m" | "5m" | "1d";

export type IntradaySpec = {
  mode: "intraday";
  tf: "1m" | "5m";
  /** Minutes of the regular session to play from 9:30. */
  playMinutes: number;
  /** Day filter on |gap %| and the regular-session range in % of the open. */
  filter: (f: DayFeatures) => boolean;
  /** Ranking when nothing passes the filter (higher = closer to what this level wants). */
  rank: (f: DayFeatures) => number;
};

export type SwingSpec = {
  mode: "swing";
  tf: "1d";
  history: number;
  play: number;
  filter: (f: SeriesFeatures) => boolean;
  rank: (f: SeriesFeatures) => number;
};

export type DayFeatures = { gapPct: number; rangePct: number };
export type SeriesFeatures = { atrPct: number; bigGaps: number };

export const INTRADAY_SPECS: Record<Difficulty, IntradaySpec> = {
  easy: {
    mode: "intraday", tf: "5m", playMinutes: 390,
    filter: (f) => Math.abs(f.gapPct) < 2.5 && f.rangePct >= 1 && f.rangePct <= 6,
    rank: (f) => -Math.abs(f.gapPct) - Math.abs(f.rangePct - 3),
  },
  medium: {
    mode: "intraday", tf: "1m", playMinutes: 90,
    filter: (f) => f.rangePct >= 0.8,
    rank: (f) => f.rangePct,
  },
  hard: {
    mode: "intraday", tf: "1m", playMinutes: 180,
    filter: (f) => Math.abs(f.gapPct) >= 2.5 || f.rangePct >= 4,
    rank: (f) => Math.abs(f.gapPct) + f.rangePct,
  },
};

export const SWING_SPECS: Record<Difficulty, SwingSpec> = {
  easy: { mode: "swing", tf: "1d", history: 120, play: 60, filter: (f) => f.atrPct < 2.8 && f.bigGaps <= 1, rank: (f) => -f.atrPct },
  medium: { mode: "swing", tf: "1d", history: 120, play: 100, filter: () => true, rank: () => 0 },
  hard: { mode: "swing", tf: "1d", history: 120, play: 140, filter: (f) => f.atrPct >= 3.2 || f.bigGaps >= 3, rank: (f) => f.atrPct + f.bigGaps },
};

export function specOf(mode: SimMode, d: Difficulty): IntradaySpec | SwingSpec {
  return mode === "intraday" ? INTRADAY_SPECS[d] : SWING_SPECS[d];
}

/** Bars the player plays at this level (for the start screen hint). */
export function playBarsOf(mode: SimMode, d: Difficulty): number {
  if (mode === "swing") return SWING_SPECS[d].play;
  const s = INTRADAY_SPECS[d];
  return Math.round(s.playMinutes / (s.tf === "5m" ? 5 : 1));
}

/* ─────────────────────────── New York time ─────────────────────────── */

const ET_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});

/** New York date and minutes since midnight of an epoch (seconds). */
export function etOf(t: number): { date: string; min: number } {
  const p = ET_FMT.formatToParts(new Date(t * 1000));
  const get = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, min: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}

export const RTH_OPEN = 570;
export const RTH_CLOSE = 960;
export const PRE_OPEN = 240;

/* ─────────────────────────── Aggregation ─────────────────────────── */

/** 1-minute (or finer) bars → `sec`-second buckets aligned to the epoch (5-minute buckets align to :00/:05/…). */
export function aggregate(bars: readonly SimBar[], sec: number): SimBar[] {
  const out: SimBar[] = [];
  let cur: SimBar | null = null;
  for (const b of bars) {
    const k = Math.floor(b.t / sec) * sec;
    if (cur && cur.t === k) {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v;
    } else {
      cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      out.push(cur);
    }
  }
  return out;
}

/** Regular-session intraday bars of one day → one daily bar (t = UTC midnight of the date). */
export function dailyBar(date: string, bars: readonly SimBar[]): SimBar | null {
  const rth = bars.filter((b) => { const m = etOf(b.t).min; return m >= RTH_OPEN && m < RTH_CLOSE; });
  const src = rth.length ? rth : bars;
  if (!src.length) return null;
  let h = -Infinity, l = Infinity, v = 0;
  for (const b of src) { h = Math.max(h, b.h); l = Math.min(l, b.l); v += b.v; }
  return { t: Date.parse(`${date}T00:00:00Z`) / 1000, o: src[0].o, h, l, c: src[src.length - 1].c, v };
}

/** Average true range of the last `n` bars (simple mean); null with fewer than 2 bars. */
export function atr(bars: readonly SimBar[], n = 14): number | null {
  if (bars.length < 2) return null;
  const from = Math.max(1, bars.length - n);
  let sum = 0, k = 0;
  for (let i = from; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    sum += Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    k++;
  }
  return k ? sum / k : null;
}

/* ─────────────────────────── Features ─────────────────────────── */

export function dayFeatures(prevClose: number | null, rth: readonly SimBar[]): DayFeatures | null {
  if (!rth.length) return null;
  const open = rth[0].o;
  let h = -Infinity, l = Infinity;
  for (const b of rth) { h = Math.max(h, b.h); l = Math.min(l, b.l); }
  return {
    gapPct: prevClose && prevClose > 0 ? ((open - prevClose) / prevClose) * 100 : 0,
    rangePct: open > 0 ? ((h - l) / open) * 100 : 0,
  };
}

export function seriesFeatures(daily: readonly SimBar[]): SeriesFeatures {
  let sum = 0, k = 0, big = 0;
  for (let i = 1; i < daily.length; i++) {
    const b = daily[i], pc = daily[i - 1].c;
    if (pc > 0) {
      sum += (Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)) / pc) * 100;
      k++;
      if (Math.abs(b.o - pc) / pc >= 0.03) big++;
    }
  }
  return { atrPct: k ? sum / k : 0, bigGaps: big };
}

/* ─────────────────────────── Game series ─────────────────────────── */

export type Levels = { pdh: number | null; pdl: number | null; pdc: number | null; pmh: number | null; pml: number | null };

export type BuiltScenario = {
  bars: SimBar[];
  startIdx: number;
  endIdx: number;
  levels: Levels;
  /** Bars of the play day (intraday) / game window (swing) — for features and the risk unit. */
  riskUnit: number;
};

/**
 * Intraday series: previous regular session (context, optional) + the play day's premarket + its regular session up
 * to `playMinutes` after the open. The game starts on the last premarket bar (or the last context bar when the day
 * has no premarket prints), so the first «next» shows the 9:30 bar.
 */
export function buildIntraday(input: {
  day: string;
  dayBars: readonly SimBar[];
  prevBars: readonly SimBar[];
  prevLevels: { h: number; l: number; c: number } | null;
  spec: IntradaySpec;
}): BuiltScenario | null {
  const sec = input.spec.tf === "5m" ? 300 : 60;
  const norm = (bs: readonly SimBar[]) => (sec === 60 ? [...bs] : aggregate(bs, sec));
  const day = norm(input.dayBars).filter((b) => etOf(b.t).date === input.day);
  const pre = day.filter((b) => { const m = etOf(b.t).min; return m >= PRE_OPEN && m < RTH_OPEN; });
  const lastPlayMin = RTH_OPEN + input.spec.playMinutes;
  const rth = day.filter((b) => { const m = etOf(b.t).min; return m >= RTH_OPEN && m < Math.min(RTH_CLOSE, lastPlayMin); });
  // A day cached mid-session (or a half day) is too short for the level: skip it.
  const expected = Math.min(input.spec.playMinutes, RTH_CLOSE - RTH_OPEN) / (sec / 60);
  if (rth.length < expected * 0.85) return null;
  const prev = norm(input.prevBars).filter((b) => { const m = etOf(b.t).min; return m >= RTH_OPEN && m < RTH_CLOSE; });
  const bars = [...prev, ...pre, ...rth];
  if (bars.length < rth.length + 1) {
    // No context at all: nothing visible before the open — not a fair start.
    return null;
  }
  const startIdx = prev.length + pre.length - 1;
  // Too little to read before the open (thin premarket and no previous session archived): not a fair start.
  if (startIdx + 1 < (sec === 60 ? 30 : 12)) return null;
  const endIdx = bars.length - 1;
  let pmh: number | null = null, pml: number | null = null;
  for (const b of pre) { pmh = pmh == null ? b.h : Math.max(pmh, b.h); pml = pml == null ? b.l : Math.min(pml, b.l); }
  const pl = input.prevLevels ?? (prev.length ? { h: Math.max(...prev.map((b) => b.h)), l: Math.min(...prev.map((b) => b.l)), c: prev[prev.length - 1].c } : null);
  const visible = bars.slice(0, startIdx + 1);
  return {
    bars, startIdx, endIdx,
    levels: { pdh: pl?.h ?? null, pdl: pl?.l ?? null, pdc: pl?.c ?? null, pmh, pml },
    riskUnit: riskUnitOf(visible, input.spec.tf, pl?.c ?? visible[visible.length - 1]?.c ?? 0),
  };
}

/** Swing series: `history` visible daily bars, then `play` bars to trade, from `from` (index into `daily`). */
export function buildSwing(daily: readonly SimBar[], from: number, spec: SwingSpec): BuiltScenario | null {
  const bars = daily.slice(from, from + spec.history + spec.play);
  if (bars.length < spec.history + spec.play) return null;
  const startIdx = spec.history - 1;
  const visible = bars.slice(0, startIdx + 1);
  return {
    bars: [...bars], startIdx, endIdx: bars.length - 1,
    levels: { pdh: null, pdl: null, pdc: null, pmh: null, pml: null },
    riskUnit: riskUnitOf(visible, "1d", visible[visible.length - 1].c),
  };
}

/**
 * Risk per share when the player sets no stop: an ATR of the visible bars scaled to a typical stop on that timeframe
 * (1-minute ×3, 5-minute ×1.5, daily ×1), never below 0.2% of the price.
 */
export function riskUnitOf(visible: readonly SimBar[], tf: SimTf, price: number): number {
  const k = tf === "1m" ? 3 : tf === "5m" ? 1.5 : 1;
  const rth = tf === "1d" ? visible : visible.filter((b) => { const m = etOf(b.t).min; return m >= RTH_OPEN && m < RTH_CLOSE; });
  const a = atr(rth.length >= 15 ? rth : visible, 14) ?? price * 0.005;
  const v = Math.max(a * k, price * 0.002, 0.01);
  return Math.round(v * 10000) / 10000;
}

/** Base position: ≈ $10k notional in round lots (10 shares under $50, else 5 / 1). */
export const BASE_NOTIONAL = 10_000;
export function defaultQty(price: number): number {
  if (!(price > 0)) return 100;
  const raw = BASE_NOTIONAL / price;
  const lot = raw >= 100 ? 10 : raw >= 20 ? 5 : 1;
  return Math.max(1, Math.round(raw / lot) * lot);
}

/** Buying power cap of one position (intraday 4:1, swing 2:1 on a $25k account). */
export function maxNotionalOf(mode: SimMode): number {
  return mode === "intraday" ? 100_000 : 50_000;
}

/* ─────────────────────────── Fake timeline ─────────────────────────── */

const FAKE_DAY0 = Date.UTC(2001, 0, 10) / 1000; // Wednesday, EST (no DST)

/**
 * Intraday: the same New York wall clock on fake days (play day = 2001-01-10, the day before = 01-09…).
 * Swing: day 0 = 2001-01-01, one bar per calendar day (lightweight-charts only needs increasing times).
 */
export function fakeTimes(bars: readonly SimBar[], mode: SimMode): number[] {
  if (mode === "swing") return bars.map((_, i) => Date.UTC(2001, 0, 1) / 1000 + i * 86400);
  const dates = [...new Set(bars.map((b) => etOf(b.t).date))].sort();
  const lastIdx = dates.length - 1;
  const dayIdx = new Map(dates.map((d, i) => [d, i - lastIdx]));
  return bars.map((b) => {
    const { date, min } = etOf(b.t);
    return FAKE_DAY0 + (dayIdx.get(date) ?? 0) * 86400 + (min + 300) * 60;
  });
}

/** Compact wire format: [t, o, h, l, c, v] with the fake time. */
export type WireBar = [number, number, number, number, number, number];
export function toWire(bars: readonly SimBar[], times: readonly number[], from: number, to: number): WireBar[] {
  const out: WireBar[] = [];
  for (let i = Math.max(0, from); i <= to && i < bars.length; i++) {
    const b = bars[i];
    out.push([times[i], b.o, b.h, b.l, b.c, b.v]);
  }
  return out;
}

/* ─────────────────────────── Picking ─────────────────────────── */

/** Weighted random pick; `rnd` injectable for tests. Returns null for an empty list. */
export function pickWeighted<T>(items: readonly T[], weight: (x: T) => number, rnd: () => number = Math.random): T | null {
  if (!items.length) return null;
  const ws = items.map((x) => Math.max(0, weight(x)));
  const total = ws.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.min(items.length - 1, Math.floor(rnd() * items.length))];
  let r = rnd() * total;
  for (let i = 0; i < items.length; i++) { r -= ws[i]; if (r < 0) return items[i]; }
  return items[items.length - 1];
}

/** Weighted sample of up to `n` distinct items (Efraimidis–Spirakis keys: u^(1/w), largest first). */
export function weightedSample<T>(items: readonly T[], n: number, weight: (x: T) => number, rnd: () => number = Math.random): T[] {
  return items
    .map((x) => ({ x, k: Math.pow(Math.max(rnd(), 1e-12), 1 / Math.max(1e-6, weight(x))) }))
    .sort((a, b) => b.k - a.k)
    .slice(0, n)
    .map((e) => e.x);
}

/** Random sample of up to `n` distinct items (Fisher–Yates on a copy). */
export function sample<T>(items: readonly T[], n: number, rnd: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

/** Look-ahead (bars) for the «cut a winner» rule and the overtrading threshold, per mode / timeframe. */
export function judgeOpts(mode: SimMode, tf: SimTf): { lookAhead: number; overtrading: number } {
  if (mode === "swing") return { lookAhead: 15, overtrading: 6 };
  return { lookAhead: tf === "5m" ? 12 : 30, overtrading: 8 };
}
