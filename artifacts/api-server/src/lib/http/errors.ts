/**
 * The one API error contract.
 *
 *   throw notFound("TRADE_NOT_FOUND");               → 404 { error: "Сделка не найдена", code: "TRADE_NOT_FOUND" }
 *   throw badRequest("INVALID_ID");                  → 400 { error: "Некорректный идентификатор", code: "INVALID_ID" }
 *   throw forbidden("trades.write");                 → 403 { error: "…", code: "FORBIDDEN", details: { capability } }
 *   throw new AppError("CONFLICT", 409, undefined, { field: "name" });
 *
 * Handlers throw; only the error middleware (./middleware.ts) writes the body, translating `code` into the
 * request language (errors namespace, src/i18n/<lang>/errors.ts). `error` stays in the body because the
 * frontend shows it. Codes and their default statuses: ERROR_CODES below, documented in ./CODES.md.
 *
 * `sendError(res, err)` writes the same body without throwing — only for code that must answer inside a
 * try/catch or a helper that returns a boolean. New code throws.
 */
import type { Request, Response } from "express";
import type { Capability } from "../permissionsMatrix";
import { langOf, type Lang, type Params } from "../../i18n";
import { errorsT } from "../../i18n/ns";
import { personNameFor } from "../people/latinNames";
import type ruErrors from "../../i18n/ru/errors";

/** Default HTTP status of every code. Keys must match src/i18n/ru/errors.ts exactly (tsc checks both ways). */
export const ERROR_CODES = {
  BAD_REQUEST: 400,
  VALIDATION: 400,
  INVALID_JSON: 400,
  INVALID_ID: 400,
  INVALID_DATE: 400,
  INVALID_TICKER: 400,
  TICKER_REQUIRED: 400,
  INVALID_TRADER: 400,
  TRADER_REQUIRED: 400,
  NO_FIELDS: 400,
  UPLOAD_ERROR: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  GUEST_READ_ONLY: 403,
  STAFF_ONLY: 403,
  TRADE_FORBIDDEN: 403,
  CORS_REJECTED: 403,
  NOT_FOUND: 404,
  TRADE_NOT_FOUND: 404,
  TRADER_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  RESEARCH_NOT_FOUND: 404,
  EVENT_NOT_FOUND: 404,
  FEED_ENTRY_NOT_FOUND: 404,
  DISCUSSION_NOT_FOUND: 404,
  COMMENT_NOT_FOUND: 404,
  IDEA_NOT_FOUND: 404,
  COHORT_NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  CHECKLIST_ITEM_NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  AI_UNAVAILABLE: 502,
  TIMEOUT: 503,
  // ── server-a (translation wave) ──
  NAME_REQUIRED: 400,
  NAME_TOO_LONG: 400,
  DAY_IN_FUTURE: 400,
  RULE_NOT_FOUND: 404,
  RULE_KIND_INVALID: 400,
  RULE_THRESHOLD_INVALID: 400,
  RULE_TICKERS_REQUIRED: 400,
  RULE_TICKERS_INVALID: 400,
  RULE_TIME_INVALID: 400,
  RULE_NUMBER_INVALID: 400,
  RULE_WINDOW_ORDER: 400,
  RULE_FACTOR_MIN: 400,
  RULES_OWN_ONLY: 403,
  RULE_DESK_STAFF_ONLY: 403,
  RULE_EDIT_OWN_ONLY: 403,
  RULE_OFFICE_LOCKED: 403,
  VIOLATION_UNACK_STAFF_ONLY: 403,
  VIOLATION_DECISION_STAFF_ONLY: 403,
  VIOLATION_DISMISS_STAFF_ONLY: 403,
  CHECKLIST_NOT_FOUND: 404,
  CHECKLIST_FORBIDDEN: 403,
  CHECKLIST_ALREADY_LINKED: 409,
  CHECKLIST_RESPONSES_REQUIRED: 400,
  SETUP_SUGGESTION_MISSING: 409,
  DATE_RANGE_INVALID: 400,
  TRIGGER_NOT_FOUND: 404,
  TRIGGER_KIND_INVALID: 400,
  TRIGGER_PARAM_RANGE: 400,
  TRIGGER_TEXT_REQUIRED: 400,
  TRIGGERS_OWN_ONLY: 403,
  WEEKLY_REPORT_OWN_ONLY: 403,
  WEEKLY_REPORT_WEEK_LOCKED: 400,
  PROMOTION_SELF_ONLY: 403,
  STAGE_NOT_ASSIGNED: 400,
  STAGE_TOP: 400,
  STAGE_ALREADY: 409,
  PROMOTION_PENDING_EXISTS: 409,
  PROMOTION_REQUEST_NOT_FOUND: 404,
  PROMOTION_REQUEST_DECIDED: 409,
  PROMOTION_SELF_APPROVE: 403,
  PROMOTION_COMMENT_REQUIRED: 400,
  PROMOTION_STAGE_CHANGED: 409,
  PROMOTION_REJECT_REASON: 400,
  CHALLENGE_NOT_FOUND: 404,
  CHALLENGE_TEMPLATE_NOT_FOUND: 400,
  CHALLENGE_RULES_INVALID: 400,
  COHORT_NAME_TAKEN: 409,
  COHORT_NAME_TAKEN_ACTIVE: 409,
  ALREADY_ENROLLED: 409,
  SESSION_ROOM_REQUIRED: 400,
  SESSION_URL_REQUIRED: 400,
  SESSION_ROOM_URL_REQUIRED: 400,
  RANGE_TOO_LONG: 400,
  NOT_SESSION_DAY: 400,
  SESSION_NOT_STARTED: 400,
  OFFICE_ONLY: 400,
  NOT_ENROLLED: 403,
  NO_OCCURRENCE: 400,
  TOO_EARLY: 409,
  TOO_LATE: 409,
  MEETING_NOT_FOUND: 404,
  ACTION_NOT_FOUND: 404,
  GOAL_NOT_FOUND: 404,
  ACTION_STUDENT_DONE_ONLY: 403,
  GOAL_STUDENT_MANUAL_ONLY: 403,
  GOAL_STATUS_MANUAL: 400,
  PROGRAM_NOT_FOUND: 404,
  MODULE_NOT_FOUND: 404,
  SUBMISSION_NOT_FOUND: 404,
  QUIZ_ANSWERS_REQUIRED: 400,
  QUIZ_EMPTY: 400,
  QUIZ_NO_ATTEMPTS: 400,
  CONTENT_INVALID: 400,
  TRADES_NOT_YOURS: 400,
  INVALID_URL: 400,
  VIDEO_URL_UNSUPPORTED: 400,
  SUBMISSION_EMPTY: 400,
  SUBMISSION_MIN_TRADES: 400,
  SUBMISSION_GRADED_EDIT: 409,
  SUBMISSION_GRADED: 409,
  SUBMISSION_GRADED_WITHDRAW: 409,
  ASSIGNMENT_NO_RUBRIC: 400,
  RUBRIC_INCOMPLETE: 400,
  RETURN_COMMENT_REQUIRED: 400,
  // ── server-b (translation wave) ──
  INVALID_FIELD: 400,
  IDS_REQUIRED: 400,
  MUTE_TOO_LONG: 400,
  NOTIFICATION_NOT_FOUND: 404,
  CANNOT_CHANGE_OWN_ROLE: 400,
  CANNOT_BAN_ADMIN: 403,
  CANNOT_BAN_SELF: 400,
  ADMIN_ONLY_BAN_CURATOR: 403,
  REPORTER_BANNED: 403,
  REPORT_NOT_FOUND: 404,
  REPORT_AUTHOR_NOT_FOUND: 409,
  FILE_REQUIRED: 400,
  XLS_PARSE_FAILED: 400,
  XLS_NO_TRADES: 400,
  ACCOUNT_LINKED_TO_OTHER: 400,
  INVALID_LOCALE: 400,
  ADMIN_ONLY: 403,
  USER_NAME_TAKEN: 409,
  CANNOT_DEACTIVATE_SELF: 400,
  PASSWORD_CHANGE_REQUIRED: 403,
  GUEST_NO_PERSONAL: 403,
  PERSONAL_DATA_FORBIDDEN: 403,
  GUEST_DISABLED: 403,
  INIT_PASSWORDS_DISABLED: 503,
  ADMIN_PASSWORD_REQUIRED: 403,
  INIT_PASSWORDS_MISSING: 400,
  NOT_OWNER: 403,
  ai_not_configured: 503,
  MISTAKES_OWN_ONLY: 403,
  MISTAKE_EDIT_OWN_ONLY: 403,
  MISTAKE_DELETE_OWN_ONLY: 403,
  TEXT_TOO_LONG: 400,
  DESCRIPTION_REQUIRED: 400,
  TRADE_NOT_OWNED: 400,
  TRADE_IDS_REQUIRED: 400,
  CANNOT_APPLY_TO_SELF: 400,
  CANNOT_FREEZE_ADMIN: 403,
  ADMIN_ONLY_FREEZE_CURATOR: 403,
  ALREADY_FROZEN: 409,
  NOT_FROZEN: 409,
  ALREADY_ARCHIVED: 409,
  ADMIN_ONLY_ARCHIVE_CURATOR: 403,
  ALREADY_ACTIVE: 409,
  CURATOR_NOT_ACTIVE: 400,
  CANNOT_SELF_CURATOR: 400,
  CURATOR_ALREADY_ASSIGNED: 409,
  UNKNOWN_ROLE: 400,
  ROLE_UNCHANGED: 409,
  UNKNOWN_USER: 400,
  REASON_REQUIRED: 400,
  USER_NAME_REQUIRED: 400,
  PASSWORD_TOO_SHORT: 400,
  NAME_LATIN_CHARS: 400,
  NAME_LATIN_INVALID_FOR: 400,
  BREACH_NOT_FOUND: 404,
  BREACH_REVIEW_NOT_FOUND: 404,
  AGREEMENT_NOT_FOUND: 404,
  NOTE_EMPTY: 400,
  NOTE_NOT_FOUND: 404,
  NOTE_AUTHOR_ONLY: 403,
  TIER_KEY_DUPLICATE: 400,
  TIER_NOT_FOUND: 400,
  SCALING_OWN_ONLY: 403,
  TRADER_NO_DATA: 404,
  PROPOSAL_PENDING: 409,
  PROPOSAL_TARGET_REQUIRED: 400,
  ALREADY_ON_TIER: 400,
  PROPOSAL_NOT_FOUND: 404,
  PROPOSAL_DECIDED: 409,
  PROPOSAL_TIER_GONE: 400,
  AUDIENCE_INVALID: 400,
  AUDIENCE_UNKNOWN: 400,
  AUDIENCE_TOO_MANY: 400,
  AUDIENCE_FILTER_INVALID: 400,
  COHORT_OWN_ONLY: 400,
  TOPIC_REQUIRED: 400,
  BANNED_ACTION: 403,
  TRADE_NOT_YOURS: 403,
  DISCUSSION_AUTHOR_ONLY: 403,
  PIN_STAFF_ONLY: 403,
  COMMENT_NOT_IN_THREAD: 404,
  COMMENT_EMPTY: 400,
  COMMENT_OWN_ONLY: 403,
  EOD_OWN_ONLY: 403,
  INVALID_RANGE: 400,
  TRADE_REVIEW_OWN_ONLY: 403,
  EOD_DAY_CLOSED: 409,
  EOD_ALREADY_CLOSED: 409,
  EOD_FUTURE_DAY: 422,
  EOD_INCOMPLETE: 422,
  EOD_DAY_NOT_FOUND: 404,
  EOD_NOT_CLOSED: 409,
  INVALID_WEEK: 400,
  FUTURE_WEEK: 400,
  SCORE_RANGE: 400,
  RATING_NOT_FOUND: 404,
  RATING_OWN_ONLY: 403,
  RATING_ACK_TRADER_ONLY: 403,
  WEEKLY_OWN_ONLY: 403,
  SELF_REVIEW_TRADER_ONLY: 403,
  GOALS_OWN_ONLY: 403,
  WEEKLY_NOT_FOUND: 404,
  ASSIGNEE_NOT_STAFF: 400,
  IDEA_COMMENT_DELETE_FORBIDDEN: 403,
  FIELD_REQUIRED: 400,
  TOO_MANY: 400,
  AUTHOR_OR_STAFF_ONLY: 403,
  OWN_TRADES_ONLY: 403,
  OWN_DATA_ONLY: 403,
  MEMBERS_ONLY: 403,
  GUEST_UNAVAILABLE: 403,
  UPSTREAM_FAILED: 502,
  NO_DATA: 404,
  ALREADY_IN_WATCHLIST: 409,
  SETUP_NOT_FOUND: 404,
  EXAMPLE_NOT_FOUND: 404,
  PLAN_NOT_FOUND: 404,
  VOICE_NOTE_NOT_FOUND: 404,
  DOC_NOT_FOUND: 404,
  TEMPLATE_NOT_FOUND: 404,
  SCENARIO_NOT_FOUND: 404,
  ACCOUNT_NOT_FOUND: 404,
  AI_COOLDOWN: 429,
  MEDIA_DAILY_LIMIT: 429,
  IMAGE_TYPE: 400,
  AUDIO_REQUIRED: 400,
  DUPLICATE: 409,
  SYNC_RUNNING: 409,
  NOT_AVAILABLE_YET: 503,
  STORAGE_FAILED: 502,
  WRONG_PASSWORD: 403,
  NOT_CONFIGURED: 503,
  EDITED_ELSEWHERE: 409,
  SELECT_AT_LEAST_ONE: 400,
  NAME_REQUIRED_GENERIC: 400,
  GENERATION_FAILED: 502,
  COMPUTE_FAILED: 500,
  STAFF_COMPARE_ONLY: 403,
  INVALID_SYMBOL: 400,
  NO_TASKS: 404,
  NON_TRADING_DAY: 400,
  ACCOUNT_NOT_YOURS: 403,
  OWN_ENTRY: 400,
  SETUP_EDITOR_ONLY: 403,
  OFFICE_SETUP_NO_AUTHOR: 400,
  TICKER_NOT_IN_SEC: 404,
  SETUP_TEXT_REQUIRED: 400,
  SETUP_ALREADY_OFFICE: 409,
  NOTES_ACCESS: 403,
  SETUP_OWN_ONLY: 403,
  REPORT_PARSE_FAILED: 400,
  REPORT_PERIOD_UNKNOWN: 400,
  REPORT_ACCOUNT_UNKNOWN: 400,
  OWN_JUNIORS_ONLY: 403,
  IDEA_ALREADY_TRADED: 409,
  EXAMPLE_SETUP_FORBIDDEN: 403,
  OFFICE_PLAYBOOK_STAFF_ONLY: 403,
  SHARE_SENIOR_ONLY: 403,
  FILLS_CSV_REQUIRED: 400,
  REVIEW_DELETE_OWN_ONLY: 403,
  UPSTREAM_UNAVAILABLE: 503,
  SYNC_PENDING: 409,
  JOURNAL_CONFLICT: 409,
  REVIEWER_ONLY: 403,
  RATE_REVIEWER_ONLY: 403,
  EXPIRATION_NOT_FOUND: 404,
  IMAGE_TOO_LARGE: 413,
  IMAGE_UNREADABLE: 400,
  OFFICE_ALREADY_PUBLIC: 403,
  OFFICE_PLAYBOOK_STAFF_EDIT: 403,
  FOLDER_EXISTS: 409,
  IDEA_CONVERT_RETIRED: 410,
  AUDIO_TYPE: 415,
  PENDING_NOT_FOUND: 404,
  TRADE_ALREADY_LINKED: 409,
  TRADE_OTHER_TRADER: 409,
  BROKER_TRADE_EXISTS: 409,
  PROPREPORTS_NOT_CONFIGURED: 503,
  FILE_TYPE: 400,
  TRADES_REPORT_EMPTY: 400,
  CHECKLIST_REQUIRED: 422,
  CHECKLIST_NOT_PASSED: 422,
  CHECKLIST_MISMATCH: 422,
  CHECKLIST_INVALID_ID: 422,
  PROMOTE_STAFF_ONLY: 403,
  DESK_TEMPLATES_STAFF_ONLY: 403,
  DESK_PLAN_MEDIA_UPLOAD_STAFF_ONLY: 403,
  DESK_PLAN_MEDIA_DELETE_STAFF_ONLY: 403,
  FEED_GENERATE_STAFF_ONLY: 403,
  PERMISSIONS_CELLS_REJECTED: 400,
  DAILY_NOTHING_TO_DISPUTE: 409,
} as const satisfies Record<keyof typeof ruErrors, number>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(ERROR_CODES, v);
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Interpolation values for the message ({name} placeholders in the dictionary). */
  readonly params?: Params;
  /** Machine-readable extras sent as `details` (validation issues, capability, field…). */
  readonly details?: unknown;

  constructor(code: ErrorCode, status?: number, params?: Params, details?: unknown) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.status = status ?? ERROR_CODES[code];
    this.params = params;
    this.details = details;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

// ─── Helpers (return the error: `throw notFound()`) ──────────────────────────────────────────────────────

export const badRequest = (code: ErrorCode = "BAD_REQUEST", details?: unknown, params?: Params) =>
  new AppError(code, 400, params, details);

export const notFound = (code: ErrorCode = "NOT_FOUND", params?: Params) => new AppError(code, 404, params);

export const unauthorized = () => new AppError("AUTH_REQUIRED", 401);

/** 403. With a capability the body carries `details.capability` (the frontend can name the missing right). */
export const forbidden = (cap?: Capability, code: ErrorCode = "FORBIDDEN") =>
  new AppError(code, 403, undefined, cap ? { capability: cap } : undefined);

export const conflict = (code: ErrorCode = "CONFLICT", details?: unknown, params?: Params) =>
  new AppError(code, 409, params, details);

export const tooLarge = (code: ErrorCode = "TOO_LARGE") => new AppError(code, 413);

// ─── Body ────────────────────────────────────────────────────────────────────────────────────────────────

export type ErrorBody = { error: string; code: ErrorCode; details?: unknown; requestId?: string };

/** Error params that carry a person's stored name (ALREADY_ENROLLED, ACCOUNT_LINKED_TO_OTHER, CURATOR_NOT_ACTIVE…). */
const PERSON_ERROR_PARAMS = ["user", "owner", "trader", "curator", "actor", "author", "who"] as const;

/** Person names in error params as the reader sees them (Latin for EN / UZ); `details` keep the stored names. */
function withPersonNames(params: Params | undefined, lang: Lang | null | undefined): Params | undefined {
  if (!params || !lang || lang === "ru") return params;
  let out: Params | null = null;
  for (const k of PERSON_ERROR_PARAMS) {
    const v = params[k];
    if (typeof v === "string" && v) (out ??= { ...params })[k] = personNameFor(v, lang);
  }
  return out ?? params;
}

/** Localized text of a code. */
export function errorMessage(code: ErrorCode, lang: Lang | null | undefined, params?: Params): string {
  return errorsT.tryFor(lang, code, withPersonNames(params, lang)) ?? code;
}

/** The response body for an AppError in `lang`. `requestId` is added for 5xx (the user can quote it). */
export function errorBody(err: AppError, lang: Lang | null | undefined, requestId?: string): ErrorBody {
  const body: ErrorBody = { error: errorMessage(err.code, lang, err.params), code: err.code };
  if (err.details !== undefined) body.details = err.details;
  if (err.status >= 500 && requestId) body.requestId = requestId;
  return body;
}

/** pino-http request id (string or number) as a string, if any. */
export function requestIdOf(req: Request | undefined): string | undefined {
  const id = (req as (Request & { id?: unknown }) | undefined)?.id;
  return id === undefined || id === null || id === "" ? undefined : String(id);
}

/**
 * Write an AppError as the response (same body as the middleware) and return `res`.
 * Use only where throwing is not possible (inside try/catch that would swallow it, boolean helpers).
 */
export function sendError(res: Response, err: AppError): Response {
  const req = res.req as Request | undefined;
  const lang = req ? langOf(req) : undefined;
  return res.status(err.status).json(errorBody(err, lang, requestIdOf(req)));
}

/**
 * sendError plus extra TOP-LEVEL fields that existing clients read from the error body (`existingId`, `current`,
 * `retryAfterSec`, `retryAfterMs`…). New code puts extras into `details`; this exists so old contracts keep working
 * while the text is translated by code.
 */
export function sendErrorWith(res: Response, err: AppError, extra: Record<string, unknown>): Response {
  const req = res.req as Request | undefined;
  const lang = req ? langOf(req) : undefined;
  return res.status(err.status).json({ ...extra, ...errorBody(err, lang, requestIdOf(req)) });
}
