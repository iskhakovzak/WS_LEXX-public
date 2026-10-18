/** Server `juniorReview`: junior notes review desk — repeated-mistake categories and attention flags — lib/juniorReview.ts. FOMO stays as is. Terms: edge-tracker/src/i18n/GLOSSARY.md (mistake labels match the `trades` tag labels). */
export default {
  mistake: {
    fomo: "FOMO / погоня",
    early_entry: "Ранний вход",
    moved_stop: "Двигал стоп",
    no_stop: "Без стопа",
    overtrading: "Переторговка",
    size: "Размер больше плана",
    revenge: "Отыгрыш",
    off_plan: "Не по плану",
    early_exit: "Ранний выход",
    held_loser: "Передержал лосс",
    averaging: "Усреднение",
    daily_limit: "Нарушил лимит",
    emotions: "Эмоции / тильт",
  },
  attention: {
    waiting: "Ждёт ответа",
    unanswered: "Без ответа: {n}",
    missed: "Пропуск {n} дн. подряд",
    never: "Ещё ни одной сводки",
    low: "Низкие оценки · {score}",
    falling: "Оценки падают · {delta}",
    repeat: "Повторяет: {mistake} ×{count}",
  },
} as const;
