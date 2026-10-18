import type { Messages } from "../core";
import type ru from "../ru/marketbrief";

export default {
  lookback: {
    weekend: "Over the weekend (Fri–Sun)",
    friday: "For Friday",
    lastDay: "For the last day",
  },
} satisfies Messages<typeof ru>;
