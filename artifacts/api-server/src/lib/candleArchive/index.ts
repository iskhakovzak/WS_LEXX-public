/** Candle archive public API — see service.ts (behaviour), store.ts (SQL), codec.ts (payload format). */
export { readArchivedDays, ensureArchivedDay, archiveDayOnce, runArchiveFill, type FillReport, type ArchiveOutcome } from "./service";
export { listArchivedDays, archivedTfs, archiveTotals, type ArchivedDay, type ArchiveListFilter, type ArchiveListItem } from "./store";
export { aggregateBars, regularOnly, isDayComplete, bestProviderTf, providerServes, TF_SEC, ARCHIVE_TFS, isArchiveTf, tfOfSec, type ArchiveTf } from "./days";
export type { Bar } from "./codec";
