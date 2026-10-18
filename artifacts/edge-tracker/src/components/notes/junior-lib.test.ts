import { describe, expect, it } from "vitest";
import {
  addSnippet, appendSnippet, byAttention, canReviewTrader, daysSince, draftDiffers, nextUnanswered, reviewKeyAction,
  type ReviewerInfo,
} from "./junior-lib";

describe("canReviewTrader", () => {
  const desk: ReviewerInfo = { kind: "desk", via: "desk", traders: null, mine: [], money: true };
  const mentor: ReviewerInfo = { kind: "scoped", via: "mentor", traders: ["Умид"], mine: ["Умид"], money: false };
  const none: ReviewerInfo = { kind: "none", via: null, traders: null, mine: [], money: false };

  it("desk reviews anyone but self; mentor only mentees; others nobody", () => {
    expect(canReviewTrader(desk, "Умид", "Антон")).toBe(true);
    expect(canReviewTrader(desk, "Антон", "Антон")).toBe(false);
    expect(canReviewTrader(mentor, "Умид", "Артур")).toBe(true);
    expect(canReviewTrader(mentor, "Закир", "Артур")).toBe(false);
    expect(canReviewTrader(none, "Умид", "Закир")).toBe(false);
    expect(canReviewTrader(null, "Умид", "Закир")).toBe(false);
  });
});

describe("snippets", () => {
  it("appendSnippet puts the reply on its own line and never duplicates it", () => {
    expect(appendSnippet("", "Хорошо.")).toBe("Хорошо.");
    expect(appendSnippet("Разбор ок", "Хорошо.")).toBe("Разбор ок\nХорошо.");
    expect(appendSnippet("Разбор ок  ", "Хорошо.")).toBe("Разбор ок\nХорошо.");
    expect(appendSnippet("Разбор ок\n", "Хорошо.")).toBe("Разбор ок\nХорошо.");
    expect(appendSnippet("Хорошо.", "Хорошо.")).toBe("Хорошо.");
    expect(appendSnippet("abc", "  ")).toBe("abc");
  });

  it("addSnippet dedupes, trims, puts newest first and caps at 10", () => {
    expect(addSnippet(["a", "b"], " b ")).toEqual(["b", "a"]);
    expect(addSnippet(["a"], "   ")).toEqual(["a"]);
    const many = Array.from({ length: 10 }, (_, i) => `s${i}`);
    expect(addSnippet(many, "new")).toHaveLength(10);
    expect(addSnippet(many, "new")[0]).toBe("new");
  });
});

describe("draftDiffers", () => {
  it("only keeps drafts that differ from the saved review", () => {
    expect(draftDiffers({ feedback: "ok", score: 4 }, { curator_feedback: "ok", curator_score: 4 })).toBe(false);
    expect(draftDiffers({ feedback: " ok ", score: 4 }, { curator_feedback: "ok", curator_score: 4 })).toBe(false);
    expect(draftDiffers({ feedback: "ok!", score: 4 }, { curator_feedback: "ok", curator_score: 4 })).toBe(true);
    expect(draftDiffers({ feedback: "", score: 3 }, {})).toBe(true);
    expect(draftDiffers({ feedback: "", score: null }, { curator_feedback: null, curator_score: null })).toBe(false);
  });
});

describe("reviewKeyAction", () => {
  it("navigates with J/K, arrows and Russian layout outside fields", () => {
    expect(reviewKeyAction({ key: "j" }, false)).toEqual({ type: "next" });
    expect(reviewKeyAction({ key: "о" }, false)).toEqual({ type: "next" });
    expect(reviewKeyAction({ key: "ArrowRight" }, false)).toEqual({ type: "next" });
    expect(reviewKeyAction({ key: "K" }, false)).toEqual({ type: "prev" });
    expect(reviewKeyAction({ key: "ArrowLeft" }, false)).toEqual({ type: "prev" });
    expect(reviewKeyAction({ key: "r" }, false)).toEqual({ type: "focus" });
    expect(reviewKeyAction({ key: "к" }, false)).toEqual({ type: "focus" });
  });

  it("digits score outside fields, Alt+digit anywhere, 0 clears", () => {
    expect(reviewKeyAction({ key: "4", code: "Digit4" }, false)).toEqual({ type: "score", value: 4 });
    expect(reviewKeyAction({ key: "0", code: "Digit0" }, false)).toEqual({ type: "score", value: null });
    expect(reviewKeyAction({ key: "4", code: "Digit4" }, true)).toBeNull();
    expect(reviewKeyAction({ key: "¢", code: "Digit4", altKey: true }, true)).toEqual({ type: "score", value: 4 });
    expect(reviewKeyAction({ key: "7", code: "Digit7" }, false)).toBeNull();
  });

  it("Ctrl/⌘+Enter sends from anywhere; typing in a field is left alone", () => {
    expect(reviewKeyAction({ key: "Enter", ctrlKey: true }, true)).toEqual({ type: "send" });
    expect(reviewKeyAction({ key: "Enter", metaKey: true }, false)).toEqual({ type: "send" });
    expect(reviewKeyAction({ key: "j" }, true)).toBeNull();
    expect(reviewKeyAction({ key: "j", ctrlKey: true }, false)).toBeNull();
  });
});

describe("nextUnanswered", () => {
  const list = [
    { id: 1, reviewed_at: null },
    { id: 2, reviewed_at: "x" },
    { id: 3, reviewed_at: null },
    { id: 4, reviewed_at: "x" },
  ];
  it("skips answered notes and wraps around", () => {
    expect(nextUnanswered(list, 1)?.id).toBe(3);
    expect(nextUnanswered(list, 3)?.id).toBe(1);
    expect(nextUnanswered(list, 4)?.id).toBe(1);
  });
  it("null when nothing else needs an answer", () => {
    expect(nextUnanswered([{ id: 1, reviewed_at: null }], 1)).toBeNull();
    expect(nextUnanswered([], 1)).toBeNull();
  });
});

describe("byAttention / daysSince", () => {
  it("sorts by priority, then name", () => {
    const rows = [{ trader: "Умид", priority: 0 }, { trader: "Закир", priority: 40 }, { trader: "Артур", priority: 0 }];
    expect(byAttention(rows).map((r) => r.trader)).toEqual(["Закир", "Артур", "Умид"]);
  });
  it("counts whole days", () => {
    expect(daysSince("2026-10-14", "2026-10-17")).toBe(3);
    expect(daysSince("2026-10-17", "2026-10-17")).toBe(0);
    expect(daysSince("2026-10-18", "2026-10-17")).toBe(0);
  });
});
