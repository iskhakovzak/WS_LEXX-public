/** Server `common`: generic API messages (errors shown in toasts, shared labels). Terms: edge-tracker/src/i18n/GLOSSARY.md. */
export default {
  errors: {
    authRequired: "Требуется вход",
    guestReadOnly: "Гостевой режим: только просмотр",
    forbidden: "Недостаточно прав для этого действия",
    notFound: "Не найдено",
    validation: "Некорректный запрос",
    invalidJson: "Некорректный JSON в теле запроса",
    internal: "Внутренняя ошибка сервера",
    rateLimited: "Слишком много запросов, попробуйте позже",
    loginRateLimited: "Слишком много попыток входа, попробуйте позже",
    invalidCredentials: "Неверное имя или пароль",
    banned: "Доступ заблокирован. Обратитесь к куратору",
    invalidLocale: "Неизвестный язык: {value}",
  },
  roles: {
    trader: "Трейдер",
    curator: "Куратор",
    admin: "Администратор",
    guest: "Гость",
  },
  units: {
    trades: { one: "{count} сделка", few: "{count} сделки", many: "{count} сделок", other: "{count} сделки" },
    days: { one: "{count} день", few: "{count} дня", many: "{count} дней", other: "{count} дня" },
  },
} as const;
