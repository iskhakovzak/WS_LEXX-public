/**
 * The trader's focus as the curator sees it in the profile (GET /api/curator/trader/:name → `focus`): the focus in
 * force, its history (one FocusVerdict per finished trading day: what the focus was and whether it was kept), and the
 * trader's costliest mistakes of the window — the options a curator picks from to replace the focus
 * (PUT /api/daily/focus/:trader/:date, routes/daily.ts). Engine work goes through lib/daily/service; the history reads
 * the stored evening snapshots (daily_reviews.verdict) and computes only the missing days, within a time budget.
 */
import { pool } from "@workspace/db";
import { addDays, isWeekend, nyDate, nyMinutes } from "../tradingDate";
import { CLOSE_MINUTES, tradingPhase } from "../curatorLogic";
import { closeDateSql, netPnlSql, num } from "../tradeMath";
import { logger } from "../logger";
import { lastFinishedDay, queueDays, storedVerdict, warmVerdicts, type StoredVerdictRow } from "./costQueue";
import { eveningFor, focusFor, mistakeCosts } from "./service";
import { rewardsFor, type Rewards } from "./rewards";
import type { DailyFocus, FocusVerdict, MistakeCost } from "./types";

export const FOCUS_HISTORY_DAYS = 10;
const BUDGET_MS = 1500;

export type FocusHistoryDay = { date: string; trades: number; netPnl: number | null; focus: FocusVerdict | null; reviewed: boolean };

export interface CuratorFocus {
  /** The focus the trader sees now (the dashboard's day: today, the next weekday at the weekend). */
  current: DailyFocus | null;
  /** The trading day a replacement applies to: today before the close on a weekday, else the next weekday. */
  date: string;
  /** Newest first; days the trader traded. */
  history: FocusHistoryDay[];
  /** The trader's mistakes over the history window that cost money, costliest first. */
  options: MistakeCost[];
  window: { from: string; to: string };
  /** Contract streak, discipline points / level and badges (lib/daily/rewards); null when not computed in time. */
  rewards?: Rewards | null;
}

function nextWeekday(d: string): string {
  let x = d;
  for (let i = 0; i < 7 && isWeekend(x); i++) x = addDays(x, 1);
  return x;
}

/** The trading day a focus set now is for: today before the close on a weekday, else the next weekday. */
export function nextFocusDay(today: string, now: { date: string; minutes: number }): string {
  return nextWeekday(today === now.date && now.minutes >= CLOSE_MINUTES ? addDays(today, 1) : today);
}

/** The day whose focus the trader's dashboard shows (lib/daily/service dailyMe): today, the next weekday at the weekend. */
export function shownFocusDay(today: string): string {
  return tradingPhase(today, 0) === "weekend" ? nextWeekday(today) : today;
}

function withBudget<T>(p: Promise<T>, fallback: T, ms = BUDGET_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  const safe = p.catch((err: unknown) => {
    logger.warn({ err: (err as Error)?.message }, "curatorFocus: service call failed");
    return fallback;
  });
  return Promise.race([safe, late]).finally(() => timer && clearTimeout(timer));
}

async function loadHistory(trader: string, days: readonly string[]): Promise<FocusHistoryDay[]> {
  const cd = closeDateSql("t");
  const [traded, stored] = await Promise.all([
    pool.query<{ d: string; n: number; net: unknown }>(
      `SELECT LEFT(${cd}, 10) AS d, COUNT(*)::int AS n, SUM(${netPnlSql("t")}) FILTER (WHERE t.pnl IS NOT NULL)::float AS net
         FROM trades t WHERE t.deleted_at IS NULL AND t.trader = $1 AND LEFT(${cd}, 10) = ANY($2) GROUP BY 1`,
      [trader, days],
    ),
    pool
      .query<StoredVerdictRow & { reviewed_at: Date | null }>(
        `SELECT trader, date, verdict -> 'focus' AS focus, disputed, disputed_mistake, reviewed_at FROM daily_reviews WHERE trader = $1 AND date = ANY($2)`,
        [trader, days],
      )
      .catch(() => ({ rows: [] as (StoredVerdictRow & { reviewed_at: Date | null })[] })),
  ]);
  const byDay = new Map(stored.rows.map((r) => [String(r.date), r]));
  const tradedDays = traded.rows.filter((r) => Number(r.n) > 0);
  const missing = tradedDays.filter((r) => !byDay.get(String(r.d))?.focus).map((r): [string, string] => [trader, String(r.d)]);
  const computed = missing.length ? await warmVerdicts(missing, eveningFor, BUDGET_MS) : new Map<string, FocusVerdict | null>();
  return tradedDays
    .map((r) => {
      const d = String(r.d);
      const row = byDay.get(d);
      return {
        date: d,
        trades: Number(r.n),
        netPnl: num(r.net),
        focus: row?.focus ? storedVerdict(row) : computed.get(`${trader}|${d}`) ?? null,
        reviewed: !!row?.reviewed_at,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

export async function curatorFocusFor(trader: string, today: string): Promise<CuratorFocus> {
  const now = { date: nyDate(), minutes: nyMinutes() };
  const days = queueDays(lastFinishedDay(today, now), FOCUS_HISTORY_DAYS - 1);
  const window = { from: days[days.length - 1], to: days[0] };
  const [current, history, options, rewards] = await Promise.all([
    withBudget(focusFor(trader, shownFocusDay(today)), null),
    withBudget(loadHistory(trader, days), [] as FocusHistoryDay[], BUDGET_MS + 500),
    withBudget(mistakeCosts(trader, window.from, window.to), [] as MistakeCost[]),
    withBudget(rewardsFor(trader), null),
  ]);
  return {
    current,
    date: nextFocusDay(today, now),
    history,
    options: options.filter((o) => o.id && (o.costNet ?? 0) < 0).slice(0, 8),
    window,
    rewards,
  };
}
