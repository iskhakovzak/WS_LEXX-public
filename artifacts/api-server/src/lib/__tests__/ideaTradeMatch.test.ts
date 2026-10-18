import { describe, it, expect } from "vitest";
import { assignIdeaTrades, defaultValidUntil, ideaWindow, type IdeaForMatch } from "../ideaTradeMatch";

const base: IdeaForMatch = {
  id: 1, trader: "Максим Р.", ticker: "msft", side: "Long", publishedAt: "2026-10-14T12:50:00Z", createdAt: "2026-10-14T12:00:00Z",
  ideaDate: "2026-10-14", validUntil: null, horizon: "intraday",
};

describe("ideaWindow", () => {
  it("intraday: publish moment → same NY session; ticker upper, side lower", () => {
    expect(ideaWindow(base)).toEqual({ id: 1, trader: "Максим Р.", ticker: "MSFT", side: "long", startAt: "2026-10-14T12:50:00.000Z", startDay: "2026-10-14", endDay: "2026-10-14" });
  });
  it("overnight / swing extend by sessions, skipping the weekend", () => {
    expect(ideaWindow({ ...base, publishedAt: "2026-10-16T13:00:00Z", horizon: "overnight" })!.endDay).toBe("2026-10-19");
    expect(defaultValidUntil("swing", "2026-10-14")).toBe("2026-10-28");
  });
  it("explicit valid_until wins; one before the start collapses to the start day", () => {
    expect(ideaWindow({ ...base, validUntil: "2026-10-20" })!.endDay).toBe("2026-10-20");
    expect(ideaWindow({ ...base, validUntil: "2026-10-01" })!.endDay).toBe("2026-10-14");
  });
  it("falls back to created_at; NY date of a late-evening UTC publish is the previous day", () => {
    expect(ideaWindow({ ...base, publishedAt: null })!.startAt).toBe("2026-10-14T12:00:00.000Z");
    expect(ideaWindow({ ...base, publishedAt: "2026-10-15T02:00:00Z" })!.startDay).toBe("2026-10-14");
  });
  it("no side / no author / no start → not matchable", () => {
    expect(ideaWindow({ ...base, side: "" })).toBeNull();
    expect(ideaWindow({ ...base, trader: "" })).toBeNull();
    expect(ideaWindow({ ...base, publishedAt: null, createdAt: null })).toBeNull();
  });
});

describe("assignIdeaTrades", () => {
  it("each idea takes its nearest trade", () => {
    const m = assignIdeaTrades([
      { ideaId: 1, tradeId: 10, distanceMs: 5000 },
      { ideaId: 1, tradeId: 11, distanceMs: 1000 },
    ]);
    expect([...m]).toEqual([[1, 11]]);
  });
  it("a trade serves one idea: the nearer idea wins, the other falls back to its next trade", () => {
    const m = assignIdeaTrades([
      { ideaId: 1, tradeId: 10, distanceMs: 2000 },
      { ideaId: 2, tradeId: 10, distanceMs: 500 },
      { ideaId: 1, tradeId: 12, distanceMs: 9000 },
    ]);
    expect(m.get(2)).toBe(10);
    expect(m.get(1)).toBe(12);
  });
  it("is deterministic regardless of input order (idempotent reruns)", () => {
    const c = [
      { ideaId: 3, tradeId: 30, distanceMs: 100 },
      { ideaId: 4, tradeId: 30, distanceMs: 100 },
      { ideaId: 4, tradeId: 31, distanceMs: 200 },
    ];
    expect([...assignIdeaTrades(c)]).toEqual([...assignIdeaTrades([...c].reverse())]);
    expect(assignIdeaTrades(c).get(3)).toBe(30);
  });
});
