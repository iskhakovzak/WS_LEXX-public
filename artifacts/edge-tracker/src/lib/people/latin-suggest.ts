/**
 * Latin display names (users.name_latin), pure helpers for the admin «suggestions» and the self-service edit.
 * The suggestion comes from the shared transliteration (@workspace/text-search `latinizeName`: «Дмитрий К.» →
 * «Dmitriy K.»); the check mirrors the API (lib/peopleDirectory.ts `cleanNameLatin`), so a value the form accepts
 * is a value the server accepts.
 */
import { latinizeName } from "@workspace/text-search";

export const NAME_LATIN_MAX = 80;
const ALLOWED = /^[\p{L}\p{N} .'ʻʼ’`-]+$/u;

/** Trim and collapse spaces (what the server stores). */
export function tidyLatin(v: string): string {
  return v.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Is a (tidied, non-empty) value one the server accepts? Empty → true (it means «remove»). */
export function isValidLatin(v: string): boolean {
  const t = tidyLatin(v);
  return !t || (t.length <= NAME_LATIN_MAX && ALLOWED.test(t));
}

/** Suggested Latin name for a person without one; null when they have one or the name is already Latin. */
export function latinSuggestion(p: { name: string; nameLatin?: string | null }): string | null {
  if (p.nameLatin?.trim()) return null;
  const s = tidyLatin(latinizeName(p.name));
  return s && s !== tidyLatin(p.name) && isValidLatin(s) ? s : null;
}
