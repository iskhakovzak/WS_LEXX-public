import { describe, expect, it } from "vitest";
import {
  canEditPure, canReadPure, canSharePure, isShared, normSharedWith, spaceOf, visibleSql, type PlaybookViewer,
} from "../playbookAccess";
import { computeUsdStats, etWallMinutes, slotStats, timeSlotOf } from "../playbookEdge";

const base: PlaybookViewer = { name: "Алекс", guest: false, teamScope: ["Алекс"], editOwn: true, editAny: false, review: false, stage: "junior", cohorts: [3] };
const curator: PlaybookViewer = { ...base, name: "Ориф", teamScope: null, editAny: true, review: true, stage: null, cohorts: [] };
const senior: PlaybookViewer = { ...base, name: "Сеня", teamScope: ["Сеня"], stage: "senior" };
const guest: PlaybookViewer = { name: "guest", guest: true, teamScope: [], editOwn: false, editAny: false, review: false, stage: null, cohorts: [] };

describe("playbook spaces", () => {
  it("legacy rows without space: no author → office, author → personal", () => {
    expect(spaceOf({ trader: null })).toBe("office");
    expect(spaceOf({ trader: "Алекс" })).toBe("personal");
    expect(spaceOf({ trader: "Ориф", space: "office" })).toBe("office");
  });

  it("office is readable by everyone, editable by curators only", () => {
    const row = { trader: null, space: "office" };
    for (const v of [base, curator, senior, guest]) expect(canReadPure(v, row)).toBe(true);
    expect(canEditPure(base, row)).toBe(false);
    expect(canEditPure(curator, row)).toBe(true);
    expect(canEditPure(guest, row)).toBe(false);
  });

  it("personal is private: owner and staff only", () => {
    const row = { trader: "Сеня", space: "personal", visibility: "private" };
    expect(canReadPure(senior, row)).toBe(true);
    expect(canReadPure(curator, row)).toBe(true);
    expect(canReadPure(base, row)).toBe(false);
    expect(canReadPure(guest, row)).toBe(false);
    expect(canEditPure(senior, row)).toBe(true);
    expect(canEditPure(base, row)).toBe(false);
  });

  it("shared with all / people / cohort", () => {
    expect(canReadPure(base, { trader: "Сеня", space: "personal", visibility: "all" })).toBe(true);
    expect(canReadPure(base, { trader: "Сеня", space: "personal", visibility: "custom", sharedWith: { users: ["Алекс"] } })).toBe(true);
    expect(canReadPure(base, { trader: "Сеня", space: "personal", visibility: "custom", sharedWith: { cohorts: [3] } })).toBe(true);
    expect(canReadPure(base, { trader: "Сеня", space: "personal", visibility: "custom", sharedWith: { users: ["Боб"], cohorts: [9] } })).toBe(false);
    expect(isShared({ trader: "Сеня", space: "personal", visibility: "custom", sharedWith: { users: [] } })).toBe(false);
    expect(isShared({ trader: "Сеня", space: "personal", visibility: "all" })).toBe(true);
    // shared readers never edit
    expect(canEditPure(base, { trader: "Сеня", space: "personal", visibility: "all" })).toBe(false);
  });

  it("only seniors (or staff) share, and only their own personal setups", () => {
    expect(canSharePure(senior, { trader: "Сеня", space: "personal" })).toBe(true);
    expect(canSharePure(base, { trader: "Алекс", space: "personal" })).toBe(false);
    expect(canSharePure(curator, { trader: "Ориф", space: "personal" })).toBe(true);
    expect(canSharePure(curator, { trader: "Сеня", space: "personal" })).toBe(false);
    expect(canSharePure(senior, { trader: null, space: "office" })).toBe(false);
  });

  it("normSharedWith cleans input", () => {
    expect(normSharedWith({ users: [" a ", "a", "", 5], cohorts: ["2", 2, -1, "x"] })).toEqual({ users: ["a", "5"], cohorts: [2] });
    expect(normSharedWith(null)).toEqual({ users: [], cohorts: [] });
  });

  it("visibleSql: staff sees all, member gets office/own/shared filter", () => {
    expect(visibleSql(curator, [])).toBe("TRUE");
    const params: unknown[] = [];
    const sql = visibleSql(base, params);
    expect(sql).toContain("'office'");
    expect(sql).toContain("visibility = 'all'");
    expect(params).toEqual([["Алекс"], "Алекс", ["3"]]);
  });
});

describe("playbook $ stats", () => {
  it("computeUsdStats: net, expectancy, payoff, PF null without losses", () => {
    const u = computeUsdStats([
      { result: "win", pnl: 100, fees: 2 },
      { result: "loss", pnl: -50, fees: 2 },
      { result: "open", pnl: 10, fees: 0 },
      { result: "win", pnl: 30, fees: -1 },
    ]);
    expect(u.n).toBe(3);
    expect(u.net).toBe(75);
    expect(u.expectancy).toBe(25);
    expect(u.winrate).toBeCloseTo(0.6667, 3);
    expect(u.profitFactor).toBeCloseTo(127 / 52, 2);
    expect(computeUsdStats([{ result: "win", pnl: 10, fees: 0 }]).profitFactor).toBeNull();
  });

  it("time slots", () => {
    expect(timeSlotOf(9 * 60 + 41)).toBe("09:30");
    expect(timeSlotOf(9 * 60)).toBe("pre");
    expect(timeSlotOf(16 * 60)).toBe("post");
    expect(timeSlotOf(null)).toBeNull();
    expect(etWallMinutes("2026-03-02 10:05:00", () => 0)).toBe(605);
    const s = slotStats([
      { result: "win", pnl: 10, fees: 0, entryMin: 575 },
      { result: "win", pnl: 10, fees: 0, entryMin: 580 },
      { result: "loss", pnl: -5, fees: 0, entryMin: 590 },
      { result: "win", pnl: 50, fees: 0, entryMin: 900 },
    ], 2);
    expect(s.slots.map((x) => x.slot)).toEqual(["09:30", "15:00"]);
    expect(s.best.map((x) => x.slot)).toEqual(["09:30"]);
  });
});
