/**
 * Simulator (/simulator) — a hidden real chart, bar by bar, with the desk's fees; the server holds the future.
 *
 *   POST /api/sim/games                {mode, difficulty}        new game (the previous active one is settled first)
 *   GET  /api/sim/games/active                                   the active game (bars up to the cursor) or null
 *   GET  /api/sim/games/:id                                      own game; finished ones carry the reveal
 *   POST /api/sim/games/:id/step       {order?, bracket?, advance} act at the current bar's close, then show N bars
 *   POST /api/sim/games/:id/undo                                 cancel the last order (same bar only)
 *   POST /api/sim/games/:id/finish                               close the position, play out the rest flat, reveal
 *   GET  /api/sim/me                                             history, bests, streaks, opt-in
 *   GET  /api/sim/leaderboard?week=YYYY-MM-DD                    weekly desk board (opted-in players + the viewer)
 *   PUT  /api/sim/prefs                {leaderboardVisible}
 *   GET  /api/sim/own/candidates                                 «Мои худшие дни»: the viewer's replayable losses
 *   POST /api/sim/own                  {pick, tradeId?}          new own game (worst of 30 days | random loss | a trade)
 *
 * Members only (guests are read-only and a game writes). Logic: lib/sim/service.ts; engine: lib/sim/engine.ts.
 */
import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { route, idParam, unauthorized, AppError } from "../lib/http";
import { resolveActor } from "../lib/permissions";
import * as sim from "../lib/sim/service";
import { createOwnGame, ownCandidates } from "../lib/sim/ownService";

const router: IRouter = Router();

async function viewerOf(req: Request): Promise<sim.Viewer> {
  const actor = await resolveActor(req);
  if (!actor) throw unauthorized();
  if (actor.guest) throw new AppError("GUEST_READ_ONLY");
  return { id: actor.id, name: actor.name, staff: actor.role === "curator" || actor.role === "admin" };
}

const mode = z.enum(["intraday", "swing"]);
const difficulty = z.enum(["easy", "medium", "hard"]);
const price = z.number().finite().positive().max(1_000_000);

router.post("/sim/games", route({ body: z.object({ mode, difficulty }) }, async ({ req, body }) => {
  return sim.createGame(await viewerOf(req), body.mode, body.difficulty);
}));

router.get("/sim/games/active", route({}, async ({ req }) => {
  return { game: await sim.activeSnapshot(await viewerOf(req)) };
}));

router.get("/sim/games/:id", route({ params: z.object({ id: idParam }) }, async ({ req, params }) => {
  return sim.gameSnapshot(await viewerOf(req), params.id);
}));

router.post("/sim/games/:id/step", route({
  params: z.object({ id: idParam }),
  body: z.object({
    order: z.object({ kind: z.enum(["buy", "sell", "flat"]), qty: z.number().int().min(1).max(1_000_000).optional() }).nullish(),
    bracket: z.object({ stop: price.nullable(), target: price.nullable() }).nullish(),
    advance: z.number().int().min(0).max(60).default(1),
  }),
}, async ({ req, params, body }) => {
  return sim.step(await viewerOf(req), params.id, body);
}));

router.post("/sim/games/:id/undo", route({ params: z.object({ id: idParam }) }, async ({ req, params }) => {
  return sim.undo(await viewerOf(req), params.id);
}));

router.post("/sim/games/:id/finish", route({ params: z.object({ id: idParam }) }, async ({ req, params }) => {
  return sim.finish(await viewerOf(req), params.id);
}));

router.get("/sim/me", route({}, async ({ req }) => {
  return sim.myStats(await viewerOf(req));
}));

router.get("/sim/leaderboard", route({ query: z.object({ week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }) }, async ({ req, query }) => {
  return sim.leaderboard(await viewerOf(req), query.week ?? null);
}));

router.put("/sim/prefs", route({ body: z.object({ leaderboardVisible: z.boolean() }) }, async ({ req, body }) => {
  return sim.updatePrefs(await viewerOf(req), body.leaderboardVisible);
}));

router.get("/sim/own/candidates", route({}, async ({ req }) => {
  return ownCandidates(await viewerOf(req));
}));

router.post("/sim/own", route({
  body: z.object({ pick: z.enum(["worst", "random", "trade"]), tradeId: idParam.optional() })
    .refine((b) => b.pick !== "trade" || b.tradeId != null, { message: "tradeId", path: ["tradeId"] }),
}, async ({ req, body }) => {
  return createOwnGame(await viewerOf(req), body.pick, body.tradeId ?? null);
}));

export default router;
