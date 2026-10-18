/**
 * date-fns Locale for the UI language — only for components that take a date-fns locale object (react-day-picker
 * `<Calendar locale={…}>`). Text formatting goes through fmtDate & co. Not re-exported from the barrel, so pages
 * that don't need it don't load the locale data. Call at render time (language is read when called).
 */
import type { Locale } from "date-fns";
import { enUS } from "date-fns/locale/en-US";
import { ru } from "date-fns/locale/ru";
import { uz } from "date-fns/locale/uz";
import { getLang } from "@/i18n/state";

export function dateFnsLocale(): Locale {
  const lang = getLang();
  return lang === "en" ? enUS : lang === "uz" ? uz : ru;
}
