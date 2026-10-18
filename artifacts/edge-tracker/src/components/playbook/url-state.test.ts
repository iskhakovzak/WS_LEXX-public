import { describe, expect, it } from "vitest";
import { patchSearch } from "./url-state";

describe("playbook url state", () => {
  it("sets, replaces and removes params, keeping the rest", () => {
    expect(patchSearch("?id=5&tab=stats", { space: "mine" })).toBe("id=5&tab=stats&space=mine");
    expect(patchSearch("id=5&space=mine", { space: "office" })).toBe("id=5&space=office");
    expect(patchSearch("id=5&space=mine", { space: null })).toBe("id=5");
    expect(patchSearch("", { q: "" })).toBe("");
  });
  it("drops a param equal to its default", () => {
    expect(patchSearch("view=gallery&gt=2", { view: "library", gt: "1" }, { view: "library", gt: "1" })).toBe("");
    expect(patchSearch("", { gt: "3" }, { gt: "1" })).toBe("gt=3");
  });
  it("encodes Cyrillic values", () => {
    const s = patchSearch("", { trader: "Ориф" });
    expect(new URLSearchParams(s).get("trader")).toBe("Ориф");
  });
});
