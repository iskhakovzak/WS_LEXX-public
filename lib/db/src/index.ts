import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool, types } = pg;

types.setTypeParser(20, parseInt);
types.setTypeParser(21, parseInt);
types.setTypeParser(23, parseInt);
types.setTypeParser(26, parseInt);
types.setTypeParser(1700, parseFloat);

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  throw new Error("DATABASE_URL must be set.");
}

const envInt = (name: string, def: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
};

/**
 * Session settings for every connection (ARCHITECTURE.md §2.6, data.md D7):
 *   • TimeZone=UTC — instants are UTC everywhere; the trading day is computed explicitly in America/New_York;
 *   • statement_timeout 30 s (PG_STATEMENT_TIMEOUT_MS) — a runaway query fails with 57014 instead of holding a
 *     connection; migrations and jobs that need longer raise it with SET LOCAL;
 *   • idle_in_transaction_session_timeout 60 s — a forgotten BEGIN can't hold locks forever;
 *   • application_name — visible in pg_stat_activity.
 */
export function poolConfig(connectionString: string, overrides: pg.PoolConfig = {}): pg.PoolConfig {
  return {
    connectionString,
    max: envInt("PG_POOL_MAX", 10),
    application_name: process.env.PG_APPLICATION_NAME || "ws-lexx-api",
    statement_timeout: envInt("PG_STATEMENT_TIMEOUT_MS", 30_000),
    idle_in_transaction_session_timeout: 60_000,
    options: "-c TimeZone=UTC",
    ...overrides,
  };
}

/** A separate pool with the same session settings (CLI tools, tests on scratch databases). */
export function createPool(connectionString: string, overrides: pg.PoolConfig = {}): pg.Pool {
  const p = new Pool(poolConfig(connectionString, overrides));
  p.on("error", (err) => poolErrorHandler(err));
  return p;
}

// An idle client that loses its connection emits "error" on the pool; without a listener Node would crash.
let poolErrorHandler: (err: Error) => void = (err) => {
  process.stderr.write(`[db] idle client error: ${err?.message ?? String(err)}\n`);
};
/** The API replaces the default stderr handler with its logger (index.ts). */
export function setPoolErrorHandler(fn: (err: Error) => void): void {
  poolErrorHandler = fn;
}

export const pool = new Pool(poolConfig(dbUrl));
pool.on("error", (err) => poolErrorHandler(err));
export const db = drizzle(pool, { schema });

export { pg };
export * from "./schema";
