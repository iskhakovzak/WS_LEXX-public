import { describe, expect, it } from "vitest";
import { bucketOf, enrichIdea, type TradeIdea } from "../idea-metrics";

const idea = (id: number, over: Partial<TradeIdea> = {}): TradeIdea => ({
  id, ticker: "AAA", side: "Long", setup: null, score: 60, setupQuality: null, status: "published", trader: "T",
  ideaDate: "2026-10-01", createdAt: "2026-10-01T12:00:00Z", publishedAt: "2026-10-01T12:00:00Z", convertedTradeId: null,
  reactions: [], linkedTrade: null, ...over,
});

describe("enrichIdea — price basis", () => {
  it("target first = win at planned R, stop first = −1R, tracked without hit = open", () => {
    const a = enrichIdea(idea(1), { basis: "price", track: { hit: "target", plannedR: 2.5 } });
    const b = enrichIdea(idea(2), { basis: "price", track: { hit: "final_target", plannedR: 1.8 } });
    const c = enrichIdea(idea(3), { basis: "price", track: { hit: "stop", plannedR: 3 } });
    const d = enrichIdea(idea(4), { basis: "price", track: { hit: null, plannedR: 2 } });
    expect([a.outcome, a.r]).toEqual(["win", 2.5]);
    expect([b.outcome, b.r]).toEqual(["win", 1.8]);
    expect([c.outcome, c.r]).toEqual(["loss", -1]);
    expect([d.outcome, d.r]).toEqual(["open", null]);
    const bk = bucketOf([a, b, c, d]);
    expect(bk.hitRate).toBeCloseTo(2 / 3);
    expect(bk.sumR).toBeCloseTo(3.3);
    expect(bk.open).toBe(1);
  });

  it("drafts and untracked ideas have no outcome; money stays null", () => {
    expect(enrichIdea(idea(5, { status: "draft" }), { basis: "price", track: { hit: "target", plannedR: 2 } }).outcome).toBe("none");
    const u = enrichIdea(idea(6), { basis: "price", track: null });
    expect([u.outcome, u.r, u.pnl]).toEqual(["none", null, null]);
  });

  it("trade basis is unchanged by default", () => {
    const t = enrichIdea(idea(7, { linkedTrade: { id: 1, result: "win", pnl: 100, rMultiple: 2, date: "2026-10-02", r: 2, net: 95, outcome: "win" } }));
    expect([t.outcome, t.r, t.pnl, t.converted]).toEqual(["win", 2, 95, true]);
  });
});
