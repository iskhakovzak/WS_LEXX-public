/**
 * Trade structure on the client: role labels / tags, role of an execution (API role or derived from its kind),
 * and the step series of the running position and its average price. Pure.
 */
import type { Execution, ExecutionKind, Fill, Side, StructureStats, TradeRole } from "../types";
import { fmtCount, fmtPrice, fmtR, fmtRate } from "@/lib/format";
import { chartI18n } from "@/i18n/ns/chart";

/** Role names in the UI language (getters: each read follows the current language). */
export const ROLE_LABEL: Readonly<Record<TradeRole, string>> = {
  get entry() { return chartI18n.t("role.entry"); },
  get reentry() { return chartI18n.t("role.reentry"); },
  get flip() { return chartI18n.t("role.flip"); },
  get add() { return chartI18n.t("role.add"); },
  get partial_exit() { return chartI18n.t("role.partial_exit"); },
  get exit() { return chartI18n.t("role.exit"); },
  get stop() { return chartI18n.t("role.stop"); },
};

/** Short tag drawn next to the marker on the chart. */
export const ROLE_TAG: Readonly<Record<TradeRole, string>> = {
  get entry() { return chartI18n.t("roleTag.entry"); },
  get reentry() { return chartI18n.t("roleTag.reentry"); },
  get flip() { return chartI18n.t("roleTag.flip"); },
  get add() { return chartI18n.t("roleTag.add"); },
  get partial_exit() { return chartI18n.t("roleTag.partial_exit"); },
  get exit() { return chartI18n.t("roleTag.exit"); },
  get stop() { return chartI18n.t("roleTag.stop"); },
};

/** Order of the marker key under the chart. */
export const ROLE_ORDER: readonly TradeRole[] = ["entry", "reentry", "flip", "add", "partial_exit", "exit", "stop"];

const KIND_ROLE: Record<ExecutionKind, TradeRole> = { entry: "entry", add: "add", trim: "partial_exit", exit: "exit", stop: "stop" };

export function roleFromKind(kind: ExecutionKind): TradeRole {
  return KIND_ROLE[kind] ?? "entry";
}

/** The API's role when present, else the one implied by the stored kind. */
export function roleOf(e: Pick<Execution, "kind" | "role">): TradeRole {
  return e.role && e.role in ROLE_LABEL ? e.role : roleFromKind(e.kind);
}

export function roleLabel(role: TradeRole, inferred = false): string {
  return `${ROLE_LABEL[role]}${inferred ? "?" : ""}`;
}

/** Marker label: «Добор 10.50 × 100». */
export function fillLabelOf(role: TradeRole, inferred: boolean, price: number, qty: number | null): string {
  return `${roleLabel(role, inferred)} ${fmtPrice(price)}${qty != null ? ` × ${fmtCount(Math.round(qty))}` : ""}`;
}

/** Tooltip lines of a marker: role, price, size, share of the max position, R, pieces, why. */
export function fillDetails(f: Fill): string[] {
  const out: string[] = [];
  const head = [`${roleLabel(f.role, f.inferred)} ${fmtPrice(f.price)}`];
  if (f.qty != null) head.push(chartI18n.t("structure.qty", { qty: fmtCount(Math.round(f.qty)) }));
  out.push(head.join(" "));
  const leg = f.leg;
  const extra: string[] = [];
  if (leg?.fraction != null && leg.fraction < 0.999) extra.push(chartI18n.t("structure.ofPosition", { pct: fmtRate(leg.fraction) }));
  if (leg?.positionAfter != null) extra.push(leg.positionAfter > 0 ? chartI18n.t("structure.inPosition", { qty: fmtCount(Math.round(leg.positionAfter)) }) : chartI18n.t("structure.closed"));
  if (leg?.avgAfter != null && leg.opening) extra.push(chartI18n.t("structure.avg", { price: fmtPrice(leg.avgAfter) }));
  if (leg?.r != null) extra.push(fmtR(leg.r));
  else if (leg?.perShare != null && !leg.opening) extra.push(chartI18n.t("structure.perShare", { value: `${leg.perShare >= 0 ? "+" : "−"}${fmtPrice(Math.abs(leg.perShare))}` }));
  if (f.pieces > 1) extra.push(chartI18n.t("structure.pieces", { count: f.pieces }));
  if (extra.length) out.push(extra.join(" · "));
  if (leg?.reason) out.push(leg.reason);
  return out;
}

export type PositionStep = {
  /** Bar index where this state starts. */
  fromIdx: number;
  /** Bar index of the next change (or of the last fill). */
  toIdx: number;
  /** Average cost of the open position (null when flat). */
  avg: number | null;
  /** Open shares (null when quantities are unknown). */
  qty: number | null;
};

/**
 * Running average price / position after every fill (average-cost method; closing fills keep the average).
 * Unknown quantities: every fill counts as one unit for the average, a full exit / stop flattens, `qty` stays null.
 */
export function positionSteps(fills: readonly Fill[], opening: (f: Fill) => boolean): PositionStep[] {
  if (!fills.length) return [];
  const known = fills.every((f) => f.qty != null);
  let pos = 0, cost = 0;
  const out: PositionStep[] = [];
  for (let i = 0; i < fills.length; i++) {
    const f = fills[i];
    const u = known ? (f.qty as number) : 1;
    if (opening(f)) { cost += f.price * u; pos += u; }
    // Sizes unknown: a full exit / stop closes whatever is left (units are only a stand-in for shares).
    else if (!known && (f.role === "exit" || f.role === "stop")) { pos = 0; cost = 0; }
    else if (pos > 1e-9) { const avg = cost / pos; const q = Math.min(u, pos); cost -= avg * q; pos -= q; }
    const next = fills[i + 1];
    const state = { avg: pos > 1e-9 ? cost / pos : null, qty: known ? Math.max(0, pos) : null };
    const prev = out[out.length - 1];
    if (prev && prev.fromIdx === f.idx) { prev.avg = state.avg; prev.qty = state.qty; prev.toIdx = next ? next.idx : f.idx; continue; }
    out.push({ fromIdx: f.idx, toIdx: next ? next.idx : f.idx, ...state });
  }
  return out;
}

/** «Перезаход №2» / «Переворот» / «Сделка #12» for a sibling trade. */
export function siblingTitle(s: { id: number; reentryIndex: number; legs: { role: TradeRole }[] }): string {
  if (s.legs[0]?.role === "flip") return chartI18n.t("structure.flip");
  return s.reentryIndex > 0 ? chartI18n.t("structure.reentryN", { n: s.reentryIndex }) : chartI18n.t("structure.firstEntry");
}

export function sideWord(side: Side): string {
  return side === "short" ? chartI18n.t("structure.short") : chartI18n.t("structure.long");
}

/**
 * One line for the marker key: «2 добора · частичный фикс · перезаход №1», in the UI language (built from the stats,
 * not from the server's Russian `summary`). Mirror of api-server lib/tradeStructure structureSummary.
 */
export function structureSummary(s: Pick<StructureStats, "adds" | "partials" | "stopHit" | "stopInferred" | "reentryIndex" | "flipIn" | "flipOut" | "scaledEntryLikely" | "scaledExitLikely">): string {
  const parts: string[] = [];
  if (s.flipIn) parts.push(chartI18n.t("structure.summary.flip"));
  else if (s.reentryIndex > 0) parts.push(chartI18n.t("structure.summary.reentry", { n: s.reentryIndex }));
  if (s.adds) parts.push(chartI18n.t("structure.summary.adds", { count: s.adds }));
  else if (s.scaledEntryLikely) parts.push(chartI18n.t("structure.summary.scaledEntry"));
  if (s.partials) parts.push(chartI18n.t("structure.summary.partials", { count: s.partials }));
  else if (s.scaledExitLikely) parts.push(chartI18n.t("structure.summary.scaledExit"));
  if (s.stopHit) parts.push(s.stopInferred ? chartI18n.t("structure.summary.stopInferred") : chartI18n.t("structure.summary.stop"));
  if (s.flipOut) parts.push(chartI18n.t("structure.summary.flipOut"));
  return parts.join(" · ");
}
