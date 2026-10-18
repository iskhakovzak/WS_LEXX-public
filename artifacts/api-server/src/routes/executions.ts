import { Router, type IRouter, type Request, type Response } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { pool } from "@workspace/db";
import { isReadableExampleTrade, loadMoneyViewer } from "../lib/playbookAccess";
import { redactExecutions, redactStructure } from "../lib/playbookPrivacy";
import { roleLabel } from "../lib/tradeStructure";
import { langOf } from "../i18n";
import { refreshTradeStructures, structureForTrade } from "../lib/tradeStructureStore";
import { structureSummary } from "../lib/tradeStructure";
import { logger } from "../lib/logger";
import { can, resolveActor } from "../lib/permissions";
import { canReadTradeExecutions } from "../lib/accessRules";
import { AppError, badRequest, notFound, sendError, unauthorized } from "../lib/http";

const router: IRouter = Router();

const KIND_VALUES = ["entry", "add", "trim", "exit", "stop"] as const;
type ExecutionKind = (typeof KIND_VALUES)[number];

export type ExecutionRow = {
  id: number;
  tradeId: number;
  kind: ExecutionKind;
  price: string;
  qty: string | null;
  executedAt: string | null;
  note: string | null;
  sortOrder: number;
  /** lib/tradeStructure: what this fill did — entry / reentry / flip / add / partial_exit / exit / stop. */
  role: string | null;
  roleLabel: string | null;
  /** The role is a heuristic guess (stop without a known stop level). */
  roleInferred: boolean;
  /** Fills of one order filled in pieces share a leg. */
  legIndex: number | null;
};

/** Recompute the stored roles after an edit; never fails the request. */
async function refreshAfterEdit(tradeId: number): Promise<void> {
  await refreshTradeStructures([tradeId]).catch((e) => logger.warn({ err: e instanceof Error ? e.message : String(e), tradeId }, "trade structure refresh failed"));
}

type CreateExecutionInput = {
  kind: ExecutionKind;
  price: number;
  qty: number | null;
  executedAt: string | null;
  note: string | null;
  sortOrder: number | null;
};

function parseCreateBody(body: unknown): { ok: true; value: CreateExecutionInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;

  const kind = b.kind;
  if (typeof kind !== "string" || !(KIND_VALUES as readonly string[]).includes(kind)) {
    return { ok: false, error: `kind must be one of: ${KIND_VALUES.join(", ")}` };
  }

  const priceNum = typeof b.price === "number" ? b.price : Number(b.price);
  if (!Number.isFinite(priceNum) || priceNum <= 0) return { ok: false, error: "price must be a positive number" };

  let qty: number | null = null;
  if (b.qty != null && b.qty !== "") {
    const q = typeof b.qty === "number" ? b.qty : Number(b.qty);
    if (!Number.isFinite(q) || q <= 0) return { ok: false, error: "qty must be a positive number" };
    qty = q;
  }

  let executedAt: string | null = null;
  if (b.executedAt != null && b.executedAt !== "") {
    if (typeof b.executedAt !== "string") return { ok: false, error: "executedAt must be a string" };
    const d = new Date(b.executedAt);
    if (Number.isNaN(d.getTime())) return { ok: false, error: "executedAt must be a valid ISO datetime" };
    executedAt = d.toISOString();
  }

  let note: string | null = null;
  if (b.note != null && b.note !== "") {
    if (typeof b.note !== "string") return { ok: false, error: "note must be a string" };
    if (b.note.length > 500) return { ok: false, error: "note too long (max 500)" };
    note = b.note;
  }

  let sortOrder: number | null = null;
  if (b.sortOrder != null) {
    const s = typeof b.sortOrder === "number" ? b.sortOrder : Number(b.sortOrder);
    if (!Number.isFinite(s) || !Number.isInteger(s)) return { ok: false, error: "sortOrder must be integer" };
    sortOrder = s;
  }

  return { ok: true, value: { kind: kind as ExecutionKind, price: priceNum, qty, executedAt, note, sortOrder } };
}

/**
 * Resolves the parent trade and enforces access through the permission matrix (same rule as GET/PATCH /trades/:id):
 *   write — own trade (trades.write.own) or trades.write.any (curators/admins by default);
 *   read  — own trade, trades.read.team, or the trade is an example of a setup the viewer may read in the playbook
 *           (the chart of «Открыть сделку»; qty / $ are redacted for non-staff by lib/playbookPrivacy).
 * Guests never (lib/accessRules canReadTradeExecutions). Sends the error response itself and returns false when
 * access is denied; otherwise the trade's owner.
 */
async function assertTradeAccess(req: Request, res: Response, tradeId: number, mode: "read" | "write" = "write"): Promise<{ trader: string | null } | false> {
  const { rows } = await pool.query<{ trader: string | null }>(
    `SELECT trader FROM trades WHERE id = $1 AND deleted_at IS NULL`,
    [tradeId]
  );
  if (rows.length === 0) {
    sendError(res, notFound("TRADE_NOT_FOUND"));
    return false;
  }
  const owner = rows[0].trader;
  const actor = await resolveActor(req);
  if (!actor) {
    sendError(res, unauthorized());
    return false;
  }
  if (mode === "write") {
    const own = owner === actor.name && (await can(req, "trades.write.own", { trader: owner }));
    if (actor.guest || !(own || (await can(req, "trades.write.any", { trader: owner })))) {
      throw new AppError("OWN_TRADES_ONLY");
    }
    return { trader: owner };
  }
  const isOwn = !!owner && owner === actor.name;
  const teamAllowed = !isOwn && !actor.guest && (await can(req, "trades.read.team", { trader: owner }));
  const readableExample = !isOwn && !teamAllowed && !actor.guest && (await isReadableExampleTrade(req, tradeId));
  if (!canReadTradeExecutions(actor, owner, { teamAllowed, readableExample })) {
    throw new AppError("OWN_TRADES_ONLY");
  }
  return { trader: owner };
}

// GET /api/trades/:tradeId/executions
router.get(
  "/trades/:tradeId/executions",
  asyncHandler(async (req: Request, res: Response) => {
    const tradeId = Number(req.params.tradeId);
    if (!Number.isFinite(tradeId) || tradeId <= 0) {
      throw badRequest("INVALID_ID");
    }
    const access = await assertTradeAccess(req, res, tradeId, "read");
    if (!access) return;
    const { rows } = await pool.query(
      `SELECT id, trade_id, kind, price, qty, executed_at, note, sort_order
         FROM trade_executions
        WHERE trade_id = $1
        ORDER BY sort_order ASC, id ASC`,
      [tradeId]
    );
    // Structure is computed on read (always matches the fills); the stored copy only feeds lists and back-fills.
    const computed = await structureForTrade(tradeId, undefined, langOf(req)).catch((e) => {
      logger.warn({ err: e instanceof Error ? e.message : String(e), tradeId }, "trade structure failed");
      return null;
    });
    const byExec = computed?.structure.byExecution ?? {};
    const data: ExecutionRow[] = rows.map((r) => {
      const s = byExec[r.id];
      return {
        id: r.id,
        tradeId: r.trade_id,
        kind: r.kind,
        price: String(r.price),
        qty: r.qty != null ? String(r.qty) : null,
        executedAt: r.executed_at ? new Date(r.executed_at).toISOString() : null,
        note: r.note,
        sortOrder: r.sort_order,
        role: s?.role ?? null,
        roleLabel: s ? roleLabel(s.role, langOf(req)) : null,
        roleInferred: s?.inferred ?? false,
        legIndex: s?.legIndex ?? null,
      };
    });
    // $ privacy (lib/playbookPrivacy): someone else's fills come without qty (and the legs without size / $)
    // unless the viewer is staff.
    const viewer = await loadMoneyViewer(req);
    const structure = computed
      ? { ...redactStructure({ legs: computed.structure.legs, stats: { ...computed.structure.stats, summary: structureSummary(computed.structure.stats, langOf(req)) } }, viewer, access.trader), siblings: computed.siblings }
      : null;
    res.json({ tradeId, executions: redactExecutions(data, viewer, access.trader), structure });
  })
);

/**
 * GET /api/trade-executions/batch?ids=1,2,3 — fill times only (kind / price / executedAt) for many trades in one
 * request: trade lists draw a sparkline per row and used to fire one /executions request per trade (N+1).
 * Same read rule as the single endpoint for own / team trades; ids the viewer may not read this way (e.g. a playbook
 * example of another trader) are simply absent — the client falls back to GET /trades/:id/executions for those.
 * Response: { items: { [tradeId]: { kind, price, executedAt }[] } } (an empty array = no fills).
 */
router.get(
  "/trade-executions/batch",
  asyncHandler(async (req: Request, res: Response) => {
    const ids = [...new Set(String(req.query.ids ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
    const actor = await resolveActor(req);
    if (!actor) {
      throw unauthorized();
    }
    if (!ids.length || actor.guest) {
      res.json({ items: {} });
      return;
    }
    const { rows: trades } = await pool.query<{ id: number; trader: string | null }>(
      `SELECT id, trader FROM trades WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
      [ids],
    );
    const teamByTrader = new Map<string | null, boolean>();
    const allowed: number[] = [];
    for (const t of trades) {
      const isOwn = !!t.trader && t.trader === actor.name;
      let teamAllowed = false;
      if (!isOwn) {
        if (!teamByTrader.has(t.trader)) teamByTrader.set(t.trader, await can(req, "trades.read.team", { trader: t.trader }));
        teamAllowed = teamByTrader.get(t.trader) ?? false;
      }
      if (canReadTradeExecutions(actor, t.trader, { teamAllowed, readableExample: false })) allowed.push(Number(t.id));
    }
    const items: Record<number, { kind: string; price: string; executedAt: string | null }[]> = {};
    for (const id of allowed) items[id] = [];
    if (allowed.length) {
      const { rows } = await pool.query(
        `SELECT trade_id, kind, price, executed_at
           FROM trade_executions
          WHERE trade_id = ANY($1::int[])
          ORDER BY trade_id, sort_order ASC, id ASC`,
        [allowed],
      );
      for (const r of rows) {
        items[r.trade_id]?.push({ kind: r.kind, price: String(r.price), executedAt: r.executed_at ? new Date(r.executed_at).toISOString() : null });
      }
    }
    res.json({ items });
  })
);

// POST /api/trades/:tradeId/executions
router.post(
  "/trades/:tradeId/executions",
  asyncHandler(async (req: Request, res: Response) => {
    const tradeId = Number(req.params.tradeId);
    if (!Number.isFinite(tradeId) || tradeId <= 0) {
      throw badRequest("INVALID_ID");
    }
    const parsed = parseCreateBody(req.body);
    if (!parsed.ok) {
      throw new AppError("VALIDATION", 400, undefined, parsed.error);
    }
    if (!(await assertTradeAccess(req, res, tradeId))) return;
    const v = parsed.value;
    const { rows } = await pool.query(
      `INSERT INTO trade_executions (trade_id, kind, price, qty, executed_at, note, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 0))
       RETURNING id`,
      [tradeId, v.kind, v.price, v.qty, v.executedAt, v.note, v.sortOrder]
    );
    await refreshAfterEdit(tradeId);
    res.status(201).json({ id: rows[0].id });
  })
);

// DELETE /api/trades/:tradeId/executions/:execId
router.delete(
  "/trades/:tradeId/executions/:execId",
  asyncHandler(async (req: Request, res: Response) => {
    const tradeId = Number(req.params.tradeId);
    const execId = Number(req.params.execId);
    const validId = (n: number) => Number.isInteger(n) && n > 0;
    if (!validId(tradeId) || !validId(execId)) {
      throw badRequest("INVALID_ID");
    }
    if (!(await assertTradeAccess(req, res, tradeId))) return;
    const { rowCount } = await pool.query(
      `DELETE FROM trade_executions WHERE id = $1 AND trade_id = $2`,
      [execId, tradeId]
    );
    if (rowCount === 0) {
      throw notFound();
    }
    await refreshAfterEdit(tradeId);
    res.status(204).end();
  })
);

export default router;
