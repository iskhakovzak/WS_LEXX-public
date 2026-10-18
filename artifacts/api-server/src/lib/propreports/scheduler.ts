/**
 * Optional scheduled sync. OFF unless PROPREPORTS_SYNC_MINUTES (≥ 5) is set together with the API env vars.
 * Scheduled by the job registry ("propreports.sync", src/jobs/definitions.ts) with the cron from syncCron().
 * Pulls the last `lookbackDays` of fills (default 3, so overnight/swing exits are re-matched to their entries)
 * — or further back, to the oldest still-open broker position — and applies them with the normal idempotent engine;
 * overlapping runs are skipped.
 */
import { pool } from "@workspace/db";
import { logger } from "../logger";
import { getConfiguredClient, isConfigured, syncMinutes } from "./client";
import { buildRoundTrips } from "./round-trips";
import { applySync, planSync } from "./sync";
import { nextCronRun, parseCron } from "../../jobs/cron";

let running = false;
let lastError: string | null = null;

/** Cron for an interval in minutes: divisors of 60 → every N minutes; ≥ 60 → every round(N/60) hours. */
export function intervalCron(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.max(1, Math.min(23, Math.round(minutes / 60)));
    return h === 1 ? "0 * * * *" : `0 */${h} * * *`;
  }
  const step = [5, 6, 10, 12, 15, 20, 30].reduce((best, d) => (Math.abs(d - minutes) < Math.abs(best - minutes) ? d : best), 5);
  return `*/${step} * * * *`;
}

/** The registry cron for the scheduled sync, or null when it is off in this environment. */
export function syncCron(): string | null {
  const minutes = syncMinutes();
  return minutes && isConfigured() ? intervalCron(minutes) : null;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Max days a scheduled run reaches back for an open position: one forgotten open trade must not make every run of
 * the whole desk fetch months of fills (older carries are fixed by a manual sync of that range). */
const MAX_CARRY_DAYS = 10;

/** `from`, moved back to the session of the oldest open PropReports trade (at most MAX_CARRY_DAYS ago). */
export async function fetchStartFor(from: Date, now = new Date()): Promise<Date> {
  try {
    const { rows } = await pool.query(
      `SELECT MIN(date)::text AS d FROM trades WHERE source = 'propreports' AND deleted_at IS NULL AND LOWER(COALESCE(result, '')) = 'open'`,
    );
    const d = rows[0]?.d as string | null | undefined;
    if (!d) return from;
    const open = new Date(`${d.slice(0, 10)}T00:00:00Z`);
    const floor = new Date(now.getTime() - MAX_CARRY_DAYS * 86_400_000);
    return open < from ? (open < floor ? floor : open) : from;
  } catch {
    return from;
  }
}

export async function runScheduledSync(lookbackDays = 3): Promise<void> {
  if (running) { logger.warn("propreports: scheduled sync skipped (previous run still active)"); return; }
  const client = await getConfiguredClient();
  if (!client) return;
  running = true;
  try {
    const to = new Date();
    // Reach back to the oldest still-open broker position, so its exits pair with its entries instead of being
    // dropped as orphan fills (an overnight / swing carry older than the lookback).
    const from = await fetchStartFor(new Date(to.getTime() - lookbackDays * 86_400_000));
    const { fills } = await client.fills(ymd(from), ymd(to));
    const { trips } = buildRoundTrips(fills);
    const plan = await planSync(trips);
    const res = await applySync(plan, { actor: "scheduler", source: "api", dateFrom: ymd(from), dateTo: ymd(to), details: { scheduled: true, fills: fills.length } });
    lastError = res.errorText;
    logger.info({ inserted: res.inserted, updated: res.updated, conflicts: res.conflicts, errors: res.errors }, "propreports: scheduled sync done");
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    logger.error({ err: lastError }, "propreports: scheduled sync failed");
  } finally {
    running = false;
  }
}

export function schedulerStatus(): { enabled: boolean; minutes: number | null; nextRunAt: string | null; running: boolean; lastError: string | null } {
  const cron = syncCron();
  const next = cron ? nextCronRun(parseCron(cron), new Date()) : null;
  return { enabled: !!cron, minutes: syncMinutes(), nextRunAt: next ? next.toISOString() : null, running, lastError };
}
