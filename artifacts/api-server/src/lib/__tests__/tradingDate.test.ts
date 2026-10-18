import { describe, expect, it } from "vitest";
import { addDays, isWeekend, nyDate, nyMinutes, nySession } from "../tradingDate";

// 2026: DST starts Sun 2026-03-08 02:00 EST (→ UTC−4), ends Sun 2026-11-01 02:00 EDT (→ UTC−5).
describe("tradingDate.nyDate — New York calendar date", () => {
  it.each<[string, string, string]>([
    ["winter, before NY midnight", "2026-03-07T04:59:59Z", "2026-03-06"],
    ["winter, exactly NY midnight (05:00Z)", "2026-03-07T05:00:00Z", "2026-03-07"],
    ["DST-start day, 01:59 EST", "2026-03-08T06:59:00Z", "2026-03-08"],
    ["DST-start day, 03:00 EDT (skipped hour)", "2026-03-08T07:00:00Z", "2026-03-08"],
    ["summer, before NY midnight (03:59Z)", "2026-03-09T03:59:59Z", "2026-03-08"],
    ["summer, exactly NY midnight (04:00Z)", "2026-03-09T04:00:00Z", "2026-03-09"],
    ["summer, 04:59Z is already the next NY day", "2026-06-15T04:59:00Z", "2026-06-15"],
    ["DST-end day, 01:30 EDT (first pass)", "2026-11-01T05:30:00Z", "2026-11-01"],
    ["DST-end day, 01:30 EST (second pass)", "2026-11-01T06:30:00Z", "2026-11-01"],
    ["after DST end: 04:30Z is still 23:30 EST previous day", "2026-11-02T04:30:00Z", "2026-11-01"],
    ["after DST end: NY midnight at 05:00Z", "2026-11-02T05:00:00Z", "2026-11-02"],
    ["new year in NY lags UTC", "2027-01-01T03:00:00Z", "2026-12-31"],
    ["leap day", "2028-02-29T12:00:00Z", "2028-02-29"],
  ])("%s", (_n, iso, expected) => {
    expect(nyDate(new Date(iso))).toBe(expected);
  });

  it("default argument is now and has the YYYY-MM-DD shape", () => {
    expect(nyDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("tradingDate.nyMinutes / nySession", () => {
  it.each<[string, number]>([
    ["2026-06-15T13:30:00Z", 570], // 09:30 EDT
    ["2026-01-15T14:30:00Z", 570], // 09:30 EST
    ["2026-06-15T04:00:00Z", 0], // NY midnight → 0, not 1440 (hourCycle h23)
    ["2026-06-15T03:59:00Z", 1439],
    ["2026-06-15T20:00:00Z", 960], // 16:00 EDT
    ["2026-03-08T07:00:00Z", 180], // 03:00 EDT right after the spring-forward gap
    ["2026-11-01T06:00:00Z", 60], // 01:00 EST after the fall-back repeat
  ])("nyMinutes(%s) → %i", (iso, m) => expect(nyMinutes(new Date(iso))).toBe(m));

  const at = (hh: number, mm: number) => new Date(Date.UTC(2026, 5, 15, hh + 4, mm)); // EDT: UTC−4
  it.each<[number, number, string]>([
    [3, 59, "closed"],
    [4, 0, "premarket"],
    [9, 29, "premarket"],
    [9, 30, "regular"],
    [15, 59, "regular"],
    [16, 0, "postmarket"],
    [19, 59, "postmarket"],
    [20, 0, "closed"],
    [23, 59, "closed"],
    [0, 0, "closed"],
  ])("%02i:%02i ET → %s", (hh, mm, s) => expect(nySession(at(hh, mm))).toBe(s));
});

describe("tradingDate.addDays (calendar arithmetic, timezone-free)", () => {
  it.each<[string, number, string]>([
    ["2026-02-28", 1, "2026-03-01"],
    ["2024-02-28", 1, "2024-02-29"],
    ["2024-02-29", 1, "2024-03-01"],
    ["2100-02-28", 1, "2100-03-01"], // not a leap year
    ["2026-12-31", 1, "2027-01-01"],
    ["2026-01-01", -1, "2025-12-31"],
    ["2026-03-08", 1, "2026-03-09"], // DST start: still exactly one day
    ["2026-11-01", -1, "2026-10-31"],
    ["2026-10-17", 0, "2026-10-17"],
    ["2026-10-17", 30, "2026-11-16"],
    ["2026-10-17", -365, "2025-10-17"],
  ])("addDays(%s, %i) → %s", (d, n, e) => {
    expect(addDays(d, n)).toBe(e);
  });
});

describe("tradingDate.isWeekend", () => {
  it.each<[string, boolean]>([
    ["2026-10-16", false], // Fri
    ["2026-10-17", true], // Sat
    ["2026-10-18", true], // Sun
    ["2026-10-19", false], // Mon
    ["2026-03-08", true], // DST Sunday
    ["2026-01-01", false], // Thu
  ])("isWeekend(%s) → %s", (d, e) => expect(isWeekend(d)).toBe(e));
});
