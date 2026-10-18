/**
 * Admin console → «Данные»: background jobs (server src/jobs) and backups.
 * `names` is nested by the dotted job name ("market.sectors" → names.market.sectors); a job without an entry shows its id.
 */
export default {
  title: "Фоновые задачи",
  description: "Расписание по времени Нью-Йорка. Каждый запуск записывается в историю; второй процесс ту же задачу не запускает.",
  refresh: "Обновить список задач",
  empty: "Нет данных о задачах",
  unavailable: "Список задач появится после перезапуска API",
  col: { job: "Задача", schedule: "Расписание", last: "Последний запуск", next: "Следующий", status: "Статус" },
  schedule: { onEvent: "после синка PropReports", onStart: "при старте", manual: "вручную" },
  status: {
    running: "Выполняется",
    ok: "Успешно",
    error: "Ошибка",
    timeout: "Превышено время",
    skipped: "Пропущено",
    never: "Ещё не запускалась",
    disabled: "Выключена",
  },
  failures24h: { one: "{count} сбой за 24 ч", few: "{count} сбоя за 24 ч", many: "{count} сбоев за 24 ч", other: "{count} сбоя за 24 ч" },
  duration: "{seconds} с",
  run: "Запустить",
  runAria: "Запустить задачу «{job}» сейчас",
  started: "Задача запущена",
  startFailed: "Не удалось запустить задачу",
  names: {
    market: { sectors: "Сила секторов", "analyst-actions": "Действия аналитиков" },
    digest: { morning: "Утренний дайджест", evening: "Вечерний дайджест" },
    psychology: { "weekly-report": "Недельный отчёт по психологии" },
    quotes: { daily: "Цитата дня" },
    db: { backup: "Бэкап базы данных" },
    academy: { challenges: "Экзамены академии", readiness: "Готовность к переводу" },
    propreports: { sync: "Синхронизация PropReports" },
    trades: { "structure-backfill": "Структура сделок" },
    jobs: { prune: "Очистка истории задач" },
    candles: { archive: "Архив свечей", prune: "Чистка кэша свечей" },
    telegram: { "daily-morning": "Telegram: утренний фокус", "daily-evening": "Telegram: карточка дня", "contract-alerts": "Telegram: стоп по контракту" },
  },
  backups: {
    description: "pg_dump каждый день в 03:15 по Нью-Йорку (кэш-таблицы без данных). Хранятся 14 дневных и 8 недельных копий.",
    empty: "Бэкапов пока нет. Автобэкап — ежедневно в 03:15 по Нью-Йорку.",
    emptyAdmin: "Можно создать вручную: «Создать сейчас».",
    emptyHint: "Если список так и пуст, проверьте, что на сервере установлен pg_dump нужной версии.",
  },
} as const;
