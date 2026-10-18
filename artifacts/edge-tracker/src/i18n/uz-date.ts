/**
 * Uzbek (Latin) dates and relative time, written by hand: browsers ship little or no `uz` CLDR data, so
 * `Intl.DateTimeFormat("uz-Latn-UZ")` prints «2026 M10 7, Wed» and RelativeTimeFormat «-5 min». Only numbers are taken
 * from Intl (en-US parts, always available); month/weekday names and patterns come from here.
 *
 * Patterns (modern Uzbek orthography; numeric dates as on Uzbek documents):
 *   short          07.10.2026            shortYY        07.10.26           dayMonthNumeric  07.10
 *   medium         7-okt, 2026           dayMonth       7-okt              dayMonthLong     7-oktabr
 *   long           2026-yil 7-oktabr     monthYear      2026-yil oktabr    full             chorshanba, 2026-yil 7-oktabr
 *   weekdayDayMonth  Chor, 7-okt         weekdayDayMonthLong  chorshanba, 7-oktabr
 *   time 14:05 · dateTime 7-okt, 14:05 · shortDateTime 07.10.2026, 14:05 (24 h everywhere)
 * Pure: no React, no state (format.ts decides when to use it).
 */

export const UZ_MONTHS_LONG = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"] as const;
export const UZ_MONTHS_SHORT = ["yan", "fev", "mar", "apr", "may", "iyn", "iyl", "avg", "sen", "okt", "noy", "dek"] as const;
const UZ_MONTHS_NARROW = ["Y", "F", "M", "A", "M", "I", "I", "A", "S", "O", "N", "D"] as const;
/** Index = Date#getDay (0 = Sunday). */
export const UZ_WEEKDAYS_LONG = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"] as const;
export const UZ_WEEKDAYS_SHORT = ["Yak", "Dush", "Sesh", "Chor", "Pay", "Jum", "Shan"] as const;
const UZ_WEEKDAYS_NARROW = ["Y", "D", "S", "C", "P", "J", "S"] as const;

type Parts = { y: number; mo: number; d: number; wd: number; h: number; mi: number; s: number };

const tzCache = new Map<string, Intl.DateTimeFormat>();
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Calendar/clock parts of `date` in `timeZone` (or the device zone). */
function partsOf(date: Date, timeZone?: string): Parts {
  if (!timeZone) {
    return { y: date.getFullYear(), mo: date.getMonth(), d: date.getDate(), wd: date.getDay(), h: date.getHours(), mi: date.getMinutes(), s: date.getSeconds() };
  }
  let f = tzCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
    tzCache.set(timeZone, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(date)) p[x.type] = x.value;
  return { y: Number(p.year), mo: Number(p.month) - 1, d: Number(p.day), wd: WD[p.weekday] ?? 0, h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function uzMonth(m: number, width: "long" | "short" | "narrow" = "long"): string {
  const i = ((m % 12) + 12) % 12;
  return (width === "long" ? UZ_MONTHS_LONG : width === "short" ? UZ_MONTHS_SHORT : UZ_MONTHS_NARROW)[i];
}

export function uzWeekday(wd: number, width: "long" | "short" | "narrow" = "short"): string {
  const i = ((wd % 7) + 7) % 7;
  return (width === "long" ? UZ_WEEKDAYS_LONG : width === "short" ? UZ_WEEKDAYS_SHORT : UZ_WEEKDAYS_NARROW)[i];
}

/**
 * Formats `date` for the given Intl options in Uzbek. Covers every option combination fmtDate / fmtDateCustom use:
 * weekday, day, month (numeric | 2-digit | short | long | narrow), year (numeric | 2-digit), hour, minute, second,
 * timeZone. Clock is always 24 h; numeric dates are zero-padded dd.MM.yyyy.
 */
export function formatUzDate(date: Date, o: Intl.DateTimeFormatOptions): string {
  const p = partsOf(date, o.timeZone);
  const year = o.year === "2-digit" ? pad(p.y % 100) : o.year ? String(p.y) : "";
  const textMonth = o.month === "long" || o.month === "short" || o.month === "narrow";

  let datePart = "";
  if (textMonth) {
    const m = uzMonth(p.mo, o.month as "long" | "short" | "narrow");
    const day = o.day ? String(p.d) : "";
    const long = o.month === "long";
    if (day && year) datePart = long ? `${year}-yil ${day}-${m}` : `${day}-${m}, ${year}`;
    else if (day) datePart = `${day}-${m}`;
    else if (year) datePart = long ? `${year}-yil ${m}` : `${m} ${year}`;
    else datePart = m;
  } else if (o.month) {
    datePart = [o.day ? pad(p.d) : "", pad(p.mo + 1), year].filter(Boolean).join(".");
  } else if (o.day || year) {
    datePart = [o.day ? String(p.d) : "", year].filter(Boolean).join(", ");
  }
  if (o.weekday) {
    const wd = uzWeekday(p.wd, o.weekday);
    datePart = datePart ? `${wd}, ${datePart}` : wd;
  }

  const time: string[] = [];
  if (o.hour) time.push(pad(p.h));
  if (o.minute) time.push(pad(p.mi));
  if (o.second) time.push(pad(p.s));
  const timePart = time.join(":");

  return datePart && timePart ? `${datePart}, ${timePart}` : datePart || timePart;
}

export type RelUnit = "second" | "minute" | "hour" | "day" | "month" | "year";

const REL_WORD: Record<RelUnit, { long: string; short: string }> = {
  second: { long: "soniya", short: "son." },
  minute: { long: "daqiqa", short: "daq." },
  hour: { long: "soat", short: "soat" },
  day: { long: "kun", short: "kun" },
  month: { long: "oy", short: "oy" },
  year: { long: "yil", short: "yil" },
};

/**
 * Like `Intl.RelativeTimeFormat("uz", { numeric: "auto" }).format(value, unit)`: «hozir», «kecha», «ertaga»,
 * «5 daqiqa oldin», «2 soatdan keyin». `formatNumber` formats the count (locale grouping).
 */
export function formatUzRelative(value: number, unit: RelUnit, style: "long" | "short" | "narrow", formatNumber: (n: number) => string): string {
  const v = value + 0;
  if (unit === "second" && v === 0) return "hozir";
  if (unit === "day") {
    if (v === 0) return "bugun";
    if (v === -1) return "kecha";
    if (v === 1) return "ertaga";
  }
  if (unit === "month" || unit === "year") {
    const w = REL_WORD[unit].long;
    if (v === 0) return `shu ${w}`;
    if (v === -1) return `oʻtgan ${w}`;
    if (v === 1) return `keyingi ${w}`;
  }
  const word = REL_WORD[unit][style === "long" ? "long" : "short"];
  const n = formatNumber(Math.abs(v));
  // Suffixes attach to the word; abbreviations ("daq.") take the full word's suffix after the dot-less stem.
  if (v < 0) return `${n} ${word} oldin`;
  const stem = word.endsWith(".") ? REL_WORD[unit].long : word;
  return `${n} ${stem}dan keyin`;
}

/**
 * Date range in Uzbek: «2026-yil 12–16-oktabr», «2026-yil 28-sentabr – 2-oktabr», «2026-yil 29-dekabr – 2027-yil
 * 2-yanvar». `width` "short" uses short month names and the medium shape («12–16-okt, 2026»).
 */
export function formatUzRange(a: Date, b: Date, width: "long" | "short" = "long"): string {
  const y1 = a.getFullYear(), y2 = b.getFullYear(), m1 = a.getMonth(), m2 = b.getMonth();
  const M = (m: number) => uzMonth(m, width);
  if (width === "short") {
    if (y1 === y2 && m1 === m2) return `${a.getDate()}–${b.getDate()}-${M(m1)}, ${y1}`;
    if (y1 === y2) return `${a.getDate()}-${M(m1)} – ${b.getDate()}-${M(m2)}, ${y1}`;
    return `${a.getDate()}-${M(m1)}, ${y1} – ${b.getDate()}-${M(m2)}, ${y2}`;
  }
  if (y1 === y2 && m1 === m2) return `${y1}-yil ${a.getDate()}–${b.getDate()}-${M(m1)}`;
  if (y1 === y2) return `${y1}-yil ${a.getDate()}-${M(m1)} – ${b.getDate()}-${M(m2)}`;
  return `${y1}-yil ${a.getDate()}-${M(m1)} – ${y2}-yil ${b.getDate()}-${M(m2)}`;
}
