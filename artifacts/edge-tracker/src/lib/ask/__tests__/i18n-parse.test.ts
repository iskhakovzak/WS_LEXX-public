import { describe, expect, it } from "vitest";
import { parseAsk, replaceToken, textWithoutToken, type AskQuery, type ParseContext } from "@/lib/ask/parse";

// EN and UZ equivalents of the RU parser examples (parse.test.ts, parse-ru.test.ts): each must parse to the same
// structure as its Russian original and leave no unknown words. Friday 2026-10-16.
const ctx: ParseContext = {
  today: "2026-10-16",
  traders: ["Ориф", "Тимур"],
  tickers: ["AAPL", "NVDA", "INTC", "MRK", "TSLA", "AMD"],
  setups: ["news", "gap and go"],
};
const p = (s: string) => parseAsk(s, ctx);

/** Everything that decides the answer (labels/phrases are UI text and differ by design). */
function shape(q: AskQuery) {
  return {
    trader: q.trader, allTraders: q.allTraders, tickers: q.tickers, setups: q.setups, side: q.side, outcome: q.outcome,
    date: q.date && { from: q.date.from, to: q.date.to }, time: q.time && { fromMin: q.time.fromMin, toMin: q.time.toMin },
    weekdays: q.weekdays, price: q.price, holdSec: q.holdSec, qty: q.qty, after: q.after, lastN: q.lastN,
    intent: q.intent, target: q.target, groupBy: q.groupBy, metric: q.metric, plural: q.topN > 1, topN: q.topN,
    compare: q.compare && { dim: q.compare.dim, a: Object.keys(q.compare.a.patch), b: Object.keys(q.compare.b.patch) },
    streak: q.streak, insight: q.insight, ok: q.ok,
  };
}

const CASES: Array<[ru: string, en: string, uz: string]> = [
  ["шорты INTC в октябре после 11:00", "INTC shorts in October after 11:00", "INTC shortlar oktabrda 11:00 dan keyin"],
  ["лонги дешевле 10$ на этой неделе", "longs under $10 this week", "10$ dan arzon longlar shu hafta"],
  ["убыточные сделки вчера", "losing trades yesterday", "zararli savdolar kecha"],
  ["лучший тикер за месяц", "best ticker in the past month", "oxirgi oyda eng yaxshi tiker"],
  ["сколько комиссий в сентябре", "how much in fees in September", "sentabrda qancha komissiya"],
  ["винрейт по утрам", "win rate in the mornings", "ertalab win rate"],
  ["сделки дольше 5 минут", "trades longer than 5 minutes", "5 daqiqadan uzoq savdolar"],
  ["худший день", "worst day", "eng yomon kun"],
  ["сравни лонг и шорт за квартал", "compare long and short this quarter", "shu chorakda long va shortni solishtir"],
  ["Ориф, MRK, 15 октября", "Orif, MRK, October 15", "Orif, MRK, 15-oktabr"],
  ["прибыльные шорты орифа", "Orif's winning shorts", "Orifning foydali shortlari"],
  ["сделки Тимура вчера", "Timur's trades yesterday", "Timurning kechagi savdolari"],
  ["покажи мне всё по утрам", "show me everything in the morning", "ertalabki hammasini koʻrsat"],
  ["long INTC ytd", "long INTC year to date", "long INTC yil boshidan"],
  // Periods.
  ["в октябре", "in October", "oktabrda"],
  ["за октябрь", "for October", "oktabr uchun"],
  ["в ноябре", "in November", "noyabrda"],
  ["в мае", "in May", "mayda"],
  ["октябрь 2025", "October 2025", "2025-yil oktabr"],
  ["с 1 по 15 октября", "from October 1 to 15", "1-oktabrdan 15-oktabrgacha"],
  ["с 1 сентября по 15 октября", "from September 1 to October 15", "1-sentabrdan 15-oktabrgacha"],
  ["1-15 октября", "October 1-15", "1-15 oktabr"],
  ["с 1 октября", "since October 1", "1-oktabrdan beri"],
  ["до 15 октября", "until October 15", "15-oktabrgacha"],
  ["с начала года", "year to date", "yil boshidan beri"],
  ["в прошлом месяце", "last month", "oʻtgan oyda"],
  ["на прошлой неделе", "last week", "oʻtgan hafta"],
  ["на этой неделе", "this week", "bu hafta"],
  ["сегодня", "today", "bugun"],
  ["вчера", "yesterday", "kecha"],
  ["позавчера", "the day before yesterday", "oʻtgan kuni"],
  ["за 10 дней", "last 10 days", "oxirgi 10 kun"],
  ["за последние 30 дней", "past 30 days", "soʻnggi 30 kun"],
  ["за последние две недели", "last two weeks", "oxirgi ikki hafta"],
  ["за последние пару дней", "the last couple of days", "oxirgi ikki kun"],
  ["за неделю", "the past week", "oxirgi hafta"],
  ["3 квартал", "3rd quarter", "3-chorak"],
  ["в прошлом квартале", "last quarter", "oʻtgan chorakda"],
  ["в четверг", "on Thursday", "payshanbada"],
  ["в прошлом году", "last year", "oʻtgan yili"],
  ["за всё время", "all time", "butun vaqt"],
  // Time of day.
  ["до 10:30", "before 10:30", "10:30 gacha"],
  ["после 14", "after 2pm", "soat 14 dan keyin"],
  ["с 9:30 до 10:00", "from 9:30 to 10:00", "9:30 dan 10:00 gacha"],
  ["в обед", "at lunch", "tushlikda"],
  ["премаркет", "premarket", "premarketda"],
  ["на открытии", "at the open", "ochilishda"],
  ["утренние лонги", "morning longs", "ertalabki longlar"],
  ["шорты после обеда", "shorts in the afternoon", "tushdan keyin shortlar"],
  ["после 10:00 до 12:00", "after 10:00 before 12:00", "10:00 dan keyin 12:00 gacha"],
  ["сделки с 10:00 до 11:30", "trades from 10:00 to 11:30", "10:00 dan 11:30 gacha savdolar"],
  // Weekdays.
  ["средний винрейт по пятницам", "average win rate on Fridays", "juma kunlari oʻrtacha win rate"],
  ["по понедельникам и пятницам", "on Mondays and Fridays", "dushanba va juma kunlari"],
  // Price, hold, size.
  ["дешевле $5", "cheaper than $5", "$5 dan arzon"],
  ["дороже 50$", "above 50$", "50$ dan qimmat"],
  ["от 5 до 20$", "from 5 to 20$", "5 dan 20$ gacha"],
  ["до 10$", "under 10$", "10$ gacha"],
  ["до 5 минут", "under 5 minutes", "5 daqiqagacha"],
  ["короче 30 секунд", "shorter than 30 seconds", "30 soniyadan qisqa"],
  ["от 1 до 5 минут", "from 1 to 5 minutes", "1 dan 5 daqiqagacha"],
  ["дольше часа", "longer than an hour", "soatdan uzoq"],
  ["больше 2 мин", "more than 2 min", "2 daqiqadan koʻp"],
  ["размер больше 500 акций", "more than 500 shares", "500 aksiyadan koʻp"],
  // Context, last N.
  ["после 2 убытков подряд", "after 2 losses in a row", "ketma-ket 2 ta zarardan keyin"],
  ["винрейт после убытка", "win rate after a loss", "zarardan keyin win rate"],
  ["последние 20 сделок", "last 20 trades", "oxirgi 20 ta savdo"],
  // Intents and group-by.
  ["сколько сделок в октябре", "how many trades in October", "oktabrda nechta savdo"],
  ["сколько заработал на INTC", "how much did I make on INTC", "INTC da qancha ishladim"],
  ["средний результат шортов", "average result of shorts", "shortlarning oʻrtacha natijasi"],
  ["винрейт по часам", "win rate by hour", "soatlar boʻyicha win rate"],
  ["нетто по дням недели", "net by weekday", "hafta kunlari boʻyicha sof"],
  ["результат по тикерам", "result by ticker", "tikerlar boʻyicha natija"],
  ["результат по сетапам", "result by setup", "setaplar boʻyicha natija"],
  ["результат по удержанию", "result by hold time", "ushlab turish boʻyicha natija"],
  ["результат по размеру", "result by size", "oʻlcham boʻyicha natija"],
  ["результат по времени дня", "result by time of day", "kun vaqti boʻyicha natija"],
  ["результат по месяцам", "result by month", "oylar boʻyicha natija"],
  ["лучший час", "best hour", "eng yaxshi soat"],
  ["худшая сделка", "worst trade", "eng yomon savdo"],
  ["лучший день недели", "best day of the week", "eng yaxshi hafta kuni"],
  ["самый убыточный тикер", "least profitable ticker", "eng zararli tiker"],
  ["лучшие дни", "best days", "eng yaxshi kunlar"],
  ["топ 5 тикеров", "top 5 tickers", "top 5 tiker"],
  ["худшие дни", "worst days", "eng yomon kunlar"],
  ["лучший день в сентябре", "best day in September", "sentabrdagi eng yaxshi kun"],
  ["профит-фактор за всё время", "profit factor all time", "butun vaqt uchun profit-faktor"],
  ["максимальная просадка в сентябре", "max drawdown in September", "sentabrda maks. pasayish"],
  ["среднее удержание", "average hold time", "oʻrtacha ushlab turish"],
  ["сетап news", "setup news", "setap news"],
  ["нетто весь деск", "net for the whole desk", "sof butun desk"],
  ["сколько съели комиссии", "how much I paid in fees", "komissiyaga qancha ketdi"],
  // Comparisons.
  ["утро vs после обеда", "morning vs afternoon", "ertalab vs tushdan keyin"],
  ["AAPL vs NVDA", "AAPL vs NVDA", "AAPL vs NVDA"],
  ["сентябрь vs октябрь", "September vs October", "sentabr vs oktabr"],
  ["по понедельникам или по пятницам лучше", "Mondays or Fridays, which is better", "dushanba yoki juma kunlari yaxshiroq"],
  ["Ориф vs Тимур", "Orif vs Timur", "Orif vs Timur"],
  ["AAPL и NVDA", "AAPL and NVDA", "AAPL va NVDA"],
  ["лонги и шорты", "longs and shorts", "longlar va shortlar"],
  ["INTC vs MRK за сентябрь", "INTC vs MRK in September", "INTC vs MRK sentabrda"],
  // Insights and streaks.
  ["когда я теряю больше всего", "when do I lose the most", "qachon eng koʻp yoʻqotaman"],
  ["когда я зарабатываю больше всего", "when do I make the most", "qachon eng koʻp pul ishlayman"],
  ["в какой час я теряю больше всего", "which hour do I lose the most", "qaysi soatda eng koʻp yoʻqotaman"],
  ["самая длинная серия убытков", "longest losing streak", "eng uzun zarar seriyasi"],
  ["серия побед по дням", "winning streak by day", "kunlar boʻyicha yutuq seriyasi"],
];

describe.each(CASES)("«%s»", (ru, en, uz) => {
  const base = shape(p(ru));
  it(`EN «${en}»`, () => {
    const q = p(en);
    expect(shape(q)).toEqual(base);
    expect(q.unknown).toEqual([]);
  });
  it(`UZ «${uz}»`, () => {
    const q = p(uz);
    expect(shape(q)).toEqual(base);
    expect(q.unknown).toEqual([]);
  });
});

describe("EN / UZ specifics", () => {
  it("UZ apostrophes in any spelling: oʻ, o', o‘, o`", () => {
    for (const s of ["oʻrtacha ushlab turish", "o'rtacha ushlab turish", "o‘rtacha ushlab turish", "o`rtacha ushlab turish", "ortacha ushlab turish"]) {
      expect(p(s).intent).toBe("hold");
    }
  });
  it("English typos are corrected (6+ letters)", () => {
    const q = p("winrte in september");
    expect(q.intent).toBe("winrate");
    expect(q.date?.from).toBe("2026-09-01");
    expect(q.corrections.length).toBeGreaterThan(0);
  });
  it("Uzbek typo «komisiya» ⇒ fees", () => expect(p("komisiya oktabrda").intent).toBe("fees"));
  it("English words are not tickers; unknown words stay unknown", () => {
    const q = p("hello how are you");
    expect(q.ok).toBe(false);
    expect(q.tickers).toEqual([]);
  });
  it("Uzbek nonsense ⇒ ok=false", () => expect(p("salom qalaysiz").ok).toBe(false));
  it("Uzbek case ending after a ticker: «INTCda», «NVDAni»", () => {
    expect(p("INTCda shortlar").tickers).toEqual(["INTC"]);
    expect(p("NVDAni AAPL bilan solishtir").compare).toMatchObject({ dim: "ticker", a: { label: "NVDA" }, b: { label: "AAPL" } });
  });
  it("12-hour clock: «after 2pm», «before 10:30am»", () => {
    expect(p("after 2pm").time).toMatchObject({ fromMin: 840 });
    expect(p("before 10:30am").time).toMatchObject({ toMin: 630 });
  });
  it("mixed RU/EN question works", () => {
    const q = p("winrate шортов за сентябрь");
    expect(q.intent).toBe("winrate");
    expect(q.side).toBe("Short");
    expect(q.date?.from).toBe("2026-09-01");
  });
  it("EN chip removal and replacement re-parse in place", () => {
    const q = p("shorts INTC in October");
    const date = q.tokens.find((t) => t.kind === "date")!;
    const next = p(textWithoutToken(q, date.key));
    expect(next.date).toBeNull();
    expect(next.side).toBe("Short");
    const side = q.tokens.find((t) => t.kind === "side")!;
    expect(p(replaceToken(q, side.key, "longs")).side).toBe("Long");
  });
  it("UZ chip removal keeps the rest", () => {
    const q = p("INTC shortlar oktabrda");
    const date = q.tokens.find((t) => t.kind === "date")!;
    const next = p(textWithoutToken(q, date.key));
    expect(next.date).toBeNull();
    expect(next.tickers).toEqual(["INTC"]);
  });
});
