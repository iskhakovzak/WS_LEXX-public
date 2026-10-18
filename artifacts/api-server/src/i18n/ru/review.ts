/** Server `review`: end-of-day, weekly review and curator rating texts (API messages and notifications, rendered per reader in lib/notificationRenderers/review.ts). Names, comments and focus texts are user content. Terms: edge-tracker/src/i18n/GLOSSARY.md. */
export default {
  quote: "«{text}»",
  eod: {
    closedTitle: "День закрыт: {trader}, {date}",
    closedBody: "{parts} — ждёт разбора",
    trades: { one: "{count} сделка", few: "{count} сделки", many: "{count} сделок", other: "{count} сделки" },
    net: "нетто {net}",
    discipline: "дисциплина {value}/5",
    overdueTitle: "Разбор просрочен: {trader}, {date}",
    overdueBody: "День ждёт разбора {hours} ч (SLA {sla} ч)",
    reviewedTitle: "Разбор дня {date}: {score}/5",
    reviewedBy: "Оценка от {reviewer}",
    reviewedComment: "{reviewer}: «{comment}»",
  },
  rating: {
    newTitle: "Оценка за неделю {week}: {overall}/10",
    updatedTitle: "Оценка обновлена {week}: {overall}/10",
    focus: " · фокус: «{focus}»",
    comment: " · «{comment}»",
    ackTitle: "Оценка подтверждена: {trader}",
    ackBody: "Неделя {week}: {overall}/10",
    ackBy: " (отметил {acker})",
  },
  weekly: {
    submittedTitle: "Отчёт недели {week}: {trader}",
    mood: "Настроение {mood}/5. ",
    focus: "Фокус: «{focus}»",
    awaiting: "Самооценка ждёт разбора",
    readyTitle: "Разбор недели готов {week}",
    updatedTitle: "Разбор недели обновлён {week}",
    score: ": {score}/10",
    goals: { one: " · {count} цель на неделю", few: " · {count} цели на неделю", many: " · {count} целей на неделю", other: " · {count} цели на неделю" },
    comment: " · «{comment}»",
  },
  rubric: {
    discipline: {
      label: "Дисциплина",
      hint: "План дня, стоп соблюдён, без тильта",
    },
    riskManagement: {
      label: "Риск-менеджмент",
      hint: "Риск на сделку, дневной лимит, размер",
    },
    execution: {
      label: "Исполнение",
      hint: "Вход по плану, R-профиль, слиппедж",
    },
    journaling: {
      label: "Журнал",
      hint: "Дни с записью, идеи, разбор ошибок",
    },
    improvement: {
      label: "Прогресс",
      hint: "Динамика к прошлой неделе, работа над фокусом",
    },
  },
  formula: {
    winRate: "W / (W + L), безубыток исключён",
    avgRRubric: "ΣR / число закрытых сделок (R со знаком, ±20 clamp)",
    profitFactorRubric: "ΣR⁺ / |ΣR⁻| (null когда нет убытков)",
    netRubric: "P&L нетто = брутто − |комиссии|; дата = exit_date ?? date (NY)",
    avgR: "ΣR / закрытые (win+loss+be)",
    profitFactor: "ΣR⁺ / |ΣR⁻|",
    net: "нетто = брутто − |комиссии|; неделя по дате закрытия (NY)",
  },
  breach: {
    avgRisk: "Средний риск на сделку выше лимита",
    dailyLimit: "Дневной лимит убытка превышен",
    bigLoss: "Убыток {r}R — стоп не соблюдён",
  },
  archive: {
    rule_disabled: "правило выключено",
    rule_deleted: "правило удалено",
    stale: "неактуально",
  },
  hours: {
    pre: "До 9:30",
    post: "После 16",
  },
  ideas: {
    noTrader: "(не указан)",
    formulaWinRate: "W/(W+L), безубыток не учитывается",
    formulaNet: "нетто = брутто − комиссии",
  },
} as const;
