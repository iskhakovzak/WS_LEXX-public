/**
 * Daily loop (owner goal 2026-10-18: every visit gives one useful thing). Logic: lib/daily/service.ts over the pure
 * engine lib/daily/engine.ts; shapes: lib/daily/types.ts.
 *
 *   GET  /api/daily/me                     the viewer's DailyMe: phase, focus, last finished day, tier progress, intraday
 *   GET  /api/daily/trader/:name           the same for a trader (journal.review on that trader — like /curator/trader/:name)
 *   POST /api/daily/review                 {date, note?, dispute?} — the viewer marks a finished day reviewed;
 *                                          dispute = «the focus hit was not a mistake» (409 DAILY_NOTHING_TO_DISPUTE
 *                                          when the day's focus was not broken)
 *   PUT  /api/daily/focus/:trader/:date    {mistake: MistakeId | null} — curator override (journal.review on the trader);
 *                                          null = back to the engine's pick
 *
 * A trader only ever sees their own card; staff see the traders their journal.review scope covers.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { assertCap, route } from "../lib/http/route";
import { AppError, badRequest, notFound } from "../lib/http";
import { nyDate } from "../lib/tradingDate";
import { isMistakeId } from "../lib/daily/engine";
import { dailyMe, eveningFor, markReviewed, setFocusOverride } from "../lib/daily/service";

const router: IRouter = Router();

const isRealDate = (s: string) => {
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, "invalid date");
const traderName = z.string().trim().min(1).max(100);
const mistake = z.string().max(80).refine(isMistakeId, "unknown mistake");

async function traderExists(name: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM users WHERE name = $1 LIMIT 1`, [name]);
  return rows.length > 0;
}

router.get("/daily/me", route({}, async ({ req }) => {
  const me = req.authUser?.name;
  const actor = await assertCap(req, "trades.read.own", { trader: me ?? "" });
  return dailyMe(actor.name);
}));

router.get("/daily/trader/:name", route({ params: z.object({ name: traderName }) }, async ({ req, params }) => {
  await assertCap(req, "journal.review", { trader: params.name });
  if (!(await traderExists(params.name))) throw notFound("TRADER_NOT_FOUND");
  return dailyMe(params.name);
}));

const ReviewBody = z.object({
  date: ymd,
  note: z.string().max(500).nullable().optional(),
  dispute: z.boolean().optional(),
});

router.post("/daily/review", route({ body: ReviewBody }, async ({ req, body }) => {
  const actor = await assertCap(req, "journal.write.own", { trader: req.authUser?.name ?? "" });
  if (body.date > nyDate()) throw badRequest("INVALID_DATE");
  if (body.dispute) {
    const card = await eveningFor(actor.name, body.date);
    if (card?.focus?.status !== "broken") throw new AppError("DAILY_NOTHING_TO_DISPUTE");
  }
  await markReviewed(actor.name, body.date, { note: body.note, dispute: body.dispute });
  return { ok: true, date: body.date, reviewed: true, disputed: !!body.dispute };
}));

router.put("/daily/focus/:trader/:date", route({
  params: z.object({ trader: traderName, date: ymd }),
  body: z.object({ mistake: mistake.nullable() }),
}, async ({ req, params, body }) => {
  const actor = await assertCap(req, "journal.review", { trader: params.trader });
  if (!(await traderExists(params.trader))) throw notFound("TRADER_NOT_FOUND");
  return setFocusOverride(params.trader, params.date, body.mistake, actor.name);
}));

export default router;
