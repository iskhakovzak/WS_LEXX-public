/**
 * DEMO office for the local journal DB — 19 synthetic traders (trainee → senior), ~40k broker-like trades on REAL market
 * prices (Yahoo bars) plus the surrounding journal / academy / risk / playbook / discussion content.
 *
 *   pnpm --filter @workspace/scripts run seed-demo      # (re)create the demo office (unseed first, then seed)
 *   pnpm --filter @workspace/scripts run unseed-demo    # remove ONLY demo rows (candles_cache rows are kept)
 *   flags: --offline (Yahoo disk cache only)  --dry (generate + verify + stats, no DB writes)
 *          --unseed --drop-candles (also delete the candles_cache rows this seed inserted — exact keys from the state file)
 *
 * LOCAL ONLY: refuses to run unless DATABASE_URL (default postgresql://postgres:postgres@localhost:5432/edge_tracker)
 * points at localhost / 127.0.0.1 / ::1. No AI, no PropReports, no API login. The only network host is Yahoo Finance
 * (seed-demo-market.ts: sequential, ≥ 700 ms apart, back-off, every response cached on disk).
 *
 * Prices: every fill sits inside the real bar covering its timestamp (finest of 1m / 5m / 60m, snapped to the tick);
 * opening-auction fills = the real official open, MOC fills = the real official close, overnight exits at the open =
 * the real next-day open; stops come from real structure (premarket range, prior 15/60 min, prior day). Option premiums
 * are synthetic (delta/theta on the real underlying path) — Yahoo has no historical option prices.
 *
 * Marker (what unseed relies on):
 *   users            settings->>'demo' = 'true'  (names are the demo marker for every user-keyed table)
 *   trades           external_id LIKE 'DEMO|%'  AND context_snapshot->>'demo' = 'true'  (source = 'propreports'
 *                    so the app treats them as broker trades — pnl = gross, fees separate, like the real sync)
 *   candles_cache    real Yahoo bars in the app's exact format; inserted only where the key was missing
 *                    (ON CONFLICT DO NOTHING) with fetched_at = CANDLE_SENTINEL, keys recorded in the state file
 *                    yahoo-cache/candles-inserted.json. They are real data, so unseed keeps them unless --drop-candles.
 *   everything else  owned by / about a demo user name (trader, user_name, user_id, student, author, curator,
 *                    reviewer, created_by, …) or attached to a demo trade / thread / idea / rule / playbook row.
 *
 * Deterministic: a seeded PRNG per trader + fixed cached bars — reruns produce the same data (only serial ids differ).
 */
import pg from "pg";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { loadTicker, cacheDir, requestCount, type Bar } from "./seed-demo-market";

// ─── guard ──────────────────────────────────────────────────────────────────

const DB_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/edge_tracker";
{
  let host = "";
  try { host = new URL(DB_URL).hostname.replace(/^\[|\]$/g, ""); } catch { /* fallthrough */ }
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    console.error(`[seed-demo] REFUSED: DATABASE_URL host "${host || "?"}" is not localhost. This script only touches the local dev DB.`);
    process.exit(2);
  }
  if (process.env.NODE_ENV === "production") {
    console.error("[seed-demo] REFUSED: NODE_ENV=production");
    process.exit(2);
  }
}

const UNSEED_ONLY = process.argv.includes("--unseed");
const OFFLINE = process.argv.includes("--offline");
const DRY = process.argv.includes("--dry");
const DROP_CANDLES = process.argv.includes("--drop-candles");
const CANDLE_SENTINEL = "2026-10-16 23:59:59.424242+00";
const START = "2025-01-02";
const END = "2026-10-16";
const TODAY = "2026-10-17";

// ─── PRNG ───────────────────────────────────────────────────────────────────

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
class Rng {
  private s: number;
  constructor(seed: string) { this.s = hashStr(seed) || 1; }
  next(): number { // mulberry32
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  u(a: number, b: number): number { return a + (b - a) * this.next(); }
  int(a: number, b: number): number { return Math.floor(this.u(a, b + 1)); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  normal(): number { let u = 0; while (u === 0) u = this.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next()); }
  weighted<T extends string>(w: Partial<Record<T, number>>): T {
    const e = Object.entries(w) as [T, number][];
    const tot = e.reduce((s, [, v]) => s + (v || 0), 0);
    let r = this.next() * tot;
    for (const [k, v] of e) { r -= v || 0; if (r <= 0) return k; }
    return e[e.length - 1][0];
  }
  poisson(l: number): number { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= this.next(); } while (p > L); return k - 1; }
  shuffle<T>(a: T[]): T[] { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

// ─── real market data (Yahoo bars, see seed-demo-market.ts) ─────────────────

/** Intraday bar in ET seconds-of-day (`s`), normalised so l ≤ o,c ≤ h. `raw` keeps Yahoo's values for candles_cache. */
type IBar = { s: number; dur: number; o: number; h: number; l: number; c: number; t: number };
type DayMkt = {
  o: number; h: number; l: number; c: number; v: number; prev: number | null; atr: number; close10: number | null; rvol: number;
  h1: IBar[]; m5: IBar[] | null; m1: IBar[] | null;
  raw: { h1: Bar[]; m5: Bar[]; m1: Bar[] };
};
type TickerMeta = { name: string; sector: string; cap: string | null; float: string | null; adv: string; beta: number; isEtf: boolean; days: Map<string, DayMkt> };

// sector / approx. market cap / approx. float (descriptive columns only — prices come from Yahoo)
const UNIVERSE: [string, string, string | null, string | null][] = [
  ["SPY", "ETF", null, null], ["QQQ", "ETF", null, null], ["IWM", "ETF", null, null], ["SOXL", "ETF", null, null], ["TQQQ", "ETF", null, null],
  ["AAPL", "Technology", "3.9T", "14.8B"], ["MSFT", "Technology", "3.7T", "7.4B"], ["NVDA", "Technology", "4.6T", "23.4B"], ["AMZN", "Consumer Cyclical", "2.6T", "9.6B"],
  ["GOOGL", "Communication Services", "3.9T", "5.6B"], ["META", "Communication Services", "1.8T", "2.2B"], ["TSLA", "Consumer Cyclical", "1.4T", "2.8B"],
  ["AVGO", "Technology", "1.7T", "4.6B"], ["NFLX", "Communication Services", "480B", "425M"],
  ["AMD", "Technology", "400B", "1.6B"], ["MU", "Technology", "250B", "1.1B"], ["INTC", "Technology", "180B", "4.3B"], ["QCOM", "Technology", "180B", "1.1B"],
  ["ORCL", "Technology", "600B", "1.6B"], ["CRM", "Technology", "240B", "950M"], ["ADBE", "Technology", "150B", "420M"], ["MRVL", "Technology", "90B", "860M"],
  ["SMCI", "Technology", "25B", "540M"], ["ARM", "Technology", "150B", "100M"], ["PANW", "Technology", "130B", "650M"], ["CRWD", "Technology", "120B", "240M"],
  ["SNOW", "Technology", "75B", "320M"], ["SHOP", "Technology", "200B", "1.2B"], ["UBER", "Technology", "190B", "2.0B"],
  ["PLTR", "Technology", "400B", "2.2B"], ["COIN", "Financial Services", "80B", "210M"], ["HOOD", "Financial Services", "100B", "720M"], ["SOFI", "Financial Services", "30B", "1.1B"],
  ["MARA", "Financial Services", "6B", "350M"], ["RIOT", "Financial Services", "5B", "330M"], ["MSTR", "Technology", "80B", "230M"], ["RKLB", "Industrials", "30B", "470M"],
  ["IONQ", "Technology", "15B", "290M"], ["HIMS", "Healthcare", "10B", "205M"], ["AFRM", "Technology", "22B", "290M"],
  ["SOUN", "Technology", "5B", "380M"], ["RGTI", "Technology", "8B", "300M"], ["QBTS", "Technology", "6B", "290M"], ["OKLO", "Utilities", "12B", "120M"],
  ["ACHR", "Industrials", "6B", "550M"], ["LUNR", "Industrials", "2B", "120M"], ["BBAI", "Technology", "2B", "350M"],
  ["BA", "Industrials", "160B", "750M"], ["DIS", "Communication Services", "200B", "1.8B"], ["JPM", "Financial Services", "820B", "2.7B"], ["BAC", "Financial Services", "380B", "7.5B"],
  ["XOM", "Energy", "480B", "4.3B"], ["CVX", "Energy", "300B", "1.7B"], ["UNH", "Healthcare", "300B", "900M"], ["LLY", "Healthcare", "750B", "890M"],
  ["WMT", "Consumer Defensive", "800B", "4.4B"], ["COST", "Consumer Defensive", "420B", "440M"],
  ["F", "Consumer Cyclical", "45B", "3.9B"], ["AAL", "Industrials", "9B", "650M"], ["NIO", "Consumer Cyclical", "12B", "1.9B"], ["PLUG", "Industrials", "3B", "900M"],
];
const TICKERS = UNIVERSE.map((u) => u[0]);
const MEGA = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "NFLX"];
const TECH = ["AMD", "MU", "INTC", "QCOM", "ORCL", "CRM", "ADBE", "MRVL", "SMCI", "ARM", "PANW", "CRWD", "SNOW", "SHOP", "UBER"];
const MOMO = ["PLTR", "COIN", "HOOD", "SOFI", "MARA", "RIOT", "MSTR", "RKLB", "IONQ", "HIMS", "AFRM"];
const SMALL = ["SOUN", "RGTI", "QBTS", "OKLO", "ACHR", "LUNR", "BBAI"];
const VALUE = ["BA", "DIS", "JPM", "BAC", "XOM", "CVX", "UNH", "LLY", "WMT", "COST"];
const CHEAP = ["F", "AAL", "NIO", "PLUG", "SOFI", "INTC"];
const ETF = ["SPY", "QQQ", "IWM", "SOXL", "TQQQ"];
const OPT_UNDER = ["AAPL", "NVDA", "TSLA", "SPY", "QQQ", "AMD", "META", "AMZN"];

const T: Record<string, TickerMeta> = {};
let DAYS: string[] = [];
let DAY_IDX = new Map<string, number>();
const EARLY_CLOSE = new Set<string>();
/** Desk-wide edge shift from the real tape: trending months help everyone, choppy months / reversal days hurt. */
const REGIME = new Map<string, number>();

/** US DST (2nd Sunday of March → 1st Sunday of November). */
function isDST(date: string): boolean {
  const y = +date.slice(0, 4), m = +date.slice(5, 7), d = +date.slice(8, 10);
  if (m < 3 || m > 11) return false;
  if (m > 3 && m < 11) return true;
  const firstSun = 1 + ((7 - new Date(Date.UTC(y, m - 1, 1)).getUTCDay()) % 7);
  return m === 3 ? d >= firstSun + 7 : d < firstSun;
}
function etOf(t: number): { date: string; sec: number } {
  let x = t - 4 * 3600;
  let date = ymd(new Date(x * 1000));
  if (!isDST(date)) { x = t - 5 * 3600; date = ymd(new Date(x * 1000)); }
  return { date, sec: ((x % 86400) + 86400) % 86400 };
}
const fmtVol = (v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${Math.round(v / 1e6)}M` : `${Math.round(v / 1e3)}K`);

function groupIntraday(bars: Bar[], nominal: number): Map<string, { ib: IBar[]; raw: Bar[] }> {
  const m = new Map<string, { ib: IBar[]; raw: Bar[] }>();
  for (const b of bars) {
    const { date, sec } = etOf(b.t);
    if (sec < 4 * 3600 || sec >= 20 * 3600) continue;
    const g = m.get(date) ?? { ib: [], raw: [] };
    g.raw.push(b);
    g.ib.push({ s: sec, dur: nominal, o: b.o, h: Math.max(b.h, b.o, b.c), l: Math.min(b.l, b.o, b.c), c: b.c, t: b.t });
    m.set(date, g);
  }
  for (const g of m.values()) {
    for (let i = 0; i < g.ib.length; i++) {
      const nx = g.ib[i + 1];
      g.ib[i].dur = Math.max(1, Math.min(nominal, (nx ? nx.s : 20 * 3600) - g.ib[i].s));
    }
  }
  return m;
}

async function loadMarket(): Promise<void> {
  const t0 = Date.now();
  const nowSec = Date.parse(`${TODAY}T12:00:00Z`) / 1000; // pinned → stable cache keys
  const spyRet = new Map<string, number>();
  for (const [tk, sector, cap, float] of UNIVERSE) {
    const b = await loadTicker(tk, nowSec, OFFLINE);
    if (!b.d1.length || !b.h1.length) throw new Error(`no Yahoo data for ${tk}${OFFLINE ? " in the offline cache" : ""}`);
    const h1 = groupIntraday(b.h1, 3600), m5 = groupIntraday(b.m5, 300), m1 = groupIntraday(b.m1, 60);
    const days = new Map<string, DayMkt>();
    const d1 = b.d1.map((x) => ({ date: etOf(x.t).date, ...x }));
    const trs: number[] = [];
    const rets = new Map<string, number>();
    for (let i = 0; i < d1.length; i++) {
      const x = d1[i], p = d1[i - 1];
      const prev = p ? p.c : null;
      const tr = prev == null ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - prev), Math.abs(x.l - prev));
      const atr = trs.length ? trs.slice(-14).reduce((a, v) => a + v, 0) / Math.min(14, trs.length) : tr;
      trs.push(tr);
      if (prev) rets.set(x.date, x.c / prev - 1);
      const hh = h1.get(x.date);
      if (!hh) continue;
      days.set(x.date, {
        o: x.o, h: Math.max(x.h, x.o, x.c), l: Math.min(x.l, x.o, x.c), c: x.c, v: x.v, prev, atr, close10: d1[i - 10]?.c ?? null,
        rvol: (() => { const b20 = d1.slice(Math.max(0, i - 20), i); const avg = b20.reduce((a, y) => a + y.v, 0) / Math.max(1, b20.length); return avg > 0 ? r2(clamp(x.v / avg, 0.1, 30)) : 1; })(),
        h1: hh.ib, m5: m5.get(x.date)?.ib ?? null, m1: m1.get(x.date)?.ib ?? null,
        raw: { h1: hh.raw, m5: m5.get(x.date)?.raw ?? [], m1: m1.get(x.date)?.raw ?? [] },
      });
    }
    if (tk === "SPY") for (const [d, r] of rets) spyRet.set(d, r);
    let cov = 0, vr = 0;
    for (const [d, r] of rets) { const s = spyRet.get(d); if (s == null) continue; cov += r * s; vr += s * s; }
    const recent = d1.slice(-50);
    T[tk] = { name: b.meta.longName || b.meta.shortName || tk, sector, cap, float, isEtf: sector === "ETF",
      adv: fmtVol(recent.reduce((a, x) => a + x.v, 0) / Math.max(1, recent.length)), beta: vr ? r2(cov / vr) : 1, days };
  }
  // trading calendar = sessions SPY actually traded; early closes = no regular hourly bar at/after 13:00
  DAYS = [...T.SPY.days.keys()].filter((d) => d >= START && d <= END).sort();
  DAY_IDX = new Map(DAYS.map((d, i) => [d, i]));
  // NYSE 13:00 early closes in range (post-market bars exist after 13:00, so the list is official, checked against SPY volume)
  for (const d of ["2025-07-03", "2025-11-28", "2025-12-24"]) {
    const m = T.SPY.days.get(d);
    if (!m) continue;
    const after13 = m.h1.filter((b) => b.s >= 13 * 3600 && b.s < 16 * 3600).reduce((a, b) => a + (m.raw.h1.find((x) => x.t === b.t)?.v ?? 0), 0);
    const before = m.h1.filter((b) => b.s >= OPEN && b.s < 13 * 3600).reduce((a, b) => a + (m.raw.h1.find((x) => x.t === b.t)?.v ?? 0), 0);
    if (after13 < before * 0.15) EARLY_CLOSE.add(d); else console.warn(`[seed-demo] ${d}: SPY volume after 13:00 looks like a full session — not treating as early close`);
  }
  {
    const spy = T.SPY.days;
    const byMonth = new Map<string, string[]>();
    for (const d of DAYS) { const k = d.slice(0, 7); byMonth.set(k, [...(byMonth.get(k) ?? []), d]); }
    const trendOf = (ds: string[]) => {
      const first = spy.get(ds[0])!, last = spy.get(ds[ds.length - 1])!;
      const path = ds.reduce((a, d) => { const m = spy.get(d)!; return a + Math.abs(m.c - (m.prev ?? m.o)); }, 0);
      return path ? Math.abs(last.c - (first.prev ?? first.o)) / path : 0.3;
    };
    const trends = [...byMonth.values()].map(trendOf).sort((a, b) => a - b);
    const med = trends[Math.floor(trends.length / 2)];
    for (const [, ds] of byMonth) {
      const monthShift = clamp((trendOf(ds) - med) * 0.8, -0.25, 0.25);
      for (const d of ds) {
        const m = spy.get(d)!;
        const body = m.h > m.l ? Math.abs(m.c - m.o) / (m.h - m.l) : 0.5;
        REGIME.set(d, monthShift + (body < 0.2 ? -0.08 : body > 0.7 ? 0.05 : 0));
      }
    }
  }
  console.log(`[seed-demo] market: ${TICKERS.length} tickers, ${DAYS.length} sessions ${DAYS[0]}..${DAYS[DAYS.length - 1]}, early closes ${[...EARLY_CLOSE].join(",") || "—"}, Yahoo requests ${requestCount} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

const OPEN = 9 * 3600 + 30 * 60; // 34200
const closeOf = (d: string) => (EARLY_CLOSE.has(d) ? 13 * 3600 : 16 * 3600);
const nextSession = (d: string, n = 1): string | null => { const i = DAY_IDX.get(d); return i == null ? null : DAYS[i + n] ?? null; };
/** Next session for content timestamps (past END: next weekday). */
const nextDay = (d: string): string => { const n = nextSession(d); if (n) return n; let x = addDays(d, 1); while (dow(x) === 0 || dow(x) === 6) x = addDays(x, 1); return x; };
const mkt = (tk: string, d: string): DayMkt | null => T[tk]?.days.get(d) ?? null;
const tradeable = (tk: string, d: string) => { const m = mkt(tk, d); return !!m && m.h1.filter((b) => b.s >= OPEN && b.s < 16 * 3600).length >= 3; };

const tickSz = (p: number) => (p >= 1 ? 0.01 : 0.0001);
const tick = (p: number) => (p >= 1 ? Math.round(p * 100) / 100 : Math.round(p * 10000) / 10000);
/** Round to the tick and keep it inside the bar's real range. */
function snap(p: number, b: { l: number; h: number }): number {
  const ts = tickSz(p);
  const lo = Math.ceil(b.l / ts - 1e-3) * ts, hi = Math.floor(b.h / ts + 1e-3) * ts; // Yahoo values are float32 (4.3499999 = 4.35)
  let q = Math.round(p / ts) * ts;
  if (lo <= hi) q = clamp(q, lo, hi); else return NaN; // no whole tick inside the bar (sub-penny prints) → caller skips the trade
  return ts === 0.01 ? Math.round(q * 100) / 100 : Math.round(q * 10000) / 10000;
}
function covering(arr: IBar[] | null, sec: number): IBar | null {
  if (!arr || !arr.length) return null;
  let lo = 0, hi = arr.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].s <= sec) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  if (k < 0) return null;
  const b = arr[k];
  return sec < b.s + b.dur ? b : null;
}
/** Finest real bar covering an ET second of the day (1m → 5m → 60m). */
const barAt = (m: DayMkt, sec: number): IBar | null => covering(m.m1, sec) ?? covering(m.m5, sec) ?? covering(m.h1, sec);
/** Deterministic intrabar path: up bar o→l→h→c, down bar o→h→l→c (vertex times vary per bar). */
function vertsOf(b: IBar): [number, number][] {
  const hsh = ((b.t * 2654435761) >>> 0) / 4294967296;
  const f1 = 0.12 + 0.33 * hsh, f2 = 0.55 + 0.33 * ((hsh * 7.31) % 1);
  const up = b.c >= b.o;
  return [[b.s, b.o], [b.s + f1 * b.dur, up ? b.l : b.h], [b.s + f2 * b.dur, up ? b.h : b.l], [b.s + 0.985 * b.dur, b.c]];
}
function pathPx(b: IBar, sec: number): number {
  const v = vertsOf(b);
  if (sec <= v[0][0]) return v[0][1];
  for (let i = 1; i < v.length; i++) if (sec <= v[i][0]) return v[i - 1][1] + ((v[i][1] - v[i - 1][1]) * (sec - v[i - 1][0])) / (v[i][0] - v[i - 1][0]);
  return v[v.length - 1][1];
}
/** Real price of `tk` at an ET wall second (inside the finest bar covering it), or null if no bar covers it. */
function priceAt(tk: string, d: string, sec: number): { px: number; b: IBar } | null {
  const m = mkt(tk, d);
  if (!m) return null;
  const b = barAt(m, sec);
  return b ? { px: snap(pathPx(b, sec), b), b } : null;
}

type V = { k: number; p: number; b: IBar; d: string; gap: boolean };
type Leg = { date: string; from: number; to: number; ext: boolean; openGap?: boolean };
/** Vertex path over one or more session windows using the finest series the day has. */
function buildPath(tk: string, legs: Leg[]): V[] {
  const out: V[] = [];
  for (const L of legs) {
    const m = mkt(tk, L.date);
    if (!m) return [];
    const base = DAY_IDX.get(L.date)! * 86400;
    const series = m.m1 && m.m1.some((b) => b.s >= L.from - 60 && b.s < L.to) ? m.m1 : m.m5 && m.m5.some((b) => b.s >= L.from - 300 && b.s < L.to) ? m.m5 : m.h1;
    const lo = L.ext ? 4 * 3600 : OPEN, hi = L.ext ? 20 * 3600 : closeOf(L.date);
    const bars = series.filter((b) => b.s + b.dur > L.from && b.s < L.to && b.s >= lo - (L.ext ? 0 : 1800) && b.s < hi && (L.ext || b.s >= OPEN || b.s + b.dur > OPEN));
    if (!bars.length) return [];
    if (L.openGap) out.push({ k: base + OPEN, p: m.o, b: bars.find((b) => b.s >= OPEN) ?? bars[0], d: L.date, gap: true });
    let first = true;
    for (const b of bars) {
      const vs = vertsOf(b);
      if (first && !L.openGap && b.s <= L.from) {
        out.push({ k: base + L.from, p: pathPx(b, L.from), b, d: L.date, gap: false });
      } else {
        out.push({ k: base + Math.max(b.s, L.from), p: b.o, b, d: L.date, gap: true });
      }
      first = false;
      for (const [s, p] of vs.slice(1)) if (s > L.from && s < L.to) out.push({ k: base + s, p, b, d: L.date, gap: false });
      if (b.s + b.dur >= L.to && b.s <= L.to) { out.push({ k: base + L.to, p: pathPx(b, L.to), b, d: L.date, gap: false }); break; }
    }
  }
  // drop non-increasing keys (zero-length gaps)
  return out.filter((v, i) => i === 0 || v.k > out[i - 1].k || (v.k === out[i - 1].k && v.gap));
}
const keyOf0 = (dd: string, s: number) => DAY_IDX.get(dd)! * 86400 + s;
type Level = { name: string; px: number; up: boolean };
type Hit = { name: string; k: number; px: number; b: IBar; d: string };
class Cursor {
  i = 0; k: number; p: number;
  constructor(public v: V[]) { this.k = v[0]?.k ?? 0; this.p = v[0]?.p ?? 0; }
  next(levels: Level[]): Hit | null {
    for (; this.i + 1 < this.v.length; this.i++) {
      const z = this.v[this.i + 1];
      let best: Hit | null = null;
      for (const L of levels) {
        const hit = L.up ? this.p < L.px && z.p >= L.px : this.p > L.px && z.p <= L.px;
        if (!hit) continue;
        const k = z.gap || z.k === this.k ? z.k : this.k + ((z.k - this.k) * (L.px - this.p)) / (z.p - this.p);
        const px = z.gap ? z.p : L.px;
        if (!best || k < best.k) best = { name: L.name, k, px, b: z.b, d: z.d };
      }
      if (best) {
        if (best.k >= z.k) { this.k = z.k; this.p = z.p; this.i++; } else { this.k = best.k; this.p = best.px; }
        return best;
      }
      this.k = z.k; this.p = z.p;
    }
    return null;
  }
}

// ─── calendar helpers ───────────────────────────────────────────────────────

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const dow = (s: string) => new Date(`${s}T12:00:00Z`).getUTCDay();
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
function mondayOf(d: string): string { const w = (dow(d) + 6) % 7; return addDays(d, -w); }
function isoWeekKey(d: string): string {
  const dt = new Date(`${d}T00:00:00Z`);
  const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day + 3);
  const year = dt.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((dt.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
const hms = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
/** Postgres timestamptz literal for an ET wall time (Postgres applies DST). */
const etTs = (date: string, sec: number) => `${date} ${hms(sec)} America/New_York`;
function holdHuman(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// ─── playbook setups ────────────────────────────────────────────────────────

type StageKey = "trainee" | "junior" | "trader" | "senior";
type Strat = "OPG" | "OPGtoDAY" | "Day" | "MOC" | "Overnight" | "Swing" | "AfterMarket" | "Premarket" | "OPT";
/** bias: how the side follows real structure — gap direction, the day's move so far, multi-day trend, fixed side, or free. */
type Bias = "long" | "short" | "gapWith" | "gapFade" | "trend" | "fade" | "free";
type SetupDef = { strat: Strat; bias: Bias; gap?: "up" | "down" };
const SETUP: Record<string, SetupDef> = {
  "OPG Momentum — Opening Auction Breakout": { strat: "OPG", bias: "gapWith" },
  "OPG Gap Fade — Auction Reversal": { strat: "OPG", bias: "gapFade" },
  "OPG — Opening Price Guarantee Order": { strat: "OPG", bias: "gapWith" },
  "IMBX — Opening Imbalance Long": { strat: "OPG", bias: "long" },
  "IMBX — Opening Imbalance Short": { strat: "OPG", bias: "short" },
  "IMBX Fade — Imbalance Reversal": { strat: "OPGtoDAY", bias: "gapFade" },
  "IMBX + VWAP Confirmation": { strat: "OPGtoDAY", bias: "gapWith" },
  "Gap and Go — Earnings Momentum": { strat: "OPGtoDAY", bias: "gapWith" },
  "Opening Drive — Momentum Ignition": { strat: "OPGtoDAY", bias: "gapWith" },
  "Second Day Play — Momentum Continuation": { strat: "OPGtoDAY", bias: "free" },
  "Earnings Gap Down — Short the Failed Bounce": { strat: "OPGtoDAY", bias: "short", gap: "down" },
  "Earnings Gap Up — First Pullback Long": { strat: "OPGtoDAY", bias: "long", gap: "up" },
  "Weak Open Short — Gap Up Fail": { strat: "OPGtoDAY", bias: "short", gap: "up" },
  "Exhaustion Gap — Reversal Signal": { strat: "OPGtoDAY", bias: "gapFade" },
  "Gap Fill — Statistical Edge": { strat: "Day", bias: "gapFade" },
  "Opening Range Breakout (ORB)": { strat: "Day", bias: "trend" },
  "VWAP Trend Trade — Intraday": { strat: "Day", bias: "trend" },
  "High of Day Break — Momentum Ignition": { strat: "Day", bias: "long" },
  "Red to Green Move": { strat: "Day", bias: "long", gap: "down" },
  "VWAP Reclaim — Mean Reversion Long": { strat: "Day", bias: "long" },
  "Parabolic Short — Extended Stock": { strat: "Day", bias: "short" },
  "Dead Cat Bounce — Short the Recovery": { strat: "Day", bias: "short" },
  "Failed Follow Through — Bear Flag Short": { strat: "Day", bias: "short" },
  "Tape Reading — Order Flow Entry": { strat: "Day", bias: "free" },
  "Low Float Momentum — Float Rotation": { strat: "Day", bias: "long" },
  "Short Squeeze Play": { strat: "Day", bias: "long" },
  "Mean Reversion — Oversold Bounce": { strat: "Day", bias: "long" },
  "Rubber Band Snap — Extended Stock Reversal": { strat: "Day", bias: "fade" },
  "News Fade — Sell/Short the News": { strat: "Day", bias: "short" },
  "Sympathy Play — Sector Follower": { strat: "Day", bias: "trend" },
  "MOC Imbalance — Closing Auction Play": { strat: "MOC", bias: "trend" },
  "MOC Fade — Closing Reversal": { strat: "MOC", bias: "fade" },
  "MOC — Market On Close Order": { strat: "MOC", bias: "free" },
  "Power Hour Momentum — 3:00–4:00 PM": { strat: "MOC", bias: "trend" },
  "MOC + Options Expiration — Pin Risk Play": { strat: "MOC", bias: "free" },
  "Overnight Hold — Swing Catalyst": { strat: "Overnight", bias: "trend" },
  "Post-Earnings Drift (PEAD) — Follow Surprise": { strat: "Overnight", bias: "gapWith" },
  "Earnings Whisper — Pre-Earnings Position": { strat: "Overnight", bias: "long" },
  "9 EMA Daily — Swing Entry на Trend": { strat: "Swing", bias: "trend" },
  "Multi-Day Breakout — Weekly Range Expansion": { strat: "Swing", bias: "trend" },
  "Moving Average Crossover — Trend Change": { strat: "Swing", bias: "trend" },
  "Fibonacci Retracement — Measured Pullback": { strat: "Swing", bias: "trend" },
  "After Hours Earnings React — Next Day Prep": { strat: "AfterMarket", bias: "trend" },
  "CPI / Jobs Report — Morning Gap Framework": { strat: "Premarket", bias: "gapWith" },
  "Fed Day / FOMC — 2:00 PM Reversal": { strat: "OPT", bias: "trend" },
  "Earnings Range Anticipation — Straddle Alternative": { strat: "OPT", bias: "free" },
};
/** Personal (demo) playbook entries: owner, name, setup def, conditions, stop, targets. */
const PERSONAL: [string, string, SetupDef, string, string, string][] = [
  ["Алексей М.", "OPG по гэперу — мой вариант", { strat: "OPG", bias: "gapWith" }, "Гэп > 3% на новостях, премаркет-объём > 1М, OPG в сторону гэпа.", "Стоп за минимум премаркета", "Фикс половины на 1R, остаток — до 9:45"],
  ["Павел Д.", "MOC-имбаланс > 20% ADV", { strat: "MOC", bias: "trend" }, "Имбаланс публикуется в 15:50, размер > 20% ADV, цена у хая/лоя дня.", "Стоп за лоем последнего часа", "Выход в закрывающем аукционе"],
  ["Никита С.", "ORB 5 минут на лидерах сектора", { strat: "OPGtoDAY", bias: "gapWith" }, "Лидер сектора, пробой диапазона первых 5 минут с объёмом.", "Стоп под минимумом премаркета", "Цель — 2R, трейлинг по VWAP"],
  ["Евгений Л.", "PEAD — держу победителя отчёта", { strat: "Overnight", bias: "trend" }, "Отчёт лучше ожиданий, закрытие у хая дня, сектор сильный.", "Стоп под минимум дня отчёта", "Фикс на открытии следующего дня или трейлинг"],
  ["Игорь П.", "Шорт параболы на моментум-именах", { strat: "Day", bias: "short" }, "Рост > 30% за 2 дня, разворотная свеча на 5 минутах, объём падает.", "Стоп над HOD последних 15 минут", "Цели: VWAP, затем PDC"],
  ["Кирилл Б.", "Откат к VWAP — лонг в тренде", { strat: "Day", bias: "trend" }, "Тренд с утра, первый откат к VWAP на падающем объёме.", "Стоп под лоем последних 15 минут", "Цель — HOD"],
  ["Сергей В.", "Опционы на FOMC — дебетовые колл/пут", { strat: "OPT", bias: "trend" }, "Направление после 14:00 подтверждено, покупаю ближайшие страйки.", "Стоп — 40% премии", "Фикс половины на +50%"],
  ["Максим Р.", "Скальп ленты на SPY/QQQ", { strat: "Day", bias: "free" }, "Крупный покупатель/продавец на уровне, лента ускоряется, спред 1 цент.", "Стоп 0.05–0.1 ATR за уровнем", "Фикс на первом импульсе, 0.8–1.2R"],
  ["Роман Ж.", "OPG-имбаланс > 30% ADV на открытии", { strat: "OPG", bias: "gapWith" }, "Имбаланс в 9:28 > 30% ADV в сторону гэпа, премаркет держит уровень.", "Стоп за минимум/максимум премаркета", "Выход в первые 3–10 минут"],
  ["Глеб А.", "Пин к страйку в пятницу на закрытии", { strat: "MOC", bias: "fade" }, "Экспирация, крупный открытый интерес на ближайшем страйке, цена в 0.5% от него.", "Стоп за экстремум последнего часа", "Выход MOC"],
  ["Андрей Н.", "Свинг по недельному пробою", { strat: "Swing", bias: "trend" }, "Пробой недельного диапазона на объёме, сектор в тренде.", "Стоп под лоем предыдущего дня", "Цель — 2–3R за 2–4 дня"],
  ["Виктор С.", "Премаркет-гэпер на новостях", { strat: "Premarket", bias: "gapWith" }, "Новость до 8:00, гэп > 4%, премаркет-объём > 500K.", "Стоп за лоем/хаем премаркета", "Фикс до открытия или на первом импульсе после"],
  ["Степан Л.", "Недельные коллы/путы на пробое уровня", { strat: "OPT", bias: "trend" }, "Пробой дневного уровня с объёмом, недельные опционы ATM.", "Стоп — 40% премии", "Фикс половины на +60%"],
];
for (const [, name, def] of PERSONAL) SETUP[name] = def;

// ─── people ─────────────────────────────────────────────────────────────────

type Persona = {
  tpd: number; riskMul: number; payoff: number; noise: number;
  /** selection edge: probability to pass on a losing candidate (negative = passes on winners) */
  edge: (d: string) => number;
  holdMul?: number; stopMul?: number;
  setups: [string, number][];
  universe: string[]; shortBias: number; blowups: number; slumps: number; account: string;
};
type DemoUser = {
  name: string; role: "trader" | "curator" | "admin";
  stages?: [string, StageKey][]; // [since, stage]
  mentor?: string; curator?: string; riskManager?: string;
  persona?: Persona;
};
const lin = (d0: string, v0: number, d1: string, v1: number) => (d: string) => {
  if (d <= d0) return v0; if (d >= d1) return v1;
  return v0 + (v1 - v0) * (dayDiff(d0, d) / dayDiff(d0, d1));
};
const MENTOR = "Ольга Н.";
const RISK = "Руслан Т.";
const USERS: DemoUser[] = [
  { name: "Дмитрий К.", role: "admin" },
  { name: "Сергей В.", role: "admin", stages: [["2024-03-04", "senior"]], riskManager: RISK,
    persona: { tpd: 4.2, riskMul: 1.0, payoff: 1.5, noise: 0.08, edge: () => 0.47, shortBias: 0.4, blowups: 1, slumps: 2, account: "DEMO1001", holdMul: 1.5,
      setups: [["MOC Imbalance — Closing Auction Play", 3], ["Overnight Hold — Swing Catalyst", 2.2], ["Post-Earnings Drift (PEAD) — Follow Surprise", 1.4], ["Gap and Go — Earnings Momentum", 2.2], ["Fed Day / FOMC — 2:00 PM Reversal", 0.4], ["9 EMA Daily — Swing Entry на Trend", 0.4], ["Опционы на FOMC — дебетовые колл/пут", 0.4]],
      universe: [...MEGA, ...ETF, ...VALUE] } },
  { name: MENTOR, role: "curator" },
  { name: RISK, role: "curator" },
  { name: "Алексей М.", role: "trader", stages: [["2023-09-04", "senior"]], riskManager: RISK,
    persona: { tpd: 7, riskMul: 1.0, payoff: 1.0, noise: 0.05, edge: () => 0.48, shortBias: 0.45, blowups: 1, slumps: 2, account: "DEMO1002",
      setups: [["OPG Momentum — Opening Auction Breakout", 3], ["OPG — Opening Price Guarantee Order", 2], ["IMBX — Opening Imbalance Long", 1], ["IMBX — Opening Imbalance Short", 1], ["Opening Drive — Momentum Ignition", 3], ["MOC — Market On Close Order", 1.5], ["OPG по гэперу — мой вариант", 2]],
      universe: [...MEGA, ...TECH, ...MOMO] } },
  { name: "Игорь П.", role: "trader", stages: [["2024-02-05", "trader"], ["2025-05-05", "senior"]], riskManager: RISK,
    persona: { tpd: 6, riskMul: 0.9, payoff: 1.4, noise: 0.12, edge: (d) => (d < "2025-12-01" ? 0.4 : lin("2025-12-01", 0.44, "2026-04-01", -0.04)(d)), shortBias: 0.4, blowups: 4, slumps: 3, account: "DEMO1003",
      setups: [["Parabolic Short — Extended Stock", 2], ["High of Day Break — Momentum Ignition", 2], ["Gap and Go — Earnings Momentum", 2.5], ["After Hours Earnings React — Next Day Prep", 1], ["Short Squeeze Play", 1], ["CPI / Jobs Report — Morning Gap Framework", 0.8], ["Шорт параболы на моментум-именах", 1.5]],
      universe: [...MOMO, ...TECH.slice(0, 8), "TSLA", "NVDA", "TQQQ", "SOXL", ...SMALL.slice(0, 3)] } },
  { name: "Никита С.", role: "trader", stages: [["2024-06-03", "junior"], ["2025-09-02", "trader"]], curator: MENTOR, riskManager: RISK,
    persona: { tpd: 5.5, riskMul: 1.0, payoff: 1.1, noise: 0.07, edge: lin("2025-01-02", 0.14, "2026-10-16", 0.5), shortBias: 0.4, blowups: 2, slumps: 2, account: "DEMO1004",
      setups: [["Opening Drive — Momentum Ignition", 2.5], ["Gap and Go — Earnings Momentum", 2], ["OPG Momentum — Opening Auction Breakout", 2], ["VWAP Trend Trade — Intraday", 1.5], ["MOC Imbalance — Closing Auction Play", 1], ["ORB 5 минут на лидерах сектора", 2]],
      universe: [...MEGA, ...TECH, ...MOMO.slice(0, 6)] } },
  { name: "Павел Д.", role: "trader", stages: [["2024-01-08", "trader"]], riskManager: RISK,
    persona: { tpd: 5.5, riskMul: 1.0, payoff: 0.9, noise: 0.04, edge: () => 0.46, shortBias: 0.5, blowups: 1, slumps: 2, account: "DEMO1005",
      setups: [["MOC Imbalance — Closing Auction Play", 3], ["MOC Fade — Closing Reversal", 1.5], ["MOC — Market On Close Order", 2], ["MOC + Options Expiration — Pin Risk Play", 0.8], ["OPG — Opening Price Guarantee Order", 2], ["MOC-имбаланс > 20% ADV", 2.5]],
      universe: [...MEGA, ...ETF, "ORCL", "INTC", "MU", "UNH", "XOM", "JPM", "LLY"] } },
  { name: "Евгений Л.", role: "trader", stages: [["2024-04-01", "junior"], ["2025-03-03", "trader"]], curator: MENTOR, riskManager: RISK,
    persona: { tpd: 4.5, riskMul: 1.0, payoff: 1.6, noise: 0.08, edge: () => 0.42, shortBias: 0.35, blowups: 2, slumps: 2, account: "DEMO1006", holdMul: 1.4,
      setups: [["Overnight Hold — Swing Catalyst", 2], ["Post-Earnings Drift (PEAD) — Follow Surprise", 1.5], ["Earnings Whisper — Pre-Earnings Position", 0.7], ["Gap and Go — Earnings Momentum", 3], ["MOC — Market On Close Order", 1.5], ["Earnings Range Anticipation — Straddle Alternative", 0.7], ["PEAD — держу победителя отчёта", 1.2]],
      universe: [...MEGA, ...VALUE, "PLTR", "MU", "HOOD", "CRWD", "PANW"] } },
  { name: "Кирилл Б.", role: "trader", stages: [["2025-06-02", "trainee"], ["2025-12-01", "junior"]], mentor: MENTOR, curator: MENTOR, riskManager: RISK,
    persona: { tpd: 5, riskMul: 1.0, payoff: 1.0, noise: 0.07, edge: lin("2025-06-02", 0.06, "2026-10-16", 0.38), shortBias: 0.35, blowups: 1, slumps: 2, account: "DEMO1007",
      setups: [["OPG — Opening Price Guarantee Order", 2.5], ["Opening Range Breakout (ORB)", 2], ["VWAP Trend Trade — Intraday", 1.5], ["MOC — Market On Close Order", 1], ["Откат к VWAP — лонг в тренде", 1.5]],
      universe: [...MEGA.slice(0, 6), ...CHEAP, "AMD", "UBER"] } },
  { name: "Артём Г.", role: "trader", stages: [["2025-10-06", "trainee"], ["2026-04-06", "junior"]], mentor: MENTOR, curator: MENTOR, riskManager: RISK,
    persona: { tpd: 5.5, riskMul: 1.0, payoff: 1.0, noise: 0.07, edge: lin("2025-10-06", 0.04, "2026-10-16", 0.32), shortBias: 0.35, blowups: 1, slumps: 1, account: "DEMO1008",
      setups: [["Opening Range Breakout (ORB)", 2], ["Red to Green Move", 1.5], ["OPG Momentum — Opening Auction Breakout", 2], ["VWAP Reclaim — Mean Reversion Long", 1.5], ["MOC Fade — Closing Reversal", 1]],
      universe: [...CHEAP, "AAPL", "AMD", "NVDA", "PLTR", "HOOD"] } },
  { name: "Денис Ф.", role: "trader", stages: [["2025-08-04", "trainee"], ["2026-02-02", "junior"]], mentor: MENTOR, curator: MENTOR, riskManager: RISK,
    persona: { tpd: 6, riskMul: 1.0, payoff: 1.1, noise: 0.12, edge: () => 0.0, shortBias: 0.45, blowups: 3, slumps: 2, account: "DEMO1009",
      setups: [["High of Day Break — Momentum Ignition", 2.5], ["Gap and Go — Earnings Momentum", 2], ["Parabolic Short — Extended Stock", 1.5], ["CPI / Jobs Report — Morning Gap Framework", 1], ["Low Float Momentum — Float Rotation", 1.5], ["Overnight Hold — Swing Catalyst", 0.15]],
      universe: [...CHEAP, ...SMALL.slice(0, 4), "TSLA", "SOXL", "TQQQ", "COIN", "MARA"] } },
  { name: "Илья Ш.", role: "trader", stages: [["2026-02-02", "trainee"]], mentor: MENTOR, curator: MENTOR, riskManager: RISK,
    persona: { tpd: 7.8, riskMul: 0.8, payoff: 0.9, noise: 0.06, edge: lin("2026-02-02", 0.0, "2026-10-16", 0.16), shortBias: 0.3, blowups: 0, slumps: 1, account: "DEMO1010",
      setups: [["Opening Range Breakout (ORB)", 2], ["VWAP Trend Trade — Intraday", 2], ["OPG — Opening Price Guarantee Order", 2], ["MOC — Market On Close Order", 1]],
      universe: [...CHEAP, "AAPL", "AMD", "SPY", "QQQ"] } },
  { name: "Владислав Е.", role: "trader", stages: [["2026-03-02", "trainee"]], mentor: MENTOR, curator: MENTOR, riskManager: RISK,
    persona: { tpd: 8.6, riskMul: 0.8, payoff: 1.0, noise: 0.07, edge: lin("2026-03-02", 0.0, "2026-10-16", 0.14), shortBias: 0.3, blowups: 0, slumps: 0, account: "DEMO1011",
      setups: [["VWAP Reclaim — Mean Reversion Long", 2], ["Opening Range Breakout (ORB)", 2], ["Red to Green Move", 1.5]],
      universe: [...CHEAP, "SOUN", "ACHR", "SPY"] } },
  // ── round 2: eight more styles
  { name: "Максим Р.", role: "trader", stages: [["2024-09-02", "junior"], ["2025-04-07", "trader"]], riskManager: RISK,
    persona: { tpd: 10.5, riskMul: 0.55, payoff: 0.95, noise: 0.05, edge: () => 0.42, shortBias: 0.48, blowups: 1, slumps: 2, account: "DEMO1012", holdMul: 0.3, stopMul: 0.55,
      setups: [["Tape Reading — Order Flow Entry", 3], ["VWAP Trend Trade — Intraday", 2], ["High of Day Break — Momentum Ignition", 1.5], ["Opening Range Breakout (ORB)", 1.5], ["Failed Follow Through — Bear Flag Short", 1.2], ["Скальп ленты на SPY/QQQ", 2.5]],
      universe: ["SPY", "QQQ", "NVDA", "TSLA", "AMD", "AAPL", "META", "AMZN", "TQQQ", "SOXL", "MSFT"] } },
  { name: "Роман Ж.", role: "trader", stages: [["2023-11-06", "trader"], ["2024-10-07", "senior"]], riskManager: RISK,
    persona: { tpd: 7.5, riskMul: 1.0, payoff: 0.9, noise: 0.05, edge: () => 0.5, shortBias: 0.5, blowups: 1, slumps: 2, account: "DEMO1013", holdMul: 0.8,
      setups: [["OPG Momentum — Opening Auction Breakout", 3], ["OPG Gap Fade — Auction Reversal", 2], ["OPG — Opening Price Guarantee Order", 1.5], ["IMBX — Opening Imbalance Long", 1.2], ["IMBX — Opening Imbalance Short", 1.2], ["IMBX Fade — Imbalance Reversal", 1], ["OPG-имбаланс > 30% ADV на открытии", 2]],
      universe: [...MEGA, ...TECH, ...MOMO, ...VALUE.slice(0, 5)] } },
  { name: "Глеб А.", role: "trader", stages: [["2024-05-06", "junior"], ["2025-02-03", "trader"]], riskManager: RISK,
    persona: { tpd: 5.5, riskMul: 1.0, payoff: 0.9, noise: 0.05, edge: () => 0.44, shortBias: 0.5, blowups: 1, slumps: 2, account: "DEMO1014",
      setups: [["MOC Imbalance — Closing Auction Play", 3], ["MOC Fade — Closing Reversal", 2], ["Power Hour Momentum — 3:00–4:00 PM", 2], ["MOC + Options Expiration — Pin Risk Play", 1], ["MOC — Market On Close Order", 1.5], ["Пин к страйку в пятницу на закрытии", 1]],
      universe: [...MEGA, ...ETF, ...VALUE, "AMD", "MU", "ORCL"] } },
  { name: "Андрей Н.", role: "trader", stages: [["2023-04-03", "senior"]], riskManager: RISK,
    persona: { tpd: 3.6, riskMul: 1.0, payoff: 1.9, noise: 0.06, edge: () => 0.4, shortBias: 0.3, blowups: 1, slumps: 2, account: "DEMO1015", holdMul: 1.5,
      setups: [["Overnight Hold — Swing Catalyst", 2.5], ["Post-Earnings Drift (PEAD) — Follow Surprise", 1.5], ["9 EMA Daily — Swing Entry на Trend", 2], ["Multi-Day Breakout — Weekly Range Expansion", 1.5], ["Moving Average Crossover — Trend Change", 1], ["Fibonacci Retracement — Measured Pullback", 1], ["Свинг по недельному пробою", 1.5]],
      universe: [...MEGA, ...TECH.slice(0, 10), ...VALUE, "PLTR", "HOOD", "RKLB"] } },
  { name: "Виктор С.", role: "trader", stages: [["2024-07-01", "junior"], ["2025-06-02", "trader"]], riskManager: RISK,
    persona: { tpd: 5.5, riskMul: 0.9, payoff: 1.3, noise: 0.09, edge: () => 0.42, shortBias: 0.45, blowups: 2, slumps: 2, account: "DEMO1016",
      setups: [["Gap and Go — Earnings Momentum", 3], ["Earnings Gap Down — Short the Failed Bounce", 1.5], ["Earnings Gap Up — First Pullback Long", 1.5], ["After Hours Earnings React — Next Day Prep", 1.5], ["CPI / Jobs Report — Morning Gap Framework", 1], ["News Fade — Sell/Short the News", 1], ["Премаркет-гэпер на новостях", 1.5]],
      universe: [...MEGA, ...TECH, ...MOMO] } },
  { name: "Даниил О.", role: "trader", stages: [["2025-03-03", "trainee"], ["2025-09-01", "junior"]], mentor: MENTOR, curator: MENTOR, riskManager: RISK,
    persona: { tpd: 5.5, riskMul: 0.9, payoff: 1.5, noise: 0.11, edge: lin("2025-03-03", 0.04, "2026-10-16", 0.3), shortBias: 0.3, blowups: 2, slumps: 2, account: "DEMO1017",
      setups: [["Low Float Momentum — Float Rotation", 2.5], ["Short Squeeze Play", 1.5], ["Red to Green Move", 1.5], ["High of Day Break — Momentum Ignition", 2], ["Parabolic Short — Extended Stock", 1]],
      universe: [...SMALL, "MARA", "RIOT", "IONQ", "HIMS", "PLUG", "NIO", "SOFI"] } },
  { name: "Степан Л.", role: "trader", stages: [["2025-04-07", "junior"], ["2026-05-04", "trader"]], curator: MENTOR, riskManager: RISK,
    persona: { tpd: 4.8, riskMul: 1.0, payoff: 1.4, noise: 0.08, edge: lin("2025-04-07", 0.16, "2026-10-16", 0.4), shortBias: 0.4, blowups: 1, slumps: 2, account: "DEMO1018",
      setups: [["Fed Day / FOMC — 2:00 PM Reversal", 1], ["Earnings Range Anticipation — Straddle Alternative", 1], ["VWAP Trend Trade — Intraday", 2], ["Opening Range Breakout (ORB)", 2], ["Opening Drive — Momentum Ignition", 1.5], ["Недельные коллы/путы на пробое уровня", 1.4]],
      universe: [...MEGA, ...ETF.slice(0, 2), "AMD", "PLTR", "COIN"] } },
  { name: "Егор М.", role: "trader", stages: [["2025-09-01", "trainee"], ["2026-03-02", "junior"]], mentor: MENTOR, curator: MENTOR, riskManager: RISK,
    persona: { tpd: 5.5, riskMul: 1.0, payoff: 0.9, noise: 0.06, edge: lin("2025-09-01", 0.04, "2026-10-16", 0.3), shortBias: 0.45, blowups: 1, slumps: 1, account: "DEMO1019",
      setups: [["Mean Reversion — Oversold Bounce", 2], ["Rubber Band Snap — Extended Stock Reversal", 2], ["VWAP Reclaim — Mean Reversion Long", 1.5], ["Gap Fill — Statistical Edge", 2], ["Exhaustion Gap — Reversal Signal", 1]],
      universe: [...MEGA, ...ETF, "AMD", "UBER", "DIS", "BA", "JPM"] } },
];
const DEMO_NAMES = USERS.map((u) => u.name);
const TRADERS = USERS.filter((u) => u.persona);
const stageAt = (u: DemoUser, d: string): StageKey | null => {
  let s: StageKey | null = null;
  for (const [since, st] of u.stages ?? []) if (since <= d) s = st;
  return s;
};
const firstDay = (u: DemoUser) => [...(u.stages ?? [])].sort()[0]?.[0] ?? START;
const STAGE_RU: Record<StageKey, string> = { trainee: "Стажёр", junior: "Джун", trader: "Трейдер", senior: "Сеньор" };
const TIER: Record<StageKey, { account: number; daily: number; weekly: number; dd: number; risk: number; pos: number; ovn: number; open: number; allowOvn: boolean; allowSwing: boolean }> = {
  trainee: { account: 10000, daily: 150, weekly: 400, dd: 800, risk: 50, pos: 10000, ovn: 0, open: 2, allowOvn: false, allowSwing: false },
  junior: { account: 25000, daily: 300, weekly: 900, dd: 2000, risk: 100, pos: 25000, ovn: 5000, open: 3, allowOvn: false, allowSwing: false },
  trader: { account: 50000, daily: 600, weekly: 1800, dd: 4000, risk: 200, pos: 50000, ovn: 20000, open: 5, allowOvn: true, allowSwing: false },
  senior: { account: 100000, daily: 1200, weekly: 3600, dd: 8000, risk: 400, pos: 100000, ovn: 50000, open: 8, allowOvn: true, allowSwing: true },
};
const RISK_UNIT: Record<StageKey, number> = { trainee: 22, junior: 50, trader: 110, senior: 230 };

// ─── trade generation (on real bars) ────────────────────────────────────────

type Fill = { kind: "entry" | "add" | "trim" | "exit"; side: "B" | "S" | "T" | "C"; price: number; qty: number; date: string; sec: number; orderId: string; fees: Record<string, number>; ref?: string };
type GenTrade = {
  trader: string; account: string; ticker: string; underlying: string; date: string; exitDate: string | null; strat: Strat;
  side: "Long" | "Short"; isOpt: boolean; fills: Fill[]; stop: number | null; riskUsd: number | null; qty: number; plannedRisk: number;
  entry: number; exit: number; gross: number; fees: number; net: number; result: string; session: string; horizon: string;
  holdTime: string; setup: string; tags: string | null; notes: string | null; byTheBook: boolean; exitReason: string;
  conviction: number | null; grade: string | null; whatWorked: string | null; whatFailed: string | null; conclusion: string | null;
  externalId: string; feesByType: Record<string, number>; openedAt: string; closedAt: string; stage: StageKey; atr: number;
};

const STOP_RANGE: Record<Strat, [number, number]> = { OPG: [0.07, 0.3], OPGtoDAY: [0.1, 0.42], Day: [0.06, 0.3], MOC: [0.05, 0.24], Overnight: [0.35, 0.95], Swing: [0.6, 1.7], AfterMarket: [0.08, 0.38], Premarket: [0.08, 0.38], OPT: [0.12, 0.4] };
const TAGS_POOL = ["по плану", "A+ сетап", "earnings", "imbalance", "гэп", "новости", "FOMO", "ранний вход", "поздний выход", "добор", "частичный фикс", "сектор", "SPY слабый", "тренд", "реванш"];
const NOTE_POOL = [
  "Вход по плану, фикс частями.", "Поторопился со входом, стоп сработал.", "Хороший объём на открытии, держал до цели.",
  "Имбаланс перевернулся в последние минуты.", "Новости в премаркете, гэп удержался.", "Вышел раньше времени — оставил деньги на столе.",
  "Сетап из плейбука, всё по чеклисту.", "Рынок слабый, лонг против SPY был ошибкой.", "Перезашёл после ложного пробоя — сработало.",
  "Большой размер, нервничал и закрыл в безубыток.", "Отчёт лучше ожиданий, держал овернайт.", "Не дождался подтверждения на VWAP.",
];
const WORKED = ["Терпение на входе", "Чёткий стоп за уровнем", "Фикс частями по плану", "Размер по риску", "Ждал подтверждения объёмом"];
const FAILED = ["Вход без подтверждения", "Передвинул стоп", "Слишком большой размер", "Торговал против рынка", "Не зафиксировал на цели"];
const CONCL = ["Повторять этот сетап только с объёмом.", "Стоп — до входа, не после.", "На открытии ждать первые 5 минут.", "Резать убыток сразу, без надежды.", "Держать раннера до VWAP."];

function feesFor(fill: { side: string; price: number; qty: number }, isOpt: boolean, auction: boolean, rng: Rng): Record<string, number> {
  const q = fill.qty;
  const sell = fill.side === "S" || fill.side === "T";
  if (isOpt) {
    return { comm: r4(q * 0.5), ecn: r4(q * (rng.chance(0.6) ? 0.3 : -0.15)), orf: r4(q * 0.02295), clr: r4(q * 0.05), sec: sell ? r4(fill.price * q * 100 * 0.0000278) : 0, taf: sell ? r4(Math.min(q * 0.00279, 8.3)) : 0, cat: r4(q * 0.0035) };
  }
  const ecnRate = auction ? 0.001 : rng.chance(0.62) ? 0.003 : -0.002;
  return {
    comm: r4(q * 0.0025), ecn: r4(q * ecnRate), sec: sell ? r4(fill.price * q * 0.0000278) : 0, taf: sell ? r4(Math.min(q * 0.000166, 8.3)) : 0,
    cat: r4(q * 0.000035), clr: r4(q * 0.0002), nscc: r4(q * 0.0001),
  };
}
function occSymbol(under: string, expiry: string, cp: "C" | "P", strike: number): string {
  return `${under}${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}${cp}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}

type DayCtx = { date: string; di: number; busy: Map<string, [number, number][]> };
function overlaps(list: [number, number][] | undefined, a: number, b: number): boolean { return !!list?.some(([x, y]) => a <= y + 1 && b >= x - 1); }
function markBusy(ctx: DayCtx, tk: string, a: number, b: number) { const l = ctx.busy.get(tk); if (l) l.push([a, b]); else ctx.busy.set(tk, [[a, b]]); }

/** Entry/exit wall times for a strategy. xOff = sessions until the exit (0 = same session). */
function timesFor(strat: Strat, date: string, rng: Rng, holdMul = 1): { e: number; x: number; xOff: number } | null {
  const close = closeOf(date);
  const early = EARLY_CLOSE.has(date);
  const lognorm = (medianSec: number, sigma: number) => medianSec * Math.exp(rng.normal() * sigma);
  switch (strat) {
    case "OPG": return { e: OPEN, x: OPEN + clamp(Math.round(lognorm(170 * holdMul, 0.9)), 8, 15 * 60), xOff: 0 };
    case "OPGtoDAY": return { e: OPEN, x: Math.min(close - 300, OPEN + Math.round(clamp(lognorm(75 * 60 * holdMul, 0.7), 20 * 60, 6 * 3600))), xOff: 0 };
    case "MOC": {
      const e = rng.chance(0.65) ? close - rng.int(30, 600) : close - rng.int(600, early ? 2400 : 3600);
      return { e, x: close, xOff: 0 };
    }
    case "Day":
    case "OPT": {
      const r = rng.next();
      const e = r < 0.68 ? OPEN + rng.int(60, 2 * 3600) : r < 0.88 ? OPEN + rng.int(2 * 3600, 5 * 3600) : OPEN + rng.int(5 * 3600, Math.max(5 * 3600 + 60, close - OPEN - 15 * 60));
      if (e >= close - 240) return null;
      const x = Math.min(close - rng.int(30, 200), e + Math.round(clamp(lognorm(9 * 60 * holdMul, 1.0), 20, 3 * 3600)));
      return x > e + 5 ? { e, x, xOff: 0 } : null;
    }
    case "Overnight": {
      if (early) return null;
      const e = rng.chance(0.3) ? close : close - rng.int(60, 40 * 60);
      return { e, x: rng.chance(0.5) ? OPEN : OPEN + rng.int(40, 2 * 3600), xOff: 1 };
    }
    case "Swing": return early ? null : { e: OPEN + rng.int(30 * 60, 6 * 3600), x: OPEN + rng.int(10 * 60, 6 * 3600), xOff: rng.int(2, 4) };
    case "AfterMarket": {
      if (early) return null;
      const e = 16 * 3600 + (rng.chance(0.7) ? rng.int(4 * 60, 35 * 60) : rng.int(35 * 60, 2.5 * 3600));
      return { e, x: Math.min(20 * 3600 - rng.int(60, 600), e + Math.round(clamp(lognorm(12 * 60, 0.9), 40, 2 * 3600))), xOff: 0 };
    }
    case "Premarket": {
      const e = rng.int(7 * 3600, 9 * 3600 + 24 * 60);
      const x = rng.chance(0.6) ? Math.min(OPEN - rng.int(5, 90), e + Math.round(clamp(lognorm(10 * 60, 0.8), 30, 2 * 3600))) : OPEN + rng.int(30, 45 * 60);
      return x > e + 5 ? { e, x, xOff: 0 } : null;
    }
  }
}

/** Side from the setup's bias and the real tape (gap, the day's move so far, multi-day trend); null = setup not present. */
function sideFor(def: SetupDef, m: DayMkt, P0: number, strat: Strat, rng: Rng, shortBias: number): "Long" | "Short" | null {
  const gap = m.prev ? (m.o - m.prev) / m.prev : 0;
  if (def.gap === "up" && gap < 0.004) return null;
  if (def.gap === "down" && gap > -0.004) return null;
  const ref = strat === "Premarket" ? (m.prev ?? m.o) : strat === "AfterMarket" ? m.c : strat === "Swing" ? (m.close10 ?? m.o) : m.o;
  const move = (P0 - ref) / ref;
  switch (def.bias) {
    case "long": return "Long";
    case "short": return "Short";
    case "gapWith": if (Math.abs(gap) < 0.003 && strat !== "Premarket") return null; return (strat === "Premarket" ? move : gap) >= 0 ? "Long" : "Short";
    case "gapFade": if (Math.abs(gap) < 0.004) return null; return gap >= 0 ? "Short" : "Long";
    case "trend": if (Math.abs(move) < 0.001) return rng.chance(shortBias) ? "Short" : "Long"; return move >= 0 ? "Long" : "Short";
    case "fade": if (Math.abs(move) < 0.002) return null; return move >= 0 ? "Short" : "Long";
    case "free": return rng.chance(shortBias) ? "Short" : "Long";
  }
}

/** Structural reference (low for longs / high for shorts) known at entry time. */
function structureLevel(tk: string, date: string, strat: Strat, e: number, dir: number): number | null {
  const m = mkt(tk, date)!;
  const pick = (from: number, to: number) => {
    const series = m.m1 && m.m1.some((b) => b.s >= from && b.s < to) ? m.m1 : m.m5 && m.m5.some((b) => b.s >= from && b.s < to) ? m.m5 : m.h1;
    const bs = series.filter((b) => b.s >= from && b.s + b.dur <= to + 1);
    if (!bs.length) return null;
    return dir > 0 ? Math.min(...bs.map((b) => b.l)) : Math.max(...bs.map((b) => b.h));
  };
  switch (strat) {
    case "OPG": case "OPGtoDAY": return pick(4 * 3600, OPEN); // premarket range
    case "Overnight": return pick(OPEN, e) ?? (dir > 0 ? m.l : m.h);
    case "Swing": { const i = DAY_IDX.get(date)!; const pd = i > 0 ? mkt(tk, DAYS[i - 1]) : null; return pd ? (dir > 0 ? pd.l : pd.h) : null; }
    case "MOC": return pick(e - 3600, e);
    case "Premarket": return pick(Math.max(4 * 3600, e - 3600), e);
    case "AfterMarket": return pick(Math.max(OPEN, e - 3600), e);
    default: return pick(Math.max(e < OPEN + 900 ? OPEN : 4 * 3600, e - 15 * 60), e);
  }
}

let extSeq = 0;
type BuildOpts = { sizeMul?: number; noStop?: boolean; tryE?: number };
function buildTrade(u: DemoUser, rng: Rng, ctx: DayCtx, strat: Strat, setup: string, tk: string, times: { e: number; x: number; xOff: number },
  side: "Long" | "Short", riskUsd: number, stage: StageKey, opts: BuildOpts = {}): GenTrade | null {
  const p = u.persona!;
  const date = ctx.date;
  const m = mkt(tk, date);
  if (!m) return null;
  const exitDate = times.xOff > 0 ? nextSession(date, times.xOff) : date;
  if (!exitDate) return null;
  for (let k = 1; k <= times.xOff; k++) if (!tradeable(tk, nextSession(date, k)!)) return null;
  const mx = mkt(tk, exitDate)!;
  const close = closeOf(date);
  const tier = TIER[stage];
  const isOpt = strat === "OPT";
  const auctionEntry = strat === "OPG" || strat === "OPGtoDAY" || (strat === "Overnight" && times.e === close);
  const auctionExit = strat === "MOC";
  const exitAtOpen = times.xOff > 0 && times.x === OPEN;
  // entry price: auction prints are the real official open / close, otherwise the real bar at that second
  let P0: number;
  if (strat === "OPG" || strat === "OPGtoDAY") P0 = r2(m.o);
  else if (auctionEntry) P0 = r2(m.c);
  else { const pa = priceAt(tk, date, times.e); if (!pa) return null; P0 = pa.px; }
  if (!(P0 > 0.5)) return null;
  const dir = side === "Long" ? 1 : -1;
  const atr = Math.max(m.atr, P0 * 0.004);
  // stop from real structure, clamped to a sane ATR band for the strategy
  const [lo, hi] = STOP_RANGE[strat].map((f) => f * (p.stopMul ?? 1) * atr);
  const struct = isOpt ? null : structureLevel(tk, date, strat, times.e, dir);
  let d = struct != null ? dir * (P0 - struct) + Math.max(2 * tickSz(P0), 0.02 * atr) : NaN;
  if (!(d > 0)) d = rng.u(lo, (lo + hi) / 2);
  d = clamp(d, lo, hi);
  d = Math.max(tick(d), P0 >= 1 ? 0.02 : 0.002);
  const stopPrice = tick(P0 - dir * d);

  // options: synthetic premium on the real underlying path (delta ≈ 0.5, theta decay)
  let ticker = tk, mult = 1, optPrem0 = 0, optDelta = 0.5;
  const cp: "C" | "P" = side === "Long" ? "C" : "P";
  if (isOpt) {
    const step = P0 >= 200 ? 5 : P0 >= 50 ? 2.5 : 1;
    const strike = Math.round((P0 * (1 + (cp === "C" ? 1 : -1) * rng.u(-0.004, 0.012))) / step) * step;
    let expiry = date; while (dow(expiry) !== 5) expiry = addDays(expiry, 1);
    if (rng.chance(0.3)) expiry = addDays(expiry, 7);
    const dte = Math.max(0.3, dayDiff(date, expiry) + 0.3);
    optPrem0 = Math.round(clamp(atr * Math.sqrt(dte) * 0.42 + Math.max(0, (P0 - strike) * (cp === "C" ? 1 : -1)), 0.3, 30) * 100) / 100;
    optDelta = clamp(0.5 + ((P0 - strike) * (cp === "C" ? 1 : -1)) / (atr * 3), 0.3, 0.7);
    ticker = occSymbol(tk, expiry, cp, strike);
    mult = 100;
  }
  const prem = (S: number, sec: number) => Math.max(0.01, Math.round((optPrem0 + optDelta * dir * (S - P0) - optPrem0 * 0.12 * ((sec - times.e) / 23400)) * 100) / 100);

  // size
  const lot = P0 > 150 ? 10 : P0 > 30 ? 25 : 50;
  let qty: number;
  if (isOpt) qty = Math.max(1, Math.round((riskUsd * (opts.sizeMul ?? 1)) / (optDelta * d * 100)));
  else {
    qty = Math.floor((riskUsd * (opts.sizeMul ?? 1)) / d / lot) * lot;
    const maxQ = Math.floor((tier.pos * (opts.sizeMul && opts.sizeMul > 1 ? 1.4 : 0.95)) / P0 / lot) * lot;
    if (qty > maxQ) qty = maxQ;
    if (qty < lot) qty = P0 < 80 ? lot : Math.max(5, Math.floor(riskUsd / d / 5) * 5);
    if (qty <= 0) return null;
  }
  const lotQ = isOpt ? 1 : qty >= 100 ? 25 : 5;
  const splitQ = (q: number, f: number) => Math.max(lotQ, Math.round((q * f) / lotQ) * lotQ);

  // management plan
  const roll = rng.next();
  const undisciplined = rng.chance(p.noise * 1.4);
  let structure: "simple" | "split" | "add" | "scaleout" | "add_scaleout" | "avgdown" =
    roll < 0.42 ? "simple" : roll < 0.56 ? "split" : roll < 0.7 ? "add" : roll < 0.92 ? "scaleout" : "add_scaleout";
  if (undisciplined && rng.chance(0.35) && strat !== "MOC") structure = "avgdown";
  const span = (times.xOff > 0 ? times.xOff * 86400 : 0) + times.x - times.e;
  if (span < 60 && structure !== "split") structure = "simple";
  if (qty < 2 * lotQ && structure !== "simple") structure = "simple";
  const tR = clamp(p.payoff * Math.exp(rng.normal() * 0.45 - 0.05), 0.6, 5);
  const effStop = opts.noStop ? P0 - dir * d * rng.u(2.6, 3.6) : undisciplined ? P0 - dir * d * rng.u(1.3, 1.8) : stopPrice;

  // walk the real price path
  const legs: Leg[] = [];
  const ext = strat === "Premarket" || strat === "AfterMarket";
  const lastSame = times.xOff > 0 ? close : auctionExit ? close : times.x;
  if (!(auctionEntry && times.xOff > 0 && times.e >= close)) legs.push({ date, from: times.e, to: lastSame, ext });
  for (let k = 1; k <= times.xOff; k++) {
    const dk = nextSession(date, k)!;
    legs.push({ date: dk, from: OPEN, to: k === times.xOff ? Math.max(OPEN + 1, times.x) : closeOf(dk), ext: false, openGap: true });
  }
  const path = buildPath(tk, legs);
  if (!path.length) return null;
  // the walk starts at the fill itself, so an overnight gap through the stop is a crossing (filled at the real open)
  if (path[0].k > keyOf0(date, times.e)) path.unshift({ k: keyOf0(date, times.e), p: P0, b: path[0].b, d: date, gap: false });
  if (path.length < 2) return null;
  const cur = new Cursor(path);
  const keyOf = (dd: string, s: number) => DAY_IDX.get(dd)! * 86400 + s;
  const secOf = (h: Hit) => Math.floor(h.k - DAY_IDX.get(h.d)! * 86400);
  const fills: Fill[] = [];
  const oid = () => `D${(++extSeq).toString(36).toUpperCase()}`;
  const entrySide = isOpt ? "B" : side === "Long" ? "B" : "T";
  const exitSide = isOpt ? "S" : side === "Long" ? "S" : "C";
  const px = (S: number, sec: number) => (isOpt ? prem(S, sec) : S);
  const e0q = structure === "add" || structure === "add_scaleout" || structure === "avgdown" ? splitQ(qty, rng.u(0.5, 0.7)) : qty;
  if (structure === "split" && e0q >= 2 * lotQ) {
    const o = oid();
    const a = splitQ(e0q, rng.u(0.3, 0.6));
    fills.push({ kind: "entry", side: entrySide, price: px(P0, times.e), qty: a, date, sec: times.e, orderId: o, fees: {} });
    const p2 = auctionEntry || isOpt ? P0 : snap(P0 + dir * rng.pick([0, 0.01, 0.01, 0.02]), priceAt(tk, date, times.e)!.b);
    fills.push({ kind: "add", side: entrySide, price: px(p2, times.e), qty: e0q - a, date, sec: times.e, orderId: o, fees: {} });
  } else fills.push({ kind: "entry", side: entrySide, price: px(P0, times.e), qty: e0q, date, sec: times.e, orderId: oid(), fees: {} });
  let addLeft = qty - e0q;
  let held = e0q;
  const levels: Level[] = [];
  const setLv = (name: string, price: number, up: boolean) => { const i = levels.findIndex((l) => l.name === name); if (i >= 0) levels.splice(i, 1); levels.push({ name, px: price, up }); };
  setLv("stop", effStop, dir < 0);
  setLv("target", P0 + dir * tR * d, dir > 0);
  if (structure === "scaleout" || structure === "add_scaleout") { setLv("trim1", P0 + dir * rng.u(0.8, 1.2) * d, dir > 0); if (qty >= 4 * lotQ && rng.chance(0.35)) setLv("trim2", P0 + dir * rng.u(1.5, 2) * d, dir > 0); }
  if (addLeft > 0) setLv("add", structure === "avgdown" ? P0 - dir * rng.u(0.4, 0.7) * d : P0 + dir * rng.u(0.3, 0.6) * d, structure === "avgdown" ? dir < 0 : dir > 0);
  let lastSec = { d: date, s: times.e };
  const after = (dd: string, s: number) => { if (dd === lastSec.d && s <= lastSec.s) s = lastSec.s + 1; lastSec = { d: dd, s }; return s; };
  let exitReason = "time";
  let done = false;
  while (!done) {
    const h = cur.next(levels);
    if (!h) break;
    const s = after(h.d, secOf(h));
    const fb = barAt(mkt(tk, h.d)!, s) ?? h.b;
    const fillAt = (price: number) => (isOpt ? prem(price, s) : snap(price, fb));
    if (h.name === "stop") {
      const slip = isOpt || opts.noStop ? 0 : rng.pick([0, 0, 1, 1, 2]) * tickSz(h.px);
      fills.push({ kind: "exit", side: exitSide, price: fillAt(h.px - dir * slip), qty: held, date: h.d, sec: s, orderId: oid(), fees: {} });
      held = 0; exitReason = opts.noStop ? "late" : undisciplined ? "late" : "stop"; done = true;
    } else if (h.name === "target") {
      fills.push({ kind: "exit", side: exitSide, price: fillAt(h.px), qty: held, date: h.d, sec: s, orderId: oid(), fees: {} });
      held = 0; exitReason = "target"; done = true;
    } else if (h.name.startsWith("trim")) {
      levels.splice(levels.findIndex((l) => l.name === h.name), 1);
      const q = Math.min(held - lotQ, splitQ(qty, rng.u(0.25, 0.45)));
      if (q >= lotQ) {
          fills.push({ kind: "trim", side: exitSide, price: fillAt(h.px), qty: q, date: h.d, sec: s, orderId: oid(), fees: {} });
        held -= q;
        if (!undisciplined && rng.chance(0.55)) setLv("stop", P0 + dir * tickSz(P0), dir < 0); // stop to break-even
      }
    } else if (h.name === "add") {
      levels.splice(levels.findIndex((l) => l.name === "add"), 1);
      fills.push({ kind: "add", side: entrySide, price: fillAt(h.px), qty: addLeft, date: h.d, sec: s, orderId: oid(), fees: {} });
      held += addLeft; addLeft = 0;
    }
  }
  if (held > 0) {
    // time exit: closing auction = official close, next-day open = official open, else the real bar at that second
    let xp: number, xs: number;
    const xd = exitDate;
    if (auctionExit) { xp = r2(mx.c); xs = closeOf(xd); }
    else if (exitAtOpen) { xp = r2(mx.o); xs = OPEN; }
    else {
      xs = times.xOff > 0 ? times.x : times.x;
      const pa = priceAt(tk, xd, xs);
      if (!pa) return null;
      xp = pa.px;
    }
    if (xd === lastSec.d && xs <= lastSec.s) {
      if (auctionExit || exitAtOpen) return null;
      xs = lastSec.s + 1;
      const pa = priceAt(tk, xd, xs); if (!pa) return null; xp = pa.px;
    }
    fills.push({ kind: "exit", side: exitSide, price: isOpt ? prem(xp, xs + (times.xOff ? 23400 * times.xOff : 0)) : xp, qty: held, date: xd, sec: xs, orderId: oid(), fees: {} });
    held = 0;
  }
  const entries = fills.filter((f) => f.kind === "entry" || f.kind === "add");
  const exits = fills.filter((f) => f.kind === "trim" || f.kind === "exit");
  const totalQ = entries.reduce((a, f) => a + f.qty, 0);
  // a trade with one leg left partly closed by trims needs the final exit to carry the rest
  const exitQ = exits.reduce((a, f) => a + f.qty, 0);
  if (exitQ !== totalQ) exits[exits.length - 1].qty += totalQ - exitQ;
  for (let i = 0; i < exits.length - 1; i++) if (exits[i].kind === "exit") exits[i].kind = "trim";
  exits[exits.length - 1].kind = "exit";
  if ([...entries, ...exits].some((f) => !Number.isFinite(f.price))) return null;
  const all = [...entries, ...exits].sort((a, b) => keyOf(a.date, a.sec) - keyOf(b.date, b.sec) || (a.kind === "entry" ? -1 : 0));
  const feesByType: Record<string, number> = {};
  let feeTot = 0;
  for (const f of all) {
    const auction = (auctionEntry && f.kind === "entry" && f.date === date && f.sec === times.e) || ((auctionExit || exitAtOpen) && f.kind === "exit" && f.sec === (auctionExit ? closeOf(f.date) : OPEN));
    f.fees = feesFor(f, isOpt, auction, rng);
    for (const [k, v] of Object.entries(f.fees)) { feesByType[k] = r4((feesByType[k] ?? 0) + v); feeTot += v; }
  }
  feeTot = r4(feeTot);
  const d2 = isOpt ? 1 : dir;
  const entryNotional = entries.reduce((s, f) => s + f.price * f.qty, 0);
  const exitNotional = exits.reduce((s, f) => s + f.price * f.qty, 0);
  const gross = r4(d2 * (exitNotional - entryNotional) * mult);
  const net = r4(gross - feeTot);
  const result = Math.abs(net) < 0.005 ? "breakeven" : net > 0 ? "win" : "loss";
  const first = all[0], last = all[all.length - 1];
  const holdSec = dayDiff(first.date, last.date) * 86400 + last.sec - first.sec;
  const session = first.sec < OPEN ? "premarket" : first.sec >= 16 * 3600 ? "postmarket" : "regular";
  const horizon = last.date === date ? "intraday" : last.date === nextSession(date) ? "overnight" : "swing";
  const openedAt = `${date}T${hms(first.sec)}`;
  const externalId = `DEMO|${p.account}|${ticker}|${openedAt}|${isOpt ? "Long" : side}|${(++extSeq).toString(36)}`;
  const hasStop = !isOpt && rng.chance(stage === "senior" ? 0.5 : stage === "trader" ? 0.55 : 0.7);
  const plannedRisk = isOpt ? optDelta * d * totalQ * 100 : d * totalQ;
  const lose = net < 0;
  const byTheBook = !undisciplined && !opts.noStop && structure !== "avgdown" && (exitReason === "target" || exitReason === "time" || exitReason === "stop");
  return {
    trader: u.name, account: p.account, ticker, underlying: tk, date, exitDate: horizon === "intraday" ? null : last.date, strat, side: isOpt ? "Long" : side, isOpt,
    fills: all, stop: hasStop ? stopPrice : null, riskUsd: hasStop ? r2(d * totalQ) : null, qty: totalQ, plannedRisk,
    entry: r4(entryNotional / totalQ), exit: r4(exitNotional / totalQ), gross, fees: feeTot, net, result, session, horizon, holdTime: holdHuman(holdSec),
    setup, byTheBook, exitReason,
    tags: rng.chance(0.12) ? [...new Set([rng.pick(TAGS_POOL), ...(rng.chance(0.4) ? [rng.pick(TAGS_POOL)] : [])])].join(",") : null,
    notes: rng.chance(0.05) ? rng.pick(NOTE_POOL) : null,
    conviction: rng.chance(0.18) ? rng.int(2, 5) : null,
    grade: rng.chance(0.15) ? rng.pick(["A+", "A", "B", "B", "C"]) : null,
    whatWorked: rng.chance(0.02) && !lose ? rng.pick(WORKED) : null,
    whatFailed: rng.chance(0.025) && lose ? rng.pick(FAILED) : null,
    conclusion: rng.chance(0.02) ? rng.pick(CONCL) : null,
    externalId, feesByType, openedAt, closedAt: `${last.date}T${hms(last.sec)}`, stage, atr: r4(m.atr),
  };
}

type DayStat = { trader: string; date: string; n: number; net: number; gross: number; fees: number; wins: number; losses: number; best: GenTrade | null; worst: GenTrade | null; blowup: boolean; strats: Set<Strat>; tickers: Set<string>; trades: GenTrade[] };

/** Desk activity follows the real tape: SPY's daily range vs its 20-day average. */
function activityOf(d: string): number {
  const i = DAY_IDX.get(d)!;
  const rng = (x: string) => { const m = T.SPY.days.get(x)!; return (m.h - m.l) / m.o; };
  const back = DAYS.slice(Math.max(0, i - 20), i);
  const avg = back.length ? back.reduce((a, x) => a + rng(x), 0) / back.length : rng(d);
  return clamp(Math.sqrt(rng(d) / avg), 0.7, 1.6);
}

function generateTrades(): { trades: GenTrade[]; days: DayStat[] } {
  const trades: GenTrade[] = [];
  const days: DayStat[] = [];
  for (const u of TRADERS) {
    const p = u.persona!;
    const rng = new Rng(`trader:${u.name}`);
    const myDays = DAYS.filter((d) => d >= firstDay(u));
    const off = new Set<string>();
    for (const yr of ["2025", "2026"]) {
      const yd = myDays.filter((d) => d.startsWith(yr));
      for (let v = 0; v < 2 && yd.length > 30; v++) { const s = rng.int(10, yd.length - 8); for (let k = 0; k < 5; k++) off.add(yd[s + k]); }
    }
    for (const d of myDays) if (rng.chance(0.03)) off.add(d);
    const slump = new Set<string>();
    for (let s = 0; s < p.slumps && myDays.length > 40; s++) { const st = rng.int(15, myDays.length - 20); const len = rng.int(8, 15); for (let k = 0; k < len; k++) slump.add(myDays[st + k]); }
    const blow = new Set<string>();
    for (let b = 0; b < p.blowups && myDays.length > 20; b++) blow.add(myDays[rng.int(10, myDays.length - 2)]);
    let form = 0;
    const carry = new Map<string, number>();
    let carryDate = "";
    for (const date of myDays) {
      const di = DAY_IDX.get(date)!;
      const stage = stageAt(u, date)!;
      form = form * 0.85 + rng.normal() * p.noise * 0.8;
      if (off.has(date)) continue;
      const ctx: DayCtx = { date, di, busy: new Map() };
      if (carryDate === date) for (const [tk, s] of carry) markBusy(ctx, tk, 0, s);
      carry.clear();
      const isBlow = blow.has(date);
      const edge = p.edge(date) + form + (slump.has(date) ? -0.35 : 0) + (REGIME.get(date) ?? 0);
      const risk = RISK_UNIT[stage] * p.riskMul;
      const tier = TIER[stage];
      let n = Math.max(1, rng.poisson(p.tpd * activityOf(date)));
      if (isBlow) n += rng.int(3, 6);
      // tickers in play today: the persona's universe, biggest real gaps / relative volume first
      const live = p.universe.filter((t) => tradeable(t, date));
      const score = (t: string) => { const m = mkt(t, date)!; const g = m.prev ? Math.abs(m.o / m.prev - 1) : 0; return g * 100 + rng.u(0, 1.2); };
      const inPlay = [...live].sort((a, b) => score(b) - score(a));
      const stat: DayStat = { trader: u.name, date, n: 0, net: 0, gross: 0, fees: 0, wins: 0, losses: 0, best: null, worst: null, blowup: isBlow, strats: new Set(), tickers: new Set(), trades: [] };
      const allowedSetups: Record<string, number> = {};
      for (const [name, w] of p.setups) {
        const st = SETUP[name].strat;
        if ((st === "Overnight") && !tier.allowOvn && u.name !== "Денис Ф.") continue;
        if (st === "Swing" && !tier.allowSwing) continue;
        if (stage === "trainee" && (st === "OPT" || st === "AfterMarket" || st === "Overnight")) continue;
        allowedSetups[name] = w;
      }
      if (!Object.keys(allowedSetups).length) continue;
      let dayNet = 0;
      let blowDone = false;
      const pending: { setup?: string; reentryOf?: GenTrade; flip?: boolean }[] = [];
      for (let i = 0; i < n; i++) pending.push({});
      let guard = 0;
      while (pending.length && guard++ < 90) {
        const job = pending.shift()!;
        if (!isBlow && dayNet <= -tier.daily * rng.u(0.85, 1.05)) break;
        const blowTrade = isBlow && !blowDone && rng.chance(0.5);
        const sizeMul = isBlow && blowDone ? rng.u(1.3, 1.8) : blowTrade ? rng.u(1.2, 1.6) : 1;
        // selection edge: a good trader passes on more of the losing candidates (look at up to 3 setups, take the first acceptable)
        const tries = blowTrade ? 3 : 1 + (rng.chance(Math.abs(edge)) ? 1 : 0) + (rng.chance(Math.abs(edge) * 0.6) ? 1 : 0);
        let chosen: GenTrade | null = null;
        let worst: GenTrade | null = null;
        for (let a = 0; a < tries + 2 && (a < tries || !chosen); a++) {
          let t: GenTrade | null = null;
          if (job.reentryOf) {
            const prev = job.reentryOf;
            const prevEnd = prev.fills[prev.fills.length - 1].sec;
            const e = job.flip ? prevEnd + 1 : prevEnd + rng.int(20, 25 * 60);
            const x = Math.min(closeOf(date) - rng.int(30, 300), e + Math.round(clamp(9 * 60 * (p.holdMul ?? 1) * Math.exp(rng.normal()), 20, 2 * 3600)));
            if (x <= e + 5 || e < OPEN + 20) break;
            const side = job.flip ? (prev.side === "Long" ? "Short" : "Long") : prev.side;
            const st0 = SETUP[prev.setup].strat;
            const reSetup = st0 === "Day" || st0 === "OPGtoDAY" ? prev.setup : Object.keys(allowedSetups).find((x) => SETUP[x].strat === "Day");
            if (!reSetup) break;
            const l = ctx.busy.get(prev.underlying)?.filter(([s0, s1]) => !(s0 === prev.fills[0].sec && s1 === prevEnd));
            if (overlaps(l, e, x)) break;
            t = buildTrade(u, rng, ctx, "Day", reSetup, prev.underlying, { e, x, xOff: 0 }, side, risk, stage, { sizeMul });
          } else {
            const setup = job.setup ?? rng.weighted(allowedSetups);
            const def = SETUP[setup];
            const strat = def.strat;
            const times = timesFor(strat, date, rng, p.holdMul);
            if (!times) continue;
            const endSame = times.xOff > 0 ? 86400 : strat === "MOC" ? closeOf(date) : times.x;
            const pool = strat === "OPT" ? OPT_UNDER.filter((x) => tradeable(x, date)) : def.bias === "gapWith" || def.bias === "gapFade" || def.gap ? inPlay.slice(0, 6) : inPlay.slice(0, 10);
            const cands = rng.shuffle([...pool]).filter((x) => !overlaps(ctx.busy.get(x), times.e, endSame));
            for (const tk of cands) {
              const m = mkt(tk, date)!;
              const P0 = strat === "OPG" || strat === "OPGtoDAY" ? m.o : priceAt(tk, date, times.e)?.px;
              if (P0 == null) continue;
              const side = sideFor(def, m, P0, strat, rng, p.shortBias);
              if (!side) continue;
              t = buildTrade(u, rng, ctx, strat, setup, tk, times, side, risk, stage, { sizeMul, noStop: blowTrade });
              if (t) break;
            }
          }
          if (!t) continue;
          if (!worst || t.net < worst.net) worst = t;
          if (blowTrade) { chosen = worst; continue; }
          if (a < tries - 1 && ((edge > 0 && t.net < 0) || (edge < 0 && t.net > 0))) continue;
          chosen = t;
          break;
        }
        const t = blowTrade ? worst : chosen;
        if (!t) continue;
        if (blowTrade) blowDone = true;
        const endSame = t.horizon === "intraday" ? t.fills[t.fills.length - 1].sec : 86400;
        markBusy(ctx, t.underlying, t.fills[0].sec, endSame);
        if (t.horizon !== "intraday") { carry.set(t.underlying, t.fills[t.fills.length - 1].sec); carryDate = nextSession(date) ?? ""; }
        trades.push(t);
        dayNet += t.net;
        stat.n++; stat.net += t.net; stat.gross += t.gross; stat.fees += t.fees; stat.trades.push(t);
        if (t.result === "win") stat.wins++; else if (t.result === "loss") stat.losses++;
        if (!stat.best || t.net > stat.best.net) stat.best = t;
        if (!stat.worst || t.net < stat.worst.net) stat.worst = t;
        stat.strats.add(t.strat); stat.tickers.add(t.underlying);
        if (t.horizon === "intraday" && !t.isOpt && t.strat !== "MOC" && t.session === "regular" && t.fills[t.fills.length - 1].sec < closeOf(date) - 1800) {
          const r = rng.next();
          if (r < 0.03) pending.unshift({ reentryOf: t, flip: true });
          else if (r < (t.result === "loss" ? 0.3 : 0.16)) pending.unshift({ reentryOf: t });
        }
      }
      if (stat.n) days.push(stat);
    }
  }
  return { trades, days };
}

// ─── verification + stats ───────────────────────────────────────────────────

type FillCheck = { kind: "open" | "close" | "bar"; ok: boolean; ref: string };
/** How a stock fill relates to the real market: auction prints vs the official open/close, everything else vs the finest bar covering it. */
function checkFill(t: GenTrade, f: Fill): FillCheck {
  const m = mkt(t.underlying, f.date)!;
  const ts = tickSz(f.price);
  const onTick = Math.abs(f.price / ts - Math.round(f.price / ts)) < 1e-6;
  if (f.sec === closeOf(f.date) && (f.kind === "exit" || f.kind === "entry" || f.kind === "add") && Math.abs(f.price - r2(m.c)) < 1e-9)
    return { kind: "close", ok: onTick, ref: `official close ${r2(m.c)}` };
  if (f.sec === OPEN && Math.abs(f.price - r2(m.o)) < 1e-9) return { kind: "open", ok: onTick, ref: `official open ${r2(m.o)}` };
  const b = barAt(m, f.sec);
  if (!b) return { kind: "bar", ok: false, ref: "no bar" };
  const iv = b.dur <= 60 ? "1m" : b.dur <= 300 ? "5m" : "60m";
  return { kind: "bar", ok: onTick && f.price >= b.l - 1e-5 && f.price <= b.h + 1e-5, ref: `${iv} bar ${hms(b.s)} O ${r4(b.o)} H ${r4(b.h)} L ${r4(b.l)} C ${r4(b.c)}` };
}
function verifyFills(trades: GenTrade[]): void {
  let n = 0, bad = 0;
  const kinds: Record<string, number> = {};
  const samples: string[] = [];
  for (const t of trades) {
    if (t.isOpt) continue;
    for (const f of t.fills) {
      n++;
      const ck = checkFill(t, f);
      kinds[ck.kind] = (kinds[ck.kind] ?? 0) + 1;
      if (!ck.ok) { bad++; if (samples.length < 8) samples.push(`${t.externalId} ${f.kind} ${f.date} ${hms(f.sec)} @${f.price} — ${ck.ref}`); }
    }
  }
  console.log(`[seed-demo] fill check: ${n} stock fills — at official open ${kinds.open ?? 0}, at official close ${kinds.close ?? 0}, inside the real bar ${kinds.bar ?? 0}; violations ${bad}`);
  for (const x of samples) console.log("   ✗ " + x);
  if (bad) throw new Error(`${bad} fills outside the real market`);
}
/** A few concrete trade → bar comparisons for the report (after insert, with DB ids). */
function printSpotChecks(trades: GenTrade[]): void {
  const rng = new Rng("spot");
  const want: [string, (t: GenTrade) => boolean][] = [
    ["OPG", (t) => t.strat === "OPG"], ["MOC", (t) => t.strat === "MOC" && t.fills[t.fills.length - 1].sec === closeOf(t.date)], ["Day 1m", (t) => t.strat === "Day" && !!mkt(t.underlying, t.date)!.m1],
    ["Day 5m", (t) => t.strat === "Day" && !mkt(t.underlying, t.date)!.m1 && !!mkt(t.underlying, t.date)!.m5], ["Day 60m", (t) => t.strat === "Day" && !mkt(t.underlying, t.date)!.m5],
    ["Overnight", (t) => t.strat === "Overnight"], ["Premarket", (t) => t.strat === "Premarket"], ["AfterMarket", (t) => t.strat === "AfterMarket"], ["Swing", (t) => t.strat === "Swing"],
  ];
  console.log("\nSpot checks (fill vs real Yahoo bar):");
  for (const [label, pred] of want) {
    const c = trades.filter((t) => !t.isOpt && pred(t));
    if (!c.length) continue;
    const t = c[Math.floor(rng.next() * c.length)];
    console.log(`  [${label}] trade #${(t as any).id ?? "?"} ${t.trader} ${t.underlying} ${t.side} «${t.setup}» net ${r2(t.net)}`);
    for (const f of t.fills) console.log(`      ${f.kind.padEnd(5)} ${f.date} ${hms(f.sec)} ${String(f.qty).padStart(5)} @ ${f.price}  ↔  ${checkFill(t, f).ref}`);
  }
}
function printStats(trades: GenTrade[]): void {
  const by = new Map<string, { n25: number; n26: number; net25: number; net26: number; win: number; stage: string }>();
  const office = { net25: 0, net26: 0, gross25: 0, gross26: 0, fees25: 0, fees26: 0 };
  const monthly = new Map<string, number>();
  for (const t of trades) {
    const yr = (t.exitDate ?? t.date).slice(0, 4);
    const u = TRADERS.find((x) => x.name === t.trader)!;
    const b = by.get(t.trader) ?? { n25: 0, n26: 0, net25: 0, net26: 0, win: 0, stage: STAGE_RU[stageAt(u, END)!] };
    if (yr === "2025") { b.n25++; b.net25 += t.net; office.net25 += t.net; office.gross25 += t.gross; office.fees25 += t.fees; }
    else { b.n26++; b.net26 += t.net; office.net26 += t.net; office.gross26 += t.gross; office.fees26 += t.fees; }
    if (t.result === "win") b.win++;
    by.set(t.trader, b);
    const m = (t.exitDate ?? t.date).slice(0, 7);
    monthly.set(m, (monthly.get(m) ?? 0) + t.net);
  }
  console.log("\nTrades per trader (stage now · total · win% · 2025 count/net · 2026 count/net):");
  for (const [n, b] of by) console.log(`  ${n.padEnd(13)} ${b.stage.padEnd(8)} ${String(b.n25 + b.n26).padStart(5)}  ${(100 * b.win / (b.n25 + b.n26)).toFixed(0).padStart(3)}%   2025: ${String(b.n25).padStart(5)} / ${r2(b.net25).toFixed(0).padStart(8)}   2026: ${String(b.n26).padStart(5)} / ${r2(b.net26).toFixed(0).padStart(8)}`);
  console.log(`\nOffice net: 2025 = $${r2(office.net25).toFixed(0)} (gross ${r2(office.gross25).toFixed(0)}, fees ${r2(office.fees25).toFixed(0)}) · 2026 YTD = $${r2(office.net26).toFixed(0)} (gross ${r2(office.gross26).toFixed(0)}, fees ${r2(office.fees26).toFixed(0)})`);
  console.log("Monthly net: " + [...monthly.entries()].sort().map(([m, v]) => `${m}:${(v / 1000).toFixed(1)}k`).join(" "));
  const sc = new Map<string, { n: number; sh: number }>();
  let totN = 0, totSh = 0;
  for (const t of trades) { const s = sc.get(t.strat) ?? { n: 0, sh: 0 }; const sh = t.qty * (t.isOpt ? 100 : 1); s.n++; s.sh += sh; sc.set(t.strat, s); totN++; totSh += sh; }
  console.log("Strategy shares (trades % / share-volume %): " + [...sc.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${k} ${(100 * v.n / totN).toFixed(1)}%/${(100 * v.sh / totSh).toFixed(1)}%`).join(" · "));
  const su = new Map<string, { n: number; net: number }>();
  for (const t of trades) { const s = su.get(t.setup) ?? { n: 0, net: 0 }; s.n++; s.net += t.net; su.set(t.setup, s); }
  console.log("Setup shares (trades % · net $):");
  for (const [k, v] of [...su.entries()].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${(100 * v.n / totN).toFixed(1).padStart(5)}%  ${String(v.n).padStart(5)}  ${r2(v.net).toFixed(0).padStart(8)}  ${k}`);
  const structCount = { adds: 0, trims: 0, split: 0, stopCol: 0 };
  for (const t of trades) {
    if (t.fills.some((f) => f.kind === "add" && f.sec !== t.fills[0].sec)) structCount.adds++;
    if (t.fills.some((f) => f.kind === "trim")) structCount.trims++;
    if (t.fills.filter((f) => f.kind === "entry" || f.kind === "add").length > 1 && t.fills[1].sec === t.fills[0].sec) structCount.split++;
    if (t.stop != null) structCount.stopCol++;
  }
  const tks = new Map<string, number>();
  for (const t of trades) tks.set(t.underlying, (tks.get(t.underlying) ?? 0) + 1);
  console.log(`Structures: scale-ins ${structCount.adds}, partial exits ${structCount.trims}, split fills ${structCount.split}, trades with stop ${structCount.stopCol}`);
  console.log(`Tickers used (${tks.size}): ` + [...tks.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", "));
}

// ─── DB helpers ─────────────────────────────────────────────────────────────

type Q = pg.PoolClient;
async function insertMany(c: Q, table: string, cols: string[], rows: unknown[][], opts: { returning?: string; casts?: Record<string, string>; conflict?: string } = {}): Promise<any[]> {
  if (!rows.length) return [];
  const out: any[] = [];
  const per = Math.max(1, Math.floor(30000 / cols.length));
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const params: unknown[] = [];
    const values = chunk.map((r) => `(${r.map((v, j) => { params.push(v); const cast = opts.casts?.[cols[j]]; return `$${params.length}${cast ? `::${cast}` : ""}`; }).join(",")})`).join(",");
    const sql = `INSERT INTO ${table} (${cols.map((c2) => `"${c2}"`).join(",")}) VALUES ${values}${opts.conflict ? ` ${opts.conflict}` : ""}${opts.returning ? ` RETURNING ${opts.returning}` : ""}`;
    const res = await c.query(sql, params);
    if (opts.returning) out.push(...res.rows);
  }
  return out;
}
async function tableCols(c: Q): Promise<Map<string, Set<string>>> {
  const { rows } = await c.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`);
  const m = new Map<string, Set<string>>();
  for (const r of rows) { const s = m.get(r.table_name) ?? new Set<string>(); s.add(r.column_name); m.set(r.table_name, s); }
  return m;
}

// ─── unseed ─────────────────────────────────────────────────────────────────

async function unseed(c: Q): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const add = (k: string, n: number | null) => { if (n) counts[k] = (counts[k] ?? 0) + n; };
  const cols = await tableCols(c);
  const has = (t: string, col?: string) => cols.has(t) && (!col || cols.get(t)!.has(col));
  const { rows: nr } = await c.query(`SELECT name FROM users WHERE settings->>'demo' = 'true'`);
  const names = [...new Set([...nr.map((r) => r.name as string)])];
  const { rows: tr } = await c.query(`SELECT id FROM trades WHERE external_id LIKE 'DEMO|%' OR context_snapshot->>'demo' = 'true'${names.length ? ` OR trader = ANY($1::text[])` : ""}`, names.length ? [names] : []);
  const tradeIds = tr.map((r) => Number(r.id));
  const del = async (label: string, sql: string, params: unknown[]) => {
    await c.query("SAVEPOINT u");
    try { const r = await c.query(sql, params); add(label, r.rowCount); await c.query("RELEASE SAVEPOINT u"); return true; }
    catch (e) { await c.query("ROLLBACK TO SAVEPOINT u"); return (e as { code?: string }).code === "23503" ? false : Promise.reject(e); }
  };
  // children of demo trades (any author)
  if (tradeIds.length) {
    for (const [t, col] of [["trade_executions", "trade_id"], ["trade_quality", "trade_id"], ["trade_setup_suggestions", "trade_id"], ["trade_reviews", "trade_id"], ["trade_reactions", "trade_id"],
      ["eod_trade_reviews", "trade_id"], ["playbook_examples", "trade_id"], ["playbook_checklist_runs", "trade_id"], ["pre_trade_checklist_responses", "trade_id"], ["ai_trade_reviews", "trade_id"],
      ["ai_review_rate_limit", "trade_id"], ["rule_violations", "trade_id"], ["voice_notes", "trade_id"], ["trading_errors", "trade_id"]] as const) {
      if (has(t, col)) await del(t, `DELETE FROM ${t} WHERE ${col} = ANY($1::int[])`, [tradeIds]);
    }
    if (has("trade_ideas", "converted_trade_id")) await c.query(`UPDATE trade_ideas SET converted_trade_id = NULL WHERE converted_trade_id = ANY($1::int[]) AND NOT (trader = ANY($2::text[]))`, [tradeIds, names]);
    if (has("discussions", "trade_id")) await c.query(`UPDATE discussions SET trade_id = NULL WHERE trade_id = ANY($1::int[]) AND NOT (COALESCE(trader,'') = ANY($2::text[]))`, [tradeIds, names]);
  }
  if (names.length) {
    // children of demo parents (threads, ideas, rules, playbook rows, alerts, meetings, cohorts)
    const childOf = async (parentTable: string, ownerCol: string, children: [string, string][]) => {
      if (!has(parentTable, ownerCol)) return;
      const { rows } = await c.query(`SELECT id FROM ${parentTable} WHERE ${ownerCol} = ANY($1::text[])`, [names]);
      const ids = rows.map((r) => Number(r.id));
      if (!ids.length) return;
      for (const [t, col] of children) if (has(t, col)) await del(t, `DELETE FROM ${t} WHERE ${col} = ANY($1::int[])`, [ids]);
    };
    await childOf("discussions", "trader", [["comments", "discussion_id"], ["discussion_votes", "discussion_id"], ["discussion_reads", "thread_id"]]);
    await childOf("trade_ideas", "trader", [["trade_idea_reactions", "trade_idea_id"], ["trade_idea_comments", "idea_id"]]);
    await childOf("trading_rules", "trader", [["rule_violations", "rule_id"], ["rule_self_checks", "rule_id"]]);
    await childOf("playbook", "trader", [["playbook_reviews", "playbook_id"], ["playbook_examples", "playbook_id"], ["playbook_revisions", "playbook_id"], ["playbook_checklist_marks", "playbook_id"], ["playbook_checklist_runs", "playbook_id"], ["playbook_media", "playbook_id"]]);
    await childOf("risk_alert_log", "trader", [["risk_breach_reviews", "alert_id"]]);
    await childOf("academy_one_on_ones", "student", [["academy_action_items", "meeting_id"]]);
    await childOf("academy_cohorts", "created_by", [["academy_enrollments", "cohort_id"], ["academy_enrollment_history", "cohort_id"]]);
    await childOf("academy_sessions", "created_by", [["academy_attendance", "session_id"]]);
    // in-app notifications ABOUT a demo trader that the API's background jobs sent to real staff (e.g. EOD SLA reminders)
    if (has("notifications", "title")) {
      const pats = names.map((n) => `%${n}%`);
      await del("notifications", `DELETE FROM notifications WHERE title LIKE ANY($1::text[]) OR message LIKE ANY($1::text[]) OR entity_id LIKE ANY($1::text[])`, [pats]);
    }
    // every row owned by / about a demo user (retry passes resolve FK order)
    const OWNER_COLS = ["trader", "user_name", "user_id", "student", "author", "author_name", "curator", "reviewer", "created_by", "reader", "actor", "reporter", "user_key"];
    const targets: [string, string][] = [];
    const { rows: textCols } = await c.query(
      `SELECT c.table_name, c.column_name FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = current_schema() AND c.data_type = 'text' AND c.column_name = ANY($1::text[]) AND c.table_name <> 'users'`, [OWNER_COLS]);
    for (const r of textCols) targets.push([r.table_name, r.column_name]);
    let pending = targets;
    for (let pass = 0; pass < 6 && pending.length; pass++) {
      const next: [string, string][] = [];
      for (const [t, col] of pending) {
        const ok = await del(t, `DELETE FROM "${t}" WHERE "${col}" = ANY($1::text[])`, [names]);
        if (!ok) next.push([t, col]);
      }
      pending = next;
    }
    if (pending.length) throw new Error(`unseed: could not delete from ${pending.map((p) => p.join(".")).join(", ")} (FK)`);
  }
  if (tradeIds.length) await del("trades", `DELETE FROM trades WHERE id = ANY($1::int[])`, [tradeIds]);
  if (names.length) await del("users", `DELETE FROM users WHERE settings->>'demo' = 'true'`, []);
  if (DROP_CANDLES && has("candles_cache")) {
    // only the exact keys this seed inserted (state file) AND still carrying its sentinel fetched_at — a row the app
    // re-fetched since (fetched_at = NOW()) or cached on its own is never deleted
    const stateFile = path.join(cacheDir(), "candles-inserted.json");
    let keys: string[] = [];
    try { keys = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* nothing recorded */ }
    if (keys.length) {
      const parts = keys.map((k) => k.split("|"));
      const r = await c.query(
        `DELETE FROM candles_cache cc USING unnest($1::text[], $2::text[], $3::text[], $4::boolean[]) AS k(ticker, date, interval, extended)
          WHERE cc.ticker = k.ticker AND cc.date = k.date AND cc.interval = k.interval AND cc.extended = k.extended AND cc.fetched_at = $5::timestamptz`,
        [parts.map((x) => x[0]), parts.map((x) => x[1]), parts.map((x) => x[2]), parts.map((x) => x[3] === "true"), CANDLE_SENTINEL]);
      add("candles_cache", r.rowCount);
      fs.writeFileSync(stateFile, "[]");
    }
  }
  return counts;
}

// ─── seed ───────────────────────────────────────────────────────────────────

function randomLockedHash(): string {
  // A real bcrypt hash of 32 random bytes that is never printed or stored anywhere: nobody can log in as a demo user.
  const req = createRequire(path.resolve(import.meta.dirname, "..", "..", "artifacts", "api-server", "package.json"));
  try {
    const bcrypt = req("bcryptjs");
    return bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), 8);
  } catch {
    return `$2a$08$${crypto.randomBytes(40).toString("base64").replace(/[^A-Za-z0-9./]/g, ".").slice(0, 53)}`;
  }
}

const TXT = {
  plan: ["Работаю только гэперы с объёмом, OPG по плану, MOC если будет имбаланс.", "Фокус: первые 30 минут, максимум 3 тикера.", "Сегодня CPI — до 10:00 не торгую, потом ORB.", "План: шорт слабых в секторе, лонг сильных на откатах к VWAP.", "Отчёты вчера после закрытия — смотрю реакцию на открытии.", "Риск на сделку как обычно, дневной стоп не трогаю.", "Торгую мало, только A+ сетапы.", "Утром список из 5 тикеров, в обед не торгую."],
  well: ["Дождался подтверждения и не догонял.", "Фиксировал частями, раннера держал до VWAP.", "Стопы стояли сразу после входа.", "Остановился после двух убытков.", "Хорошо отработал открытие.", "Не торговал в обед — как и планировал.", "MOC-имбаланс прочитал правильно."],
  mistakes: ["Вошёл до подтверждения, поймал стоп.", "Передвинул стоп — убыток больше плана.", "Перезаходил в тот же тикер трижды.", "Взял размер больше обычного после убытка.", "Закрыл прибыльную позицию слишком рано.", "Торговал против рынка — SPY падал.", "Не было плана на сделку, вошёл на эмоциях.", "Пропустил свой сетап, потом догнал хуже."],
  lessons: ["Ждать первые 5 минут на открытии.", "Стоп ставлю до входа.", "После двух стопов подряд — пауза 15 минут.", "Размер не увеличивать после убытка.", "Фиксировать треть на 1R.", "Не торговать без плана.", "Следить за SPY перед входом."],
  focus: ["Терпение на входе.", "Дисциплина стопов.", "Меньше сделок, лучше качество.", "Держать прибыльные сделки дольше.", "Не торговать в обед.", "Работать только по плейбуку."],
  feedback: ["Хорошо, что остановился после двух стопов. Продолжай в том же духе.", "Вход в {T} был ранним — жди закрепления над уровнем.", "Размер в убыточной сделке больше плана. Обсудим на 1:1.", "Отличный день: план, исполнение, разбор. Так и держать.", "Мало конкретики в разборе — пиши цифры: вход, стоп, R.", "Перезаходы в {T} — признак тильта. Правило: максимум 2 входа в тикер.", "Стоп двигать нельзя. Это главное на этой неделе.", "Фиксация частями — молодец, это видно по результату.", "Разбор сделок хороший, но план на день слишком общий.", "Видно прогресс по дисциплине за неделю."],
  emotion: ["Спокойно, всё по плану.", "Немного нервничал на открытии.", "После стопа хотелось отыграться — сдержался.", "Не выспался, торговал осторожно.", "Устал к обеду.", "Хороший фокус весь день.", "Раздражение после пропущенного сетапа."],
  curatorNote: { note: ["Обсудили план на неделю, цель — дисциплина стопов.", "Попросил писать разбор каждый день.", "Хороший прогресс по журналу."], call: ["Созвон 30 минут: разбор недели, план на следующую.", "1:1 по видео — хоткеи и размер позиции."], concern: ["Две недели подряд превышает дневной лимит.", "Перезаходы и реванш после убытков — следить.", "Пропускает утренние брифинги."], praise: ["Отличная неделя, ни одного нарушения.", "Лучший результат в группе за месяц.", "Стабильно ведёт журнал и разборы."] },
};

async function seed(c: Q, trades: GenTrade[], days: DayStat[]): Promise<void> {
  const cols = await tableCols(c);
  const has = (t: string) => cols.has(t);
  const rng = new Rng("content");
  const summary: string[] = [];

  // users
  const userRows = USERS.map((u) => {
    const created = u.stages?.length ? `${[...u.stages].sort()[0][0]} 09:00:00 America/New_York` : "2024-01-08 09:00:00 America/New_York";
    return [u.name, u.role, true, randomLockedHash(), u.curator ?? null, u.riskManager ?? null, u.mentor ?? null, JSON.stringify({ demo: true, demoSeed: "seed-demo v2" }), created];
  });
  const users = await insertMany(c, "users", ["name", "role", "active", "password_hash", "assigned_curator", "assigned_risk_manager", "assigned_mentor", "settings", "created_at"], userRows,
    { returning: "id, name, role", casts: { settings: "jsonb", created_at: "timestamptz" } });

  // playbook: office entries by name (lowest id wins on duplicate names) + the demo personal entries, inserted
  // BEFORE the trades so every trade carries setup = exact playbook name AND playbook_id (the app's own linkage)
  const { rows: pb } = await c.query(`SELECT id, name FROM playbook WHERE deleted_at IS NULL AND trader IS NULL AND COALESCE(space, 'office') = 'office' ORDER BY id`);
  const pbId = new Map<string, number>();
  for (const r of pb) if (!pbId.has(r.name)) pbId.set(r.name, Number(r.id));
  const personalNames = new Set(PERSONAL.map((x) => x[1]));
  const missingPb = Object.keys(SETUP).filter((n) => !personalNames.has(n) && !pbId.has(n));
  if (missingPb.length) throw new Error(`office playbook entries missing (setups not linkable): ${missingPb.join(", ")}`);
  const personal: { id: number; trader: string; name: string; items: { id: string; text: string }[] }[] = [];
  {
    const SENIORS = new Set(TRADERS.filter((u) => stageAt(u, END) === "senior").map((u) => u.name));
    const setupType = (st: Strat) => (st === "OPG" || st === "OPGtoDAY" ? "OPG" : st === "MOC" ? "Imbalance" : st === "Overnight" || st === "Swing" ? "Post-Earnings Continuation" : st === "Premarket" ? "Gap" : "Intraday Momentum");
    const tod = (st: Strat) => (st === "MOC" ? "15:30–16:00" : st === "OPG" || st === "OPGtoDAY" ? "9:30–10:00" : st === "Premarket" ? "7:00–9:30" : st === "AfterMarket" ? "16:00–18:00" : st === "Overnight" || st === "Swing" ? null : "9:45–15:30");
    const itemsOf = (i: number) => [{ id: `d${i}a`, text: "Сетап совпадает с описанием" }, { id: `d${i}b`, text: "Стоп определён до входа" }, { id: `d${i}c`, text: "Размер по риску" }, { id: `d${i}d`, text: "Объём подтверждает движение" }];
    const rows = PERSONAL.map(([who, name, def, cond, stop, tgt], i) => {
      const u = TRADERS.find((x) => x.name === who)!;
      // seniors share theirs with the whole office; two traders share with chosen colleagues; the rest stay private
      const vis = SENIORS.has(who) ? "all" : who === "Павел Д." || who === "Виктор С." ? "custom" : "private";
      const sw = vis === "custom" ? JSON.stringify({ users: who === "Павел Д." ? ["Глеб А.", "Кирилл Б."] : ["Игорь П.", "Денис Ф."], cohorts: [] }) : null;
      const created = addDays(firstDay(u) > START ? firstDay(u) : START, -4);
      return [name, "Мои сетапы", setupType(def.strat), cond, "Личный сетап из журнала.", 60 + (i * 7) % 30, who, "personal", vis, sw, vis === "private" ? null : etTs("2026-03-02", 18 * 3600 + i * 60), vis === "private" ? null : who, who,
        cond, stop, tgt, tod(def.strat), def.strat === "Overnight" ? "overnight" : def.strat === "Swing" ? "swing" : "intraday", def.strat, JSON.stringify(itemsOf(i)), etTs(created, 18 * 3600 + i * 60), etTs("2026-09-15", 18 * 3600 + i * 60)];
    });
    const pr = await insertMany(c, "playbook", ["name", "folder", "setup_type", "conditions", "notes", "confidence_level", "trader", "space", "visibility", "shared_with", "shared_at", "shared_by", "created_by", "entry_text", "stop_text", "targets_text", "time_of_day", "horizon", "tags", "checklist_items", "created_at", "updated_at"],
      rows, { returning: "id, trader, name", casts: { shared_with: "jsonb", shared_at: "timestamptz", checklist_items: "jsonb", created_at: "timestamptz", updated_at: "timestamptz" } });
    for (const r of pr) {
      pbId.set(r.name, Number(r.id));
      personal.push({ id: Number(r.id), trader: r.trader, name: r.name, items: itemsOf(PERSONAL.findIndex((x) => x[1] === r.name)) });
    }
    if (has("playbook_reviews")) await insertMany(c, "playbook_reviews", ["playbook_id", "reviewer", "verdict", "comment"], pr.filter((_, i) => i % 2 === 0).map((p) => [p.id, MENTOR, "approved", "Хорошо описано, примеры сделок — в карточке."]));
  }

  // trades (trader by trader, chronological within each trader)
  const t0 = Date.now();
  const tradeCols = ["ticker", "date", "setup", "side", "entry", "exit", "stop", "result", "pnl", "hold_time", "market_cap", "float", "relative_volume", "session", "notes",
    "what_worked", "what_failed", "conclusion", "trader", "tags", "playbook_id", "atr", "sector", "context_snapshot", "conviction", "confidence_grade", "beta", "adv", "long_name",
    "horizon", "exit_date", "qty", "fees", "risk_usd", "source", "external_id", "broker_account", "synced_at", "created_at"];
  const tradeRows = trades.map((t) => {
    const m = T[t.underlying];
    const dm = mkt(t.underlying, t.date)!;
    const synced = etTs(t.closedAt.slice(0, 10), Math.min(86399, Number(t.closedAt.slice(11, 13)) * 3600 + Number(t.closedAt.slice(14, 16)) * 60 + Number(t.closedAt.slice(17, 19)) + 120));
    const ctxSnap = { demo: true, source: "propreports", externalId: t.externalId, account: t.account, openedAt: t.openedAt, closedAt: t.closedAt, qty: t.qty, openQty: 0,
      gross: t.gross, totalFees: t.fees, net: t.net, feesByType: t.feesByType, fillCount: t.fills.length, avgEntry: t.entry, avgExit: t.exit, fromReport: false, priceSource: "yahoo",
      ...(t.isOpt ? { assetType: "option", underlying: t.underlying, multiplier: 100, premiumModel: "synthetic" } : {}) };
    return [t.ticker, t.date, t.setup, t.side, t.entry, t.exit, t.stop, t.result, t.gross, t.holdTime, m.cap, m.float,
      dm.rvol, t.session, t.notes, t.whatWorked, t.whatFailed, t.conclusion, t.trader, t.tags,
      pbId.get(t.setup) ?? null, t.atr, m.sector, JSON.stringify(ctxSnap), t.conviction, t.grade,
      m.beta, m.adv, m.name, t.horizon, t.exitDate, t.qty, t.fees, t.riskUsd, "propreports", t.externalId, t.account, synced, synced];
  });
  const ins = await insertMany(c, "trades", tradeCols, tradeRows, { returning: "id, external_id", casts: { context_snapshot: "jsonb", synced_at: "timestamptz", created_at: "timestamptz" } });
  const idByExt = new Map(ins.map((r) => [r.external_id as string, Number(r.id)]));
  const execRows: unknown[][] = [];
  for (const t of trades) {
    const id = idByExt.get(t.externalId)!;
    (t as any).id = id;
    t.fills.forEach((f, i) => {
      const fee = Object.values(f.fees).reduce((s, v) => s + v, 0);
      execRows.push([id, f.kind, f.price, f.qty, etTs(f.date, f.sec), `PropReports ${f.side}${fee ? ` · fees ${r2(fee)}` : ""}`, i, f.orderId]);
    });
  }
  await insertMany(c, "trade_executions", ["trade_id", "kind", "price", "qty", "executed_at", "note", "sort_order", "order_id"], execRows, { casts: { executed_at: "timestamptz" } });
  summary.push(`trades: ${trades.length}, executions: ${execRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (trades.some((t) => (t as any).id == null || pbId.get(t.setup) == null)) throw new Error("trade without id / playbook link");
  printSpotChecks(trades);

  // candles_cache: the real bars of every (ticker, day) a demo trade touches, in the API's exact format (raw Yahoo
  // {t,o,h,l,c,v}; extended = 04:00–20:00 ET, regular = 09:30–16:00). Only missing keys are inserted — rows the app
  // already cached are never touched — and the inserted keys go to the state file so --drop-candles removes exactly them.
  if (has("candles_cache")) {
    const t1 = Date.now();
    const need = new Set<string>();
    for (const t of trades) for (const f of t.fills) need.add(`${t.underlying}|${f.date}`);
    const cRows: unknown[][] = [];
    const reg = (bars: Bar[]) => bars.filter((b) => { const s2 = etOf(b.t).sec; return s2 >= OPEN && s2 < 16 * 3600; });
    for (const key of [...need].sort()) {
      const [tk, d] = key.split("|");
      const dm = mkt(tk, d);
      if (!dm) continue;
      for (const [iv, bars] of [["60m", dm.raw.h1], ["5m", dm.raw.m5], ["1m", dm.raw.m1]] as [string, Bar[]][]) {
        if (!bars.length) continue;
        cRows.push([tk, d, iv, true, JSON.stringify(bars), CANDLE_SENTINEL]);
        const r = reg(bars);
        if (r.length) cRows.push([tk, d, iv, false, JSON.stringify(r), CANDLE_SENTINEL]);
      }
    }
    const added = await insertMany(c, "candles_cache", ["ticker", "date", "interval", "extended", "ohlcv", "fetched_at"], cRows,
      { returning: "ticker, date, interval, extended", casts: { ohlcv: "jsonb", fetched_at: "timestamptz" }, conflict: "ON CONFLICT (ticker, date, interval, extended) DO NOTHING" });
    const stateFile = path.join(cacheDir(), "candles-inserted.json");
    let prev: string[] = [];
    try { prev = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* first run */ }
    const keys = new Set(prev);
    for (const a of added) keys.add(`${a.ticker}|${a.date}|${a.interval}|${a.extended}`);
    fs.writeFileSync(stateFile, JSON.stringify([...keys].sort()));
    const byIv: Record<string, number> = {};
    for (const a of added) { const k = `${a.interval}/${a.extended ? "ext" : "reg"}`; byIv[k] = (byIv[k] ?? 0) + 1; }
    summary.push(`candles_cache: ${cRows.length} candidate rows for ${need.size} ticker-days, inserted ${added.length} (${Object.entries(byIv).map(([k, v]) => `${k} ${v}`).join(", ")}), already cached ${cRows.length - added.length} (${((Date.now() - t1) / 1000).toFixed(1)}s); state file ${stateFile}`);
  }

  // broker account mapping (no API calls; mapping only, so the admin console does not flag demo accounts as unmapped)
  if (has("propreports_accounts")) {
    await insertMany(c, "propreports_accounts", ["account", "account_id", "account_name", "trader", "active", "notes", "last_synced_at", "last_fill_at"],
      TRADERS.map((u) => [u.persona!.account, u.persona!.account, `${u.name} (demo)`, u.name, true, "demo-seed: синтетический счёт демо-офиса", etTs(END, 16 * 3600 + 900), `${END}T15:59:00`]),
      { casts: { last_synced_at: "timestamptz" }, conflict: "ON CONFLICT (account) DO NOTHING" });
  }

  // ── academy ladder: stage, history, risk limits, scaling
  const stageRows: unknown[][] = [], histRows: unknown[][] = [], limRows: unknown[][] = [], limEv: unknown[][] = [], scaleRows: unknown[][] = [];
  for (const u of TRADERS) {
    const st = u.stages!;
    const cur = st[st.length - 1];
    stageRows.push([u.name, cur[1], cur[0], cur[1] === "trainee" ? MENTOR : "Дмитрий К."]);
    let prev: StageKey | null = null;
    for (const [since, s] of st) {
      const actor = prev ? "Дмитрий К." : MENTOR;
      histRows.push([u.name, prev, s, prev ? "promote" : "assign", actor, prev ? rng.pick(["Сдал экзамен, стабильный плюс 2 месяца", "Выполнил критерии перевода", "Решение партнёров по итогам квартала"]) : "Зачислен на деск", etTs(since, 8 * 3600 + 30 * 60)]);
      const tier = TIER[s];
      const lim = { tier: s, notes: null, trader: u.name, allowSwing: tier.allowSwing, accountSize: tier.account, maxDrawdown: tier.dd, allowOvernight: tier.allowOvn, dailyLossLimit: tier.daily, maxPositionUsd: tier.pos, maxRiskPerTrade: tier.risk, weeklyLossLimit: tier.weekly, maxOpenPositions: tier.open, maxOvernightExposure: tier.ovn };
      limEv.push([u.name, prev ? JSON.stringify({ ...lim, tier: prev }) : null, JSON.stringify(lim), `Шаблон тира «${STAGE_RU[s]}»`, RISK, etTs(since, 8 * 3600 + 35 * 60)]);
      scaleRows.push([u.name, prev ? "promote" : "assign", prev, s, RISK, prev ? "Перевод по лестнице академии" : null, JSON.stringify({ key: s, name: STAGE_RU[s], ...lim }), etTs(since, 8 * 3600 + 36 * 60)]);
      prev = s;
    }
    const t = TIER[cur[1]];
    limRows.push([u.name, t.account, t.daily, t.weekly, t.dd, t.risk, t.pos, t.ovn, t.open, t.allowOvn, t.allowSwing, cur[1], u.name === "Денис Ф." ? "Под наблюдением: превышения дневного лимита" : null, RISK]);
  }
  if (has("academy_trader_stage")) await insertMany(c, "academy_trader_stage", ["user_name", "stage", "since", "updated_by"], stageRows);
  if (has("academy_stage_history")) await insertMany(c, "academy_stage_history", ["user_name", "from_stage", "to_stage", "action", "actor", "comment", "created_at"], histRows, { casts: { created_at: "timestamptz" } });
  if (has("trader_risk_limits")) await insertMany(c, "trader_risk_limits", ["trader", "account_size", "daily_loss_limit", "weekly_loss_limit", "max_drawdown", "max_risk_per_trade", "max_position_usd", "max_overnight_exposure", "max_open_positions", "allow_overnight", "allow_swing", "tier", "notes", "updated_by"], limRows);
  if (has("trader_risk_limit_events")) await insertMany(c, "trader_risk_limit_events", ["trader", "before", "after", "reason", "changed_by", "changed_at"], limEv, { casts: { before: "jsonb", after: "jsonb", changed_at: "timestamptz" } });
  if (has("scaling_history")) await insertMany(c, "scaling_history", ["trader", "action", "from_tier", "to_tier", "actor", "comment", "limits", "created_at"], scaleRows, { casts: { limits: "jsonb", created_at: "timestamptz" } });

  // cohort + enrollments for the academy people (created_by = demo mentor ⇒ unseed-able)
  const academyPeople = TRADERS.filter((u) => u.mentor);
  let cohortId: number | null = null;
  if (has("academy_cohorts") && has("academy_enrollments")) {
    const [co] = await insertMany(c, "academy_cohorts", ["name", "format", "mentor", "starts_on", "ends_on", "description", "room", "created_by"],
      [["Академия — поток 2025/26", "office", MENTOR, "2025-03-03", "2026-12-18", "Сквозной поток стажёров и джунов: утренние брифинги, разборы, экзамены лестницы.", "Переговорная 2", MENTOR]], { returning: "id" });
    cohortId = Number(co.id);
    const enr = await insertMany(c, "academy_enrollments", ["cohort_id", "user_name", "stage", "status", "joined_on", "note", "created_by"],
      academyPeople.map((u) => [cohortId, u.name, stageAt(u, END), "active", firstDay(u), "", MENTOR]), { returning: "id, user_name" });
    if (has("academy_enrollment_history")) {
      const eh: unknown[][] = [];
      for (const e of enr) {
        const u = academyPeople.find((x) => x.name === e.user_name)!;
        let prev: StageKey | null = null;
        for (const [since, s] of u.stages!) { eh.push([e.id, cohortId, u.name, prev, s, prev ? "active" : null, "active", MENTOR, prev ? "Перевод по лестнице" : "Зачисление", etTs(since, 9 * 3600)]); prev = s; }
      }
      await insertMany(c, "academy_enrollment_history", ["enrollment_id", "cohort_id", "user_name", "from_stage", "to_stage", "from_status", "to_status", "changed_by", "note", "changed_at"], eh, { casts: { changed_at: "timestamptz" } });
    }
    if (has("academy_sessions") && has("academy_attendance")) {
      const [sess] = await insertMany(c, "academy_sessions", ["cohort_id", "title", "kind", "recurrence", "weekdays", "start_date", "end_date", "start_time", "duration_min", "mode", "room", "host", "description", "created_by"],
        [[cohortId, "Утренний брифинг", "briefing", "weekly", "{1,2,3,4,5}", "2026-08-31", "2026-12-18", "08:50", 30, "office", "Переговорная 2", MENTOR, "План дня, тикеры в игре, риск-режим.", MENTOR]], { returning: "id", casts: { weekdays: "smallint[]" } });
      const att: unknown[][] = [];
      for (const d of DAYS.filter((x) => x >= "2026-08-31")) for (const u of academyPeople) {
        if (firstDay(u) > d) continue;
        const r = rng.next();
        att.push([sess.id, d, u.name, r < 0.82 ? "present" : r < 0.92 ? "late" : r < 0.97 ? "absent" : "excused", "mentor", MENTOR, "", etTs(d, 8 * 3600 + 55 * 60)]);
      }
      await insertMany(c, "academy_attendance", ["session_id", "occurrence_date", "user_name", "status", "source", "marked_by", "note", "checked_in_at"], att, { casts: { checked_in_at: "timestamptz" } });
    }
  }

  // lesson progress / quiz attempts / submissions for academy people
  const { rows: lessons } = has("academy_lessons") ? await c.query(`SELECT id FROM academy_lessons WHERE archived_at IS NULL ORDER BY id`) : { rows: [] as any[] };
  const { rows: quizzes } = has("academy_quizzes") ? await c.query(`SELECT id, pass_pct FROM academy_quizzes WHERE archived_at IS NULL ORDER BY id`) : { rows: [] as any[] };
  const { rows: assigns } = has("academy_assignments") ? await c.query(`SELECT id FROM academy_assignments WHERE archived_at IS NULL ORDER BY id`) : { rows: [] as any[] };
  const lp: unknown[][] = [], qa: unknown[][] = [], subs: unknown[][] = [];
  for (const u of academyPeople) {
    const start = firstDay(u);
    const done = u.name === "Владислав Е." ? 2 : u.name === "Илья Ш." ? 4 : lessons.length;
    lessons.forEach((l: any, i: number) => {
      const d = addDays(start, 2 + i * 4);
      lp.push([u.name, l.id, etTs(d, 19 * 3600), i < done ? etTs(d, 20 * 3600) : null, etTs(d, 20 * 3600)]);
    });
    quizzes.forEach((q: any, i: number) => {
      if (u.name === "Владислав Е." && i > 0) return;
      const tries = u.name === "Денис Ф." ? 2 : rng.chance(0.3) ? 2 : 1;
      for (let k = 0; k < tries; k++) {
        const pct = k === tries - 1 ? rng.int(Number(q.pass_pct), 100) : rng.int(45, Number(q.pass_pct) - 5);
        qa.push([q.id, u.name, "{}", "[]", pct / 10, 10, pct, pct >= Number(q.pass_pct), etTs(addDays(start, 10 + i * 8 + k), 18 * 3600)]);
      }
    });
    if (u.name !== "Владислав Е.") assigns.forEach((a: any, i: number) => {
      const pct = rng.int(62, 96);
      subs.push([a.id, u.name, rng.pick(["Разобрал три сделки: вход, стоп, выход, R. Ошибка — ранний вход в двух из трёх.", "План на день с уровнями и списком тикеров приложен.", "Разбор OPG-сделок за неделю: что сработало и что нет."]),
        pct >= 70 ? "graded" : "returned", pct, 100, pct, pct >= 70, rng.pick(["Хорошо, но добавь скриншоты уровней.", "Отличный разбор.", "Мало конкретики по стопам — переделай."]), MENTOR, etTs(addDays(start, 20 + i * 10), 12 * 3600), etTs(addDays(start, 18 + i * 10), 21 * 3600)]);
    });
  }
  if (has("academy_lesson_progress")) await insertMany(c, "academy_lesson_progress", ["user_name", "lesson_id", "started_at", "completed_at", "updated_at"], lp, { casts: { started_at: "timestamptz", completed_at: "timestamptz", updated_at: "timestamptz" } });
  if (has("academy_quiz_attempts")) await insertMany(c, "academy_quiz_attempts", ["quiz_id", "user_name", "answers", "results", "score", "max_score", "pct", "passed", "submitted_at"], qa, { casts: { answers: "jsonb", results: "jsonb", submitted_at: "timestamptz" } });
  if (has("academy_submissions")) await insertMany(c, "academy_submissions", ["assignment_id", "user_name", "body", "status", "total", "max_total", "pct", "passed", "mentor_comment", "graded_by", "graded_at", "created_at"], subs, { casts: { graded_at: "timestamptz", created_at: "timestamptz" } });

  // challenges (exams of the ladder) — finished ones with a summary from the generated trades, plus active ones
  const dayByTrader = new Map<string, DayStat[]>();
  for (const d of days) { const l = dayByTrader.get(d.trader) ?? []; l.push(d); dayByTrader.set(d.trader, l); }
  const chRows: unknown[][] = [];
  const examRules = (to: StageKey, consistencyPct: number, minDays: number) => {
    const t = TIER[to];
    return { accountSize: t.account, maxDrawdown: t.daily * 5, drawdownMode: "trailing", profitTarget: t.daily * 5, rulesVersion: 2, tradingWindow: { end: 960, start: 240 }, consistencyPct, dailyLossLimit: t.daily, maxPositionQty: null, maxPositionUsd: t.pos, minTradingDays: minDays, tradingWindowStrict: false, trailingStopsAtStart: true };
  };
  const finishedSummary = (u: DemoUser, from: string, to: string, status: "passed" | "failed", rules: any) => {
    const ds = (dayByTrader.get(u.name) ?? []).filter((d) => d.date >= from && d.date <= to);
    const net = r2(ds.reduce((s, d) => s + d.net, 0));
    return { net, status, reason: status === "passed" ? "Цель по прибыли достигнута, все правила соблюдены" : "Дневной лимит убытка превышен", failure: status === "failed" ? { date: ds.find((d) => d.net < -rules.dailyLossLimit)?.date ?? to, rule: "daily_loss", label: "Дневной лимит убытка", detail: "Убыток дня больше лимита" } : null,
      passedOn: status === "passed" ? to : null, tradingDays: ds.length,
      progress: [{ key: "profit_target", pct: clamp(net / rules.profitTarget, 0, 1.5), state: status === "passed" ? "ok" : "pending" }, { key: "daily_loss", pct: 0.6, state: status === "passed" ? "ok" : "breached" }, { key: "max_drawdown", pct: 0.4, state: "ok" }, { key: "consistency", pct: 0.3, state: "ok" }, { key: "min_days", pct: 1, state: "ok" }, { key: "max_position", pct: 0.7, state: "ok" }, { key: "trading_window", pct: null, state: "ok" }] };
  };
  for (const u of TRADERS) {
    const st = u.stages!;
    for (let i = 1; i < st.length; i++) {
      const [since, to] = st[i]; const from = st[i - 1][1];
      if (since < "2025-01-02") continue;
      const key = `${from}_to_${to}`;
      const rules = examRules(to, from === "trainee" ? 40 : 35, from === "trainee" ? 10 : 15);
      // a failed first attempt for some, then the passed one
      if (u.name === "Денис Ф." || u.name === "Никита С.") {
        const fs = addDays(since, -70), fe = addDays(since, -42);
        chRows.push([u.name, key, `Перевод ${STAGE_RU[from]} → ${STAGE_RU[to]} (капитал $${TIER[to].account / 1000}k)`, JSON.stringify(rules), fs, fe, "failed", JSON.stringify(finishedSummary(u, fs, fe, "failed", rules)), "failed", "Первая попытка — сорвался на дневном лимите", MENTOR, etTs(fs, 8 * 3600)]);
      }
      const ps = addDays(since, -32), pe = addDays(since, -3);
      chRows.push([u.name, key, `Перевод ${STAGE_RU[from]} → ${STAGE_RU[to]} (капитал $${TIER[to].account / 1000}k)`, JSON.stringify(rules), ps, pe, "passed", JSON.stringify(finishedSummary(u, ps, pe, "passed", rules)), "passed", "Сдал", MENTOR, etTs(ps, 8 * 3600)]);
    }
  }
  const activeExam = (name: string, from: StageKey, to: StageKey, starts: string) => {
    const rules = examRules(to, from === "trainee" ? 40 : from === "junior" ? 35 : 30, from === "trainee" ? 10 : 15);
    chRows.push([name, `${from}_to_${to}`, `Перевод ${STAGE_RU[from]} → ${STAGE_RU[to]} (капитал $${TIER[to].account / 1000}k)`, JSON.stringify(rules), starts, addDays(starts, 27), "active", null, null, null, MENTOR, etTs(starts, 8 * 3600)]);
  };
  activeExam("Кирилл Б.", "junior", "trader", "2026-10-05");
  activeExam("Илья Ш.", "trainee", "junior", "2026-10-12");
  activeExam("Никита С.", "trader", "senior", "2026-10-01");
  if (has("academy_challenges")) await insertMany(c, "academy_challenges", ["user_name", "template_key", "name", "rules", "starts_on", "ends_on", "status", "summary", "notified_status", "comment", "created_by", "created_at"], chRows, { casts: { rules: "jsonb", summary: "jsonb", created_at: "timestamptz" } });

  if (has("academy_promotion_requests")) {
    await insertMany(c, "academy_promotion_requests", ["user_name", "from_stage", "to_stage", "status", "passed", "total", "ready", "comment", "requested_by", "created_at", "decided_by", "decided_at", "decision_comment"], [
      ["Кирилл Б.", "junior", "trader", "pending", 7, 9, false, "Прошу рассмотреть перевод: 3 месяца в плюсе, экзамен идёт", "Кирилл Б.", etTs("2026-10-13", 17 * 3600), null, null, null],
      ["Артём Г.", "trainee", "junior", "approved", 8, 8, true, "Все критерии выполнены", MENTOR, etTs("2026-04-01", 17 * 3600), "Дмитрий К.", etTs("2026-04-03", 12 * 3600), "Одобрено, с понедельника капитал $25k"],
      ["Денис Ф.", "trainee", "junior", "rejected", 5, 8, false, "Хочу на джуна", "Денис Ф.", etTs("2025-12-15", 17 * 3600), "Дмитрий К.", etTs("2025-12-17", 12 * 3600), "Рано: превышения дневного лимита, нет стабильности"],
      ["Денис Ф.", "trainee", "junior", "approved", 7, 8, true, "Повторная заявка после экзамена", MENTOR, etTs("2026-01-28", 17 * 3600), "Дмитрий К.", etTs("2026-01-30", 12 * 3600), "Одобрено условно, под наблюдением риск-менеджера"],
      ["Даниил О.", "trainee", "junior", "approved", 8, 8, true, "Критерии выполнены, экзамен сдан", MENTOR, etTs("2025-08-27", 17 * 3600), "Дмитрий К.", etTs("2025-08-29", 12 * 3600), "Одобрено, с 1 сентября капитал $25k"],
      ["Егор М.", "trainee", "junior", "approved", 8, 8, true, "Прошу перевод на джуна", "Егор М.", etTs("2026-02-24", 17 * 3600), "Дмитрий К.", etTs("2026-02-26", 12 * 3600), "Одобрено"],
      ["Степан Л.", "junior", "trader", "approved", 9, 9, true, "Год в плюсе, экзамен сдан", MENTOR, etTs("2026-04-28", 17 * 3600), "Дмитрий К.", etTs("2026-04-30", 12 * 3600), "Одобрено, капитал $50k"],
      ["Даниил О.", "junior", "trader", "pending", 6, 9, false, "Хочу на трейдера", "Даниил О.", etTs("2026-10-09", 17 * 3600), null, null, null],
    ], { casts: { created_at: "timestamptz", decided_at: "timestamptz" } });
  }
  if (has("academy_idp_goals")) {
    const g: unknown[][] = [];
    for (const u of academyPeople) {
      g.push([u.name, "Не больше 3 убыточных сделок подряд", "loss_streak", "lte", 3, 10, "2026-09-01", "2026-11-30", "active", "", MENTOR]);
      g.push([u.name, "10 дней дневника с разбором", "journal_days", "gte", 10, null, "2026-09-15", "2026-11-15", "active", "", MENTOR]);
      if (u.name === "Кирилл Б.") g.push([u.name, "Профит-фактор ≥ 1.3 за 20 дней", "profit_factor", "gte", 1.3, 20, "2026-08-01", "2026-10-31", "active", "", MENTOR]);
    }
    await insertMany(c, "academy_idp_goals", ["student", "title", "metric", "comparator", "target", "window_n", "start_date", "due_on", "status", "note", "created_by"], g);
  }
  if (has("academy_one_on_ones")) {
    const oo: unknown[][] = [];
    const agendas = [["Разбор недели, стопы.", "Двигает стоп в убыточных сделках. Договорились: стоп только в сторону прибыли."], ["Размер позиции после убытка.", "После стопа берёт размер ×1.5. Правило: после убытка — половина размера."], ["План на месяц, экзамен.", "Готов к экзамену через 2 недели, если удержит дисциплину."], ["Хоткеи и исполнение на открытии.", "Хоткеи настроены, OPG-ордера отправляет вовремя."], ["Психология: реванш.", "Тильт после двух стопов. Пауза 15 минут после второго стопа."]];
    for (const u of academyPeople) {
      const n = u.name === "Владислав Е." ? 2 : u.name === "Илья Ш." ? 3 : 6;
      for (let k = 0; k < n; k++) {
        const d = DAYS.filter((x) => x >= firstDay(u) && x <= END);
        const day = d[Math.min(d.length - 1, Math.floor(((k + 1) / (n + 1)) * d.length))];
        const [ag, nt] = agendas[(k + hashStr(u.name)) % agendas.length];
        oo.push([u.name, MENTOR, cohortId, etTs(day, 16 * 3600 + 30 * 60), 40, rng.chance(0.7) ? "office" : "online", ag, nt, "", MENTOR]);
      }
    }
    const meet = await insertMany(c, "academy_one_on_ones", ["student", "mentor", "cohort_id", "met_at", "duration_min", "format", "agenda", "notes", "private_notes", "created_by"], oo, { returning: "id, student, met_at", casts: { met_at: "timestamptz" } });
    if (has("academy_action_items")) {
      const ai = meet.filter((_, i) => i % 2 === 0).map((m) => {
        const due = ymd(new Date(new Date(m.met_at).getTime() + 7 * 86400000));
        const done = due < "2026-10-10" || rng.chance(0.3);
        return [m.id, m.student, "student", rng.pick(["Стоп только в сторону прибыли всю неделю", "После второго стопа — пауза 15 минут", "Писать разбор каждый день", "Пройти урок по исполнению и сдать тест"]), due, done ? "done" : "open", done ? etTs(due, 18 * 3600) : null, MENTOR];
      });
      await insertMany(c, "academy_action_items", ["meeting_id", "student", "owner", "title", "due_on", "status", "done_at", "created_by"], ai, { casts: { done_at: "timestamptz" } });
    }
  }

  // ── journal / EOD / psychology / notes
  const jRows: unknown[][] = [], eodRows: unknown[][] = [], emoRows: unknown[][] = [], jnRows: unknown[][] = [], eodTr: unknown[][] = [];
  const MISTAKE_TAGS = ["FOMO", "Ранний вход", "Поздний выход", "Двигал стоп", "Овертрейдинг", "Реванш", "Без плана", "Большой размер", "Не по сетапу", "Ранний выход"];
  const EMOTION_TAGS = ["Спокойствие", "Уверенность", "Азарт", "Нетерпение", "Страх", "Жадность", "Скука", "Раздражение"];
  for (const d of days) {
    const u = TRADERS.find((x) => x.name === d.trader)!;
    const stage = stageAt(u, d.date)!;
    const academy = stage === "trainee" || stage === "junior";
    const r = new Rng(`day:${d.trader}:${d.date}`);
    const bad = d.net < 0;
    const mood = clamp(Math.round(3 + (d.net > 0 ? 1 : -1) * r.u(0, 1.4) + r.normal() * 0.4), 1, 5);
    const discipline = clamp(Math.round((d.blowup ? 1.5 : 4) + r.normal() * 0.7 - (d.n > u.persona!.tpd * 1.6 ? 1 : 0)), 1, 5);
    const best = d.best?.underlying ?? "";
    const worst = d.worst?.underlying ?? "";
    const pJournal = academy ? 0.6 : stage === "trader" ? 0.3 : 0.15;
    if (r.chance(pJournal)) {
      const tags = [...new Set([r.pick(EMOTION_TAGS), ...(bad && r.chance(0.5) ? [r.pick(MISTAKE_TAGS)] : []), ...(d.blowup ? ["Реванш", "Раздражение"] : [])])];
      jRows.push([d.trader, d.date, r.pick(TXT.plan), bad ? (r.chance(0.5) ? r.pick(TXT.well) : "") : `${r.pick(TXT.well)} Лучшая сделка — ${best}.`, bad ? `${r.pick(TXT.mistakes)} Худшая — ${worst}.` : r.chance(0.3) ? r.pick(TXT.mistakes) : "",
        r.chance(0.7) ? r.pick(TXT.lessons) : "", mood, discipline, d.blowup ? false : r.chance(0.8), JSON.stringify(tags), etTs(d.date, 16 * 3600 + r.int(10 * 60, 3 * 3600))]);
    }
    if (d.date >= "2026-01-02" && r.chance(academy ? 0.55 : 0.15)) {
      const reviewed = academy && r.chance(0.55);
      eodRows.push([d.trader, d.date, etTs(d.date, 16 * 3600 + r.int(15 * 60, 2 * 3600)), discipline,
        JSON.stringify({ mood, stop: d.blowup ? "Не остановился после дневного лимита" : bad ? r.pick(["Стоп по плану", "Остановился после двух стопов", ""]) : "", repeat: r.pick(["", "Фиксация частями", "Вход после подтверждения"]), tomorrow: r.pick(TXT.focus), positions: [] }),
        reviewed ? MENTOR : null, reviewed ? etTs(nextDay(d.date), 8 * 3600 + r.int(0, 3000)) : null, reviewed ? r.pick(TXT.feedback).replace("{T}", worst || best) : null, reviewed ? clamp(discipline + r.int(-1, 1), 1, 5) : null]);
      if (academy) for (const t of d.trades.slice(0, 6)) {
        if (!r.chance(0.6)) continue;
        const lose = t.net < 0;
        eodTr.push([t, d.trader, lose ? r.chance(0.4) : r.chance(0.85), lose && r.chance(0.6) ? `{${[r.pick(MISTAKE_TAGS)].map((x) => `"${x}"`).join(",")}}` : "{}", lose ? r.pick(TXT.lessons) : r.chance(0.3) ? r.pick(TXT.lessons) : ""]);
      }
    }
    if (r.chance(d.date >= "2026-01-02" ? 0.45 : 0.15)) {
      emoRows.push([d.trader, d.date, r.chance(0.7), r.chance(bad ? 0.4 : 0.15), d.blowup || (bad && r.chance(0.12)), r.chance(bad ? 0.35 : 0.7), r.chance(0.2), d.blowup || (bad && r.chance(0.08)), r.chance(0.3) ? r.pick(TXT.emotion) : null, etTs(d.date, 8 * 3600 + r.int(0, 3600))]);
    }
    if (academy && d.date >= "2026-01-02" && r.chance(0.42)) {
      const sections = { plan: r.pick(TXT.plan), intraday: `${d.n} сделок, ${d.net >= 0 ? "+" : ""}${r2(d.net)}$. Лучшая ${best}, худшая ${worst}.`, mistakes: bad ? r.pick(TXT.mistakes) : r.chance(0.4) ? r.pick(TXT.mistakes) : "", lessons: r.pick(TXT.lessons), focus: r.pick(TXT.focus) };
      const raw = Object.entries({ "": "", "План": sections.plan, "Сделки — интрадей": sections.intraday, "Ошибки": sections.mistakes, "Уроки": sections.lessons, "Фокус на завтра": sections.focus }).filter(([, v]) => v).map(([k, v]) => `${k}:\n${v}`).join("\n\n");
      const reviewed = r.chance(d.date < "2026-10-12" ? 0.7 : 0.3);
      const at = etTs(d.date, 16 * 3600 + r.int(20 * 60, 3 * 3600));
      jnRows.push([d.trader, d.date, raw, String(mood), JSON.stringify(Object.fromEntries(Object.entries(sections).filter(([, v]) => v))), reviewed ? r.pick(TXT.feedback).replace("{T}", worst || best) : null, reviewed ? clamp(discipline + r.int(-1, 1), 1, 5) : null,
        reviewed ? MENTOR : null, reviewed ? etTs(nextDay(d.date), 8 * 3600 + r.int(0, 3000)) : null, reviewed && r.chance(0.8) ? etTs(nextDay(d.date), 9 * 3600) : null, at, at]);
    }
  }
  if (has("journal_days")) await insertMany(c, "journal_days", ["trader", "day", "plan", "well", "mistakes", "lessons", "mood", "discipline", "followed_plan", "tags", "created_at"], jRows, { casts: { tags: "jsonb", created_at: "timestamptz" } });
  if (has("eod_days")) await insertMany(c, "eod_days", ["trader", "date", "closed_at", "discipline", "summary", "reviewed_by", "reviewed_at", "curator_comment", "curator_score"], eodRows, { casts: { closed_at: "timestamptz", summary: "jsonb", reviewed_at: "timestamptz" } });
  if (has("eod_trade_reviews")) await insertMany(c, "eod_trade_reviews", ["trade_id", "trader", "followed_plan", "mistakes", "lesson"], eodTr.map((x) => [(x[0] as any).id, ...x.slice(1)]), { casts: { mistakes: "text[]" } });
  if (has("emotional_state_log")) await insertMany(c, "emotional_state_log", ["user_id", "date", "sleep_well", "stressed", "tilted", "focused", "anxious", "revenge", "free_text", "created_at"], emoRows, { casts: { created_at: "timestamptz" } });
  if (has("junior_notes")) await insertMany(c, "junior_notes", ["trader", "note_date", "raw_text", "mood", "sections", "curator_feedback", "curator_score", "reviewed_by", "reviewed_at", "feedback_seen_at", "created_at", "updated_at"], jnRows, { casts: { sections: "jsonb", reviewed_at: "timestamptz", feedback_seen_at: "timestamptz", created_at: "timestamptz", updated_at: "timestamptz" } });

  // weekly reviews + ratings (curators about traders), curator notes
  const wk = new Map<string, Map<string, DayStat[]>>();
  for (const d of days) { const m = wk.get(d.trader) ?? new Map<string, DayStat[]>(); const k = mondayOf(d.date); const l = m.get(k) ?? []; l.push(d); m.set(k, l); wk.set(d.trader, m); }
  const wrRows: unknown[][] = [], ratRows: unknown[][] = [], cnRows: unknown[][] = [];
  for (const u of TRADERS) {
    const weeks = [...(wk.get(u.name) ?? new Map<string, DayStat[]>()).entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [mon, ds] of weeks) {
      const stage = stageAt(u, mon) ?? stageAt(u, ds[0].date)!;
      const academy = stage === "trainee" || stage === "junior";
      const r = new Rng(`wk:${u.name}:${mon}`);
      const net = ds.reduce((s, d) => s + d.net, 0);
      const curator = u.curator ?? (u.riskManager ?? RISK);
      if (mon >= "2026-01-05" && (academy || stage === "trader") && r.chance(academy ? 0.85 : 0.5)) {
        const reviewed = r.chance(mon < "2026-10-12" ? 0.75 : 0.2);
        const score = clamp(Math.round(6 + net / (TIER[stage].daily * 2) + r.normal()), 2, 10);
        wrRows.push([u.name, isoWeekKey(mon), mon, JSON.stringify({ well: r.pick(TXT.well), badly: r.pick(TXT.mistakes), focus: r.pick(TXT.focus), lessons: r.pick(TXT.lessons), mood: clamp(Math.round(3 + net / (TIER[stage].daily * 3)), 1, 5), updatedAt: new Date(`${addDays(mon, 4)}T22:00:00Z`).toISOString() }),
          reviewed ? JSON.stringify({ comment: r.pick(TXT.feedback).replace("{T}", ds[0].best?.underlying ?? ""), score, by: curator, updatedAt: new Date(`${addDays(mon, 7)}T13:00:00Z`).toISOString() }) : "{}",
          reviewed ? JSON.stringify([{ id: `g${hashStr(u.name + mon).toString(36)}`, text: r.pick(TXT.focus), status: mon < "2026-10-05" ? r.pick(["done", "done", "partial", "missed"]) : "open", by: curator, createdAt: new Date(`${addDays(mon, 7)}T13:00:00Z`).toISOString() }]) : "[]",
          reviewed ? "reviewed" : "submitted", etTs(addDays(mon, 4), 18 * 3600), reviewed ? etTs(addDays(mon, 7), 9 * 3600) : null]);
      }
      const rateEvery = academy ? 1 : stage === "trader" ? 2 : 4;
      const wIdx = Math.round(dayDiff("2025-01-06", mon) / 7);
      if (wIdx % rateEvery === 0 && (mon >= "2025-03-03")) {
        const base = clamp(6 + net / (TIER[stage].daily * 2.5), 2, 9.5);
        const sc = () => clamp(Math.round(base + r.normal() * 1.1), 1, 10);
        const vals = [sc(), sc(), sc(), sc(), sc()];
        ratRows.push([u.name, curator, mon, ...vals, clamp(Math.round(vals.reduce((a, b) => a + b, 0) / 5), 1, 10), r.pick(TXT.feedback).replace("{T}", ds[0].best?.underlying ?? ""), r.pick(TXT.focus), stage, etTs(addDays(mon, 5), 15 * 3600), r.chance(0.7) ? etTs(addDays(mon, 7), 9 * 3600) : null]);
      }
    }
    const nNotes = (u.mentor ? 6 : 2) + (u.name === "Денис Ф." || u.name === "Игорь П." ? 4 : 0);
    const myDays = (dayByTrader.get(u.name) ?? []);
    for (let k = 0; k < nNotes && myDays.length; k++) {
      const d = myDays[Math.floor(((k + 0.5) / nNotes) * myDays.length)];
      const kind: keyof typeof TXT.curatorNote = d.blowup || ((u.name === "Денис Ф." || u.name === "Игорь П.") && k % 2 === 0) ? "concern" : rng.pick(["note", "call", "praise", "note"] as const);
      cnRows.push([u.name, u.curator ?? RISK, rng.pick(TXT.curatorNote[kind]), kind, kind === "concern" && rng.chance(0.4), etTs(d.date, 17 * 3600)]);
    }
  }
  if (has("weekly_reviews")) await insertMany(c, "weekly_reviews", ["trader", "week", "week_start", "self_review", "curator_review", "goals", "status", "submitted_at", "reviewed_at"], wrRows, { casts: { self_review: "jsonb", curator_review: "jsonb", goals: "jsonb", submitted_at: "timestamptz", reviewed_at: "timestamptz" } });
  if (has("trader_ratings")) await insertMany(c, "trader_ratings", ["trader", "curator", "week", "discipline", "risk_management", "execution", "journaling", "improvement", "overall", "comment", "focus", "tier", "created_at", "acknowledged_at"], ratRows, { casts: { created_at: "timestamptz", acknowledged_at: "timestamptz" } });
  if (has("curator_notes")) await insertMany(c, "curator_notes", ["trader", "author", "body", "kind", "pinned", "created_at"], cnRows, { casts: { created_at: "timestamptz" } });

  // risk alerts from the generated day P&L (+ breach reviews for the worst days)
  const raRows: unknown[][] = [];
  for (const d of days) {
    const u = TRADERS.find((x) => x.name === d.trader)!;
    const lim = TIER[stageAt(u, d.date)!].daily;
    if (d.net <= -lim) raRows.push([d.trader, d.date, "stop", "breach", r2(-d.net), lim, `Дневной убыток ${r2(-d.net)}$ достиг лимита ${lim}$ — торговля на сегодня остановлена.`, etTs(d.date, 15 * 3600)]);
    else if (d.net <= -lim * 0.7) raRows.push([d.trader, d.date, "warn", "warn", r2(-d.net), lim, `Близко к стопу: убыток ${r2(-d.net)}$ из ${lim}$ дневного лимита.`, etTs(d.date, 14 * 3600)]);
  }
  if (has("risk_alert_log")) {
    const alerts = await insertMany(c, "risk_alert_log", ["trader", "date", "kind", "level", "used", "limit", "message", "created_at"], raRows, { returning: "id, trader, date, kind", casts: { created_at: "timestamptz" }, conflict: "ON CONFLICT (trader, date, kind) DO NOTHING" });
    if (has("risk_breach_reviews")) {
      const br = alerts.filter((a) => a.kind === "stop" && a.date >= "2025-09-01").filter((_, i) => i % 2 === 0).map((a) => {
        const blow = days.find((d) => d.trader === a.trader && d.date === a.date)?.blowup;
        return [a.id, a.trader, a.date, a.kind, blow ? rng.pick(["revenge", "tilt", "overtrading"]) : rng.pick(["news", "size", "no_stop", "other"]), blow ? "Продолжил торговать после лимита, увеличивал размер." : "Гэп против позиции / резкое движение.",
          JSON.stringify(blow ? [{ id: `a${a.id}`, title: "Пауза 2 дня и разбор с куратором", dueOn: nextDay(a.date), status: "done" }] : []), blow ? rng.pick(["warning", "reduced", "pause"]) : "none", RISK, RISK];
      });
      await insertMany(c, "risk_breach_reviews", ["alert_id", "trader", "date", "kind", "reason", "comment", "actions", "consequence", "created_by", "updated_by"], br, { casts: { actions: "jsonb" } });
    }
  }

  // personal trading rules (violations are written by the app's rules engine: POST /api/rules/scan)
  const ruleRows: unknown[][] = [];
  for (const u of TRADERS) {
    const st = stageAt(u, END)!;
    const t = TIER[st];
    if (st === "trainee" || st === "junior") {
      ruleRows.push([u.name, "Не больше 15 сделок в день", "max_trades_per_day", JSON.stringify({ n: 15 }), true, "personal", u.curator ?? MENTOR, "Против овертрейдинга"]);
      ruleRows.push([u.name, "Стоп после 3 убытков подряд", "no_trade_after_n_losses", JSON.stringify({ n: 3 }), true, "personal", u.curator ?? MENTOR, null]);
      ruleRows.push([u.name, "Без переноса через ночь", "no_overnight", "{}", true, "personal", RISK, "Джун/стажёр — только интрадей"]);
      ruleRows.push([u.name, "Не больше 3 входов в тикер", "max_trades_per_ticker_day", JSON.stringify({ n: 3 }), true, "personal", u.curator ?? MENTOR, null]);
    } else {
      ruleRows.push([u.name, `Дневной лимит ${t.daily}$`, "max_daily_loss_usd", JSON.stringify({ usd: t.daily }), true, "personal", RISK, null]);
      ruleRows.push([u.name, "Пауза 5 минут после убытка", "min_pause_after_loss", JSON.stringify({ minutes: 5 }), u.name !== "Сергей В.", "personal", u.name, null]);
    }
  }
  if (has("trading_rules")) await insertMany(c, "trading_rules", ["trader", "name", "kind", "threshold", "enabled", "origin", "created_by", "note"], ruleRows, { casts: { threshold: "jsonb" } });

  // trading errors, trade reviews by curators, reactions
  const errRows: unknown[][] = [], revRows: unknown[][] = [], reactRows: unknown[][] = [];
  const ERR_TYPES = ["Ранний вход", "Двигал стоп", "Овертрейдинг", "Реванш", "Большой размер", "Не по сетапу", "Поздний выход"];
  for (const d of days) {
    const u = TRADERS.find((x) => x.name === d.trader)!;
    const stage = stageAt(u, d.date)!;
    const academy = stage === "trainee" || stage === "junior";
    const r = new Rng(`soc:${d.trader}:${d.date}`);
    if (d.worst && d.worst.net < 0 && r.chance(academy ? 0.1 : 0.03)) {
      const et = d.blowup ? "Реванш" : r.pick(ERR_TYPES);
      errRows.push([d.trader, et, `${d.worst.underlying}: ${r.pick(TXT.mistakes)}`, d.worst.ticker, d.worst, d.blowup ? "high" : r.pick(["low", "medium", "medium", "high"]), r.pick(TXT.lessons), d.date < "2026-09-01" ? "yes" : "no", etTs(d.date, 17 * 3600)]);
    }
    if (academy && d.date >= "2025-09-01" && r.chance(0.18)) {
      const t = r.chance(0.5) ? d.worst! : d.best!;
      const rating = t.net > 0 ? r.pick(["excellent", "good", "good"]) : r.pick(["needs_work", "poor", "needs_work"]);
      revRows.push([t, u.mentor ?? MENTOR, t.net > 0 ? r.pick(["Хорошее исполнение, вход после подтверждения.", "Отлично зафиксировал частями.", "По плану — так и надо."]) : r.pick(["Вход до подтверждения — жди закрепления.", "Стоп слишком широкий для этого сетапа.", "Здесь не было сетапа, это FOMO.", "Размер больше плана."]), rating, etTs(nextDay(d.date), 8 * 3600 + r.int(0, 3600))]);
    }
    if (d.best && d.best.net > TIER[stage].daily * 0.8 && r.chance(0.5)) {
      for (const who of r.shuffle(DEMO_NAMES.filter((n) => n !== d.trader)).slice(0, r.int(1, 3))) reactRows.push([d.best, who, "like", etTs(d.date, 17 * 3600 + r.int(0, 7200))]);
    }
  }
  if (has("trading_errors")) await insertMany(c, "trading_errors", ["trader", "error_type", "description", "ticker", "trade_id", "severity", "lesson", "resolved", "created_at"], errRows.map((x) => [...x.slice(0, 4), (x[4] as any).id, ...x.slice(5)]), { casts: { created_at: "timestamptz" } });
  if (has("trade_reviews")) await insertMany(c, "trade_reviews", ["trade_id", "curator", "comment", "rating", "created_at"], revRows.map((x) => [(x[0] as any).id, ...x.slice(1)]), { casts: { created_at: "timestamptz" } });
  if (has("trade_reactions")) await insertMany(c, "trade_reactions", ["trade_id", "trader", "reaction_type", "created_at"], reactRows.map((x) => [(x[0] as any).id, ...x.slice(1)]), { casts: { created_at: "timestamptz" } });

  // discussions + comments + votes
  const THREADS: [string, string, string, string | null][] = [
    ["setup", "OPG на гэперах после отчёта — когда не входить", "Делюсь наблюдением: если премаркет-объём меньше 1М, OPG по гэперу чаще разворачивается в первые 5 минут.", null],
    ["analysis", "NVDA перед отчётом — уровни", "Ключевые уровни на завтра, смотрю реакцию на открытии.", "NVDA"],
    ["strategy", "MOC-имбалансы: статистика за квартал", "Свёл свои MOC-сделки: лучше всего работают имбалансы > 20% ADV в последние 10 минут.", null],
    ["risk", "Дневной лимит и перезаходы", "Заметил у себя: третий заход в тикер почти всегда в минус. Ввожу правило максимум 2 входа.", null],
    ["review_request", "Разберите сделку TSLA — стоп или нет?", "Вышел по стопу, а потом цена пошла в мою сторону. Стоп был слишком близко?", "TSLA"],
    ["general", "Кто торгует CPI завтра?", "Какой план на CPI? Я до 10:00 не торгую.", null],
    ["analysis", "Сектор полупроводников — ротация", "MU, AMD, AVGO сильнее рынка третий день подряд.", "MU"],
    ["setup", "Афтер-маркет на отчётах: мой чеклист", "Входить только после первых 5 минут после релиза, размер половина.", null],
    ["strategy", "Овернайт по PEAD — держать или нет", "Держу победителей отчёта через ночь, если закрылись у хая дня.", null],
    ["review_request", "Разбор дня: три стопа подряд", "Прошу посмотреть мои сделки за сегодня, не понимаю, где ошибка.", null],
    ["general", "Хоткеи для OPG/MOC — делитесь настройками", "Какие хоткеи стоят на отправку OPG и MOC?", null],
    ["analysis", "SPY на исторических максимумах", "Осторожно с шортами против рынка на этой неделе.", "SPY"],
    ["risk", "Размер после убытка", "Правило: после стопа — половина размера на следующую сделку.", null],
    ["setup", "Fade гэпа на COIN", "COIN гэпнул на 8%, на открытии отдал половину. Шортил от PMH.", "COIN"],
    ["general", "Итоги месяца по деску", "Месяц тяжёлый, но лимиты все соблюдали. Молодцы.", null],
  ];
  const COMMENTS = ["Согласен, у меня так же.", "Спасибо, полезно!", "А какой стоп ставишь?", "Я бы подождал подтверждения.", "Попробую завтра.", "Есть статистика по этому?", "У меня обратный опыт.", "Хорошее наблюдение.", "+1, добавлю в плейбук.", "Смотри на объём в премаркете.", "Стоп был нормальный, проблема во входе.", "Лучше уменьшить размер, чем расширять стоп."];
  const dRows: unknown[][] = [];
  const threadMeta: { author: string; date: string }[] = [];
  THREADS.forEach(([type, topic, notes, ticker], i) => {
    const author = TRADERS[(i * 5 + 3) % TRADERS.length].name;
    const u = TRADERS.find((x) => x.name === author)!;
    const span = DAYS.filter((d) => d >= firstDay(u) && d >= "2025-06-01");
    const date = span[Math.floor(((i + 1) / (THREADS.length + 1)) * span.length)];
    threadMeta.push({ author, date });
    dRows.push([topic, type, author, notes, ticker, ticker ? `${ticker}` : null, etTs(date, 12 * 3600 + i * 120)]);
  });
  if (has("discussions")) {
    const th = await insertMany(c, "discussions", ["topic", "type", "trader", "notes", "ticker", "tags", "created_at"], dRows, { returning: "id", casts: { created_at: "timestamptz" } });
    const cm: unknown[][] = [], votes: unknown[][] = [];
    th.forEach((t, i) => {
      const r = new Rng(`thr:${i}`);
      const n = r.int(2, 7);
      for (let k = 0; k < n; k++) {
        const who = r.pick(DEMO_NAMES.filter((x) => x !== threadMeta[i].author));
        cm.push([t.id, who, r.pick(COMMENTS), etTs(threadMeta[i].date, 12 * 3600 + 600 + k * r.int(120, 1800))]);
      }
      for (const who of r.shuffle(DEMO_NAMES.filter((x) => x !== threadMeta[i].author)).slice(0, r.int(1, 6))) votes.push([t.id, who, r.chance(0.88) ? 1 : -1]);
    });
    await insertMany(c, "comments", ["discussion_id", "trader", "text", "created_at"], cm, { casts: { created_at: "timestamptz" } });
    if (has("discussion_votes")) await insertMany(c, "discussion_votes", ["discussion_id", "trader", "value"], votes);
  }

  // trade ideas (published by traders), reactions/comments
  if (has("trade_ideas")) {
    const iRows: unknown[][] = [];
    const ideaMeta: { trader: string; date: string }[] = [];
    for (let i = 0; i < 70; i++) {
      const u = TRADERS[i % TRADERS.length];
      const r = new Rng(`idea:${i}`);
      const span = DAYS.filter((d) => d >= firstDay(u) && d >= "2025-09-01");
      if (!span.length) continue;
      const date = span[r.int(0, span.length - 1)];
      const tks = u.persona!.universe.filter((x) => mkt(x, date));
      if (!tks.length) continue;
      const tk = r.pick(tks);
      const dm = mkt(tk, date)!;
      const px = dm.c; // the real close of the idea day
      const side = r.chance(u.persona!.shortBias) ? "Short" : "Long";
      const d2 = side === "Long" ? 1 : -1;
      const setup = r.weighted(Object.fromEntries(u.persona!.setups) as Record<string, number>);
      ideaMeta.push({ trader: u.name, date });
      iRows.push([tk, side, setup, `${r2(px - dm.atr * 0.05)}–${r2(px + dm.atr * 0.05)}`, String(r2(px + d2 * dm.atr * 0.8)), String(r2(px - d2 * dm.atr * 0.3)),
        r.pick(["Гэп на отчёте, сильный объём в премаркете.", "Пробой уровня недели, сектор сильный.", "Слабость против рынка, шорт от VWAP.", "Имбаланс на закрытии в сторону покупок.", "Откат к VWAP в тренде."]),
        r.int(45, 92), date < "2026-10-14" ? "published" : r.pick(["draft", "published"]), u.name, pbId.get(setup) ?? null,
        etTs(date, 8 * 3600 + r.int(0, 3600)), etTs(date, 8 * 3600 + r.int(0, 3600)), date, T[tk].sector, T[tk].name, r2(TIER[stageAt(u, date)!].risk * 0.8), r.pick(["A", "B", "A+"]), r.pick(["intraday", "intraday", "overnight"])]);
    }
    const ideas = await insertMany(c, "trade_ideas", ["ticker", "side", "setup", "entry_zone", "target", "stop", "thesis", "score", "status", "trader", "playbook_id", "published_at", "created_at", "idea_date", "sector", "long_name", "risk_amount", "setup_quality", "horizon"], iRows,
      { returning: "id", casts: { published_at: "timestamptz", created_at: "timestamptz" } });
    const ir: unknown[][] = [], ic: unknown[][] = [];
    ideas.forEach((idea, i) => {
      const r = new Rng(`idear:${i}`);
      for (const who of r.shuffle(DEMO_NAMES.filter((x) => x !== ideaMeta[i].trader)).slice(0, r.int(0, 4))) ir.push([idea.id, who, r.pick(["thumbs_up", "thumbs_up", "thumbs_up", "warning", "thumbs_down"]), r.chance(0.3) ? r.pick(COMMENTS) : null, etTs(ideaMeta[i].date, 9 * 3600 + r.int(0, 1800))]);
      if (r.chance(0.4)) ic.push([idea.id, r.pick([MENTOR, RISK, "Алексей М.", "Сергей В."]), r.pick(["Стоп маловат для этого ATR.", "Хорошая идея, смотри объём на открытии.", "Цель реалистичная.", "Против рынка — осторожно."]), false, "website", etTs(ideaMeta[i].date, 9 * 3600 + r.int(1800, 3600))]);
    });
    if (has("trade_idea_reactions")) await insertMany(c, "trade_idea_reactions", ["trade_idea_id", "trader", "reaction", "comment", "created_at"], ir, { casts: { created_at: "timestamptz" } });
    if (has("trade_idea_comments")) await insertMany(c, "trade_idea_comments", ["idea_id", "author_name", "text", "is_private", "source", "created_at"], ic, { casts: { created_at: "timestamptz" } });
  }

  // playbook examples: the best by-the-book winners (R ≥ 1, no blow-up day) per trader × setup, tiered 1 (эталон) → 3
  if (has("playbook_examples")) {
    const blowDays = new Set(days.filter((d) => d.blowup).map((d) => `${d.trader}|${d.date}`));
    const per: Record<StageKey, [number, number]> = { senior: [4, 6], trader: [3, 4], junior: [1, 2], trainee: [0, 1] };
    const ex: unknown[][] = [];
    const exRng = new Rng("examples");
    const groups = new Map<string, GenTrade[]>();
    for (const t of trades) {
      if (!t.byTheBook || t.net <= 0 || t.isOpt || blowDays.has(`${t.trader}|${t.date}`) || t.plannedRisk <= 0 || t.net / t.plannedRisk < 1) continue;
      const k = `${t.trader}|${t.setup}`; const l = groups.get(k) ?? []; l.push(t); groups.set(k, l);
    }
    for (const [k, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [trader, setup] = k.split("|");
      const u = TRADERS.find((x) => x.name === trader)!;
      const [lo, hi] = per[stageAt(u, END)!];
      const n = Math.min(list.length, exRng.int(lo, hi));
      if (!n) continue;
      const best = [...list].sort((a, b) => b.net / b.plannedRisk - a.net / a.plannedRisk).slice(0, n);
      const pe = personal.find((p) => p.name === setup);
      best.forEach((t, i) => {
        const marks = pe ? JSON.stringify(Object.fromEntries(pe.items.map((it) => [it.id, true]))) : null;
        const note = i === 0 ? `Эталон: ${t.underlying} ${t.side === "Long" ? "лонг" : "шорт"}, +${(t.net / t.plannedRisk).toFixed(1)}R по плану` : i === 1 ? "Чистое исполнение, стоп и цель по плану" : null;
        ex.push([pbId.get(setup), (t as any).id, i === 0 ? 1 : i < 3 ? 2 : 3, note, marks, i, u.mentor ? MENTOR : trader, etTs(t.closedAt.slice(0, 10), 17 * 3600 + i * 60)]);
      });
    }
    await insertMany(c, "playbook_examples", ["playbook_id", "trade_id", "tier", "note", "checklist_marks", "sort_order", "added_by", "created_at"], ex, { casts: { checklist_marks: "jsonb", created_at: "timestamptz" } });
    summary.push(`playbook_examples: ${ex.length} (tier 1: ${ex.filter((x) => x[2] === 1).length}, tier 2: ${ex.filter((x) => x[2] === 2).length}, tier 3: ${ex.filter((x) => x[2] === 3).length}) across ${new Set(ex.map((x) => x[0])).size} playbook entries; personal entries: ${personal.length}`);
  }

  // checklist completions (pre-trade checklist) for academy people
  if (has("pre_trade_checklist_responses")) {
    const { rows: items } = await c.query(`SELECT id FROM pre_trade_checklist_template WHERE active ORDER BY sort_order, id`);
    const ck: unknown[][] = [];
    for (const t of trades) {
      const u = TRADERS.find((x) => x.name === t.trader)!;
      if (!u.mentor || t.date < "2026-03-01") continue;
      const r = new Rng(`ck:${t.externalId}`);
      if (!r.chance(0.12)) continue;
      const resp = Object.fromEntries(items.map((it: any) => [String(it.id), r.chance(0.85)]));
      ck.push([t.ticker, t.date, t.trader, (t as any).id, JSON.stringify(resp), Object.values(resp).every(Boolean), etTs(t.date, Math.max(4 * 3600, Number(t.openedAt.slice(11, 13)) * 3600 + Number(t.openedAt.slice(14, 16)) * 60 - 120))]);
    }
    await insertMany(c, "pre_trade_checklist_responses", ["ticker", "trade_date", "trader", "trade_id", "responses", "passed", "created_at"], ck, { casts: { created_at: "timestamptz" } });
  }

  // ── summary
  console.log("\n=== DEMO OFFICE SEEDED ===");
  console.log(summary.join("\n"));
  console.log("\nUsers:");
  for (const u of users) {
    const du = USERS.find((x) => x.name === u.name)!;
    const st = du.stages ? stageAt(du, END) : null;
    console.log(`  #${u.id}  ${u.name.padEnd(13)} role=${u.role.padEnd(8)} stage=${st ? STAGE_RU[st] : "—"}${du.mentor ? `  mentor=${du.mentor}` : ""}`);
  }
  printStats(trades);
  console.log(`Content: journal_days ${jRows.length}, eod_days ${eodRows.length}, junior_notes ${jnRows.length}, emotional_state ${emoRows.length}, weekly_reviews ${wrRows.length}, ratings ${ratRows.length}, curator_notes ${cnRows.length}, risk_alerts ${raRows.length}, rules ${ruleRows.length}, errors ${errRows.length}, trade_reviews ${revRows.length}, challenges ${chRows.length}`);
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tStart = Date.now();
  let gen: { trades: GenTrade[]; days: DayStat[] } | null = null;
  if (!UNSEED_ONLY) {
    await loadMarket();
    const tg = Date.now();
    gen = generateTrades();
    console.log(`[seed-demo] generated ${gen.trades.length} trades on ${gen.days.length} trader-days (${((Date.now() - tg) / 1000).toFixed(1)}s)`);
    verifyFills(gen.trades);
    if (DRY) {
      printSpotChecks(gen.trades);
      printStats(gen.trades);
      console.log(`\n[seed-demo] --dry: nothing written. ${((Date.now() - tStart) / 1000).toFixed(1)}s`);
      return;
    }
  }
  const pool = new pg.Pool({ connectionString: DB_URL, max: 2 });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const removed = await unseed(c);
    const total = Object.values(removed).reduce((a, b) => a + b, 0);
    console.log(`[seed-demo] removed previous demo rows: ${total}${total ? " — " + Object.entries(removed).map(([k, v]) => `${k}:${v}`).join(", ") : ""}`);
    if (!UNSEED_ONLY) {
      const { rows } = await c.query(`SELECT name FROM users WHERE name = ANY($1::text[])`, [DEMO_NAMES]);
      if (rows.length) throw new Error(`demo names already used by non-demo users: ${rows.map((r) => r.name).join(", ")}`);
      await seed(c, gen!.trades, gen!.days);
    }
    await c.query("COMMIT");
    console.log(UNSEED_ONLY ? "[seed-demo] unseed complete." : `\n[seed-demo] done in ${((Date.now() - tStart) / 1000).toFixed(1)}s (Yahoo requests this run: ${requestCount}). Next: POST /api/rules/scan for the demo traders (violations come from the app's rules engine).`);
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    console.error("[seed-demo] FAILED, rolled back:", e instanceof Error ? e.stack : e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

void main();
