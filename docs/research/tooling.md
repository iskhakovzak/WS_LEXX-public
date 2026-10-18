# Architecture research: tooling, security and delivery

Scope: monorepo setup, lint/format, type-check/test, CI, git hygiene, dependency health, build and deploy, runtime security, observability, backups, developer experience.
Repo: `C:\Users\WS\Desktop\lexx\Project-Deploy` (branch `main`, 955 commits across all refs, private GitHub `iskhakovzak/WS_LEXX`; the unauthenticated GitHub API returns 404, so the repo is private).
Everything below was observed read-only on 2026-10-17. Commands run: `tsc --noEmit` per package, `vitest run` per package, `pnpm audit`, `pnpm outdated -r`, `prettier --check`, plus git log/pickaxe history scans. No files were changed.

---

## 1. Current state map

### 1.1 Monorepo layout

| Package | Kind | Size / notes |
|---|---|---|
| `artifacts/api-server` (`@workspace/api-server`) | Express 5 API, esbuild bundle to `dist/index.mjs` | 217 `.ts` files, 73.8k LOC. `pool.query` used 1,132×, drizzle query builder used 145×. 34 files contain `CREATE TABLE IF NOT EXISTS`. |
| `artifacts/edge-tracker` (`@workspace/edge-tracker`) | React 19.1 + Vite 7 + Tailwind 4 + wouter + TanStack Query | Last built main chunk (Oct 16) is 1.04 MB. 55 shadcn `ui/*` files, of which **27 are imported nowhere**. |
| `artifacts/binance-monitor` | Python script (aiohttp) run as a Replit workflow | Not part of pnpm. `requirements.txt` has unpinned `>=` ranges. |
| `lib/db` | drizzle schema + `pg` Pool | Exports raw `.ts` (`"exports": "./src/index.ts"`). |
| `lib/api-spec` → `lib/api-zod`, `lib/api-client-react` | OpenAPI (2,514 lines) → orval codegen | Generated code is committed. orval 8.9.0. |
| `lib/integrations-anthropic-ai` | Anthropic SDK wrapper | Used by api-server (12 files). |
| `lib/integrations-openai-ai-server` | OpenAI wrapper | **Imported by nobody.** api-server imports `openai` directly. It is also missing from the root `tsconfig.json` references. |
| `lib/text-search` (new, untracked) | Cross-script name search | Used by api (1 file) and web (3 files). Its `test` script borrows edge-tracker's vitest. It is **not** listed in the api/web tsconfig `references`. |
| `scripts` (`@workspace/scripts`) | tsx CLIs | `local-db` (embedded-postgres), `restore-dump`, `seed-demo` (164 KB file), `local-whisper`, `import-propreports`, and leftovers `hello.ts` and `seed-zakir-trades.ts`. |

- **pnpm workspace** (`pnpm-workspace.yaml`):
  - Has a `catalog:` of 22 entries, but only some packages use it. For example, `wouter` is `^3.9.0` in edge-tracker while the catalog says `^3.7.0`; `vitest` and `esbuild` are not catalogued.
  - `minimumReleaseAge: 1440` (a 24 h supply-chain delay) is good practice and already in place.
  - There are about 100 platform-binary `overrides` (Replit's linux-x64 trimming). Because of these, a Windows dev machine can only install with the right binaries thanks to the `-` overrides being platform-specific. Worth knowing before CI on `ubuntu-latest`, which is fine because it is linux-x64.
  - `lockfileVersion 9.0`, local pnpm 10.34.7, Node 24.19. **There is no `packageManager` or `engines` field**, so the pnpm version on Replit and on the laptop is not pinned.
  - **No duplicate versions** of react, zod, drizzle, typescript, vite or pino in the lockfile.
- **TypeScript**:
  - `tsconfig.base.json` is strict-ish but sets `strictFunctionTypes: false` and `noUnusedLocals: false`.
  - The root `tsconfig.json` uses project references for 5 libs (`composite`, `emitDeclarationOnly`). Libs export **raw `.ts` source**, so references are half-used: api-server references db/api-zod/anthropic but not text-search, and web references only api-client-react. The result is the extra `typecheck:libs` step plus `dist/` and `tsbuildinfo` churn.
  - **`edge-tracker/tsconfig.json` excludes `**/*.test.ts`**, so its 52 test files are never type-checked (vitest strips types).
  - Type-check status today: api-server ✅ (7 s), edge-tracker ✅ (25 s), scripts ✅.
- **Tests**: vitest everywhere.
  - edge-tracker: 52 files, 646 tests, 1.6 s, all pass.
  - api-server: 44 files, 941 tests, 2.2 s, all pass.
  - api tests point `DATABASE_URL` at local `edge_tracker` and skip the SQL tests when that DB is down (`src/test-setup.ts`). This is good and CI-friendly with a Postgres service.
- **Ad-hoc checks that already exist but are not wired together**:
  - `edge-tracker/scripts/check-z.mjs`: z-index ratchet with a baseline file. This pattern is worth copying.
  - `edge-tracker/scripts/i18n-report.mjs`: Cyrillic-in-code counter with `--check <prefix>`.
  - `api-server/scripts/check-permissions.mjs`: offline check of the permissions matrix. It is not in any `package.json` script.

### 1.2 Lint / format / CI
- **Linter: none.** There is no ESLint, Biome or oxlint config anywhere.
- **Formatter: Prettier 3.8.3 is a root devDependency but has no config and has never been applied.** `prettier --check` flags **212 of 217** api-server files. Across `artifacts/*/src` there are **3,535 lines longer than 200 characters**.
- **No `.editorconfig`, no git hooks, no `.github/`** (so no Actions, Dependabot or Renovate), and no `.git-blame-ignore-revs`.
- **Deploy has no quality gate**:
  - The Replit production build (`api-server/.replit-artifact/artifact.toml` → `bash scripts/build-prod.sh`) runs only `vite build` + esbuild.
  - Root `pnpm build` does run `typecheck`, but deploy does not call it. Tests are never run on deploy.

### 1.3 Build and deploy (Replit Reserved VM, `deploymentTarget = "gce"`)
- There are **two production services** behind Replit's path router:
  - The `api` artifact serves `/api` (Express, `PORT=8080`, health check `/api/healthz`).
  - The `web` artifact (`serve = "static"`, `publicDir = artifacts/edge-tracker/dist/public`) serves `/`.
  - `build-prod.sh` **also** copies the SPA into `api-server/dist/public`, and `app.ts` serves it when `NODE_ENV=production`. So the frontend is built twice, and **index.html is most likely served by Replit's static server, which Express/helmet headers never touch.** This matters for CSP (see P1-5).
- The `postMerge` hook runs `pnpm install --frozen-lockfile` only. Schema changes run on API boot via `lib/migrate.ts`, and `startServer` logs and **continues if migrations fail**.
- The api-server `dev` script uses the Linux-only `fuser`, and its dev loop is "esbuild build + start" with no watch mode. On Windows the `fuser` part fails silently.
- The production bundle is `index.mjs` at 8.5 MB plus a 16 MB source map. `--enable-source-maps` is fine.
- `vite.config.ts` loads `runtimeErrorOverlay()` in production builds too (it only does something in dev, but it is still bundled). The dev server binds `0.0.0.0` with `allowedHosts: true`.
- Docs drift:
  - README and DEPLOY say "React 18"; the actual version is 19.1.
  - `MIGRATION.md` describes Supabase, while DEPLOY describes Replit Postgres.
  - `replit.md`, `main.py` and `pyproject.toml` (the Replit Python template "Hello from repl-nix-workspace") are leftovers.

### 1.4 Env and secrets
- About 40 env vars are read directly via `process.env` in **19 server files**, with no central schema: `JWT_SECRET`, `ADMIN_PASSWORD`, `PLAYBOOK_PASSWORD`, `MEDIA_TOKEN_SECRET`, `TELEGRAM_*`, `AI_INTEGRATIONS_*`, `PROPREPORTS_*`, `RESEND_API_KEY`, `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `SEED_USERS`, `INIT_PASSWORDS`, `GUEST_MODE`, `TRANSCRIBE_*`, `WHISPER_*`, and others.
- Only `JWT_SECRET` and `DATABASE_URL` fail fast at boot.
- Derived-secret coupling:
  - `MEDIA_TOKEN_SECRET` falls back to `JWT_SECRET` (`routes/voicenotes.ts:34`).
  - `TELEGRAM_WEBHOOK_SECRET` falls back to `sha256("tg:"+JWT_SECRET)`, with a literal fallback `"ws-lexx-tg-secret"` (`routes/telegram.ts:28`).
  - Rotating `JWT_SECRET` therefore silently rotates the media and webhook secrets too.
- Local: `.env.local` (holds `JWT_SECRET`) is gitignored. ✅

### 1.5 Runtime security (api-server)

| Area | Today | Verdict |
|---|---|---|
| AuthN | HS256 JWT, **30 d TTL**, stored in `localStorage["ws_lexx_token"]`, sent by a global fetch patch (`lib/install-fetch-auth.ts`). Revocation works via a `token_version` check with a 30 s cache, and logout bumps the version. Guest tokens last 12 h with a signed `kind:"guest"` marker. | Sound design, but the TTL is long and `jwt.verify` is called without `algorithms: ["HS256"]`. |
| Global gate | `apiAuthGate` + explicit `PUBLIC_API_ROUTES` allowlist (`lib/auth.ts`). | ✅ Good. |
| Passwords | bcryptjs at cost 10. Per DEPLOY.md, default accounts get **random 6-digit PINs**. `GET /users` is public and returns id, name and **role** for the login screen. | Small keyspace plus a public roster: brute-force resistance rests entirely on rate limiting (see P0-2). |
| Rate limiting | `express-rate-limit` keyed by IP: 10 per 15 min on `/auth/login` and `/auth/init-passwords`, 60 on guest. Per-user limiters exist for AI and voice routes (`lib/rateLimits.ts`). **`app.set("trust proxy")` is never called.** | Broken behind Replit's proxy (see P0-2). |
| CORS | In production, origins come only from `REPLIT_DOMAINS`, with `credentials:true`. Rejected origins go through `cb(new Error)` and become a **500**. The custom domain `zakit.website` (mentioned in `index.ts`) may not be in `REPLIT_DOMAINS`. | Unneeded (same-origin SPA plus bearer tokens) and fragile. |
| Headers | helmet with `contentSecurityPolicy: false` and CORP `cross-origin`. The SPA HTML is served by Replit static, so no headers apply to it. | No CSP anywhere. |
| Body limits | `express.json({limit:"10mb"})` and `urlencoded 10mb` apply globally and are **mounted before the auth gate**, so anonymous requests are parsed too. Multer: voice 25 MB, PropReports 15 MB, admin XLS 10 MB. Plan media accepts raw images (webp/jpeg/png) up to `PLAN_MEDIA_MAX_BYTES`. | Tighten the default. |
| SQL injection | All 37 template-literal queries interpolate constants or whitelisted identifiers: `COL[k]` maps (`dailyfeed.ts:492`), `KIND_TABLE[kind]` from a zod enum, `SORT_COLS` (`tradesPageQuery.ts:111`). Values are always `$n` parameters. | ✅ Low risk. Keep it enforced (see principles). |
| XSS | The only `dangerouslySetInnerHTML` is shadcn `ui/chart.tsx`, which is unused. The academy markdown renderer emits React nodes and no raw HTML. User URLs are sanitised server-side to http(s) by `safeHttpUrl` / `sanitizeMultiLineUrls`, which is implemented twice (`lib/safe-url.ts` and `lib/academyContent.ts:40`). There is one `document.write` with `esc()` in `components/stats/export.ts:92`. | ✅ Small surface. A 30-day localStorage token turns any future XSS into account takeover, though. |
| Uploads | Audio MIME allowlist, extension allowlist for broker files, in-memory storage, size limits. **xlsx 0.18.5** parses uploaded broker files. | Vulnerable library (see P0-3). |
| SSRF | Outbound fetches go only to fixed hosts (Yahoo, NASDAQ, SEC, RSS list, Telegram, the local whisper URL from env, the Replit sidecar `127.0.0.1:1106`). Tickers are regex-validated or `encodeURIComponent`'d, and every call has `AbortSignal.timeout`. | ✅ Low risk. |
| Secrets in URLs | Voice audio uses a 5-minute HMAC media token. The legacy `?access_token=<JWT>` is still accepted (`auth.ts` `QUERY_TOKEN_PATHS`). pino-http logs the URL **without the query string**. ✅ | Remove the legacy query-token path. |
| Crash policy | `process.on("uncaughtException")` logs and **keeps serving** (`index.ts:18`). | Unsafe per Node docs (see P1-4). |

### 1.6 Observability
- pino plus pino-http. Redaction covers `authorization`, `cookie` and `set-cookie`, and the request serializer drops the query string. ✅
- There are 309 `logger.*` calls and 40 leftover `console.*` calls in the server.
- **No error tracking** (no Sentry or equivalent, server or browser).
- No request id is returned to the client.
- `/api/healthz` returns a static `ok` and does not check the DB.
- **No SIGTERM handler or graceful shutdown**, so in-flight requests and crons are cut on every redeploy.
- The browser has a route-level `ErrorBoundary` (`components/shell/route-error-boundary.tsx`) but reports errors nowhere.

### 1.7 Backups (`lib/dbBackupCron.ts`)
- `pg_dump --format=plain | gzip -9` is **buffered fully in memory**, then uploaded to Replit Object Storage at `ws-lexx-backups/<ts>.sql.gz`.
- It runs every **48 h** (first run 3 min after boot) and keeps the **last 10**, about 20 days.
- Admins can list, trigger and download (15-minute signed URL; the name is validated against `..` and `/`). Each run writes an audit log entry.
- Gaps:
  - The RPO is 48 h.
  - Backups live in the same provider and account as the app, so there is **no off-site copy**.
  - Backups are not encrypted beyond provider defaults.
  - The DB URL, including the password, is passed on `pg_dump`'s argv.
  - There is **no restore drill** and **no failure alert**. A failed cron just logs.
  - Pruning sorts by name, which is correct because the names are ISO timestamps.

### 1.8 Git hygiene
- **Uncommitted work-in-progress: 315 modified and 26 untracked paths** in Project-Deploy, including all of `lib/text-search/`, `src/i18n/` and new tests. That is a single-disk loss risk. Commit it in logical slices.
- `.config/` is untracked and contains `.vscode-server`, `.semgrep`, `npm` and `replit` user state. It is **not in `.gitignore`**.
- **Tracked AI-agent skill bundles**: `.agents/` (388 files) and `.codex/` (28 files), 416 of 1,557 tracked files (27%). Also tracked: `skills-lock.json`, `main.py`, `pyproject.toml`, `replit.md`.
- On disk but gitignored: `db_backup_v3.sql` (203 KB), `accounts.db`, `db-backup/` (full dump plus CSVs; **`users.csv` holds plaintext 4–5 character passwords**), and `scripts/backups/prod-backup-*.json` (users/trades/playbook CSV). These are real data sitting in the repo folder, where they get copied into worktrees, zips and agents' context.
- Remotes and branches: **25 `subrepl-*` remotes** plus `gitsafe-backup`, and 45 branches (25 `subrepl-*`, 5 `claude/*`, `replit-agent`, `scripts-lf-eol`).
- Pack size **119 MB**. The bulk comes from historical `attached_assets/*.tcb` files (1.5 MB each) and `artifacts/ws-lexx-pitch/public/*.png`.
- **The "deleted replit/attached_assets/extracted_project noise" is not in this repo.** It lives in a **separate stale clone, `C:\Users\WS\Desktop\lexx\Web-Builder`**, with a different history: HEAD `bf4efbc` (2026-04-08) does not exist in Project-Deploy. That clone shows 1,279 deleted files, 3 modified (`vite.config.ts`, `drizzle.config.ts`, `scripts/package.json`) and 9 untracked (build outputs plus `scripts/src/local-db.ts`). It is an abandoned April working copy, so nothing needs fixing in Project-Deploy. Recommendation: archive it as a zip outside `Desktop/lexx`, then delete the folder (owner decision).

### 1.9 Secrets in git history

See the private owner notes; details intentionally not stored in the repo.

### 1.10 Dependency health
- **`pnpm audit`: 82 advisories (12 critical, 40 high, 25 moderate, 5 low) across 664 packages.** Split by where they actually run:
  - **Production runtime (api-server)**:
    - `multer 2.1.1`: 3 high DoS issues (crafted field names, array index), plus a moderate one. Fixed in **≥2.3.0** (latest 2.4.0). Reachable by any signed-in user via voice-note upload.
    - `xlsx 0.18.5`: prototype pollution (CVE-2023-30533) and ReDoS (CVE-2024-22363). The **npm package is abandoned, so no fixed version exists on npm.** Parses broker XLS/XLSX uploads (admin) and the PropReports performance report.
    - `express 5.2.1` → bundled `qs 6.15.1` (3 moderate DoS) and `body-parser 2.2.2` (low). Fixed by express 5.3.0.
    - `proxy-addr 2.0.7`: **critical** IP spoofing via IPv4-mapped IPv6 trust subnet. Only bites when `trust proxy` is set to a subnet, but it becomes relevant once P0-2 is fixed. Fixed via express 5.3.0, or override `proxy-addr >=2.0.8`.
    - `express-rate-limit 8.4.1` → `ip-address 10.1.0` (1 high, 4 moderate). Fixed by 8.7.1.
    - `@google-cloud/storage 7.19` → `fast-xml-builder`, `form-data` (high CRLF injection), `uuid`, `@tootallnate/once`. Fixed by v8 (a major bump) or overrides.
    - `pino-pretty` → `fast-copy` (moderate). Dev-only in practice.
  - **Root `package.json` dependencies that nothing imports**: `adm-zip 0.5.17` (7 high + 4 moderate) and `@replit/connectors-sdk`. **Delete both.**
  - **Build/dev-time**:
    - `orval 8.9.0`: **11 critical import-time RCE** issues plus 1 high SSRF. Exploitable only with a malicious spec; ours is self-authored, but upgrade to ≥8.22 anyway.
    - Through orval's tree: `typedoc`, `js-yaml`, `brace-expansion`, `fast-uri`, `markdown-it`, `linkify-it`.
    - **`vite 7.3.2`: `server.fs.deny` bypass on Windows** plus `launch-editor` NTLM disclosure. The owner develops on Windows, and the dev server binds `0.0.0.0` with `allowedHosts: true`, and `fs.deny: ["**/.*"]` is the only thing protecting `.env.local`. **Upgrade to ≥7.3.5 and bind to localhost.**
    - `esbuild 0.27.3` (Windows dev-server file read; we don't use `esbuild serve`), `postcss`, `nanoid`, `browserslist`, `@babel/core`, `source-map-js`.
- **`pnpm outdated -r`: 86 outdated, 20 behind a major version.** Notable majors: zod 3→4, recharts 2→3, vite 7→8, TypeScript 5.9→7.0 (the native compiler), @vitejs/plugin-react 5→6, react-day-picker 9→10, date-fns 3→4, react-resizable-panels 2→4, @hookform/resolvers 3→5, openai 6→7, pino 9→10, @google-cloud/storage 7→8, lucide-react 0.545→1.x, framer-motion 12→14, @anthropic-ai/sdk 0.78→0.135 (minor in semver terms, but far behind).
- **Deprecated**: `@types/bcryptjs` (bcryptjs 3 ships its own types) and `@types/express-rate-limit` (v8 ships its own types).
- **Unused or misplaced**:
  - api-server: `cookie-parser` (0 imports), `google-auth-library` (0 direct imports), and `@types/multer` listed under `dependencies`.
  - web: `react-icons` (0 imports).
  - The 27 unused shadcn `ui/*` files keep these packages alive: accordion, aspect-ratio, avatar, context-menu, hover-card, menubar, navigation-menu, progress, radio-group, scroll-area, toggle-group, `embla-carousel-react`, `input-otp`, `react-resizable-panels`, plus `ui/sonner` (`sonner` may still be used elsewhere).
  - `lib/integrations-openai-ai-server`: a whole package with no consumers.
  - `knip` could not be run via `dlx` (resolution error), so these findings come from manual import counts.

---

## 2. Problems ranked by impact

### P0: security, act now

**P0-1. Leaked secrets and plaintext passwords in git history (§1.9).** Evidence: older commits (details in private owner notes).
→ The owner rotates everything in the §1.9 list. A history rewrite is optional (see the owner decision in Phase 0). Rotating first is mandatory either way.

**P0-2. Login brute-force protection is mis-keyed and can also lock out the whole desk.**
Evidence: `app.ts` never sets `trust proxy`.
- Behind Replit's proxy `req.ip` is the proxy's address, so the `/auth/login` limiter (10 requests per 15 min, **counting successful logins too**) is one bucket shared by everyone. A morning wave of 25 traders logging in can produce 429s. express-rate-limit v7+ also logs `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` in this setup.
- Even once `trust proxy` is set, the whole office probably sits behind one public NAT IP. The limit is per IP, not per account.
- With 6-digit PINs and a public roster that includes the admin's name and role (`GET /users`), one attacker on a rotating IP pool gets 40 tries per hour per IP against the admin.

→ Fix:
- Set `app.set("trust proxy", 1)`, after verifying the hop count on Replit by logging `req.ips` once.
- Key the login limiter by `ip + lowercased name`, with `skipSuccessfulRequests: true`.
- Add a **per-account** progressive lockout persisted in the DB (for example 5 failures leads to a 15-minute lock, then doubling), and audit-log each lock.
- Require at least 10-character passwords for curators and admins.

**P0-3. Vulnerable runtime libraries.**
- `multer` (DoS reachable by any member) → `^2.4.0`.
- `xlsx@0.18.5` (prototype pollution and ReDoS on uploaded files) → switch to the official SheetJS tarball `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (the vendor's documented distribution). Alternatively replace it with `exceljs` for `.xlsx` plus a CSV parser. The XLSX parse sites are `lib/propreports/parse-trades-report.ts`, `parse-performance-report.ts` and `scripts/src/lib/parse-propreports.ts`.
- `express` → `^5.3.0` (qs, body-parser, proxy-addr).
- `express-rate-limit` → `^8.7.1`.
- Delete root `adm-zip` and `@replit/connectors-sdk`.

**P0-4. Vite dev server exposure on Windows.** `vite 7.3.2` has an fs.deny bypass on Windows, and the server is bound to `0.0.0.0` with `allowedHosts: true`. Anyone on the same Wi-Fi or LAN could read `.env.local` (`JWT_SECRET`) while dev is running.
→ Bump vite to ≥7.3.5 (the catalog entry is `^7.3.2`, so `pnpm update vite` within range works). Default `host` to `127.0.0.1` and opt into `0.0.0.0` with `HOST=0.0.0.0`.

### P1: security hardening and correctness

**P1-1. No CSP, and index.html headers are outside our control** (Replit static service). Combined with the 30-day localStorage token, any XSS becomes account takeover.
→ Add a `<meta http-equiv="Content-Security-Policy">` to `index.html`, or make the API the single production service so helmet covers HTML. The proposed policy is in §5. Start with report-only on the API (`Content-Security-Policy-Report-Only`) for a week.

**P1-2. Token lifetime.** 30-day bearer tokens in localStorage.
→ Reduce `TOKEN_TTL` to **7 days with sliding re-issue**: `/auth/me` returns a fresh token when the current one is more than 24 h old. Remove the legacy `?access_token=` path (`QUERY_TOKEN_PATHS`), since the HMAC media tokens replace it. Add `algorithms: ["HS256"]` to `jwt.verify`. Moving to httpOnly cookies plus CSRF is possible but costs effort L; not worth it for an internal app once CSP is in place. Record it as an ADR.

**P1-3. Global 10 MB JSON/urlencoded parser runs before the auth gate.**
→ Make the defaults `express.json({ limit: "256kb" })` and drop `urlencoded` entirely (grep shows no form posts). Keep explicit larger parsers on the few routes that need them (plan media already uses `express.raw`; check AI and import routes).

**P1-4. `uncaughtException` keeps the process alive** (`index.ts:18`), and failed migrations are ignored (`startServer`). Node's docs say it is not safe to resume after an uncaught exception.
→ On `uncaughtException`: log, flush, `process.exit(1)`, and let Replit restart. Keep `unhandledRejection` as log-only, but count it. On migration failure in production, **refuse to start** (exit 1) rather than serve against a half-migrated schema.

**P1-5. CORS is fragile and unnecessary.** Rejected origins return 500, and the allowlist misses the custom domain.
→ In production use `cors({ origin: false })`, or simply don't mount `cors` (same-origin SPA plus bearer tokens need no CORS). Keep permissive CORS only in dev for the `API_TARGET` second-instance setup. If a cross-origin consumer ever appears, use an `APP_ORIGINS` env allowlist and `credentials: false`.

**P1-6. Secret coupling and missing env validation.** `MEDIA_TOKEN_SECRET` and `TELEGRAM_WEBHOOK_SECRET` derive from `JWT_SECRET`, and there is a literal fallback secret.
→ A `lib/config.ts` zod schema parsed once at boot (production requires `JWT_SECRET ≥ 32 chars`, a distinct `MEDIA_TOKEN_SECRET`, a distinct `TELEGRAM_WEBHOOK_SECRET` when `TELEGRAM_BOT_TOKEN` is set, and `DATABASE_URL`). Delete the fallbacks. Add `.env.example` listing all ~40 vars with comments. The 19 files then import `config` instead of reading `process.env`.

**P1-7. No deploy gate.** Replit builds whatever is in the workspace: no type-check, no tests, no audit.
→ CI on GitHub (Phase 1). Replit's build should also run `pnpm run typecheck` before `build-prod.sh`; it costs about 35 s.

### P2: data integrity and operations

**P2-1. Backups:** 48 h RPO, single provider, no restore test, no alert, the whole dump in RAM.
→ Run daily. Keep 14 daily plus 8 weekly. Stream (`pg_dump | gzip | bucket.file().createWriteStream()`). Pass the password via `PGPASSWORD` env, not argv. Encrypt with `age` before upload, and keep the private key offline with the owner. Copy off-site weekly (Backblaze B2, S3 or the owner's Google Drive). Send a Telegram message to admins on failure. Add a monthly restore drill script (`scripts/restore-dump.ts` into embedded Postgres) that runs a smoke query. Check whether Replit's managed Postgres plan offers point-in-time restore; if it does, that becomes the primary path and dumps become the off-site copy.

**P2-2. Uncommitted work-in-progress (315 M plus 26 ??)** risks being lost and blocks any CI or blame strategy. → Commit in slices before anything else in Phase 1.

**P2-3. No graceful shutdown:** redeploys cut in-flight writes (PropReports sync, backup upload). → A SIGTERM handler: `server.close()`, stop crons, `pool.end()`, with a 10 s hard timeout.

**P2-4. No error tracking.** Crashes are visible only in Replit logs. → Sentry (free tier) for server and browser with `sendDefaultPii: false` and a `beforeSend` that strips `Authorization` and query strings. Alternative: a self-hosted GlitchTip. Add a deep health check (`/api/healthz?deep=1` runs `SELECT 1`) and use it for the Replit startup health check.

### P3: maintainability and developer experience
- **P3-1.** No linter or formatter. The code has never been formatted (212 of 217 api files, 3,535 lines over 200 characters). There is no shared rule for promise handling, unused vars or hooks.
- **P3-2.** The tsconfig reference graph is inconsistent (§1.1). Web test files are not type-checked. `strictFunctionTypes: false`.
- **P3-3.** Dead packages and code: `lib/integrations-openai-ai-server`, 27 unused `ui/*` files, `react-icons`, `cookie-parser`, `google-auth-library`, deprecated `@types/*`, duplicate `safeHttpUrl`, `scripts/src/hello.ts`.
- **P3-4.** Catalog drift (`wouter`, `vitest`, `esbuild` outside the catalog); pnpm and Node not pinned.
- **P3-5.** Repo noise: tracked `.agents/` and `.codex/`, Replit Python template files, stale `MIGRATION.md`, 25 sub-repl remotes and branches, untracked `.config/`, real data dumps inside the working folder.
- **P3-6.** The api dev loop has no watch mode and uses Linux-only `fuser`. Windows developers need `.claude/launch.json` tricks.
- **P3-7.** Schema DDL is scattered across 34 files (`CREATE TABLE IF NOT EXISTS` in routes) plus `migrate.ts` (1,396 lines). The DB report covers this; tooling-wise there is no migration check in CI.

---

## 3. Target principles (enforceable, sized for one owner plus agents)

1. **One command proves a commit is shippable**: `pnpm verify` = `biome ci` + `typecheck` + `test` + `build:prod`. CI runs exactly this, and Replit's build runs `typecheck` at minimum. Nothing merges to `main` red.
2. **Ratchets, not big bangs.** New checks start with a baseline file (the `check-z.mjs` pattern) or with `--changed`. Debt may shrink, never grow. This applies to lint, i18n Cyrillic counts, z-index and audit findings.
3. **Formatting is mechanical and lives in one commit.** One formatter (Biome), one reformat commit listed in `.git-blame-ignore-revs`, after which formatting is never discussed again.
4. **Secrets live only in Replit Secrets or `.env.local`.** They are validated at boot by `lib/config.ts`, never derived from one another, never in URLs, and never in the repo or its working folder (no dumps under `Project-Deploy/`). gitleaks runs in CI on every push.
5. **Every `/api` route is authenticated unless it is in `PUBLIC_API_ROUTES`** (already true; keep it). Every public route has a rate limit. Every mutation that takes a body has a zod schema and the default 256 KB limit unless it opts out explicitly.
6. **SQL values are always `$n` parameters. Identifiers come only from a typed `Record<Enum, string>` map.** Grep-check in CI: no `${req.` inside a `query(` template.
7. **User URLs pass `safeHttpUrl` on write** (one implementation in `lib/safe-url.ts`). There is no `dangerouslySetInnerHTML` outside `components/ui/chart.tsx` (enforced by a Biome rule with an override).
8. **Dependencies:** the catalog holds every version shared by 2 or more packages. Renovate opens grouped PRs weekly after a 3-day release age. Security PRs come immediately. Runtime high/critical advisories block CI; dev-only ones warn.
9. **Fail closed on boot:** missing config, failed migrations or an uncaught exception all lead to exit, and the supervisor restarts. Errors go to the tracker with PII stripped.
10. **Backups are proven by restores:** daily, encrypted, off-site, with a monthly automated restore smoke test and alerts on failure.

---

## 4. Migration plan

Legend: Effort S (≤2 h) / M (≤1 day) / L (several days). "Wave" means the upcoming translation wave that touches nearly every UI file.

### Phase 0: owner actions (security, today; not code)

| # | What | Effort | Before/after wave |
|---|---|---|---|
| 0.1 | Rotate the Telegram bot token (BotFather `/revoke`), all user PINs and passwords (force a reset for every user; bumping `token_version` for all users logs everyone out), `ADMIN_PASSWORD`, `PLAYBOOK_PASSWORD`, `JWT_SECRET` (set separate `MEDIA_TOKEN_SECRET` and `TELEGRAM_WEBHOOK_SECRET` at the same time), and AI/PropReports/Resend keys if they were ever outside Secrets. | S | Independent |
| 0.2 | Delete local data copies from the working folder: `db_backup_v3.sql`, `accounts.db`, `db-backup/`, `scripts/backups/*.json`. Move whatever is still needed into an encrypted archive outside `Desktop/lexx`. | S | Independent |
| 0.3 | **Decision: rewrite history or not.** Option A (recommended for now): rotation only, plus gitleaks in CI. Option B: `git filter-repo` to drop `db-backup/`, `*.sql`, `accounts.db`, `attached_assets/`, `artifacts/ws-lexx-pitch/public/*.png` and the binance README blob. That shrinks the 119 MB pack, but requires a force-push, re-cloning every Replit sub-repl and worktree, and deleting the 25 `subrepl-*` remotes. If B, do it **after** the wave, when no long-lived branches are open. | B is M | After |
| 0.4 | Archive and delete the stale `C:\Users\WS\Desktop\lexx\Web-Builder` clone (its only unique-looking file is `scripts/src/local-db.ts`; compare it with Project-Deploy's version first). | S | Independent |

### Phase 1: repo hygiene and a safety net (before the wave)

| # | What | Files | Effort | Risk | Verify |
|---|---|---|---|---|---|
| 1.1 | Commit the work in progress in logical slices (text-search, i18n foundation, leftovers). | all | S | low | `git status` clean |
| 1.2 | `.gitignore`: add `.config/`, `.claude/worktrees/`, `*.local.json`, `db-backup/`, `scripts/backups/` (already partly covered), `*.dump`, `*.sql.gz`. Untrack `.agents/` and `.codex/` (owner decision: keep them only if agents in Replit need them; otherwise `git rm -r --cached` and add to `.gitignore`). Remove `main.py`, `pyproject.toml`, `scripts/src/hello.ts`. | `.gitignore` | S | low | `git ls-files \| wc -l` drops by about 420 |
| 1.3 | Pin the toolchain: root `package.json` gets `"packageManager": "pnpm@10.34.7"` and `"engines": { "node": ">=24 <25" }`. Add `.nvmrc` (`24`). | root | S | low | `pnpm -v` on Replit matches |
| 1.4 | Dependency security pass, all within semver or near it: `multer ^2.4.0`, `express ^5.3.0`, `express-rate-limit ^8.7.1`, `vite ^7.3.5` (catalog), `orval ^8.43` (then run codegen and diff; codegen is a separate, reviewed step), the xlsx tarball. Remove root `adm-zip` and `@replit/connectors-sdk`, `@types/bcryptjs`, `@types/express-rate-limit`, `cookie-parser`, `google-auth-library`, `react-icons`. Move `@types/multer` to devDependencies. Add overrides `proxy-addr: ">=2.0.8"` and `form-data@<2.5.6: ">=2.5.6"` until `@google-cloud/storage` 8. | package.json ×4, workspace yaml | M | medium (orval output diff, xlsx API is the same) | `pnpm audit --prod --audit-level high` returns 0; all 1,587 tests pass; PropReports parser tests pass |
| 1.5 | Delete dead code: `lib/integrations-openai-ai-server`, the 27 unused `components/ui/*.tsx` files and their Radix deps. **Do this before the wave** so nobody translates dead files. | web, lib | S | low | typecheck plus build |
| 1.6 | Add **CI** (`.github/workflows/ci.yml`, §5.2): install, `biome ci` (lint-only, see 1.7), typecheck, test with a Postgres service, `build:prod`, gitleaks, `pnpm audit --prod` (warn), `check-z`, `check-permissions`, and the i18n ratchet. | `.github/` | S–M | low | A green run on a PR |
| 1.7 | **Biome, lint-only**: `biome.json` (§5.1) with `formatter.enabled: false`, a correctness-focused rule set, and `biome ci --changed` in CI so only touched files are linted. This creates no churn, so it is safe to land before the wave. | root | S | low | `pnpm lint` runs in under 2 s |
| 1.8 | Root scripts: `verify`, `lint`, `format`, `check:z`, `check:perm`, `i18n:check`, and `test:types` (type-check tests via `tsconfig.test.json`). | root, web | S | low | `pnpm verify` green |
| 1.9 | Renovate (`renovate.json`, §5.3), or Dependabot security-only if the owner prefers zero PR noise. | `.github/` | S | low | Dependency Dashboard issue appears |

### Phase 2: runtime security fixes (server-only, safe in parallel with the wave)

| # | What | Files | Effort | Verify |
|---|---|---|---|---|
| 2.1 | `trust proxy` + login limiter keyed by `ip+name` with `skipSuccessfulRequests` + per-account lockout table + audit. | `app.ts`, `routes/auth.ts`, `migrate.ts` (new `login_attempts`) | M | Unit test: 6 bad PINs → 423/429 on that name only; another name is unaffected; one successful login does not count |
| 2.2 | `lib/config.ts` (zod env), `.env.example`, remove derived and fallback secrets, boot fail-fast. | 19 files read env | M | Boot with a missing var exits 1 with a clear message; tests set env in `test-setup.ts` |
| 2.3 | JSON limit 256 KB default plus per-route overrides; drop `urlencoded`. | `app.ts` + any big-body routes | S | A 300 KB POST to `/api/trades` returns 413; voice and plan-media still work |
| 2.4 | JWT: `algorithms:["HS256"]`, 7-day TTL plus sliding refresh on `/auth/me`, remove `?access_token`. | `lib/auth.ts`, `routes/auth.ts`, `voice-note-player.tsx` (already uses media URLs) | S–M | Existing auth tests; a manual voice note still plays |
| 2.5 | CORS off in production (same-origin). | `app.ts` | S | A production smoke test of login + mutation on the custom domain |
| 2.6 | Crash policy: exit on `uncaughtException`; exit on migration failure in production; SIGTERM graceful shutdown. | `index.ts` | S | `kill -TERM` in dev drains requests |
| 2.7 | CSP: report-only header on the API plus a `<meta>` CSP in `index.html` (§5.5). Enforce after a week of clean reports. Remove `crossOriginResourcePolicy: "cross-origin"` unless something needs it. | `app.ts`, `index.html` | S + soak | DevTools shows no CSP violations across all pages (TradingView snapshots, YouTube/Vimeo/Loom/Rutube embeds, Google Fonts) |
| 2.8 | Decide one production server for the SPA: either drop the Replit static `web` service so Express serves `/` (helmet applies and there is one build), or drop the copy in `build-prod.sh`. Recommend **Express serves everything** (simpler headers, one artifact). | `artifact.toml` ×2, `build-prod.sh` | S | Deploy preview: `curl -I /` shows helmet headers |

### Phase 3: observability and backups (any time)

| # | What | Effort |
|---|---|---|
| 3.1 | Sentry (server: `@sentry/node`; web: `@sentry/react` + ErrorBoundary hook). Scrub PII, sample traces at 0. Releases tagged with the git SHA from the build. | M |
| 3.2 | Request id: pino-http `genReqId` (uuid) plus an `X-Request-Id` response header. The error JSON includes `requestId` so traders can quote it. Replace the 40 `console.*` calls with `logger`. | S |
| 3.3 | `/api/healthz?deep=1` (DB `SELECT 1`, migrations version); Replit health check points at it. | S |
| 3.4 | Backups v2 (P2-1): daily, streamed, `age`-encrypted, off-site weekly, Telegram alert on failure, `pnpm --filter scripts restore-drill`. | M |

### Phase 4: after the translation wave

| # | What | Effort | Why after |
|---|---|---|---|
| 4.1 | **One-shot format**: enable the Biome formatter (`lineWidth: 140`, double quotes, semicolons, which matches the current style), run `biome format --write .`, commit as "chore: format", and add the SHA to `.git-blame-ignore-revs`. | S (mechanical) | Reformatting every file before or during the wave would conflict with every translation edit. |
| 4.2 | Turn on more lint rules (style group), then flip CI from `--changed` to the full repo once the count is 0. | M | |
| 4.3 | tsconfig cleanup: decide between the "internal packages, raw TS" pattern (drop `composite`/`references`/`typecheck:libs`; consumers type-check the source) and full references. **Recommend raw TS**, which is the pattern already used for exports. Turn on `strictFunctionTypes`; add `tsconfig.test.json` for web tests. | M | Touches many files' types |
| 4.4 | Major upgrades, one PR each, in this order: `@google-cloud/storage 8` → `pino 10`/`pino-http 11` → `zod 4` (api-zod codegen plus 28 server files; orval supports zod 4) → `recharts 3` (22 files) → `vite 8` + `plugin-react 6` → `date-fns 4` → `react-day-picker 10` → TypeScript 7 (native; expect much faster type-checks; adopt once `tsc`-compatible flags are confirmed). | L total | Each touches UI files |
| 4.5 | api-server dev DX: `tsx watch src/index.ts` (or `node --watch` on the esbuild output) in place of build+start; drop `fuser`; cross-platform port handling. | S | Can be earlier; low conflict |
| 4.6 | Docs: one `README.md` (local dev on Windows, seed demo, env table generated from `config.ts`), `DEPLOY.md` (Replit only), delete `MIGRATION.md` (Supabase era) and `replit.md` (or fold them in). Add `docs/adr/` with: 0001 bearer token in localStorage plus CSP, 0002 raw SQL with parameter discipline, 0003 Biome, 0004 backups. | M | |

Owner decisions flagged: 0.3 (history rewrite), 1.2 (untrack `.agents/` and `.codex/`), 1.9 (Renovate vs Dependabot), 2.8 (single production service), 3.1 (Sentry SaaS vs self-host; data leaves the desk), and the password policy for curators and admins (2.1).

---

## 5. Concrete config proposals

### 5.1 `biome.json` (Phase 1: lint-only; Phase 4: formatter on)
Why Biome over ESLint+Prettier for this repo: one devDependency instead of about 8, sub-second runs on about 1,100 files, nested config for the monorepo, built-in React hooks rules (`useExhaustiveDependencies`, `useHookAtTopLevel`), and the floating-promise check (`noFloatingPromises`) without a typescript-eslint program. The gap is fewer framework plugins, which this codebase doesn't need, since it has no Next.js or framework-specific rules. Type safety stays with `tsc`.
```jsonc
{
  "$schema": "https://biomejs.dev/schemas/2.x/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true, "defaultBranch": "main" },
  "files": { "includes": ["**", "!**/dist", "!**/generated", "!lib/api-zod/src/**", "!pnpm-lock.yaml", "!.agents", "!.codex"] },
  "formatter": { "enabled": false, "lineWidth": 140, "indentStyle": "space", "indentWidth": 2 },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always", "trailingCommas": "all" } },
  "assist": { "actions": { "source": { "organizeImports": "off" } } },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": false,
      "correctness": {
        "noUnusedVariables": "warn", "noUnusedImports": "warn",
        "useExhaustiveDependencies": "warn", "useHookAtTopLevel": "error",
        "noUndeclaredVariables": "off"
      },
      "suspicious": {
        "noDoubleEquals": "error", "noFallthroughSwitchClause": "error",
        "noAsyncPromiseExecutor": "error", "noDebugger": "error", "noConsole": { "level": "warn", "options": { "allow": ["warn", "error"] } }
      },
      "security": { "noDangerouslySetInnerHtml": "error", "noGlobalEval": "error" },
      "nursery": { "noFloatingPromises": "warn" }
    }
  },
  "overrides": [
    { "includes": ["artifacts/edge-tracker/src/components/ui/chart.tsx"], "linter": { "rules": { "security": { "noDangerouslySetInnerHtml": "off" } } } },
    { "includes": ["scripts/**", "**/*.test.ts", "**/__tests__/**"], "linter": { "rules": { "suspicious": { "noConsole": "off" } } } }
  ]
}
```
Root scripts: `"lint": "biome lint ."`, `"lint:ci": "biome ci --changed --since=origin/main"`, and in Phase 4 `"format": "biome format --write ."`. Remove `prettier` from the root devDependencies when Biome lands. Check the exact rule group names against the installed Biome 2.x version, because rule groups shift between minors.

### 5.2 `.github/workflows/ci.yml`
```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
permissions: { contents: read }
jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: postgres, POSTGRES_DB: edge_tracker }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s --health-retries 10
    env:
      TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/edge_tracker
      JWT_SECRET: ci-only-not-a-secret-ci-only-not-a-secret
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }            # biome --changed + gitleaks need history
      - uses: pnpm/action-setup@v4          # reads "packageManager" from package.json; v6 is current, either works
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run lint:ci
      - run: pnpm run typecheck
      - run: pnpm run test
      - run: pnpm --filter @workspace/edge-tracker run lint:z
      - run: node artifacts/api-server/scripts/check-permissions.mjs
      - run: pnpm --filter @workspace/edge-tracker run i18n:report -- --check src  # once the wave baseline exists; use a ratchet file like check-z
      - run: pnpm run build:prod
      - name: audit (runtime deps)
        run: pnpm audit --prod --audit-level high
        continue-on-error: true             # flip to blocking after Phase 1.4
  secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
        env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
```
Notes:
- Run a one-off full-history gitleaks scan locally (`gitleaks git --log-opts="--all" -r report.json`). Allowlist only the known test DSNs (`postgres:postgres@localhost`) in `.gitleaks.toml`. Never allowlist the real Telegram token.
- On a private repo, GitHub Free includes 2,000 Actions minutes per month. This pipeline takes about 3–4 minutes per run.
- Optionally pin actions by SHA (Renovate keeps the SHAs updated).
- Replit deploys from the Replit workspace, not from GitHub, so the gate is procedural: deploy only from a green `main`.

### 5.3 `renovate.json`
```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", ":dependencyDashboard", "helpers:pinGitHubActionDigests"],
  "schedule": ["before 9am on monday"],
  "timezone": "Asia/Tashkent",
  "minimumReleaseAge": "3 days",
  "rangeStrategy": "bump",
  "lockFileMaintenance": { "enabled": true, "schedule": ["before 9am on the first day of the month"] },
  "vulnerabilityAlerts": { "enabled": true, "schedule": ["at any time"], "minimumReleaseAge": null },
  "packageRules": [
    { "matchUpdateTypes": ["major"], "dependencyDashboardApproval": true },
    { "groupName": "radix", "matchPackageNames": ["@radix-ui/**"] },
    { "groupName": "tanstack", "matchPackageNames": ["@tanstack/**"] },
    { "groupName": "vite+vitest", "matchPackageNames": ["vite", "vitest", "@vitejs/**", "@tailwindcss/**", "tailwindcss"] },
    { "groupName": "types", "matchPackageNames": ["@types/**"], "matchUpdateTypes": ["minor", "patch"], "automerge": true },
    { "groupName": "replit", "matchPackageNames": ["@replit/**"] },
    { "matchManagers": ["pip_requirements"], "enabled": false }
  ]
}
```
Renovate updates `catalog:` entries in `pnpm-workspace.yaml` directly. Our own `minimumReleaseAge: 1440` in pnpm stays as the second gate. Timezone is the owner's choice; desk hours follow the US market.

### 5.4 `app.ts` hardening sketch (Phase 2)
```ts
app.set("trust proxy", 1);                         // verify hop count once by logging req.ips on Replit
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: { reportOnly: true, directives: CSP }, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: "256kb" }));         // per-route larger parsers where needed; no urlencoded
if (!isProd) app.use(cors());                      // prod: same-origin, no CORS layer
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: 10, skipSuccessfulRequests: true, standardHeaders: "draft-8", legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? "")}:${String(req.body?.name ?? "").trim().toLowerCase()}`,
});
app.use("/api/auth/login", express.json({ limit: "4kb" }), loginLimiter);
// + per-account lockout in routes/auth.ts (DB table login_attempts(name, failures, locked_until))
```

### 5.5 CSP (start as report-only)
```
default-src 'self';
script-src 'self' 'sha256-<hash of the inline theme script in index.html>';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
img-src 'self' data: blob: https:;                 # user screenshot URLs + TradingView snapshots
media-src 'self' blob:;
connect-src 'self';
frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://www.loom.com https://rutube.ru https://www.tradingview.com;
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none';
```
Notes:
- `'unsafe-inline'` for styles is needed because React `style=` attributes and Recharts emit inline styles. This is acceptable; the important part is that scripts are locked.
- Self-hosting Inter and IBM Plex Mono (via `@fontsource`) would remove the Google domains entirely and stop the per-pageload font request to Google.

### 5.6 OWASP ASVS 5.0 "lite" checklist for this app (L1 plus a few L2 items)

| ASVS area | Item | Status |
|---|---|---|
| V6 Authentication | Brute-force protection per account, not just per IP | ❌ (P0-2) |
| V6 | Credentials not hard-coded or in the repo; default credentials rotated | ❌ history (P0-1) |
| V6 | Minimum secret length for privileged roles | ❌ 6-digit PINs |
| V7 Sessions | Absolute and idle timeouts; revocation on logout and password change | ⚠️ revocation ✅, TTL 30 d |
| V8 Authorization | Server-side, deny-by-default, central gate | ✅ `apiAuthGate` + capabilities |
| V1/V2 Encoding and validation | Parameterised SQL; schema validation on bodies; URL scheme allowlist | ✅ (keep enforcing) |
| V3 Web frontend | CSP, `frame-ancestors`, `nosniff`, HSTS | ❌ CSP / ⚠️ HTML headers outside Express |
| V4 API | Body size limits; rate limits on expensive endpoints | ⚠️ 10 MB global; AI and voice ✅ |
| V5 Files | Type and size allowlists; parsers patched | ⚠️ xlsx vulnerable |
| V11 Crypto | Distinct secrets per purpose; HMAC compared in constant time | ⚠️ derived secrets / ✅ `timingSafeEqual` |
| V13 Config | Secrets via env, validated at boot; no debug in production | ⚠️ no central validation |
| V14 Data protection | Backups encrypted and off-site; no data dumps in the repo | ❌ |
| V16 Logging | Security events logged (login fail, lock, role change); no secrets in logs; alerting | ⚠️ login failures not audited; redaction ✅ |
| V15 Secure coding | Dependency inventory, SCA in CI, update policy | ❌ (Phase 1) |

---

## 6. Quick wins (each ≤1 h)

1. Add `.config/` and `.claude/worktrees/` to `.gitignore`. Delete `main.py`, `pyproject.toml`, `scripts/src/hello.ts`.
2. `pnpm remove adm-zip @replit/connectors-sdk -w`; remove `cookie-parser`, `google-auth-library`, `@types/bcryptjs` and `@types/express-rate-limit` (api) and `react-icons` (web). Move `@types/multer` to devDependencies.
3. Bump `multer ^2.4.0`, `express ^5.3.0`, `express-rate-limit ^8.7.1`, and the catalog entry `vite ^7.3.5`. Run tests.
4. `vite.config.ts`: `host: process.env.HOST ?? "127.0.0.1"`; load `runtimeErrorOverlay()` only in dev.
5. `app.set("trust proxy", 1)`, plus `skipSuccessfulRequests: true` on `loginLimiter`.
6. `jwt.verify(token, SECRET, { algorithms: ["HS256"] })`.
7. `express.json` default limit `256kb`; delete the `urlencoded` line (check that nothing posts forms).
8. `uncaughtException` handler: log, then `process.exit(1)`.
9. Add `"packageManager": "pnpm@10.34.7"`, `engines.node`, and `.nvmrc`.
10. Wire `check-permissions.mjs` and `check-z.mjs` into root `package.json` scripts.
11. Delete `lib/integrations-openai-ai-server` and add `lib/text-search` to the api and web tsconfig `references` (or drop references per 4.3).
12. Merge the duplicate `safeHttpUrl` (`lib/academyContent.ts:40` → import from `lib/safe-url.ts`).
13. Prune the 25 `subrepl-*` remotes and local branches plus the merged `claude/*` branches (`git remote remove`, `git branch -d`). Owner confirms first.
14. Add the `ci.yml` from §5.2 with audit set to non-blocking.

---

## Sources
- Biome v2 vs ESLint+Prettier (2026 comparisons): [Better Stack guide](https://betterstack.com/community/guides/scaling-nodejs/biome-eslint/), [noqta Biome 2 guide 2026](https://noqta.tn/en/blog/biome-2-all-in-one-toolchain-formatter-linter-guide-2026), [two-repo migration report](https://dev.to/ahmed_mahmoud360/i-replaced-eslint-and-prettier-with-biome-on-two-production-repos-2m2a)
- pnpm `minimumReleaseAge` and Renovate interplay: [project dependency notes](https://next.tangled.org/lukebennett.dev/luke-ui/blob/main/docs/DEPENDENCIES.md); `pnpm/action-setup` reading `packageManager`, with cache: [pnpm/action-setup docs mirror](https://docsearch.algolia.com/mcp/docs/repo/pnpm/action-setup), [action-setup v4 tag](https://gitea.wp-staging.com/pnpm/action-setup/src/tag/v4)
- express-rate-limit behind proxies (`trust proxy`, `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`): [GoogleCloudPlatform issue #3583](https://github.com/GoogleCloudPlatform/nodejs-docs-samples/issues/3583), [n8n community thread](https://community.n8n.io/t/x-forwarded-for-header-is-set-but-the-express-trust-proxy-s/51208?tl=en)
- OWASP ASVS 5.0 (May 2025, about 350 requirements in 17 chapters): [SoftwareMill: what's new in ASVS 5.0](https://softwaremill.com/whats-new-in-asvs-5-0/), [Intertek announcement](https://assuranceinaction.intertek.com/post/102kghm/owasp-release-version-5-0-of-the-application-security-verification-standard-asvs)
- Gitleaks and secret rotation order (rotate first, then optionally rewrite history; full-history scan with `--log-opts=--all`): [OneUptime gitleaks guide 2026](https://oneuptime.com/blog/post/2026-01-25-secret-scanning-gitleaks/view), [Secrets in git history](https://cyan-ai-shine.lovable.app/resources/secrets-in-git-history)
- Node.js `uncaughtException` ("not safe to resume normal operation"): [Node.js process docs](https://nodejs.org/download/rc/v6.14.2-rc.1/docs/api/process.html)
- Vulnerability data: local `pnpm audit --json` (GitHub Advisory DB) and `pnpm outdated -r`, run 2026-10-17. SheetJS fixed builds are distributed via cdn.sheetjs.com (linked from the audit references for CVE-2023-30533).
