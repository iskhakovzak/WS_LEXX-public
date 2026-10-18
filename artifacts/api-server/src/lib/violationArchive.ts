/**
 * Rule-violation archive policy — pure helpers (no DB).
 *
 * Violations carry human input (trader acknowledgement + comment, curator resolution + consequence), so they are never
 * dropped together with that input:
 * - disabling a rule archives its violations with reason `rule_disabled` (re-enabling brings them back as active);
 * - soft-deleting a rule archives them with reason `rule_deleted` (restoring the rule brings them back);
 * - a violation a rescan no longer produces (the trade was edited, a self-check mark was cleared) is deleted only when
 *   nobody wrote anything on it; otherwise it is archived with reason `stale`.
 * Archived rows live in rule_violations itself (archived_at / archived_reason). Every count, score and default list
 * reads active rows only (`archived_at IS NULL`, see activeViolationSql).
 */
import { reviewT } from "../i18n/ns";
import type { Lang } from "../i18n";

export const ARCHIVE_REASONS = ["rule_disabled", "rule_deleted", "stale"] as const;
export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

export function isArchiveReason(v: unknown): v is ArchiveReason {
  return typeof v === "string" && (ARCHIVE_REASONS as readonly string[]).includes(v);
}

/** Human-facing label in `lang` (review namespace `archive.*`). */
export function archiveReasonText(reason: ArchiveReason, lang: Lang = "ru"): string {
  return reviewT.tFor(lang)(`archive.${reason}`);
}
/** RU labels (kept for older imports). */
export const ARCHIVE_REASON_LABEL: Record<ArchiveReason, string> = {
  rule_disabled: archiveReasonText("rule_disabled"),
  rule_deleted: archiveReasonText("rule_deleted"),
  stale: archiveReasonText("stale"),
};

/** Label for a stored archived_reason; null when the row is not archived / the reason is unknown. */
export function archiveReasonLabel(v: unknown, lang: Lang = "ru"): string | null {
  return isArchiveReason(v) ? archiveReasonText(v, lang) : null;
}

/** The rule_violations columns that hold human input (trader / curator). */
export const HUMAN_INPUT_COLUMNS = [
  "comment",
  "acknowledged_at",
  "acknowledged_by",
  "resolution",
  "resolved_at",
  "resolved_by",
  "consequence",
] as const;

export type HumanInputRow = Partial<Record<(typeof HUMAN_INPUT_COLUMNS)[number], unknown>>;

function present(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

/** Did a trader or curator write anything on this violation (comment, acknowledgement, review, consequence)? */
export function hasHumanInput(row: HumanInputRow): boolean {
  return HUMAN_INPUT_COLUMNS.some((c) => present(row[c]));
}

export type StaleAction = "delete" | "archive" | "keep";

/**
 * What to do with a violation the engine no longer produces:
 *   no human input → delete (it is purely derived; a later rescan recreates it if it applies again);
 *   human input, still active → archive as `stale`;
 *   human input, already archived → keep as is.
 */
export function staleAction(row: HumanInputRow & { archived_at?: unknown }): StaleAction {
  if (!hasHumanInput(row)) return "delete";
  return row.archived_at != null ? "keep" : "archive";
}

export function planStaleViolations<R extends HumanInputRow & { id: number | string; archived_at?: unknown }>(
  rows: readonly R[],
): { deleteIds: number[]; archiveIds: number[] } {
  const deleteIds: number[] = [];
  const archiveIds: number[] = [];
  for (const r of rows) {
    const id = Number(r.id);
    if (!Number.isInteger(id)) continue;
    const a = staleAction(r);
    if (a === "delete") deleteIds.push(id);
    else if (a === "archive") archiveIds.push(id);
  }
  return { deleteIds, archiveIds };
}

/** SQL predicate: the violation is active (not archived). `alias` — table alias, e.g. "v". */
export function activeViolationSql(alias?: string): string {
  return `${alias ? `${alias}.` : ""}archived_at IS NULL`;
}

/** Columns the stale planner needs (SELECT list). */
export const STALE_PLAN_COLUMNS = ["id", "archived_at", ...HUMAN_INPUT_COLUMNS].join(", ");

/**
 * Archive visibility of the violations list (GET /rule-violations):
 *   active   — default: active rows only;
 *   all      — include=archived: active + archived;
 *   archived — archived=only: archived rows only.
 */
export type ArchiveMode = "active" | "all" | "archived";

export function parseArchiveMode(q: Record<string, unknown>): ArchiveMode {
  const archived = typeof q.archived === "string" ? q.archived.toLowerCase() : "";
  if (archived === "only" || archived === "1" || archived === "true") return "archived";
  const include = typeof q.include === "string" ? q.include.toLowerCase().split(",").map((s) => s.trim()) : [];
  if (include.includes("archived") || archived === "include" || archived === "all") return "all";
  return "active";
}

/**
 * WHERE fragment for the list. Deleted rules' violations (archived `rule_deleted`) appear only when the archive is
 * requested. Rule history (a ruleId filter) shows `rule_disabled` rows by default too — with the «правило выключено» badge.
 */
export function archiveWhereSql(mode: ArchiveMode, opts: { v?: string; r?: string; ruleHistory?: boolean } = {}): string {
  const v = opts.v ?? "v";
  const r = opts.r ?? "r";
  if (mode === "archived") return `${v}.archived_at IS NOT NULL`;
  if (mode === "all") return "TRUE";
  const notDeletedRule = `(${r}.id IS NULL OR ${r}.deleted_at IS NULL)`;
  if (opts.ruleHistory) return `(${v}.archived_at IS NULL OR ${v}.archived_reason = 'rule_disabled') AND ${notDeletedRule}`;
  return `${v}.archived_at IS NULL AND ${notDeletedRule}`;
}

/**
 * Weekly / period reports: a violation of a deleted or disabled rule still belongs to the history of a past period
 * (it happened); stale ones (no longer a violation) do not. Counts and scores keep using active rows only.
 */
export function reportArchiveSql(alias = "v"): string {
  return `(${alias}.archived_at IS NULL OR ${alias}.archived_reason IN ('rule_disabled', 'rule_deleted'))`;
}
