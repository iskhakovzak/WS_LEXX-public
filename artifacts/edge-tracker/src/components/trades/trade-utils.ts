import type { Trade, CreateTradeBody, CreateTradeBodyConfidenceGrade, CreateTradeBodyHorizon } from "@workspace/api-client-react";
import { resultTone as sharedResultTone } from "@/lib/trade-result";
import { differenceInCalendarDays, parseISO } from "date-fns";
import {
  screenshotUrlsToString,
  stringToScreenshotUrls,
  screenshotNotesToString,
  stringToScreenshotNotes,
} from "@/components/screenshot-fields";
import { nyDate, addDays } from "@/lib/trading-date";
import { normalizeResult } from "@/lib/trade-result";
import { signedR, priceR, netPnl as sharedNetPnl, isOpen as sharedIsOpen } from "@/lib/trade-math";
import type { Tone } from "@/components/ds";
import type { PlaybookPayload } from "@/components/add-to-playbook";
import { tradesI18n } from "@/i18n/ns/trades";
import { HORIZONS, type Horizon } from "@/components/shared/trade-labels";
export { RESULTS, HORIZONS, HORIZON_LABEL, EVENT_LABEL, SESSION_LABEL, RESULT_LABEL, eventLabel, sessionLabel, type Horizon } from "@/components/shared/trade-labels";

export const EVENT_TYPES = ["earnings", "momentum", "news", "ipo", "fed", "macro", "other"];
export const SESSIONS = ["premarket", "regular", "afterhours"];
export const SIDES = ["Long", "Short"];
export const GRADES = ["A+", "A", "B", "C"] as const;




export function resultKey(result: string | null | undefined): "win" | "loss" | "breakeven" | "open" {
  const r = normalizeResult(result);
  if (r === "win") return "win";
  if (r === "loss") return "loss";
  if (r === "be") return "breakeven";
  return "open";
}

/** Shared tones from lib/trade-result (win/loss/BE), plus "accent" for open positions. */
export function resultTone(result: string | null | undefined): Tone {
  return resultKey(result) === "open" ? "accent" : sharedResultTone(result);
}

// ── Form model ──────────────────────────────────────────────────────────────

export type FormData = {
  ticker: string; date: string; setup: string; side: string; eventType: string; entry: string; exit: string;
  stop: string; result: string; pnl: string; rMultiple: string; holdTime: string; slippage: string;
  marketCap: string; float: string; relativeVolume: string; atr: string; sector: string; session: string; screenshotUrls: string[];
  screenshotNotes: string[]; notes: string; whatWorked: string; whatFailed: string; conclusion: string; trader: string; tags: string;
  conviction: number; confidenceGrade: string;
  beta: string; shortInterest: string; adv: string; longName: string;
  horizon: Horizon; exitDate: string; qty: string; fees: string; riskUsd: string;
};

export const blankForm = (): FormData => ({
  ticker: "", date: nyDate(), setup: "", side: "Long", eventType: "", entry: "",
  exit: "", stop: "", result: "win", pnl: "", rMultiple: "", holdTime: "", slippage: "",
  marketCap: "", float: "", relativeVolume: "", atr: "", sector: "", session: "regular", screenshotUrls: [""], screenshotNotes: [""], notes: "",
  whatWorked: "", whatFailed: "", conclusion: "", trader: "", tags: "",
  conviction: 3, confidenceGrade: "B",
  beta: "", shortInterest: "", adv: "", longName: "",
  horizon: "intraday", exitDate: "", qty: "", fees: "", riskUsd: "",
});

type TradeExtra = Trade & { beta?: number | null; shortInterest?: number | null; adv?: string | null; longName?: string | null };

export function tradeToForm(t: Trade): FormData {
  const x = t as TradeExtra;
  const urls = stringToScreenshotUrls(t.screenshotUrl);
  return {
    ticker: t.ticker, date: t.date.substring(0, 10), setup: t.setup ?? "", side: t.side ?? "Long",
    eventType: t.eventType ?? "",
    entry: t.entry != null ? String(t.entry) : "", exit: t.exit != null ? String(t.exit) : "",
    stop: t.stop != null ? String(t.stop) : "", result: t.result,
    pnl: t.pnl != null ? String(t.pnl) : "", rMultiple: t.rMultiple != null ? String(t.rMultiple) : "",
    holdTime: t.holdTime ?? "", slippage: t.slippage != null ? String(t.slippage) : "",
    marketCap: t.marketCap ?? "", float: t.float ?? "",
    relativeVolume: t.relativeVolume != null ? String(t.relativeVolume) : "",
    atr: t.atr != null ? String(t.atr) : "",
    sector: t.sector ?? "",
    session: t.session ?? "regular", screenshotUrls: urls, screenshotNotes: stringToScreenshotNotes(t.screenshotNotes, urls.length), notes: t.notes ?? "",
    whatWorked: t.whatWorked ?? "", whatFailed: t.whatFailed ?? "",
    conclusion: t.conclusion ?? "", trader: t.trader ?? "", tags: t.tags ?? "",
    conviction: t.conviction ?? 3, confidenceGrade: t.confidenceGrade ?? "B",
    beta: x.beta != null ? String(x.beta) : "",
    shortInterest: x.shortInterest != null ? String(x.shortInterest) : "",
    adv: x.adv ?? "",
    longName: x.longName ?? "",
    horizon: (HORIZONS as readonly string[]).includes(t.horizon ?? "") ? (t.horizon as Horizon) : "intraday",
    exitDate: t.exitDate ? t.exitDate.substring(0, 10) : "",
    qty: t.qty != null ? String(t.qty) : "",
    fees: t.fees != null ? String(t.fees) : "",
    riskUsd: t.riskUsd != null ? String(t.riskUsd) : "",
  };
}

export function formToBody(f: FormData): CreateTradeBody & { tags?: string | null; side?: string | null } {
  return {
    ticker: f.ticker.toUpperCase(), date: f.date, setup: f.setup || null, side: f.side || null, result: f.result,
    eventType: f.eventType || null, entry: f.entry ? Number(f.entry) : null,
    exit: f.exit ? Number(f.exit) : null, stop: f.stop ? Number(f.stop) : null,
    pnl: f.pnl ? Number(f.pnl) : null, rMultiple: f.rMultiple ? Number(f.rMultiple) : null,
    holdTime: f.holdTime || null, slippage: f.slippage ? Number(f.slippage) : null,
    marketCap: f.marketCap || null, float: f.float || null,
    relativeVolume: f.relativeVolume ? Number(f.relativeVolume) : null,
    atr: f.atr ? Number(f.atr) : null,
    sector: f.sector || null,
    session: f.session || null, screenshotUrl: screenshotUrlsToString(f.screenshotUrls) || null,
    screenshotNotes: screenshotNotesToString(f.screenshotNotes) || null,
    notes: f.notes || null, whatWorked: f.whatWorked || null,
    whatFailed: f.whatFailed || null, conclusion: f.conclusion || null,
    trader: f.trader || null, tags: f.tags || null,
    conviction: f.conviction,
    confidenceGrade: f.confidenceGrade as CreateTradeBodyConfidenceGrade,
    beta: f.beta ? Number(f.beta) : null,
    shortInterest: f.shortInterest ? Number(f.shortInterest) : null,
    adv: f.adv || null,
    longName: f.longName || null,
    horizon: (f.horizon || "intraday") as CreateTradeBodyHorizon,
    exitDate: f.horizon !== "intraday" && f.exitDate ? f.exitDate : null,
    qty: f.qty ? Number(f.qty) : null,
    fees: f.fees ? Number(f.fees) : null,
    riskUsd: f.riskUsd ? Number(f.riskUsd) : null,
  };
}

/** Planned $ risk suggestion: |entry − stop| × qty. */
export function suggestedRiskUsd(f: Pick<FormData, "entry" | "stop" | "qty">): number | null {
  const e = Number(f.entry), st = Number(f.stop), q = Number(f.qty);
  if (!f.entry || !f.stop || !f.qty || !Number.isFinite(e) || !Number.isFinite(st) || !Number.isFinite(q) || q <= 0) return null;
  const v = Math.abs(e - st) * q;
  return v > 0 ? Math.round(v * 100) / 100 : null;
}

// Fields that trigger the server-side pre-trade checklist gate on PATCH.
export const ENTRY_DECISION_FIELDS = ["ticker", "date", "side", "setup", "entry", "stop", "eventType"] as const;

export function apiErrorMessage(e: unknown): string {
  const data = (e as { data?: { message?: string; error?: string } } | null)?.data;
  return data?.message ?? data?.error ?? (e instanceof Error ? e.message : String(e));
}

export function splitTags(tags: string | null | undefined): string[] {
  return (tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}

export function dayOf(t: Pick<Trade, "date">): string {
  return t.date.substring(0, 10);
}

/** «В плейбук» / «Новый сетап из сделки»: the setup form prefilled from a trade (trade sheet and the trades list). */
export function tradePlaybookPayload(t: Trade): PlaybookPayload {
  return {
    name: `${t.ticker} ${t.setup || t.eventType || ""} (${dayOf(t)})`.trim(),
    setupType: t.setup || t.eventType || undefined,
    conditions: t.notes || undefined,
    notes: [
      t.whatWorked ? tradesI18n.t("playbookNotes.worked", { text: t.whatWorked }) : "",
      t.whatFailed ? tradesI18n.t("playbookNotes.failed", { text: t.whatFailed }) : "",
      t.conclusion ? tradesI18n.t("playbookNotes.conclusion", { text: t.conclusion }) : "",
    ].filter(Boolean).join("\n") || undefined,
    screenshotUrl: t.screenshotUrl || undefined,
    screenshotNotes: t.screenshotNotes || undefined,
    tags: t.tags || undefined,
    sourceType: "trade",
    sourceId: t.id,
  };
}

export function horizonOf(t: Trade): Horizon {
  return (HORIZONS as readonly string[]).includes(t.horizon ?? "") ? (t.horizon as Horizon) : "intraday";
}

/** Net P&L = gross P&L − |fees| (shared formula from @/lib/trade-math; null when P&L is not filled). */
export function netPnl(t: Trade): number | null {
  return sharedNetPnl(t);
}

/** Broker wall-clock instants (ET «YYYY-MM-DDTHH:MM:SS») of the first / last fill from contextSnapshot, when known. */
export function tradeWall(t: Pick<Trade, "contextSnapshot">): { open: string | null; close: string | null } {
  const cs = (t.contextSnapshot ?? {}) as Record<string, unknown>;
  const ok = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) ? v.replace(" ", "T") : null);
  return { open: ok(cs.openedAt), close: ok(cs.closedAt) };
}

/** «HH:MM» of a wall-clock instant. */
export function wallHm(v: string | null | undefined): string | null {
  return v ? v.slice(11, 16) : null;
}

function wallMs(v: string): number {
  const ms = Date.parse(`${v.slice(0, 19)}Z`);
  return Number.isFinite(ms) ? ms : NaN;
}

/** Parse the broker «holdTime» text («45s», «5m», «1h 2m», «2d 3h») into seconds. */
export function parseHoldText(s: string | null | undefined): number | null {
  if (!s) return null;
  const re = /(\d+(?:\.\d+)?)\s*([dhms])/gi;
  let total = 0, any = false;
  for (const m of s.matchAll(re)) {
    any = true;
    const n = Number(m[1]);
    total += n * ({ d: 86400, h: 3600, m: 60, s: 1 } as Record<string, number>)[m[2].toLowerCase()];
  }
  return any ? total : null;
}

/** Hold time in seconds: broker open/close wall clock, else the «holdTime» text. */
export function holdSeconds(t: Pick<Trade, "contextSnapshot" | "holdTime">): number | null {
  const w = tradeWall(t);
  if (w.open && w.close) {
    const d = (wallMs(w.close) - wallMs(w.open)) / 1000;
    if (Number.isFinite(d) && d >= 0) return Math.round(d);
  }
  return parseHoldText(t.holdTime);
}

/** Compact hold in the current language: «45с», «5м», «1ч 20м», «2д» (EN «45s», «1h 20m»). */
export function fmtHold(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  const t = tradesI18n.t;
  if (s < 60) return t("hold.s", { s });
  if (s < 3600) { const m = Math.floor(s / 60), r = s % 60; return m < 10 && r ? t("hold.ms", { m, s: r }) : t("hold.m", { m }); }
  if (s < 86400) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return m ? t("hold.hm", { h, m }) : t("hold.h", { h }); }
  return t("hold.d", { d: Math.floor(s / 86400) });
}

/**
 * Another trader's trade opened by a non-staff viewer (e.g. a playbook example): the API nulls its $ fields
 * (pnl / fees / qty / riskUsd / slippage) and sets `redacted: true` — server lib/playbookPrivacy.ts.
 */
export function isRedactedTrade(t: Trade): boolean {
  return (t as Trade & { redacted?: boolean }).redacted === true;
}

/** Broker-sourced trade (PropReports): broker numbers are read-only in the UI. */
export function isBrokerTrade(t: Pick<Trade, "source">): boolean {
  return t.source === "propreports";
}

/** Fields owned by the broker when `source === 'propreports'` (trader layer stays editable). */
export const BROKER_OWNED_FIELDS = ["ticker", "date", "side", "entry", "exit", "qty", "pnl", "fees", "exitDate", "horizon"] as const;

/** Calendar days held: open → until today, closed → until exitDate (if set). */
export function daysHeld(t: Trade, now = new Date()): number | null {
  try {
    const start = parseISO(dayOf(t));
    if (resultKey(t.result) === "open") return Math.max(0, differenceInCalendarDays(now, start));
    if (t.exitDate) return Math.max(0, differenceInCalendarDays(parseISO(t.exitDate.substring(0, 10)), start));
    return null;
  } catch {
    return null;
  }
}

// ── Derived metrics ─────────────────────────────────────────────────────────

/** Price-derived R (side-aware) — thin wrapper over the shared `priceR`, rounded for display. */
export function computedR(t: Pick<Trade, "entry" | "stop" | "exit" | "side">): number | null {
  const r = priceR(t);
  return r == null ? null : Math.round(r * 100) / 100;
}

/**
 * R-multiple used everywhere in the trades UI. The value is the shared `signedR` from @/lib/trade-math
 * (stored R signed by the result → price R → pnl/riskUsd); `derived` tells the UI the number was not
 * typed by the trader (so it can be marked «расч.»).
 */
export function effectiveR(t: Trade): { value: number | null; derived: boolean } {
  if (sharedIsOpen(t)) return { value: null, derived: false };
  const value = signedR(t);
  return { value, derived: value != null && t.rMultiple == null };
}

export type TradeStats = {
  count: number;
  open: number;
  wins: number;
  losses: number;
  be: number;
  winRate: number | null;
  avgR: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  expectancyR: number | null;
  profitFactor: number | null;
  rCount: number;
  totalR: number;
  totalPnl: number | null;
  pnlCount: number;
  streak: { kind: "win" | "loss" | null; len: number };
  curve: { i: number; r: number; label: string }[];
};

/** Aggregates for the current filter. Chronological order is derived internally. */
export function computeStats(list: Trade[]): TradeStats {
  const chrono = [...list].sort((a, b) => (a.date === b.date ? (a.createdAt ?? "").localeCompare(b.createdAt ?? "") : a.date.localeCompare(b.date)));
  let wins = 0, losses = 0, be = 0, open = 0;
  let sumR = 0, rCount = 0, winRSum = 0, winRN = 0, lossRSum = 0, lossRN = 0, posR = 0, negR = 0;
  let pnl = 0, pnlCount = 0;
  const curve: TradeStats["curve"] = [];
  let cum = 0;
  for (const t of chrono) {
    const k = resultKey(t.result);
    if (k === "win") wins++; else if (k === "loss") losses++; else if (k === "breakeven") be++; else open++;
    const r = effectiveR(t).value;
    if (r != null && k !== "open") {
      sumR += r; rCount++;
      if (r > 0) { posR += r; } else if (r < 0) { negR += -r; }
      if (k === "win") { winRSum += r; winRN++; }
      if (k === "loss") { lossRSum += r; lossRN++; }
      cum += r;
      curve.push({ i: curve.length + 1, r: Math.round(cum * 100) / 100, label: `${t.ticker} · ${dayOf(t)}` });
    }
    const n = netPnl(t);
    if (n != null) { pnl += n; pnlCount++; }
  }
  const closed = wins + losses + be;
  // Shared rule (lib/trade-math): win rate = W / (W + L), break-even excluded.
  const decided = wins + losses;
  const winRate = decided ? wins / decided : null;
  const avgWinR = winRN ? winRSum / winRN : null;
  const avgLossR = lossRN ? lossRSum / lossRN : null;
  let expectancyR: number | null = null;
  if (closed && (avgWinR != null || avgLossR != null)) {
    expectancyR = (wins / closed) * (avgWinR ?? 0) + (losses / closed) * (avgLossR ?? 0);
  }
  // Current streak: walk back from the latest closed trade.
  let streak: TradeStats["streak"] = { kind: null, len: 0 };
  for (let i = chrono.length - 1; i >= 0; i--) {
    const k = resultKey(chrono[i].result);
    if (k === "open" || k === "breakeven") continue;
    if (streak.kind == null) streak = { kind: k, len: 1 };
    else if (streak.kind === k) streak.len++;
    else break;
  }
  return {
    count: list.length, open, wins, losses, be, winRate,
    avgR: rCount ? sumR / rCount : null,
    avgWinR, avgLossR, expectancyR,
    // PF = ΣR⁺ / |ΣR⁻|; null (never ∞) when there are no losing R.
    profitFactor: negR > 0 ? posR / negR : null,
    rCount, totalR: sumR,
    totalPnl: pnlCount ? pnl : null, pnlCount,
    streak, curve,
  };
}

// ── Filters ─────────────────────────────────────────────────────────────────

export type Period = "all" | "today" | "week" | "month" | "custom";
export type Outcome = "all" | "win" | "loss" | "breakeven" | "open";

export type TradeFilters = {
  q: string;
  /** Exact ticker (deep links `?ticker=`); the free-text `q` still matches tickers as a substring. */
  ticker: string;
  period: Period;
  from: string;
  to: string;
  outcome: Outcome;
  side: "" | "Long" | "Short";
  setup: string;
  /** Playbook entry id (deep links `?playbookId=`); server-side only. */
  playbookId: string;
  trader: string;
  sector: string;
  tag: string;
  session: string;
  eventType: string;
  horizon: "" | Horizon;
  /** Trade source: manual / PropReports. */
  source: "" | "manual" | "propreports";
  /** Execution-quality filters (need the quality map; ignored when it is empty). */
  exitEffMax: string;
  mfeRMin: string;
  leftMin: string;
  /** Explicit id list from a deep link (?ids=1,2,3). */
  ids: string;
};

export const DEFAULT_FILTERS: TradeFilters = {
  q: "", ticker: "", period: "all", from: "", to: "", outcome: "all", side: "", setup: "", playbookId: "", trader: "", sector: "", tag: "", session: "", eventType: "", horizon: "",
  source: "", exitEffMax: "", mfeRMin: "", leftMin: "", ids: "",
};

/** Rows per page offered by the paginated table. */
export const PAGE_SIZES = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;

/** Per-trade execution-quality numbers used by the table, filters and the summary strip. */
export type TradeQualityLite = {
  status: "ok" | "partial" | "unavailable";
  exitEfficiency: number | null;
  mfeR: number | null;
  maeR: number | null;
  mfeUsd: number | null;
  capturedR: number | null;
  leftOnTableR: number | null;
  leftOnTableUsd: number | null;
};
export type QualityMap = Record<number, TradeQualityLite | undefined>;

export function hasQualityFilters(f: TradeFilters): boolean {
  return Boolean(f.exitEffMax || f.mfeRMin || f.leftMin);
}

/** Apply execution-quality filters on top of the base filters (trades without quality pass only when no quality filter is set). */
export function applyQualityFilters(trades: Trade[], f: TradeFilters, quality: QualityMap): Trade[] {
  if (!hasQualityFilters(f)) return trades;
  const exitMax = f.exitEffMax ? Number(f.exitEffMax) / 100 : null;
  const mfeMin = f.mfeRMin ? Number(f.mfeRMin) : null;
  const leftMin = f.leftMin ? Number(f.leftMin) : null;
  return trades.filter((t) => {
    const q = quality[t.id];
    if (!q) return false;
    if (exitMax != null && Number.isFinite(exitMax) && !(q.exitEfficiency != null && q.exitEfficiency <= exitMax)) return false;
    if (mfeMin != null && Number.isFinite(mfeMin) && !(q.mfeR != null && q.mfeR >= mfeMin)) return false;
    if (leftMin != null && Number.isFinite(leftMin) && !(q.leftOnTableR != null && q.leftOnTableR >= leftMin)) return false;
    return true;
  });
}

/** Period bounds on the New York trading calendar (never the browser's local date). */
export function periodRange(f: Pick<TradeFilters, "period" | "from" | "to">, now = new Date()): { from: string; to: string } {
  const today = nyDate(now);
  if (f.period === "today") return { from: today, to: today };
  if (f.period === "week") {
    const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
    const back = dow === 0 ? 6 : dow - 1; // Monday-based week
    return { from: addDays(today, -back), to: today };
  }
  if (f.period === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  if (f.period === "custom") return { from: f.from, to: f.to };
  return { from: "", to: "" };
}

/** Number of non-default "advanced" filters (those hidden in the popover). */
export function advancedFilterCount(f: TradeFilters): number {
  return [f.ticker, f.playbookId, f.trader, f.sector, f.tag, f.session, f.eventType, f.source, f.exitEffMax, f.mfeRMin, f.leftMin, f.ids, f.period === "custom" ? f.from || f.to : ""].filter(Boolean).length;
}

function idSet(ids: string): Set<number> | null {
  if (!ids.trim()) return null;
  const s = new Set<number>();
  for (const p of ids.split(",")) { const n = Number(p.trim()); if (Number.isInteger(n) && n > 0) s.add(n); }
  return s.size ? s : null;
}

export function isDefaultFilters(f: TradeFilters): boolean {
  return (Object.keys(DEFAULT_FILTERS) as (keyof TradeFilters)[]).every((k) => f[k] === DEFAULT_FILTERS[k]);
}

export function setupOf(t: Trade): string {
  return t.setup || t.eventType || "";
}

/** Apply everything except `outcome` (so segment counts can be computed against the same base). */
export function applyBaseFilters(trades: Trade[], f: TradeFilters): Trade[] {
  const q = f.q.trim().toLowerCase();
  const tagQ = f.tag.trim().toLowerCase();
  const { from, to } = periodRange(f);
  const ids = idSet(f.ids);
  const ticker = f.ticker.trim().toUpperCase();
  return trades.filter((t) => {
    if (ids && !ids.has(t.id)) return false;
    if (ticker && t.ticker.toUpperCase() !== ticker) return false;
    // playbookId is not part of the API trade shape — only the server-side page endpoint can filter by it.
    const d = dayOf(t);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (f.side && t.side !== f.side) return false;
    if (f.source === "propreports" && !isBrokerTrade(t)) return false;
    if (f.source === "manual" && isBrokerTrade(t)) return false;
    if (f.setup && t.setup !== f.setup && t.eventType !== f.setup) return false;
    if (f.trader && t.trader !== f.trader) return false;
    if (f.sector && t.sector !== f.sector) return false;
    if (f.session && t.session !== f.session) return false;
    if (f.eventType && t.eventType !== f.eventType) return false;
    if (f.horizon && horizonOf(t) !== f.horizon) return false;
    if (tagQ && !(t.tags ?? "").toLowerCase().includes(tagQ)) return false;
    if (!q) return true;
    const hay = [
      t.ticker, t.date, t.setup, t.side, t.eventType, t.session, t.trader, t.tags, t.notes,
      t.whatWorked, t.whatFailed, t.conclusion, t.sector, t.float, t.marketCap,
      t.pnl != null ? String(t.pnl) : "", t.rMultiple != null ? String(t.rMultiple) : "",
    ].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });
}

export function applyOutcome(trades: Trade[], outcome: Outcome): Trade[] {
  if (outcome === "all") return trades;
  return trades.filter((t) => resultKey(t.result) === outcome);
}

// ── Sorting ─────────────────────────────────────────────────────────────────

export type SortCol = "date" | "ticker" | "side" | "setup" | "trader" | "entry" | "exit" | "r" | "result" | "pnl" | "gross" | "fees" | "exitEff" | "mfeR" | "left" | "impact" | "hold";
export type SortConfig = { col: SortCol; dir: "asc" | "desc" };

const RESULT_ORDER: Record<string, number> = { win: 3, breakeven: 2, open: 1, loss: 0 };

export function sortTrades(list: Trade[], sort: SortConfig, quality: QualityMap = {}): Trade[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  const val = (t: Trade): string | number => {
    switch (sort.col) {
      case "ticker": return t.ticker;
      case "side": return t.side ?? "";
      case "setup": return setupOf(t).toLowerCase();
      case "trader": return t.trader ?? "";
      case "entry": return t.entry ?? -Infinity;
      case "exit": return t.exit ?? -Infinity;
      case "r": return effectiveR(t).value ?? -Infinity;
      case "result": return RESULT_ORDER[resultKey(t.result)] ?? 0;
      case "pnl": return netPnl(t) ?? -Infinity;
      case "gross": return t.pnl ?? -Infinity;
      case "fees": return t.fees != null ? Math.abs(t.fees) : -Infinity;
      case "exitEff": return quality[t.id]?.exitEfficiency ?? -Infinity;
      case "mfeR": return quality[t.id]?.mfeR ?? -Infinity;
      case "left": return quality[t.id]?.leftOnTableR ?? quality[t.id]?.leftOnTableUsd ?? -Infinity;
      case "impact": { const n = netPnl(t); return n != null ? Math.abs(n) : -Infinity; }
      case "hold": return holdSeconds(t) ?? -Infinity;
      default: return t.date.substring(0, 10);
    }
  };
  return [...list].sort((a, b) => {
    const av = val(a), bv = val(b);
    if (av < bv) return -dir;
    if (av > bv) return dir;
    // Stable tiebreak: newest first.
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id - a.id;
  });
}

// ── CSV export ──────────────────────────────────────────────────────────────

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function tradesToCsv(list: Trade[]): string {
  const cols: [string, (t: Trade) => unknown][] = [
    ["id", (t) => t.id], ["date", (t) => dayOf(t)], ["ticker", (t) => t.ticker], ["side", (t) => t.side],
    ["setup", (t) => t.setup], ["eventType", (t) => t.eventType], ["session", (t) => t.session], ["trader", (t) => t.trader],
    ["entry", (t) => t.entry], ["stop", (t) => t.stop], ["exit", (t) => t.exit], ["result", (t) => t.result],
    ["rMultiple", (t) => t.rMultiple], ["rEffective", (t) => effectiveR(t).value], ["pnl", (t) => t.pnl],
    ["fees", (t) => t.fees], ["netPnl", (t) => netPnl(t)], ["qty", (t) => t.qty], ["riskUsd", (t) => t.riskUsd],
    ["horizon", (t) => t.horizon], ["exitDate", (t) => t.exitDate], ["source", (t) => t.source ?? "manual"], ["brokerAccount", (t) => t.brokerAccount],
    ["holdTime", (t) => t.holdTime], ["relativeVolume", (t) => t.relativeVolume], ["float", (t) => t.float],
    ["marketCap", (t) => t.marketCap], ["sector", (t) => t.sector], ["conviction", (t) => t.conviction],
    ["confidenceGrade", (t) => t.confidenceGrade], ["tags", (t) => t.tags], ["notes", (t) => t.notes],
    ["whatWorked", (t) => t.whatWorked], ["whatFailed", (t) => t.whatFailed], ["conclusion", (t) => t.conclusion],
  ];
  const head = cols.map(([h]) => h).join(",");
  const rows = list.map((t) => cols.map(([, get]) => csvCell(get(t))).join(","));
  return [head, ...rows].join("\r\n");
}

export function downloadCsv(list: Trade[], name = `trades-${nyDate()}.csv`) {
  const blob = new Blob(["﻿" + tradesToCsv(list)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── localStorage helpers (never throw) ──────────────────────────────────────

export function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function readLSArray<T>(key: string): T[] {
  try {
    const raw = window.localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function writeLS(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

/** True when the keyboard event target is a text-entry control. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
