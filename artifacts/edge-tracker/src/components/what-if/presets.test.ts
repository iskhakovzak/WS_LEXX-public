import { describe, expect, it } from "vitest";
import type { PreviewTrade } from "./rules";
import { buildQuestions, changedDays, cheapestTariff, tariffOptions, typicalDayLoss, worstSetups, TARIFF_EXAMPLES } from "./presets";

let id = 0;
const mk = (day: string, gross: number, extra: Partial<PreviewTrade> = {}): PreviewTrade => {
  id++;
  return { id, day, entryMin: 600 + id, ticker: "AAA", side: "long", qty: 100, entry: 10, gross, fees: 1, holdSec: 60, seq: id, ...extra };
};

describe("worstSetups", () => {
  it("returns losing setups with enough trades, worst first", () => {
    const ts = [
      ...Array.from({ length: 5 }, () => mk("2026-01-02", -20, { setup: "Fade" })),
      ...Array.from({ length: 5 }, () => mk("2026-01-02", -5, { setup: "chase" })),
      ...Array.from({ length: 5 }, () => mk("2026-01-02", -4, { setup: "Chase" })),
      ...Array.from({ length: 5 }, () => mk("2026-01-02", 30, { setup: "ORB" })),
      mk("2026-01-02", -999, { setup: "Rare" }),
    ];
    expect(worstSetups(ts).map((w) => w.name)).toEqual(["Fade", "chase"]);
    expect(worstSetups(ts)[1].n).toBe(10);
  });
});

describe("typicalDayLoss", () => {
  it("takes the median losing day, rounded", () => {
    const ts = [mk("2026-01-01", -43), mk("2026-01-02", -61), mk("2026-01-03", -120), mk("2026-01-04", 500)];
    // nets −44, −62, −121 → median 62 → 60
    expect(typicalDayLoss(ts)).toBe(60);
    expect(typicalDayLoss([mk("2026-01-01", -10)])).toBeNull();
  });
});

describe("cheapestTariff", () => {
  it("picks the plan with the biggest saving, or null when nothing is cheaper", () => {
    const expensive = [mk("2026-01-01", 10, { fees: 50 }), mk("2026-01-02", 10, { fees: 50 })];
    const best = cheapestTariff(expensive, TARIFF_EXAMPLES);
    expect(best).not.toBeNull();
    expect(best!.saving).toBeGreaterThan(0);
    expect(cheapestTariff([mk("2026-01-01", 10, { fees: 0 })], TARIFF_EXAMPLES)).toBeNull();
  });
  it("lists server commission presets before the examples", () => {
    const opts = tariffOptions([{ id: "x", label: "Наш тариф", rules: [{ type: "commissionPlan", perShare: 0.001, minPerOrder: 0.1, ecnPerShare: 0 }] }, { id: "y", label: "Другое", rules: [{ type: "maxTradesPerDay", n: 3 }] }]);
    expect(opts[0].label).toBe("Наш тариф");
    expect(opts).toHaveLength(1 + TARIFF_EXAMPLES.length);
  });
});

describe("buildQuestions", () => {
  it("disables setup / grade questions with a reason when the data has none", () => {
    const qs = buildQuestions([mk("2026-01-01", -10), mk("2026-01-02", -20), mk("2026-01-03", -30)], []);
    const by = Object.fromEntries(qs.map((q) => [q.id, q]));
    expect(by.after3.rule).toEqual({ type: "stopAfterLosses", n: 3 });
    expect(by.worstSetups.disabled).toBe("в сделках не размечены сетапы");
    expect(by.aplus.disabled).toMatch(/оценки/);
    expect(by.dayLimit.rule).toEqual({ type: "dailyLossLimit", usd: 20 });
  });
  it("enables «только A+» when trades are graded", () => {
    const qs = buildQuestions([mk("2026-01-01", 5, { grade: "A+" })], []);
    expect(qs.find((q) => q.id === "aplus")!.rule).toEqual({ type: "minGrade", grade: "A+" });
  });
});

describe("changedDays", () => {
  it("lists days the scenario changed, biggest first, marking removed days", () => {
    const base = [{ day: "d1", net: -100 }, { day: "d2", net: 50 }, { day: "d3", net: 10 }];
    const sc = [{ day: "d2", net: 50 }, { day: "d3", net: 30 }];
    expect(changedDays(base, sc)).toEqual([
      { day: "d1", before: -100, after: 0, delta: 100, removed: true },
      { day: "d3", before: 10, after: 30, delta: 20, removed: false },
    ]);
  });
});
