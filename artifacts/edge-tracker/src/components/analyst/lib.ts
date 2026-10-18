/**
 * Analyst actions — pure helpers (formatting, NY-time session logic, scoring, persisted view state).
 */
import type { Tone } from "@/components/ds";
import { fmtDate, fmtPct, fmtRelative, fmtUsd, fmtWeekday } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { analystI18n } from "@/i18n/ns/analyst";

export type ActionKind = "upgrade" | "downgrade" | "initiated" | "maintain" | "reiterated" | "other";

export type FeedAction = {
  id: number;
  ticker: string;
  firm: string;
  action: ActionKind;
  actionRaw: string;
  toGrade: string | null;
  fromGrade: string | null;
  source: string;
  sourceUrl: string | null;
  gradedAt: string | null;
  priceTarget: string | null;
  priceTargetFrom: string | null;
  marketCap: string | null;
  marketCapNum: number | null;
  sector: string | null;
  longName: string | null;
};

export type FeedResponse = {
  items: FeedAction[];
  count: number;
  availableFirms: string[];
  /** Added by the 2026 API pass; may be missing on older builds. */
  capStats?: { known: number; unknown: number };
};

export type Quote = {
  price: number | null;
  change: number | null;
  gapPct: number | null;
  prevClose: number | null;
  relativeVolume?: number | null;
  /** Premarket % change vs the previous close (null outside premarket). */
  preMarketChange?: number | null;
  name?: string | null;
  spark?: number[];
  marketTime?: number | null;
};

export type OpenPosition = {
  id: number;
  ticker: string;
  trader: string | null;
  horizon: "intraday" | "overnight" | "swing";
  side: string | null;
  date: string;
};

/* ── Kinds ─────────────────────────────────────────────────────────────── */

const kindMeta = (k: ActionKind, tone: Tone) => ({
  tone,
  get label() { return analystI18n.t(`kind.label.${k}`); },
  get short() { return analystI18n.t(`kind.short.${k}`); },
});
/** Action kind → label / short label (read from the dictionary at access time) and tone. */
export const KIND_META: Record<ActionKind, { readonly label: string; readonly short: string; tone: Tone }> = {
  upgrade: kindMeta("upgrade", "up"),
  downgrade: kindMeta("downgrade", "down"),
  initiated: kindMeta("initiated", "accent"),
  maintain: kindMeta("maintain", "neutral"),
  reiterated: kindMeta("reiterated", "neutral"),
  other: kindMeta("other", "neutral"),
};

export type TypeFilter = "all" | "moves" | "upgrade" | "downgrade" | "initiated" | "targets";

export function matchesType(a: FeedAction, t: TypeFilter): boolean {
  switch (t) {
    case "all": return true;
    case "moves": return a.action === "upgrade" || a.action === "downgrade";
    case "upgrade": return a.action === "upgrade";
    case "downgrade": return a.action === "downgrade";
    case "initiated": return a.action === "initiated";
    case "targets": return a.action === "maintain" || a.action === "reiterated" || a.action === "other";
  }
}

/* ── Numbers ───────────────────────────────────────────────────────────── */

export function num(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** % change of the price target (from → to). */
export function ptChangePct(a: FeedAction): number | null {
  const to = num(a.priceTarget);
  const from = num(a.priceTargetFrom);
  if (to == null || from == null) return null;
  const p = ((to - from) / from) * 100;
  return Math.abs(p) > 300 ? null : p;
}

/** Upside of the new target vs the current price. */
export function upsidePct(a: FeedAction, price: number | null | undefined): number | null {
  const to = num(a.priceTarget);
  if (to == null || price == null || !(price > 0)) return null;
  return ((to - price) / price) * 100;
}

/** Gap the trader sees now: premarket change while premarket is live, else the last session's open gap. */
export function gapOf(q: Quote | null | undefined): number | null {
  if (!q) return null;
  if (q.preMarketChange != null && Number.isFinite(q.preMarketChange)) return q.preMarketChange;
  return q.gapPct != null && Number.isFinite(q.gapPct) ? q.gapPct : null;
}

/* ── New York clock ────────────────────────────────────────────────────── */

const NY = "America/New_York";
const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
});

type NyParts = { day: string; hhmm: string; minutes: number; weekday: number };
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function nyParts(d: Date): NyParts {
  const p: Record<string, string> = {};
  for (const x of partsFmt.formatToParts(d)) p[x.type] = x.value;
  const hh = p.hour === "24" ? "00" : p.hour;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hhmm: `${hh}:${p.minute}`,
    minutes: Number(hh) * 60 + Number(p.minute),
    weekday: WD[p.weekday] ?? 1,
  };
}

/** "YYYY-MM-DD HH:mm" in New York — sortable wall-clock key. */
export function nyKey(iso: string | null): string {
  if (!iso) return "";
  const p = nyParts(new Date(iso));
  return `${p.day} ${p.hhmm}`;
}

function shiftDay(day: string, delta: number): { day: string; weekday: number } {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta, 12));
  return { day: dt.toISOString().slice(0, 10), weekday: dt.getUTCDay() };
}

/**
 * Start of the "today" window for premarket prep: 16:00 ET of the weekday before the
 * session we are preparing for. After 20:00 ET (or on weekends) we prepare for the next weekday.
 */
export function sessionWindow(now = new Date()): { startKey: string; sessionDay: string; label: string } {
  const p = nyParts(now);
  let target = { day: p.day, weekday: p.weekday };
  if (p.weekday === 0 || p.weekday === 6 || p.minutes >= 20 * 60) {
    do { target = shiftDay(target.day, 1); } while (target.weekday === 0 || target.weekday === 6);
  }
  let prev = shiftDay(target.day, -1);
  while (prev.weekday === 0 || prev.weekday === 6) prev = shiftDay(prev.day, -1);
  const wd = fmtWeekday(prev.weekday, "short");
  return { startKey: `${prev.day} 16:00`, sessionDay: target.day, label: analystI18n.t("sinceClose", { weekday: wd }) };
}

export type Session = "pre" | "rth" | "post";
export function sessionOf(iso: string | null): Session | null {
  if (!iso) return null;
  const m = nyParts(new Date(iso)).minutes;
  if (m < 9 * 60 + 30) return "pre";
  if (m < 16 * 60) return "rth";
  return "post";
}
export const SESSION_LABEL = {} as Record<Session, string>;
for (const k of ["pre", "rth", "post"] as const) Object.defineProperty(SESSION_LABEL, k, { get: () => analystI18n.t(`session.${k}`), enumerable: true });

export function nyTime(iso: string | null): string {
  return iso ? nyParts(new Date(iso)).hhmm : "—";
}

export function dayTitle(day: string, today: string): string {
  if (day === today) return commonI18n.t("time.today");
  if (day === shiftDay(today, -1).day) return commonI18n.t("time.yesterday");
  const s = fmtDate(day, "weekdayDayMonth");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function relAgo(iso: string | null): string {
  if (!iso) return "";
  return fmtRelative(iso, { style: "short" });
}

/* ── Ratings ───────────────────────────────────────────────────────────── */

export type Stance = "buy" | "hold" | "sell";
const BUY_RE = /(strong\s*buy|buy|outperform|overweight|accumulate|positive|add|conviction|top pick)/i;
const SELL_RE = /(sell|underperform|underweight|reduce|negative)/i;
export function stanceOf(grade: string | null): Stance | null {
  if (!grade) return null;
  if (SELL_RE.test(grade)) return "sell";
  if (BUY_RE.test(grade)) return "buy";
  return "hold";
}

/* ── Firms: tier ───────────────────────────────────────────────────────── */

/** Bulge-bracket and research houses whose rating changes usually move the tape. */
const TOP_FIRM_RE = /(goldman|morgan stanley|jp\s?morgan|\bb\.?\s?of\s?a\b|bofa|bank of america|citi|wells fargo|barclays|\bubs\b|deutsche|jefferies|bernstein|evercore|wolfe|melius)/i;

/** Market reaction to a firm's calls (subset of the firm-weight API row). */
export type FirmWeightLite = { n: number; ratio: number | null; hit: number | null; avgSignedDay: number | null };

/** Minimum sample for showing a firm's weight. */
export const WEIGHT_MIN_N = 5;

/** «Топ-фирма»: big name, or the market reliably reacts to it (weight ≥ 1.8 on ≥ 8 rating calls). */
export function isTopFirm(firm: string, w?: FirmWeightLite | null): boolean {
  if (TOP_FIRM_RE.test(firm)) return true;
  return !!w && w.n >= 8 && (w.ratio ?? 0) >= 1.8;
}

/* ── Importance score for premarket scanning ───────────────────────────── */

export type ScoreReason = { key: string; label: string; tone: Tone };
export type ScoreCtx = {
  held: boolean;
  watched: boolean;
  /** How many of my closed trades are on this ticker (0 = never traded). */
  traded: number;
  top: boolean;
  weight?: FirmWeightLite | null;
  gapPct?: number | null;
};

/**
 * Importance of an action for the coming session. Rating change > initiation > target update; boosted by a
 * top-tier or high-weight firm, a big target change, the trader's own names (position, watchlist, traded) and
 * an already visible gap. Reasons explain the score in the UI (never more than four).
 */
export function scoreAction(a: FeedAction, ctx: ScoreCtx): { score: number; reasons: ScoreReason[] } {
  let s = 0;
  const reasons: ScoreReason[] = [];
  if (a.action === "upgrade" || a.action === "downgrade") s += 100;
  else if (a.action === "initiated") s += 50;
  const t = analystI18n.t;
  if (ctx.held) { s += 200; reasons.push({ key: "held", label: t("reason.held"), tone: "warn" }); }
  if (ctx.top) { s += 40; reasons.push({ key: "top", label: t("reason.top"), tone: "accent" }); }
  const w = ctx.weight;
  if (w && w.n >= WEIGHT_MIN_N && w.ratio != null && w.ratio >= 1.5) {
    s += Math.min(40, (w.ratio - 1) * 25);
    reasons.push({ key: "weight", label: t("reason.weight", { value: w.ratio.toFixed(1) }), tone: "purple" });
  }
  const pt = ptChangePct(a);
  if (pt != null) {
    s += Math.min(60, Math.abs(pt) * 2);
    if (Math.abs(pt) >= 10) reasons.push({ key: "pt", label: `PT ${fmtPct(pt, 0)}`, tone: pt > 0 ? "up" : "down" });
  }
  if (ctx.watched) { s += 50; reasons.push({ key: "watch", label: t("reason.watch"), tone: "accent" }); }
  if (ctx.traded > 0) {
    s += 30 + Math.min(30, ctx.traded);
    reasons.push({ key: "traded", label: t("reason.traded", { count: ctx.traded }), tone: "neutral" });
  }
  if (ctx.gapPct != null && Math.abs(ctx.gapPct) >= 2) {
    s += 20;
    reasons.push({ key: "gap", label: t("reason.gap", { value: fmtPct(ctx.gapPct, 1) }), tone: ctx.gapPct > 0 ? "up" : "down" });
  }
  return { score: Math.round(s), reasons: reasons.slice(0, 4) };
}

/* ── Filters (persisted) ───────────────────────────────────────────────── */

const period = <V extends string>(value: V) => ({ value, get label() { return analystI18n.t("period.d", { count: value }); } });
/** Data windows; labels («5д» / "5d" / "5k") follow the UI language. */
export const PERIODS = [period("1"), period("3"), period("5"), period("14"), period("30"), period("90")] as const;
export type Period = (typeof PERIODS)[number]["value"];

export const CAP_PRESETS = [0, 1, 2, 10, 50, 200] as const;
export const PT_SIZES = [0, 5, 10, 20] as const;
export type PtSize = (typeof PT_SIZES)[number];
export type TierFilter = "all" | "top" | "other";
export type SortKey = "score" | "time" | "pt" | "gap" | "weight" | "ticker";

export type Filters = {
  type: TypeFilter;
  tier: TierFilter;
  /** Minimal |target change|, %. 0 = any (also rows without a target). */
  ptMin: PtSize;
  sector: string | null;
  mineOnly: boolean;
  todayOnly: boolean;
  period: Period;
  minCapB: number;
  includeUnknownCap: boolean;
};

export const DEFAULT_FILTERS: Filters = {
  type: "all",
  tier: "all",
  ptMin: 0,
  sector: null,
  mineOnly: false,
  todayOnly: false,
  period: "5",
  minCapB: 0,
  includeUnknownCap: true,
};

/** Stored value → valid Filters (older / partial objects from localStorage). */
export function normalizeFilters(raw: unknown): Filters {
  const v = { ...DEFAULT_FILTERS, ...(raw && typeof raw === "object" ? (raw as Partial<Filters>) : {}) };
  if (!PERIODS.some((p) => p.value === v.period)) v.period = DEFAULT_FILTERS.period;
  if (!(PT_SIZES as readonly number[]).includes(v.ptMin)) v.ptMin = 0;
  if (!["all", "top", "other"].includes(v.tier)) v.tier = "all";
  if (!["all", "moves", "upgrade", "downgrade", "initiated", "targets"].includes(v.type)) v.type = "all";
  if (typeof v.minCapB !== "number" || !Number.isFinite(v.minCapB)) v.minCapB = 0;
  return v;
}

/** Filters that differ from the defaults (except the data window: period / cap). */
export function activeFilterCount(f: Filters): number {
  let n = 0;
  if (f.type !== "all") n++;
  if (f.tier !== "all") n++;
  if (f.ptMin) n++;
  if (f.sector) n++;
  if (f.mineOnly) n++;
  if (f.todayOnly) n++;
  return n;
}

export type SavedView = { id: string; name: string; filters: Filters };

export type FilterCtx = {
  isMine: (ticker: string) => boolean;
  isTop: (firm: string) => boolean;
  /** NY wall-clock key of the session window start ("YYYY-MM-DD HH:mm"). */
  windowStart: string;
};

/** Client-side filters (period and cap are applied by the API query). */
export function matchesFilters(a: FeedAction, f: Filters, ctx: FilterCtx, search = ""): boolean {
  if (!matchesType(a, f.type)) return false;
  if (f.tier === "top" && !ctx.isTop(a.firm)) return false;
  if (f.tier === "other" && ctx.isTop(a.firm)) return false;
  if (f.ptMin) {
    const p = ptChangePct(a);
    if (p == null || Math.abs(p) < f.ptMin) return false;
  }
  if (f.sector && (a.sector ?? "") !== f.sector) return false;
  if (f.mineOnly && !ctx.isMine(a.ticker)) return false;
  if (f.todayOnly && nyKey(a.gradedAt) < ctx.windowStart) return false;
  const s = search.trim().toLowerCase();
  if (s && !a.ticker.toLowerCase().startsWith(s) && !a.firm.toLowerCase().includes(s)) return false;
  return true;
}

/** Last session day (NY date) before the window start that has actions — fallback for a quiet premarket. */
export function previousSessionDay(items: FeedAction[], windowStart: string): string | null {
  let best: string | null = null;
  for (const a of items) {
    const k = nyKey(a.gradedAt);
    if (!k || k >= windowStart) continue;
    const d = k.slice(0, 10);
    if (!best || d > best) best = d;
  }
  return best;
}

/** Short Russian date «16 окт» for a YYYY-MM-DD. */
export function shortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return fmtDate(day, "dayMonth").replace(".", "");
}

export function watchlistCatalyst(a: FeedAction): string {
  const kind = KIND_META[a.action].label;
  const grade = a.fromGrade && a.toGrade && a.fromGrade !== a.toGrade ? `${a.fromGrade} → ${a.toGrade}` : a.toGrade ?? "";
  const to = num(a.priceTarget);
  const from = num(a.priceTargetFrom);
  const pt = to != null ? ` · PT ${from != null ? `${fmtUsd(from, { decimals: "trim" })} → ` : ""}${fmtUsd(to, { decimals: "trim" })}` : "";
  return `${kind}: ${a.firm}${grade ? ` ${grade}` : ""}${pt}`.slice(0, 240);
}
