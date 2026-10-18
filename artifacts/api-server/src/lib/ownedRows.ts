/**
 * Owner-or-staff guard for shared desk rows that carry `created_by` (big7 levels / catalysts / tickers, watchlist).
 * The rule itself is pure (accessRules.canModifyOwnedRow, unit-tested); this file only resolves the actor
 * (role from the DB, inactive/banned → null) and sends the 401/403.
 */
import type { Request, Response } from "express";
import { resolveActor } from "./permissions";
import { canModifyOwnedRow } from "./accessRules";
import { AppError, sendError, unauthorized } from "./http/errors";

/** Name to stamp into created_by on insert (the resolved, active member), or null for guest/anonymous. */
export async function creatorName(req: Request): Promise<string | null> {
  const actor = await resolveActor(req);
  return actor && !actor.guest ? actor.name : null;
}

/** Non-sending check (e.g. to filter a bulk action). */
export async function mayModifyRow(req: Request, createdBy: string | null | undefined): Promise<boolean> {
  return canModifyOwnedRow(await resolveActor(req), createdBy);
}

/** Sends 401 (no active actor) / 403 NOT_OWNER and returns false when the caller may not edit/delete the row. */
export async function requireRowOwnerOrStaff(req: Request, res: Response, createdBy: string | null | undefined): Promise<boolean> {
  const actor = await resolveActor(req);
  if (!actor) { sendError(res, unauthorized()); return false; }
  if (!canModifyOwnedRow(actor, createdBy)) { sendError(res, new AppError("NOT_OWNER")); return false; }
  return true;
}
