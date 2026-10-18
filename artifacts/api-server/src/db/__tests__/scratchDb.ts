/**
 * Test helper: a throw-away database on the LOCAL Postgres (same server as TEST_DATABASE_URL / the vitest default).
 * `available` is false when the server is down, so suites can `describe.skipIf(!db.available)`.
 */
import { createPool, pg } from "@workspace/db";

const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/edge_tracker";

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export async function pgAvailable(): Promise<boolean> {
  const c = new pg.Client({ connectionString: withDb(base, "postgres"), connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

export async function createScratchDb(tag: string): Promise<{ name: string; url: string; pool: pg.Pool; drop: () => Promise<void> }> {
  const host = new URL(base).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`scratch databases only on a local server, not ${host}`);
  const name = `vitest_${tag}_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: withDb(base, "postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8'`);
  await admin.end();
  const url = withDb(base, name);
  const pool = createPool(url, { max: 5, application_name: "vitest" });
  return {
    name,
    url,
    pool,
    drop: async () => {
      await pool.end().catch(() => undefined);
      const a = new pg.Client({ connectionString: withDb(base, "postgres") });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
