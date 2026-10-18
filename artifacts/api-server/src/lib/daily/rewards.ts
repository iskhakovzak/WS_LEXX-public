/**
 * Discipline rewards — DB side: loads what the badge rules (lib/daily/badges.ts) read, awards new badges once
 * (trader_badges, migration 0204: INSERT … ON CONFLICT DO NOTHING — idempotent, a second process or run awards nothing
 * twice), sends an in-app notification for a freshly earned badge (type «discipline_badge», params as data, rendered
 * per reader) and answers the trader's streak / points / level (lib/daily/discipline.ts) with every badge state.
 *
 * When it runs: on read (GET /api/daily/me, the evening card of the last finished day, the curator profile) with a
 * per-process cache keyed by (trader, last finished day) for CACHE_MS — a new finished day or a changed snapshot
 * recomputes at once — and nightly (rewards.nightly job, lib/daily/rewardsJob.ts) for every trader of the day, so
 * badges and the Telegram card line do not wait for a visit.
 *
 * Only badges earned in the last NOTIFY_DAYS calendar days notify: the first run after the rollout awards history
 * quietly instead of flooding the bell.
 */
import { pool } from "@workspace/db";
import { loadBehaviorRows, rowToBehaviorTrade } from "../../routes/behavior";
import { fetchRiskLimits } from "../rulesEngine";
import { notifyUser } from "../notifyUtils";
import { logger } from "../logger";
import { setting } from "../settings/registry";
import { addDays } from "../tradingDate";
import { dayPath, windowDays } from "./detectors";
import { contractLedger, disciplineSummary, lastFinishedDay, loadPlanContracts } from "./discipline";
import {
  BADGE_IDS, badgeStates, evaluateBadges, type BadgeTargets, type FocusDay, type OwnGame, type ReviewDay, type RuleResult, type StopDay,
} from "./badges";
import type { BadgeId, BadgeState, DisciplineSummary, EveningCard } from "./types";

export const CACHE_MS = 5 * 60_000;
export const NOTIFY_DAYS = 7;
/** Traded days looked at for the review run; months looked back for the clean month. */
const REVIEW_LOOKBACK_DAYS = 180;
const CLEAN_MONTHS_BACK = 3;

export type Rewards = { discipline: DisciplineSummary; badges: BadgeState[] };

const isBadge = (v: string): v is BadgeId => (BADGE_IDS as readonly string[]).includes(v);

export function badgeTargets(): BadgeTargets {
  return {
    streak: [setting("rewards.streakBadge1Days"), setting("rewards.streakBadge2Days"), setting("rewards.streakBadge3Days")],
    reviews: setting("rewards.reviewStreakDays"),
    focus: setting("rewards.focusCleanDays"),
    cleanMonthDays: setting("rewards.cleanMonthMinDays"),
    simBeat: setting("rewards.simBeatCount"),
  };
}

const loadTradesOf = (trader: string) => async (from: string, to: string) => (await loadBehaviorRows(trader, from, to)).map(rowToBehaviorTrade);

// ─── loaders ────────────────────────────────────────────────────────────────

export async function awardedBadges(trader: string): Promise<Map<BadgeId, { date: string; target: number }>> {
  const { rows } = await pool
    .query<{ badge: string; awarded_on: string; target: number }>(`SELECT badge, awarded_on, target FROM trader_badges WHERE trader = $1`, [trader])
    .catch(() => ({ rows: [] as { badge: string; awarded_on: string; target: number }[] }));
  return new Map(rows.filter((r) => isBadge(r.badge)).map((r) => [r.badge as BadgeId, { date: String(r.awarded_on), target: Number(r.target) }]));
}

async function reviewDays(trader: string, asOf: string): Promise<ReviewDay[]> {
  const { rows } = await pool.query<{ d: string; reviewed_on: string | null }>(
    `SELECT t.d, to_char(r.reviewed_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS reviewed_on
       FROM (SELECT DISTINCT substring(date, 1, 10) AS d FROM trades
              WHERE trader = $1 AND deleted_at IS NULL AND substring(date, 1, 10) >= $2 AND substring(date, 1, 10) <= $3) t
       LEFT JOIN daily_reviews r ON r.trader = $1 AND r.date = t.d
      ORDER BY t.d`,
    [trader, addDays(asOf, -REVIEW_LOOKBACK_DAYS), asOf],
  );
  return rows.map((r) => ({ date: String(r.d), reviewedOn: r.reviewed_on }));
}

async function focusDays(trader: string, asOf: string): Promise<FocusDay[]> {
  const { rows } = await pool.query<{ date: string; status: string | null; disputed: boolean }>(
    `SELECT date, verdict #>> '{focus,status}' AS status, disputed FROM daily_reviews
      WHERE trader = $1 AND date <= $2 AND verdict #>> '{focus,status}' IS NOT NULL ORDER BY date`,
    [trader, asOf],
  );
  return rows.map((r) => ({ date: String(r.date), status: String(r.status), disputed: !!r.disputed }));
}

/** Traded days of the last CLEAN_MONTHS_BACK finished months + the current one: worst running net and the daily stop. */
async function stopDays(trader: string, asOf: string): Promise<StopDay[]> {
  const d = new Date(`${asOf.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - CLEAN_MONTHS_BACK);
  const from = d.toISOString().slice(0, 10);
  const [trades, plans, limits] = await Promise.all([loadTradesOf(trader)(from, asOf), loadPlanContracts(trader, from, asOf), fetchRiskLimits(trader)]);
  const out: StopDay[] = [];
  for (const [date, list] of windowDays(trades, from, asOf)) {
    const plan = plans.get(date)?.maxLossUsd ?? null;
    const limit = plan != null && plan > 0 ? plan : (limits.dailyLossLimit ?? null);
    out.push({ date, trough: dayPath(list).trough, limit: limit != null && limit > 0 ? limit : null });
  }
  return out;
}

async function ownGames(trader: string): Promise<OwnGame[]> {
  const { rows } = await pool
    .query<{ finished_on: string; verdict: string | null }>(
      `SELECT to_char(g.finished_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS finished_on, g.result #>> '{own,verdict}' AS verdict
         FROM sim_games g JOIN users u ON u.id = g.user_id
        WHERE u.name = $1 AND g.params ? 'own' AND g.status = 'finished' AND g.finished_at IS NOT NULL`,
      [trader],
    )
    .catch(() => ({ rows: [] as { finished_on: string; verdict: string | null }[] }));
  return rows.map((r) => ({ finishedOn: String(r.finished_on), verdict: r.verdict }));
}

// ─── awarding ───────────────────────────────────────────────────────────────

const NOTIFY_VARIANT: Record<BadgeId, string> = {
  streak_1: "streak", streak_2: "streak", streak_3: "streak", reviews: "reviews", focus: "focus",
  clean_month: "clean_month", sim_first: "sim_first", sim_beat: "sim_beat",
};

/** Inserts the newly earned badges (once) and notifies the recent ones. Returns the badges this call awarded. */
export async function awardBadges(trader: string, results: Record<BadgeId, RuleResult>, awarded: ReadonlyMap<BadgeId, unknown>, today: string): Promise<{ id: BadgeId; date: string; target: number }[]> {
  const fresh = BADGE_IDS.filter((id) => !awarded.has(id) && results[id].earnedOn);
  const out: { id: BadgeId; date: string; target: number }[] = [];
  for (const id of fresh) {
    const r = results[id];
    const { rows } = await pool.query<{ badge: string }>(
      `INSERT INTO trader_badges (trader, badge, awarded_on, target) VALUES ($1, $2, $3, $4) ON CONFLICT (trader, badge) DO NOTHING RETURNING badge`,
      [trader, id, r.earnedOn, r.target],
    );
    if (!rows.length) continue; // another process awarded it first
    out.push({ id, date: r.earnedOn!, target: r.target });
    if (r.earnedOn! >= addDays(today, -NOTIFY_DAYS)) {
      await notifyUser({
        userName: trader, type: "discipline_badge", params: { variant: NOTIFY_VARIANT[id], count: r.target, badge: id },
        link: "/?rewards=1", entityType: "badge", entityId: id, source: "rewards",
      });
    }
  }
  return out;
}

// ─── entry points ───────────────────────────────────────────────────────────

const cache = new Map<string, { at: number; asOf: string; value: Rewards }>();

/** Drop the cached answer (a new snapshot, a review) so the next read recomputes. */
export function forgetRewards(trader: string): void {
  cache.delete(trader);
}

/** Recomputes everything for one trader, awards new badges, refreshes the cache. */
export async function evaluateRewards(trader: string, now = new Date()): Promise<Rewards> {
  const asOf = lastFinishedDay(now);
  const awarded = await awardedBadges(trader);
  const needClean = !awarded.has("clean_month");
  const [{ summary, ledger }, reviews, focus, stops, games] = await Promise.all([
    disciplineSummary(trader, { loadTrades: loadTradesOf(trader), now }),
    reviewDays(trader, asOf).catch(() => []),
    focusDays(trader, asOf).catch(() => []),
    needClean ? stopDays(trader, asOf).catch(() => []) : Promise.resolve([] as StopDay[]),
    ownGames(trader),
  ]);
  const results = evaluateBadges({ ledger, reviews, focus, stops, games, asOf }, badgeTargets());
  for (const b of await awardBadges(trader, results, awarded, asOf)) awarded.set(b.id, { date: b.date, target: b.target });
  const value: Rewards = { discipline: summary, badges: badgeStates(results, awarded) };
  cache.set(trader, { at: Date.now(), asOf, value });
  return value;
}

/** Cached rewards (recomputed after CACHE_MS, on a new finished day, or after forgetRewards). Null when it failed. */
export async function rewardsFor(trader: string, now = new Date()): Promise<Rewards | null> {
  const hit = cache.get(trader);
  if (hit && hit.asOf === lastFinishedDay(now) && Date.now() - hit.at < CACHE_MS) return hit.value;
  try {
    return await evaluateRewards(trader, now);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, trader }, "rewards: evaluation failed");
    return null;
  }
}

/** Badges earned on `date` (stored; for older evening cards). */
export async function badgesOn(trader: string, date: string): Promise<{ id: BadgeId; target: number }[]> {
  const awarded = await awardedBadges(trader);
  return BADGE_IDS.filter((id) => awarded.get(id)?.date === date).map((id) => ({ id, target: awarded.get(id)!.target }));
}

/**
 * The evening card's rewards line: the kept-contract streak after `date` (`streak` = from the scaled verdict, when the
 * day had a contract) and the badges earned that day. The last finished day evaluates (cached); older days read.
 */
export async function cardRewards(trader: string, date: string, streak: number | null, now = new Date()): Promise<EveningCard["rewards"]> {
  if (date === lastFinishedDay(now)) {
    const r = await rewardsFor(trader, now);
    if (!r) return null;
    return { streak: streak ?? r.discipline.streak, badges: r.badges.filter((b) => b.earnedOn === date).map((b) => ({ id: b.id, target: b.target })) };
  }
  const s = streak ?? (await contractLedger(trader, { to: date, now })).at(-1)?.streak ?? 0;
  return { streak: s, badges: await badgesOn(trader, date) };
}
