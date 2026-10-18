/**
 * One place that turns whatever the API (or fetch) threw into a sentence in the UI language, and decides retries.
 *
 *   humanizeApiError(err)                 → "Сначала заполните пре-трейд чек-лист" / "Fill in the pre-trade checklist first"
 *   humanizeApiError(err, fallback)       → `fallback` when nothing better than the generic text is known
 *   apiErrorStatus(err) / apiErrorCode(err) → for branching (e.g. open the checklist dialog on CHECKLIST_REQUIRED)
 *   shouldRetryQuery / retryDelay         → QueryClient defaults: never retry 4xx, retry network / 5xx with backoff
 *
 * Message order (contract: artifacts/api-server/src/lib/http/CODES.md): the server's `error` text when it is in the UI
 * language (the server translates it by `X-Lang`); else `apiErrors.codes.<code>`; else a known old English message;
 * else the text for the HTTP status; else a generic line.
 *
 * Accepts: `ApiError` from `lib/api/http` and from the generated client (`{status, data:{error,code}}`), a plain Error
 * whose message is "HTTP 403 Forbidden: Only curators…" or a raw JSON string, a Response, a string, or a body object.
 */
import { getLang } from "@/i18n";
import { apiErrorsI18n } from "@/i18n/ns/apiErrors";
import { ApiError, CLIENT_CODES } from "./http";

export type ApiErrorInfo = {
  status: number | null;
  code: string | null;
  /** Raw server message (any language). */
  raw: string | null;
  /** Text for people, in the UI language. */
  message: string;
  isNetwork: boolean;
};

/** Old English server messages (substring, case-insensitive; the longest match wins) → dictionary key. */
const LEGACY_MESSAGES: Array<[string, string]> = [
  ["pre-trade checklist required", "codes.CHECKLIST_REQUIRED"],
  ["checklist required", "codes.CHECKLIST_REQUIRED"],
  ["only curators and admins can review ideas", "legacy.curatorsReviewIdeas"],
  ["only curators can leave reviews", "legacy.curatorsLeaveReviews"],
  ["only curators can rate", "legacy.curatorsRate"],
  ["only curators", "legacy.curatorsOnly"],
  ["curator or admin role required", "legacy.curatorsOnly"],
  ["admin password required", "legacy.adminPasswordRequired"],
  ["authentication required", "codes.AUTH_REQUIRED"],
  ["not authenticated", "codes.AUTH_REQUIRED"],
  ["invalid credentials", "codes.INVALID_CREDENTIALS"],
  ["user is banned", "codes.BANNED"],
  ["not authorized", "codes.FORBIDDEN"],
  ["forbidden", "codes.FORBIDDEN"],
  ["not your trade", "legacy.notYourTrade"],
  ["not found", "codes.NOT_FOUND"],
  ["invalid request", "codes.VALIDATION"],
  ["invalid id", "codes.INVALID_ID"],
  ["validation", "codes.VALIDATION"],
  ["too many requests", "codes.RATE_LIMITED"],
  ["rate limit", "codes.RATE_LIMITED"],
  ["internal server error", "codes.INTERNAL"],
  ["did you forget to provision the anthropic ai integration", "codes.ai_not_configured"],
  ["ai_integrations_anthropic", "codes.ai_not_configured"],
  ["failed to fetch", "codes.NETWORK"],
  ["networkerror", "codes.NETWORK"],
  ["load failed", "codes.NETWORK"],
  ["unexpected token", "codes.BAD_RESPONSE"],
  ["failed to parse response", "codes.BAD_RESPONSE"],
];

const CYRILLIC = /[Ѐ-ӿ]/;
/** Technical dumps (a serialized zod issue list, a stack trace) are not messages for people. */
const TECHNICAL_RE = /^\s*[[{]|\n\s+at /;
const NETWORK_RE =/failed to fetch|networkerror|load failed|network request failed/i;

/** True when `text` is plausibly already in the UI language (RU ⇔ Cyrillic; EN/UZ ⇔ Latin). */
function fitsUiLanguage(text: string): boolean {
  return getLang() === "ru" ? CYRILLIC.test(text) : !CYRILLIC.test(text);
}

function pickString(o: unknown, keys: string[]): string | null {
  if (!o || typeof o !== "object") return null;
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function parseJsonMaybe(s: string): unknown {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/** "HTTP 403 Forbidden: Only curators…" → { status: 403, rest: "Only curators…" } */
function parseHttpPrefix(msg: string): { status: number | null; rest: string } {
  const m = /^HTTP\s+(\d{3})(?:\s+[^:]*)?(?::\s*([\s\S]*))?$/.exec(msg.trim());
  if (!m) return { status: null, rest: msg };
  return { status: Number(m[1]), rest: (m[2] ?? "").trim() };
}

function legacyText(raw: string | null): string | null {
  if (!raw || CYRILLIC.test(raw)) return null;
  const lower = raw.toLowerCase();
  let best: string | null = null;
  let bestLen = 0;
  for (const [needle, key] of LEGACY_MESSAGES) {
    if (lower.includes(needle) && needle.length > bestLen) { best = key; bestLen = needle.length; }
  }
  return best ? apiErrorsI18n.tryT(best) ?? null : null;
}

type ParseState = { status: number | null; code: string | null; raw: string | null; isNetwork: boolean };

function fromBody(s: ParseState, body: unknown): void {
  if (!body) return;
  if (typeof body === "string") {
    const parsed = parseJsonMaybe(body);
    if (parsed) { fromBody(s, parsed); return; }
    const t = body.trim();
    if (s.raw == null && t && !t.startsWith("<")) s.raw = t;
    return;
  }
  if (typeof body === "object") {
    if (s.code == null) s.code = pickString(body, ["code"]);
    if (s.raw == null) s.raw = pickString(body, ["error", "message", "detail", "title", "error_description"]);
    const st = (body as { status?: unknown }).status;
    if (s.status == null && typeof st === "number") s.status = st;
  }
}

function parse(err: unknown): ParseState {
  const s: ParseState = { status: null, code: null, raw: null, isNetwork: false };
  if (err instanceof ApiError) {
    s.status = err.isNetwork ? null : err.status;
    s.code = err.code;
    s.isNetwork = err.isNetwork;
    fromBody(s, err.body);
    if (s.raw == null && !err.isNetwork && err.code !== CLIENT_CODES.badResponse && !/^HTTP \d{3}$/.test(err.message)) s.raw = err.message;
    if (s.raw && TECHNICAL_RE.test(s.raw)) s.raw = null;
    return s;
  }
  if (typeof Response !== "undefined" && err instanceof Response) {
    s.status = err.status;
  } else if (typeof err === "string") {
    const p = parseHttpPrefix(err);
    if (p.status) { s.status = p.status; fromBody(s, p.rest); } else fromBody(s, err);
  } else if (err && typeof err === "object") {
    const e = err as { status?: unknown; statusCode?: unknown; data?: unknown; response?: unknown; body?: unknown; message?: unknown; name?: unknown; code?: unknown };
    if (typeof e.status === "number") s.status = e.status;
    else if (typeof e.statusCode === "number") s.status = e.statusCode;
    if (typeof e.code === "string") s.code = e.code;
    fromBody(s, e.data);
    fromBody(s, e.body);
    if (typeof Response !== "undefined" && e.response instanceof Response && s.status == null) s.status = e.response.status;
    if (typeof e.message === "string" && e.message.trim()) {
      const p = parseHttpPrefix(e.message);
      if (p.status && s.status == null) s.status = p.status;
      if (s.raw == null) fromBody(s, p.rest || e.message);
      if (s.status == null && (e.name === "TypeError" && NETWORK_RE.test(e.message))) s.isNetwork = true;
      else if (s.status == null && NETWORK_RE.test(e.message)) s.isNetwork = true;
    }
  }
  if (s.status === 0) { s.status = null; s.isNetwork = true; }
  if (s.raw && /^(Request failed with status|HTTP \d{3}$)/i.test(s.raw)) s.raw = null;
  if (s.raw && TECHNICAL_RE.test(s.raw)) s.raw = null;
  return s;
}

export function describeApiError(err: unknown): ApiErrorInfo {
  const { status, code, raw, isNetwork } = parse(err);
  const t = apiErrorsI18n.tryT;
  const codeText = code ? t(`codes.${code}`) : undefined;
  // With a code the server text is authoritative; a code-less old English message is replaced by its curated text.
  const rawFits = raw && raw.length <= 300 && fitsUiLanguage(raw) && (code || !legacyText(raw)) ? raw : null;

  const message =
    rawFits ||
    codeText ||
    legacyText(raw) ||
    (status != null ? t(`status.${status}`) : null) ||
    (isNetwork ? t("codes.NETWORK") : null) ||
    (status != null && status >= 500 ? t("status.500") : null) ||
    (raw && raw.length <= 200 ? raw : null) ||
    apiErrorsI18n.t("generic");

  return { status, code, raw, message, isNetwork };
}

/** Toast-ready text for any error, in the UI language. */
export function humanizeApiError(err: unknown, fallback?: string): string {
  const info = describeApiError(err);
  if (fallback && info.message === apiErrorsI18n.t("generic")) return fallback;
  return info.message;
}

export function apiErrorStatus(err: unknown): number | null {
  return parse(err).status;
}

export function apiErrorCode(err: unknown): string | null {
  return parse(err).code;
}

/** True when the server answered 503 { code: "ai_not_configured" } — show «AI не настроен», disable AI buttons, don't retry. */
export function isAiNotConfiguredError(err: unknown): boolean {
  const code = apiErrorCode(err);
  return code === "ai_not_configured" || legacyText(parse(err).raw) === apiErrorsI18n.t("codes.ai_not_configured");
}

export function isAuthError(err: unknown): boolean {
  return apiErrorStatus(err) === 401;
}

export function isNotFound(err: unknown): boolean {
  return apiErrorStatus(err) === 404;
}

/**
 * `.catch(nullIfMissing)`: an endpoint that answers 404 (or the SPA's HTML fallback) resolves to `null`.
 * This is the old «API build without this endpoint» fallback — phase E deletes every use; don't add new ones.
 */
export function nullIfMissing(err: unknown): null {
  const { status, code } = parse(err);
  if (status === 404 || code === CLIENT_CODES.badResponse) return null;
  throw err;
}

/** 4xx errors: the same request will get the same answer, so never retry. */
export function isClientError(err: unknown): boolean {
  const s = apiErrorStatus(err);
  return s != null && s >= 400 && s < 500;
}

/** QueryClient `retry`: never 4xx; network / 5xx up to 2 more times; anything unknown once. */
export function shouldRetryQuery(failureCount: number, err: unknown): boolean {
  const { status, isNetwork } = parse(err);
  if (status != null && status >= 400 && status < 500) return false;
  if (isNetwork || (status != null && status >= 500)) return failureCount < 2;
  return failureCount < 1;
}

/** QueryClient `retryDelay`: 1 s, 2 s, 4 s … capped at 8 s. */
export function retryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 8000);
}
