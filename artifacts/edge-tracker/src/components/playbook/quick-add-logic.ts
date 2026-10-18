/**
 * Pure logic of the «В плейбук» quick add (components/playbook/quick-add.tsx): which setups to offer and in what
 * order, the default tier, and how to undo a save. No React, no fetch — unit-tested in quick-add-logic.test.ts.
 */
import type { Tier } from "./model";

export type QuickSetup = {
  id: number; name: string; folder: string | null; space: "office" | "personal"; mine: boolean; shared: boolean;
  owner: string | null; canAddExamples: boolean; setupType: string | null; tags: string | null;
};

/** Group code of a row; the heading text is looked up in `playbookDialogs` → `quick.group.*` at render time. */
export type QuickGroup = "found" | "suggested" | "recent" | "mine" | "office" | "shared";
export type QuickRow = { s: QuickSetup; group: QuickGroup };

/** Search haystack match: every whitespace-separated term must occur in name / folder / type / tags / owner. */
export function matchesSearch(s: QuickSetup, term: string): boolean {
  const terms = term.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = `${s.name} ${s.folder ?? ""} ${s.setupType ?? ""} ${s.tags ?? ""} ${s.owner ?? ""}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/**
 * Rows for the setup list.
 *   With a search term: matching writable setups (own first, then office, then shared), max 60.
 *   Without: «Подходят по сделке» (suggested) → «Недавние» → «Мой плейбук» → «Плейбук офиса» → «Общие»,
 *   each setup once, only setups the viewer may add examples to.
 */
export function buildQuickRows(input: {
  setups: QuickSetup[]; suggested: { id: number }[]; recent: number[]; search: string;
}): QuickRow[] {
  const writable = input.setups.filter((s) => s.canAddExamples);
  const rank = (s: QuickSetup) => (s.mine ? 0 : s.space === "office" ? 1 : 2);
  const ordered = [...writable].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "ru"));
  if (input.search.trim()) {
    return ordered.filter((s) => matchesSearch(s, input.search)).slice(0, 60).map((s) => ({ s, group: "found" as const }));
  }
  const byId = new Map(writable.map((s) => [s.id, s]));
  const out: QuickRow[] = [];
  const seen = new Set<number>();
  const push = (s: QuickSetup | undefined, group: QuickGroup) => {
    if (!s || seen.has(s.id)) return;
    seen.add(s.id);
    out.push({ s, group });
  };
  for (const sg of input.suggested) push(byId.get(sg.id), "suggested");
  for (const id of input.recent) push(byId.get(id), "recent");
  for (const s of ordered) push(s, s.mine ? "mine" : s.space === "office" ? "office" : "shared");
  return out;
}

/** Default tier: the tier of an existing example in the picked setup, else a hint from the outcome. */
export function defaultTier(t: { result?: string | null; signedR?: number | null; netPnl?: number | null } | null | undefined, existing?: Tier | null): Tier {
  if (existing) return existing;
  if (!t) return 1;
  const r = t.signedR != null && Number.isFinite(t.signedR) ? t.signedR : null;
  if (t.result === "loss" || (r != null && r < 0) || (r == null && t.netPnl != null && t.netPnl < 0)) return 3;
  if (r != null && r < 2) return 2;
  return 1;
}

export type AddResponse = {
  examples?: { id: number; tradeId: number }[];
  skipped?: { tradeId: number; reason: string }[];
  linked?: number;
  /** Newer API: example ids created by this call / previous tier+note of re-added ones / trades linked here. */
  created?: number[];
  previous?: { id: number; tier: number; note: string | null }[];
  linkedTradeIds?: number[];
};

export type UndoStep =
  | { kind: "delete"; exampleId: number; unlink: boolean }
  | { kind: "restore"; exampleId: number; tier: Tier; note: string | null };

/**
 * Steps that revert one «Добавить» call: delete what it created (and drop the trade link it set), restore the tier /
 * note of examples it only updated. Empty when the API is too old to say what it did (no undo offered then).
 */
export function undoSteps(r: AddResponse): UndoStep[] {
  if (!Array.isArray(r.created)) return [];
  const linked = new Set(r.linkedTradeIds ?? []);
  const tradeOf = new Map((r.examples ?? []).map((e) => [e.id, e.tradeId]));
  const steps: UndoStep[] = r.created.map((id) => ({ kind: "delete", exampleId: id, unlink: linked.has(tradeOf.get(id) ?? -1) }));
  for (const p of r.previous ?? []) {
    const tier = (p.tier === 1 || p.tier === 2 || p.tier === 3 ? p.tier : 2) as Tier;
    steps.push({ kind: "restore", exampleId: p.id, tier, note: p.note });
  }
  return steps;
}

