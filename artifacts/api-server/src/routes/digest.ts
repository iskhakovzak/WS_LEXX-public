import { Router, type IRouter } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { getActor, isGuest } from "../lib/auth";
import { can } from "../lib/permissions";
import type { Request, Response } from "express";
import {
  getSubscription,
  upsertSubscription,
  buildDigest,
  sendDigestToTrader,
} from "../lib/digest";
import { AppError, sendError, unauthorized } from "../lib/http";

const router: IRouter = Router();

/**
 * Subscriptions hold contact data (email / Telegram chat id) and trigger
 * outbound messages, so only the user themselves (or staff: curator/admin) may touch them.
 * Subscriptions are keyed by the signed-in user's name — curators without a "trader" profile get their own digest too.
 */
async function ensureSelf(req: Request, res: Response, trader: string): Promise<boolean> {
  const actor = getActor(req);
  if (!actor) { sendError(res, unauthorized()); return false; }
  if (isGuest(req)) throw new AppError("GUEST_UNAVAILABLE");
  if (actor !== trader && !(await can(req, "digest.manage.any", { trader }))) throw new AppError("OWN_DATA_ONLY");
  return true;
}

/** `trader` from query/body for staff, otherwise always the signed-in user. */
function subjectOf(req: Request, requested: unknown): string {
  const me = getActor(req) ?? "";
  const r = typeof requested === "string" ? requested.trim() : "";
  return r || me;
}

router.get("/digest/subscription", asyncHandler(async (req, res): Promise<void> => {
  const trader = subjectOf(req, req.query.trader);
  if (!trader) throw unauthorized();
  if (!(await ensureSelf(req, res, trader))) return;
  const sub = await getSubscription(trader);
  res.json({ subscription: sub });
}));

router.put("/digest/subscription", asyncHandler(async (req, res): Promise<void> => {
  const {
    trader,
    enabled,
    channel,
    telegramChatId,
    email,
    sendMorning,
    sendEvening,
    tradesWindowHours,
  } = req.body as Record<string, unknown>;

  const subject = subjectOf(req, trader);
  if (!subject) throw unauthorized();
  if (!(await ensureSelf(req, res, subject))) return;

  const VALID_CHANNELS = ["none", "telegram", "email", "both"];
  if (channel !== undefined && !VALID_CHANNELS.includes(String(channel))) throw new AppError("INVALID_FIELD", undefined, { field: "channel" });

  const patch: Parameters<typeof upsertSubscription>[1] = {};
  if (enabled !== undefined) patch.enabled = Boolean(enabled);
  if (channel !== undefined) patch.channel = String(channel);
  if ("telegramChatId" in req.body) patch.telegramChatId = telegramChatId != null ? String(telegramChatId) : null;
  if ("email" in req.body) patch.email = email != null ? String(email) : null;
  if (sendMorning !== undefined) patch.sendMorning = Boolean(sendMorning);
  if (sendEvening !== undefined) patch.sendEvening = Boolean(sendEvening);
  if (tradesWindowHours !== undefined) {
    const n = Number(tradesWindowHours);
    if (!isNaN(n) && n > 0 && n <= 168) patch.tradesWindowHours = n;
  }

  const sub = await upsertSubscription(subject, patch);
  res.json({ subscription: sub });
}));

router.post("/digest/send", asyncHandler(async (req, res): Promise<void> => {
  const { trader } = req.body as Record<string, unknown>;
  const subject = subjectOf(req, trader);
  if (!subject) throw unauthorized();
  if (!(await ensureSelf(req, res, subject))) return;
  const result = await sendDigestToTrader(subject);
  res.json(result);
}));

router.get("/digest/preview", asyncHandler(async (req, res): Promise<void> => {
  const trader = subjectOf(req, req.query.trader);
  if (!trader) throw unauthorized();
  if (!(await ensureSelf(req, res, trader))) return;
  const hoursRaw = Number(req.query.hours);
  const windowHours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(168, Math.max(1, hoursRaw)) : 24;
  const { trades, text } = await buildDigest(trader, windowHours);
  res.json({ trader, windowHours, tradesCount: trades.length, text });
}));

export default router;
