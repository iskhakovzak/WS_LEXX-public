// «Спроси журнал» — basic Uzbek (Latin) question rules («INTC shortlar oktabrda 11:00 dan keyin», «juma kunlari
// win rate», «ertalab vs tushdan keyin», «qachon eng koʻp yoʻqotaman»). prepare() drops the apostrophes of oʻ / gʻ / ʼ
// («koʻp» → «kop», «boʻyicha» → «boyicha»), so the patterns below are written without them. Case endings attach to
// numbers and months («11:00dan», «15-oktabrgacha»): patterns allow an optional space or hyphen before them.

import type { AskDim } from "./types";
import {
  fx, HH, NUM, clock, dayMonth, monthRange, partsOf, plausibleBareHour, resolveYear, toNum, unitSeconds, validYmd, ymd,
  type Handler, type ruleBook, type State,
} from "./kit";

type Book = ReturnType<typeof ruleBook>;

const MONS = "(yanvar|fevral|mart|aprel|may|iyun|iyul|avgust|sentabr|sentyabr|oktabr|oktyabr|noyabr|dekabr)";
const MONTHS = ["yan", "fev", "mar", "apr", "may", "iyun", "iyul", "avg", "sen", "okt", "noy", "dek"];
const monthIndex = (w: string | undefined): number | null => {
  if (!w) return null;
  const i = MONTHS.findIndex((s) => w.startsWith(s));
  return i < 0 ? null : i + 1;
};
/** «2025-yil » / «2025 » before a month. */
const YEAR_PRE = "(?:(20\\d{2})\\s*-?\\s*(?:yil\\p{L}*\\s+)?)?";
const SUF = "\\s*-?\\s*";

const UNIT = "(soniya|sekund|daqiqa|minut|soat)";
const CUR_RE = /\$|dollar|narx/;
const LOSS_W = "zarar\\p{L}*|yutqaz\\p{L}*";
const WIN_W = "foydali\\s+savdo\\p{L}*|foyda\\p{L}*|yutuq\\p{L}*";
const isLossWord = (w: string) => /^(zarar|yutqaz)/.test(w);

const TARGET = "hafta\\s+kun\\p{L}*|tiker\\p{L}*|aksiya\\p{L}*|kun\\p{L}*|soat\\p{L}*|vaqt\\p{L}*|oy\\p{L}*|hafta\\p{L}*|savdo\\p{L}*|yonalish\\p{L}*|setap\\p{L}*|treyder\\p{L}*|sessiya\\p{L}*";
const TARGET_MAP: Array<[RegExp, AskDim]> = [
  [/^hafta kun/, "weekday"], [/^treyder/, "trader"], [/^(tiker|aksiya)/, "ticker"], [/^kun/, "day"], [/^(soat|vaqt)/, "hour"],
  [/^sessiya/, "slot"], [/^oy/, "month"], [/^hafta/, "week"], [/^savdo/, "trade"], [/^yonalish/, "side"], [/^setap/, "setup"],
];
const targetOf = (w: string | undefined): AskDim | null => (w ? TARGET_MAP.find(([r]) => r.test(w.replace(/\s+/g, " ")))?.[1] ?? null : null);

const GROUP = "hafta\\s+kun(?:lari)?|kirish\\s+soat(?:lari)?|kun\\s+vaqti|tiker(?:lar)?|aksiya(?:lar)?|kun(?:lar)?|soat(?:lar)?|oy(?:lar)?|hafta(?:lar)?|yonalish(?:lar)?|tomon(?:lar)?|setap(?:lar)?|treyder(?:lar)?|ushlab\\s+turish|davomiylik|olcham|hajm|sessiya(?:lar)?|vaqt";
const GROUPS: Array<[RegExp, AskDim]> = [
  [/^hafta kun/, "weekday"], [/^(tiker|aksiya)/, "ticker"], [/^(kun vaqt|sessiya|vaqt)/, "slot"], [/^kun/, "day"], [/^(soat|kirish)/, "hour"],
  [/^oy/, "month"], [/^hafta/, "week"], [/^(yonalish|tomon)/, "side"], [/^setap/, "setup"], [/^treyder/, "trader"],
  [/^(ushlab|davomiylik)/, "holdBucket"], [/^(olcham|hajm)/, "sizeBucket"],
];

const WD = "dushanba\\p{L}*|seshanba\\p{L}*|chorshanba\\p{L}*|payshanba\\p{L}*|juma\\p{L}*";
const weekdayIndex = (w: string): number | null => {
  const i = ["dush", "sesh", "chor", "pay", "jum"].findIndex((s) => w.startsWith(s));
  return i < 0 ? null : i;
};

export const UZ_NAME_PREFIX = "treyder\\s+";
export const UZ_NAME_SUFFIX = "ning|ni|ga|da|dan|niki";
/** Case endings after a ticker: «INTCda», «NVDAni», «AAPLlar». */
export const UZ_TICKER_SUFFIX = "da|dan|ni|ning|ga|dagi|gacha|lar|larda|lari";

/** Function words the leftover pass ignores. */
export const UZ_NOISE = [
  "savdo", "savdolar", "savdolarim", "savdolarni", "savdolarda", "savdolarning", "savdolari", "mening", "menga", "men", "meni", "va", "bilan",
  "uchun", "da", "dan", "ga", "ni", "ning", "qanday", "nima", "nimaga", "korsat", "korsating", "ber", "bering", "ayt", "ayting", "iltimos",
  "qilib", "edi", "bor", "ham", "hammasi", "hammasini", "barchasi", "umumiy", "ta", "keyin", "oldin", "gacha", "beri", "boshlab", "boyicha",
  "qilgan", "qildim", "ochgan", "yopgan", "ketdi", "ketgan", "sarfladim", "toladim", "jurnal", "jurnaldan", "jurnalda", "treyder", "aksiya",
  "aksiyalar", "dona", "pozitsiya", "narx", "narxi", "kirish", "holatda", "payt", "paytda", "eng", "pul", "kun", "kuni", "kunlari", "yil",
  "hisobda", "orasida", "hafta", "oy", "vaqt", "soat", "qaysi", "qancha", "nechta", "bu", "shu", "u", "ular", "butun", "barcha", "hamma", "kerak", "boladi", "bolgan",
];

function facets(b: Book) {
  b.add("scope", "(?:butun|barcha|hamma)\\s+vaqt\\p{L}*(?:\\s+uchun)?|umuman|har\\s+doim|doim|butun\\s+tarix\\p{L}*", (_m, st) => fx.allTime(st));
  b.add("scope", "(?:barcha|hamma|butun)\\s+treyder\\p{L}*|butun\\s+desk\\p{L}*|(?:butun\\s+)?jamoa\\p{L}*|desk\\p{L}+", (_m, st) => fx.desk(st));

  b.add("last", "(?:oxirgi|songgi)\\s+(\\d{1,4})\\s+(?:ta\\s+)?savdo\\p{L}*", (m, st) => fx.lastN(st, Number(m[1])));
  b.add("last", "(?:oxirgi|songgi)\\s+(savdo\\p{L}*)", (m, st) => fx.lastOne(st, m[1] === "savdo"));

  b.add("after", `(?:ketma-?ket\\s+)?(?:(\\d{1,2})\\s+(?:ta\\s+)?)?(?:ketma-?ket\\s+)?(${LOSS_W}|${WIN_W})(?:\\s+savdo\\p{L}*)?\\s+keyin(?:gi)?`, (m, st) =>
    fx.after(st, isLossWord(m[2]) ? "loss" : "win", m[1]));

  b.add("streak", "(?:(kun|savdo)lar\\s+boyicha\\s+)?(?:eng\\s+(?:uzun|katta)\\s+)?(?:(zarar\\p{L}*|yutqaz\\p{L}*|yutuq\\p{L}*|foyda\\p{L}*)\\s+)?seriya\\p{L}*(?:\\s+(kun|savdo)lar\\s+boyicha)?", (m, st) =>
    fx.streak(st, m[2] ? (isLossWord(m[2]) ? "loss" : "win") : null, m[1] === "kun" || m[3] === "kun" ? "day" : "trade"));
  b.add("streak", "ketma-?ket\\s+(zarar\\p{L}*|yutqaz\\p{L}*|yutuq\\p{L}*|foydali)(?:\\s+(savdo|kun)\\p{L}*)?|(zarar\\p{L}*|yutuq\\p{L}*|foydali)(?:\\s+(savdo|kun)\\p{L}*)?\\s+ketma-?ket", (m, st) =>
    fx.streak(st, isLossWord(m[1] ?? m[3]) ? "loss" : "win", (m[2] ?? m[4]) === "kun" ? "day" : "trade"));

  b.add("which", `qaysi\\s+(${TARGET})`, (m, st) => fx.which(st, targetOf(m[1])));
  b.add("which", "zaif\\s+(?:joy|tomon)\\p{L}*|qayerda\\s+(?:pul\\s+)?yoqotaman|nimada\\s+yutqazaman", (_m, st) => fx.leak(st, "worst"));
  b.add("which", "kuchli\\s+(?:joy|tomon)\\p{L}*|nima\\s+(?:eng\\s+yaxshi\\s+)?ishlaydi", (_m, st) => fx.leak(st, "best"));
  b.add("which", "qachon|qayerda|qaysi\\s+paytda|qanday\\s+holatda", (_m, st) => fx.when(st));
  b.add("which", "eng\\s+kop", (_m, st) => fx.most(st));
  b.add("which", "qancha\\s+(?:pul\\s+)?(ishladim|topdim|yutdim|yoqotdim|yutqazdim)|(ishladim|topdim|yoqotdim|yutqazdim)", (m, st) =>
    fx.earned(st, /^(ishla|top|yut(?!qaz))/.test(m[1] ?? m[2]) ? "earn" : "lose"));
  b.add("which", "(?:pul\\s+)?yoqot\\p{L}*|yutqaz\\p{L}*|zarar\\s+kor\\p{L}*", (_m, st) => fx.verb(st, "lose"));
  b.add("which", "pul\\s+ishla\\p{L}*|ishlayman|topaman|daromad\\s+qil\\p{L}*", (_m, st) => fx.verb(st, "earn"));
  b.add("which", "yaxshiroq|yomonroq|yoki", (_m, st) => fx.weakCompare(st));

  // Hold time: «5 daqiqadan uzoq», «30 soniyadan qisqa», «1 dan 5 daqiqagacha», «5 daqiqagacha».
  b.add("hold", `${NUM}${SUF}(?:${UNIT}${SUF})?dan\\s+${NUM}\\s*${UNIT}${SUF}gacha`, (m, st) => {
    const unitB = unitSeconds(m[4]);
    return fx.holdRange(st, toNum(m[1]) * (m[2] ? unitSeconds(m[2]) : unitB), toNum(m[3]) * unitB);
  });
  b.add("hold", `${NUM}\\s*[-–]\\s*${NUM}\\s*${UNIT}(?:lik)?`, (m, st) => {
    const u = unitSeconds(m[3]);
    return fx.holdRange(st, toNum(m[1]) * u, toNum(m[2]) * u);
  });
  const bound = (dir: "min" | "max"): Handler => (m, st) => fx.holdBound(st, dir, (m[1] ? toNum(m[1]) : 1) * unitSeconds(m[2]));
  b.add("hold", `(?:${NUM}\\s*)?${UNIT}${SUF}dan\\s+(?:uzoq|kop|ortiq|ziyod|koproq|uzunroq)`, bound("min"));
  b.add("hold", `kamida\\s+${NUM}\\s*${UNIT}`, bound("min"));
  b.add("hold", `(?:${NUM}\\s*)?${UNIT}${SUF}dan\\s+(?:qisqa|kam|tez|kamroq|qisqaroq)`, bound("max"));
  b.add("hold", `${NUM}\\s*${UNIT}${SUF}gacha`, bound("max"));
  b.add("hold", "skalp\\p{L}*|tez\\s+savdo\\p{L}*", (_m, st) => fx.holdBound(st, "max", 60));

  // Size: «500 aksiyadan kop», «hajmi 100 dan 500 aksiyagacha», «kamida 500 aksiya».
  const SZ = "(?:olcham\\p{L}*|hajm\\p{L}*)";
  b.add("qty", `(${SZ}\\s+)?(\\d+)\\s*(?:[-–]|${SUF}dan\\s+)\\s*(\\d+)\\s*(?:ta\\s+)?(aksiya\\p{L}*)?`, (m, st) => (!m[1] && !m[4] ? false : fx.qtyRange(st, Number(m[2]), Number(m[3]))));
  b.add("qty", `(${SZ}\\s+)?(\\d+)\\s*(?:ta\\s+)?(aksiya\\p{L}*?)?${SUF}dan\\s+(kop|ortiq|ziyod|koproq|kam|kamroq)`, (m, st) =>
    (!m[1] && !m[3] ? false : fx.qtyBound(st, /^kam/.test(m[4]), Number(m[2]))));
  b.add("qty", "kamida\\s+(\\d+)\\s*(?:ta\\s+)?aksiya\\p{L}*", (m, st) => fx.qtyBound(st, false, Number(m[1])));

  // Price: «10$ dan arzon», «narxi 5 dan 20$ gacha», «10$ gacha».
  b.add("price", `(?:narx\\p{L}*\\s+)?\\$?\\s*${NUM}\\s*\\$?${SUF}dan\\s+\\$?\\s*${NUM}\\s*(?:\\$|dollar\\p{L}*)?${SUF}gacha`, (m, st) =>
    (CUR_RE.test(m[0]) ? fx.priceRange(st, toNum(m[1]), toNum(m[2])) : false));
  b.add("price", `(narx\\p{L}*\\s+)?\\$?\\s*${NUM}\\s*(\\$|dollar\\p{L}*?)?${SUF}dan\\s+(arzon\\p{L}*|past\\p{L}*|qimmat\\p{L}*|yuqori\\p{L}*|kam|kop|ortiq)`, (m, st) => {
    if (!CUR_RE.test(m[0]) && !/^(arzon|qimmat)/.test(m[4])) return false;
    return fx.priceBound(st, /^(arzon|past|kam)/.test(m[4]) ? "max" : "min", toNum(m[2]));
  });
  b.add("price", `(?:narx\\p{L}*\\s+)?\\$\\s*${NUM}${SUF}gacha|${NUM}\\s*(?:\\$|dollar\\p{L}*?)${SUF}gacha`, (m, st) => fx.priceBound(st, "max", toNum(m[1] ?? m[2])));
}

function dates(b: Book) {
  const day = (st: State, d: string, mon: string, year?: string) => dayMonth(st.today, d, monthIndex(mon), year);
  b.add("dates", `(\\d{1,2})${SUF}${MONS}dan\\s+(\\d{1,2})${SUF}${MONS}gacha`, (m, st) => {
    const end = day(st, m[3], m[4]);
    return fx.span(st, end ? day(st, m[1], m[2], end.slice(0, 4)) : null, end);
  });
  b.add("dates", `(\\d{1,2})${SUF}dan\\s+(\\d{1,2})${SUF}${MONS}gacha`, (m, st) => {
    const end = day(st, m[2], m[3]);
    if (!end) return false;
    const [y, mo] = partsOf(end);
    return fx.span(st, validYmd(y, mo, Number(m[1])) ? ymd(y, mo, Number(m[1])) : null, end);
  });
  b.add("dates", `${YEAR_PRE}(\\d{1,2})\\s*[-–]\\s*(\\d{1,2})${SUF}${MONS}\\p{L}*`, (m, st) => fx.span(st, day(st, m[2], m[4], m[1]), day(st, m[3], m[4], m[1])));
  b.add("dates", "(\\d{4}-\\d{2}-\\d{2})\\s*-?\\s*dan\\s+(\\d{4}-\\d{2}-\\d{2})\\s*-?\\s*gacha", (m, st) => {
    const [a, c] = [m[1], m[2]].map(partsOf);
    return validYmd(...a) && validYmd(...c) ? fx.span(st, m[1], m[2]) : false;
  });
  // «sentabrdan oktabrgacha» — from the first day of one month to the last day of another.
  b.add("dates", `${MONS}dan\\s+${MONS}gacha`, (m, st) => {
    const a = monthIndex(m[1]), c = monthIndex(m[2]);
    if (!a || !c) return false;
    const endY = resolveYear(c, st.today);
    return fx.span(st, monthRange(a > c ? endY - 1 : endY, a).from, monthRange(endY, c).to);
  });
  b.add("dates", `${YEAR_PRE}(\\d{1,2})${SUF}${MONS}dan(?:\\s+(?:beri|boshlab))?`, (m, st) => fx.since(st, day(st, m[2], m[3], m[1])));
  b.add("dates", `${YEAR_PRE}(\\d{1,2})${SUF}${MONS}gacha`, (m, st) => fx.until(st, day(st, m[2], m[3], m[1])));
  b.add("dates", `${MONS}dan(?:\\s+(?:beri|boshlab))?`, (m, st) => fx.sinceMonth(st, monthIndex(m[1])));
  b.add("dates", `${YEAR_PRE}(\\d{1,2})${SUF}${MONS}(?:da|dagi|ning)?(?:\\s+kuni)?(?:\\s+(20\\d{2}))?`, (m, st) => fx.day(st, day(st, m[2], m[3], m[1] ?? m[4])));
  b.add("dates", `(20\\d{2})${SUF}(?:yil\\p{L}*\\s+)?${MONS}(?:da|dagi|ning)?|${MONS}(?:da|dagi)?\\s+(20\\d{2})(?:${SUF}yil\\p{L}*)?`, (m, st) =>
    fx.month(st, monthIndex(m[2] ?? m[3]), m[1] ?? m[4]));
  b.add("dates", `(20\\d{2})${SUF}yil\\p{L}*`, (m, st) => fx.year(st, Number(m[1])));
  b.add("dates", `${YEAR_PRE}([1-4])${SUF}chorak\\p{L}*`, (m, st) => fx.quarter(st, Number(m[2]), m[1]));

  b.add("relDates", "bugun\\p{L}*", (_m, st) => fx.period(st, "today"));
  b.add("relDates", "otgan\\s+kuni|kechadan\\s+oldingi\\s+kun\\p{L}*", (_m, st) => fx.period(st, "dayBefore"));
  b.add("relDates", "kecha\\p{L}*", (_m, st) => fx.period(st, "yesterday"));
  b.add("relDates", "otgan\\s+hafta\\p{L}*", (_m, st) => fx.period(st, "lastWeek"));
  b.add("relDates", "(?:bu|shu|joriy)\\s+hafta\\p{L}*", (_m, st) => fx.period(st, "thisWeek"));
  b.add("relDates", "(?:oxirgi|songgi)\\s+hafta\\p{L}*|(?:oxirgi|songgi)\\s+7\\s+kun\\p{L}*", (_m, st) => fx.period(st, "pastWeek"));
  b.add("relDates", "(?:oxirgi|songgi)\\s+(\\d{1,3})\\s+(kun|hafta|oy)\\p{L}*", (m, st) => fx.lastPeriod(st, Number(m[1]), m[2] === "hafta" ? "week" : m[2] === "oy" ? "month" : "day"));
  b.add("relDates", "otgan\\s+oy\\p{L}*", (_m, st) => fx.period(st, "lastMonth"));
  b.add("relDates", "(?:bu|shu|joriy)\\s+oy\\p{L}*", (_m, st) => fx.period(st, "thisMonth"));
  b.add("relDates", "(?:oxirgi|songgi)\\s+oy\\p{L}*", (_m, st) => fx.period(st, "pastMonth"));
  b.add("relDates", "otgan\\s+chorak\\p{L}*", (_m, st) => fx.period(st, "lastQuarter"));
  b.add("relDates", "(?:bu|shu|joriy)\\s+chorak\\p{L}*", (_m, st) => fx.period(st, "thisQuarter"));
  b.add("relDates", "yil\\s+boshidan(?:\\s+beri)?|(?:bu|shu|joriy)\\s+yil\\p{L}*", (_m, st) => fx.period(st, "ytd"));
  b.add("relDates", "otgan\\s+yil\\p{L}*", (_m, st) => fx.period(st, "lastYear"));
  b.add("relDates", "(?:oxirgi|songgi)\\s+yil\\p{L}*", (_m, st) => fx.period(st, "pastYear"));
  b.add("relDates", "(dushanba|seshanba|chorshanba|payshanba|juma)(?:da|\\s+kuni)", (m, st) => fx.weekdayDate(st, weekdayIndex(m[1]) ?? 0));
  b.add("relDates", `${MONS}(?:da|dagi|ning|ni)?(?:\\s+(20\\d{2}))?(?:\\s+uchun)?`, (m, st) => fx.month(st, monthIndex(m[1]), m[2]));
}

function timeAndIntents(b: Book) {
  b.add("sessions", "tushdan\\s+keyin(?:gi)?|kunning\\s+ikkinchi\\s+yarmi\\p{L}*", (_m, st) => fx.session(st, "afternoon"));
  b.add("sessions", "premarket\\p{L}*|pre-market\\p{L}*|ochilishdan\\s+oldin(?:gi)?", (_m, st) => fx.session(st, "premarket"));
  b.add("sessions", "postmarket\\p{L}*|yopilishdan\\s+keyin(?:gi)?", (_m, st) => fx.session(st, "postmarket"));
  b.add("sessions", "power\\s*hour\\p{L}*|oxirgi\\s+soat\\p{L}*|kun\\s+oxiri\\p{L}*|yopilishdan\\s+oldin(?:gi)?", (_m, st) => fx.session(st, "powerHour"));
  b.add("sessions", "birinchi\\s+soat\\p{L}*", (_m, st) => fx.session(st, "firstHour"));
  b.add("sessions", "ochilish\\p{L}*|birinchi\\s+30\\s+daqiqa\\p{L}*", (_m, st) => fx.session(st, "open"));
  b.add("sessions", "ertalab\\p{L}*", (_m, st) => fx.session(st, "morning"));
  b.add("sessions", "tushlik\\p{L}*|tush\\s+payti\\p{L}*|kun\\s+ortasi\\p{L}*", (_m, st) => fx.session(st, "lunch"));

  // Time: «10:00 dan 11:30 gacha», «11:00 dan keyin», «soat 14 dan keyin», «10:30 gacha».
  b.add("time", `(?:soat\\s+)?${HH}${SUF}dan\\s+(?:soat\\s+)?${HH}${SUF}gacha`, (m, st) => {
    if (!m[2] && !m[4] && !(plausibleBareHour(m[1]) && plausibleBareHour(m[3]))) return false;
    return fx.timeRange(st, clock(m[1], m[2]), clock(m[3], m[4]));
  });
  b.add("time", `(?:soat\\s+)?${HH}${SUF}dan\\s+(?:keyin|song)`, (m, st) => (!m[2] && !plausibleBareHour(m[1]) ? false : fx.timeAfter(st, clock(m[1], m[2]))));
  b.add("time", `(?:soat\\s+)?${HH}${SUF}(?:gacha|dan\\s+oldin)`, (m, st) => (!m[2] && !plausibleBareHour(m[1]) ? false : fx.timeBefore(st, clock(m[1], m[2]))));

  b.add("weekdays", `(?:${WD})(?:\\s*(?:va|,|\\/)\\s*(?:${WD}))*(?:\\s+kun(?:lari|larida|lar)\\p{L}*)?`, (m, st) =>
    fx.weekdays(st, [...m[0].matchAll(/\p{L}+/gu)].map((x) => weekdayIndex(x[0]))));

  b.add("intents", "solishtir\\p{L}*|taqqosla\\p{L}*|qiyosla\\p{L}*", (_m, st) => fx.strongCompare(st));
  b.add("intents", `(?:(top|antitop)[\\s-]*(\\d{1,2})?|(?:(\\d{1,2})\\s+(?:ta\\s+)?)?eng\\s+(yaxshi|yomon|foydali|zararli|kuchli|zaif))(?:\\s+(\\d{1,2})\\s*(?:ta)?)?(?:\\s+(${TARGET}))?`, (m, st) => {
    const word = m[1] ?? m[4];
    return fx.best(st, {
      worst: /^(antitop|yomon|zararli|zaif)$/.test(word),
      n: Number(m[2] ?? m[3] ?? m[5] ?? 0),
      dim: targetOf(m[6]),
      plural: Boolean(m[6] && /lar/.test(m[6])),
    });
  });
  // «top 5 tiker»: the EN «top 5» rule ran first (same stage) and left the Uzbek target word.
  b.add("intents", `(${TARGET})`, (m, st) => (st.d.best && !st.d.target ? fx.best(st, { worst: st.d.best === "worst", dim: targetOf(m[1]), plural: /lar/.test(m[1]) }) : false));
  b.add("intents", "komissiya\\p{L}*|xarajat\\p{L}*|tolov\\p{L}*", (_m, st) => fx.explicit(st, "fees"));
  b.add("intents", "vinreyt\\p{L}*|yutuq\\s+foiz\\p{L}*|aniqlik", (_m, st) => fx.explicit(st, "winrate"));
  b.add("intents", "profit[\\s-]*faktor\\p{L}*", (_m, st) => fx.explicit(st, "pf"));
  b.add("intents", "(?:maks(?:imal)?\\.?\\s+)?(?:pasayish|drawdown)\\p{L}*", (_m, st) => fx.explicit(st, "drawdown"));
  b.add("intents", "ortacha\\s+ushlab\\s+turish\\p{L}*|ushlab\\s+turish\\s+vaqti\\p{L}*|qancha\\s+(?:vaqt\\s+)?ushlayman|ortacha\\s+davomiylik\\p{L}*", (_m, st) => fx.explicit(st, "hold"));
  b.add("intents", "ortacha\\s+(?:olcham|hajm)\\p{L}*|pozitsiya\\s+(?:olcham|hajm)\\p{L}*", (_m, st) => fx.explicit(st, "size"));
  b.add("intents", `(${GROUP})\\s+boyicha|har\\s+bir\\s+(tiker|kun|soat|oy|hafta|setap|treyder)`, (m, st) => {
    const w = (m[1] ?? m[2]).replace(/\s+/g, " ");
    return fx.group(st, GROUPS.find(([r]) => r.test(w))?.[1] ?? null);
  });
  b.add("intents", "ortacha(?:\\s+hisobda)?|kutilma\\p{L}*", (_m, st) => fx.explicit(st, "avg"));
  b.add("intents", "nechta(?:\\s+savdo\\p{L}*)?|savdolar\\s+soni|soni|qancha\\s+savdo\\p{L}*|miqdor\\p{L}*", (_m, st) => fx.explicit(st, "count"));
  b.add("intents", "sof(?:\\s+foyda)?|natija\\p{L}*|foyda(?:si)?|jami|daromad\\p{L}*", (_m, st) => fx.explicit(st, "sum"));
  b.add("intents", "qancha", (_m, st) => fx.countHint(st));

  b.add("sides", "long(?:lar|i|ni|da|ga)\\p{L}*|short(?:lar|i|ni|da|ga)\\p{L}*", (m, st) => fx.side(st, m[0].startsWith("long") ? "Long" : "Short"));
  b.add("sides", "zararli\\p{L}*|zarar|minus(?:dagi)?|qizil", (_m, st) => fx.outcome(st, "loss"));
  b.add("sides", "foydali\\p{L}*|yutuqli\\p{L}*|plyus(?:dagi)?|yashil", (_m, st) => fx.outcome(st, "win"));
  b.add("sides", "nolda(?:gi)?|zararsiz\\p{L}*", (_m, st) => fx.outcome(st, "breakeven"));

  b.add("setup", "(?:setap\\p{L}*|strategiya\\p{L}*)\\s+([\\p{L}\\p{N}][\\p{L}\\p{N}\\-]*(?:\\s+(?:and|&|va|n)\\s+[\\p{L}\\p{N}][\\p{L}\\p{N}\\-]*)?)", (m, st) =>
    fx.setup(st, m[1], /^(boyicha|va|bilan|uchun)$/));
}

export function addUzRules(b: Book): void {
  facets(b);
  dates(b);
  timeAndIntents(b);
}
