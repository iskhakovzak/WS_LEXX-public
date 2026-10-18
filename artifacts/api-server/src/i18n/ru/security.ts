/** Server `security`: sign-in, secrets policy, request limits, error-tracking alerts. Terms: edge-tracker/src/i18n/GLOSSARY.md. */
export default {
  login: {
    invalid: "Неверное имя или PIN",
    locked: "Слишком много неудачных попыток. Вход временно заблокирован",
    rateLimited: "Слишком много попыток входа, попробуйте позже",
    banned: "Доступ заблокирован. Обратитесь к куратору",
  },
  password: {
    changeRequired: "Сначала задайте новый пароль",
    tooShort: "Не короче {min} символов",
    tooLong: "Не длиннее {max} символов",
    sameAsOld: "Новый пароль должен отличаться от текущего",
    sameAsName: "Пароль не должен совпадать с именем",
    currentWrong: "Текущий пароль неверен",
    required: "Укажите текущий и новый пароль",
    tooManyAttempts: "Слишком много попыток, попробуйте позже",
  },
  body: {
    tooManyRequests: "Слишком много запросов, попробуйте позже",
    tooLarge: "Слишком большой запрос (больше {limit})",
  },
  alert: {
    title: "WS_LEXX: новая ошибка на сервере",
    titleClient: "WS_LEXX: новая ошибка в приложении",
    route: "Маршрут: {route}",
    count: "Повторов: {count}",
    open: "Открыть: {url}",
  },
} as const;
