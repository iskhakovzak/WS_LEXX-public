/**
 * Admin console: Latin display names (users.name_latin) — shown instead of the Cyrillic name in the English and
 * Uzbek interface and found by search. Not a rename: the stored name stays the identity everywhere.
 *
 *   POST /admin/console/people/:id/name-latin   {nameLatin: string | null}            → {ok, name, nameLatin}
 *   POST /admin/console/people/name-latin/bulk  {items: [{id, nameLatin}]} (≤ 500)    → {ok, changed, unchanged}
 *
 * Capability users.manage; another admin needs users.manage.admins (own row is fine). Every value goes through
 * cleanNameLatin first (bulk: one bad item → NAME_LATIN_INVALID_FOR, nothing saved); then one transaction writes the
 * names and one «user.name_latin» audit entry per changed user (lib/peopleDirectory saveLatinNames), and the display
 * table is reloaded (lib/people/latinNames). Mounted by routes/admin-console.ts.
 */
import type { IRouter } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { can, requireCap, resolveActor } from "../lib/permissions";
import { cleanNameLatin, ensureNameLatin, saveLatinNames, type LatinNameChange } from "../lib/peopleDirectory";
import { reloadLatinNames } from "../lib/people/latinNames";
import { AppError, unauthorized } from "../lib/http";

type Target = { id: number; name: string; role: string };

async function loadTargets(ids: number[]): Promise<Map<number, Target>> {
  const { rows } = await pool.query<Target>(`SELECT id, name, role FROM users WHERE id = ANY($1::int[])`, [ids]);
  return new Map(rows.map((u) => [Number(u.id), { id: Number(u.id), name: String(u.name), role: String(u.role) }]));
}

/** Check every item (exists, may be edited, valid value) and save them; returns the changes actually written. */
async function apply(req: Parameters<typeof can>[0], raw: { id: number; nameLatin?: unknown }[], bulk: boolean): Promise<{ items: LatinNameChange[]; changed: LatinNameChange[] }> {
  const actor = await resolveActor(req);
  if (!actor) throw unauthorized();
  await ensureNameLatin();
  const byId = new Map<number, unknown>();
  for (const it of raw) byId.set(it.id, it.nameLatin); // last one wins on a repeated id
  const users = await loadTargets([...byId.keys()]);
  const adminMgr = await can(req, "users.manage.admins");
  const items: LatinNameChange[] = [];
  for (const [id, value] of byId) {
    const u = users.get(id);
    if (!u) throw new AppError("USER_NOT_FOUND", 404, undefined, bulk ? { id } : undefined);
    if (u.role === "admin" && u.id !== actor.id && !adminMgr) throw new AppError("ADMIN_ONLY");
    const cleaned = cleanNameLatin(value);
    if (!cleaned.ok) {
      throw bulk ? new AppError("NAME_LATIN_INVALID_FOR", 400, { name: u.name }, { id, code: cleaned.code }) : new AppError(cleaned.code, 400, cleaned.params);
    }
    items.push({ id, name: u.name, nameLatin: cleaned.value });
  }
  const changed = await saveLatinNames(items, actor.name, { bulk });
  if (changed.length) await reloadLatinNames();
  return { items, changed };
}

export function mountLatinNameRoutes(router: IRouter): void {
  router.post("/admin/console/people/name-latin/bulk", asyncHandler(async (req, res): Promise<void> => {
    if (!(await requireCap(req, res, "users.manage"))) return;
    const parsed = z.object({
      items: z.array(z.object({ id: z.number().int().positive(), nameLatin: z.unknown() })).min(1).max(500),
    }).safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("VALIDATION", 400, undefined, parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    }
    const { items, changed } = await apply(req, parsed.data.items, true);
    res.json({ ok: true, changed, unchanged: items.length - changed.length });
  }));

  router.post("/admin/console/people/:id/name-latin", asyncHandler(async (req, res): Promise<void> => {
    if (!(await requireCap(req, res, "users.manage"))) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new AppError("INVALID_ID");
    const { items } = await apply(req, [{ id, nameLatin: (req.body ?? {}).nameLatin }], false);
    res.json({ ok: true, name: items[0]!.name, nameLatin: items[0]!.nameLatin });
  }));
}
