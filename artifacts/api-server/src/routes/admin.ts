import { Router, type IRouter } from "express";
import { eq, desc, and, ilike, or, gte } from "drizzle-orm";
import { z } from "zod";
import multer from "multer";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { db, pool, auditLogTable, contentReportsTable, discussionsTable, commentsTable, } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { config } from "../config";
import { logAudit } from "../lib/audit";
import { parseTradesReportBuffer, reportTradesToRoundTrips, planSync, applySync, loadAccountMappings } from "../lib/propreports";
import { getActor, bumpTokenVersion } from "../lib/auth";
import { can, forbiddenError, resolveActor, type Capability } from "../lib/permissions";
import { runDbBackup, listBackups, getBackupDownloadUrl, resolveBackupObjectName } from "../lib/dbBackupCron";
import { violationDaySql } from "../lib/violationWindow";
import { AppError, badRequest, notFound, unauthorized } from "../lib/http";
import { langOf } from "../i18n";
import { adminT } from "../i18n/ns";

const router: IRouter = Router();

const USER_COLUMNS = `id, name, role, active,
  COALESCE(theme, 'dark') AS theme,
  COALESCE(banned, false) AS banned,
  banned_at AS "bannedAt",
  banned_reason AS "bannedReason",
  created_at AS "createdAt"`;

const reasonSchema = z.string().trim().max(2000).optional();
const resolutionSchema = z.string().trim().max(2000).optional();
const roleSchema = z.enum(["admin", "curator", "trader"]);
const targetTypeSchema = z.enum(["discussion", "comment"]);

const roleBodySchema = z.object({ role: roleSchema });
const banBodySchema = z.object({ reason: reasonSchema });
const unbanBodySchema = z.object({});
const resolveBodySchema = z.object({ resolution: resolutionSchema });
// The reporter is always the signed-in member (token) — a `reporter` field in the body is ignored.
const reportBodySchema = z.object({
  targetType: targetTypeSchema,
  targetId: z.union([z.string().trim().min(1), z.number().int()]).transform((v) => String(v)),
  reason: z.string().trim().min(1).max(2000),
});


/**
 * Capability guard (permissions matrix, role from the DB). `admin` = may manage admins/curators
 * (users.manage.admins) — replaces the old `guard.role === "admin"` checks.
 */
async function requireCapGuard(req: Request, cap: Capability): Promise<{ ok: true; role: string; admin: boolean }> {
  const actor = await resolveActor(req);
  if (!actor) throw unauthorized();
  if (!(await can(req, cap))) throw forbiddenError(cap);
  return { ok: true, role: actor.role, admin: await can(req, "users.manage.admins") };
}

router.get("/admin/reports/count", asyncHandler(async (req, res): Promise<void> => {
  await requireCapGuard(req, "admin.reports");
  const { rows } = await pool.query<any>(`SELECT COUNT(*)::int AS c FROM content_reports WHERE status = 'open'`);
  res.json({ open: rows[0]?.c ?? 0 });
}));

router.get("/admin/users", asyncHandler(async (req, res): Promise<void> => {
  await requireCapGuard(req, "users.read.team");
  const { rows } = await pool.query<any>(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at ASC`);
  res.json(rows);
}));

router.post("/admin/users/:id/role", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) throw new AppError("INVALID_ID");
  const parsed = roleBodySchema.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const { role } = parsed.data;
  const actor = getActor(req);
  await requireCapGuard(req, "users.manage.admins");
  if (req.authUser?.id === id) throw new AppError("CANNOT_CHANGE_OWN_ROLE");
  const { rows } = await pool.query<any>(
    `UPDATE users SET role = $1 WHERE id = $2 RETURNING ${USER_COLUMNS}`,
    [role, id],
  );
  if (!rows[0]) throw notFound("USER_NOT_FOUND");
  // Role is embedded in the JWT — force re-login so the new role applies everywhere.
  await bumpTokenVersion(id);
  await logAudit({ actor: actor!, action: "user.role.change", targetType: "user", targetId: String(id), details: { name: rows[0].name, role } });
  res.json(rows[0]);
}));

router.post("/admin/users/:id/ban", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) throw new AppError("INVALID_ID");
  const parsed = banBodySchema.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const { reason } = parsed.data;
  const actor = getActor(req);
  const guard = await requireCapGuard(req, "users.manage");
  const { rows: target } = await pool.query<any>(`SELECT name, role FROM users WHERE id = $1`, [id]);
  if (!target[0]) throw notFound("USER_NOT_FOUND");
  if (target[0].role === "admin") throw new AppError("CANNOT_BAN_ADMIN");
  if (target[0].name === actor) throw new AppError("CANNOT_BAN_SELF");
  if (target[0].role === "curator" && !guard.admin) throw new AppError("ADMIN_ONLY_BAN_CURATOR");
  const { rows } = await pool.query<any>(
    `UPDATE users SET banned = true, banned_at = NOW(), banned_reason = $1 WHERE id = $2 RETURNING ${USER_COLUMNS}`,
    [reason || null, id],
  );
  await bumpTokenVersion(id);
  await logAudit({ actor: actor!, action: "user.ban", targetType: "user", targetId: String(id), details: { name: target[0].name, reason: reason || null } });
  res.json(rows[0]);
}));

router.post("/admin/users/:id/unban", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) throw new AppError("INVALID_ID");
  const parsed = unbanBodySchema.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const actor = getActor(req);
  await requireCapGuard(req, "users.manage");
  const { rows } = await pool.query<any>(
    `UPDATE users SET banned = false, banned_at = NULL, banned_reason = NULL WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    [id],
  );
  if (!rows[0]) throw notFound("USER_NOT_FOUND");
  await logAudit({ actor: actor!, action: "user.unban", targetType: "user", targetId: String(id), details: { name: rows[0].name } });
  res.json(rows[0]);
}));

router.delete("/admin/discussions/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) throw new AppError("INVALID_ID");
  const actor = getActor(req);
  await requireCapGuard(req, "discussions.moderate");
  const [d] = await db.update(discussionsTable).set({ deletedAt: new Date() }).where(eq(discussionsTable.id, id)).returning();
  if (!d) throw notFound();
  await logAudit({ actor: actor!, action: "discussion.delete", targetType: "discussion", targetId: String(id), details: { topic: d.topic, author: d.trader } });
  res.sendStatus(204);
}));

router.delete("/admin/comments/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) throw new AppError("INVALID_ID");
  const actor = getActor(req);
  await requireCapGuard(req, "discussions.moderate");
  const [existing] = await db.select().from(commentsTable).where(eq(commentsTable.id, id));
  if (!existing) throw notFound();
  await db.delete(commentsTable).where(eq(commentsTable.id, id));
  await logAudit({ actor: actor!, action: "comment.delete", targetType: "comment", targetId: String(id), details: { author: existing.trader, discussionId: existing.discussionId } });
  res.sendStatus(204);
}));

router.get("/admin/audit", asyncHandler(async (req, res): Promise<void> => {
  await requireCapGuard(req, "admin.audit");
  const filterActor = typeof req.query.filterActor === "string" ? req.query.filterActor : null;
  const filterAction = typeof req.query.filterAction === "string" ? req.query.filterAction : null;
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  // Optional free-text search (actor/action/target/details) and look-back window in days.
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const sinceDays = Number(req.query.sinceDays);
  const conds = [] as any[];
  if (filterActor) conds.push(eq(auditLogTable.actor, filterActor));
  if (filterAction) conds.push(eq(auditLogTable.action, filterAction));
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conds.push(or(
      ilike(auditLogTable.actor, like),
      ilike(auditLogTable.action, like),
      ilike(auditLogTable.targetId, like),
      ilike(auditLogTable.details, like),
    ));
  }
  if (Number.isFinite(sinceDays) && sinceDays > 0 && sinceDays <= 3650) {
    conds.push(gte(auditLogTable.createdAt, new Date(Date.now() - sinceDays * 86_400_000)));
  }
  const rows = await db.select().from(auditLogTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditLogTable.createdAt))
    .limit(limit);
  res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
}));

router.post("/reports", asyncHandler(async (req, res): Promise<void> => {
  const parsed = reportBodySchema.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const { targetType, targetId, reason } = parsed.data;
  const reporter = getActor(req);
  if (!reporter) throw unauthorized();
  const { rows: bannedCheck } = await pool.query<any>(`SELECT COALESCE(banned, false) AS banned FROM users WHERE name = $1`, [reporter]);
  if (bannedCheck[0]?.banned) throw new AppError("REPORTER_BANNED");
  const [row] = await db.insert(contentReportsTable).values({
    reporter,
    targetType,
    targetId,
    reason,
  }).returning();
  res.status(201).json({ ...row, createdAt: row.createdAt.toISOString(), resolvedAt: row.resolvedAt?.toISOString() ?? null });
}));

router.get("/admin/reports", asyncHandler(async (req, res): Promise<void> => {
  await requireCapGuard(req, "admin.reports");
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const rows = await db.select().from(contentReportsTable)
    .where(status ? eq(contentReportsTable.status, status) : undefined)
    .orderBy(desc(contentReportsTable.createdAt))
    .limit(500);
  const targets = await loadReportTargets(rows);
  // How many open reports point at the same target — lets the queue show "3 жалобы" on one item.
  const { rows: dupRows } = await pool.query<any>(
    `SELECT target_type, target_id, COUNT(*)::int AS c FROM content_reports WHERE status = 'open' GROUP BY target_type, target_id`,
  );
  const openByTarget = new Map<string, number>(dupRows.map((d: any) => [`${d.target_type}:${d.target_id}`, d.c]));
  res.json(rows.map((r) => {
    const key = `${r.targetType}:${r.targetId}`;
    return {
      ...r,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      target: targets.get(key) ?? null,
      openReportsOnTarget: openByTarget.get(key) ?? 0,
    };
  }));
}));

interface ReportTarget {
  author: string | null;
  authorId: number | null;
  authorRole: string | null;
  authorBanned: boolean;
  preview: string | null;
  title: string | null;
  discussionId: number | null;
  deleted: boolean;
  createdAt: string | null;
}

/** Resolve reported discussions/comments to author + preview so the queue can act without opening the thread. */
async function loadReportTargets(rows: { targetType: string; targetId: string }[]): Promise<Map<string, ReportTarget>> {
  const out = new Map<string, ReportTarget>();
  const ids = (type: string) => [...new Set(
    rows.filter((r) => r.targetType === type).map((r) => Number(r.targetId)).filter((n) => Number.isInteger(n) && n > 0),
  )];
  const discIds = ids("discussion");
  const commentIds = ids("comment");
  const empty = { rows: [] as any[] };
  const [discRes, comRes, usersRes] = await Promise.all([
    discIds.length
      ? pool.query<any>(`SELECT id, trader, topic, notes, deleted_at, created_at FROM discussions WHERE id = ANY($1::int[])`, [discIds])
      : Promise.resolve(empty),
    commentIds.length
      ? pool.query<any>(
          `SELECT c.id, c.trader, c.text, c.discussion_id, c.created_at, d.topic
             FROM comments c LEFT JOIN discussions d ON d.id = c.discussion_id
            WHERE c.id = ANY($1::int[])`,
          [commentIds],
        )
      : Promise.resolve(empty),
    pool.query<any>(`SELECT id, name, role, COALESCE(banned, false) AS banned FROM users`),
  ]);
  const users = new Map<string, any>(usersRes.rows.map((u: any) => [u.name, u]));
  const clip = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 280) : null);
  const withAuthor = (author: string | null) => {
    const u = author ? users.get(author) : null;
    return { author, authorId: u?.id ?? null, authorRole: u?.role ?? null, authorBanned: !!u?.banned };
  };
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  for (const d of discRes.rows) {
    out.set(`discussion:${d.id}`, {
      ...withAuthor(d.trader ?? null),
      title: d.topic ?? null,
      preview: clip(d.notes),
      discussionId: d.id,
      deleted: !!d.deleted_at,
      createdAt: iso(d.created_at),
    });
  }
  const foundComments = new Set<number>();
  for (const c of comRes.rows) {
    foundComments.add(c.id);
    out.set(`comment:${c.id}`, {
      ...withAuthor(c.trader ?? null),
      title: c.topic ?? null,
      preview: clip(c.text),
      discussionId: c.discussion_id ?? null,
      deleted: false,
      createdAt: iso(c.created_at),
    });
  }
  // Comments are hard-deleted: a missing row means the content is already gone.
  for (const id of commentIds) {
    if (!foundComments.has(id)) {
      out.set(`comment:${id}`, {
        author: null, authorId: null, authorRole: null, authorBanned: false,
        title: null, preview: null, discussionId: null, deleted: true, createdAt: null,
      });
    }
  }
  return out;
}

const banAuthorBodySchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  /** Also close every other open report against the same target. Default true. */
  resolveSiblings: z.boolean().optional(),
});

// Moderation shortcut: ban the author of the reported content and close the report(s) in one step.
router.post("/admin/reports/:id/ban-author", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) throw new AppError("INVALID_ID");
  const parsed = banAuthorBodySchema.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const { reason, resolveSiblings = true } = parsed.data;
  const actor = getActor(req);
  const guard = await requireCapGuard(req, "admin.reports");

  const [report] = await db.select().from(contentReportsTable).where(eq(contentReportsTable.id, id));
  if (!report) throw new AppError("REPORT_NOT_FOUND");
  const target = (await loadReportTargets([report])).get(`${report.targetType}:${report.targetId}`);
  if (!target?.author || target.authorId == null) throw new AppError("REPORT_AUTHOR_NOT_FOUND");
  if (target.authorRole === "admin") throw new AppError("CANNOT_BAN_ADMIN");
  if (target.author === actor) throw new AppError("CANNOT_BAN_SELF");
  if (target.authorRole === "curator" && !guard.admin) throw new AppError("ADMIN_ONLY_BAN_CURATOR");

  const { rows: banned } = await pool.query<any>(
    `UPDATE users SET banned = true, banned_at = NOW(), banned_reason = $1 WHERE id = $2 RETURNING ${USER_COLUMNS}`,
    [reason, target.authorId],
  );
  await bumpTokenVersion(target.authorId);
  // Stored resolution text: written in the moderator's language (they and other staff read it in the admin panel).
  const resolution = adminT.tFor(langOf(req))("reports.authorBanned", { reason }).slice(0, 2000);
  const closed = await pool.query<any>(
    `UPDATE content_reports SET status = 'resolved', resolved_by = $1, resolved_at = NOW(), resolution = $2
      WHERE status = 'open' AND (id = $3 OR ($4::boolean AND target_type = $5 AND target_id = $6))
      RETURNING id`,
    [actor, resolution, id, resolveSiblings, report.targetType, report.targetId],
  );
  const closedIds = closed.rows.map((r: any) => r.id as number);
  await logAudit({
    actor: actor!, action: "report.ban_author", targetType: "user", targetId: String(target.authorId),
    details: { name: target.author, reason, reportId: id, closedReports: closedIds },
  });
  res.json({ user: banned[0] ?? null, closedReports: closedIds });
}));

router.post("/admin/reports/:id/resolve", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) throw new AppError("INVALID_ID");
  const parsed = resolveBodySchema.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const { resolution } = parsed.data;
  const actor = getActor(req);
  await requireCapGuard(req, "admin.reports");
  const [row] = await db.update(contentReportsTable).set({
    status: "resolved",
    resolvedBy: actor!,
    resolvedAt: new Date(),
    resolution: resolution || null,
  }).where(eq(contentReportsTable.id, id)).returning();
  if (!row) throw notFound();
  await logAudit({ actor: actor!, action: "report.resolve", targetType: "report", targetId: String(id), details: { resolution } });
  res.json({ ...row, createdAt: row.createdAt.toISOString(), resolvedAt: row.resolvedAt?.toISOString() ?? null });
}));

router.post("/admin/reports/:id/dismiss", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) throw new AppError("INVALID_ID");
  const parsed = resolveBodySchema.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const { resolution } = parsed.data;
  const actor = getActor(req);
  await requireCapGuard(req, "admin.reports");
  const [row] = await db.update(contentReportsTable).set({
    status: "dismissed",
    resolvedBy: actor!,
    resolvedAt: new Date(),
    resolution: resolution || null,
  }).where(eq(contentReportsTable.id, id)).returning();
  if (!row) throw notFound();
  await logAudit({ actor: actor!, action: "report.dismiss", targetType: "report", targetId: String(id), details: { resolution } });
  res.json({ ...row, createdAt: row.createdAt.toISOString(), resolvedAt: row.resolvedAt?.toISOString() ?? null });
}));

const bulkReportsBodySchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(200),
  kind: z.enum(["resolve", "dismiss"]),
  resolution: z.string().trim().min(1).max(2000),
});

// Bulk triage: resolve or dismiss several open reports with one reason (one audit entry per report).
router.post("/admin/reports/bulk", asyncHandler(async (req, res): Promise<void> => {
  const parsed = bulkReportsBodySchema.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const { ids, kind, resolution } = parsed.data;
  const actor = getActor(req);
  await requireCapGuard(req, "admin.reports");
  const status = kind === "resolve" ? "resolved" : "dismissed";
  const { rows } = await pool.query<any>(
    `UPDATE content_reports SET status = $1, resolved_by = $2, resolved_at = NOW(), resolution = $3
      WHERE status = 'open' AND id = ANY($4::int[])
      RETURNING id`,
    [status, actor, resolution, [...new Set(ids)]],
  );
  const updated = rows.map((r: any) => r.id as number);
  await Promise.all(updated.map((id) => logAudit({
    actor: actor!, action: `report.${kind}`, targetType: "report", targetId: String(id), details: { resolution, bulk: true },
  })));
  res.json({ updated, skipped: ids.filter((id) => !updated.includes(id)) });
}));

const DB_EXPORT_TABLES = {
  playbook: `SELECT * FROM playbook ORDER BY id`,
  trades: `SELECT * FROM trades ORDER BY id`,
  users: `SELECT id, name, role, active, created_at FROM users ORDER BY id`,
  big7Tickers: `SELECT * FROM big7_tickers ORDER BY id`,
  big7Levels: `SELECT * FROM big7_levels ORDER BY id`,
  big7Catalysts: `SELECT * FROM big7_catalysts ORDER BY id`,
  marketEvents: `SELECT * FROM market_events ORDER BY id`,
  tradeIdeas: `SELECT * FROM trade_ideas ORDER BY id`,
  tradingRules: `SELECT * FROM trading_rules ORDER BY id`,
  watchlist: `SELECT * FROM watchlist ORDER BY id`,
  research: `SELECT * FROM research ORDER BY id`,
} as const;
type DbExportKey = keyof typeof DB_EXPORT_TABLES;

// DB Export — full JSON backup of all critical tables (admin/curator only)
router.get("/admin/db-export", asyncHandler(async (req, res): Promise<void> => {
  const actor = getActor(req);
  await requireCapGuard(req, "admin.backups.read");

  // Optional ?tables=trades,playbook — export a subset. Unknown keys are ignored; empty ⇒ everything
  // (the default keeps the full-backup format that the settings import expects).
  const requested = typeof req.query.tables === "string"
    ? req.query.tables.split(",").map((t) => t.trim()).filter((t): t is DbExportKey => t in DB_EXPORT_TABLES)
    : [];
  const keys: DbExportKey[] = requested.length ? [...new Set(requested)] : (Object.keys(DB_EXPORT_TABLES) as DbExportKey[]);
  const results = await Promise.all(keys.map((k) => pool.query<any>(DB_EXPORT_TABLES[k])));
  const tables: Record<string, any[]> = {};
  const summary: Record<string, number> = {};
  keys.forEach((k, i) => { tables[k] = results[i].rows; summary[k] = results[i].rows.length; });

  const exportedAt = new Date().toISOString();
  const data = {
    exportedAt,
    database: config.databaseName ?? "unknown",
    nodeEnv: config.nodeEnv,
    partial: requested.length > 0,
    summary,
    tables,
  };
  await logAudit({ actor: actor!, action: "db.export", targetType: "db", targetId: null, details: { tables: keys, partial: requested.length > 0 } });

  const filename = `ws-lexx-${requested.length ? "export" : "backup"}-${exportedAt.substring(0, 10)}.json`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.json(data);
}));

router.get("/admin/overview", asyncHandler(async (req, res): Promise<void> => {
  await requireCapGuard(req, "admin.audit");
  const [{ rows: openR }, { rows: bannedR }, { rows: weekR }, { rows: roles }] = await Promise.all([
    pool.query<any>(`SELECT COUNT(*)::int AS c FROM content_reports WHERE status = 'open'`),
    pool.query<any>(`SELECT COUNT(*)::int AS c FROM users WHERE COALESCE(banned, false) = true`),
    pool.query<any>(`SELECT COUNT(*)::int AS c FROM audit_log WHERE created_at >= NOW() - INTERVAL '7 days'`),
    pool.query<any>(`SELECT role, COUNT(*)::int AS c FROM users WHERE active = true GROUP BY role`),
  ]);
  const recent = await db.select().from(auditLogTable).orderBy(desc(auditLogTable.createdAt)).limit(10);
  res.json({
    openReports: openR[0]?.c ?? 0,
    bannedUsers: bannedR[0]?.c ?? 0,
    auditLast7d: weekR[0]?.c ?? 0,
    roleCounts: Object.fromEntries(roles.map((r: any) => [r.role, r.c])),
    recent: recent.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  });
}));

// ─── Desk pulse: per-user activity for the head of desk ───
// Computed from existing tables only (trades, journal_days, rule_violations, activity_log, audit_log, comments).
// Optional tables are probed with to_regclass so the endpoint works on a fresh DB.
const PULSE_YMD = /^\d{4}-\d{2}-\d{2}$/;
const PULSE_DAYS = 14;

// Desk day = New York trading date (audit P1-13): default and fallback are America/New_York, never UTC.
const PULSE_DEFAULT_TZ = "America/New_York";
function pulseTz(raw: unknown): string {
  if (typeof raw !== "string" || !raw || raw.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(raw)) return PULSE_DEFAULT_TZ;
  try { new Intl.DateTimeFormat("en-US", { timeZone: raw }); return raw; } catch { return PULSE_DEFAULT_TZ; }
}
function ymdIn(tz: string, d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function ymdShift(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isWeekend(ymd: string): boolean {
  const wd = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return wd === 0 || wd === 6;
}
async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query<any>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [name]);
  return !!rows[0]?.ok;
}
function maxDate(...vals: unknown[]): Date | null {
  let best: Date | null = null;
  for (const v of vals) {
    if (!v) continue;
    const d = v instanceof Date ? v : new Date(String(v));
    if (!isNaN(d.getTime()) && (!best || d > best)) best = d;
  }
  return best;
}

interface PulseUser {
  id: number;
  name: string;
  role: string;
  active: boolean;
  banned: boolean;
  bannedReason: string | null;
  createdAt: string | null;
  lastSeen: string | null;
  activeToday: boolean;
  tradesToday: number;
  tradesWeek: number;
  lastTradeDate: string | null;
  journalToday: boolean;
  notesStreak: number;
  journal30: number;
  violationsToday: number;
  violationsWeek: number;
  violationsHighWeek: number;
  violationsTotal: number;
  tradeStrip: number[];
  journalStrip: boolean[];
}

router.get("/admin/desk-pulse", asyncHandler(async (req, res): Promise<void> => {
  await requireCapGuard(req, "admin.audit");

  const tz = pulseTz(req.query.tz);
  const today = typeof req.query.date === "string" && PULSE_YMD.test(req.query.date) ? req.query.date : ymdIn(tz, new Date());
  const weekFrom = ymdShift(today, -6);
  const stripFrom = ymdShift(today, -(PULSE_DAYS - 1));
  const days = Array.from({ length: PULSE_DAYS }, (_, i) => ymdShift(stripFrom, i));

  const [hasJournal, hasViolations, hasActivity] = await Promise.all([
    tableExists("journal_days"), tableExists("rule_violations"), tableExists("activity_log"),
  ]);
  const empty = { rows: [] as any[] };

  const [usersR, tradesR, stripR, journalR, violR, activityR, auditR, commentsR, reportsR] = await Promise.all([
    pool.query<any>(`SELECT id, name, role, active, COALESCE(banned, false) AS banned, banned_reason, created_at FROM users ORDER BY name`),
    pool.query<any>(
      `SELECT trader,
              COUNT(*) FILTER (WHERE date = $1)::int AS today,
              COUNT(*) FILTER (WHERE date >= $2 AND date <= $1)::int AS week,
              MAX(date) FILTER (WHERE date <= $1) AS last_date,
              MAX(created_at) AS last_created
         FROM trades WHERE deleted_at IS NULL AND trader IS NOT NULL GROUP BY trader`,
      [today, weekFrom],
    ),
    pool.query<any>(
      `SELECT trader, date, COUNT(*)::int AS c FROM trades
        WHERE deleted_at IS NULL AND trader IS NOT NULL AND date >= $1 AND date <= $2
        GROUP BY trader, date`,
      [stripFrom, today],
    ),
    hasJournal
      ? pool.query<any>(
          `SELECT trader, TO_CHAR(day, 'YYYY-MM-DD') AS d, updated_at FROM journal_days
            WHERE day > ($1::date - 120) AND day <= $1::date
              AND (plan <> '' OR well <> '' OR mistakes <> '' OR lessons <> '' OR mood IS NOT NULL OR discipline IS NOT NULL)`,
          [today],
        )
      : Promise.resolve(empty),
    hasViolations
      ? pool.query<any>(
          // По торговому дню нарушения (day), а не по occurred_at — иначе бэкфилл истории попадает в «сегодня».
          `SELECT trader,
                  COUNT(*) FILTER (WHERE vd = $1)::int AS today,
                  COUNT(*) FILTER (WHERE vd > $2 AND vd <= $1)::int AS week,
                  COUNT(*) FILTER (WHERE severity = 'high' AND vd > $2 AND vd <= $1)::int AS high_week,
                  COUNT(*)::int AS total
             FROM (SELECT trader, severity, ${violationDaySql("")} AS vd FROM rule_violations WHERE archived_at IS NULL) v
            GROUP BY trader`,
          [today, ymdShift(today, -7)],
        ).catch(() => pool.query<any>(
          // Колонки day ещё нет (схема правил не создана) — старый расчёт по occurred_at.
          `SELECT trader,
                  COUNT(*) FILTER (WHERE (occurred_at AT TIME ZONE $2)::date = $1::date)::int AS today,
                  COUNT(*) FILTER (WHERE (occurred_at AT TIME ZONE $2)::date > ($1::date - 7))::int AS week,
                  COUNT(*) FILTER (WHERE severity = 'high' AND (occurred_at AT TIME ZONE $2)::date > ($1::date - 7))::int AS high_week,
                  COUNT(*)::int AS total
             FROM rule_violations WHERE archived_at IS NULL GROUP BY trader`,
          [today, tz],
        ))
      : Promise.resolve(empty),
    hasActivity
      ? pool.query<any>(`SELECT trader, MAX(created_at) AS last FROM activity_log WHERE trader IS NOT NULL GROUP BY trader`)
      : Promise.resolve(empty),
    pool.query<any>(`SELECT actor AS trader, MAX(created_at) AS last FROM audit_log GROUP BY actor`),
    pool.query<any>(`SELECT trader, MAX(created_at) AS last FROM comments WHERE trader IS NOT NULL GROUP BY trader`),
    pool.query<any>(`SELECT COUNT(*)::int AS c FROM content_reports WHERE status = 'open'`),
  ]);

  const byTrader = <T,>(rows: any[]) => new Map<string, T>(rows.map((r) => [String(r.trader), r as T]));
  const trades = byTrader<any>(tradesR.rows);
  const viol = byTrader<any>(violR.rows);
  const activity = byTrader<any>(activityR.rows);
  const audit = byTrader<any>(auditR.rows);
  const comments = byTrader<any>(commentsR.rows);
  const strip = new Map<string, Map<string, number>>();
  for (const r of stripR.rows) {
    const m = strip.get(r.trader) ?? new Map<string, number>();
    m.set(r.date, r.c);
    strip.set(r.trader, m);
  }
  const journal = new Map<string, { days: Set<string>; last: Date | null }>();
  for (const r of journalR.rows) {
    const j = journal.get(r.trader) ?? { days: new Set<string>(), last: null };
    j.days.add(r.d);
    j.last = maxDate(j.last, r.updated_at);
    journal.set(r.trader, j);
  }

  const users: PulseUser[] = (usersR.rows as any[]).map((u: any): PulseUser => {
    const name = String(u.name);
    const t = trades.get(name);
    const v = viol.get(name);
    const j = journal.get(name);
    const jd = j?.days ?? new Set<string>();
    // Streak of journal days ending today (or the previous trading day if today's note isn't written yet).
    // Weekends without a note don't break the streak.
    let streak = 0;
    let cursor = jd.has(today) ? today : ymdShift(today, -1);
    for (let i = 0; i < 120; i++) {
      if (jd.has(cursor)) streak++;
      else if (!isWeekend(cursor)) break;
      cursor = ymdShift(cursor, -1);
    }
    const lastSeen = maxDate(t?.last_created, j?.last, activity.get(name)?.last, audit.get(name)?.last, comments.get(name)?.last);
    const tradesToday = t?.today ?? 0;
    const journalToday = jd.has(today);
    const sm = strip.get(name);
    return {
      id: u.id as number,
      name,
      role: String(u.role),
      active: !!u.active,
      banned: !!u.banned,
      bannedReason: u.banned_reason ?? null,
      createdAt: u.created_at ? new Date(u.created_at).toISOString() : null,
      lastSeen: lastSeen?.toISOString() ?? null,
      activeToday: tradesToday > 0 || journalToday || (lastSeen ? ymdIn(tz, lastSeen) === today : false),
      tradesToday,
      tradesWeek: t?.week ?? 0,
      lastTradeDate: t?.last_date ?? null,
      journalToday,
      notesStreak: streak,
      journal30: [...jd].filter((d) => d > ymdShift(today, -30)).length,
      violationsToday: v?.today ?? 0,
      violationsWeek: v?.week ?? 0,
      violationsHighWeek: v?.high_week ?? 0,
      violationsTotal: v?.total ?? 0,
      tradeStrip: days.map((d) => sm?.get(d) ?? 0),
      journalStrip: days.map((d) => jd.has(d)),
    };
  });

  const desk = users.filter((u) => u.role === "trader" && u.active && !u.banned);
  const staleCutoff = Date.now() - 3 * 86_400_000;
  res.json({
    date: today,
    tz,
    days,
    journalAvailable: hasJournal,
    violationsAvailable: hasViolations,
    summary: {
      deskTraders: desk.length,
      activeToday: desk.filter((u) => u.activeToday).length,
      activeNames: desk.filter((u) => u.activeToday).map((u) => u.name),
      tradesToday: users.reduce((s, u) => s + u.tradesToday, 0),
      tradesWeek: users.reduce((s, u) => s + u.tradesWeek, 0),
      noJournalToday: hasJournal ? desk.filter((u) => !u.journalToday).map((u) => u.name) : [],
      violationsToday: users.reduce((s, u) => s + u.violationsToday, 0),
      violationsWeek: users.reduce((s, u) => s + u.violationsWeek, 0),
      openReports: reportsR.rows[0]?.c ?? 0,
      stale: desk.filter((u) => !u.lastSeen || new Date(u.lastSeen).getTime() < staleCutoff).map((u) => u.name),
      banned: users.filter((u) => u.banned).length,
      deskTradeStrip: days.map((_, i) => users.reduce((s, u) => s + u.tradeStrip[i], 0)),
    },
    users,
  });
}));

// ─── DB Backups (pg_dump → Object Storage) ───
router.get("/admin/backups", asyncHandler(async (req, res): Promise<void> => {
  await requireCapGuard(req, "admin.backups.read");
  const backups = await listBackups();
  res.json(backups);
}));

router.post("/admin/backups/trigger", asyncHandler(async (req, res): Promise<void> => {
  await requireCapGuard(req, "admin.backups.run");
  const result = await runDbBackup();
  res.json(result);
}));

router.get("/admin/backups/:name/download", asyncHandler(async (req, res): Promise<void> => {
  await requireCapGuard(req, "admin.backups.run");
  const name = req.params.name;
  if (!name || name.includes("..") || name.includes("/")) throw new AppError("INVALID_FIELD", undefined, { field: "name" });
  const objectName = await resolveBackupObjectName(String(name));
  if (!objectName) throw new AppError("NOT_FOUND");
  const url = await getBackupDownloadUrl(objectName);
  res.json({ url });
}));

// ─── PropReports XLS import ───
// Delegates to lib/propreports (parse-trades-report + sync engine) so the trade contract is honoured:
// pnl = GROSS, fees = total fees, qty, horizon, exit_date, source='propreports', external_id, broker_account, synced_at,
// executions in trade_executions; re-imports update broker-owned fields only and never duplicate.
// Rows imported by the previous inline parser (pnl = net, dedupKey in context_snapshot) are adopted, not duplicated.
// Endpoint and response shape are kept for the admin UI: { parsed, newTrades, duplicates, minDate, maxDate, tradingDays,
// tickers, totalNet, wins, losses, breakEven, dryRun, trader, inserted } (+ updated, conflicts, account).
const xlsUploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
const uploadXls: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  xlsUploader.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    next(err); // multer errors → error middleware (413 TOO_LARGE / 400 UPLOAD_ERROR)
  });
};

const importBodySchema = z.object({
  trader: z.string().trim().min(1).max(100).default("Закир"), // i18n-ignore (a user name: legacy default of the admin import)
  /** Broker account the report belongs to (the Trades report has no account column). Defaults to the trader's mapped account. */
  account: z.string().trim().min(1).max(120).optional(),
  dryRun: z.union([z.boolean(), z.string()]).optional().transform((v) => v === true || v === "true" || v === "1"),
});

router.post("/admin/import-propreports", uploadXls, asyncHandler(async (req, res): Promise<void> => {
  const actor = getActor(req);
  await requireCapGuard(req, "propreports.sync");
  if (!req.file) throw new AppError("FILE_REQUIRED");

  const parsed = importBodySchema.safeParse(req.body);
  if (!parsed.success) throw parsed.error;
  const { trader, dryRun } = parsed.data;

  let trades;
  try {
    trades = parseTradesReportBuffer(req.file.buffer);
  } catch (e) {
    throw badRequest("XLS_PARSE_FAILED", e instanceof Error ? e.message : String(e));
  }
  if (trades.length === 0) throw new AppError("XLS_NO_TRADES");

  // Resolve the broker account: explicit → first active mapping of this trader → the trader's name (mapping auto-created).
  const mappings = await loadAccountMappings();
  let account = parsed.data.account ?? mappings.find((m) => m.trader === trader && m.active)?.account ?? mappings.find((m) => m.trader === trader)?.account;
  if (!account) {
    account = trader;
    if (!dryRun) {
      await pool.query( // i18n-ignore (stored account note, data)
        `INSERT INTO propreports_accounts (account, trader, notes) VALUES ($1, $1, 'создано автоматически при импорте XLS')
         ON CONFLICT (account) DO UPDATE SET trader = COALESCE(propreports_accounts.trader, EXCLUDED.trader), updated_at = NOW()`,
        [trader],
      );
    }
  }
  const existingMapping = mappings.find((m) => m.account === account);
  if (existingMapping && existingMapping.trader && existingMapping.trader !== trader) {
    throw badRequest("ACCOUNT_LINKED_TO_OTHER", undefined, { account, owner: existingMapping.trader, trader });
  }

  const trips = reportTradesToRoundTrips(trades, account);
  // dry run must not create the mapping, so the plan gets it as a virtual mapping instead
  const plan = await planSync(trips, { virtualMappings: existingMapping ? [] : [{ account, trader }] });
  const dates = [...new Set(trades.map((t) => t.date))].sort();
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  const totalNet = +trades.reduce((s, t) => s + t.net, 0).toFixed(2);
  const summary = {
    parsed: trades.length,
    newTrades: plan.counts.insert,
    duplicates: plan.counts.unchanged + plan.counts.update + plan.counts.adopt,
    conflicts: plan.counts.conflict,
    unmapped: plan.counts.skip,
    minDate, maxDate, tradingDays: dates.length, tickers: new Set(trades.map((t) => t.ticker)).size,
    totalNet,
    wins: trades.filter((t) => t.result === "win").length,
    losses: trades.filter((t) => t.result === "loss").length,
    breakEven: trades.filter((t) => t.result === "be").length,
    dryRun, trader, account,
  };

  if (dryRun) {
    res.json({ ...summary, inserted: 0, updated: 0 });
    return;
  }
  const result = await applySync(plan, { actor: actor!, source: "file", fileName: req.file.originalname, details: { via: "admin", trader } });
  res.json({ ...summary, inserted: result.inserted, updated: result.updated, runId: result.runId, errorText: result.errorText });
}));


export default router;
