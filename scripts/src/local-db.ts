// Local development Postgres (no install required).
// Data lives in .local-db/ at the repo root (git-ignored).
// Connection: postgresql://postgres:postgres@localhost:5432/edge_tracker
import EmbeddedPostgres from "embedded-postgres";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const dataDir = path.join(root, ".local-db");
const port = Number(process.env.LOCAL_DB_PORT ?? 5432);
const database = "edge_tracker";

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: "postgres",
  port,
  persistent: true,
  // Seed data contains Cyrillic; the Windows default encoding can't store it.
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
});

if (!fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
  await pg.initialise();
}
await pg.start();

const client = pg.getPgClient();
await client.connect();
const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
if (exists.rowCount === 0) await pg.createDatabase(database);
await client.end();

console.log(`Postgres ready: postgresql://postgres:postgres@localhost:${port}/${database}`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
