/**
 * How a person's name is shown. Names are stored in Cyrillic («Закир», «Дмитрий К.») and stay the identity in
 * API params, URLs, filters and keys. In English and Uzbek the UI shows the Latin name an admin set
 * (users.name_latin: «Zakir», «Dmitriy K.») when there is one, the stored name otherwise; in Russian always the
 * stored name.
 *
 *   personName(t.trader)                       → «Zakir» (EN/UZ, Latin name set) / «Закир»
 *   t("feed.by", { name: personName(author) }) → names inside sentences go through it too
 *   personInitials(name)                       → «ZA» / «ЗА» for avatars
 *
 * Plain function (reads the current language and the name table at call time), safe in labels, charts, CSV.
 * A language switch or a change of the Latin names re-mounts the tree (I18nProvider), so renders stay current.
 */
import { latinNameOf } from "@/lib/people/latin-names";
import { getLang } from "./state";
import { localeTagFor, type Lang } from "./core";

/** Display name in the current UI language. Empty input → "". */
export function personName(name: string | null | undefined): string {
  return personNameFor(name, getLang());
}

/** Display name for an explicit language (exports, copy for another reader). */
export function personNameFor(name: string | null | undefined, lang: Lang): string {
  if (!name) return "";
  if (lang === "ru") return name;
  return latinNameOf(name) ?? name;
}

/** Up to two initials of the display name («Dmitriy K.» → «DK», «Zakir» → «ZA», «Закир» → «ЗА»). */
export function personInitials(name: string | null | undefined): string {
  const shown = personName(name).trim();
  if (!shown) return "?";
  const words = shown.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] ?? shown).slice(0, 2).toUpperCase();
}

/** Compare two stored names by how they are shown (sorting a roster in the UI language). */
export function comparePersonNames(a: string, b: string): number {
  const lang = getLang();
  return personNameFor(a, lang).localeCompare(personNameFor(b, lang), localeTagFor(lang));
}
