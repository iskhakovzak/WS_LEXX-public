/**
 * One enriched row per analyst action: quote, desk/trader context, firm weight, historical reaction and the
 * importance score. Built once per render in the page and shared by «Сегодня до открытия» and the table.
 */
import type { FirmWeightRow, ReactionAgg, ReactionKind, TickerReaction } from "./api";
import {
  gapOf, isTopFirm, ptChangePct, scoreAction,
  type FeedAction, type FirmWeightLite, type OpenPosition, type Quote, type ScoreReason,
} from "./lib";
import { analystI18n } from "@/i18n/ns/analyst";

export type Row = {
  a: FeedAction;
  quote: Quote | null;
  held: OpenPosition[];
  watched: boolean;
  /** My closed trades on this ticker (0 = never traded / unknown). */
  traded: number;
  top: boolean;
  weight: FirmWeightLite | null;
  /** Historical reaction of this ticker to the same kind of action. */
  reaction: ReactionAgg | null;
  reactionKind: ReactionKind | null;
  score: number;
  reasons: ScoreReason[];
};

/** Minimum events before a historical average is shown. */
export const REACTION_MIN_N = 2;

export function reactionKindOf(a: FeedAction): ReactionKind | null {
  if (a.action === "upgrade") return "up";
  if (a.action === "downgrade") return "down";
  if (a.action === "initiated") return "init";
  const p = ptChangePct(a);
  if (p == null || Math.abs(p) < 5) return null;
  return p > 0 ? "ptUp" : "ptDown";
}

/** Reaction kind → lower-case label in the UI language (getters: read at access time). */
export const REACTION_KIND_LABEL = {} as Record<ReactionKind, string>;
for (const k of ["up", "down", "init", "ptUp", "ptDown"] as const) {
  Object.defineProperty(REACTION_KIND_LABEL, k, { get: () => analystI18n.t(`reactionKind.${k}`), enumerable: true });
}

export function weightMap(firms: FirmWeightRow[] | null | undefined): Map<string, FirmWeightLite> {
  const m = new Map<string, FirmWeightLite>();
  for (const f of firms ?? []) {
    m.set(f.firm, { n: f.rating.n, ratio: f.rating.avgRatio, hit: f.rating.hitRate, avgSignedDay: f.rating.avgSignedDay });
  }
  return m;
}

export type EnrichCtx = {
  quotes: Record<string, Quote> | undefined;
  held: Map<string, OpenPosition[]>;
  isWatched: (t: string) => boolean;
  traded: Map<string, number>;
  weights: Map<string, FirmWeightLite>;
  reactions: Record<string, TickerReaction> | undefined;
};

export function enrich(a: FeedAction, ctx: EnrichCtx): Row {
  const t = a.ticker.toUpperCase();
  const quote = ctx.quotes?.[t] ?? null;
  const held = ctx.held.get(t) ?? [];
  const watched = ctx.isWatched(t);
  const traded = ctx.traded.get(t) ?? 0;
  const weight = ctx.weights.get(a.firm) ?? null;
  const top = isTopFirm(a.firm, weight);
  const kind = reactionKindOf(a);
  const reaction = kind ? ctx.reactions?.[t]?.[kind] ?? null : null;
  const { score, reasons } = scoreAction(a, { held: held.length > 0, watched, traded, top, weight, gapPct: gapOf(quote) });
  return { a, quote, held, watched, traded, top, weight, reaction, reactionKind: kind, score, reasons };
}
