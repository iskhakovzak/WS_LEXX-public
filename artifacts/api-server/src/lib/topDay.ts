/**
 * «Топ дня» — the desk's best and worst trader-days (owner decision 2026-10-18, DAILY_LOOP_2_BRIEF §5): a month calendar
 * of desk results, the top 10 trader-days by net profit and by net loss for one NY trading date, and one trader-day
 * opened by its day alias (tickers, $ per ticker, times) with links to the desk-day chart.
 *
 * Pure (no DB): lib/topDayStore.ts loads grouped rows, this file shapes the answer and applies the privacy policy:
 *   - staff (curator / admin, lib/playbookPrivacy)      → real names and every $;
 *   - trader, `privacy.hideNamesFromTraders` on (default) → anonymous: «Трейдер N» (lib/deskAliases) + every $, since
 *     nobody is identifiable; the viewer's own row is flagged `me`. The real name never leaves the server;
 *   - trader, setting off                              → named: names shown, other traders' $ hidden (the old rule:
 *     canSeeTradeMoney); counts, tickers and ranks stay.
 * Money = net (pnl − |fees|, lib/tradeMath). Unit-tested in __tests__/topDay.test.ts.
 */
import { deskAliases } from "./deskAliases";
import { canSeeTradeMoney, type MoneyViewer } from "./playbookPrivacy";

export const TOP_N = 10;

export type TopMode = "staff" | "anonymous" | "named";

export function topMode(viewer: MoneyViewer, hideNames: boolean): TopMode {
  if (viewer.staff) return "staff";
  return hideNames ? "anonymous" : "named";
}

/** May the viewer see the real name of a trader in this mode? (The viewer's own row is flagged `me` instead.) */
const showsNames = (mode: TopMode): boolean => mode !== "anonymous";

/** May the viewer see the $ of `trader`'s day in this mode? */
function seesMoney(mode: TopMode, viewer: MoneyViewer, trader: string): boolean {
  return mode === "named" ? canSeeTradeMoney(viewer, trader) : true;
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const int = (v: unknown): number => Math.trunc(num(v) ?? 0);
const round2 = (n: number): number => Math.round(n * 100) / 100;
const money = (n: number | null): number | null => (n == null ? null : round2(n));

// ─── Calendar ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** One row per trading date of the month (store: grouped by date over trader-days). */
export interface CalendarRow {
  date: string;
  net: unknown;
  trades: unknown;
  traders: unknown;
  best: unknown;
  worst: unknown;
  /** The viewer's own net that day (null when they did not trade). */
  mine: unknown;
  /** Did the viewer trade that day? */
  traded: unknown;
}

export interface CalendarDay {
  date: string;
  /** Desk net (null in the named mode for traders: an aggregate over other traders' money). */
  net: number | null;
  trades: number;
  traders: number;
  /** Best / worst trader-day net, no names (null in the named mode for traders). */
  best: number | null;
  worst: number | null;
  /** The viewer's own net that day; null when they did not trade. */
  mine: number | null;
}

export interface TopCalendar {
  month: string;
  mode: TopMode;
  days: CalendarDay[];
  /** Market holidays of the month (holiday_calendar type 'holiday'). */
  holidays: string[];
}

export function buildCalendar(month: string, rows: readonly CalendarRow[], holidays: readonly string[], mode: TopMode): TopCalendar {
  const deskMoney = mode !== "named";
  const days = rows
    .map((r): CalendarDay => ({
      date: String(r.date),
      net: deskMoney ? money(num(r.net)) : null,
      trades: int(r.trades),
      traders: int(r.traders),
      best: deskMoney ? money(num(r.best)) : null,
      worst: deskMoney ? money(num(r.worst)) : null,
      mine: r.traded ? money(num(r.mine) ?? 0) : null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { month, mode, days, holidays: [...new Set(holidays.map(String))].sort() };
}

// ─── Day: top 10 profit / loss ─────────────────────────────────────────────────────────────────────────────────────

/** One (trader, ticker) group of the day (store). */
export interface TraderTickerRow {
  trader: string;
  ticker: string;
  net: unknown;
  trades: unknown;
  wins: unknown;
  losses: unknown;
}

export interface TopTicker {
  ticker: string;
  trades: number;
  net: number | null;
}

export interface TopRow {
  /** Day alias (1..N over every trader active that day, lib/deskAliases). */
  alias: number;
  me: boolean;
  /** Real name: staff and the named mode only; null in the anonymous mode. */
  name: string | null;
  /** 1-based place in its list (profit or loss). */
  place: number;
  net: number | null;
  trades: number;
  wins: number;
  losses: number;
  tickers: TopTicker[];
  /** Ticker with the best net of the day (null when $ is hidden). */
  bestTicker: string | null;
}

export interface TopDay {
  date: string;
  mode: TopMode;
  desk: { net: number | null; trades: number; traders: number };
  profit: TopRow[];
  loss: TopRow[];
  /** The viewer's own day when they traded (also when outside both lists), else null. */
  me: TopRow | null;
}

interface TraderAgg {
  trader: string;
  net: number;
  trades: number;
  wins: number;
  losses: number;
  tickers: { ticker: string; trades: number; net: number }[];
}

/** Group (trader, ticker) rows into trader-days; tickers by net, best first. */
export function aggregateTraders(rows: readonly TraderTickerRow[]): TraderAgg[] {
  const by = new Map<string, TraderAgg>();
  for (const r of rows) {
    const name = String(r.trader ?? "");
    if (!name) continue;
    let a = by.get(name);
    if (!a) {
      a = { trader: name, net: 0, trades: 0, wins: 0, losses: 0, tickers: [] };
      by.set(name, a);
    }
    const net = num(r.net) ?? 0;
    const trades = int(r.trades);
    a.net += net;
    a.trades += trades;
    a.wins += int(r.wins);
    a.losses += int(r.losses);
    const tk = a.tickers.find((x) => x.ticker === r.ticker);
    if (tk) { tk.net += net; tk.trades += trades; }
    else a.tickers.push({ ticker: String(r.ticker), trades, net });
  }
  for (const a of by.values()) a.tickers.sort((x, y) => y.net - x.net || x.ticker.localeCompare(y.ticker));
  return [...by.values()];
}

function shapeRow(a: TraderAgg, place: number, aliases: ReadonlyMap<string, number>, viewer: MoneyViewer, mode: TopMode): TopRow {
  const me = !!viewer.name && a.trader === viewer.name;
  const $ = seesMoney(mode, viewer, a.trader);
  const tickers = $ ? a.tickers : [...a.tickers].sort((x, y) => y.trades - x.trades || x.ticker.localeCompare(y.ticker));
  return {
    alias: aliases.get(a.trader) ?? 0,
    me,
    name: showsNames(mode) ? a.trader : null,
    place,
    net: $ ? round2(a.net) : null,
    trades: a.trades,
    wins: a.wins,
    losses: a.losses,
    tickers: tickers.map((t) => ({ ticker: t.ticker, trades: t.trades, net: $ ? round2(t.net) : null })),
    bestTicker: $ && a.tickers.length && a.tickers[0].net > 0 ? a.tickers[0].ticker : null,
  };
}

/** Profit list (net > 0, best first) and loss list (net < 0, worst first), each cut to `n`. */
export function rankTraders(aggs: readonly TraderAgg[], n = TOP_N): { profit: TraderAgg[]; loss: TraderAgg[] } {
  const cmp = (x: TraderAgg, y: TraderAgg) => x.trader.localeCompare(y.trader);
  const profit = aggs.filter((a) => a.net > 0).sort((x, y) => y.net - x.net || cmp(x, y));
  const loss = aggs.filter((a) => a.net < 0).sort((x, y) => x.net - y.net || cmp(x, y));
  return { profit: profit.slice(0, n), loss: loss.slice(0, n) };
}

/** Full place of `trader` in the profit or loss order (1-based), regardless of the top-N cut. */
function fullPlace(aggs: readonly TraderAgg[], a: TraderAgg): number {
  const { profit, loss } = rankTraders(aggs, Number.MAX_SAFE_INTEGER);
  const list = a.net > 0 ? profit : loss;
  const i = list.findIndex((x) => x.trader === a.trader);
  return i >= 0 ? i + 1 : 0;
}

/**
 * `aliases`: the desk-wide day aliases (lib/deskDayStore.loadDayAliases — the same source as the desk-day chart); when
 * omitted they are numbered over the traders in `rows` (same roster: every live trader of the date).
 */
export function buildTopDay(
  date: string, rows: readonly TraderTickerRow[], viewer: MoneyViewer, mode: TopMode, n = TOP_N,
  aliases: ReadonlyMap<string, number> = deskAliases(rows.map((r) => String(r.trader ?? "")), date),
): TopDay {
  const aggs = aggregateTraders(rows);
  const { profit, loss } = rankTraders(aggs, n);
  const mine = viewer.name ? aggs.find((a) => a.trader === viewer.name) : undefined;
  const deskMoney = mode !== "named";
  return {
    date,
    mode,
    desk: {
      net: deskMoney ? round2(aggs.reduce((s, a) => s + a.net, 0)) : null,
      trades: aggs.reduce((s, a) => s + a.trades, 0),
      traders: aggs.length,
    },
    profit: profit.map((a, i) => shapeRow(a, i + 1, aliases, viewer, mode)),
    loss: loss.map((a, i) => shapeRow(a, i + 1, aliases, viewer, mode)),
    me: mine ? shapeRow(mine, fullPlace(aggs, mine), aliases, viewer, mode) : null,
  };
}

// ─── One trader-day by alias ───────────────────────────────────────────────────────────────────────────────────────

/** One (trader, ticker, side) group of the day with fill times (store). */
export interface TraderTickerSideRow extends TraderTickerRow {
  side: string | null;
  first_at: Date | string | null;
  last_at: Date | string | null;
}

export interface TraderDayTicker {
  ticker: string;
  side: "long" | "short" | "both";
  trades: number;
  wins: number;
  losses: number;
  net: number | null;
  /** First fill of the ticker that day / last fill (ISO, UTC). */
  firstAt: string | null;
  lastAt: string | null;
}

export interface TraderDay {
  date: string;
  mode: TopMode;
  alias: number;
  me: boolean;
  name: string | null;
  /** Which order `place` is in (sent even when $ is hidden, so the client can say «3rd by loss»). */
  list: "profit" | "loss" | "flat";
  /** Place in the profit list (net > 0) or the loss list (net < 0); 0 for a flat day. */
  place: number;
  net: number | null;
  trades: number;
  wins: number;
  losses: number;
  tickers: TraderDayTicker[];
}

const iso = (x: Date | string | null): string | null => {
  if (x == null) return null;
  const d = x instanceof Date ? x : new Date(x);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const sideOf = (s: string | null): "long" | "short" => ((s ?? "").toLowerCase().includes("short") ? "short" : "long");

/** The trader-day of `alias`, or null when no trader has that alias on `date`. */
export function buildTraderDay(
  date: string, alias: number, rows: readonly TraderTickerSideRow[], viewer: MoneyViewer, mode: TopMode,
  aliases: ReadonlyMap<string, number> = deskAliases(rows.map((r) => String(r.trader ?? "")), date),
): TraderDay | null {
  const aggs = aggregateTraders(rows);
  const trader = [...aliases].find(([, n]) => n === alias)?.[0];
  if (!trader) return null;
  const a = aggs.find((x) => x.trader === trader)!;
  const $ = seesMoney(mode, viewer, trader);

  const byTicker = new Map<string, TraderDayTicker & { netSum: number }>();
  for (const r of rows) {
    if (String(r.trader) !== trader) continue;
    const key = String(r.ticker);
    const side = sideOf(r.side);
    const first = iso(r.first_at), last = iso(r.last_at);
    const cur = byTicker.get(key);
    if (!cur) {
      byTicker.set(key, {
        ticker: key, side, trades: int(r.trades), wins: int(r.wins), losses: int(r.losses), net: null,
        netSum: num(r.net) ?? 0, firstAt: first, lastAt: last,
      });
      continue;
    }
    if (cur.side !== side) cur.side = "both";
    cur.trades += int(r.trades);
    cur.wins += int(r.wins);
    cur.losses += int(r.losses);
    cur.netSum += num(r.net) ?? 0;
    if (first && (!cur.firstAt || first < cur.firstAt)) cur.firstAt = first;
    if (last && (!cur.lastAt || last > cur.lastAt)) cur.lastAt = last;
  }
  const tickers = [...byTicker.values()]
    .sort((x, y) => (x.firstAt ?? "9").localeCompare(y.firstAt ?? "9") || x.ticker.localeCompare(y.ticker))
    .map(({ netSum, ...t }) => ({ ...t, net: $ ? round2(netSum) : null }));

  return {
    date,
    mode,
    alias,
    me: !!viewer.name && trader === viewer.name,
    name: showsNames(mode) ? trader : null,
    list: a.net > 0 ? "profit" : a.net < 0 ? "loss" : "flat",
    place: fullPlace(aggs, a),
    net: $ ? round2(a.net) : null,
    trades: a.trades,
    wins: a.wins,
    losses: a.losses,
    tickers,
  };
}
