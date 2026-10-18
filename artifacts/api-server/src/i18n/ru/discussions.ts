/** Server `discussions`: audience labels and discussion notifications (review_request, thread_new, reply), rendered per reader in lib/notificationRenderers/discussions.ts. Topics, names and comment previews are user content. Terms: edge-tracker/src/i18n/GLOSSARY.md. */
export default {
  audience: {
    all: "Всем",
    trainee: "Стажёрам",
    junior: "Джунам",
    trader: "Трейдерам",
    senior: "Сеньорам",
    staff: "Кураторам",
    cohort: "Когорта #{id}",
  },
  notify: {
    quote: "«{text}»",
    reviewRequest: "{author} просит разбор",
    reviewRequestTicker: "{author} просит разбор {ticker}",
    threadNew: "{author}: новая тема",
    threadNewTicker: "{author}: новая тема {ticker}",
    audienceSuffix: " · {label}",
    accepted: "Ваш ответ отмечен как решение · {actor}",
    replyToYou: "{actor}: ответ вам в «{topic}»",
    replyInYours: "{actor}: новый ответ в вашем обсуждении «{topic}»",
  },
} as const;
