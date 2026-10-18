# Architecture research: data model & database

Scope: Postgres schema, migrations, identity model, integrity, indexes, time/money/JSON conventions, audit, backups, seed/demo data.
Method: read-only queries on the local DB `edge_tracker` (PG 16.14, run with `default_transaction_read_only=on`), a static scan of `artifacts/api-server/src`, `lib/db`, `scripts/src`, and the drizzle schema loaded through `getTableConfig` and compared with `information_schema`/`pg_catalog`. Work files are in `scratchpad/arch/data_work/`: `tables.tsv`, `columns.tsv`, `constraints.tsv`, `indexes.tsv`, `drizzle.json`, `orphans.tsv`, `idorph.tsv`, `cmp.cjs`, `explain.mts`.

**Caveat on the local DB.** It is about 98% demo data: 22 of 30 users have `settings->>'demo'='true'`, and 44,295 of 45,297 trades have `external_id LIKE 'DEMO|%'`, from `scripts/src/seed-demo.ts`. `pg_stat_*` has never been reset, so index usage reflects dev and test traffic, not production. Run the integrity SQL in §6 against production (read-only) before acting on any count.

---

## 1. Current state map

### 1.1 Size and shape
| | |
|---|---|
| DB size | 335 MB; 124 tables; 0 views; 0 triggers; extensions: only `plpgsql` (`pg_stat_statements`, `pg_trgm`, `citext` are available but not installed) |
| Biggest tables | `trades` 149 MB (45,297 rows, about 2.5 KB per row: `structure` jsonb averages 775 B and `context_snapshot` 607 B); `candles_cache` 70 MB (37 MB TOAST); `analyst_actions_cache` 46 MB (110,795 rows); `trade_executions` 31 MB (101,044 rows); `analyst_bars_cache` 6.5 MB. Everything else is under 3.3 MB |
| Cache tables | `candles_cache`, `analyst_actions_cache`, `analyst_bars_cache`, `news_cache`, `ticker_data_cache`, `sector_strength_cache`, `market_open_brief_cache`, `offering_ticker_cache` take about 124 MB (37% of the DB) and have **no retention or pruning** |
| Column types (1,354 columns) | 656 text, 237 timestamptz (0 `timestamp without tz`, good), 233 integer, 62 jsonb, 50 boolean, 16 date, 81 numeric (5 unbounded), 6 smallint, 8 arrays, 1 bytea (`playbook_media.bytes`) |
| Keys | 124 PKs (every table has one, all `SERIAL` int4); **26 FKs** (0 point to `users`); **2 CHECKs** (`trade_executions.kind`, `playbook_examples.tier`); 23 UNIQUE constraints plus unique indexes; 304 indexes |
| Access code | `pool.query`/`client.query` called about 1,322 times across 73 files; drizzle query builder about 145 times in 21 files; 20 explicit transactions (`pool.connect` + `BEGIN`) |

### 1.2 How the schema gets created (three uncoordinated mechanisms)
1. **`artifacts/api-server/src/lib/migrate.ts`** (1,396 lines, 63 commits) runs on every boot from `index.ts:90`, before `listen`. It contains 60 `CREATE TABLE IF NOT EXISTS`, 103 `addColumns` entries plus 34 more inline `ADD COLUMN`s, 57 `CREATE INDEX`, one `DO $$` type widening, and 14 data `UPDATE`/`INSERT`s: seed users with random PINs, 20 SMB playbook strategies with tags, a 6-item checklist, the **2026-only** holiday/FOMC/CPI calendar, the rename `UPDATE users SET name='Ориф' WHERE name='Ариф'`, a one-off "restore playbook rows deleted 2026-04-22 17:35–17:40", a legacy PropReports pnl repair, and the merge of the legacy `playbook_trade_ideas` table. Errors are logged and **swallowed**, either per statement or by 35 `.catch(() => {})`. If the whole step throws, `index.ts` logs "continuing anyway".
2. **About 44 lazy `ensure*()` functions in 34 other files** (210 DDL statements outside migrate.ts; 366 repo-wide). 19 of them run **at module import** (`ensureTables().catch(...)` at top level in `routes/{dailyfeed,discussions,eod,events,gameplan,playbook,ratings,research,scaling,setups-auto,trade-quality,tradeideas,trades,users,weekly-review,indicator-notes,permissions}.ts`, `lib/{notifyUtils,rulesEngine}.ts`). That is, they run concurrently with each other and with `runMigrations()`. The rest run on the first request to a route. **About 64 of the 124 tables exist only because some route was hit** (all `academy_*`, `scaling_*`, `eod_*`, `journal_days`, `game_plans`, `trade_quality`, …).
3. **`lib/db` (drizzle)** models 43 tables. The `push`/`push-force` scripts are still in `lib/db/package.json`. `replit.md`, `README.md` and `scripts/post-merge.sh` all say never to use them.

### 1.3 Drift: drizzle model vs the real DB (from `cmp.cjs`)
- **81 of 124 tables are not modelled**, including `users`, every `academy_*`, `eod_*`, `journal_days`, every `propreports_*`, `notifications`, `trader_risk_limits`, `trade_quality`.
- **83 columns exist in the DB but not in the model**, among them `trades.structure` and `trades.reentry_of`, about 30 `playbook` columns (`space`, `visibility`, `shared_with`, `*_text` …), 11 `rule_violations` columns, `discussions.audience`, `watchlist.in_play`, and `trade_executions.role`/`leg_index`/`order_id`.
- **16 objects are declared in drizzle but missing from the DB**:
  - CHECKs `trades_conviction_range` and `trades_confidence_grade_enum`. The model claims integrity the DB doesn't enforce.
  - 14 indexes, among them `emotional_state_log_user_date_idx`. That table has 1,602 seq scans against 1 index scan.
- The reverse also exists: drizzle-only index names such as `events_date_idx` and `comments_trader_idx` came from an old `drizzle-kit push` and now duplicate indexes created by migrate.ts.
- No type or nullability drift on the columns both sides know about.
- `drizzle-zod` insert schemas (`insertTradeSchema` …) are **unused** anywhere.
- **Footgun:** `pnpm --filter @workspace/db push` would diff 43 tables against 124 and offer to **drop 81 tables and 83 columns**.

### 1.4 Identity: people are referenced by name text
- `users.name TEXT UNIQUE` is the de facto key. The JWT carries `{sub:id, name, role, tv}`, and `authMiddleware` trusts `decoded.name` (`lib/auth.ts:153`). The code reads `authUser.name` 77 times and `authUser.id` 6 times.
- **About 152 person-valued columns in 101 tables**: `trader` (43 tables), `user_name`, `user_id` *(TEXT name: `emotional_state_log`, `voice_notes`, `weekly_psychology_reports`)*, `curator`, `author`, `author_name`, `student`, `mentor`, `reader`, `reporter`, `actor`, `owner`, `trader_name`, about 45 `*_by` columns, `users.assigned_curator`/`assigned_risk_manager`/`assigned_mentor`, `propreports_accounts.trader`, plus non-FK-able containers: `discussions.audience TEXT[]`, `playbook.shared_with JSONB`, and @mentions inside text. Full list: `data_work/personcols.txt`.
- About 778 SQL predicates compare on these columns (`trader = $1` …); 188 frontend files read `.trader`.
- The new `users.name_latin` alias (`lib/peopleDirectory.ts`) is search-only, not unique, and **not in migrate.ts** despite its docstring. It is created lazily and absent from the local DB.
- Local orphan scan (`orphans.tsv`): 111 columns hold data. The only non-user values are the sentinels `system` (75 rows), `import-script` (3), `Офис` (1), plus the guest sentinel `∅` in code. `academy_action_items.owner` is a role enum, not a name. There are no case or whitespace near-duplicates today.

### 1.5 Other conventions observed
- **Soft delete is mixed.** `deleted_at` on 15 tables, `archived_at` on 22, `active` on 4; hard `DELETE` in about 32 raw SQL sites plus drizzle `db.delete` (comments, reactions, reviews, journal_days, author_notes, junior_notes, rule_violations, trader_ratings …). `FROM trades` appears 173 times. Filtering on `deleted_at IS NULL` is by convention; about 18 sites don't show the filter in the same literal, mostly legitimately (by-id lookups, composed WHERE), but nothing enforces it.
- **Time.**
  - Instants are timestamptz everywhere (good).
  - Trading-day columns are **TEXT `YYYY-MM-DD`** in about 30 places (`trades.date`/`exit_date`, `eod_days.date`, `game_plans.date`, …), but **DATE** in 16 others (`journal_days.day`, `junior_notes.note_date`, academy).
  - "Week" has **three encodings**: `trader_ratings.week` is a Monday `YYYY-MM-DD` text, `weekly_reviews.week` is ISO `2026-W31` text with a separate `week_start DATE`, and `weekly_psychology_reports.week_start`/`week_end` are TEXT.
  - Code discipline is good: `lib/tradingDate.ts` nyDate, and 23 `AT TIME ZONE 'America/New_York'`. Remaining leaks are 3 `DEFAULT CURRENT_DATE` (author_notes, junior_notes, academy_enrollments.joined_on) and `telegram.ts:434,489` `published_at::date = CURRENT_DATE`. These depend on the **session TimeZone, which is `Asia/Tashkent` locally**; production is likely UTC, so they behave differently per environment and neither matches NY.
  - Trade open/close times live **only inside JSON** as NY-local naive strings (`context_snapshot->>'openedAt'` = `"2026-10-16T09:30:00"`, used in 16 SQL sites, parsed with regexes such as `lib/ideaTradeMatch.ts:112`). `trade_executions.executed_at` is a proper timestamptz.
- **Money.**
  - `trades.pnl` and `fees` are `numeric(14,4)` (widened after the "Ориф −$0.25" audit), `risk_usd` is (12,2), prices are (12,4), `qty` is (14,2).
  - Elsewhere it is inconsistent: `weekly_psychology_reports.total_pnl`/`avg_pnl_per_trade`/`win_rate` are **TEXT**, `trade_ideas.entry_zone`/`target`/`stop` are TEXT, `market_cap`/`float`/`adv` are TEXT ("652 M "), and 5 columns are unbounded `numeric`.
  - `lib/db/src/index.ts` registers `types.setTypeParser(1700, parseFloat)` globally, so all numerics reach JS as floats (fine at this scale; drizzle's `numeric` TS type says string, which is a lie).
- **Canonical values are normalised at read time.** `trades.result` is free text; `lib/tradeMath.ts` applies `TRANSLATE(LOWER(TRIM(result)))` and Russian synonyms (`прибыль`, `убыток`, `бу` …) on every row of every aggregate. Stored values today: win, loss, and `breakeven`×8 (canonical is `be`). `watchlist.status` holds both `watching` and `Active`. `trading_errors.resolved` is TEXT `'yes'/'no'`. `playbook.setup_type = 'Другой'` is a Russian sentinel compared in code (3 server and 2 frontend sites).
- **JSON.**
  - 62 jsonb columns. Mostly documents (plans, reviews, quiz answers, snapshots); reasonable.
  - Hot spots: `trades.context_snapshot` duplicates real columns (`qty`, `gross`=pnl, `totalFees`=fees, `externalId`, `account`=broker_account) and holds the only copy of `openedAt`/`closedAt`.
  - JSON stored as **TEXT**: `audit_log.details`, `activity_log.details`, `pre_trade_checklist_responses.responses`, `*.screenshot_notes` (`'[""]'`), `score_breakdown`.
  - `tags` is comma-separated TEXT in 9 tables.
- **Audit.**
  - `audit_log` (actor TEXT, target_id TEXT, details TEXT JSON, 59 call sites) and `activity_log` (58 call sites). Writes are best-effort, outside the business transaction (`lib/audit.ts` swallows errors).
  - Domain history tables exist and are good: `trader_risk_limit_events` (before/after jsonb), `scaling_history`, `academy_stage_history`, `academy_enrollment_history`, `playbook_revisions`, `trading_errors_archive`.
  - **`routes/users.ts` writes no audit at all** for create, update, password or role changes. `admin-console.ts` does.
- **Connection.** One `new Pool({connectionString})` with defaults: max 10, no `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` or `application_name`, and no explicit session TimeZone.
- **Backups** (`lib/dbBackupCron.ts`).
  - `pg_dump --format=plain | gzip` is **buffered entirely in memory**, then uploaded to Replit Object Storage. Interval 48 h, last 10 kept. **Every process start triggers a backup 3 minutes later**, because `lastBackupAt` lives in memory, so a deploy-heavy day pushes the 10-slot window down to hours.
  - Cache tables are included.
  - No restore drill, and no check that the `pg_dump` major version is ≥ the server's. Replit production DBs are PG 16 **or 17** on Neon; a 16 `pg_dump` against a 17 server fails. Replit also offers point-in-time restore (7 days on Core, 28 on Pro/Teams). Restore today means manual `psql < dump` (DEPLOY.md) or `scripts/src/restore-dump.ts`.
- **Seed/demo.**
  - Demo data shares the dev DB, marked as above. `seed-demo.ts` refuses non-localhost and production (good) and has `--unseed`.
  - Production-relevant seeds (users, strategies, checklist, calendar) live inside migrate.ts and re-run on every boot.
  - `artifacts/api-server/src/lib/seed-sync.sql` (1,416 lines) is unused and starts with `DELETE FROM "trades"; DELETE FROM "playbook"; …`, a loaded gun in `src/`.

### 1.6 Query and index review
EXPLAIN (ANALYZE, BUFFERS) on representative queries (`explain.mts`):

| Query | Exec | Plan |
|---|---|---|
| Office stats `loadTrades` (`routes/officeStats.ts:110`, year 2026, 24k rows) | **233 ms**, 107k shared buffers (≈850 MB logical reads) | Parallel seq scan on trades plus 24,450 lateral index probes into `trade_executions`. Cached 1 min in-process |
| Dashboard "today", all desk (`routes/dashboard.ts:171`) | 39 ms | Seq scan: `COALESCE(NULLIF(exit_date,''),date)=$2` plus TRANSLATE(result) is not indexable |
| Dashboard "today", one trader | 3.3 ms | Bitmap on `trades_trader_idx` (5,373 rows) then filter |
| Trades page keyset (`lib/tradesPageQuery.ts`) | 0.2 ms | Index-only scan `trades_live_trader_date_id_idx`. Good |
| `openedAt` window | 2.2 ms | Filter over JSON after the trader bitmap |
| `emotional_state_log` by user | 0.4 ms | Seq scan; the drizzle-declared index was never created |
| analyst actions by ticker, candles by key | ≤1.5 ms | Unique indexes used |

Performance is fine at 45k trades. The cost driver is the 2.5 KB rows and per-row expression evaluation, not missing indexes.

**Redundant indexes** (a non-unique index that is a prefix of another with the same predicate; `dupidx.sql`), 15 in total:
- `trades_trader_idx`, covered by `trades_chain_idx` (trader, ticker, date)
- `analyst_actions_ticker_idx` (1.7 MB), covered by `analyst_actions_unique`
- `candles_cache_ticker_idx`
- `rule_violations_rule_idx`
- `junior_notes_trader_date_idx` and `author_notes_trader_date_idx`, which exactly duplicate their UNIQUE constraints
- `market_events_date_idx` and `events_date_idx`, two identical indexes (drizzle and migrate)
- `holiday_calendar_date_idx`, `news_cache_ticker_idx`, `weekly_psych_reports_user_idx`, `big7_tickers_group_idx`, `discussion_votes_discussion_idx`, `trade_setup_suggestions_trade_idx`, `playbook_checklist_marks_playbook_idx`

Also, 5 of the 15 `trades` indexes are near-overlapping: `trades_date_idx` vs `trades_live_date_id_idx`, and `trades_ticker_idx` vs `trades_live_ticker_date_idx`. Not urgent; check production `idx_scan` first.

**Unused**: `trades_event_id_idx` (1 MB, 0 scans; `event_id` is NULL on 45,205 of 45,297 rows) and about 30 tiny indexes on low-traffic tables. Ignore the tiny ones.

**Missing**:
- `emotional_state_log(user_id, date)`
- an expression or generated-column index for close date plus result when the desk-wide "today/week" aggregates grow
- `trade_quality.trade_id` has no FK (41 orphan rows)

---

## 2. Problems ranked by impact

### Correctness and security
1. **Renaming a user silently forks their identity.** `PATCH /api/users/:id` accepts `name` (`routes/users.ts:373`). It updates only `users.name`: none of the about 152 name columns, no `bumpTokenVersion` (that happens only for password/role/active changes), and no audit. After a rename, all history (45k trades, journal, academy, PropReports mapping, permissions scope via `assigned_curator`) points to the old name. The user's still-valid JWT keeps writing rows under the old name, and new tokens write under the new one. The current UI doesn't send `name`, so this is a latent API footgun, but the in-flight Latin-alias work invites "just fix the name" requests. The boot-time `UPDATE users SET name='Ориф' WHERE name='Ариф'` is exactly such a rename, repeated forever and touching only `users`.
2. **Destructive tooling within one command.** `lib/db` `push`/`push-force` would drop 81 tables. `seed-sync.sql` deletes every trade and playbook row if anyone runs it.
3. **Schema errors are swallowed, so boot "succeeds" on a broken schema.** Live evidence: on every boot, `Migration: merge playbook_trade_ideas → trade_ideas` fails with `column "market_cap" does not exist` (3 times in `scratchpad/api8092.log`). The legacy table persists and the warning is ignored. Any similar failure on a real column means 500s at runtime, not a failed deploy.
4. **Boot DDL races and takes heavy locks.** 19 `ensure*` functions run DDL at import time, concurrently with migrate.ts. On a fresh DB that gives order-dependent failures (indexes on `trades` before `trades` exists; `notifications` is created in two places), and concurrent `CREATE TABLE IF NOT EXISTS` on the same name can fail with a `pg_type` unique violation. Every `ALTER TABLE … ADD COLUMN IF NOT EXISTS` requests an ACCESS EXCLUSIVE lock **before** the existence check (PG lock level for the ADD COLUMN subform; see the [ALTER TABLE docs](https://www.postgresql.org/docs/16/static/sql-altertable.html)). Without `lock_timeout`, one long query on `trades`/`users`/`playbook` during a deploy queues **all** traffic behind the ALTER. Request-time `ensure*` repeats this the first time each route is hit after a restart.

### Data integrity
5. **Almost no referential integrity.** 0 FKs to `users`. 45 of 71 integer `*_id` reference columns have no FK. Local orphans: `trade_quality.trade_id` ×41; rows pointing at soft-deleted parents: `playbook_examples` 2, `playbook_revisions` 2, `trades.playbook_id` 1, `trade_reactions` 1.
6. **Enums are unconstrained free text.** `trades.result` (and its Russian synonyms) is normalised per row at read time. `watchlist.status` has `watching`/`Active`; `trading_errors.resolved` is `'yes'/'no'` TEXT; `users.role` is unchecked. Drizzle declares two trades CHECKs that don't exist in the DB.
7. **Business uniqueness is enforced only in the app.** These are logically unique but have no DB constraint: `emotional_state_log(user_id,date)`, `trader_ratings(trader,curator,week)`, `weekly_psychology_reports(user_id,week_start)`, `trade_reactions(trade_id,trader,reaction_type)`, `trade_idea_reactions(trade_idea_id,trader)`, `trade_reviews(trade_id,curator)`. Clean locally, but racy. `users.name` is unique only case- and space-sensitively (`'закир'` can coexist with `'Закир'`).
8. **Time semantics are split.** Trade open/close instants exist only as naive JSON strings; trading days are TEXT in some places and DATE in others; three week encodings; 5 SQL sites depend on the session TZ, which differs between local (Tashkent) and production.
9. **Data is mutated by boot code.** Rename, restore window, pnl repair and re-tagging of seeded strategies are one-offs that keep running and can fight user edits (for example, re-tagging seeded strategies whose tags are empty).
10. **Backup gaps.** In-memory buffering, restart-triggered dumps compressing the retention window, no restore test, no pg_dump/server version check, and 124 MB of re-fetchable cache inside every dump.

### Maintainability
11. **There is no single source of truth for the schema.** Docs say migrate.ts, but 64 tables live elsewhere; drizzle models a stale third of it; nothing records which changes were applied. Reviewing "what does `playbook` look like" means grepping six files.
12. **The ORM is used half-way.** Drizzle in 21 files with stale models and unused zod schemas; raw `pg` in 73 files. Types for raw rows are hand-written per query.
13. **Rendered Russian text is stored as data.** `notifications.title`/`message` hold final RU strings with names inlined; `activity_log.entity_title`; `scaling_tiers.name`/`academy_stages.name` (editable labels, fine because they are keyed by `key`); seeded checklist labels; the `'Другой'` sentinel. The translation wave cannot translate rows already written.

### Performance (low)
14. Wide `trades` rows (`structure` + `context_snapshot` ≈ 1.4 KB inline) make every desk-wide scan read about 108 MB of heap. Per-row TRANSLATE/COALESCE expressions block index use. Fine now; it will matter at about 200k trades or with more concurrent dashboards.
15. 15 redundant indexes (about 3.5 MB, plus write amplification on `trades`), and unbounded cache tables.

---

## 3. Target principles (enforceable, sized for one small team)

- **D1. One migration history.** All DDL lives in numbered, immutable files under `artifacts/api-server/migrations/NNNN_name.sql`, applied by one runner under an advisory lock before `listen`. A failing migration **aborts boot** (Replit keeps the old deployment). No DDL anywhere else: CI greps for `CREATE TABLE|ALTER TABLE|CREATE INDEX` outside `migrations/`.
- **D2. Migrations are forward-only and expand/contract.** Add (nullable or defaulted) → backfill → switch code → constrain (`NOT VALID` then `VALIDATE`) → drop in a *later* release. Each file sets `lock_timeout = '3s'` and `statement_timeout`. Indexes on big tables use `CREATE INDEX CONCURRENTLY` in their own non-transactional migration. "Reversible" means the expand step is harmless if the code is rolled back; down-migrations are not maintained.
- **D3. Data fixes are migrations too**: a one-off is a numbered file that runs once and is recorded. Seeds needed in production (strategies, checklist, calendar) are idempotent migrations or an explicit admin action, never boot code.
- **D4. The schema snapshot is committed.** `db/schema.sql` (from `pg_dump --schema-only`) is regenerated by a script after each migration. CI builds an empty PG 16, runs all migrations, diffs against the snapshot, and runs the integrity checks in §6.
- **D5. People are referenced by key with DB enforcement.** Every person column has an FK to `users`: initially to `users(name)` `ON UPDATE CASCADE`, eventually to `users(id)`. Sentinel actors (`system`, `import-script`) are real inactive `users` rows with role `system`. A rename is a supported operation: one UPDATE, cascaded, token version bumped, audited.
- **D6. Canonical values are stored, not inferred.** Enums are text plus a CHECK (not PG `ENUM` types, which are painful to evolve). Normalise on write (one function shared by the PropReports sync and API writes). Never store display labels or translated text as data; store a code plus params and render in the UI.
- **D7. Time.**
  - Instants are `timestamptz` in UTC; the pool sets `TimeZone=UTC`.
  - "Trading day" is a NY date, computed in code (`nyDate`) or with `AT TIME ZONE 'America/New_York'`, and stored as `date`. Transitional: TEXT with `CHECK (col ~ '^\d{4}-\d{2}-\d{2}$')`.
  - No `CURRENT_DATE`, `now()::date` or `ts::date` in SQL.
  - Weeks are stored as `week_start date` (NY Monday).
- **D8. Money.** `numeric` with explicit scale: pnl, fees and per-share prices `numeric(14,4)`, account-level amounts `numeric(14,2)`. Never TEXT. Aggregate in SQL and round only for display.
- **D9. JSON is for documents and snapshots, not for queried facts.** A field that appears in WHERE, ORDER BY or GROUP BY becomes a column. JSON is `jsonb`, never TEXT.
- **D10. Deletion.** User content that can be restored uses `deleted_at timestamptz` (one name); workflow state uses `archived_at`. Hard delete only for join/ack rows and caches. Queries on soft-delete tables go through a `*_live` view or a shared SQL fragment.
- **D11. Every table has** `id` (identity for new tables), `created_at timestamptz not null default now()`, plus `updated_at` if mutable; FKs on every `*_id`; an index on every FK column used in joins.
- **D12. Audit** writes go in the same transaction as the change for security-relevant actions (users, roles, permissions, limits, money), `details jsonb`.
- **D13. Caches** are named `*_cache` with a documented TTL and a nightly prune, and are excluded from backups (`--exclude-table-data`).

---

## 4. Migration plan

All of this is backend and SQL. **None of it requires file moves in the frontend, so it can run in parallel with or after the translation wave.** Two items **should be decided before** the wave because they change what the UI translates: (a) notifications and activity store `type` + `params` instead of rendered RU text (4.6); (b) canonical codes for `result`, `setup_type 'Другой'`, `watchlist.status` (4.4).

### Phase 0: stop the bleeding (S, before anything else)
| Step | Files | Risk | Verify |
|---|---|---|---|
| Remove `push`/`push-force` from `lib/db/package.json` (or replace them with a script that prints "use migrations") | `lib/db/package.json` | none | `pnpm -r run` lists no push |
| Delete `src/lib/seed-sync.sql` and its i18n allowlist entry | api-server | none | grep |
| `PATCH /users/:id`: reject `name` (400 "renames go through /admin/users/:id/rename") until 4.5 lands; add `logAudit` for create, update, password, role and deactivate | `routes/users.ts` | low | vitest route test |
| Pool: `application_name`, `idle_in_transaction_session_timeout=60s`, `options: '-c TimeZone=UTC'`; set `lock_timeout='3s'` at the top of `runMigrations` | `lib/db/src/index.ts`, `migrate.ts` | low; changes local TZ behaviour of the 5 CURRENT_DATE sites (they become UTC like production) | boot log; `SHOW TimeZone` |
| Fix the two `telegram.ts` `::date = CURRENT_DATE` sites → NY date | `routes/telegram.ts:434,489` | low | unit test around 20:00 NY |
| `playbook_trade_ideas`: either fix the merge (select only existing columns) or, **with owner approval** (data change), drop the empty legacy table | `migrate.ts:818` | low (0 rows) | boot log has no WARN |
| Backups: stream `pg_dump -Fc` straight to object storage (no Buffer); persist `lastBackupAt` (read the newest object's timestamp) so restarts don't re-dump; `--exclude-table-data` for the 8 cache tables; log `pg_dump --version` and the server version, and fail loudly on mismatch | `lib/dbBackupCron.ts` | low | trigger via `/api/admin/backups/trigger` on staging; restore drill (Phase 6) |

### Phase 1: versioned migrations with a baseline (M, can start now)
Tool recommendation: **node-pg-migrate 9.x** used programmatically with **SQL files**. It is a Node-native runner and supports `.sql` loaders, an advisory lock (`advisoryLockMode: 'wait'`), `checkOrder`, `dryRun`, and `fake` for baselining an existing DB ([API docs](https://salsita.github.io/node-pg-migrate/api); requires Node ≥ 22.12, PG ≥ 14; the repo runs Node 24 and PG 16 locally).

Alternatives:
- [graphile-migrate](https://www.bytebase.com/blog/top-open-source-postgres-migration-tools.md): plain-SQL, roll-forward, idempotent-by-convention `current.sql` workflow; also a good fit, but it wants a shadow DB and a CLI-centric workflow.
- [dbmate](https://www.pkgpulse.com/guides/drizzle-kit-vs-atlas-vs-dbmate-schema-migration-tools-2026): a Go binary; no in-process advisory-lock runner, and one more binary to ship on Replit.
- drizzle-kit `generate`/`migrate`: only viable if drizzle becomes the schema of record, which conflicts with 73 raw-SQL files and 81 unmodelled tables.
- A homegrown runner (about 80 lines: `schema_migrations` table plus `pg_advisory_lock`) is also acceptable for this size. **Owner/lead decision.**

Steps:
1. **Baseline.** Take `pg_dump --schema-only --no-owner` **of production** and save it as `migrations/0001_baseline.sql` (tables, constraints, indexes; no data). Put seed data needed on a fresh DB (strategies, checklist, calendar) in `0002_reference_seed.sql` using `ON CONFLICT DO NOTHING`.
2. **Runner at boot** (`index.ts`): `runner({ dir, migrationsTable: 'schema_migrations', advisoryLockMode: 'wait', checkOrder: true, singleTransaction: false })`. If `schema_migrations` is missing but `trades` exists, run once with `fake: true` up to 0002 to mark the baseline as applied on existing DBs.
3. **Transition** (behaviour-preserving). Keep `runMigrations()` and all `ensure*()` running **after** the runner for one or two releases. They become no-ops because everything already exists. Then delete them file by file: each `ensure*` deletion PR must show its DDL is already in the baseline or a numbered migration. Delete the module-import `ensure*().catch()` calls first, since they are the race.
4. **CI job**: spin up an empty PG 16 (`embedded-postgres` is already a devDependency in `scripts`), run migrations, `pg_dump --schema-only`, and diff against the committed `db/schema.sql`. Also run the §6 checks.
5. **Drizzle.** Either (a) stop using it: migrate the 21 files to `pool.query` with typed row interfaces and delete `lib/db/src/schema/*` except `pool`; or (b) regenerate it read-only from the DB with `drizzle-kit pull` after each migration and never write models by hand. The recommendation is (a), as it is the dominant style (73 vs 21 files) and removes a second source of truth. **Owner/lead decision; not urgent.**

Risk: medium (boot path). Mitigations: dry run against a production snapshot locally (`restore-dump.ts` exists); the baseline is fake-applied, never executed, on production.

### Phase 2: cheap integrity constraints (M, after Phase 1)
Each constraint is a migration in three steps: clean the data (separate migration, logged counts), add the constraint `NOT VALID`, then `VALIDATE CONSTRAINT` in the next migration (it takes a SHARE UPDATE EXCLUSIVE lock and doesn't block writes).
- **CHECK enums**:
  - `trades.result IN ('win','loss','be','open')`: first `UPDATE trades SET result='be' WHERE result='breakeven'` (8 locally) and map Russian synonyms; then simplify `lib/tradeMath.ts` `res()` to a plain column compare. Synonym mapping moves to the write path (sync plus API).
  - `trades.side IN ('Long','Short')`
  - `trades.horizon IN ('intraday','overnight','swing')` (nullable)
  - `trades.session`
  - `trades.source IN ('manual','propreports')`
  - the two drizzle-declared trades CHECKs
  - `users.role IN ('trader','curator','admin','system')`
  - `watchlist.status` after normalising `Active`
  - `trading_errors.resolved`; convert to boolean later
- **Format CHECKs** on TEXT dates: `trades.date`, `exit_date`, `eod_days.date`, `game_plans.date`, … (`~ '^\d{4}-\d{2}-\d{2}$'`; 0 violations locally).
- **UNIQUE**: the six business keys in §2.7 (dedupe first; 0 dups locally) and `CREATE UNIQUE INDEX users_name_ci ON users (lower(btrim(name)))`.
- **FKs on the 45 soft references**, starting with trade-attached tables: `trade_quality` (delete the 41 orphans), `eod_trade_reviews`, `playbook_examples`, `rule_violations.trade_id`, `pre_trade_checklist_responses.trade_id`, `trades.playbook_id` → playbook, `discussions.*_id`. Use `ON DELETE CASCADE` for derived rows and `SET NULL` for links.
- Drop the 15 redundant indexes and `trades_event_id_idx` after confirming 0 scans on production (`pg_stat_user_indexes`, reset first, observe for 1–2 weeks).
- Add the missing `emotional_state_log(user_id, date)` index (it becomes the unique key above).

Verify: §6 checks return 0; existing vitest suite; one smoke pass of the app.

### Phase 3: identity, the safe incremental path (M, needs owner decisions)
Goal: integrity and rename safety **without rewriting 778 SQL predicates or 188 frontend files**.
1. **Owner decides** whether renames are a product feature or names are frozen. Either way, do 2–5.
2. **System actors**: insert inactive `users` rows `system`, `import-script` (role `system`, no password, `active=false`), and decide on `Офис` (one `playbook.copied_from_author` row). Map the guest `∅` to a real `guest` row, or NULL it before persistence.
3. **Name FKs with cascade**, one migration per table group: `ALTER TABLE trades ADD CONSTRAINT trades_trader_fk FOREIGN KEY (trader) REFERENCES users(name) ON UPDATE CASCADE NOT VALID;` then `VALIDATE`. `users.name` is already UNIQUE, which Postgres requires for the FK target.
   - Use `ON DELETE RESTRICT`; users are deactivated, never deleted.
   - Add an index on each FK column where one is missing (most `trader` columns have one). A rename then updates 45k trade rows in one transaction (sub-second at this size).
   - Columns about 110 (all except `discussions.audience` TEXT[], `playbook.shared_with` jsonb, and free-text mentions). For those three, add a rename hook (a SQL function `rename_user(old,new)` that also rewrites the arrays/jsonb), plus a nightly integrity check.
4. **Rename endpoint**: `POST /admin/users/:id/rename`. One transaction: `UPDATE users SET name=$new` (cascades), call `rename_user()` for the non-FK containers, `bumpTokenVersion`, `logAudit` with `{from,to}`. Only after this exists, lift the Phase 0 PATCH block.
5. **Latin aliases**: move `name_latin` into a migration. Add a unique index on `lower(name_latin)` where it is not null, plus a CHECK or trigger so an alias can't equal another user's `name` (otherwise search and mention resolution become ambiguous). Keep it display/search-only; never use it as a key.
6. **Optional Phase 4 (L): move to `user_id` int FKs.** For each table: add `trader_id int REFERENCES users(id)`, backfill by join, add a BEFORE INSERT/UPDATE trigger that fills `trader_id` from `trader` (and vice versa), switch reads module by module, make it NOT NULL, and eventually drop the text column. With step 3 in place this is **not needed for correctness**; it buys smaller indexes and decouples display names. For 30 users the recommendation is to defer it. **Owner decision.**

Verify: the integrity SQL (orphan names = 0); a rename on a restored production snapshot followed by spot checks of the trades page, journal, academy and PropReports mapping; a token issued before the rename is rejected.

### Phase 4: trades table hygiene (M)
- **Promote** `opened_at timestamptz` and `closed_at timestamptz` out of `context_snapshot`. Backfill is `(context_snapshot->>'openedAt')::timestamp AT TIME ZONE 'America/New_York'` (45,205 rows, all naive format). The PropReports sync writes both. Replace the 16 JSON-parsing SQL sites (`lib/ideaTradeMatch.ts`, `lib/askBook.ts`, `lib/propreports/sync.ts` …).
- **Generated** `close_date date GENERATED ALWAYS AS (COALESCE(NULLIF(exit_date,''),date)::date) STORED`. Postgres 16 supports stored generated columns. Requires the date CHECK first; note that adding a stored generated column rewrites the table, so do it in a low-traffic window. Optionally index `(close_date) WHERE deleted_at IS NULL`.
- Stop duplicating `qty`, `gross`, `totalFees`, `externalId` and `account` in `context_snapshot` for new rows (keep old rows). Consider moving `structure` jsonb to a 1:1 side table if desk-wide scans become slow; not needed now.
- Convert TEXT money/metrics (`weekly_psychology_reports.*pnl*`, `win_rate`) to numeric, and normalise week columns to `week_start date`.

### Phase 5: soft-delete and audit consistency (S–M)
- Add `trades_live`, `playbook_live`, … views (explicit column lists; recreate them in the migration whenever columns change) or a shared `LIVE(alias)` SQL fragment. A lint flags `FROM trades` without it in new code.
- Hard-deleted user content (comments, journal_days, author_notes, junior_notes, trader_ratings, rule_violations): decide per table whether deletion must be restorable. **Owner decision.**
- `audit_log.details` and `activity_log.details` TEXT → jsonb (`USING details::jsonb`, after validating that all rows parse). Security-relevant `logAudit` calls take a `client` and run inside the business transaction.

### Phase 6: backup and restore discipline (S, recurring)
- Daily `pg_dump -Fc` excluding cache data, plus Replit PITR (confirm the plan: [7 days on Core, 28 on Pro](https://docs.replit.com/features/data-and-storage/data-recovery); see also [production databases](https://docs.replit.com/features/data-and-storage/production-databases)). Retention: 14 daily plus 8 weekly (**owner decision**).
- **Monthly restore drill**: restore the latest dump into a scratch DB (local embedded-postgres), run migrations (should be a no-op), run the §6 checks and compare `count(*)` of the top 10 tables with production. Record the result in `audit_log`.
- Separate demo from production: production must never contain `settings->>'demo'` users or `DEMO|` trades. Add that to the §6 checks (expect 0 in production). Keep `seed-demo.ts`'s localhost guard.

### Phase 7: rendered text as data (decide before the translation wave; implement S–M)
- `notifications`: add `params jsonb` and keep `type`. New writes store `{actor, thread, snippet, …}`; the UI renders the text through i18n. Old rows keep `title`/`message` as fallback. The same pattern applies to `activity_log.entity_title`.
- Replace the `'Другой'` sentinel with the code `other` (migration plus 5 code sites); show labels via i18n.
- Seeded checklist labels and strategy texts are user-editable content. Leave them, but seed new installs in the default locale only. **Owner decision** on whether the desk wants them translated.

---

## 5. Quick wins (each ≤ 1 h)
1. Delete the `push`/`push-force` scripts in `lib/db/package.json`.
2. Delete `artifacts/api-server/src/lib/seed-sync.sql` (and its allowlist line in `src/i18n/allowlist.json`).
3. Block `name` in `PATCH /api/users/:id` and add `logAudit` to user create, update and deactivate in `routes/users.ts`.
4. Fix `routes/telegram.ts:434,489` to use the NY date, not `CURRENT_DATE`.
5. Add `lock_timeout`/`statement_timeout` at the start of `runMigrations()`; add `application_name` and `idle_in_transaction_session_timeout` to the pool.
6. Fix the `playbook_trade_ideas` merge so the boot WARN goes away (or drop the empty table with approval).
7. Create `emotional_state_log (user_id, date)` (the index declared in drizzle and never created).
8. `dbBackupCron`: derive `lastBackupAt` from the newest object in the bucket, so restarts don't force a dump.
9. Add the **2027 market calendar** (NYSE holidays, FOMC, CPI, NFP, OPEX). `seedHolidays2026()` is the only source and today is 2026-10-17, so the calendar goes empty in about 10 weeks.
10. Put the §6 integrity queries in a script (`scripts/src/db-check.ts`, read-only) and run it once against production.

---

## 6. Integrity checks (results on the local DB)
| Check | Local result |
|---|---|
| Person columns with values not in `users.name` (152 columns scanned, 111 hold data) | 0 real orphans; sentinels only: `system` ×75 (activity_log 20, academy_* 38, scaling_* 17), `import-script` ×3, `Офис` ×1 |
| Users: case/whitespace duplicates; names with leading or trailing spaces | 0 / 0 |
| Integer reference orphans (71 `*_id` columns, 45 without FK) | `trade_quality.trade_id` **41**; references to soft-deleted parents: playbook_examples 2, playbook_revisions 2, trades.playbook_id 1, trade_reactions 1 |
| Trades: bad `date`/`exit_date` format; conviction out of range; grade outside A+/A/B/C | 0 / 0 / 0 |
| Trades: non-canonical `result` | `breakeven` ×8 (canonical is `be`) |
| Trades: live trades without executions | 6 |
| Trades: natural-key duplicates (trader, ticker, date, side, entry, exit, qty, pnl) | 7 groups, all demo (distinct `external_id`s, so legitimate separate round trips) |
| Enum drift | `watchlist.status` watching ×7 / **Active ×4**; `trading_errors.resolved` yes/no TEXT |
| Business-key duplicates (6 keys from §2.7) | 0 |
| `propreports_accounts` unmapped or mapped to an unknown user | 0 / 0 (20 accounts) |
| Legacy table still present | `playbook_trade_ideas` (0 rows); its merge fails on every boot |
| Production-only check to add | `count(*)` of demo users / `DEMO|` trades should be 0 |

The SQL for all of the above is in `data_work/orphans.cjs`, `idorph.cjs` and the inline queries in this session. Wrap it as `scripts/src/db-check.ts` (quick win 10).

---

## 7. Decisions for the owner
1. **Renames.** Are user renames a feature (then build the Phase 3 cascade plus the rename endpoint) or are names frozen (block them and rely on `name_latin` for display)? Either way, Phase 0 blocks the unsafe path now.
2. **Identity depth.** Stop at name FKs with `ON UPDATE CASCADE` (recommended for about 30 users), or fund the full `user_id` migration (L)?
3. **Sentinel actors.** `system`, `import-script`, `Офис` and guest become real inactive `users` rows (recommended), or NULL plus an `actor_kind` column?
4. **Migration tool.** node-pg-migrate 9 with SQL files (recommended) vs a homegrown runner vs graphile-migrate.
5. **Drizzle.** Remove it in favour of raw `pg` (recommended) or keep it as an introspected read-only model.
6. **Hard vs soft delete** for comments, journal_days, notes, ratings, rule_violations.
7. **Backups.** Retention and cadence, and confirmation of the Replit plan's PITR window. Approve excluding cache-table data from dumps.
8. **Notifications and activity.** Switch to `type` + `params` rendered via i18n. Decide **before** the translation wave touches notification copy.
9. **Data changes needing explicit approval:**
   - drop `playbook_trade_ideas`
   - delete the 41 `trade_quality` orphans
   - `breakeven` → `be`
   - `Active` → `watching`
   - remove the boot-time `Ариф→Ориф` / restore-window / pnl-repair one-offs after confirming they are no-ops in production

Sources: [PostgreSQL 16 ALTER TABLE](https://www.postgresql.org/docs/16/static/sql-altertable.html) · [node-pg-migrate programmatic API](https://salsita.github.io/node-pg-migrate/api) · [node-pg-migrate repo](https://github.com/salsita/node-pg-migrate) · [Bytebase: top open-source Postgres migration tools 2026](https://www.bytebase.com/blog/top-open-source-postgres-migration-tools.md) · [PkgPulse: drizzle-kit vs atlas vs dbmate 2026](https://www.pkgpulse.com/guides/drizzle-kit-vs-atlas-vs-dbmate-schema-migration-tools-2026) · [Replit data recovery](https://docs.replit.com/features/data-and-storage/data-recovery) · [Replit production databases](https://docs.replit.com/features/data-and-storage/production-databases). Versions checked on npm on 2026-10-17: node-pg-migrate 9.0.0, graphile-migrate 1.4.1, dbmate 2.36.0, drizzle-kit 0.31.11 (repo has ^0.31.10), drizzle-orm 0.45.4 (repo has ^0.45.2).
