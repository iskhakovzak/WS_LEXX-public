/**
 * Internal error tracking (lib/errorTracking.ts).
 *
 *   POST /client-errors                 public (the login screen can fail too); per-IP/user limiter, 32 KB body
 *   POST /csp-report                    public; CSP violation reports (report-uri / report-to)
 *   GET  /admin/app-errors              admin.errors — grouped list: ?status=open|resolved|all&source=&q=&limit=&offset=
 *   GET  /admin/app-errors/:id          admin.errors — one group + its last occurrences
 *   POST /admin/app-errors/:id/resolve  admin.errors — { resolved: boolean }
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireCap } from "../lib/permissions";
import { badRequest, notFound } from "../lib/http";
import { ERROR_SOURCES, ensureErrorTrackingSchema, recordError, releaseId, type ErrorSource } from "../lib/errorTracking";
import { cspReportBody, reportLimiter } from "../lib/security/http";
import { logAudit } from "../lib/audit";

const router: IRouter = Router();
const limiter = reportLimiter();

const ClientError = z.object({
  kind: z.enum(["render", "error", "rejection", "api"]),
  name: z.string().max(200).optional(),
  message: z.string().max(4000),
  stack: z.string().max(16_000).optional().nullable(),
  componentStack: z.string().max(8000).optional().nullable(),
  /** Page path (the client sends location.pathname; anything after ? or # is dropped here anyway). */
  page: z.string().max(500).optional().nullable(),
  /** Failed API call: method + path and status. */
  api: z.object({ method: z.string().max(10), path: z.string().max(500), status: z.number().int().min(100).max(599) }).optional().nullable(),
  requestId: z.string().max(64).optional().nullable(),
  release: z.string().max(64).optional().nullable(),
});

router.post("/client-errors", limiter, asyncHandler(async (req, res): Promise<void> => {
  const parsed = ClientError.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION");
  const b = parsed.data;
  const route = b.api ? `${b.api.method.toUpperCase()} ${b.api.path}` : b.page ?? null;
  await recordError({
    source: "client",
    kind: b.kind === "api" ? `api ${b.api?.status ?? ""}`.trim() : `${b.kind}:${b.name || "Error"}`,
    message: b.message,
    stack: [b.stack, b.componentStack ? `Component stack:${b.componentStack}` : null].filter(Boolean).join("\n") || null,
    route,
    status: b.api?.status ?? null,
    requestId: b.requestId ?? null,
    userId: req.authUser?.id ?? null,
    userAgent: req.get("user-agent") ?? null,
    release: b.release ?? releaseId(),
    context: b.page && b.api ? { page: b.page } : null,
  });
  res.status(204).end();
}));

type CspBody = Record<string, unknown>;

/** Normalizes both report formats into { directive, blocked, document }. */
function cspReports(body: unknown): { directive: string; blocked: string; document: string; sample?: string }[] {
  const items: CspBody[] = Array.isArray(body)
    ? (body as { type?: string; body?: CspBody }[]).filter((r) => r?.type === "csp-violation" && r.body).map((r) => r.body!)
    : body && typeof body === "object" && (body as { "csp-report"?: CspBody })["csp-report"]
      ? [(body as { "csp-report": CspBody })["csp-report"]]
      : [];
  return items.slice(0, 10).map((r) => ({
    directive: String(r["effectiveDirective"] ?? r["effective-directive"] ?? r["violated-directive"] ?? "unknown").slice(0, 100),
    blocked: String(r["blockedURL"] ?? r["blocked-uri"] ?? "").slice(0, 300),
    document: String(r["documentURL"] ?? r["document-uri"] ?? "").slice(0, 300),
    sample: typeof (r["sample"] ?? r["script-sample"]) === "string" ? String(r["sample"] ?? r["script-sample"]).slice(0, 120) : undefined,
  }));
}

function originOnly(u: string): string {
  try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch { return u.split(/[?#]/)[0]; }
}
function pathOnly(u: string): string {
  try { return new URL(u).pathname; } catch { return u.split(/[?#]/)[0]; }
}

router.post("/csp-report", limiter, cspReportBody, asyncHandler(async (req, res): Promise<void> => {
  for (const r of cspReports(req.body)) {
    const blocked = r.blocked && /^[a-z]+:\/\//i.test(r.blocked) ? originOnly(r.blocked) : r.blocked || "inline";
    await recordError({
      source: "csp",
      kind: `csp:${r.directive}`,
      message: `${r.directive} blocked ${blocked}`,
      route: r.document ? pathOnly(r.document) : null,
      userAgent: req.get("user-agent") ?? null,
      userId: req.authUser?.id ?? null,
      context: r.sample ? { sample: r.sample } : null,
    });
  }
  res.status(204).end();
}));

// ─── Admin ──────────────────────────────────────────────────────────────────────────────────────────────

const ListQuery = z.object({
  status: z.enum(["open", "resolved", "all"]).default("open"),
  source: z.enum(ERROR_SOURCES as unknown as [ErrorSource, ...ErrorSource[]]).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const LIST_COLS = `id::int, source, kind, message, route, status, count, first_seen AS "firstSeen", last_seen AS "lastSeen",
  last_request_id AS "lastRequestId", last_user_id AS "lastUserId", release, resolved_at AS "resolvedAt", resolved_by AS "resolvedBy"`;

router.get("/admin/app-errors", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "admin.errors"))) return;
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) throw badRequest("VALIDATION");
  const { status, source, q, limit, offset } = parsed.data;
  await ensureErrorTrackingSchema();
  const where: string[] = [];
  const params: unknown[] = [];
  if (status === "open") where.push("resolved_at IS NULL");
  if (status === "resolved") where.push("resolved_at IS NOT NULL");
  if (source) { params.push(source); where.push(`source = $${params.length}`); }
  if (q) { params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); where.push(`(message ILIKE $${params.length} OR route ILIKE $${params.length} OR kind ILIKE $${params.length})`); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [{ rows: items }, { rows: tot }, { rows: counts }] = await Promise.all([
    pool.query(`SELECT ${LIST_COLS} FROM app_errors ${w} ORDER BY last_seen DESC LIMIT ${limit} OFFSET ${offset}`, params),
    pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM app_errors ${w}`, params),
    pool.query<{ open: number; resolved: number; last24h: number }>(
      `SELECT COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
              COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved,
              COUNT(*) FILTER (WHERE resolved_at IS NULL AND last_seen > now() - interval '24 hours')::int AS last24h
         FROM app_errors`,
    ),
  ]);
  res.json({ items, total: tot[0]?.n ?? 0, counts: counts[0] ?? { open: 0, resolved: 0, last24h: 0 } });
}));

function parseId(raw: unknown): number {
  const s = String(raw ?? "");
  if (!/^\d{1,15}$/.test(s)) throw badRequest("INVALID_ID");
  return Number(s);
}

router.get("/admin/app-errors/:id", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "admin.errors"))) return;
  const id = parseId(req.params.id);
  await ensureErrorTrackingSchema();
  const { rows } = await pool.query(`SELECT ${LIST_COLS}, stack, user_agent AS "userAgent", alerted_at AS "alertedAt" FROM app_errors WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound();
  const { rows: occurrences } = await pool.query(
    `SELECT o.id::int, o.at, o.request_id AS "requestId", o.user_id AS "userId", u.name AS "userName", o.route, o.status, o.context
       FROM app_error_occurrences o LEFT JOIN users u ON u.id = o.user_id
      WHERE o.error_id = $1 ORDER BY o.at DESC LIMIT 20`,
    [id],
  );
  res.json({ occurrences, error: rows[0] }); // `error` = the error record (data, not an error answer)
}));

const ResolveBody = z.object({ resolved: z.boolean() });

router.post("/admin/app-errors/:id/resolve", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "admin.errors"))) return;
  const id = parseId(req.params.id);
  const parsed = ResolveBody.safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest("VALIDATION");
  await ensureErrorTrackingSchema();
  const actor = req.authUser!.name;
  const { rows } = await pool.query(
    `UPDATE app_errors SET resolved_at = ${parsed.data.resolved ? "now()" : "NULL"}, resolved_by = $2 WHERE id = $1 RETURNING ${LIST_COLS}`,
    [id, parsed.data.resolved ? actor : null],
  );
  if (!rows[0]) throw notFound();
  await logAudit({ actor, action: parsed.data.resolved ? "app_error.resolve" : "app_error.reopen", targetType: "app_error", targetId: String(id) });
  res.json({ occurrences: undefined, error: rows[0] }); // `error` = the error record (data)
}));

export default router;
