/**
 * Cross-script normalisation for people's names (RU / EN / UZ).
 *
 * Three levels, from strict to loose:
 *   literal  — lowercase, «ё»→«е», Latin diacritics and apostrophes removed; same script only.
 *   translit — one Latin spelling for Cyrillic (Russian + Uzbek ў қ ғ ҳ) and Latin (English + Uzbek oʻ gʻ sh ch q x):
 *              «Рахматулло» = «Rakhmatullo» = «Rahmatullo», «Ольга» = «Olga», «Қодир» = «Qodir».
 *   skeleton — phonetic key on top of translit: a/o, e/i/y merged, doubled letters collapsed:
 *              «Закир» = «Zokir», «Тимур» = «Темур», «Евгений» = «Yevgeniy» = «Evgeniy», «Кирилл» = «Kiril».
 */

const PROTECT_SHORT_I = ""; // «й» survives NFD (it would decompose into «и» + breve)
const PROTECT_SHORT_U = ""; // Uzbek «ў» (у + breve)
const PROTECT_YO = ""; // «ё» (е + diaeresis) — translit spells it «yo» (Uzbek «Бахтиёр» = «Baxtiyor»)

/** Apostrophe-like characters: Uzbek oʻ / gʻ (U+02BB, U+02BC), typewriter ', `, ´ and typographic quotes. */
const APOSTROPHES = /[ʻʼʹ‘’‛'`´]/g;

/** Lowercase + strip Latin diacritics (é → e), keeping «й» / «ў» intact. */
function baseLower(s: string): string {
  return s
    .toLowerCase()
    .replace(/й/g, PROTECT_SHORT_I)
    .replace(/ў/g, PROTECT_SHORT_U)
    .replace(/ё/g, PROTECT_YO)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(//g, "й")
    .replace(//g, "ў")
    .replace(//g, "ё");
}

/** Same-script comparable form: lowercase, «ё»→«е», no diacritics, no apostrophes. */
export function literal(s: string): string {
  return baseLower(s).replace(/ё/g, "е").replace(APOSTROPHES, "");
}

const CYR_TO_LAT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sh",
  ъ: "", ы: "i", ь: "", э: "e", ю: "yu", я: "ya",
  // Uzbek Cyrillic
  ў: "o", қ: "k", ғ: "g", ҳ: "h",
  // Ukrainian / Kazakh letters that show up in names
  і: "i", ї: "yi", є: "ye", ґ: "g", ә: "a", ө: "o", ү: "u", ұ: "u", ң: "n", һ: "h",
};

/** Latin spelling rules shared by English and Uzbek Latin. `xAsH` — Uzbek «x» (= «х») instead of English «ks». */
function latinRules(s: string, xAsH: boolean): string {
  let t = s.replace(APOSTROPHES, "");
  t = t
    .replace(/shch/g, "sh")
    .replace(/dzh|dj/g, "j")
    .replace(/zh/g, "j")
    .replace(/kh/g, "h")
    .replace(/ph/g, "f")
    .replace(/w/g, "v")
    .replace(/ck/g, "k")
    .replace(/q/g, "k")
    .replace(/c(?!h)(?=[eiy])/g, "s")
    .replace(/c(?!h)/g, "k")
    .replace(/tz/g, "ts");
  // «x» at the start of a word is Uzbek («Xurshid» = «Хуршид»); inside a word it is either («Maxim» / «Baxtiyor»).
  t = t.replace(/^x/, "h").replace(/x/g, xAsH ? "h" : "ks");
  return t.replace(/[^a-z0-9]/g, "");
}

/** Cyrillic → Latin letter by letter (other characters pass through). */
function cyrToLat(s: string): string {
  let out = "";
  for (const ch of s) out += CYR_TO_LAT[ch] ?? ch;
  return out;
}

/**
 * All Latin spellings of one token (usually one; two when an inner «x» is ambiguous: «Shohrux» → shohruks / shohruh).
 * Input is a single word; separators are not expected.
 */
export function translitVariants(token: string): string[] {
  const lat = cyrToLat(baseLower(token));
  const out = [latinRules(lat, false)];
  if (/x/.test(lat.slice(1))) out.push(latinRules(lat, true));
  // Word-initial «Е» is spelled both ways: «Егор» = «Egor» = «Yegor», «Евгений» = «Evgeniy» = «Yevgeniy».
  for (const v of [...out]) {
    if (v.startsWith("ye")) out.push(v.slice(1));
    else if (v.startsWith("e")) out.push(`y${v}`);
  }
  return [...new Set(out)];
}

/** Main Latin spelling of a token or phrase (words joined by single spaces). */
export function translit(s: string): string {
  return tokenize(s).map((t) => translitVariants(t.text)[0]).filter(Boolean).join(" ");
}

/** Phonetic key of one translit token: a/o → a, e/i/y → i, repeated letters collapsed. */
export function skeleton(tr: string): string {
  let out = "";
  for (const ch of tr) {
    const c = ch === "o" ? "a" : ch === "e" || ch === "y" ? "i" : ch;
    if (out[out.length - 1] !== c) out += c;
  }
  return out;
}

export type Token = { text: string; start: number; end: number };

/** Words with their offsets in the source string (letters, digits and in-word apostrophes such as «oʻ»). */
export function tokenize(s: string): Token[] {
  const out: Token[] = [];
  const re = /[\p{L}\p{N}ʻʼ‘’'`]+/gu;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    // Trim leading/trailing apostrophes (quotes around a word are not part of it).
    let text = m[0];
    let start = m.index;
    const lead = /^[ʻʼ‘’'`]+/.exec(text)?.[0].length ?? 0;
    text = text.slice(lead);
    start += lead;
    text = text.replace(/[ʻʼ‘’'`]+$/, "");
    if (text) out.push({ text, start, end: start + text.length });
  }
  return out;
}

export const hasCyrillic = (s: string) => /[Ѐ-ӿ]/.test(s);
export const hasLatin = (s: string) => /[a-z]/i.test(s);

/**
 * Latin spelling of a person's name for display, keeping case and punctuation: «Дмитрий К.» → «Dmitriy K.»,
 * «Артём Г.» → «Artyom G.», «Рахматулло» → «Rahmatullo». Words already in Latin stay as written. Used to suggest
 * users.name_latin to an admin (a suggestion only: the admin confirms or corrects it).
 */
export function latinizeName(s: string): string {
  return s.replace(/[\p{L}ʻʼ‘’'`]+/gu, (w) => {
    if (!hasCyrillic(w)) return w;
    const lat = translitVariants(w)[0] ?? w;
    const upper = w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase();
    const allUpper = w.length > 1 && w === w.toUpperCase();
    if (allUpper) return lat.toUpperCase();
    return upper ? lat.charAt(0).toUpperCase() + lat.slice(1) : lat;
  });
}
