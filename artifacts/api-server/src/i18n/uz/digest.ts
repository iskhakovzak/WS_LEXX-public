import type { Messages } from "../core";
import type ru from "../ru/digest";

export default {
  morning: "ERTALABKI",
  evening: "KECHKI",
  title: "{period} DAYJEST",
  brief: "ERTALABKI BRIF",
  briefHtml: "Ertalabki brif",
  macro: "MAKRO",
  macroHtml: "Makro",
  sectors: "SEKTORLAR",
  sectorsHtml: "Sektorlar",
  feed: "KUNLIK LENTA",
  feedHtml: "Kunlik lenta",
  theme: "Mavzu",
  tickers: "Tikerlar",
  works: "Nima ishlayapti",
  notes: "Qaydlar",
  trades: "{hours} SOATDAGI SAVDOLAR",
  tradesHtml: "{hours} soatdagi savdolar",
  noTrades: "Bu davrda savdolar topilmadi",
  grade: "Baho",
  subject: "Edge Tracker | Dayjest {date} — {trader}",
} satisfies Messages<typeof ru>;
