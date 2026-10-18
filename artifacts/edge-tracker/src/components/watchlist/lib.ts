/** Watchlist domain types, derived metrics and small fetch helpers. */
import type { Tone } from "@/components/ds";
import { fmtPct } from "@/lib/format";
import { watchlistI18n } from "@/i18n/ns/watchlist";

/** Record whose values are read from the dictionary on access (UI language at render time, never frozen). */
function labelRecord<K extends string>(keys: readonly K[], get: (k: K) => string): Record<K, string> {
  const o = {} as Record<K, string>;
  for (const k of keys) Object.defineProperty(o, k, { get: () => get(k), enumerable: true });
  return o;
}

export const STATUSES = ["watching", "passed", "traded"] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABELS: Record<string, string> = labelRecord(STATUSES, (s) => watchlistI18n.t(`status.${s}`));
export const STATUS_TONE: Record<string, Tone> = { watching: "accent", passed: "neutral", traded: "up" };

/** Legacy rows carry statuses like "Active" — map them onto the known set so filters/counters/select work. */
export function normStatus(s: string | null | undefined): Status {
  const v = (s ?? "").trim().toLowerCase();
  return (STATUSES as readonly string[]).includes(v) ? (v as Status) : "watching";
}

export type WatchlistItem = {
  id: number; ticker: string; catalyst: string | null; targetPrice: string | null;
  stopPrice: string | null; status: string; notes: string | null; sector: string | null;
  tags: string | null; createdAt: string;
  /** Author (server created_by). null = legacy row → only staff may edit content / delete. */
  createdBy?: string | null;
  score: number | null; scoreBreakdown: string | null; scoredAt: string | null;
  screenshotUrl?: string | null;
  longName?: string | null; marketCap?: string | null; float?: string | null; atr?: string | null;
  relativeVolume?: string | null;
  /** Added by GET /api/watchlist (may be missing on older API builds). */
  ideaCount?: number; lastIdeaAt?: string | null; tradeCount?: number; lastTradeDate?: string | null;
  /** Team-shared «В игре» flag (absent on API builds before the in_play migration → client falls back to localStorage). */
  inPlay?: boolean; inPlayAt?: string | null;
  /** Open positions on the ticker (trades with result = open, visible to the viewer) and today's auto «Торговал». */
  openPositions?: number; openTraders?: string[]; openTradeIds?: number[];
  tradedToday?: boolean; autoTraded?: boolean;
  /** Working list (GET /api/watchlist after the list_name column; older builds omit it → client fallback). */
  list?: ListName;
};

/** Working lists of the day. «Сегодня» ⇔ the team «В игре» flag. */
export const LISTS = ["today", "swing", "watch"] as const;
export type ListName = (typeof LISTS)[number];
export const LIST_LABELS: Record<ListName, string> = labelRecord(LISTS, (l) => watchlistI18n.t(`list.${l}`));
export const LIST_HINT: Record<ListName, string> = labelRecord(LISTS, (l) => watchlistI18n.t(`list.hint.${l}`));
export function isListName(v: unknown): v is ListName {
  return typeof v === "string" && (LISTS as readonly string[]).includes(v);
}

/**
 * Tickers from free text: «AAPL, nvda tsla», a pasted column, «$AMD;MU». Uppercased, deduped,
 * invalid tokens returned separately so the input can say what it skipped.
 */
export const TICKER_TOKEN_RE = /^[A-Z][A-Z0-9.\-]{0,11}$/;
export function parseTickers(text: string): { tickers: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const tickers: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;|]+/)) {
    const t = raw.trim().toUpperCase().replace(/^\$/, "");
    if (!t || seen.has(t)) continue;
    seen.add(t);
    if (TICKER_TOKEN_RE.test(t)) tickers.push(t); else invalid.push(t);
  }
  return { tickers, invalid };
}

export type Quote = {
  price: number | null; change: number | null; open: number | null; high: number | null; low: number | null;
  prevClose: number | null; volume: number | null; avgVolume: number | null; relativeVolume: number | null;
  high52w: number | null; low52w: number | null; name: string | null; gapPct: number | null; atr: number | null;
  spark?: number[]; marketTime?: number | null;
  /** NY trading date of the last regular-session print (stale when ≠ today's NY date). */
  marketDate?: string | null;
};

export type NewsDigest = {
  count24h: number; count7d: number; categories24h: string[];
  latest: { title: string; category: string; publishedAt: string | null; url: string | null; source: string | null } | null;
};

export type EarningsHit = { callType: "BMO" | "AMC" | "TNS"; when: "today" | "recent"; epsSurprisePct: number | null; priceMoveDay: number | null };

export type Breakdown = {
  total: number;
  components: Record<string, { weight: number; raw: number; weighted: number; reason: string; reasonCode?: string; reasonParams?: Record<string, string | number> }>;
};

const SCORE_STATIC: Record<string, string> = { float: "Float", atr: "ATR", relativeVolume: "rVol" };
export const SCORE_LABELS: Record<string, string> = labelRecord(
  ["catalyst", "float", "atr", "relativeVolume", "sectorStrength", "liquidity"] as const,
  (k) => SCORE_STATIC[k] ?? watchlistI18n.t(`score.${k as "catalyst" | "sectorStrength" | "liquidity"}`),
);

export function parseBreakdown(raw: string | null): Breakdown | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Breakdown;
    return p && typeof p.components === "object" && p.components ? p : null;
  } catch {
    return null;
  }
}

export function num(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}


export function scoreTone(score: number | null | undefined): Tone {
  if (score == null) return "neutral";
  return score >= 70 ? "up" : score >= 40 ? "warn" : "down";
}

/** Plan derived from levels and the live price. Side inferred from level order (target above stop → long). */
export type Plan = {
  side: "long" | "short" | null;
  stop: number | null; target: number | null; price: number | null;
  /** R:R from the current price (reward / risk). */
  rr: number | null;
  /** % move from price to stop/target (signed in the trade direction: negative = against). */
  toStopPct: number | null; toTargetPct: number | null;
  /** Distance to stop expressed in ATRs. */
  stopAtr: number | null;
  /** Position of price on the stop→target ladder, 0..1 (clamped), null if unknown. */
  progress: number | null;
  alert: "stop-hit" | "target-hit" | "near-stop" | "near-target" | null;
};

export function computePlan(item: WatchlistItem, q: Quote | undefined): Plan {
  const stop = num(item.stopPrice);
  const target = num(item.targetPrice);
  const price = q?.price ?? null;
  const atr = q?.atr ?? num(item.atr);
  const side: Plan["side"] = stop != null && target != null && stop !== target ? (target > stop ? "long" : "short") : null;
  const base: Plan = { side, stop, target, price, rr: null, toStopPct: null, toTargetPct: null, stopAtr: null, progress: null, alert: null };
  if (price == null || price <= 0) return base;
  // Signed in the trader's favour: «до стопа» is a loss (≤ 0) and «до цели» a gain (≥ 0) for shorts as well as longs.
  const dir = side === "short" ? -1 : 1;
  if (stop != null) base.toStopPct = (((stop - price) / price) * 100) * dir;
  if (target != null) base.toTargetPct = (((target - price) / price) * 100) * dir;
  if (side && stop != null && target != null) {
    const risk = (price - stop) * dir;
    const reward = (target - price) * dir;
    base.rr = risk > 0 ? reward / risk : null;
    base.progress = Math.max(0, Math.min(1, (price - stop) / (target - stop)));
    if (risk <= 0) base.alert = "stop-hit";
    else if (reward <= 0) base.alert = "target-hit";
    else if (atr && risk / atr <= 0.5) base.alert = "near-stop";
    else if (atr && reward / atr <= 0.5) base.alert = "near-target";
    if (atr && atr > 0) base.stopAtr = risk / atr;
  }
  return base;
}

/** Why a ticker is "in play" today — each reason is shown as a chip. */
export type PlayReason = { key: string; label: string; tone: Tone };

export function inPlayReasons(item: WatchlistItem, q: Quote | undefined, news: NewsDigest | undefined, earn: EarningsHit | undefined, plan: Plan): PlayReason[] {
  const t = watchlistI18n.t;
  const out: PlayReason[] = [];
  if (earn?.when === "today") out.push({ key: "earn", label: earn.callType === "TNS" ? t("reason.earnToday") : t("reason.earnTodayCall", { call: earn.callType }), tone: earn.callType === "AMC" ? "purple" : "warn" });
  else if (earn) out.push({ key: "earn", label: t("reason.earnYesterday", { call: earn.callType }), tone: "purple" });
  const gap = q?.gapPct ?? null;
  if (gap != null && Math.abs(gap) >= 3) out.push({ key: "gap", label: t("reason.gap", { value: fmtPct(gap, 1) }), tone: gap > 0 ? "up" : "down" });
  const rv = q?.relativeVolume ?? null;
  if (rv != null && rv >= 1.5) out.push({ key: "rvol", label: `rVol ${rv.toFixed(1)}×`, tone: "accent" });
  if (news && news.count24h > 0) out.push({ key: "news", label: t("reason.news", { count: news.count24h }), tone: "neutral" });
  if (plan.alert === "near-stop" || plan.alert === "near-target") out.push({ key: "lvl", label: plan.alert === "near-stop" ? t("reason.nearStop") : t("reason.nearTarget"), tone: "warn" });
  if (plan.alert === "stop-hit") out.push({ key: "lvl", label: t("reason.stopHit"), tone: "down" });
  if (plan.alert === "target-hit") out.push({ key: "lvl", label: t("reason.targetHit"), tone: "up" });
  return out;
}

export function splitTags(tags?: string | null): string[] {
  return tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
}

export function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
export function writeLS(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ }
}


export type KeyLevelKey = "pdh" | "pdl" | "vwap" | "pmh" | "pml" | "stop" | "target";
const KEY_LEVEL_STATIC: Partial<Record<KeyLevelKey, string>> = { pdh: "PDH", pdl: "PDL", vwap: "VWAP", pmh: "PMH", pml: "PML" };
export const KEY_LEVEL_LABEL: Record<KeyLevelKey, string> = labelRecord(
  ["pdh", "pdl", "vwap", "pmh", "pml", "stop", "target"] as const,
  (k) => KEY_LEVEL_STATIC[k] ?? watchlistI18n.t(k === "stop" ? "level.stop" : "level.target"),
);
export type KeyLevel = {
  key: KeyLevelKey; label: string; price: number;
  /** (level − price) / price in %: positive = level above the price. */
  distPct: number;
  /** |level − price| / ATR. */
  distAtr: number | null;
};

/**
 * Key levels around the live price, nearest first: PDH/PDL/VWAP (+ premarket high/low and the row's
 * stop/target when set). `core` limits to PDH/PDL/VWAP/stop/target for the compact table cell.
 */
export function keyLevels(
  price: number | null | undefined,
  lv: { pdh: number | null; pdl: number | null; vwap: number | null; pmh?: number | null; pml?: number | null } | null | undefined,
  item: Pick<WatchlistItem, "stopPrice" | "targetPrice"> | null,
  atr: number | null | undefined,
  core = false,
): KeyLevel[] {
  if (price == null || !(price > 0)) return [];
  const raw: [KeyLevelKey, number | null | undefined][] = [
    ["pdh", lv?.pdh], ["pdl", lv?.pdl], ["vwap", lv?.vwap],
    ...(core ? [] : ([["pmh", lv?.pmh], ["pml", lv?.pml]] as [KeyLevelKey, number | null | undefined][])),
    ["stop", num(item?.stopPrice ?? null)], ["target", num(item?.targetPrice ?? null)],
  ];
  const out: KeyLevel[] = [];
  for (const [key, p] of raw) {
    if (p == null || !(p > 0)) continue;
    out.push({
      key, label: KEY_LEVEL_LABEL[key], price: p,
      distPct: ((p - price) / price) * 100,
      distAtr: atr && atr > 0 ? Math.abs(p - price) / atr : null,
    });
  }
  return out.sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct));
}

/** «Yahoo» quote date "10/16/2026" → "2026-10-16". */
export function quoteDateIso(d: string | null | undefined): string | null {
  if (!d) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d);
  if (!m) return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

const NY_STAMP = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
/** «YYYY-MM-DD HH:mm» in New York for an ISO instant (null when unparsable). */
export function nyStamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(NY_STAMP.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * Was the row put into «Сегодня» for an earlier session? `prevSession` = the trading day before the session
 * being prepared; anything moved in before its 16:00 ET close belonged to that (or an older) session.
 * Rows without a timestamp are not judged.
 */
export function isStaleToday(inPlayAt: string | null | undefined, prevSession: string): boolean {
  const s = nyStamp(inPlayAt);
  return s != null && s < `${prevSession} 16:00`;
}

/** Copy text to the clipboard; false when the browser refuses (no permission / insecure context). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Unfocused document / no permission: the legacy selection copy still works from a user gesture.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
