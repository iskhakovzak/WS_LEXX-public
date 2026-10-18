/**
 * Schema snapshot CLI (data.md D4). Run from artifacts/api-server:
 *
 *   pnpm --filter @workspace/api-server db:snapshot          build a scratch DB from src/db/migrations, write db/schema.sql
 *   pnpm --filter @workspace/api-server db:snapshot:check    same, but exit 1 when db/schema.sql differs (CI)
 *   node scripts/run-ts.mjs src/db/tools/snapshot.ts --dump <db> --out <file> [--exclude t1,t2] [--header "…"]
 *                                                            dump an existing LOCAL database (used to make 0001_baseline.sql)
 *
 * Server: SNAPSHOT_DATABASE_URL, else DATABASE_URL, else postgresql://postgres:postgres@localhost:5432/postgres.
 * Only the database part of the URL is replaced: a scratch database `ws_snapshot_<pid>_<time>` is created, migrated,
 * dumped and dropped. Refuses non-local hosts unless --allow-remote (never point this at production).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const serverUrl = process.env.SNAPSHOT_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres";
process.env.DATABASE_URL ??= serverUrl; // @workspace/db needs it at import time (the main pool is never used here)

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

function assertLocal(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) && !flag("--allow-remote")) {
    console.error(`snapshot: refusing non-local database host "${host}" (pass --allow-remote for a CI service container)`);
    process.exit(2);
  }
}

function firstDiff(a: string, b: string): string {
  const la = a.split("\n"), lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `line ${i + 1}:\n  committed: ${la[i] ?? "<eof>"}\n  migrations: ${lb[i] ?? "<eof>"}`;
  }
  return "";
}

async function main(): Promise<void> {
  assertLocal(serverUrl);
  const { createPool } = await import("@workspace/db");
  const { dumpSchema } = await import("../schemaDump");
  const { runMigrationFiles } = await import("../runner");
  const root = process.cwd();
  const log = { info: () => undefined, warn: (o: object, m?: string) => console.warn("warn:", m, JSON.stringify(o)), error: (o: object, m?: string) => console.error("error:", m, JSON.stringify(o)) };

  const dumpDb = opt("--dump");
  if (dumpDb) {
    const out = opt("--out");
    if (!out) throw new Error("--out <file> is required with --dump");
    const pool = createPool(withDb(serverUrl, dumpDb), { max: 2, application_name: "ws-lexx-snapshot" });
    try {
      const sql = await dumpSchema(pool, { excludeTables: (opt("--exclude") ?? "").split(",").filter(Boolean), header: opt("--header") });
      writeFileSync(path.resolve(root, out), sql);
      console.log(`snapshot: wrote ${out} (${sql.length} bytes) from database ${dumpDb}`);
    } finally {
      await pool.end();
    }
    return;
  }

  const dir = path.resolve(root, opt("--dir") ?? "src/db/migrations");
  const target = path.resolve(root, opt("--file") ?? "db/schema.sql");
  const scratch = `ws_snapshot_${process.pid}_${Date.now()}`;
  const admin = createPool(serverUrl, { max: 1, application_name: "ws-lexx-snapshot" });
  await admin.query(`CREATE DATABASE ${scratch} TEMPLATE template0 ENCODING 'UTF8'`);
  let sql = "";
  try {
    const pool = createPool(withDb(serverUrl, scratch), { max: 2, application_name: "ws-lexx-snapshot" });
    try {
      const r = await runMigrationFiles({ pool, logger: log, dir, baselineVersion: null });
      sql = await dumpSchema(pool, { header: "-- Schema built from src/db/migrations (db:snapshot). Do not edit: change a migration and re-run the script." });
      console.log(`snapshot: applied ${r.applied.length} migrations to ${scratch}`);
    } finally {
      await pool.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${scratch}`).catch((e) => console.error("snapshot: could not drop", scratch, e));
    await admin.end();
  }

  if (flag("--check")) {
    const committed = existsSync(target) ? readFileSync(target, "utf8").replace(/\r\n/g, "\n") : "";
    if (committed !== sql) {
      console.error(`snapshot: ${path.relative(root, target)} is out of date with src/db/migrations.\n${firstDiff(committed, sql)}\nRun: pnpm --filter @workspace/api-server db:snapshot`);
      process.exit(1);
    }
    console.log(`snapshot: ${path.relative(root, target)} matches the migrations`);
    return;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, sql);
  console.log(`snapshot: wrote ${path.relative(root, target)} (${sql.length} bytes)`);
}

main().catch((err) => {
  console.error("snapshot failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
