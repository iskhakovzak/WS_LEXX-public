// Review presets ("smart views") and the quick-tag vocabulary of the trades page.
// The predicates mirror the server (api-server lib/tradesPageQuery.ts → presetPredicate) so the page works the same
// while the running API predates `?preset=` (then the client filters the full filtered list itself).
import type { Trade } from "@workspace/api-client-react";
import { MISTAKE_TAGS } from "@/components/eod/eod-api";
import { tradesI18n } from "@/i18n/ns/trades";
export { tagLabel, tagMatches } from "@/components/shared/trade-labels";
import { holdSeconds, netPnl, resultKey, splitTags, tradeWall, type SortConfig } from "./trade-utils";

export const PRESETS = ["review", "worst", "best", "scalp", "fees", "revenge"] as const;
export type Preset = (typeof PRESETS)[number];

/** Same thresholds as the server (SCALP_MAX_SEC / FEES_SHARE / REVENGE_WINDOW_MIN). */
export const SCALP_MAX_SEC = 120;
export const FEES_SHARE = 0.5;
export const REVENGE_WINDOW_MIN = 10;

export type PresetMeta = {
  key: Preset;
  label: string;
  /** One line under the bar: why this view is worth a look. */
  why: string;
  /** Default ordering of the view. */
  sort: SortConfig;
  tone: "warn" | "down" | "up" | "accent" | "purple";
};

const PRESET_BASE: Record<Preset, Pick<PresetMeta, "sort" | "tone">> = {
  review: { sort: { col: "impact", dir: "desc" }, tone: "warn" },
  worst: { sort: { col: "pnl", dir: "asc" }, tone: "down" },
  best: { sort: { col: "pnl", dir: "desc" }, tone: "up" },
  scalp: { sort: { col: "date", dir: "desc" }, tone: "accent" },
  fees: { sort: { col: "fees", dir: "desc" }, tone: "warn" },
  revenge: { sort: { col: "date", dir: "desc" }, tone: "purple" },
};

/** Label and «why» are read in the current language on access. */
export const PRESET_META: Record<Preset, PresetMeta> = Object.fromEntries(
  PRESETS.map((key) => [key, {
    key,
    get label() { return tradesI18n.t(`presets.${key}.label`); },
    get why() { return tradesI18n.t(`presets.${key}.why`); },
    ...PRESET_BASE[key],
  }]),
) as Record<Preset, PresetMeta>;

export function isPreset(v: string | null | undefined): v is Preset {
  return !!v && (PRESETS as readonly string[]).includes(v);
}

// ── Quick-tag vocabulary ─────────────────────────────────────────────────────

/** Mistakes: the same list as the EOD review (one vocabulary across the desk). */
export const MISTAKES: readonly string[] = MISTAKE_TAGS;
// Stored values (codes): the Russian word is what trades.tags keeps; `tagLabel` shows it in the UI language.
// i18n-ignore (stored tag codes)
export const EMOTIONS: readonly string[] = ["Спокойствие", "Уверенность", "Страх", "Жадность", "Тильт", "Скука", "Нетерпение", "Эйфория"];


const MISTAKE_SET = new Set(MISTAKES.map((m) => m.toLowerCase()));
const EMOTION_SET = new Set(EMOTIONS.map((m) => m.toLowerCase()));

export type TagKind = "setup" | "mistake" | "emotion";

/** Split the free `tags` column into mistakes / emotions / other tags (case-insensitive vocabulary match). */
export function classifyTags(tags: string | null | undefined): { mistakes: string[]; emotions: string[]; other: string[] } {
  const out = { mistakes: [] as string[], emotions: [] as string[], other: [] as string[] };
  for (const t of splitTags(tags)) {
    const k = t.toLowerCase();
    if (MISTAKE_SET.has(k)) out.mistakes.push(t);
    else if (EMOTION_SET.has(k)) out.emotions.push(t);
    else out.other.push(t);
  }
  return out;
}

/** Toggle one tag in the comma list; returns the new column value (null when empty). */
export function toggleTag(tags: string | null | undefined, tag: string): string | null {
  const cur = splitTags(tags);
  const has = cur.some((c) => c.toLowerCase() === tag.toLowerCase());
  const next = has ? cur.filter((c) => c.toLowerCase() !== tag.toLowerCase()) : [...cur, tag];
  return next.length ? next.join(", ") : null;
}

export function hasTag(tags: string | null | undefined, tag: string): boolean {
  return splitTags(tags).some((c) => c.toLowerCase() === tag.toLowerCase());
}

// ── Client-side predicates (fallback while the API has no ?preset=) ─────────

/** Closed trade without setup, tags, notes or review text. */
export function isUnreviewed(t: Trade): boolean {
  if (resultKey(t.result) === "open") return false;
  const blank = (v: string | null | undefined) => !v || !v.trim();
  return blank(t.setup) && blank(t.tags) && blank(t.notes) && blank(t.whatWorked) && blank(t.whatFailed) && blank(t.conclusion);
}

function feesHeavy(t: Trade): boolean {
  if (t.pnl == null || !t.fees) return false;
  return Math.abs(t.fees) >= FEES_SHARE * Math.abs(t.pnl);
}

/** Ids entered < REVENGE_WINDOW_MIN after closing a losing trade the same day (per trader, by broker times). */
export function revengeIds(list: Trade[]): Set<number> {
  const groups = new Map<string, { t: Trade; o: number; c: number | null }[]>();
  for (const t of list) {
    const w = tradeWall(t);
    if (!w.open) continue;
    const o = Date.parse(`${w.open.slice(0, 19)}Z`);
    if (!Number.isFinite(o)) continue;
    const c = w.close ? Date.parse(`${w.close.slice(0, 19)}Z`) : NaN;
    const k = `${t.trader ?? ""}|${t.date.slice(0, 10)}`;
    const arr = groups.get(k) ?? [];
    arr.push({ t, o, c: Number.isFinite(c) ? c : null });
    groups.set(k, arr);
  }
  const out = new Set<number>();
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.o - b.o || a.t.id - b.t.id);
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1], cur = arr[i];
      const pn = netPnl(prev.t);
      if (pn == null || pn >= 0 || prev.c == null) continue;
      const gap = cur.o - prev.c;
      if (gap >= 0 && gap < REVENGE_WINDOW_MIN * 60_000) out.add(cur.t.id);
    }
  }
  return out;
}

/** Filter a list by a preset (client fallback). `revenge` is computed over the list itself. */
export function applyPreset(list: Trade[], preset: Preset): Trade[] {
  switch (preset) {
    case "review": return list.filter(isUnreviewed);
    case "best": return list.filter((t) => t.pnl != null && (netPnl(t) ?? 0) > 0);
    case "worst": return list.filter((t) => t.pnl != null && (netPnl(t) ?? 0) < 0);
    case "scalp": return list.filter((t) => { const h = holdSeconds(t); return h != null && h < SCALP_MAX_SEC; });
    case "fees": return list.filter(feesHeavy);
    case "revenge": { const ids = revengeIds(list); return list.filter((t) => ids.has(t.id)); }
  }
}

/** Counts per preset (badges) over a list. */
export function presetCounts(list: Trade[]): Record<Preset, number> {
  const rev = revengeIds(list);
  const out: Record<Preset, number> = { review: 0, worst: 0, best: 0, scalp: 0, fees: 0, revenge: rev.size };
  for (const t of list) {
    if (isUnreviewed(t)) out.review++;
    const n = t.pnl != null ? netPnl(t) : null;
    if (n != null && n > 0) out.best++;
    if (n != null && n < 0) out.worst++;
    const h = holdSeconds(t);
    if (h != null && h < SCALP_MAX_SEC) out.scalp++;
    if (feesHeavy(t)) out.fees++;
  }
  return out;
}
