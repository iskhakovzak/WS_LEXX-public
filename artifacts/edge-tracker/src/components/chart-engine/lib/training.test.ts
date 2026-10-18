import { describe, expect, it } from "vitest";
import { computeExitScore, scoreVerdict } from "./training";

describe("training exit score", () => {
  const closes = [10, 10, 11, 12, 13, 12, 11, 10.5];

  it("scores a long exit between the worst and best close of the window", () => {
    // window: entry 1 … max(user 4, exit 6) → closes 10..13
    expect(computeExitScore(closes, 1, 4, 6, "long", 13)).toBe(100);
    expect(computeExitScore(closes, 1, 6, 6, "long", 11)).toBe(33);
    expect(computeExitScore(closes, 1, 1, 6, "long", 10)).toBe(0);
  });

  it("inverts for shorts", () => {
    expect(computeExitScore(closes, 1, 1, 6, "short", 10)).toBe(100);
    expect(computeExitScore(closes, 1, 4, 6, "short", 13)).toBe(0);
  });

  it("returns null when there is nothing to compare", () => {
    expect(computeExitScore(closes, null, 3, 6, "long", 12)).toBeNull();
    expect(computeExitScore([5, 5, 5], 0, 2, 2, "long", 5)).toBeNull();
    expect(computeExitScore(closes, 5, 2, null, "long", 11)).toBeNull();
  });

  it("names the verdict", () => {
    expect(scoreVerdict(90)?.tone).toBe("up");
    expect(scoreVerdict(50)?.label).toBe("средне");
    expect(scoreVerdict(5)?.tone).toBe("down");
    expect(scoreVerdict(null)).toBeNull();
  });
});
