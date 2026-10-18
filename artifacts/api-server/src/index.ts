import { loadBootConfig, ConfigError } from "./config";
import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "./lib/migrate";
import { reloadLatinNames } from "./lib/people/latinNames";
import { ensureTradeStructureSchema } from "./lib/tradeStructureStore";
import { registerWebhook } from "./lib/telegramBot";
import { telegramWebhookSecret } from "./routes/telegram";
import { pool, setPoolErrorHandler } from "@workspace/db";
import { runMigrationFiles, MigrationError } from "./db/runner";
import { registerAllJobs } from "./jobs/definitions";
import { startJobScheduler, stopJobScheduler } from "./jobs/registry";
import { installCrashHandlers, installGracefulShutdown } from "./lib/security/lifecycle";
import { captureProcessError } from "./lib/errorTracking";

// ─── CONFIG (fail fast) ──────────────────────────────────────────────────────
let bootConfig: ReturnType<typeof loadBootConfig>["config"];
try {
  const { config, warnings } = loadBootConfig();
  bootConfig = config;
  for (const w of warnings) logger.warn(`config: ${w}`);
} catch (err) {
  if (err instanceof ConfigError) {
    logger.fatal({ problems: err.problems }, err.message);
    process.exit(1);
  }
  throw err;
}
setPoolErrorHandler((err) => logger.error({ err }, "db: idle client error"));

// ─── CRASH POLICY (lib/security/lifecycle.ts) ────────────────────────────────
// After an uncaught exception / unhandled rejection the process state is undefined: log, record it in the error
// tracker (bounded wait), exit(1) — Replit restarts the server. Route errors never get here (error middleware).
installCrashHandlers({ logger, capture: captureProcessError });

// ─── PORT VALIDATION ─────────────────────────────────────────────────────────
const rawPort = bootConfig.port == null ? "" : String(bootConfig.port);

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ─── STARTUP ─────────────────────────────────────────────────────────────────
function startBackgroundServices(): void {
  // Every timer lives in the job registry (src/jobs/definitions.ts); nothing starts on module import.
  try {
    registerAllJobs();
    if (bootConfig.jobsEnabled) startJobScheduler();
    else logger.warn("jobs: scheduler disabled (JOBS_ENABLED=false)");
  } catch (err) {
    logger.error({ err }, "jobs: failed to start the scheduler");
  }

  // Register Telegram webhook only in production to avoid dev server stealing the webhook.
  // TELEGRAM_WEBHOOK_URL must be set as an env secret to the stable custom domain
  // (e.g. https://zakit.website/api/telegram/webhook).
  // REPLIT_DOMAINS is NOT used — it contains ephemeral riker.prod.repl.run URLs that
  // change on every deployment and break webhook delivery.
  if (bootConfig.isProduction) {
    const webhookUrl = bootConfig.telegram.webhookUrl;
    if (webhookUrl) {
      registerWebhook(webhookUrl, telegramWebhookSecret()).catch((e: Error) => {
        logger.warn({ error: e.message }, "Failed to register Telegram webhook");
      });
    } else {
      logger.warn("TELEGRAM_WEBHOOK_URL is not set — Telegram webhook NOT registered. Set it to https://zakit.website/api/telegram/webhook");
    }
  } else {
    logger.info("Telegram webhook skipped — development mode (production keeps its webhook)");
  }
}

/**
 * Versioned migrations (src/db/migrations, ARCHITECTURE.md §3.1) run first, under an advisory lock. A failure stops
 * the process in production (the platform keeps the previous deployment); in development it is logged loudly and the
 * server still starts so the error can be inspected.
 */
async function applyVersionedMigrations(): Promise<void> {
  try {
    const r = await runMigrationFiles({ pool, logger, production: bootConfig.isProduction });
    logger.info({ applied: r.applied.map((m) => `${m.version}_${m.name}`), baselined: r.baselined, total: r.total }, "migrations: up to date");
  } catch (err) {
    if (bootConfig.isProduction) {
      logger.fatal({ err, version: err instanceof MigrationError ? err.version : null }, "migrations FAILED — refusing to start");
      process.exit(1);
    }
    logger.error({ err, version: err instanceof MigrationError ? err.version : null }, "!!! migrations FAILED — development server continues on an outdated schema; fix the migration !!!");
  }
}

let migrationsDone = false;
async function startServer(attempt = 1): Promise<void> {
  if (!migrationsDone) {
    migrationsDone = true;
    await applyVersionedMigrations();
    // Legacy boot DDL: kept as a no-op safety net while ensure*() bodies move into numbered migrations (Phase D).
    try {
      await runMigrations();
    } catch (error) {
      logger.error({ err: error }, "legacy runMigrations failed, continuing");
    }
    try {
      await ensureTradeStructureSchema();
    } catch (error) {
      logger.error({ err: error }, "Failed to ensure trade-structure columns, continuing anyway");
    }
    // Latin display names for EN/UZ readers (lib/people/latinNames): warm the table before the first render.
    await reloadLatinNames();
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      logger.info({ port }, "Server listening");
      // SIGTERM / SIGINT: stop accepting, drain in-flight requests, stop jobs, close the pool; hard exit after 10 s.
      installGracefulShutdown(server, {
        logger,
        stopJobs: () => stopJobScheduler(8_000),
        closePool: () => pool.end(),
        timeoutMs: 10_000,
      });
      startBackgroundServices();
      resolve();
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && attempt <= 5) {
        const delay = attempt * 2000;
        logger.warn({ port, attempt, delay }, `Port in use — retrying in ${delay}ms`);
        setTimeout(() => {
          startServer(attempt + 1).then(resolve).catch(reject);
        }, delay);
      } else {
        logger.error({ err, attempt }, "Fatal: could not bind to port");
        // Don't process.exit — let the process manager (Replit) handle the restart.
        reject(err);
      }
    });
  });
}

startServer().catch((err) => {
  logger.fatal({ err }, "Server failed to start");
  process.exit(1);
});
