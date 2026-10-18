/**
 * Permissions — request-level helpers on top of the pure matrix (lib/permissionsMatrix.ts).
 *
 *   const ok = await can(req, "risk.limits.edit", { trader });          // boolean
 *   if (!(await requireCap(req, res, "journal.review"))) return;        // sends 401/403 itself
 *   const scope = await readScope(req, "ratings.read.team");           // null = everyone | string[] = only these
 *
 * The actor's role comes from the DB (token roles go stale after a role change; inactive/banned users resolve to
 * no actor at all), is cached on the request, and desk overrides (table role_permissions) are cached in memory for
 * OVERRIDES_TTL_MS. Guests are a synthetic read-only identity with no capabilities.
 */
import type { Request, Response } from "express";
import { pool } from "@workspace/db";
import {
  buildEffectiveMatrix, evaluate, readableTraders, normalizeRole, isCapability,
  type Actor, type Capability, type EffectiveMatrix, type Override, type Role, type Target,
} from "./permissionsMatrix";
import { AppError, errorMessage, forbidden, isErrorCode, sendError, unauthorized, type ErrorCode } from "./http/errors";

export type { Actor, Capability, EffectiveMatrix, Override, Role, Scope, Target } from "./permissionsMatrix";
export {
  CAPABILITIES, CAPABILITY_DEFS, CAPABILITY_KEYS, DEFAULT_MATRIX, DEFAULT_SCOPE, ROLES,
  buildEffectiveMatrix, capabilitiesOf, capabilityDef, diffFromDefaults, evaluate, isCapability, isEditableRole, readableTraders,
} from "./permissionsMatrix";

declare global {
  namespace Express {
    interface Request {
      /** Memoised actor for this request (undefined = not resolved yet, null = anonymous/inactive). */
      permActor?: Actor | null;
    }
  }
}

const GUEST_USER_ID = 0;
const GUEST_ROLE = "guest";

export const FORBIDDEN_CODE = "FORBIDDEN";

// ─── role_permissions table (additive, idempotent) ──────────────────────────

let ensured: Promise<void> | null = null;
export function ensureRolePermissionsTable(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(
        `CREATE TABLE IF NOT EXISTS role_permissions (
           role TEXT NOT NULL,
           capability TEXT NOT NULL,
           allowed BOOLEAN NOT NULL DEFAULT true,
           scope TEXT,
           updated_by TEXT,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           PRIMARY KEY (role, capability)
         )`,
      )
      .then(() => undefined)
      .catch((err) => {
        ensured = null;
        throw err;
      });
  }
  return ensured;
}

// ─── overrides cache ────────────────────────────────────────────────────────

const OVERRIDES_TTL_MS = 15_000;
let cache: { at: number; overrides: Override[]; matrix: EffectiveMatrix; updatedAt: string | null; updatedBy: string | null } | null = null;

export function invalidatePermissionsCache(): void {
  cache = null;
}

type OverrideRow = { role: string; capability: string; allowed: boolean; scope: string | null; updated_by: string | null; updated_at: Date | string | null };

export async function loadOverrides(): Promise<{ overrides: Override[]; updatedAt: string | null; updatedBy: string | null }> {
  let rows: OverrideRow[] = [];
  try {
    await ensureRolePermissionsTable();
    rows = (await pool.query<OverrideRow>(`SELECT role, capability, allowed, scope, updated_by, updated_at FROM role_permissions ORDER BY role, capability`)).rows;
  } catch {
    rows = []; // table missing / DB hiccup → defaults (never fail open or closed differently from today)
  }
  const overrides: Override[] = [];
  let updatedAt: string | null = null;
  let updatedBy: string | null = null;
  for (const r of rows) {
    if (!isCapability(r.capability)) continue;
    const role = normalizeRole(r.role);
    if (role !== "trader" && role !== "curator") continue;
    overrides.push({ role, capability: r.capability, allowed: !!r.allowed, scope: r.scope === "assigned" || r.scope === "desk" ? r.scope : null });
    const at = r.updated_at ? new Date(r.updated_at).toISOString() : null;
    if (at && (!updatedAt || at > updatedAt)) { updatedAt = at; updatedBy = r.updated_by ?? null; }
  }
  return { overrides, updatedAt, updatedBy };
}

/** Effective matrix (defaults + desk overrides), cached briefly. */
export async function getEffectiveMatrix(): Promise<EffectiveMatrix> {
  return (await getMatrixState()).matrix;
}

export async function getMatrixState(): Promise<NonNullable<typeof cache>> {
  const now = Date.now();
  if (cache && now - cache.at < OVERRIDES_TTL_MS) return cache;
  const { overrides, updatedAt, updatedBy } = await loadOverrides();
  cache = { at: now, overrides, matrix: buildEffectiveMatrix(overrides), updatedAt, updatedBy };
  return cache;
}

function hasAssignedScope(matrix: EffectiveMatrix, role: Role): boolean {
  const row = matrix[role];
  for (const key in row) if (row[key as Capability].scope === "assigned") return true;
  return false;
}

// ─── actor ──────────────────────────────────────────────────────────────────

/**
 * The signed-in member as the matrix sees them: current DB role (null when inactive/banned), guest flag and —
 * only when some capability of that role is scoped "assigned" — the list of their wards.
 */
export async function resolveActor(req: Request): Promise<Actor | null> {
  if (req.permActor !== undefined) return req.permActor;
  const u = req.authUser;
  if (!u) return (req.permActor = null);
  if (u.role === GUEST_ROLE && u.id === GUEST_USER_ID) {
    return (req.permActor = { id: u.id, name: u.name, role: "guest", guest: true, wards: [] });
  }
  const { rows } = await pool.query<{ role: string; name: string }>(
    `SELECT role, name FROM users WHERE id = $1 AND active = true AND COALESCE(banned, false) = false LIMIT 1`,
    [u.id],
  );
  if (!rows[0]) return (req.permActor = null);
  const role = normalizeRole(rows[0].role);
  let wards: string[] = [];
  if (hasAssignedScope(await getEffectiveMatrix(), role)) {
    const { rows: w } = await pool.query<{ name: string }>(
      `SELECT name FROM users WHERE active = true AND COALESCE(banned, false) = false
         AND (assigned_curator = $1 OR assigned_risk_manager = $1 OR assigned_mentor = $1)`,
      [u.name],
    );
    wards = w.map((r) => r.name);
  }
  return (req.permActor = { id: u.id, name: u.name, role, guest: false, wards });
}

// ─── checks ─────────────────────────────────────────────────────────────────

export async function can(req: Request, cap: Capability, target?: Target | null): Promise<boolean> {
  const actor = await resolveActor(req);
  if (!actor) return false;
  return evaluate(await getEffectiveMatrix(), actor, cap, target);
}

export async function canAny(req: Request, caps: readonly Capability[], target?: Target | null): Promise<boolean> {
  const actor = await resolveActor(req);
  if (!actor) return false;
  const matrix = await getEffectiveMatrix();
  return caps.some((c) => evaluate(matrix, actor, c, target));
}

/** 403 for a missing capability: `details.capability` names it; `code` picks a more specific text (e.g. STAFF_ONLY). */
export function forbiddenError(cap: Capability, code?: ErrorCode | LegacyMessage): AppError {
  return forbidden(cap, isErrorCode(code) ? code : "FORBIDDEN");
}
/** Older callers passed a Russian sentence instead of a code; it is ignored (the generic FORBIDDEN text is used). */
type LegacyMessage = string & { readonly __legacy?: never };

/**
 * Sends 401 (anonymous / inactive), 403 (guest or missing capability) and returns false; true when allowed.
 * `code` picks a more specific error text than FORBIDDEN (e.g. "STAFF_ONLY"); the text is translated by the middleware.
 */
export async function requireCap(req: Request, res: Response, cap: Capability, target?: Target | null, code?: ErrorCode | LegacyMessage): Promise<boolean> {
  if (!req.authUser) { sendError(res, unauthorized()); return false; }
  const actor = await resolveActor(req);
  if (!actor) { sendError(res, unauthorized()); return false; }
  if (actor.guest) { sendError(res, new AppError("GUEST_READ_ONLY")); return false; }
  if (!evaluate(await getEffectiveMatrix(), actor, cap, target)) { sendError(res, forbiddenError(cap, code)); return false; }
  return true;
}

/** Like requireCap but accepts any of several capabilities (e.g. own OR team). The 403 names the first one. */
export async function requireAnyCap(req: Request, res: Response, caps: readonly Capability[], target?: Target | null, code?: ErrorCode | LegacyMessage): Promise<boolean> {
  if (!req.authUser) { sendError(res, unauthorized()); return false; }
  const actor = await resolveActor(req);
  if (!actor) { sendError(res, unauthorized()); return false; }
  if (actor.guest) { sendError(res, new AppError("GUEST_READ_ONLY")); return false; }
  const matrix = await getEffectiveMatrix();
  if (!caps.some((c) => evaluate(matrix, actor, c, target))) { sendError(res, forbiddenError(caps[0]!, code)); return false; }
  return true;
}

/**
 * Which traders a team-scoped read may return for the caller:
 *   null       → everyone (desk scope)
 *   string[]   → only these names (own name, plus wards under "assigned" scope)
 *   []         → nobody (guest / anonymous)
 */
export async function readScope(req: Request, cap: Capability): Promise<string[] | null> {
  const actor = await resolveActor(req);
  return readableTraders(await getEffectiveMatrix(), actor, cap);
}

/** Failure of a scope helper: `throw failure.appError` (status/error kept for older callers; error is RU). */
export type ScopeFailure = { ok: false; status: number; error: string; appError: AppError };
function scopeFailure(appError: AppError): ScopeFailure {
  return { ok: false, status: appError.status, error: errorMessage(appError.code, "ru", appError.params), appError };
}

/**
 * Resolve a `?trader=` request against a team capability. Returns the single trader to filter by
 * (null = whole desk) or an error. A member without the capability always gets their own name; a caller under
 * "assigned" scope gets the requested ward, or their own name when nothing was requested.
 */
export async function resolveTraderParam(
  req: Request, cap: Capability, requested: unknown, opts: { allowAll?: boolean } = {},
): Promise<{ ok: true; trader: string | null; team: boolean; actor: Actor } | ScopeFailure> {
  const actor = await resolveActor(req);
  if (!actor) return scopeFailure(unauthorized());
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (raw.length > 120) return scopeFailure(new AppError("INVALID_TRADER"));
  const matrix = await getEffectiveMatrix();
  if (actor.guest) return { ok: true, trader: "∅guest", team: false, actor };
  const scope = readableTraders(matrix, actor, cap);
  if (scope === null) return { ok: true, trader: raw || (opts.allowAll ? null : actor.name), team: true, actor };
  if (raw && raw !== actor.name && !scope.includes(raw)) return scopeFailure(forbiddenError(cap));
  if (!raw) return { ok: true, trader: actor.name, team: scope.length > 1, actor };
  return { ok: true, trader: raw, team: scope.length > 1, actor };
}
