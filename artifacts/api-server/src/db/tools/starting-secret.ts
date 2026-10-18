/**
 * Give accounts a starting secret they must replace on their next sign-in (owner decision 2026-10-18).
 * Run from artifacts/api-server:
 *
 *   node scripts/run-ts.mjs src/db/tools/starting-secret.ts --secret 000000 --all --confirm
 *   node scripts/run-ts.mjs src/db/tools/starting-secret.ts --secret 000000 --ids 121,130 --confirm
 *
 * Sets password_hash, must_change_secret = true and ends open sessions (token_version + 1). Staff minimums do not apply
 * here: the secret only opens the «set your own» step. Sign-in is by name, so a shared starting secret lets anyone who
 * knows a name claim that account first: hand it out only when people sign in right away. Uses DATABASE_URL; refuses a
 * non-local host unless --allow-remote. The secret is never printed.
 */
import bcrypt from "bcryptjs";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const url = process.env.DATABASE_URL;
const secret = opt("--secret");
const ids = opt("--ids")?.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0) ?? [];

if (!url || !secret || (!flag("--all") && ids.length === 0) || !flag("--confirm")) {
  console.error("usage: DATABASE_URL=… node scripts/run-ts.mjs src/db/tools/starting-secret.ts --secret <s> (--all | --ids 1,2) --confirm [--allow-remote]");
  process.exit(2);
}
const host = new URL(url).hostname;
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) && !flag("--allow-remote")) {
  console.error(`starting-secret: refusing non-local database host "${host}" (pass --allow-remote on purpose)`);
  process.exit(2);
}

const { pool: client } = await import("@workspace/db"); // reads DATABASE_URL at import time
try {
  const hash = await bcrypt.hash(secret, 10);
  const { rows } = await client.query<{ id: number; name: string }>(
    `UPDATE users SET password_hash = $1, must_change_secret = true, token_version = token_version + 1
      WHERE active = true AND ($2::boolean OR id = ANY($3::int[]))
      RETURNING id, name`,
    [hash, flag("--all"), ids],
  );
  await client.query(
    `INSERT INTO audit_log (actor, action, target_type, target_id, details) VALUES ('system', 'user.starting_secret', 'user', $1, $2)`,
    [rows.length === 1 ? String(rows[0].id) : "many", JSON.stringify({ count: rows.length, ids: rows.map((r: { id: number }) => r.id) })],
  ).catch(() => { /* audit table missing on a bare database */ });
  process.stdout.write(`starting-secret: ${rows.length} account(s) updated; each must set its own secret on the next sign-in\n`);
} finally {
  await client.end();
}
