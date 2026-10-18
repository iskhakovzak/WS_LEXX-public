import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { scopeTrader } from "../lib/auth";
import { captureContext } from "../lib/marketContext";
import { closedSql, netPnl, normResult, signedR } from "../lib/tradeMath";
import { nyDate } from "../lib/tradingDate";
import { unauthorized } from "../lib/http";

const router: IRouter = Router();

type Bucket = {
  regime?: string;
  bucket?: string;
  trend_day?: string;
  sample: number;
  winRate: number | null;
  avgRMultiple: number | null;
  /** Net P&L (gross − |fees|); null when no trade in the bucket has a P&L. */
  totalPnl: number | null;
};

type SetupRegime = {
  scope: string;
  sample: number;
  value: { winRate: number | null; avgRMultiple: number | null; totalPnl: number | null };
};

function safeAvg(arr: Array<number | null>): number | null {
  const xs = arr.filter((x): x is number => x != null && Number.isFinite(x));
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Audit P0-4: one definition with the dashboard/stats (lib/tradeMath) — win rate = W/(W+L), break-even excluded,
// null when nothing is decided; R = signed R (sign from the result); P&L = net.
function winRate(rows: Array<{ result: unknown }>): number | null {
  let w = 0, l = 0;
  for (const r of rows) {
    const res = normResult(r.result);
    if (res === "win") w++;
    else if (res === "loss") l++;
  }
  return w + l > 0 ? w / (w + l) : null;
}

function avgSignedR(rows: any[]): number | null {
  return safeAvg(rows.map((r) => signedR(r)));
}

function totalNet(rows: any[]): number | null {
  const xs = rows.map((r) => netPnl(r)).filter((x): x is number => x != null);
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100 : null;
}

function aggregate(rows: any[], keyFn: (r: any) => string | null): Bucket[] {
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const k = keyFn(r);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const out: Bucket[] = [];
  for (const [key, items] of groups) {
    out.push({
      regime: key,
      bucket: key,
      trend_day: key,
      sample: items.length,
      winRate: winRate(items),
      avgRMultiple: avgSignedR(items),
      totalPnl: totalNet(items),
    });
  }
  return out.sort((a, b) => b.sample - a.sample);
}

function aggregateSetupRegime(rows: any[]): { best: SetupRegime[]; worst: SetupRegime[] } {
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const setup = r.setup;
    const regime = r.context_snapshot?.marketRegime;
    if (!setup || !regime) continue;
    const k = `${setup} · ${regime}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const all: SetupRegime[] = [];
  for (const [scope, items] of groups) {
    if (items.length < 3) continue;
    const wr = winRate(items);
    all.push({
      scope,
      sample: items.length,
      value: {
        winRate: wr,
        avgRMultiple: avgSignedR(items),
        totalPnl: totalNet(items),
      },
    });
  }
  // combos without a decided trade have no win rate — they are neither best nor worst
  const sorted = all.filter((x) => x.value.winRate != null).sort((a, b) => b.value.winRate! - a.value.winRate!);
  return {
    best: sorted.slice(0, 6),
    worst: sorted.slice(-6).reverse(),
  };
}

router.get("/market-conditions/dna", asyncHandler(async (req, res): Promise<void> => {
  const requested = typeof req.query.userKey === "string" && req.query.userKey ? req.query.userKey : null;
  // lib/auth scopeTrader: members see DNA built from their own trades; staff may pick any trader or the whole team
  // (null); a guest gets the no-match sentinel → empty buckets (the live market context is still returned).
  const userKey = await scopeTrader(req, requested);
  if (userKey === undefined) throw unauthorized();
  const today = nyDate();

  const currentContext = await captureContext({ tradeDate: today }).catch(() => null);

  const params: any[] = [];
  let where = `t.deleted_at IS NULL AND ${closedSql("t")} AND t.context_snapshot IS NOT NULL`;
  if (userKey) {
    params.push(userKey);
    where += ` AND t.trader = $${params.length}`;
  }
  const { rows } = await pool.query<any>(
    `SELECT t.setup, t.result, t.side, t.entry, t.exit, t.stop, t.pnl, t.fees, t.r_multiple, t.risk_usd, t.context_snapshot
     FROM trades t WHERE ${where}
     ORDER BY t.date DESC LIMIT 2000`,
    params,
  ).catch(() => ({ rows: [] as any[] }));

  const byRegime = aggregate(rows, (r) => r.context_snapshot?.marketRegime ?? null);
  const byVixBucket = aggregate(rows, (r) => r.context_snapshot?.vix?.bucket ?? null);
  const byTrendDay = aggregate(rows, (r) => {
    const t = r.context_snapshot?.trendDay?.spy;
    if (t === true) return "trend";
    if (t === false) return "chop";
    return null;
  });
  const setupRegime = aggregateSetupRegime(rows);

  res.json({
    generatedAt: new Date().toISOString(),
    currentContext,
    byRegime,
    byVixBucket,
    byTrendDay,
    bestSetupRegime: setupRegime.best,
    worstSetupRegime: setupRegime.worst,
    sample: rows.length,
  });
}));

export default router;
