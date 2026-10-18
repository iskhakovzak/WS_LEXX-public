import type { Messages } from "../core";
import type ru from "../ru/events";

export default {
  earnings: {
    catalyst: "Earnings",
    company: " · {company}",
    epsEst: " · EPS est {eps}",
    headline: "Earnings {ticker} ({session})",
    eps: "EPS estimate {eps}",
    cap: "cap {cap}",
  },
} satisfies Messages<typeof ru>;
