/**
 * Server date formatting in a given language (mirror of edge-tracker/src/i18n/format.ts, the styles that server
 * texts need). Money, R and prices keep the trading format in every language: format them with the existing
 * helpers (e.g. lib/notifyEventsCore fmtUsd / fmtSignedUsd) and pass the result as a param.
 *
 *   fmtDateFor("en", "2026-10-17", "dayMonth")   → "Oct 17"
 *   fmtDateFor("ru", "2026-10-17", "dayMonth")   → "17 окт."
 *   fmtDateFor("uz", new Date(), "dateTime")     → "17-okt, 14:05"
 *
 * A date-only string ("YYYY-MM-DD", a NY trading day) is formatted as that calendar day (UTC noon, UTC zone),
 * so it never shifts by a day. Instants (Date / ISO with time) use `timeZone` (default America/New_York).
 */
import { localeTagFor, type Lang } from "./core";

export type ServerDateStyle =
  | "short" //        17.10.2026 / 10/17/2026
  | "medium" //       17 окт. 2026 г. / Oct 17, 2026
  | "long" //         17 октября 2026 г. / October 17, 2026
  | "dayMonth" //     17 окт. / Oct 17
  | "dayMonthLong" // 17 октября / October 17
  | "weekdayDayMonth" // пт, 17 окт. / Fri, Oct 17
  | "monthYear" //    октябрь 2026 г. / October 2026
  | "time" //         14:05
  | "dateTime" //     17 окт., 14:05 / Oct 17, 14:05
  | "dayMonthNumeric"; // 17.10 / 10/17

const STYLES: Record<ServerDateStyle, Intl.DateTimeFormatOptions> = {
  short: { day: "2-digit", month: "2-digit", year: "numeric" },
  medium: { day: "numeric", month: "short", year: "numeric" },
  long: { day: "numeric", month: "long", year: "numeric" },
  dayMonth: { day: "numeric", month: "short" },
  dayMonthLong: { day: "numeric", month: "long" },
  weekdayDayMonth: { weekday: "short", day: "numeric", month: "short" },
  monthYear: { month: "long", year: "numeric" },
  time: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  dateTime: { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  dayMonthNumeric: { day: "2-digit", month: "2-digit" },
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const cache = new Map<string, Intl.DateTimeFormat>();

function dtf(lang: Lang, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `${lang}|${JSON.stringify(opts)}`;
  let f = cache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(localeTagFor(lang), opts);
    cache.set(k, f);
  }
  return f;
}

/** Format a date / NY trading day in `lang`. Invalid or empty → "—". */
export function fmtDateFor(
  lang: Lang,
  d: Date | string | number | null | undefined,
  style: ServerDateStyle = "dayMonth",
  opts?: { timeZone?: string },
): string {
  if (d === null || d === undefined || d === "") return "—";
  let date: Date;
  let timeZone = opts?.timeZone ?? "America/New_York";
  if (typeof d === "string" && DATE_ONLY.test(d)) {
    date = new Date(`${d}T12:00:00Z`);
    timeZone = "UTC";
  } else {
    date = d instanceof Date ? d : new Date(d);
  }
  if (Number.isNaN(date.getTime())) return "—";
  return dtf(lang, { ...STYLES[style], timeZone }).format(date);
}
