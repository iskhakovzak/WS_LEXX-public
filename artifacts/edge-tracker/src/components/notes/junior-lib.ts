import type { CSSProperties } from "react";
import { fmtRelative } from "@/lib/format";
import { notesI18n } from "@/i18n/ns/notes";
import { comparePersonNames } from "@/i18n";

/* ───────────────────────── Types ───────────────────────── */

export const SECTION_KEYS = ["free", "plan", "intraday", "overnight", "swing", "mistakes", "lessons", "focus"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
export type Sections = Partial<Record<SectionKey, string>>;

export type JuniorNote = {
  id: number;
  trader: string;
  note_date: string;
  raw_text: string;
  refined_text: string | null;
  mood: string | null;
  sections?: Sections | null;
  curator_feedback?: string | null;
  curator_score?: number | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  feedback_seen_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type ScoreTrend = {
  scores: { date: string; score: number }[];
  avg: number | null;
  recent: number | null;
  delta: number | null;
  direction: "up" | "down" | "flat" | null;
};

export type RepeatedMistake = { key: string; label: string; count: number; last: string };

export type AttentionFlag = {
  kind: "unanswered" | "missed" | "low_score" | "falling" | "repeat";
  label: string;
  tone: "down" | "warn" | "accent";
};

export type OverviewRow = {
  trader: string;
  /** The reviewer's own junior (assigned curator / mentor). */
  mine?: boolean;
  note: {
    id: number;
    mood: string | null;
    words: number;
    preview: string;
    curator_score: number | null;
    reviewed_at: string | null;
    reviewed_by: string | null;
    updated_at: string;
  } | null;
  streak: number;
  last_note_date: string | null;
  notes_30d: number;
  unreviewed_14d: number;
  avg_score: number | null;
  reminder: { id: number; curator: string; created_at: string } | null;
  missed_run?: number;
  trend?: ScoreTrend;
  repeated?: RepeatedMistake[];
  attention?: AttentionFlag[];
  priority?: number;
};

/** GET /junior-notes/reviewer — who the caller may review. */
export type ReviewerInfo = {
  kind: "desk" | "scoped" | "none";
  via: "desk" | "assigned" | "mentor" | null;
  /** Scoped reviewers: the only juniors they review. */
  traders: string[] | null;
  /** «Мои джуны»: assigned curator / mentor of these. */
  mine: string[];
  /** Sees juniors' $ (staff). Mentors who are traders see R only. */
  money: boolean;
};

export function canReviewTrader(r: ReviewerInfo | null | undefined, trader: string, me: string): boolean {
  if (!r || r.kind === "none" || !trader || trader === me) return false;
  return r.kind === "desk" || (r.traders ?? []).includes(trader);
}

export type ContextTrade = {
  id: number;
  ticker: string;
  side: string | null;
  setup: string | null;
  horizon: string;
  result: string | null;
  date: string;
  exit_date: string | null;
  r: number | null;
  pnl_net: number | null;
};

/** GET /junior-notes/:id/context — what the reviewer sees next to the note. */
export type ReviewContext = {
  note_id: number;
  trader: string;
  date: string;
  trades: {
    opened: ContextTrade[];
    carried: ContextTrade[];
    totals: { count: number; wins: number; losses: number; r: number | null; pnl_net: number | null };
    money_visible: boolean;
  };
  prev: {
    id: number;
    note_date: string;
    focus: string | null;
    mistakes: string | null;
    lessons: string | null;
    curator_feedback: string | null;
    curator_score: number | null;
    reviewed_by: string | null;
  } | null;
  recent_feedback: { note_date: string; score: number | null; feedback: string | null; reviewed_by: string | null }[];
  trend: ScoreTrend;
  repeated: RepeatedMistake[];
  streak: number;
};

export type Reminder = { id: number; trader: string; note_date: string; curator: string; message: string | null; created_at: string };

/* ───────────────────────── Sections ───────────────────────── */

/** Section texts are getters: read at render time in the current UI language. */
function meta(k: SectionKey): { readonly title: string; readonly hint: string; readonly placeholder: string } {
  return {
    get title() { return notesI18n.t(`junior.sections.${k}.title`); },
    get hint() { return notesI18n.t(`junior.sections.${k}.hint`); },
    get placeholder() { return notesI18n.t(`junior.sections.${k}.placeholder`); },
  };
}

export const SECTION_META: Record<SectionKey, { readonly title: string; readonly hint: string; readonly placeholder: string }> = {
  free: meta("free"),
  plan: meta("plan"),
  intraday: meta("intraday"),
  overnight: meta("overnight"),
  swing: meta("swing"),
  mistakes: meta("mistakes"),
  lessons: meta("lessons"),
  focus: meta("focus"),
};

export const TRADE_SECTIONS: SectionKey[] = ["intraday", "overnight", "swing"];

export function emptySections(): Sections {
  return {};
}

/** Sections for a loaded note. Legacy notes (free text only) land in the untitled `free` block. */
export function sectionsOf(note: JuniorNote | null | undefined): Sections {
  if (!note) return {};
  if (note.sections && typeof note.sections === "object") return { ...note.sections };
  return note.raw_text?.trim() ? { free: note.raw_text } : {};
}

/**
 * Flat text for AI/search — mirrors composeSections() on the server byte for byte, so the headings are the
 * server's RU storage headings in every UI language (not display text).
 */
const COMPOSE_TITLES: Record<SectionKey, string> = {
  free: "",
  plan: "План", // i18n-ignore (server format)
  intraday: "Сделки — интрадей", // i18n-ignore (server format)
  overnight: "Сделки — овернайт", // i18n-ignore (server format)
  swing: "Сделки — свинг", // i18n-ignore (server format)
  mistakes: "Ошибки", // i18n-ignore (server format)
  lessons: "Уроки", // i18n-ignore (server format)
  focus: "Фокус на завтра", // i18n-ignore (server format)
};
export function composeSections(s: Sections): string {
  return SECTION_KEYS.filter((k) => s[k]?.trim())
    .map((k) => (COMPOSE_TITLES[k] ? `${COMPOSE_TITLES[k]}:\n${s[k]!.trim()}` : s[k]!.trim()))
    .join("\n\n");
}

/** Flat text for previews and search in the UI: the same blocks with headings in the UI language. */
export function previewSections(s: Sections): string {
  return SECTION_KEYS.filter((k) => s[k]?.trim())
    .map((k) => {
      if (k === "free") return s[k]!.trim();
      const title = TRADE_SECTIONS.includes(k) ? notesI18n.t("junior.tradesSection", { title: SECTION_META[k].title }) : SECTION_META[k].title;
      return `${title}: ${s[k]!.trim()}`;
    })
    .join("\n\n");
}

export function filledKeys(s: Sections): SectionKey[] {
  return SECTION_KEYS.filter((k) => s[k]?.trim());
}

export function wordCount(s: Sections): number {
  return SECTION_KEYS.reduce((n, k) => n + (s[k]?.trim() ? s[k]!.trim().split(/\s+/).length : 0), 0);
}

/* ───────────────────────── Templates ───────────────────────── */

export type Template = { id: string; readonly label: string; readonly sections: Sections };

type BuiltinId = "regular" | "red" | "carry" | "flat";
/** Prompts come in the UI language when applied; plain list markers and empty blocks are the same everywhere. */
const TEMPLATE_FIXED: Record<BuiltinId, Sections> = {
  regular: { mistakes: "1. ", lessons: "1. ", focus: "" },
  red: {},
  carry: {},
  flat: { lessons: "" },
};
const TEMPLATE_TEXT: Record<BuiltinId, readonly SectionKey[]> = {
  regular: ["plan", "intraday"],
  red: ["plan", "intraday", "mistakes", "lessons", "focus"],
  carry: ["overnight", "swing", "focus"],
  flat: ["plan", "mistakes"],
};
const builtin = (id: BuiltinId): Template => ({
  id,
  get label() { return notesI18n.t(`junior.templates.${id}.label`); },
  get sections() {
    const out: Sections = {};
    for (const k of SECTION_KEYS) {
      if (TEMPLATE_TEXT[id].includes(k)) out[k] = notesI18n.tryT(`junior.templates.${id}.${k}`) ?? "";
      else if (TEMPLATE_FIXED[id][k] != null) out[k] = TEMPLATE_FIXED[id][k];
    }
    return out;
  },
});
export const BUILTIN_TEMPLATES: Template[] = [builtin("regular"), builtin("red"), builtin("carry"), builtin("flat")];

const MY_TEMPLATE_KEY = "ws_lexx_junior_template";

export function loadMyTemplate(): Template | null {
  try {
    const raw = localStorage.getItem(MY_TEMPLATE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Sections;
    return s && typeof s === "object" ? { id: "mine", get label() { return notesI18n.t("myTemplate"); }, sections: s } : null;
  } catch {
    return null;
  }
}

export function saveMyTemplate(s: Sections): boolean {
  try {
    localStorage.setItem(MY_TEMPLATE_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

/** Fills only empty sections so a template never overwrites what the trader already wrote. */
export function applyTemplate(current: Sections, t: Template): Sections {
  const next = { ...current };
  for (const k of SECTION_KEYS) {
    const v = t.sections[k];
    if (v != null && !next[k]?.trim()) next[k] = v;
  }
  return next;
}

/* ───────────────────────── Mood ───────────────────────── */

// `label` is a getter: read at render time in the current UI language.
export const MOODS = [
  { value: "focused", score: 5, get label() { return notesI18n.t("junior.mood.focused"); } },
  { value: "confident", score: 4, get label() { return notesI18n.t("junior.mood.confident"); } },
  { value: "neutral", score: 3, get label() { return notesI18n.t("junior.mood.neutral"); } },
  { value: "stressed", score: 2, get label() { return notesI18n.t("junior.mood.stressed"); } },
  { value: "frustrated", score: 1, get label() { return notesI18n.t("junior.mood.frustrated"); } },
] as const;

/** Mood label by its 1–5 score (charts). */
export function moodLabelByScore(v: number): string {
  return MOODS.find((m) => m.score === v)?.label ?? String(v);
}

export function moodMeta(v: string | null | undefined) {
  return MOODS.find((m) => m.value === v) ?? null;
}

export function moodTone(v: string | null | undefined): "up" | "accent" | "neutral" | "warn" | "down" {
  const s = moodMeta(v)?.score;
  if (s == null) return "neutral";
  return s >= 5 ? "up" : s === 4 ? "accent" : s === 3 ? "neutral" : s === 2 ? "warn" : "down";
}

/* ───────────────────────── Dates ───────────────────────── */

export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function isWeekend(iso: string): boolean {
  const wd = new Date(iso + "T12:00:00").getDay();
  return wd === 0 || wd === 6;
}

export function prevTradingDay(iso: string): string {
  let d = addDays(iso, -1);
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}

export function nextTradingDay(iso: string): string {
  let d = addDays(iso, 1);
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
}

/** Last `n` trading days ending at `end` (inclusive if it is a weekday), oldest first. */
export function lastTradingDays(end: string, n: number): string[] {
  const out: string[] = [];
  let d = end;
  while (isWeekend(d)) d = addDays(d, -1);
  while (out.length < n) {
    out.push(d);
    d = prevTradingDay(d);
  }
  return out.reverse();
}

/** Consecutive trading days with a note, counting back from today (today may still be unwritten). */
export function streakOf(dates: Set<string>, today = localToday()): number {
  let d = today;
  while (isWeekend(d)) d = addDays(d, -1);
  if (!dates.has(d)) d = prevTradingDay(d);
  let n = 0;
  while (dates.has(d) && n < 400) {
    n++;
    d = prevTradingDay(d);
  }
  return n;
}

export function relTime(ts: string | number | null | undefined, now = Date.now()): string {
  if (ts == null) return "";
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return "";
  return fmtRelative(t, { now });
}

export function hasFeedback(n: Pick<JuniorNote, "reviewed_at">): boolean {
  return !!n.reviewed_at;
}

export function isUnread(n: Pick<JuniorNote, "reviewed_at" | "feedback_seen_at">): boolean {
  return !!n.reviewed_at && !n.feedback_seen_at;
}

/* ───────────────────────── API (requests: lib/api/http) ───────────────────────── */

export const qk = {
  all: ["junior-notes"] as const,
  day: (trader: string, date: string) => ["junior-notes", "day", trader, date] as const,
  history: (trader: string) => ["junior-notes", "history", trader] as const,
  team: (date: string) => ["junior-notes", "team", date] as const,
  overview: (date: string, scope: ReviewScopeFilter = "all") => ["junior-notes", "overview", date, scope] as const,
  reminders: ["junior-notes", "reminders", "me"] as const,
  /** Prefix — touch every scope with setQueriesData / invalidateQueries. */
  queue: ["junior-notes", "queue"] as const,
  queueOf: (scope: ReviewScopeFilter) => ["junior-notes", "queue", scope] as const,
  reviewer: ["junior-notes", "reviewer"] as const,
  context: (id: number) => ["junior-notes", "context", id] as const,
};

export type ReviewScopeFilter = "all" | "mine";

/* ───────────────────────── Review flow (senior) ───────────────────────── */

/** Built-in quick replies — short, concrete, in the desk's voice; in the reviewer's UI language. */
const SNIPPET_KEYS = ["good", "specific", "stop", "rule", "focus", "plan", "missedFocus"] as const;
export function builtinSnippets(): string[] {
  return SNIPPET_KEYS.map((k) => notesI18n.t(`junior.snippets.${k}`));
}

const SNIPPETS_KEY = "ws_lexx_junior_snippets";
const MAX_SNIPPETS = 10;

export function loadMySnippets(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SNIPPETS_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, MAX_SNIPPETS) : [];
  } catch {
    return [];
  }
}

export function saveMySnippets(list: string[]): boolean {
  try {
    localStorage.setItem(SNIPPETS_KEY, JSON.stringify(list.slice(0, MAX_SNIPPETS)));
    return true;
  } catch {
    return false;
  }
}

/** Adds a personal snippet on top (deduplicated, trimmed, capped). */
export function addSnippet(list: readonly string[], text: string): string[] {
  const t = text.trim().slice(0, 300);
  if (!t) return [...list];
  return [t, ...list.filter((x) => x !== t)].slice(0, MAX_SNIPPETS);
}

/** Appends a quick reply on its own line; a snippet already in the text is not added twice. */
export function appendSnippet(text: string, snippet: string): string {
  const s = snippet.trim();
  if (!s || text.includes(s)) return text;
  if (!text.trim()) return s;
  return /\n\s*$/.test(text) ? `${text}${s}` : `${text.replace(/\s+$/, "")}\n${s}`;
}

/* Feedback drafts survive closing the sheet / switching notes (per note, this browser only). */
const DRAFT_PREFIX = "ws_lexx_junior_draft:";
export type ReviewDraft = { feedback: string; score: number | null };

export function loadDraft(id: number): ReviewDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + id);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<ReviewDraft>;
    return { feedback: typeof d.feedback === "string" ? d.feedback : "", score: typeof d.score === "number" ? d.score : null };
  } catch {
    return null;
  }
}

export function saveDraft(id: number, d: ReviewDraft): void {
  try { localStorage.setItem(DRAFT_PREFIX + id, JSON.stringify(d)); } catch { /* ignore */ }
}

export function clearDraft(id: number): void {
  try { localStorage.removeItem(DRAFT_PREFIX + id); } catch { /* ignore */ }
}

export function hasDraft(id: number): boolean {
  try { return localStorage.getItem(DRAFT_PREFIX + id) != null; } catch { return false; }
}

/** A draft is worth keeping only when it differs from what is already saved on the note. */
export function draftDiffers(d: ReviewDraft, saved: { curator_feedback?: string | null; curator_score?: number | null }): boolean {
  return d.feedback.trim() !== (saved.curator_feedback ?? "").trim() || (d.score ?? null) !== (saved.curator_score ?? null);
}

export type ReviewKeyAction =
  | { type: "next" } | { type: "prev" } | { type: "send" } | { type: "focus" } | { type: "score"; value: number | null };

/**
 * Keyboard map of the review sheet. Outside text fields: J/→ next, K/← prev, 1–5 score, 0 clear, R focus the answer.
 * Anywhere: Ctrl/⌘+Enter send, Alt+1–5 score. Russian-layout letters (О, Л, К) work too.
 */
export function reviewKeyAction(
  e: { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean },
  inField: boolean,
): ReviewKeyAction | null {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") return { type: "send" };
  const digit = /^Digit([0-5])$/.exec(e.code ?? "")?.[1] ?? (/^[0-5]$/.test(e.key) ? e.key : null);
  if (e.altKey && !e.ctrlKey && !e.metaKey && digit != null) return { type: "score", value: digit === "0" ? null : Number(digit) };
  if (inField || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (digit != null && !e.shiftKey) return { type: "score", value: digit === "0" ? null : Number(digit) };
  const k = e.key.toLowerCase();
  // Russian-layout twins of J / K / R (physical keys), not UI text.
  if (k === "j" || k === "о" || e.key === "ArrowRight") return { type: "next" }; // i18n-ignore
  if (k === "k" || k === "л" || e.key === "ArrowLeft") return { type: "prev" }; // i18n-ignore
  if (k === "r" || k === "к") return { type: "focus" }; // i18n-ignore
  return null;
}

/**
 * Where «send and next» goes: the next item after `currentId` that still needs an answer (wrapping around),
 * or null when everything else in the list is answered.
 */
export function nextUnanswered<T extends { id: number; reviewed_at?: string | null }>(list: readonly T[], currentId: number): T | null {
  const i = Math.max(0, list.findIndex((n) => n.id === currentId));
  for (let k = 1; k <= list.length; k++) {
    const n = list[(i + k) % list.length]!;
    if (n.id !== currentId && !n.reviewed_at) return n;
  }
  return null;
}

/** Roster order for the senior: attention priority first, then name. */
export function byAttention<T extends { trader: string; priority?: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || comparePersonNames(a.trader, b.trader));
}

/** Whole calendar days between a note date and today (for «ждёт 3 дн.»). */
export function daysSince(iso: string, today = localToday()): number {
  const a = Date.parse(iso + "T12:00:00");
  const b = Date.parse(today + "T12:00:00");
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86_400_000)) : 0;
}

/* ───────────────────────── Chart styling ───────────────────────── */

export const TOOLTIP_STYLE: CSSProperties = {
  backgroundColor: "hsl(var(--popover) / 0.92)",
  border: "1px solid hsl(var(--border))",
  color: "hsl(var(--popover-foreground))",
  borderRadius: 12,
  fontSize: 12,
  boxShadow: "0 8px 32px rgb(0 0 0 / 0.3)",
  backdropFilter: "blur(24px)",
  fontVariantNumeric: "tabular-nums",
};
