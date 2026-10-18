/**
 * The error middleware: the only place that turns a thrown error into an HTTP answer.
 * Registered LAST in app.ts: `app.use(errorMiddleware)`.
 *
 *   AppError                     → its status/code (+ details)
 *   ZodError                     → 400 VALIDATION, details: [{ path, message }]
 *   pg 23505 / 23503             → 409 CONFLICT
 *   pg 22P02                     → 400 BAD_REQUEST
 *   pg 57014 (statement timeout) → 503 TIMEOUT
 *   multer LIMIT_FILE_SIZE       → 413 TOO_LARGE; other multer errors → 400 UPLOAD_ERROR
 *   body-parser                  → 400 INVALID_JSON / 413 TOO_LARGE / other 4xx kept with a generic code
 *   CORS rejection               → 403 CORS_REJECTED
 *   anything else                → 500 INTERNAL (no message or stack to the client; logged with { err } + request id)
 */
import type { NextFunction, Request, Response } from "express";
import { logger } from "../logger";
import { langOf } from "../../i18n";
import { AppError, errorBody, requestIdOf, type ErrorCode } from "./errors";

type Loose = Record<string, unknown>;

const PG_CODES: Record<string, ErrorCode> = {
  "23505": "CONFLICT", // unique_violation
  "23503": "CONFLICT", // foreign_key_violation
  "22P02": "BAD_REQUEST", // invalid_text_representation (e.g. "abc"::int)
  "57014": "TIMEOUT", // query_canceled (statement_timeout)
};

/** 4xx status of a framework error (body-parser / http-errors) → code. */
const STATUS_CODES: Record<number, ErrorCode> = {
  400: "BAD_REQUEST",
  401: "AUTH_REQUIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "TOO_LARGE",
  429: "RATE_LIMITED",
};

function isZodError(err: unknown): err is { issues: Array<{ path: Array<string | number>; message: string }> } {
  return !!err && typeof err === "object" && (err as Loose).name === "ZodError" && Array.isArray((err as Loose).issues);
}

/** node-postgres DatabaseError: 5-char SQLSTATE plus server fields. */
function pgCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Loose;
  if (typeof e.code !== "string" || !/^[0-9A-Z]{5}$/.test(e.code)) return null;
  if (!("severity" in e) && !("routine" in e)) return null;
  return e.code;
}

function isMulterError(err: unknown): err is { code: string; field?: string } {
  return !!err && typeof err === "object" && (err as Loose).name === "MulterError" && typeof (err as Loose).code === "string";
}

/** body-parser / http-errors: numeric status + `expose` (client-safe) or a body-parser `type`. */
function frameworkStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Loose;
  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : null;
  if (status === null || status < 400 || status >= 500) return null;
  if (e.expose === true || typeof e.type === "string") return status;
  return null;
}

/** Validation issues in the shared `details` shape. */
export function zodDetails(issues: Array<{ path: Array<string | number>; message: string }>): Array<{ path: string; message: string }> {
  return issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** Map any thrown value to an AppError. `internal` = unexpected (log as error). */
export function toAppError(err: unknown): { appError: AppError; internal: boolean } {
  if (err instanceof AppError) return { appError: err, internal: err.status >= 500 && err.code === "INTERNAL" };
  if (isZodError(err)) return { appError: new AppError("VALIDATION", 400, undefined, zodDetails(err.issues)), internal: false };

  const pg = pgCode(err);
  if (pg) {
    const code = PG_CODES[pg];
    if (code) return { appError: new AppError(code), internal: code === "TIMEOUT" };
    return { appError: new AppError("INTERNAL"), internal: true };
  }

  if (isMulterError(err)) {
    if (err.code === "LIMIT_FILE_SIZE" || err.code === "LIMIT_FIELD_VALUE") return { appError: new AppError("TOO_LARGE"), internal: false };
    return { appError: new AppError("UPLOAD_ERROR", 400, undefined, { reason: err.code, ...(err.field ? { field: err.field } : {}) }), internal: false };
  }

  if (err instanceof Error && /^CORS\b/.test(err.message)) return { appError: new AppError("CORS_REJECTED"), internal: false };

  const status = frameworkStatus(err);
  if (status !== null) {
    const type = (err as Loose).type;
    if (type === "entity.parse.failed") return { appError: new AppError("INVALID_JSON"), internal: false };
    if (type === "entity.too.large") return { appError: new AppError("TOO_LARGE"), internal: false };
    return { appError: new AppError(STATUS_CODES[status] ?? "BAD_REQUEST", status), internal: false };
  }

  return { appError: new AppError("INTERNAL"), internal: true };
}

export function errorMiddleware(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const { appError, internal } = toAppError(err);
  const requestId = requestIdOf(req);
  if (internal) logger.error({ err, requestId, method: req.method, path: req.path }, "Unhandled route error");
  else if (appError.status >= 500) logger.warn({ err, requestId, code: appError.code }, "Route error");
  if (res.headersSent) {
    // Body already started (stream): let Express close the connection.
    next(err);
    return;
  }
  res.status(appError.status).json(errorBody(appError, langOf(req), requestId));
}
