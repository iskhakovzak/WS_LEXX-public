import { BookOpen, Shield, Sparkles, Star, Target, TrendingUp, type LucideIcon } from "lucide-react";
import { nyDate, addDays } from "@/lib/trading-date";
import { fmtDate } from "@/lib/format";
import { ratingsI18n } from "@/i18n/ns/ratings";
import { comparePersonNames } from "@/i18n";
import { commonI18n } from "@/i18n/ns/common";

export type Rating = {
  id: number; trader: string; curator: string; week: string;
  discipline: number; riskManagement: number; execution: number;
  journaling: number; improvement: number; overall: number;
  comment: string | null; createdAt: string;
  /** Feedback loop: the one thing to work on next week, the facts the score was based on, the risk tier, trader's acknowledgement. */
  focus?: string | null; evidence?: Record<string, unknown> | null; tier?: string | null;
  acknowledgedAt?: string | null; updatedAt?: string | null;
};

export type CriterionKey = "discipline" | "riskManagement" | "execution" | "journaling" | "improvement";
export type ScoreKey = CriterionKey | "overall";

type CriterionDef = { key: CriterionKey; readonly label: string; readonly short: string; icon: LucideIcon; readonly hint: string };
/** Labels are getters: read at render time in the current UI language. */
const criterion = (key: CriterionKey, icon: LucideIcon): CriterionDef => ({
  key,
  icon,
  get label() { return ratingsI18n.t(`criteria.${key}.label`); },
  get short() { return ratingsI18n.t(`criteria.${key}.short`); },
  get hint() { return ratingsI18n.t(`criteria.${key}.hint`); },
});
export const CRITERIA: CriterionDef[] = [
  criterion("discipline", Shield),
  criterion("riskManagement", Target),
  criterion("execution", Sparkles),
  criterion("journaling", BookOpen),
  criterion("improvement", TrendingUp),
];
export const OVERALL = { key: "overall" as const, get label() { return ratingsI18n.t("overall"); }, icon: Star };

/** Monday of the week containing the given YYYY-MM-DD (default: today on the NY trading calendar). */
export function weekOf(d: Date | string = new Date()): string {
  const day = typeof d === "string" ? d : nyDate(d);
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((wd + 6) % 7));
}

export function shiftWeek(week: string, delta: number): string {
  return addDays(week, delta * 7);
}

export function weekLabel(week: string): string {
  const fmt = (iso: string) => fmtDate(iso.slice(0, 10), "dayMonth").replace(".", "");
  return `${fmt(week)} – ${fmt(addDays(week, 4))}`;
}

export type Scores = Record<ScoreKey, number> & { composite: number };
export type WeekPoint = Scores & { week: string; count: number };

export type Scorecard = {
  trader: string;
  latest: WeekPoint | null;
  prev: WeekPoint | null;
  avg: Scores;
  series: WeekPoint[];
  totalRatings: number;
  ratedThisWeek: boolean;
  latestCurators: string[];
  lastComment: { text: string; curator: string; week: string } | null;
  /** Latest curator-set focus («над чем работать»), with whether the trader has acknowledged it. */
  lastFocus: { text: string; curator: string; week: string; ratingId: number; acknowledged: boolean } | null;
  tier: string | null;
  weakest: CriterionKey | null;
  strongest: CriterionKey | null;
};

const KEYS: ScoreKey[] = ["discipline", "riskManagement", "execution", "journaling", "improvement", "overall"];
const r1 = (n: number) => Math.round(n * 10) / 10;

export function avgScores(list: Pick<Rating, ScoreKey>[]): Scores {
  const out = {} as Scores;
  for (const k of KEYS) out[k] = list.length ? r1(list.reduce((s, r) => s + Number(r[k] ?? 0), 0) / list.length) : 0;
  out.composite = r1(CRITERIA.reduce((s, c) => s + out[c.key], 0) / CRITERIA.length);
  return out;
}

/** Build per-trader weekly scorecards from raw ratings (averaging across curators per week). */
export function buildScorecards(ratings: Rating[], currentWeek = weekOf(), maxWeeks = 12): Scorecard[] {
  const byTrader = new Map<string, Map<string, Rating[]>>();
  for (const r of ratings) {
    const m = byTrader.get(r.trader) ?? new Map<string, Rating[]>();
    const l = m.get(r.week) ?? [];
    l.push(r);
    m.set(r.week, l);
    byTrader.set(r.trader, m);
  }
  const out: Scorecard[] = [];
  for (const [trader, wk] of byTrader) {
    const weeks = [...wk.keys()].sort();
    const series = weeks.map((w) => ({ week: w, count: wk.get(w)!.length, ...avgScores(wk.get(w)!) })).slice(-maxWeeks);
    const all = weeks.flatMap((w) => wk.get(w)!);
    const latest = series[series.length - 1] ?? null;
    const prev = series.length > 1 ? series[series.length - 2] : null;
    const newestFirst = [...all].sort((a, b) => b.week.localeCompare(a.week) || b.createdAt.localeCompare(a.createdAt));
    const withComment = newestFirst.find((r) => r.comment?.trim());
    const withFocus = newestFirst.find((r) => r.focus?.trim());
    const withTier = newestFirst.find((r) => r.tier);
    let weakest: CriterionKey | null = null, strongest: CriterionKey | null = null;
    if (latest) {
      const sorted = [...CRITERIA].sort((a, b) => latest[a.key] - latest[b.key]);
      if (latest[sorted[0].key] !== latest[sorted[sorted.length - 1].key]) {
        weakest = sorted[0].key;
        strongest = sorted[sorted.length - 1].key;
      }
    }
    out.push({
      trader,
      latest, prev,
      avg: avgScores(all),
      series,
      totalRatings: all.length,
      ratedThisWeek: wk.has(currentWeek),
      latestCurators: latest ? [...new Set(wk.get(latest.week)!.map((r) => r.curator))] : [],
      lastComment: withComment ? { text: withComment.comment!.trim(), curator: withComment.curator, week: withComment.week } : null,
      lastFocus: withFocus
        ? { text: withFocus.focus!.trim(), curator: withFocus.curator, week: withFocus.week, ratingId: withFocus.id, acknowledged: !!withFocus.acknowledgedAt }
        : null,
      tier: withTier?.tier ?? null,
      weakest, strongest,
    });
  }
  return out.sort((a, b) => (b.latest?.overall ?? 0) - (a.latest?.overall ?? 0) || comparePersonNames(a.trader, b.trader));
}

export function criterionLabel(k: CriterionKey): string {
  return CRITERIA.find((c) => c.key === k)?.label ?? k;
}

// ─── Evidence (GET /api/ratings/evidence) ───────────────────────────────────

export type WeekTradeFacts = {
  trades: number; wins: number; losses: number; be: number; open: number;
  winRate: number | null; totalR: number | null; avgR: number | null; profitFactor: number | null;
  maxLossR: number | null; net: number | null; gross: number | null; avgRiskUsd: number | null;
  tradesWithNotesPct: number | null; activeDays: number;
};

export type RatingEvidence = {
  trader: string; week: string; weekEnd: string;
  trades: WeekTradeFacts; prevTrades: WeekTradeFacts; netDelta: number | null; worstDayNet: number | null;
  journal: { days: number; avgDiscipline: number | null; planFollowedPct: number | null; mistakes: string[] };
  ideas: { published: number; converted: number; reviewed: number };
  risk: { tier: string | null; maxRiskPerTrade: number | null; dailyLossLimit: number | null };
  breaches: string[];
  prevFocus: string | null;
  prevRating: Rating | null;
  currentRating: Rating | null;
};

/** Tier choices: the desk ladder Стажёр → Джун → Трейдер → Сеньор (same codes as trader_risk_limits.tier). */
export const TIER_CODES = ["trainee", "junior", "trader", "senior"] as const;
const TIER_COMMON = { trainee: "tiers.intern", junior: "tiers.junior", trader: "tiers.trader", senior: "tiers.senior" } as const;
const isTierCode = (t: string): t is (typeof TIER_CODES)[number] => (TIER_CODES as readonly string[]).includes(t);
/** Ladder tier label in the UI language; older pre-ladder codes (starter / standard / lead) too; unknown codes as is. */
export const tierLabel = (t: string | null | undefined): string => {
  if (!t) return "";
  if (isTierCode(t)) return commonI18n.t(TIER_COMMON[t]);
  return ratingsI18n.tryT(`legacyTier.${t}`) ?? t;
};
export const isLadderTier = isTierCode;
