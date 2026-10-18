/**
 * Server `academyCohorts`: cohorts, sessions, IDP goals and the mentor dashboard (lib/academyCohorts,
 * routes/academy-cohorts.ts). Stage names come from `academyPath.stages`. Cohort / session / goal titles, notes and
 * comments are user content. EN/UZ match edge-tracker academyCohorts.
 */
export default {
  enrollmentStatus: { active: "Учится", paused: "Пауза", graduated: "Выпущен", dropped: "Отчислен" },
  weekdays: { d0: "вс", d1: "пн", d2: "вт", d3: "ср", d4: "чт", d5: "пт", d6: "сб" },
  rule: {
    once: "разово {date}",
    daily: "ежедневно",
    weekdays: "по будням",
    weekly: "еженедельно: {days}",
    full: "{when} в {time} ({tz})",
  },
  metrics: {
    fee_share: { label: "Доля комиссий от брутто", unit: "%", description: "Σ|комиссий| / Σ брутто P&L за последние N торговых дней со сделками. Брутто ≤ 0 — цель не выполнена.", example: "доля комиссий < 50% брутто за 10 дней" },
    loss_streak: { label: "Убыточных сделок подряд (макс.)", unit: "сделок", description: "Самая длинная серия убыточных (по нетто) сделок подряд за последние N торговых дней. Безубыточная сделка серию не прерывает.", example: "не более 3 убыточных сделок подряд за 10 дней" },
    win_rate: { label: "Винрейт", unit: "%", description: "W / (W + L) по последним N сделкам с исходом (безубыточные исключены). Пока сделок меньше N — цель не засчитывается.", example: "винрейт ≥ 50% на 100 сделках" },
    journal_days: { label: "Дней дневника с разбором", unit: "дней", description: "Торговые дни с даты начала цели, где заполнен дневник (что получилось / ошибки / уроки) или день закрыт в EOD.", example: "закрыть 10 дней дневника с разбором" },
    net_pnl: { label: "Нетто P&L", unit: "$", description: "Сумма нетто (брутто − |комиссии|) за последние N торговых дней со сделками.", example: "нетто ≥ $0 за 20 дней" },
    trading_days: { label: "Торговых дней", unit: "дней", description: "Число дней со сделками с даты начала цели.", example: "20 торговых дней" },
    manual: { label: "Ручная цель", unit: "%", description: "Прогресс отмечает наставник (или студент) вручную, 0–100 %.", example: "прочитать «Trading in the Zone» и сдать конспект" },
  },
  /** Goal evaluation details (GoalEval.detail; `detailMsg` carries key + params). */
  goal: {
    manual: "Отмечено вручную: {pct} %",
    noTrades: "Нет сделок",
    fees: "Комиссии ${fees} из брутто ${gross} за {days} из {n} дн.",
    grossNeg: "Брутто ≤ 0 за {days} дн. (комиссии ${fees}) — цель не выполнена",
    lossStreak: "Макс. серия убытков {value} за {days} из {n} дн. ({trades} сделок)",
    net: "Нетто ${net} за {days} из {n} дн.",
    needDays: "{detail}; нужно {n} дн. для зачёта ({sign} {target})",
    winRate: "{wins} из {total} сделок в плюс",
    winRateNeed: "{wins} из {total} сделок в плюс; нужно {n} сделок для зачёта",
    noDecided: "Нет сделок с исходом",
    sinceJournal: { one: "{value} из {count} дня дневника с разбором с {date}", few: "{value} из {count} дней дневника с разбором с {date}", many: "{value} из {count} дней дневника с разбором с {date}", other: "{value} из {count} дней дневника с разбором с {date}" },
    sinceTrading: { one: "{value} из {count} торгового дня с {date}", few: "{value} из {count} торговых дней с {date}", many: "{value} из {count} торговых дней с {date}", other: "{value} из {count} торговых дней с {date}" },
    formulaDays: " за {n} дн.",
    formulaTrades: " на {n} сделках",
  },
  /** Why a student is falling behind (mentor dashboard; reasons also carry `code` + `params`). */
  lag: {
    paused: "Обучение на паузе",
    attendance_low: "Посещаемость {pct} %",
    absent_streak: { one: "{count} пропуск подряд", few: "{count} пропуска подряд", many: "{count} пропусков подряд", other: "{count} пропуска подряд" },
    overdue_actions: "Просрочено договорённостей: {n}",
    missed_goals: "Сорвано целей ИПР: {n}",
    goals_at_risk: "Цели под угрозой срыва: {n}",
    no_trades_never: "Нет ни одной сделки",
    no_trades: "Не торгует {n} раб. дн. (последняя сделка {date})",
    no_journal_never: "Дневник ещё не вёлся",
    no_journal: "Дневник не заполнялся {n} раб. дн.",
  },
  /** Notifications (lib/notificationRenderers/academyCohorts.ts). */
  notify: {
    goalAchievedTitle: "Цель ИПР достигнута",
    goalMissedTitle: "Срок цели ИПР истёк",
    goalAchieved: "{student}: «{title}» — выполнено ({detail})",
    goalMissed: "{student}: «{title}» — срок {due} прошёл, цель не достигнута ({detail})",
    actionOverdueTitle: "Договорённость просрочена",
    actionOverdue: "{student}: договорённость «{title}» просрочена (срок {due})",
    changeTitle: "Изменение в обучении",
    changeStage: "ступень: {from} → {to}",
    changeStatus: "статус: {from} → {to}",
    enrolledTitle: "Вы зачислены в когорту",
    enrolledBody: "Когорта «{cohort}», ступень «{stage}»",
    actionTitle: "Новая договорённость с наставником",
    actionBody: "«{title}»",
    actionBodyDue: "«{title}» — срок {due}",
    goalTitle: "Новая цель в ИПР",
    goalBody: "«{title}» — {formula}",
    goalBodyDue: "«{title}» — {formula}, срок {due}",
  },
  /** Enrollment history notes written by the system. */
  history: { enrolled: "Зачисление", archived: "Убран из когорты (архив)" },
} as const;
