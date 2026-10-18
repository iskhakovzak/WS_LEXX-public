import { Router, type IRouter } from "express";
import { isNull, eq, and, asc } from "drizzle-orm";
import { db, tradesTable, emotionalStateLogTable } from "@workspace/db";
import { asyncHandler } from "../lib/asyncHandler";
import { TtlCache } from "../lib/hotCache";
import { netPnl as netPnlOf, normResult, signedR } from "../lib/tradeMath";
import { addDays, nyDate } from "../lib/tradingDate";
import { badRequest, forbidden } from "../lib/http";
import { psychologyT } from "../lib/behaviorI18n";
import { langOf, type Lang } from "../i18n";

const psychologyCache = new TtlCache<string, unknown>(3 * 60 * 1000);

const router: IRouter = Router();

// Result buckets / R / net come from lib/tradeMath (audit P0-5): one definition with the dashboard and stats.
function isWin(result: unknown) {
  return normResult(result) === "win";
}

function isLoss(result: unknown) {
  return normResult(result) === "loss";
}


type TradeRow = typeof tradesTable.$inferSelect;
/** Prop-desk columns (horizon/fees/riskUsd) — widened so this compiles against older built db typings too. */
type PropFields = { horizon?: string | null; fees?: string | number | null; riskUsd?: string | number | null };
const prop = (t: TradeRow) => t as TradeRow & PropFields;

/** Signed R (sign from result -> price-derived -> pnl / risk_usd); null when unknown. Shared rule: lib/tradeMath. */
function realizedR(t: TradeRow): number | null {
  return signedR(t);
}

/** P&L net of fees (gross - |fees|). Null when P&L is not filled. Shared rule: lib/tradeMath. */
function netPnl(t: TradeRow): number | null {
  return netPnlOf(prop(t));
}

const horizonOf = (t: TradeRow) => {
  const h = prop(t).horizon;
  return h === "overnight" || h === "swing" ? h : "intraday";
};

function pearson(pairs: { x: number; y: number }[]): number | null {
  if (pairs.length < 5) return null;
  const n = pairs.length;
  const sumX = pairs.reduce((s, p) => s + p.x, 0);
  const sumY = pairs.reduce((s, p) => s + p.y, 0);
  const sumXY = pairs.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = pairs.reduce((s, p) => s + p.x * p.x, 0);
  const sumY2 = pairs.reduce((s, p) => s + p.y * p.y, 0);
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return den === 0 || !Number.isFinite(den) ? 0 : Math.round((num / den) * 1000) / 1000;
}

/** winRate = W/(W+L) — break-even and open excluded; null when nothing is decided (never a fake 0). */
type GroupAgg = { count: number; wins: number; losses: number; winRate: number | null; avgR: number | null; rCount: number; avgPnl: number | null; pnlCount: number };

function aggregate(trades: TradeRow[]): GroupAgg {
  let wins = 0;
  let losses = 0;
  const rs: number[] = [];
  const pnls: number[] = [];
  for (const t of trades) {
    if (isWin(t.result)) wins++;
    else if (isLoss(t.result)) losses++;
    const r = realizedR(t);
    if (r != null) rs.push(r);
    const np = netPnl(t);
    if (np != null) pnls.push(np);
  }
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    count: trades.length,
    wins,
    losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    avgR: rs.length > 0 ? round(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
    rCount: rs.length,
    avgPnl: pnls.length > 0 ? round(pnls.reduce((a, b) => a + b, 0) / pnls.length) : null,
    pnlCount: pnls.length,
  };
}

type Confidence = "low" | "medium" | "high";
function confidenceOf(minN: number): Confidence {
  return minN >= 15 ? "high" : minN >= 5 ? "medium" : "low";
}

type Comparison = {
  key: string;
  label: string;
  withLabel: string;
  withoutLabel: string;
  with: GroupAgg;
  without: GroupAgg;
  /** null when either side has no decided trades. */
  deltaWinRatePp: number | null;
  deltaR: number | null;
  impact: number;
  confidence: Confidence;
  text: string;
};

const fmtR = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}R`;

type Phrase = { label: string; withLabel: string; withoutLabel: string; lead: string; contrast: string };

/** Compare two trade groups and describe the difference in plain words (in `lang`). Null if too small. */
function compareGroups(
  key: string,
  phrase: Phrase,
  a: TradeRow[],
  b: TradeRow[],
  lang: Lang,
): Comparison | null {
  const label = phrase.label;
  const t = psychologyT.tFor(lang);
  if (a.length < 2 || b.length < 2) return null;
  const w = aggregate(a);
  const wo = aggregate(b);
  const dWr = w.winRate != null && wo.winRate != null ? Math.round((w.winRate - wo.winRate) * 100) : null;
  const dR = w.avgR != null && wo.avgR != null && w.rCount >= 2 && wo.rCount >= 2
    ? Math.round((w.avgR - wo.avgR) * 100) / 100
    : null;
  // Nothing comparable (no decided trades on one side and no R) — make no claim at all.
  if (dWr == null && dR == null) return null;
  // Effect in R units (50 п.п. винрейта ≈ 1R) scaled by the smaller sample.
  const effect = dR != null ? Math.abs(dR) : Math.abs(dWr!) / 50;
  const minN = Math.min(a.length, b.length);
  const impact = Math.round(effect * Math.sqrt(minN) * 100) / 100;
  const parts: string[] = [];
  if (dWr != null) {
    const wr = { pp: Math.abs(dWr), a: Math.round(w.winRate! * 100), b: Math.round(wo.winRate! * 100), contrast: phrase.contrast };
    parts.push(t(dWr > 0 ? "compare.wrHigher" : dWr < 0 ? "compare.wrLower" : "compare.wrSame", wr));
  }
  if (dR != null && w.avgR != null && wo.avgR != null) {
    const rp = { a: fmtR(w.avgR), b: fmtR(wo.avgR) };
    parts.push(dWr == null ? t("compare.rContrast", { ...rp, contrast: phrase.contrast }) : t("compare.r", rp));
  }
  const text = t("compare.text", { lead: phrase.lead, parts: parts.join("; "), na: a.length, nb: b.length });
  return {
    key, label, withLabel: phrase.withLabel, withoutLabel: phrase.withoutLabel,
    with: w, without: wo, deltaWinRatePp: dWr, deltaR: dR, impact, confidence: confidenceOf(minN), text,
  };
}

/** Phrases of a check-in factor / behaviour comparison in `lang` (psychology.factors.* / psychology.behavior.*). */
function phraseOf(group: "factors" | "behavior", key: string, lang: Lang): Phrase {
  const tr = (f: string) => psychologyT.tryFor(lang, `${group}.${key}.${f}`) ?? key;
  return { label: tr("label"), withLabel: tr("withLabel"), withoutLabel: tr("withoutLabel"), lead: tr("lead"), contrast: tr("contrast") };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TICKER_RE = /^[A-Za-z0-9.\-]{1,12}$/;

router.get("/analytics/psychology", asyncHandler(async (req, res): Promise<void> => {
  const userId = (req.query.userId as string | undefined)?.trim();
  if (!userId) throw badRequest("TRADER_REQUIRED");
  const lang = langOf(req);
  const t = psychologyT.tFor(lang);
  // Emotional check-ins are personal: traders may only read their own analytics.
  const viewer = req.authUser;
  if (viewer && !["curator", "admin"].includes(viewer.role) && viewer.name !== userId) {
    throw forbidden();
  }

  // Optional filters shared with the analytics page filter bar.
  const q = (k: string) => (typeof req.query[k] === "string" ? (req.query[k] as string).trim() : "");
  const from = q("from");
  const to = q("to");
  const side = q("side").toLowerCase();
  const ticker = q("ticker").toUpperCase();
  const setup = q("setup");
  const horizon = q("horizon").toLowerCase();
  if (horizon && !["intraday", "overnight", "swing"].includes(horizon)) {
    throw badRequest("INVALID_FIELD", { field: "horizon", allowed: ["intraday", "overnight", "swing"] }, { field: "horizon" });
  }
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) throw badRequest("INVALID_DATE");
  if (side && side !== "long" && side !== "short") {
    throw badRequest("INVALID_FIELD", { field: "side", allowed: ["long", "short"] }, { field: "side" });
  }
  if (ticker && !TICKER_RE.test(ticker)) {
    throw badRequest("INVALID_TICKER");
  }
  if (setup.length > 120) throw badRequest("INVALID_FIELD", { field: "setup" }, { field: "setup" });

  // Generated texts depend on the language → it is part of the cache key.
  const CACHE_KEY = `psychology:${lang}:${userId}:${from}:${to}:${side}:${ticker}:${setup}:${horizon}`;
  const cached = psychologyCache.get(CACHE_KEY);
  if (cached) { res.json(cached); return; }

  const [rawTrades, rawStates] = await Promise.all([
    db.select().from(tradesTable)
      .where(and(isNull(tradesTable.deletedAt), eq(tradesTable.trader, userId))),
    db.select().from(emotionalStateLogTable)
      .where(eq(emotionalStateLogTable.userId, userId))
      .orderBy(asc(emotionalStateLogTable.date)),
  ]);

  const inRange = (d: string) => {
    const day = (d ?? "").substring(0, 10);
    return (!from || day >= from) && (!to || day <= to);
  };
  const allTrades = rawTrades.filter((t) => {
    if (!inRange(t.date)) return false;
    if (side && !(t.side ?? "").toLowerCase().startsWith(side)) return false;
    if (ticker && (t.ticker ?? "").toUpperCase() !== ticker) return false;
    if (horizon && horizonOf(t) !== horizon) return false;
    if (setup) {
      if (setup === "__none__") { if (t.setup) return false; }
      else if ((t.setup ?? "") !== setup) return false;
    }
    return true;
  });
  const allStates = rawStates.filter((s) => inRange(s.date));

  // WR, expectancy (R) and P&L by conviction level (1-5)
  const byConviction = [1, 2, 3, 4, 5].map((level) => {
    const group = allTrades.filter((t) => t.conviction === level);
    const a = aggregate(group);
    return {
      conviction: level,
      count: a.count,
      winRate: a.winRate,
      avgPnl: a.avgPnl,
      expectancy: a.avgR,
      avgR: a.avgR,
      rCount: a.rCount,
    };
  });

  // Confidence grade vs outcome
  const GRADE_ORDER = ["A+", "A", "B", "C"];
  const gradeGroups = new Map<string, TradeRow[]>();
  for (const t of allTrades) {
    const g = t.confidenceGrade;
    if (!g) continue;
    if (!gradeGroups.has(g)) gradeGroups.set(g, []);
    gradeGroups.get(g)!.push(t);
  }
  const byConfidenceGrade = [...gradeGroups.entries()].map(([grade, group]) => {
    const a = aggregate(group);
    return { grade, count: a.count, winRate: a.winRate, avgPnl: a.avgPnl, avgR: a.avgR, rCount: a.rCount };
  }).sort((a, b) => GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade));

  // Heatmap: confidence grade × outcome (win/loss/breakeven)
  const heatmap: { grade: string; outcome: string; count: number }[] = [];
  for (const [grade, group] of gradeGroups) {
    const counts: Record<string, number> = {};
    for (const t of group) {
      const r = normResult(t.result);
      if (r !== "win" && r !== "loss" && r !== "be") continue; // open / unknown are not an outcome
      const outcome = r === "be" ? "breakeven" : r;
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    for (const [outcome, count] of Object.entries(counts)) heatmap.push({ grade, outcome, count });
  }

  // Emotional state distribution by month
  const monthMap: Record<string, { sleepWell: number; stressed: number; tilted: number; focused: number; anxious: number; revenge: number; total: number }> = {};
  for (const s of allStates) {
    const month = s.date.substring(0, 7);
    if (!monthMap[month]) monthMap[month] = { sleepWell: 0, stressed: 0, tilted: 0, focused: 0, anxious: 0, revenge: 0, total: 0 };
    monthMap[month].total++;
    if (s.sleepWell) monthMap[month].sleepWell++;
    if (s.stressed) monthMap[month].stressed++;
    if (s.tilted) monthMap[month].tilted++;
    if (s.focused) monthMap[month].focused++;
    if (s.anxious) monthMap[month].anxious++;
    if (s.revenge) monthMap[month].revenge++;
  }
  const emotionalByMonth = Object.entries(monthMap).sort((a, b) => a[0].localeCompare(b[0])).map(([month, d]) => ({ month, ...d }));

  // Join trades to the same-day check-in.
  const stateByDate = new Map<string, typeof allStates[0]>();
  for (const s of allStates) stateByDate.set(s.date.substring(0, 10), s);
  const stateOf = (t: TradeRow) => stateByDate.get(t.date.substring(0, 10));

  type StateKey = "sleepWell" | "focused" | "stressed" | "anxious" | "tilted" | "revenge";
  const STATE_KEYS: StateKey[] = ["sleepWell", "focused", "stressed", "anxious", "tilted", "revenge"];
  const tradesWithCheckin = allTrades.filter((t) => stateOf(t));

  const groupFor = (pred: (t: TradeRow) => boolean) => allTrades.filter(pred);
  const isNormalDay = (t: TradeRow) => {
    const s = stateOf(t);
    return !s || (!s.stressed && !s.tilted && !s.focused && !s.revenge && !s.anxious);
  };

  const summary = (group: TradeRow[]) => {
    const a = aggregate(group);
    return { count: a.count, winRate: a.winRate, avgPnl: a.avgPnl, expectancy: a.avgR, avgR: a.avgR };
  };
  const emotionalImpact: Record<string, ReturnType<typeof summary>> = {
    stressed: summary(groupFor((t) => !!stateOf(t)?.stressed)),
    tilted: summary(groupFor((t) => !!stateOf(t)?.tilted)),
    focused: summary(groupFor((t) => !!stateOf(t)?.focused)),
    anxious: summary(groupFor((t) => !!stateOf(t)?.anxious)),
    revenge: summary(groupFor((t) => !!stateOf(t)?.revenge)),
    sleepWell: summary(groupFor((t) => !!stateOf(t)?.sleepWell)),
    normal: summary(groupFor(isNormalDay)),
  };

  // Best/worst emotional state (by win rate, ≥3 trades)
  const stateEntries = Object.entries(emotionalImpact)
    .filter(([state]) => state !== "sleepWell")
    .map(([state, s]) => ({ state, ...s }))
    .filter((s) => s.count >= 3 && s.winRate != null);
  const sortedByWR = [...stateEntries].sort((a, b) => b.winRate! - a.winRate!);
  const bestEmotionalState = sortedByWR[0]?.state ?? null;
  const worstEmotionalState = sortedByWR[sortedByWR.length - 1]?.state ?? null;

  // Factor comparisons: among trades on days with a check-in, factor present vs absent.
  const factors: Comparison[] = [];
  for (const key of STATE_KEYS) {
    const withF = tradesWithCheckin.filter((x) => !!stateOf(x)?.[key]);
    const withoutF = tradesWithCheckin.filter((x) => !stateOf(x)?.[key]);
    const c = compareGroups(key, phraseOf("factors", key, lang), withF, withoutF, lang);
    if (c) factors.push(c);
  }

  // Behaviour patterns that need no check-ins.
  const behavior: Comparison[] = [];
  const byDay = new Map<string, TradeRow[]>();
  for (const t of allTrades) {
    const d = t.date.substring(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(t);
  }
  const afterLoss: TradeRow[] = [];
  const firstOrAfterWin: TradeRow[] = [];
  const busyDays: TradeRow[] = [];
  const calmDays: TradeRow[] = [];
  for (const dayTrades of byDay.values()) {
    const ordered = [...dayTrades].sort((a, b) =>
      (a.date.length > 10 && b.date.length > 10 ? a.date.localeCompare(b.date) : 0)
      || String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""))
      || a.id - b.id);
    ordered.forEach((t, i) => {
      if (i > 0 && isLoss(ordered[i - 1].result)) afterLoss.push(t);
      else firstOrAfterWin.push(t);
    });
    (ordered.length >= 3 ? busyDays : calmDays).push(...ordered);
  }
  const afterLossCmp = compareGroups("afterLoss", phraseOf("behavior", "afterLoss", lang), afterLoss, firstOrAfterWin, lang);
  if (afterLossCmp) behavior.push(afterLossCmp);
  const busyCmp = compareGroups("overtrading", phraseOf("behavior", "overtrading", lang), busyDays, calmDays, lang);
  if (busyCmp) behavior.push(busyCmp);
  const highConv = allTrades.filter((t) => (t.conviction ?? 0) >= 4);
  const lowConv = allTrades.filter((t) => t.conviction != null && t.conviction <= 3);
  const convCmp = compareGroups("conviction", phraseOf("behavior", "conviction", lang), highConv, lowConv, lang);
  if (convCmp) behavior.push(convCmp);
  const topGrade = allTrades.filter((t) => t.confidenceGrade === "A+" || t.confidenceGrade === "A");
  const lowGrade = allTrades.filter((t) => t.confidenceGrade === "B" || t.confidenceGrade === "C");
  const gradeCmp = compareGroups("grade", phraseOf("behavior", "grade", lang), topGrade, lowGrade, lang);
  if (gradeCmp) behavior.push(gradeCmp);

  // Correlations: P&L where filled, R as fallback (local data often has no P&L).
  const gradeOrdinal: Record<string, number> = { "A+": 4, "A": 3, "B": 2, "C": 1 };
  const confidencePnlCorrelation = pearson(allTrades
    .filter((t) => t.confidenceGrade && gradeOrdinal[t.confidenceGrade] !== undefined && netPnl(t) != null)
    .map((t) => ({ x: gradeOrdinal[t.confidenceGrade!], y: netPnl(t)! })));
  const convictionPnlCorrelation = pearson(allTrades
    .filter((t) => t.conviction != null && netPnl(t) != null)
    .map((t) => ({ x: Number(t.conviction), y: netPnl(t)! })));
  const confidenceRCorrelation = pearson(allTrades
    .filter((t) => t.confidenceGrade && gradeOrdinal[t.confidenceGrade] !== undefined && realizedR(t) != null)
    .map((t) => ({ x: gradeOrdinal[t.confidenceGrade!], y: realizedR(t)! })));
  const convictionRCorrelation = pearson(allTrades
    .filter((t) => t.conviction != null && realizedR(t) != null)
    .map((t) => ({ x: Number(t.conviction), y: realizedR(t)! })));

  // Ranked insights: strongest, best-supported effects first.
  type RankedInsight = { id: string; title: string; text: string; tone: "up" | "down" | "neutral"; impact: number; sample: number; confidence: Confidence };
  const ranked: RankedInsight[] = [...factors, ...behavior].map((c) => {
    const dWr = c.deltaWinRatePp ?? 0; // compareGroups guarantees deltaR or deltaWinRatePp
    const signed = c.deltaR ?? dWr / 50;
    const metric = c.deltaR != null ? fmtR(c.deltaR) : t("compare.pp", { value: `${dWr > 0 ? "+" : dWr < 0 ? "−" : ""}${Math.abs(dWr)}` });
    return {
      id: c.key,
      title: t(c.deltaR != null ? "compare.titleR" : "compare.titleWr", { label: c.withLabel, metric }),
      text: c.text,
      tone: Math.abs(signed) < 0.05 ? "neutral" as const : signed > 0 ? "up" as const : "down" as const,
      impact: c.impact,
      sample: Math.min(c.with.count, c.without.count),
      confidence: c.confidence,
    };
  }).filter((i) => i.impact > 0).sort((a, b) => b.impact - a.impact);

  const coveragePct = allTrades.length > 0 ? tradesWithCheckin.length / allTrades.length : 0;
  if (allTrades.length >= 3 && coveragePct < 0.5) {
    ranked.push({
      id: "coverage",
      title: t("coverage.title"),
      text: t("coverage.text", { pct: Math.round(coveragePct * 100), n: tradesWithCheckin.length, total: allTrades.length }),
      tone: "neutral",
      impact: 0,
      sample: tradesWithCheckin.length,
      confidence: "low",
    });
  }

  // Legacy flat insight strings (kept for backward compatibility).
  const insights: string[] = ranked.filter((i) => i.id !== "coverage").slice(0, 5).map((i) => i.text);
  if (bestEmotionalState) {
    const bs = stateEntries.find((s) => s.state === bestEmotionalState);
    if (bs && bs.winRate != null) {
      insights.push(t("bestState", { state: psychologyT.tryFor(lang, `states.${bestEmotionalState}`) ?? bestEmotionalState, wr: Math.round(bs.winRate * 100) }));
    }
  }
  if (insights.length === 0) insights.push(t("noData"));

  const emotionalImpactArray = Object.entries(emotionalImpact)
    .map(([emotion, stats]) => ({ emotion, ...stats }))
    .filter((e) => e.count > 0);

  // Recent check-ins (last 30 days, or the selected period)
  const cutoff = from || addDays(nyDate(), -30);
  const recentCheckins = allStates
    .filter((s) => s.date >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 60)
    .map((s) => {
      const dayTrades = byDay.get(s.date.substring(0, 10)) ?? [];
      const a = aggregate(dayTrades);
      return {
        date: s.date,
        sleepWell: s.sleepWell,
        stressed: s.stressed,
        tilted: s.tilted,
        focused: s.focused,
        anxious: s.anxious,
        revenge: s.revenge,
        trades: a.count,
        wins: a.wins,
        sumR: a.avgR != null ? Math.round(a.avgR * a.rCount * 100) / 100 : null,
      };
    });

  const payload = {
    byConviction,
    byConfidenceGrade,
    heatmap,
    emotionalByMonth,
    emotionalImpact,
    emotionalImpactArray,
    bestEmotionalState,
    worstEmotionalState,
    insights,
    rankedInsights: ranked,
    factors,
    behavior,
    coverage: {
      trades: allTrades.length,
      tradesWithCheckin: tradesWithCheckin.length,
      checkins: allStates.length,
      tradesWithConviction: allTrades.filter((t) => t.conviction != null).length,
      tradesWithGrade: allTrades.filter((t) => !!t.confidenceGrade).length,
      tradesWithR: allTrades.filter((t) => realizedR(t) != null).length,
      tradesWithPnl: allTrades.filter((t) => t.pnl != null).length,
    },
    recentCheckins,
    confidencePnlCorrelation,
    convictionPnlCorrelation,
    confidenceRCorrelation,
    convictionRCorrelation,
  };
  psychologyCache.set(CACHE_KEY, payload);
  res.json(payload);
}));

export default router;
