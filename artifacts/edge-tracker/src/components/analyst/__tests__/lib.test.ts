import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS, activeFilterCount, isTopFirm, matchesFilters, normalizeFilters, previousSessionDay, scoreAction,
  type FeedAction, type FilterCtx,
} from "@/components/analyst/lib";
import * as rx from "../../../../../api-server/src/lib/analystReaction";

function act(p: Partial<FeedAction> = {}): FeedAction {
  return {
    id: 1, ticker: "AAPL", firm: "Some Small Firm", action: "maintain", actionRaw: "main", toGrade: "Buy", fromGrade: "Buy",
    source: "yahoo", sourceUrl: null, gradedAt: "2026-10-16T11:00:00Z", priceTarget: null, priceTargetFrom: null,
    marketCap: null, marketCapNum: null, sector: "Technology", longName: null, ...p,
  };
}
const base = { held: false, watched: false, traded: 0, top: false, weight: null, gapPct: null };

describe("scoreAction", () => {
  it("ranks rating change > initiation > target update", () => {
    const up = scoreAction(act({ action: "upgrade" }), base).score;
    const init = scoreAction(act({ action: "initiated" }), base).score;
    const pt = scoreAction(act({ action: "maintain", priceTarget: "105", priceTargetFrom: "100" }), base).score;
    expect(up).toBeGreaterThan(init);
    expect(init).toBeGreaterThan(pt);
  });
  it("my context lifts a target update above a bare upgrade", () => {
    const mine = scoreAction(act({ priceTarget: "130", priceTargetFrom: "100" }), { ...base, watched: true, traded: 12 });
    const bare = scoreAction(act({ action: "upgrade" }), base);
    expect(mine.score).toBeGreaterThan(bare.score);
    expect(mine.reasons.map((r) => r.key)).toEqual(["pt", "watch", "traded"]);
  });
  it("team position dominates and reasons are capped at four", () => {
    const r = scoreAction(act({ action: "downgrade", priceTarget: "80", priceTargetFrom: "100" }), {
      held: true, watched: true, traded: 3, top: true, weight: { n: 9, ratio: 2.2, hit: 0.7, avgSignedDay: 1.5 }, gapPct: -4,
    });
    expect(r.reasons).toHaveLength(4);
    expect(r.reasons[0].key).toBe("held");
    expect(r.score).toBeGreaterThan(400);
  });
  it("ignores firm weight on a small sample", () => {
    const small = scoreAction(act({ action: "upgrade" }), { ...base, weight: { n: 3, ratio: 4, hit: 1, avgSignedDay: 3 } });
    expect(small.reasons.find((x) => x.key === "weight")).toBeUndefined();
  });
});

describe("isTopFirm", () => {
  it("knows the big houses", () => {
    expect(isTopFirm("Goldman Sachs")).toBe(true);
    expect(isTopFirm("JP Morgan")).toBe(true);
    expect(isTopFirm("BofA Securities")).toBe(true);
    expect(isTopFirm("UBS")).toBe(true);
    expect(isTopFirm("Rosenblatt")).toBe(false);
  });
  it("promotes a firm the market reliably reacts to", () => {
    expect(isTopFirm("Rosenblatt", { n: 8, ratio: 1.9, hit: 0.6, avgSignedDay: 1 })).toBe(true);
    expect(isTopFirm("Rosenblatt", { n: 7, ratio: 3, hit: 0.6, avgSignedDay: 1 })).toBe(false);
  });
});

describe("filters", () => {
  const ctx: FilterCtx = { isMine: (t) => t === "NVDA", isTop: (f) => f === "Goldman Sachs", windowStart: "2026-10-16 16:00" };
  it("normalizes stale stored objects", () => {
    const f = normalizeFilters({ period: "7", ptMin: 7, tier: "x", type: "bogus", mineOnly: true });
    expect(f.period).toBe(DEFAULT_FILTERS.period);
    expect(f.ptMin).toBe(0);
    expect(f.tier).toBe("all");
    expect(f.type).toBe("all");
    expect(f.mineOnly).toBe(true);
    expect(normalizeFilters(null)).toEqual(DEFAULT_FILTERS);
    expect(activeFilterCount(f)).toBe(1);
  });
  it("applies tier, PT size, sector, mine and session window", () => {
    const f = { ...DEFAULT_FILTERS };
    const a = act({ ticker: "NVDA", firm: "Goldman Sachs", priceTarget: "120", priceTargetFrom: "100", gradedAt: "2026-10-17T11:00:00Z" });
    expect(matchesFilters(a, { ...f, tier: "top" }, ctx)).toBe(true);
    expect(matchesFilters(a, { ...f, tier: "other" }, ctx)).toBe(false);
    expect(matchesFilters(a, { ...f, ptMin: 20 }, ctx)).toBe(true);
    expect(matchesFilters(act(), { ...f, ptMin: 5 }, ctx)).toBe(false); // no target → fails a PT filter
    expect(matchesFilters(a, { ...f, sector: "Energy" }, ctx)).toBe(false);
    expect(matchesFilters(a, { ...f, mineOnly: true }, ctx)).toBe(true);
    expect(matchesFilters(act(), { ...f, mineOnly: true }, ctx)).toBe(false);
    expect(matchesFilters(a, { ...f, todayOnly: true }, ctx)).toBe(true);
    expect(matchesFilters(act({ gradedAt: "2026-10-16T15:00:00Z" }), { ...f, todayOnly: true }, ctx)).toBe(false);
    expect(matchesFilters(a, f, ctx, "nv")).toBe(true);
    expect(matchesFilters(a, f, ctx, "gold")).toBe(true);
    expect(matchesFilters(a, f, ctx, "vd")).toBe(false);
  });
  it("finds the previous session for a quiet premarket", () => {
    const items = [act({ gradedAt: "2026-10-15T14:00:00Z" }), act({ gradedAt: "2026-10-16T13:00:00Z" }), act({ gradedAt: "2026-10-17T12:00:00Z" })];
    expect(previousSessionDay(items, "2026-10-17 00:00")).toBe("2026-10-16");
    expect(previousSessionDay([], "2026-10-17 00:00")).toBeNull();
  });
});

describe("server reaction math", () => {
  it("maps publication time to the reaction session (NY)", () => {
    expect(rx.reactionDay(new Date("2026-10-15T12:00:00Z"))).toBe("2026-10-15"); // Thu 08:00 ET
    expect(rx.reactionDay(new Date("2026-10-15T20:30:00Z"))).toBe("2026-10-16"); // Thu 16:30 ET → Fri
    expect(rx.reactionDay(new Date("2026-10-16T21:00:00Z"))).toBe("2026-10-19"); // Fri after close → Mon
    expect(rx.reactionDay(new Date("2026-10-17T15:00:00Z"))).toBe("2026-10-19"); // Saturday → Mon
  });
  it("measures gap, day move and ratio against the typical day", () => {
    const bars: rx.Bar[] = [];
    for (let i = 0; i < 21; i++) {
      const d = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
      const c = i % 2 ? 101 : 100;
      bars.push({ d, o: c, h: c, l: c, c, v: 1000 });
    }
    bars.push({ d: "2026-09-22", o: 104.03, h: 106.5, l: 103, c: 106.05, v: 3000 }); // prev close 100 → gap ≈ +4%, day ≈ +6%
    const r = rx.reactionOn(bars, "2026-09-22")!;
    expect(r.gap).toBeCloseTo(4.03, 1);
    expect(r.dayMove).toBeCloseTo(6.05, 1);
    expect(r.volRatio).toBe(3);
    expect(r.ratio).toBeGreaterThan(5);
    const agg = rx.aggregate([{ dir: 1, r }, { dir: -1, r }]);
    expect(agg.n).toBe(2);
    expect(agg.hitRate).toBe(0.5);
    expect(agg.avgSignedDay).toBe(0);
  });
  it("classifies actions; small target tweaks are not events", () => {
    expect(rx.classifyAction({ action: "up" })?.kind).toBe("up");
    expect(rx.classifyAction({ action: "init", to_grade: "Hold" })).toBeNull();
    expect(rx.classifyAction({ action: "init", to_grade: "Overweight" })?.dir).toBe(1);
    expect(rx.classifyAction({ action: "main", price_target: "103", price_target_from: "100" })).toBeNull();
    expect(rx.classifyAction({ action: "main", price_target: "$90", price_target_from: "100" })?.kind).toBe("ptDown");
  });
});
