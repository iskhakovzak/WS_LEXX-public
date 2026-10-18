import express, { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireCap } from "../lib/permissions";
import { scopeTrader } from "../lib/auth";
import {
  PLAN_MEDIA_DAILY_LIMIT,
  PLAN_MEDIA_MAX_BYTES,
  ensurePlanMedia,
  sniffImageMime,
  type MediaContext,
} from "../lib/planMedia";
import { AppError, badRequest, notFound, sendError, unauthorized } from "../lib/http";

/**
 * Screenshots for «План дня» (desk game plan and personal trader plans).
 *
 *   POST   /api/plan-media?context=desk|personal&date=YYYY-MM-DD&w=&h=   raw image body (webp/jpeg/png, ≤2.5 MB)
 *          desk → gameplan.publish; personal → journal.write.own (own plan only)
 *   GET    /api/plan-media/:id      image bytes. desk media: any signed-in member (the desk plan is team-wide);
 *                                   personal media: owner or whoever scopeTrader(…, "journal.read.team") lets read them
 *   DELETE /api/plan-media/:id      soft delete (desk: gameplan.publish; personal: owner)
 *
 * The browser loads images with fetch() (Authorization header) and shows them as blob: URLs — tokens never go in URLs.
 */
const router: IRouter = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const rawImage = express.raw({ type: ["image/webp", "image/jpeg", "image/png"], limit: PLAN_MEDIA_MAX_BYTES });

function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function dim(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 10000 ? n : null;
}

router.post(
  "/plan-media",
  (req, res, next) => {
    rawImage(req, res, (err: unknown) => {
      if (!err) return next();
      const tooBig = (err as { type?: string })?.type === "entity.too.large";
      sendError(res, tooBig ? new AppError("IMAGE_TOO_LARGE", 413, { max: "2.5 MB" }) : new AppError("IMAGE_UNREADABLE"));
    });
  },
  asyncHandler(async (req, res): Promise<void> => {
    const context = req.query.context === "personal" ? "personal" : req.query.context === "desk" ? "desk" : null;
    const date = typeof req.query.date === "string" ? req.query.date : "";
    if (!context || !ISO_DATE.test(date) || isNaN(Date.parse(date + "T00:00:00Z"))) throw new AppError("FIELD_REQUIRED", undefined, { field: "context, date" });
    const me = req.authUser?.name;
    if (!me) {
      throw unauthorized();
    }
    const ok =
      context === "desk"
        ? await requireCap(req, res, "gameplan.publish", null, "DESK_PLAN_MEDIA_UPLOAD_STAFF_ONLY")
        : await requireCap(req, res, "journal.write.own", { trader: me });
    if (!ok) return;

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new AppError("IMAGE_TYPE", 415);
    const mime = sniffImageMime(body);
    if (!mime) throw new AppError("IMAGE_TYPE", 415);
    await ensurePlanMedia();
    const { rows: quota } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM plan_media WHERE owner = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [me],
    );
    if ((quota[0]?.n ?? 0) >= PLAN_MEDIA_DAILY_LIMIT) throw new AppError("MEDIA_DAILY_LIMIT", undefined, { max: PLAN_MEDIA_DAILY_LIMIT });
    const { rows } = await pool.query<{ id: number; created_at: Date }>(
      `INSERT INTO plan_media (context, owner, plan_date, mime, bytes, size_bytes, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [context, me, date, mime, body, body.length, dim(req.query.w), dim(req.query.h)],
    );
    res.status(201).json({
      id: rows[0]!.id,
      context,
      date,
      mime,
      size: body.length,
      width: dim(req.query.w),
      height: dim(req.query.h),
      createdAt: new Date(rows[0]!.created_at).toISOString(),
    });
  }),
);

type MediaRow = { id: number; context: MediaContext; owner: string; mime: string; bytes: Buffer; size_bytes: number };

router.get("/plan-media/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) {
    throw badRequest("INVALID_ID");
  }
  if (!req.authUser) {
    throw unauthorized();
  }
  await ensurePlanMedia();
  const { rows } = await pool.query<MediaRow>(
    `SELECT id, context, owner, mime, bytes, size_bytes FROM plan_media WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw notFound();
  }
  if (row.context === "personal") {
    // Owner always; others only within their journal.read.team scope (guest → sentinel ≠ owner).
    const scope = await scopeTrader(req, row.owner, "journal.read.team");
    if (scope !== row.owner) {
      throw notFound();
    }
  }
  res.setHeader("Content-Type", row.mime);
  res.setHeader("Content-Length", String(row.size_bytes));
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.end(row.bytes);
}));

router.delete("/plan-media/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) {
    throw badRequest("INVALID_ID");
  }
  const me = req.authUser?.name;
  if (!me) {
    throw unauthorized();
  }
  await ensurePlanMedia();
  const { rows } = await pool.query<{ context: MediaContext; owner: string }>(
    `SELECT context, owner FROM plan_media WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw notFound();
  }
  if (row.context === "desk") {
    if (!(await requireCap(req, res, "gameplan.publish", null, "DESK_PLAN_MEDIA_DELETE_STAFF_ONLY"))) return;
  } else if (row.owner !== me) {
    throw notFound();
  }
  await pool.query(`UPDATE plan_media SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`, [id]);
  res.json({ ok: true, id });
}));

export default router;
