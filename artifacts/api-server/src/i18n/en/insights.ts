import type { Messages } from "../core";
import type ru from "../ru/insights";

export default {
  rule: {
    OPG: "Entry in the premarket or at the opening auction (before 09:31), exit before 10:00",
    OPGtoDAY: "Entry at the open (premarket / auction before 09:31), position held into the day — exit after 10:00",
    Day: "Intraday trade: entry after 09:31 and before 15:50, exit before the closing auction",
    MOC: "Closing auction: entry after the imbalances are published (from 15:50) or exit in the 15:59:30–16:01 auction",
    AfterMarket: "After-hours: entry after 16:00 or exit of an intraday position after 16:01",
    Overnight: "Position carried through the session close (exit the next day or later)",
    OPT: "Options: contract symbol in OCC format (e.g. AAPL261016C00230000)",
  },
  order: "OPT → Overnight → AfterMarket (entry) → OPG / OPGtoDAY → MOC → AfterMarket (exit) → Day",
  note: {
    time: "Time is New York time, by the trade's first entry and last exit.",
    result: "The day result is net (after fees) by the trade's close date.",
    pct: "% = net ÷ the office's yearly capital set by the partners.",
    volume: "Volume is the number of shares / contracts across all fills.",
  },
  bucket: {
    pre: "Premarket",
    post: "After-hours",
  },
  insight: {
    eff: "{strategy} brings {net} of the result with {volume} of the volume",
    drag: "{strategy} is negative ({value}) with {volume} of the office volume",
    negMonths: { one: "{strategy} negative for {count} month in a row", other: "{strategy} negative for {count} months in a row" },
    goalDone: "The {year} goal ({goal}) is already reached: {value}",
    goalAhead: "The office is ahead of the {goal} goal pace by {value}",
    goalBehind: "{need} a month is needed to reach {goal} — behind the pace by {gap}",
    greenStreak: { one: "{count} green day in a row", other: "{count} green days in a row" },
    redStreak: { one: "{count} red day in a row", other: "{count} red days in a row" },
    drawdown: { one: "The office has been {value} below the peak for {count} trading day", other: "The office has been {value} below the peak for {count} trading days" },
    bestTime: "Best entry time — {bucket}: {share} of the profit",
    ticker: "{ticker} — {share} of the period's profit",
    yoy: "By this day in {prevYear}: {was}; in {year}: {now}",
    bestMonth: "Best month of {year} — {month}: {value}",
  },
} satisfies Messages<typeof ru>;
