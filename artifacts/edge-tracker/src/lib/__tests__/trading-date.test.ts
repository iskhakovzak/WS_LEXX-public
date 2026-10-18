import { describe, expect, it } from "vitest";
import { addDays, nyDate, prevWeekday } from "@/lib/trading-date";
import * as server from "../../../../api-server/src/lib/tradingDate";

// 2026: DST starts Sun 2026-03-08 (→ UTC−4), ends Sun 2026-11-01 (→ UTC−5).
describe("trading-date.nyDate (client) ≡ server", () => {
  it.each<[string, string]>([
    ["2026-03-07T04:59:59Z", "2026-03-06"],
    ["2026-03-07T05:00:00Z", "2026-03-07"],
    ["2026-03-08T06:59:00Z", "2026-03-08"],
    ["2026-03-08T07:00:00Z", "2026-03-08"],
    ["2026-03-09T03:59:59Z", "2026-03-08"],
    ["2026-03-09T04:00:00Z", "2026-03-09"],
    ["2026-11-01T05:30:00Z", "2026-11-01"],
    ["2026-11-01T06:30:00Z", "2026-11-01"],
    ["2026-11-02T04:30:00Z", "2026-11-01"],
    ["2026-11-02T05:00:00Z", "2026-11-02"],
    ["2027-01-01T03:00:00Z", "2026-12-31"],
  ])("nyDate(%s) → %s", (iso, e) => {
    expect(nyDate(new Date(iso))).toBe(e);
    expect(server.nyDate(new Date(iso))).toBe(e);
  });

  it("default is now, same on both sides", () => {
    expect(nyDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(nyDate()).toBe(server.nyDate());
  });
});

describe("trading-date.addDays (client) ≡ server", () => {
  it.each<[string, number, string]>([
    ["2026-02-28", 1, "2026-03-01"],
    ["2024-02-28", 1, "2024-02-29"],
    ["2100-02-28", 1, "2100-03-01"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2026-01-01", -1, "2025-12-31"],
    ["2026-03-08", 1, "2026-03-09"],
    ["2026-10-17", 0, "2026-10-17"],
    ["2026-10-17", -365, "2025-10-17"],
  ])("addDays(%s, %i) → %s", (d, n, e) => {
    expect(addDays(d, n)).toBe(e);
    expect(server.addDays(d, n)).toBe(e);
  });
});

describe("trading-date.prevWeekday", () => {
  it.each<[string, string]>([
    ["2026-10-20", "2026-10-19"], // Tue → Mon
    ["2026-10-19", "2026-10-16"], // Mon → Fri
    ["2026-10-18", "2026-10-16"], // Sun → Fri
    ["2026-10-17", "2026-10-16"], // Sat → Fri
    ["2026-11-02", "2026-10-30"], // Mon across month
    ["2026-01-05", "2026-01-02"],
    ["2026-01-01", "2025-12-31"], // across year
    ["2026-03-09", "2026-03-06"], // Monday after DST start
  ])("prevWeekday(%s) → %s", (d, e) => expect(prevWeekday(d)).toBe(e));

  it("never returns a weekend and always moves back", () => {
    let d = "2026-12-31";
    for (let i = 0; i < 300; i++) {
      const p = prevWeekday(d);
      expect(p < d).toBe(true);
      expect(server.isWeekend(p)).toBe(false);
      d = p;
    }
  });
});
