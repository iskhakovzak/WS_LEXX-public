/**
 * Owner-or-staff rule for shared desk rows with an author (watchlist content, big7 levels / catalysts / tickers).
 * Mirror of api-server lib/accessRules.canModifyOwnedRow — the server enforces it (403 NOT_OWNER); this only
 * hides buttons that would fail. Rows without an author (legacy / seeded) are staff-only.
 */
export function canModifyOwned(createdBy: string | null | undefined, me: string | null | undefined, isStaff: boolean): boolean {
  if (!me) return false;
  if (isStaff) return true;
  const owner = typeof createdBy === "string" ? createdBy.trim() : "";
  return owner !== "" && owner === me;
}

/** Reads `createdBy` off a row whose generated type does not declare it yet (orval types predate the column). */
export function createdByOf(row: unknown): string | null {
  const v = row && typeof row === "object" ? (row as { createdBy?: unknown }).createdBy : null;
  return typeof v === "string" ? v : null;
}
