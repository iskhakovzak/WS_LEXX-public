import type { Messages } from "../core";
import type ru from "../ru/discussions";

export default {
  audience: {
    all: "Everyone",
    trainee: "Interns",
    junior: "Juniors",
    trader: "Traders",
    senior: "Seniors",
    staff: "Curators",
    cohort: "Cohort #{id}",
  },
  notify: {
    quote: "“{text}”",
    reviewRequest: "{author} asks for a review",
    reviewRequestTicker: "{author} asks for a review of {ticker}",
    threadNew: "{author}: new topic",
    threadNewTicker: "{author}: new topic {ticker}",
    audienceSuffix: " · {label}",
    accepted: "Your reply was marked as the solution · {actor}",
    replyToYou: "{actor}: reply to you in “{topic}”",
    replyInYours: "{actor}: new reply in your discussion “{topic}”",
  },
} satisfies Messages<typeof ru>;
