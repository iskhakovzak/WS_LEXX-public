import { describe, expect, it } from "vitest";
import { isNotifiableViolationDay, violationDedupKey, violationNotice } from "../notifyEventsCore";

describe("violationDedupKey", () => {
  it("is stable per rule + scan key", () => {
    expect(violationDedupKey(7, "t:42")).toBe("rule_violation:7:t:42");
    expect(violationDedupKey(7, "t:42")).toBe(violationDedupKey(7, "t:42"));
    expect(violationDedupKey(8, "t:42")).not.toBe(violationDedupKey(7, "t:42"));
  });
});

describe("isNotifiableViolationDay", () => {
  it("only today / yesterday notify; history and missing days do not", () => {
    expect(isNotifiableViolationDay("2026-10-16", "2026-10-16")).toBe(true);
    expect(isNotifiableViolationDay("2026-10-17", "2026-10-16")).toBe(true);
    expect(isNotifiableViolationDay("2026-10-15", "2026-10-16")).toBe(false);
    expect(isNotifiableViolationDay(null, "2026-10-16")).toBe(false);
    expect(isNotifiableViolationDay("", "2026-10-16")).toBe(false);
  });
});

describe("violationNotice", () => {
  const one = { ruleName: "Стоп после 3 убытков", message: "4-я сделка после трёх убытков подряд", severity: "medium" };

  it("returns null without items", () => {
    expect(violationNotice("alice", [], false)).toBeNull();
  });

  it("single violation: rule in the title, message as body; staff variant names the trader", () => {
    expect(violationNotice("alice", [one], false)).toEqual({
      title: "Нарушено правило «Стоп после 3 убытков»",
      message: "4-я сделка после трёх убытков подряд",
      severity: "warn",
    });
    expect(violationNotice("alice", [one], true)?.title).toBe("Нарушено правило «Стоп после 3 убытков» · alice");
  });

  it("several violations: count with plural, unique rules listed (max 3), high severity → critical", () => {
    const items = [
      one,
      { ...one, message: "5-я сделка" },
      { ruleName: "Макс. позиция", message: "$60k > $50k", severity: "high" },
      { ruleName: "Без овернайта", message: "перенос", severity: "low" },
      { ruleName: "Чек-лист", message: "без чек-листа", severity: "low" },
    ];
    const n = violationNotice("bob", items, true)!;
    expect(n.title).toBe("5 нарушений правил · bob");
    expect(n.message).toBe("«Стоп после 3 убытков», «Макс. позиция», «Без овернайта» и ещё 1");
    expect(n.severity).toBe("critical");
    expect(violationNotice("bob", items.slice(0, 2), false)!.title).toBe("2 нарушения правил");
  });
});
