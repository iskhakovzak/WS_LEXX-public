/**
 * Read-only data integrity report (docs/research/data.md §6). Prints counts; changes nothing.
 *
 *   pnpm --filter @workspace/scripts exec tsx ./src/db-check.ts            # DATABASE_URL or the local edge_tracker
 *   DATABASE_URL=… pnpm --filter @workspace/scripts exec tsx ./src/db-check.ts --json
 *
 * The session runs with default_transaction_read_only=on, so even a bug here cannot write. Safe against a production
 * read replica / snapshot, but run it there only on purpose (the owner decides).
 * Exit code: 0 always (it is a report); `--strict` exits 1 when a check that must be 0 is not.
 */
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/edge_tracker";
const json = process.argv.includes("--json");
const strict = process.argv.includes("--strict");

type Row = Record<string, unknown>;
type Check = { key: string; label: string; count: number; mustBeZero: boolean; sample?: Row[] };

const PERSON_COLS = /^(trader|user_name|curator|author|author_name|student|mentor|reader|reporter|actor|owner|trader_name|assigned_curator|assigned_risk_manager|assigned_mentor|[a-z_]+_by)$/;
/** user_id is a TEXT name in these tables (data.md §1.4). */
const TEXT_USER_ID_TABLES = new Set(["emotional_state_log", "voice_notes", "weekly_psychology_reports"]);
/** Columns that look like people but hold roles / enums. */
const NOT_PEOPLE = new Set(["academy_action_items.owner"]);
const SENTINELS = new Set(["system", "import-script", "scheduler", "Офис", "∅guest"]);

/** Integer reference columns → parent table (soft-delete column checked when present). */
const ID_TARGETS: Record<string, string> = {
  trade_id: "trades", playbook_id: "playbook", discussion_id: "discussions", trade_idea_id: "trade_ideas", idea_id: "trade_ideas",
  rule_id: "trading_rules", session_id: "war_room_sessions", converted_trade_id: "trades", watchlist_id: "watchlist", event_id: "market_events",
  pattern_id: "research", parent_id: "playbook", daily_feed_id: "daily_feed",
};
/** Self/ambiguous references skipped (parent_id is only playbook→playbook). */
const ID_ONLY_IN: Record<string, string[]> = { parent_id: ["playbook"], session_id: ["war_room_levels"], pattern_id: ["trades"] };

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: url, options: "-c default_transaction_read_only=on -c TimeZone=UTC", application_name: "ws-lexx-db-check" });
  await client.connect();
  const q = async <T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> => (await client.query(sql, params)).rows as T[];
  const n = async (sql: string, params: unknown[] = []) => Number((await q<{ n: string }>(sql, params))[0]?.n ?? 0);
  const exists = async (t: string) => (await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${t}`]))[0]?.ok === true;
  const hasCol = async (t: string, c: string) => (await n(`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [t, c])) > 0;
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // ── 1. people referenced by name ──
  const cols = await q<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.data_type = 'text' ORDER BY 1, 2`);
  const people = cols.filter((c) => (PERSON_COLS.test(c.column_name) || (c.column_name === "user_id" && TEXT_USER_ID_TABLES.has(c.table_name)))
    && !NOT_PEOPLE.has(`${c.table_name}.${c.column_name}`) && c.table_name !== "users");
  const orphanSample: Row[] = [];
  let realOrphans = 0;
  const sentinelCounts = new Map<string, number>();
  for (const c of people) {
    const rows = await q<{ v: string; n: string }>(
      `SELECT x.${ident(c.column_name)} AS v, count(*) AS n FROM ${ident(c.table_name)} x
        WHERE x.${ident(c.column_name)} IS NOT NULL AND x.${ident(c.column_name)} <> ''
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.name = x.${ident(c.column_name)}) GROUP BY 1 ORDER BY 2 DESC`);
    for (const r of rows) {
      const cnt = Number(r.n);
      if (SENTINELS.has(r.v)) sentinelCounts.set(r.v, (sentinelCounts.get(r.v) ?? 0) + cnt);
      else {
        realOrphans += cnt;
        if (orphanSample.length < 25) orphanSample.push({ column: `${c.table_name}.${c.column_name}`, value: r.v, rows: cnt });
      }
    }
  }
  add({ key: "person_orphans", label: `Person columns (${people.length} scanned) with a value not in users.name (sentinels excluded)`, count: realOrphans, mustBeZero: true, sample: orphanSample });
  add({ key: "person_sentinels", label: "Rows with sentinel actors (system, import-script, …)", count: [...sentinelCounts.values()].reduce((a, b) => a + b, 0), mustBeZero: false, sample: [...sentinelCounts].map(([value, rows]) => ({ value, rows })) });

  // ── 2. users ──
  add({ key: "users_ci_dupes", label: "users: case / whitespace duplicate names", count: await n(`SELECT count(*) AS n FROM (SELECT lower(btrim(name)) FROM users GROUP BY 1 HAVING count(*) > 1) d`), mustBeZero: true });
  add({ key: "users_untrimmed", label: "users: names with leading/trailing spaces", count: await n(`SELECT count(*) AS n FROM users WHERE name <> btrim(name)`), mustBeZero: true });

  // ── 3. integer reference orphans ──
  const idCols = await q<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'integer' AND column_name LIKE '%\\_id' ORDER BY 1, 2`);
  const idSample: Row[] = [];
  let idOrphans = 0, softParents = 0;
  for (const c of idCols) {
    const target = ID_TARGETS[c.column_name];
    if (!target || (ID_ONLY_IN[c.column_name] && !ID_ONLY_IN[c.column_name].includes(c.table_name))) continue;
    if (!(await exists(target))) continue;
    const orphans = await n(`SELECT count(*) AS n FROM ${ident(c.table_name)} x WHERE x.${ident(c.column_name)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${ident(target)} p WHERE p.id = x.${ident(c.column_name)})`);
    let soft = 0;
    if (await hasCol(target, "deleted_at")) {
      const childSoft = await hasCol(c.table_name, "deleted_at");
      soft = await n(`SELECT count(*) AS n FROM ${ident(c.table_name)} x JOIN ${ident(target)} p ON p.id = x.${ident(c.column_name)} WHERE p.deleted_at IS NOT NULL${childSoft ? " AND x.deleted_at IS NULL" : ""}`);
    }
    if (orphans || soft) idSample.push({ column: `${c.table_name}.${c.column_name}`, target, orphans, liveRowsOnDeletedParent: soft });
    idOrphans += orphans;
    softParents += soft;
  }
  add({ key: "id_orphans", label: "Integer references to a missing parent row", count: idOrphans, mustBeZero: true, sample: idSample });
  add({ key: "id_soft_parents", label: "Live rows pointing at a soft-deleted parent", count: softParents, mustBeZero: false });

  // ── 4–7. trades ──
  add({ key: "trades_bad_dates", label: "trades: date / exit_date not YYYY-MM-DD", count: await n(`SELECT count(*) AS n FROM trades WHERE date !~ '^\\d{4}-\\d{2}-\\d{2}$' OR (COALESCE(exit_date, '') <> '' AND exit_date !~ '^\\d{4}-\\d{2}-\\d{2}$')`), mustBeZero: true });
  add({ key: "trades_conviction", label: "trades: conviction outside 1–5", count: await n(`SELECT count(*) AS n FROM trades WHERE conviction IS NOT NULL AND (conviction < 1 OR conviction > 5)`), mustBeZero: true });
  add({ key: "trades_grade", label: "trades: confidence_grade outside A+/A/B/C", count: await n(`SELECT count(*) AS n FROM trades WHERE confidence_grade IS NOT NULL AND confidence_grade NOT IN ('A+', 'A', 'B', 'C')`), mustBeZero: true });
  add({ key: "trades_result_codes", label: "trades: result not in win/loss/be/open", count: await n(`SELECT count(*) AS n FROM trades WHERE result IS NULL OR result NOT IN ('win', 'loss', 'be', 'open')`), mustBeZero: true,
    sample: await q(`SELECT result, count(*)::int AS rows FROM trades WHERE result IS NULL OR result NOT IN ('win', 'loss', 'be', 'open') GROUP BY 1 ORDER BY 2 DESC LIMIT 10`) });
  add({ key: "trades_no_executions", label: "trades: live trades without executions", count: await n(`SELECT count(*) AS n FROM trades t WHERE t.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM trade_executions e WHERE e.trade_id = t.id)`), mustBeZero: false });
  add({ key: "trades_natural_dupes", label: "trades: natural-key duplicate groups (trader, ticker, date, side, entry, exit, qty, pnl)", mustBeZero: false,
    count: await n(`SELECT count(*) AS n FROM (SELECT 1 FROM trades WHERE deleted_at IS NULL GROUP BY trader, ticker, date, side, entry, exit, qty, pnl HAVING count(*) > 1) d`) });

  // ── 8. enum drift ──
  add({ key: "watchlist_status", label: "watchlist.status not canonical ('Active' and other casings)", count: await n(`SELECT count(*) AS n FROM watchlist WHERE status <> lower(status) OR lower(btrim(status)) = 'active'`), mustBeZero: true,
    sample: await q(`SELECT status, count(*)::int AS rows FROM watchlist GROUP BY 1 ORDER BY 2 DESC`) });
  add({ key: "trading_errors_resolved", label: "trading_errors.resolved values (TEXT yes/no)", count: await n(`SELECT count(*) AS n FROM trading_errors WHERE resolved NOT IN ('yes', 'no')`), mustBeZero: true,
    sample: await q(`SELECT resolved, count(*)::int AS rows FROM trading_errors GROUP BY 1`) });
  add({ key: "setup_type_sentinel", label: "playbook.setup_type still holding the label 'Другой' (code is 'other')", count: await n(`SELECT count(*) AS n FROM playbook WHERE setup_type = 'Другой'`), mustBeZero: true });

  // ── 9. business-key duplicates ──
  const keys: [string, string][] = [
    ["emotional_state_log", "user_id, date"], ["trader_ratings", "trader, curator, week"], ["weekly_psychology_reports", "user_id, week_start"],
    ["trade_reactions", "trade_id, trader, reaction_type"], ["trade_idea_reactions", "trade_idea_id, trader"], ["trade_reviews", "trade_id, curator"],
  ];
  const keySample: Row[] = [];
  let keyDupes = 0;
  for (const [t, k] of keys) {
    if (!(await exists(t))) continue;
    const d = await n(`SELECT count(*) AS n FROM (SELECT 1 FROM ${ident(t)} GROUP BY ${k} HAVING count(*) > 1) d`);
    if (d) keySample.push({ table: t, key: k, groups: d });
    keyDupes += d;
  }
  add({ key: "business_key_dupes", label: "Business-key duplicate groups (6 keys)", count: keyDupes, mustBeZero: true, sample: keySample });

  // ── 10. PropReports accounts ──
  if (await exists("propreports_accounts")) {
    add({ key: "pr_unmapped", label: "propreports_accounts: active accounts without a trader", count: await n(`SELECT count(*) AS n FROM propreports_accounts WHERE active AND (trader IS NULL OR trader = '')`), mustBeZero: false });
    add({ key: "pr_unknown_user", label: "propreports_accounts: mapped to an unknown user", count: await n(`SELECT count(*) AS n FROM propreports_accounts a WHERE COALESCE(a.trader, '') <> '' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.name = a.trader)`), mustBeZero: true });
  }

  // ── 11. legacy objects, demo data ──
  add({ key: "legacy_playbook_trade_ideas", label: "Legacy table playbook_trade_ideas present", count: (await exists("playbook_trade_ideas")) ? 1 : 0, mustBeZero: true });
  add({ key: "demo_users", label: "Demo users (settings->>'demo' = 'true'; must be 0 in production)", count: (await hasCol("users", "settings")) ? await n(`SELECT count(*) AS n FROM users WHERE settings ->> 'demo' = 'true'`) : 0, mustBeZero: false });
  add({ key: "demo_trades", label: "Demo trades (external_id LIKE 'DEMO|%'; must be 0 in production)", count: await n(`SELECT count(*) AS n FROM trades WHERE external_id LIKE 'DEMO|%'`), mustBeZero: false });
  const migrations = (await exists("schema_migrations")) ? await q(`SELECT version, name, baseline FROM schema_migrations ORDER BY version`) : [];

  await client.end();
  const db = new URL(url);
  if (json) {
    console.log(JSON.stringify({ database: `${db.hostname}/${db.pathname.slice(1)}`, checks, migrations }, null, 2));
  } else {
    console.log(`db-check (read-only) — ${db.hostname}/${db.pathname.slice(1)}`);
    for (const c of checks) {
      const flag = c.count === 0 ? "ok " : c.mustBeZero ? "!! " : "·  ";
      console.log(`${flag}${String(c.count).padStart(7)}  ${c.label}`);
      if (c.count && c.sample?.length) for (const s of c.sample.slice(0, 8)) console.log(`            ${JSON.stringify(s)}`);
    }
    console.log(`schema_migrations: ${migrations.length ? migrations.map((m) => m.version).join(", ") : "(none)"}`);
  }
  if (strict && checks.some((c) => c.mustBeZero && c.count > 0)) process.exit(1);
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

main().catch((err) => {
  console.error("db-check failed:", err instanceof Error ? err.message : err);
  process.exit(2);
});
