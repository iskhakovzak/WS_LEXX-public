// «Спроси журнал» — English question rules («INTC shorts in October after 11:00», «win rate on Fridays»,
// «morning vs afternoon», «when do I lose the most»). Same stages and effects as ./rules-ru.

import type { AskDim } from "./types";
import { fx, NUM, clock, dayMonth, partsOf, plausibleBareHour, toNum, unitSeconds, validYmd, ymd, type Handler, type ruleBook, type State } from "./kit";

type Book = ReturnType<typeof ruleBook>;

const MON = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\.?";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthIndex = (w: string | undefined): number | null => {
  const i = w ? MONTHS.indexOf(w.slice(0, 3)) : -1;
  return i < 0 ? null : i + 1;
};
const D = "(\\d{1,2})(?:st|nd|rd|th)?";
/** «October 15» or «15 October» / «15th of October»: groups (mon, day) or (day, mon). */
const DM = `(?:${MON}\\s+${D}|${D}\\s+(?:of\\s+)?${MON})`;
const pickDM = (m: RegExpExecArray, at: number): [string, string] => (m[at] ? [m[at + 1], m[at]] : [m[at + 2], m[at + 3]]);

const UNIT = "(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)";
const CUR_RE = /\$|dollar|usd|buck|price/;
const LOSS_W = "loss(?:es)?|losing(?:\\s+trades?)?|losers?|red\\s+trades?";
const WIN_W = "wins?|winning(?:\\s+trades?)?|winners?|green\\s+trades?";
const isLossWord = (w: string) => /^(loss|losing|loser|red)/.test(w);

const TARGET = "days?\\s+of\\s+(?:the\\s+)?week|weekdays?|tickers?|symbols?|stocks?|names?|days?|hours?|time\\s+of\\s+(?:the\\s+)?day|time|months?|weeks?|trades?|sides?|setups?|traders?|sessions?";
const TARGET_MAP: Array<[RegExp, AskDim]> = [
  [/^(days? of|weekday)/, "weekday"], [/^trader/, "trader"], [/^(ticker|symbol|stock|name)/, "ticker"], [/^day/, "day"],
  [/^(time of|session)/, "slot"], [/^(hour|time)/, "hour"], [/^month/, "month"], [/^week/, "week"], [/^trade/, "trade"],
  [/^side/, "side"], [/^setup/, "setup"],
];
const targetOf = (w: string | undefined): AskDim | null => (w ? TARGET_MAP.find(([r]) => r.test(w.replace(/\s+/g, " ")))?.[1] ?? null : null);
const pluralTarget = (w: string | undefined) => Boolean(w && /^(days of|\p{L}+s\b)/u.test(w) && !/^(sales)/.test(w));

const GROUPS: Array<[RegExp, AskDim]> = [
  [/^(days? of|weekday)/, "weekday"], [/^(ticker|symbol|stock)/, "ticker"], [/^entry hour/, "hour"], [/^day/, "day"], [/^hour/, "hour"],
  [/^month/, "month"], [/^week/, "week"], [/^(side|direction)/, "side"], [/^setup/, "setup"], [/^trader/, "trader"],
  [/^(hold|duration)/, "holdBucket"], [/^(position size|size)/, "sizeBucket"], [/^(time|session)/, "slot"],
];

const WD = "mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|mon|tues?|wed|thu(?:rs?)?|fri";
const weekdayIndex = (w: string): number | null => {
  const i = ["mon", "tue", "wed", "thu", "fri"].indexOf(w.slice(0, 3));
  return i < 0 ? null : i;
};

/** 12-hour clock: «2pm» → 14:00, «12am» → 0:00; bare 24-hour «14» stays. */
const HH = "(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?";
function hm(h: string, mm: string | undefined, ap: string | undefined): number | null {
  let hh = Number(h);
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    if (ap.startsWith("p") && hh < 12) hh += 12;
    if (ap.startsWith("a") && hh === 12) hh = 0;
  }
  return clock(String(hh), mm);
}
const bare = (h: string, mm?: string, ap?: string) => !mm && !ap && !plausibleBareHour(h);

export const EN_NAME_PREFIX = "trader\\s+";

/** Function words the leftover pass ignores (also never tickers in an all-Latin question). */
export const EN_NOISE = [
  "show", "me", "my", "mine", "the", "of", "in", "for", "all", "and", "a", "an", "trades", "trade", "what", "whats", "is", "are", "was", "were",
  "did", "do", "does", "i", "im", "ive", "how", "much", "on", "at", "by", "to", "from", "with", "please", "list", "give", "get", "find", "tell",
  "about", "it", "this", "that", "these", "those", "there", "have", "has", "had", "been", "be", "so", "far", "held", "hold", "holding",
  "positions", "position", "took", "taken", "trading", "traded", "journal", "money", "paid", "pay", "spend", "spent", "went", "go", "ate", "eat",
  "eaten", "than", "any", "some", "time", "times", "see", "view", "can", "you", "your", "which", "one", "ones", "only", "just", "where", "were",
  "out", "up", "over", "between", "per", "each", "every", "entry", "entries", "shares", "share", "size", "price", "priced", "day", "days",
  "result", "make", "made", "everything", "anything", "everyone", "into", "fees", "s", "vs", "or", "better", "worse", "number", "total", "trader", "traders", "doing", "done",
];

function facets(b: Book) {
  b.add("scope", "(?:of\\s+|for\\s+|over\\s+)?all[\\s-]time|ever|since\\s+(?:the\\s+)?(?:start|beginning)|(?:the\\s+)?(?:whole|entire|full)\\s+history|overall|lifetime", (_m, st) => fx.allTime(st));
  b.add("scope", "(?:for\\s+)?(?:all|every)\\s+traders?|(?:for\\s+)?(?:the\\s+)?(?:whole|entire|full)\\s+(?:desk|team)|desk[\\s-]?wide|team[\\s-]?wide|(?:the\\s+)?desk|everyone", (_m, st) => fx.desk(st));

  b.add("last", "(?:my\\s+)?(?:the\\s+)?(?:last|latest|most\\s+recent|recent)\\s+(\\d{1,4})\\s+trades?", (m, st) => fx.lastN(st, Number(m[1])));
  b.add("last", "(?:my\\s+)?(?:the\\s+)?(?:last|latest|most\\s+recent|recent)\\s+(trades?)", (m, st) => fx.lastOne(st, m[1] === "trade"));

  b.add("after", `after\\s+(?:(?:a|an|one|the)\\s+)?(?:(\\d{1,2})\\s+)?(?:(?:consecutive|straight)\\s+)?(${LOSS_W}|${WIN_W})(?:\\s+(?:in\\s+a\\s+row|straight|back\\s+to\\s+back))?`, (m, st) =>
    fx.after(st, isLossWord(m[2]) ? "loss" : "win", m[1]));

  b.add("streak", "(?:(?:the\\s+)?(?:longest|biggest|max(?:imum)?|record)\\s+)?(?:(daily)\\s+)?(?:(losing|loss|winning|win)\\s+)?streaks?(?:\\s+of\\s+(loss(?:es)?|losing\\s+(?:trades|days)|wins|winning\\s+(?:trades|days)))?(?:\\s+(?:by|in|per)\\s+(days?|trades?))?", (m, st) => {
    const w = m[2] ?? m[3] ?? "";
    return fx.streak(st, /^los/.test(w) ? "loss" : /^win/.test(w) ? "win" : null, m[1] || /days$/.test(m[3] ?? "") || /^day/.test(m[4] ?? "") ? "day" : "trade");
  });
  b.add("streak", "(loss(?:es)?|losing(?:\\s+(trades?|days?))?|wins|winning(?:\\s+(trades?|days?))?|red\\s+(days?)|green\\s+(days?))\\s+in\\s+a\\s+row", (m, st) =>
    fx.streak(st, /^(los|red)/.test(m[1]) ? "loss" : "win", /^day/.test(m[2] ?? m[3] ?? m[4] ?? m[5] ?? "") ? "day" : "trade"));

  b.add("which", `(?:in\\s+|on\\s+|at\\s+|by\\s+|for\\s+)?(?:which|what)\\s+(${TARGET})`, (m, st) => fx.which(st, targetOf(m[1])));
  b.add("which", "weak\\s+(?:spots?|points?|sides?)|weaknesses|leaks?|where\\s+(?:do\\s+|am\\s+)?i\\s+(?:leak|bleed)\\p{L}*|what\\s+(?:is\\s+)?(?:hurting|costing)\\s+me", (_m, st) => fx.leak(st, "worst"));
  b.add("which", "strong\\s+(?:spots?|points?|sides?)|strengths?|what\\s+(?:works|is\\s+working)(?:\\s+best)?", (_m, st) => fx.leak(st, "best"));
  b.add("which", "when|where|in\\s+what|under\\s+what\\s+conditions?", (_m, st) => fx.when(st));
  b.add("which", "(?:the\\s+)?most(?!\\s+(?:profitable|unprofitable|losing|recent))", (_m, st) => fx.most(st));
  b.add("which", "how\\s+much\\s+(?:money\\s+)?(?:did|have)\\s+i\\s+(make|made|earn|earned|lose|lost|win|won)|(?:i\\s+)?(made|earned|lost|won)(?:\\s+money)?", (m, st) =>
    fx.earned(st, /^(make|made|earn|win|won)/.test(m[1] ?? m[2]) ? "earn" : "lose"));
  b.add("which", "lose(?:\\s+money)?|losing\\s+money|losing(?=\\s*$)|bleed\\p{L}*", (_m, st) => fx.verb(st, "lose"));
  b.add("which", "make(?:\\s+money)?|making(?:\\s+money)?|earn(?:ing)?", (_m, st) => fx.verb(st, "earn"));
  b.add("which", "better|worse|or", (_m, st) => fx.weakCompare(st));

  // Hold time.
  b.add("hold", `(?:from|between)\\s+${NUM}\\s*(?:${UNIT}\\s+)?(?:to|and|-|–)\\s*${NUM}\\s*${UNIT}`, (m, st) => {
    const unitB = unitSeconds(m[4]);
    return fx.holdRange(st, toNum(m[1]) * (m[2] ? unitSeconds(m[2]) : unitB), toNum(m[3]) * unitB);
  });
  b.add("hold", `${NUM}\\s*[-–]\\s*${NUM}\\s*${UNIT}`, (m, st) => {
    const u = unitSeconds(m[3]);
    return fx.holdRange(st, toNum(m[1]) * u, toNum(m[2]) * u);
  });
  const holdBound = (dir: "min" | "max"): Handler => (m, st) => {
    if (!m[2] && m[3].length < 3) return false;
    return fx.holdBound(st, dir, (m[2] ? toNum(m[2]) : 1) * unitSeconds(m[3]));
  };
  b.add("hold", `(longer\\s+than|more\\s+than|over|above|at\\s+least|min(?:imum)?)\\s+(?:(?:a|an|one)\\s+|${NUM}\\s*)?${UNIT}`, holdBound("min"));
  b.add("hold", `(shorter\\s+than|less\\s+than|under|below|within|up\\s+to|at\\s+most|max(?:imum)?)\\s+(?:(?:a|an|one)\\s+|${NUM}\\s*)?${UNIT}`, holdBound("max"));
  b.add("hold", "scalps?|scalping|quick\\s+trades?", (_m, st) => fx.holdBound(st, "max", 60));

  // Position size (shares) — needs «shares» or a «size / position» prefix.
  const SH = "(?:\\s*(shares?|sh|lots?))";
  const SZ = "(?:(?:position\\s+)?size|qty|quantity)";
  b.add("qty", `(${SZ}\\s+)?(?:(?:from|between)\\s+)?(\\d+)\\s*(?:-|–|to|and)\\s*(\\d+)${SH}?`, (m, st) => (!m[1] && !m[4] ? false : fx.qtyRange(st, Number(m[2]), Number(m[3]))));
  b.add("qty", `(${SZ}\\s+)?(more\\s+than|over|above|at\\s+least|less\\s+than|fewer\\s+than|under|below|up\\s+to|at\\s+most|>|<)\\s*(\\d+)${SH}?`, (m, st) =>
    (!m[1] && !m[4] ? false : fx.qtyBound(st, /^(less|fewer|under|below|up|at\s+most|<)/.test(m[2]), Number(m[3]))));
  b.add("qty", "(\\d+)\\s*\\+\\s*(?:shares?|sh)", (m, st) => fx.qtyBound(st, false, Number(m[1])));

  // Entry price.
  b.add("price", `(?:(?:price|priced|entry)\\s+)?(?:from|between)\\s*\\$?\\s*${NUM}\\s*\\$?\\s*(?:to|and|-|–)\\s*\\$?\\s*${NUM}\\s*(?:\\$|dollars?|usd|bucks?)?`, (m, st) =>
    (CUR_RE.test(m[0]) ? fx.priceRange(st, toNum(m[1]), toNum(m[2])) : false));
  b.add("price", `\\$\\s*${NUM}\\s*[-–]\\s*\\$\\s*${NUM}`, (m, st) => fx.priceRange(st, toNum(m[1]), toNum(m[2])));
  const priceBound = (dir: "min" | "max", soft: RegExp): Handler => (m, st) => {
    if (!CUR_RE.test(m[0]) && !soft.test(m[2])) return false; // «under 10» needs a $ marker
    return fx.priceBound(st, dir, toNum(m[3]));
  };
  const CUR_TAIL = "\\s*(?:\\$|dollars?|usd|bucks?)?";
  b.add("price", `((?:price|priced|entry)\\s+)?(cheaper\\s+than|below|under|less\\s+than|up\\s+to|at\\s+most|no\\s+more\\s+than)\\s*\\$?\\s*${NUM}${CUR_TAIL}`, priceBound("max", /^(cheaper|below)/));
  b.add("price", `((?:price|priced|entry)\\s+)?(more\\s+expensive\\s+than|pricier\\s+than|above|over|more\\s+than|at\\s+least)\\s*\\$?\\s*${NUM}${CUR_TAIL}`, priceBound("min", /^(more\s+expensive|pricier|above)/));
}

function dates(b: Book) {
  const day = (st: State, d: string, mon: string, year?: string) => dayMonth(st.today, d, monthIndex(mon), year);
  const Y = "(?:,?\\s+(\\d{4}))?";
  // «from October 1 to 15», «between Oct 1 and Oct 15, 2025»
  b.add("dates", `(?:from|between)\\s+${MON}\\s+${D}\\s+(?:to|until|till|through|thru|and|-|–)\\s+(?:${MON}\\s+)?${D}${Y}`, (m, st) => {
    const end = day(st, m[4], m[3] ?? m[1], m[5]);
    return fx.span(st, end ? day(st, m[2], m[1], m[5] ?? end.slice(0, 4)) : null, end);
  });
  // «from 1 to 15 October», «from 1 September to 15 October»
  b.add("dates", `(?:from|between)\\s+${D}(?:\\s+(?:of\\s+)?${MON})?\\s+(?:to|until|till|through|thru|and|-|–)\\s+${D}\\s+(?:of\\s+)?${MON}${Y}`, (m, st) => {
    const end = day(st, m[3], m[4], m[5]);
    if (!end) return false;
    const [y, mo] = partsOf(end);
    const start = m[2] ? day(st, m[1], m[2], m[5] ?? String(y)) : validYmd(y, mo, Number(m[1])) ? ymd(y, mo, Number(m[1])) : null;
    return fx.span(st, start, end);
  });
  // «October 1-15», «Oct 1–15, 2025», «1-15 October»
  b.add("dates", `${MON}\\s+${D}\\s*[-–]\\s*${D}${Y}`, (m, st) => fx.span(st, day(st, m[2], m[1], m[4]), day(st, m[3], m[1], m[4])));
  b.add("dates", `${D}\\s*[-–]\\s*${D}\\s+(?:of\\s+)?${MON}${Y}`, (m, st) => fx.span(st, day(st, m[1], m[3], m[4]), day(st, m[2], m[3], m[4])));
  b.add("dates", "(?:from|between)\\s+(\\d{4}-\\d{2}-\\d{2})\\s+(?:to|and|until|till|through)\\s+(\\d{4}-\\d{2}-\\d{2})", (m, st) => {
    const [a, c] = [m[1], m[2]].map(partsOf);
    return validYmd(...a) && validYmd(...c) ? fx.span(st, m[1], m[2]) : false;
  });
  b.add("dates", `(?:since|starting(?:\\s+from)?|from|after)\\s+${DM}${Y}`, (m, st) => { const [d, mo] = pickDM(m, 1); return fx.since(st, day(st, d, mo, m[5])); });
  b.add("dates", `(?:until|till|through|thru|before|up\\s+to|by)\\s+${DM}${Y}`, (m, st) => { const [d, mo] = pickDM(m, 1); return fx.until(st, day(st, d, mo, m[5])); });
  b.add("dates", `(?:since|starting(?:\\s+in|\\s+from)?|from)\\s+${MON}(?:\\s+(\\d{4}))?`, (m, st) => fx.sinceMonth(st, monthIndex(m[1]), m[2]));
  b.add("dates", `(?:on\\s+)?(?:the\\s+)?${DM}${Y}`, (m, st) => { const [d, mo] = pickDM(m, 1); return fx.day(st, day(st, d, mo, m[5])); });
  b.add("dates", `(?:(?:in|for|during)\\s+)?${MON}\\s*,?\\s+(20\\d{2})`, (m, st) => fx.month(st, monthIndex(m[1]), m[2]));
  b.add("dates", "(?:in|for|during)\\s+(20\\d{2})", (m, st) => fx.year(st, Number(m[1])));
  b.add("dates", "(?:(?:in|for|during)\\s+(?:the\\s+)?)?q([1-4])(?:\\s*,?\\s*(\\d{4}))?", (m, st) => fx.quarter(st, Number(m[1]), m[2]));
  b.add("dates", "(?:(?:in|for|during)\\s+)?(?:the\\s+)?(?:([1-4])(?:st|nd|rd|th)?|(first|second|third|fourth))\\s+quarter(?:\\s+(?:of\\s+)?(\\d{4}))?", (m, st) =>
    fx.quarter(st, m[1] ? Number(m[1]) : ["first", "second", "third", "fourth"].indexOf(m[2]) + 1, m[3]));

  const IN = "(?:(?:in|over|during|for)\\s+)?(?:the\\s+)?";
  b.add("relDates", "today'?s?", (_m, st) => fx.period(st, "today"));
  b.add("relDates", "(?:the\\s+)?day\\s+before\\s+yesterday", (_m, st) => fx.period(st, "dayBefore"));
  b.add("relDates", "yesterday'?s?", (_m, st) => fx.period(st, "yesterday"));
  b.add("relDates", `${IN}(?:last|previous|prior)\\s+week`, (_m, st) => fx.period(st, "lastWeek"));
  b.add("relDates", `${IN}(?:this|current)\\s+week|week\\s+to\\s+date|wtd`, (_m, st) => fx.period(st, "thisWeek"));
  b.add("relDates", `${IN}past\\s+year|${IN}last\\s+12\\s+months`, (_m, st) => fx.period(st, "pastYear"));
  b.add("relDates", `${IN}(?:last|past|previous|recent)\\s+(\\d{1,3})\\s+(?:of\\s+)?(?:trading\\s+)?(days?|weeks?|months?)`, (m, st) =>
    fx.lastPeriod(st, Number(m[1]), m[2].startsWith("week") ? "week" : m[2].startsWith("month") ? "month" : "day"));
  b.add("relDates", `${IN}past\\s+week`, (_m, st) => fx.period(st, "pastWeek"));
  b.add("relDates", `${IN}(?:last|previous|prior)\\s+month`, (_m, st) => fx.period(st, "lastMonth"));
  b.add("relDates", `${IN}(?:this|current)\\s+month|month\\s+to\\s+date|mtd`, (_m, st) => fx.period(st, "thisMonth"));
  b.add("relDates", `${IN}past\\s+month`, (_m, st) => fx.period(st, "pastMonth"));
  b.add("relDates", `${IN}(?:last|previous|prior)\\s+quarter`, (_m, st) => fx.period(st, "lastQuarter"));
  b.add("relDates", `${IN}(?:this|current)\\s+quarter|quarter\\s+to\\s+date|qtd`, (_m, st) => fx.period(st, "thisQuarter"));
  b.add("relDates", "ytd|year\\s+to\\s+date|this\\s+year|(?:since|from)\\s+(?:the\\s+)?(?:start|beginning)\\s+of\\s+(?:the\\s+)?year", (_m, st) => fx.period(st, "ytd"));
  b.add("relDates", `${IN}(?:last|previous|prior)\\s+year`, (_m, st) => fx.period(st, "lastYear"));
  b.add("relDates", "(?:on|last)\\s+(monday|tuesday|wednesday|thursday|friday)", (m, st) => fx.weekdayDate(st, weekdayIndex(m[1]) ?? 0));
  b.add("relDates", `(?:(?:in|for|during)\\s+)?${MON}(?:\\s+(\\d{4}))?`, (m, st) => fx.month(st, monthIndex(m[1]), m[2]));
}

function timeAndIntents(b: Book) {
  b.add("sessions", "(?:in\\s+the\\s+)?afternoons?|after\\s+lunch|(?:in\\s+the\\s+)?second\\s+half\\s+of\\s+the\\s+day", (_m, st) => fx.session(st, "afternoon"));
  b.add("sessions", "(?:in\\s+(?:the\\s+)?)?pre-?market|before\\s+the\\s+open(?:ing)?", (_m, st) => fx.session(st, "premarket"));
  b.add("sessions", "(?:in\\s+(?:the\\s+)?)?(?:after-?hours|post-?market)|after\\s+the\\s+close", (_m, st) => fx.session(st, "postmarket"));
  b.add("sessions", "power\\s*hour|(?:in\\s+)?the\\s+last\\s+hour|(?:at\\s+the\\s+)?end\\s+of\\s+(?:the\\s+)?day|before\\s+the\\s+close", (_m, st) => fx.session(st, "powerHour"));
  b.add("sessions", "(?:in\\s+)?(?:the\\s+)?first\\s+hour", (_m, st) => fx.session(st, "firstHour"));
  b.add("sessions", "(?:at\\s+|on\\s+)?the\\s+open(?:ing)?|opening(?:\\s+bell)?|(?:the\\s+)?first\\s+30\\s+min(?:utes)?", (_m, st) => fx.session(st, "open"));
  b.add("sessions", "(?:in\\s+the\\s+)?mornings?", (_m, st) => fx.session(st, "morning"));
  b.add("sessions", "(?:at\\s+|during\\s+|over\\s+)?lunch(?:time)?|mid-?day|(?:in\\s+the\\s+)?middle\\s+of\\s+the\\s+day", (_m, st) => fx.session(st, "lunch"));

  b.add("time", `(?:from|between)\\s+${HH}\\s+(?:to|and|until|till|-)\\s+${HH}`, (m, st) => {
    if (!m[2] && !m[3] && !m[5] && !m[6] && !(plausibleBareHour(m[1]) && plausibleBareHour(m[4]))) return false;
    return fx.timeRange(st, hm(m[1], m[2], m[3]), hm(m[4], m[5], m[6]));
  });
  b.add("time", `(after|later\\s+than|since|from)\\s+${HH}`, (m, st) =>
    ((m[1] === "since" || m[1] === "from") && !m[3] && !m[4]) || bare(m[2], m[3], m[4]) ? false : fx.timeAfter(st, hm(m[2], m[3], m[4])));
  b.add("time", `(?:before|until|till|earlier\\s+than|by)\\s+${HH}`, (m, st) => (bare(m[1], m[2], m[3]) ? false : fx.timeBefore(st, hm(m[1], m[2], m[3]))));

  b.add("weekdays", `(?:on\\s+|every\\s+)?(?:${WD})(?:\\s*(?:and|,|\\/|&)\\s*(?:on\\s+)?(?:${WD}))*`, (m, st) =>
    fx.weekdays(st, [...m[0].matchAll(/\p{L}+/gu)].map((x) => (/^(and|on|every)$/.test(x[0]) ? null : weekdayIndex(x[0])))));

  b.add("intents", "compare|comparison|compared\\s+(?:to|with)|versus|against|head\\s+to\\s+head", (_m, st) => fx.strongCompare(st));
  const BEST = "best|top|most\\s+profitable|strongest";
  const WORST = "worst|bottom|least\\s+profitable|most\\s+(?:losing|unprofitable)|weakest";
  b.add("intents", `(?:the\\s+)?(?:(top|bottom)[\\s-]*(\\d{1,2})?|(?:(\\d{1,2})\\s+)?(${BEST}|${WORST}))(?:\\s+(\\d{1,2}))?(?:\\s+(${TARGET}))?`, (m, st) => {
    const word = m[1] ?? m[4];
    return fx.best(st, {
      worst: new RegExp(`^(?:${WORST})$`).test(word),
      n: Number(m[2] ?? m[3] ?? m[5] ?? 0),
      dim: targetOf(m[6]),
      plural: pluralTarget(m[6]),
    });
  });
  b.add("intents", "fees?|commissions?|comms?|costs?", (_m, st) => fx.explicit(st, "fees"));
  b.add("intents", "win\\s*rates?|winrates?|wr|hit\\s*rate|win\\s*%|win\\s+percentage|accuracy|percent(?:age)?\\s+(?:of\\s+)?(?:winners|wins|winning\\s+trades)", (_m, st) => fx.explicit(st, "winrate"));
  b.add("intents", "profit[\\s-]*fa[ck]tor\\p{L}*|pf", (_m, st) => fx.explicit(st, "pf"));
  b.add("intents", "(?:max(?:imum)?\\s+|biggest\\s+)?draw[\\s-]?downs?|dd", (_m, st) => fx.explicit(st, "drawdown"));
  b.add("intents", "(?:average|avg|mean|typical)\\s+(?:hold(?:ing)?(?:\\s+time)?|time\\s+in\\s+(?:a\\s+)?trades?|trade\\s+duration|duration)|how\\s+long\\s+(?:do\\s+|did\\s+)?i\\s+(?:usually\\s+)?hold|(?<!(?:by|per)\\s{1,3})hold(?:ing)?\\s+time(?=\\s*$)", (_m, st) => fx.explicit(st, "hold"));
  b.add("intents", "(?:average|avg|mean|typical)\\s+(?:position\\s+)?size|position\\s+size|how\\s+(?:big|large)\\s+(?:are\\s+)?my\\s+positions?", (_m, st) => fx.explicit(st, "size"));
  b.add("intents", "(?:by|per|grouped\\s+by|broken\\s+down\\s+by|split\\s+by|for\\s+each|each)\\s+(days?\\s+of\\s+(?:the\\s+)?week|weekdays?|tickers?|symbols?|stocks?|entry\\s+hours?|days?|hours?|months?|weeks?|sides?|directions?|setups?|traders?|hold(?:ing)?(?:\\s+times?)?|durations?|(?:position\\s+)?sizes?|time\\s+of\\s+(?:the\\s+)?day|sessions?|time\\s+slots?)", (m, st) => {
    const w = m[1].replace(/\s+/g, " ");
    return fx.group(st, GROUPS.find(([r]) => r.test(w))?.[1] ?? null);
  });
  b.add("intents", "average|avg|on\\s+average|mean|expectancy|expected\\s+value|ev", (_m, st) => fx.explicit(st, "avg"));
  b.add("intents", "how\\s+many(?:\\s+trades)?|number\\s+of\\s+trades|trade\\s+count|count|total\\s+trades", (_m, st) => fx.explicit(st, "count"));
  b.add("intents", "net(?:\\s+p\\s*&\\s*l|\\s+pnl|\\s+profit)?|p\\s*&\\s*l|pnl|profit|total|results?|earnings|income|gross|performance|how\\s+did\\s+i\\s+do", (_m, st) => fx.explicit(st, "sum"));
  b.add("intents", "how\\s+much", (_m, st) => fx.countHint(st));

  b.add("sides", "longs?|shorts?", (m, st) => fx.side(st, m[0].startsWith("long") ? "Long" : "Short"));
  b.add("sides", "losing(?:\\s+trades?)?|losers?|losses|loss|red(?:\\s+trades?)?|negative|unprofitable|in\\s+the\\s+red", (_m, st) => fx.outcome(st, "loss"));
  b.add("sides", "winning(?:\\s+trades?)?|winners?|wins|profitable|green(?:\\s+trades?)?|positive|in\\s+the\\s+green", (_m, st) => fx.outcome(st, "win"));
  b.add("sides", "break[\\s-]?evens?|flat|scratch(?:es|ed)?", (_m, st) => fx.outcome(st, "breakeven"));

  b.add("setup", "(?:setup|pattern|strategy|play)\\s+([\\p{L}\\p{N}][\\p{L}\\p{N}\\-]*(?:\\s+(?:and|&|n)\\s+[\\p{L}\\p{N}][\\p{L}\\p{N}\\-]*)?)", (m, st) =>
    fx.setup(st, m[1], /^(by|and|in|for|on|of|the|with|vs)$/));
}

export function addEnRules(b: Book): void {
  facets(b);
  dates(b);
  timeAndIntents(b);
}
