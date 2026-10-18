/**
 * Database backups (ARCHITECTURE.md §3.10, data.md Phase 0/6). Scheduled by the job registry ("db.backup",
 * src/jobs/definitions.ts): daily at a fixed New York hour (BACKUP_CRON, default 03:15), plus a catch-up run
 * after boot only when the newest stored backup is older than 20 h — a restart never forces a dump.
 *
 *   • `pg_dump -Fc` streamed straight into Object Storage (no in-memory buffer);
 *   • data of `*_cache` tables is excluded (re-fetchable, ~37% of the DB); their schema is kept;
 *   • pg_dump and server major versions are logged; an older pg_dump than the server fails loudly;
 *   • retention: newest backup of each of the last 14 days + newest of each of the last 8 weeks (NY calendar);
 *   • the time of the last backup is derived from the newest stored object, never kept in memory.
 *
 * Restore: `pg_restore --no-owner --dbname=<url> <file>.dump` (old `.sql.gz` backups: `gunzip -c | psql`).
 */
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { pool } from "@workspace/db";
import { config } from "../config";
import { objectStorageClient } from "./objectStorage";
import { logger } from "./logger";
import { logAudit } from "./audit";
import { nyDate } from "./tradingDate";

const BACKUP_PREFIX = "ws-lexx-backups/";
const SIDECAR = "http://127.0.0.1:1106";
export const KEEP_DAILY = 14;
export const KEEP_WEEKLY = 8;
const EXTENSIONS = [".dump", ".sql.gz"] as const;

export interface BackupMeta {
  name: string;
  objectName: string;
  /** File name to save as (name + extension). */
  file: string;
  format: "custom" | "plain-gzip";
  createdAt: string;
  sizeKb: number;
}

const bucketId = (): string => config.storage.bucketId;

function nowLabel(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
}

function splitName(objectName: string): { name: string; ext: (typeof EXTENSIONS)[number] } | null {
  const base = objectName.startsWith(BACKUP_PREFIX) ? objectName.slice(BACKUP_PREFIX.length) : objectName;
  for (const ext of EXTENSIONS) if (base.endsWith(ext)) return { name: base.slice(0, -ext.length), ext };
  return null;
}

/** Major version from "pg_dump (PostgreSQL) 16.4" / server_version_num 160004. */
export function parsePgDumpMajor(versionLine: string): number | null {
  const m = /(\d+)(?:\.(\d+))?/.exec(versionLine.replace(/^[^\d]*/, ""));
  return m ? Number(m[1]) : null;
}

async function pgDumpVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("pg_dump", ["--version"]);
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("error", (e) => reject(new Error(`pg_dump is not installed or not on PATH (${e.message})`)));
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`pg_dump --version exited ${code}`))));
  });
}

/** Logs both versions; throws when pg_dump is older than the server (a 16 pg_dump cannot dump a 17 server). */
export async function checkDumpVersions(): Promise<{ pgDump: string; server: string }> {
  const [pgDump, serverRows] = await Promise.all([pgDumpVersion(), pool.query(`SELECT current_setting('server_version') AS v, current_setting('server_version_num')::int AS n`)]);
  const server = String(serverRows.rows[0]?.v ?? "?");
  const serverMajor = Math.floor(Number(serverRows.rows[0]?.n ?? 0) / 10000);
  const dumpMajor = parsePgDumpMajor(pgDump);
  logger.info({ pgDump, server }, "dbBackup: versions");
  if (dumpMajor == null || !serverMajor || dumpMajor < serverMajor) {
    const msg = `pg_dump major ${dumpMajor ?? "?"} is older than the server major ${serverMajor || "?"} (${pgDump} vs ${server}) — install a matching postgresql client`;
    logger.error({ pgDump, server }, `dbBackup: ${msg}`);
    throw new Error(msg);
  }
  return { pgDump, server };
}

/** Pure: which stored backups fall outside "newest per day for KEEP_DAILY days + newest per week for KEEP_WEEKLY weeks". */
export function backupsToDelete<T extends { objectName: string; createdAt: string | Date }>(items: T[], keepDaily = KEEP_DAILY, keepWeekly = KEEP_WEEKLY): T[] {
  const sorted = [...items].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const keep = new Set<string>();
  const days = new Set<string>();
  const weeks = new Set<string>();
  for (const it of sorted) {
    const d = nyDate(new Date(it.createdAt));
    if (!days.has(d) && days.size < keepDaily) {
      days.add(d);
      keep.add(it.objectName);
    }
    const w = weekKey(d);
    if (!weeks.has(w) && weeks.size < keepWeekly) {
      weeks.add(w);
      keep.add(it.objectName);
    }
  }
  return sorted.filter((it) => !keep.has(it.objectName));
}

/** Monday (YYYY-MM-DD) of the week of a YYYY-MM-DD date. */
function weekKey(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const wd = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - wd);
  return t.toISOString().slice(0, 10);
}

async function pruneOldBackups(): Promise<number> {
  const all = await listBackups();
  const doomed = backupsToDelete(all);
  const bucket = objectStorageClient.bucket(bucketId());
  for (const b of doomed) {
    await bucket.file(b.objectName).delete().catch((err: unknown) => logger.warn({ err, name: b.objectName }, "dbBackup: prune failed"));
    logger.info({ name: b.objectName }, "dbBackup: pruned old backup");
  }
  return doomed.length;
}

export async function runDbBackup(): Promise<BackupMeta> {
  if (!bucketId()) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not configured — set up Object Storage first");
  if (!config.databaseUrl) throw new Error("DATABASE_URL not set");
  const versions = await checkDumpVersions();
  const label = nowLabel();
  const objectName = `${BACKUP_PREFIX}${label}.dump`;
  const file = objectStorageClient.bucket(bucketId()).file(objectName);
  logger.info({ label }, "dbBackup: starting pg_dump (custom format, streamed)");

  const args = ["--format=custom", "--no-password", "--no-owner", "--no-privileges", "--exclude-table-data=public.*_cache", `--dbname=${config.databaseUrl}`];
  const child = spawn("pg_dump", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
  const exited = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
  try {
    await pipeline(child.stdout, file.createWriteStream({ resumable: false, contentType: "application/octet-stream", metadata: { metadata: { pgDump: versions.pgDump, server: versions.server } } }));
    const code = await exited;
    if (code !== 0) throw new Error(`pg_dump exited ${code}: ${stderr.trim().slice(-500)}`);
  } catch (err) {
    child.kill();
    await file.delete().catch(() => undefined);
    logger.error({ err, stderr: stderr.slice(-1000) }, "dbBackup: failed");
    throw err;
  }
  const [meta] = await file.getMetadata();
  const sizeKb = Math.round(Number(meta.size ?? 0) / 1024);
  const pruned = await pruneOldBackups().catch((err) => { logger.warn({ err }, "dbBackup: prune failed"); return 0; });
  logger.info({ objectName, sizeKb, pruned }, "dbBackup: completed");
  await logAudit({ actor: "system", action: "db.backup", targetType: "backup", targetId: label, details: { sizeKb, objectName, pruned, ...versions } });
  return { name: label, objectName, file: `${label}.dump`, format: "custom", createdAt: new Date().toISOString(), sizeKb };
}

export async function listBackups(): Promise<BackupMeta[]> {
  if (!bucketId()) return [];
  const bucket = objectStorageClient.bucket(bucketId());
  const [files] = await bucket.getFiles({ prefix: BACKUP_PREFIX });
  const result: BackupMeta[] = [];
  for (const f of files) {
    const parts = splitName(f.name);
    if (!parts) continue;
    const [meta] = await f.getMetadata();
    result.push({
      name: parts.name,
      objectName: f.name,
      file: `${parts.name}${parts.ext}`,
      format: parts.ext === ".dump" ? "custom" : "plain-gzip",
      createdAt: String(meta.timeCreated ?? meta.updated ?? ""),
      sizeKb: Math.round(Number(meta.size ?? 0) / 1024),
    });
  }
  return result.sort((a, b) => b.name.localeCompare(a.name));
}

/** Time of the newest stored backup (null when none / storage not configured). */
export async function latestBackupAt(): Promise<Date | null> {
  const list = await listBackups();
  const t = list.map((b) => new Date(b.createdAt).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0];
  return t ? new Date(t) : null;
}

/** Object name for a backup name from the list (either format); null when it does not exist. */
export async function resolveBackupObjectName(name: string): Promise<string | null> {
  const list = await listBackups();
  return list.find((b) => b.name === name)?.objectName ?? null;
}

export async function getBackupDownloadUrl(objectName: string): Promise<string> {
  const req = {
    bucket_name: bucketId(),
    object_name: objectName,
    method: "GET",
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
  const resp = await fetch(`${SIDECAR}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Signed URL failed: ${resp.status}`);
  const { signed_url } = await resp.json() as { signed_url: string };
  return signed_url;
}

/**
 * The "db.backup" job body: skips when a recent backup exists (catch-up after boot: < 20 h; scheduled: < 1 h, so a
 * manual «Создать сейчас» shortly before the nightly slot doesn't double up).
 */
export async function backupJob(trigger: string): Promise<Record<string, unknown>> {
  const last = await latestBackupAt();
  const minAgeMs = trigger === "startup" ? 20 * 3600_000 : trigger === "manual" ? 0 : 3600_000;
  if (last && Date.now() - last.getTime() < minAgeMs) return { skipped: "recent", lastBackupAt: last.toISOString() };
  const r = await runDbBackup();
  return { objectName: r.objectName, sizeKb: r.sizeKb };
}
