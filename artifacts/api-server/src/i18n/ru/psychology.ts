/**
 * Server `psychology`: psychology analytics (routes/psychologyanalytics.ts) and the weekly psychology report
 * (lib/weeklyPsychologyReport.ts, re-rendered from stored stats on read). Terms: edge-tracker/src/i18n/GLOSSARY.md.
 */
export default {
  states: {
    focused: "в фокусе",
    stressed: "стресс",
    tilted: "тильт",
    revenge: "реванш",
    anxious: "тревога",
    sleepWell: "выспался",
    normal: "обычное",
  },
  /** Check-in factors: present vs absent among trades on days with a check-in. */
  factors: {
    sleepWell: { label: "Сон", withLabel: "Выспался", withoutLabel: "Не выспался", lead: "Когда вы высыпаетесь,", contrast: "в дни недосыпа" },
    focused: { label: "Фокус", withLabel: "В фокусе", withoutLabel: "Без фокуса", lead: "В дни, когда вы в фокусе,", contrast: "в остальные дни" },
    stressed: { label: "Стресс", withLabel: "Стресс", withoutLabel: "Без стресса", lead: "В дни со стрессом", contrast: "в спокойные дни" },
    anxious: { label: "Тревога", withLabel: "Тревога", withoutLabel: "Без тревоги", lead: "В тревожные дни", contrast: "в остальные дни" },
    tilted: { label: "Тильт", withLabel: "Тильт", withoutLabel: "Без тильта", lead: "В дни с тильтом", contrast: "в дни без него" },
    revenge: { label: "Реванш", withLabel: "Желание отыграться", withoutLabel: "Без реванша", lead: "Когда хочется отыграться,", contrast: "в обычные дни" },
  },
  /** Behaviour comparisons that need no check-ins. */
  behavior: {
    afterLoss: { label: "После убытка", withLabel: "После убытка", withoutLabel: "Остальные", lead: "Сделки, открытые в тот же день после убыточной,", contrast: "у остальных" },
    overtrading: { label: "Много сделок за день", withLabel: "3+ сделки в день", withoutLabel: "1–2 сделки в день", lead: "В дни, когда вы делаете 3 и больше сделок,", contrast: "в дни с 1–2 сделками" },
    conviction: { label: "Высокая убеждённость", withLabel: "Убеждённость 4–5★", withoutLabel: "1–3★", lead: "В сделках с убеждённостью 4–5★", contrast: "при 1–3★" },
    grade: { label: "Оценка A/A+", withLabel: "Оценка A/A+", withoutLabel: "Оценка B/C", lead: "В сделках с оценкой A/A+", contrast: "у сделок B/C" },
  },
  compare: {
    wrHigher: "винрейт выше на {pp} п.п. — {a}% против {b}% {contrast}",
    wrLower: "винрейт ниже на {pp} п.п. — {a}% против {b}% {contrast}",
    wrSame: "винрейт такой же, как — {a}% против {b}% {contrast}",
    r: "средний результат {a} против {b} на сделку",
    rContrast: "средний результат {a} против {b} на сделку {contrast}",
    text: "{lead} {parts}. Выборка: {na} и {nb} сделок.",
    titleR: "{label}: {metric} на сделку",
    titleWr: "{label}: {metric} к винрейту",
    pp: "{value} п.п.",
  },
  coverage: {
    title: "Мало чек-инов",
    text: "Утренний чек-ин есть только для {pct}% сделок ({n} из {total}). Заполняйте его каждый торговый день — тогда сон, стресс и фокус можно будет сравнить с результатом.",
  },
  bestState: "Лучшее состояние для вас: {state} (WR {wr}%)",
  noData: "Накопите больше данных (минимум 2 сделки в каждой группе сравнения) для появления инсайтов",
  /** Weekly psychology report (buildInsights). */
  weekly: {
    states: {
      focused: "в фокусе",
      stressed: "стресс",
      tilted: "тильт",
      revenge: "отыгрыш",
      anxious: "тревога",
      normal: "без отметок",
    },
    noTrades: "На этой неделе сделок нет.",
    summary: { one: "За неделю: {count} сделка, винрейт {wr}%.", few: "За неделю: {count} сделки, винрейт {wr}%.", many: "За неделю: {count} сделок, винрейт {wr}%.", other: "За неделю: {count} сделки, винрейт {wr}%." },
    summaryPnl: { one: "За неделю: {count} сделка, винрейт {wr}%, P&L {pnl}.", few: "За неделю: {count} сделки, винрейт {wr}%, P&L {pnl}.", many: "За неделю: {count} сделок, винрейт {wr}%, P&L {pnl}.", other: "За неделю: {count} сделки, винрейт {wr}%, P&L {pnl}." },
    wrUp: "Винрейт вырос на {pp} п.п. к прошлой неделе.",
    wrDown: "Винрейт снизился на {pp} п.п. к прошлой неделе.",
    focusUp: "В дни «в фокусе» винрейт выше на {pp} п.п. ({a}% против {b}%).",
    focusDown: "В дни «в фокусе» винрейт ниже на {pp} п.п. — проверьте, не переторговываете ли вы на уверенности.",
    stressCost: "Стресс стоит {pp} п.п. винрейта ({a}% против {b}%).",
    stressDays: { one: "Стресс отмечен {count} день — пересмотрите утреннюю рутину.", few: "Стресс отмечен {count} дня — пересмотрите утреннюю рутину.", many: "Стресс отмечен {count} дней — пересмотрите утреннюю рутину.", other: "Стресс отмечен {count} дня — пересмотрите утреннюю рутину." },
    tiltDays: { one: "Тильт отмечен {count} день — в такие сессии следите за овертрейдингом и дневным лимитом.", few: "Тильт отмечен {count} дня — в такие сессии следите за овертрейдингом и дневным лимитом.", many: "Тильт отмечен {count} дней — в такие сессии следите за овертрейдингом и дневным лимитом.", other: "Тильт отмечен {count} дня — в такие сессии следите за овертрейдингом и дневным лимитом." },
    revengeR: { one: "{count} сделка в режиме отыгрыша — в среднем {r}R.", few: "{count} сделки в режиме отыгрыша — в среднем {r}R.", many: "{count} сделок в режиме отыгрыша — в среднем {r}R.", other: "{count} сделки в режиме отыгрыша — в среднем {r}R." },
    revengeWr: { one: "{count} сделка в режиме отыгрыша — винрейт {wr}%.", few: "{count} сделки в режиме отыгрыша — винрейт {wr}%.", many: "{count} сделок в режиме отыгрыша — винрейт {wr}%.", other: "{count} сделки в режиме отыгрыша — винрейт {wr}%." },
    bestState: "Лучшее состояние недели — «{state}» ({wr}% винрейт).",
    noCheckins: "Чек-инов на этой неделе нет — без них не видно, как состояние влияет на результат.",
    fewCheckins: "Чек-ин заполнен {n} из 5 дней — чем больше данных, тем точнее выводы.",
  },
} as const;
