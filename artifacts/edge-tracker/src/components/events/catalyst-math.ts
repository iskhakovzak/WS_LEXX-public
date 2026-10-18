// «Катализаторы» — pure, I/O-free math: which days carry a market catalyst (macro calendar, short days,
// earnings of the trader's tickers) and how the trader actually trades on such days vs ordinary days.
// Money is always net (lib/trade-math netPnl = pnl − |fees|), win rate = W/(W+L), trading day = NY date.
// Covered by catalyst-math.test.ts (synthetic books).
import { isOpen, netPnl, resultOf, type TradeLike } from "@/lib/trade-math";
import { addDays } from "@/lib/trading-date";
import { fmtUsd } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { eventsI18n } from "@/i18n/ns/events";

/* ───────────── Inputs ───────────── */

/** holiday_calendar row (GET /api/holidays). */
export type MacroRow = { id?: number; date: string; type: string; name: string; description: string | null; importance: string };

export type BookTrade = TradeLike & { id?: number; ticker?: string | null; date?: string | null };

/** One reported quarter from GET /api/earnings/history/:ticker (only the fields we use). */
export type ReactionQuarter = {
  date: string;
  reactionDate: string | null;
  gapPct: number | null;
  rangePct: number | null;
  closePct: number | null;
  beat?: boolean | null;
};
export type TickerHistory = { ticker: string; quarters: ReactionQuarter[] };

/* ───────────── Categories ───────────── */

export type CatKey = "cpi" | "ppi" | "nfp" | "fomc" | "opex" | "month_end" | "short_day";

/** CPI / NFP / PPI are codes in every language; the rest are translated (events.cat.label.*). */
export const catLabel = (k: CatKey): string =>
  k === "cpi" || k === "nfp" || k === "ppi" ? k.toUpperCase() : eventsI18n.t(`cat.label.${k}`);
export const catHint = (k: CatKey): string => eventsI18n.t(`cat.hint.${k}`);

const catDef = (key: CatKey) => ({
  key,
  get label() { return catLabel(key); },
  get hint() { return catHint(key); },
});
export const CATS: { key: CatKey; readonly label: string; readonly hint: string }[] = (
  ["cpi", "nfp", "fomc", "ppi", "opex", "month_end", "short_day"] as const
).map(catDef);

const isWeekendYmd = (d: string) => {
  const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
  return wd === 0 || wd === 6;
};

/** Holiday rows that close the market for the whole day. */
export function isClosedRow(r: Pick<MacroRow, "type" | "description" | "name">): boolean {
  return r.type?.toLowerCase() === "holiday" && /closed/i.test(`${r.description ?? ""}`) && !/early|1\s?pm|13:00/i.test(`${r.description ?? ""}`);
}

/** Holiday rows with an early close. */
export function isShortDayRow(r: Pick<MacroRow, "type" | "description" | "name">): boolean {
  return r.type?.toLowerCase() === "holiday" && /early close|close early|1\s?pm|13:00/i.test(`${r.description ?? ""} ${r.name ?? ""}`);
}

/** Category of one calendar row, or null (e.g. the first FOMC day, a full holiday). */
export function categoryOf(r: MacroRow): CatKey | null {
  const t = (r.type ?? "").toLowerCase();
  if (t === "cpi" || t === "ppi" || t === "nfp" || t === "month_end") return t;
  if (t === "opex" || t === "quad_witching") return "opex";
  if (t === "fomc") return /decision/i.test(r.name ?? "") || /statement|2\s?pm/i.test(r.description ?? "") ? "fomc" : null;
  if (t === "holiday" && isShortDayRow(r)) return "short_day";
  return null;
}

/** date → categories present that day. */
export function categoriesByDate(rows: MacroRow[]): Map<string, Set<CatKey>> {
  const m = new Map<string, Set<CatKey>>();
  for (const r of rows) {
    const k = categoryOf(r);
    if (!k) continue;
    const d = r.date.slice(0, 10);
    const s = m.get(d) ?? new Set<CatKey>();
    s.add(k);
    m.set(d, s);
  }
  return m;
}

export function closedDates(rows: MacroRow[]): Set<string> {
  return new Set(rows.filter(isClosedRow).map((r) => r.date.slice(0, 10)));
}

/* ───────────── Trading days ───────────── */

export function isTradingDay(d: string, closed: Set<string>): boolean {
  return !isWeekendYmd(d) && !closed.has(d);
}

export function nextTradingDay(d: string, closed: Set<string>): string {
  let x = addDays(d, 1);
  for (let i = 0; i < 14 && !isTradingDay(x, closed); i++) x = addDays(x, 1);
  return x;
}

export function prevTradingDay(d: string, closed: Set<string>): string {
  let x = addDays(d, -1);
  for (let i = 0; i < 14 && !isTradingDay(x, closed); i++) x = addDays(x, -1);
  return x;
}

/**
 * The day the desk is preparing for: today while the regular session is not over (NY < 16:00) and the
 * market is open, otherwise the next trading day. `nyMinutes` = minutes since NY midnight.
 */
export function focusDay(todayNy: string, nyMinutes: number, closed: Set<string>): string {
  if (isTradingDay(todayNy, closed) && nyMinutes < 16 * 60) return todayNy;
  return nextTradingDay(todayNy, closed);
}

const nyClock = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** Minutes since midnight in New York for an instant. */
export function nyMinutesOf(d: Date = new Date()): number {
  const [h, m] = nyClock.format(d).split(":").map(Number);
  return (h % 24) * 60 + (m || 0);
}

/* ───────────── Day book ───────────── */

export type DayStat = { date: string; n: number; wins: number; losses: number; net: number; tickers: Map<string, { n: number; net: number }> };

/** Closed trades grouped by trading (entry) date, net money. Open positions are skipped. */
export function buildDayBook(trades: BookTrade[]): Map<string, DayStat> {
  const m = new Map<string, DayStat>();
  for (const t of trades) {
    if (isOpen(t)) continue;
    const d = String(t.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const net = netPnl(t);
    const r = resultOf(t);
    const s = m.get(d) ?? { date: d, n: 0, wins: 0, losses: 0, net: 0, tickers: new Map() };
    s.n++;
    if (r === "win") s.wins++;
    else if (r === "loss") s.losses++;
    if (net != null) s.net += net;
    const tk = String(t.ticker ?? "").toUpperCase();
    if (tk) {
      const ts = s.tickers.get(tk) ?? { n: 0, net: 0 };
      ts.n++;
      if (net != null) ts.net += net;
      s.tickers.set(tk, ts);
    }
    m.set(d, s);
  }
  return m;
}

export type Sample = "none" | "low" | "ok";
export const sampleOf = (days: number): Sample => (days === 0 ? "none" : days < 5 ? "low" : "ok");

export type DayAgg = {
  days: number;
  trades: number;
  net: number;
  avgNetDay: number | null;
  greenDays: number;
  greenPct: number | null;
  wins: number;
  losses: number;
  winRate: number | null;
  avgTradesDay: number | null;
  /** Day nets, for the noise test. */
  nets: number[];
  sample: Sample;
};

const r2 = (v: number) => Math.round(v * 100) / 100;

export function aggregateDays(book: Map<string, DayStat>, dates: Iterable<string>): DayAgg {
  let trades = 0, net = 0, green = 0, wins = 0, losses = 0;
  const nets: number[] = [];
  for (const d of dates) {
    const s = book.get(d);
    if (!s) continue;
    trades += s.n; net += s.net; wins += s.wins; losses += s.losses;
    if (s.net > 0) green++;
    nets.push(s.net);
  }
  const days = nets.length;
  return {
    days, trades, net: r2(net),
    avgNetDay: days ? r2(net / days) : null,
    greenDays: green,
    greenPct: days ? Math.round((green / days) * 100) : null,
    wins, losses,
    winRate: wins + losses ? Math.round((wins / (wins + losses)) * 1000) / 10 : null,
    avgTradesDay: days ? Math.round((trades / days) * 10) / 10 : null,
    nets,
    sample: sampleOf(days),
  };
}

/** Welch t-statistic of two samples' means (null when either has < 2 values or zero variance). */
export function welchT(a: number[], b: number[]): number | null {
  if (a.length < 2 || b.length < 2) return null;
  const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
  const varOf = (x: number[], m: number) => x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1);
  const ma = mean(a), mb = mean(b);
  const se = Math.sqrt(varOf(a, ma) / a.length + varOf(b, mb) / b.length);
  if (!Number.isFinite(se) || se === 0) return null;
  return (ma - mb) / se;
}

/** «устойчиво» when |t| ≥ 2 with ≥ 5 event days, «похоже» at |t| ≥ 1.3, otherwise noise. */
export type Verdict = "robust" | "maybe" | "noise" | "low";
export function verdictOf(agg: DayAgg, base: DayAgg): Verdict {
  if (agg.days < 5 || base.days < 5) return "low";
  const t = welchT(agg.nets, base.nets);
  if (t == null) return "noise";
  const a = Math.abs(t);
  return a >= 2 ? "robust" : a >= 1.3 ? "maybe" : "noise";
}

export type CategoryEdge = {
  key: CatKey;
  label: string;
  hint: string;
  /** Trading days of this category inside the trader's active span. */
  calendarDays: number;
  agg: DayAgg;
  /** avgNetDay − baseline.avgNetDay ($/day). */
  delta: number | null;
  verdict: Verdict;
  dates: string[];
};

export type CatalystEdge = {
  from: string | null;
  to: string | null;
  baseline: DayAgg;
  all: DayAgg;
  rows: CategoryEdge[];
};

/**
 * «Как я торгую в такие дни»: per macro category the trader's day results vs ordinary days
 * (traded days with no category at all). Span = first..last traded day (optionally clipped).
 */
export function edgeByCategory(
  book: Map<string, DayStat>,
  cats: Map<string, Set<CatKey>>,
  closed: Set<string>,
  opts: { from?: string | null; to?: string | null } = {},
): CatalystEdge {
  const traded = [...book.keys()].filter((d) => (!opts.from || d >= opts.from) && (!opts.to || d <= opts.to)).sort();
  const from = traded[0] ?? null;
  const to = traded[traded.length - 1] ?? null;
  const inSpan = (d: string) => from != null && to != null && d >= from && d <= to;
  const baseDates = traded.filter((d) => !cats.has(d));
  const baseline = aggregateDays(book, baseDates);
  const rows: CategoryEdge[] = CATS.map((c) => {
    const dates = [...cats.entries()].filter(([d, s]) => s.has(c.key) && inSpan(d) && isTradingDay(d, closed)).map(([d]) => d).sort();
    const agg = aggregateDays(book, dates);
    return {
      key: c.key, label: c.label, hint: c.hint,
      calendarDays: dates.length,
      agg,
      delta: agg.avgNetDay != null && baseline.avgNetDay != null ? r2(agg.avgNetDay - baseline.avgNetDay) : null,
      verdict: verdictOf(agg, baseline),
      dates,
    };
  });
  return { from, to, baseline, all: aggregateDays(book, traded), rows };
}

/* ───────────── Tickers ───────────── */

export type TickerFreq = { ticker: string; n: number; net: number; days: number; lastDate: string };

/** The trader's most traded tickers (closed trades), most trades first. */
export function frequentTickers(trades: BookTrade[], limit = 12, minTrades = 3): TickerFreq[] {
  const m = new Map<string, { n: number; net: number; days: Set<string>; last: string }>();
  for (const t of trades) {
    if (isOpen(t)) continue;
    const tk = String(t.ticker ?? "").trim().toUpperCase();
    if (!tk) continue;
    const d = String(t.date ?? "").slice(0, 10);
    const s = m.get(tk) ?? { n: 0, net: 0, days: new Set<string>(), last: "" };
    s.n++;
    s.net += netPnl(t) ?? 0;
    s.days.add(d);
    if (d > s.last) s.last = d;
    m.set(tk, s);
  }
  return [...m.entries()]
    .filter(([, s]) => s.n >= minTrades)
    .map(([ticker, s]) => ({ ticker, n: s.n, net: r2(s.net), days: s.days.size, lastDate: s.last }))
    .sort((a, b) => b.n - a.n || a.ticker.localeCompare(b.ticker))
    .slice(0, limit);
}

/* ───────────── Earnings reaction × my trades ───────────── */

export type EarningsEdge = {
  ticker: string;
  /** Reaction sessions known from history (newest first). */
  reactions: { date: string; gapPct: number | null; rangePct: number | null; closePct: number | null; beat: boolean | null }[];
  avgAbsGap: number | null;
  avgRange: number | null;
  upShare: number | null;
  /** My closed trades in this ticker on its reaction days. */
  event: { days: number; trades: number; net: number; wins: number; losses: number; winRate: number | null; avgNetTrade: number | null };
  /** My closed trades in this ticker on all other days. */
  other: { trades: number; net: number; winRate: number | null; avgNetTrade: number | null };
};

const avg = (xs: number[]) => (xs.length ? r2(xs.reduce((s, v) => s + v, 0) / xs.length) : null);

export function earningsEdge(trades: BookTrade[], h: TickerHistory): EarningsEdge {
  const ticker = h.ticker.toUpperCase();
  const reactions = h.quarters
    .filter((q) => !!q.reactionDate)
    .map((q) => ({ date: String(q.reactionDate).slice(0, 10), gapPct: q.gapPct, rangePct: q.rangePct, closePct: q.closePct, beat: q.beat ?? null }))
    .sort((a, b) => b.date.localeCompare(a.date));
  const rset = new Set(reactions.map((r) => r.date));
  let eN = 0, eNet = 0, eW = 0, eL = 0, oN = 0, oNet = 0, oW = 0, oL = 0;
  const eDays = new Set<string>();
  for (const t of trades) {
    if (isOpen(t)) continue;
    if (String(t.ticker ?? "").toUpperCase() !== ticker) continue;
    const d = String(t.date ?? "").slice(0, 10);
    const net = netPnl(t) ?? 0;
    const r = resultOf(t);
    if (rset.has(d)) {
      eN++; eNet += net; eDays.add(d);
      if (r === "win") eW++; else if (r === "loss") eL++;
    } else {
      oN++; oNet += net;
      if (r === "win") oW++; else if (r === "loss") oL++;
    }
  }
  const closes = reactions.map((r) => r.closePct).filter((v): v is number => v != null);
  return {
    ticker,
    reactions,
    avgAbsGap: avg(reactions.map((r) => r.gapPct).filter((v): v is number => v != null).map(Math.abs)),
    avgRange: avg(reactions.map((r) => r.rangePct).filter((v): v is number => v != null)),
    upShare: closes.length ? Math.round((closes.filter((v) => v > 0).length / closes.length) * 100) : null,
    event: {
      days: eDays.size, trades: eN, net: r2(eNet), wins: eW, losses: eL,
      winRate: eW + eL ? Math.round((eW / (eW + eL)) * 1000) / 10 : null,
      avgNetTrade: eN ? r2(eNet / eN) : null,
    },
    other: {
      trades: oN, net: r2(oNet),
      winRate: oW + oL ? Math.round((oW / (oW + oL)) * 1000) / 10 : null,
      avgNetTrade: oN ? r2(oNet / oN) : null,
    },
  };
}

/** All tickers' earnings-reaction days pooled: «как я торгую в день отчёта своего тикера». */
export function pooledEarnings(edges: EarningsEdge[]) {
  let trades = 0, net = 0, wins = 0, losses = 0, days = 0, oTrades = 0, oNet = 0;
  for (const e of edges) {
    trades += e.event.trades; net += e.event.net; wins += e.event.wins; losses += e.event.losses; days += e.event.days;
    oTrades += e.other.trades; oNet += e.other.net;
  }
  return {
    days, trades, net: r2(net),
    winRate: wins + losses ? Math.round((wins / (wins + losses)) * 1000) / 10 : null,
    avgNetTrade: trades ? r2(net / trades) : null,
    otherAvgNetTrade: oTrades ? r2(oNet / oTrades) : null,
    sample: sampleOf(days),
  };
}

/* ───────────── Copy ───────────── */

/**
 * One-line takeaway for a category row: what the numbers say and what to do about it.
 * Deliberately cautious with thin samples.
 */
export function takeaway(row: CategoryEdge, _base: DayAgg): string {
  const t = eventsI18n.t;
  const a = row.agg;
  if (a.days === 0) return row.calendarDays ? t("takeaway.noTradesCal", { days: commonI18n.t("units.days", { count: row.calendarDays }) }) : t("takeaway.noneInPeriod");
  if (row.verdict === "low") return t("takeaway.low", { days: commonI18n.t("units.days", { count: a.days }) });
  if (row.verdict === "noise") return t("takeaway.noise");
  const d = row.delta ?? 0;
  return d < 0
    ? t("takeaway.worse", { amount: fmtUsd(Math.abs(d), { decimals: 0 }) })
    : t("takeaway.better", { amount: fmtUsd(d, { decimals: 0 }) });
}
