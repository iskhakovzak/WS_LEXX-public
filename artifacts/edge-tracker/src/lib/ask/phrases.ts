// «Спроси журнал» — every human phrase the parser and the answers show, rendered in the UI language (askI18n).
// Called at parse / answer time (never at module scope), so a language switch re-renders them.
//
// Two families:
//  • display phrases — chips, subjects, answer sentences («в октябре», «после 11:00», «Лучший тикер»);
//  • query phrases (canonicalText, q.*) — question texts the app writes for the user (follow-ups, chip swaps). They
//    go back through the parser, so each language's wording must parse (tests: lib/ask/__tests__/i18n-*.test.ts).

import { askI18n } from "@/i18n/ns/ask";
import { personName } from "@/i18n";
import { fmtDate, fmtWeekday } from "@/lib/format";
import type { AskAfter, AskDim, AskFilter, AskMetric, AskNumRange, AskOutcome, AskQuery, AskSide } from "./types";

const t = askI18n.t;

/** Lower bound for open-ended ranges («до 15 октября»). */
export const BOOK_START = "2000-01-01";

const pad = (n: number) => String(n).padStart(2, "0");
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** Entry price in the trading format, short: $10, $7.50. */
export const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
export const fmtClock = (min: number) => `${Math.floor(min / 60)}:${pad(min % 60)}`;

export function fmtDuration(sec: number): string {
  if (sec < 60) return t("ph.s", { n: Math.round(sec) });
  if (sec < 3600) {
    const m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return s ? t("ph.ms", { m, s }) : t("ph.m", { n: m });
  }
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return m ? t("ph.hm", { h, m }) : t("ph.h", { h });
}

const dShort = (d: string) => fmtDate(d, "short");
const dDm = (d: string) => fmtDate(d, "dayMonthNumeric");

/** Chip range: «01.10–31.10.2026», «15.10.2026», «до 15.10.2026». */
export function fmtRange(r: { from: string; to: string }): string {
  if (r.from === r.to) return dShort(r.from);
  if (r.from <= BOOK_START) return t("ph.until", { date: dShort(r.to) });
  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
  return t("ph.span", { from: sameYear ? dDm(r.from) : dShort(r.from), to: dShort(r.to) });
}

/** «a, b и c» in the UI language. */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return t("ph.list", { list: items.slice(0, -1).join(", "), last: items[items.length - 1] });
}

// ── Periods ───────────────────────────────────────────────────────────────────

type MonthNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
export type DatePhrase =
  | { k: "today" | "yesterday" | "dayBefore" | "thisWeek" | "lastWeek" | "pastWeek" | "thisMonth" | "lastMonth" | "pastMonth" | "thisQuarter" | "lastQuarter" | "ytd" | "lastYear" | "pastYear" }
  | { k: "quarter"; q: number; y: number }
  | { k: "year"; y: number }
  | { k: "lastN"; n: number; unit: "day" | "week" | "month" }
  | { k: "month"; m: number; y?: number }
  | { k: "day"; date: string; withYear: boolean }
  | { k: "range"; from: string; to: string }
  | { k: "since"; date: string }
  | { k: "until"; date: string };

export const monthIn = (m: number) => t(`ph.monthIn.m${m as MonthNo}`);

export function datePhrase(p: DatePhrase): string {
  switch (p.k) {
    case "lastN": return t(p.unit === "week" ? "ph.lastWeeks" : p.unit === "month" ? "ph.lastMonths" : "ph.lastDays", { count: p.n });
    case "quarter": return t("ph.quarter", { q: p.q, year: p.y });
    case "year": return t("ph.year", { year: p.y });
    case "month": return p.y ? t("ph.monthYear", { monthIn: monthIn(p.m), year: p.y }) : monthIn(p.m);
    case "day": return t("ph.onDay", { date: fmtDate(p.date, p.withYear ? "long" : "dayMonthLong") });
    case "range": {
      const sameYear = p.from.slice(0, 4) === p.to.slice(0, 4);
      return t("ph.range", { from: sameYear ? dDm(p.from) : dShort(p.from), to: dShort(p.to) });
    }
    case "since": return t("ph.since", { date: dDm(p.date) });
    case "until": return t("ph.until", { date: dDm(p.date) });
    default: return t(`ph.${p.k}`);
  }
}

// ── Facets ────────────────────────────────────────────────────────────────────

export type SessionCode = "afternoon" | "premarket" | "postmarket" | "powerHour" | "firstHour" | "open" | "morning" | "lunch";
export const sessionPhrase = (code: SessionCode) => t(`ph.session.${code}`);
export const groupPhrase = (dim: AskDim) => t(`ph.group.${dim}`);
export const sideOne = (s: AskSide) => t(s === "Long" ? "ph.long" : "ph.short");
export const sidePl = (s: AskSide) => t(s === "Long" ? "ph.longs" : "ph.shorts");
const sideGen = (s: AskSide) => t(s === "Long" ? "ph.longsGen" : "ph.shortsGen");
export const outcomeAdj = (o: AskOutcome) => t(`ph.${o}`);
const outcomeGen = (o: AskOutcome) => t(`ph.${o}Gen`);
export const metricBy = (m: AskMetric) => t(`metricBy.${m}`);
export const metricName = (m: AskMetric) => t(`metricName.${m}`);

export function afterPhrase(a: AskAfter): string {
  if (a.kind === "loss") return a.n > 1 ? t("ph.afterLossN", { n: a.n }) : t("ph.afterLoss");
  return a.n > 1 ? t("ph.afterWinN", { n: a.n }) : t("ph.afterWin");
}

type WdKey = "d0" | "d1" | "d2" | "d3" | "d4";
/** «по пятницам», «по понедельникам и пятницам» (also a valid question text). */
export function weekdayPhrase(set: number[]): string {
  return t("ph.weekdays", { days: joinList(set.map((d) => t(`ph.wdPl.d${d}` as `ph.wdPl.${WdKey}`))) });
}
/** «понедельник, пятница» (0 = Monday). */
export const weekdayNames = (set: number[]) => set.map((d) => fmtWeekday((d + 1) % 7, "long")).join(", ");

export function targetTitle(kind: "best" | "worst", dim: AskDim, plural = false): string {
  return t(`target.${dim}.${plural ? (kind === "best" ? "bestPl" : "worstPl") : kind}`);
}

function holdPhrase(h: AskNumRange): string {
  if (h.min != null && h.max != null) return t("ph.holdRange", { min: fmtDuration(h.min), max: fmtDuration(h.max) });
  if (h.min != null) return t("ph.holdMin", { v: fmtDuration(h.min) });
  return t("ph.holdMax", { v: fmtDuration(h.max ?? 0) });
}
function pricePhrase(p: AskNumRange): string {
  if (p.min != null && p.max != null) return t("ph.priceRange", { min: usd(p.min), max: usd(p.max) });
  if (p.min != null) return t("ph.priceMin", { v: usd(p.min) });
  return t("ph.priceMax", { v: usd(p.max ?? 0) });
}
function qtyPhrase(p: AskNumRange): string {
  if (p.min != null && p.max != null) return t("ph.qtyRange", { min: p.min, max: p.max });
  if (p.min != null) return t("ph.qtyMin", { n: p.min });
  return t("ph.qtyMax", { n: p.max ?? 0 });
}

// ── Subjects ──────────────────────────────────────────────────────────────────

/** Context tail shared by every headline: tickers, setups, period, weekdays, time, price, hold, size, context. */
export function filterTail(q: AskFilter, opts: { tickers?: boolean } = {}): string {
  const parts: string[] = [];
  if (opts.tickers !== false && q.tickers.length) parts.push(q.tickers.join(", "));
  if (q.setups.length) parts.push(q.setups.map((s) => `«${s}»`).join(", "));
  if (q.date) parts.push(q.date.phrase);
  if (q.weekdays) parts.push(weekdayPhrase(q.weekdays));
  if (q.time) parts.push(q.time.phrase);
  if (q.price) parts.push(pricePhrase(q.price));
  if (q.holdSec) parts.push(holdPhrase(q.holdSec));
  if (q.qty) parts.push(qtyPhrase(q.qty));
  if (q.after) parts.push(afterPhrase(q.after));
  if (q.lastN) parts.push(t("ph.lastTail", { n: q.lastN }));
  return parts.join(t("subj.tailSep"));
}

const withTail = (base: string, tail: string) => (base && tail ? t("subj.withTail", { base, tail }) : base || tail);
const withTrader = (main: string, trader: string | null) => (trader ? t("subj.withTrader", { main, trader: personName(trader) }) : main);

/** Short noun phrase for the filtered set: «Шорты INTC в октябре после 11:00». */
export function describeFilter(q: AskFilter): string {
  let base: string;
  if (q.side && q.outcome) base = t("subj.sideOutcome", { outcome: cap(outcomeAdj(q.outcome)), side: sidePl(q.side) });
  else if (q.side) base = cap(sidePl(q.side));
  else if (q.outcome) base = t("subj.outcomeTrades", { outcome: cap(outcomeAdj(q.outcome)) });
  else base = t("subj.trades");
  return withTrader(withTail(base, filterTail(q)), q.trader);
}

/**
 * Human subject of the query (no numbers): «Шорты INTC в октябре после 11:00», «Лучший тикер за месяц»,
 * «Лонг vs шорт · за квартал».
 */
export function describeSubject(q: AskQuery): string {
  const sep = t("subj.tailSep");
  if (q.intent === "compare" && q.compare) {
    const head = t("subj.compare", { a: cap(q.compare.a.label), b: q.compare.b.label });
    const set = q.side && q.outcome ? t("subj.sideOutcome", { outcome: outcomeAdj(q.outcome), side: sidePl(q.side) })
      : q.side ? sidePl(q.side) : q.outcome ? outcomeAdj(q.outcome) : "";
    const base = withTail(set, filterTail(q));
    return withTrader(base ? t("subj.withBase", { head, base }) : head, q.trader);
  }
  if ((q.intent === "best" || q.intent === "worst") && q.target) {
    let among = "";
    if (q.outcome && q.side) among = t("subj.amongSideOutcome", { outcome: outcomeGen(q.outcome), side: sideGen(q.side) });
    else if (q.side) among = t("subj.amongSide", { side: sideGen(q.side) });
    else if (q.outcome) among = t("subj.amongOutcome", { outcome: outcomeGen(q.outcome) });
    const tail = [among, filterTail(q)].filter(Boolean).join(sep);
    return withTrader(withTail(targetTitle(q.intent, q.target, q.topN > 1), tail), q.trader);
  }
  if (q.intent === "insight") {
    const head = q.insight === "worst" ? t("subj.insightWorst") : t("subj.insightBest");
    const tail = [q.side ? `(${sidePl(q.side)})` : "", filterTail(q)].filter(Boolean).join(sep);
    return withTrader(withTail(head, tail), q.trader);
  }
  if (q.intent === "streak") {
    const head = q.streak?.kind === "loss" ? t("subj.streakLoss") : q.streak?.kind === "win" ? t("subj.streakWin") : t("subj.streak");
    return withTrader(withTail(head, filterTail(q)), q.trader);
  }
  return describeFilter(q);
}

// ── Question texts (round-trip through the parser) ────────────────────────────

function durationQuery(sec: number): string {
  if (sec % 3600 === 0) return t("q.hours", { count: sec / 3600 });
  if (sec % 60 === 0) return t("q.minutes", { count: sec / 60 });
  return t("q.seconds", { count: sec });
}

/** A question text in the UI language that parses back to the same filter. */
export function canonicalText(f: AskFilter, opts: { allTraders?: boolean } = {}): string {
  const p: string[] = [];
  if (f.side) p.push(sidePl(f.side));
  if (f.outcome) p.push(t(`q.${f.outcome}`));
  if (f.tickers.length) p.push(f.tickers.join(" "));
  for (const s of f.setups) p.push(t("q.setup", { name: s }));
  if (f.date) p.push(f.date.from === f.date.to ? f.date.from : t("q.isoRange", { from: f.date.from, to: f.date.to }));
  if (f.weekdays) p.push(weekdayPhrase(f.weekdays));
  if (f.time) {
    const { fromMin: a, toMin: b } = f.time;
    if (a != null && b != null) p.push(t("q.timeRange", { from: fmtClock(a), to: fmtClock(b) }));
    else if (a != null) p.push(t("q.timeAfter", { t: fmtClock(a) }));
    else if (b != null) p.push(t("q.timeBefore", { t: fmtClock(b) }));
  }
  if (f.price) {
    const { min, max } = f.price;
    if (min != null && max != null) p.push(t("q.priceRange", { min, max }));
    else if (min != null) p.push(t("q.priceMin", { v: min }));
    else if (max != null) p.push(t("q.priceMax", { v: max }));
  }
  if (f.holdSec) {
    const { min, max } = f.holdSec;
    if (min != null) p.push(t("q.holdMin", { d: durationQuery(min) }));
    if (max != null) p.push(t("q.holdMax", { d: durationQuery(max) }));
  }
  if (f.qty) {
    const { min, max } = f.qty;
    if (min != null && max != null) p.push(t("q.qtyRange", { min, max }));
    else if (min != null) p.push(t("q.qtyMin", { n: min }));
    else if (max != null) p.push(t("q.qtyMax", { n: max }));
  }
  if (f.after) p.push(afterPhrase(f.after));
  if (f.lastN) p.push(t("q.lastN", { n: f.lastN }));
  if (f.trader) p.push(personName(f.trader));
  else if (opts.allTraders) p.push(t("q.desk"));
  return p.join(" ");
}
