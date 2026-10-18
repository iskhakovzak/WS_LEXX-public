/**
 * Desk settings an admin changes on the site (owner decision 2026-10-18: «легко настраивать, всё на сайте»).
 * One typed registry: every tunable number / time / switch is declared here with its default, bounds and group; the
 * admin page renders its form from this list, and code reads values with `setting(key)` (sync: the store keeps a warm
 * cache, filled at start-up and after every save; until then the default). Labels live in the server/web i18n under
 * `settings.<key>` — never hard-code texts here.
 *
 * Adding a setting: append to SETTINGS (keep keys stable — they are stored in app_settings), read it with setting().
 */

export type SettingGroup = "daily" | "discipline" | "rewards" | "telegram" | "curator" | "privacy";
export type SettingUnit = "usd" | "pct" | "days" | "points" | "minutes" | "count" | "ratio";

type Base = { group: SettingGroup; unit?: SettingUnit };
export type NumberDef = Base & { type: "number"; default: number; min: number; max: number; step?: number };
export type TimeDef = Base & { type: "time"; default: string /* "HH:MM", New York time */ };
export type BoolDef = Base & { type: "boolean"; default: boolean };
export type SelectDef = Base & { type: "select"; default: string; options: readonly string[] };
export type SettingDef = NumberDef | TimeDef | BoolDef | SelectDef;

export const SETTINGS = {
  // Daily focus (lib/daily/detectors + engine)
  "daily.focusWindowDays": { group: "daily", type: "number", default: 10, min: 3, max: 30, step: 1, unit: "days" },
  "daily.focusMinDays": { group: "daily", type: "number", default: 2, min: 1, max: 10, step: 1, unit: "days" },
  "daily.focusMinCostUsd": { group: "daily", type: "number", default: 10, min: 0, max: 1000, step: 5, unit: "usd" },
  "daily.feesShare": { group: "daily", type: "number", default: 0.5, min: 0.1, max: 1, step: 0.05, unit: "ratio" },
  "daily.feesHealthyShare": { group: "daily", type: "number", default: 0.25, min: 0, max: 1, step: 0.05, unit: "ratio" },
  "daily.feesMinUsd": { group: "daily", type: "number", default: 5, min: 0, max: 500, step: 1, unit: "usd" },
  "daily.givebackMinPeakUsd": { group: "daily", type: "number", default: 50, min: 0, max: 5000, step: 10, unit: "usd" },
  "daily.givebackKeepShare": { group: "daily", type: "number", default: 0.2, min: 0, max: 1, step: 0.05, unit: "ratio" },

  // Own contract → discipline (lib/daily/discipline)
  "discipline.contractKeptPoints": { group: "discipline", type: "number", default: 5, min: 0, max: 50, step: 1, unit: "points" },
  "discipline.contractBrokenPoints": { group: "discipline", type: "number", default: -15, min: -100, max: 0, step: 1, unit: "points" },
  // Progressive scale: a kept day adds step × (kept days in a row before it), at most the cap, on top of the item points.
  "discipline.streakStepPoints": { group: "discipline", type: "number", default: 1, min: 0, max: 20, step: 1, unit: "points" },
  "discipline.streakBonusCapPoints": { group: "discipline", type: "number", default: 10, min: 0, max: 100, step: 1, unit: "points" },
  // A broken day: «reset» = the streak starts again from 0; «halve» = it keeps half (rounded down).
  "discipline.streakOnBreak": { group: "discipline", type: "select", default: "reset", options: ["reset", "halve"] },
  "discipline.pointsWindowDays": { group: "discipline", type: "number", default: 30, min: 5, max: 120, step: 1, unit: "days" },

  // Rewards: levels by all-time discipline points, badge thresholds (lib/daily/badges, lib/daily/rewards)
  "rewards.level1Points": { group: "rewards", type: "number", default: 50, min: 1, max: 100000, step: 10, unit: "points" },
  "rewards.level2Points": { group: "rewards", type: "number", default: 150, min: 1, max: 100000, step: 10, unit: "points" },
  "rewards.level3Points": { group: "rewards", type: "number", default: 400, min: 1, max: 100000, step: 10, unit: "points" },
  "rewards.level4Points": { group: "rewards", type: "number", default: 800, min: 1, max: 100000, step: 10, unit: "points" },
  "rewards.streakBadge1Days": { group: "rewards", type: "number", default: 5, min: 2, max: 250, step: 1, unit: "days" },
  "rewards.streakBadge2Days": { group: "rewards", type: "number", default: 10, min: 2, max: 250, step: 1, unit: "days" },
  "rewards.streakBadge3Days": { group: "rewards", type: "number", default: 20, min: 2, max: 250, step: 1, unit: "days" },
  "rewards.reviewStreakDays": { group: "rewards", type: "number", default: 10, min: 2, max: 100, step: 1, unit: "days" },
  "rewards.focusCleanDays": { group: "rewards", type: "number", default: 5, min: 2, max: 60, step: 1, unit: "days" },
  "rewards.cleanMonthMinDays": { group: "rewards", type: "number", default: 10, min: 1, max: 23, step: 1, unit: "days" },
  "rewards.simBeatCount": { group: "rewards", type: "number", default: 3, min: 1, max: 50, step: 1, unit: "count" },

  // Telegram daily loop (lib/daily/telegramJobs; New York time, weekdays)
  "telegram.morningEnabled": { group: "telegram", type: "boolean", default: true },
  "telegram.morningTime": { group: "telegram", type: "time", default: "08:45" },
  "telegram.eveningEnabled": { group: "telegram", type: "boolean", default: true },
  "telegram.eveningTime": { group: "telegram", type: "time", default: "16:30" },
  "telegram.contractAlertsEnabled": { group: "telegram", type: "boolean", default: true },

  // Curator queue (lib/daily/costQueue)
  "curator.queueCarryDays": { group: "curator", type: "number", default: 2, min: 0, max: 10, step: 1, unit: "days" },

  // Privacy of cross-trader views (desk-day, top of the day)
  "privacy.hideNamesFromTraders": { group: "privacy", type: "boolean", default: true },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;
type DefOf<K extends SettingKey> = (typeof SETTINGS)[K];
export type SettingValue<K extends SettingKey> =
  DefOf<K> extends { type: "number" } ? number : DefOf<K> extends { type: "boolean" } ? boolean : string;

const cache = new Map<string, unknown>();

/** Current value (stored value from the warm cache, else the default). Sync — safe in pure engine code paths. */
export function setting<K extends SettingKey>(key: K): SettingValue<K> {
  const v = cache.get(key);
  return (v === undefined ? SETTINGS[key].default : v) as SettingValue<K>;
}

/** Replace the cache with stored values (the store calls this on warm-up and after saves). Unknown keys are ignored. */
export function __loadSettingsCache(values: Record<string, unknown>): void {
  cache.clear();
  for (const [k, v] of Object.entries(values)) if (k in SETTINGS) cache.set(k, v);
}
