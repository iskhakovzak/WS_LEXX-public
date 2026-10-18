/**
 * The ONLY reader of process.env in the API server (ARCHITECTURE.md §2.10). Parsed with zod on first access;
 * index.ts calls `loadBootConfig()` before anything else so a broken environment stops the process with one clear
 * message (production) or a list of warnings (development). Every variable is documented in .env.example.
 *
 *   import { config } from "./config";
 *   config.jwtSecret, config.isProduction, config.propreports.domain …
 *
 * Secrets are never derived from each other in production: MEDIA_TOKEN_SECRET and TELEGRAM_WEBHOOK_SECRET must be
 * set on their own (and differ from JWT_SECRET). In development a missing one is derived from JWT_SECRET with a
 * warning, so a fresh checkout still runs.
 *
 * lib/db (DATABASE_URL) and lib/integrations-anthropic-ai read their own variables in their own packages.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

type Env = Record<string, string | undefined>;

const str = z.string().optional().transform((v) => {
  const t = v?.trim();
  return t ? t : undefined;
});
const int = (def: number, min = 0) =>
  str.transform((v, ctx) => {
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be a number ≥ ${min}` });
      return z.NEVER;
    }
    return n;
  });

const schema = z.object({
  NODE_ENV: str,
  PORT: str,
  LOG_LEVEL: str,
  DATABASE_URL: str,
  PGDATABASE: str,
  // auth & secrets
  JWT_SECRET: str,
  MEDIA_TOKEN_SECRET: str,
  TELEGRAM_WEBHOOK_SECRET: str,
  ADMIN_PASSWORD: str,
  INIT_PASSWORDS: str,
  PLAYBOOK_PASSWORD: str,
  SEED_USERS: str,
  GUEST_MODE: str,
  // http
  REPLIT_DOMAINS: str,
  TRUST_PROXY: str,
  RELEASE_SHA: str,
  REPLIT_DEPLOYMENT_ID: str,
  SITE_URL: str,
  // telegram / email
  TELEGRAM_BOT_TOKEN: str,
  TELEGRAM_BOT_USERNAME: str,
  TELEGRAM_WEBHOOK_URL: str,
  RESEND_API_KEY: str,
  // object storage & backups
  DEFAULT_OBJECT_STORAGE_BUCKET_ID: str,
  PUBLIC_OBJECT_SEARCH_PATHS: str,
  PRIVATE_OBJECT_DIR: str,
  BACKUP_CRON: str,
  // AI
  ANTHROPIC_MODEL: str,
  AI_DAILY_COST_BUDGET_USD: str,
  AI_INTEGRATIONS_OPENAI_BASE_URL: str,
  AI_INTEGRATIONS_OPENAI_API_KEY: str,
  // transcription
  TRANSCRIBE_PROVIDER: str,
  TRANSCRIBE_FALLBACK: str,
  WHISPER_URL: str,
  WHISPER_LANGUAGE: str,
  WHISPER_PROMPT: z.string().optional(), // empty string is meaningful (no prompt)
  // PropReports
  PROPREPORTS_DOMAIN: str,
  PROPREPORTS_TOKEN: str,
  PROPREPORTS_USER: str,
  PROPREPORTS_PASSWORD: str,
  PROPREPORTS_GROUP_ID: str,
  PROPREPORTS_ACCOUNT_IDS: str,
  PROPREPORTS_SYNC_MINUTES: str,
  // database pool / jobs
  PG_STATEMENT_TIMEOUT_MS: int(30_000, 0),
  PG_POOL_MAX: int(10, 1),
  JOBS_ENABLED: str,
});

export type Config = ReturnType<typeof buildConfig>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid server configuration:\n  - ${problems.join("\n  - ")}\nSee artifacts/api-server/.env.example.`);
    this.name = "ConfigError";
  }
}

const derive = (secret: string, purpose: string) => createHash("sha256").update(`${purpose}:${secret}`).digest("hex").slice(0, 48);

function buildConfig(e: z.infer<typeof schema>, warnings: string[]) {
  const nodeEnv = e.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";
  const jwtSecret = e.JWT_SECRET ?? "";
  const mediaTokenSecret = e.MEDIA_TOKEN_SECRET ?? (jwtSecret ? derive(jwtSecret, "media") : "");
  const telegramWebhookSecret = e.TELEGRAM_WEBHOOK_SECRET ?? (jwtSecret ? derive(jwtSecret, "tg").slice(0, 32) : "");
  if (!isProduction) {
    if (!e.MEDIA_TOKEN_SECRET) warnings.push("MEDIA_TOKEN_SECRET is not set — derived from JWT_SECRET (development only)");
    if (!e.TELEGRAM_WEBHOOK_SECRET) warnings.push("TELEGRAM_WEBHOOK_SECRET is not set — derived from JWT_SECRET (development only)");
  }
  const raw = (k: string) => (e as Record<string, unknown>)[k] as string | undefined;
  return {
    nodeEnv,
    isProduction,
    isTest: nodeEnv === "test",
    port: e.PORT ? Number(e.PORT) : null,
    logLevel: e.LOG_LEVEL ?? "info",
    databaseUrl: e.DATABASE_URL ?? null,
    databaseName: e.PGDATABASE ?? null,
    jwtSecret,
    mediaTokenSecret,
    telegramWebhookSecret,
    adminPassword: e.ADMIN_PASSWORD ?? null,
    initPasswords: e.INIT_PASSWORDS ?? null,
    playbookPassword: e.PLAYBOOK_PASSWORD ?? null,
    seedUsers: e.SEED_USERS ?? null,
    guestMode: e.GUEST_MODE,
    replitDomains: (e.REPLIT_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean),
    siteUrl: e.SITE_URL ?? "https://zakit.website",
    /** Raw TRUST_PROXY (lib/security/http.ts trustProxySetting() interprets it). */
    trustProxy: e.TRUST_PROXY,
    /** Build/deploy id for the error tracker. */
    release: (e.RELEASE_SHA ?? e.REPLIT_DEPLOYMENT_ID ?? "").slice(0, 64) || null,
    telegram: {
      botToken: e.TELEGRAM_BOT_TOKEN ?? "",
      botUsername: e.TELEGRAM_BOT_USERNAME ?? "DailyDigest_WS_bot",
      webhookUrl: e.TELEGRAM_WEBHOOK_URL ?? null,
    },
    resendApiKey: e.RESEND_API_KEY ?? null,
    storage: {
      bucketId: e.DEFAULT_OBJECT_STORAGE_BUCKET_ID ?? "",
      publicSearchPaths: e.PUBLIC_OBJECT_SEARCH_PATHS ?? "",
      privateDir: e.PRIVATE_OBJECT_DIR ?? "",
    },
    /** Daily backup schedule, cron in America/New_York (default 03:15). */
    backupCron: e.BACKUP_CRON ?? "15 3 * * *",
    ai: {
      anthropicModel: e.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
      dailyCostBudgetUsd: Number(e.AI_DAILY_COST_BUDGET_USD ?? "5.0"),
      openaiBaseUrl: e.AI_INTEGRATIONS_OPENAI_BASE_URL,
      openaiApiKey: e.AI_INTEGRATIONS_OPENAI_API_KEY ?? "dummy",
    },
    /** Raw transcription variables (lib/transcribe.ts transcribeConfig() interprets them). */
    transcribeEnv: {
      TRANSCRIBE_PROVIDER: e.TRANSCRIBE_PROVIDER,
      TRANSCRIBE_FALLBACK: e.TRANSCRIBE_FALLBACK,
      WHISPER_URL: e.WHISPER_URL,
      WHISPER_LANGUAGE: e.WHISPER_LANGUAGE,
      WHISPER_PROMPT: e.WHISPER_PROMPT,
    } as Record<string, string | undefined>,
    /** Raw PropReports variables (lib/propreports/client.ts readConfig() interprets them). */
    propreportsEnv: (k: string): string => raw(k) ?? "",
    pg: { statementTimeoutMs: e.PG_STATEMENT_TIMEOUT_MS, poolMax: e.PG_POOL_MAX },
    /** JOBS_ENABLED=false keeps the job scheduler off (e.g. a second local process on a shared DB). Default on. */
    jobsEnabled: !["0", "false", "off", "no"].includes((e.JOBS_ENABLED ?? "").toLowerCase()),
  };
}

/** Pure: parse an environment. Throws ConfigError (production problems) — warnings are returned, never thrown. */
export function loadConfig(env: Env): { config: Config; warnings: string[] } {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  const warnings: string[] = [];
  const config = buildConfig(parsed.data, warnings);
  const problems: string[] = [];
  if (!config.jwtSecret) {
    if (config.isProduction) problems.push("JWT_SECRET is required");
    else warnings.push("JWT_SECRET is not set — sign-in will not work (lib/auth.ts refuses to start without it)");
  }
  if (config.isProduction) {
    if (!config.databaseUrl) problems.push("DATABASE_URL is required in production");
    if (!parsed.data.MEDIA_TOKEN_SECRET) problems.push("MEDIA_TOKEN_SECRET is required in production (a separate secret, not derived from JWT_SECRET)");
    if (!parsed.data.TELEGRAM_WEBHOOK_SECRET) problems.push("TELEGRAM_WEBHOOK_SECRET is required in production (a separate secret, not derived from JWT_SECRET)");
    for (const k of ["MEDIA_TOKEN_SECRET", "TELEGRAM_WEBHOOK_SECRET"] as const) {
      if (parsed.data[k] && parsed.data[k] === config.jwtSecret) problems.push(`${k} must differ from JWT_SECRET`);
    }
  }
  if (problems.length) throw new ConfigError(problems);
  return { config, warnings };
}

let cached: Config | null = null;
let cachedWarnings: string[] = [];

/** The parsed config (parsed on first use). */
export function getConfig(): Config {
  if (!cached) {
    const r = loadConfig(process.env);
    cached = r.config;
    cachedWarnings = r.warnings;
  }
  return cached;
}

/** index.ts: parse now (throws ConfigError) and return the development warnings to log. */
export function loadBootConfig(): { config: Config; warnings: string[] } {
  const config = getConfig();
  return { config, warnings: cachedWarnings };
}

/** Tests only: forget the parsed config (the next access re-reads process.env). */
export function resetConfigForTests(): void {
  cached = null;
  cachedWarnings = [];
}

/** Property access parses lazily, so importing modules never fails at import time in tests. */
export const config: Config = new Proxy({} as Config, {
  get: (_t, key) => (getConfig() as Record<string | symbol, unknown>)[key],
});
