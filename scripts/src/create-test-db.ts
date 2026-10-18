// Creates the local TEST database used by the API tests (artifacts/api-server/src/test-setup.ts refuses any
// database whose name does not end in `_test`, so tests never touch the dev DB `edge_tracker`).
//   1. start local Postgres:  pnpm --filter @workspace/scripts run local-db
//   2. once:                  pnpm db:test:create
// Override the server with ADMIN_DATABASE_URL (any DB on the same server) and the name with TEST_DB_NAME.
import pg from "pg";

const adminUrl = process.env.ADMIN_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres";
const name = process.env.TEST_DB_NAME ?? "edge_tracker_test";
if (!/^[a-z0-9_]+_test$/.test(name)) throw new Error(`TEST_DB_NAME must be [a-z0-9_]+ and end in _test, got "${name}"`);

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (rowCount) {
    console.log(`${name} already exists`);
  } else {
    await client.query(`CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0`);
    console.log(`created ${name}`);
  }
} finally {
  await client.end();
}
const u = new URL(adminUrl);
u.pathname = `/${name}`;
console.log(`TEST_DATABASE_URL=${u.toString().replace(/\/\/([^:]+):[^@]*@/, "//$1:***@")}`);
