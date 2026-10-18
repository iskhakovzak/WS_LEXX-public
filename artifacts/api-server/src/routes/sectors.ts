import { Router, type IRouter } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { getSectorStrength } from "../lib/marketDataService";

const router: IRouter = Router();

// Forced refreshes hit Yahoo directly; don't let a click-happy dashboard hammer it.
let lastForcedAt = 0;
const FORCE_MIN_INTERVAL_MS = 20_000;

router.get("/sectors", asyncHandler(async (req, res): Promise<void> => {
  let force = req.query.force === "1" || req.query.force === "true";
  if (force) {
    const now = Date.now();
    if (now - lastForcedAt < FORCE_MIN_INTERVAL_MS) force = false;
    else lastForcedAt = now;
  }
  const data = await getSectorStrength({ force });

  // Breadth summary for the heat strip header.
  const valid = data.filter((s) => s.changePct != null && Number.isFinite(s.changePct));
  const sorted = [...valid].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));
  const advancers = valid.filter((s) => (s.changePct ?? 0) > 0).length;
  const decliners = valid.filter((s) => (s.changePct ?? 0) < 0).length;
  const avg = valid.length ? valid.reduce((a, s) => a + (s.changePct ?? 0), 0) / valid.length : null;
  const leader = sorted[0] ?? null;
  const laggard = sorted.length > 1 ? sorted[sorted.length - 1] : null;

  res.json({
    sectors: data,
    fetchedAt: data[0]?.fetchedAt || null,
    breadth: {
      advancers,
      decliners,
      unchanged: valid.length - advancers - decliners,
      avgChangePct: avg != null ? Math.round(avg * 1000) / 1000 : null,
      spreadPct: leader && laggard ? Math.round(((leader.changePct ?? 0) - (laggard.changePct ?? 0)) * 1000) / 1000 : null,
      leader: leader ? leader.symbol : null,
      laggard: laggard ? laggard.symbol : null,
    },
  });
}));

export default router;
