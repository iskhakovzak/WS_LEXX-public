// «Спроси журнал» — deterministic question parser for RU, EN and UZ (Latin) (no AI / LLM, no React).
//
// A phrase like «шорты INTC в октябре после 11:00» / «INTC shorts in October after 11:00» /
// «INTC shortlar oktabrda 11:00 dan keyin» becomes a structured AskQuery: filters (trader, tickers, setups, side,
// result, NY date range, ET entry-time window, weekdays, entry price, hold time, size, «после убытка», «последние N
// сделок»), an intent (list | count | sum | avg | winrate | fees | pf | hold | size | drawdown | best | worst |
// compare | streak | insight), a group-by dimension, a metric and top-N.
//
// Pipeline:
//   1. prepare(): lowercase, ё→е, punctuation → spaces, Uzbek apostrophes dropped, number words → digits, wrong
//      keyboard layout and typo correction. Every prepared char remembers its span in the user's text.
//   2. Rules (./rules-ru, ./rules-en, ./rules-uz + the language-neutral ones below) run stage by stage (./kit STAGES);
//      inside a stage RU → EN → UZ → neutral. Each accepted match masks its span, so later (looser) rules never
//      re-read it. Accepted matches become AskTokens («понял как» chips) with the span in the ORIGINAL text — a chip
//      can be removed / replaced in place (textWithoutToken / replaceToken). Every language always runs: mixed
//      questions («winrate за сентябрь») work, and no language detection can guess wrong.
//   3. Leftovers: trader names, known setups, Latin tickers, noise words; anything else → `unknown`.
//   4. Resolution: two values of one facet + «vs / сравни / или» ⇒ comparison; intent precedence; defaults.
// Chips and phrases are rendered in the UI language (./phrases) at parse time.
//
// Dates are computed from the NY trading date passed in ctx.today (nyDate() from @/lib/trading-date).

import { mapSpan, prepare, } from "./prepare";
import {
  L, R, emptyDraft, fx, normWord, re, ruleBook, STAGES, toNum, validYmd, partsOf, ymd, resolveYear, clock,
  type Draft, type Rule, type RuleSet, type State,
} from "./kit";
import { addRuRules, latinNames, RU_NAME_PREFIX, RU_NAME_SUFFIX, RU_NOISE } from "./rules-ru";
import { addEnRules, EN_NAME_PREFIX, EN_NOISE } from "./rules-en";
import { addUzRules, UZ_NAME_PREFIX, UZ_NAME_SUFFIX, UZ_NOISE, UZ_TICKER_SUFFIX } from "./rules-uz";
import {
  fmtClock, joinList, metricBy, outcomeAdj, sideOne, targetTitle, weekdayNames,
} from "./phrases";
import { askI18n } from "@/i18n/ns/ask";
import { personName } from "@/i18n";
import { latinNameOf } from "@/lib/people/latin-names";

export type { AskAfter, AskCompare, AskCompareDim, AskCompareSide, AskDateRange, AskDim, AskFilter, AskIntent, AskMetric, AskNumRange, AskOutcome, AskQuery, AskSide, AskTimeRange, AskToken, AskTokenKind, ParseContext } from "./types";
import type { AskCompare, AskCompareSide, AskDateRange, AskDim, AskFilter, AskIntent, AskMetric, AskQuery, AskSide, AskTimeRange, AskToken, ParseContext } from "./types";

export { BOOK_START, weekdayOf } from "./kit";
export {
  afterPhrase, describeFilter, describeSubject, filterTail, fmtClock, fmtDuration, fmtRange, metricBy, metricName, targetTitle,
  weekdayPhrase,
} from "./phrases";

// ── Rule runner ───────────────────────────────────────────────────────────────

function mask(st: State, start: number, end: number) {
  st.s = st.s.slice(0, start) + " ".repeat(end - start) + st.s.slice(end);
}

function runRule(st: State, rule: Rule) {
  rule.re.lastIndex = 0;
  const found: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = rule.re.exec(st.s))) {
    if (m[0] === "") { rule.re.lastIndex++; continue; }
    found.push(m);
  }
  for (const mm of found) {
    // Skip if an earlier match of this same rule already masked part of the span.
    if (st.s.slice(mm.index, mm.index + mm[0].length) !== mm[0]) continue;
    const res = rule.fn(mm, st);
    if (res === false) continue;
    const start = mm.index, end = mm.index + mm[0].length;
    if (res) {
      const [os, oe] = mapSpan(st.prep, start, end);
      st.tokens.push({ ...res, key: `${res.kind}:${os}`, text: st.orig.slice(os, oe).trim(), start: os, end: oe });
    }
    mask(st, start, end);
  }
}

/** Language-neutral rules: digits, «$», «vs», ISO dates, clock ranges. */
function addNeutralRules(b: ReturnType<typeof ruleBook>) {
  b.push("price", /([<>])\s*\$\s*(\d+(?:[.,]\d+)?)|([<>])\s*(\d+(?:[.,]\d+)?)\s*\$/gu, (m, st) =>
    fx.priceBound(st, (m[1] ?? m[3]) === "<" ? "max" : "min", toNum(m[2] ?? m[4])));
  b.add("dates", "(\\d{4}-\\d{2}-\\d{2})\\s*[-–]\\s*(\\d{4}-\\d{2}-\\d{2})", (m, st) => {
    const [a, c] = [m[1], m[2]].map(partsOf);
    return validYmd(...a) && validYmd(...c) ? fx.span(st, m[1], m[2]) : false;
  });
  b.add("dateTail", "(\\d{4}-\\d{2}-\\d{2})", (m, st) => (validYmd(...partsOf(m[1])) ? fx.day(st, m[1]) : false));
  b.add("dateTail", "(20\\d{2})", (m, st) => fx.year(st, Number(m[1])));
  b.push("time", new RegExp(`${L}(\\d{1,2})[:.](\\d{2})\\s*[-–]\\s*(\\d{1,2})[:.](\\d{2})${R}`, "gu"), (m, st) =>
    fx.timeRange(st, clock(m[1], m[2]), clock(m[3], m[4])));
  // Numeric dates «15.10», «15.10.2026» (after time so «10.30» as a clock never lands here first).
  b.push("numDate", new RegExp(`${L}(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{2,4}))?${R}(?!\\s*\\$)`, "gu"), (m, st) => {
    const d = Number(m[1]), mo = Number(m[2]);
    let y = m[3] ? Number(m[3]) : resolveYear(mo, st.today);
    if (y < 100) y += 2000;
    return validYmd(y, mo, d) ? fx.day(st, ymd(y, mo, d)) : false;
  });
  b.add("intents", "vs\\.?", (_m, st) => fx.strongCompare(st));
}

function buildRules(): Rule[] {
  const b = ruleBook();
  addRuRules(b);
  addEnRules(b);
  addUzRules(b);
  addNeutralRules(b);
  const set: RuleSet = b.set;
  return STAGES.flatMap((s) => set[s]);
}

const RULES = buildRules();

// ── Leftovers: trader names, setups, tickers, noise ───────────────────────────

const NOISE = new Set([...RU_NOISE, ...EN_NOISE, ...UZ_NOISE, "-", "—", "–", ":"]);

/** Latin words that are vocabulary, never tickers (even typed in capitals). */
const NOT_TICKERS = new Set([
  "long", "short", "vs", "ytd", "mtd", "qtd", "net", "pnl", "wr", "am", "pm", "top", "best", "worst", "fee", "fees", "s", "m", "h",
  "min", "sec", "usd", "win", "wins", "loss", "trades", "trade", "pf", "dd", "desk", "setup", "setups", "vs.",
]);

/** Latin words the EN / UZ rules use (from the rule sources) + noise: never typo-«fixed», and the typo targets. */
const LATIN_KNOWN: ReadonlySet<string> = new Set([
  ...RULES.flatMap((r) => r.re.source.match(/[a-z]{3,}/g) ?? []), ...EN_NOISE, ...UZ_NOISE, ...NOT_TICKERS,
  // Whole words the sources only hold as stems or with quantifiers («winrates?», «komissiya\p{L}*»).
  "winrate", "commission", "commissions", "average", "drawdown", "streak", "losing", "winning", "morning", "afternoon",
  "yesterday", "komissiya", "komissiyalar", "ortacha", "seriya", "seriyasi", "savdolar", "pasayish",
]);

const NAME_PREFIX = `${RU_NAME_PREFIX}|${EN_NAME_PREFIX}|${UZ_NAME_PREFIX}`;
const NAME_SUFFIX = `(?:${RU_NAME_SUFFIX}|${UZ_NAME_SUFFIX}|s)?`;

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchTraders(st: State) {
  const names = [...st.traders].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const name of names) {
    // The Latin display name too (users.name_latin): follow-up questions are written with personName in EN / UZ.
    const latin = latinNameOf(name);
    const forms = [...new Set([normWord(name), ...latinNames(normWord(name)), ...(latin ? [normWord(latin)] : [])])].filter((n) => n.length >= 2);
    for (const n of forms) {
      runRule(st, {
        re: re(`(?:${NAME_PREFIX})?${escapeRe(n)}${NAME_SUFFIX}`),
        fn: (_m, s) => {
          if (s.d.traders.includes(name)) return null;
          s.d.traders.push(name);
          return { kind: "trader", label: askI18n.t("tok.trader", { name: personName(name) }), phrase: name };
        },
      });
    }
  }
}

function matchSetups(st: State) {
  const names = [...st.setups].filter((s) => s && s.length >= 3).sort((a, b) => b.length - a.length);
  for (const name of names) {
    runRule(st, {
      re: re(escapeRe(normWord(name)).replace(/\s+/g, "\\s+")),
      fn: (_m, s) => {
        if (s.d.setups.includes(name)) return null;
        s.d.setups.push(name);
        return { kind: "setup", label: askI18n.t("tok.setup", { name }), phrase: askI18n.t("ph.setup", { name }) };
      },
    });
  }
}

/**
 * Latin words left over are tickers: «$aapl», «INTC», a ticker from the book, or — in a question that has Cyrillic
 * words or is one word — any short Latin word. In an all-Latin question (EN / UZ) a lowercase word that is not a
 * known ticker stays unknown («hello» is not a ticker). Uzbek case endings after a ticker are allowed («INTCda»).
 */
function matchTickers(st: State, known: ReadonlySet<string>) {
  const words = st.prep.text.match(/[\p{L}\p{N}$]+/gu) ?? [];
  const strict = !/\p{Script=Cyrillic}/u.test(st.prep.text) && words.length >= 2;
  runRule(st, {
    re: new RegExp(`${L}(\\$)?([a-z]{1,5}(?:\\.[a-z]{1,2})?)(${UZ_TICKER_SUFFIX})?${R}`, "gu"),
    fn: (m, s) => {
      const w = m[2];
      if (NOT_TICKERS.has(w)) return false;
      const at = m.index + (m[1] ? 1 : 0);
      const [os, oe] = mapSpan(s.prep, at, at + w.length);
      const upper = /^[A-Z]{1,5}(?:\.[A-Z]{1,2})?$/.test(s.orig.slice(os, oe).replace(/^\$/, ""));
      const t = w.toUpperCase();
      const isKnown = known.has(t);
      if (!m[1] && NOISE.has(w) && !(upper && isKnown)) return false;
      if (m[3] && !upper && !isKnown) return false;
      if (strict && !m[1] && !upper && !isKnown) return false;
      if (s.d.tickers.includes(t)) return null;
      s.d.tickers.push(t);
      return { kind: "ticker", label: askI18n.t("tok.ticker", { ticker: t }), phrase: t };
    },
  });
}

function collectUnknown(st: State): string[] {
  const out: string[] = [];
  const wordRe = /[^\s]+/gu;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(st.s))) {
    const w = m[0].replace(/^[.:\-–—/&]+|[.:\-–—/&]+$/g, "");
    if (!w || NOISE.has(w) || NOT_TICKERS.has(w)) continue;
    const [os, oe] = mapSpan(st.prep, m.index, m.index + m[0].length);
    const origWord = st.orig.slice(os, oe).replace(/^[.:\-–—/,]+|[.:\-–—/,]+$/g, "");
    out.push(origWord || w);
  }
  return out;
}

// ── Resolution ────────────────────────────────────────────────────────────────

const METRIC_OF: Record<string, AskMetric> = { winrate: "winRate", fees: "fees", count: "n", avg: "avg", pf: "pf" };

function boundingDate(ds: AskDateRange[]): AskDateRange | null {
  if (!ds.length) return null;
  if (ds.length === 1) return ds[0];
  const from = ds.reduce((a, d) => (d.from < a ? d.from : a), ds[0].from);
  const to = ds.reduce((a, d) => (d.to > a ? d.to : a), ds[0].to);
  return { from, to, phrase: joinList(ds.map((d) => d.phrase)) };
}

function boundingTime(ts: AskTimeRange[], bound: Draft["timeBound"]): AskTimeRange | null {
  let t: AskTimeRange | null = null;
  if (ts.length === 1) t = ts[0];
  else if (ts.length > 1) {
    const from = Math.min(...ts.map((x) => x.fromMin ?? 0));
    const to = Math.max(...ts.map((x) => x.toMin ?? 24 * 60));
    t = { fromMin: from, toMin: to, phrase: joinList(ts.map((x) => x.phrase)) };
  }
  if (bound) {
    const fromMin = Math.max(t?.fromMin ?? -1, bound.fromMin ?? -1);
    const toMin = Math.min(t?.toMin ?? 9999, bound.toMin ?? 9999);
    const f = fromMin < 0 ? null : fromMin, to = toMin >= 9999 ? null : toMin;
    const phrase = f != null && to != null ? askI18n.t("ph.timeRange", { from: fmtClock(f), to: fmtClock(to) })
      : f != null ? askI18n.t("ph.timeAfter", { t: fmtClock(f) }) : askI18n.t("ph.timeBefore", { t: fmtClock(to ?? 0) });
    return { fromMin: f, toMin: to, phrase: t ? `${t.phrase}, ${phrase}` : phrase };
  }
  return t;
}

/** Pick the facet to compare (or null) — two values of one facet + a compare hint. */
function pickCompare(d: Draft): AskCompare | null {
  const flag = d.compareFlag;
  const sideA = (s: AskSide): AskCompareSide => ({ label: sideOne(s), patch: { side: s } });
  if (d.sides.length === 2 && (flag || !d.tickers.length || d.tickers.length < 2)) {
    // «лонг и шорт» always means a comparison, unless the user compares two tickers.
    if (!(flag && d.tickers.length >= 2)) return { dim: "side", a: sideA("Long"), b: sideA("Short") };
  }
  if (d.traders.length >= 2) return { dim: "trader", a: { label: personName(d.traders[0]), patch: { trader: d.traders[0] } }, b: { label: personName(d.traders[1]), patch: { trader: d.traders[1] } } };
  if (!flag) return null;
  if (d.tickers.length >= 2) return { dim: "ticker", a: { label: d.tickers[0], patch: { tickers: [d.tickers[0]] } }, b: { label: d.tickers[1], patch: { tickers: [d.tickers[1]] } } };
  if (d.times.length >= 2) {
    const [x, y] = d.times;
    return { dim: "time", a: { label: x.phrase, patch: { time: x } }, b: { label: y.phrase, patch: { time: y } } };
  }
  if (d.weekdaySets.length >= 2) {
    const [x, y] = d.weekdaySets;
    return { dim: "weekday", a: { label: weekdayNames(x), patch: { weekdays: x } }, b: { label: weekdayNames(y), patch: { weekdays: y } } };
  }
  if (d.dates.length >= 2) {
    const [x, y] = d.dates;
    return { dim: "date", a: { label: x.phrase, patch: { date: x } }, b: { label: y.phrase, patch: { date: y } } };
  }
  if (d.setups.length >= 2) return { dim: "setup", a: { label: d.setups[0], patch: { setups: [d.setups[0]] } }, b: { label: d.setups[1], patch: { setups: [d.setups[1]] } } };
  if (d.outcomes.length >= 2) {
    return { dim: "outcome", a: { label: outcomeAdj(d.outcomes[0]), patch: { outcome: d.outcomes[0] } }, b: { label: outcomeAdj(d.outcomes[1]), patch: { outcome: d.outcomes[1] } } };
  }
  if (flag === "strong" && d.sides.length < 2 && !d.tickers.length) return { dim: "side", a: sideA("Long"), b: sideA("Short") };
  return null;
}

function resolveIntent(d: Draft, compare: AskCompare | null) {
  let intent: AskIntent = "list";
  let target: AskDim | null = null;
  let insight: "best" | "worst" | null = null;
  let metric: AskMetric = "net";
  for (const k of ["winrate", "fees", "pf", "count", "avg"] as const) if (d.explicit.has(k)) { metric = METRIC_OF[k]; break; }
  if (d.mostFlag && !d.verb && d.whichTarget && !d.best) metric = "n";

  if (compare) intent = "compare";
  else if (d.streak) intent = "streak";
  else if (d.best) { intent = d.best; target = d.target ?? d.whichTarget ?? d.groupBy ?? "trade"; }
  else if ((d.whenFlag || d.mostFlag || d.whichTarget) && d.verb && !d.explicit.has("fees")) {
    if (d.whichTarget) { intent = d.verb === "lose" ? "worst" : "best"; target = d.whichTarget; }
    else { intent = "insight"; insight = d.verb === "lose" ? "worst" : "best"; }
  } else if (d.leak && !d.explicit.has("fees")) {
    if (d.whichTarget) { intent = d.leak; target = d.whichTarget; }
    else { intent = "insight"; insight = d.leak; }
  } else if (d.whichTarget && d.mostFlag) { intent = "best"; target = d.whichTarget; }
  else if (d.explicit.has("fees")) intent = "fees";
  else if (d.explicit.has("winrate")) intent = "winrate";
  else if (d.explicit.has("pf")) intent = "pf";
  else if (d.explicit.has("hold")) intent = "hold";
  else if (d.explicit.has("size")) intent = "size";
  else if (d.explicit.has("drawdown")) intent = "drawdown";
  else if (d.explicit.has("avg")) intent = "avg";
  else if (d.explicit.has("sum")) intent = "sum";
  else if (d.explicit.has("count") || d.countHint) intent = "count";
  if ((intent === "best" || intent === "worst") && metric === "net" && d.explicit.has("avg")) metric = "avg";
  return { intent, target, insight, metric };
}

export function parseAsk(text: string, ctx: ParseContext): AskQuery {
  const raw = text ?? "";
  const traders = ctx.traders ?? [];
  const setups = ctx.setups ?? [];
  const knownTickers = new Set((ctx.tickers ?? []).map((t) => t.toUpperCase()));
  const protect = new Set<string>([...traders.flatMap((n) => [normWord(n), ...latinNames(normWord(n))]), ...setups.map(normWord)].filter((x) => x.length >= 2));
  const prep = prepare(raw, { protect, tickers: knownTickers, latinKnown: LATIN_KNOWN });
  const st: State = { orig: raw, prep, s: prep.text, today: ctx.today, traders, setups, tokens: [], d: emptyDraft() };

  // Trader names first: a name like «Тимур» must not be eaten by another rule, and Latin names are not tickers.
  matchTraders(st);
  for (const rule of RULES) runRule(st, rule);
  matchSetups(st);
  matchTickers(st, knownTickers);
  const unknown = collectUnknown(st);

  const d = st.d;
  const tokens = [...st.tokens];

  let compare = pickCompare(d);
  // Keep the user's order: «утро vs после обеда» ⇒ A = утро, even when the «после обеда» rule ran first.
  if (compare) {
    const pos = (label: string) => {
      const l = label.toLowerCase();
      const tok = tokens.find((t) => t.start >= 0 && (t.phrase.toLowerCase() === l || t.text.toLowerCase() === l || t.label.toLowerCase().endsWith(l)));
      return tok ? tok.start : -1;
    };
    const pa = pos(compare.a.label), pb = pos(compare.b.label);
    if (pa >= 0 && pb >= 0 && pb < pa) compare = { ...compare, a: compare.b, b: compare.a };
  }
  const cdim = compare?.dim;

  // Filters (the compared facet stays out of the base filter).
  const side: AskSide | null = cdim === "side" ? null : d.sides.length === 1 ? d.sides[0] : null;
  const tickers = cdim === "ticker" ? [] : d.tickers;
  const date = cdim === "date" || d.allTime ? null : boundingDate(d.dates);
  const time = cdim === "time" ? (d.timeBound ? boundingTime([], d.timeBound) : null) : boundingTime(d.times, d.timeBound);
  const wdUnion = [...new Set(d.weekdaySets.flat())].sort();
  const weekdays = cdim === "weekday" || !wdUnion.length ? null : wdUnion;
  const setupsF = cdim === "setup" ? [] : d.setups;
  const outcomeF = cdim === "outcome" ? null : d.outcomes.length ? d.outcomes[d.outcomes.length - 1] : null;
  const trader = cdim === "trader" ? null : d.traders[0] ?? null;

  const { intent, target, insight, metric } = resolveIntent(d, compare);
  let groupBy: AskDim | null = d.groupBy ?? (intent === "list" || intent === "sum" || intent === "count" || intent === "winrate" || intent === "avg" || intent === "fees" || intent === "pf" ? d.whichTarget : null);
  if ((intent === "best" || intent === "worst") && target && target !== "trade") groupBy = target;
  if (intent === "compare") groupBy = null;
  const topN = intent === "best" || intent === "worst" ? (d.topN ?? (d.plural ? 5 : 1)) : 1;

  const t = askI18n.t;
  const derived = (key: string, label: string, phrase: string): AskToken => ({ key, kind: key === "compare" ? "compare" : "intent", label, phrase, text: "", start: -1, end: -1 });
  if (compare) {
    tokens.push(derived("compare", t("tok.compare", { a: compare.a.label, b: compare.b.label }), `${compare.a.label} vs ${compare.b.label}`));
  }
  if ((intent === "best" || intent === "worst") && target) {
    const title = topN > 1 ? t("tok.topN", { title: targetTitle(intent, target, true).toLowerCase(), n: topN }) : targetTitle(intent, target).toLowerCase();
    tokens.push(derived("intent:best", metric !== "net" ? t("tok.bestBy", { title, metric: metricBy(metric) }) : t("tok.best", { title }), title));
  }
  if (intent === "insight") {
    tokens.push(derived("intent:insight", insight === "worst" ? t("tok.insightWorst") : t("tok.insightBest"), t("ph.insight")));
  }
  if (intent === "count" && !d.countToken) tokens.push(derived("intent:count", t("tok.count"), t("ph.count")));

  tokens.sort((a, b) => (a.start < 0 ? 1 : b.start < 0 ? -1 : a.start - b.start));

  return {
    raw, trader, allTraders: d.allTraders, tickers, setups: setupsF, side, outcome: outcomeF, date, time, weekdays,
    price: d.price, holdSec: d.holdSec, qty: d.qty, after: d.after, lastN: d.lastN,
    intent, target, groupBy, metric, topN, compare, streak: d.streak, insight,
    tokens, unknown, corrections: prep.corrections, ok: tokens.length > 0,
  };
}

/** The filter part of a query (for one side of a comparison: merge `compare.x.patch` on top). */
export function filterOf(q: AskQuery): AskFilter {
  return {
    trader: q.trader, tickers: q.tickers, setups: q.setups, side: q.side, outcome: q.outcome, date: q.date, time: q.time,
    weekdays: q.weekdays, price: q.price, holdSec: q.holdSec, qty: q.qty, after: q.after, lastN: q.lastN,
  };
}

function tidy(s: string): string {
  return s.replace(/\s*,\s*(,\s*)+/g, ", ").replace(/^[\s,]+|[\s,]+$/g, "").replace(/\s{2,}/g, " ");
}

/** Text of the query with one chip's source span blanked (re-parse it to drop that facet). */
export function textWithoutToken(q: AskQuery, key: string): string {
  const tok = q.tokens.find((t) => t.key === key);
  if (!tok || tok.start < 0) return q.raw;
  return tidy(q.raw.slice(0, tok.start) + " " + q.raw.slice(tok.end));
}

/** Text of the query with one chip's source span replaced by `replacement` (chip editing). */
export function replaceToken(q: AskQuery, key: string, replacement: string): string {
  const tok = q.tokens.find((t) => t.key === key);
  if (!tok || tok.start < 0) return tidy(`${q.raw} ${replacement}`);
  return tidy(q.raw.slice(0, tok.start) + ` ${replacement} ` + q.raw.slice(tok.end));
}

export function removeToken(q: AskQuery, key: string, ctx: ParseContext): AskQuery {
  return parseAsk(textWithoutToken(q, key), ctx);
}
