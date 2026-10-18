import { describe, expect, it } from "vitest";
import { decodeTagged } from "./use-tagged-trades";

describe("decodeTagged", () => {
  it("expands the columnar payload, -1 → null", () => {
    const rows = decodeTagged({
      n: 2,
      dict: ["AAPL", "win", "vwap, orb", "ORB", "intraday", "loss"],
      id: [7, 9], ticker: [0, 0], date: ["2026-10-01", "2026-10-02"], result: [1, 5], r: [1.5, null],
      pnl: [120.5, null], fees: [1.2, null], tags: [2, -1], setup: [3, 3], horizon: [4, -1],
    });
    expect(rows).toEqual([
      { id: 7, ticker: "AAPL", date: "2026-10-01", result: "win", rMultiple: 1.5, pnl: 120.5, fees: 1.2, tags: "vwap, orb", setup: "ORB", horizon: "intraday" },
      { id: 9, ticker: "AAPL", date: "2026-10-02", result: "loss", rMultiple: null, pnl: null, fees: null, tags: null, setup: "ORB", horizon: null },
    ]);
  });
});
