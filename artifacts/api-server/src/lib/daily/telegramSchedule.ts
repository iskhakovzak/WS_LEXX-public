/**
 * When the daily-loop Telegram sends go out — desk settings (admin → «Настройки деска», group "telegram"), New York
 * time, weekdays. Sync and light: src/jobs/definitions.ts reads these as cron getters on every scheduler tick, so a
 * saved time takes effect from the next minute without a restart; the job page shows the schedule in force.
 *
 *   morning   telegram.morningTime (default 08:45) when telegram.morningEnabled
 *   evening   telegram.eveningTime (default 16:30), never before EVENING_FROM_MIN (16:15: the close + the first
 *             post-close sync), when telegram.eveningEnabled; a PropReports sync after that time also sends
 *   alerts    telegram.contractAlertsEnabled (after each scheduled sync, see telegramJobs)
 *
 * Why a cron getter and not a 5-minute poll: one run per day at the exact minute (no job_runs row every 5 minutes on
 * the admin page), and the notification_dedup claim still makes a manual / repeated run send nothing twice. A time
 * saved after today's minute has passed takes effect tomorrow (a missed morning focus is not sent late).
 */
import { SETTINGS, setting } from "../settings/registry";
import { timeToMinutes } from "../settings/validate";

/** Evening cards from 16:15 NY (the close + the first post-close sync). */
export const EVENING_FROM_MIN = 16 * 60 + 15;

const minutesOf = (v: string, fallback: string): number => timeToMinutes(v) ?? (timeToMinutes(fallback) as number);

/** Minutes after NY midnight of the morning focus send. */
export function morningSendMinutes(): number {
  return minutesOf(setting("telegram.morningTime"), SETTINGS["telegram.morningTime"].default);
}

/** Minutes after NY midnight of the evening cards (the configured time, not before 16:15). */
export function eveningSendMinutes(): number {
  return Math.max(EVENING_FROM_MIN, minutesOf(setting("telegram.eveningTime"), SETTINGS["telegram.eveningTime"].default));
}

/** Weekday cron at a NY minute of the day: 525 → "45 8 * * 1-5". */
export function weekdayCronAt(minutes: number): string {
  const m = Math.min(Math.max(Math.round(minutes), 0), 23 * 60 + 59);
  return `${m % 60} ${Math.floor(m / 60)} * * 1-5`;
}

export const morningCron = (): string => weekdayCronAt(morningSendMinutes());
export const eveningCron = (): string => weekdayCronAt(eveningSendMinutes());

export const morningEnabled = (): boolean => setting("telegram.morningEnabled");
export const eveningEnabled = (): boolean => setting("telegram.eveningEnabled");
export const contractAlertsEnabled = (): boolean => setting("telegram.contractAlertsEnabled");
