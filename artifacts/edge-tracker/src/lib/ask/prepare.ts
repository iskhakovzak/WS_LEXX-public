// «Спроси журнал» — text preparation before the rule parser (pure, no React).
//
// 1. Normalise: lowercase, ё→е, punctuation → space; Uzbek apostrophes inside Latin words are dropped
//    («oʻrtacha» / «o'rtacha» / «o‘rtacha» → «ortacha», «boʻyicha» → «boyicha»), so UZ rules use one spelling.
// 2. Number words → digits («две недели» → «2 недели», «two weeks» → «2 weeks», «ikki hafta» → «2 hafta»).
// 3. Wrong keyboard layout: a Latin word that is not a known ticker / Latin rule word and reads as a Russian vocabulary
//    word in the ЙЦУКЕН layout is replaced («dbyhtqn» → «винрейт»).
// 4. Typos: a Cyrillic word that is not in the vocabulary is replaced by the single closest vocabulary word
//    (OSA distance ≤ 1 for 4–6 letters, ≤ 2 for 7+), «винрейд» → «винрейт», «комисии» → «комиссии». A lowercase
//    Latin word of 6+ letters is corrected the same way towards the words the EN / UZ rules use («winrte» →
//    «winrate», «komisiya» → «komissiya»); Uzbek words with a case ending are left alone.
//
// Replacements change length, so every output character keeps the span of the original text it came
// from (`src`): a rule match [a, b) in the prepared text maps back to [src[a].start, src[b−1].end) in the
// user's text — that is what makes «понял как» chips removable / editable in place.

export interface Correction { from: string; to: string }

export interface Prepared {
  /** Normalised text the rules run on. */
  text: string;
  /** For every char of `text`: [start, end) in the original string. */
  src: Array<[number, number]>;
  corrections: Correction[];
}

const NUM_WORDS: Record<string, number> = {
  один: 1, одна: 1, одну: 1, одного: 1, два: 2, две: 2, двух: 2, три: 3, трех: 3, четыре: 4, четырех: 4, пять: 5, пяти: 5,
  шесть: 6, шести: 6, семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9, десять: 10, десяти: 10,
  пятнадцать: 15, двадцать: 20, тридцать: 30, пару: 2, пара: 2,
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, couple: 2,
  ikki: 2, uch: 3, tort: 4, besh: 5, olti: 6, yetti: 7, sakkiz: 8, toqqiz: 9, yigirma: 20, ottiz: 30,
};

/** Words the rules know (full forms). Typos are corrected towards these. */
export const VOCAB: readonly string[] = [
  // trades, sides, results
  "сделки", "сделок", "сделка", "сделку", "сделкам", "трейды", "трейдов", "лонги", "лонгов", "лонг", "шорты", "шортов", "шорт",
  "убыточные", "убыточных", "убыточная", "убыточной", "убыточный", "убытка", "убытков", "убыток", "убытки", "лосса", "лоссов",
  "прибыльные", "прибыльных", "прибыльная", "прибыльной", "прибыльный", "прибыль", "прибыли", "профита", "безубыток",
  "проигрышные", "выигрышные", "минусовые", "плюсовые",
  // metrics / intents
  "комиссии", "комиссий", "комиссиям", "комиссия", "комиссиями", "винрейт", "винрейта", "винрейту", "сколько", "нетто", "брутто",
  "лучший", "лучшая", "лучшие", "лучших", "лучшее", "худший", "худшая", "худшие", "худших", "худшее",
  "средний", "среднее", "средняя", "средние", "сравни", "сравнить", "сравнение", "заработал", "заработала", "заработали",
  "потерял", "потеряла", "потеряли", "теряю", "теряешь", "сливаю", "проигрываю", "зарабатываю", "серия", "серии", "подряд",
  "просадка", "просадку", "профит", "фактор", "удержание", "удержания", "держал", "держу", "размер", "размером", "позиции",
  "количество", "итого", "результат", "результаты", "больше", "меньше", "всего", "когда", "дольше", "короче", "быстрее",
  "дешевле", "дороже", "выше", "ниже", "акций", "тикер", "тикеры", "тикеров", "тикерам", "сетап", "сетапы", "сетапам", "сетапу",
  "сетапов", "трейдерам", "трейдеры", "трейдеров", "время", "времени",
  // periods
  "сегодня", "вчера", "позавчера", "неделе", "неделю", "недели", "неделя", "недель", "неделям", "месяц", "месяца", "месяце",
  "месяцев", "месяцам", "квартал", "квартале", "году", "прошлой", "прошлом", "прошлый", "прошлую", "этой", "этом", "текущей",
  "текущем", "последние", "последних", "последний", "последняя", "последнюю", "начала", "история", "истории",
  "январе", "феврале", "марте", "апреле", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре",
  "январь", "февраль", "март", "апрель", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
  "января", "февраля", "марта", "апреля", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря",
  "понедельник", "вторник", "среда", "среду", "четверг", "пятница", "пятницу", "понедельникам", "вторникам", "средам",
  "четвергам", "пятницам", "понедельники", "вторники", "четверги", "пятницы",
  // time of day
  "утром", "утро", "утрам", "обед", "обеда", "обеде", "побед", "победы", "победа", "побед", "выигрышей", "проигрышей", "серия", "серии", "серий", "стрик", "после", "перед", "премаркет", "премаркете", "открытии", "открытие",
  "закрытия", "закрытие", "минут", "минуты", "минуту", "секунд", "секунды", "часа", "часов", "часам", "дням", "дней",
  // extra forms that must not be "corrected" into something else
  "лучше", "хуже", "день", "дни", "дня", "часы", "часу", "утра", "вечером", "акции", "тикеру", "сетапом", "сегодняшние",
  "вчерашние", "плюс", "минус", "плюсе", "минусе", "слил", "слила", "года", "неделях", "сессиям", "сессии", "удержанию",
  "длительности", "размеру", "объему", "лосс", "лоссы", "стопы", "подряд", "сделках", "сделками", "трейдам", "всё",
  "команде", "команда", "деску", "трейдеру", "ошибаюсь", "сильные", "слабые", "места", "стороны", "работает",
];

const VOCAB_SET = new Set(VOCAB);

/** Function words / filler that are never "typos". */
const STOP = new Set([
  "мои", "мой", "моих", "моя", "мое", "мне", "меня", "для", "что", "как", "где", "это", "эти", "этот", "все", "всех", "весь",
  "вся", "был", "была", "были", "было", "есть", "или", "либо", "так", "уже", "еще", "тоже", "только", "очень", "чаще",
  "какой", "какая", "какие", "каких", "каким", "какое", "каком", "какую", "самый", "самая", "самое", "самые", "самых",
  "покажи", "показать", "найди", "выведи", "список", "дай", "скажи", "пожалуйста", "плиз", "через", "между", "против",
  "сделал", "сделала", "торговал", "торговала", "торговля", "торговли", "трейдер", "трейдера", "журнал", "журнале",
]);

/** ЙЦУКЕН ↔ QWERTY. */
const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU = "йцукенгшщзхъфывапролджэячсмитьбюё";
const LAYOUT = new Map<string, string>([...EN].map((c, i) => [c, RU[i]]));

export function fromWrongLayout(word: string): string | null {
  let out = "";
  for (const ch of word) {
    const r = LAYOUT.get(ch);
    if (!r) return null;
    out += r;
  }
  return out.replace(/ё/g, "е");
}

/** Optimal string alignment distance (Levenshtein + adjacent transpositions), capped. */
export function osaDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const n = a.length, m = b.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => {
    const row = new Array<number>(m + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
      d[i][j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
  }
  return d[n][m];
}

/** Closest vocabulary word, or null when none is close enough or the best match is ambiguous. */
export function closestWord(word: string, vocab: readonly string[] = VOCAB): string | null {
  if (word.length < 4) return null;
  const max = word.length >= 7 ? 2 : 1;
  let best: string | null = null, bestD = max + 1, tie = false;
  for (const v of vocab) {
    if (Math.abs(v.length - word.length) > max) continue;
    const dist = osaDistance(word, v, max);
    if (dist < bestD) { best = v; bestD = dist; tie = false; }
    else if (dist === bestD && v !== best) tie = true;
  }
  if (!best || bestD > max) return null;
  // Same distance to two different words: only accept when they share the stem (e.g. «сделки»/«сделку»).
  if (tie && bestD > 0) {
    const stem = best.slice(0, 4);
    const all = vocab.filter((v) => Math.abs(v.length - word.length) <= max && osaDistance(word, v, max) === bestD);
    if (!all.every((v) => v.startsWith(stem))) return null;
  }
  return best;
}

const PUNCT = /[,;!?«»"“”„()[\]{}]/;
const CYR = /^[\p{Script=Cyrillic}]+$/u;
const LAT = /^[a-z[\];',.`]+$/;

export interface PrepareOptions {
  /** Words that must never be corrected (trader names, setups, known tickers — lowercase). */
  protect?: ReadonlySet<string>;
  /** Known tickers (uppercase) — a Latin word that is a ticker is never re-read as Russian. */
  tickers?: ReadonlySet<string>;
  /** Latin words the EN / UZ rules use (never «fixed»; typo targets). */
  latinKnown?: ReadonlySet<string>;
}

/** Apostrophe-like characters inside a Latin word (oʻ gʻ, taʼlim, don't). */
const APOS = /['`ʻʼ‘’]/g;
/** Uzbek case endings: a Latin word ending with one is not typo-corrected (agglutination, not a typo). */
const UZ_ENDING = /(?:da|dan|ga|ni|ning|lar|lari|larda|gacha|dagi|niki)$/;

function isProtected(w: string, protect: ReadonlySet<string>): boolean {
  if (protect.has(w)) return true;
  for (const p of protect) if (p.length >= 3 && w.startsWith(p) && w.length - p.length <= 4) return true;
  return false;
}

function normChar(ch: string): string {
  let c = ch.toLowerCase();
  if (c.length !== 1) c = ch.length === 1 ? ch : " ";
  if (c === "ё") c = "е";
  if (PUNCT.test(c)) c = " ";
  return c;
}

export function prepare(orig: string, opts: PrepareOptions = {}): Prepared {
  const protect = opts.protect ?? new Set<string>();
  const tickers = opts.tickers ?? new Set<string>();
  const latin = opts.latinKnown ?? new Set<string>();
  const latinVocab = [...latin].filter((w) => w.length >= 5);
  const chars = [...orig];
  // Character offsets into `orig` (UTF-16) for each code point.
  const offs: number[] = [];
  let o = 0;
  for (const ch of chars) { offs.push(o); o += ch.length; }
  offs.push(o);

  let text = "";
  const src: Array<[number, number]> = [];
  const corrections: Correction[] = [];
  const push = (s: string, start: number, end: number) => {
    for (const c of s) { text += c; src.push([start, end]); }
  };

  let i = 0;
  while (i < chars.length) {
    const c0 = normChar(chars[i]);
    // A "word" = run of letters (Latin words may include the layout punctuation [ ] ; ' ` and Uzbek apostrophes).
    if (/\p{L}/u.test(c0) && !/[ʻʼ]/.test(c0)) {
      let j = i;
      let w = "";
      while (j < chars.length) {
        const raw = chars[j];
        const c = normChar(raw);
        const latinWord = /^[a-z]/.test(w);
        if (/\p{L}/u.test(c) && !/[ʻʼ]/.test(c)) { w += c; j++; }
        else if (latinWord && (/[[\];'`ʻʼ‘’]/.test(raw))) { w += raw; j++; }
        else break;
      }
      const start = offs[i], end = offs[j];
      const bare = w.replace(APOS, "");
      let out = w;
      const fix = (to: string) => { out = to; corrections.push({ from: orig.slice(start, end), to }); };
      if (NUM_WORDS[bare] != null) out = String(NUM_WORDS[bare]);
      else if (CYR.test(w)) {
        if (!VOCAB_SET.has(w) && !STOP.has(w) && !isProtected(w, protect)) {
          const f = closestWord(w);
          if (f && f !== w) fix(f);
        }
      } else if (/^[a-z]/.test(w)) {
        const known = latin.has(bare) || protect.has(bare) || tickers.has(bare.toUpperCase());
        const lower = orig.slice(start, end) === orig.slice(start, end).toLowerCase();
        if (!known && lower && bare.length >= 6 && /^[a-z]+$/.test(bare) && !UZ_ENDING.test(bare) && !isProtected(bare, protect)) {
          const f = closestWord(bare, latinVocab);
          if (f && f !== bare) fix(f);
        }
        if (out === w && !known && LAT.test(w) && w.length >= 4 && !tickers.has(w.toUpperCase()) && !protect.has(w)) {
          const ru = fromWrongLayout(w);
          const f = ru ? (VOCAB_SET.has(ru) || STOP.has(ru) ? ru : closestWord(ru)) : null;
          if (f) fix(f);
        }
        if (out === w) out = bare;
      }
      if (out === w) for (let k = i; k < j; k++) push(normChar(chars[k]), offs[k], offs[k + 1]);
      else push(out, start, end);
      i = j;
      continue;
    }
    push(c0, offs[i], offs[i + 1]);
    i++;
  }
  return { text, src, corrections };
}

/** Map a [a, b) span of the prepared text back to the original string. */
export function mapSpan(p: Prepared, a: number, b: number): [number, number] {
  if (!p.src.length || b <= a) return [0, 0];
  const s = p.src[Math.min(a, p.src.length - 1)][0];
  const e = p.src[Math.min(b - 1, p.src.length - 1)][1];
  return [s, e];
}
