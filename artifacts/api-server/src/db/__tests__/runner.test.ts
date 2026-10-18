import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MigrationError, checksumOf, loadMigrationFiles, runMigrationFiles, resolveMigrationsDir } from "../runner";
import { splitSqlStatements } from "../sqlSplit";
import { createScratchDb, pgAvailable } from "./scratchDb";

const available = await pgAvailable();
const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mig-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(dir, name), sql);
  return dir;
}

describe("splitSqlStatements", () => {
  it("splits on top-level semicolons only", () => {
    const sql = `CREATE INDEX CONCURRENTLY a ON t (x); -- comment; here
      INSERT INTO t VALUES ('a;b', "c;d");
      DO $$ BEGIN PERFORM 1; END $$;
      /* block; comment */ SELECT $tag$ ; $tag$;`;
    expect(splitSqlStatements(sql)).toHaveLength(4);
    expect(splitSqlStatements("  -- only a comment\n")).toEqual([]);
  });
});

describe("loadMigrationFiles", () => {
  it("orders by version, rejects bad names and duplicates, detects no-transaction", () => {
    const dir = dirWith({ "0010_b.sql": "SELECT 1;", "0002_a.sql": "-- no-transaction\nSELECT 1;" });
    const files = loadMigrationFiles(dir);
    expect(files.map((f) => f.version)).toEqual(["0002", "0010"]);
    expect(files[0].noTransaction).toBe(true);
    expect(files[1].noTransaction).toBe(false);
    expect(() => loadMigrationFiles(dirWith({ "2_bad.sql": "" }))).toThrow(MigrationError);
    expect(() => loadMigrationFiles(dirWith({ "0001_a.sql": "", "0001_b.sql": "" }))).toThrow(/duplicate/);
  });

  it("checksum ignores CRLF", () => {
    expect(checksumOf("a\r\nb")).toBe(checksumOf("a\nb"));
  });

  it("the repository migrations load (names valid, versions unique, baseline first)", () => {
    const files = loadMigrationFiles(resolveMigrationsDir());
    expect(files[0].version).toBe("0001");
    expect(files.length).toBeGreaterThan(5);
  });
});

describe.skipIf(!available)("runMigrationFiles (scratch database)", () => {
  let db: Awaited<ReturnType<typeof createScratchDb>>;
  beforeAll(async () => { db = await createScratchDb("runner"); });
  afterAll(async () => { await db?.drop(); });

  it("applies pending files in order, once, under the lock; a second run applies nothing", async () => {
    await db.pool.query(`DROP TABLE IF EXISTS schema_migrations, seq_log, idx_t`);
    const dir = dirWith({
      "0001_base.sql": "CREATE TABLE seq_log (n int);",
      "0002_one.sql": "INSERT INTO seq_log VALUES (2); DO $$ BEGIN RAISE NOTICE 'two: % rows', 1; END $$;",
      "0010_two.sql": "INSERT INTO seq_log VALUES (10);",
      "0011_concurrent.sql": "-- no-transaction\nCREATE TABLE IF NOT EXISTS idx_t (x int);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS idx_t_x ON idx_t (x);",
    });
    // Two boots at once: the advisory lock serialises them, nothing runs twice.
    const [a, b] = await Promise.all([
      runMigrationFiles({ pool: db.pool, logger: silent, dir }),
      runMigrationFiles({ pool: db.pool, logger: silent, dir }),
    ]);
    expect(a.applied.length + b.applied.length).toBe(4);
    const first = a.applied.length ? a : b;
    expect(first.applied.map((m) => m.version)).toEqual(["0001", "0002", "0010", "0011"]);
    expect(first.applied[1].notices).toEqual(["two: 1 rows"]);
    expect((await db.pool.query(`SELECT n FROM seq_log ORDER BY n`)).rows.map((r) => r.n)).toEqual([2, 10]);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'idx_t_x'`)).rows[0].n).toBe(1);
    const again = await runMigrationFiles({ pool: db.pool, logger: silent, dir });
    expect(again.applied).toEqual([]);
  });

  it("records the baseline without executing it on a pre-runner database", async () => {
    await db.pool.query(`DROP TABLE IF EXISTS schema_migrations, should_not_exist, trades, after_base`);
    await db.pool.query(`CREATE TABLE trades (id int)`);
    const dir = dirWith({ "0001_baseline.sql": "CREATE TABLE should_not_exist (x int);", "0002_next.sql": "CREATE TABLE after_base (x int);" });
    const r = await runMigrationFiles({ pool: db.pool, logger: silent, dir });
    expect(r.baselined).toBe("0001");
    expect(r.applied.map((m) => m.version)).toEqual(["0002"]);
    expect((await db.pool.query(`SELECT to_regclass('should_not_exist') AS t`)).rows[0].t).toBeNull();
    expect((await db.pool.query(`SELECT baseline FROM schema_migrations WHERE version = '0001'`)).rows[0].baseline).toBe(true);
    await db.pool.query(`DROP TABLE trades`);
  });

  it("a failing file aborts: MigrationError, its transaction rolled back, not recorded, later files not run", async () => {
    await db.pool.query(`DROP TABLE IF EXISTS schema_migrations, ok_t, half_t, never_t`);
    const dir = dirWith({
      "0001_ok.sql": "CREATE TABLE ok_t (x int);",
      "0002_bad.sql": "CREATE TABLE half_t (x int); SELECT * FROM no_such_table;",
      "0003_never.sql": "CREATE TABLE never_t (x int);",
    });
    await expect(runMigrationFiles({ pool: db.pool, logger: silent, dir })).rejects.toMatchObject({ name: "MigrationError", version: "0002" });
    const versions = (await db.pool.query(`SELECT version FROM schema_migrations ORDER BY version`)).rows.map((r) => r.version);
    expect(versions).toEqual(["0001"]);
    expect((await db.pool.query(`SELECT to_regclass('half_t') AS t`)).rows[0].t).toBeNull();
    expect((await db.pool.query(`SELECT to_regclass('never_t') AS t`)).rows[0].t).toBeNull();
    // the advisory lock was released: another run can proceed (and fails the same way)
    await expect(runMigrationFiles({ pool: db.pool, logger: silent, dir })).rejects.toBeInstanceOf(MigrationError);
  });

  it("refuses out-of-order files in production, warns in development; logs an edited applied file", async () => {
    await db.pool.query(`DROP TABLE IF EXISTS schema_migrations, o1, o5, o3`);
    await runMigrationFiles({ pool: db.pool, logger: silent, dir: dirWith({ "0001_a.sql": "CREATE TABLE o1 (x int);", "0005_b.sql": "CREATE TABLE o5 (x int);" }) });
    const late = dirWith({ "0001_a.sql": "CREATE TABLE o1 (x int); -- edited", "0003_late.sql": "CREATE TABLE o3 (x int);", "0005_b.sql": "CREATE TABLE o5 (x int);" });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(runMigrationFiles({ pool: db.pool, logger: log, dir: late, production: true })).rejects.toThrow(/out of order/);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ version: "0001" }), expect.stringContaining("immutable"));
    const dev = await runMigrationFiles({ pool: db.pool, logger: log, dir: late, production: false });
    expect(dev.applied.map((m) => m.version)).toEqual(["0003"]);
  });

  it("the repository migrations build an empty database and are idempotent on a second run", async () => {
    const fresh = await createScratchDb("repo");
    try {
      const r = await runMigrationFiles({ pool: fresh.pool, logger: silent });
      expect(r.baselined).toBeNull();
      expect(r.applied[0].version).toBe("0001");
      expect((await fresh.pool.query(`SELECT to_regclass('trades') AS t, to_regclass('job_runs') AS j`)).rows[0]).toEqual({ t: "trades", j: "job_runs" });
      expect((await fresh.pool.query(`SELECT count(*)::int AS n FROM holiday_calendar WHERE date LIKE '2027-%'`)).rows[0].n).toBeGreaterThan(80);
      const again = await runMigrationFiles({ pool: fresh.pool, logger: silent });
      expect(again.applied).toEqual([]);
    } finally {
      await fresh.drop();
    }
  });
});
