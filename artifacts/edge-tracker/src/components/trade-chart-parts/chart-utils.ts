/**
 * Pure helpers for TradeChart: exchange-time (ET) classification, VWAP,
 * execution placement, excursion (MFE/MAE) and theme colour resolution.
 */
import { useEffect, useState } from "react";
import type { UTCTimestamp, Time } from "lightweight-charts";
import { fmtDate } from "@/lib/format";
import { chartI18n } from "@/i18n/ns/chart";

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export type SessionLevels = {
  pmHigh: number | null;
  pmLow: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
};

export type CandlesResponse = {
  ticker: string;
  date: string;
  interval: string;
  candles: Candle[];
  prevClose: number | null;
  cached?: boolean;
  daysBack?: number;
  /** Present when requested with levels=1 on a server that supports it. */
  sessionLevels?: SessionLevels | null;
};

export type ExecutionKind = "entry" | "add" | "trim" | "exit" | "stop";

export type Execution = {
  id: number;
  tradeId: number;
  kind: ExecutionKind;
  /** Recognised role (Вход / Перезаход / Переворот / Добор / Частичный фикс / Выход / Стоп), when the API sent one. */
  role?: import("@/components/chart-engine/types").TradeRole | null;
  roleInferred?: boolean;
  price: string;
  qty: string | null;
  executedAt: string | null;
  note: string | null;
  sortOrder: number;
};

export type ExecutionsResponse = { tradeId: number; executions: Execution[] };

// ── ET time ────────────────────────────────────────────────────────────────
const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
});
// Display labels follow the UI language (resolved at call time); the zone is always New York.
const NY = { timeZone: "America/New_York" };
/** "15:55" (ET). */
export function fmtEtTime(d: Date): string {
  return fmtDate(d, "time", NY);
}
/** "15 окт." (ET). */
export function fmtEtDay(d: Date): string {
  return fmtDate(d, "dayMonth", NY);
}

export function timeToDate(time: Time): Date | null {
  return typeof time === "number" ? new Date(time * 1000) : null;
}
export function fmtEtDateTime(d: Date): string {
  return `${fmtEtDay(d)} ${fmtEtTime(d)} ET`;
}
/** "15:55:35" (ET). Accepts a Date, an ISO string or epoch seconds. */
export function fmtEtTimeSec(v: Date | string | number | null | undefined): string {
  const d = v == null ? null : v instanceof Date ? v : typeof v === "number" ? new Date(v * 1000) : new Date(v);
  if (!d || Number.isNaN(d.getTime())) return "—";
  // HH:MM:SS New York — fills carry seconds (PropReports), bars do not.
  return fmtDate(d, "timeSeconds", NY);
}
/** "15 окт. 15:55:35 ET". */
export function fmtEtDateTimeSec(v: Date | string | number | null | undefined): string {
  const d = v == null ? null : v instanceof Date ? v : typeof v === "number" ? new Date(v * 1000) : new Date(v);
  if (!d || Number.isNaN(d.getTime())) return "—";
  return `${fmtEtDay(d)} ${fmtDate(d, "timeSeconds", NY)} ET`;
}

/**
 * Human duration from seconds: «11 с», «1 мин 11 с», «1 ч 05 мин», «2 дн 3 ч». Hold times of scalps are
 * well under a minute, so the minute-only format («1m», «0 мин») hid the real number.
 */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  const t = chartI18n.t;
  if (s < 60) return t("dur.s", { s });
  if (s < 3600) { const m = Math.floor(s / 60), r = s % 60; return r ? t("dur.ms", { m, s: r }) : t("dur.m", { m }); }
  if (s < 86400) { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return m ? t("dur.hm", { h, m: String(m).padStart(2, "0") }) : t("dur.h", { h }); }
  const d = Math.floor(s / 86400), h = Math.round((s % 86400) / 3600);
  return h ? t("dur.dh", { d, h }) : t("dur.d", { d });
}

export type EtSession = "premarket" | "regular" | "postmarket" | "closed";
/** Session names in the UI language (getters: every read follows the current language). */
export const ET_SESSION_LABEL: Readonly<Record<EtSession, string>> = {
  get premarket() { return chartI18n.t("session.premarket"); },
  get regular() { return chartI18n.t("session.regular"); },
  get postmarket() { return chartI18n.t("session.postmarket"); },
  get closed() { return chartI18n.t("session.closed"); },
};
/** Session of an instant by New York wall clock: 04:00–09:30 premarket, 09:30–16:00 regular, 16:00–20:00 postmarket. */
export function sessionOfEt(v: Date | string | number | null | undefined): EtSession | null {
  const d = v == null ? null : v instanceof Date ? v : typeof v === "number" ? new Date(v * 1000) : new Date(v);
  if (!d || Number.isNaN(d.getTime())) return null;
  const info = etInfo(Math.floor(d.getTime() / 1000));
  if (isRegularHours(info)) return "regular";
  if (isPreMarket(info)) return "premarket";
  if (isAfterHours(info)) return "postmarket";
  return "closed";
}

/**
 * ET wall clock ("YYYY-MM-DD" + "HH:MM[:SS]") → ISO instant. Independent of the browser
 * time zone, so an execution typed as 09:35 is 09:35 New York whatever the trader's laptop says.
 * Returns null for unparsable input.
 */
export function etWallToIso(dateStr: string, timeStr: string): string | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr ?? "");
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(timeStr ?? "");
  if (!dm || !tm) return null;
  const y = +dm[1], mo = +dm[2], d = +dm[3], h = +tm[1], mi = +tm[2], s = tm[3] ? +tm[3] : 0;
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  // Two passes handle the DST switch days.
  for (let i = 0; i < 2; i++) {
    const p: Record<string, string> = {};
    for (const x of ET_FMT.formatToParts(new Date(guess))) p[x.type] = x.value;
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, s);
    const target = Date.UTC(y, mo - 1, d, h, mi, s);
    const diff = target - wall;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess).toISOString();
}

export type EtInfo = { dayKey: string; hour: number; minute: number };

const etCache = new Map<number, EtInfo>();
export function etInfo(epochSec: number): EtInfo {
  const hit = etCache.get(epochSec);
  if (hit) return hit;
  const parts = ET_FMT.formatToParts(new Date(epochSec * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const info = {
    dayKey: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
  };
  if (etCache.size > 20000) etCache.clear();
  etCache.set(epochSec, info);
  return info;
}

export function isRegularHours(info: EtInfo): boolean {
  if (info.hour < 9 || info.hour >= 16) return false;
  if (info.hour === 9 && info.minute < 30) return false;
  return true;
}
export function isPreMarket(info: EtInfo): boolean {
  if (info.hour < 4) return false;
  if (info.hour < 9) return true;
  return info.hour === 9 && info.minute < 30;
}
export function isAfterHours(info: EtInfo): boolean {
  return info.hour >= 16 && info.hour < 20;
}

export function toNum(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function ageDaysOf(date: string): number {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return 0;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}

/** Session VWAP: regular hours only, resets every day at 9:30 ET. */
export function computeSessionVwap(candles: Candle[]): { time: UTCTimestamp; value: number }[] {
  const out: { time: UTCTimestamp; value: number }[] = [];
  let cumPV = 0;
  let cumV = 0;
  let currentDay = "";
  for (const c of candles) {
    const info = etInfo(c.t);
    if (!isRegularHours(info)) continue;
    if (info.dayKey !== currentDay) {
      cumPV = 0;
      cumV = 0;
      currentDay = info.dayKey;
    }
    const typical = (c.h + c.l + c.c) / 3;
    const v = Number.isFinite(c.v) ? c.v : 0;
    cumPV += typical * v;
    cumV += v;
    if (cumV > 0) out.push({ time: c.t as UTCTimestamp, value: cumPV / cumV });
  }
  return out;
}

/** Trade-day levels computed on the client (fallback when the API has no sessionLevels). */
export function computeDayLevels(candles: Candle[], dayKey: string): SessionLevels {
  let pmHigh: number | null = null, pmLow: number | null = null;
  let open: number | null = null, high: number | null = null, low: number | null = null, close: number | null = null;
  for (const c of candles) {
    const info = etInfo(c.t);
    if (info.dayKey !== dayKey) continue;
    if (isPreMarket(info)) {
      pmHigh = pmHigh == null ? c.h : Math.max(pmHigh, c.h);
      pmLow = pmLow == null ? c.l : Math.min(pmLow, c.l);
    } else if (isRegularHours(info)) {
      if (open == null) open = c.o;
      high = high == null ? c.h : Math.max(high, c.h);
      low = low == null ? c.l : Math.min(low, c.l);
      close = c.c;
    }
  }
  return { pmHigh, pmLow, open, high, low, close };
}

// ── Execution placement ────────────────────────────────────────────────────
export type Resolved = { exec: Execution; price: number; candle: Candle; idx: number; /** Fill instant (epoch s) when the execution is timed. */ at: number | null };

/** Bar length in seconds inferred from the smallest gap between consecutive bars (60 for 1m, 300 for 5m…). */
export function inferBarSeconds(candles: Candle[]): number {
  let best = Infinity;
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].t - candles[i - 1].t;
    if (d > 0 && d < best) best = d;
  }
  return Number.isFinite(best) ? best : 60;
}

/**
 * Index of the bar that CONTAINS the instant (bar.t ≤ ts < bar.t + barSeconds). A 15:55:35 fill belongs to the
 * 15:55 bar — the old «nearest bar start» rule put it on the 15:56 bar, one bar after the price was actually paid.
 * Falls back to the last bar that opened before the instant, then to the nearest bar (gaps, halts, first bar).
 */
export function containingBarIndex(candles: Candle[], ts: number, barSeconds: number): number {
  if (!candles.length) return -1;
  let lo = 0, hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles[mid].t <= ts) lo = mid; else hi = mid - 1;
  }
  if (candles[lo].t <= ts && ts < candles[lo].t + barSeconds) return lo;
  if (candles[lo].t <= ts) {
    // Instant falls in a hole (halt / missing bar): the fill still happened after this bar opened — unless the
    // next bar starts within one bar length (rounding), in which case the next bar is the closer description.
    const next = lo + 1 < candles.length ? candles[lo + 1] : null;
    if (next && next.t - ts < ts - (candles[lo].t + barSeconds)) return lo + 1;
    return lo;
  }
  return lo; // ts before the first bar
}

/** Map executions to candles in chronological order (containing bar if timed, else first price match after cursor). */
export function resolveExecutions(candles: Candle[], execs: Execution[]): Resolved[] {
  if (!candles.length || !execs.length) return [];
  const sorted = [...execs].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const out: Resolved[] = [];
  const lastIdx = candles.length - 1;
  const barSeconds = inferBarSeconds(candles);
  let cursor = 0;
  for (const exec of sorted) {
    const price = Number(exec.price);
    if (!Number.isFinite(price)) continue;

    if (exec.executedAt) {
      const ms = new Date(exec.executedAt).getTime();
      if (Number.isFinite(ms)) {
        const ts = Math.floor(ms / 1000);
        const idx = containingBarIndex(candles, ts, barSeconds);
        out.push({ exec, price, candle: candles[idx], idx, at: ts });
        cursor = Math.max(cursor, Math.min(idx + 1, lastIdx));
        continue;
      }
    }

    const start = Math.min(cursor, lastIdx);
    let foundIdx = -1;
    for (let i = start; i < candles.length; i++) {
      const c = candles[i];
      if (price >= c.l && price <= c.h) { foundIdx = i; break; }
    }
    if (foundIdx === -1) {
      let bestIdx = start;
      let bestDist = Math.abs((candles[start].h + candles[start].l) / 2 - price);
      for (let i = start + 1; i < candles.length; i++) {
        const d = Math.abs((candles[i].h + candles[i].l) / 2 - price);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      foundIdx = bestIdx;
    }
    out.push({ exec, price, candle: candles[foundIdx], idx: foundIdx, at: null });
    cursor = Math.min(foundIdx + 1, lastIdx);
  }
  return out;
}

/** Fallback placement for a simple entry/exit trade (no executions logged). */
export function placeSimple(candles: Candle[], dayKey: string, entry: number | null, exit: number | null): { entryIdx: number | null; exitIdx: number | null } {
  if (!candles.length) return { entryIdx: null, exitIdx: null };
  // Prefer bars from the trade day itself (multi-day context may be loaded).
  let first = candles.findIndex((c) => etInfo(c.t).dayKey === dayKey);
  if (first < 0) first = 0;
  let entryIdx: number | null = null;
  let exitIdx: number | null = null;
  if (entry != null) {
    const m = candles.findIndex((c, i) => i >= first && entry >= c.l && entry <= c.h);
    entryIdx = m >= 0 ? m : first;
  }
  if (exit != null) {
    const from = entryIdx ?? first;
    let m = -1;
    for (let i = from + (entryIdx != null ? 1 : 0); i < candles.length; i++) {
      const c = candles[i];
      if (exit >= c.l && exit <= c.h) { m = i; break; }
    }
    exitIdx = m >= 0 ? m : candles.length - 1;
  }
  return { entryIdx, exitIdx };
}

export type Excursion = {
  /** Max favourable move per share from entry (≥0). */
  mfe: number;
  /** Max adverse move per share from entry (≥0). */
  mae: number;
  /** Favourable move after the exit until the end of the loaded data (≥0), null when no exit. */
  afterExit: number | null;
};

/**
 * Known price path inside a bar in which the position opens and/or closes (mirror of the server's
 * effectiveBarRange in lib/tradeQuality.ts): we cannot see the intrabar sequence, so only what is certain
 * counts — the bar's open if we were already in position when it opened, the fill prices themselves, and
 * the bar's close if we were still in position when it closed. The full high/low of the entry bar would
 * otherwise charge the trader with a low that printed BEFORE the fill (the «MAE 0.32 through 0 min» bug).
 */
export function partialBarRange(c: Candle, openAtStart: boolean, openAtEnd: boolean, fillPrices: number[]): { hi: number; lo: number } {
  if (openAtStart && openAtEnd && !fillPrices.length) return { hi: c.h, lo: c.l };
  const pts = [...fillPrices];
  if (openAtStart) pts.push(c.o);
  if (openAtEnd) pts.push(c.c);
  if (!pts.length) return { hi: c.h, lo: c.l };
  return { hi: Math.max(...pts), lo: Math.min(...pts) };
}

export function computeExcursion(
  candles: Candle[], entryIdx: number, exitIdx: number | null, entry: number, exit: number | null, isShort: boolean, dayKey: string,
  /** Fill instants (epoch s) when known: enables the partial-bar rule on the entry/exit bars. */
  fillTimes?: { entryAt: number | null; exitAt: number | null },
): Excursion {
  const end = exitIdx ?? candles.length - 1;
  const timed = fillTimes != null && fillTimes.entryAt != null && (exitIdx == null || fillTimes.exitAt != null);
  let hi = -Infinity, lo = Infinity;
  for (let i = entryIdx; i <= end && i < candles.length; i++) {
    const c = candles[i];
    let h = c.h, l = c.l;
    if (timed && (i === entryIdx || i === end)) {
      const fills: number[] = [];
      if (i === entryIdx) fills.push(entry);
      if (i === end && exitIdx != null && exit != null) fills.push(exit);
      const openAtStart = i !== entryIdx;
      const openAtEnd = !(i === end && exitIdx != null);
      ({ hi: h, lo: l } = partialBarRange(c, openAtStart, openAtEnd, fills));
    }
    hi = Math.max(hi, h);
    lo = Math.min(lo, l);
  }
  const mfe = Math.max(0, isShort ? entry - lo : hi - entry);
  const mae = Math.max(0, isShort ? hi - entry : entry - lo);
  let afterExit: number | null = null;
  if (exitIdx != null && exit != null) {
    let h2 = -Infinity, l2 = Infinity;
    for (let i = exitIdx + 1; i < candles.length; i++) {
      if (etInfo(candles[i].t).dayKey !== dayKey) continue;
      h2 = Math.max(h2, candles[i].h);
      l2 = Math.min(l2, candles[i].l);
    }
    if (Number.isFinite(h2)) afterExit = Math.max(0, isShort ? exit - l2 : h2 - exit);
    else afterExit = 0;
  }
  return { mfe, mae, afterExit };
}

// ── Theme colours ──────────────────────────────────────────────────────────
function hslTripletToRgb(triplet: string): [number, number, number] | null {
  const m = triplet.trim().match(/^(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/);
  if (!m) return null;
  const h = ((Number(m[1]) % 360) + 360) % 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export type ChartTheme = {
  up: (a?: number) => string;
  down: (a?: number) => string;
  primary: (a?: number) => string;
  c1: (a?: number) => string;
  c3: (a?: number) => string;
  c5: (a?: number) => string;
  fg: (a?: number) => string;
  muted: (a?: number) => string;
  border: (a?: number) => string;
  font: string;
  dark: boolean;
};

export function readChartTheme(): ChartTheme {
  const root = typeof document !== "undefined" ? document.documentElement : null;
  const cs = root ? getComputedStyle(root) : null;
  const make = (name: string, fallback: [number, number, number]) => {
    const rgb = (cs && hslTripletToRgb(cs.getPropertyValue(name))) || fallback;
    return (a = 1) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
  };
  const font = (typeof document !== "undefined" && getComputedStyle(document.body).fontFamily) || "Inter, system-ui, sans-serif";
  return {
    up: make("--up", [76, 195, 138]),
    down: make("--down", [240, 106, 106]),
    primary: make("--primary", [10, 132, 255]),
    c1: make("--chart-1", [51, 153, 255]),
    c3: make("--chart-3", [227, 193, 74]),
    c5: make("--chart-5", [169, 139, 216]),
    fg: make("--foreground", [235, 236, 238]),
    muted: make("--muted-foreground", [160, 164, 170]),
    border: make("--border", [44, 46, 50]),
    font,
    dark: !!root?.classList.contains("dark"),
  };
}

/** Re-renders when the html class (theme) changes. */
export function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const root = document.documentElement;
    const obs = new MutationObserver(() => setV((x) => x + 1));
    obs.observe(root, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    return () => obs.disconnect();
  }, []);
  return v;
}

// ── Prefs (localStorage, best effort) ──────────────────────────────────────
export type ChartPrefs = {
  vwap: boolean;
  levels: boolean;
  rLevels: boolean;
  volume: boolean;
  adds: boolean;
  extended: boolean;
  daysBack: number;
  tall: boolean;
};

/** The whole trading day by default: premarket 4:00 → after-hours 20:00 ET (pre/post on). */
export const DEFAULT_PREFS: ChartPrefs = {
  vwap: true, levels: true, rLevels: true, volume: true, adds: false, extended: true, daysBack: 0, tall: false,
};
const PREFS_KEY = "trade-chart-prefs-v3";
/** v2 saved `extended: false` for everyone (the old default); v3 keeps the other choices and starts on the full day. */
const PREFS_KEY_V2 = "trade-chart-prefs-v2";

export function loadPrefs(): ChartPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) {
      const old = localStorage.getItem(PREFS_KEY_V2);
      const p = old ? JSON.parse(old) : null;
      return { ...DEFAULT_PREFS, ...(p && typeof p === "object" ? p : {}), extended: true };
    }
    const p = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...(p && typeof p === "object" ? p : {}) };
  } catch {
    return DEFAULT_PREFS;
  }
}
export function savePrefs(p: ChartPrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}

