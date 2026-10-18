import type { NextAction, QueueItem, TodayPayload, CostQueueRow } from "./api";

/**
 * «Следующие шаги» merged with the queue by money (GET /api/curator/today `byCost`): one attention list per curator.
 *   1. cost rows the curator has not looked at yet — most expensive first (server order);
 *   2. next steps of traders without such a row — by priority (the old list);
 *   3. cost rows already reviewed — at the bottom, dimmed («Разобрано»).
 * Pure: no React, no i18n — tested in cost-queue-model.test.ts.
 */

export type TraderNext = NextAction & { trader: string };

export type AttentionRow =
  | { type: "cost"; key: string; trader: string; item: CostQueueRow; next: TraderNext | null; breachPending: boolean }
  | { type: "next"; key: string; trader: string; next: TraderNext };

export function attentionRows(data: Pick<TodayPayload, "nextActions" | "queue"> & { byCost?: CostQueueRow[] }): AttentionRow[] {
  const nextBy = new Map(data.nextActions.map((a) => [a.trader, a]));
  const breachBy = new Set(data.queue.filter((q: QueueItem) => q.kind === "breach").map((q) => q.trader));
  const cost = (data.byCost ?? []).map((item): AttentionRow => ({
    type: "cost", key: `cost:${item.trader}:${item.date}`, trader: item.trader, item,
    next: nextBy.get(item.trader) ?? null, breachPending: breachBy.has(item.trader),
  }));
  const open = cost.filter((r) => r.type === "cost" && !r.item.resolved);
  const done = cost.filter((r) => r.type === "cost" && r.item.resolved);
  const covered = new Set(open.map((r) => r.trader));
  const rest = data.nextActions
    .filter((a) => !covered.has(a.trader))
    .map((a): AttentionRow => ({ type: "next", key: `next:${a.trader}`, trader: a.trader, next: a }));
  return [...open, ...rest, ...done];
}

export type PrimaryAction =
  | { kind: "breach" }
  | { kind: "focus" }
  | { kind: "next"; href: string }
  | { kind: "day" };

/** What the row's main button does: review the breached stop → look at the focus → the trader's next step → the day. */
export function primaryAction(row: Extract<AttentionRow, { type: "cost" }>): PrimaryAction {
  const kinds = new Set(row.item.reasons.map((r) => r.kind));
  if (kinds.has("stop_breach") && row.breachPending) return { kind: "breach" };
  if (kinds.has("disputed") || kinds.has("focus_broken")) return { kind: "focus" };
  if (row.next && row.next.kind !== "none" && !row.next.href.startsWith("/curator?")) return { kind: "next", href: row.next.href };
  return { kind: "day" };
}

/** Money params of reason texts (formatted as $ by the view). */
export const MONEY_PARAMS = new Set(["used", "limit", "fees", "gross", "peak", "close", "net"]);
