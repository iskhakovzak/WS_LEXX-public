/**
 * Labels of the 1–5 day scales (shared by the day journal and EOD). The stored value is the number; `MOOD_LABELS[mood - 1]` reads the
 * label in the current language on access, so these lists are safe to keep at module scope.
 */
import { journalI18n } from "@/i18n/ns/journal";

function liveList<K extends string>(keys: readonly K[], label: (k: K) => string): readonly string[] {
  const out: string[] = [];
  keys.forEach((k, i) => Object.defineProperty(out, i, { get: () => label(k), enumerable: true }));
  return out;
}

const MOOD_KEYS = ["tilt", "bad", "even", "good", "flow"] as const;
const DISCIPLINE_KEYS = ["chaos", "weak", "fair", "good", "perfect"] as const;

export const MOOD_LABELS: readonly string[] = liveList(MOOD_KEYS, (k) => journalI18n.t(`mood.${k}`));
export const DISCIPLINE_LABELS: readonly string[] = liveList(DISCIPLINE_KEYS, (k) => journalI18n.t(`discipline.${k}`));
