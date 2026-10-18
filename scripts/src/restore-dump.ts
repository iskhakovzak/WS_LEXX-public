// Restore a pg_dump plain-text file (e.g. db_backup_v3.sql) into the local DB without psql.
// Usage: DATABASE_URL=... tsx ./src/restore-dump.ts ../db_backup_v3.sql
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";

const file = process.argv[2];
const dbUrl = process.env.DATABASE_URL;
if (!file || !dbUrl) {
  console.error("Usage: DATABASE_URL=... tsx ./src/restore-dump.ts <dump.sql>");
  process.exit(1);
}

const lines = fs.readFileSync(path.resolve(file), "utf8").split(/\r?\n/);
const client = new pg.Client({ connectionString: dbUrl });
await client.connect();

let sql: string[] = [];
const flush = async () => {
  const text = sql.join("\n").trim();
  sql = [];
  if (text) await client.query(text);
};

let copies = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // psql meta-commands (\restrict, \unrestrict, \connect ...) are not SQL.
  if (line.startsWith("\\")) continue;
  if (/^COPY .* FROM stdin;$/.test(line)) {
    await flush();
    const rows: string[] = [];
    while (lines[++i] !== "\\.") rows.push(lines[i]);
    const data = rows.length ? rows.join("\n") + "\n" : "";
    await pipeline(Readable.from([data]), client.query(copyFrom(line.replace(/;$/, ""))));
    copies++;
    continue;
  }
  sql.push(line);
}
await flush();
await client.end();
console.log(`Restored ${path.basename(file)}: ${copies} tables copied`);
