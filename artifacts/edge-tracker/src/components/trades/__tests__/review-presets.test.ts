import { describe, expect, it } from "vitest";
import type { Trade } from "@workspace/api-client-react";
import { applyPreset, classifyTags, hasTag, isUnreviewed, presetCounts, revengeIds, toggleTag } from "../review-presets";
import { groupTradeDays } from "@/hooks/use-trades-page";

let nextId = 1;
function trade(p: Partial<Trade> & { open?: string; close?: string }): Trade {
  const { open, close, ...rest } = p;
  return {
    id: nextId++,
    ticker: "AAPL",
    side: "Long",
    date: (open ?? "2026-10-01T10:00:00").slice(0, 10),
    result: "win",
    pnl: 10,
    fees: 1,
    trader: "Ориф",
    contextSnapshot: open ? { openedAt: open, closedAt: close ?? null } : null,
    ...rest,
  } as unknown as Trade;
}

describe("tags", () => {
  it("toggles case-insensitively and empties to null", () => {
    expect(toggleTag(null, "Страх")).toBe("Страх");
    expect(toggleTag("Страх, foo", "страх")).toBe("foo");
    expect(toggleTag("Страх", "Страх")).toBeNull();
    expect(hasTag("a, Тильт", "тильт")).toBe(true);
  });
  it("classifies emotions vs other tags", () => {
    const c = classifyTags("Страх, my-tag");
    expect(c.emotions).toEqual(["Страх"]);
    expect(c.other).toEqual(["my-tag"]);
  });
});

describe("presets (client fallback)", () => {
  it("isUnreviewed ignores open trades and tagged trades", () => {
    expect(isUnreviewed(trade({}))).toBe(true);
    expect(isUnreviewed(trade({ result: "open" }))).toBe(false);
    expect(isUnreviewed(trade({ tags: "Страх" }))).toBe(false);
    expect(isUnreviewed(trade({ setup: "ORB" }))).toBe(false);
  });

  it("scalp / fees / best / worst", () => {
    const scalp = trade({ open: "2026-10-01T10:00:00", close: "2026-10-01T10:01:30" });
    const slow = trade({ open: "2026-10-01T11:00:00", close: "2026-10-01T11:30:00", pnl: -20, fees: 2, result: "loss" });
    const feesHeavy = trade({ pnl: 4, fees: 3 });
    const list = [scalp, slow, feesHeavy];
    expect(applyPreset(list, "scalp").map((t) => t.id)).toEqual([scalp.id]);
    expect(applyPreset(list, "fees").map((t) => t.id)).toEqual([feesHeavy.id]);
    expect(applyPreset(list, "worst").map((t) => t.id)).toEqual([slow.id]);
    expect(applyPreset(list, "best").map((t) => t.id)).toEqual([scalp.id, feesHeavy.id]);
  });

  it("revenge: entry < 10 min after a losing close, same trader and day", () => {
    const loss = trade({ open: "2026-10-01T10:00:00", close: "2026-10-01T10:05:00", pnl: -50, result: "loss" });
    const quick = trade({ open: "2026-10-01T10:09:00", close: "2026-10-01T10:20:00" });
    const late = trade({ open: "2026-10-01T10:40:00", close: "2026-10-01T10:45:00" });
    const otherTrader = trade({ open: "2026-10-01T10:06:00", close: "2026-10-01T10:07:00", trader: "Другой" });
    const ids = revengeIds([late, quick, loss, otherTrader]);
    expect([...ids]).toEqual([quick.id]);
    expect(presetCounts([loss, quick, late, otherTrader]).revenge).toBe(1);
  });
});

describe("groupTradeDays", () => {
  it("groups newest-first with net, fees and an intraday sequence", () => {
    const a = trade({ open: "2026-10-02T09:45:00", close: "2026-10-02T09:50:00", pnl: 30, fees: 5 });
    const b = trade({ open: "2026-10-02T09:31:00", close: "2026-10-02T09:40:00", pnl: -10, fees: 5, result: "loss" });
    const c = trade({ open: "2026-10-01T10:00:00", close: "2026-10-01T10:10:00", pnl: 8, fees: 1 });
    const { days, byDay } = groupTradeDays([a, b, c]);
    expect(days.map((d) => d.date)).toEqual(["2026-10-02", "2026-10-01"]);
    const d0 = days[0];
    expect(d0.count).toBe(2);
    expect(d0.net).toBeCloseTo(10);
    expect(d0.fees).toBeCloseTo(10);
    expect(d0.seq).toEqual([-15, 25]);
    expect(byDay.get("2026-10-02")!.map((t) => t.id)).toEqual([b.id, a.id]);
  });
});
