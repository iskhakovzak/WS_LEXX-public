/**
 * US equities session math in America/New_York wall time.
 * Pre-market 04:00–09:30, regular 09:30–16:00, after-hours 16:00–20:00 ET.
 * Weekends and full-day market holidays (from /api/dashboard/today) are closed.
 */

import { shellI18n } from "@/i18n/ns/shell";

const TZ = "America/New_York";

export type SessionPhase = "pre" | "regular" | "after" | "closed";
export type NextKey = "toOpen" | "toClose" | "toAfterEnd" | "toPremarket";

export type SessionState = {
  phase: SessionPhase;
  /** NY wall clock "HH:MM:SS". */
  nyTime: string;
  /** NY calendar date YYYY-MM-DD. */
  nyDate: string;
  /** Milliseconds until the next relevant boundary. */
  msToNext: number;
  /** What the countdown points to, as a code. */
  nextKey: NextKey;
  /** What the countdown points to, in the UI language (read when the state is computed: call at render). */
  nextLabel: string;
  /** 0..1 position within the 04:00–20:00 extended day, null when outside it / closed day. */
  dayProgress: number | null;
  /** Holiday name if today is a market holiday. */
  holiday: string | null;
  weekend: boolean;
};

export const PRE_OPEN_MIN = 4 * 60;
export const OPEN_MIN = 9 * 60 + 30;
export const CLOSE_MIN = 16 * 60;
export const AFTER_END_MIN = 20 * 60;
const EXT_DAY = AFTER_END_MIN - PRE_OPEN_MIN;

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

type WallParts = { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number };
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function wallParts(date: Date): WallParts {
  const p: Record<string, string> = {};
  for (const x of partsFmt.formatToParts(date)) p[x.type] = x.value;
  return {
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour) % 24,
    mi: Number(p.minute),
    s: Number(p.second),
    wd: WD[p.weekday] ?? 0,
  };
}

/** UTC ms of a NY wall time (DST-aware). */
function nyWallToUtc(ymd: string, minutes: number): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60, 0);
  const offsetAt = (t: number) => {
    const w = wallParts(new Date(t));
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}

function ymdOf(p: WallParts) {
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

function addDaysYmd(ymd: string, n: number) {
  const dt = new Date(`${ymd}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function weekdayOf(ymd: string) {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay();
}

function isTradingDay(ymd: string, holidays: Set<string>) {
  const wd = weekdayOf(ymd);
  return wd !== 0 && wd !== 6 && !holidays.has(ymd);
}

function nextTradingDay(fromYmd: string, holidays: Set<string>) {
  let d = addDaysYmd(fromYmd, 1);
  for (let i = 0; i < 14 && !isTradingDay(d, holidays); i++) d = addDaysYmd(d, 1);
  return d;
}

const next = (nextKey: NextKey) => ({ nextKey, nextLabel: shellI18n.t(`clock.next.${nextKey}`) });

export function getSessionState(now: Date, holidays: { date: string; name: string }[] = []): SessionState {
  const p = wallParts(now);
  const nyDate = ymdOf(p);
  const nyTime = `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}:${String(p.s).padStart(2, "0")}`;
  const set = new Set(holidays.map((h) => h.date));
  const holiday = holidays.find((h) => h.date === nyDate)?.name ?? null;
  const weekend = p.wd === 0 || p.wd === 6;
  const mins = p.h * 60 + p.mi + p.s / 60;
  const t = now.getTime();

  const tradingToday = isTradingDay(nyDate, set);
  const nextOpen = () => {
    const day = tradingToday && mins < OPEN_MIN ? nyDate : nextTradingDay(nyDate, set);
    return nyWallToUtc(day, OPEN_MIN) - t;
  };

  if (!tradingToday) {
    return {
      phase: "closed",
      nyTime,
      nyDate,
      msToNext: nextOpen(),
      ...next("toOpen"),
      dayProgress: null,
      holiday,
      weekend,
    };
  }
  const progress = mins >= PRE_OPEN_MIN && mins < AFTER_END_MIN ? (mins - PRE_OPEN_MIN) / EXT_DAY : null;
  if (mins >= PRE_OPEN_MIN && mins < OPEN_MIN) {
    return {
      phase: "pre",
      nyTime,
      nyDate,
      msToNext: nyWallToUtc(nyDate, OPEN_MIN) - t,
      ...next("toOpen"),
      dayProgress: progress,
      holiday,
      weekend,
    };
  }
  if (mins >= OPEN_MIN && mins < CLOSE_MIN) {
    return {
      phase: "regular",
      nyTime,
      nyDate,
      msToNext: nyWallToUtc(nyDate, CLOSE_MIN) - t,
      ...next("toClose"),
      dayProgress: progress,
      holiday,
      weekend,
    };
  }
  if (mins >= CLOSE_MIN && mins < AFTER_END_MIN) {
    return {
      phase: "after",
      nyTime,
      nyDate,
      msToNext: nyWallToUtc(nyDate, AFTER_END_MIN) - t,
      ...next("toAfterEnd"),
      dayProgress: progress,
      holiday,
      weekend,
    };
  }
  return {
    phase: "closed",
    nyTime,
    nyDate,
    msToNext: nextOpen(),
    ...next("toOpen"),
    dayProgress: progress,
    holiday,
    weekend,
  };
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const hms = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return days > 0 ? `${shellI18n.t("clock.daysPrefix", { count: days })} ${hms}` : hms;
}

/** Full phase names in the UI language (getters: read at render, never frozen at import). */
export const PHASE_LABEL: Readonly<Record<SessionPhase, string>> = {
  get pre() { return shellI18n.t("clock.phaseLong.pre"); },
  get regular() { return shellI18n.t("clock.phaseLong.regular"); },
  get after() { return shellI18n.t("clock.phaseLong.after"); },
  get closed() { return shellI18n.t("clock.phaseLong.closed"); },
};
