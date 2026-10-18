/**
 * Dates, months, weekdays, relative time and NY clock: they follow the UI language and live in i18n/format.ts
 * (one implementation, shared with the i18n runtime). Re-exported so feature code imports every formatter from
 * "@/lib/format".
 */
export {
  fmtDate,
  fmtDateCustom,
  fmtDateRange,
  fmtMonth,
  fmtWeekday,
  fmtRelative,
  fmtTimeNY,
  localeTag,
  toDate,
  type DateInput,
  type DateStyle,
} from "@/i18n/format";
