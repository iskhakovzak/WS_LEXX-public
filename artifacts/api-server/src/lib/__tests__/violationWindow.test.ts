import { describe, expect, it } from "vitest";
import { countRecentViolations, recentViolationWindow, violationDaySql, violationTradingDay } from "../violationWindow";
import { nyDate } from "../tradingDate";

describe("violationWindow", () => {
  it("window = previous weekday .. today", () => {
    expect(recentViolationWindow("2026-10-16")).toEqual({ from: "2026-10-15", to: "2026-10-16" }); // Fri
    expect(recentViolationWindow("2026-10-17")).toEqual({ from: "2026-10-16", to: "2026-10-17" }); // Sat → Fri
    expect(recentViolationWindow("2026-10-19")).toEqual({ from: "2026-10-16", to: "2026-10-19" }); // Mon → Fri
  });

  it("uses the stored trading day, falls back to the NY date of occurred_at", () => {
    expect(violationTradingDay({ day: "2026-01-02", occurredAt: "2026-10-17T15:00:00Z" }, nyDate)).toBe("2026-01-02");
    expect(violationTradingDay({ day: "", occurredAt: "2026-10-17T02:00:00Z" }, nyDate)).toBe("2026-10-16"); // 22:00 NY
    expect(violationTradingDay({ day: null, occurredAt: new Date("2026-10-16T18:00:00Z") }, nyDate)).toBe("2026-10-16");
  });

  it("a backfill inserted just now does not count as «за сутки»", () => {
    const insertedNow = "2026-10-17T14:00:00Z";
    const backfill = Array.from({ length: 2545 }, (_, i) => ({ day: `2026-0${1 + (i % 8)}-1${i % 10}`, occurredAt: insertedNow }));
    const fresh = [
      { day: "2026-10-16", occurredAt: insertedNow },
      { day: "2026-10-17", occurredAt: insertedNow },
      { day: null, occurredAt: "2026-10-16T19:00:00Z" },
    ];
    expect(countRecentViolations([...backfill, ...fresh], "2026-10-17", nyDate)).toBe(3);
  });

  it("SQL expression reads day first, NY date as fallback", () => {
    expect(violationDaySql("v")).toBe("COALESCE(NULLIF(v.day, ''), TO_CHAR(v.occurred_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD'))");
    expect(violationDaySql("")).toContain("NULLIF(day, '')");
  });
});
