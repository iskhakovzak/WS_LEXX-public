/**
 * `behavior` namespace (src/i18n/{ru,en,uz}/behavior.ts) — behaviour patterns, insights, triggers — and
 * `psychology` (src/i18n/{ru,en,uz}/psychology.ts) — psychology analytics and the weekly psychology report.
 */
import { defineNamespace, type Lang } from "../i18n";
import ruBehavior from "../i18n/ru/behavior";
import enBehavior from "../i18n/en/behavior";
import uzBehavior from "../i18n/uz/behavior";
import ruPsychology from "../i18n/ru/psychology";
import enPsychology from "../i18n/en/psychology";
import uzPsychology from "../i18n/uz/psychology";

export const behaviorT = defineNamespace(ruBehavior, { en: enBehavior, uz: uzBehavior });
export const psychologyT = defineNamespace(ruPsychology, { en: enPsychology, uz: uzPsychology });

/** Duration in minutes → "45 с" / "12 мин" / "2 ч 5 мин" in `lang`. */
export function fmtDurFor(lang: Lang, min: number | null): string {
  if (min == null) return "—";
  const t = behaviorT.tFor(lang);
  if (min < 1) return t("units.sec", { n: Math.round(min * 60) });
  if (min < 60) return t("units.min", { n: Math.round(min) });
  return t("units.hourMin", { h: Math.floor(min / 60), m: Math.round(min % 60) });
}
