/**
 * Discipline badges — PURE rules (no I/O), unit-tested. A badge rewards following the rules and reviewing the day,
 * never trading activity or P&L. Each rule reads stored data (lib/daily/rewards.ts loads it) and answers the NY day it
 * was first earned, or how far the trader is now. Awarding (once, idempotent) is lib/daily/rewards.ts.
 *
 *   streak_1/2/3  kept-contract days in a row reached rewards.streakBadge1/2/3Days (5 / 10 / 20) — the progressive
 *                 scale's streak (lib/daily/discipline.ts)
 *   reviews       rewards.reviewStreakDays (10) traded days in a row whose evening card was reviewed on time (that
 *                 day or the next trading day); a traded day without a review breaks the run, days off do not
 *   focus         the day's focus mistake absent rewards.focusCleanDays (5) judged days in a row (snapshot verdict
 *                 «kept»; «broken» breaks the run; no trades / unknown / disputed days are skipped)
 *   clean_month   a finished calendar month with ≥ rewards.cleanMonthMinDays (10) traded days, the daily stop known
 *                 on each of them and never reached (worst running net of the day > −stop)
 *   sim_first     the first own-day replay finished in the simulator (sim own mode)
 *   sim_beat      rewards.simBeatCount (3) own replays where the sim decision beat the real trade (verdict «better»)
 */
import { addDays, isWeekend } from "../tradingDate";
import type { LedgerDay } from "./discipline";
import type { BadgeId, BadgeState } from "./types";

export const BADGE_IDS: readonly BadgeId[] = ["streak_1", "streak_2", "streak_3", "reviews", "focus", "clean_month", "sim_first", "sim_beat"];

export type BadgeTargets = { streak: readonly [number, number, number]; reviews: number; focus: number; cleanMonthDays: number; simBeat: number };

/** A rule's answer: the day it was earned (null = not yet) and the progress now. */
export type RuleResult = { earnedOn: string | null; progress: number; target: number };

/** Inputs, all sorted or sortable by date. */
export type ReviewDay = { date: string; reviewedOn: string | null };
export type FocusDay = { date: string; status: string; disputed: boolean };
export type StopDay = { date: string; trough: number; limit: number | null };
export type OwnGame = { finishedOn: string; verdict: string | null };

export type BadgeInput = {
  ledger: readonly LedgerDay[];
  reviews: readonly ReviewDay[];
  focus: readonly FocusDay[];
  stops: readonly StopDay[];
  games: readonly OwnGame[];
  /** The last finished trading day (months up to its month − 1 are finished). */
  asOf: string;
};

const byDate = <T extends { date: string }>(a: readonly T[]): T[] => [...a].sort((x, y) => x.date.localeCompare(y.date));

/** A run of «hits» that «misses» reset and «skips» leave alone: the day the run first reached `target`, and the run now. */
function runRule<T extends { date: string }>(days: readonly T[], target: number, judge: (d: T) => "hit" | "miss" | "skip"): RuleResult {
  let run = 0, earnedOn: string | null = null;
  for (const d of byDate(days)) {
    const j = judge(d);
    if (j === "skip") continue;
    run = j === "hit" ? run + 1 : 0;
    if (earnedOn == null && run >= target) earnedOn = d.date;
  }
  return { earnedOn, progress: earnedOn ? target : Math.min(run, target), target };
}

/** Kept-contract streak reached `target` (the ledger carries the streak after each day). */
export function streakRule(ledger: readonly LedgerDay[], target: number): RuleResult {
  const sorted = byDate(ledger);
  const hit = sorted.find((d) => d.streak >= target);
  const now = sorted.length ? sorted[sorted.length - 1]!.streak : 0;
  return { earnedOn: hit?.date ?? null, progress: hit ? target : Math.min(now, target), target };
}

function nextWeekday(d: string): string {
  let x = addDays(d, 1);
  for (let i = 0; i < 7 && isWeekend(x); i++) x = addDays(x, 1);
  return x;
}

/** Reviewed on time = on the day itself or by the next trading day (the dashboard shows yesterday's card until the close). */
export function reviewedOnTime(r: ReviewDay): boolean {
  return r.reviewedOn != null && r.reviewedOn <= nextWeekday(r.date);
}

export function reviewsRule(days: readonly ReviewDay[], target: number, asOf: string): RuleResult {
  // The last finished day can still be reviewed tomorrow: not reviewed yet = skipped, not a miss.
  return runRule(days, target, (d) => (reviewedOnTime(d) ? "hit" : d.date >= asOf && d.reviewedOn == null ? "skip" : "miss"));
}

export function focusRule(days: readonly FocusDay[], target: number): RuleResult {
  return runRule(days, target, (d) => (d.disputed ? "skip" : d.status === "kept" ? "hit" : d.status === "broken" ? "miss" : "skip"));
}

/** First finished month with enough traded days, the stop known on each and never reached. Progress = the current month. */
export function cleanMonthRule(days: readonly StopDay[], minDays: number, asOf: string): RuleResult {
  const months = new Map<string, StopDay[]>();
  for (const d of byDate(days)) {
    const m = d.date.slice(0, 7);
    (months.get(m) ?? months.set(m, []).get(m)!).push(d);
  }
  const current = asOf.slice(0, 7);
  const clean = (list: readonly StopDay[]) => list.every((d) => d.limit != null && d.limit > 0 && d.trough > -d.limit);
  for (const [m, list] of months) {
    if (m >= current) continue;
    if (list.length >= minDays && clean(list)) return { earnedOn: list[list.length - 1]!.date, progress: minDays, target: minDays };
  }
  const now = months.get(current) ?? [];
  return { earnedOn: null, progress: clean(now) ? Math.min(now.length, minDays) : 0, target: minDays };
}

export function simFirstRule(games: readonly OwnGame[]): RuleResult {
  const first = [...games].sort((a, b) => a.finishedOn.localeCompare(b.finishedOn))[0];
  return { earnedOn: first?.finishedOn ?? null, progress: first ? 1 : 0, target: 1 };
}

export function simBeatRule(games: readonly OwnGame[], target: number): RuleResult {
  const better = games.filter((g) => g.verdict === "better").sort((a, b) => a.finishedOn.localeCompare(b.finishedOn));
  const hit = better[target - 1];
  return { earnedOn: hit?.finishedOn ?? null, progress: Math.min(better.length, target), target };
}

/** Every badge rule over the inputs. */
export function evaluateBadges(input: BadgeInput, t: BadgeTargets): Record<BadgeId, RuleResult> {
  return {
    streak_1: streakRule(input.ledger, t.streak[0]),
    streak_2: streakRule(input.ledger, t.streak[1]),
    streak_3: streakRule(input.ledger, t.streak[2]),
    reviews: reviewsRule(input.reviews, t.reviews, input.asOf),
    focus: focusRule(input.focus, t.focus),
    clean_month: cleanMonthRule(input.stops, t.cleanMonthDays, input.asOf),
    sim_first: simFirstRule(input.games),
    sim_beat: simBeatRule(input.games, t.simBeat),
  };
}

/**
 * Badge states for the API: an awarded badge keeps its stored day (awarded once — a later rule change never takes it
 * away); a not-awarded one shows the rule's progress.
 */
export function badgeStates(results: Record<BadgeId, RuleResult>, awarded: ReadonlyMap<BadgeId, { date: string; target: number }>): BadgeState[] {
  return BADGE_IDS.map((id) => {
    const a = awarded.get(id);
    const r = results[id];
    return a ? { id, earnedOn: a.date, target: a.target, progress: a.target } : { id, earnedOn: null, target: r.target, progress: r.progress };
  });
}
