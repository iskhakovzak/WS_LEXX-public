import { describe, expect, it } from "vitest";
import { isValidLatin, latinSuggestion, tidyLatin } from "./latin-suggest";

describe("latinSuggestion", () => {
  it("suggests a Latin spelling for Cyrillic names without one", () => {
    expect(latinSuggestion({ name: "Дмитрий К." })).toBe("Dmitriy K.");
    expect(latinSuggestion({ name: "Рахматулло", nameLatin: null })).toBe("Rahmatullo");
    expect(latinSuggestion({ name: "Закир", nameLatin: "" })).toBe("Zakir");
  });
  it("no suggestion when a Latin name is set or the name is already Latin", () => {
    expect(latinSuggestion({ name: "Закир", nameLatin: "Zakir Ishakov" })).toBeNull();
    expect(latinSuggestion({ name: "John" })).toBeNull();
  });
});

describe("isValidLatin / tidyLatin", () => {
  it("mirrors the server rule", () => {
    expect(tidyLatin("  Zakir   Ishakov ")).toBe("Zakir Ishakov");
    expect(isValidLatin("Oʻtkir G'ayratov-Jr.")).toBe(true);
    expect(isValidLatin("")).toBe(true);
    expect(isValidLatin("<b>")).toBe(false);
    expect(isValidLatin("x".repeat(81))).toBe(false);
  });
});
