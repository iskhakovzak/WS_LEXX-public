import { describe, expect, it } from "vitest";
import { netPnl, normResult, num, signedR } from "../tradeMath";
import { TRADE_ROWS, toSnake } from "./fixtures/trade-rows";

describe("tradeMath.num", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["", null],
    ["   ", null],
    ["12.5", 12.5],
    [" 7 ", 7],
    ["abc", null],
    ["Infinity", null],
    [NaN, null],
    [0, 0],
    [-3.25, -3.25],
  ])("num(%j) → %j", (input, expected) => {
    expect(num(input)).toBe(expected);
  });
});

describe("tradeMath.normResult", () => {
  it.each([
    ["win", "win"], ["WIN", "win"], [" Прибыль ", "win"], ["профит", "win"],
    ["loss", "loss"], ["Убыток", "loss"], ["лосс", "loss"],
    ["be", "be"], ["breakeven", "be"], ["безубыток", "be"], ["БУ", "be"],
    ["open", "open"], ["OPEN ", "open"],
    ["", null], [null, null], [undefined, null], ["pending", null], [42, null],
  ])("normResult(%j) → %j", (input, expected) => {
    expect(normResult(input)).toBe(expected);
  });
});

describe("tradeMath.signedR / netPnl (server JS)", () => {
  it.each(TRADE_ROWS.map((r) => [r.id, r.name, r] as const))("#%i %s", (_id, _name, row) => {
    const camel = signedR(row);
    const snake = signedR(toSnake(row));
    if (row.expectR == null) {
      expect(camel).toBeNull();
      expect(snake).toBeNull();
    } else {
      expect(camel).toBeCloseTo(row.expectR, 9);
      expect(snake).toBeCloseTo(row.expectR, 9);
    }
    const net = netPnl(row);
    if (row.expectNet == null) expect(net).toBeNull();
    else expect(net).toBeCloseTo(row.expectNet, 9);
    expect(netPnl(toSnake(row))).toStrictEqual(net);
  });

  it("stored R beats price R, price R beats pnl/risk", () => {
    const base = { result: "win", side: "long", entry: 100, exit: 120, stop: 90, pnl: 50, riskUsd: 100 };
    expect(signedR({ ...base, rMultiple: 0.5 })).toBe(0.5);
    expect(signedR(base)).toBe(2);
    expect(signedR({ ...base, stop: null })).toBe(0.5);
  });

  it("clamps every branch to ±20", () => {
    expect(signedR({ result: "win", rMultiple: 999 })).toBe(20);
    expect(signedR({ result: "loss", rMultiple: 999 })).toBe(-20);
    expect(signedR({ result: "win", pnl: 1e6, riskUsd: 1 })).toBe(20);
    expect(signedR({ result: "loss", pnl: -1e6, riskUsd: 1 })).toBe(-20);
  });

  it("negative riskUsd never divides", () => {
    expect(signedR({ result: "win", pnl: 100, riskUsd: -50 })).toBeNull();
  });

  it("fees sign is ignored: net is always gross − |fees|", () => {
    expect(netPnl({ pnl: 100, fees: 3 })).toBe(97);
    expect(netPnl({ pnl: 100, fees: -3 })).toBe(97);
    expect(netPnl({ pnl: 100, fees: null })).toBe(100);
    expect(netPnl({ pnl: 0, fees: 2 })).toBe(-2);
    expect(netPnl({ pnl: "", fees: 2 })).toBeNull();
  });
});
