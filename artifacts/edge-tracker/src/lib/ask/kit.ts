// «Спроси журнал» — the parser kit shared by the RU / EN / UZ rule sets (pure, no React).
//
// A rule = regex over the prepared text + handler. Handlers never build user-facing text themselves: they call an
// effect below (fx.*), which records the facet in the draft and returns the «понял как» chip (label + phrase,
// rendered in the UI language by ./phrases). Rules are grouped by STAGE; parse.ts runs the stages in order and,
// inside a stage, RU → EN → UZ → language-neutral rules. Each accepted match masks its span, so later (looser)
// rules never re-read it — that is why the stage order matters (hold before price before time, …).

import { addDays, prevWeekday } from "@/lib/trading-date";
import type { Prepared } from "./prepare";
import {
  BOOK_START, afterPhrase, datePhrase, fmtClock, fmtDuration, fmtRange, groupPhrase, outcomeAdj, sessionPhrase, sideOne, sidePl,
  usd, weekdayNames, weekdayPhrase, type DatePhrase, type SessionCode,
} from "./phrases";
import { askI18n } from "@/i18n/ns/ask";
import type { AskAfter, AskDateRange, AskDim, AskNumRange, AskOutcome, AskSide, AskTimeRange, AskToken } from "./types";

// ── Regex building blocks (JS \b does not work for Cyrillic ⇒ explicit lookarounds) ──

export const L = "(?<![\\p{L}\\p{N}])";
export const R = "(?![\\p{L}\\p{N}])";
export const re = (body: string) => new RegExp(`${L}(?:${body})${R}`, "gu");
export const NUM = "(\\d+(?:[.,]\\d+)?)";
export const HH = "(\\d{1,2})(?:[:.](\\d{2}))?";

// ── Date helpers ──────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const partsOf = (date: string) => date.split("-").map(Number) as [number, number, number];
/** 0 = Monday … 6 = Sunday. */
export const weekdayOf = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
export const validYmd = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
export { BOOK_START };

/** Month without an explicit year: the latest occurrence not after today. */
export function resolveYear(month: number, today: string, explicit?: string): number {
  if (explicit) return Number(explicit);
  const [ty, tm] = partsOf(today);
  return month > tm ? ty - 1 : ty;
}
export function monthRange(y: number, m: number) {
  return { from: ymd(y, m, 1), to: ymd(y, m, daysInMonth(y, m)) };
}
export function quarterRange(y: number, q: number) {
  const m0 = (q - 1) * 3 + 1;
  return { from: ymd(y, m0, 1), to: ymd(y, m0 + 2, daysInMonth(y, m0 + 2)) };
}
/** Day + month (1–12) + optional year → ISO date, or null when invalid. */
export function dayMonth(today: string, d: string | number, mo: number | null, year?: string): string | null {
  if (!mo) return null;
  const y = resolveYear(mo, today, year);
  const dd = Number(d);
  return validYmd(y, mo, dd) ? ymd(y, mo, dd) : null;
}

export const toNum = (s: string | undefined) => (s == null ? NaN : Number(s.replace(",", ".")));
export const clock = (h: string, mm?: string) => {
  const hh = Number(h), mi = mm ? Number(mm) : 0;
  if (hh > 23 || mi > 59) return null;
  return hh * 60 + mi;
};
export const plausibleBareHour = (h: string) => Number(h) >= 4 && Number(h) <= 20;

/** Seconds in a duration unit word of any language (с/s → 1, ч/h/soat → 3600, else minutes). */
export function unitSeconds(u: string): number {
  if (u.startsWith("soat")) return 3600;
  const c = u[0];
  if (c === "с" || c === "s") return 1; // i18n-ignore (RU unit letter in the question)
  if (c === "ч" || c === "h") return 3600; // i18n-ignore (RU unit letter in the question)
  return 60;
}

export const SESSIONS: Record<SessionCode, [number, number]> = {
  afternoon: [840, 960], premarket: [240, 570], postmarket: [960, 1200], powerHour: [900, 960],
  firstHour: [570, 630], open: [570, 600], morning: [570, 660], lunch: [660, 840],
};

// ── Parser state ──────────────────────────────────────────────────────────────

export type Explicit = "count" | "sum" | "avg" | "winrate" | "fees" | "pf" | "hold" | "size" | "drawdown";

export interface Draft {
  traders: string[];
  allTraders: boolean;
  tickers: string[];
  setups: string[];
  sides: AskSide[];
  outcomes: AskOutcome[];
  dates: AskDateRange[];
  allTime: boolean;
  times: AskTimeRange[];
  timeBound: { fromMin: number | null; toMin: number | null } | null;
  weekdaySets: number[][];
  price: AskNumRange | null;
  holdSec: AskNumRange | null;
  qty: AskNumRange | null;
  after: AskAfter | null;
  lastN: number | null;
  compareFlag: "strong" | "weak" | null;
  best: "best" | "worst" | null;
  topN: number | null;
  plural: boolean;
  target: AskDim | null;
  whichTarget: AskDim | null;
  leak: "best" | "worst" | null;
  whenFlag: boolean;
  mostFlag: boolean;
  verb: "earn" | "lose" | null;
  streak: { kind: "win" | "loss" | null; unit: "trade" | "day" } | null;
  explicit: Set<Explicit>;
  countHint: boolean;
  countToken: boolean;
  groupBy: AskDim | null;
}

export function emptyDraft(): Draft {
  return {
    traders: [], allTraders: false, tickers: [], setups: [], sides: [], outcomes: [], dates: [], allTime: false, times: [], timeBound: null,
    weekdaySets: [], price: null, holdSec: null, qty: null, after: null, lastN: null, compareFlag: null, best: null, topN: null,
    plural: false, target: null, whichTarget: null, leak: null, whenFlag: false, mostFlag: false, verb: null, streak: null,
    explicit: new Set(), countHint: false, countToken: false, groupBy: null,
  };
}

export interface State {
  orig: string;
  prep: Prepared;
  s: string;
  today: string;
  traders: readonly string[];
  setups: readonly string[];
  d: Draft;
  tokens: AskToken[];
}

export type TokenBody = Omit<AskToken, "key" | "text" | "start" | "end">;
/** null = consumed without a chip; false = rejected (the span stays for later rules). */
export type Handler = (m: RegExpExecArray, st: State) => TokenBody | null | false;
export interface Rule { re: RegExp; fn: Handler }

export const STAGES = [
  "scope", "last", "after", "streak", "which", "hold", "qty", "price", "dates", "dateTail", "relDates", "sessions", "time",
  "numDate", "weekdays", "intents", "sides", "setup",
] as const;
export type Stage = (typeof STAGES)[number];
export type RuleSet = Record<Stage, Rule[]>;

export function ruleBook() {
  const set = Object.fromEntries(STAGES.map((s) => [s, [] as Rule[]])) as RuleSet;
  return {
    set,
    add: (stage: Stage, body: string, fn: Handler) => { set[stage].push({ re: re(body), fn }); },
    push: (stage: Stage, rx: RegExp, fn: Handler) => { set[stage].push({ re: rx, fn }); },
  };
}

/** Normalised word for matching names / setups (lowercase, ё→е, _ → space). */
export function normWord(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[_]+/g, " ").trim(); // i18n-ignore (ё → е)
}

// ── Effects ───────────────────────────────────────────────────────────────────

const t = askI18n.t;

export type Period =
  | "today" | "yesterday" | "dayBefore" | "thisWeek" | "lastWeek" | "pastWeek" | "thisMonth" | "lastMonth" | "pastMonth"
  | "thisQuarter" | "lastQuarter" | "ytd" | "lastYear" | "pastYear";

function periodRange(today: string, p: Period): { from: string; to: string } {
  const [y, m] = partsOf(today);
  const q = Math.floor((m - 1) / 3) + 1;
  switch (p) {
    case "today": return { from: today, to: today };
    case "yesterday": { const d = prevWeekday(today); return { from: d, to: d }; }
    case "dayBefore": { const d = prevWeekday(prevWeekday(today)); return { from: d, to: d }; }
    case "thisWeek": return { from: addDays(today, -weekdayOf(today)), to: today };
    case "lastWeek": { const mon = addDays(today, -weekdayOf(today) - 7); return { from: mon, to: addDays(mon, 4) }; }
    case "pastWeek": return { from: addDays(today, -6), to: today };
    case "thisMonth": return { from: ymd(y, m, 1), to: today };
    case "lastMonth": return m === 1 ? monthRange(y - 1, 12) : monthRange(y, m - 1);
    case "pastMonth": return { from: addDays(today, -29), to: today };
    case "thisQuarter": return { from: quarterRange(y, q).from, to: today };
    case "lastQuarter": return q === 1 ? quarterRange(y - 1, 4) : quarterRange(y, q - 1);
    case "ytd": return { from: `${y}-01-01`, to: today };
    case "lastYear": return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case "pastYear": return { from: addDays(today, -364), to: today };
  }
}

const range = (min: number | null, max: number | null): AskNumRange => ({ min, max });

export const fx = {
  date(st: State, from: string, to: string, p: DatePhrase): TokenBody {
    if (from > to) [from, to] = [to, from];
    const phrase = datePhrase(p);
    st.d.dates.push({ from, to, phrase });
    return { kind: "date", label: t("tok.date", { range: fmtRange({ from, to }) }), phrase };
  },
  period(st: State, p: Period): TokenBody {
    const r = periodRange(st.today, p);
    return fx.date(st, r.from, r.to, { k: p });
  },
  lastPeriod(st: State, n: number, unit: "day" | "week" | "month"): TokenBody | false {
    if (!(n > 0)) return false;
    const days = unit === "week" ? 7 : unit === "month" ? 30 : 1;
    return fx.date(st, addDays(st.today, -(n * days) + 1), st.today, { k: "lastN", n, unit });
  },
  day(st: State, date: string | null): TokenBody | false {
    if (!date) return false;
    return fx.date(st, date, date, { k: "day", date, withYear: date.slice(0, 4) !== st.today.slice(0, 4) });
  },
  span(st: State, from: string | null, to: string | null): TokenBody | false {
    if (!from || !to) return false;
    return fx.date(st, from, to, { k: "range", from: from < to ? from : to, to: from < to ? to : from });
  },
  since(st: State, date: string | null): TokenBody | false {
    return date ? fx.date(st, date, st.today, { k: "since", date }) : false;
  },
  until(st: State, date: string | null): TokenBody | false {
    return date ? fx.date(st, BOOK_START, date, { k: "until", date }) : false;
  },
  month(st: State, mo: number | null, year?: string): TokenBody | false {
    if (!mo) return false;
    const y = resolveYear(mo, st.today, year);
    const r = monthRange(y, mo);
    return fx.date(st, r.from, r.to, { k: "month", m: mo, y: year ? y : undefined });
  },
  sinceMonth(st: State, mo: number | null, year?: string): TokenBody | false {
    if (!mo) return false;
    return fx.since(st, ymd(resolveYear(mo, st.today, year), mo, 1));
  },
  year(st: State, y: number): TokenBody | false {
    const ty = Number(st.today.slice(0, 4));
    if (y > ty || y < 2000) return false;
    return fx.date(st, `${y}-01-01`, y === ty ? st.today : `${y}-12-31`, { k: "year", y });
  },
  quarter(st: State, q: number, year?: string): TokenBody {
    const [ty, tm] = partsOf(st.today);
    const y = year ? Number(year) : (q - 1) * 3 + 1 > tm ? ty - 1 : ty;
    const r = quarterRange(y, q);
    return fx.date(st, r.from, r.to < st.today ? r.to : st.today, { k: "quarter", q, y });
  },
  weekdayDate(st: State, wd: number): TokenBody {
    const d = addDays(st.today, -((weekdayOf(st.today) - wd + 7) % 7));
    return fx.day(st, d) as TokenBody;
  },
  allTime(st: State): TokenBody {
    st.d.allTime = true;
    return { kind: "date", label: t("tok.allTime"), phrase: t("ph.allTime") };
  },
  desk(st: State): TokenBody {
    st.d.allTraders = true;
    return { kind: "scope", label: t("tok.desk"), phrase: t("ph.desk") };
  },
  lastN(st: State, n: number): TokenBody | false {
    if (!(n > 0)) return false;
    st.d.lastN = n;
    return { kind: "last", label: t("tok.last", { n }), phrase: t("ph.last", { count: n }) };
  },
  lastOne(st: State, one: boolean): TokenBody {
    if (one) {
      st.d.lastN = 1;
      return { kind: "last", label: t("tok.lastOne"), phrase: t("ph.lastOne") };
    }
    return fx.lastN(st, 20) as TokenBody;
  },
  after(st: State, kind: "win" | "loss", n?: string | number): TokenBody {
    const a = { kind, n: n ? Math.min(10, Math.max(1, Number(n))) : 1 };
    st.d.after = a;
    const phrase = afterPhrase(a);
    return { kind: "after", label: t("tok.after", { phrase }), phrase };
  },
  streak(st: State, kind: "win" | "loss" | null, unit: "trade" | "day"): TokenBody {
    st.d.streak = { kind, unit };
    const k = `${kind ?? "any"}${unit === "day" ? "Days" : ""}` as "any" | "loss" | "win" | "anyDays" | "lossDays" | "winDays";
    return { kind: "intent", label: t(`tok.streak.${k}`), phrase: t("ph.streak") };
  },
  which(st: State, dim: AskDim | null): null | false {
    if (!dim) return false;
    st.d.whichTarget = dim;
    return null;
  },
  leak(st: State, k: "best" | "worst"): null { st.d.leak = k; return null; },
  when(st: State): null { st.d.whenFlag = true; return null; },
  most(st: State): null { st.d.mostFlag = true; return null; },
  verb(st: State, v: "earn" | "lose"): null { st.d.verb = v; return null; },
  /** «сколько я заработал / потерял» ⇒ sum + verb. */
  earned(st: State, v: "earn" | "lose"): TokenBody {
    st.d.verb = v;
    return fx.explicit(st, "sum");
  },
  weakCompare(st: State): null { if (!st.d.compareFlag) st.d.compareFlag = "weak"; return null; },
  strongCompare(st: State): null { st.d.compareFlag = "strong"; return null; },
  holdRange(st: State, a: number, b: number): TokenBody | false {
    if (!(a >= 0 && b > 0)) return false;
    const min = Math.min(a, b), max = Math.max(a, b);
    st.d.holdSec = range(min, max);
    const p = { min: fmtDuration(min), max: fmtDuration(max) };
    return { kind: "hold", label: t("tok.holdRange", p), phrase: t("ph.holdRange", p) };
  },
  holdBound(st: State, dir: "min" | "max", sec: number): TokenBody | false {
    if (!(sec > 0)) return false;
    const prev = st.d.holdSec ?? range(null, null);
    st.d.holdSec = dir === "min" ? { ...prev, min: sec } : { ...prev, max: sec };
    const v = fmtDuration(sec);
    return dir === "min"
      ? { kind: "hold", label: t("tok.holdMin", { v }), phrase: t("ph.holdMin", { v }) }
      : { kind: "hold", label: t("tok.holdMax", { v }), phrase: t("ph.holdMax", { v }) };
  },
  qtyRange(st: State, a: number, b: number): TokenBody | false {
    if (!(a >= 0 && b > 0)) return false;
    const min = Math.min(a, b), max = Math.max(a, b);
    st.d.qty = range(min, max);
    return { kind: "qty", label: t("tok.qtyRange", { min, max }), phrase: t("ph.qtyRange", { min, max }) };
  },
  qtyBound(st: State, max: boolean, n: number): TokenBody | false {
    if (!(n > 0)) return false;
    const prev = st.d.qty ?? range(null, null);
    st.d.qty = max ? { ...prev, max: n } : { ...prev, min: n };
    return max
      ? { kind: "qty", label: t("tok.qtyMax", { n }), phrase: t("ph.qtyMax", { n }) }
      : { kind: "qty", label: t("tok.qtyMin", { n }), phrase: t("ph.qtyMin", { n }) };
  },
  priceRange(st: State, a: number, b: number): TokenBody | false {
    if (!(a >= 0 && b > 0)) return false;
    const min = Math.min(a, b), max = Math.max(a, b);
    st.d.price = range(min, max);
    const p = { min: usd(min), max: usd(max) };
    return { kind: "price", label: t("tok.priceRange", p), phrase: t("ph.priceRange", p) };
  },
  priceBound(st: State, dir: "min" | "max", n: number): TokenBody | false {
    if (!(n > 0)) return false;
    const prev = st.d.price ?? range(null, null);
    st.d.price = dir === "max" ? { ...prev, max: n } : { ...prev, min: n };
    const v = usd(n);
    return dir === "max"
      ? { kind: "price", label: t("tok.priceMax", { v }), phrase: t("ph.priceMax", { v }) }
      : { kind: "price", label: t("tok.priceMin", { v }), phrase: t("ph.priceMin", { v }) };
  },
  session(st: State, code: SessionCode): TokenBody {
    const [from, to] = SESSIONS[code];
    const phrase = sessionPhrase(code);
    st.d.times.push({ fromMin: from, toMin: to, phrase });
    return { kind: "time", label: t("tok.session", { from: fmtClock(from), to: fmtClock(to), phrase }), phrase };
  },
  timeRange(st: State, a: number | null, b: number | null): TokenBody | false {
    if (a == null || b == null || a >= b) return false;
    const p = { from: fmtClock(a), to: fmtClock(b) };
    const phrase = t("ph.timeRange", p);
    st.d.times.push({ fromMin: a, toMin: b, phrase });
    return { kind: "time", label: t("tok.timeRange", p), phrase };
  },
  timeAfter(st: State, a: number | null): TokenBody | false {
    if (a == null) return false;
    st.d.timeBound = { fromMin: a, toMin: st.d.timeBound?.toMin ?? null };
    return { kind: "time", label: t("tok.timeAfter", { t: fmtClock(a) }), phrase: t("ph.timeAfter", { t: fmtClock(a) }) };
  },
  timeBefore(st: State, b: number | null): TokenBody | false {
    if (b == null) return false;
    st.d.timeBound = { fromMin: st.d.timeBound?.fromMin ?? null, toMin: b };
    return { kind: "time", label: t("tok.timeBefore", { t: fmtClock(b) }), phrase: t("ph.timeBefore", { t: fmtClock(b) }) };
  },
  /** Weekday words in the match → filter (0 = Mon … 4 = Fri). */
  weekdays(st: State, days: Array<number | null>): TokenBody | false {
    const set = [...new Set(days.filter((x): x is number => x != null))].sort();
    if (!set.length) return false;
    st.d.weekdaySets.push(set);
    return { kind: "weekday", label: t("tok.weekday", { days: weekdayNames(set) }), phrase: weekdayPhrase(set) };
  },
  best(st: State, o: { worst: boolean; n?: number; dim?: AskDim | null; plural?: boolean }): null {
    st.d.best = o.worst ? "worst" : "best";
    if (o.n && o.n > 0) st.d.topN = Math.min(50, o.n);
    if (o.dim) st.d.target = o.dim;
    if (o.plural) st.d.plural = true;
    return null;
  },
  explicit(st: State, k: Explicit): TokenBody {
    st.d.explicit.add(k);
    if (k === "count") st.d.countToken = true;
    return { kind: "intent", label: t(`tok.${k}`), phrase: t(`ph.${k}`) };
  },
  countHint(st: State): null { st.d.countHint = true; return null; },
  group(st: State, dim: AskDim | null): TokenBody | false {
    if (!dim) return false;
    st.d.groupBy = dim;
    if (dim === "trader") st.d.allTraders = true;
    const phrase = groupPhrase(dim);
    return { kind: "group", label: t("tok.group", { phrase }), phrase };
  },
  side(st: State, side: AskSide): TokenBody {
    if (!st.d.sides.includes(side)) st.d.sides.push(side);
    return { kind: "side", label: t("tok.side", { side: sideOne(side) }), phrase: sidePl(side) };
  },
  outcome(st: State, o: AskOutcome): TokenBody {
    if (!st.d.outcomes.includes(o)) st.d.outcomes.push(o);
    const word = outcomeAdj(o);
    return { kind: "outcome", label: t("tok.outcome", { outcome: word }), phrase: word };
  },
  /** «сетап X» — a known setup by prefix, else the word itself. `stop` = function words that are never a name. */
  setup(st: State, word: string, stop: RegExp): TokenBody | false {
    if (stop.test(word)) return false;
    const known = st.setups.find((s) => normWord(s) === word) ?? st.setups.find((s) => normWord(s).startsWith(word) || word.startsWith(normWord(s)));
    const name = known ?? word;
    if (!st.d.setups.includes(name)) st.d.setups.push(name);
    return { kind: "setup", label: t("tok.setup", { name }), phrase: t("ph.setup", { name }) };
  },
};
