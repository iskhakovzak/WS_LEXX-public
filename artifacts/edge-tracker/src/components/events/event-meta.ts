import type { MarketEvent } from "@workspace/api-client-react";
import type { Tone } from "@/components/ds";
import { nyDate, addDays as addNyDays } from "@/lib/trading-date";
import { fmtDate, fmtDateCustom, fmtDateRange, fmtWeekday, type DateStyle } from "@/lib/format";
import { eventsI18n } from "@/i18n/ns/events";

/* ───────────── Event types ───────────── */

export const EVENT_TYPES = ["earnings", "momentum", "news", "ipo", "fed", "macro", "short_squeeze", "upg", "dwg", "other"] as const;

type TypeKey = "earnings" | "momentum" | "news" | "ipo" | "fed" | "macro" | "economic" | "short_squeeze" | "upg" | "dwg" | "other";
const TYPE_TONE: Record<TypeKey, Tone> = {
  earnings: "accent", momentum: "purple", news: "warn", ipo: "purple", fed: "accent", macro: "accent",
  economic: "accent", short_squeeze: "warn", upg: "up", dwg: "down", other: "neutral",
};
const isTypeKey = (k: string): k is TypeKey => Object.prototype.hasOwnProperty.call(TYPE_TONE, k);

/** Legacy rows store types in other casing ("News", "Earnings") — compare case-insensitively. */
export const normType = (t: string | null | undefined) => (t ?? "").trim().toLowerCase();

export function typeMeta(t: string | null | undefined): { label: string; tone: Tone } {
  const k = normType(t);
  if (isTypeKey(k)) return { label: eventsI18n.t(`type.${k}`), tone: TYPE_TONE[k] };
  return { label: (t ?? "").trim() || eventsI18n.t("type.other"), tone: "neutral" };
}

/** Recharts fill for a tone (tokens only). */
export function toneFill(tone: Tone): string {
  switch (tone) {
    case "up": return "hsl(var(--up))";
    case "down": return "hsl(var(--down))";
    case "accent": return "hsl(var(--chart-1))";
    case "warn": return "hsl(var(--chart-3))";
    case "purple": return "hsl(var(--chart-5))";
    default: return "hsl(var(--muted-foreground))";
  }
}

/* ───────────── Reactions ───────────── */

export const REACTIONS = ["gap_up", "gap_down", "grind_up", "grind_down", "flat", "reversal"] as const;

type ReactionKey = (typeof REACTIONS)[number] | "bullish" | "bearish" | "mixed";
const REACTION_TONE: Record<ReactionKey, Tone> = {
  gap_up: "up", gap_down: "down", grind_up: "up", grind_down: "down", flat: "neutral", reversal: "warn",
  bullish: "up", bearish: "down", mixed: "neutral",
};
const isReactionKey = (k: string): k is ReactionKey => Object.prototype.hasOwnProperty.call(REACTION_TONE, k);

export function reactionMeta(r: string | null | undefined): { label: string; tone: Tone } | null {
  if (!r) return null;
  const k = r.trim().toLowerCase();
  return isReactionKey(k) ? { label: eventsI18n.t(`reaction.${k}`), tone: REACTION_TONE[k] } : { label: r, tone: "neutral" };
}

/** Direction of an event: sign of the logged move, else the reaction's tone. */
export function eventTone(e: MarketEvent): Tone {
  if (e.percentMove != null && e.percentMove !== 0) return e.percentMove > 0 ? "up" : "down";
  const r = reactionMeta(e.reaction);
  return r && (r.tone === "up" || r.tone === "down") ? r.tone : "neutral";
}

/* ───────────── Session (BMO / RTH / AMC) ─────────────
 * The API now stores the session in `market_events.session` (serialized as `session`).
 * Legacy rows kept it as a tag ("BMO" / "RTH" / "AMC") or a mention in the headline/summary. */

export type Session = "bmo" | "rth" | "amc";
const sessionDef = (value: Session, label: string, tone: Tone) => ({
  value, label, tone,
  get hint() { return eventsI18n.t(`session.${value}`); },
});
export const SESSIONS: { value: Session; label: string; readonly hint: string; tone: Tone }[] = [
  sessionDef("bmo", "BMO", "warn"),
  sessionDef("rth", "RTH", "accent"),
  sessionDef("amc", "AMC", "purple"),
];
const SESSION_TAGS = new Set(["bmo", "rth", "amc"]);

export function splitTags(tags: string | null | undefined): string[] {
  return (tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}

/** Tags without the session marker (session is shown as its own pill). */
export function displayTags(tags: string | null | undefined): string[] {
  return splitTags(tags).filter((t) => !SESSION_TAGS.has(t.toLowerCase()));
}

export function getSession(e: Pick<MarketEvent, "tags" | "headline" | "summary"> & { session?: string | null }): Session | null {
  const col = (e.session ?? "").trim().toLowerCase();
  if (SESSION_TAGS.has(col)) return col as Session;
  for (const t of splitTags(e.tags)) {
    const k = t.toLowerCase();
    if (SESSION_TAGS.has(k)) return k as Session;
  }
  const text = `${e.headline ?? ""} ${e.summary ?? ""}`;
  // Parses free text written in any UI language (legacy notes are Russian) — not UI copy.
  if (/\bBMO\b/i.test(text) || /до открытия|before the open|premarket|pre-market|ochilishdan oldin/i.test(text)) return "bmo"; // i18n-ignore
  if (/\bAMC\b/i.test(text) || /после закрытия|after the close|after hours|after-hours|yopilishdan keyin/i.test(text)) return "amc"; // i18n-ignore
  return null;
}

/** Merge a session marker into a tag string (replaces any previous marker). */
export function withSession(tags: string[], session: Session | null): string {
  const rest = tags.filter((t) => !SESSION_TAGS.has(t.toLowerCase()));
  return (session ? [session.toUpperCase(), ...rest] : rest).join(", ");
}

/* ───────────── Tickers ───────────── */

/** "XOM, CVX / BP" -> ["XOM","CVX","BP"] */
export function splitTickers(raw: string | null | undefined): string[] {
  return (raw ?? "").split(/[\s,;/]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
}

/* ───────────── Dates (YYYY-MM-DD strings; "today" = America/New_York trading date) ───────────── */

export const dayOf = (e: Pick<MarketEvent, "date">) => e.date.substring(0, 10);

export function parseYmd(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : new Date(s);
}

export function addDays(ymd: string, n: number): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? addNyDays(ymd, n) : ymd;
}

/** Monday of the week containing ymd (pure calendar arithmetic, time-zone independent). */
export function weekStartOf(ymd: string): string {
  const d = parseYmd(ymd);
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(ymd.substring(0, 10), -dow);
}

/** Trading "today" — the New York calendar date, not the browser's. */
export const today = () => nyDate();

/** Calendar date of the events area in the UI language, without a trailing dot («17 окт»). */
export function fmtDay(ymd: string, style: DateStyle | Intl.DateTimeFormatOptions = "dayMonth") {
  const d = parseYmd(ymd);
  return (typeof style === "string" ? fmtDate(d, style) : fmtDateCustom(d, style)).replace(/\.$/, "");
}

/** Capitalised weekday for column / row heads: «Пн» / «Понедельник». */
export function weekdayLabel(ymd: string, style: "short" | "long" = "short") {
  const s = fmtWeekday(parseYmd(ymd), style);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function fmtRange(fromYmd: string, toYmd: string) {
  // Shared range formatter: «19–23 окт. 2026 г.» / «Oct 19 – 23, 2026» / «19–23-okt, 2026» (Uzbek hand-written).
  return fmtDateRange(parseYmd(fromYmd), parseYmd(toYmd), "short");
}

/* ───────────── Numbers / words ───────────── */

/** Past event with neither a logged move nor a reaction — needs a follow-up. */
export function needsOutcome(e: MarketEvent, todayYmd = today()): boolean {
  return dayOf(e) < todayYmd && e.percentMove == null && !e.reaction;
}

/* ───────────── Macro calendar (holiday_calendar rows) ───────────── */

/** Macro codes read the same in every language; the rest go through `events.macro.*`. */
const MACRO_CODE: Record<string, string> = { fomc: "FOMC", cpi: "CPI", ppi: "PPI", nfp: "NFP", opex: "OPEX", pce: "PCE" };
const MACRO_WORD = ["quad_witching", "holiday", "month_end", "gdp"] as const;

export function macroLabel(type: string) {
  const k = type?.toLowerCase() ?? "";
  if (MACRO_CODE[k]) return MACRO_CODE[k];
  const w = MACRO_WORD.find((x) => x === k);
  if (w) return eventsI18n.t(`macro.${w}`);
  return type ? type.toUpperCase() : eventsI18n.t("macro.event");
}

export function importanceTone(imp: string): Tone {
  return imp === "high" ? "down" : imp === "medium" ? "warn" : "neutral";
}

/** "8:30am ET — …" -> "8:30 ET" */
export function macroTime(desc: string | null | undefined): string | null {
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*ET/i.exec(desc ?? "");
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3].toLowerCase() === "pm" && h < 12) h += 12;
  if (m[3].toLowerCase() === "am" && h === 12) h = 0;
  return `${h}:${m[2] ?? "00"} ET`;
}

export function isMarketClosed(h: { type: string; description: string | null }) {
  return h.type === "holiday" && /closed/i.test(h.description ?? "");
}

/* ───────────── Local storage (safe) ───────────── */

export function loadLS<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function saveLS(key: string, value: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ }
}
