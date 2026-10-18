// «Спроси журнал» — client-side filters and aggregation over the loaded trade book (pure, no React, no fetch).
// Money is net by default (net = pnl − |fees| via @/lib/trade-math); win rate = W/(W+L); PF null instead of ∞.
// Every sentence is rendered in the UI language (askI18n) at answer time; follow-up questions too (./phrases).

import { closeDate, computeKpis, feesOf, maxDrawdown, netPnl, num, resultOf, type TradeLike } from "@/lib/trade-math";
import type { TradeResult } from "@/lib/trade-result";
import { describeFilter, filterOf, weekdayOf, type AskDim, type AskFilter, type AskMetric, type AskQuery } from "./parse";
import {
  canonicalText, cap, describeSubject, fmtClock, fmtDuration, metricBy, metricName, monthIn, sideOne, sidePl, targetTitle, weekdayPhrase,
} from "./phrases";
import { fmtDate, fmtMonth, fmtNum, fmtRate, fmtUsd, fmtWeekday } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { askI18n } from "@/i18n/ns/ask";
import { personName } from "@/i18n";

const t = askI18n.t;
const nTrades = (n: number) => commonI18n.t("units.trades", { count: n });

export interface AskTrade extends TradeLike {
  id: number;
  ticker: string;
  date: string;
  side?: string | null;
  trader?: string | null;
  setup?: string | null;
  holdTime?: string | null;
  qty?: number | string | null;
  contextSnapshot?: unknown;
}

// ── Per-trade derived fields ──────────────────────────────────────────────────

function snap(t: AskTrade): Record<string, unknown> | null {
  const s = t.contextSnapshot;
  return s && typeof s === "object" ? (s as Record<string, unknown>) : null;
}

const CLOCK_RE = /T(\d{2}):(\d{2})/;

/** ET entry time in minutes since midnight (PropReports `openedAt` is an ET wall-clock timestamp). */
export function entryMinutes(t: AskTrade): number | null {
  const opened = snap(t)?.openedAt;
  if (typeof opened !== "string") return null;
  const m = CLOCK_RE.exec(opened);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** «2h 29m», «17s», «1m», «1d 2h» → seconds (PropReports text; the Cyrillic units are legacy rows). */
export function parseHoldTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const rx = /(\d+(?:\.\d+)?)\s*(d|h|m|s|д|ч|м|с)/gi; // i18n-ignore (data units)
  let total = 0, any = false, m: RegExpExecArray | null;
  while ((m = rx.exec(s))) {
    any = true;
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    total += n * (u === "d" || u === "д" ? 86400 : u === "h" || u === "ч" ? 3600 : u === "m" || u === "м" ? 60 : 1); // i18n-ignore (data units)
  }
  return any ? total : null;
}

/** Hold in seconds: openedAt→closedAt when both exist, else the `holdTime` text. */
export function holdSeconds(t: AskTrade): number | null {
  const s = snap(t);
  const o = s?.openedAt, c = s?.closedAt;
  if (typeof o === "string" && typeof c === "string") {
    const d = (Date.parse(`${c}Z`) - Date.parse(`${o}Z`)) / 1000;
    if (Number.isFinite(d) && d >= 0) return d;
  }
  return parseHoldTime(t.holdTime);
}

export function qtyOf(t: AskTrade): number | null {
  const q = num(t.qty) ?? num(snap(t)?.qty);
  return q == null ? null : Math.abs(q);
}

const dayOf = (t: AskTrade) => closeDate(t) ?? t.date;

// ── Book index (chronology, «после убытка») ───────────────────────────────────

export interface TradeMeta {
  min: number | null;
  hold: number | null;
  qty: number | null;
  day: string;
  wd: number;
  /** Results of the same trader's earlier trades that day, most recent first. */
  prev: TradeResult[];
  /** Chronological rank in the whole book. */
  rank: number;
}

export type BookIndex = Map<number, TradeMeta>;

export function chronoKey(t: AskTrade): string {
  const m = entryMinutes(t);
  return `${t.date}|${m == null ? "9999" : String(m).padStart(4, "0")}|${String(t.id).padStart(9, "0")}`;
}

export function indexBook(trades: AskTrade[]): BookIndex {
  const sorted = [...trades].sort((a, b) => chronoKey(a).localeCompare(chronoKey(b)));
  const idx: BookIndex = new Map();
  const lastByTraderDay = new Map<string, TradeResult[]>();
  sorted.forEach((t, rank) => {
    const day = dayOf(t);
    const k = `${t.trader ?? ""}|${t.date}`;
    const prev = lastByTraderDay.get(k) ?? [];
    idx.set(t.id, { min: entryMinutes(t), hold: holdSeconds(t), qty: qtyOf(t), day, wd: weekdayOf(day), prev: prev.slice(0, 10), rank });
    lastByTraderDay.set(k, [resultOf(t), ...prev]);
  });
  return idx;
}

function metaOf(idx: BookIndex, t: AskTrade): TradeMeta {
  return idx.get(t.id) ?? { min: entryMinutes(t), hold: holdSeconds(t), qty: qtyOf(t), day: dayOf(t), wd: weekdayOf(dayOf(t)), prev: [], rank: t.id };
}

// ── Filters ───────────────────────────────────────────────────────────────────

export interface FilterOutcome {
  kept: AskTrade[];
  /** Trades dropped because a filter needs a field they do not have. */
  noTime: number;
  noHold: number;
  noPrice: number;
  noQty: number;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").trim(); // i18n-ignore (ё → е)

export function applyFilter(trades: AskTrade[], f: AskFilter, idx: BookIndex): FilterOutcome {
  let noTime = 0, noHold = 0, noPrice = 0, noQty = 0;
  const tickers = f.tickers.length ? new Set(f.tickers) : null;
  const setups = f.setups.length ? f.setups.map(norm) : null;
  const wds = f.weekdays ? new Set(f.weekdays) : null;
  let kept = trades.filter((t) => {
    if (f.trader && t.trader !== f.trader) return false;
    if (tickers && !tickers.has((t.ticker ?? "").toUpperCase())) return false;
    if (setups) {
      const s = norm(t.setup ?? "");
      if (!s || !setups.some((x) => s === x || s.includes(x))) return false;
    }
    if (f.side && f.side !== t.side) return false;
    if (f.outcome) {
      const r = resultOf(t);
      if ((f.outcome === "breakeven" ? "be" : f.outcome) !== r) return false;
    }
    const m = metaOf(idx, t);
    if (f.date && (m.day < f.date.from || m.day > f.date.to)) return false;
    if (wds && !wds.has(m.wd)) return false;
    if (f.time) {
      if (m.min == null) { noTime++; return false; }
      if (f.time.fromMin != null && m.min < f.time.fromMin) return false;
      if (f.time.toMin != null && m.min >= f.time.toMin) return false;
    }
    if (f.price) {
      const p = num(t.entry);
      if (p == null) { noPrice++; return false; }
      if (f.price.min != null && p < f.price.min) return false;
      if (f.price.max != null && p > f.price.max) return false;
    }
    if (f.holdSec) {
      if (m.hold == null) { noHold++; return false; }
      if (f.holdSec.min != null && m.hold <= f.holdSec.min) return false;
      if (f.holdSec.max != null && m.hold >= f.holdSec.max) return false;
    }
    if (f.qty) {
      if (m.qty == null) { noQty++; return false; }
      if (f.qty.min != null && m.qty < f.qty.min) return false;
      if (f.qty.max != null && m.qty >= f.qty.max) return false;
    }
    if (f.after) {
      const p = m.prev.slice(0, f.after.n);
      if (p.length < f.after.n || !p.every((r) => r === f.after!.kind)) return false;
    }
    return true;
  });
  if (f.lastN) {
    kept = [...kept].sort((a, b) => metaOf(idx, a).rank - metaOf(idx, b).rank).slice(-f.lastN);
  }
  return { kept, noTime, noHold, noPrice, noQty };
}

/** Filters the trades page cannot apply from its own URL params (⇒ the link carries ids). */
export function needsIds(f: AskFilter): boolean {
  return Boolean(f.time || f.price || f.holdSec || f.qty || f.after || f.lastN || f.weekdays || f.tickers.length > 1 || f.setups.length > 1);
}

// ── Aggregation ───────────────────────────────────────────────────────────────

export interface Agg {
  key: string;
  label: string;
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  net: number | null;
  gross: number | null;
  fees: number;
  avgNet: number | null;
  /** Σ net⁺ / |Σ net⁻|; null when there are no losing $ (never ∞). */
  pf: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  avgHold: number | null;
  /** Follow-up question that narrows the query to this row. */
  ask?: string;
  /** Trades of the row (kept for drill-down). */
  ids?: number[];
}

export function aggOf(trades: AskTrade[], key = "all", label = "", idx?: BookIndex): Agg {
  const k = computeKpis(trades);
  let pos = 0, neg = 0, nPos = 0, nNeg = 0, holdSum = 0, holdN = 0;
  for (const t of trades) {
    const n = netPnl(t);
    if (n != null) {
      if (n > 0) { pos += n; nPos++; } else if (n < 0) { neg += n; nNeg++; }
    }
    const h = idx ? metaOf(idx, t).hold : holdSeconds(t);
    if (h != null) { holdSum += h; holdN++; }
  }
  return {
    key, label,
    n: trades.length,
    wins: k.wins, losses: k.losses,
    winRate: k.winRate,
    net: k.netPnl,
    gross: k.grossPnl,
    fees: trades.reduce((s, t) => s + feesOf(t), 0),
    avgNet: k.netPnl != null && k.pnlCount ? k.netPnl / k.pnlCount : null,
    pf: neg < 0 ? pos / Math.abs(neg) : null,
    avgWin: nPos ? pos / nPos : null,
    avgLoss: nNeg ? neg / nNeg : null,
    avgHold: holdN ? holdSum / holdN : null,
    ids: trades.map((t) => t.id),
  };
}

export function metricValue(r: Agg, metric: AskMetric): number | null {
  switch (metric) {
    case "winRate": return r.winRate;
    case "n": return r.n;
    case "fees": return r.fees;
    case "avg": return r.avgNet;
    case "pf": return r.pf;
    default: return r.net;
  }
}

export function fmtMetric(v: number | null | undefined, metric: AskMetric): string {
  if (v == null) return "—";
  switch (metric) {
    case "winRate": return fmtRate(v);
    case "n": return String(v);
    case "fees": return fmtUsd(v);
    case "pf": return fmtNum(v);
    default: return fmtUsd(v, { signed: true });
  }
}

/** Group label for a Monday-first weekday index (0 = Mon): short weekday in the UI language. */
function wdLabel(wd: number): string {
  return cap(fmtWeekday((wd + 1) % 7, "short"));
}

function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - wd);
  return d.toISOString().slice(0, 10);
}
function plusDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** dd.MM (tables). */
export const dm = (date: string) => fmtDate(date.slice(0, 10), "dayMonthNumeric");
/** dd.MM.yyyy. */
export const dmy = (date: string) => fmtDate(date.slice(0, 10), "short");

type SlotKey = "0" | "1" | "2" | "3" | "4" | "5" | "6";
type BucketKey = "0" | "1" | "2" | "3" | "4";
/** Time-of-day slots (ET); label and follow-up question in the UI language (slotLabel / slotAsk). */
export const SLOTS: Array<{ key: SlotKey; from: number; to: number }> = [
  { key: "0", from: 0, to: 570 }, { key: "1", from: 570, to: 600 }, { key: "2", from: 600, to: 660 }, { key: "3", from: 660, to: 840 },
  { key: "4", from: 840, to: 900 }, { key: "5", from: 900, to: 960 }, { key: "6", from: 960, to: 1440 },
];
export const HOLD_BUCKETS: Array<{ key: BucketKey; max: number }> = [
  { key: "0", max: 60 }, { key: "1", max: 300 }, { key: "2", max: 900 }, { key: "3", max: 3600 }, { key: "4", max: Infinity },
];
export const SIZE_BUCKETS: Array<{ key: BucketKey; max: number }> = [
  { key: "0", max: 50 }, { key: "1", max: 100 }, { key: "2", max: 200 }, { key: "3", max: 500 }, { key: "4", max: Infinity },
];
function slotAsk(k: SlotKey): string {
  switch (k) {
    case "0": return t("q.premarket");
    case "1": return t("q.open");
    case "2": return t("q.timeRange", { from: "10:00", to: "11:00" });
    case "3": return t("q.lunch");
    case "4": return t("q.timeRange", { from: "14:00", to: "15:00" });
    case "5": return t("q.powerHour");
    default: return t("q.postmarket");
  }
}

/** Group key + label + follow-up phrase (sortable key: chronological dims sort by key). */
export function groupKey(tr: AskTrade, dim: AskDim, idx: BookIndex): { key: string; label: string; ask: string } | null {
  const m = metaOf(idx, tr);
  switch (dim) {
    case "ticker": { const k = (tr.ticker ?? "—").toUpperCase(); return { key: k, label: k, ask: k }; }
    case "day": return m.day ? { key: m.day, label: `${wdLabel(m.wd)}, ${dmy(m.day)}`, ask: m.day } : null;
    case "hour": {
      if (m.min == null) return null;
      const h = Math.floor(m.min / 60);
      const range = { from: fmtClock(h * 60), to: fmtClock((h + 1) * 60) };
      return { key: String(h).padStart(2, "0"), label: `${range.from}–${range.to}`, ask: t("q.timeRange", range) };
    }
    case "weekday": return { key: String(m.wd), label: wdLabel(m.wd), ask: weekdayPhrase([m.wd]) };
    case "month": {
      const mo = Number(m.day.slice(5, 7));
      return { key: m.day.slice(0, 7), label: `${fmtMonth(mo - 1, "short")} ${m.day.slice(0, 4)}`, ask: t("q.monthYear", { monthIn: monthIn(mo), year: m.day.slice(0, 4) }) };
    }
    case "week": {
      const mon = mondayOf(m.day), fri = plusDays(mon, 4);
      return { key: mon, label: t("weekLabel", { from: dm(mon), to: dm(fri) }), ask: t("q.isoRange", { from: mon, to: fri }) };
    }
    case "side": { const s = tr.side === "Long" ? "Long" : tr.side === "Short" ? "Short" : null; return s ? { key: s, label: sideOne(s), ask: sidePl(s) } : null; }
    case "trade": return { key: String(tr.id), label: `${tr.ticker} ${dm(tr.date)}`, ask: tr.ticker };
    case "setup": { const s = (tr.setup ?? "").trim(); return s ? { key: s.toLowerCase(), label: s, ask: t("q.setup", { name: s }) } : { key: "—", label: t("noSetup"), ask: "" }; }
    case "trader": return tr.trader ? { key: tr.trader, label: personName(tr.trader), ask: tr.trader } : null;
    case "slot": {
      if (m.min == null) return null;
      const s = SLOTS.find((x) => m.min! >= x.from && m.min! < x.to) ?? SLOTS[SLOTS.length - 1];
      return { key: s.key, label: t(`slot.s${s.key}`), ask: slotAsk(s.key) };
    }
    case "holdBucket": {
      if (m.hold == null) return null;
      const b = HOLD_BUCKETS.find((x) => m.hold! < x.max)!;
      return { key: b.key, label: t(`holdBucket.b${b.key}`), ask: t(`q.hold.b${b.key}`) };
    }
    case "sizeBucket": {
      if (m.qty == null) return null;
      const b = SIZE_BUCKETS.find((x) => m.qty! < x.max)!;
      return { key: b.key, label: t(`sizeBucket.b${b.key}`), ask: t(`q.size.b${b.key}`) };
    }
  }
}

export function groupTrades(trades: AskTrade[], dim: AskDim, idx: BookIndex): Agg[] {
  const buckets = new Map<string, { label: string; ask: string; items: AskTrade[] }>();
  for (const tr of trades) {
    const g = groupKey(tr, dim, idx);
    if (!g) continue;
    const b = buckets.get(g.key) ?? { label: g.label, ask: g.ask, items: [] };
    b.items.push(tr);
    buckets.set(g.key, b);
  }
  return [...buckets.entries()].map(([key, b]) => ({ ...aggOf(b.items, key, b.label, idx), ask: b.ask }));
}

const CHRONO: ReadonlySet<AskDim> = new Set(["day", "hour", "weekday", "month", "week", "slot", "holdBucket", "sizeBucket"]);

// Follow-up questions round-trip through the parser: canonicalText lives in ./phrases (UI language).
export { canonicalText };

// ── Answer ────────────────────────────────────────────────────────────────────

export interface AskStat { label: string; value: string; tone?: number | null; hint?: string }

export interface AskLinkParams {
  trader?: string;
  ticker?: string;
  setup?: string;
  date?: string;
  from?: string;
  to?: string;
  side?: "Long" | "Short";
  outcome?: "win" | "loss" | "breakeven";
  ids?: number[];
}

export type AskChart =
  | { type: "equity"; title: string; points: Array<{ i: number; v: number; label: string }> }
  | { type: "bars"; title: string; metric: AskMetric; rows: Array<{ key: string; label: string; value: number; highlight?: boolean; ask?: string }> }
  | { type: "hist"; title: string; bins: Array<{ label: string; value: number; tone: "up" | "down" | "neutral" }> };

export interface AskGroups {
  dim: AskDim | "insight";
  title: string;
  rows: Agg[];
  highlight?: string[];
  metric: AskMetric;
}

export type AskAnswerKind = "summary" | "groups" | "compare" | "top" | "streak" | "insight" | "empty";

export interface AskAnswer {
  kind: AskAnswerKind;
  subject: string;
  /** One or two short sentences: the conclusion. */
  headline: string;
  big: { label: string; value: string; tone: number | null; sub?: string };
  stats: AskStat[];
  chart: AskChart | null;
  groups: AskGroups | null;
  /** All trades the answer is about (virtualised list). */
  trades: AskTrade[];
  tradesTitle: string;
  /** Sort the list by net instead of time (best/worst trade). */
  tradesByPnl?: boolean;
  link: AskLinkParams;
  linkLabel: string;
  notes: string[];
  /** Trades matched by the filter / trades in scope. */
  matched: number;
  total: number;
  empty: boolean;
}

export interface AnswerMeta {
  truncated?: boolean;
  /** Max ids carried into the trades link when client-only filters were applied. */
  maxLinkIds?: number;
  /** Book size in scope (for «N из M»). */
  total?: number;
}

const dimTitle = (d: AskDim) => t(`dim.${d}`);
const byMetric = (title: string, metric: AskMetric) => `${title} — ${metricBy(metric)}`;

export const MAX_LINK_IDS = 400;

function baseLink(f: AskFilter, kept: AskTrade[], maxIds: number): { link: AskLinkParams; note?: string } {
  const link: AskLinkParams = {};
  if (f.trader) link.trader = f.trader;
  if (f.tickers.length === 1) link.ticker = f.tickers[0];
  if (f.setups.length === 1) link.setup = f.setups[0];
  if (f.side) link.side = f.side;
  if (f.outcome) link.outcome = f.outcome;
  if (f.date) {
    if (f.date.from === f.date.to) link.date = f.date.from;
    else { link.from = f.date.from; link.to = f.date.to; }
  }
  if (needsIds(f) && kept.length) {
    if (kept.length <= maxIds) link.ids = kept.map((tr) => tr.id);
    else return { link, note: t("ans.linkNote", { max: maxIds }) };
  }
  return { link };
}

function sortChrono(trades: AskTrade[], idx: BookIndex, desc = true): AskTrade[] {
  const s = [...trades].sort((a, b) => metaOf(idx, a).rank - metaOf(idx, b).rank);
  return desc ? s.reverse() : s;
}

function equityChart(trades: AskTrade[], idx: BookIndex): AskChart | null {
  const title = t("ans.equity");
  const s = sortChrono(trades, idx, false).filter((tr) => netPnl(tr) != null);
  if (s.length < 2) return null;
  let cum = 0;
  const pts = s.map((tr, i) => { cum += netPnl(tr)!; return { i: i + 1, v: Math.round(cum * 100) / 100, label: `${tr.ticker} · ${dm(tr.date)}` }; });
  // Downsample to ≤ 300 points (keep the last one).
  if (pts.length > 300) {
    const step = Math.ceil(pts.length / 300);
    return { type: "equity", title, points: pts.filter((_, i) => i % step === 0 || i === pts.length - 1) };
  }
  return { type: "equity", title, points: pts };
}

function netHist(trades: AskTrade[]): AskChart | null {
  const vals = trades.map((tr) => netPnl(tr)).filter((v): v is number => v != null);
  if (vals.length < 3) return null;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) return null;
  const bins = 12;
  const w = (hi - lo) / bins;
  const counts = new Array(bins).fill(0);
  for (const v of vals) counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++;
  return {
    type: "hist",
    title: t("ans.hist"),
    bins: counts.map((c, i) => {
      const a = lo + i * w, b = a + w;
      return { label: `${fmtUsd(a, { signed: true })} … ${fmtUsd(b, { signed: true })}`, value: c, tone: b <= 0 ? "down" : a >= 0 ? "up" : "neutral" };
    }),
  };
}

function barsFrom(rows: Agg[], metric: AskMetric, title: string, highlight: string[] = []): AskChart | null {
  const r = rows.filter((x) => metricValue(x, metric) != null).slice(0, 16);
  if (!r.length) return null;
  return { type: "bars", title, metric, rows: r.map((x) => ({ key: x.key, label: x.label, value: metricValue(x, metric)!, highlight: highlight.includes(x.key), ask: x.ask })) };
}

function bucketHist(trades: AskTrade[], dim: AskDim, idx: BookIndex, title: string): AskChart | null {
  const rows = groupTrades(trades, dim, idx).sort((a, b) => a.key.localeCompare(b.key));
  if (rows.length < 2) return null;
  return { type: "hist", title, bins: rows.map((r) => ({ label: r.label, value: r.n, tone: (r.net ?? 0) > 0 ? "up" : (r.net ?? 0) < 0 ? "down" : "neutral" })) };
}

function statsOf(a: Agg): AskStat[] {
  const s: AskStat[] = [
    { label: t("ans.stTrades"), value: String(a.n) },
    { label: t("ans.stNet"), value: fmtUsd(a.net, { signed: true }), tone: a.net, hint: t("ans.stNetHint") },
    { label: t("ans.stWinRate"), value: fmtRate(a.winRate), hint: `W/(W+L): ${a.wins}W / ${a.losses}L` },
    { label: t("ans.stFees"), value: fmtUsd(a.fees) },
    { label: t("ans.stAvg"), value: fmtUsd(a.avgNet, { signed: true }), tone: a.avgNet },
    { label: t("ans.stPf"), value: a.pf == null ? "—" : fmtNum(a.pf), hint: t("ans.stPfHint") },
    { label: t("ans.stAvgWinLoss"), value: a.avgWin != null || a.avgLoss != null ? `${fmtUsd(a.avgWin, { signed: true })} / ${fmtUsd(a.avgLoss, { signed: true })}` : "—" },
    { label: t("ans.stHold"), value: a.avgHold == null ? "—" : fmtDuration(a.avgHold) },
  ];
  return s.filter((x) => x.value !== "—" && x.value !== "— / —");
}

/** One extra sentence worth saying about a set of trades (fees eating the edge, payoff). */
function takeaway(a: Agg): string | null {
  if (a.n < 3) return null;
  if (a.gross != null && a.gross > 0 && a.fees / a.gross >= 0.5) return t("ans.tkFees", { share: fmtRate(a.fees / a.gross) });
  if (a.gross != null && a.gross > 0 && (a.net ?? 0) < 0) return t("ans.tkGross", { gross: fmtUsd(a.gross, { signed: true }) });
  if (a.avgWin != null && a.avgLoss != null && a.winRate != null) {
    const payoff = a.avgWin / Math.abs(a.avgLoss);
    if (a.winRate >= 0.5 && payoff < 0.8) return t("ans.tkPayoff", { loss: fmtUsd(a.avgLoss, { signed: true }), win: fmtUsd(a.avgWin, { signed: true }) });
    if (a.winRate < 0.5 && payoff > 1.3) return t("ans.tkLowWr", { x: payoff.toFixed(1) });
  }
  return null;
}

function statLine(a: Agg): string {
  return t("ans.statLine", { trades: nTrades(a.n), net: fmtUsd(a.net, { signed: true }), wr: fmtRate(a.winRate) });
}

/** Smallest group size worth ranking (no «100% винрейт» from one trade). */
function minGroupN(total: number, metric: AskMetric, dim: AskDim | "insight"): number {
  if (dim === "trade") return 1;
  if (metric === "net" || metric === "n" || metric === "fees") return dim === "insight" ? Math.max(5, Math.ceil(total * 0.03)) : 1;
  return Math.max(3, Math.ceil(total * 0.02));
}

function rankRows(rows: Agg[], metric: AskMetric, best: boolean): Agg[] {
  // For fees «worst» = most fees; for everything else «best» = highest value.
  const desc = metric === "fees" ? !best : best;
  return [...rows]
    .filter((r) => metricValue(r, metric) != null)
    .sort((x, y) => (desc ? metricValue(y, metric)! - metricValue(x, metric)! : metricValue(x, metric)! - metricValue(y, metric)!) || y.n - x.n);
}

interface Ctx { q: AskQuery; f: AskFilter; idx: BookIndex; maxIds: number; total: number; notes: string[] }
type Base = Omit<AskAnswer, "kind" | "headline" | "big" | "chart" | "groups" | "trades" | "tradesTitle">;

function emptyAnswer(subject: string, c: Ctx, link: AskLinkParams, headline?: string): AskAnswer {
  return {
    kind: "empty", subject, headline: headline ?? t("ans.empty", { subject }), big: { label: t("ans.stTrades"), value: "0", tone: null },
    stats: [], chart: null, groups: null, trades: [], tradesTitle: t("ans.tradesTitle"), link, linkLabel: t("ans.open"),
    notes: c.notes, matched: 0, total: c.total, empty: true,
  };
}

function topAnswer(q: AskQuery, trades: AskTrade[], c: Ctx, base: Base, listed: AskTrade[]): AskAnswer {
  const { idx, f, maxIds, notes } = c;
  const link = base.link;
  const subject = base.subject;
  const target = q.target!;
  const intent = q.intent as "best" | "worst";
  const best = intent === "best";
  const metric = q.metric;
  const N = Math.max(1, q.topN);
  if (target === "trade") {
    const withPnl = trades.filter((tr) => netPnl(tr) != null);
    const sorted = [...withPnl].sort((x, y) => (best ? netPnl(y)! - netPnl(x)! : netPnl(x)! - netPnl(y)!));
    const top = sorted[0];
    if (!top) return emptyAnswer(subject, c, link, t("ans.noPnl", { subject }));
    const n = netPnl(top)!;
    const topList = sorted.slice(0, Math.max(N, 10));
    const list = `${sorted.slice(0, 3).map((tr) => `${tr.ticker} ${dm(tr.date)} ${fmtUsd(netPnl(tr), { signed: true })}`).join(", ")}${N > 3 ? "…" : ""}`;
    const one = { ticker: top.ticker, date: dmy(top.date), net: fmtUsd(n, { signed: true }) };
    const side = top.side === "Short" || top.side === "Long" ? sideOne(top.side) : null;
    const head = N > 1
      ? t(best ? "ans.bestTrades" : "ans.worstTrades", { count: N, list })
      : side ? t("ans.oneTrade", { ...one, side }) : t("ans.oneTradeNoSide", one);
    return {
      ...base, kind: "top", headline: head,
      big: { label: `${targetTitle(intent, "trade")}: ${top.ticker} · ${dm(top.date)}`, value: fmtUsd(n, { signed: true }), tone: n },
      chart: { type: "bars", title: best ? t("ans.topTradesChart") : t("ans.worstTradesChart"), metric: "net", rows: topList.map((tr) => ({ key: String(tr.id), label: `${tr.ticker} ${dm(tr.date)}`, value: netPnl(tr)!, highlight: sorted.indexOf(tr) < N })) },
      groups: null, trades: topList, tradesTitle: N > 1 ? t("ans.topN", { n: topList.length }) : t("ans.tradeAndNext"), tradesByPnl: true,
      link: { ...link, ids: sorted.slice(0, N).map((tr) => tr.id) }, linkLabel: N > 1 ? t("ans.openN", { count: N }) : t("ans.openTrade"),
    };
  }
  const minN = minGroupN(trades.length, metric, target);
  const rowsAll = groupTrades(trades, target, idx);
  const rows = rankRows(rowsAll.filter((r) => r.n >= minN), metric, best);
  if (minN > 1 && rowsAll.some((r) => r.n < minN)) notes.push(t("ans.minGroup", { count: minN, metric: metricBy(metric) }));
  const top = rows[0];
  if (!top) return emptyAnswer(subject, c, link, t("ans.fewData", { subject }));
  const topRows = rows.slice(0, N);
  const hl = topRows.map((r) => r.key);
  const topIds = new Set(topRows.flatMap((r) => r.ids ?? []));
  const v = metricValue(top, metric);
  const titlePl = targetTitle(intent, target, true), title1 = targetTitle(intent, target);
  const head = N > 1
    ? `${titlePl}: ${topRows.slice(0, 3).map((r) => `${r.label} ${fmtMetric(metricValue(r, metric), metric)}`).join(", ")}${N > 3 ? "…" : ""}`
    : t("ans.top1", { title: title1, label: top.label, metric: metricName(metric), value: fmtMetric(v, metric), stats: statLine(top) });
  const narrowed: AskLinkParams = { ...link };
  delete narrowed.ids;
  if (N === 1 && target === "ticker") narrowed.ticker = top.key;
  else if (N === 1 && target === "day") { narrowed.date = top.key; delete narrowed.from; delete narrowed.to; }
  else if (N === 1 && target === "side") narrowed.side = top.key as "Long" | "Short";
  else if (N === 1 && target === "trader") narrowed.trader = top.key;
  if (needsIds(f) || !(N === 1 && ["ticker", "day", "side", "trader"].includes(target))) {
    if (topIds.size <= maxIds) narrowed.ids = [...topIds];
  }
  const showRows = CHRONO.has(target) && rows.length <= 12 ? [...rows].sort((a, b) => a.key.localeCompare(b.key)) : rows.slice(0, 15);
  return {
    ...base, kind: "top", headline: head,
    big: { label: N > 1 ? t("ans.bigTopN", { title: titlePl, label: top.label }) : `${title1}: ${top.label}`, value: fmtMetric(v, metric), tone: metric === "net" || metric === "avg" ? v : null, sub: statLine(top) },
    chart: barsFrom(showRows, metric, byMetric(dimTitle(target), metric), hl),
    groups: { dim: target, title: t(best ? "ans.groupsBest" : "ans.groupsWorst", { dim: dimTitle(target), metric: metricBy(metric) }), rows: rows.slice(0, 24), highlight: hl, metric },
    trades: listed.filter((tr) => topIds.has(tr.id)), tradesTitle: N > 1 ? t("ans.topNTrades", { n: N }) : t("ans.tradesOf", { label: top.label }),
    link: narrowed, linkLabel: N > 1 ? t("ans.openTopN", { n: N }) : t("ans.openLabel", { label: top.label }),
  };
}

export function buildAnswer(q: AskQuery, f: AskFilter, trades: AskTrade[], idx: BookIndex, meta: AnswerMeta & Partial<FilterOutcome> = {}): AskAnswer {
  const subject = describeSubject({ ...q, ...f });
  const maxIds = meta.maxLinkIds ?? MAX_LINK_IDS;
  const total = meta.total ?? trades.length;
  const { link, note } = baseLink(f, trades, maxIds);
  const notes: string[] = [];
  if (note) notes.push(note);
  if (meta.noTime) notes.push(t("ans.noTime", { count: meta.noTime }));
  if (meta.noHold) notes.push(t("ans.noHold", { count: meta.noHold }));
  if (meta.noPrice) notes.push(t("ans.noPrice", { count: meta.noPrice }));
  if (meta.noQty) notes.push(t("ans.noQty", { count: meta.noQty }));
  if (meta.truncated) notes.push(t("ans.truncated"));
  const c: Ctx = { q, f, idx, maxIds, total, notes };

  if (!trades.length) return emptyAnswer(subject, c, link);

  const all = aggOf(trades, "all", t("ans.all"), idx);
  const stats = statsOf(all);
  const base: Base = { subject, stats, link, linkLabel: t("ans.openFiltered"), notes, matched: trades.length, total, empty: false };
  const listed = sortChrono(trades, idx);

  if ((q.intent === "best" || q.intent === "worst") && q.target) return topAnswer(q, trades, c, base, listed);
  if (q.intent === "streak") return streakAnswer(q, trades, c, base, all);
  if (q.intent === "insight") return insightAnswer(q, trades, c, base);

  // ── list / count / sum / avg / winrate / fees / pf / hold / size / drawdown ──
  let big: AskAnswer["big"];
  let headline = t("ans.summary", { subject, stats: statLine(all) });
  let chart: AskChart | null = equityChart(trades, idx);
  const sNet = fmtUsd(all.net, { signed: true }), sGross = fmtUsd(all.gross, { signed: true }), sWr = fmtRate(all.winRate);
  switch (q.intent) {
    case "count": big = { label: t("ans.stTrades"), value: String(all.n), tone: null, sub: `${all.wins}W / ${all.losses}L` }; break;
    case "winrate":
      big = { label: t("ans.wrLabel"), value: sWr, tone: null, sub: t("ans.wrSub", { w: all.wins, l: all.losses }) };
      headline = t("ans.wrHead", { subject, wr: sWr, w: all.wins, n: all.wins + all.losses });
      chart = netHist(trades) ?? chart;
      break;
    case "fees": {
      const share = all.gross != null && all.gross > 0 ? all.fees / all.gross : null;
      big = { label: t("ans.feesLabel"), value: fmtUsd(all.fees), tone: null, sub: share != null ? t("ans.feesShare", { share: fmtRate(share), gross: sGross }) : t("ans.feesGross", { gross: sGross }) };
      headline = share != null
        ? t("ans.feesHead", { fees: fmtUsd(all.fees), share: fmtRate(share), gross: sGross, net: sNet, avg: fmtUsd(all.n ? all.fees / all.n : null) })
        : t("ans.feesHeadNoGross", { subject, fees: fmtUsd(all.fees), trades: nTrades(all.n), gross: sGross, net: sNet });
      const span = trades.length ? new Set(trades.map((tr) => metaOf(idx, tr).day.slice(0, 7))).size : 0;
      const rows = groupTrades(trades, span > 1 ? "month" : "day", idx).sort((a, b) => a.key.localeCompare(b.key));
      chart = barsFrom(rows, "fees", span > 1 ? t("ans.feesByMonth") : t("ans.feesByDay"));
      break;
    }
    case "avg":
      big = { label: t("ans.avgLabel"), value: fmtUsd(all.avgNet, { signed: true }), tone: all.avgNet, sub: t("ans.avgSub", { win: fmtUsd(all.avgWin, { signed: true }), loss: fmtUsd(all.avgLoss, { signed: true }) }) };
      headline = t("ans.avgHead", { subject, avg: fmtUsd(all.avgNet, { signed: true }), trades: nTrades(all.n), wr: sWr });
      chart = netHist(trades) ?? chart;
      break;
    case "pf":
      big = { label: t("ans.pfLabel"), value: all.pf == null ? "—" : fmtNum(all.pf), tone: all.pf == null ? null : all.pf - 1, sub: t("ans.stPfHint") };
      headline = all.pf == null ? t("ans.pfNone", { subject }) : t("ans.pfHead", { subject, pf: fmtNum(all.pf) });
      break;
    case "hold": {
      const holds = trades.map((tr) => metaOf(idx, tr).hold).filter((h): h is number => h != null).sort((a, b) => a - b);
      const med = holds.length ? holds[Math.floor(holds.length / 2)] : null;
      const d = all.avgHold == null ? "—" : fmtDuration(all.avgHold);
      big = { label: t("ans.holdLabel"), value: d, tone: null, sub: med != null ? t("ans.holdMedian", { d: fmtDuration(med) }) : undefined };
      const wins = trades.filter((tr) => resultOf(tr) === "win"), losses = trades.filter((tr) => resultOf(tr) === "loss");
      const aw = aggOf(wins, "w", "w", idx).avgHold, al = aggOf(losses, "l", "l", idx).avgHold;
      headline = aw != null && al != null ? t("ans.holdHeadSplit", { subject, d, win: fmtDuration(aw), loss: fmtDuration(al) }) : t("ans.holdHead", { subject, d });
      chart = bucketHist(trades, "holdBucket", idx, t("ans.holdChart")) ?? chart;
      break;
    }
    case "size": {
      const qs = trades.map((tr) => metaOf(idx, tr).qty).filter((x): x is number => x != null);
      const avg = qs.length ? qs.reduce((s, x) => s + x, 0) / qs.length : null;
      big = { label: t("ans.sizeLabel"), value: avg == null ? "—" : t("ph.shares", { n: Math.round(avg) }), tone: null, sub: qs.length ? t("ans.sizeRange", { min: Math.min(...qs), max: Math.max(...qs) }) : undefined };
      headline = t("ans.sizeHead", { subject, n: avg == null ? "—" : Math.round(avg), trades: nTrades(all.n) });
      chart = bucketHist(trades, "sizeBucket", idx, t("ans.sizeChart")) ?? chart;
      break;
    }
    case "drawdown": {
      const s = sortChrono(trades, idx, false).map((tr) => netPnl(tr)).filter((v): v is number => v != null);
      const dd = fmtUsd(-Math.abs(maxDrawdown(s)), { signed: true });
      big = { label: t("ans.ddLabel"), value: dd, tone: maxDrawdown(s) ? -1 : null };
      headline = t("ans.ddHead", { subject, dd, net: sNet });
      break;
    }
    default:
      big = { label: t("ans.netLabel"), value: sNet, tone: all.net, sub: t("ans.netSub", { trades: nTrades(all.n), wr: sWr }) };
  }
  const tk = takeaway(all);
  if (tk && q.intent !== "fees") headline += ` ${tk}`;

  let groups: AskGroups | null = null;
  let kind: AskAnswerKind = "summary";
  if (q.groupBy) {
    const rows = groupTrades(trades, q.groupBy, idx);
    const metric: AskMetric = q.intent === "winrate" ? "winRate" : q.intent === "count" ? "n" : q.intent === "fees" ? "fees" : q.intent === "avg" ? "avg" : q.intent === "pf" ? "pf" : "net";
    if (CHRONO.has(q.groupBy)) rows.sort((x, y) => x.key.localeCompare(y.key));
    else rows.sort((x, y) => (metricValue(y, metric) ?? -Infinity) - (metricValue(x, metric) ?? -Infinity) || y.n - x.n);
    const shown = q.groupBy === "day" ? rows.slice(-31) : rows.slice(0, 40);
    groups = { dim: q.groupBy, title: dimTitle(q.groupBy), rows: shown, metric };
    chart = barsFrom(shown, metric, byMetric(dimTitle(q.groupBy), metric)) ?? chart;
    const ranked = rankRows(rows.filter((r) => r.n >= minGroupN(trades.length, metric, q.groupBy!)), metric, true);
    if (ranked.length >= 2) {
      const b = ranked[0], w = ranked[ranked.length - 1];
      headline = t("ans.groupsHead", {
        subject, stats: statLine(all), best: b.label, bestV: fmtMetric(metricValue(b, metric), metric), worst: w.label, worstV: fmtMetric(metricValue(w, metric), metric),
      });
    }
    kind = "groups";
  }

  return { ...base, kind, headline, big, chart, groups, trades: listed, tradesTitle: t("ans.byQuery") };
}

// ── Comparison ────────────────────────────────────────────────────────────────

export function buildCompare(q: AskQuery, f: AskFilter, a: AskTrade[], b: AskTrade[], idx: BookIndex, meta: AnswerMeta & { notes?: string[] } = {}): AskAnswer {
  const c = q.compare!;
  const subject = describeSubject(q);
  const metric = q.metric;
  const ra = { ...aggOf(a, "a", c.a.label, idx), ask: canonicalText({ ...f, ...c.a.patch }, { allTraders: q.allTraders }) };
  const rb = { ...aggOf(b, "b", c.b.label, idx), ask: canonicalText({ ...f, ...c.b.patch }, { allTraders: q.allTraders }) };
  const union = [...new Map([...a, ...b].map((tr) => [tr.id, tr])).values()];
  const total = meta.total ?? union.length;
  const notes = [...(meta.notes ?? [])];
  const { link, note } = baseLink(f, union, meta.maxLinkIds ?? MAX_LINK_IDS);
  if (note) notes.push(note);
  if (!union.length) {
    return {
      kind: "empty", subject, headline: t("ans.cmpEmpty", { subject }), big: { label: t("ans.stTrades"), value: "0", tone: null }, stats: [], chart: null, groups: null,
      trades: [], tradesTitle: t("ans.tradesTitle"), link, linkLabel: t("ans.open"), notes, matched: 0, total, empty: true,
    };
  }
  const va = metricValue(ra, metric), vb = metricValue(rb, metric);
  const diff = va != null && vb != null ? va - vb : null;
  const higherBetter = metric !== "fees";
  const winner = diff == null || diff === 0 ? null : (diff > 0) === higherBetter ? ra : rb;
  const loser = winner === ra ? rb : ra;
  const word = metricName(metric);
  const headline = winner
    ? t("ans.cmpHead", {
      winner: winner.label, metric: word, wv: fmtMetric(metricValue(winner, metric), metric), lv: fmtMetric(metricValue(loser, metric), metric),
      wn: nTrades(winner.n), ln: nTrades(loser.n), wwr: fmtRate(winner.winRate), lwr: fmtRate(loser.winRate),
    })
    : cap(t("ans.cmpTie", { a: ra.label, b: rb.label, metric: word, v: fmtMetric(va, metric) }));
  const pp = diff == null ? "" : `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${Math.abs(Math.round(diff * 100))}`;
  const diffFmt = diff == null ? "—" : metric === "winRate" ? commonI18n.t("units.percentPoints", { value: pp }) : metric === "n" ? fmtNum(diff, { decimals: 0, signed: true }) : metric === "pf" ? fmtNum(diff, { signed: true }) : fmtUsd(diff, { signed: true });
  const all = aggOf(union, "all", t("ans.all"), idx);
  return {
    kind: "compare", subject, headline,
    big: { label: cap(t("ans.cmpDiff", { metric: word, a: ra.label, b: rb.label })), value: diffFmt, tone: metric === "net" || metric === "avg" ? diff : null },
    stats: statsOf(all),
    chart: barsFrom([ra, rb], metric, byMetric(`${cap(ra.label)} vs ${rb.label}`, metric), winner ? [winner.key] : []),
    groups: { dim: "side", title: t("ans.cmpTitle"), rows: [ra, rb], highlight: winner ? [winner.key] : [], metric },
    trades: sortChrono(union, idx), tradesTitle: t("ans.cmpTrades"),
    link: union.length <= (meta.maxLinkIds ?? MAX_LINK_IDS) ? { ...link, ids: union.map((tr) => tr.id) } : link,
    linkLabel: t("ans.cmpOpen"), notes, matched: union.length, total, empty: false,
  };
}

// ── Streaks ───────────────────────────────────────────────────────────────────

interface Run { kind: "win" | "loss"; items: AskTrade[]; days?: string[]; net: number }

function runsOf(trades: AskTrade[], idx: BookIndex, unit: "trade" | "day"): Run[] {
  const s = sortChrono(trades, idx, false);
  const runs: Run[] = [];
  if (unit === "day") {
    const byDay = new Map<string, AskTrade[]>();
    for (const tr of s) { const d = metaOf(idx, tr).day; byDay.set(d, [...(byDay.get(d) ?? []), tr]); }
    for (const [day, items] of byDay) {
      const net = items.reduce((x, tr) => x + (netPnl(tr) ?? 0), 0);
      if (net === 0) continue;
      const kind = net > 0 ? "win" : "loss";
      const last = runs[runs.length - 1];
      if (last && last.kind === kind) { last.items.push(...items); last.days!.push(day); last.net += net; }
      else runs.push({ kind, items: [...items], days: [day], net });
    }
    return runs;
  }
  for (const tr of s) {
    const r = resultOf(tr);
    if (r !== "win" && r !== "loss") continue;
    const last = runs[runs.length - 1];
    if (last && last.kind === r) { last.items.push(tr); last.net += netPnl(tr) ?? 0; }
    else runs.push({ kind: r, items: [tr], net: netPnl(tr) ?? 0 });
  }
  return runs;
}

function streakAnswer(q: AskQuery, trades: AskTrade[], c: Ctx, base: Base, all: Agg): AskAnswer {
  const unit = q.streak?.unit ?? "trade";
  const runs = runsOf(trades, c.idx, unit);
  const len = (r: Run) => (unit === "day" ? r.days!.length : r.items.length);
  const longest = (k: "win" | "loss") => runs.filter((r) => r.kind === k).sort((x, y) => len(y) - len(x) || (k === "win" ? y.net - x.net : x.net - y.net))[0] ?? null;
  const lw = longest("win"), ll = longest("loss");
  const kind = q.streak?.kind ?? "win";
  const loss = kind === "loss";
  const focus = loss ? ll : lw;
  const cur = runs[runs.length - 1] ?? null;
  const u = (n: number) => (unit === "day" ? commonI18n.t("units.days", { count: n }) : nTrades(n));
  if (!focus) return { ...base, kind: "empty", headline: t("ans.stEmpty", { subject: describeSubject(q) }), big: { label: t("ans.stBig"), value: "0", tone: null }, chart: null, groups: null, trades: [], tradesTitle: t("ans.tradesTitle"), empty: true };
  const span = (r: Run) => { const s = sortChrono(r.items, c.idx, false); return s.length ? `${dm(s[0].date)}–${dm(s[s.length - 1].date)}` : ""; };
  const other = loss ? lw : ll;
  const parts = [t(loss ? "ans.stLongestLoss" : "ans.stLongestWin", { n: u(len(focus)), span: span(focus), net: fmtUsd(focus.net, { signed: true }) })];
  if (other) parts.push(t(loss ? "ans.stOtherWin" : "ans.stOtherLoss", { n: u(len(other)) }));
  if (cur) parts.push(t(cur.kind === "win" ? "ans.stNowWin" : "ans.stNowLoss", { n: u(len(cur)) }));
  // Distribution of run lengths for the focused kind.
  const lens = runs.filter((r) => r.kind === kind).map(len);
  const maxL = Math.min(10, Math.max(...lens, 1));
  const bins = Array.from({ length: maxL }, (_, i) => ({ label: i + 1 === maxL && Math.max(...lens) > maxL ? `${maxL}+` : String(i + 1), value: lens.filter((l) => (i + 1 === maxL ? l >= maxL : l === i + 1)).length, tone: (loss ? "down" : "up") as "up" | "down" }));
  const stats: AskStat[] = [
    { label: t("ans.stMaxWin"), value: lw ? u(len(lw)) : "—" },
    { label: t("ans.stMaxLoss"), value: ll ? u(len(ll)) : "—" },
    { label: t("ans.stCurrent"), value: cur ? t(cur.kind === "win" ? "ans.stCurWin" : "ans.stCurLoss", { n: u(len(cur)) }) : "—" },
    { label: t("ans.stTotal"), value: String(runs.length) },
    ...statsOf(all).slice(0, 3),
  ].filter((s) => s.value !== "—");
  const chartKey = `${loss ? "loss" : "win"}${unit === "day" ? "Days" : "Trades"}` as "lossDays" | "lossTrades" | "winDays" | "winTrades";
  return {
    ...base, kind: "streak", headline: parts.join(" "), stats,
    big: { label: t(loss ? "ans.stBigLoss" : "ans.stBigWin"), value: u(len(focus)), tone: null, sub: `${span(focus)} · ${fmtUsd(focus.net, { signed: true })}` },
    chart: { type: "hist", title: t(`ans.stChart.${chartKey}`), bins },
    groups: null, trades: sortChrono(focus.items, c.idx), tradesTitle: t("ans.stSeriesTrades"),
    link: focus.items.length <= c.maxIds ? { ...base.link, ids: focus.items.map((tr) => tr.id) } : base.link, linkLabel: t("ans.stOpen"),
  };
}

// ── Insight: «когда я теряю больше всего» ────────────────────────────────────

const INSIGHT_DIMS = ["slot", "hour", "weekday", "holdBucket", "sizeBucket", "ticker", "side", "setup"] as const;

function insightAnswer(q: AskQuery, trades: AskTrade[], c: Ctx, base: Base): AskAnswer {
  const worst = q.insight !== "best";
  const minN = minGroupN(trades.length, "net", "insight");
  const baseText = canonicalText(c.f, { allTraders: q.allTraders });
  const findings: Agg[] = [];
  for (const dim of INSIGHT_DIMS) {
    const groups = groupTrades(trades, dim, c.idx).filter((r) => dim !== "setup" || r.key !== "—");
    if (groups.length < 2) continue; // one bucket = nothing to compare against
    const rows = groups.filter((r) => r.n >= minN && r.net != null);
    const top = rankRows(rows, "net", !worst)[0];
    if (!top || top.net == null || (worst ? top.net >= 0 : top.net <= 0)) continue;
    findings.push({ ...top, key: `${dim}:${top.key}`, label: `${t(`insightDim.${dim}`)}: ${top.label}`, ask: [top.ask, baseText].filter(Boolean).join(" ") });
  }
  // Context: right after a loss vs the rest.
  const afterLoss = trades.filter((tr) => metaOf(c.idx, tr).prev[0] === "loss");
  if (afterLoss.length >= minN) {
    const a = aggOf(afterLoss, "ctx:afterLoss", t("ans.afterLoss"), c.idx);
    if (a.net != null && (worst ? a.net < 0 : a.net > 0)) findings.push({ ...a, ask: [t("ph.afterLoss"), baseText].filter(Boolean).join(" ") });
  }
  findings.sort((x, y) => (worst ? (x.net ?? 0) - (y.net ?? 0) : (y.net ?? 0) - (x.net ?? 0)));
  const top = findings[0];
  if (!top) {
    return {
      ...base, kind: "insight", headline: worst ? t("ans.inNoneWorst") : t("ans.inNoneBest"),
      big: { label: t("ans.inFindings"), value: "0", tone: null }, chart: equityChart(trades, c.idx), groups: null, trades: sortChrono(trades, c.idx), tradesTitle: t("ans.byQuery"),
    };
  }
  const second = findings[1];
  const head = t(worst ? "ans.inHeadWorst" : "ans.inHeadBest", { label: top.label.toLowerCase(), net: fmtUsd(top.net, { signed: true }), trades: nTrades(top.n), wr: fmtRate(top.winRate) });
  const headline = second ? `${head} ${t("ans.inNext", { label: second.label.toLowerCase(), net: fmtUsd(second.net, { signed: true }) })}` : head;
  const ids = new Set(top.ids ?? []);
  c.notes.push(t(worst ? "ans.inNoteWorst" : "ans.inNoteBest", { count: minN, k: INSIGHT_DIMS.length + 1 }));
  return {
    ...base, kind: "insight", headline,
    big: { label: top.label, value: fmtUsd(top.net, { signed: true }), tone: top.net, sub: t("ans.inSub", { trades: nTrades(top.n), wr: fmtRate(top.winRate), avg: fmtUsd(top.avgNet, { signed: true }) }) },
    chart: barsFrom(findings, "net", worst ? t("ans.inChartWorst") : t("ans.inChartBest"), [top.key]),
    groups: { dim: "insight", title: worst ? t("ans.inGroupsWorst") : t("ans.inGroupsBest"), rows: findings, highlight: [top.key], metric: "net" },
    trades: sortChrono(trades.filter((tr) => ids.has(tr.id)), c.idx), tradesTitle: t("ans.tradesOf", { label: top.label }),
    link: ids.size <= c.maxIds ? { ...base.link, ids: [...ids] } : base.link, linkLabel: t("ans.inOpen"),
  };
}

export { describeFilter, filterOf };
