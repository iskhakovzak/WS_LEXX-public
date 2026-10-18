import { describe, expect, it } from "vitest";
import { axisLabel, linear, niceStep, niceTicks, yDomain } from "../scale";
import { crosshairDate, timeTicks } from "../time";

describe("scale", () => {
  it("linear maps and inverts (inverted pixel range)", () => {
    const y = linear({ min: -100, max: 100 }, 200, 0);
    expect(y(-100)).toBe(200);
    expect(y(0)).toBe(100);
    expect(y.invert(50)).toBe(50);
  });

  it("nice steps", () => {
    expect(niceStep(1000, 5)).toBe(200);
    expect(niceStep(9, 4)).toBe(2.5);
    expect(niceStep(0.7, 5)).toBe(0.1);
    expect(niceStep(0, 5)).toBe(1);
  });

  it("nice ticks stay inside the domain and hit zero exactly", () => {
    expect(niceTicks(-130, 480, 5)).toEqual([-100, 0, 100, 200, 300, 400]);
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(0.1, 0.7, 3)).toEqual([0.2, 0.4, 0.6]);
    expect(niceTicks(NaN, 1)).toEqual([]);
  });

  it("y domain pulls the start line in only when it is close", () => {
    const near = yDomain(200, 1000, { pad: 0 });
    expect(near.min).toBe(0);
    const far = yDomain(9000, 10000, { pad: 0 });
    expect(far.min).toBe(9000);
    const neg = yDomain(-500, -100, { pad: 0 });
    expect(neg.max).toBe(0);
    const flat = yDomain(0, 0);
    expect(flat.max).toBeGreaterThan(flat.min);
    expect(yDomain(100, 100, { includeZero: false }).min).toBe(50);
  });

  it("axis labels: compact money, signed R, fine steps on big values", () => {
    expect(axisLabel(1500, "net")).toBe("$1.5K");
    expect(axisLabel(-85, "net")).toBe("−$85");
    expect(axisLabel(2.5, "r")).toBe("+2.5R");
    expect(axisLabel(-12, "r")).toBe("−12R");
    expect(axisLabel(0, "r")).toBe("0R");
    expect(axisLabel(0.25, "r", 0.05)).toBe("+0.25R");
    expect(axisLabel(12350, "net", 50)).toBe("$12.35K");
  });
});

/** Trading days (Mon–Fri) from `from`, `count` of them. */
function weekdays(from: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  while (out.length < count) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("time ticks", () => {
  it("day labels with the month name at a month start when there is room", () => {
    const keys = weekdays("2026-09-24", 10); // 24 Sep … 7 Oct
    const ticks = timeTicks(keys, 0, keys.length, 80);
    expect(ticks[0]).toMatchObject({ index: 0, label: "сен", major: true });
    const oct = ticks.find((x) => keys[x.index] === "2026-10-01");
    expect(oct).toMatchObject({ label: "окт", major: true });
    expect(ticks.find((x) => keys[x.index] === "2026-09-25")?.label).toBe("25");
  });

  it("switches to weeks / months / years as it gets dense and keeps the spacing", () => {
    const keys = weekdays("2024-01-02", 520); // ~2 years
    const months = timeTicks(keys, 0, keys.length, 2);
    expect(months.every((x, i) => i === 0 || (x.index - months[i - 1].index) * 2 >= 64)).toBe(true);
    expect(months.some((x) => x.label === "2025" && x.major)).toBe(true);
    const weeks = timeTicks(keys, 0, 60, 14);
    // ~5 days per week × 14px = 70px ≥ 64 → week level: labels are day numbers on Mondays (or month starts).
    expect(weeks.length).toBeGreaterThan(5);
    expect(weeks.length).toBeLessThan(20);
    const tiny = timeTicks(keys, 0, keys.length, 0.3);
    expect(tiny.every((x) => /^\d{4}$/.test(x.label))).toBe(true);
  });

  it("the first label inside a month names the month", () => {
    const keys = weekdays("2026-09-24", 10);
    expect(timeTicks(keys, 2, keys.length, 80)[0]).toMatchObject({ index: 2, label: "28 сен", major: false });
  });

  it("monthly candles never get day labels", () => {
    const keys = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"];
    expect(timeTicks(keys, 0, 4, 100, "month").map((x) => x.label)).toEqual(["2026", "фев", "мар", "апр"]);
  });

  it("empty / degenerate input", () => {
    expect(timeTicks([], 0, 10, 10)).toEqual([]);
    expect(timeTicks(["2026-10-12"], 0, 1, 0)).toEqual([]);
  });

  it("crosshair date: weekday, year only when it differs", () => {
    expect(crosshairDate("2026-10-16", "day", "2026")).toBe("пт, 16 окт");
    expect(crosshairDate("2025-10-16", "day", "2026")).toBe("чт, 16 окт 2025");
    expect(crosshairDate("2026-10-12", "week", "2026")).toBe("нед. 12 окт");
    expect(crosshairDate("2026-10-01", "month", "2026")).toBe("октябрь 2026");
  });
});
