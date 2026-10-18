/** Server `insights`: office statistics («Главное» insights, strategy rules, time buckets, weekdays, notes) — lib/officeStats.ts. Strategy codes (OPG, OPGtoDAY, Day, MOC, AfterMarket, Overnight, OPT) and money / % keep the trading format. Terms: edge-tracker/src/i18n/GLOSSARY.md. */
export default {
  rule: {
    OPG: "Вход в премаркете или на открывающем аукционе (до 09:31), выход до 10:00",
    OPGtoDAY: "Вход на открытии (премаркет / аукцион до 09:31), позиция удержана в день — выход после 10:00",
    Day: "Внутридневная сделка: вход после 09:31 и до 15:50, выход до закрывающего аукциона",
    MOC: "Закрывающий аукцион: вход после публикации дисбалансов (с 15:50) или выход в аукционе 15:59:30–16:01",
    AfterMarket: "Постмаркет: вход после 16:00 или выход внутридневной позиции после 16:01",
    Overnight: "Позиция перенесена через закрытие сессии (выход на следующий день или позже)",
    OPT: "Опционы: символ контракта в формате OCC (например, AAPL261016C00230000)",
  },
  order: "OPT → Overnight → AfterMarket (вход) → OPG / OPGtoDAY → MOC → AfterMarket (выход) → Day",
  note: {
    time: "Время — по Нью-Йорку, по первому входу и последнему выходу сделки.",
    result: "Результат дня — нетто (после комиссий) по дате закрытия сделки.",
    pct: "% — нетто ÷ капитал офиса за год, который указывают партнёры.",
    volume: "Объём — число акций / контрактов по всем исполнениям.",
  },
  bucket: {
    pre: "Премаркет",
    post: "Постмаркет",
  },
  insight: {
    eff: "{strategy} даёт {net} результата при {volume} объёма",
    drag: "{strategy} в минусе ({value}) при {volume} объёма офиса",
    negMonths: { one: "{strategy} в минусе {count} месяц подряд", few: "{strategy} в минусе {count} месяца подряд", many: "{strategy} в минусе {count} месяцев подряд", other: "{strategy} в минусе {count} месяца подряд" },
    goalDone: "Цель {year} ({goal}) уже выполнена: {value}",
    goalAhead: "Офис опережает темп к цели {goal} на {value}",
    goalBehind: "До цели {goal} нужно {need} в месяц — отставание от темпа {gap}",
    greenStreak: { one: "{count} зелёный день подряд", few: "{count} зелёных дня подряд", many: "{count} зелёных дней подряд", other: "{count} зелёного дня подряд" },
    redStreak: { one: "{count} красный день подряд", few: "{count} красных дня подряд", many: "{count} красных дней подряд", other: "{count} красного дня подряд" },
    drawdown: { one: "Офис ниже пика на {value} уже {count} торговый день", few: "Офис ниже пика на {value} уже {count} торговых дня", many: "Офис ниже пика на {value} уже {count} торговых дней", other: "Офис ниже пика на {value} уже {count} торгового дня" },
    bestTime: "Лучшее время входа — {bucket}: {share} прибыли",
    ticker: "{ticker} — {share} всей прибыли периода",
    yoy: "К этому дню {prevYear} было {was}, в {year} — {now}",
    bestMonth: "Лучший месяц {year} — {month}: {value}",
  },
} as const;
