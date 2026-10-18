import { describe, expect, it } from "vitest";
import { describeSubject, parseAsk, removeToken, textWithoutToken, type ParseContext } from "@/lib/ask/parse";

// Saturday 2026-10-17 (NY trading date). Yesterday ⇒ previous weekday (Fri 10-16).
const ctx: ParseContext = { today: "2026-10-17", traders: ["Ориф", "Тимур", "Закир", "Антон"] };
const p = (s: string) => parseAsk(s, ctx);

describe("parseAsk — examples from the brief", () => {
  it("шорты INTC в октябре после 11:00", () => {
    const q = p("шорты INTC в октябре после 11:00");
    expect(q.side).toBe("Short");
    expect(q.tickers).toEqual(["INTC"]);
    expect(q.date).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(q.time).toMatchObject({ fromMin: 660, toMin: null });
    expect(q.intent).toBe("list");
    expect(q.unknown).toEqual([]);
    expect(describeSubject(q)).toBe("Шорты INTC в октябре после 11:00");
  });

  it("лонги дешевле 10$ на этой неделе", () => {
    const q = p("лонги дешевле 10$ на этой неделе");
    expect(q.side).toBe("Long");
    expect(q.price).toEqual({ min: null, max: 10 });
    expect(q.date).toMatchObject({ from: "2026-10-12", to: "2026-10-17" });
    expect(q.time).toBeNull();
    expect(q.unknown).toEqual([]);
  });

  it("убыточные сделки вчера", () => {
    const q = p("убыточные сделки вчера");
    expect(q.outcome).toBe("loss");
    expect(q.date).toMatchObject({ from: "2026-10-16", to: "2026-10-16" });
    expect(describeSubject(q)).toBe("Убыточные сделки вчера");
  });

  it("лучший тикер за месяц", () => {
    const q = p("лучший тикер за месяц");
    expect(q.intent).toBe("best");
    expect(q.target).toBe("ticker");
    expect(q.groupBy).toBe("ticker");
    expect(q.date).toMatchObject({ from: "2026-09-18", to: "2026-10-17" });
    expect(describeSubject(q)).toBe("Лучший тикер за последний месяц");
  });

  it("сколько комиссий в сентябре", () => {
    const q = p("сколько комиссий в сентябре");
    expect(q.intent).toBe("fees");
    expect(q.date).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(q.unknown).toEqual([]);
  });

  it("винрейт по утрам", () => {
    const q = p("винрейт по утрам");
    expect(q.intent).toBe("winrate");
    expect(q.time).toMatchObject({ fromMin: 570, toMin: 660 });
  });

  it("сделки дольше 5 минут", () => {
    const q = p("сделки дольше 5 минут");
    expect(q.holdSec).toEqual({ min: 300, max: null });
    expect(q.intent).toBe("list");
    expect(q.unknown).toEqual([]);
  });

  it("худший день", () => {
    const q = p("худший день");
    expect(q.intent).toBe("worst");
    expect(q.target).toBe("day");
    expect(q.groupBy).toBe("day");
  });

  it("сравни лонг и шорт за квартал", () => {
    const q = p("сравни лонг и шорт за квартал");
    expect(q.intent).toBe("compare");
    expect(q.compare).toMatchObject({ dim: "side", a: { patch: { side: "Long" } }, b: { patch: { side: "Short" } } });
    expect(q.side).toBeNull();
    expect(q.date).toMatchObject({ from: "2026-10-01", to: "2026-10-17" });
    expect(describeSubject(q)).toBe("Лонг vs шорт · за квартал");
  });

  it("Ориф, MRK, 15 октября (staff names a trader)", () => {
    const q = p("Ориф, MRK, 15 октября");
    expect(q.trader).toBe("Ориф");
    expect(q.tickers).toEqual(["MRK"]);
    expect(q.date).toMatchObject({ from: "2026-10-15", to: "2026-10-15" });
    expect(q.unknown).toEqual([]);
  });
});

describe("declensions and noise", () => {
  it.each([
    ["шорт", "Short"], ["шорты", "Short"], ["шортов", "Short"], ["шортам", "Short"],
    ["лонг", "Long"], ["лонги", "Long"], ["лонгов", "Long"], ["long", "Long"], ["short", "Short"],
  ])("%s ⇒ %s", (word, side) => {
    expect(p(`${word} INTC`).side).toBe(side);
  });

  it.each([
    ["в октябре", "2026-10-01", "2026-10-31"],
    ["октябрь", "2026-10-01", "2026-10-31"],
    ["за октябрь", "2026-10-01", "2026-10-31"],
    ["в ноябре", "2025-11-01", "2025-11-30"],
    ["в мае", "2026-05-01", "2026-05-31"],
    ["октябрь 2025", "2025-10-01", "2025-10-31"],
  ])("month «%s»", (text, from, to) => {
    expect(p(text).date).toMatchObject({ from, to });
  });

  it("trader name declension: прибыльные шорты орифа", () => {
    const q = p("прибыльные шорты орифа");
    expect(q.trader).toBe("Ориф");
    expect(q.outcome).toBe("win");
    expect(q.side).toBe("Short");
    expect(describeSubject(q)).toBe("Прибыльные шорты · Ориф");
  });

  it("сделки Тимура вчера", () => {
    const q = p("сделки Тимура вчера");
    expect(q.trader).toBe("Тимур");
    expect(q.date?.from).toBe("2026-10-16");
  });

  it("lowercase and cashtag tickers", () => {
    expect(p("intc").tickers).toEqual(["INTC"]);
    expect(p("$aapl и $MSFT").tickers).toEqual(["AAPL", "MSFT"]);
  });

  it("vocabulary words are not tickers", () => {
    const q = p("long INTC ytd");
    expect(q.side).toBe("Long");
    expect(q.tickers).toEqual(["INTC"]);
    expect(q.date).toMatchObject({ from: "2026-01-01", to: "2026-10-17" });
  });

  it("ё is normalised and noise words are ignored", () => {
    const q = p("покажи мне всё по утрам");
    expect(q.time).toMatchObject({ fromMin: 570 });
    expect(q.unknown).toEqual([]);
  });
});

describe("dates", () => {
  it.each([
    ["с 1 по 15 октября", "2026-10-01", "2026-10-15"],
    ["с 1 сентября по 15 октября", "2026-09-01", "2026-10-15"],
    ["1-15 октября", "2026-10-01", "2026-10-15"],
    ["с 1 октября", "2026-10-01", "2026-10-17"],
    ["YTD", "2026-01-01", "2026-10-17"],
    ["с начала года", "2026-01-01", "2026-10-17"],
    ["в прошлом месяце", "2026-09-01", "2026-09-30"],
    ["на прошлой неделе", "2026-10-05", "2026-10-09"],
    ["сегодня", "2026-10-17", "2026-10-17"],
    ["позавчера", "2026-10-15", "2026-10-15"],
    ["за 10 дней", "2026-10-08", "2026-10-17"],
    ["за неделю", "2026-10-11", "2026-10-17"],
    ["Q3", "2026-07-01", "2026-09-30"],
    ["3 квартал", "2026-07-01", "2026-09-30"],
    ["в прошлом квартале", "2026-07-01", "2026-09-30"],
    ["15.10", "2026-10-15", "2026-10-15"],
    ["2026-10-05", "2026-10-05", "2026-10-05"],
    ["в четверг", "2026-10-15", "2026-10-15"],
    ["в прошлом году", "2025-01-01", "2025-12-31"],
  ])("«%s» ⇒ %s…%s", (text, from, to) => {
    const q = p(text);
    expect(q.date).toMatchObject({ from, to });
    expect(q.unknown).toEqual([]);
  });

  it("YTD phrase is humanised", () => {
    expect(p("нетто YTD").date?.phrase).toBe("с начала года");
  });
});

describe("time of day", () => {
  it.each([
    ["до 10:30", null, 630],
    ["после 14", 840, null],
    ["с 9:30 до 10:00", 570, 600],
    ["9:30-10:15", 570, 615],
    ["в обед", 660, 840],
    ["power hour", 900, 960],
    ["премаркет", 240, 570],
    ["на открытии", 570, 600],
    ["утренние лонги", 570, 660],
  ])("«%s»", (text, fromMin, toMin) => {
    expect(p(text).time).toMatchObject({ fromMin, toMin });
  });

  it("после 10 и до 12 combine into one window", () => {
    expect(p("после 10:00 до 12:00").time).toMatchObject({ fromMin: 600, toMin: 720 });
  });
});

describe("price and hold", () => {
  it.each([
    ["дешевле $5", { min: null, max: 5 }],
    ["дороже 50$", { min: 50, max: null }],
    ["от 5 до 20$", { min: 5, max: 20 }],
    ["до 10$", { min: null, max: 10 }],
    ["<7.5$", { min: null, max: 7.5 }],
  ])("price «%s»", (text, price) => {
    const q = p(text);
    expect(q.price).toEqual(price);
    expect(q.time).toBeNull();
  });

  it.each([
    ["до 5 минут", { min: null, max: 300 }],
    ["короче 30 секунд", { min: null, max: 30 }],
    ["от 1 до 5 минут", { min: 60, max: 300 }],
    ["дольше часа", { min: 3600, max: null }],
    ["больше 2 мин", { min: 120, max: null }],
  ])("hold «%s»", (text, hold) => {
    const q = p(text);
    expect(q.holdSec).toEqual(hold);
    expect(q.time).toBeNull();
    expect(q.price).toBeNull();
  });
});

describe("intents and group-by", () => {
  it("сколько сделок в октябре ⇒ count", () => expect(p("сколько сделок в октябре").intent).toBe("count"));
  it("сколько заработал на INTC ⇒ sum", () => {
    const q = p("сколько заработал на INTC");
    expect(q.intent).toBe("sum");
    expect(q.tickers).toEqual(["INTC"]);
  });
  it("средний результат ⇒ avg", () => expect(p("средний результат шортов").intent).toBe("avg"));
  it("винрейт по часам ⇒ winrate grouped by hour", () => {
    const q = p("винрейт по часам");
    expect(q.intent).toBe("winrate");
    expect(q.groupBy).toBe("hour");
  });
  it("нетто по дням недели ⇒ sum grouped by weekday", () => {
    const q = p("нетто по дням недели");
    expect(q.intent).toBe("sum");
    expect(q.groupBy).toBe("weekday");
  });
  it.each([
    ["лучший час", "best", "hour"],
    ["худшая сделка", "worst", "trade"],
    ["лучший день недели", "best", "weekday"],
    ["самый убыточный тикер", "worst", "ticker"],
    ["лучшие дни", "best", "day"],
  ])("«%s»", (text, intent, target) => {
    const q = p(text);
    expect(q.intent).toBe(intent);
    expect(q.target).toBe(target);
    expect(q.outcome).toBeNull();
  });
  it("худшая сделка has no group-by", () => expect(p("худшая сделка").groupBy).toBeNull());
  it("INTC vs MRK ⇒ ticker compare", () => {
    const q = p("INTC vs MRK за сентябрь");
    expect(q.compare).toMatchObject({ dim: "ticker", a: { label: "INTC" }, b: { label: "MRK" } });
    expect(q.date?.from).toBe("2026-09-01");
    expect(describeSubject(q)).toBe("INTC vs MRK · в сентябре");
  });
  it("лонги vs шорты ⇒ side compare without «сравни»", () => {
    expect(p("лонги и шорты").compare).toMatchObject({ dim: "side", a: { patch: { side: "Long" } }, b: { patch: { side: "Short" } } });
  });
});

describe("failures, chips and removal", () => {
  it("nothing understood ⇒ ok=false with the unknown words", () => {
    const q = p("привет как дела");
    expect(q.ok).toBe(false);
    expect(q.unknown).toEqual(["привет", "дела"]);
  });
  it("empty input ⇒ ok=false", () => expect(p("   ").ok).toBe(false));
  it("partial understanding keeps the unknown words", () => {
    const q = p("шорты блаблабла");
    expect(q.ok).toBe(true);
    expect(q.unknown).toEqual(["блаблабла"]);
  });
  it("tokens carry spans and labels in text order", () => {
    const q = p("шорты INTC в октябре после 11:00");
    expect(q.tokens.map((t) => t.kind)).toEqual(["side", "ticker", "date", "time"]);
    expect(q.tokens.find((t) => t.kind === "date")?.label).toBe("Период: 01.10–31.10.2026");
    expect(q.tokens.find((t) => t.kind === "time")?.text).toBe("после 11:00");
  });
  it("removing the time chip re-parses without it", () => {
    const q = p("шорты INTC в октябре после 11:00");
    const key = q.tokens.find((t) => t.kind === "time")!.key;
    expect(textWithoutToken(q, key)).toBe("шорты INTC в октябре");
    const r = removeToken(q, key, ctx);
    expect(r.time).toBeNull();
    expect(r.side).toBe("Short");
  });
  it("removing the trader chip cleans the commas", () => {
    const q = p("Ориф, MRK, 15 октября");
    const key = q.tokens.find((t) => t.kind === "trader")!.key;
    expect(textWithoutToken(q, key)).toBe("MRK, 15 октября");
  });
});
