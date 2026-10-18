import { describe, expect, it } from "vitest";
import {
  ARCHIVE_REASON_LABEL,
  activeViolationSql,
  archiveReasonLabel,
  archiveWhereSql,
  hasHumanInput,
  isArchiveReason,
  parseArchiveMode,
  planStaleViolations,
  reportArchiveSql,
  staleAction,
} from "../violationArchive";

describe("hasHumanInput", () => {
  it("is false for a purely derived violation", () => {
    expect(hasHumanInput({})).toBe(false);
    expect(hasHumanInput({ comment: null, acknowledged_at: null, resolution: null, consequence: null })).toBe(false);
  });

  it("ignores blank strings", () => {
    expect(hasHumanInput({ comment: "   ", consequence: "" })).toBe(false);
  });

  it.each([
    ["comment", { comment: "взял сверх лимита" }],
    ["acknowledgement", { acknowledged_at: new Date("2026-10-14T15:00:00Z") }],
    ["acknowledged_by only", { acknowledged_by: "alice" }],
    ["curator resolution", { resolution: "dismissed" }],
    ["resolved_at", { resolved_at: "2026-10-14T15:00:00Z" }],
    ["resolved_by", { resolved_by: "curator" }],
    ["consequence", { consequence: "размер −50% на неделю" }],
  ])("is true with %s", (_label, row) => {
    expect(hasHumanInput(row)).toBe(true);
  });
});

describe("staleAction (rescan no longer produces the violation)", () => {
  it("deletes a violation nobody touched", () => {
    expect(staleAction({ comment: null, archived_at: null })).toBe("delete");
  });

  it("deletes even an already archived one without human input", () => {
    expect(staleAction({ archived_at: new Date() })).toBe("delete");
  });

  it("archives an active violation with a comment / acknowledgement / review", () => {
    expect(staleAction({ comment: "почему", archived_at: null })).toBe("archive");
    expect(staleAction({ acknowledged_at: new Date() })).toBe("archive");
    expect(staleAction({ resolution: "upheld", resolved_at: new Date() })).toBe("archive");
  });

  it("keeps an already archived violation with human input as is", () => {
    expect(staleAction({ comment: "почему", archived_at: new Date() })).toBe("keep");
  });
});

describe("planStaleViolations", () => {
  it("splits rows into delete / archive ids and skips keepers and bad ids", () => {
    const plan = planStaleViolations([
      { id: 1 },
      { id: "2", comment: "разобрали на 1:1" },
      { id: 3, acknowledged_at: new Date(), archived_at: new Date() },
      { id: 4, comment: "  " },
      { id: "x", comment: "bad id" },
      { id: 5, consequence: "стоп-день" },
    ]);
    expect(plan.deleteIds).toEqual([1, 4]);
    expect(plan.archiveIds).toEqual([2, 5]);
  });

  it("is empty for no rows", () => {
    expect(planStaleViolations([])).toEqual({ deleteIds: [], archiveIds: [] });
  });
});

describe("archive reasons", () => {
  it("recognises only the three reasons", () => {
    expect(isArchiveReason("rule_disabled")).toBe(true);
    expect(isArchiveReason("rule_deleted")).toBe(true);
    expect(isArchiveReason("stale")).toBe(true);
    expect(isArchiveReason("other")).toBe(false);
    expect(isArchiveReason(null)).toBe(false);
  });

  it("has a Russian label per reason", () => {
    expect(ARCHIVE_REASON_LABEL.rule_disabled).toBe("правило выключено");
    expect(ARCHIVE_REASON_LABEL.rule_deleted).toBe("правило удалено");
    expect(archiveReasonLabel("stale")).toBe("неактуально");
    expect(archiveReasonLabel(null)).toBeNull();
    expect(archiveReasonLabel("bogus")).toBeNull();
  });
});

describe("parseArchiveMode", () => {
  it("defaults to active rows only", () => {
    expect(parseArchiveMode({})).toBe("active");
    expect(parseArchiveMode({ include: "trades" })).toBe("active");
  });

  it("include=archived returns active + archived", () => {
    expect(parseArchiveMode({ include: "archived" })).toBe("all");
    expect(parseArchiveMode({ include: "trades, Archived" })).toBe("all");
    expect(parseArchiveMode({ archived: "include" })).toBe("all");
  });

  it("archived=only returns only archived rows", () => {
    expect(parseArchiveMode({ archived: "only" })).toBe("archived");
    expect(parseArchiveMode({ archived: "1", include: "archived" })).toBe("archived");
  });
});

describe("SQL predicates", () => {
  it("activeViolationSql", () => {
    expect(activeViolationSql()).toBe("archived_at IS NULL");
    expect(activeViolationSql("v")).toBe("v.archived_at IS NULL");
  });

  it("archiveWhereSql: default hides archived rows and deleted rules", () => {
    const sql = archiveWhereSql("active");
    expect(sql).toContain("v.archived_at IS NULL");
    expect(sql).toContain("r.deleted_at IS NULL");
    expect(sql).not.toContain("rule_disabled");
  });

  it("archiveWhereSql: rule history also shows a disabled rule's violations", () => {
    expect(archiveWhereSql("active", { ruleHistory: true })).toContain("v.archived_reason = 'rule_disabled'");
  });

  it("archiveWhereSql: archive modes", () => {
    expect(archiveWhereSql("all")).toBe("TRUE");
    expect(archiveWhereSql("archived", { v: "x" })).toBe("x.archived_at IS NOT NULL");
  });

  it("reportArchiveSql keeps disabled / deleted rules' violations but not stale ones", () => {
    const sql = reportArchiveSql("v");
    expect(sql).toContain("v.archived_at IS NULL");
    expect(sql).toContain("'rule_disabled', 'rule_deleted'");
    expect(sql).not.toContain("stale");
  });
});
