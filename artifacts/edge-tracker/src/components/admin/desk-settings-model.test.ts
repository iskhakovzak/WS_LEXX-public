import { describe, expect, it } from "vitest";
import {
  changesOf, checkValue, groupRows, inputOf, nyToTashkent, parseInput, shownBounds, shownProblem, type SettingDef, type SettingRow,
} from "./desk-settings-model";

const ratio: SettingDef = { group: "daily", type: "number", default: 0.5, min: 0.1, max: 1, step: 0.05, unit: "ratio" };
const days: SettingDef = { group: "daily", type: "number", default: 10, min: 3, max: 30, step: 1, unit: "days" };
const row = (key: string, def: SettingDef, value: SettingRow["value"] = null): SettingRow => ({
  key, def, value, effective: value ?? def.default, default: def.default, updatedBy: null, updatedAt: null,
});

describe("desk settings model", () => {
  it("ratio is shown and typed as percent", () => {
    expect(inputOf(ratio, 0.35)).toBe("35");
    expect(parseInput("k", ratio, "35")).toEqual({ ok: true, value: 0.35 });
    expect(parseInput("k", ratio, "12,5")).toEqual({ ok: true, value: 0.125 });
    expect(shownBounds(ratio as Extract<SettingDef, { type: "number" }>)).toEqual({ min: 10, max: 100, step: 5 });
    expect(checkValue("k", ratio, 0.05)).toEqual({ key: "k", kind: "range", min: 10, max: 100 });
    expect(shownProblem(ratio, { key: "k", kind: "range", min: 0.1, max: 1 })).toEqual({ key: "k", kind: "range", min: 10, max: 100 });
  });

  it("inline checks mirror the server", () => {
    expect(parseInput("k", days, "")).toMatchObject({ ok: false, problem: { kind: "empty" } });
    expect(parseInput("k", days, "1e3")).toMatchObject({ ok: false, problem: { kind: "type" } });
    expect(checkValue("k", days, 7.5)).toMatchObject({ kind: "integer" });
    expect(checkValue("k", days, 31)).toMatchObject({ kind: "range", min: 3, max: 30 });
    expect(checkValue("k", { group: "telegram", type: "time", default: "08:45" }, "8:45")).toMatchObject({ kind: "time" });
    expect(checkValue("k", { group: "x", type: "select", default: "a", options: ["a", "b"] }, "c")).toMatchObject({ kind: "option" });
  });

  it("the batch holds only real changes; the default goes as null", () => {
    const rows = [row("a", days), row("b", days, 12), row("c", ratio)];
    expect(changesOf(rows, { a: 10, b: 12, c: 0.4 })).toEqual([{ key: "c", value: 0.4 }]);
    expect(changesOf(rows, { b: 10 })).toEqual([{ key: "b", value: null }]);
    expect(changesOf(rows, { b: null, a: 15 })).toEqual([{ key: "a", value: 15 }, { key: "b", value: null }]);
  });

  it("groups in display order, unknown groups last", () => {
    const g = groupRows([row("t", { group: "telegram", type: "boolean", default: true }), row("z", { group: "zeta", type: "boolean", default: true }), row("d", days)]);
    expect(g.map((x) => x.group)).toEqual(["daily", "telegram", "zeta"]);
  });

  it("New York → Tashkent with the day shift (EDT and EST)", () => {
    const summer = new Date("2026-10-16T12:00:00Z"); // EDT −4, Tashkent +5 → +9 h
    expect(nyToTashkent("08:45", summer)).toEqual({ time: "17:45", dayShift: 0 });
    expect(nyToTashkent("16:30", summer)).toEqual({ time: "01:30", dayShift: 1 });
    const winter = new Date("2026-12-04T12:00:00Z"); // EST −5 → +10 h
    expect(nyToTashkent("08:45", winter)).toEqual({ time: "18:45", dayShift: 0 });
    expect(nyToTashkent("bad", winter)).toBeNull();
  });
});
