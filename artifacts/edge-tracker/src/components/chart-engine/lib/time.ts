/**
 * New-York time helpers (DST-correct via Intl). Pure: no React, no DOM.
 * Candle times are UTC epoch seconds; everything the trader sees is ET.
 */
import { fmtDate, fmtDateCustom } from "@/lib/format";
import { chartI18n } from "@/i18n/ns/chart";
import type { Candle, Session } from "../types";

export const ET_TZ = "America/New_York";

const PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TZ, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
});

export type EtParts = {
  dayKey: string;
  hour: number;
  minute: number;
  second: number;
  /** Minutes since ET midnight. */
  mod: number;
  /** 0 = Sunday. */
  weekday: number;
};

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const cache = new Map<number, EtParts>();

/** ET wall-clock parts for an epoch second (memoised — the chart asks for the same bars again and again). */
export function etParts(epochSec: number): EtParts {
  const hit = cache.get(epochSec);
  if (hit) return hit;
  const parts = PARTS_FMT.formatToParts(new Date(epochSec * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const out: EtParts = {
    dayKey: `${get("year")}-${get("month")}-${get("day")}`,
    hour, minute, second: Number(get("second")),
    mod: hour * 60 + minute,
    weekday: WD[get("weekday")] ?? 0,
  };
  if (cache.size > 50000) cache.clear();
  cache.set(epochSec, out);
  return out;
}

export const RTH_OPEN_MIN = 9 * 60 + 30;
export const RTH_CLOSE_MIN = 16 * 60;
export const PRE_OPEN_MIN = 4 * 60;
export const POST_CLOSE_MIN = 20 * 60;

export function sessionOfMinutes(mod: number): Session {
  if (mod >= RTH_OPEN_MIN && mod < RTH_CLOSE_MIN) return "rth";
  if (mod >= PRE_OPEN_MIN && mod < RTH_OPEN_MIN) return "pre";
  if (mod >= RTH_CLOSE_MIN && mod < POST_CLOSE_MIN) return "post";
  return "closed";
}

export function sessionOf(epochSec: number): Session {
  return sessionOfMinutes(etParts(epochSec).mod);
}

export function etDayKey(epochSec: number): string {
  return etParts(epochSec).dayKey;
}

/**
 * ET wall clock → epoch seconds, DST-correct (two passes handle the switch days).
 * `dayKey` is YYYY-MM-DD in New York.
 */
export function etWallToEpoch(dayKey: string, hour: number, minute: number, second = 0): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dayKey);
  if (!m) return NaN;
  const y = +m[1], mo = +m[2], d = +m[3];
  const target = Date.UTC(y, mo - 1, d, hour, minute, second);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = etParts(Math.floor(guess / 1000));
    const pm = /^(\d{4})-(\d{2})-(\d{2})/.exec(p.dayKey)!;
    const wall = Date.UTC(+pm[1], +pm[2] - 1, +pm[3], p.hour, p.minute, p.second);
    const diff = target - wall;
    if (diff === 0) break;
    guess += diff;
  }
  return Math.floor(guess / 1000);
}

/** Epoch seconds of an ISO instant (as stored in executions.executedAt). NaN when unparsable. */
export function isoToEpoch(iso: string | null | undefined): number {
  if (!iso) return NaN;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}

// ── Formatting ─────────────────────────────────────────────────────────────
// Display labels follow the UI language (resolved at call time); the zone is always New York.
const ET = { timeZone: ET_TZ };
export function fmtEtTime(epochSec: number, withSeconds = false): string {
  return fmtDate(epochSec * 1000, withSeconds ? "timeSeconds" : "time", ET);
}
export function fmtEtDay(epochSec: number): string {
  return fmtDate(epochSec * 1000, "dayMonth", ET);
}
export function fmtEtDayFull(epochSec: number): string {
  return fmtDate(epochSec * 1000, "short", ET);
}
export function fmtEtDateTime(epochSec: number, withSeconds = false): string {
  return `${fmtEtDay(epochSec)} ${fmtEtTime(epochSec, withSeconds)} ET`;
}

/**
 * Tick label for the lightweight-charts time axis. `tickMarkType`: 0 Year, 1 Month, 2 DayOfMonth, 3 Time, 4 TimeWithSeconds
 * (the numeric values of the TickMarkType enum — kept numeric so this file does not import the library).
 */
export function tickMarkLabel(epochSec: number, tickMarkType: number): string {
  const ms = epochSec * 1000;
  switch (tickMarkType) {
    case 0: return fmtDateCustom(ms, { timeZone: ET_TZ, year: "numeric" });
    case 1: return fmtDateCustom(ms, { timeZone: ET_TZ, month: "short", year: "2-digit" });
    case 2: return fmtDate(ms, "dayMonth", ET);
    case 4: return fmtDate(ms, "timeSeconds", ET);
    default: return fmtDate(ms, "time", ET);
  }
}

/** «1 мин 11 с», «2 ч 05 мин», «3 дн 4 ч». Negative → with a leading «−». */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const neg = seconds < 0;
  let s = Math.round(Math.abs(seconds));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  let out: string;
  if (d > 0) out = chartI18n.t("dur.dh", { d, h });
  else if (h > 0) out = chartI18n.t("dur.hm", { h, m: String(m).padStart(2, "0") });
  else if (m > 0) out = chartI18n.t("dur.ms", { m, s });
  else out = chartI18n.t("dur.s", { s });
  return neg ? `−${out}` : out;
}

// ── Index lookup ───────────────────────────────────────────────────────────
/** Index of the last bar with `t <= time` (−1 when before the first bar). Binary search. */
export function findBarIndex(bars: readonly Candle[], time: number): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= time) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Index of the bar whose `[t, t + barSec)` contains `time`; falls back to the nearest bar. */
export function barIndexForTime(bars: readonly Candle[], time: number, barSec: number): number {
  if (!bars.length) return -1;
  const i = findBarIndex(bars, time);
  if (i < 0) return 0;
  if (time < bars[i].t + barSec) return i;
  // In a gap (lunch halt, overnight): snap to whichever neighbour is nearer in time.
  const next = i + 1 < bars.length ? bars[i + 1] : null;
  if (!next) return i;
  return time - bars[i].t <= next.t - time ? i : i + 1;
}

/** Fractional logical index for an arbitrary time (for drawings between bars / outside the data). */
export function timeToLogical(bars: readonly Candle[], time: number, barSec: number): number {
  if (!bars.length) return 0;
  const i = findBarIndex(bars, time);
  if (i < 0) return (time - bars[0].t) / barSec;
  if (i >= bars.length - 1) return i + (time - bars[i].t) / barSec;
  const a = bars[i].t, b = bars[i + 1].t;
  return i + (time - a) / Math.max(1, b - a);
}

/** Inverse of {@link timeToLogical}. */
export function logicalToTime(bars: readonly Candle[], logical: number, barSec: number): number {
  if (!bars.length) return 0;
  if (logical <= 0) return bars[0].t + logical * barSec;
  const i = Math.floor(logical);
  if (i >= bars.length - 1) return bars[bars.length - 1].t + (logical - (bars.length - 1)) * barSec;
  const a = bars[i].t, b = bars[i + 1].t;
  return a + (logical - i) * (b - a);
}
