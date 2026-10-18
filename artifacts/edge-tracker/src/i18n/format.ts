/**
 * Locale-aware formatting for counts, dates, months, weekdays and relative time. Use these instead of
 * hard-coded "ru-RU". Money, prices, R and percent are NOT localized: they live in lib/format (fmtUsd, fmtPrice,
 * fmtR, fmtPct — `$1,234.56`, `+0.21R` in every language). lib/format re-exports everything here, so feature code
 * imports both from "@/lib/format".
 *
 * All helpers read the current language at call time (call them during render, not at module scope).
 * Uzbek dates, month/weekday names and relative time are hand-written in uz-date.ts (browsers lack uz CLDR data);
 * Uzbek numbers use ru separators (same as CLDR uz) — see numberLocaleFor in core.ts.
 */
import { formatCountFor, localeTagFor, numberLocaleFor, type Lang } from "./core";
import { getLang } from "./state";
import { formatUzDate, formatUzRange, formatUzRelative, uzMonth, uzWeekday, type RelUnit } from "./uz-date";

export type DateInput = Date | string | number;

/** ru-RU / en-US / uz-Latn-UZ for the current (or given) language. */
export function localeTag(lang: Lang = getLang()): string {
  return localeTagFor(lang);
}

type DateFormatter = { format(d: Date): string };
const cache = new Map<string, DateFormatter>();
/** Cached formatter for the language. Uzbek is hand-written (uz-date.ts): browsers lack its CLDR date data. */
function dtf(opts: Intl.DateTimeFormatOptions, lang: Lang = getLang()): DateFormatter {
  const k = `${lang}|${JSON.stringify(opts)}`;
  let f = cache.get(k);
  if (!f) {
    f = lang === "uz" ? { format: (d: Date) => formatUzDate(d, opts) } : new Intl.DateTimeFormat(localeTagFor(lang), opts);
    cache.set(k, f);
  }
  return f;
}

/** Date-only strings ("2026-10-17") are read as local calendar dates (no UTC day shift). Invalid → null. */
export function toDate(d: DateInput | null | undefined): Date | null {
  if (d == null || d === "") return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d;
  if (typeof d === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    const r = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(d);
    return Number.isNaN(r.getTime()) ? null : r;
  }
  const r = new Date(d);
  return Number.isNaN(r.getTime()) ? null : r;
}

const nfCache = new Map<string, Intl.NumberFormat>();
/** 1234 → "1 234" (ru, uz) / "1,234" (en). Non-finite → "—". `opts` (e.g. maximumFractionDigits) are cached per language. */
export function fmtCount(n: number | null | undefined, opts?: Intl.NumberFormatOptions): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n) + 0; // -0 → 0 (Intl prints "-0")
  const lang = getLang();
  if (!opts) return formatCountFor(lang, v);
  const k = `${lang}|${JSON.stringify(opts)}`;
  let f = nfCache.get(k);
  if (!f) {
    f = new Intl.NumberFormat(numberLocaleFor(lang), opts);
    nfCache.set(k, f);
  }
  return f.format(v);
}

export type DateStyle =
  | "short" //     17.10.2026 / 10/17/2026 / 17.10.2026
  | "medium" //    17 окт. 2026 г. / Oct 17, 2026 / 17-okt, 2026
  | "long" //      17 октября 2026 г. / October 17, 2026 / 2026-yil 17-oktabr
  | "full" //      суббота, 17 октября 2026 г. / Saturday, October 17, 2026 / shanba, 2026-yil 17-oktabr
  | "dayMonth" //  17 окт. / Oct 17 / 17-okt
  | "dayMonthLong" // 17 октября / October 17 / 17-oktabr
  | "monthYear" // октябрь 2026 г. / October 2026 / 2026-yil oktabr
  | "time" //      14:05 (24h in every language: trading desk format)
  | "timeSeconds" // 14:05:09
  | "dateTime" // 17 окт., 14:05 / Oct 17, 14:05 / 17-okt, 14:05
  | "shortYY" //   17.10.26 / 10/17/26 / 17.10.26
  | "dayMonthNumeric" // 17.10 / 10/17 / 17.10
  | "weekdayDayMonth" // сб, 17 окт. / Sat, Oct 17 / Shan, 17-okt
  | "weekdayDayMonthLong" // суббота, 17 октября / Saturday, October 17 / shanba, 17-oktabr
  | "numericDateTime" // 17.10, 14:05 / 10/17, 14:05 / 17.10, 14:05
  | "shortDateTime" // 17.10.2026, 14:05 / 10/17/2026, 14:05 / 17.10.2026, 14:05
  | "shortDateTimeSeconds" // 17.10.2026, 14:05:09 (audit / "updated at" tooltips)
  | "fullShortWeekday"; // сб, 17 октября 2026 г. / Sat, October 17, 2026 / Shan, 2026-yil 17-oktabr

const STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { day: "2-digit", month: "2-digit", year: "numeric" },
  medium: { day: "numeric", month: "short", year: "numeric" },
  long: { day: "numeric", month: "long", year: "numeric" },
  full: { weekday: "long", day: "numeric", month: "long", year: "numeric" },
  dayMonth: { day: "numeric", month: "short" },
  dayMonthLong: { day: "numeric", month: "long" },
  monthYear: { month: "long", year: "numeric" },
  time: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  timeSeconds: { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" },
  dateTime: { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  shortYY: { day: "2-digit", month: "2-digit", year: "2-digit" },
  dayMonthNumeric: { day: "2-digit", month: "2-digit" },
  weekdayDayMonth: { weekday: "short", day: "numeric", month: "short" },
  weekdayDayMonthLong: { weekday: "long", day: "numeric", month: "long" },
  numericDateTime: { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  shortDateTime: { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  shortDateTimeSeconds: { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" },
  fullShortWeekday: { weekday: "short", day: "numeric", month: "long", year: "numeric" },
};

/** Format a date in the UI language. Invalid/empty → "—". Pass `timeZone` to pin a zone. */
export function fmtDate(d: DateInput | null | undefined, style: DateStyle = "medium", opts?: { timeZone?: string }): string {
  const date = toDate(d);
  if (!date) return "—";
  return dtf(opts?.timeZone ? { ...STYLES[style], timeZone: opts.timeZone } : STYLES[style]).format(date);
}

/**
 * Rare date shapes that no style covers (prefer a style: add one above when a shape repeats). Same caching,
 * language and "—" for invalid input as fmtDate.
 */
export function fmtDateCustom(d: DateInput | null | undefined, opts: Intl.DateTimeFormatOptions): string {
  const date = toDate(d);
  if (!date) return "—";
  return dtf(opts).format(date);
}

const rangeCache = new Map<string, Intl.DateTimeFormat>();
/**
 * A date range in the UI language with the shared parts written once: «12–16 октября 2026 г.» / «October 12 – 16, 2026»
 * / «2026-yil 12–16-oktabr». `width: "short"` → «12–16 окт. 2026 г.» / «Oct 12 – 16, 2026» / «12–16-okt, 2026».
 * Invalid input → "—"; from > to is swapped.
 */
export function fmtDateRange(from: DateInput | null | undefined, to: DateInput | null | undefined, width: "long" | "short" = "long"): string {
  let a = toDate(from), b = toDate(to);
  if (!a || !b) return "—";
  if (a.getTime() > b.getTime()) [a, b] = [b, a];
  const lang = getLang();
  if (lang === "uz") return formatUzRange(a, b, width);
  const k = `${lang}|${width}`;
  let f = rangeCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(localeTagFor(lang), { day: "numeric", month: width, year: "numeric" });
    rangeCache.set(k, f);
  }
  return f.formatRange(a, b).replace(/[  ]/g, " "); // ICU thin / narrow no-break spaces → plain spaces, as fmtDate prints
}

/**
 * Month name. `m` is a Date or a month index 0–11. `width`: "long" (октябрь / October / oktabr) or "short"
 * (окт. / Oct / okt). Stand-alone (nominative) form. Uzbek names are hand-written (uz-date.ts).
 */
export function fmtMonth(m: Date | number, width: "long" | "short" = "long"): string {
  if (getLang() === "uz") return uzMonth(typeof m === "number" ? m : m.getMonth(), width);
  const date = typeof m === "number" ? new Date(2026, m, 15) : m;
  return dtf({ month: width }).format(date);
}

/**
 * Weekday name. `d` is a Date or a weekday index 0–6 (0 = Sunday, like Date#getDay).
 * `width`: "long" (понедельник / Monday / dushanba), "short" (пн / Mon / Dush), "narrow" (П / M / D).
 */
export function fmtWeekday(d: DateInput | number, width: "long" | "short" | "narrow" = "short"): string {
  // 2026-10-18 is a Sunday.
  const date = typeof d === "number" ? new Date(2026, 9, 18 + (((d % 7) + 7) % 7)) : toDate(d);
  if (!date) return "—";
  if (getLang() === "uz") return uzWeekday(date.getDay(), width);
  return dtf({ weekday: width }).format(date);
}

const rtfCache = new Map<string, Intl.RelativeTimeFormat>();
/**
 * Relative time: "5 минут назад" / "5 minutes ago" / "5 daqiqa oldin", "через 2 часа" / "in 2 hours",
 * "вчера" / "yesterday" / "kecha", "сейчас" / "now" / "hozir" (under 45 s). `style: "short"` → "5 мин. назад".
 */
export function fmtRelative(d: DateInput | null | undefined, opts?: { now?: Date | number; style?: "long" | "short" | "narrow" }): string {
  const date = toDate(d);
  if (!date) return "—";
  const lang = getLang();
  const style = opts?.style ?? "long";
  let fmt: (v: number, unit: Intl.RelativeTimeFormatUnit & RelUnit) => string;
  if (lang === "uz") {
    fmt = (v, unit) => formatUzRelative(v, unit, style, (n) => formatCountFor("uz", n));
  } else {
    const k = `${lang}|${style}`;
    let rtf = rtfCache.get(k);
    if (!rtf) {
      rtf = new Intl.RelativeTimeFormat(localeTagFor(lang), { numeric: "auto", style });
      rtfCache.set(k, rtf);
    }
    const r = rtf;
    fmt = (v, unit) => r.format(v, unit);
  }
  const now = opts?.now instanceof Date ? opts.now.getTime() : (opts?.now ?? Date.now());
  const sec = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(sec);
  if (abs < 45) return fmt(0, "second");
  if (abs < 45 * 60) return fmt(Math.round(sec / 60), "minute");
  if (abs < 22 * 3600) return fmt(Math.round(sec / 3600), "hour");
  if (abs < 26 * 86400) return fmt(Math.round(sec / 86400), "day");
  if (abs < 320 * 86400) return fmt(Math.round(sec / (30 * 86400)), "month");
  return fmt(Math.round(sec / (365 * 86400)), "year");
}

/** Wall-clock time in New York, 24h: "09:30" (or "09:30:05" with seconds). */
export function fmtTimeNY(d: DateInput = new Date(), opts?: { seconds?: boolean }): string {
  const date = toDate(d);
  if (!date) return "—";
  return dtf({
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    ...(opts?.seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  }).format(date);
}
