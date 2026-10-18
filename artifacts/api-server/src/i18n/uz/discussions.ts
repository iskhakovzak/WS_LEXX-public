import type { Messages } from "../core";
import type ru from "../ru/discussions";

export default {
  audience: {
    all: "Hammaga",
    trainee: "Stajyorlarga",
    junior: "Juniorlarga",
    trader: "Treyderlarga",
    senior: "Seniorlarga",
    staff: "Kuratorlarga",
    cohort: "Guruh #{id}",
  },
  notify: {
    quote: "«{text}»",
    reviewRequest: "{author} tahlil soʻramoqda",
    reviewRequestTicker: "{author} {ticker} boʻyicha tahlil soʻramoqda",
    threadNew: "{author}: yangi mavzu",
    threadNewTicker: "{author}: yangi mavzu {ticker}",
    audienceSuffix: " · {label}",
    accepted: "Javobingiz yechim deb belgilandi · {actor}",
    replyToYou: "{actor}: «{topic}»da sizga javob",
    replyInYours: "{actor}: «{topic}» muhokamangizda yangi javob",
  },
} satisfies Messages<typeof ru>;
