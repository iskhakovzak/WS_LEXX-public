import type { Messages } from "../core";
import type ru from "../ru/digest";

export default {
  morning: "MORNING",
  evening: "EVENING",
  title: "{period} DIGEST",
  brief: "MORNING BRIEF",
  briefHtml: "Morning brief",
  macro: "MACRO",
  macroHtml: "Macro",
  sectors: "SECTORS",
  sectorsHtml: "Sectors",
  feed: "DAILY FEED",
  feedHtml: "Daily feed",
  theme: "Theme",
  tickers: "Tickers",
  works: "What works",
  notes: "Notes",
  trades: "TRADES IN {hours}H",
  tradesHtml: "Trades in {hours}h",
  noTrades: "No trades in this period",
  grade: "Grade",
  subject: "Edge Tracker | Digest {date} — {trader}",
} satisfies Messages<typeof ru>;
