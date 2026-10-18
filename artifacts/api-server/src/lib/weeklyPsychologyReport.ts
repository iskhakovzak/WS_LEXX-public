import { db, tradesTable, emotionalStateLogTable, weeklyPsychologyReportsTable } from "@workspace/db";
import { eq, and, gte, lte, isNull, desc } from "drizzle-orm";
import { logger } from "./logger";
import { psychologyT } from "./behaviorI18n";
import { DEFAULT_LANG, type Lang } from "../i18n";

function isWin(result: string) {
  return result === "win" || result === "прибыль"; // i18n-ignore (legacy stored result value)
}

// Local calendar date (YYYY-MM-DD). toISOString() converts to UTC first, which on
// servers east of UTC turned local Monday 00:00 into Sunday — the week started on Sunday.
export function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isValidYmd(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return ymdLocal(new Date(y, m - 1, d + n));
}

function getWeekBounds(date: Date): { weekStart: string; weekEnd: string } {
  const day = date.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() + diffToMonday);
  const friday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 4);
  return { weekStart: ymdLocal(monday), weekEnd: ymdLocal(friday) };
}

/** Monday..Friday bounds of the week containing `ymd` (local calendar). */
export function weekBoundsFor(ymd: string): { weekStart: string; weekEnd: string } {
  const [y, m, d] = ymd.split("-").map(Number);
  return getWeekBounds(new Date(y, m - 1, d));
}

export function getCurrentWeekBounds() {
  return getWeekBounds(new Date());
}

interface DayStats {
  wins: number;
  total: number;
  pnl: number;
  rSum: number;
  rCount: number;
}

function emptyDayStats(): DayStats {
  return { wins: 0, total: 0, pnl: 0, rSum: 0, rCount: 0 };
}

function accum(stats: DayStats, pnl: number, win: boolean, r: number | null = null) {
  stats.total++;
  if (win) stats.wins++;
  stats.pnl += pnl;
  if (r != null && Number.isFinite(r)) {
    stats.rSum += r;
    stats.rCount++;
  }
}

function statsSummary(stats: DayStats) {
  return {
    count: stats.total,
    winRate: stats.total > 0 ? Math.round((stats.wins / stats.total) * 100) / 100 : 0,
    avgPnl: stats.total > 0 ? Math.round((stats.pnl / stats.total) * 100) / 100 : 0,
    totalPnl: Math.round(stats.pnl * 100) / 100,
    avgR: stats.rCount > 0 ? Math.round((stats.rSum / stats.rCount) * 100) / 100 : null,
  };
}

type StateSummary = ReturnType<typeof statsSummary>;

/** Readiness 0..100 from a check-in: sleep/focus add, stress/anxiety/tilt/revenge subtract. */
export function readinessScore(s: {
  sleepWell: boolean; focused: boolean; stressed: boolean; anxious: boolean; tilted: boolean; revenge: boolean;
}): number {
  let score = 50;
  if (s.sleepWell) score += 20;
  if (s.focused) score += 30;
  if (s.stressed) score -= 15;
  if (s.anxious) score -= 15;
  if (s.tilted) score -= 25;
  if (s.revenge) score -= 25;
  return Math.max(0, Math.min(100, score));
}

/** State labels of the weekly report in `lang` (keys: focused, stressed, tilted, revenge, anxious, normal). */
export function stateLabelFor(state: string, lang: Lang = DEFAULT_LANG): string {
  return psychologyT.tryFor(lang, `weekly.states.${state}`) ?? state;
}
/** Russian labels (historical export). */
export const STATE_LABELS_RU: Record<string, string> = Object.fromEntries(
  ["focused", "stressed", "tilted", "revenge", "anxious", "normal"].map((k) => [k, stateLabelFor(k, "ru")]),
);

const pct = (x: number) => Math.round(x * 100);
const money = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(Math.round(x)).toLocaleString("en-US")}`;


type InsightInput = {
  totalTrades: number;
  totalCheckins: number;
  winRate: number | string;
  totalPnl: number | string;
  bestState: string | null;
  emotionalBreakdown: unknown;
  rawStats?: unknown;
};

/**
 * Insights computed from stored stats in `lang`. Deterministic, so stored reports (whatever language their saved
 * text is in) are re-rendered in the reader's language when read.
 */
export function buildInsights(r: InsightInput, prev?: InsightInput | null, lang: Lang = DEFAULT_LANG): string[] {
  const t = psychologyT.tFor(lang);
  const out: string[] = [];
  const breakdown = (r.emotionalBreakdown ?? {}) as Record<string, StateSummary | undefined>;
  const raw = (r.rawStats ?? {}) as { checkinCountByState?: Record<string, number> };
  const counts = raw.checkinCountByState ?? {};
  const wr = Number(r.winRate) || 0;
  const pnl = Number(r.totalPnl) || 0;
  const n = r.totalTrades;

  if (n === 0) {
    out.push(t("weekly.noTrades"));
  } else {
    out.push(pnl !== 0 ? t("weekly.summaryPnl", { count: n, wr: pct(wr), pnl: money(pnl) }) : t("weekly.summary", { count: n, wr: pct(wr) }));
  }

  if (prev && prev.totalTrades > 0 && n > 0) {
    const d = pct(wr) - pct(Number(prev.winRate) || 0);
    if (Math.abs(d) >= 5) {
      out.push(t(d > 0 ? "weekly.wrUp" : "weekly.wrDown", { pp: Math.abs(d) }));
    }
  }

  const focused = breakdown.focused;
  const normal = breakdown.normal;
  const stressed = breakdown.stressed;
  const revenge = breakdown.revenge;

  if (focused && normal && focused.count >= 1 && normal.count >= 1) {
    const diff = pct(focused.winRate - normal.winRate);
    if (diff > 0) {
      out.push(t("weekly.focusUp", { pp: diff, a: pct(focused.winRate), b: pct(normal.winRate) }));
    } else if (diff < 0) {
      out.push(t("weekly.focusDown", { pp: Math.abs(diff) }));
    }
  }

  if (stressed && normal && stressed.count >= 1 && normal.count >= 1) {
    const d = pct(stressed.winRate - normal.winRate);
    if (d < 0) out.push(t("weekly.stressCost", { pp: Math.abs(d), a: pct(stressed.winRate), b: pct(normal.winRate) }));
  }

  const stressedDays = counts.stressed ?? 0;
  if (stressedDays >= 3) {
    out.push(t("weekly.stressDays", { count: stressedDays }));
  }
  const tiltDays = counts.tilted ?? 0;
  if (tiltDays >= 1) {
    out.push(t("weekly.tiltDays", { count: tiltDays }));
  }
  if (revenge && revenge.count >= 1) {
    out.push(revenge.avgR != null
      ? t("weekly.revengeR", { count: revenge.count, r: `${revenge.avgR > 0 ? "+" : ""}${revenge.avgR}` })
      : t("weekly.revengeWr", { count: revenge.count, wr: pct(revenge.winRate) }));
  }

  const best = r.bestState ? breakdown[r.bestState] : undefined;
  if (r.bestState && r.bestState !== "normal" && best) {
    out.push(t("weekly.bestState", { state: stateLabelFor(r.bestState, lang), wr: pct(best.winRate) }));
  }

  if (r.totalCheckins === 0 && n > 0) {
    out.push(t("weekly.noCheckins"));
  } else if (r.totalCheckins > 0 && r.totalCheckins < 3) {
    out.push(t("weekly.fewCheckins", { n: r.totalCheckins }));
  }

  return out;
}

export async function generateWeeklyReport(userId: string, weekStart?: string, weekEnd?: string): Promise<number> {
  const bounds = weekStart && weekEnd
    ? { weekStart, weekEnd }
    : getCurrentWeekBounds();

  const wStart = bounds.weekStart;
  const wEnd = bounds.weekEnd;

  const [allTrades, allStates] = await Promise.all([
    db.select().from(tradesTable).where(
      and(
        isNull(tradesTable.deletedAt),
        eq(tradesTable.trader, userId),
        gte(tradesTable.date, wStart),
        lte(tradesTable.date, wEnd + "T23:59:59"),
      )
    ),
    db.select().from(emotionalStateLogTable).where(
      and(
        eq(emotionalStateLogTable.userId, userId),
        gte(emotionalStateLogTable.date, wStart),
        lte(emotionalStateLogTable.date, wEnd),
      )
    ),
  ]);

  const stateByDate = new Map<string, typeof allStates[0]>();
  for (const s of allStates) {
    stateByDate.set(s.date, s);
  }

  // Per-day stats (Mon..Fri) for the day strip in the UI.
  const dayMap = new Map<string, DayStats>();
  for (let i = 0; i < 5; i++) dayMap.set(addDaysYmd(wStart, i), emptyDayStats());

  const stressedStats = emptyDayStats();
  const tiltedStats = emptyDayStats();
  const focusedStats = emptyDayStats();
  const revengeStats = emptyDayStats();
  const anxiousStats = emptyDayStats();
  const normalStats = emptyDayStats();

  for (const t of allTrades) {
    const tradeDate = t.date.substring(0, 10);
    const pnl = t.pnl ? Number(t.pnl) : 0;
    const r = t.rMultiple != null ? Number(t.rMultiple) : null;
    const win = isWin(t.result);
    const day = dayMap.get(tradeDate);
    if (day) accum(day, pnl, win, r);
    const state = stateByDate.get(tradeDate);
    if (!state) {
      accum(normalStats, pnl, win, r);
      continue;
    }
    if (state.stressed) accum(stressedStats, pnl, win, r);
    if (state.tilted) accum(tiltedStats, pnl, win, r);
    if (state.focused) accum(focusedStats, pnl, win, r);
    if (state.revenge) accum(revengeStats, pnl, win, r);
    if (state.anxious) accum(anxiousStats, pnl, win, r);
    if (!state.stressed && !state.tilted && !state.focused && !state.revenge && !state.anxious) {
      accum(normalStats, pnl, win, r);
    }
  }

  const emotionalBreakdown = {
    stressed: statsSummary(stressedStats),
    tilted: statsSummary(tiltedStats),
    focused: statsSummary(focusedStats),
    revenge: statsSummary(revengeStats),
    anxious: statsSummary(anxiousStats),
    normal: statsSummary(normalStats),
  };

  const stateEntries = Object.entries(emotionalBreakdown)
    .filter(([, s]) => s.count >= 1)
    .map(([state, s]) => ({ state, ...s }))
    .sort((a, b) => b.winRate - a.winRate);

  const bestState = stateEntries[0]?.state ?? null;
  const worstState = stateEntries.length > 1 ? stateEntries[stateEntries.length - 1]?.state ?? null : null;

  const totalPnl = allTrades.reduce((s, t) => s + (t.pnl ? Number(t.pnl) : 0), 0);
  const wins = allTrades.filter((t) => isWin(t.result)).length;
  const winRate = allTrades.length > 0 ? wins / allTrades.length : 0;
  const avgPnlPerTrade = allTrades.length > 0 ? totalPnl / allTrades.length : 0;

  const checkinCountByState: Record<string, number> = {
    sleepWell: 0, stressed: 0, tilted: 0, focused: 0, anxious: 0, revenge: 0,
  };
  for (const s of allStates) {
    if (s.sleepWell) checkinCountByState.sleepWell++;
    if (s.stressed) checkinCountByState.stressed++;
    if (s.tilted) checkinCountByState.tilted++;
    if (s.focused) checkinCountByState.focused++;
    if (s.anxious) checkinCountByState.anxious++;
    if (s.revenge) checkinCountByState.revenge++;
  }

  const days = [...dayMap.entries()].map(([date, d]) => {
    const st = stateByDate.get(date);
    return { date, ...statsSummary(d), readiness: st ? readinessScore(st) : null };
  });

  const rs = allTrades
    .map((t) => (t.rMultiple != null ? Number(t.rMultiple) : NaN))
    .filter((x) => Number.isFinite(x));
  const avgR = rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) / 100 : null;
  const readinessVals = days.map((d) => d.readiness).filter((x): x is number => x != null);
  const avgReadiness = readinessVals.length
    ? Math.round(readinessVals.reduce((a, b) => a + b, 0) / readinessVals.length)
    : null;

  const rawStats = {
    checkinCountByState,
    stateBreakdown: emotionalBreakdown,
    weekStart: wStart,
    weekEnd: wEnd,
    days,
    avgR,
    avgReadiness,
  };

  const prevRow = await getPreviousWeeklyReport(userId, wStart);
  const insights = buildInsights(
    { totalTrades: allTrades.length, totalCheckins: allStates.length, winRate, totalPnl, bestState, emotionalBreakdown, rawStats },
    prevRow,
  );

  const existing = await db.select({ id: weeklyPsychologyReportsTable.id })
    .from(weeklyPsychologyReportsTable)
    .where(and(
      eq(weeklyPsychologyReportsTable.userId, userId),
      eq(weeklyPsychologyReportsTable.weekStart, wStart),
    ))
    .limit(1);

  let reportId: number;

  if (existing.length > 0) {
    await db.update(weeklyPsychologyReportsTable)
      .set({
        weekEnd: wEnd,
        totalTrades: allTrades.length,
        totalCheckins: allStates.length,
        emotionalBreakdown,
        bestState,
        worstState,
        totalPnl: String(Math.round(totalPnl * 100) / 100),
        avgPnlPerTrade: String(Math.round(avgPnlPerTrade * 100) / 100),
        winRate: String(Math.round(winRate * 100) / 100),
        keyInsights: insights,
        rawStats,
        generatedAt: new Date(),
      })
      .where(and(
        eq(weeklyPsychologyReportsTable.userId, userId),
        eq(weeklyPsychologyReportsTable.weekStart, wStart),
      ));
    reportId = existing[0].id;
  } else {
    const [inserted] = await db.insert(weeklyPsychologyReportsTable).values({
      userId,
      weekStart: wStart,
      weekEnd: wEnd,
      totalTrades: allTrades.length,
      totalCheckins: allStates.length,
      emotionalBreakdown,
      bestState,
      worstState,
      totalPnl: String(Math.round(totalPnl * 100) / 100),
      avgPnlPerTrade: String(Math.round(avgPnlPerTrade * 100) / 100),
      winRate: String(Math.round(winRate * 100) / 100),
      keyInsights: insights,
      rawStats,
    }).returning({ id: weeklyPsychologyReportsTable.id });
    reportId = inserted.id;
  }

  logger.info({ userId, weekStart: wStart, weekEnd: wEnd, trades: allTrades.length }, "Weekly psychology report generated");
  return reportId;
}

export async function getLatestWeeklyReport(userId: string) {
  const rows = await db.select()
    .from(weeklyPsychologyReportsTable)
    .where(eq(weeklyPsychologyReportsTable.userId, userId))
    .orderBy(desc(weeklyPsychologyReportsTable.weekStart))
    .limit(1);
  return rows[0] ?? null;
}

export async function getWeeklyReportById(userId: string, id: number) {
  const rows = await db.select()
    .from(weeklyPsychologyReportsTable)
    .where(and(eq(weeklyPsychologyReportsTable.userId, userId), eq(weeklyPsychologyReportsTable.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

/** Most recent report for a week before `weekStart` (tolerates old Sunday-shifted rows of the same week). */
export async function getPreviousWeeklyReport(userId: string, weekStart: string) {
  const cutoff = isValidYmd(weekStart) ? addDaysYmd(weekStart, -3) : weekStart;
  const rows = await db.select()
    .from(weeklyPsychologyReportsTable)
    .where(and(
      eq(weeklyPsychologyReportsTable.userId, userId),
      lte(weeklyPsychologyReportsTable.weekStart, cutoff),
    ))
    .orderBy(desc(weeklyPsychologyReportsTable.weekStart))
    .limit(1);
  return rows[0] ?? null;
}

export async function getWeeklyReportHistory(userId: string, limit = 8) {
  return db.select()
    .from(weeklyPsychologyReportsTable)
    .where(eq(weeklyPsychologyReportsTable.userId, userId))
    .orderBy(desc(weeklyPsychologyReportsTable.weekStart))
    .limit(limit);
}

export async function getAllUserIds(): Promise<string[]> {
  const { pool } = await import("@workspace/db");
  const { rows } = await pool.query<{ trader: string }>(
    `SELECT DISTINCT trader FROM trades WHERE deleted_at IS NULL AND trader IS NOT NULL`
  );
  return rows.map((r) => r.trader);
}

/** Weekly psychology reports for every trader with trades. Job registry: "psychology.weekly-report" (Fridays 17:00 NY). */
export async function runWeeklyReports(): Promise<Record<string, unknown>> {
  const userIds = await getAllUserIds();
  let ok = 0, failed = 0;
  for (const userId of userIds) {
    try {
      await generateWeeklyReport(userId);
      ok++;
    } catch (e: any) {
      failed++;
      logger.warn({ userId, error: e.message }, "Failed to generate weekly report for user");
    }
  }
  return { users: userIds.length, ok, failed };
}
