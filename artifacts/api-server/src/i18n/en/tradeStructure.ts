import type { Messages } from "../core";
import type ru from "../ru/tradeStructure";

export default {
  role: {
    entry: "Entry",
    reentry: "Re-entry",
    flip: "Flip",
    add: "Add",
    partial_exit: "Partial exit",
    exit: "Exit",
    stop: "Stop",
  },
  reason: {
    reentryInTrade: "New entry after a full exit within the same trade",
    markedStop: "Marked as a stop",
    flipIn: "Flip: opened in the same second the opposite position closed",
    reentryN: "Re-entry #{n} in this ticker this session",
    flipOut: "Flip: the opposite position opened in the same second",
    atStop: "Exit at the stop level {price}",
    atStopFromRisk: "Exit at the stop level {price} (stop from $ risk)",
    inferredAfterAdd: "Likely a stop: a losing exit within 5 minutes after averaging against the position",
    inferredAtWorst: "Likely a stop: a losing exit near the trade's worst price ({price}, {pct}% of the drawdown given back)",
  },
  note: {
    averages: "Trade from the Trades report: only average entry and exit prices are known; separate adds and partial exits aren't visible. A Fills sync shows every fill.",
    scaledEntry: "Average entry price {price} isn't a whole cent — the entry took at least two fills at different prices (an add or a split fill).",
    scaledExit: "Average exit price {price} isn't a whole cent — the exit took at least two fills at different prices (a partial exit or a split fill).",
    carry: "Position carried over from the previous session: some entries happened before the loaded fills.",
    unknownCarry: "Some closing fills have no open position — the entry was before the loaded period.",
    noQty: "Some fills have no quantity — position and $ per leg aren't calculated.",
    split: { one: "Partial fills of one order are merged into one leg ({count} extra fill).", other: "Partial fills of one order are merged into one leg ({count} extra fills)." },
  },
  summary: {
    flip: "flip",
    reentry: "re-entry #{n}",
    adds: { one: "{count} add", other: "{count} adds" },
    scaledEntry: "scaled entry",
    partials: { one: "{count} partial exit", other: "{count} partial exits" },
    scaledExit: "scaled exit",
    stop: "stop",
    stopInferred: "stop?",
    flipOut: "→ flip",
  },
} satisfies Messages<typeof ru>;
