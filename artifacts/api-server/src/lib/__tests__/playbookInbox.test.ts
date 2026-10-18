import { describe, expect, it } from "vitest";
import { inboxDays, labelMatchesSetup, labelScore, rankInbox, suggestSetup, suggestTier, type InboxSetup } from "../playbookInbox";

const setups: InboxSetup[] = [
  { id: 1, name: "Пробой HOD", setupType: "breakout", tags: "momentum", canAddExamples: true, mine: false, space: "office" },
  { id: 2, name: "Пробой HOD (мой)", setupType: "breakout", canAddExamples: true, mine: true, space: "personal" },
  { id: 3, name: "Шорт отката", tags: "fade, vwap", canAddExamples: false, mine: false, space: "personal" },
  { id: 4, name: "VWAP reclaim", canAddExamples: true, mine: false, space: "office" },
];

describe("playbook inbox: setup suggestion", () => {
  it("label matching is loose both ways and ignores short labels", () => {
    expect(labelMatchesSetup("пробой hod", { name: "Пробой HOD" })).toBe(true);
    expect(labelMatchesSetup("Пробой HOD на объёме", { name: "Пробой HOD" })).toBe(true);
    expect(labelMatchesSetup("fade", { name: "X", tags: "fade, vwap" })).toBe(true);
    expect(labelMatchesSetup("ab", { name: "ab" })).toBe(false);
    expect(labelMatchesSetup(null, { name: "Пробой" })).toBe(false);
  });

  it("linked setup wins over labels, but only when the viewer may add examples there", () => {
    expect(suggestSetup({ id: 9, closeDate: null, playbookId: 4, autoSetup: "Пробой HOD" }, setups)).toMatchObject({ id: 4, via: "linked" });
    // Linked to a read-only setup → falls through to the auto label.
    expect(suggestSetup({ id: 9, closeDate: null, playbookId: 3, autoSetup: "Пробой HOD" }, setups)).toMatchObject({ via: "auto" });
  });

  it("scores exact name over partial name over tag", () => {
    expect(labelScore("VWAP reclaim", { name: "vwap reclaim" })).toBe(3);
    expect(labelScore("VWAP", { name: "VWAP reclaim" })).toBe(2);
    expect(labelScore("fade", { name: "Шорт отката", tags: "fade, vwap" })).toBe(1);
    expect(labelScore("ORB", { name: "Пробой" })).toBe(0);
    // A tag-only match loses to a name match in another setup.
    const list: InboxSetup[] = [
      { id: 10, name: "Gap and Go", tags: "пробой", canAddExamples: true, mine: true, space: "personal" },
      { id: 11, name: "ORB пробой", canAddExamples: true, mine: false, space: "office" },
    ];
    expect(suggestSetup({ id: 1, closeDate: null, setup: "ORB пробой" }, list)?.id).toBe(11);
  });

  it("prefers the viewer's own setup over office for the same label", () => {
    expect(suggestSetup({ id: 9, closeDate: null, autoSetup: "пробой" }, setups)?.id).toBe(2);
    // …but an exact name beats ownership.
    expect(suggestSetup({ id: 9, closeDate: null, autoSetup: "Пробой HOD" }, setups)?.id).toBe(1);
  });

  it("falls back to the setup text written on the trade, never to read-only setups", () => {
    expect(suggestSetup({ id: 9, closeDate: null, setup: "vwap reclaim" }, setups)).toMatchObject({ id: 4, via: "text" });
    expect(suggestSetup({ id: 9, closeDate: null, setup: "Шорт отката" }, setups)).toBeNull();
    expect(suggestSetup({ id: 9, closeDate: null }, setups)).toBeNull();
  });
});

describe("playbook inbox: tier hint and ranking", () => {
  it("suggests a tier from the outcome", () => {
    expect(suggestTier({ result: "win", signedR: 2.4 })).toBe(1);
    expect(suggestTier({ result: "win", signedR: 0.8 })).toBe(2);
    expect(suggestTier({ result: "win", signedR: null })).toBe(2);
    expect(suggestTier({ result: "be", signedR: 0 })).toBe(2);
    expect(suggestTier({ result: "loss", signedR: -1 })).toBe(3);
    expect(suggestTier({ result: null, signedR: -0.2 })).toBe(3);
  });

  it("ranks newest day first; within a day suggested / big-R trades float up", () => {
    const rows = [
      { id: 1, closeDate: "2026-10-14", signedR: 0.5, suggestion: null },
      { id: 2, closeDate: "2026-10-15", signedR: 0.1, suggestion: null },
      { id: 3, closeDate: "2026-10-15", signedR: 3, suggestion: null },
      { id: 4, closeDate: "2026-10-15", signedR: 0.2, suggestion: { id: 1, name: "x", reason: "r", via: "auto" as const } },
    ];
    expect(rankInbox(rows).map((r) => r.id)).toEqual([4, 3, 2, 1]);
  });

  it("clamps the look-back window", () => {
    expect(inboxDays(undefined)).toBe(14);
    expect(inboxDays("7")).toBe(7);
    expect(inboxDays(500)).toBe(90);
    expect(inboxDays(-3)).toBe(14);
  });
});
