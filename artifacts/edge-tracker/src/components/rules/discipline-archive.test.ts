import { describe, expect, it } from "vitest";
import { countedViolations, withArchive } from "./discipline";
import type { Violation } from "./types";

const v = (id: number, over: Partial<Violation> = {}): Violation => ({
  id, trader: "alice", ruleId: 1, tradeId: null, occurredAt: "2026-10-14T15:00:00Z", severity: "medium", message: `v${id}`, details: null,
  day: "2026-10-14", costNet: -10, acknowledgedBy: null, acknowledgedAt: null, comment: null, resolution: null, consequence: null,
  resolvedBy: null, resolvedAt: null, status: "open", ruleName: "Лимит", ruleKind: "max_trades", ticker: null, tradeDate: null, ...over,
});

describe("withArchive", () => {
  const active = [v(1), v(2)];
  const archived = [v(3, { archived: true, archivedReason: "rule_disabled" }), v(2, { archived: true })];

  it("returns only active violations while the archive is hidden", () => {
    expect(withArchive(active, archived, false).map((x) => x.id)).toEqual([1, 2]);
  });

  it("appends archived violations after active ones, deduped by id", () => {
    expect(withArchive(active, archived, true).map((x) => x.id)).toEqual([1, 2, 3]);
  });

  it("handles an empty archive", () => {
    expect(withArchive(active, [], true)).toEqual(active);
  });
});

describe("countedViolations", () => {
  it("drops archived violations from counts", () => {
    const list = [v(1), v(2, { archived: true, archivedReason: "rule_deleted" }), v(3, { archived: false })];
    expect(countedViolations(list).map((x) => x.id)).toEqual([1, 3]);
  });
});
