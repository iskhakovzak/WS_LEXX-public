/**
 * In-app notification center.
 *
 *   GET    /notifications                      inbox page: { items, nextCursor, total? }  (filters below)
 *            ?unread=1            only unread
 *            ?type=a,b            canonical types (legacy spellings matched automatically)
 *            ?severity=info,warn,critical
 *            ?since=ISO           created after this instant
 *            ?archived=0|1|all    default 0 (inbox); 1 = archive only
 *            ?cursor=…            opaque keyset cursor from the previous page
 *            ?limit=30            1..100
 *            ?trader=Имя          staff only — inspect someone else's inbox
 *   GET    /notifications/count                { unread, critical, warn } — bell badge (poll every 30–60 s)
 *   GET    /notifications/types                registry for filters / preferences UI
 *   GET    /notifications/prefs                { prefs: [{ type, inApp, muteUntil }], muteAllUntil }
 *   PUT    /notifications/prefs                body { prefs: [...], muteAllUntil?: ISO|null }
 *   PATCH  /notifications/read-all             body { type?: string } — optionally one type only
 *   PATCH  /notifications/read-idea/:ideaId    legacy: opening an idea reads its notifications
 *   POST   /notifications/read-many            body { ids: number[] }
 *   POST   /notifications/unread-many          body { ids: number[] }
 *   POST   /notifications/archive              body { ids: number[] } | { read: true } (archive everything already read)
 *   POST   /notifications/unarchive            body { ids: number[] }
 *   PATCH  /notifications/:id/read | /unread | /archive | /unarchive
 *
 * Identity is always req.authUser (the global gate already rejects anonymous callers). Guests have no inbox.
 * Rows are never deleted — archive only.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { isGuest, isStaffRole, viewerRole } from "../lib/auth";
import { ensureNotificationSchema, loadNotificationPrefs, saveNotificationPrefs } from "../lib/notifyUtils";
import {
  ALL_TYPES_KEY, clampLimit, decodeCursor, deriveLink, encodeCursor,
  expandTypeFilter, groupLabels, isSeverity, normalizeType, notificationTypes, parseList, sanitizePrefs, stripInlineLink, typeMeta,
} from "../lib/notificationCore";
import { AppError, badRequest, notFound, sendError } from "../lib/http";
import { langOf, type Lang } from "../i18n";
import { renderNotification, type NotificationParams } from "../lib/notificationText";

const router: IRouter = Router();

type Row = {
  id: number;
  user_name: string;
  type: string;
  idea_id: number | null;
  message: string;
  is_read: boolean;
  source: string;
  created_at: Date;
  severity: string | null;
  title: string | null;
  link: string | null;
  entity_type: string | null;
  entity_id: string | null;
  actor: string | null;
  read_at: Date | null;
  archived_at: Date | null;
  params?: Record<string, unknown> | null;
};

const COLS = `id, user_name, type, idea_id, message, is_read, source, created_at, severity, title, link, entity_type, entity_id, actor, read_at, archived_at, params`;

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** API shape (camelCase). `message` is kept as an alias of `body` for older clients. */
export function presentNotification(r: Row, lang: Lang = "ru") {
  const meta = typeMeta(r.type, lang);
  const legacy = !r.title;
  // Text as data: rows with params are rendered in the reader's language; older rows keep their stored Russian text.
  const rendered = r.params ? renderNotification(meta.type, r.params as NotificationParams, lang) : null;
  const body = rendered ? rendered.body : legacy ? stripInlineLink(r.message) : r.message;
  return {
    id: r.id,
    userName: r.user_name,
    type: meta.type,
    typeLabel: meta.label,
    group: meta.group,
    severity: isSeverity(r.severity) ? r.severity : meta.severity,
    title: rendered?.title ?? r.title ?? meta.label,
    body,
    message: body,
    link: deriveLink(r),
    entityType: r.entity_type,
    entityId: r.entity_id,
    actor: r.actor,
    ideaId: r.idea_id,
    source: r.source,
    isRead: r.is_read || r.read_at != null,
    readAt: iso(r.read_at),
    archivedAt: iso(r.archived_at),
    createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
    params: r.params ?? null,
  };
}

/**
 * Whose inbox. Everyone reads their own; curators/admins may pass ?trader= to inspect someone else's
 * (role is re-read from the DB, token roles can be stale). Guests get nothing.
 */
async function resolveTarget(req: Request): Promise<string | null> {
  const me = req.authUser?.name;
  if (!me || isGuest(req)) return null;
  const requested = typeof req.query["trader"] === "string" ? (req.query["trader"] as string).trim() : "";
  if (requested && requested !== me && isStaffRole(await viewerRole(req))) return requested;
  return me;
}

/** Identity for mutations: the signed-in member only (guests cannot mutate; the gate already 403s them). */
function me(req: Request, res: Response): string | null {
  const name = req.authUser?.name;
  if (!name || isGuest(req)) { sendError(res, new AppError("GUEST_READ_ONLY")); return null; }
  return name;
}

function parseIds(body: unknown): number[] | null {
  const raw = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(raw)) return null;
  const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  return ids.length ? ids.slice(0, 500) : null;
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ─── reads ──────────────────────────────────────────────────────────────────

router.get("/notifications/count", asyncHandler(async (req, res): Promise<void> => {
  const trader = await resolveTarget(req);
  if (!trader) { res.json({ unread: 0, critical: 0, warn: 0 }); return; }
  await ensureNotificationSchema();
  const { rows } = await pool.query<{ unread: string; critical: string; warn: string }>(
    `SELECT COUNT(*) AS unread,
            COUNT(*) FILTER (WHERE severity = 'critical') AS critical,
            COUNT(*) FILTER (WHERE severity = 'warn') AS warn
       FROM notifications
      WHERE user_name = $1 AND is_read = FALSE AND read_at IS NULL AND archived_at IS NULL`,
    [trader],
  );
  const r = rows[0];
  res.json({ unread: Number(r?.unread ?? 0), critical: Number(r?.critical ?? 0), warn: Number(r?.warn ?? 0) });
}));

router.get("/notifications/types", asyncHandler(async (req, res): Promise<void> => {
  const lang = langOf(req);
  res.json({
    types: notificationTypes(lang),
    groups: Object.entries(groupLabels(lang)).map(([id, label]) => ({ id, label })),
    allTypesKey: ALL_TYPES_KEY,
  });
}));

router.get("/notifications/prefs", asyncHandler(async (req, res): Promise<void> => {
  const name = req.authUser?.name;
  if (!name || isGuest(req)) { res.json({ prefs: [], muteAllUntil: null }); return; }
  const rows = await loadNotificationPrefs(name);
  const all = rows.find((p) => p.type === ALL_TYPES_KEY);
  res.json({
    prefs: rows.filter((p) => p.type !== ALL_TYPES_KEY).map((p) => ({ type: normalizeType(p.type), inApp: p.inApp, muteUntil: iso(p.muteUntil ?? null) })),
    muteAllUntil: all?.inApp === false ? "forever" : iso(all?.muteUntil ?? null),
  });
}));

router.put("/notifications/prefs", asyncHandler(async (req, res): Promise<void> => {
  const name = me(req, res);
  if (!name) return;
  const body = (req.body ?? {}) as { prefs?: unknown; muteAllUntil?: unknown };
  const prefs = sanitizePrefs(body.prefs).filter((p) => p.type !== ALL_TYPES_KEY);
  if (body.muteAllUntil === "forever") prefs.push({ type: ALL_TYPES_KEY, inApp: false, muteUntil: null });
  else if (typeof body.muteAllUntil === "string" && body.muteAllUntil.trim()) {
    const ms = Date.parse(body.muteAllUntil);
    if (!Number.isFinite(ms)) throw badRequest("INVALID_FIELD", undefined, { field: "muteAllUntil" });
    if (ms - Date.now() > 366 * 86_400_000) throw badRequest("MUTE_TOO_LONG");
    prefs.push({ type: ALL_TYPES_KEY, inApp: true, muteUntil: new Date(ms).toISOString() });
  }
  await saveNotificationPrefs(name, prefs);
  const saved = await loadNotificationPrefs(name);
  const all = saved.find((p) => p.type === ALL_TYPES_KEY);
  res.json({
    ok: true,
    prefs: saved.filter((p) => p.type !== ALL_TYPES_KEY).map((p) => ({ type: normalizeType(p.type), inApp: p.inApp, muteUntil: iso(p.muteUntil ?? null) })),
    muteAllUntil: all?.inApp === false ? "forever" : iso(all?.muteUntil ?? null),
  });
}));

router.get("/notifications", asyncHandler(async (req, res): Promise<void> => {
  const trader = await resolveTarget(req);
  if (!trader) { res.json({ items: [], nextCursor: null }); return; }
  await ensureNotificationSchema();

  const limit = clampLimit(req.query["limit"], 30, 100);
  const where: string[] = [`user_name = $1`];
  const params: unknown[] = [trader];
  const add = (sql: string, v: unknown) => { params.push(v); return sql.replace("?", `$${params.length}`); };

  const archived = String(req.query["archived"] ?? "0");
  if (archived === "1" || archived === "true") where.push(`archived_at IS NOT NULL`);
  else if (archived !== "all") where.push(`archived_at IS NULL`);

  const unread = req.query["unread"];
  if (unread === "1" || unread === "true") where.push(`is_read = FALSE AND read_at IS NULL`);

  const types = parseList(req.query["type"]);
  if (types.length) where.push(add(`type = ANY(?::text[])`, expandTypeFilter(types)));

  const severities = parseList(req.query["severity"]).filter(isSeverity);
  if (severities.length) where.push(add(`severity = ANY(?::text[])`, severities));

  const sinceRaw = req.query["since"];
  if (typeof sinceRaw === "string" && sinceRaw.trim()) {
    const ms = Date.parse(sinceRaw);
    if (!Number.isFinite(ms)) throw badRequest("INVALID_FIELD", undefined, { field: "since" });
    where.push(add(`created_at > ?::timestamptz`, new Date(ms).toISOString()));
  }

  const cursorRaw = req.query["cursor"];
  if (cursorRaw !== undefined && cursorRaw !== "") {
    const cursor = decodeCursor(cursorRaw);
    if (!cursor) throw badRequest("INVALID_FIELD", undefined, { field: "cursor" });
    params.push(cursor.createdAt, cursor.id);
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`);
  }

  params.push(limit + 1);
  const { rows } = await pool.query<Row>(
    `SELECT ${COLS} FROM notifications WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  res.json({
    items: page.map((r) => presentNotification(r, langOf(req))),
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  });
}));

// ─── mutations ──────────────────────────────────────────────────────────────

router.patch("/notifications/read-all", asyncHandler(async (req, res): Promise<void> => {
  const name = me(req, res);
  if (!name) return;
  await ensureNotificationSchema();
  const type = typeof (req.body as { type?: unknown } | null)?.type === "string" ? String((req.body as { type: string }).type) : "";
  const params: unknown[] = [name];
  let sql = `UPDATE notifications SET is_read = TRUE, read_at = COALESCE(read_at, NOW()) WHERE user_name = $1 AND (is_read = FALSE OR read_at IS NULL) AND archived_at IS NULL`;
  if (type) { params.push(expandTypeFilter([type])); sql += ` AND type = ANY($2::text[])`; }
  const { rowCount } = await pool.query(sql, params);
  res.json({ ok: true, updated: rowCount ?? 0 });
}));

/** Mark every unread notification about one trade idea as read (opening the idea counts as reading them). */
router.patch("/notifications/read-idea/:ideaId", asyncHandler(async (req, res): Promise<void> => {
  const ideaId = parseId(String(req.params.ideaId));
  if (!ideaId) throw badRequest("INVALID_ID");
  const name = me(req, res);
  if (!name) return;
  await ensureNotificationSchema();
  const { rowCount } = await pool.query(
    `UPDATE notifications SET is_read = TRUE, read_at = COALESCE(read_at, NOW())
      WHERE user_name = $1 AND idea_id = $2 AND (is_read = FALSE OR read_at IS NULL)`,
    [name, ideaId],
  );
  res.json({ ok: true, updated: rowCount ?? 0 });
}));

router.post("/notifications/read-many", asyncHandler(async (req, res): Promise<void> => {
  const name = me(req, res);
  if (!name) return;
  const ids = parseIds(req.body);
  if (!ids) throw badRequest("IDS_REQUIRED");
  await ensureNotificationSchema();
  const { rowCount } = await pool.query(
    `UPDATE notifications SET is_read = TRUE, read_at = COALESCE(read_at, NOW()) WHERE user_name = $1 AND id = ANY($2::int[]) AND (is_read = FALSE OR read_at IS NULL)`,
    [name, ids],
  );
  res.json({ ok: true, updated: rowCount ?? 0 });
}));

router.post("/notifications/unread-many", asyncHandler(async (req, res): Promise<void> => {
  const name = me(req, res);
  if (!name) return;
  const ids = parseIds(req.body);
  if (!ids) throw badRequest("IDS_REQUIRED");
  await ensureNotificationSchema();
  const { rowCount } = await pool.query(
    `UPDATE notifications SET is_read = FALSE, read_at = NULL WHERE user_name = $1 AND id = ANY($2::int[])`,
    [name, ids],
  );
  res.json({ ok: true, updated: rowCount ?? 0 });
}));

router.post("/notifications/archive", asyncHandler(async (req, res): Promise<void> => {
  const name = me(req, res);
  if (!name) return;
  await ensureNotificationSchema();
  const body = (req.body ?? {}) as { ids?: unknown; read?: unknown };
  if (body.read === true) {
    const { rows } = await pool.query<{ id: number }>(
      `UPDATE notifications SET archived_at = NOW() WHERE user_name = $1 AND archived_at IS NULL AND (is_read = TRUE OR read_at IS NOT NULL) RETURNING id`,
      [name],
    );
    // ids → the client can offer «Отменить» (POST /notifications/unarchive).
    res.json({ ok: true, updated: rows.length, ids: rows.map((r) => Number(r.id)) });
    return;
  }
  const ids = parseIds(body);
  if (!ids) throw badRequest("IDS_REQUIRED");
  // Archiving also reads: an archived row never counts as unread.
  const { rowCount } = await pool.query(
    `UPDATE notifications SET archived_at = COALESCE(archived_at, NOW()), is_read = TRUE, read_at = COALESCE(read_at, NOW())
      WHERE user_name = $1 AND id = ANY($2::int[]) AND archived_at IS NULL`,
    [name, ids],
  );
  res.json({ ok: true, updated: rowCount ?? 0 });
}));

router.post("/notifications/unarchive", asyncHandler(async (req, res): Promise<void> => {
  const name = me(req, res);
  if (!name) return;
  const ids = parseIds(req.body);
  if (!ids) throw badRequest("IDS_REQUIRED");
  await ensureNotificationSchema();
  const { rowCount } = await pool.query(
    `UPDATE notifications SET archived_at = NULL WHERE user_name = $1 AND id = ANY($2::int[]) AND archived_at IS NOT NULL`,
    [name, ids],
  );
  res.json({ ok: true, updated: rowCount ?? 0 });
}));

async function setOne(req: Request, res: Response, sql: string): Promise<void> {
  const id = parseId(String(req.params.id));
  if (!id) throw badRequest("INVALID_ID");
  const name = me(req, res);
  if (!name) return;
  await ensureNotificationSchema();
  const { rows } = await pool.query<Row>(`${sql} WHERE id = $1 AND user_name = $2 RETURNING ${COLS}`, [id, name]);
  if (!rows[0]) throw notFound("NOTIFICATION_NOT_FOUND");
  res.json({ ok: true, notification: presentNotification(rows[0], langOf(req)) });
}

router.patch("/notifications/:id/read", asyncHandler((req, res) =>
  setOne(req, res, `UPDATE notifications SET is_read = TRUE, read_at = COALESCE(read_at, NOW())`)));
router.patch("/notifications/:id/unread", asyncHandler((req, res) =>
  setOne(req, res, `UPDATE notifications SET is_read = FALSE, read_at = NULL`)));
router.patch("/notifications/:id/archive", asyncHandler((req, res) =>
  setOne(req, res, `UPDATE notifications SET archived_at = COALESCE(archived_at, NOW()), is_read = TRUE, read_at = COALESCE(read_at, NOW())`)));
router.patch("/notifications/:id/unarchive", asyncHandler((req, res) =>
  setOne(req, res, `UPDATE notifications SET archived_at = NULL`)));

export default router;
