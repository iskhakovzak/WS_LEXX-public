// «Спроси журнал» — Russian question rules (input vocabulary: Russian words are data here, not UI text).
// Ported 1:1 from the original parser; every rule only matches and calls an effect from ./kit.

import type { AskDim } from "./types";
import { fx, HH, NUM, clock, dayMonth, partsOf, plausibleBareHour, toNum, unitSeconds, validYmd, ymd, type Handler, type ruleBook, type State } from "./kit";

type Book = ReturnType<typeof ruleBook>;

const MON = "(январ\\p{L}*|феврал\\p{L}*|март\\p{L}*|апрел\\p{L}*|ма[йяею]|июн\\p{L}*|июл\\p{L}*|август\\p{L}*|сентябр\\p{L}*|октябр\\p{L}*|ноябр\\p{L}*|декабр\\p{L}*|янв|фев|мар|апр|авг|сент|сен|окт|ноя|дек)\\.?";
const MONTH_STEMS: Array<[RegExp, number]> = [
  [/^янв/, 1], [/^фев/, 2], [/^мар/, 3], [/^апр/, 4], [/^ма[йяею]$/, 5], [/^июн/, 6], [/^июл/, 7],
  [/^авг/, 8], [/^сен/, 9], [/^окт/, 10], [/^ноя/, 11], [/^дек/, 12],
];
function monthIndex(word: string): number | null {
  const w = word.replace(/\.$/, "");
  for (const [r, m] of MONTH_STEMS) if (r.test(w)) return m;
  return null;
}

const UNIT = "(секунд\\p{L}*|сек|с|минут\\p{L}*|мин|м|час\\p{L}*|ч)";
const CUR_RE = /\$|долл|usd|бакс|цен/;
const LOSS_W = "убыт\\p{L}*|убыточн\\p{L}*|лосс\\p{L}*|минус\\p{L}*|стоп\\p{L}*|проигрыш\\p{L}*|поражени\\p{L}*|красн\\p{L}*";
const WIN_W = "прибыльн\\p{L}*|профит\\p{L}*|плюс\\p{L}*|выигрыш\\p{L}*|побед\\p{L}*|зелен\\p{L}*";
const isLossWord = (w: string) => /^(убыт|лосс|минус|стоп|проигр|пораж|красн)/.test(w);

const TARGET = "дн\\p{L}*\\s+недели|день\\s+недели|тикер\\p{L}*|бумаг\\p{L}*|акци\\p{L}*|дн(?:и|ей|я|ям)|день|час(?:ы|ов|а)?|время|месяц\\p{L}*|недел\\p{L}*|сделк\\p{L}*|сделок|трейд(?:ы|ов|а)?|сторон\\p{L}*|направлени\\p{L}*|сетап\\p{L}*|setup\\p{L}*|трейдер\\p{L}*|сесси\\p{L}*";
const TARGET_MAP: Array<[RegExp, AskDim]> = [
  [/^(дн\p{L}*|день) недели/u, "weekday"], [/^трейдер/, "trader"], [/^(тикер|бумаг|акци)/, "ticker"], [/^(дн|день)/, "day"],
  [/^(час|время)/, "hour"], [/^сесси/, "slot"], [/^месяц/, "month"], [/^недел/, "week"], [/^(сделк|сделок|трейд)/, "trade"],
  [/^(сторон|направлен)/, "side"], [/^(сетап|setup)/, "setup"],
];
const PLURAL_TARGET = /^(тикеры|тикеров|тикера|акции|акций|бумаги|бумаг|дни|дней|часы|часов|сделки|сделок|трейды|трейдов|месяцы|месяцев|недели|недель|сетапы|сетапов|сессии|трейдеры|трейдеров)/;
const targetOf = (w: string | undefined): AskDim | null => {
  if (!w) return null;
  const s = w.replace(/\s+/g, " ");
  return TARGET_MAP.find(([r]) => r.test(s))?.[1] ?? null;
};

function weekdayIndex(w: string): number | null {
  if (/^(понедельн|пн$)/.test(w)) return 0;
  if (/^(вторн|вт$)/.test(w)) return 1;
  if (/^сред[аыу]?$|^средам$/.test(w)) return 2;
  if (/^(четверг|чт$)/.test(w)) return 3;
  if (/^(пятниц|пт$)/.test(w)) return 4;
  return null;
}
const WEEKDAYS: Record<string, number> = { понедельник: 0, вторник: 1, среду: 2, четверг: 3, пятницу: 4 };

const GROUPS: Array<[RegExp, AskDim]> = [
  [/^дням недели/, "weekday"], [/^(тикерам|бумагам|акциям)/, "ticker"], [/^дням/, "day"], [/^часам/, "hour"], [/^месяцам/, "month"],
  [/^неделям/, "week"], [/^(сторонам|направлени)/, "side"], [/^(сетапам|setup)/, "setup"], [/^трейдерам/, "trader"],
  [/^(удержани|длительност|времени удержания)/, "holdBucket"], [/^(размер|объем)/, "sizeBucket"], [/^(времени дня|сессиям|времени)/, "slot"],
];

/** Trader name forms: «у Орифа», «трейдера Тимура», «Орифу». */
export const RU_NAME_PREFIX = "у\\s+|трейдер\\p{L}*\\s+";
export const RU_NAME_SUFFIX = "а|у|ом|е|ым|ой|ы|я|ю|ем|и";

const LATIN: Record<string, string[]> = {
  а: ["a"], б: ["b"], в: ["v"], г: ["g"], д: ["d"], е: ["e"], ё: ["yo", "e"], ж: ["j", "zh"], з: ["z"], и: ["i"], й: ["y", "i"], к: ["k"],
  л: ["l"], м: ["m"], н: ["n"], о: ["o"], п: ["p"], р: ["r"], с: ["s"], т: ["t"], у: ["u"], ф: ["f"], х: ["x", "kh", "h"], ц: ["ts", "s"],
  ч: ["ch"], ш: ["sh"], щ: ["sh", "shch"], ъ: [""], ы: ["y", "i"], ь: [""], э: ["e"], ю: ["yu"], я: ["ya"], ў: ["o"], қ: ["q"], ғ: ["g"], ҳ: ["h"],
};
/** Latin spellings of a Cyrillic name («Ориф» → orif, «Тимур» → timur, «Хасан» → xasan / khasan / hasan), ≤ 8. */
export function latinNames(name: string): string[] {
  let out = [""];
  for (const ch of name.toLowerCase()) {
    const opts = LATIN[ch] ?? [ch];
    out = out.flatMap((p) => opts.map((o) => p + o)).slice(0, 8);
  }
  return out.filter((v) => v.trim() && v !== name.toLowerCase());
}

/** Function words the leftover pass ignores. */
export const RU_NOISE = [
  "сделки", "сделок", "сделка", "сделку", "сделках", "сделкам", "сделками", "трейды", "трейдов", "трейд", "трейдам",
  "мои", "мой", "моих", "моя", "мое", "мне", "меня", "я", "у", "по", "в", "во", "на", "за", "и", "а", "с", "со", "от", "до", "для", "из", "к", "о", "об", "при",
  "все", "всех", "всего", "какой", "какая", "какие", "каким", "каких", "какое", "был", "была", "были", "было", "есть", "самый", "самая", "самое", "самые", "самых",
  "что", "как", "это", "эти", "этот", "покажи", "показать", "найди", "выведи", "список", "дай", "скажи", "пожалуйста", "плиз",
  "ли", "бы", "же", "только", "торговля", "торговли", "торговал", "торговала", "торгую", "торговать", "входы", "вход", "входа", "года", "год", "г", "г.",
  "и/или", "мною", "трейдер", "трейдера", "трейдеру", "журнал", "журнале", "холд", "удержание", "удержания", "удержанием", "держал", "держала", "цена", "цене", "входе",
  "съели", "съедают", "съело", "ушло", "ушли", "потратил", "заплатил", "плачу", "платил", "нам", "чаще", "реже", "всё", "весь", "целом", "общем",
  "сделал", "сделала", "делал", "открывал", "открыл", "закрыл", "акций", "акции", "шт", "позиции", "позиция", "размер", "размером", "раз", "дней", "дня",
];

function facets(b: Book) {
  // Scope and «all time».
  b.add("scope", "за\\s+(?:все|всю)\\s+(?:время|историю|период)|все\\s+время|вся\\s+история|за\\s+весь\\s+период|всегда", (_m, st) => fx.allTime(st));
  b.add("scope", "(?:по\\s+)?(?:всем|все|всех)\\s+трейдер\\p{L}*|(?:весь|всему|всего|по)\\s+деск\\p{L}*|(?:вся|всей|по)\\s+команд\\p{L}*|деск", (_m, st) => fx.desk(st));

  // «последние 20 сделок», «последняя сделка».
  b.add("last", "(?:последн\\p{L}*|крайн\\p{L}*)\\s+(\\d{1,4})\\s+(?:сделк\\p{L}*|сделок|трейд\\p{L}*)", (m, st) => fx.lastN(st, Number(m[1])));
  b.add("last", "(?:последн\\p{L}*|крайн\\p{L}*)\\s+(сделк\\p{L}*|трейд\\p{L}*)", (m, st) => fx.lastOne(st, /^(сделка|сделку|трейд)$/.test(m[1])));

  // «после убытка», «после 2 убытков подряд», «после прибыльной сделки».
  b.add("after", `после\\s+(?:(\\d{1,2})\\s+)?(${LOSS_W}|${WIN_W})(?:\\s+(?:сделк\\p{L}*|сделок|трейд\\p{L}*))?(?:\\s+подряд)?`, (m, st) =>
    fx.after(st, isLossWord(m[2]) ? "loss" : "win", m[1]));

  // Streaks.
  b.add("streak", `(?:(?:сам\\p{L}*\\s+)?(?:длинн\\p{L}*|долг\\p{L}*|больш\\p{L}*|максимальн\\p{L}*|рекордн\\p{L}*)\\s+)?(?:сери\\p{L}*|стрик\\p{L}*)(?:\\s+(?:из\\s+)?(${LOSS_W}|${WIN_W}))?(?:\\s+(?:по\\s+)?(сделкам|сделок|сделки|трейдов|дням|дней|дня|дни))?`, (m, st) =>
    fx.streak(st, m[1] ? (isLossWord(m[1]) ? "loss" : "win") : null, m[2] && /^дн/.test(m[2]) ? "day" : "trade"));
  b.add("streak", `(${LOSS_W}|${WIN_W})\\s+(?:(сделк\\p{L}*|сделок|дн\\p{L}*|дней)\\s+)?подряд`, (m, st) =>
    fx.streak(st, isLossWord(m[1]) ? "loss" : "win", m[2] && /^дн/.test(m[2]) ? "day" : "trade"));

  // Which / when / most — the «когда я теряю больше всего» family.
  b.add("which", `(?:в\\s+|во\\s+|на\\s+|по\\s+|у\\s+)?как(?:ой|ая|ие|их|ом|ую|им|ое|ому)\\s+(${TARGET})`, (m, st) => fx.which(st, targetOf(m[1])));
  b.add("which", "слаб\\p{L}*\\s+(?:мест\\p{L}*|сторон\\p{L}*)|утечк\\p{L}*|где\\s+(?:я\\s+)?слива\\p{L}*|на\\s+ч[е]м\\s+(?:я\\s+)?слива\\p{L}*", (_m, st) => fx.leak(st, "worst"));
  b.add("which", "сильн\\p{L}*\\s+(?:мест\\p{L}*|сторон\\p{L}*)|что\\s+(?:у\\s+меня\\s+)?(?:лучше\\s+всего\\s+)?работает", (_m, st) => fx.leak(st, "best"));
  b.add("which", "когда|где|в\\s+ч[е]м|на\\s+ч[е]м|при\\s+как\\p{L}*\\s+услови\\p{L}*", (_m, st) => fx.when(st));
  b.add("which", "(?:больше|сильнее|чаще)\\s+всего", (_m, st) => fx.most(st));
  b.add("which", "теря\\p{L}*|слива\\p{L}*|проигрыва\\p{L}*|ошиба\\p{L}*", (_m, st) => fx.verb(st, "lose"));
  b.add("which", "зарабатыва\\p{L}*|выигрыва\\p{L}*", (_m, st) => fx.verb(st, "earn"));
  b.add("which", "(?:сколько\\s+)?(?:я\\s+)?(потерял\\p{L}*|слил\\p{L}*|проиграл\\p{L}*|заработал\\p{L}*|выиграл\\p{L}*|наторговал\\p{L}*)", (m, st) =>
    fx.earned(st, /^(заработ|выигр|наторг)/.test(m[1]) ? "earn" : "lose"));
  // «лучше/хуже» (comparative) and «или» hint at a comparison; «лучший» is handled by the best rule.
  b.add("which", "лучше|хуже|или|либо", (_m, st) => fx.weakCompare(st));

  // Hold time (before price/time: «до 5 минут» is not 5:00 and not $5).
  b.add("hold", `от\\s+${NUM}\\s*(?:${UNIT}\\s+)?(?:до|-|–)\\s*${NUM}\\s*${UNIT}`, (m, st) => {
    const unitB = unitSeconds(m[4]);
    const unitA = m[2] ? unitSeconds(m[2]) : unitB;
    return fx.holdRange(st, toNum(m[1]) * unitA, toNum(m[3]) * unitB);
  });
  b.add("hold", `${NUM}\\s*[-–]\\s*${NUM}\\s*${UNIT}`, (m, st) => {
    const u = unitSeconds(m[3]);
    return fx.holdRange(st, toNum(m[1]) * u, toNum(m[2]) * u);
  });
  const holdBound = (dir: "min" | "max"): Handler => (m, st) => {
    const unit = m[3];
    if (!m[2] && unit.length < 3) return false; // «дольше м» is not a duration; «дольше минуты» is
    return fx.holdBound(st, dir, (m[2] ? toNum(m[2]) : 1) * unitSeconds(unit));
  };
  b.add("hold", `(дольше|длиннее|больше|более|свыше|от|не\\s+меньше|минимум)\\s+(?:${NUM}\\s*)?${UNIT}`, holdBound("min"));
  b.add("hold", `(короче|быстрее|меньше|менее|до|не\\s+дольше|не\\s+больше|максимум|в\\s+пределах)\\s+(?:${NUM}\\s*)?${UNIT}`, holdBound("max"));
  b.add("hold", "скальп\\p{L}*|быстр\\p{L}*\\s+сделк\\p{L}*", (_m, st) => fx.holdBound(st, "max", 60));

  // Position size (shares) — needs «акций/шт» or a «размер/объём/позиция» prefix.
  const SH = "(?:\\s*(акци\\p{L}*|шт\\p{L}*|лот\\p{L}*))";
  const SZ = "(?:размер\\p{L}*|объем\\p{L}*|позици\\p{L}*)";
  b.add("qty", `(${SZ}\\s+)?(?:от\\s+)?(\\d+)\\s*(?:-|–|до)\\s*(\\d+)${SH}?`, (m, st) => (!m[1] && !m[4] ? false : fx.qtyRange(st, Number(m[2]), Number(m[3]))));
  b.add("qty", `(${SZ}\\s+)?(больше|более|свыше|от|не\\s+меньше|меньше|менее|до|не\\s+больше|>|<)\\s*(\\d+)${SH}?`, (m, st) =>
    (!m[1] && !m[4] ? false : fx.qtyBound(st, /^(меньше|менее|до|не\s+больше|<)$/.test(m[2]), Number(m[3]))));

  // Entry price.
  b.add("price", `(?:(?:цен\\p{L}*|по\\s+цене)\\s+)?от\\s*\\$?\\s*${NUM}\\s*\\$?\\s*(?:до|-|–)\\s*\\$?\\s*${NUM}\\s*(?:\\$|долл\\p{L}*|usd|бакс\\p{L}*)?`, (m, st) =>
    (CUR_RE.test(m[0]) ? fx.priceRange(st, toNum(m[1]), toNum(m[2])) : false));
  const priceBound = (dir: "min" | "max", soft: RegExp): Handler => (m, st) => {
    if (!CUR_RE.test(m[0]) && !soft.test(m[2])) return false; // «меньше 5» / «до 10» need a $ marker
    return fx.priceBound(st, dir, toNum(m[3]));
  };
  const CUR_TAIL = "\\s*(?:\\$|долл\\p{L}*|usd|бакс\\p{L}*)?";
  b.add("price", `((?:цен\\p{L}*|по\\s+цене)\\s+)?(дешевле|ниже|меньше|до|не\\s+дороже)\\s*\\$?\\s*${NUM}${CUR_TAIL}`, priceBound("max", /^(дешевле|ниже|не\s+дороже)$/));
  b.add("price", `((?:цен\\p{L}*|по\\s+цене)\\s+)?(дороже|выше|больше|от|не\\s+дешевле)\\s*\\$?\\s*${NUM}${CUR_TAIL}`, priceBound("min", /^(дороже|выше|не\s+дешевле)$/));
}

function dates(b: Book) {
  const day = (st: State, d: string, mon: string, year?: string) => dayMonth(st.today, d, monthIndex(mon), year);
  // Explicit ranges first.
  b.add("dates", `с\\s+(\\d{1,2})(?:\\s+${MON})?\\s+(?:по|до)\\s+(\\d{1,2})\\s+${MON}(?:\\s+(\\d{4}))?(?:\\s+г(?:ода|\\.)?)?`, (m, st) => {
    const end = day(st, m[3], m[4], m[5]);
    if (!end) return false;
    let start: string | null;
    if (m[2]) start = day(st, m[1], m[2], m[5] ?? end.slice(0, 4));
    else {
      const [y, mo] = partsOf(end);
      start = validYmd(y, mo, Number(m[1])) ? ymd(y, mo, Number(m[1])) : null;
    }
    return fx.span(st, start, end);
  });
  b.add("dates", `(\\d{1,2})\\s*[-–]\\s*(\\d{1,2})\\s+${MON}(?:\\s+(\\d{4}))?`, (m, st) => {
    const end = day(st, m[2], m[3], m[4]);
    if (!end) return false;
    const [y, mo] = partsOf(end);
    return fx.span(st, validYmd(y, mo, Number(m[1])) ? ymd(y, mo, Number(m[1])) : null, end);
  });
  b.add("dates", "(?:с\\s+)?(\\d{4}-\\d{2}-\\d{2})\\s*(?:по|до)\\s*(\\d{4}-\\d{2}-\\d{2})", (m, st) => {
    const [a, c] = [m[1], m[2]].map(partsOf);
    return validYmd(...a) && validYmd(...c) ? fx.span(st, m[1], m[2]) : false;
  });
  b.add("dates", `(?:начиная\\s+)?(?:с|после)\\s+(\\d{1,2})(?:-?го)?\\s+${MON}(?:\\s+(\\d{4}))?`, (m, st) => fx.since(st, day(st, m[1], m[2], m[3])));
  b.add("dates", `(?:до|по)\\s+(\\d{1,2})(?:-?го)?\\s+${MON}(?:\\s+(\\d{4}))?`, (m, st) => fx.until(st, day(st, m[1], m[2], m[3])));
  b.add("dates", `(?:начиная\\s+)?с\\s+${MON}(?:\\s+(\\d{4}))?`, (m, st) => fx.sinceMonth(st, monthIndex(m[1]), m[2]));
  b.add("dates", `(\\d{1,2})(?:-?го)?\\s+${MON}(?:\\s+(\\d{4}))?(?:\\s+г(?:ода|\\.)?)?`, (m, st) => fx.day(st, day(st, m[1], m[2], m[3])));
  // «октябрь 2025» — month + explicit year, before the bare-year rule takes «2025».
  b.add("dates", `(?:(?:в|во|за)\\s+)?${MON}\\s+(20\\d{2})(?:\\s+г(?:ода|\\.)?)?`, (m, st) => fx.month(st, monthIndex(m[1]), m[2]));
  b.add("dates", "(?:в|за)\\s+(20\\d{2})(?:\\s*(?:г\\.?|год\\p{L}*))?|(20\\d{2})\\s*(?:г\\.?|год\\p{L}*)", (m, st) => fx.year(st, Number(m[1] ?? m[2])));

  // Relative periods.
  b.add("relDates", "сегодня|сегодняшн\\p{L}*|за\\s+сегодня", (_m, st) => fx.period(st, "today"));
  b.add("relDates", "позавчера", (_m, st) => fx.period(st, "dayBefore"));
  b.add("relDates", "вчера|вчерашн\\p{L}*", (_m, st) => fx.period(st, "yesterday"));
  b.add("relDates", "(?:на|за)\\s+прошл\\p{L}*\\s+недел\\p{L}*|прошл\\p{L}*\\s+недел\\p{L}*", (_m, st) => fx.period(st, "lastWeek"));
  b.add("relDates", "(?:на|за)\\s+(?:эт\\p{L}*|текущ\\p{L}*)\\s+недел\\p{L}*|(?:эт\\p{L}*|текущ\\p{L}*)\\s+недел\\p{L}*", (_m, st) => fx.period(st, "thisWeek"));
  b.add("relDates", "(?:за\\s+)?последн\\p{L}*\\s+(\\d{1,3})\\s+(?:торгов\\p{L}*\\s+)?(дн\\p{L}*|день|недел\\p{L}*|месяц\\p{L}*)|за\\s+(\\d{1,3})\\s+(?:торгов\\p{L}*\\s+)?(дн\\p{L}*|день|недел\\p{L}*|месяц\\p{L}*)", (m, st) => {
    const u = m[2] ?? m[4];
    return fx.lastPeriod(st, Number(m[1] ?? m[3]), u.startsWith("нед") ? "week" : u.startsWith("мес") ? "month" : "day");
  });
  b.add("relDates", "за\\s+(?:последн\\p{L}*\\s+)?недел\\p{L}*|за\\s+7\\s+дней", (_m, st) => fx.period(st, "pastWeek"));
  b.add("relDates", "(?:в|за)\\s+прошл\\p{L}*\\s+месяц\\p{L}*|прошл\\p{L}*\\s+месяц\\p{L}*", (_m, st) => fx.period(st, "lastMonth"));
  b.add("relDates", "(?:в|за)\\s+(?:эт\\p{L}*|текущ\\p{L}*)\\s+месяц\\p{L}*|(?:эт\\p{L}*|текущ\\p{L}*)\\s+месяц\\p{L}*", (_m, st) => fx.period(st, "thisMonth"));
  b.add("relDates", "за\\s+(?:последн\\p{L}*\\s+)?месяц|за\\s+30\\s+дней", (_m, st) => fx.period(st, "pastMonth"));
  b.add("relDates", "(?:в|за)\\s+прошл\\p{L}*\\s+квартал\\p{L}*|прошл\\p{L}*\\s+квартал\\p{L}*", (_m, st) => fx.period(st, "lastQuarter"));
  b.add("relDates", "(?:в|за)\\s+(?:эт\\p{L}*|текущ\\p{L}*)\\s+квартал\\p{L}*|за\\s+квартал|(?:эт\\p{L}*|текущ\\p{L}*)\\s+квартал\\p{L}*", (_m, st) => fx.period(st, "thisQuarter"));
  // Quarters with an optional year run in the «dates» stage (before the bare year takes «2025»).
  b.add("dates", "(?:(?:в|за)\\s+)?к([1-4])(?:\\s+(\\d{4}))?", (m, st) => fx.quarter(st, Number(m[1]), m[2]));
  b.add("dates", "(?:(?:в|за)\\s+)?([1-4])(?:-?(?:й|ом|м|ый))?\\s+квартал\\p{L}*(?:\\s+(\\d{4}))?", (m, st) => fx.quarter(st, Number(m[1]), m[2]));
  b.add("relDates", "с\\s+начала\\s+года|(?:в|за)\\s+эт\\p{L}*\\s+год\\p{L}*|этот\\s+год", (_m, st) => fx.period(st, "ytd"));
  b.add("relDates", "(?:в|за)\\s+прошл\\p{L}*\\s+год\\p{L}*|прошл\\p{L}*\\s+год\\p{L}*", (_m, st) => fx.period(st, "lastYear"));
  b.add("relDates", "за\\s+(?:последн\\p{L}*\\s+)?год", (_m, st) => fx.period(st, "pastYear"));
  b.add("relDates", "(?:в|во)\\s+(понедельник|вторник|среду|четверг|пятницу)", (m, st) => fx.weekdayDate(st, WEEKDAYS[m[1]]));
  // Month name alone: «в октябре», «за сентябрь», «октябрь 2025».
  b.add("relDates", `(?:(?:в|во|за)\\s+)?${MON}(?:\\s+(\\d{4}))?(?:\\s+г(?:ода|\\.)?)?`, (m, st) => fx.month(st, monthIndex(m[1]), m[2]));
}

function timeAndIntents(b: Book) {
  // Named sessions (before generic time: «до открытия», «после закрытия», «после обеда»).
  b.add("sessions", "после\\s+обеда|во\\s+второй\\s+половине\\s+дня|вторая\\s+половина\\s+дня", (_m, st) => fx.session(st, "afternoon"));
  b.add("sessions", "премаркет\\p{L}*|пре-?маркет\\p{L}*|до\\s+открытия", (_m, st) => fx.session(st, "premarket"));
  b.add("sessions", "постмаркет\\p{L}*|афтермаркет\\p{L}*|после\\s+закрытия", (_m, st) => fx.session(st, "postmarket"));
  b.add("sessions", "пауэр[\\s-]*ауэр\\p{L}*|павер[\\s-]*хаур\\p{L}*|(?:в\\s+)?последн\\p{L}*\\s+час\\p{L}*|в\\s+конце\\s+дня|перед\\s+закрытием", (_m, st) => fx.session(st, "powerHour"));
  b.add("sessions", "(?:в\\s+)?перв\\p{L}*\\s+час\\p{L}*", (_m, st) => fx.session(st, "firstHour"));
  b.add("sessions", "(?:на\\s+)?открыти\\p{L}*|перв\\p{L}*\\s+30\\s+минут", (_m, st) => fx.session(st, "open"));
  b.add("sessions", "(?:по\\s+)?утр\\p{L}*|утренн\\p{L}*|с\\s+утра", (_m, st) => fx.session(st, "morning"));
  b.add("sessions", "(?:в\\s+|во\\s+время\\s+)?обед\\p{L}*|ланч\\p{L}*|(?:в\\s+)?середин\\p{L}*\\s+дня", (_m, st) => fx.session(st, "lunch"));

  // Time of day (ET entry time).
  b.add("time", `(?:с|между)\\s+${HH}\\s+(?:до|и|по)\\s+${HH}(?:\\s*(?:ч|час\\p{L}*))?`, (m, st) => {
    if (!m[2] && !m[4] && !(plausibleBareHour(m[1]) && plausibleBareHour(m[3]))) return false;
    return fx.timeRange(st, clock(m[1], m[2]), clock(m[3], m[4]));
  });
  b.add("time", `(после|позже|с)\\s+${HH}(?:\\s*(?:ч|час\\p{L}*))?`, (m, st) =>
    (!m[3] && (m[1] === "с" || !plausibleBareHour(m[2])) ? false : fx.timeAfter(st, clock(m[2], m[3]))));
  b.add("time", `(?:до|раньше|ранее)\\s+${HH}(?:\\s*(?:ч|час\\p{L}*))?`, (m, st) =>
    (!m[2] && !plausibleBareHour(m[1]) ? false : fx.timeBefore(st, clock(m[1], m[2]))));

  // Weekdays as a filter: «по пятницам», «понедельники и пятницы», «пт».
  const WD_ANY = "понедельник(?:и|ам|ов)?|вторник(?:и|ам|ов)?|сред(?:а|ы|ам)|четверг(?:и|ам|ов)?|пятниц(?:а|ы|ам)|пн|вт|чт|пт";
  b.add("weekdays", `(?:по\\s+|в\\s+)?(?:${WD_ANY})(?:\\s*(?:и|,|\\/)\\s*(?:по\\s+)?(?:${WD_ANY}))*`, (m, st) =>
    fx.weekdays(st, [...m[0].matchAll(/[\p{L}]+/gu)].map((x) => weekdayIndex(x[0]))));

  // Intent words.
  b.add("intents", "сравни\\p{L}*|сравнени\\p{L}*|против|в\\s+сравнении", (_m, st) => fx.strongCompare(st));
  const BEST_W = "лучш\\p{L}*|самы\\p{L}*\\s+(?:прибыльн|доходн|удачн)\\p{L}*|наиболее\\s+(?:прибыльн|доходн)\\p{L}*";
  const WORST_W = "худш\\p{L}*|самы\\p{L}*\\s+(?:убыточн|неудачн|провальн)\\p{L}*|наиболее\\s+убыточн\\p{L}*";
  b.add("intents", `(?:(топ|антитоп)[\\s-]*(\\d{1,2})?|(?:(\\d{1,2})\\s+)?(${BEST_W}|${WORST_W}))(?:\\s+(\\d{1,2}))?(?:\\s+(${TARGET}))?`, (m, st) => {
    const word = m[1] ?? m[4];
    return fx.best(st, {
      worst: word === "антитоп" || /^(худш)/.test(word) || /(убыточн|неудачн|провальн)/.test(word),
      n: Number(m[2] ?? m[3] ?? m[5] ?? 0),
      dim: targetOf(m[6]),
      plural: (m[6] != null && PLURAL_TARGET.test(m[6])) || /(ие|их)$/.test(word) || /^самые|^самых/.test(word),
    });
  });
  b.add("intents", "комисси\\p{L}*|комс\\p{L}*|сбор\\p{L}*|издержк\\p{L}*", (_m, st) => fx.explicit(st, "fees"));
  b.add("intents", "вин\\s*рейт\\p{L}*|винрейт\\p{L}*|процент\\s+(?:побед|прибыльных|выигрышей|выигрышных)|точност\\p{L}*", (_m, st) => fx.explicit(st, "winrate"));
  b.add("intents", "профит[\\s-]*фактор\\p{L}*", (_m, st) => fx.explicit(st, "pf"));
  b.add("intents", "(?:максимальн\\p{L}*\\s+)?просадк\\p{L}*", (_m, st) => fx.explicit(st, "drawdown"));
  b.add("intents", "(?<!по\\s{1,3})(?:средн\\p{L}*\\s+)?(?:врем\\p{L}*\\s+)?удержани\\p{L}*(?=\\s*$)|средн\\p{L}*\\s+(?:врем\\p{L}*\\s+)?удержани\\p{L}*|сколько\\s+(?:я\\s+)?(?:в\\s+среднем\\s+)?держ\\p{L}*|как\\s+долго\\s+(?:я\\s+)?держ\\p{L}*|средн\\p{L}*\\s+длительност\\p{L}*", (_m, st) => fx.explicit(st, "hold"));
  b.add("intents", "средн\\p{L}*\\s+(?:размер\\p{L}*|объем\\p{L}*|позици\\p{L}*)|размер\\p{L}*\\s+позици\\p{L}*|каким\\s+размером", (_m, st) => fx.explicit(st, "size"));
  b.add("intents", "(?:по|в\\s+разрезе|с\\s+разбивкой\\s+по)\\s+(дням\\s+недели|тикерам|бумагам|акциям|дням|часам|месяцам|неделям|сторонам|направлению|направлениям|сетапам|трейдерам|удержанию|длительности|времени\\s+удержания|размеру|объему|времени\\s+дня|сессиям|времени)", (m, st) => {
    const w = m[1].replace(/\s+/g, " ");
    return fx.group(st, GROUPS.find(([r]) => r.test(w))?.[1] ?? null);
  });
  b.add("intents", "средн\\p{L}*|в\\s+среднем|матожидани\\p{L}*|мат\\s+ожидани\\p{L}*|ожидани\\p{L}*", (_m, st) => fx.explicit(st, "avg"));
  b.add("intents", "сколько\\s+(?:было\\s+|всего\\s+)?(?:сделок|трейдов|раз)|количество(?:\\s+сделок)?|число\\s+сделок|кол-?во(?:\\s+сделок)?", (_m, st) => fx.explicit(st, "count"));
  b.add("intents", "нетто|пнл|прибыл[ьи]|итог\\p{L}*|результат\\p{L}*|сумм\\p{L}*|доход\\p{L}*|заработ(?:ок|ка)|профит", (_m, st) => fx.explicit(st, "sum"));
  b.add("intents", "сколько", (_m, st) => fx.countHint(st));

  // Side and result.
  b.add("sides", "лонг\\p{L}*|покупк\\p{L}*|шорт\\p{L}*", (m, st) => fx.side(st, /^(лонг|покуп)/.test(m[0]) ? "Long" : "Short"));
  b.add("sides", "убыточн\\p{L}*|минусов\\p{L}*|в\\s+минус|лосс\\p{L}*|проигрышн\\p{L}*|стопы|убытк\\p{L}*|убыток", (_m, st) => fx.outcome(st, "loss"));
  b.add("sides", "прибыльн\\p{L}*|плюсов\\p{L}*|в\\s+плюс|профитн\\p{L}*|выигрышн\\p{L}*", (_m, st) => fx.outcome(st, "win"));
  b.add("sides", "безубыт\\p{L}*|в\\s+ноль", (_m, st) => fx.outcome(st, "breakeven"));

  // «сетап X» (any word after it; known setups are matched later as bare words too).
  b.add("setup", "(?:сетап\\p{L}*|паттерн\\p{L}*|стратеги\\p{L}*)\\s+([\\p{L}\\p{N}][\\p{L}\\p{N}\\-]*(?:\\s+(?:and|&|и|n)\\s+[\\p{L}\\p{N}][\\p{L}\\p{N}\\-]*)?)", (m, st) =>
    fx.setup(st, m[1], /^(по|и|в|за|на|с)$/));
}

export function addRuRules(b: Book): void {
  facets(b);
  dates(b);
  timeAndIntents(b);
}

