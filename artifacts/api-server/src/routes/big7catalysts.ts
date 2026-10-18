import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, big7CatalystsTable } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { creatorName, requireRowOwnerOrStaff } from "../lib/ownedRows";
import { AppError, badRequest, notFound } from "../lib/http";

const router: IRouter = Router();

function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
const VALID_IMPACT = new Set(["low", "medium", "high"]);

router.get("/big7/catalysts", asyncHandler(async (_req, res): Promise<void> => {
  const rows = await db.select().from(big7CatalystsTable).orderBy(desc(big7CatalystsTable.date));
  res.json(rows);
}));

router.post("/big7/catalysts", asyncHandler(async (req, res): Promise<void> => {
  const { ticker, date, type, description, impact } = req.body as Record<string, unknown>;
  if (!ticker || !date || !type || !String(ticker).trim()) throw new AppError("FIELD_REQUIRED", undefined, { field: "ticker, date, type" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || Number.isNaN(Date.parse(String(date)))) {
    throw badRequest("INVALID_DATE");
  }
  const tickerStr = String(ticker).trim().toUpperCase().replace(/^\$/, "");
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(tickerStr)) {
    throw badRequest("INVALID_TICKER");
  }
  const [row] = await db.insert(big7CatalystsTable).values({
    ticker: tickerStr,
    date: String(date),
    type: String(type).slice(0, 40),
    description: description != null && String(description).trim() !== "" ? String(description).slice(0, 500) : null,
    impact: VALID_IMPACT.has(String(impact)) ? String(impact) : "medium",
    createdBy: await creatorName(req),
  }).returning();
  res.status(201).json(row);
}));

// PATCH /api/big7/catalysts/:id — edit date / type / description / impact (ticker too).
router.patch("/big7/catalysts/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) throw badRequest("INVALID_ID");
  const [existing] = await db.select({ createdBy: big7CatalystsTable.createdBy }).from(big7CatalystsTable).where(eq(big7CatalystsTable.id, id));
  if (!existing) throw notFound();
  if (!(await requireRowOwnerOrStaff(req, res, existing.createdBy))) return;
  const { ticker, date, type, description, impact } = req.body as Record<string, unknown>;
  const patch: Partial<typeof big7CatalystsTable.$inferInsert> = {};
  if (ticker !== undefined) {
    const t = String(ticker).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) throw badRequest("INVALID_TICKER");
    patch.ticker = t;
  }
  if (date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || Number.isNaN(Date.parse(String(date)))) {
      throw badRequest("INVALID_DATE");
    }
    patch.date = String(date);
  }
  if (type !== undefined) {
    const t = String(type).trim();
    if (!t || t.length > 40) throw new AppError("INVALID_FIELD", undefined, { field: "type" });
    patch.type = t;
  }
  if (description !== undefined) {
    patch.description = description != null && String(description).trim() !== "" ? String(description).slice(0, 500) : null;
  }
  if (impact !== undefined) {
    if (!VALID_IMPACT.has(String(impact))) throw new AppError("INVALID_FIELD", undefined, { field: "impact" });
    patch.impact = String(impact);
  }
  if (Object.keys(patch).length === 0) throw new AppError("NO_FIELDS");
  const [row] = await db.update(big7CatalystsTable).set(patch).where(eq(big7CatalystsTable.id, id)).returning();
  if (!row) throw notFound();
  res.json(row);
}));

router.delete("/big7/catalysts/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) throw badRequest("INVALID_ID");
  const [existing] = await db.select({ createdBy: big7CatalystsTable.createdBy }).from(big7CatalystsTable).where(eq(big7CatalystsTable.id, id));
  if (!existing) { res.status(204).send(); return; }
  if (!(await requireRowOwnerOrStaff(req, res, existing.createdBy))) return;
  await db.delete(big7CatalystsTable).where(eq(big7CatalystsTable.id, id));
  res.status(204).send();
}));

export default router;
