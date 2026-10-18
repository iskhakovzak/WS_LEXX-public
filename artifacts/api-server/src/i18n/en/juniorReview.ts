import type { Messages } from "../core";
import type ru from "../ru/juniorReview";

export default {
  mistake: {
    fomo: "FOMO / chasing",
    early_entry: "Early entry",
    moved_stop: "Moved stop",
    no_stop: "No stop",
    overtrading: "Overtrading",
    size: "Size above plan",
    revenge: "Revenge",
    off_plan: "Off plan",
    early_exit: "Early exit",
    held_loser: "Held a loser",
    averaging: "Averaging down",
    daily_limit: "Broke the limit",
    emotions: "Emotions / tilt",
  },
  attention: {
    waiting: "Awaiting reply",
    unanswered: "No reply: {n}",
    missed: "Missed {n} days in a row",
    never: "No notes yet",
    low: "Low scores · {score}",
    falling: "Scores falling · {delta}",
    repeat: "Repeats: {mistake} ×{count}",
  },
} satisfies Messages<typeof ru>;
