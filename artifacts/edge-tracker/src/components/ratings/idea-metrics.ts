import { normalizeResult } from "@/lib/trade-result";
import { signedR, netPnl } from "@/lib/trade-math";
import { ratingsI18n } from "@/i18n/ns/ratings";
import { ideasI18n } from "@/i18n/ns/ideas";

export type IdeaReaction = { id: number; trader: string; reaction: string };
/** `r` / `net` / `outcome` come from the API (shared trade math); the raw columns are kept for older payloads. */
export type LinkedTrade = {
  id: number; result: string; pnl: string | number | null; rMultiple: string | number | null; date: string;
  side?: string | null; entry?: string | null; exit?: string | null; stop?: string | null; fees?: string | null; riskUsd?: string | null;
  r?: number | null; net?: number | null; outcome?: "win" | "loss" | "be" | "open" | null;
};
export type TradeIdea = {
  id: number;
  ticker: string;
  side: string | null;
  setup: string | null;
  score: number | null;
  setupQuality: string | null;
  status: string;
  trader: string | null;
  ideaDate: string | null;
  createdAt: string;
  publishedAt: string | null;
  convertedTradeId: number | null;
  reactions?: IdeaReaction[];
  linkedTrade?: LinkedTrade | null;
};

export type Outcome = "win" | "loss" | "be" | "open" | "none";

export type EnrichedIdea = TradeIdea & {
  date: string;
  outcome: Outcome;
  r: number | null;
  pnl: number | null;
  published: boolean;
  converted: boolean;
};

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Live price tracking of an idea (GET /trade-ideas/tracking): did price reach the target or the stop first. */
export type PriceTrack = { hit: "target" | "final_target" | "stop" | null; plannedR: number | null };
/** Where an idea's outcome comes from: the linked trade, or price vs. the idea's own target / stop. */
export type OutcomeBasis = "trades" | "price";

/**
 * Price basis: target first → win at the planned R to target 1, stop first → loss at −1R, tracked without a hit → open.
 * Ideas without numeric levels (not tracked) or drafts have no outcome. Money stays null — no position was measured.
 */
function enrichByPrice(i: TradeIdea, track: PriceTrack | null | undefined): EnrichedIdea {
  const published = i.status === "published" || i.status === "converted";
  let outcome: Outcome = "none";
  let r: number | null = null;
  if (published && track) {
    if (track.hit === "stop") { outcome = "loss"; r = -1; }
    else if (track.hit === "target" || track.hit === "final_target") { outcome = "win"; r = track.plannedR != null && Number.isFinite(track.plannedR) ? track.plannedR : null; }
    else outcome = "open";
  }
  return { ...i, date: (i.ideaDate || i.createdAt || "").slice(0, 10), outcome, r, pnl: null, published, converted: !!i.linkedTrade };
}

export function enrichIdea(i: TradeIdea, opts?: { basis?: OutcomeBasis; track?: PriceTrack | null }): EnrichedIdea {
  if (opts?.basis === "price") return enrichByPrice(i, opts.track);
  const lt = i.linkedTrade ?? null;
  let outcome: Outcome = "none";
  if (lt) {
    const n = lt.outcome ?? normalizeResult(lt.result);
    const raw = (lt.result ?? "").toLowerCase().trim();
    // Legacy stored result values (some rows were written in Russian) — data parsing, not UI text.
    outcome = n ?? (raw === "winner" || raw === "profit" ? "win" : raw === "loser" || raw === "убыточный" ? "loss" : raw === "ноль" ? "be" : "open"); // i18n-ignore
  }
  // One trade math: signed R (BE ⇒ 0, open ⇒ null) and net P&L (gross − |fees|), server value first.
  const r = lt ? (lt.r != null && Number.isFinite(lt.r) ? lt.r : signedR({ ...lt, rMultiple: num(lt.rMultiple), pnl: num(lt.pnl) })) : null;
  const pnl = lt ? (lt.net != null && Number.isFinite(lt.net) ? lt.net : netPnl({ ...lt, pnl: num(lt.pnl) })) : null;
  return {
    ...i,
    date: (i.ideaDate || i.createdAt || "").slice(0, 10),
    outcome,
    r,
    pnl,
    published: i.status === "published" || i.status === "converted",
    converted: !!lt,
  };
}

export type Bucket = {
  ideas: number; published: number; converted: number;
  wins: number; losses: number; be: number; open: number; closed: number;
  hitRate: number | null; avgR: number | null; sumR: number; rCount: number;
  conversion: number | null;
};

export function bucketOf(list: EnrichedIdea[]): Bucket {
  let published = 0, converted = 0, wins = 0, losses = 0, be = 0, open = 0, sumR = 0, rCount = 0;
  for (const i of list) {
    if (i.published) published++;
    if (i.converted) converted++;
    if (i.outcome === "win") wins++;
    else if (i.outcome === "loss") losses++;
    else if (i.outcome === "be") be++;
    else if (i.outcome === "open") open++;
    if (i.r != null) { sumR += i.r; rCount++; }
  }
  const closed = wins + losses + be;
  const decided = wins + losses;
  return {
    ideas: list.length, published, converted, wins, losses, be, open, closed,
    // Hit rate = W / (W + L): break-even is neither a hit nor a miss (same rule as the trades win rate).
    hitRate: decided > 0 ? wins / decided : null,
    avgR: rCount > 0 ? sumR / rCount : null,
    sumR, rCount,
    conversion: published > 0 ? converted / published : null,
  };
}

/** Pearson correlation; null when n < 5 or no variance. */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 5) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < n; k++) {
    sxy += (xs[k] - mx) * (ys[k] - my);
    sxx += (xs[k] - mx) ** 2;
    syy += (ys[k] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Score vs realised R: correlation over ideas that have both. */
export function calibrationOf(list: EnrichedIdea[]): { r: number | null; n: number } {
  const pts = list.filter((i) => i.score != null && i.r != null);
  return { r: pearson(pts.map((p) => p.score!), pts.map((p) => p.r!)), n: pts.length };
}

export const SCORE_BUCKETS = [
  { key: "80", label: "80–100", min: 80, max: 100 },
  { key: "65", label: "65–79", min: 65, max: 79.999 },
  { key: "50", label: "50–64", min: 50, max: 64.999 },
  { key: "0", label: "< 50", min: 0, max: 49.999 },
] as const;

export const QUALITY_ORDER = ["A+", "A", "B+", "B", "C", "D"] as const;

export type CalibRow = Bucket & { key: string; label: string };
/* Labels of the «no score» / «no grade» rows are read when the rows are built (render time). */

export function scoreCalibration(list: EnrichedIdea[]): CalibRow[] {
  const rows: CalibRow[] = SCORE_BUCKETS.map((b) => ({
    key: b.key, label: b.label,
    ...bucketOf(list.filter((i) => i.score != null && i.score >= b.min && i.score <= b.max)),
  }));
  rows.push({ key: "none", label: ratingsI18n.t("calib.noScore"), ...bucketOf(list.filter((i) => i.score == null)) });
  return rows;
}

export function qualityCalibration(list: EnrichedIdea[]): CalibRow[] {
  const rows: CalibRow[] = QUALITY_ORDER.map((q) => ({ key: q, label: q, ...bucketOf(list.filter((i) => i.setupQuality === q)) }));
  rows.push({ key: "none", label: ratingsI18n.t("calib.noGrade"), ...bucketOf(list.filter((i) => !i.setupQuality || !QUALITY_ORDER.includes(i.setupQuality as never))) });
  return rows;
}

export type AuthorStats = Bucket & {
  trader: string;
  avgScore: number | null;
  calib: { r: number | null; n: number };
  best: EnrichedIdea | null;
  lastDate: string | null;
  sparkR: number[];
};

export function authorStats(list: EnrichedIdea[]): AuthorStats[] {
  const by = new Map<string, EnrichedIdea[]>();
  for (const i of list) {
    const t = i.trader ?? ideasI18n.t("stats.noAuthor");
    const l = by.get(t) ?? [];
    l.push(i);
    by.set(t, l);
  }
  return [...by.entries()].map(([trader, ideas]) => {
    const scored = ideas.filter((i) => i.score != null);
    const withR = ideas.filter((i) => i.r != null).sort((a, b) => a.date.localeCompare(b.date));
    let cum = 0;
    const best = withR.length ? withR.reduce((a, b) => (b.r! > a.r! ? b : a)) : null;
    return {
      trader,
      ...bucketOf(ideas),
      avgScore: scored.length ? scored.reduce((s, i) => s + i.score!, 0) / scored.length : null,
      calib: calibrationOf(ideas),
      best,
      lastDate: ideas.reduce<string | null>((m, i) => (!m || i.date > m ? i.date : m), null),
      sparkR: withR.map((i) => (cum += i.r!)),
    };
  });
}

export function calibVerdict(c: { r: number | null; n: number }): { text: string; tone: "up" | "down" | "warn" | "neutral" } {
  const t = ratingsI18n.t;
  if (c.r == null) return { text: c.n < 5 ? t("calib.fewData", { n: c.n }) : t("calib.noSpread"), tone: "neutral" };
  if (c.r >= 0.3) return { text: t("calib.predicts"), tone: "up" };
  if (c.r <= -0.1) return { text: t("calib.inverse"), tone: "down" };
  return { text: t("calib.weak"), tone: "warn" };
}
