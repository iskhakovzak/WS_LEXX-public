/**
 * `deskDay` — «Деск на тикере» (/desk-day): one ticker-day with every desk trader's entries, adds, partial exits,
 * exits and stops; the legend of traders; deterministic takeaways; entry links from the trade sheet and the day report.
 * RU addresses the trader as «ты». Tickers, R, P&L, Long/Short stay as in GLOSSARY.md.
 */
export default {
  title: "Деск на тикере",
  desc: "Сделки всего деска в этот день на одном графике — учись на входах и выходах коллег в тот же момент рынка",
  descFor: "{ticker} · {date}: сделки всего деска на одном графике",
  form: {
    ticker: "Тикер",
    date: "Дата",
    show: "Показать",
    hint: "Выбери тикер и торговый день — увидишь сделки всех трейдеров деска на одном графике.",
  },
  prevDay: "Предыдущий день",
  nextDay: "Следующий день",
  loading: "Загрузка сделок деска…",
  noCandles: "Свечей за этот день нет — график недоступен.",
  chartAria: "График {ticker} за {date} со сделками деска",
  tf: "Таймфрейм",
  empty: {
    title: "На {ticker} в этот день сделок деска нет",
    desc: "Попробуй другой день или тикер.",
  },
  guest: {
    title: "Только для участников деска",
    desc: "Войди под своим аккаунтом, чтобы видеть сделки коллег.",
  },
  legend: {
    title: "Трейдеры",
    count: { one: "{count} трейдер", few: "{count} трейдера", many: "{count} трейдеров", other: "{count} трейдера" },
    all: "Все",
    me: "я",
    focus: "Выделить сделки {name}",
    trades: { one: "{count} сделка", few: "{count} сделки", many: "{count} сделок", other: "{count} сделки" },
    window: "{from}–{to} ET",
    hold: "в позиции {time}",
    added: "доливался против позиции",
    moneyHidden: "$ и объёмы видны только владельцу сделки и кураторам.",
  },
  result: { win: "Плюс", loss: "Минус", be: "В ноль", open: "Открыта" },
  side: { both: "Лонг + Шорт" },
  key: "Обозначения",
  tip: {
    qty: "{qty} шт.",
    pieces: { one: "{count} часть", few: "{count} части", many: "{count} частей", other: "{count} части" },
    move: "{move} на акцию",
  },
  takeaway: {
    label: "Вывод",
    best: "Лучший результат — {name}: {r}, {side}, вход в {time} ET ({min} мин после открытия)",
    bestPre: "Лучший результат — {name}: {r}, {side}, вход в {time} ET, до открытия",
    bestOpen: "Лучший результат — {name}: {r}, {side}, вход на открытии ({time} ET)",
    averaging: "{averaged} из {losers} трейдеров в минусе доливались против позиции",
    timing: "В плюсе входили около {winners} ET, в минусе — около {losers} ET",
    sides: "Шорт: в плюсе {sw} из {st} · Лонг: {lw} из {lt}",
  },
  link: {
    label: "Деск на этом тикере: {traders}",
    aria: "Открыть сделки деска на {ticker} за {date}",
    chips: "Деск на тех же тикерах",
    chip: "{ticker} · {traders}",
  },
} as const;
