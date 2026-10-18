/**
 * When the daily loop may talk to Telegram (light module: jobs/definitions.ts imports it for `enabled`, so it must
 * not pull the DB-backed senders). Same rule as error alerts (lib/errorTracking alertsEnabled): a bot token AND
 * production — a development API never sends, even with a token in its env.
 */
import { config } from "../../config";
import { syncCron } from "../propreports/scheduler";

export function dailyTelegramEnabled(c: { isProduction: boolean; telegram: { botToken: string } } = config): boolean {
  return c.isProduction && !!c.telegram.botToken.trim();
}

/** Intraday contract alerts need fresh trades during the session: the scheduled PropReports sync (PROPREPORTS_SYNC_MINUTES). */
export function intradayAlertsEnabled(): boolean {
  return dailyTelegramEnabled() && syncCron() != null;
}
