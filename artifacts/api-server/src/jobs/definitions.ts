/**
 * Every background job of the API, in one list. `registerAllJobs()` is called by index.ts (and the admin route reads
 * the registry). Importing this module registers nothing and starts nothing. Cron is New York wall-clock time.
 *
 * Former timers (backend.md §1.9) → jobs:
 *   sector poller (boot + 15 min, weekdays 9–16 NY) → market.sectors
 *   analyst-actions poller (30 s after boot + 20 min) → market.analyst-actions
 *   digest 09:00 / 18:00 UTC (60 s tick)             → digest.morning 05:00 NY / digest.evening 14:00 NY (same instants in EDT)
 *   weekly psychology report (Fri ≥ 17:00 server-local) → psychology.weekly-report Fri 17:00 NY
 *   daily quote (15 s after boot + 06:00 MSK)          → quotes.daily 23:00 NY (≈ 06:00 MSK) + 15 s after boot
 *   DB backup (3 min after EVERY boot + 48 h)          → db.backup daily BACKUP_CRON (03:15 NY) + catch-up only if > 20 h old
 *   academy challenges (60 s after boot + 15 min)      → academy.challenges
 *   «готов к переводу» notices (were sent by GET)      → academy.readiness (15 min + after each PropReports sync)
 *   PropReports scheduled sync (module-level timer)    → propreports.sync (PROPREPORTS_SYNC_MINUTES → cron)
 *   trade-structure back-fill (once at boot)           → trades.structure-backfill
 *   (new) job_runs retention                           → jobs.prune daily
 */
import { pool } from "@workspace/db";
import { config } from "../config";
import { registerJob, listJobs } from "./registry";
import { syncCron } from "../lib/propreports/scheduler";
import { dailyTelegramEnabled, intradayAlertsEnabled } from "../lib/daily/telegramGuard";

const MIN = 60_000;
let registered = false;

export function registerAllJobs(): void {
  if (registered || listJobs().length) return;
  registered = true;

  registerJob({
    name: "market.sectors",
    cron: "*/15 9-16 * * 1-5",
    runOnStartMs: 0,
    timeoutMs: 5 * MIN,
    async run({ trigger }) {
      const { runSectorRefresh } = await import("../lib/marketDataService");
      if (trigger === "startup") {
        const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date());
        const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date())) % 24;
        if (wd === "Sat" || wd === "Sun" || hour < 9 || hour > 16) return { skipped: "outside market hours" };
      }
      return runSectorRefresh();
    },
  });

  registerJob({
    name: "market.analyst-actions",
    cron: "*/20 * * * *",
    runOnStartMs: 30_000,
    timeoutMs: 18 * MIN,
    async run() {
      const { runAnalystActionsScan } = await import("../lib/marketDataService");
      return runAnalystActionsScan();
    },
  });

  registerJob({
    name: "digest.morning",
    cron: "0 5 * * *",
    timeoutMs: 10 * MIN,
    async run() {
      const { runDigestIfNeeded } = await import("../lib/digest");
      await runDigestIfNeeded("morning");
      return { period: "morning" };
    },
  });

  registerJob({
    name: "digest.evening",
    cron: "0 14 * * *",
    timeoutMs: 10 * MIN,
    async run() {
      const { runDigestIfNeeded } = await import("../lib/digest");
      await runDigestIfNeeded("evening");
      return { period: "evening" };
    },
  });

  // Daily loop in the Telegram bot (lib/daily/telegramJobs.ts): production + bot token only; every send once per
  // trader and day (notification_dedup). Morning 08:45 NY = premarket, 45 min before the open, the previous day synced.
  registerJob({
    name: "telegram.daily-morning",
    cron: "45 8 * * 1-5",
    timeoutMs: 10 * MIN,
    enabled: dailyTelegramEnabled,
    async run({ signal }) {
      const { runMorningFocus } = await import("../lib/daily/telegramJobs");
      return runMorningFocus({ signal });
    },
  });

  // Evening card: 16:30 NY (the session's trades are in after the post-close sync) + every PropReports sync after
  // 16:15 NY, so a later / manual sync sends the cards it unlocks; a trader without trades that day gets none.
  registerJob({
    name: "telegram.daily-evening",
    cron: "30 16 * * 1-5",
    on: ["propreports.synced"],
    timeoutMs: 10 * MIN,
    enabled: dailyTelegramEnabled,
    async run({ signal }) {
      const { runEveningCards } = await import("../lib/daily/telegramJobs");
      return runEveningCards({ signal });
    },
  });

  // Intraday own-contract alerts (daily stop / max trades): only with the scheduled PropReports sync, after each sync.
  registerJob({
    name: "telegram.contract-alerts",
    on: ["propreports.synced"],
    timeoutMs: 5 * MIN,
    enabled: intradayAlertsEnabled,
    async run({ signal }) {
      const { runContractAlerts } = await import("../lib/daily/telegramJobs");
      return runContractAlerts({ signal });
    },
  });

  registerJob({
    name: "psychology.weekly-report",
    cron: "0 17 * * 5",
    timeoutMs: 30 * MIN,
    async run() {
      const { runWeeklyReports } = await import("../lib/weeklyPsychologyReport");
      return runWeeklyReports();
    },
  });

  registerJob({
    name: "quotes.daily",
    cron: "0 23 * * *",
    runOnStartMs: 15_000,
    timeoutMs: 5 * MIN,
    async run({ trigger }) {
      const { ensureTodayQuote } = await import("../lib/dailyQuoteCron");
      return ensureTodayQuote(trigger === "startup" ? "startup" : "23:00 NY");
    },
  });

  registerJob({
    name: "db.backup",
    cron: config.backupCron,
    runOnStartMs: 5 * MIN,
    timeoutMs: 60 * MIN,
    enabled: () => !!config.storage.bucketId,
    async run({ trigger }) {
      const { backupJob } = await import("../lib/dbBackupCron");
      return backupJob(trigger);
    },
  });

  registerJob({
    name: "academy.challenges",
    cron: "*/15 * * * *",
    runOnStartMs: 60_000,
    timeoutMs: 10 * MIN,
    async run() {
      const { refreshChallenges } = await import("../routes/academy-path");
      return refreshChallenges();
    },
  });

  registerJob({
    name: "academy.readiness",
    cron: "7-59/15 * * * *",
    on: ["propreports.synced"],
    timeoutMs: 10 * MIN,
    async run({ trigger, payload }) {
      const { refreshReadinessNotices } = await import("../routes/academy-path");
      const traders = trigger === "event" ? ((payload as { traders?: string[] } | undefined)?.traders ?? []) : null;
      if (traders && traders.length === 0) return { skipped: "no changed traders" };
      return refreshReadinessNotices(traders);
    },
  });

  registerJob({
    name: "propreports.sync",
    cron: syncCron() ?? undefined,
    timeoutMs: 15 * MIN,
    enabled: () => syncCron() != null,
    async run() {
      const { runScheduledSync } = await import("../lib/propreports");
      await runScheduledSync();
      return {};
    },
  });

  registerJob({
    name: "trades.structure-backfill",
    runOnStartMs: 0,
    timeoutMs: 30 * MIN,
    async run() {
      const { backfillTradeStructures } = await import("../lib/tradeStructureStore");
      return backfillTradeStructures();
    },
  });

  registerJob({
    name: "jobs.prune",
    cron: "40 3 * * *",
    timeoutMs: 5 * MIN,
    async run() {
      const r = await pool.query(`DELETE FROM job_runs WHERE started_at < now() - interval '30 days'`);
      return { deleted: r.rowCount ?? 0 };
    },
  });

  // Permanent candle archive (lib/candleArchive): every finished symbol-day with trades / playbook examples / ideas /
  // simulator games, once for the whole desk. After each PropReports sync, nightly after the post-market (21:15 NY,
  // every day so weekends finish a backfill), and 2 min after boot. ≤ 400 provider calls per run; the next run resumes.
  registerJob({
    name: "candles.archive",
    cron: "15 21 * * *",
    on: ["propreports.synced"],
    runOnStartMs: 2 * MIN,
    timeoutMs: 30 * MIN,
    async run({ signal, logger }) {
      const { runArchiveFill } = await import("../lib/candleArchive");
      return runArchiveFill({ signal, logger, budget: 400, gapMs: 400 });
    },
  });

  registerJob({
    name: "candles.prune",
    cron: "50 3 * * *",
    timeoutMs: 10 * MIN,
    async run({ signal }) {
      const { pruneCandleCaches } = await import("../lib/candleArchive/prune");
      return pruneCandleCaches({ signal });
    },
  });

}
