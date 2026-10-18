import { Router, type IRouter } from "express";
import { eq, desc, ne } from "drizzle-orm";
import { db, big7LevelsTable } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { creatorName, requireRowOwnerOrStaff } from "../lib/ownedRows";
import { AppError, badRequest, notFound } from "../lib/http";

const router: IRouter = Router();

function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Price must be a finite number; otherwise numeric column would 500 or store NaN. */
function parsePrice(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? String(n) : null;
}

/** Seed/demo ticker that must never reach the desk (row kept in the DB, only hidden from reads). */
const SEED_TICKER = "TEST";

router.get("/big7levels", asyncHandler(async (_req, res): Promise<void> => {
  const rows = await db.select().from(big7LevelsTable)
    .where(ne(big7LevelsTable.ticker, SEED_TICKER))
    .orderBy(desc(big7LevelsTable.createdAt));
  res.json(rows);
}));

router.post("/big7levels", asyncHandler(async (req, res): Promise<void> => {
  const { ticker, label, price, notes } = req.body as Record<string, unknown>;
  if (!ticker || !label || price === undefined || price === null) throw new AppError("FIELD_REQUIRED", undefined, { field: "ticker, label, price" });
  const priceStr = parsePrice(price);
  if (priceStr === null) throw new AppError("INVALID_FIELD", undefined, { field: "price" });
  const [row] = await db.insert(big7LevelsTable).values({
    ticker: String(ticker).trim().toUpperCase(),
    label: String(label),
    price: priceStr,
    notes: notes != null ? String(notes) : null,
    createdBy: await creatorName(req),
  }).returning();
  res.status(201).json(row);
}));

router.patch("/big7levels/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) throw badRequest("INVALID_ID");
  const [existing] = await db.select({ createdBy: big7LevelsTable.createdBy }).from(big7LevelsTable).where(eq(big7LevelsTable.id, id));
  if (!existing) throw notFound();
  if (!(await requireRowOwnerOrStaff(req, res, existing.createdBy))) return;
  const { ticker, label, price, notes } = req.body as Record<string, unknown>;
  const priceStr = price !== undefined ? parsePrice(price) : undefined;
  if (priceStr === null) throw new AppError("INVALID_FIELD", undefined, { field: "price" });
  const [row] = await db.update(big7LevelsTable).set({
    ticker: ticker !== undefined ? String(ticker).toUpperCase() : undefined,
    label: label !== undefined ? String(label) : undefined,
    price: priceStr,
    notes: notes !== undefined ? (notes != null ? String(notes) : null) : undefined,
  }).where(eq(big7LevelsTable.id, id)).returning();
  if (!row) throw notFound();
  res.json(row);
}));

router.delete("/big7levels/:id", asyncHandler(async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) throw badRequest("INVALID_ID");
  const [existing] = await db.select({ createdBy: big7LevelsTable.createdBy }).from(big7LevelsTable).where(eq(big7LevelsTable.id, id));
  if (!existing) { res.status(204).send(); return; }
  if (!(await requireRowOwnerOrStaff(req, res, existing.createdBy))) return;
  await db.delete(big7LevelsTable).where(eq(big7LevelsTable.id, id));
  res.status(204).send();
}));

export default router;
