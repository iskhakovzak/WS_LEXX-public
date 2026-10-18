import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc, gte, lte, isNull } from "drizzle-orm";
import { db, emotionalStateLogTable, tradesTable } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { requirePersonalAccess } from "../lib/auth";
import { readinessScore, isValidYmd, addDaysYmd } from "../lib/weeklyPsychologyReport";
import { netPnl, normResult, signedR } from "../lib/tradeMath";
import { nyDate } from "../lib/tradingDate";
import { AppError } from "../lib/http";

const router: IRouter = Router();

/**
 * Check-ins are personal: the owner, or a member whose journal.read.team grant covers that trader (curators/admins
 * by default) — lib/auth requirePersonalAccess. Guests never. Writing someone else's check-in needs journal.review.
 * Returns the effective userId, or null after sending an error response.
 */
function resolveUserId(req: Request, res: Response, raw: unknown, mode: "read" | "write" = "read"): Promise<string | null> {
  return requirePersonalAccess(req, res, raw, mode === "write" ? "journal.review" : "journal.read.team");
}

type Row = typeof emotionalStateLogTable.$inferSelect;
const present = (r: Row) => ({ ...r, createdAt: r.createdAt.toISOString(), readiness: readinessScore(r) });

router.get("/emotional-state", asyncHandler(async (req, res): Promise<void> => {
  const userId = await resolveUserId(req, res, req.query.userId);
  if (!userId) return;
  const rows = await db
    .select()
    .from(emotionalStateLogTable)
    .where(eq(emotionalStateLogTable.userId, userId))
    .orderBy(desc(emotionalStateLogTable.createdAt));
  res.json(rows.map(present));
}));

router.get("/emotional-state/by-date", asyncHandler(async (req, res): Promise<void> => {
  const userId = await resolveUserId(req, res, req.query.userId);
  if (!userId) return;
  const date = (req.query.date as string | undefined)?.trim();
  if (!date) throw new AppError("INVALID_DATE");
  const [row] = await db
    .select()
    .from(emotionalStateLogTable)
    .where(and(eq(emotionalStateLogTable.userId, userId), eq(emotionalStateLogTable.date, date)))
    .limit(1);
  res.json(row ? present(row) : null);
}));

router.get("/emotional-state/today", asyncHandler(async (req, res): Promise<void> => {
  const userId = await resolveUserId(req, res, req.query.userId);
  if (!userId) return;
  // Client sends the trading date it saves check-ins with; the fallback is the New York trading date
  // (audit P1-12) — the UTC date flips to "tomorrow" at 20:00 ET.
  const qDate = (req.query.date as string | undefined)?.trim();
  const today = qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate)
    ? qDate
    : nyDate();
  const [row] = await db
    .select()
    .from(emotionalStateLogTable)
    .where(and(eq(emotionalStateLogTable.userId, userId), eq(emotionalStateLogTable.date, today)))
    .limit(1);
  res.json(row ? present(row) : null);
}));

// Audit P0-6: R = signed R, P&L = net, win rate = W/(W+L) (break-even/open excluded) — all from lib/tradeMath.
type Agg = { days: number; trades: number; wins: number; losses: number; rSum: number; rCount: number };
const emptyAgg = (): Agg => ({ days: 0, trades: 0, wins: 0, losses: 0, rSum: 0, rCount: 0 });
const winRateOf = (wins: number, losses: number) => (wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) / 100 : null);
const finish = (a: Agg) => ({
  days: a.days,
  trades: a.trades,
  winRate: winRateOf(a.wins, a.losses),
  avgR: a.rCount > 0 ? Math.round((a.rSum / a.rCount) * 100) / 100 : null,
});

/**
 * Check-in history joined with that day's trade results, plus simple correlations:
 * win rate / avg R on high- vs low-readiness days and with vs without each flag.
 * GET /emotional-state/insights?userId=&to=YYYY-MM-DD&days=30
 */
router.get("/emotional-state/insights", asyncHandler(async (req, res): Promise<void> => {
  const userId = await resolveUserId(req, res, req.query.userId);
  if (!userId) return;
  const to = isValidYmd(req.query.to) ? (req.query.to as string) : nyDate();
  const rawDays = Number(req.query.days);
  const span = Number.isFinite(rawDays) ? Math.min(Math.max(Math.trunc(rawDays), 7), 120) : 30;
  const from = addDaysYmd(to, -(span - 1));

  const [states, trades] = await Promise.all([
    db.select().from(emotionalStateLogTable).where(and(
      eq(emotionalStateLogTable.userId, userId),
      gte(emotionalStateLogTable.date, from),
      lte(emotionalStateLogTable.date, to),
    )),
    db.select({
      date: tradesTable.date,
      result: tradesTable.result,
      side: tradesTable.side,
      entry: tradesTable.entry,
      exit: tradesTable.exit,
      stop: tradesTable.stop,
      rMultiple: tradesTable.rMultiple,
      pnl: tradesTable.pnl,
      fees: tradesTable.fees,
      riskUsd: tradesTable.riskUsd,
    }).from(tradesTable).where(and(
      isNull(tradesTable.deletedAt),
      eq(tradesTable.trader, userId),
      gte(tradesTable.date, from),
      lte(tradesTable.date, to + "T23:59:59"),
    )),
  ]);

  const tradeByDay = new Map<string, Agg & { pnl: number; pnlCount: number }>();
  for (const t of trades) {
    const d = t.date.slice(0, 10);
    const a = tradeByDay.get(d) ?? { ...emptyAgg(), pnl: 0, pnlCount: 0 };
    a.trades++;
    const res_ = normResult(t.result);
    if (res_ === "win") a.wins++;
    else if (res_ === "loss") a.losses++;
    const r = signedR(t);
    if (r != null) {
      a.rSum += r;
      a.rCount++;
    }
    const net = netPnl(t);
    if (net != null) {
      a.pnl += net;
      a.pnlCount++;
    }
    tradeByDay.set(d, a);
  }

  const days = states
    .map((s) => {
      const t = tradeByDay.get(s.date);
      return {
        date: s.date,
        readiness: readinessScore(s),
        sleepWell: s.sleepWell,
        focused: s.focused,
        stressed: s.stressed,
        anxious: s.anxious,
        tilted: s.tilted,
        revenge: s.revenge,
        hasNote: !!s.freeText,
        trades: t?.trades ?? 0,
        winRate: t ? winRateOf(t.wins, t.losses) : null,
        avgR: t && t.rCount > 0 ? Math.round((t.rSum / t.rCount) * 100) / 100 : null,
        pnl: t && t.pnlCount > 0 ? Math.round(t.pnl * 100) / 100 : null,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const add = (a: Agg, date: string) => {
    a.days++;
    const t = tradeByDay.get(date);
    if (!t) return;
    a.trades += t.trades;
    a.wins += t.wins;
    a.losses += t.losses;
    a.rSum += t.rSum;
    a.rCount += t.rCount;
  };

  const high = emptyAgg();
  const low = emptyAgg();
  const all = emptyAgg();
  const FLAGS = ["sleepWell", "focused", "stressed", "anxious", "tilted", "revenge"] as const;
  const withFlag = Object.fromEntries(FLAGS.map((f) => [f, emptyAgg()])) as Record<(typeof FLAGS)[number], Agg>;
  const withoutFlag = Object.fromEntries(FLAGS.map((f) => [f, emptyAgg()])) as Record<(typeof FLAGS)[number], Agg>;

  for (const s of states) {
    const score = readinessScore(s);
    add(all, s.date);
    if (score >= 70) add(high, s.date);
    else if (score < 50) add(low, s.date);
    for (const f of FLAGS) add(s[f] ? withFlag[f] : withoutFlag[f], s.date);
  }

  // Trading days without a check-in — the "unknown" bucket.
  const checkinDates = new Set(states.map((s) => s.date));
  const noCheckin = emptyAgg();
  for (const d of tradeByDay.keys()) if (!checkinDates.has(d)) add(noCheckin, d);

  // Check-in streak: consecutive weekdays (Mon–Fri) ending today (or yesterday if today not filled yet).
  let streak = 0;
  let cursor = to;
  if (!checkinDates.has(cursor)) cursor = addDaysYmd(cursor, -1);
  for (let i = 0; i < span; i++) {
    const [y, m, d] = cursor.split("-").map(Number);
    const dow = new Date(y, m - 1, d).getDay();
    if (dow === 0 || dow === 6) {
      cursor = addDaysYmd(cursor, -1);
      continue;
    }
    if (!checkinDates.has(cursor)) break;
    streak++;
    cursor = addDaysYmd(cursor, -1);
  }

  res.json({
    from,
    to,
    days,
    streak,
    overall: finish(all),
    highReadiness: finish(high),
    lowReadiness: finish(low),
    noCheckin: finish(noCheckin),
    flags: FLAGS.map((f) => ({ key: f, with: finish(withFlag[f]), without: finish(withoutFlag[f]) })),
  });
}));

router.post("/emotional-state", asyncHandler(async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const userId = await resolveUserId(req, res, body.userId, "write");
  if (!userId) return;
  const { date } = body;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError("INVALID_DATE");
  const bool = (v: unknown) => v === true || v === "true" || v === 1;
  const sleepWell = bool(body.sleepWell);
  const stressed = bool(body.stressed);
  const tilted = bool(body.tilted);
  const focused = bool(body.focused);
  const anxious = bool(body.anxious);
  const revenge = bool(body.revenge);
  if (body.freeText != null && typeof body.freeText !== "string") throw new AppError("INVALID_FIELD", undefined, { field: "freeText" });
  const freeText = typeof body.freeText === "string" && body.freeText.trim() ? body.freeText.slice(0, 2000) : null;

  const existing = await db
    .select({ id: emotionalStateLogTable.id })
    .from(emotionalStateLogTable)
    .where(and(eq(emotionalStateLogTable.userId, userId), eq(emotionalStateLogTable.date, date)))
    .limit(1);

  let row;
  if (existing.length > 0) {
    [row] = await db
      .update(emotionalStateLogTable)
      .set({ sleepWell, stressed, tilted, focused, anxious, revenge, freeText })
      .where(eq(emotionalStateLogTable.id, existing[0].id))
      .returning();
  } else {
    [row] = await db
      .insert(emotionalStateLogTable)
      .values({ userId, date, sleepWell, stressed, tilted, focused, anxious, revenge, freeText })
      .returning();
  }

  res.status(201).json(present(row));
}));

export default router;
