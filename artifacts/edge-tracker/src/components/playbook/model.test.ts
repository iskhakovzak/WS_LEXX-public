import { describe, expect, it } from "vitest";
import { blankForm, entryToForm, formToBody, searchHaystack, type PlaybookEntry } from "./model";

const entry = (over: Partial<PlaybookEntry> = {}): PlaybookEntry => ({
  id: 1, name: "Gap and Go", folder: "Гэпы", setupType: null, conditions: null, checklist: null, checklistItems: null, notes: null,
  confidenceLevel: 70, screenshotUrl: null, screenshotNotes: null, tags: null, sourceType: null, sourceId: null, createdAt: "2026-10-01",
  parentId: null, ticker: null, marketCap: null, float: null, adv: null, atr: null, relativeVolume: null, beta: null, shortInterest: null,
  sector: null, longName: null, reviewed: false, reviewedBy: null, reviewedAt: null, ...over,
});

describe("playbook form ↔ structured card", () => {
  it("round-trips the structured fields, horizon and time of day", () => {
    const f = entryToForm(entry({ contextText: "Гэп > 4%", stopText: "Под лоу", horizon: "swing", timeOfDay: "Премаркет" }));
    expect(f.contextText).toBe("Гэп > 4%");
    expect(f.entryText).toBe("");
    const body = formToBody(f, f.folder, "Закир") as Record<string, unknown>;
    expect(body.contextText).toBe("Гэп > 4%");
    expect(body.stopText).toBe("Под лоу");
    expect(body.entryText).toBeNull();
    expect(body.horizon).toBe("swing");
    expect(body.timeOfDay).toBe("Премаркет");
  });

  it("sends empty structured fields as null and trims them", () => {
    const body = formToBody({ ...blankForm(), name: "X", triggerText: "  откат к VWAP  " }, null, "Закир") as Record<string, unknown>;
    expect(body.triggerText).toBe("откат к VWAP");
    expect(body.contextText).toBeNull();
    expect(body.horizon).toBeNull();
  });
});

describe("searchHaystack", () => {
  it("finds a setup by text written only in the structured card", () => {
    const e = entry({ triggerText: "Откат к VWAP на падающем объёме" });
    expect(searchHaystack(e)).toContain("vwap");
    expect(searchHaystack(e)).toContain("гэпы");
  });

  it("caches per row object (a new object is rebuilt)", () => {
    const a = entry({ notes: "старое" });
    expect(searchHaystack(a)).toContain("старое");
    const b = { ...a, notes: "новое" };
    expect(searchHaystack(b)).toContain("новое");
    expect(searchHaystack(b)).not.toContain("старое");
  });
});
