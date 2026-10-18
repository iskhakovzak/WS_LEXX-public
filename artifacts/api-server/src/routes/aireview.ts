import { Router, type IRouter, type Request, type Response } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { generateReview, getLatestReview, RateLimitedError } from "../lib/aiReview";
import { handleAiNotConfigured } from "../lib/aiErrors";
import { canAccessTrade } from "../lib/auth";
import { db, aiReviewRateLimitTable, aiTradeReviewsTable } from "@workspace/db";
import { eq, and, gte, sql, inArray } from "drizzle-orm";
import { AppError, badRequest, notFound, sendError, sendErrorWith } from "../lib/http";
import { langOf } from "../i18n";

/**
 * AI reviews are personal feedback (like curator reviews): the trade's owner and whoever may read it through the
 * permission matrix (trades.read.team). A playbook example opened by another trader is NOT enough — the review
 * quotes the trade's $. Sends 404/403 and returns false when denied.
 */
async function requireReviewAccess(req: Request, res: Response, id: number): Promise<boolean> {
  const ok = await canAccessTrade(req, id, "read");
  if (ok === null) { sendError(res, notFound("TRADE_NOT_FOUND")); return false; }
  if (!ok) throw new AppError("OWN_TRADES_ONLY");
  return true;
}

const router: IRouter = Router();

const RATE_LIMIT_PER_USER = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Rate-limit / usage key = the signed-in member's name from the token. Every /api route except the public list in
 * lib/auth requires a token, so there is no anonymous caller here (the old x-user / body / query fallbacks are gone).
 */
function userKeyFor(req: Request): string {
  return req.authUser?.name?.trim() || "anonymous";
}

router.get("/ai-review/usage", asyncHandler(async (req, res): Promise<void> => {
  const userKey = userKeyFor(req);

  const now = Date.now();
  const hourlyCutoff = new Date(now - RATE_LIMIT_WINDOW_MS);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const [hourlyRows, dailyRateLimitRows] = await Promise.all([
    db.select({ id: aiReviewRateLimitTable.id })
      .from(aiReviewRateLimitTable)
      .where(and(eq(aiReviewRateLimitTable.userKey, userKey), gte(aiReviewRateLimitTable.createdAt, hourlyCutoff))),
    db.select({ tradeId: aiReviewRateLimitTable.tradeId })
      .from(aiReviewRateLimitTable)
      .where(and(eq(aiReviewRateLimitTable.userKey, userKey), gte(aiReviewRateLimitTable.createdAt, todayStart))),
  ]);

  const hourlyCount = hourlyRows.length;
  const dailyCount = dailyRateLimitRows.length;

  let dailyCostUsd = 0;
  const dailyTradeIds = dailyRateLimitRows.map(r => r.tradeId).filter((id): id is number => id != null);
  if (dailyTradeIds.length > 0) {
    const costRows = await db
      .select({ costUsd: sql<string>`COALESCE(SUM(${aiTradeReviewsTable.costUsd}), 0)` })
      .from(aiTradeReviewsTable)
      .where(and(
        inArray(aiTradeReviewsTable.tradeId, dailyTradeIds),
        gte(aiTradeReviewsTable.generatedAt, todayStart),
      ));
    dailyCostUsd = parseFloat(costRows[0]?.costUsd ?? "0");
  }

  res.json({
    userKey,
    hourlyCount,
    hourlyLimit: RATE_LIMIT_PER_USER,
    dailyCount,
    dailyCostUsd,
  });
}));

router.post("/trades/:id/ai-review", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  if (!(await requireReviewAccess(req, res, id))) return;
  const userKey = userKeyFor(req);
  const force = req.query.force === "true" || req.body?.force === true;
  try {
    const result = await generateReview({ tradeId: id, userKey, force, lang: langOf(req) });
    res.status(201).json(result);
  } catch (e: any) {
    if (e instanceof RateLimitedError) {
      res.setHeader("Retry-After", String(e.retryAfterSec));
      sendErrorWith(res, new AppError("RATE_LIMITED", 429), { retryAfterSec: e.retryAfterSec });
      return;
    }
    if (e.message?.includes("not found")) {
      sendError(res, notFound("TRADE_NOT_FOUND"));
      return;
    }
    if (handleAiNotConfigured(e, res)) return; // 503 ai_not_configured (audit P2-3)
    req.log?.error({ error: e.message, tradeId: id }, "ai review failed");
    sendError(res, new AppError("AI_UNAVAILABLE", 500));
  }
}));

router.get("/trades/:id/ai-review", asyncHandler(async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("INVALID_ID");
  if (!(await requireReviewAccess(req, res, id))) return;
  const review = await getLatestReview(id);
  if (!review) throw new AppError("NO_DATA");
  res.json(review);
}));

export default router;
