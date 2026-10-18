import type { Tone } from "@/components/ds";
import type { NextActionKind, Phase, QueueKind, TraderSignal } from "./api";
import { matchesAny } from "@workspace/text-search";
import { comparePersonNames } from "@/i18n";
import { curatorI18n } from "@/i18n/ns/curator";

/** `{ key: label }` whose labels are read in the current language on every access (safe at module scope). */
export function liveLabels<K extends string>(keys: readonly K[], label: (k: K) => string): Record<K, string> {
  const o = {} as Record<K, string>;
  for (const k of keys) Object.defineProperty(o, k, { get: () => label(k), enumerable: true });
  return o;
}

/** «2 ч», «1 д 4 ч» — waiting time in the queue. */
export function waitLabel(hours: number | null | undefined): string {
  if (hours == null) return "—";
  const t = curatorI18n.t;
  if (hours < 1) return t("wait.lessHour");
  if (hours < 24) return t("wait.hours", { h: Math.round(hours) });
  const d = Math.floor(hours / 24);
  const h = Math.round(hours - d * 24);
  return h ? t("wait.daysHours", { d, h }) : t("wait.days", { d });
}

const PHASES: readonly Phase[] = ["premarket", "session", "afterclose", "weekend"];
export const PHASE_LABEL: Record<Phase, string> = liveLabels(PHASES, (p) => curatorI18n.t(`phase.${p}`));

/** What the curator should be doing in this phase (one line under the header). */
export const PHASE_HINT: Record<Phase, string> = liveLabels(PHASES, (p) => curatorI18n.t(`phaseHint.${p}`));

const QUEUE_KINDS: readonly QueueKind[] = ["eod", "weekly", "academy", "breach"];
export const QUEUE_LABEL: Record<QueueKind, string> = liveLabels(QUEUE_KINDS, (k) => curatorI18n.t(`queue.${k}`));
export const QUEUE_TONE: Record<QueueKind, Tone> = { eod: "accent", weekly: "purple", academy: "neutral", breach: "down" };

export function riskTone(state: string): Tone {
  if (state === "stop" || state === "weekly" || state === "drawdown") return "down";
  if (state === "warn") return "warn";
  if (state === "ok") return "up";
  return "neutral";
}

export function actionTone(kind: NextActionKind): Tone {
  switch (kind) {
    case "breach_review": case "stopped": return "down";
    case "near_stop": case "overdue_action": case "missing_eod": case "no_limits": return "warn";
    case "eod_review": case "weekly_review": return "accent";
    case "none": return "up";
    default: return "neutral";
  }
}

/** Discipline 0–10 → tone. */
export function disciplineTone(v: number | null): Tone {
  if (v == null) return "neutral";
  return v >= 7 ? "up" : v >= 5 ? "warn" : "down";
}

/** Largest limit usage today (day / week / drawdown), null when no limits. */
export function worstUsage(s: Pick<TraderSignal, "risk">): number | null {
  const vals = [s.risk.dailyPct, s.risk.weeklyPct, s.risk.drawdownPct].filter((v): v is number => v != null);
  return vals.length ? Math.max(...vals) : null;
}

export type TraderSort = "attention" | "name" | "pnl" | "discipline";

/** Attention first: priority of the next action, then the worst limit usage, then name. */
export function sortTraders(list: readonly TraderSignal[], by: TraderSort): TraderSignal[] {
  const arr = [...list];
  const name = (a: TraderSignal, b: TraderSignal) => comparePersonNames(a.trader, b.trader);
  if (by === "name") return arr.sort(name);
  if (by === "pnl") return arr.sort((a, b) => (a.risk.weekPnl ?? 0) - (b.risk.weekPnl ?? 0) || name(a, b));
  if (by === "discipline") return arr.sort((a, b) => (a.discipline.value ?? 99) - (b.discipline.value ?? 99) || name(a, b));
  return arr.sort((a, b) => b.nextAction.priority - a.nextAction.priority || (worstUsage(b) ?? -1) - (worstUsage(a) ?? -1) || name(a, b));
}

/** Free-text filter: trader name / Latin alias in any script (RU / EN / UZ, wrong layout), stage, tier, next action. */
export function matchesQuery(s: TraderSignal, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  if ([s.trader, s.stage.label, s.tierName, s.nextAction.label].some((x) => (x ?? "").toLowerCase().includes(t))) return true;
  return matchesAny(q, s.trader, s.nameLatin);
}

const NOTE_KINDS = ["note", "call", "concern", "praise"] as const;
export const NOTE_KIND_LABEL: Record<(typeof NOTE_KINDS)[number], string> = liveLabels(NOTE_KINDS, (k) => curatorI18n.t(`noteKind.${k}`));
export const NOTE_KIND_TONE: Record<keyof typeof NOTE_KIND_LABEL, Tone> = { note: "neutral", call: "accent", concern: "warn", praise: "up" };

/** Profile deep link inside the cabinet. */
export function profileHref(trader: string, tab?: string): string {
  const q = new URLSearchParams({ trader });
  if (tab && tab !== "overview") q.set("tab", tab);
  return `/curator?${q.toString()}`;
}

/** Cross-section links the cabinet uses (proposed for lib/links.ts). */
export const curatorLinks = {
  risk: (trader: string) => `/risk?trader=${encodeURIComponent(trader)}`,
  riskLimits: (trader: string) => `/risk?trader=${encodeURIComponent(trader)}&tab=limits`,
  journalQueue: () => "/journal?view=queue",
  journalDay: (trader: string, date?: string) => `/journal?trader=${encodeURIComponent(trader)}${date ? `&date=${date}` : ""}`,
  weeklyCurator: (trader: string, week?: string) => `/weekly-review?view=curator&trader=${encodeURIComponent(trader)}${week ? `&week=${encodeURIComponent(week)}` : ""}`,
  academyMentor: () => "/academy/mentor",
  scaling: (trader: string) => `/scaling?trader=${encodeURIComponent(trader)}`,
  behavior: (trader: string) => `/behavior?trader=${encodeURIComponent(trader)}`,
};
