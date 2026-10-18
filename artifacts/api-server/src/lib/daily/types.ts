/**
 * Daily loop contract (owner goal 2026-10-18: keep new traders; every visit gives one useful thing).
 * Shared by the engine (lib/daily/engine.ts, service.ts), routes/daily.ts, the curator queue, the Telegram bot and the
 * web mirror (edge-tracker src/lib/daily/types.ts — keep both in sync).
 *
 *   Morning  — DailyFocus: the trader's costliest repeating mistake of the last 10 trading days, one line.
 *   Evening  — EveningCard: was the focus kept (decided from the trades, never typed), one trade worth a look, how the
 *              desk traded the same ticker, the own-contract verdict (daily stop / max trades / own rule from the
 *              personal plan), reviewed yes/no.
 *   Weekly   — TierProgress: «to Junior: 3 of 5» from the scaling ladder.
 *
 * Money is NET ($, pnl − |fees|, ≤ 0 = cost). Dates are New York trading days (YYYY-MM-DD). Texts travel as data
 * (TextItem: key + params) and are rendered per reader (web dictionaries, server `daily` namespace for Telegram).
 */

/** Stable ids. «behavior:<PatternKey>» from lib/behaviorEngine, «structure:averaging» (add against a losing position,
 * lib/tradeStructure), «structure:held_past_stop», «day:giveback» (day peak net ≥ X then closed near/below zero),
 * «day:fees» (fees ≥ 50 % of gross), «day:after_limit» (trading after the daily loss limit), «rule:<RuleKind>». */
export type MistakeId = string;

export type TextItem = { key: string; params?: Record<string, string | number | null> };

export type TradeRef = { tradeId: number; date: string; ticker: string; net: number | null };

export interface MistakeCost {
  id: MistakeId;
  /** Occurrences (trades or days) in the window. */
  count: number;
  /** Distinct trading days it happened on. */
  days: number;
  /** Σ net impact in $ (≤ 0 = cost); null when money is unknown. */
  costNet: number | null;
  examples: TradeRef[];
}

export interface DailyFocus {
  trader: string;
  /** The trading day this focus is FOR (computed after the previous day closed). */
  date: string;
  mistake: MistakeId | null;
  window: { from: string; to: string };
  costNet: number | null;
  count: number;
  /** «auto» = engine, «curator» = a curator replaced it, «none» = nothing repeating (good!). */
  source: "auto" | "curator" | "none";
  /** One line for the trader, e.g. key "focus.behavior:martingale" with {cost, count}. */
  text: TextItem;
}

export type VerdictStatus = "kept" | "broken" | "no_trades" | "unknown";

export interface FocusVerdict {
  date: string;
  mistake: MistakeId;
  status: VerdictStatus;
  hits: TradeRef[];
  costNet: number | null;
  /** The trader pressed «this is not a mistake» — excluded from the next focus pick and shown to the curator. */
  disputed: boolean;
}

export interface ContractVerdict {
  date: string;
  maxLoss: { limit: number | null; actual: number | null; status: VerdictStatus | "unset" };
  maxTrades: { limit: number | null; actual: number; status: VerdictStatus | "unset" };
  /** Own rule for the day (a MistakeId picked in the plan, usually the focus) — checked like the focus. */
  rule: { mistake: MistakeId | null; status: VerdictStatus | "unset" };
  /** Points to the day's discipline score: kept +, broken −, unset 0 (lib/daily/engine.ts DISCIPLINE_POINTS). */
  disciplineDelta: number;
}

export interface EveningCard {
  trader: string;
  date: string;
  trades: number;
  netPnl: number | null;
  focus: FocusVerdict | null;
  /** One trade worth opening: the biggest loss, else a giveback, else the best trade. */
  tradeToReview: (TradeRef & { reason: "biggest_loss" | "giveback" | "focus_hit" | "best" }) | null;
  /** Other traders on the same ticker that day (for «same ticker, same day»). */
  deskSameTicker: { ticker: string; traders: number } | null;
  contract: ContractVerdict | null;
  reviewed: boolean;
  reviewNote: string | null;
  /** Kept-contract streak after this day and the badges earned on it (lib/daily/discipline, lib/daily/rewards). */
  rewards?: { streak: number; badges: { id: BadgeId; target: number }[] } | null;
}

export interface TierProgressItem { metric: string; label: TextItem; actual: number | null; target: number | null; ok: boolean }

export interface TierProgress {
  tier: string | null;
  nextTier: string | null;
  met: number;
  total: number;
  items: TierProgressItem[];
}

/** GET /api/daily/me and GET /api/daily/trader/:name (staff). */
export interface DailyMe {
  today: string;
  phase: "premarket" | "session" | "afterclose" | "weekend";
  focus: DailyFocus | null;
  /** The last finished trading day (yesterday before the close, today after it). */
  evening: EveningCard | null;
  progress: TierProgress | null;
  /** Intraday contract checks are live only when the PropReports scheduled sync is on (PROPREPORTS_SYNC_MINUTES). */
  intraday: boolean;
  /** Contract streak, discipline points and level (absent on older servers / when it could not be computed). */
  discipline?: DisciplineSummary | null;
  /** Every badge: earned ones carry the day, locked ones the progress. */
  badges?: BadgeState[];
}

/**
 * Discipline rewards — follow the rules and review, never trade more (a streak for trading every day would push
 * overtrading). Points come only from the own contract (lib/daily/discipline.ts progressive scale); badges from stored
 * data (lib/daily/badges.ts rules, awarded once in trader_badges). All numbers are desk settings (discipline.*, rewards.*).
 */
export type BadgeId = "streak_1" | "streak_2" | "streak_3" | "reviews" | "focus" | "clean_month" | "sim_first" | "sim_beat";

export interface DisciplineSummary {
  /** Kept-contract days in a row up to the last finished day (days without a contract neither break nor grow it). */
  streak: number;
  bestStreak: number;
  /** Bonus points the next kept day adds on top of the item points (progressive scale). */
  nextBonus: number;
  /** Σ contract points over the last `windowDays` trading days, and all time. */
  points30: number;
  pointsTotal: number;
  windowDays: number;
  /** Level index 0.. (texts `rewards.level.<n>`), from pointsTotal and the settings thresholds. */
  level: number;
  /** Threshold of the current level; of the next one (null at the top). */
  levelFrom: number;
  nextLevelAt: number | null;
}

export interface BadgeState {
  id: BadgeId;
  /** NY trading day it was earned; null = not yet. */
  earnedOn: string | null;
  /** The number in its name (days in a row, games …). */
  target: number;
  /** Where the trader is now (0..target; = target once earned). */
  progress: number;
}

/** Curator queue row (GET /api/curator/today `byCost`): the desk's most expensive problems first. */
export interface CostQueueItem {
  trader: string;
  date: string;
  /** Σ cost in $ (≤ 0) of everything below; the sort key. */
  costNet: number;
  reasons: { kind: "stop_breach" | "focus_broken" | "fees" | "loss_streak" | "giveback" | "rule" | "disputed"; costNet: number | null; text: TextItem; tradeId?: number }[];
}
