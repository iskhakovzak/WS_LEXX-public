import { describe, expect, it } from "vitest";
import { parseAsk, replaceToken, textWithoutToken, type ParseContext } from "@/lib/ask/parse";

// Friday 2026-10-16 (NY trading date).
const ctx: ParseContext = {
  today: "2026-10-16",
  traders: ["Ориф", "Тимур"],
  tickers: ["AAPL", "NVDA", "INTC", "MRK", "TSLA", "AMD"],
  setups: ["news", "gap and go"],
};
const p = (s: string) => parseAsk(s, ctx);

describe("опечатки, ё/е, раскладка, числа словами", () => {
  it.each([
    ["винрейд за сентябрь", "winrate"],
    ["винрейт за сентебре", "winrate"],
    ["сколько съели комисии", "fees"],
    ["комисси за всё время", "fees"],
  ])("«%s» ⇒ %s", (text, intent) => {
    expect(p(text).intent).toBe(intent);
  });

  it("«шотры» ⇒ шорты", () => {
    const q = p("шотры в октябре");
    expect(q.side).toBe("Short");
    expect(q.corrections.length).toBeGreaterThan(0);
  });

  it("«лучщий тикер» ⇒ best ticker", () => {
    const q = p("лучщий тикер");
    expect(q.intent).toBe("best");
    expect(q.target).toBe("ticker");
  });

  it("неправильная раскладка «dbyhtqn» ⇒ винрейт", () => {
    expect(p("dbyhtqn").intent).toBe("winrate");
  });

  it("тикер латиницей не «исправляется» раскладкой", () => {
    const q = p("NVDA за неделю");
    expect(q.tickers).toEqual(["NVDA"]);
    expect(q.corrections).toEqual([]);
  });

  it("«за всё время» и «за все время» одинаково", () => {
    const a = p("нетто за всё время");
    const b = p("нетто за все время");
    expect(a.date).toBeNull();
    expect(b.date).toBeNull();
    expect(a.unknown).toEqual([]);
    expect(b.unknown).toEqual([]);
  });

  it("«ё» в «зарабатываю/теряю» не мешает: «где я теряю больше всего»", () => {
    expect(p("где я теряю больше всего").intent).toBe("insight");
  });

  it("числа словами: «за последние две недели»", () => {
    expect(p("за последние две недели").date).toMatchObject({ from: "2026-10-03", to: "2026-10-16" });
  });

  it("«пару дней» ⇒ 2 дня", () => {
    expect(p("за последние пару дней").date).toMatchObject({ from: "2026-10-15", to: "2026-10-16" });
  });
});

describe("периоды", () => {
  it.each([
    ["за последние 2 недели", "2026-10-03", "2026-10-16"],
    ["в сентябре", "2026-09-01", "2026-09-30"],
    ["с 1 августа", "2026-08-01", "2026-10-16"],
    ["до 15 октября", "2000-01-01", "2026-10-15"],
    ["за последние 30 дней", "2026-09-17", "2026-10-16"],
    ["вчера", "2026-10-15", "2026-10-15"],
    ["сегодня", "2026-10-16", "2026-10-16"],
    ["на этой неделе", "2026-10-12", "2026-10-16"],
    ["октябрь 2025", "2025-10-01", "2025-10-31"],
    ["с 1 по 10 октября", "2026-10-01", "2026-10-10"],
  ])("«%s» ⇒ %s…%s", (text, from, to) => {
    const q = p(text);
    expect(q.date).toMatchObject({ from, to });
    expect(q.unknown).toEqual([]);
  });
});

describe("время, дни недели, удержание, размер, цена", () => {
  it("«по пятницам» ⇒ weekday filter, не дата", () => {
    const q = p("средний винрейт по пятницам");
    expect(q.weekdays).toEqual([4]);
    expect(q.date).toBeNull();
    expect(q.intent).toBe("winrate");
  });

  it("«по понедельникам и пятницам» ⇒ два дня", () => {
    expect(p("по понедельникам и пятницам").weekdays).toEqual([0, 4]);
  });

  it("«после обеда» ⇒ 14:00–16:00", () => {
    expect(p("шорты после обеда").time).toMatchObject({ fromMin: 840, toMin: 960 });
  });

  it("«power hour» ⇒ 15:00–16:00", () => {
    expect(p("power hour").time).toMatchObject({ fromMin: 900, toMin: 960 });
  });

  it("«с 10:00 до 11:30»", () => {
    expect(p("сделки с 10:00 до 11:30").time).toMatchObject({ fromMin: 600, toMin: 690 });
  });

  it("«дольше 15 минут»", () => {
    expect(p("сделки дольше 15 минут").holdSec).toEqual({ min: 900, max: null });
  });

  it("«размер больше 500 акций»", () => {
    expect(p("размер больше 500 акций").qty).toMatchObject({ min: 500 });
  });

  it("«дешевле 10$»", () => {
    expect(p("лонги дешевле 10$").price).toEqual({ min: null, max: 10 });
  });

  it("«после 2 убытков подряд» ⇒ after loss ×2 (не серия)", () => {
    const q = p("после 2 убытков подряд");
    expect(q.after).toEqual({ kind: "loss", n: 2 });
    expect(q.intent).not.toBe("streak");
  });

  it("«после убытка»", () => {
    expect(p("винрейт после убытка").after).toEqual({ kind: "loss", n: 1 });
  });

  it("«последние 20 сделок»", () => {
    expect(p("последние 20 сделок").lastN).toBe(20);
  });
});

describe("сравнения", () => {
  it("«утро vs после обеда» ⇒ сравнение по времени (а не лонг/шорт)", () => {
    const q = p("утро vs после обеда");
    expect(q.intent).toBe("compare");
    expect(q.compare?.dim).toBe("time");
    expect(q.compare?.a.patch.time?.fromMin).toBe(570); // A = утро (order of the question)
    expect(q.compare?.b.patch.time?.fromMin).toBe(840);
    expect(q.time).toBeNull();
  });

  it("«AAPL vs NVDA» ⇒ сравнение тикеров", () => {
    const q = p("AAPL vs NVDA");
    expect(q.compare?.dim).toBe("ticker");
    expect(q.compare?.a.patch.tickers).toEqual(["AAPL"]);
    expect(q.compare?.b.patch.tickers).toEqual(["NVDA"]);
  });

  it("«сентябрь vs октябрь» ⇒ сравнение периодов", () => {
    const q = p("сентябрь vs октябрь");
    expect(q.compare?.dim).toBe("date");
    expect(q.date).toBeNull();
  });

  it("«понедельник или пятница лучше» ⇒ сравнение дней недели", () => {
    const q = p("по понедельникам или по пятницам лучше");
    expect(q.compare?.dim).toBe("weekday");
  });

  it("«Ориф vs Тимур» ⇒ сравнение трейдеров", () => {
    expect(p("Ориф vs Тимур").compare?.dim).toBe("trader");
  });

  it("«AAPL и NVDA» без «vs» ⇒ оба тикера фильтром", () => {
    const q = p("AAPL и NVDA");
    expect(q.compare).toBeNull();
    expect(q.tickers).toEqual(["AAPL", "NVDA"]);
  });
});

describe("топы, худшие, инсайты, серии", () => {
  it("«топ 5 тикеров» ⇒ best ticker, topN 5", () => {
    const q = p("топ 5 тикеров");
    expect(q.intent).toBe("best");
    expect(q.target).toBe("ticker");
    expect(q.topN).toBe(5);
  });

  it("«худшие дни» ⇒ worst day, plural", () => {
    const q = p("худшие дни");
    expect(q.intent).toBe("worst");
    expect(q.target).toBe("day");
    expect(q.topN).toBeGreaterThan(1);
  });

  it("«лучший день» ⇒ topN 1", () => {
    const q = p("лучший день в сентябре");
    expect(q.target).toBe("day");
    expect(q.topN).toBe(1);
  });

  it("«когда я теряю больше всего» ⇒ insight worst", () => {
    const q = p("когда я теряю больше всего");
    expect(q.intent).toBe("insight");
    expect(q.insight).toBe("worst");
    expect(q.ok).toBe(true);
  });

  it("«когда я зарабатываю больше всего» ⇒ insight best", () => {
    expect(p("когда я зарабатываю больше всего").insight).toBe("best");
  });

  it("«в какой час я теряю больше всего» ⇒ worst hour", () => {
    const q = p("в какой час я теряю больше всего");
    expect(q.intent).toBe("worst");
    expect(q.target).toBe("hour");
  });

  it("«самая длинная серия убытков» ⇒ streak loss", () => {
    const q = p("самая длинная серия убытков");
    expect(q.intent).toBe("streak");
    expect(q.streak?.kind).toBe("loss");
  });

  it("«серия побед по дням» ⇒ streak by day", () => {
    expect(p("серия побед по дням").streak).toEqual({ kind: "win", unit: "day" });
  });

  it("«сколько съели комиссии» ⇒ fees, без непонятых слов", () => {
    const q = p("сколько съели комиссии");
    expect(q.intent).toBe("fees");
    expect(q.unknown).toEqual([]);
  });
});

describe("группировки и метрики", () => {
  it.each([
    ["по тикерам", "ticker"],
    ["по дням недели", "weekday"],
    ["по часам", "hour"],
    ["по сетапам", "setup"],
    ["по удержанию", "holdBucket"],
    ["по размеру", "sizeBucket"],
    ["по времени дня", "slot"],
    ["по месяцам", "month"],
  ])("«%s» ⇒ groupBy %s", (text, dim) => {
    expect(p(`результат ${text}`).groupBy).toBe(dim);
  });

  it("«профит-фактор» ⇒ pf", () => expect(p("профит-фактор за всё время").intent).toBe("pf"));
  it("«просадка» ⇒ drawdown", () => expect(p("максимальная просадка в сентябре").intent).toBe("drawdown"));
  it("«среднее удержание» ⇒ hold", () => expect(p("среднее удержание").intent).toBe("hold"));
  it("«сетап news» ⇒ setup filter", () => expect(p("сетап news").setups).toEqual(["news"]));
  it("«весь деск» ⇒ allTraders", () => expect(p("нетто весь деск").allTraders).toBe(true));
});

describe("«не понял» и правка чипов", () => {
  it("бессмыслица ⇒ ok=false", () => {
    const q = p("абракадабра хрюк");
    expect(q.ok).toBe(false);
    expect(q.unknown.length).toBeGreaterThan(0);
  });

  it("removing the date chip keeps the rest", () => {
    const q = p("шорты INTC в октябре");
    const tok = q.tokens.find((t) => t.kind === "date")!;
    const next = p(textWithoutToken(q, tok.key));
    expect(next.date).toBeNull();
    expect(next.side).toBe("Short");
    expect(next.tickers).toEqual(["INTC"]);
  });

  it("replacing the side chip re-parses in place", () => {
    const q = p("шорты INTC в октябре");
    const tok = q.tokens.find((t) => t.kind === "side")!;
    const next = p(replaceToken(q, tok.key, "лонги"));
    expect(next.side).toBe("Long");
    expect(next.date?.from).toBe("2026-10-01");
  });
});
