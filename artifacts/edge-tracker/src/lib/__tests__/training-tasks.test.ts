import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_SETTINGS, activeFilterCount, countFor, noTasksMessage, parseRecent, parseTaskSettings, pushRecent, settingsForRole, taskQuery,
  taskSettingsKey, taskUrl,
  TASK_RECENT_MAX, type TaskSettings,
} from "../training-tasks";

describe("training task settings", () => {
  it("parses stored settings defensively", () => {
    expect(parseTaskSettings(null)).toEqual(DEFAULT_TASK_SETTINGS);
    expect(parseTaskSettings("{bad")).toEqual(DEFAULT_TASK_SETTINGS);
    expect(parseTaskSettings(JSON.stringify({ source: "desk", res: "any", side: "short", result: "win", ticker: " nvda ", from: "2026-08-01", to: "x" }))).toEqual({
      source: "desk", res: "any", side: "short", result: "win", ticker: "NVDA", from: "2026-08-01", to: "",
    });
    expect(parseTaskSettings({ source: "hack", ticker: "DROP TABLE" })).toMatchObject({ source: "mine", ticker: "" });
  });

  it("keeps settings per viewer and resets trade sources for guests", () => {
    const guest = taskSettingsKey("guest", null);
    const member = taskSettingsKey("trader", "Артур");
    expect(guest).not.toBe(member);
    expect(taskSettingsKey(undefined, undefined)).toBe(taskSettingsKey(null, null));
    expect(taskSettingsKey("trader", "Артур")).not.toBe(taskSettingsKey("trader", "Умид"));
    expect(taskSettingsKey("trader", "Артур")).not.toBe(taskSettingsKey("admin", "Артур"));
    const desk: TaskSettings = { ...DEFAULT_TASK_SETTINGS, source: "desk", ticker: "NVDA" };
    expect(settingsForRole(desk, false)).toEqual({ ...desk, source: "day" });
    expect(settingsForRole(desk, true)).toBe(desk);
    expect(settingsForRole({ ...desk, source: "day" }, true).source).toBe("day");
  });

  it("builds the pool / task query; side and result do not apply to ticker-days", () => {
    const s: TaskSettings = { source: "desk", res: "1m", side: "long", result: "loss", ticker: "aapl", from: "2026-09-01", to: "" };
    expect(taskQuery(s)).toBe("source=desk&side=long&result=loss&ticker=AAPL&from=2026-09-01");
    expect(taskQuery(s, { forTask: true, exclude: ["t1", "d:SPY:2026-10-14"] })).toBe("source=desk&side=long&result=loss&ticker=AAPL&from=2026-09-01&res=1m&exclude=t1%2Cd%3ASPY%3A2026-10-14");
    expect(taskQuery({ ...s, source: "day" })).toBe("source=day&ticker=AAPL&from=2026-09-01");
    expect(activeFilterCount(s)).toBe(4);
    expect(activeFilterCount({ ...s, source: "day" })).toBe(2);
  });

  it("counts by resolution and explains an empty pool", () => {
    const c = { total: 100, "1m": 3, "5m": 20, "60m": 77 };
    expect([countFor(c, "1m"), countFor(c, "5m"), countFor(c, "any"), countFor(null, "any")]).toEqual([3, 23, 100, 0]);
    expect(noTasksMessage({ ...DEFAULT_TASK_SETTINGS, res: "5m" }, { total: 5, "1m": 0, "5m": 0, "60m": 5 })).toMatch(/часовыми/);
    expect(noTasksMessage({ ...DEFAULT_TASK_SETTINGS, res: "1m" }, { total: 5, "1m": 0, "5m": 2, "60m": 3 })).toMatch(/7 дней/);
    expect(noTasksMessage(DEFAULT_TASK_SETTINGS, { total: 0, "1m": 0, "5m": 0, "60m": 0 })).toMatch(/деска/);
  });

  it("remembers recent tasks uniquely and caps them", () => {
    let r: string[] = [];
    for (let i = 0; i < TASK_RECENT_MAX + 5; i++) r = pushRecent(r, `t${i}`);
    expect(r).toHaveLength(TASK_RECENT_MAX);
    expect(pushRecent(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(parseRecent('["t1", 5, "d:A:2026-01-02"]')).toEqual(["t1", "d:A:2026-01-02"]);
    expect(parseRecent("nope")).toEqual([]);
  });

  it("opens a trade task with its source and a ticker-day task without a trade", () => {
    expect(taskUrl({ kind: "trade", tradeId: 42, ticker: "X", date: "2026-10-14", source: "desk" }, "5m")).toBe("/chart-lab?trade=42&src=desk&mode=training&tf=5m");
    expect(taskUrl({ kind: "day", tradeId: null, ticker: "SPY", date: "2026-10-14", source: "day" }, "1m")).toBe("/chart-lab?ticker=SPY&date=2026-10-14&mode=training");
  });
});
