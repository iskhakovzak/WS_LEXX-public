/**
 * Versioned SQL migrations (ARCHITECTURE.md §3.1, data.md Phase 1). In-house, no dependency.
 *
 *   src/db/migrations/NNNN_snake_name.sql   ordered by NNNN, applied once, recorded in `schema_migrations`
 *
 * Rules
 *   • Files are immutable once merged: fix forward with a new file. The checksum of an applied file is compared on
 *     every boot (CRLF-insensitive); a mismatch is logged loudly.
 *   • Each file runs in ONE transaction with `SET LOCAL lock_timeout = '3s'` (a long query on a hot table makes the
 *     migration fail fast instead of queueing all traffic behind its ACCESS EXCLUSIVE lock). A first line
 *     `-- no-transaction` runs the statements one by one outside a transaction (needed for CREATE INDEX CONCURRENTLY);
 *     such files must be idempotent (IF NOT EXISTS), because a failure leaves the earlier statements applied.
 *   • Data fixes are migrations too; log affected rows with RAISE NOTICE (the runner forwards notices to the log).
 *   • `pg_advisory_lock` serialises concurrent boots (deploy overlap, two dev servers on one DB).
 *   • Baseline: on a database that predates the runner (`trades` exists, `schema_migrations` is empty), 0001 is
 *     recorded as applied WITHOUT executing it. On an empty database 0001 creates the schema.
 *   • A failure throws MigrationError; index.ts refuses to start in production and logs loudly in development.
 *
 * The runner takes the pool and logger as arguments (no app imports), so tests and CLI tools can drive it.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitSqlStatements } from "./sqlSplit";

export type QueryResultLike = { rows: any[]; rowCount: number | null };
export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<QueryResultLike>;
  release(err?: Error | boolean): void;
  on?(event: "notice", listener: (msg: { message?: string }) => void): unknown;
  removeListener?(event: "notice", listener: (msg: { message?: string }) => void): unknown;
}
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}
export interface LoggerLike {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const MIGRATION_FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
/** Arbitrary constant: one advisory lock id for "schema migrations" across every process. */
export const MIGRATION_LOCK_ID = 727_431_001;
const NO_TX_RE = /^\s*--\s*no-transaction\b/i;

export type MigrationFile = { version: string; name: string; file: string; sql: string; checksum: string; noTransaction: boolean };
export type AppliedMigration = { version: string; name: string; ms: number; notices: string[]; baseline?: boolean };
export type RunResult = { applied: AppliedMigration[]; baselined: string | null; pending: number; total: number };

export class MigrationError extends Error {
  constructor(message: string, readonly version: string | null, readonly cause?: unknown) {
    super(message);
    this.name = "MigrationError";
  }
}

export type RunOptions = {
  pool: PgPoolLike;
  logger: LoggerLike;
  /** Directory with NNNN_name.sql files (default: resolveMigrationsDir()). */
  dir?: string;
  /** Production refuses out-of-order pending files; development applies them with a warning. */
  production?: boolean;
  /** Version recorded without execution on a pre-runner database (default "0001"). null disables baselining. */
  baselineVersion?: string | null;
  /** SQL returning one row `{ present: boolean }`: true ⇒ the database predates the runner. */
  baselineProbe?: string;
  /** Per-file statement timeout inside the migration transaction (default 15 min; the pool default is 30 s). */
  statementTimeout?: string;
  lockTimeout?: string;
  /** How long a second boot waits for the migration lock before failing (default 15 min). */
  lockWaitMs?: number;
};

export const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  execution_ms INTEGER,
  baseline BOOLEAN NOT NULL DEFAULT false
)`;

const DEFAULT_PROBE = `SELECT to_regclass('public.trades') IS NOT NULL AS present`;

/** dist/migrations (bundled build copies them there) or src/db/migrations (vitest, tsx, CLI tools). */
export function resolveMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "migrations"), path.join(here, "db", "migrations"), path.join(here, "..", "src", "db", "migrations")];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
}

/** Reads and validates the migration files (sorted, unique versions, names match the pattern). */
export function loadMigrationFiles(dir: string): MigrationFile[] {
  if (!existsSync(dir)) throw new MigrationError(`migrations directory not found: ${dir}`, null);
  const files: MigrationFile[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".sql")) continue;
    const m = MIGRATION_FILE_RE.exec(file);
    if (!m) throw new MigrationError(`bad migration file name "${file}" (expected NNNN_snake_name.sql)`, null);
    const sql = readFileSync(path.join(dir, file), "utf8");
    files.push({ version: m[1], name: m[2], file, sql, checksum: checksumOf(sql), noTransaction: NO_TX_RE.test(sql) });
  }
  for (let i = 1; i < files.length; i++) {
    if (files[i].version === files[i - 1].version) throw new MigrationError(`duplicate migration version ${files[i].version}`, files[i].version);
  }
  return files;
}

export async function runMigrationFiles(opts: RunOptions): Promise<RunResult> {
  const { pool, logger } = opts;
  const dir = opts.dir ?? resolveMigrationsDir();
  const files = loadMigrationFiles(dir);
  const baselineVersion = opts.baselineVersion === undefined ? "0001" : opts.baselineVersion;
  const stmtTimeout = opts.statementTimeout ?? "15min";
  const lockTimeout = opts.lockTimeout ?? "3s";
  const result: RunResult = { applied: [], baselined: null, pending: 0, total: files.length };

  const client = await pool.connect();
  let locked = false;
  let current: string | null = null;
  let notices: string[] = [];
  const onNotice = (msg: { message?: string }) => {
    const text = msg?.message ?? String(msg);
    // IF [NOT] EXISTS chatter ("relation … already exists, skipping") is not worth a log line.
    if (/(already exists|does not exist), skipping$/.test(text)) return;
    notices.push(text);
    logger.info({ migration: current, notice: text }, "migration notice");
  };
  client.on?.("notice", onNotice);
  try {
    // Poll with pg_try_advisory_lock instead of a blocking pg_advisory_lock: a session blocked inside that statement
    // holds a virtual transaction, and a CREATE INDEX CONCURRENTLY run by the lock holder waits for every such
    // transaction to end — the two boots deadlock (40P01; seen in CI). Between tries this session runs nothing.
    const waitUntil = Date.now() + (opts.lockWaitMs ?? 15 * 60_000);
    for (;;) {
      const { rows } = await client.query(`SELECT pg_try_advisory_lock($1) AS ok`, [MIGRATION_LOCK_ID]);
      if (rows[0]?.ok) break;
      if (Date.now() > waitUntil) throw new MigrationError("timed out waiting for the migration lock (another instance is migrating)", null);
      await new Promise((r) => setTimeout(r, 250));
    }
    locked = true;
    await client.query(SCHEMA_MIGRATIONS_DDL);

    const { rows: appliedRows } = await client.query(`SELECT version, checksum FROM schema_migrations ORDER BY version`);
    const applied = new Map<string, string>(appliedRows.map((r: any) => [String(r.version), String(r.checksum)]));

    // Baseline: a database built by the old boot code (trades exists) gets 0001 recorded, not executed.
    if (applied.size === 0 && baselineVersion) {
      const base = files.find((f) => f.version === baselineVersion);
      if (base) {
        const { rows } = await client.query(opts.baselineProbe ?? DEFAULT_PROBE);
        if (rows[0]?.present) {
          await client.query(
            `INSERT INTO schema_migrations (version, name, checksum, execution_ms, baseline) VALUES ($1, $2, $3, 0, true)`,
            [base.version, base.name, base.checksum],
          );
          applied.set(base.version, base.checksum);
          result.baselined = base.version;
          logger.info({ version: base.version, migration: base.name }, "migrations: existing database — baseline recorded as applied (not executed)");
        }
      }
    }

    for (const f of files) {
      const sum = applied.get(f.version);
      if (sum !== undefined && sum !== f.checksum) {
        logger.error({ version: f.version, file: f.file, recorded: sum, now: f.checksum }, "migrations: an APPLIED migration file was edited — files are immutable, fix forward with a new file");
      }
    }
    const known = new Set(files.map((f) => f.version));
    for (const v of applied.keys()) if (!known.has(v)) logger.warn({ version: v }, "migrations: applied version has no file in this build");

    const maxApplied = [...applied.keys()].sort().at(-1) ?? null;
    const pending = files.filter((f) => !applied.has(f.version));
    result.pending = pending.length;
    for (const f of pending) {
      if (maxApplied && f.version < maxApplied) {
        const msg = `migration ${f.file} is older than the newest applied version ${maxApplied} (out of order)`;
        if (opts.production) throw new MigrationError(msg, f.version);
        logger.warn({ version: f.version, maxApplied }, `migrations: ${msg} — applying anyway (development)`);
      }
    }

    for (const f of pending) {
      current = f.version;
      notices = [];
      const t0 = Date.now();
      try {
        if (f.noTransaction) {
          await client.query(`SET lock_timeout = '${lockTimeout}'`);
          await client.query(`SET statement_timeout = '${stmtTimeout}'`);
          for (const stmt of splitSqlStatements(f.sql)) await client.query(stmt);
          await client.query(`RESET lock_timeout`);
          await client.query(`RESET statement_timeout`);
          await client.query(
            `INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)`,
            [f.version, f.name, f.checksum, Date.now() - t0],
          );
        } else {
          await client.query("BEGIN");
          await client.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
          await client.query(`SET LOCAL statement_timeout = '${stmtTimeout}'`);
          await client.query(f.sql);
          await client.query(
            `INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)`,
            [f.version, f.name, f.checksum, Date.now() - t0],
          );
          await client.query("COMMIT");
        }
      } catch (err) {
        if (!f.noTransaction) await client.query("ROLLBACK").catch(() => undefined);
        else {
          await client.query(`RESET lock_timeout`).catch(() => undefined);
          await client.query(`RESET statement_timeout`).catch(() => undefined);
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new MigrationError(`migration ${f.file} failed: ${reason}`, f.version, err);
      }
      const ms = Date.now() - t0;
      result.applied.push({ version: f.version, name: f.name, ms, notices });
      logger.info({ version: f.version, migration: f.name, ms, notices: notices.length || undefined }, "migration applied");
    }
    current = null;
    return result;
  } finally {
    client.removeListener?.("notice", onNotice);
    if (locked) await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
