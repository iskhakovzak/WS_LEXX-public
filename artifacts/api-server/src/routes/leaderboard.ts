// Team leaderboard — consistency first, not raw P&L.
//
//   GET /leaderboard?period=week|month|quarter|all|days&days=N&from&to&metric&minTrades&format=desk
//
// One source of numbers: ../lib/tradeMath (signed R, net $, W/(W+L), PF = ΣR⁺/|ΣR⁻|) on the New York
// trading calendar (../lib/tradingDate), by close date. Staff see the whole desk; a trader gets only
// their own row (with their rank among qualified teammates, no one else's numbers).
//
// Default response is the legacy array (ratings tabs); `format=desk` wraps it with period/weights/mostImproved.
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { signedRSql, netPnlSql, closeDateSql, closedSql, resultSql } from "../lib/tradeMath";
import { nyDate, addDays } from "../lib/tradingDate";
import { scopeTrader } from "../lib/auth";
import { unauthorized } from "../lib/http";

const router: IRouter = Router();

const round = (n: number, d = 2) => Number(n.toFixed(d));
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// ─── Period windows (NY calendar, Mon–Fri weeks) ─────────────────────────────
export type PeriodKind = "week" | "month" | "quarter" | "all" | "days" | "custom";

function mondayOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(ymd, -((wd + 6) % 7));
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
function addMonths(ymd: string, n: number): string {
  const [y, m] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return t.toISOString().slice(0, 10);
}

export type Window = { kind: PeriodKind; from: string; to: string; prevFrom: string | null; prevTo: string | null };

export function resolveWindow(q: { period?: unknown; days?: unknown; from?: unknown; to?: unknown }, today = nyDate()): Window {
  const from = typeof q.from === "string" && YMD.test(q.from) ? q.from : null;
  const to = typeof q.to === "string" && YMD.test(q.to) ? q.to : null;
  if (from && to && from <= to) {
    const len = daysBetween(from, to) + 1;
    return { kind: "custom", from, to, prevFrom: addDays(from, -len), prevTo: addDays(from, -1) };
  }
  const daysRaw = q.days != null && q.days !== "" ? Math.floor(Number(q.days)) : null;
  const period = typeof q.period === "string" ? q.period : daysRaw ? "days" : "month";
  switch (period) {
    case "week": {
      const mon = mondayOf(today);
      return { kind: "week", from: mon, to: addDays(mon, 4), prevFrom: addDays(mon, -7), prevTo: addDays(mon, -3) };
    }
    case "quarter": {
      const [y, m] = today.split("-").map(Number);
      const qStart = `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
      return { kind: "quarter", from: qStart, to: today, prevFrom: addMonths(qStart, -3), prevTo: addDays(qStart, -1) };
    }
    case "all":
      // "prev" for all-time = the state as of 7 days ago (lets the UI show rank movement).
      return { kind: "all", from: "0000-01-01", to: today, prevFrom: "0000-01-01", prevTo: addDays(today, -7) };
    case "days": {
      const n = daysRaw && Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 3650) : 30;
      const start = addDays(today, -(n - 1));
      return { kind: "days", from: start, to: today, prevFrom: addDays(start, -n), prevTo: addDays(start, -1) };
    }
    default: {
      const mStart = today.slice(0, 7) + "-01";
      return { kind: "month", from: mStart, to: today, prevFrom: addMonths(mStart, -1), prevTo: addDays(mStart, -1) };
    }
  }
}

// ─── Desk score (pure; offline-checked by scratchpad/check-desk-score.mjs) ────
// BEGIN deskScore
/** Weights of the desk score — the one place to tune the ranking. */
export const SCORE_WEIGHTS = {
  expectancy: 0.25,   // mean signed R per closed trade
  profitFactor: 0.15, // ΣR⁺ / |ΣR⁻|
  net: 0.15,          // net $ vs the trader's loss limits (excluded when no $ or no limits)
  consistency: 0.20,  // % green trading days
  drawdown: 0.15,     // max drawdown vs limit (or vs 10R without $)
  discipline: 0.10,   // rule violations per week
} as const;
export type ScorePart = keyof typeof SCORE_WEIGHTS;

export type ScoreInput = {
  closed: number;
  wins: number;
  expectancyR: number | null;
  profitFactorR: number | null;
  net: number | null;
  tradingDays: number;
  greenDays: number;
  maxDrawdownNet: number | null;
  maxDrawdownR: number;
  violations: number;
  /** Window length in calendar days (violations are normalised per week). */
  windowDays: number;
  dailyLossLimit: number | null;
  maxDrawdownLimit: number | null;
  accountSize: number | null;
};

/** Each component in [0,1] (null = not measurable → excluded and weights renormalised). */
export function scoreParts(i: ScoreInput): Record<ScorePart, number | null> {
  const lossUnit = i.dailyLossLimit ?? (i.accountSize != null ? i.accountSize * 0.02 : null);
  const ddLimit = i.maxDrawdownLimit ?? (lossUnit != null ? lossUnit * 3 : null);
  const expectancy = i.expectancyR == null ? null : clamp01((i.expectancyR + 0.5) / 1.0);
  const profitFactor =
    i.profitFactorR == null ? (i.closed > 0 ? (i.wins > 0 ? 1 : 0.5) : null) : clamp01((i.profitFactorR - 0.5) / 1.5);
  const net = i.net == null || lossUnit == null || lossUnit <= 0 ? null : clamp01(0.5 + i.net / (4 * lossUnit));
  const consistency = i.tradingDays > 0 ? clamp01(i.greenDays / i.tradingDays) : null;
  const drawdown =
    i.maxDrawdownNet != null && ddLimit != null && ddLimit > 0
      ? 1 - clamp01(Math.abs(i.maxDrawdownNet) / ddLimit)
      : i.closed > 0 ? 1 - clamp01(Math.abs(i.maxDrawdownR) / 10) : null;
  const weeks = Math.max(1, i.windowDays / 7);
  // No closed trades and no violations ⇒ nothing to judge (otherwise an idle trader scores 100).
  const discipline = i.closed > 0 || i.violations > 0 ? 1 - clamp01(i.violations / weeks / 3) : null;
  return { expectancy, profitFactor, net, consistency, drawdown, discipline };
}

/** 0–100 weighted score over the measurable components; null when nothing is measurable. */
export function deskScore(i: ScoreInput): { score: number | null; parts: Record<ScorePart, number | null> } {
  const parts = scoreParts(i);
  let num = 0, den = 0;
  for (const k of Object.keys(SCORE_WEIGHTS) as ScorePart[]) {
    const v = parts[k];
    if (v == null) continue;
    num += SCORE_WEIGHTS[k] * v;
    den += SCORE_WEIGHTS[k];
  }
  return { score: den > 0 ? Math.round((num / den) * 1000) / 10 : null, parts };
}
// END deskScore

// ─── Aggregation ─────────────────────────────────────────────────────────────
type Row = { trader: string; day: string; result: "win" | "loss" | "be"; net: number | null; gross: number | null; r: number | null };

function dailySharpe(daily: number[]): number | null {
  if (daily.length < 5) return null;
  const mean = daily.reduce((s, v) => s + v, 0) / daily.length;
  const variance = daily.reduce((s, v) => s + (v - mean) ** 2, 0) / (daily.length - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return null;
  return round((mean / sd) * Math.sqrt(252));
}

function maxDrawdown(values: number[]): number {
  let cum = 0, peak = 0, dd = 0;
  for (const v of values) { cum += v; if (cum > peak) peak = cum; if (cum - peak < dd) dd = cum - peak; }
  return dd;
}

function aggregate(rows: Row[]) {
  // rows sorted by day ASC, id ASC
  let wins = 0, losses = 0, bes = 0;
  let net = 0, gross = 0, pnlCount = 0, rSum = 0, rCount = 0, rPos = 0, rNeg = 0;
  let best = -Infinity, worst = Infinity, bestR = -Infinity, worstR = Infinity;
  let cur = 0, bestStreak = 0, worstStreak = 0, last: string = "";
  const netByDay = new Map<string, number>();
  const rByDay = new Map<string, number>();
  const days: string[] = [];
  const rSeries: number[] = [];
  const netSeries: number[] = [];
  let lastDate: string | null = null;
  for (const t of rows) {
    if (days[days.length - 1] !== t.day) days.push(t.day);
    if (!lastDate || t.day > lastDate) lastDate = t.day;
    if (t.result === "win") wins++; else if (t.result === "loss") losses++; else bes++;
    if (t.net != null) {
      net += t.net; gross += t.gross ?? 0; pnlCount++;
      best = Math.max(best, t.net); worst = Math.min(worst, t.net);
      netByDay.set(t.day, (netByDay.get(t.day) ?? 0) + t.net);
      netSeries.push(t.net);
    }
    if (t.r != null) {
      rSum += t.r; rCount++;
      if (t.r > 0) rPos += t.r; else if (t.r < 0) rNeg += t.r;
      bestR = Math.max(bestR, t.r); worstR = Math.min(worstR, t.r);
      rByDay.set(t.day, (rByDay.get(t.day) ?? 0) + t.r);
      rSeries.push(t.r);
    }
    if (t.result === "win") { cur = last === "win" ? cur + 1 : 1; bestStreak = Math.max(bestStreak, cur); last = "win"; }
    else if (t.result === "loss") { cur = last === "loss" ? cur - 1 : -1; worstStreak = Math.min(worstStreak, cur); last = "loss"; }
    else { cur = 0; last = "be"; }
  }
  const closed = wins + losses + bes;
  const decided = wins + losses;
  const dayScore = (d: string) => (netByDay.has(d) ? netByDay.get(d)! : rByDay.get(d) ?? 0);
  const greenDays = days.filter((d) => dayScore(d) > 0).length;
  let cum = 0;
  const sparkR = days.map((d) => (cum += rByDay.get(d) ?? 0));
  return {
    closed, wins, losses, breakevens: bes,
    /** W / (W + L), in % (break-even excluded). */
    winrate: decided > 0 ? round((wins / decided) * 100) : 0,
    winRate: decided > 0 ? wins / decided : null,
    net: pnlCount > 0 ? round(net) : null,
    gross: pnlCount > 0 ? round(gross) : null,
    fees: pnlCount > 0 ? round(gross - net) : null,
    pnlCount,
    avgPnl: pnlCount > 0 ? round(net / pnlCount) : 0,
    /** null when no trade in the window has a known R (no stop, e.g. broker imports) — never a fake 0R. */
    totalR: rCount > 0 ? round(rSum) : null,
    avgR: rCount > 0 ? round(rSum / rCount) : null,
    rCount,
    expectancyR: rCount > 0 ? round(rSum / rCount) : null,
    profitFactorR: rNeg < 0 ? round(rPos / Math.abs(rNeg)) : null,
    bestR: rCount > 0 ? round(bestR) : null, worstR: rCount > 0 ? round(worstR) : null,
    bestTrade: pnlCount > 0 ? round(best) : 0, worstTrade: pnlCount > 0 ? round(worst) : 0,
    tradingDays: days.length,
    greenDays,
    consistency: days.length > 0 ? round(greenDays / days.length, 4) : null,
    maxDrawdownR: round(maxDrawdown(rSeries)),
    maxDrawdownNet: pnlCount > 0 ? round(maxDrawdown(netSeries)) : null,
    sharpeDaily: dailySharpe([...netByDay.values()]),
    sharpeDailyR: dailySharpe([...rByDay.values()]),
    currentStreak: cur, bestStreak, worstStreak,
    lastTradeDate: lastDate,
    sparkR: sparkR.slice(-30).map((v) => round(v)),
  };
}

type Limits = { tier: string | null; accountSize: number | null; dailyLossLimit: number | null; maxDrawdown: number | null };
const numOrNull = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

const METRICS = ["score", "net", "r", "expectancy", "pf", "consistency", "drawdown", "winrate"] as const;
type Metric = (typeof METRICS)[number];

router.get("/leaderboard", asyncHandler(async (req, res): Promise<void> => {
  const scope = await scopeTrader(req, null);
  if (scope === undefined) throw unauthorized();
  const me = req.authUser?.name ?? "";
  const win = resolveWindow(req.query);
  const metric: Metric = (METRICS as readonly string[]).includes(String(req.query.metric)) ? (req.query.metric as Metric) : "score";
  const minRaw = req.query.minTrades != null && req.query.minTrades !== "" ? Math.floor(Number(req.query.minTrades)) : 10;
  const minTrades = Number.isFinite(minRaw) && minRaw >= 0 ? minRaw : 10;
  const format = req.query.format === "desk" ? "desk" : "array";
  const quiet = () => ({ rows: [] as any[] });

  const dataFrom = win.prevFrom && win.prevFrom < win.from ? win.prevFrom : win.from;
  const CLOSE = closeDateSql();
  const [tradeRows, openRows, violationRows, limitRows, ratingRows] = await Promise.all([
    pool.query<{ trader: string; day: string; result: string; net: number | null; gross: number | null; r: number | null }>(
      `SELECT t.trader, ${CLOSE} AS day, ${resultSql()} AS result,
              (CASE WHEN t.pnl IS NULL THEN NULL ELSE ${netPnlSql()} END)::float AS net, t.pnl::float AS gross, ${signedRSql()}::float AS r
       FROM trades t
       WHERE t.trader IS NOT NULL AND t.deleted_at IS NULL AND ${closedSql()} AND ${CLOSE} BETWEEN $1 AND $2
       ORDER BY t.trader, ${CLOSE} ASC, t.id ASC`,
      [dataFrom, win.to],
    ),
    pool.query<{ trader: string; c: number }>(
      `SELECT t.trader, COUNT(*)::int AS c FROM trades t
       WHERE t.trader IS NOT NULL AND t.deleted_at IS NULL AND LOWER(TRIM(COALESCE(t.result, ''))) = 'open' GROUP BY t.trader`,
    ),
    pool.query<{ trader: string; cur: number; prev: number }>(
      `SELECT v.trader,
              COUNT(*) FILTER (WHERE v.occurred_at >= $1::date AND v.occurred_at < ($2::date + 1))::int AS cur,
              COUNT(*) FILTER (WHERE $3::date IS NOT NULL AND v.occurred_at >= $3::date AND v.occurred_at < ($4::date + 1))::int AS prev
       FROM rule_violations v WHERE v.archived_at IS NULL GROUP BY v.trader`,
      [win.from === "0000-01-01" ? "1970-01-01" : win.from, win.to, win.prevFrom === "0000-01-01" ? "1970-01-01" : win.prevFrom, win.prevTo ?? win.to],
    ).catch(quiet),
    pool.query(`SELECT trader, tier, account_size, daily_loss_limit, max_drawdown FROM trader_risk_limits`).catch(quiet),
    pool.query<{ trader: string; avg: number; n: number }>(
      `SELECT trader, AVG(overall)::float AS avg, COUNT(*)::int AS n FROM trader_ratings
       WHERE week >= $1 AND week <= $2 GROUP BY trader`,
      [win.from === "0000-01-01" ? "1970-01-01" : win.from, win.to],
    ).catch(quiet),
  ]);

  const cur = new Map<string, Row[]>();
  const prev = new Map<string, Row[]>();
  for (const r of tradeRows.rows) {
    const result = r.result as Row["result"] | null;
    if (!result || !r.day) continue;
    const row: Row = { trader: r.trader, day: String(r.day), result, net: numOrNull(r.net), gross: numOrNull(r.gross), r: numOrNull(r.r) };
    if (row.day >= win.from && row.day <= win.to) { const l = cur.get(row.trader) ?? []; l.push(row); cur.set(row.trader, l); }
    if (win.prevFrom && win.prevTo && row.day >= win.prevFrom && row.day <= win.prevTo) { const l = prev.get(row.trader) ?? []; l.push(row); prev.set(row.trader, l); }
  }
  const openBy = new Map(openRows.rows.map((r) => [r.trader, Number(r.c)]));
  const violBy = new Map(violationRows.rows.map((r: any) => [String(r.trader), { cur: Number(r.cur), prev: Number(r.prev) }]));
  const limitsBy = new Map<string, Limits>(
    limitRows.rows.map((r: any) => [String(r.trader), { tier: r.tier ?? null, accountSize: numOrNull(r.account_size), dailyLossLimit: numOrNull(r.daily_loss_limit), maxDrawdown: numOrNull(r.max_drawdown) }]),
  );
  const ratingBy = new Map(ratingRows.rows.map((r: any) => [String(r.trader), { avg: round(Number(r.avg), 1), n: Number(r.n) }]));

  const windowDays = Math.max(1, daysBetween(win.from === "0000-01-01" ? (tradeRows.rows[0]?.day ? String(tradeRows.rows[0].day) : win.to) : win.from, win.to) + 1);
  const prevDays = win.prevFrom && win.prevTo ? Math.max(1, daysBetween(win.prevFrom === "0000-01-01" ? win.prevFrom.replace("0000", "1970") : win.prevFrom, win.prevTo) + 1) : windowDays;

  const traders = new Set<string>([...cur.keys(), ...prev.keys()]);
  const entries = [...traders].map((trader) => {
    const a = aggregate(cur.get(trader) ?? []);
    const L = limitsBy.get(trader) ?? { tier: null, accountSize: null, dailyLossLimit: null, maxDrawdown: null };
    const v = violBy.get(trader) ?? { cur: 0, prev: 0 };
    const scoreOf = (x: ReturnType<typeof aggregate>, violations: number, days: number) =>
      deskScore({
        closed: x.closed, wins: x.wins, expectancyR: x.expectancyR, profitFactorR: x.profitFactorR, net: x.net,
        tradingDays: x.tradingDays, greenDays: x.greenDays, maxDrawdownNet: x.maxDrawdownNet, maxDrawdownR: x.maxDrawdownR,
        violations, windowDays: days, dailyLossLimit: L.dailyLossLimit, maxDrawdownLimit: L.maxDrawdown, accountSize: L.accountSize,
      });
    const s = scoreOf(a, v.cur, windowDays);
    const p = prev.get(trader);
    const pa = p && p.length ? aggregate(p) : null;
    const ps = pa ? scoreOf(pa, v.prev, prevDays) : null;
    const qualified = a.closed >= minTrades;
    return {
      trader,
      ...a,
      totalTrades: a.closed + (openBy.get(trader) ?? 0),
      open: openBy.get(trader) ?? 0,
      /** Net $ (legacy name kept for the ratings tabs). */
      totalPnl: a.net ?? 0,
      expectancy: a.avgPnl,
      sharpeApprox: a.sharpeDaily ?? 0,
      violations: v.cur,
      violationsPerWeek: round(v.cur / Math.max(1, windowDays / 7), 2),
      score: s.score,
      scoreParts: s.parts,
      qualified,
      minTrades,
      tier: L.tier,
      accountSize: L.accountSize,
      dailyLossLimit: L.dailyLossLimit,
      maxDrawdownLimit: L.maxDrawdown,
      rating: ratingBy.get(trader) ?? null,
      prevScore: ps?.score ?? null,
      deltaScore: s.score != null && ps?.score != null ? round(s.score - ps.score, 1) : null,
      prev: pa
        ? { totalTrades: pa.closed, winrate: pa.winrate, totalPnl: pa.net ?? 0, totalR: pa.totalR, avgR: pa.avgR, expectancy: pa.avgPnl, expectancyR: pa.expectancyR, score: ps?.score ?? null, closed: pa.closed, net: pa.net, qualified: pa.closed >= minTrades }
        : null,
    };
  });

  const metricOf = (e: (typeof entries)[number]): number => {
    switch (metric) {
      case "net": return e.net ?? Number.NEGATIVE_INFINITY;
      case "r": return e.totalR ?? Number.NEGATIVE_INFINITY;
      case "expectancy": return e.expectancyR ?? Number.NEGATIVE_INFINITY;
      case "pf": return e.profitFactorR ?? (e.wins > 0 && e.losses === 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
      case "consistency": return e.consistency ?? Number.NEGATIVE_INFINITY;
      case "drawdown": return e.maxDrawdownNet ?? e.maxDrawdownR; // less negative = better
      case "winrate": return e.winRate ?? Number.NEGATIVE_INFINITY;
      default: return e.score ?? Number.NEGATIVE_INFINITY;
    }
  };
  entries.sort((a, b) => Number(b.qualified) - Number(a.qualified) || metricOf(b) - metricOf(a) || (b.score ?? -1) - (a.score ?? -1) || b.closed - a.closed || a.trader.localeCompare(b.trader));
  let rank = 0;
  const ranked = entries.map((e) => ({ ...e, rank: e.qualified ? ++rank : null }));
  const improved = ranked.filter((e) => e.qualified && e.deltaScore != null && e.prev?.qualified).sort((a, b) => (b.deltaScore ?? 0) - (a.deltaScore ?? 0))[0];
  const mostImproved = improved && (improved.deltaScore ?? 0) > 0 ? { trader: improved.trader, deltaScore: improved.deltaScore, score: improved.score, prevScore: improved.prevScore } : null;

  // Non-staff: own row only (rank among qualified teammates is fine, teammates' numbers are not).
  const visible = scope === null ? ranked : ranked.filter((e) => e.trader === scope);
  if (format === "array") { res.json(visible); return; }
  res.json({
    period: { kind: win.kind, from: win.from === "0000-01-01" ? (tradeRows.rows[0]?.day ? String(tradeRows.rows[0].day) : win.to) : win.from, to: win.to, prevFrom: win.prevFrom, prevTo: win.prevTo, today: nyDate() },
    metric,
    minTrades,
    weights: SCORE_WEIGHTS,
    qualifiedCount: rank,
    totalTraders: ranked.length,
    mostImproved: scope === null || mostImproved?.trader === scope ? mostImproved : null,
    viewer: { name: me, staff: scope === null },
    rows: visible,
  });
}));

export default router;
