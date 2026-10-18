import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import type { Request, Response, NextFunction } from "express";
import { pool } from "@workspace/db";
import { config } from "../config";
import { can, readScope, resolveActor, type Capability } from "./permissions";
import { canReadPersonal, guestModeEnabled } from "./accessRules";
import { AppError, sendError, unauthorized } from "./http/errors";

const SECRET = config.jwtSecret;
if (!SECRET) {
  throw new Error("JWT_SECRET is not set");
}
const SECRET_OK: string = SECRET;
/** Member session: 7 days, re-issued by GET /auth/me once the current token is older than REFRESH_AFTER_SEC (sliding). */
export const TOKEN_TTL_SEC = 7 * 24 * 3600;
export const REFRESH_AFTER_SEC = 24 * 3600;
const GUEST_TOKEN_TTL = "12h";
/** The only algorithm we sign with — and the only one jwt.verify accepts (no `alg` confusion). */
const JWT_ALG = "HS256" as const;
const BCRYPT_ROUNDS = 10;

export type AuthUser = { id: number; name: string; role: string };

// ─── Guest mode ─────────────────────────────────────────────────────────────
// A guest is a synthetic read-only identity with NO users row: id 0, role "guest".
// Guest JWTs carry `kind: "guest"` and are accepted by authMiddleware without the
// token_version lookup (there is no row to look up). They expire after 12h and
// cannot be revoked individually — rotating JWT_SECRET invalidates them all.
export const GUEST_ROLE = "guest";
export const GUEST_USER_ID = 0;
export const GUEST_NAME = "Гость"; // i18n-ignore (identity of the guest session: JWT name / scope sentinel; the UI shows its own label)
/**
 * Sentinel returned by scopeTrader() for guests. It is not a real trader name, so every
 * `WHERE trader = $scope` query yields zero rows: a guest sees only team-wide/non-personal
 * data that a route exposes without a trader filter, never anyone's trades, notes or money.
 * (The "∅" character cannot be typed into the user picker, and names are trimmed on creation.)
 */
export const GUEST_SCOPE = "∅guest";

/**
 * GUEST_MODE switch (lib/accessRules guestModeEnabled): unset → on in development, off in production.
 * When off, POST /auth/guest answers 403 GUEST_DISABLED and already-issued guest tokens stop working.
 */
export function isGuestModeEnabled(): boolean {
  return guestModeEnabled({ GUEST_MODE: config.guestMode, NODE_ENV: config.nodeEnv });
}

export function isGuestUser(u: AuthUser | null | undefined): boolean {
  return !!u && u.role === GUEST_ROLE && u.id === GUEST_USER_ID;
}

export function isGuest(req: Request): boolean {
  return isGuestUser(req.authUser);
}

export function signGuestToken(): string {
  return jwt.sign(
    { sub: GUEST_USER_ID, name: GUEST_NAME, role: GUEST_ROLE, tv: 0, kind: "guest" },
    SECRET_OK,
    { expiresIn: GUEST_TOKEN_TTL, algorithm: JWT_ALG },
  );
}

const tvCache = new Map<number, { tv: number; exp: number }>();
const TV_CACHE_TTL_MS = 30_000;

async function getTokenVersion(userId: number): Promise<number | null> {
  const now = Date.now();
  const cached = tvCache.get(userId);
  if (cached && cached.exp > now) return cached.tv;
  const { rows } = await pool.query<{ token_version: number }>(
    `SELECT token_version FROM users WHERE id = $1 AND active = true LIMIT 1`,
    [userId],
  );
  if (!rows[0]) {
    tvCache.delete(userId);
    return null;
  }
  const tv = rows[0].token_version;
  tvCache.set(userId, { tv, exp: now + TV_CACHE_TTL_MS });
  return tv;
}

function invalidateTvCache(userId: number): void {
  tvCache.delete(userId);
}

/**
 * `pwc` (password change required): the account still has an issued secret (users.must_change_secret), or staff whose
 * secret is shorter than the staff minimum (lib/security/passwordPolicy).
 * While it is set, apiAuthGate allows only PASSWORD_CHANGE_ROUTES.
 */
export async function signToken(u: AuthUser, opts: { pwc?: boolean } = {}): Promise<string> {
  const tv = (await getTokenVersion(u.id)) ?? 0;
  return jwt.sign({ sub: u.id, name: u.name, role: u.role, tv, ...(opts.pwc ? { pwc: true } : {}) }, SECRET_OK, {
    expiresIn: TOKEN_TTL_SEC,
    algorithm: JWT_ALG,
  });
}

/** Sliding session: should GET /auth/me hand out a fresh token? (`iat` in seconds.) */
export function shouldRefreshToken(iat: number | undefined, nowMs = Date.now()): boolean {
  return typeof iat === "number" && nowMs / 1000 - iat > REFRESH_AFTER_SEC;
}

export async function bumpTokenVersion(userId: number): Promise<void> {
  await pool.query(`UPDATE users SET token_version = token_version + 1 WHERE id = $1`, [userId]);
  invalidateTvCache(userId);
}

type DecodedToken = { id: number; name: string; role: string; tv: number; guest: boolean; iat?: number; pwc: boolean };

function decodeToken(token: string): DecodedToken | null {
  try {
    const decoded = jwt.verify(token, SECRET_OK, { algorithms: [JWT_ALG] }) as Record<string, unknown>;
    if (!decoded || typeof decoded !== "object") return null;
    if (typeof decoded.sub !== "number" || typeof decoded.name !== "string" || typeof decoded.role !== "string") return null;
    const tv = typeof decoded.tv === "number" ? decoded.tv : 0;
    const guest = decoded.kind === "guest" && decoded.role === GUEST_ROLE && decoded.sub === GUEST_USER_ID;
    // A token claiming the guest role without the signed guest marker (or vice versa) is rejected.
    if ((decoded.role === GUEST_ROLE || decoded.sub === GUEST_USER_ID) && !guest) return null;
    const iat = typeof decoded.iat === "number" ? decoded.iat : undefined;
    return { id: decoded.sub, name: decoded.name, role: decoded.role, tv, guest, iat, pwc: decoded.pwc === true };
  } catch {
    return null;
  }
}

function readBearer(req: Request): string | null {
  const header = req.header("authorization");
  if (header && header.startsWith("Bearer ")) return header.slice(7).trim() || null;
  return null;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, stored: { passwordHash: string | null }): Promise<boolean> {
  if (!stored.passwordHash) return false;
  return bcrypt.compare(plain, stored.passwordHash);
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      /** Facts about the bearer token itself (set with authUser for members). */
      authMeta?: { iat?: number; pwc: boolean };
    }
  }
}

/**
 * Tokens come ONLY from the Authorization header. Media the browser loads by itself (<audio src>) uses short-lived
 * HMAC media tokens bound to one object (routes/voicenotes.ts `/audio-url`), never the session token in a URL.
 */
export async function authMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = readBearer(req);
  if (token) {
    const decoded = decodeToken(token);
    if (decoded) {
      if (decoded.guest) {
        if (isGuestModeEnabled()) req.authUser = { id: GUEST_USER_ID, name: GUEST_NAME, role: GUEST_ROLE };
      } else {
        const currentTv = await getTokenVersion(decoded.id);
        if (currentTv !== null && currentTv === decoded.tv) {
          req.authUser = { id: decoded.id, name: decoded.name, role: decoded.role };
          req.authMeta = { iat: decoded.iat, pwc: decoded.pwc };
        }
      }
    }
  }
  next();
}

// ─── Global API gate ────────────────────────────────────────────────────────
// Every /api/* request needs a valid token except the explicit allowlist below.
// Mounted in app.ts right after authMiddleware. Exported so it can be unit-tested
// with a throwaway express app.

export type PublicRoute = { method: string; path: string | RegExp };

export const PUBLIC_API_ROUTES: readonly PublicRoute[] = [
  { method: "GET", path: "/healthz" },
  { method: "POST", path: "/auth/login" },
  { method: "POST", path: "/auth/init-passwords" },
  { method: "POST", path: "/auth/guest" },
  { method: "POST", path: "/client-errors" },  // browser error reports (also from the login screen); own limiter + 32 KB
  { method: "POST", path: "/csp-report" },     // CSP violation reports (browsers send them without credentials)
  { method: "GET", path: "/holidays" },        // market calendar for the login/shell clock
  { method: "POST", path: "/telegram/webhook" }, // Telegram calls us; verified by its own secret
  { method: "GET", path: /^\/voice-notes\/\d+\/audio$/ }, // media_token checked by the route itself
];

/** Mutations a guest may still perform (none touch data). */
const GUEST_ALLOWED_MUTATIONS: readonly PublicRoute[] = [
  { method: "POST", path: "/auth/logout" },
];

const MUTATION_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

function normalizePath(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

function matches(list: readonly PublicRoute[], method: string, path: string): boolean {
  return list.some((r) => r.method === method && (typeof r.path === "string" ? r.path === path : r.path.test(path)));
}

export function isPublicApiRoute(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === "OPTIONS") return true; // CORS preflight
  return matches(PUBLIC_API_ROUTES, m === "HEAD" ? "GET" : m, normalizePath(path));
}

/** The only routes a `pwc` token (staff with a too-short password) may call until the password is changed. */
const PASSWORD_CHANGE_ROUTES: readonly PublicRoute[] = [
  { method: "GET", path: "/auth/me" },
  { method: "POST", path: "/auth/logout" },
  { method: "POST", path: "/users/me/password" },
  { method: "PATCH", path: "/users/me/locale" },
];

// Error answers go through lib/http (codes AUTH_REQUIRED / GUEST_READ_ONLY / PASSWORD_CHANGE_REQUIRED, texts in the request language).

/**
 * 401 for anonymous callers on every non-public route; 403 for guests on every mutation.
 * `req.path` is relative to the /api mount ("/trades", not "/api/trades").
 */
export function apiAuthGate(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  const path = normalizePath(req.path);
  if (isPublicApiRoute(method, path)) return next();
  if (!req.authUser) {
    sendError(res, unauthorized());
    return;
  }
  if (MUTATION_METHODS.has(method) && isGuestUser(req.authUser) && !matches(GUEST_ALLOWED_MUTATIONS, method, path)) {
    sendError(res, new AppError("GUEST_READ_ONLY"));
    return;
  }
  if (req.authMeta?.pwc && !matches(PASSWORD_CHANGE_ROUTES, method === "HEAD" ? "GET" : method, path)) {
    sendError(res, new AppError("PASSWORD_CHANGE_REQUIRED"));
    return;
  }
  next();
}

export function getActor(req: Request): string | null {
  if (req.authUser?.name) return req.authUser.name;
  return null;
}

export function getActorRoleFromToken(req: Request): string | null {
  return req.authUser?.role ?? null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    sendError(res, unauthorized());
    return;
  }
  next();
}

/** Sends 401 (anonymous) / 403 (guest) and returns false unless the caller is a real signed-in member. */
export function requireMember(req: Request, res: Response): boolean {
  if (!req.authUser) { sendError(res, unauthorized()); return false; }
  if (isGuestUser(req.authUser)) { sendError(res, new AppError("GUEST_READ_ONLY")); return false; }
  return true;
}

// ─── Role & scope helpers (use these in routes instead of ad-hoc checks) ───
// Capability checks live in lib/permissions.ts (`can`, `requireCap`, `readScope`, `resolveTraderParam`);
// the helpers below stay for existing callers and are built on the same matrix where they decide access.

/** Pure role test (curator/admin). Prefer a capability check: `can(req, "…")` honours desk overrides, this does not. */
export function isStaffRole(role: string | null | undefined): boolean {
  return role === "curator" || role === "admin";
}

/**
 * Current role from the DB (token roles can be stale after a role change).
 * Null when anonymous/inactive/banned; "guest" for a guest token (no users row).
 */
export async function viewerRole(req: Request): Promise<string | null> {
  if (isGuest(req)) return GUEST_ROLE;
  const id = req.authUser?.id;
  if (!id) return null;
  const { rows } = await pool.query<{ role: string }>(
    `SELECT role FROM users WHERE id = $1 AND active = true AND COALESCE(banned, false) = false LIMIT 1`,
    [id],
  );
  return rows[0]?.role ?? null;
}

/** Sends 401/403 and returns false unless the caller is a curator/admin. */
export async function requireStaff(req: Request, res: Response): Promise<boolean> {
  if (!req.authUser) { sendError(res, unauthorized()); return false; }
  if (!isStaffRole(await viewerRole(req))) { sendError(res, new AppError("STAFF_ONLY")); return false; }
  return true;
}

/**
 * Which trader's data a read may return — implemented on the permissions matrix (lib/permissions.ts).
 * `cap` is the team capability that opens other members' data (default "team.read" = today's "staff sees all").
 * Holder of the capability (desk scope): the requested trader, or null = everyone.
 * Holder under "assigned" scope: the requested ward, or their own name when nothing/someone else was requested.
 * Anyone else: always their own name (the `requested` value is ignored).
 * Guest: GUEST_SCOPE — a sentinel that matches no trader, so personal data comes back empty.
 * Anonymous (or inactive/banned): undefined — the caller should answer 401 (the global gate already does for /api/*).
 */
export async function scopeTrader(req: Request, requested?: string | null, cap: Capability = "team.read"): Promise<string | null | undefined> {
  if (!req.authUser) return undefined;
  if (isGuestUser(req.authUser)) return GUEST_SCOPE;
  const actor = await resolveActor(req);
  if (!actor) return undefined;
  const allowed = await readScope(req, cap);
  if (allowed === null) return requested?.trim() || null;
  const want = requested?.trim() || "";
  if (want && allowed.includes(want)) return want;
  return actor.name;
}

/**
 * Personal data addressed by a trader name (`?userId=` on emotional check-ins, the weekly psychology report …).
 * Validates the name and decides via lib/accessRules canReadPersonal: the owner, or a member whose team capability
 * `cap` covers that trader (curators/admins by default; "assigned" scope → only their wards). Guests never.
 * Sends 400/401/403 itself and returns the trader name, or null when the request was answered.
 */
export async function requirePersonalAccess(
  req: Request, res: Response, raw: unknown, cap: Capability = "journal.read.team",
): Promise<string | null> {
  const owner = typeof raw === "string" ? raw.trim() : "";
  if (!owner || owner.length > 120) { sendError(res, new AppError("TRADER_REQUIRED")); return null; }
  if (!req.authUser) { sendError(res, unauthorized()); return null; }
  const actor = await resolveActor(req);
  if (!actor) { sendError(res, unauthorized()); return null; }
  if (actor.guest) { sendError(res, new AppError("GUEST_NO_PERSONAL")); return null; }
  const teamAllowed = owner !== actor.name && (await can(req, cap, { trader: owner }));
  if (!canReadPersonal(actor, owner, teamAllowed)) { sendError(res, new AppError("PERSONAL_DATA_FORBIDDEN")); return null; }
  return owner;
}

/**
 * May the caller read/modify trade `tradeId`? Own trades via trades.read.own / trades.write.own; other members'
 * trades via trades.read.team / trades.write.any (staff by default, scope-aware). Guest/anonymous: never.
 * Returns null when the trade does not exist (or is soft-deleted). `mode` defaults to "write" because every
 * caller today mutates something attached to the trade (checklists, links, comments).
 */
export async function canAccessTrade(req: Request, tradeId: number, mode: "read" | "write" = "write"): Promise<boolean | null> {
  if (!req.authUser || isGuestUser(req.authUser) || !Number.isInteger(tradeId)) return false;
  const { rows } = await pool.query<{ trader: string | null }>(
    `SELECT trader FROM trades WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [tradeId],
  );
  if (!rows[0]) return null;
  const target = { trader: rows[0].trader };
  const own: Capability = mode === "read" ? "trades.read.own" : "trades.write.own";
  const team: Capability = mode === "read" ? "trades.read.team" : "trades.write.any";
  if (rows[0].trader === req.authUser.name && (await can(req, own, target))) return true;
  return can(req, team, target);
}
