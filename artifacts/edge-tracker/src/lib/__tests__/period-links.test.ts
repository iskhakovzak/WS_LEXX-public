import { describe, expect, it } from "vitest";
import { chartClickDate, dayHref, isoWeekOf, periodHref, weekHref, ymdOf } from "../period-links";

describe("period links", () => {
  it("day → day report, trader only when it is one person", () => {
    expect(dayHref("2026-10-16")).toBe("/day-report?date=2026-10-16");
    expect(dayHref("2026-10-16T14:30:00Z", "Ориф")).toBe(`/day-report?date=2026-10-16&trader=${encodeURIComponent("Ориф")}`);
    expect(dayHref("2026-10-16", "all")).toBe("/day-report?date=2026-10-16");
  });

  it("week → weekly review by ISO week (from a date or a key)", () => {
    expect(isoWeekOf("2026-10-12")).toBe("2026-W42");
    expect(isoWeekOf("2026-10-18")).toBe("2026-W42"); // Sunday stays in the week
    expect(isoWeekOf("2027-01-01")).toBe("2026-W53"); // Friday of the last 2026 week
    expect(weekHref("2026-10-14", "Ориф")).toBe(`/weekly-review?week=2026-W42&trader=${encodeURIComponent("Ориф")}`);
    expect(weekHref("2026-W05")).toBe("/weekly-review?week=2026-W05");
    expect(periodHref("week", "2026-10-14")).toBe("/weekly-review?week=2026-W42");
    expect(periodHref("day", "2026-10-14")).toBe("/day-report?date=2026-10-14");
  });

  it("reads the period from a recharts click", () => {
    expect(chartClickDate({ activePayload: [{ payload: { date: "2026-10-16", pnl: 5 } }], activeLabel: "16.10" })).toBe("2026-10-16");
    expect(chartClickDate({ activeLabel: "2026-10-16" })).toBe("2026-10-16");
    expect(chartClickDate({ payload: { week: "2026-10-12" } }, "week")).toBe("2026-10-12");
    expect(chartClickDate({ activeLabel: "Пн" })).toBeNull();
    expect(chartClickDate(null)).toBeNull();
    expect(ymdOf(42)).toBeNull();
  });
});
