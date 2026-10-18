/** Server `admin`: texts of the admin panel API (moderation, users, admin console, error log). Terms: edge-tracker/src/i18n/GLOSSARY.md. */
export default {
  reports: {
    authorBanned: "Автор забанен: {reason}",
  },
  health: {
    syncRun: "Синк #{id} ({source}): {status}",
    syncErrors: ", ошибок {count}",
    sourceFile: "файл",
    scheduler: "Планировщик: {error}",
  },
  quality: {
    no_trader: {
      label: "Сделки без трейдера",
      hint: "Сделка не попадёт ни в чей журнал и статистику. Привяжите счёт к трейдеру во вкладке «Интеграции → Счета».",
    },
    unknown_trader: {
      label: "Трейдер не найден среди пользователей",
      hint: "Имя в сделке не совпадает ни с одной учёткой (переименование или опечатка в привязке счёта).",
    },
    unmapped_account: {
      label: "Сделки со счетов без привязки",
      hint: "Счёт брокера есть в сделках, но не привязан к трейдеру.",
    },
    duplicates: {
      label: "Возможные дубликаты",
      hint: "Одинаковые трейдер, тикер, дата, сторона, вход, выход и P&L. Разберите в «Интеграции → Сверка».",
    },
    ny_date_mismatch: {
      label: "Дата сделки ≠ дата открытия (NY)",
      hint: "Торговая дата должна совпадать с датой открытия по Нью-Йорку. Обычно это ручная правка или старый импорт.",
    },
    weekend: {
      label: "Сделки в выходные",
      hint: "Рынок США закрыт в субботу и воскресенье — вероятно, дата записана не по NY.",
    },
    future: {
      label: "Сделки с датой в будущем",
      hint: "Сегодня по NY: {today}.",
    },
    exit_before_entry: {
      label: "Дата выхода раньше даты входа",
      hint: "Проверьте exit_date у многодневных сделок.",
    },
    pending_reconcile: {
      label: "Ждут сверки",
      hint: "Сделки брокера, совпавшие с ручными — решите в «Интеграции → Сверка».",
    },
    legacy_no_id: {
      label: "Старый импорт без ID брокера",
      hint: "Получат ID при следующем импорте того же периода.",
    },
  },
} as const;
