import { describe, it, expect } from "vitest";
import { canModifyOwned, createdByOf } from "../ownership";

describe("canModifyOwned", () => {
  it("staff may modify any row, including legacy rows without an author", () => {
    expect(canModifyOwned(null, "Ориф", true)).toBe(true);
    expect(canModifyOwned("Закир", "Ориф", true)).toBe(true);
  });
  it("a member may modify only rows they created", () => {
    expect(canModifyOwned("Закир", "Закир", false)).toBe(true);
    expect(canModifyOwned("Артур", "Закир", false)).toBe(false);
  });
  it("legacy rows (no author) are staff-only", () => {
    expect(canModifyOwned(null, "Закир", false)).toBe(false);
    expect(canModifyOwned("", "Закир", false)).toBe(false);
    expect(canModifyOwned("   ", "Закир", false)).toBe(false);
  });
  it("guests / signed-out viewers never", () => {
    expect(canModifyOwned("Закир", null, false)).toBe(false);
    expect(canModifyOwned(null, null, true)).toBe(false);
  });
});

describe("createdByOf", () => {
  it("reads the author off untyped rows", () => {
    expect(createdByOf({ createdBy: "Закир" })).toBe("Закир");
    expect(createdByOf({ createdBy: null })).toBeNull();
    expect(createdByOf({})).toBeNull();
    expect(createdByOf(null)).toBeNull();
  });
});
