/**
 * Candle archive — pure rules (no DB, no network): timeframes, what the provider can still serve for a day, when a
 * day is complete, aggregation of archived bars to a coarser timeframe, day stats, and target de-duplication.
 */
import { nyDate, nyMinutes } from "../tradingDate";
import { rthBounds } from "../candleDay";
import type { Bar } from "./codec";

export type ArchiveTf = "1m" | "5m" | "15m" | "30m" | "60m";
export const ARCHIVE_TFS: readonly ArchiveTf[] = ["1m", "5m", "15m", "30m", "60m"];
export const TF_SEC: Record<ArchiveTf, number> = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "60m": 3600 };
export const isArchiveTf = (v: unknown): v is ArchiveTf => typeof v === "string" && (ARCHIVE_TFS as readonly string[]).includes(v);
export function tfOfSec(sec: number): ArchiveTf | null {
  return ARCHIVE_TFS.find((tf) => TF_SEC[tf] === sec) ?? null;
}

/**
 * How far back Yahoo serves each bar size (verified 2026-10-17 against the live chart API): the requested window must
 * START within the last 30 days for 1-minute bars, 60 days for 5/15/30-minute, ~730 days for hourly. A day's window
 * starts at 04:00 ET; one hour of slack keeps the call from failing on the edge.
 */
export const PROVIDER_MAX_AGE_DAYS: Record<ArchiveTf, number> = { "1m": 30, "5m": 60, "15m": 60, "30m": 60, "60m": 730 };

/** Can the provider still serve `tf` bars for `day` at `nowMs`? */
export function providerServes(tf: ArchiveTf, day: string, nowMs: number = Date.now()): boolean {
  const startMs = Date.parse(`${day}T08:00:00Z`); // 04:00 EDT (03:00 EST — earlier, so the check stays conservative)
  return nowMs - startMs < PROVIDER_MAX_AGE_DAYS[tf] * 86_400_000 - 3_600_000;
}

/** Finest bar size the provider still serves for `day`, or null (older than two years). */
export function bestProviderTf(day: string, nowMs: number = Date.now()): ArchiveTf | null {
  for (const tf of ARCHIVE_TFS) if (providerServes(tf, day, nowMs)) return tf;
  return null;
}

/** A day is complete (immutable, archivable) once New York has passed 20:05 that day — after-hours included. */
export function isDayComplete(day: string, now: Date = new Date()): boolean {
  const today = nyDate(now);
  if (day < today) return true;
  return day === today && nyMinutes(now) >= 20 * 60 + 5;
}

export function isWeekday(day: string): boolean {
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6;
}

/** Weekdays from `from` to `to` inclusive (YYYY-MM-DD), at most `cap`. */
export function weekdaysInRange(from: string, to: string, cap = 30): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (d.getTime() <= end && out.length < cap) {
    const s = d.toISOString().slice(0, 10);
    if (isWeekday(s)) out.push(s);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Bucket start of `t` for `tfSec`: hourly bars start at 09:30 in the session (Yahoo's grid), on the hour outside it. */
function bucketOf(t: number, tfSec: number, rthOpen: number): number {
  if (tfSec === 3600 && t >= rthOpen) return rthOpen + Math.floor((t - rthOpen) / 3600) * 3600;
  return Math.floor(t / tfSec) * tfSec;
}

/** Fold sorted bars of ONE day into `tfSec` bars (no-op when they already are that size or coarser). */
export function aggregateBars(bars: readonly Bar[], fromSec: number, tfSec: number, day: string): Bar[] {
  if (tfSec <= fromSec || !bars.length) return bars.slice();
  const { open } = rthBounds(day);
  const out: Bar[] = [];
  for (const b of bars) {
    const t = bucketOf(b.t, tfSec, open);
    const last = out[out.length - 1];
    if (last && last.t === t) {
      if (b.h > last.h) last.h = b.h;
      if (b.l < last.l) last.l = b.l;
      last.c = b.c;
      last.v += b.v;
    } else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}

/** Regular-session bars only (09:30–16:00 ET). */
export function regularOnly(bars: readonly Bar[], day: string): Bar[] {
  const { open, close } = rthBounds(day);
  return bars.filter((b) => b.t >= open && b.t < close);
}

export type DayStats = { rthOpen: number | null; rthHigh: number | null; rthLow: number | null; rthClose: number | null; volume: number };

/** Regular-session OHLC and the whole day's volume. */
export function dayStats(bars: readonly Bar[], day: string): DayStats {
  const rth = regularOnly(bars, day);
  let hi = -Infinity, lo = Infinity, vol = 0;
  for (const b of rth) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
  for (const b of bars) vol += b.v;
  return {
    rthOpen: rth.length ? rth[0].o : null,
    rthHigh: rth.length ? hi : null,
    rthLow: rth.length ? lo : null,
    rthClose: rth.length ? rth[rth.length - 1].c : null,
    volume: vol,
  };
}

export type SymbolDay = { symbol: string; day: string };
export const symbolDayKey = (s: SymbolDay): string => `${s.symbol}|${s.day}`;

const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,10}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Normalise + de-duplicate (symbol, day) pairs: upper-case symbols, weekdays only, valid shapes; newest day first. */
export function distinctTargets(rows: Iterable<{ symbol: string | null | undefined; day: string | null | undefined }>): SymbolDay[] {
  const seen = new Map<string, SymbolDay>();
  for (const r of rows) {
    const symbol = String(r.symbol ?? "").trim().toUpperCase();
    const day = String(r.day ?? "").slice(0, 10);
    if (!SYMBOL_RE.test(symbol) || !DAY_RE.test(day) || !isWeekday(day)) continue;
    const k = `${symbol}|${day}`;
    if (!seen.has(k)) seen.set(k, { symbol, day });
  }
  // Newest first: minute bars expire after 30 days, so the freshest days must never wait behind a long backfill.
  return [...seen.values()].sort((a, b) => (a.day === b.day ? a.symbol.localeCompare(b.symbol) : a.day < b.day ? 1 : -1));
}
