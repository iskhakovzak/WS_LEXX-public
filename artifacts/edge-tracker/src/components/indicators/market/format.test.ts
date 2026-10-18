import { describe, expect, it } from "vitest";
import { dayLabel, nextWeekday, nyMinutes, sessionInProgress, usd } from "./format";

describe("market format helpers", () => {
  it("session is live only during regular NY hours of the bar's own date", () => {
    expect(sessionInProgress("2026-10-16", "2026-10-16", 10 * 60)).toBe(true);
    expect(sessionInProgress("2026-10-16", "2026-10-16", 23 * 60 + 46)).toBe(false);
    expect(sessionInProgress("2026-10-16", "2026-10-16", 8 * 60)).toBe(false);
    expect(sessionInProgress("2026-10-15", "2026-10-16", 10 * 60)).toBe(false);
  });
  it("nyMinutes follows New York time (EDT in October)", () => {
    expect(nyMinutes(new Date("2026-10-16T14:30:00Z"))).toBe(10 * 60 + 30);
  });
  it("next weekday skips the weekend; labels are Russian", () => {
    expect(nextWeekday("2026-10-16")).toBe("2026-10-19");
    expect(dayLabel("2026-10-19", true)).toBe("пн, 19 окт");
  });
  it("usd keeps cents under $10 and uses a real minus", () => {
    expect(usd(0.41)).toBe("+$0.41");
    expect(usd(-1234.4)).toBe("−$1,234");
  });
});
