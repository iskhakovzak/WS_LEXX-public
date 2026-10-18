// Vitest setup: tests must never see the production or the dev DB. Modules that import `pool` from @workspace/db
// need DATABASE_URL at import time (the Pool is lazy — nothing connects until a query runs), so point it at a
// dedicated TEST database. SQL tests skip when it is unreachable.
//   - TEST_DATABASE_URL wins (CI sets it); without it the local `edge_tracker_test` DB is used
//     (create it once with `pnpm db:test:create` while `pnpm --filter @workspace/scripts run local-db` is running).
//   - The database name must end in `_test`: a URL pointing at `edge_tracker` (dev) or anything else is refused.
const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/edge_tracker_test";
const testDbName = decodeURIComponent(new URL(TEST_DB_URL).pathname.replace(/^\//, ""));
if (!/_test$/.test(testDbName)) {
  throw new Error(`test-setup: refusing to run tests against database "${testDbName}" — TEST_DATABASE_URL must name a *_test database.`);
}
process.env.DATABASE_URL = TEST_DB_URL;
process.env.NODE_ENV ??= "test";
// lib/auth.ts refuses to load without a secret; config.ts caches the environment on first use.
process.env.JWT_SECRET ??= "vitest-only-secret";
