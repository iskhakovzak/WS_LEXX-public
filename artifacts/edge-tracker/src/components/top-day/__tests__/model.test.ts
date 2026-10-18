import { describe, expect, it } from "vitest";
import { heatLevel, lastFinishedDay, latestDay, maxAbsNet, monthGrid, shiftMonth } from "../model";
import type { CalendarDay } from "../api";

const day = (date: string, trades: number, net: number | null = 0): CalendarDay => ({ date, net, trades, traders: 1, best: null, worst: null, mine: null });

describe("top-day model", () => {
  it("lastFinishedDay: after the close → today; before → previous weekday; weekend → Friday", () => {
    expect(lastFinishedDay(new Date("2026-10-16T20:30:00Z"))).toBe("2026-10-16"); // Fri 16:30 ET
    expect(lastFinishedDay(new Date("2026-10-16T14:00:00Z"))).toBe("2026-10-15"); // Fri 10:00 ET
    expect(lastFinishedDay(new Date("2026-10-18T15:00:00Z"))).toBe("2026-10-16"); // Sun
    expect(lastFinishedDay(new Date("2026-10-19T13:00:00Z"))).toBe("2026-10-16"); // Mon 09:00 ET
  });
  it("shiftMonth crosses years", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
  it("monthGrid: Monday first, padded weeks", () => {
    const g = monthGrid("2026-10"); // Oct 1 2026 = Thursday
    expect(g[0]).toEqual([null, null, null, "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(g.every((w) => w.length === 7)).toBe(true);
    expect(g.flat().filter(Boolean)).toHaveLength(31);
    expect(g[g.length - 1].includes("2026-10-31")).toBe(true);
  });
  it("latestDay picks the last traded day not after the limit", () => {
    const days = [day("2026-10-15", 3), day("2026-10-16", 5), day("2026-10-14", 0)];
    expect(latestDay(days, "2026-10-16")).toBe("2026-10-16");
    expect(latestDay(days, "2026-10-15")).toBe("2026-10-15");
    expect(latestDay(days, "2026-10-01")).toBeNull();
  });
  it("heat levels", () => {
    const days = [day("a", 1, 100), day("b", 1, -400)];
    expect(maxAbsNet(days)).toBe(400);
    expect(heatLevel(-400, 400)).toBe(3);
    expect(heatLevel(200, 400)).toBe(2);
    expect(heatLevel(50, 400)).toBe(1);
    expect(heatLevel(null, 400)).toBe(0);
    expect(heatLevel(0, 400)).toBe(0);
  });
});
