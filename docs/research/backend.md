# Backend architecture research: artifacts/api-server

Research date: 2026-10-17. This phase was read-only. Commands run: grep/wc scripts, `tsc --noEmit` (clean, 6.6 s), `vitest run` (44 files, 941 tests, all pass, 2 s), `pnpm audit --prod`, SELECTs on the local DB, and GETs against localhost:8080 with an admin token I minted.

---

## 1. Current state map

### 1.1 Size and shape

| Metric | Value |
|---|---|
| `src/routes/*.ts` | 77 files, **38,152 lines**, **609 handlers** (295 GET, 193 POST, 50 PATCH, 46 DELETE, 25 PUT) |
| `src/lib/**` (excluding tests) | 96 files, 28,662 lines |
| Route files over 600 lines / over 1000 lines | 25 / 6. Largest: offerings 2008, academy-cohorts 1803, academy-content 1553, risk 1496, playbook 1495, academy-path 1079 |
| Largest lib files | marketDataService 1620, migrate 1396, behaviorEngine 1113, whatIf 952 |
| Handlers per file | playbook 35, academy-content 34, academy-cohorts 33, playbook-spaces 22, admin 21, propreports 20 |
| `src/middlewares/` | empty (only `.gitkeep`) |
| Tests | 44 files, 6,759 lines (40 in lib, 4 in routes) |
| `any` | 650 occurrences (curator 45, marketbrief 34, migrate 31) |
| Lint | none (no ESLint or Biome). Prettier exists only as a root devDependency. |

### 1.2 Layering as it actually is

```
app.ts ─ pino-http → cors → helmet → json(10mb) → 3 IP rate limiters → jsonCompression → authMiddleware → apiAuthGate → routes/index.ts (75 routers, one flat Router)
routes/*.ts ─ parse req by hand or with zod → permission check (6 different idioms) → pool.query raw SQL (947 calls) → shape JSON → res.json
lib/*.ts    ─ mix of: pure engines (tradeMath, rulesEngine, scalingEngine, permissionsMatrix — well tested), DB stores
              (tradeStructureStore, curatorStore), integrations (marketDataService, telegramBot, transcribe), crons
```

- No services or repositories layer. Routes own SQL, business rules and response shape. About **85% of SQL lives in route files** (947 of 1,141 non-test `pool.query` calls; migrate.ts holds 80 of the rest).
- **Imports go in the wrong direction:**
  - `lib/dailyQuoteCron.ts` imports from `routes/dailyQuotes`.
  - `lib/propreports/sync.ts` dynamically imports `routes/academy-path` (refreshChallenges).
  - `index.ts` imports `startChallengeCron` from `routes/academy-path` and `TELEGRAM_WEBHOOK_SECRET` from `routes/telegram`.
  - Route→route imports in 12 places: candles is a de facto library for 5 routes; risk exports 23 symbols and scaling, behavior and leaderboard are also used as libraries.
- **Some background work starts on import.** `routes/propreports.ts:739` calls `startScheduler()` at module top level, so importing the router (tests included) arms a timer.

### 1.3 SQL

- Writing style: raw template strings via `pool.query` (1,135) or `client.query` (134). Drizzle query builder appears in 19 files (145 calls), mostly old CRUD (big7*, checklist, watchlist, trades GET). 555 queries are typed with `pool.query<Row>`; the rest return `any` rows.
- **Shared fragments (good):**
  - `lib/tradeMath.ts` exports `resultSql`, `netPnlSql`, `signedRSql`, `closeDateSql`, `horizonSql`, `decidedSql` and `closedSql`, and keeps a JS mirror plus a frontend mirror. 54 files import it.
  - No inline net-P&L formula bypasses it (0 hits). The 11 raw `SUM(pnl)` occurrences are intentional "gross" columns.
  - Other helpers: `spaceSql`/`visibleSql` (playbook visibility, 31 uses) and `execSpanJoin` (8).
- **Repeated fragments with no helper:**
  - `deleted_at IS NULL`: 343 times.
  - Active-user filter `active = true AND COALESCE(banned,false)=false`: 23 times.
  - Inline `AT TIME ZONE 'America/New_York'`: 14 times.
  - Optional-table guards (`to_regclass`, catching `42P01`): 15 times.
- **Transactions are hand-rolled.** 20 `pool.connect()`/BEGIN/COMMIT blocks in 10 files, each written correctly, but there is no `withTx` helper. Multi-statement writes outside a transaction exist, e.g. `PATCH /playbook/rename-folder` updates `playbook` and then `playbook_folder_settings` as separate autocommit statements.
- Advisory locks: only 2, both in academy-content (quiz attempt, demo seed).
- Injection: no user input is concatenated into SQL. Interpolated `LIMIT`/`OFFSET` values pass through `Number()`. Edge case: `admin-console.ts:445` `?offset=1e400` → `OFFSET Infinity` → 500.

### 1.4 Schema and migrations (three sources of truth)

1. `lib/migrate.ts` (1,396 lines) runs at **every boot**: 60 `CREATE TABLE IF NOT EXISTS`, column ALTERs, data repairs, user seeding and holiday seeding. There is no version table and no lock. **51 `.catch()` handlers, 35 of them silent `.catch(() => {})`.**
2. **Runtime DDL inside request paths.** 40 files define their own `ensure*()` (31 functions, **302 `await ensure*()` call sites**), memoised per process. That includes `ALTER TABLE playbook/trades/users ADD COLUMN IF NOT EXISTS` in `lib/playbookAccess.ts` (24 ALTERs) and in tradeStructureStore, peopleDirectory and users. PostgreSQL takes an ACCESS EXCLUSIVE lock for `ALTER TABLE … ADD COLUMN IF NOT EXISTS` even when the column already exists, so the first request after each deploy briefly locks hot tables.
3. `lib/db/src/schema` (Drizzle) describes **43 tables. The DB has 124.** `lib/db/package.json` still exposes `push` and `push-force` (`drizzle-kit push --force`). `scripts/post-merge.sh` already warns that push "can drop columns/tables".

Startup sequence: `runMigrations()` → `ensureTradeStructureSchema()` → background back-fill → `listen` → crons. If migrations fail, the log says "continuing anyway".

Orphan file: `src/lib/seed-sync.sql` (1,416 lines, starts with `DELETE FROM "comments"; DELETE FROM "trade_reactions"; …`). Nothing references it.

### 1.5 Input validation

- 28 of 77 route files import zod. 241 `safeParse`/`parse` calls.
- Files with mutations but **zero schema validation** (cast `req.body as {...}` and check with `typeof`):

  | File | Mutation handlers |
  |---|---|
  | playbook | 14 |
  | playbook-spaces | 9 |
  | tradeideas | 8 |
  | watchlist | 7 |
  | checklist, telegram, errors | 4 each |
  | big7tickers, ratings | 3 each |
  | digest, big7levels, weeklypsychologyreport, voicenotes | 2 each |
  | officeStats, idea-comments, executions, emotionalstate, aireview | 1 each |

  junior-notes has 8 mutations with 1 schema; notifications has 11 with 2; users has 6 with 1.
- 245 raw `req.body` references. The 400 response has no single shape: `{error}`, `{error, details: flatten()}`, `{error, issues:[…]}`, `{error, code:"VALIDATION", details:[…]}` (auth only), and `{error: zodError.message}` (trades: dumps raw zod JSON).
- Response validation exists only on `GET /trades` (`ListTradesResponse.parse` over all rows; see 1.11).

### 1.6 Error handling

- Express 5 is in use. Every handler is wrapped in `asyncHandler` (609/609). In Express 5 that wrapper is redundant: rejected promises reach the error middleware natively ([moltchat wiki, Express 5 async errors](https://moltchat-agent-commons.onrender.com/wiki/Express_5_async_error_handling)).
- There is one global error handler in `app.ts`:
  - It uses `err.status`/`statusCode`.
  - For status < 500 it sends `err.message` to the client.
  - For 500 it sends `{error, code:"INTERNAL"}`, with the message hidden in production.
- Inside handlers:
  - 159 `try/catch` blocks.
  - 11 explicit `status(500)` responses.
  - **111 silent catches** (`.catch(() => {})`, `catch {}`).
- Error body: **1,179 literal `json({ error: "…" })` sites. Only 53 (4.5%) carry a machine `code`.** The language is mixed: 600 Russian, 579 English ("Invalid id" ×62, "Not found" ×56, "Authentication required" ×31, "invalid id" ×27). The same condition gets different bodies; for example "not signed in" is `{error:"Требуется вход", code}` in auth.ts, `{error:"Требуется вход"}` (no code) in requireStaff and ask.ts, and `{error:"Authentication required"}` in users.ts.
- About 2,780 non-comment code lines in the API contain Cyrillic text: errors, labels, notification and Telegram texts, rule catalogues, insights. The i18n spec estimates ~4.2k lines across 152 files.

### 1.7 Auth, session, token_version

- JWT HS256 (`jsonwebtoken` 9) signed with `JWT_SECRET`; the process throws at import if the secret is missing.
- TTL is 30 days for members and 12 hours for guests. There is no refresh token. The client keeps the token in localStorage (`ws_lexx_token`). CSP is disabled (`helmet({contentSecurityPolicy:false})`), so a single XSS would steal a 30-day token.
- Revocation:
  - `users.token_version` is checked on every request, with a 30 s in-memory cache (`tvCache`) per process.
  - It is bumped on password, role or active change, ban and logout. Logout bumps it, so logging out kills every device.
  - All 12 bump sites call `bumpTokenVersion`.
- Global gate: `apiAuthGate` with an explicit `PUBLIC_API_ROUTES` allowlist (healthz, login, init-passwords, guest, `GET /users`, `GET /holidays`, Telegram webhook, voice-note audio). Guests get 403 on every mutation. This is a good, central, deny-by-default design. **It has no test.**
- `GET /users` is public and returns the full active roster (names, roles, so it shows who is admin) to anonymous callers. That is by design for the login picker, but it gives an attacker a ready target list.
- **Login rate limiting is probably global, not per user.** `app.set('trust proxy')` is never set. Behind Replit's proxy, `req.ip` is the proxy address, so the three IP limiters (login 10/15 min, guest 60/15 min, init-passwords 10/15 min) share one bucket for the whole internet: ten bad logins lock everyone out for 15 minutes. express-rate-limit's docs recommend `app.set('trust proxy', <hops>)` and verifying it with a `/ip` probe ([express-rate-limit: troubleshooting proxy issues](https://express-rate-limit.mintlify.app/guides/troubleshooting-proxy-issues); the same failure mode is reported on [n8n](https://community.n8n.io/t/x-forwarded-for-header-is-set-but-the-express-trust-proxy-s/51208?tl=en) and [GoogleCloudPlatform samples](https://github.com/GoogleCloudPlatform/nodejs-docs-samples/issues/3583)). The per-user limiters in `lib/rateLimits.ts` key on user id, so they are fine.
- **Plaintext PINs in logs.** `migrate.ts:866-893` seeds or repairs users with `password_hash IS NULL` using random 6-digit PINs and logs them at **info level in every environment** (`logger.info({ pins: … })`).
- Other secrets:
  - `PLAYBOOK_PASSWORD` and the Telegram webhook secret are compared with `!==`, which is not constant-time. Low risk.
  - `TELEGRAM_WEBHOOK_SECRET` falls back to `sha256(JWT_SECRET)`, with a hard-coded string as the last resort.
  - `ADMIN_PASSWORD` is compared with `timingSafeEqual` (good).

### 1.8 Permissions model

- `lib/permissionsMatrix.ts` is pure: 45 capabilities, roles trader/curator/admin/guest, scope desk/assigned, admin row locked. There is an offline parity check against the frontend mirror (`scripts/check-permissions.mjs`), but it is **not part of `pnpm test`**.
- `lib/permissions.ts` adds the request layer: `can`, `canAny`, `requireCap`, `requireAnyCap`, `readScope`, `resolveTraderParam`. The actor is re-read from the DB once per request, and overrides are cached for 15 s.
- `lib/auth.ts` adds older helpers: `scopeTrader`, `requirePersonalAccess`, `canAccessTrade`, `requireStaff`, `isStaffRole`, `viewerRole`.
- **Six authorization idioms coexist:**
  1. `requireCap`/`requireAnyCap` (62 calls)
  2. `can(...)` inline (~90)
  3. `scopeTrader`/`resolveTraderParam`/`readScope` (~95)
  4. Role-only helpers that ignore matrix overrides: `requireStaff`/`isStaffRole(viewerRole)` (~40), plus five **local** copies: `isStaffReq` (academy-content, 22 uses), `staffOnly` (academy-path, scaling), `requireStaffOr403` (playbook), `isStaff` (voicenotes, `authorNotesLogic`)
  5. **Role read from the JWT**, e.g. `["curator","admin"].includes(req.authUser.role)`: telegram.ts lines 58/562/577/607/619 (broadcast, force-disconnect, assignments), psychologyanalytics:173, voicenotes:14
  6. Row ownership (`requireRowOwnerOrStaff`, `canModifyOwnedRow`) and domain viewers (`loadMoneyViewer`, `canTrainOnTrades`, `discussionAudience`)
- **Defined capabilities no route checks:**
  - `telegram.broadcast`: the route uses the token role instead, so revoking the capability in the matrix UI has no effect.
  - `watchlist.manage`
  - `ideas.publish`
  - `propreports.import`
  - `risk.read.own`

  The admin can toggle these in the matrix UI, but nothing changes. The academy (cohorts, content, path: 85 handlers) is entirely role-based and outside the matrix.

### 1.9 Background jobs

All jobs run in-process on `setInterval`/`setTimeout`. Each is guarded by a module flag; there are no DB locks.

| Job | Where | Trigger | Idempotency / overlap guard | Clock |
|---|---|---|---|---|
| Sector poller | lib/marketDataService:1590 | 30 s after boot, then every 20 min | none (`.catch(()=>{})`) | — |
| Analyst-actions poller | marketDataService:1618 | every 15 min | none | — |
| Digest (morning/evening) | lib/digest:651 | 60 s tick, 5-min window | in-memory date plus `activity_log` lookup (check-then-act race) | **UTC** |
| Weekly psychology report | lib/weeklyPsychologyReport:465 | tick, Fridays ≥17:00 | in-memory `lastRunDate` | **server-local** (`getDay()`/`getHours()`) |
| Daily quote (AI) | lib/dailyQuoteCron | 15 s after boot, then 5-min tick at 06 | in-memory plus row check | **MSK** |
| DB backup (pg_dump → GCS) | lib/dbBackupCron | **3 min after every boot**, then every 48 h | in-memory `lastBackupAt` | — |
| Academy challenges | routes/academy-path:933 | 60 s after boot, then every 15 min | idempotent writes | **NY** |
| PropReports sync | lib/propreports/scheduler (started from a route module) | `PROPREPORTS_SYNC_MINUTES` | in-memory `running` flag | — |
| Trade-structure back-fill | index.ts | once at boot | — | — |

Consequences:
- Every deploy or restart triggers a full pg_dump within 3 minutes.
- Four different time bases are used.
- **Duplicate runs:** nothing prevents a double run if two processes are alive, such as a deploy overlap, a dev server pointed at prod DATABASE_URL, or a future second instance. Replit does not document whether old and new Reserved VM instances overlap during a redeploy ([Replit Reserved VM docs](https://docs.replit.com/cloud-services/deployments/reserved-vm-deployments)), so assume they can.
- **Failures:**
  - A failed job is visible only in logs, except PropReports `lastError`, which shows in admin-console.
  - There is no retry or backoff beyond what each job codes for itself.
  - There is no run history, except `propreports_sync_runs` and the audit log entries for backup and quote.

### 1.10 Caching

- About 30 ad-hoc in-memory caches, each with its own TTL code: `new Map<…,{ts,…}>` in analyst-actions ×4, earnings ×3, offerings ×4, candles ×2, options, stockdata, tradeideas, whatif, officeStats, feedStream, marketContext and big7tickers. Only `lib/hotCache.ts` provides a shared `TtlCache`, and only dashboard and psychologyanalytics use it.
- The ticker- and day-keyed Maps are unbounded: there is no LRU and expired keys are evicted only when read.
- Invalidation is explicit in 5 places only:
  - `invalidateDashboardCache` (11 calls: trades, sync, setups-auto)
  - permissions
  - tvCache
  - notification prefs
  - office stats
- After a PropReports sync, `feedStream` (60 s) and `officeStats` (60 s) serve stale data until TTL. That is acceptable but undocumented.
- Every cache is per process, which is fine for one VM.

### 1.11 Response size, compression, streaming

- `lib/jsonCompression.ts` gzips `res.json` bodies of 16 KB and up off the event loop (good, and tested). Two more private gzip implementations exist: `ask.ts sendBook` and `whatif.ts sendJsonGz`.
- Measured locally as admin:

  | Endpoint | Time | Transfer size |
  |---|---|---|
  | `GET /api/trades` | **2.47 s** | **63.8 MB raw / 9.7 MB gzip** |
  | `GET /api/whatif/base` | 1.10 s | **14.9 MB sent uncompressed** (no Content-Encoding, even with `Accept-Encoding: gzip`) |
  | `GET /api/office-stats` | **2.05 s** | 125 KB |
  | `GET /api/reconcile` | 1.18 s | 185 KB |
  | `GET /api/ask/book` | 0.49 s | 1.8 MB gzip |
  | `GET /api/trades/page?limit=50` | 0.78 s | 16 KB |

  `GET /api/trades` is unpaginated for staff and zod-parses 45k rows on the event loop. `/api/whatif/base` was measured on the running dev build; whether that build is stale is unverified.
- There is no streaming or SSE. Large payloads are built with `JSON.stringify` in one blocking call.

### 1.12 Logging and observability

- pino plus pino-http. Request logs carry id, method, path and status (query is stripped, good). The auth header is redacted.
- There are 288 logger calls and 0 `console.*` calls. The error-log key is inconsistent: `{error: e.message}` in some places, `{err}` in others, so stack traces are lost wherever `e.message` is used.
- There are no metrics, no error tracker, no slow-query log and no job dashboard.
- `/api/healthz` returns `{status:"ok"}` without touching the DB.
- `process.on('uncaughtException')` logs and **keeps the process alive**, which risks continuing in a corrupted state.
- There is **no SIGTERM handler and no graceful shutdown**: no `server.close()` and no `pool.end()`.

### 1.13 Config and env

- 29 env vars are read through `process.env` in 19 files. There is no schema and no single config module.
- Secrets have scattered fallbacks:
  - `MEDIA_TOKEN_SECRET || JWT_SECRET`
  - the derived Telegram secret
  - model id `process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5"` in playbook vs a `claude-sonnet-4-6` constant in 6 other files
  - AI timeouts defined 6 times (25–60 s)
- The pg Pool (`lib/db`) uses all defaults: max 10, **no `statement_timeout`, no `idle_in_transaction_session_timeout`, no `pool.on('error')`**. NUMERIC is parsed to JS float.

### 1.14 External integrations

- **PropReports** (`lib/propreports/*`) is the best-isolated integration:
  - client with a 60 s abort
  - pacing and retry
  - idempotent sync engine keyed by (source, external_id)
  - run history, parsers with fixtures and tests
- **Market data** is scraped from unofficial Yahoo, Nasdaq, TradingView, SEC and Dow Jones endpoints. It is spread across `lib/marketDataService` and **7 route files** (earnings, offerings, stockdata, options, fx, big7tickers, tradeideas), each with its own fetch, timeout (all but one `fetch` pass a `signal`) and cache. There is no shared client, no circuit breaker and no request budget.
- **AI:**
  - Anthropic is called directly from 6 route files plus aiReview, each with its own model constant, timeout and prompt code.
  - OpenAI is used only for transcription (`lib/transcribe`).
  - There is a per-user limiter for text and voice and a daily cost-budget env var.
- **Telegram:**
  - `lib/telegramBot` holds the shared code; route-level logic lives in `routes/telegram.ts` (642 lines).
  - The webhook acknowledges first and then processes. Good.
  - Broadcast loops are synchronous.
- **Object storage:** goes through the Replit sidecar at `127.0.0.1:1106`. The GCS SDK is used for backups.

### 1.15 OpenAPI spec and orval codegen

- `lib/api-spec/openapi.yaml` has 2,514 lines, 36 paths and **58 operations. The server has 608 routes.**
  - **556 routes (91%) are not in the spec.**
  - **6 spec operations have no route**: `/warroom/*`, which the Drizzle `warroom.ts` schema still describes.
  - The spec was last changed in commit 0b5ae8c (Phase 2).
- The server imports `@workspace/api-zod` in 7 route files (trades, events, research, dailyfeed, discussions, dashboard, health).
- The frontend imports `@workspace/api-client-react` in 70 files. Most use only the `Trade` type (41 files) plus around 40 hooks for the legacy CRUD sections. Everything else goes through hand-written `fetch` with hand-written types (127 FE files call `fetch(` directly).
- In practice codegen is a frozen legacy island, not the contract.

### 1.16 Security headers, CORS, limits, dependencies

- Helmet defaults minus CSP and COEP. HSTS, nosniff and XFO SAMEORIGIN are present.
- CORS in production allows `REPLIT_DOMAINS` only (verify that the custom domain zakit.website is included). An unknown origin gets a thrown Error, which becomes a **500** rather than a 403.
- `express.json({limit:'10mb'})` applies globally. Multer limits are 10/15/25 MB.
- `pnpm audit --prod` reports **31 vulnerabilities (1 critical, 13 high)**:
  - `xlsx@0.18.5`: prototype pollution and ReDoS. It parses uploaded PropReports performance files, which any member can upload. The npm package is abandoned upstream.
  - `multer@2.1.1`: three DoS advisories, fixed in 2.3.0.
  - `proxy-addr` (critical, but only exploitable once `trust proxy` is enabled; upgrade Express before turning it on)
  - `ip-address`, transitively via express-rate-limit
  - `form-data` and `fast-xml-builder`, transitively via @google-cloud/storage
  - root `adm-zip`
- The zod catalog pin is `^3.25.76`, which already includes the `zod/v4` subpath.

### 1.17 Tests

- Style:
  - Pure-function unit tests for engines (tradeMath, rulesEngine, scaling, promotion, challenge, reconcile, parsers with fixtures).
  - SQL fragment tests that run SELECTs over `VALUES` against a local DB and skip if it is down (3 files).
  - Route tests on a throwaway express app with `vi.mock("@workspace/db")` that assert on the SQL text sent (5 files).
- Coverage map:
  - Strong: tradeMath, PropReports parsing and round trips, rules, scaling, promotion, academy logic, privacy helpers, jsonCompression.
  - **None:** apiAuthGate/PUBLIC_API_ROUTES, permissions request helpers, migrations, crons, error middleware, any HTTP test against a real schema.
  - 4 of 77 route files have tests.
  - The permissions parity script is not wired into `test`.
- `test-setup.ts` falls back to the **dev DB** (`edge_tracker`) when `TEST_DATABASE_URL` is unset. That is safe today because the tests only read.
- There is no CI. `build-prod.sh` builds without running typecheck or tests.

### 1.18 Build and startup

- esbuild bundles everything into one ESM file: `dist/index.mjs` 8.5 MB plus a 16 MB sourcemap, with pino workers emitted separately. There is a long externals list copied from a template (mostly irrelevant).
- The `dev` script uses `fuser`/`sleep` port-kill loops and a full rebuild on each start; there is no watch mode.
- At startup the app runs migrations, structure schema and back-fill, then listens, then starts crons.
- If the port is busy it retries 5 times. A failed bind never calls `process.exit`.
- The production health check is `/api/healthz` (no DB check).

---

## 2. Problems ranked by impact

### Security and correctness

| # | Problem | Evidence | Fix size |
|---|---|---|---|
| S1 | **Login, guest and init-passwords rate limits are probably one global bucket** (no `trust proxy`). Anyone can lock everybody out of login for 15 minutes with 10 requests. Without the limiter on real IPs, 6-digit PINs have weak brute-force resistance. | app.ts has no `trust proxy`; Replit fronts the app with a proxy. Verify with a `/ip`-style log line in prod. | S (but upgrade Express/proxy-addr first, see S5) |
| S2 | **Plaintext seed/repair PINs logged at info in production** | migrate.ts:873, 891 | S |
| S3 | **Matrix bypass:** routes that check the JWT role or role-only helpers ignore desk overrides. 5 capabilities have no enforcing route, so the admin matrix UI lies for them. | telegram.ts ×5, psychologyanalytics:173, voicenotes:14; `telegram.broadcast`, `watchlist.manage`, `ideas.publish`, `propreports.import`, `risk.read.own` have 0 checks; academy (85 handlers) is role-only | M |
| S4 | **30-day bearer token in localStorage with CSP off.** One XSS gives a month of account takeover; there is no refresh or rotation. | lib/auth TOKEN_TTL, app.ts helmet | M (CSP: S–M) |
| S5 | **Vulnerable deps on upload paths:** xlsx 0.18.5 (prototype pollution/ReDoS) parses member uploads; multer 2.1.1 DoS. | pnpm audit | S–M |
| S6 | **`drizzle-kit push --force` is one command away from dropping 81 tables** (schema knows 43 of 124). | lib/db/package.json, DB count | S |
| S7 | **Orphan destructive SQL file in src** (`seed-sync.sql`, starts with DELETEs) | lib/seed-sync.sql | S |
| S8 | **Unvalidated mutation bodies** in ~20 files (~75 handlers). Today the result is mostly 500s or bad data, not escalation. | §1.5 table | M |

### Data integrity

| # | Problem | Evidence |
|---|---|---|
| D1 | **Schema exists in three places and evolves at runtime.** 302 `ensure*()` call sites, ALTERs on hot tables at first request, 35 silently swallowed migration errors, no version table or lock; a failed migration "continues anyway". | §1.4 |
| D2 | **Crons have no cross-process exclusion and depend on four clocks.** A deploy overlap can double-send the digest or weekly report and runs a backup on every boot. | §1.9 |
| D3 | **Multi-statement writes without transactions** (only 20 transactional blocks in the codebase; e.g. rename-folder). | playbook.ts:668 |
| D4 | **No DB timeouts or pool error handler.** A runaway analytic query or a stuck transaction can starve the 10-connection pool. Uncaught errors keep the process alive. | lib/db/src/index.ts, index.ts |
| D5 | **Manual trade creation still exposed** (`POST /trades`, `/trades/bulk`), which conflicts with "trades come only from PropReports" (owner rule). It feeds the reconcile "pending" queue. | trades.ts:537, 810 — **owner decision** |

### Maintainability

| # | Problem | Evidence |
|---|---|---|
| M1 | **No layering.** Routes hold SQL plus rules plus shaping (947 queries in routes); 6 files over 1000 lines; lib imports routes; routes double as libraries. | §1.2 |
| M2 | **Error contract is not machine-readable.** 95% of errors have no `code`; RU/EN are mixed. The i18n wave would have to translate 1,179 hand-written strings at the call sites. | §1.6 |
| M3 | **The API contract is fiction.** The spec covers 9%; 6 dead operations; FE hand-types around 550 endpoints. | §1.15 |
| M4 | **Six authorization idioms, five local staff helpers.** | §1.8 |
| M5 | **Integrations are scattered** (market data in 8 files, AI in 7, each with its own timeout, model and cache). | §1.14 |
| M6 | **About 30 bespoke caches**, unbounded Maps, invalidation by convention. | §1.10 |
| M7 | **No lint, no CI, 650 `any`, 4/77 route files tested, auth gate untested.** | §1.17 |
| M8 | **Config is scattered** (29 env vars in 19 files, duplicated model ids and timeouts). | §1.13 |

### Performance

| # | Problem | Evidence |
|---|---|---|
| P1 | `GET /trades` for staff: 64 MB JSON, zod-parsed on the event loop, 2.5 s. Every other request stalls meanwhile. | §1.11 |
| P2 | `/whatif/base` sends 15 MB uncompressed. `office-stats` takes 2 s. | §1.11 |
| P3 | Runtime DDL locks on hot tables after deploy; a backup pg_dump on every boot. | §1.4, §1.9 |

### Style

Mixed Drizzle and raw SQL, `asyncHandler` redundant under Express 5, three gzip helpers, inconsistent log keys.

---

## 3. Target principles

These rules fit a 2-person-admin internal tool with one VM, ~600 endpoints and AI agents doing most edits. "Enforced by" names the mechanism.

### Structure
1. **Feature folders, three files max per feature:**
   ```
   src/features/<feature>/
     <feature>.routes.ts   HTTP only: parse, authorize, call service, send
     <feature>.service.ts  business rules, transactions, no req/res
     <feature>.sql.ts      SQL strings plus row types (or <feature>.repo.ts)
   ```
   Pure engines stay in `src/domain/*` (tradeMath, rulesEngine, …). Integrations live in `src/integrations/<vendor>/`. Jobs live in `src/jobs/`.
   - Enforced by an ESLint `import/no-restricted-paths` (or dependency-cruiser) rule: domain imports nothing from features or integrations; nothing imports `*.routes.ts` except `routes/index.ts`; features import other features only via `service`.
2. **File size budget:** routes file ≤ 400 lines, any file ≤ 800 lines. Enforced by a CI script that fails on new violations; existing files go on an allowlist that may only shrink.
3. **No module-level side effects** (timers, DDL, network) in any file except `index.ts`/`jobs/registry.ts`. Enforced by review checklist plus a test that importing `app.ts` starts no timers (`vi.useFakeTimers`, assert `vi.getTimerCount() === 0`).

### HTTP contract
4. **Every handler declares zod schemas** for `params`, `query` and `body` through one `route()` helper (or a `validate({params, query, body})` middleware). The helper parses, puts typed values on `req`, and on failure sends the standard 400. Enforced by a lint rule banning `req.body`, `req.query` and `req.params` outside the helper. Start with a warning and an allowlist.
5. **One error shape**, RFC 9457-flavoured but backward compatible:
   ```json
   { "error": "<localized message>", "code": "NOT_FOUND", "details": { … } }
   ```
   - Handlers `throw new AppError(code, status?, params?)`, or use `notFound()`, `forbidden(cap)`, `badRequest(issues)`.
   - Only the error middleware writes error bodies, and it localizes `error` from `code` via the server i18n dictionary (`req.lang`).
   - Keep the `error` field because the FE already reads it.
   - Enforced by a lint rule banning `res.status(4xx|5xx).json(` outside `lib/http/errors.ts`, with an allowlist that only shrinks.
   - References: [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457), [Swagger: Problem Details](https://swagger.io/blog/problem-details-rfc9457-api-error-handling).
6. **The contract is code-first from zod.**
   - Request and response schemas live in `lib/api-contracts` (shared package).
   - The server validates with them; the FE imports the types (and optionally the schemas for forms).
   - OpenAPI is *generated* from them (zod v4 `.meta()` via [zod-openapi](https://github.com/samchungy/zod-openapi) or native `z.toJSONSchema`) for docs and orval, never hand-edited. With 556 undocumented routes, hand-written spec-first is not realistic.
   - Enforced by a CI test that diffs the generated spec against the route table (`router.stack`) and fails if a route has no contract (allowlist shrinks).
7. **Big collections are paged or streamed.** No endpoint returns over 2 MB raw by default. Exports use explicit `?format=export` with streaming. Enforced by a dev-mode middleware that logs a warning when a `res.json` body exceeds 2 MB.

### Authorization
8. **One way to authorize: capabilities.** Handlers call `requireCap`, `can` or `scopeFor(cap)`. Banned: `req.authUser.role`, `isStaffRole`, `viewerRole` and local staff helpers outside `lib/permissions*`. Academy gets capabilities (`academy.manage`, `academy.read.team`). Enforced by a lint rule (`no-restricted-syntax` on `authUser.role`, restricted imports) plus a test that every capability key is referenced by at least one route or service, and every mutating route has a cap check or is on an explicit "member-own" list.
9. **The public route allowlist and guest rules are tested** (table-driven test over `PUBLIC_API_ROUTES` plus a sample of mutating routes as a guest).

### Data access
10. **Schema changes only through versioned migration files** (`migrations/NNNN_name.sql`), applied at boot under `pg_advisory_lock` and recorded in `schema_migrations`. A migration that fails aborts startup; there are no silent catches. **No DDL in request paths.** Drizzle schema is either regenerated from the DB (`drizzle-kit pull`) as types only, or dropped; `push` is removed.
11. **SQL lives in `*.sql.ts`/repo files and uses shared fragments** (`tradeMath`, `notDeleted(alias)`, `activeUsers(alias)`, `nyDay(expr)`). Every query has a row type (`pool.query<Row>`). Enforced by lint banning `pool.query` in `*.routes.ts`.
12. **Multi-statement writes go through `withTx(async (tx) => …)`.** Enforced by review rule plus a grep for `BEGIN` outside `lib/db/tx.ts`.
13. **Pool settings:** `statement_timeout` 15 s by default (raise per query with `SET LOCAL`), `idle_in_transaction_session_timeout` 30 s, `max` set explicitly, `pool.on('error')` logged ([OneUptime on statement timeouts](https://oneuptime.com/blog/post/2026-01-16-postgresql-statement-timeouts/view)).

### Runtime
14. **Jobs live in one registry** (`src/jobs/registry.ts`), each declared as `{name, schedule (cron in America/New_York), run, timeoutMs}`. The runner:
    - takes a `pg_try_advisory_lock(hashtext(name))` per run, so a second process skips it;
    - writes a `job_runs` row (start, end, status, error);
    - exposes status in admin-console.

    This is a ~120-line in-house runner. pg-boss is the upgrade path if retries or queues are ever needed ([pg-boss](https://cdn.jsdelivr.net/gh/timgit/pg-boss@master/README.md), [graphile-worker](https://worker.graphile.org/docs)). For one VM and nine jobs, a dependency is not yet justified.
15. **Every outbound call goes through `integrations/http.ts`** with a timeout (default 10 s), small retry/backoff for idempotent GETs, a structured log line and a per-host cache helper. AI goes through `integrations/ai.ts` (one model config, one timeout, cost accounting).
16. **Config is read once** in `src/config.ts` (zod-parsed env, fail fast at boot). There is no `process.env` elsewhere (lint).
17. **Graceful shutdown:** on SIGTERM/SIGINT, stop the job scheduler, run `server.close()` (Node ≥19 closes idle keep-alives itself), run `pool.end()`, and exit with a 10 s hard timeout. `uncaughtException` logs and exits; the platform restarts the process ([OneUptime graceful shutdown guide](https://oneuptime.com/blog/post/2026-01-06-nodejs-graceful-shutdown-handler/view)).
18. **Logging:** always `logger.error({ err }, msg)` (the pino serializer keeps the stack), never `{error: e.message}`. No secrets or PINs at any level. `/healthz` stays a liveness check; add `/readyz` with `SELECT 1`.
19. **Caches use one `TtlCache` with `maxEntries`** (LRU), named and registered so admin-console can list them. Cache invalidation hooks hang off domain events (`onTradesChanged(traders)`), not scattered calls.

### Quality gates
20. **CI** (GitHub Actions or a Replit pre-deploy script): typecheck, ESLint, vitest, permissions parity, route/contract coverage diff, `pnpm audit --prod --audit-level=high` (warn). `build-prod.sh` runs typecheck and test before building.

---

## 4. Migration plan

Ordering versus the translation wave: the server-side i18n work (spec §"Server-side text") will touch nearly every route's error strings. **Phase 1 (error contract) must land BEFORE the API part of the translation wave.** Otherwise translators edit 1,179 call sites by hand, and those sites get rewritten again later. Translating then means filling a `code → text` dictionary. Moving route files into feature folders (Phase 4) should come **after** the translation wave, or be done per feature by the same agent, to avoid merge storms. Backend file moves do not collide with the frontend wave.

### Phase 0: safety fixes (before anything else; ≤1 day total)

| Step | Files | Effort | Risk | Verify |
|---|---|---|---|---|
| 0.1 Upgrade express (pulls proxy-addr ≥2.0.8) and multer to ≥2.3.0. Then `app.set('trust proxy', 1)` (hop count verified with a temporary log of `req.ip` + `X-Forwarded-For` in prod) | package.json, app.ts | S | Low–Med: wrong hop count = spoofable IP | Log 10 prod requests; `req.ip` equals the client IP; trip the login limiter from one IP and confirm another IP still logs in |
| 0.2 Remove PIN logging (write PINs to stdout only when `NODE_ENV!=='production'`, or never) | migrate.ts | S | None | grep `pins` |
| 0.3 Delete `push`/`push-force` scripts; delete or move `seed-sync.sql` out of src | lib/db/package.json, lib/seed-sync.sql | S | None | — |
| 0.4 pg Pool: `statement_timeout`, `idle_in_transaction_session_timeout`, `max`, `pool.on('error')` | lib/db/src/index.ts | S | Med: a legit slow report could time out, so start at 30 s and log timeouts | Load all heavy pages; watch logs for `57014` |
| 0.5 SIGTERM/SIGINT graceful shutdown; `uncaughtException` → log and `process.exit(1)` | index.ts | S | Low | `kill -TERM` locally: in-flight request completes, exit 0 |
| 0.6 Replace xlsx 0.18.5 with SheetJS CE from its CDN tarball (0.20.3+) or `exceljs` read-only | lib/propreports/parse-performance-report.ts | S–M | Med (parser behaviour) | Existing `performance.test.ts` fixtures |
| 0.7 Telegram, psychologyanalytics and voicenotes: replace JWT-role checks with `requireCap` (`telegram.broadcast`, `users.manage`, `journal.read.team`) | 3 route files | S | Low | New table test: curator with the cap revoked gets 403 |

### Phase 1: HTTP foundation (BEFORE the API translation wave; 2–3 days)

1. `src/lib/http/errors.ts`: `AppError`, helper throwers, an error-code registry (`ERROR_CODES` const with default RU text). The error middleware maps ZodError, pg errors (`23505` → `CONFLICT`, `22P02` → `BAD_REQUEST`, `57014` → `TIMEOUT`), multer errors and CORS errors (403, not 500), and localizes via `req.lang`. **S–M.**
2. `src/lib/http/route.ts`: `route({ params, query, body, cap? }, handler)` wrapper that validates and authorizes. It returns the standard 400 `{error, code:"VALIDATION", details:[{path,message}]}`. Drop `asyncHandler` in new code (Express 5). **S.**
3. Codemod the top error literals first: "Invalid id"/"invalid id" (89), "Not found" variants (~100), "Authentication required"/"Требуется вход" (~55), "Forbidden". Point them at `badRequest("INVALID_ID")`, `notFound()` and so on. That is about 30% of sites in one mechanical pass. The rest are converted file by file as the translation wave reaches each file: the translator replaces the literal with a code and adds RU/EN/UZ entries. **M**, spread out.
4. Tests: error middleware unit test; the table-driven `apiAuthGate` test; the permissions parity script moved into vitest. **S.**

- **Verify:** FE still shows the messages, because the `error` field stays. Grep count of `json({ error` falls per PR (add a CI counter that may not grow).

### Phase 2: schema single source of truth (1–3 days, any time; independent of i18n)

1. Add a `schema_migrations` table plus a runner (advisory lock, ordered `migrations/*.sql`, fail fast). **S.**
2. Freeze the current DB as `0001_baseline.sql` (`pg_dump --schema-only` of prod, sanitized) and mark it applied when tables exist. **M**; needs a prod dump. **Owner/ops step.**
3. Move every `ensure*()` DDL body into numbered migration files. Replace `await ensureX()` with nothing, keeping the function as a no-op for one release, then delete it. Do this in batches of about 5 files. **M** (302 call sites, mechanical).
4. Data repairs in migrate.ts (legacy pnl repair, tier rename, holiday seeds) become one-time numbered migrations. User seeding becomes a dev-only script.
5. Drizzle: either `drizzle-kit pull` to regenerate types for all 124 tables (types only, no push), or drop Drizzle and convert its 145 calls when touching those files. **Owner/lead decision. Recommendation: keep raw SQL as the standard and drop Drizzle gradually.** The codebase is already 90% raw SQL with good fragment helpers; two styles cost more than either one.

- **Verify:** boot on a fresh DB from the baseline plus migrations equals the prod schema (`pg_dump -s` diff). Boot twice: the second boot does nothing. Run the test suite.

### Phase 3: jobs, config, integrations (2–3 days, after Phase 0; independent of i18n)

1. `src/config.ts` (zod env) and switch the 19 files to it. **S–M.**
2. `src/jobs/registry.ts` with advisory-lock runner and `job_runs` table. Move the nine jobs in, with schedules in NY time; the backup becomes daily at a fixed hour, not on every boot. Remove `startScheduler()` from the route module. `lib/dailyQuoteCron`'s route import becomes a service import. **M.**
3. `src/integrations/http.ts` plus `integrations/marketData/*` (move Yahoo/Nasdaq/TradingView/SEC fetches out of 7 route files), and `integrations/ai.ts` (one model id, timeout and cost log). **M–L**; do it per vendor.
4. Cache helper with `maxEntries` and a registry; migrate caches when touching each file. **S** helper, M rollout.

- **Verify:** jobs visible in admin-console with last run and status. Run two local processes against the same DB: each job runs once. Unit-test the runner lock.

### Phase 4: layering and contracts (incremental, AFTER the translation wave per area, or by the translating agent)

1. Add ESLint (typescript-eslint flat config) with the restricted-paths, restricted-syntax and no-`process.env` rules in **warn** mode plus the allowlist. **S.**
2. Per feature, starting with the hottest and largest (trades, playbook, offerings, academy-*, risk):
   - split into `routes/service/sql`;
   - move shared helpers out of route files (candles → `integrations/marketData/candles`, risk exports → `features/risk/service`);
   - add contracts to `lib/api-contracts`;
   - convert to `route()`.

   About **L** total, done one feature per PR.
3. Generate OpenAPI from contracts and point orval at the generated file. Delete the dead `/warroom` operations and the Drizzle `warroom.ts` now (S). Add the CI check "route without contract" (allowlist shrinks).
4. Paginate or stream `GET /trades` for staff. The FE probably already moved to `/trades/page`; check the remaining callers. Remove the response zod-parse of 45k rows or move it to tests. Have `/whatif/base` use the shared `jsonCompression` (delete `sendJsonGz` and `ask.ts` gzip). Profile `office-stats` (2 s). **M.**
5. Academy capabilities into the matrix (**owner decision** on names and defaults: proposed `academy.manage` for curator/admin, `academy.read.team`). **M.**

- **Verify:** route-level HTTP tests per migrated feature (supertest-style against the real schema in a disposable test DB: `TEST_DATABASE_URL` required, refuse to run against `edge_tracker`). Measure payload and latency before and after (§1.11 table).

### Owner decisions needed
1. **Manual trade endpoints** (`POST /trades`, `/trades/bulk`, manual executions): delete or keep for curators only? (Memory: trades come only from PropReports.)
2. **Token model:** keep a 30-day localStorage JWT, or move to an httpOnly cookie plus shorter TTL and a refresh flow? Recommendation: an httpOnly `SameSite=Lax` cookie with 7-day sliding expiry, plus a CSP. That is a medium change touching FE fetch, the media `?access_token` path and the guest flow.
3. **Public `GET /users`:** acceptable for the login picker, or switch login to a typed name with the roster behind auth?
4. **Drizzle:** standardise on raw SQL (recommended) or invest in Drizzle for all 124 tables?
5. **Academy in the permission matrix:** yes or no, and the default grants.
6. **Backups:** daily at a fixed NY hour (recommended) vs the current 48 h plus every boot.

---

## 5. Quick wins (≤1 h each)

1. Upgrade express and multer, then `app.set('trust proxy', 1)` after verifying the hop count (S1, S5).
2. Delete the PIN `logger.info` lines in migrate.ts (S2).
3. Remove `push`/`push-force` from lib/db and remove `src/lib/seed-sync.sql` (S6, S7).
4. pg Pool: `statement_timeout: 30000`, `idle_in_transaction_session_timeout: 30000`, `pool.on('error', …)`.
5. SIGTERM handler plus exit on `uncaughtException`.
6. CORS rejection: `cb(null, false)` instead of throwing (no more 500s), and make sure the custom domain is in the allowlist.
7. Replace the five `["curator","admin"].includes(viewer.role)` checks in telegram.ts with `requireCap(req, res, "telegram.broadcast")` / `"users.manage"`.
8. Move `startScheduler()` from `routes/propreports.ts` top level into `index.ts` `startBackgroundServices`.
9. Make `/whatif/base` use the shared compression (delete `sendJsonGz`): about 15 MB down to roughly 1.5 MB per load.
10. Add `scripts/check-permissions.mjs` as a vitest test, and add a table test for `PUBLIC_API_ROUTES` and the guest-mutation 403.
11. Backup cron: skip the on-boot run when the last backup in the bucket is under 24 h old.
12. Delete the `/warroom/*` operations from openapi.yaml and `warroom.ts` from the Drizzle schema (then codegen, in the implementation phase).
13. Clamp `offset` with `Number.isSafeInteger` in admin-console audit log listing.
14. Add a `logger.error({ err })` convention note and fix the error-log key in the job runners (stack traces).
15. Make `test-setup.ts` refuse to run DB tests unless `TEST_DATABASE_URL` is set or the DB name ends in `_test`.

---

### Sources
- [Express 5 async error handling (moltchat wiki)](https://moltchat-agent-commons.onrender.com/wiki/Express_5_async_error_handling)
- [express-rate-limit: Troubleshooting proxy issues](https://express-rate-limit.mintlify.app/guides/troubleshooting-proxy-issues), [n8n thread](https://community.n8n.io/t/x-forwarded-for-header-is-set-but-the-express-trust-proxy-s/51208?tl=en), [GoogleCloudPlatform issue #3583](https://github.com/GoogleCloudPlatform/nodejs-docs-samples/issues/3583)
- [pg-boss README](https://cdn.jsdelivr.net/gh/timgit/pg-boss@master/README.md), [graphile-worker docs](https://worker.graphile.org/docs), [pkgpulse: BullMQ vs Bee-Queue vs pg-boss 2026](https://www.pkgpulse.com/guides/bullmq-vs-bee-queue-vs-pg-boss-job-queues-nodejs-2026)
- [zod-openapi](https://github.com/samchungy/zod-openapi), [Speakeasy: OpenAPI with Zod v4](https://www.speakeasy.com/openapi/frameworks/zod), [express-zod-api OpenAPI](https://mintlify.com/robintail/express-zod-api/integration/openapi), [Zod ecosystem](https://v4.zod.dev/ecosystem)
- [OneUptime: PostgreSQL statement timeouts (2026)](https://oneuptime.com/blog/post/2026-01-16-postgresql-statement-timeouts/view), [Bytebase: Postgres timeouts](https://bytebase.com/blog/postgres-timeout)
- [OneUptime: Node.js graceful shutdown (2026)](https://oneuptime.com/blog/post/2026-01-06-nodejs-graceful-shutdown-handler/view), [Galaxy Cloud: graceful shutdown guide](https://blog.galaxycloud.app/a-practical-guide-to-graceful-shutdown-in-node-js-applications/)
- [Replit Reserved VM deployments](https://docs.replit.com/cloud-services/deployments/reserved-vm-deployments)
- [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457), [Swagger: Problem Details](https://swagger.io/blog/problem-details-rfc9457-api-error-handling)
