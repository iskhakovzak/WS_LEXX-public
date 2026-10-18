/**
 * Storage for "Trade Performance" aggregate reports (table propreports_performance_reports).
 * One row per (account, period_from, period_to); a re-upload of the same period replaces the row.
 * These reports contain no individual trades — they are broker statistics only and never touch `trades`.
 */
import { pool } from "@workspace/db";
import { logAudit } from "../audit";
import type { PerformanceReport } from "./parse-performance-report";
import { loadAccountMappings, resolveAccount } from "./sync";

export interface PerformanceReportRow {
  id: number;
  account: string;
  traderName: string | null;
  periodFrom: string;
  periodTo: string;
  fileName: string | null;
  uploadedBy: string | null;
  uploadedAt: string;
  summary: PerformanceReport["summary"];
  /** full report only when requested */
  data?: PerformanceReport;
}

type Queryable = { query: (typeof pool)["query"] };

let ensured = false;
/** Idempotent; also appended to lib/migrate.ts — called here so a direct script works without the migration runner. */
export async function ensurePerformanceTable(db: Queryable = pool): Promise<void> {
  if (ensured && db === pool) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS "propreports_performance_reports" (
      "id" SERIAL PRIMARY KEY,
      "account" TEXT NOT NULL,
      "trader_name" TEXT,
      "period_from" TEXT NOT NULL,
      "period_to" TEXT NOT NULL,
      "file_name" TEXT,
      "data" JSONB NOT NULL,
      "uploaded_by" TEXT,
      "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE ("account", "period_from", "period_to")
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS propreports_perf_trader_idx ON propreports_performance_reports(trader_name)`);
  if (db === pool) ensured = true;
}

export interface SavePerformanceInput {
  account: string;
  trader: string | null;
  periodFrom: string;
  periodTo: string;
  fileName?: string | null;
  uploadedBy: string | null;
  report: PerformanceReport;
}

/** Upsert; returns the stored row (summary only) and whether an older row was replaced. */
export async function savePerformanceReport(input: SavePerformanceInput, db: Queryable = pool): Promise<{ row: PerformanceReportRow; replaced: boolean }> {
  await ensurePerformanceTable(db);
  const { rows: before } = await db.query(
    `SELECT id FROM propreports_performance_reports WHERE account = $1 AND period_from = $2 AND period_to = $3`,
    [input.account, input.periodFrom, input.periodTo],
  );
  const { rows } = await db.query(
    `INSERT INTO propreports_performance_reports (account, trader_name, period_from, period_to, file_name, data, uploaded_by, uploaded_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW())
     ON CONFLICT (account, period_from, period_to) DO UPDATE
       SET trader_name = EXCLUDED.trader_name, file_name = EXCLUDED.file_name, data = EXCLUDED.data,
           uploaded_by = EXCLUDED.uploaded_by, uploaded_at = NOW()
     RETURNING *`,
    [input.account, input.trader, input.periodFrom, input.periodTo, input.fileName ?? null, JSON.stringify(input.report), input.uploadedBy],
  );
  const row = rowView(rows[0], false);
  if (db === pool) {
    await logAudit({
      actor: input.uploadedBy ?? "system",
      action: before.length ? "propreports.performance.replace" : "propreports.performance.import",
      targetType: "propreports_performance_report",
      targetId: String(row.id),
      details: { account: input.account, trader: input.trader, periodFrom: input.periodFrom, periodTo: input.periodTo, summary: input.report.summary },
    }).catch(() => {});
  }
  return { row, replaced: before.length > 0 };
}

export interface ListPerformanceOptions {
  trader?: string | null;
  account?: string | null;
  withData?: boolean;
  limit?: number;
}

export async function listPerformanceReports(opts: ListPerformanceOptions = {}, db: Queryable = pool): Promise<PerformanceReportRow[]> {
  await ensurePerformanceTable(db);
  const { rows } = await db.query(
    `SELECT * FROM propreports_performance_reports
      WHERE ($1::text IS NULL OR trader_name = $1)
        AND ($2::text IS NULL OR account = $2)
      ORDER BY period_to DESC, period_from DESC, uploaded_at DESC
      LIMIT $3`,
    [opts.trader ?? null, opts.account ?? null, Math.min(Math.max(opts.limit ?? 50, 1), 200)],
  );
  return rows.map((r: any) => rowView(r, !!opts.withData));
}

export async function getPerformanceReport(id: number, db: Queryable = pool): Promise<PerformanceReportRow | null> {
  await ensurePerformanceTable(db);
  const { rows } = await db.query(`SELECT * FROM propreports_performance_reports WHERE id = $1`, [id]);
  return rows[0] ? rowView(rows[0], true) : null;
}

export async function deletePerformanceReport(id: number, actor: string, db: Queryable = pool): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM propreports_performance_reports WHERE id = $1`, [id]);
  if (rowCount && db === pool) await logAudit({ actor, action: "propreports.performance.delete", targetType: "propreports_performance_report", targetId: String(id) }).catch(() => {});
  return !!rowCount;
}

/** Default trader for an account via the account mapping (exact → alias → case-insensitive → fuzzy). */
export async function traderForAccount(account: string): Promise<{ trader: string | null; how: string | null }> {
  const mappings = await loadAccountMappings();
  const hit = resolveAccount(account, mappings);
  return { trader: hit?.mapping.trader ?? null, how: hit?.how ?? null };
}

function rowView(r: any, withData: boolean): PerformanceReportRow {
  const data = (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as PerformanceReport;
  return {
    id: Number(r.id),
    account: r.account,
    traderName: r.trader_name ?? null,
    periodFrom: r.period_from,
    periodTo: r.period_to,
    fileName: r.file_name ?? null,
    uploadedBy: r.uploaded_by ?? null,
    uploadedAt: new Date(r.uploaded_at).toISOString(),
    summary: data.summary,
    ...(withData ? { data } : {}),
  };
}
