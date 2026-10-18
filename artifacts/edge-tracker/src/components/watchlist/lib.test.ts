import { describe, expect, it } from "vitest";
import { isStaleToday, nyStamp } from "./lib";

describe("nyStamp", () => {
  it("formats an instant in New York time", () => {
    expect(nyStamp("2026-10-16T14:00:00Z")).toBe("2026-10-16 10:00"); // EDT = UTC−4
    expect(nyStamp("2026-12-01T21:30:00Z")).toBe("2026-12-01 16:30"); // EST = UTC−5
  });
  it("returns null for empty / invalid input", () => {
    expect(nyStamp(null)).toBeNull();
    expect(nyStamp("nope")).toBeNull();
  });
});

describe("isStaleToday", () => {
  // Preparing Monday 2026-10-19 → the previous session is Friday 2026-10-16.
  const prev = "2026-10-16";
  it("flags rows moved in during or before the previous session", () => {
    expect(isStaleToday("2026-10-16T14:00:00Z", prev)).toBe(true); // Fri 10:00 ET
    expect(isStaleToday("2026-10-14T13:00:00Z", prev)).toBe(true); // Wed
  });
  it("keeps rows moved in after the previous close (evening / weekend prep)", () => {
    expect(isStaleToday("2026-10-16T20:30:00Z", prev)).toBe(false); // Fri 16:30 ET
    expect(isStaleToday("2026-10-17T15:00:00Z", prev)).toBe(false); // Sat
  });
  it("does not judge rows without a timestamp", () => {
    expect(isStaleToday(null, prev)).toBe(false);
    expect(isStaleToday(undefined, prev)).toBe(false);
  });
});
