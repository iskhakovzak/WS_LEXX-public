/** Trade ideas — shared types and pure helpers (levels parsing, R:R, pipeline stage). */
import type { Tone } from "@/components/ds";

import { fmtDate, fmtRelative } from "@/lib/format";
import { ideasI18n } from "@/i18n/ns/ideas";
import { commonI18n } from "@/i18n/ns/common";
import { personInitials } from "@/i18n";

export type Reaction = { id: number; tradeIdeaId: number; trader: string; reaction: string; comment: string | null; createdAt: string };
/** Trade linked to an idea. `r`/`net`/`outcome` are computed server-side with the shared trade math (R signed, net = gross − |fees|). */
export type LinkedTrade = {
  id: number; result: string; pnl: string | null; rMultiple: string | null; date: string;
  side?: string | null; entry?: string | null; exit?: string | null; stop?: string | null; fees?: string | null;
  riskUsd?: string | null; qty?: string | null; horizon?: string | null; exitDate?: string | null; trader?: string | null;
  r?: number | null; net?: number | null; outcome?: "win" | "loss" | "be" | "open" | null;
};
export type IdeaComment = { id: number; idea_id: number; author_name: string; text: string; is_private: boolean; source: string; created_at: string };

export type TradeIdea = {
  id: number; ticker: string; side: string | null; setup: string | null; entryZone: string | null;
  target: string | null; stop: string | null; thesis: string | null; score: number | null;
  scoreBreakdown: string | null; status: string; trader: string | null;
  playbookId: number | null; watchlistId: number | null; screenshotUrl: string | null;
  tags: string | null; publishedAt: string | null; convertedTradeId: number | null;
  createdAt: string; reactions: Reaction[]; linkedTrade: LinkedTrade | null;
  review_status: string | null; review_reason: string | null; reviewed_by: string | null; reviewed_at: string | null;
  riskAmount: string | null; setupQuality: string | null;
  sector?: string | null; longName?: string | null;
  commentCount?: number; lastCommentAt?: string | null; unreadCount?: number;
  /** Dedicated columns (trade_ideas.horizon / valid_until); `expired` = published, not converted, valid_until < today (NY). */
  horizon?: Horizon | null; validUntil?: string | null; expired?: boolean; ideaDate?: string | null;
  /** How the linked trade got attached: «auto» = matched to the author's PropReports trade, «manual» = linked by staff. */
  tradeLinkSource?: "auto" | "manual" | null; tradeLinkedAt?: string | null;
};

export type IdeaTracking = {
  ticker: string; price: number | null;
  hit: "target" | "final_target" | "stop" | null; hitAt: string | null; ambiguous: boolean;
  rNow: number | null; mfeR: number | null; maeR: number | null; plannedR: number;
  since: string;
};
export type TrackingResponse = { generatedAt: string; items: Record<string, IdeaTracking> };

// ─── Levels ────────────────────────────────────────────────────────────────

/** All positive numbers in a free-form level string ("180.5-181.2", "185 / 187", "$178"). Mirrors the API parser. */
export function parseLevelNumbers(raw: string | null | undefined): number[] {
  if (!raw) return [];
  const normalized = String(raw).replace(/(\d),(\d{3})(?!\d)/g, "$1$2").replace(/(\d),(\d)/g, "$1.$2");
  const out: number[] = [];
  for (const m of normalized.matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

export type LevelPlan = {
  isShort: boolean;
  entry: number | null;
  entryLow: number | null;
  entryHigh: number | null;
  stop: number | null;
  targets: number[]; // nearest first
  riskPerShare: number | null;
  rewardPerShare: number | null; // to first target
  rr: number | null; // to first target
  rrFinal: number | null; // to farthest target
  issues: string[]; // soft validation problems
};

export function levelPlan(side: string | null | undefined, entryZone: string | null | undefined, stop: string | null | undefined, target: string | null | undefined): LevelPlan {
  const isShort = (side ?? "").toLowerCase() === "short";
  const entries = parseLevelNumbers(entryZone);
  const stops = parseLevelNumbers(stop);
  const rawTargets = parseLevelNumbers(target);
  const entry = entries.length ? entries.reduce((a, b) => a + b, 0) / entries.length : null;
  const stopN = stops.length ? stops[0] : null;
  const targets = [...rawTargets].sort((a, b) => (isShort ? b - a : a - b));
  const issues: string[] = [];
  let riskPerShare: number | null = null;
  let rewardPerShare: number | null = null;
  let rr: number | null = null;
  let rrFinal: number | null = null;

  if (entry != null && stopN != null) {
    const wrongStop = isShort ? stopN <= entry : stopN >= entry;
    if (wrongStop) issues.push(ideasI18n.t(isShort ? "issues.stopShort" : "issues.stopLong"));
    else riskPerShare = Math.abs(entry - stopN);
  }
  if (entry != null && targets.length) {
    const wrongTarget = targets.some((t) => (isShort ? t >= entry : t <= entry));
    if (wrongTarget) issues.push(ideasI18n.t(isShort ? "issues.targetShort" : "issues.targetLong"));
    else rewardPerShare = Math.abs(targets[0] - entry);
  }
  if (riskPerShare && rewardPerShare != null) {
    rr = rewardPerShare / riskPerShare;
    rrFinal = Math.abs(targets[targets.length - 1] - (entry as number)) / riskPerShare;
    if (rr < 1) issues.push(ideasI18n.t("issues.rrBelowOne"));
  }
  if (entry != null && stopN != null && riskPerShare && riskPerShare / entry > 0.15) {
    issues.push(ideasI18n.t("issues.stopFar"));
  }
  return {
    isShort, entry,
    entryLow: entries.length ? Math.min(...entries) : null,
    entryHigh: entries.length ? Math.max(...entries) : null,
    stop: stopN, targets, riskPerShare, rewardPerShare, rr, rrFinal, issues,
  };
}

export function ideaPlan(i: Pick<TradeIdea, "side" | "entryZone" | "stop" | "target">): LevelPlan {
  return levelPlan(i.side, i.entryZone, i.stop, i.target);
}

export function rrTone(rr: number | null | undefined): Tone {
  if (rr == null) return "neutral";
  if (rr >= 2) return "up";
  if (rr >= 1) return "warn";
  return "down";
}

// ─── Pipeline stage ────────────────────────────────────────────────────────

export type Stage = "draft" | "review" | "active" | "won" | "lost" | "rejected";

type StageDef = { key: Stage; readonly label: string; readonly short: string; tone: Tone; readonly hint: string };
/** Labels are getters: read at render time in the current UI language. */
const stage = (key: Stage, tone: Tone): StageDef => ({
  key,
  tone,
  get label() { return ideasI18n.t(`stage.${key}.label`); },
  get short() { return ideasI18n.t(`stage.${key}.short`); },
  get hint() { return ideasI18n.t(`stage.${key}.hint`); },
});
export const STAGES: StageDef[] = [
  stage("draft", "neutral"), stage("review", "warn"), stage("active", "accent"),
  stage("won", "up"), stage("lost", "down"), stage("rejected", "purple"),
];
export const STAGE_BY_KEY = Object.fromEntries(STAGES.map((s) => [s.key, s])) as Record<Stage, (typeof STAGES)[number]>;

export function normalizeTradeResult(raw: string | null | undefined): "win" | "loss" | "breakeven" | "open" {
  const r = (raw ?? "").toLowerCase().trim();
  // Legacy stored values (some rows were written in Russian) — data parsing, not UI text.
  if (r === "win" || r === "winner" || r === "прибыль" || r === "profit" || r === "профит") return "win"; // i18n-ignore
  if (r === "loss" || r === "loser" || r === "убыток" || r === "убыточный" || r === "лосс") return "loss"; // i18n-ignore
  if (r === "breakeven" || r === "be" || r === "ноль" || r === "безубыток" || r === "бу") return "breakeven"; // i18n-ignore
  return "open";
}

/** Linked-trade R (server-computed with the shared trade math; falls back to the stored r_multiple for old payloads). */
export function linkedR(t: LinkedTrade | null | undefined): number | null {
  if (!t) return null;
  if (t.r != null && Number.isFinite(t.r)) return t.r;
  const o = normalizeTradeResult(t.result);
  if (o === "open") return null;
  if (o === "breakeven") return 0;
  const raw = t.rMultiple != null && t.rMultiple !== "" ? Number(t.rMultiple) : null;
  if (raw == null || !Number.isFinite(raw)) return null;
  return o === "win" ? Math.abs(raw) : o === "loss" ? -Math.abs(raw) : raw;
}

/**
 * Realised outcome of an idea: linked trade first, then the tracked hit.
 * "be" is kept apart so hit rate = won / (won + lost) excludes break-even, like every other win rate on the desk.
 */
export function ideaOutcome(i: TradeIdea, tr?: IdeaTracking | null): "win" | "loss" | "be" | null {
  if (i.status === "draft") return null;
  if (i.linkedTrade) {
    const o = i.linkedTrade.outcome ?? normalizeTradeResult(i.linkedTrade.result);
    if (o === "win") return "win";
    if (o === "loss") return "loss";
    if (o === "be" || o === "breakeven") return "be";
  }
  if (tr?.hit === "stop") return "loss";
  if (tr?.hit === "target" || tr?.hit === "final_target") return "win";
  return null;
}

/** Where an idea sits in the pipeline. Real outcome (linked trade, then tracked hit) beats review state. */
export function stageOf(i: TradeIdea, tr?: IdeaTracking | null): Stage {
  if (i.status === "draft") return "draft";
  const o = ideaOutcome(i, tr);
  if (o === "win") return "won";
  if (o === "loss" || o === "be") return "lost";
  if (i.status === "converted") return "active";
  if (i.review_status === "rejected") return "rejected";
  if (i.review_status === "approved") return "active";
  return "review";
}

/** Horizon: the dedicated column first, legacy tag (RU «Интрадей/Овернайт/Свинг») as fallback. */
export function ideaHorizon(i: Pick<TradeIdea, "horizon" | "tags">): Horizon | null {
  return i.horizon ?? horizonOf(i.tags);
}

export const SIDE_TONE = (side: string | null | undefined): Tone => (side === "Short" ? "down" : side === "Long" ? "up" : "neutral");

/** Display of the stored side code ("Long" / "Short"): RU «Лонг / Шорт», EN/UZ «Long / Short». Other values as is. */
export function sideLabel(side: string | null | undefined): string {
  if (side === "Long") return commonI18n.t("trading.long");
  if (side === "Short") return commonI18n.t("trading.short");
  return side ?? "";
}

export const QUALITY_TONE: Record<string, Tone> = { "A+": "up", A: "up", "B+": "accent", B: "accent", C: "warn", D: "down" };

export function scoreTone(score: number | null | undefined): Tone {
  if (score == null) return "neutral";
  return score >= 70 ? "up" : score >= 40 ? "warn" : "down";
}

export function splitTags(tags: string | null | undefined): string[] {
  return tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  // A week or more back reads better as a date.
  return diff < 7 * 86_400_000 ? fmtRelative(d) : fmtDate(d, "dayMonth");
}

/** Avatar initials of the person's display name (Latin in EN/UZ when set). */
export function initials(name: string | null | undefined): string {
  return personInitials(name);
}

/** Safe localStorage access (private mode / blocked storage). */
export function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
export function writePref(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

// ─── Horizon ───────────────────────────────────────────────────────────────
// Stored in trade_ideas.horizon (the API migrated the legacy tag once); the tag is still kept in sync for old filters.

export type Horizon = "intraday" | "overnight" | "swing";
export const HORIZONS: { key: Horizon; readonly label: string }[] = (["intraday", "overnight", "swing"] as const).map((key) => ({
  key,
  get label() { return commonI18n.t(`trading.${key}`); },
}));
/** Legacy horizon tag written into `tags` (the API parses it, RU in every UI language — a stored code, not display). */
const HORIZON_TAG: Record<Horizon, string> = { intraday: "Интрадей", overnight: "Овернайт", swing: "Свинг" }; // i18n-ignore
// Tag parsing accepts RU and EN spellings (data, not UI text).
const HORIZON_ALIASES: Record<string, Horizon> = {
  intraday: "intraday", "интрадей": "intraday", "интрадэй": "intraday", "day": "intraday", // i18n-ignore
  overnight: "overnight", "овернайт": "overnight", // i18n-ignore
  swing: "swing", "свинг": "swing", // i18n-ignore
};

export function horizonOf(tags: string | null | undefined): Horizon | null {
  for (const t of splitTags(tags)) {
    const h = HORIZON_ALIASES[t.toLowerCase()];
    if (h) return h;
  }
  return null;
}

export function horizonLabel(h: Horizon | null | undefined): string {
  return h ? commonI18n.t(`trading.${h}`) : "";
}

/** Replace any horizon tag in a comma list with the given horizon (or remove it when null). */
export function setHorizonInTags(tags: string | null | undefined, h: Horizon | null): string {
  const rest = splitTags(tags).filter((t) => !HORIZON_ALIASES[t.toLowerCase()]);
  if (h) rest.unshift(HORIZON_TAG[h]);
  return rest.join(", ");
}
