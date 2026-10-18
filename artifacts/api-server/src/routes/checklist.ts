import { Router, type IRouter } from "express";
import { eq, and, desc, isNull } from "drizzle-orm";
import { db, preTradeChecklistTemplateTable, preTradeChecklistResponsesTable } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { requireMember, scopeTrader, canAccessTrade, GUEST_SCOPE } from "../lib/auth";
import { can } from "../lib/permissions";
import { z } from "zod";
import { badRequest, conflict, forbidden, idParam, notFound, route, unauthorized } from "../lib/http";

const router: IRouter = Router();

/**
 * Template management used to be gated by a shared admin password with a hard-coded
 * fallback ("0987") that also shipped in the frontend bundle. Access is now derived
 * from the caller's JWT and their *current* role in the DB (lib/auth requireStaff):
 * only active, non-banned curators/admins may change the team checklist template.
 *
 * Responses are personal pre-trade records: a member reads/writes only their own,
 * staff see everyone's, guests see nothing (scopeTrader → GUEST_SCOPE).
 */

const TemplateQuery = z.object({ includeInactive: z.string().optional() });
const TemplateItemCreate = z.object({
  label: z.string().trim().min(1).transform((v) => v.slice(0, 500)),
  description: z.string().nullish(),
  required: z.boolean().optional(),
  sortOrder: z.number().finite().optional(),
  active: z.boolean().optional(),
});
const TemplateItemPatch = z.object({
  label: z.string().optional(),
  description: z.string().nullish(),
  required: z.boolean().optional(),
  sortOrder: z.number().finite().optional(),
  active: z.boolean().optional(),
});
const TemplateItemParams = z.object({ id: idParam });

router.get("/checklist-template", route({ query: TemplateQuery }, async ({ query }) => {
  let rows = await db
    .select()
    .from(preTradeChecklistTemplateTable)
    .orderBy(preTradeChecklistTemplateTable.sortOrder, preTradeChecklistTemplateTable.id);
  if (query.includeInactive !== "true") rows = rows.filter((r) => r.active);
  return rows;
}));

router.post("/checklist-template", route({ cap: "checklist.template.edit", body: TemplateItemCreate }, async ({ body, res }) => {
  const [row] = await db.insert(preTradeChecklistTemplateTable).values({
    label: body.label,
    description: body.description ? body.description.slice(0, 2000) : null,
    required: body.required !== false,
    sortOrder: body.sortOrder ?? 0,
    active: body.active !== false,
  }).returning();
  res.status(201);
  return row;
}));

router.patch("/checklist-template/:id", route({ cap: "checklist.template.edit", params: TemplateItemParams, body: TemplateItemPatch }, async ({ params, body }) => {
  const update: Record<string, unknown> = {};
  if (body.label?.trim()) update.label = body.label.trim().slice(0, 500);
  if (body.description !== undefined) update.description = body.description ? body.description.slice(0, 2000) : null;
  if (body.required !== undefined) update.required = body.required;
  if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
  if (body.active !== undefined) update.active = body.active;
  if (Object.keys(update).length === 0) throw badRequest("NO_FIELDS");
  const [row] = await db.update(preTradeChecklistTemplateTable)
    .set(update)
    .where(eq(preTradeChecklistTemplateTable.id, params.id))
    .returning();
  if (!row) throw notFound("CHECKLIST_ITEM_NOT_FOUND");
  return row;
}));

router.delete("/checklist-template/:id", route({ cap: "checklist.template.edit", params: TemplateItemParams }, async ({ params }) => {
  const [row] = await db.update(preTradeChecklistTemplateTable)
    .set({ active: false })
    .where(eq(preTradeChecklistTemplateTable.id, params.id))
    .returning();
  if (!row) throw notFound("CHECKLIST_ITEM_NOT_FOUND");
  return { success: true };
}));

/**
 * A response always belongs to the caller. Staff may file one on behalf of a trader
 * (body.trader); for everyone else body.trader is ignored. A tradeId may only point at a
 * trade the caller can access, and must not steal a response already linked elsewhere.
 */
router.post("/checklist-responses", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  const me = req.authUser!;
  const { ticker, tradeDate, trader, tradeId, responses, passed } = req.body as Record<string, unknown>;
  if (!ticker || typeof ticker !== "string") throw badRequest("TICKER_REQUIRED");
  if (!tradeDate || typeof tradeDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw badRequest("INVALID_DATE");
  if (!responses) throw badRequest("CHECKLIST_RESPONSES_REQUIRED");
  const wanted = typeof trader === "string" && trader.trim() ? trader.trim() : "";
  const staff = !!wanted && wanted !== me.name && (await can(req, "trades.write.any", { trader: wanted }));
  const owner = staff ? wanted : me.name;
  let linkedTradeId: number | null = null;
  if (tradeId != null) {
    if (typeof tradeId !== "number" || !Number.isInteger(tradeId)) throw badRequest("INVALID_ID");
    const access = await canAccessTrade(req, tradeId);
    if (access === null) throw notFound("TRADE_NOT_FOUND");
    if (!access) throw forbidden(undefined, "TRADE_FORBIDDEN");
    linkedTradeId = tradeId;
  }
  const responsesStr = typeof responses === "string" ? responses : JSON.stringify(responses);
  const [row] = await db.insert(preTradeChecklistResponsesTable).values({
    ticker: ticker.toUpperCase().trim(),
    tradeDate,
    trader: owner,
    tradeId: linkedTradeId,
    responses: responsesStr,
    passed: passed === true,
  }).returning();
  res.status(201).json(row);
}));

router.get("/checklist-responses", asyncHandler(async (req, res): Promise<void> => {
  const { tradeId, ticker, trader, tradeDate } = req.query as Record<string, string | undefined>;
  const scope = await scopeTrader(req, trader);
  if (scope === undefined) throw unauthorized();
  if (scope === GUEST_SCOPE) { res.json([]); return; }
  const conditions = [];
  if (tradeId) {
    const id = Number(tradeId);
    if (!Number.isInteger(id)) throw badRequest("INVALID_ID");
    // Lookup by trade: ownership of the trade decides (legacy responses may have trader = null).
    const access = await canAccessTrade(req, id);
    if (!access) { res.json([]); return; }
    conditions.push(eq(preTradeChecklistResponsesTable.tradeId, id));
  } else if (scope !== null) {
    conditions.push(eq(preTradeChecklistResponsesTable.trader, scope));
  }
  if (ticker) conditions.push(eq(preTradeChecklistResponsesTable.ticker, ticker.toUpperCase()));
  if (tradeDate) conditions.push(eq(preTradeChecklistResponsesTable.tradeDate, tradeDate));
  let q = db.select().from(preTradeChecklistResponsesTable).$dynamic();
  if (conditions.length > 0) q = q.where(and(...conditions));
  const rows = await q.orderBy(desc(preTradeChecklistResponsesTable.createdAt)).limit(100);
  res.json(rows);
}));

router.patch("/checklist-responses/:id/link", asyncHandler(async (req, res): Promise<void> => {
  if (!requireMember(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest("INVALID_ID");
  const { tradeId } = req.body as Record<string, unknown>;
  if (typeof tradeId !== "number" || !Number.isInteger(tradeId)) throw badRequest("INVALID_ID");
  const [existing] = await db
    .select({ id: preTradeChecklistResponsesTable.id, trader: preTradeChecklistResponsesTable.trader, tradeId: preTradeChecklistResponsesTable.tradeId })
    .from(preTradeChecklistResponsesTable)
    .where(eq(preTradeChecklistResponsesTable.id, id))
    .limit(1);
  if (!existing) throw notFound("CHECKLIST_NOT_FOUND");
  const staff = await can(req, "trades.write.any", existing.trader ? { trader: existing.trader } : undefined);
  if (!staff && existing.trader && existing.trader !== req.authUser!.name) {
    throw forbidden(undefined, "CHECKLIST_FORBIDDEN");
  }
  if (existing.tradeId != null && existing.tradeId !== tradeId) {
    throw conflict("CHECKLIST_ALREADY_LINKED");
  }
  const access = await canAccessTrade(req, tradeId);
  if (access === null) throw notFound("TRADE_NOT_FOUND");
  if (!access) throw forbidden(undefined, "TRADE_FORBIDDEN");
  const [row] = await db.update(preTradeChecklistResponsesTable)
    .set({ tradeId, ...(existing.trader ? {} : { trader: req.authUser!.name }) })
    .where(eq(preTradeChecklistResponsesTable.id, id))
    .returning();
  res.json(row);
}));

/**
 * Used by routes/trades.ts and tradeideas.ts to find the checklist that covers a trade.
 * By tradeId first; otherwise the latest UNLINKED response for that trader/ticker/date —
 * a response already attached to another trade is never re-used (audit §2.2).
 */
export async function findChecklistResponseFor(opts: {
  ticker: string;
  tradeDate: string;
  trader?: string | null;
  tradeId?: number | null;
}): Promise<{ id: number; passed: boolean } | null> {
  if (opts.tradeId) {
    const [r] = await db
      .select({ id: preTradeChecklistResponsesTable.id, passed: preTradeChecklistResponsesTable.passed })
      .from(preTradeChecklistResponsesTable)
      .where(eq(preTradeChecklistResponsesTable.tradeId, opts.tradeId))
      .limit(1);
    if (r) return r;
  }
  const conditions = [
    eq(preTradeChecklistResponsesTable.ticker, opts.ticker.toUpperCase()),
    eq(preTradeChecklistResponsesTable.tradeDate, opts.tradeDate),
    isNull(preTradeChecklistResponsesTable.tradeId),
  ];
  if (opts.trader) conditions.push(eq(preTradeChecklistResponsesTable.trader, opts.trader));
  const [r] = await db
    .select({ id: preTradeChecklistResponsesTable.id, passed: preTradeChecklistResponsesTable.passed })
    .from(preTradeChecklistResponsesTable)
    .where(and(...conditions))
    .orderBy(desc(preTradeChecklistResponsesTable.createdAt))
    .limit(1);
  return r ?? null;
}

export default router;
