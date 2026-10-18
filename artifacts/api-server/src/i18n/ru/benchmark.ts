/** Server `benchmark`: trader benchmark metric labels / hints and badges — lib/benchmark.ts. PF, Sharpe, Sortino, Win rate, R stay as is. Terms: edge-tracker/src/i18n/GLOSSARY.md. */
export default {
  metric: {
    net: {
      label: "Нетто",
      hint: "Σ (pnl − |комиссии|)",
    },
    expectancy: {
      label: "Ожидание $",
      hint: "Нетто / сделки с $",
    },
    winRate: {
      label: "Win rate",
      hint: "W / (W + L), безубыток исключён",
    },
    profitFactor: {
      label: "PF",
      hint: "Σ нетто⁺ / |Σ нетто⁻|; нет убытков → —",
    },
    payoff: {
      label: "Плюс / минус",
      hint: "Средний плюс / |средний минус|",
    },
    sharpe: {
      label: "Sharpe",
      hint: "Среднее / σ дневного нетто × √252 (≥ 5 дней)",
    },
    sortino: {
      label: "Sortino",
      hint: "Среднее / нисходящее σ × √252 (≥ 5 дней)",
    },
    dailyVol: {
      label: "Волатильность дня",
      hint: "σ дневного нетто",
    },
    maxDd: {
      label: "Макс. просадка",
      hint: "Пик → дно дневной кривой нетто",
    },
    recoveryDays: {
      label: "Восстановление",
      hint: "Торговых дней от дна до прежнего пика",
    },
    greenShare: {
      label: "Зелёные дни",
      hint: "Доля дней с нетто > 0",
    },
    bestDayShare: {
      label: "Лучший день / прибыль",
      hint: "Правило консистентности: > 30% — внимание, > 40% — нарушение",
    },
    feeShare: {
      label: "Комиссии / брутто",
      hint: "Доля брутто-прибыли, ушедшая в комиссии",
    },
    tradesPerDay: {
      label: "Сделок в день",
      hint: "Сделки / торговые дни (нейтральная: активность)",
    },
    maxLossStreak: {
      label: "Серия минусов",
      hint: "Самая длинная серия убыточных сделок",
    },
    avgHoldMin: {
      label: "Удержание",
      hint: "Среднее время в позиции (нейтральная)",
    },
    first15Share: {
      label: "Первые 15 мин",
      hint: "Доля входов 9:30–9:45 ET (нейтральная)",
    },
    expectancyR: {
      label: "Ожидание R",
      hint: "Только сделки со стопом / риском",
    },
  },
  badge: {
    consistencyBreach: "Один день делает период",
    consistencyBreachDetail: "Лучший день {day} = {share} прибыли (> 40%)",
    consistencyWarn: "Консистентность на грани",
    consistencyWarnDetail: "Лучший день = {share} прибыли (> 30%)",
    consistencyOk: "Ровная прибыль",
    consistencyOkDetail: "Лучший день = {share} прибыли",
    fees: "Комиссии съедают",
    feesDetail: "{share} брутто уходит в комиссии",
    pfHigh: "Высокий PF",
    pfLow: "PF < 1",
    pfLowDetail: "PF {pf} — система теряет",
    payoff: "Режет плюс, держит минус",
    payoffDetail: "Средний плюс / средний минус {value}",
    streak: "Длинные серии минусов",
    streakDetail: "{n} убыточных подряд",
    open: "Минус на открытии",
    openDetail: "{n} входов 9:30–9:45, нетто {net} $",
    dd: "Ещё в просадке",
    ddDetail: "Не восстановлен пик {value} $",
    hold: "Пересиживает убытки",
    holdDetail: "Минус держит {loss} мин vs плюс {win} мин",
    top: "{metric}: топ деска",
    bottom: "{metric}: низ деска",
    percentile: "Перцентиль {p}",
  },
} as const;
