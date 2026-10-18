import { describe, it, expect } from "vitest";
import { entryBracket, fakeClock, hhmm, keyAction, maxQtyFor, nextSpeed, parsePrice, positionAfter, presetQty, roundPrice, stepErrorOf, swingIndex } from "./model";

describe("sim model — orders and bracket", () => {
  it("position after an order mirrors the server", () => {
    expect(positionAfter(0, "buy", 100)).toBe(100);
    expect(positionAfter(100, "sell", 250)).toBe(-150);
    expect(positionAfter(-40, "flat", 0)).toBe(0);
  });

  it("sends a 1R stop (and 2R target) only when a position opens or flips", () => {
    const o = { autoStop: true, autoTarget: true };
    expect(entryBracket(0, 100, 50, 0.5, o)).toEqual({ stop: 49.5, target: 51 });
    expect(entryBracket(100, -100, 50, 0.5, o)).toEqual({ stop: 50.5, target: 49 });
    expect(entryBracket(100, 200, 50, 0.5, o)).toBeUndefined(); // add: keep the open bracket
    expect(entryBracket(100, 0, 50, 0.5, o)).toBeUndefined();
    expect(entryBracket(0, 100, 50, 0.5, { autoStop: false, autoTarget: false })).toBeUndefined();
    expect(entryBracket(0, 100, 0.8, 0.01234, { autoStop: true, autoTarget: false })).toEqual({ stop: 0.7877, target: null });
  });

  it("sizes, prices and buying power", () => {
    expect(presetQty(30, "half")).toBe(15);
    expect(presetQty(5, "half")).toBe(3);
    expect(presetQty(30, "double")).toBe(60);
    expect(maxQtyFor(100_000, 358.4)).toBe(279);
    expect(roundPrice(12.3456)).toBe(12.35);
    expect(parsePrice("12,5")).toBe(12.5);
    expect(parsePrice(" ")).toBeNull();
    expect(parsePrice("-1")).toBeNull();
  });
});

describe("sim model — keys, speed, clock, errors", () => {
  it("maps physical keys (any layout) and ignores modified ones", () => {
    expect(keyAction({ code: "KeyB", key: "и" })).toBe("buy");
    expect(keyAction({ code: "KeyX", key: "x" })).toBe("flat");
    expect(keyAction({ code: "Space", key: " " })).toBe("next");
    expect(keyAction({ code: "BracketRight", key: "]" })).toBe("faster");
    expect(keyAction({ code: "KeyS", key: "s", ctrlKey: true })).toBeNull();
    expect(keyAction({ code: "KeyQ", key: "q" })).toBeNull();
  });

  it("speed steps stay within the list", () => {
    expect(nextSpeed(16, 1)).toBe(16);
    expect(nextSpeed(1, -1)).toBe(1);
    expect(nextSpeed(4, 1)).toBe(8);
  });

  it("reads the fake clock the server sends (New York wall time on fake days)", () => {
    const playDay930 = Date.UTC(2001, 0, 10, 14, 30) / 1000; // 9:30 EST
    expect(fakeClock(playDay930)).toEqual({ day: 0, min: 570 });
    expect(fakeClock(playDay930 - 86400 + 6 * 3600)).toEqual({ day: -1, min: 930 });
    expect(hhmm(570)).toBe("09:30");
    expect(swingIndex(Date.UTC(2001, 0, 1) / 1000 + 5 * 86400)).toBe(5);
  });

  it("turns the server's validation details into a reason", () => {
    expect(stepErrorOf({ body: { details: { reason: "buyingPower", maxQty: 279 } } })).toEqual({ reason: "buyingPower", maxQty: 279 });
    expect(stepErrorOf({ body: { details: { reason: "stop" } } })).toEqual({ reason: "stop" });
    expect(stepErrorOf(new Error("x"))).toEqual({ reason: "generic" });
  });
});
