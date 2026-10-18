/**
 * Internal error tracking (owner decision 2026-10-17: no third-party service).
 *
 *   app_errors              one row per fingerprint: message, route, stack, count, first/last seen, resolved state
 *   app_error_occurrences   the last OCCURRENCES_KEPT hits of each fingerprint (request id, user id, route, status)
 *
 * Sources: "server" (5xx from the error middleware, failed responses, crashes), "client" (ErrorBoundary, window
 * error / unhandledrejection, API calls that answered ≥ 500 — POST /api/client-errors) and "csp" (CSP violation
 * reports — POST /api/csp-report).
 *
 * Privacy: query strings, bearer/JWT tokens, secrets in key=value / JSON, e-mails and long digit runs (PINs) are
 * scrubbed before anything is stored or sent; lengths are capped. Never throws into the caller.
 *
 * Alerts: a NEW fingerprint (or a resolved one that came back) → Telegram message to active admins with a linked
 * chat — ONLY when NODE_ENV=production and TELEGRAM_BOT_TOKEN is set. Locally the alert is logged instead.
 * At most ALERTS_PER_HOUR alerts per process.
 *
 * Schema: idempotent ensure until B4's migration runner exists (TODO(B4): move into a numbered migration).
 */
import { createHash } from "node:crypto";
import type { Request } from "express";
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { localeOfUser } from "../i18n";
import { securityT } from "./security/i18n";
import { config } from "../config";

export type ErrorSource = "server" | "client" | "csp";
export const ERROR_SOURCES: readonly ErrorSource[] = ["server", "client", "csp"];

export type ErrorEvent = {
  source: ErrorSource;
  /** Error class / client kind («TypeError», «render», «api», «csp:script-src»). */
  kind: string;
  message: string;
  stack?: string | null;
  /** «GET /api/trades/:n» on the server, the page path on the client. */
  route?: string | null;
  status?: number | null;
  requestId?: string | null;
  userId?: number | null;
  userAgent?: string | null;
  release?: string | null;
  context?: Record<string, unknown> | null;
};

const MAX_MESSAGE = 1000;
const MAX_STACK = 8000;
const MAX_ROUTE = 300;
const MAX_CONTEXT = 4000;
export const OCCURRENCES_KEPT = 50;
export const ALERTS_PER_HOUR = 10;

// ─── Scrubbing (pure) ───────────────────────────────────────────────────────────────────────────────────

const SECRET_KEYS = "password|passwd|pwd|pin|secret|token|access_token|media_token|authorization|api[_-]?key|cookie|currentPassword|newPassword|adminPassword";

/** Remove secrets and personal data from free text. */
export function scrub(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[jwt]")
    .replace(new RegExp(`(["']?(?:${SECRET_KEYS})["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,&;}]+)`, "gi"), "$1[redacted]")
    .replace(/(https?:\/\/[^\s?#"']+|\/api\/[^\s?#"']*)\?[^\s#"']*/g, "$1")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b\d{6,}\b/g, "[num]");
}

function cap(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  const v = String(s);
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

/** Path without query/hash, ids collapsed: «/api/trades/123/reviews?x=1» → «/api/trades/:n/reviews». */
export function normalizeRoute(path: string): string {
  return path
    .split(/[?#]/)[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, "/:uuid")
    .replace(/\/\d+(?=\/|$)/g, "/:n")
    .replace(/\/\d{4}-\d{2}-\d{2}(?=\/|$)/g, "/:date");
}

/** Message with volatile parts replaced, so «id 41 not found» and «id 42 not found» group together. */
export function messageShape(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/"[^"]{0,200}"|'[^']{0,200}'|«[^»]{0,200}»/g, "<str>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .slice(0, 300);
}

/** First stack frame that points at our code, without line/column numbers (they move with every build). */
export function topFrame(stack: string | null | undefined): string {
  if (!stack) return "";
  for (const line of stack.split("\n").slice(1)) {
    const l = line.trim();
    if (!l || /node_modules|node:internal|<anonymous>/.test(l)) continue;
    return l.replace(/:\d+:\d+\)?$/, "").replace(/\?[^\s)]*/, "").replace(/-[A-Za-z0-9_]{8}\.js/, ".js").slice(0, 200);
  }
  return "";
}

export function fingerprintOf(e: Pick<ErrorEvent, "source" | "kind" | "message" | "stack" | "route">): string {
  const parts = [e.source, e.kind, messageShape(e.message), topFrame(e.stack), e.route ? normalizeRoute(e.route) : ""];
  return createHash("sha1").update(parts.join("|")).digest("hex");
}

/** Clean, capped copy of an event (what is stored and alerted). */
export function sanitizeEvent(e: ErrorEvent): ErrorEvent {
  let context: Record<string, unknown> | null = null;
  if (e.context && typeof e.context === "object") {
    const json = scrub(JSON.stringify(e.context));
    context = json.length <= MAX_CONTEXT ? (JSON.parse(json) as Record<string, unknown>) : { truncated: cap(json, MAX_CONTEXT) };
  }
  return {
    source: e.source,
    kind: cap(scrub(e.kind || "Error"), 100) ?? "Error",
    message: cap(scrub(e.message || "(no message)"), MAX_MESSAGE) ?? "(no message)",
    stack: cap(e.stack ? scrub(e.stack) : null, MAX_STACK),
    route: cap(e.route ? normalizeRoute(scrub(e.route)) : null, MAX_ROUTE),
    status: Number.isInteger(e.status) ? e.status : null,
    requestId: cap(e.requestId ?? null, 64),
    userId: Number.isInteger(e.userId) && (e.userId as number) > 0 ? e.userId : null,
    userAgent: cap(e.userAgent ?? null, 300),
    release: cap(e.release ?? null, 64),
    context,
  };
}

// ─── Storage ────────────────────────────────────────────────────────────────────────────────────────────

let schemaReady: Promise<void> | null = null;
export function ensureErrorTrackingSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS app_errors (
        id              BIGSERIAL PRIMARY KEY,
        fingerprint     TEXT NOT NULL UNIQUE,
        source          TEXT NOT NULL CHECK (source IN ('server', 'client', 'csp')),
        kind            TEXT NOT NULL,
        message         TEXT NOT NULL,
        route           TEXT NULL,
        status          INTEGER NULL,
        stack           TEXT NULL,
        count           INTEGER NOT NULL DEFAULT 1,
        first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_request_id TEXT NULL,
        last_user_id    INTEGER NULL,
        user_agent      TEXT NULL,
        release         TEXT NULL,
        resolved_at     TIMESTAMPTZ NULL,
        resolved_by     TEXT NULL,
        alerted_at      TIMESTAMPTZ NULL
      )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS app_errors_last_seen_idx ON app_errors (last_seen DESC)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS app_error_occurrences (
        id          BIGSERIAL PRIMARY KEY,
        error_id    BIGINT NOT NULL REFERENCES app_errors(id) ON DELETE CASCADE,
        at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        request_id  TEXT NULL,
        user_id     INTEGER NULL,
        route       TEXT NULL,
        status      INTEGER NULL,
        context     JSONB NULL
      )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS app_error_occurrences_error_idx ON app_error_occurrences (error_id, at DESC)`);
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

export type RecordResult = { id: number; fingerprint: string; isNew: boolean; reopened: boolean; count: number };

/** Upsert by fingerprint + one occurrence row. Returns null when the DB is unavailable (logged, never thrown). */
export async function recordError(raw: ErrorEvent): Promise<RecordResult | null> {
  const e = sanitizeEvent(raw);
  const fingerprint = fingerprintOf(e);
  try {
    await ensureErrorTrackingSchema();
    const { rows } = await pool.query<{ id: string; count: number; inserted: boolean; reopened: boolean }>(
      `WITH prev AS (SELECT resolved_at FROM app_errors WHERE fingerprint = $1)
       INSERT INTO app_errors AS a (fingerprint, source, kind, message, route, status, stack, last_request_id, last_user_id, user_agent, release)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (fingerprint) DO UPDATE SET
         count = a.count + 1,
         last_seen = now(),
         message = EXCLUDED.message,
         status = COALESCE(EXCLUDED.status, a.status),
         stack = COALESCE(EXCLUDED.stack, a.stack),
         last_request_id = COALESCE(EXCLUDED.last_request_id, a.last_request_id),
         last_user_id = COALESCE(EXCLUDED.last_user_id, a.last_user_id),
         user_agent = COALESCE(EXCLUDED.user_agent, a.user_agent),
         release = COALESCE(EXCLUDED.release, a.release),
         resolved_at = NULL,
         resolved_by = NULL
       RETURNING id, count, (xmax = 0) AS inserted, ((SELECT resolved_at FROM prev) IS NOT NULL) AS reopened`,
      [fingerprint, e.source, e.kind, e.message, e.route, e.status, e.stack, e.requestId, e.userId, e.userAgent, e.release],
    );
    const row = rows[0];
    const id = Number(row.id);
    await pool.query(
      `INSERT INTO app_error_occurrences (error_id, request_id, user_id, route, status, context) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, e.requestId, e.userId, e.route, e.status, e.context ? JSON.stringify(e.context) : null],
    );
    if (row.count % 10 === 1) {
      await pool.query(
        `DELETE FROM app_error_occurrences WHERE error_id = $1 AND id NOT IN (
           SELECT id FROM app_error_occurrences WHERE error_id = $1 ORDER BY at DESC LIMIT ${OCCURRENCES_KEPT})`,
        [id],
      );
    }
    const result = { id, fingerprint, isNew: !!row.inserted, reopened: !!row.reopened, count: Number(row.count) };
    if (result.isNew || result.reopened) void alertAdmins(e, result).catch((err) => logger.warn({ err: (err as Error)?.message }, "error alert failed"));
    return result;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, fingerprint }, "error tracking: record failed");
    return null;
  }
}

// ─── Alerts ─────────────────────────────────────────────────────────────────────────────────────────────

const alertTimes: number[] = [];

/** Should an alert actually be sent to Telegram in this environment? (production + bot token only) */
export function alertsEnabled(c: { isProduction: boolean; telegram: { botToken: string } } = config): boolean {
  return c.isProduction && !!c.telegram.botToken.trim();
}

/** Sliding one-hour budget (pure apart from the shared array; exported for tests). */
export function takeAlertBudget(now = Date.now(), times: number[] = alertTimes, perHour = ALERTS_PER_HOUR): boolean {
  while (times.length && now - times[0] > 3600_000) times.shift();
  if (times.length >= perHour) return false;
  times.push(now);
  return true;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Telegram text in the recipient's language (HTML parse mode). */
export function alertText(e: ErrorEvent, r: Pick<RecordResult, "id" | "count">, lang: Parameters<typeof securityT.tFor>[0], siteUrl: string | null): string {
  const t = securityT.tFor(lang);
  const lines = [
    `<b>${escHtml(e.source === "server" ? t("alert.title") : t("alert.titleClient"))}</b>`,
    `<code>${escHtml(`${e.kind}: ${e.message}`.slice(0, 400))}</code>`,
  ];
  if (e.route) lines.push(escHtml(t("alert.route", { route: e.route })));
  if (r.count > 1) lines.push(escHtml(t("alert.count", { count: r.count })));
  if (siteUrl) lines.push(escHtml(t("alert.open", { url: `${siteUrl}/admin?tab=errors&error=${r.id}` })));
  return lines.join("\n");
}

async function alertAdmins(e: ErrorEvent, r: RecordResult): Promise<void> {
  if (!alertsEnabled()) {
    logger.info({ fingerprint: r.fingerprint, source: e.source, kind: e.kind, route: e.route }, "error alert (not sent: Telegram alerts run only in production with a bot token)");
    return;
  }
  if (!takeAlertBudget()) {
    logger.warn({ fingerprint: r.fingerprint }, "error alert skipped: hourly budget used up");
    return;
  }
  const { rows } = await pool.query<{ id: number; telegram_chat_id: string }>(
    `SELECT id, telegram_chat_id FROM users
      WHERE role = 'admin' AND active = true AND COALESCE(banned, false) = false
        AND telegram_chat_id IS NOT NULL AND telegram_chat_id <> '' AND COALESCE(tg_notifications_enabled, true) = true`,
  );
  if (!rows.length) return;
  const { sendMessage } = await import("./telegramBot");
  const site = config.siteUrl.replace(/\/+$/, "") || null;
  for (const admin of rows) {
    await sendMessage(admin.telegram_chat_id, alertText(e, r, await localeOfUser(admin.id), site));
  }
  await pool.query(`UPDATE app_errors SET alerted_at = now() WHERE id = $1`, [r.id]);
}

// ─── Capture helpers ────────────────────────────────────────────────────────────────────────────────────

/** Build / deploy id stored with each event (RELEASE_SHA or REPLIT_DEPLOYMENT_ID). */
export function releaseId(): string | null {
  return config.release;
}

/** «POST /api/trades/:id» — the matched route pattern when Express knows it, else the normalized path. */
export function routeOf(req: Request): string {
  const pattern = req.route?.path && typeof req.route.path === "string" ? `${req.baseUrl}${req.route.path}` : req.originalUrl ?? req.url;
  return `${req.method} ${normalizeRoute(pattern)}`;
}

function requestIdOf(req: Request): string | null {
  const id = (req as Request & { id?: unknown }).id;
  return id == null || id === "" ? null : String(id);
}

/** Marks a request whose failure is already recorded, so the response hook doesn't record it again. */
const CAPTURED = Symbol.for("ws.errorCaptured");

/** 5xx from the error middleware (with stack). */
export function captureServerError(err: unknown, req: Request, status = 500): Promise<RecordResult | null> {
  (req as unknown as Record<symbol, boolean>)[CAPTURED] = true;
  const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Non-Error thrown");
  return recordError({
    source: "server",
    kind: e.name || "Error",
    message: e.message,
    stack: e.stack ?? null,
    route: routeOf(req),
    status,
    requestId: requestIdOf(req),
    userId: req.authUser?.id ?? null,
    release: releaseId(),
  });
}

/** A route answered ≥ 500 by itself (no thrown error reached the middleware). */
export function captureFailedResponse(req: Request, status: number): Promise<RecordResult | null> | null {
  if ((req as unknown as Record<symbol, boolean>)[CAPTURED]) return null;
  return recordError({
    source: "server",
    kind: `HTTP ${status}`,
    message: `Response ${status}`,
    route: routeOf(req),
    status,
    requestId: requestIdOf(req),
    userId: req.authUser?.id ?? null,
    release: releaseId(),
  });
}

/** uncaughtException / unhandledRejection (no request). */
export function captureProcessError(err: unknown, kind: "uncaughtException" | "unhandledRejection"): Promise<RecordResult | null> {
  const e = err instanceof Error ? err : new Error(String(err));
  return recordError({ source: "server", kind: `${kind}:${e.name || "Error"}`, message: e.message, stack: e.stack ?? null, release: releaseId() });
}
