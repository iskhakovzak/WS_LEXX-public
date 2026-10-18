import type { Response } from "express";

/**
 * Error answers of the sign-in / secrets flow. Their codes (INVALID_CREDENTIALS, LOGIN_LOCKED, WEAK_PASSWORD,
 * PASSWORD_CHANGE_REQUIRED …) carry extra fields the login screen needs (retryAfterSec, policy), and their texts
 * come from the `security` namespace, so they are written here instead of going through lib/http AppError.
 * TODO(B3): fold these codes into the ERROR_CODES registry once AppError can carry extra top-level fields.
 */
export function sendSecurityError(res: Response, status: number, code: string, error: string, extra?: Record<string, unknown>): void {
  res.status(status).json({ error, code, ...extra });
}
