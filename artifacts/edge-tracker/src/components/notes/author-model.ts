/**
 * Author notes ("Сводка автора") — shared types, note-section model, templates and API helpers.
 * Sections are stored inside `raw_text` as `## Heading` blocks, so the DB schema and the
 * AI-improve endpoint stay unchanged and old free-form notes keep working.
 */
import type { CSSProperties } from "react";
import { http } from "@/lib/api/http";
import { isNotFound } from "@/lib/api/errors";
import { fmtRelative } from "@/lib/format";
import { commonI18n } from "@/i18n/ns/common";
import { notesI18n } from "@/i18n/ns/notes";

export type AuthorNote = {
  id: number;
  trader: string;
  note_date: string;
  raw_text: string;
  refined_text: string | null;
  mood: string | null;
  created_at: string;
  updated_at: string;
};

export type NoteRead = { reader: string; read_at: string };

/** The author's trading day attached to a feed note. `pnlNet` is null (redacted) for readers who may not see their $. */
export type DaySnapshot = {
  count: number;
  wins: number;
  losses: number;
  rSum: number | null;
  tickers: string[];
  pnlNet: number | null;
  redacted: boolean;
};

export type AudienceStage = "trainee" | "junior" | "trader" | "senior";
export type AudienceMember = { name: string; role: string; stage: AudienceStage | null; readAt: string | null };
/** GET /author-notes/:id/audience — who of the team has / has not read the note (unread first, trainees first). */
export type Audience = { total: number; read: number; members: AudienceMember[] };

const STAGE_TIER = { trainee: "tiers.intern", junior: "tiers.junior", trader: "tiers.trader", senior: "tiers.senior" } as const;
export function stageLabel(stage: AudienceStage): string {
  return commonI18n.t(STAGE_TIER[stage]);
}

export type FeedNote = AuthorNote & {
  reads: NoteRead[];
  read_by_me: boolean;
  /** Absent on older servers; null when the author had no trades that day. */
  day?: DaySnapshot | null;
  /** true when served by the old /team endpoint (server without read receipts yet). */
  legacy?: boolean;
};

export type WeeklySummary = {
  id: number;
  trader: string;
  week_start: string;
  week_end: string;
  summary: string;
  quote_of_week: string | null;
  created_at: string;
};

export type Horizon = "intraday" | "overnight" | "swing";

export type DayTrade = {
  id: number;
  ticker: string;
  date: string;
  side: string | null;
  setup: string | null;
  result: string;
  pnl: number | null;
  pnlNet: number | null;
  rMultiple: number | null;
  /** Signed R (sign from result), null while open. */
  rSigned: number | null;
  fees: number | null;
  horizon: Horizon;
  exitDate: string | null;
};

export type DayContext = {
  date: string;
  trader: string;
  trades: DayTrade[];
  held: DayTrade[];
  summary: {
    count: number;
    wins: number;
    losses: number;
    pnlNet: number | null;
    rSum: number | null;
    byHorizon: Record<Horizon, number>;
  };
};

/* ───────────────────────── Mood ───────────────────────── */

// `label` is a getter: read at render time in the current UI language.
export const MOODS = [
  { value: "focused", emoji: "🎯", score: 1, get label() { return notesI18n.t("author.mood.focused"); } },
  { value: "confident", emoji: "💪", score: 2, get label() { return notesI18n.t("author.mood.confident"); } },
  { value: "neutral", emoji: "😐", score: 0, get label() { return notesI18n.t("author.mood.neutral"); } },
  { value: "stressed", emoji: "😰", score: -1, get label() { return notesI18n.t("author.mood.stressed"); } },
  { value: "frustrated", emoji: "😤", score: -2, get label() { return notesI18n.t("author.mood.frustrated"); } },
] as const;

export type MoodValue = (typeof MOODS)[number]["value"];

export function moodOf(v: string | null | undefined) {
  return MOODS.find((m) => m.value === v) ?? null;
}

/* ───────────────────────── Sections ───────────────────────── */

export type SectionKey = "market" | "intraday" | "overnight" | "swing" | "lessons" | "hold" | "open";

export type SectionDef = {
  key: SectionKey;
  heading: string;
  group: "market" | "trades" | "lessons" | "plan";
  readonly label: string;
  readonly placeholder: string;
};

type GroupId = SectionDef["group"];
const group = (id: GroupId) => ({
  id,
  get title() { return notesI18n.t(`author.groups.${id}.title`); },
  get hint() { return notesI18n.t(`author.groups.${id}.hint`); },
});
export const SECTION_GROUPS: { id: GroupId; readonly title: string; readonly hint: string }[] = [
  group("market"), group("trades"), group("lessons"), group("plan"),
];

/** `heading` is the storage format inside raw_text («## Рынок») — RU in every UI language, never translated. */
const section = (key: SectionKey, heading: string, g: GroupId): SectionDef => ({
  key,
  heading,
  group: g,
  get label() { return notesI18n.t(`author.sections.${key}.label`); },
  get placeholder() { return notesI18n.t(`author.sections.${key}.placeholder`); },
});
export const SECTIONS: SectionDef[] = [
  section("market", "Рынок", "market"), // i18n-ignore
  section("intraday", "Сделки · интрадей", "trades"), // i18n-ignore
  section("overnight", "Сделки · овернайт", "trades"), // i18n-ignore
  section("swing", "Сделки · свинг", "trades"), // i18n-ignore
  section("lessons", "Уроки", "lessons"), // i18n-ignore
  section("hold", "План · держу на ночь", "plan"), // i18n-ignore
  section("open", "План · на открытии", "plan"), // i18n-ignore
];

export type Sections = Record<SectionKey, string>;
export type ParsedNote = { sections: Sections; free: string; structured: boolean };

export function emptySections(): Sections {
  return { market: "", intraday: "", overnight: "", swing: "", lessons: "", hold: "", open: "" };
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HEADING_RE = new RegExp(`^## (${SECTIONS.map((s) => escapeRe(s.heading)).join("|")})[ \\t]*$`, "gm");

/** Splits raw_text into known sections. Round-trips with serializeNote (incl. trailing newlines while typing). */
export function parseNote(raw: string): ParsedNote {
  const sections = emptySections();
  const text = raw ?? "";
  const matches = Array.from(text.matchAll(HEADING_RE));
  if (matches.length === 0) return { sections, free: text, structured: false };
  const stripSep = (s: string, hasNext: boolean) => (hasNext && s.endsWith("\n\n") ? s.slice(0, -2) : s);
  const firstIdx = matches[0]!.index ?? 0;
  const free = stripSep(text.slice(0, firstIdx), true);
  matches.forEach((m, i) => {
    const def = SECTIONS.find((s) => s.heading === m[1]);
    if (!def) return;
    const start = (m.index ?? 0) + m[0].length + 1; // skip heading line + its newline
    const next = matches[i + 1];
    const end = next ? next.index ?? text.length : text.length;
    const body = stripSep(text.slice(Math.min(start, end), end), !!next);
    sections[def.key] = sections[def.key] ? `${sections[def.key]}\n${body}` : body;
  });
  return { sections, free, structured: true };
}

export function serializeNote(sections: Sections, free: string): string {
  const blocks: string[] = [];
  if (free.length > 0) blocks.push(free);
  for (const s of SECTIONS) {
    const body = sections[s.key];
    if (body.length > 0) blocks.push(`## ${s.heading}\n${body}`);
  }
  return blocks.join("\n\n");
}

export function filledSections(raw: string): SectionKey[] {
  const p = parseNote(raw);
  return SECTIONS.filter((s) => p.sections[s.key].trim()).map((s) => s.key);
}

/** Plain-text preview without headings, for list rows. */
export function notePreview(raw: string, max = 180): string {
  const p = parseNote(raw);
  const parts = p.structured
    ? [p.free, ...SECTIONS.map((s) => p.sections[s.key])].filter((x) => x.trim())
    : [p.free];
  const flat = parts.join(" · ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function appendText(base: string, add: string): string {
  if (!base.trim()) return add;
  return base.endsWith("\n") ? base + add : `${base}\n${add}`;
}

/* ───────────────────────── Templates ───────────────────────── */

export type NoteTemplate = { id: string; name: string; description: string; sections: Partial<Sections>; custom?: boolean };

type BuiltinId = "standard" | "red" | "earnings" | "friday";
const TEMPLATE_SECTIONS: Record<BuiltinId, readonly SectionKey[]> = {
  standard: ["market", "intraday", "overnight", "swing", "lessons", "hold", "open"],
  red: ["intraday", "lessons", "open"],
  earnings: ["market", "overnight", "hold", "open"],
  friday: ["lessons", "swing", "hold", "open"],
};
/** Prompts are written in the UI language at the moment the template is applied (then they are the author's text). */
const builtin = (id: BuiltinId): NoteTemplate => ({
  id,
  get name() { return notesI18n.t(`author.templates.${id}.name`); },
  get description() { return notesI18n.t(`author.templates.${id}.description`); },
  get sections() {
    const out: Partial<Sections> = {};
    for (const k of TEMPLATE_SECTIONS[id]) {
      // «standard» lessons is a plain numbered list in every language.
      out[k] = id === "standard" && k === "lessons" ? "1. \n2. " : notesI18n.tryT(`author.templates.${id}.${k}`) ?? "";
    }
    return out;
  },
});
export const BUILTIN_TEMPLATES: NoteTemplate[] = [builtin("standard"), builtin("red"), builtin("earnings"), builtin("friday")];

const CUSTOM_TPL_KEY = "ws_author_notes_templates";

export function loadCustomTemplates(): NoteTemplate[] {
  try {
    const raw = localStorage.getItem(CUSTOM_TPL_KEY);
    const arr = raw ? (JSON.parse(raw) as NoteTemplate[]) : [];
    return Array.isArray(arr) ? arr.filter((t) => t && typeof t.name === "string").map((t) => ({ ...t, custom: true })) : [];
  } catch {
    return [];
  }
}

export function saveCustomTemplates(list: NoteTemplate[]) {
  try {
    localStorage.setItem(CUSTOM_TPL_KEY, JSON.stringify(list.slice(0, 12)));
  } catch { /* storage unavailable */ }
}

/** Fills only empty sections, so a template never overwrites what was already written. */
export function applyTemplate(raw: string, tpl: NoteTemplate): string {
  const p = parseNote(raw);
  const next = { ...p.sections };
  for (const s of SECTIONS) {
    const add = tpl.sections[s.key];
    if (add && !next[s.key].trim()) next[s.key] = add;
  }
  return serializeNote(next, p.free);
}

/* ───────────────────────── Dates ───────────────────────── */

export function localToday(): string {
  const d = new Date();
  return isoLocal(d);
}

export function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function isIsoDate(v: string | null | undefined): v is string {
  return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + "T12:00:00"));
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return isoLocal(d);
}

export function weekStartOf(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return isoLocal(d);
}

export function relTime(ts: number, now: number): string {
  return fmtRelative(ts, { now });
}

export function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr + "T12:00:00").getDay();
  return d === 0 || d === 6;
}

/** Consecutive weekdays (skipping weekends) ending today/yesterday that have a note. */
export function writingStreak(dates: Set<string>, today: string): number {
  let d = today;
  if (!dates.has(d)) d = addDays(d, -1);
  let n = 0;
  for (let i = 0; i < 400; i++) {
    if (isWeekend(d)) { d = addDays(d, -1); continue; }
    if (!dates.has(d)) break;
    n++;
    d = addDays(d, -1);
  }
  return n;
}

export function horizonLabel(h: Horizon): string {
  return commonI18n.t(`trading.${h}`);
}

export const CHART_TOOLTIP: CSSProperties = {
  backgroundColor: "hsl(var(--popover) / 0.92)",
  border: "1px solid hsl(var(--border))",
  color: "hsl(var(--popover-foreground))",
  borderRadius: 12,
  fontSize: 12,
  backdropFilter: "blur(24px)",
  fontVariantNumeric: "tabular-nums",
};

/* ───────────────────────── API ───────────────────────── */

export const AN_KEYS = {
  all: ["author-notes"] as const,
  note: (trader: string, date: string) => ["author-notes", "note", trader, date] as const,
  history: (trader: string) => ["author-notes", "history", trader] as const,
  feed: (from: string, to: string) => ["author-notes", "feed", from, to] as const,
  day: (date: string) => ["author-notes", "day-context", date] as const,
  weekly: (trader: string, week: string) => ["author-notes", "weekly", trader, week] as const,
  reads: (id: number) => ["author-notes", "reads", id] as const,
  audience: (id: number) => ["author-notes", "audience", id] as const,
};

/** Team feed with read receipts; falls back to the per-day /team list on servers without /feed. */
export async function fetchFeed(from: string, to: string): Promise<FeedNote[]> {
  try {
    return await http.get<FeedNote[]>(`/api/author-notes/feed?from=${from}&to=${to}`);
  } catch (e) {
    if (!isNotFound(e)) throw e;
    const rows = await http.get<AuthorNote[]>(`/api/author-notes/team?date=${to}`);
    return rows
      .filter((n) => n.raw_text?.trim() || n.refined_text)
      .map((n) => ({ ...n, reads: [], read_by_me: true, legacy: true }));
  }
}
