import type { Messages } from "../core";
import type ru from "../ru/events";

export default {
  earnings: {
    catalyst: "Hisobot",
    company: " · {company}",
    epsEst: " · EPS est {eps}",
    headline: "{ticker} hisoboti ({session})",
    eps: "EPS prognozi {eps}",
    cap: "kap. {cap}",
  },
} satisfies Messages<typeof ru>;
