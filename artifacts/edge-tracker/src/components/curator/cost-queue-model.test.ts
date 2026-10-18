import { describe, expect, it } from "vitest";
import { attentionRows, primaryAction } from "./cost-queue-model";
import type { CostQueueRow, QueueItem, TodayPayload } from "./api";

const next = (trader: string, kind: TodayPayload["nextActions"][number]["kind"], priority: number, href = `/journal?trader=${trader}`) =>
  ({ trader, kind, label: kind, priority, href });
const cost = (trader: string, costNet: number, kinds: CostQueueRow["reasons"][number]["kind"][], resolved = false): CostQueueRow =>
  ({ trader, date: "2026-10-16", costNet, resolved, reasons: kinds.map((kind) => ({ kind, costNet: null, text: { key: `costQueue.detail.${kind}` } })) });
const breach = (trader: string): QueueItem =>
  ({ kind: "breach", id: `breach:${trader}`, trader, title: "", since: null, hoursWaiting: null, href: "", overdue: false, slaHours: 24 });

describe("attentionRows", () => {
  it("open cost rows first (server order), then next steps of other traders, reviewed cost rows last", () => {
    const rows = attentionRows({
      byCost: [cost("A", -900, ["stop_breach"]), cost("B", -300, ["fees"], true), cost("C", -100, ["giveback"])],
      nextActions: [next("D", "eod_review", 50), next("A", "breach_review", 90), next("B", "missing_eod", 40)],
      queue: [breach("A")],
    });
    expect(rows.map((r) => `${r.type}:${r.trader}`)).toEqual(["cost:A", "cost:C", "next:D", "next:B", "cost:B"]);
    const a = rows[0];
    expect(a.type === "cost" && a.breachPending && a.next?.kind).toBe("breach_review");
  });

  it("works without byCost (older API): the plain next steps", () => {
    expect(attentionRows({ nextActions: [next("D", "eod_review", 50)], queue: [] }).map((r) => r.key)).toEqual(["next:D"]);
  });
});

describe("primaryAction", () => {
  const row = (item: CostQueueRow, opts: { breachPending?: boolean; next?: ReturnType<typeof next> | null } = {}) =>
    ({ type: "cost" as const, key: "k", trader: item.trader, item, next: opts.next ?? null, breachPending: !!opts.breachPending });

  it("breached stop with a pending review → review it; focus → focus; else next step; else the day", () => {
    expect(primaryAction(row(cost("A", -1, ["stop_breach", "fees"]), { breachPending: true }))).toEqual({ kind: "breach" });
    expect(primaryAction(row(cost("A", -1, ["stop_breach", "disputed"])))).toEqual({ kind: "focus" });
    expect(primaryAction(row(cost("A", -1, ["fees"]), { next: next("A", "eod_review", 50, "/journal?x") }))).toEqual({ kind: "next", href: "/journal?x" });
    expect(primaryAction(row(cost("A", -1, ["fees"]), { next: next("A", "breach_review", 90, "/curator?trader=A&tab=risk") }))).toEqual({ kind: "day" });
  });
});
