import { eq } from "drizzle-orm";
import { db, dailyQuotesTable } from "@workspace/db";
import { logger } from "./logger";
import { logAudit } from "./audit";
import { generateBundleAndUpsert } from "../routes/dailyQuotes";

function todayKeyMsk(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

/**
 * Ensures today's (Moscow date) quote bundle exists with EN texts. Job registry: "quotes.daily" — 23:00 NY (≈ 06:00 MSK)
 * plus once 15 s after boot. Idempotent: returns without an AI call when the row is complete.
 */
export async function ensureTodayQuote(reason: string): Promise<Record<string, unknown>> {
  const date = todayKeyMsk();
  const rows = await db.select().from(dailyQuotesTable).where(eq(dailyQuotesTable.date, date)).limit(1);
  const row = rows[0];
  const needs = !row || !row.tradingEn || !row.psychologyEn;
  if (!needs) return { date, generated: false };
  logger.info({ date, reason, hasRow: !!row }, "daily-quote: regenerating");
  await generateBundleAndUpsert(date);
  await logAudit({ actor: "system", action: "daily_quote.cron", targetType: "daily_quote", targetId: date, details: { reason } });
  return { date, generated: true };
}
