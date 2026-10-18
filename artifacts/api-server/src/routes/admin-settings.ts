/**
 * Desk settings (lib/settings: registry + store; admin console → «Настройки деска»).
 *
 *   GET /admin/settings   settings.manage — { settings: [{ key, def, value, effective, default, updatedBy, updatedAt }],
 *                         timezone } in registry order (the page renders its form from `def`)
 *   PUT /admin/settings   settings.manage — { changes: [{ key, value | null }] } (null = back to the default); the
 *                         whole batch is validated first (400 SETTINGS_INVALID, details.problems per key, nothing
 *                         written); each change is audited (settings.update). Answers like GET + `changed` keys.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { requireCap } from "../lib/permissions";
import { badRequest } from "../lib/http";
import { saveSettings, settingsState } from "../lib/settings/store";

const router: IRouter = Router();

const TIMEZONE = "America/New_York";

router.get("/admin/settings", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "settings.manage"))) return;
  res.json({ settings: await settingsState(), timezone: TIMEZONE });
}));

// Values are checked against the registry in lib/settings/validate.ts (per-key problems for the form), not here.
const PutBody = z.object({
  changes: z.array(z.object({ key: z.string().min(1).max(100), value: z.unknown() })).min(1).max(200),
});

router.put("/admin/settings", asyncHandler(async (req, res): Promise<void> => {
  if (!(await requireCap(req, res, "settings.manage"))) return;
  const parsed = PutBody.safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest("VALIDATION");
  const { changed, settings } = await saveSettings(parsed.data.changes, req.authUser!.name);
  res.json({ settings, changed, timezone: TIMEZONE });
}));

export default router;
