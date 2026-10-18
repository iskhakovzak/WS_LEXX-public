/**
 * Permissions matrix API.
 *
 *   GET /api/permissions/me        any signed-in member (guests too): my role, effective capabilities, scopes, wards
 *   GET /api/permissions/matrix    staff: capability catalogue, defaults, desk overrides, effective matrix
 *   PUT /api/permissions/matrix    admin (permissions.manage): { cells: [{ role, capability, allowed, scope? }] }
 *                                  or { reset: true }. Admin and guest rows are locked; adminOnly capabilities can
 *                                  never be granted below admin — so an admin cannot remove their own
 *                                  users.manage / permissions.manage / admin.* access.
 *
 * Table role_permissions (role, capability, allowed, scope, updated_by, updated_at) is created idempotently
 * (lib/permissions.ts ensureRolePermissionsTable, run at module load and before every write).
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { logAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { requireStaff } from "../lib/auth";
import {
  CAPABILITY_DEFS, DEFAULT_MATRIX, DEFAULT_SCOPE, ROLES,
  buildEffectiveMatrix, capabilitiesOf, capabilityDef, diffFromDefaults, ensureRolePermissionsTable, getMatrixState,
  invalidatePermissionsCache, isEditableRole, requireCap, resolveActor,
  type Capability, type EffectiveMatrix, type Override, type Role,
} from "../lib/permissions";
import { badRequest, unauthorized } from "../lib/http";
import { localizedCapabilityDefs } from "../lib/permissionsI18n";
import { langOf, type Lang } from "../i18n";

const router: IRouter = Router();

ensureRolePermissionsTable().catch((err) => logger.warn({ err }, "permissions: ensure table failed at init"));

function scopesOf(matrix: EffectiveMatrix, role: Role): Record<string, "desk" | "assigned"> {
  const out: Record<string, "desk" | "assigned"> = {};
  for (const def of CAPABILITY_DEFS) if (def.team) out[def.key] = matrix[role][def.key].scope;
  return out;
}

async function matrixPayload(lang: Lang) {
  const state = await getMatrixState();
  return {
    roles: ROLES,
    // Labels, descriptions and group titles in the reader's language (keys and flags unchanged; + groupCode).
    capabilities: localizedCapabilityDefs(lang),
    defaults: DEFAULT_MATRIX,
    defaultScope: DEFAULT_SCOPE,
    overrides: state.overrides,
    matrix: state.matrix,
    locked: {
      roles: ROLES.filter((r) => !isEditableRole(r)),
      capabilities: CAPABILITY_DEFS.filter((c) => c.adminOnly).map((c) => c.key),
    },
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy,
  };
}

router.get("/permissions/me", asyncHandler(async (req, res): Promise<void> => {
  if (!req.authUser) throw unauthorized();
  const actor = await resolveActor(req);
  if (!actor) throw unauthorized();
  const state = await getMatrixState();
  res.json({
    name: actor.name,
    role: actor.role,
    guest: actor.guest,
    capabilities: capabilitiesOf(state.matrix, actor.role),
    scopes: scopesOf(state.matrix, actor.role),
    wards: actor.wards,
    customized: state.overrides.length > 0,
    updatedAt: state.updatedAt,
  });
}));

router.get("/permissions/matrix", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireStaff(req, res))) return;
  res.json(await matrixPayload(langOf(req)));
}));

const CellSchema = z.object({
  role: z.string().trim().min(1).max(20),
  capability: z.string().trim().min(1).max(80),
  allowed: z.boolean(),
  scope: z.enum(["desk", "assigned"]).nullable().optional(),
});
const PutBody = z.object({
  cells: z.array(CellSchema).max(500).optional(),
  reset: z.boolean().optional(),
}).strict();

router.put("/permissions/matrix", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "permissions.manage"))) return;
  const parsed = PutBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw badRequest("VALIDATION", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  const actor = req.authUser!.name;
  await ensureRolePermissionsTable();
  const before = (await getMatrixState()).overrides;

  let next: Override[];
  if (parsed.data.reset) {
    next = [];
  } else {
    const cells = parsed.data.cells ?? [];
    const problems: { kind: "unknown_capability" | "locked_role" | "admin_only"; role: string; capability: string }[] = [];
    // Start from the current effective matrix and apply the requested cells on top.
    const matrix = buildEffectiveMatrix(before);
    for (const c of cells) {
      const def = capabilityDef(c.capability);
      if (!def) { problems.push({ kind: "unknown_capability", role: c.role, capability: c.capability }); continue; }
      if (!isEditableRole(c.role)) { problems.push({ kind: "locked_role", role: c.role, capability: c.capability }); continue; }
      if (def.adminOnly) { problems.push({ kind: "admin_only", role: c.role, capability: c.capability }); continue; }
      const cell = matrix[c.role][def.key as Capability];
      cell.allowed = c.allowed;
      if (def.team && (c.scope === "desk" || c.scope === "assigned")) cell.scope = c.scope;
    }
    if (problems.length) throw badRequest("PERMISSIONS_CELLS_REJECTED", { problems });
    next = diffFromDefaults(matrix);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM role_permissions`);
    for (const o of next) {
      await client.query(
        `INSERT INTO role_permissions (role, capability, allowed, scope, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, NOW())`,
        [o.role, o.capability, o.allowed, o.scope ?? null, actor],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  invalidatePermissionsCache();

  const key = (o: Override) => `${o.role}:${o.capability}`;
  const beforeBy = new Map(before.map((o) => [key(o), o]));
  const afterBy = new Map(next.map((o) => [key(o), o]));
  const changed = [...new Set([...beforeBy.keys(), ...afterBy.keys()])]
    .filter((k) => JSON.stringify(beforeBy.get(k) ?? null) !== JSON.stringify(afterBy.get(k) ?? null))
    .map((k) => ({ key: k, before: beforeBy.get(k) ?? null, after: afterBy.get(k) ?? null }));
  await logAudit({ actor, action: "permissions.matrix.update", targetType: "permissions", targetId: "matrix", details: { reset: !!parsed.data.reset, changed } });
  logger.info({ actor, changed: changed.length, reset: !!parsed.data.reset }, "permissions matrix updated");

  res.json({ ...(await matrixPayload(langOf(req))), changed: changed.length });
}));

export default router;
