import { describe, expect, it } from "vitest";
import { isTradeDependentKey } from "@/lib/query-keys";
import { KEYS, POLL, STALE } from "./keys";

describe("trade-dependent keys (stop-gap until meta.deps)", () => {
  it("covers the trade-derived screens that used to be missed", () => {
    for (const key of [
      ["behavior", "report", "Закир", "", ""],
      ["setups-auto", "list", "", "", "", 1],
      ["benchmark", "summary", "30d", 5],
      ["day-report", "Закир", "2026-10-16"],
      ["/api/eod/status", { date: "2026-10-16" }],
      ["/api/events/today", { date: "2026-10-16" }],
      KEYS.openTrades(),
      KEYS.riskMe("2026-10-16"),
    ]) {
      expect(isTradeDependentKey(key), JSON.stringify(key)).toBe(true);
    }
  });

  it("leaves unrelated screens alone", () => {
    expect(isTradeDependentKey(KEYS.watchlist())).toBe(false);
    expect(isTradeDependentKey(["offerings", "2026-10-16"])).toBe(false);
    expect(isTradeDependentKey(["discussions-tickers"])).toBe(false);
  });
});

describe("freshness constants", () => {
  it("are ordered", () => {
    expect(STALE.live).toBeLessThan(STALE.default);
    expect(STALE.default).toBeLessThan(STALE.short);
    expect(STALE.short).toBeLessThan(STALE.long);
    expect(STALE.long).toBeLessThan(STALE.static);
    expect(POLL.live).toBeLessThan(POLL.minute);
  });
});
