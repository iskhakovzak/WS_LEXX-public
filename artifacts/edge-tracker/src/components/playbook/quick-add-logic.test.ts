import { describe, expect, it } from "vitest";
import { buildQuickRows, defaultTier, matchesSearch, undoSteps, type QuickSetup } from "./quick-add-logic";

const S = (id: number, name: string, extra: Partial<QuickSetup> = {}): QuickSetup => ({
  id, name, folder: null, space: "office", mine: false, shared: false, owner: null, canAddExamples: true, setupType: null, tags: null, ...extra,
});

const setups = [
  S(1, "Пробой HOD", { folder: "Моментум" }),
  S(2, "Мой ORB", { space: "personal", mine: true, owner: "Артур" }),
  S(3, "Чужой шорт", { space: "personal", shared: true, owner: "Ориф" }),
  S(4, "Только чтение", { canAddExamples: false }),
  S(5, "VWAP reclaim", { tags: "vwap, reclaim" }),
];

describe("quick add: setup rows", () => {
  it("groups suggested → recent → mine → office → shared, each setup once, no read-only ones", () => {
    const rows = buildQuickRows({ setups, suggested: [{ id: 5 }, { id: 4 }], recent: [5, 1], search: "" });
    expect(rows.map((r) => [r.s.id, r.group])).toEqual([
      [5, "suggested"],
      [1, "recent"],
      [2, "mine"],
      [3, "shared"],
    ]);
  });

  it("search matches all terms over name / folder / tags / owner, own setups first", () => {
    expect(matchesSearch(setups[0], "пробой момент")).toBe(true);
    expect(matchesSearch(setups[0], "пробой vwap")).toBe(false);
    expect(buildQuickRows({ setups, suggested: [], recent: [], search: "orb" }).map((r) => r.s.id)).toEqual([2]);
    expect(buildQuickRows({ setups, suggested: [], recent: [], search: "ориф" }).map((r) => r.s.id)).toEqual([3]);
    expect(buildQuickRows({ setups, suggested: [], recent: [], search: "чтение" })).toEqual([]);
  });
});

describe("quick add: default tier", () => {
  it("keeps an existing example's tier", () => {
    expect(defaultTier({ result: "loss", signedR: -1 }, 1)).toBe(1);
  });
  it("hints from the outcome", () => {
    expect(defaultTier({ result: "win", signedR: 2.5 })).toBe(1);
    expect(defaultTier({ result: "win", signedR: 1.2 })).toBe(2);
    expect(defaultTier({ result: "loss", signedR: -0.5 })).toBe(3);
    expect(defaultTier({ result: null, signedR: null, netPnl: -40 })).toBe(3);
    expect(defaultTier({ result: "win", signedR: null, netPnl: 80 })).toBe(1);
    expect(defaultTier(null)).toBe(1);
  });
});

describe("quick add: undo", () => {
  it("deletes created examples (unlinking trades linked by the same call) and restores updated ones", () => {
    const steps = undoSteps({
      examples: [{ id: 10, tradeId: 100 }, { id: 11, tradeId: 101 }, { id: 7, tradeId: 102 }],
      created: [10, 11],
      previous: [{ id: 7, tier: 2, note: "старое" }],
      linkedTradeIds: [101],
    });
    expect(steps).toEqual([
      { kind: "delete", exampleId: 10, unlink: false },
      { kind: "delete", exampleId: 11, unlink: true },
      { kind: "restore", exampleId: 7, tier: 2, note: "старое" },
    ]);
  });
  it("offers nothing on an older API that does not report what it did", () => {
    expect(undoSteps({ examples: [{ id: 1, tradeId: 2 }], linked: 1 })).toEqual([]);
  });
});
