/**
 * Plurals.
 *
 * - Common units (trades, days, tickers, setups, ideas, events, violations, traders, points, lessons, items,
 *   entries, wins, losses, weeks, months, minutes, hours): `commonI18n.t("units.trades", { count })` — already
 *   translated to EN/UZ. Never rebuild them with pluralRu.
 * - Feature nouns (статья, человек, правило…): `pluralRu(n, one, few, many)` below is the ONE place for the RU
 *   rule until the translation wave. The wave replaces each call with a plural entry in the area's namespace
 *   (`t("articles", { count })`) in the same edit that translates the noun, so every remaining call site is a
 *   wave item (grep `pluralRu(`). Don't write new local plural functions.
 */
import { selectPlural } from "@/i18n/core";

/**
 * RU plural form: 1 нарушение, 2 нарушения, 5 нарушений (11–14 → many); fractions (1,5) take the `few` form,
 * negatives use their absolute value. Russian-only: convert to a namespace plural entry when the area is translated.
 */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  return selectPlural("ru", { one, few, many, other: few }, Number.isFinite(n) ? n : 0);
}
