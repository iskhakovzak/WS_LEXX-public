/**
 * Author notes — pure helpers for writing speed and follow-through (unit-tested in author-plan.test.ts):
 *   - the previous note's «План на завтра» and how today's trades followed it («План vs факт»);
 *   - ticker detection ($TSLA mentions → chips, plan tickers → traded / not traded);
 *   - $ amounts in the text (the whole team reads the note — juniors should see R, not money);
 *   - feed search over text, author and the day's tickers.
 * Nothing here talks to the server or to AI.
 */
import { SECTIONS, parseNote, type AuthorNote, type DayTrade, type SectionKey } from "./author-model";
import { fmtDate, fmtR } from "@/lib/format";
import { notesI18n } from "@/i18n/ns/notes";
import { personName } from "@/i18n";

/* ───────────────────────── Previous plan ───────────────────────── */

export type PrevPlan = { date: string; hold: string; open: string };

/** Most recent earlier note (within `maxBackDays`) whose plan blocks have text. */
export function findPrevPlan(notes: AuthorNote[], date: string, maxBackDays = 10): PrevPlan | null {
  const floor = shiftIso(date, -maxBackDays);
  const sorted = notes
    .filter((n) => {
      const d = n.note_date.slice(0, 10);
      return d < date && d >= floor;
    })
    .sort((a, b) => (a.note_date < b.note_date ? 1 : -1));
  for (const n of sorted) {
    const p = parseNote(n.raw_text || "");
    if (!p.structured) continue;
    const hold = p.sections.hold.trim();
    const open = p.sections.open.trim();
    if (hold || open) return { date: n.note_date.slice(0, 10), hold, open };
  }
  return null;
}

function shiftIso(date: string, days: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Meaningful plan lines: bullets stripped, empty template prompts («Ключевые уровни: ») dropped. */
export function planLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim().replace(/^(?:[•\-*–—]|\d+[.)])\s*/, "").trim())
    .filter((l) => l && !/^[^:]{1,60}:\s*$/.test(l));
}

/* ───────────────────────── Tickers ───────────────────────── */

// Latin all-caps words that are trading jargon, not symbols. Cyrillic text never matches, so the list stays short.
const NOT_TICKERS = new Set([
  "VWAP", "ATR", "ORB", "RVOL", "EMA", "SMA", "HOD", "LOD", "PM", "AH", "ER", "FOMC", "CPI", "PPI", "PCE", "NFP",
  "FED", "NY", "ET", "BP", "PNL", "AI", "OK", "SL", "TP", "RR", "ETF", "IPO", "CEO", "EPS", "MA", "USD", "EOD",
  "ATH", "ATL", "PDH", "PDL", "HTF", "LTF", "OTC", "SSR", "BE", "TA", "FA", "MACD", "RSI", "GDP", "PR", "QE",
]);

const DOLLAR_TICKER_RE = /\$([A-Z]{1,5}(?:\.[A-Z])?)(?![A-Za-z])/g;
const CAPS_WORD_RE = /(?<![A-Za-z$])([A-Z]{2,5}(?:\.[A-Z])?)(?![A-Za-z])/g;

/** Tickers mentioned in a text: every `$TSLA`, plus bare all-caps 2–5 letter words that are not jargon. */
export function extractTickers(text: string): string[] {
  const out: string[] = [];
  const add = (t: string) => { if (!out.includes(t)) out.push(t); };
  for (const m of text.matchAll(DOLLAR_TICKER_RE)) add(m[1]!);
  for (const m of text.matchAll(CAPS_WORD_RE)) if (!NOT_TICKERS.has(m[1]!)) add(m[1]!);
  return out;
}

export type TextPart = { text: string; ticker?: string };

/** Splits text into plain runs and explicit `$TICKER` mentions (rendered as chips by the reader). */
export function splitTickers(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(DOLLAR_TICKER_RE)) {
    const i = m.index ?? 0;
    if (i > last) parts.push({ text: text.slice(last, i) });
    parts.push({ text: m[0], ticker: m[1]! });
    last = i + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/* ───────────────────────── План vs факт ───────────────────────── */

export type FollowItem = {
  line: string;
  tickers: string[];
  /** Plan tickers that were traded on the day, with Σ signed R (null when no R yet / still open). */
  traded: { ticker: string; r: number | null }[];
  status: "traded" | "missed" | "none";
};

type TradeLike = Pick<DayTrade, "ticker" | "rSigned" | "rMultiple">;

export function followThrough(lines: string[], trades: TradeLike[]): FollowItem[] {
  const byTicker = new Map<string, number | null>();
  for (const t of trades) {
    const tk = t.ticker.trim().toUpperCase();
    const r = t.rSigned ?? null;
    const prev = byTicker.get(tk);
    byTicker.set(tk, prev == null ? r : r == null ? prev : prev + r);
  }
  return lines.map((line) => {
    const tickers = extractTickers(line);
    const traded = tickers.filter((t) => byTicker.has(t)).map((t) => ({ ticker: t, r: byTicker.get(t) ?? null }));
    return { line, tickers, traded, status: !tickers.length ? "none" : traded.length ? "traded" : "missed" };
  });
}

/** «План vs факт» in the UI language (inserted into the author's text). */
export function followHeader(): string {
  return notesI18n.t("author.follow.header");
}
const FOLLOW_HEADER_RU = "План vs факт"; // i18n-ignore (detects a block written while the UI was in RU)
/** True when the lessons text already has a «План vs факт» block (RU or the current UI language). */
export function hasFollowBlock(text: string): boolean {
  return text.includes(followHeader()) || text.includes(FOLLOW_HEADER_RU);
}

/** Block for «Уроки»: one line per plan item with what actually happened; R only — the note is read by the team. */
export function followThroughBlock(prevDate: string, items: FollowItem[]): string {
  const rows = items.map((it) => {
    const fact =
      it.status === "traded"
        ? notesI18n.t("author.follow.traded", { list: it.traded.map((t) => (t.r != null ? `${t.ticker} ${fmtR(t.r, 1)}` : t.ticker)).join(", ") })
        : it.status === "missed"
          ? notesI18n.t("author.follow.missed")
          : "";
    return `• ${it.line} → ${fact}`;
  });
  return `${notesI18n.t("author.follow.block", { header: followHeader(), date: fmtDate(prevDate, "dayMonth") })}\n${rows.join("\n")}`;
}

/* ───────────────────────── Money in text ───────────────────────── */

const MONEY_RE = /(?:[+\-−]?\$\s?\d[\d\s,.]*k?)|(?:\b\d[\d,.]*\s?(?:\$|usd\b|долл|бакс))/gi;

/** `$ amounts` written in the note («+$1,200», «300$», «500 долларов»); `$TSLA` is a ticker, not money. */
export function moneyMentions(text: string): string[] {
  return Array.from(text.matchAll(MONEY_RE), (m) => m[0].trim());
}

/* ───────────────────────── Feed search ───────────────────────── */

export type Searchable = { trader: string; raw_text: string; refined_text: string | null; day?: { tickers: string[] } | null };

/** Case-insensitive match over author, text, AI text and the day's tickers; a leading `$` is ignored. */
export function matchesSearch(n: Searchable, query: string): boolean {
  const q = query.trim().replace(/^\$/, "").toLowerCase();
  if (!q) return true;
  return (
    n.trader.toLowerCase().includes(q) ||
    personName(n.trader).toLowerCase().includes(q) ||
    (n.raw_text ?? "").toLowerCase().includes(q) ||
    (n.refined_text ?? "").toLowerCase().includes(q) ||
    !!n.day?.tickers.some((t) => t.toLowerCase() === q)
  );
}

/* ───────────────────────── Section shortcuts ───────────────────────── */

/** Alt+1…7 → section key in editor order. */
export function sectionForDigit(d: number): SectionKey | null {
  return SECTIONS[d - 1]?.key ?? null;
}
