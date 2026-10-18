/**
 * Market calendar rows (holiday_calendar, seeded in English by migrations 0016 / 0017) in the reader's language.
 * The seeded English names / descriptions map to `calendar` namespace keys; anything else (rows added by hand) stays
 * as stored. FOMC / CPI / PPI / NFP / OPEX / SEP and ET stay as is (GLOSSARY: macro codes).
 */
import { calendarT } from "../i18n/ns";
import type { Lang } from "../i18n";

const NAME_KEY: Record<string, string> = {
  "New Year's Day": "newYear",
  "MLK Day": "mlk",
  "Presidents Day": "presidents",
  "Good Friday": "goodFriday",
  "Memorial Day": "memorial",
  "Juneteenth": "juneteenth",
  "Juneteenth (observed)": "juneteenthObserved",
  "Independence Day (observed)": "independenceObserved",
  "Labor Day": "labor",
  "Thanksgiving": "thanksgiving",
  "Day after Thanksgiving": "afterThanksgiving",
  "Christmas Eve": "christmasEve",
  "Christmas Day": "christmas",
  "Christmas Day (observed)": "christmasObserved",
  "FOMC Meeting": "fomc",
  "FOMC Meeting (Decision Day)": "fomcDecision",
  "FOMC Meeting + SEP": "fomcSep",
  "FOMC Meeting + SEP (Decision Day)": "fomcSepDecision",
  "CPI Release": "cpi",
  "PPI Release": "ppi",
  "NFP Jobs Report": "nfp",
  "Monthly OPEX": "opex",
  "Quadruple Witching": "quad",
  "Month-End Rebalance": "monthEnd",
};
const DESC_KEY: Record<string, string> = {
  "Market closed": "closed",
  "Early close 1pm ET": "earlyClose",
  "FOMC begins": "fomcBegins",
  "Statement 2pm ET, Powell presser 2:30pm ET": "fomcStatement",
  "8:30am ET — Consumer Price Index": "cpi",
  "8:30am ET — Producer Price Index": "ppi",
  "8:30am ET — Non-Farm Payrolls": "nfp",
  "Monthly options expiration — elevated volume into close": "opex",
  "Index futures, index options, stock futures, stock options all expire": "quad",
  "Institutional rebalancing flows": "monthEnd",
};

/** Seeded calendar name in `lang` (unknown texts unchanged). */
export function calendarName(name: string | null | undefined, lang: Lang): string | null {
  if (name == null) return null;
  const k = NAME_KEY[name];
  return k ? calendarT.tryFor(lang, `name.${k}`) ?? name : name;
}
/** Seeded calendar description in `lang` (unknown texts unchanged). */
export function calendarDescription(text: string | null | undefined, lang: Lang): string | null {
  if (text == null) return null;
  const k = DESC_KEY[text];
  return k ? calendarT.tryFor(lang, `desc.${k}`) ?? text : text;
}

/** A calendar row with name / description in `lang`. */
export function localizeCalendarRow<T extends { name?: string | null; description?: string | null }>(row: T, lang: Lang): T {
  if (lang === "en") return row;
  return { ...row, name: calendarName(row.name, lang), description: calendarDescription(row.description, lang) };
}
