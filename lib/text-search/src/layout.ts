/**
 * Keyboard-layout slips: text typed with the wrong layout active (QWERTY ↔ ЙЦУКЕН).
 * «Pfrbh» (EN layout) → «Закир»; «щдпф» (RU layout) → «olga».
 */

const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU = "йцукенгшщзхъфывапролджэячсмитьбюё";

const EN_TO_RU = new Map<string, string>();
const RU_TO_EN = new Map<string, string>();
for (let i = 0; i < EN.length; i++) {
  EN_TO_RU.set(EN[i]!, RU[i]!);
  RU_TO_EN.set(RU[i]!, EN[i]!);
}

/**
 * The same keystrokes in the other layout, or null when the text mixes scripts / has nothing to switch.
 * Only letters and the punctuation keys that carry letters in ЙЦУКЕН ([ ] ; ' , . `) are converted.
 */
export function switchLayout(s: string): string | null {
  const lower = s.toLowerCase();
  const cyr = /[а-яё]/.test(lower);
  const lat = /[a-z]/.test(lower);
  if (cyr === lat) return null; // both or neither
  const map = cyr ? RU_TO_EN : EN_TO_RU;
  let out = "";
  for (const ch of lower) out += map.get(ch) ?? ch;
  return out === lower ? null : out;
}
