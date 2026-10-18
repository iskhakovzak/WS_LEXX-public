/**
 * Playbook inbox («Сделки без эталона») — pure helpers.
 * The trader's recent own trades that are not an example of any setup yet, each with a best-guess setup
 * (linked setup → auto-classification → setup text written on the trade) and a suggested tier from the result.
 * SQL lives in routes/playbook-spaces.ts (GET /playbook-tools/inbox); this file has no DB access.
 */
import { playbookT } from "../i18n/ns";
import type { Lang } from "../i18n";

export type InboxSetup = {
  id: number;
  name: string;
  setupType?: string | null;
  tags?: string | null;
  /** May the viewer add examples to it (accessHints().canAddExamples). */
  canAddExamples: boolean;
  /** Owned by the viewer (personal space). */
  mine: boolean;
  space: "office" | "personal";
};

export type InboxTradeInput = {
  id: number;
  closeDate: string | null;
  date?: string | null;
  result?: string | null;
  signedR?: number | null;
  playbookId?: number | null;
  autoSetup?: string | null;
  setup?: string | null;
};

export type InboxSuggestion = { id: number; name: string; reason: string; via: "linked" | "auto" | "text" };

/** Does a free-text setup label ("Пробой HOD") fit a setup (name / type / tags)? Loose, case-insensitive, both ways. */
export function labelMatchesSetup(label: string | null | undefined, setup: { name?: string | null; setupType?: string | null; tags?: string | null }): boolean {
  const a = (label ?? "").trim().toLowerCase();
  if (a.length < 3) return false;
  const terms = [setup.name, setup.setupType, ...(setup.tags ?? "").split(",")]
    .map((x) => (x ?? "").trim().toLowerCase())
    .filter((x) => x.length >= 3);
  return terms.some((t) => t.includes(a) || a.includes(t));
}

/** Viewer's own setups first, then office, then shared — among setups the viewer may add examples to. */
function preference(s: InboxSetup): number {
  return s.mine ? 0 : s.space === "office" ? 1 : 2;
}

/**
 * How well a label fits a setup: 3 — same name, 2 — name contains it (or vice versa), 1 — type / tag match, 0 — none.
 * Lets «ORB пробой» pick the «ORB пробой» setup over one merely tagged «пробой».
 */
export function labelScore(label: string | null | undefined, setup: { name?: string | null; setupType?: string | null; tags?: string | null }): number {
  const a = (label ?? "").trim().toLowerCase();
  if (a.length < 3) return 0;
  const name = (setup.name ?? "").trim().toLowerCase();
  if (name && name === a) return 3;
  if (name.length >= 3 && (name.includes(a) || a.includes(name))) return 2;
  return labelMatchesSetup(label, { setupType: setup.setupType, tags: setup.tags }) ? 1 : 0;
}

function bestByLabel(label: string, setups: InboxSetup[]): InboxSetup | null {
  let best: InboxSetup | null = null;
  let bestScore = 0;
  for (const s of setups) {
    const sc = labelScore(label, s);
    if (sc > bestScore) { best = s; bestScore = sc; }
  }
  return best;
}

/**
 * Best setup for a trade, or null. Only setups the viewer may add examples to are considered.
 * Order: the setup the trade is already linked to → auto-classifier label → the setup text on the trade;
 * within a label the closest name wins, ties go to the viewer's own setup, then office.
 */
export function suggestSetup(trade: InboxTradeInput, setups: InboxSetup[], lang: Lang = "ru"): InboxSuggestion | null {
  const t = playbookT.tFor(lang);
  const writable = setups.filter((s) => s.canAddExamples).sort((a, b) => preference(a) - preference(b) || a.name.localeCompare(b.name, "ru"));
  if (trade.playbookId) {
    const s = writable.find((x) => x.id === trade.playbookId);
    if (s) return { id: s.id, name: s.name, reason: t("suggest.linked"), via: "linked" };
  }
  if (trade.autoSetup) {
    const s = bestByLabel(trade.autoSetup, writable);
    if (s) return { id: s.id, name: s.name, reason: t("suggest.auto", { label: trade.autoSetup }), via: "auto" };
  }
  if (trade.setup) {
    const s = bestByLabel(trade.setup, writable);
    if (s) return { id: s.id, name: s.name, reason: t("suggest.text", { label: trade.setup }), via: "text" };
  }
  return null;
}

/**
 * Tier hint from the outcome (the trader can always change it):
 *   ≥ 2R → 1 (эталон), other wins / breakeven / unknown R → 2, losses → 3 («на разбор»).
 * A loss can be a textbook trade too — this is only the preselected default.
 */
export function suggestTier(t: { result?: string | null; signedR?: number | null }): 1 | 2 | 3 {
  const r = t.signedR != null && Number.isFinite(t.signedR) ? t.signedR : null;
  if (t.result === "loss" || (r != null && r < 0)) return 3;
  if (r != null) return r >= 2 ? 1 : 2;
  return 2;
}

/** Newest first (close date, then id); trades with a suggestion and big |R| float up within the same day. */
export function rankInbox<T extends InboxTradeInput & { suggestion?: InboxSuggestion | null }>(rows: T[]): T[] {
  const day = (t: T) => (t.closeDate ?? t.date ?? "").slice(0, 10);
  const weight = (t: T) => (t.suggestion ? 2 : 0) + (t.signedR != null && Math.abs(t.signedR) >= 2 ? 1 : 0);
  return [...rows].sort((a, b) => day(b).localeCompare(day(a)) || weight(b) - weight(a) || b.id - a.id);
}

/** Clamp the look-back window (days) for the inbox: default 14, 1…90. */
export function inboxDays(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return 14;
  return Math.min(n, 90);
}
