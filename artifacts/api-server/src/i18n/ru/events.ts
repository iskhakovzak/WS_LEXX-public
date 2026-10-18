/** Server `events`: generated texts of market events — earnings catalysts and the earnings import (headline / summary are written in the language of the curator who runs the import) — routes/events.ts. EPS, BMO/AMC stay as is. */
export default {
  earnings: {
    catalyst: "Отчёт",
    company: " · {company}",
    epsEst: " · EPS est {eps}",
    headline: "Отчёт {ticker} ({session})",
    eps: "прогноз EPS {eps}",
    cap: "кап. {cap}",
  },
} as const;
