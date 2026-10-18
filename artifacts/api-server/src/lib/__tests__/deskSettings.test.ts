/**
 * Desk settings — pure parts: value validation against the registry (lib/settings/validate), the Telegram send times
 * derived from the settings (lib/daily/telegramSchedule) and the jobs registry following a cron getter (a saved time
 * moves the next run without a restart). The thresholds the daily engine reads come from setting() too.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SETTINGS, __loadSettingsCache, setting } from "../settings/registry";
import { timeToMinutes, validateBatch, validateSetting, storedOrNull } from "../settings/validate";
import { EVENING_FROM_MIN, eveningCron, eveningSendMinutes, morningCron, weekdayCronAt } from "../daily/telegramSchedule";
import { focusSettings, focusWindow, pickFocus } from "../daily/engine";
import { dayThresholds } from "../daily/detectors";
import { feesReason } from "../daily/costQueue";
import { cronMatches, nextCronRun, parseCron } from "../../jobs/cron";
import { clearJobs, cronOf, jobsStatus, registerJob, setJobDeps } from "../../jobs/registry";

afterEach(() => __loadSettingsCache({}));

describe("validateSetting", () => {
  it("numbers: type, bounds, whole numbers for an integer step; ratios keep decimals", () => {
    expect(validateSetting("daily.focusWindowDays", 15)).toEqual({ ok: true, value: 15 });
    expect(validateSetting("daily.focusWindowDays", 2)).toEqual({ ok: false, problem: { key: "daily.focusWindowDays", kind: "range", min: 3, max: 30 } });
    expect(validateSetting("daily.focusWindowDays", 31)).toMatchObject({ ok: false, problem: { kind: "range" } });
    expect(validateSetting("daily.focusWindowDays", 7.5)).toMatchObject({ ok: false, problem: { kind: "integer" } });
    expect(validateSetting("daily.focusWindowDays", "10")).toMatchObject({ ok: false, problem: { kind: "type" } });
    expect(validateSetting("daily.focusWindowDays", Number.NaN)).toMatchObject({ ok: false, problem: { kind: "type" } });
    expect(validateSetting("daily.feesShare", 0.35)).toEqual({ ok: true, value: 0.35 });
    expect(validateSetting("discipline.contractBrokenPoints", -20)).toEqual({ ok: true, value: -20 });
    expect(validateSetting("discipline.contractBrokenPoints", 1)).toMatchObject({ ok: false, problem: { kind: "range" } });
  });

  it("time HH:MM, booleans, unknown keys, null = default", () => {
    expect(validateSetting("telegram.morningTime", "07:30")).toEqual({ ok: true, value: "07:30" });
    for (const bad of ["7:30", "24:00", "08:60", "08:45:00", ""]) expect(validateSetting("telegram.morningTime", bad)).toMatchObject({ ok: false, problem: { kind: "time" } });
    expect(validateSetting("telegram.morningTime", 830)).toMatchObject({ ok: false, problem: { kind: "type" } });
    expect(validateSetting("telegram.morningEnabled", false)).toEqual({ ok: true, value: false });
    expect(validateSetting("telegram.morningEnabled", "false")).toMatchObject({ ok: false, problem: { kind: "type" } });
    expect(validateSetting("nope.key", 1)).toEqual({ ok: false, problem: { key: "nope.key", kind: "unknown" } });
    expect(validateSetting("daily.focusWindowDays", null)).toEqual({ ok: true, value: null });
    expect(validateSetting("__proto__", 1)).toMatchObject({ ok: false, problem: { kind: "unknown" } });
  });

  it("a batch is all-or-nothing and reports every problem (duplicates too)", () => {
    expect(validateBatch([{ key: "daily.focusMinDays", value: 3 }, { key: "telegram.eveningTime", value: "17:00" }])).toEqual({
      ok: true, values: [{ key: "daily.focusMinDays", value: 3 }, { key: "telegram.eveningTime", value: "17:00" }],
    });
    const r = validateBatch([{ key: "daily.focusMinDays", value: 3 }, { key: "daily.focusMinDays", value: 4 }, { key: "x", value: 1 }, { key: "telegram.morningTime", value: "9" }]);
    expect(r).toEqual({ ok: false, problems: [
      { key: "daily.focusMinDays", kind: "duplicate" }, { key: "x", kind: "unknown" }, { key: "telegram.morningTime", kind: "time" },
    ] });
  });

  it("a stored value that no longer fits reads as the default; every registry default is valid", () => {
    expect(storedOrNull("daily.focusWindowDays", 99)).toBeNull();
    expect(storedOrNull("daily.focusWindowDays", 12)).toBe(12);
    for (const [key, def] of Object.entries(SETTINGS)) expect(validateSetting(key, def.default), key).toMatchObject({ ok: true });
    expect(timeToMinutes("08:45")).toBe(525);
  });
});

describe("engine reads the settings", () => {
  it("focus window, repeat days and min cost follow setting()", () => {
    expect(focusSettings()).toEqual({ windowDays: 10, minDays: 2, minCost: 10 });
    expect(focusWindow("2026-10-19")).toEqual({ from: "2026-10-05", to: "2026-10-16" });
    __loadSettingsCache({ "daily.focusWindowDays": 5, "daily.focusMinDays": 3, "daily.focusMinCostUsd": 100 });
    expect(focusWindow("2026-10-19")).toEqual({ from: "2026-10-12", to: "2026-10-16" });
    const cost = { id: "day:fees" as const, count: 2, days: 2, costNet: -50, examples: [] };
    expect(pickFocus([cost])).toBeNull(); // 2 days < 3 and $50 < $100
    __loadSettingsCache({});
    expect(pickFocus([cost])?.id).toBe("day:fees");
  });

  it("fees thresholds are shared by the engine and the curator queue", () => {
    expect(dayThresholds()).toMatchObject({ feesShare: 0.5, feesHealthyShare: 0.25, feesMinUsd: 5 });
    expect(feesReason(100, 40)).toBeNull(); // 40 % < 50 %
    __loadSettingsCache({ "daily.feesShare": 0.3 });
    expect(feesReason(100, 40)).toMatchObject({ kind: "fees", costNet: -15 }); // 40 − 25 % of 100
  });
});

describe("Telegram send times", () => {
  it("defaults 08:45 / 16:30 NY on weekdays", () => {
    expect(morningCron()).toBe("45 8 * * 1-5");
    expect(eveningCron()).toBe("30 16 * * 1-5");
    expect(weekdayCronAt(0)).toBe("0 0 * * 1-5");
  });

  it("a saved time moves the cron; the evening never goes before 16:15", () => {
    __loadSettingsCache({ "telegram.morningTime": "07:05", "telegram.eveningTime": "18:00" });
    expect(morningCron()).toBe("5 7 * * 1-5");
    expect(eveningCron()).toBe("0 18 * * 1-5");
    __loadSettingsCache({ "telegram.eveningTime": "15:00" });
    expect(eveningSendMinutes()).toBe(EVENING_FROM_MIN);
    expect(eveningCron()).toBe("15 16 * * 1-5");
    expect(setting("telegram.morningTime")).toBe("08:45");
  });

  it("the cron fires at the NY minute only on weekdays", () => {
    __loadSettingsCache({ "telegram.morningTime": "07:30" });
    const e = parseCron(morningCron());
    expect(cronMatches(e, new Date("2026-10-16T11:30:00Z"))).toBe(true); // Fri 07:30 EDT
    expect(cronMatches(e, new Date("2026-10-16T12:45:00Z"))).toBe(false); // the old 08:45
    expect(cronMatches(e, new Date("2026-10-17T11:30:00Z"))).toBe(false); // Saturday
    expect(cronMatches(e, new Date("2026-12-04T12:30:00Z"))).toBe(true); // Fri 07:30 EST
  });

  it("the jobs registry follows a cron getter (next run moves after a save)", async () => {
    clearJobs();
    const fakePool = { connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }) };
    setJobDeps({ pool: fakePool as never, logger: { info: () => undefined, warn: () => undefined, error: () => undefined } as never });
    registerJob({ name: "t.dynamic", cron: morningCron, timeoutMs: 1000, run: async () => ({}) });
    const job = { name: "t.dynamic", cron: morningCron, timeoutMs: 1000, run: async () => ({}) };
    expect(cronOf(job)).toBe("45 8 * * 1-5");
    const before = (await jobsStatus()).find((j) => j.name === "t.dynamic")!;
    expect(before.cron).toBe("45 8 * * 1-5");
    __loadSettingsCache({ "telegram.morningTime": "09:10" });
    const after = (await jobsStatus()).find((j) => j.name === "t.dynamic")!;
    expect(after.cron).toBe("10 9 * * 1-5");
    const next = new Date(after.nextRunAt!);
    expect(cronMatches(parseCron("10 9 * * 1-5"), next)).toBe(true);
    expect(next.getTime()).toBeLessThanOrEqual(nextCronRun(parseCron("10 9 * * 1-5"), new Date())!.getTime());
    clearJobs();
  });
});
