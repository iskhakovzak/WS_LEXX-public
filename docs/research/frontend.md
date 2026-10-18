# Frontend architecture research: artifacts/edge-tracker

Read-only pass, 2026-10-17. Commands I ran: `tsc --noEmit` (clean, 22 s), `vitest run` (52 files, 646 tests, all passing, 3.2 s), `knip@5` (output in `scratchpad/fe_knip.txt`), and a production `vite build` written to `scratchpad/fe_build` with sourcemaps, not to the repo. A custom TypeScript-AST script (`scratchpad/fe_analyze.cjs`, output `scratchpad/fe_graph.json`) gave the import graph, layering, cycles, function sizes and unused exports. All counts below exclude `*.test.ts` unless stated otherwise.

> **Correction to the brief:** the app already runs on **React 19.1.0** (catalog pins `react: 19.1.0`, `@types/react ^19.2`), not React 18. Other versions: TanStack Query 5.100.7, Vite 7.3.2, wouter 3.9.0, Tailwind 4.2.4, recharts 2.15.4, zod 3.25.76, framer-motion 12.38, react-hook-form 7.74, TypeScript 5.9.3.
>
> **In flight right now:** 283 modified and 21 untracked files under `artifacts/edge-tracker` are not committed (i18n foundation plus leftovers). No file move may start until that tree is committed.

---

## 1. Current state map

### 1.1 Size and folder layout
- `src/` has 771 TS/TSX files and about 165k lines, 11 MB on disk. Lines are dense: 2,686 lines are longer than 200 characters and 317 are longer than 300.
- `src/pages/`: 50 route files, 18.8k lines. These are not thin. 12 page components are longer than 400 lines (see 1.8).
- `src/components/`: **51 sub-folders, in practice one per feature** (playbook 33 files / 7.7k lines, chart-engine 52 / 6.7k, notes 22 / 5.8k, academy 23 / 4.9k, trades, risk, game-plan, admin…). There are also **31 loose root files** (12.5k lines) that belong to features: `add-to-playbook.tsx`, `playbook-*.tsx` ×6, `trade-chart.tsx`, `morning-checkin.tsx`, `global-search.tsx`, `screenshot-fields.tsx`, and others.
- Shared UI comes in three places:
  - `components/ui/`: shadcn, 55 files. **28 of them are never imported**.
  - `components/ds.tsx`: a 1,300-line design-system file. It is the second-highest fan-in file (387 importers) and holds `PageHeader`, `Panel`, `StatCard`, `DataTable`, `EmptyState`, `usePersistentState`, `Sparkline` and more.
  - `components/ds/` folder: `states`, `motion`, `virtual`, `term-tooltip`.
  - A file and a folder share the name `ds`, so `@/components/ds` resolves to the file.
- `lib/`: 24 files plus `lib/ask/`. These are mostly pure (`trade-math`, `trading-date`, `api-errors`, `query-keys`, `permissions`). `lib/api.ts` is only `BASE` plus `apiUrl()`.
- `hooks/`: 5 files. `use-trades-page.ts` (604 lines) is really trades-feature code.
- `contexts/`: auth and theme only. `i18n/` holds the new foundation; it is adopted by 9 files so far.

### 1.2 Dependency direction (static imports, non-test)

| Edge kind | Count |
|---|---|
| feature → feature (same folder) | 1,227 |
| feature → shared-ui (ui/ds) | 691 |
| feature → lib | 601 |
| **feature → root-components** | **393** |
| page → feature | 366 |
| **feature → *other* feature** | **184 edges, 71 pairs** |
| root-components → feature | 21 |
| lib/hooks/shared → feature (upward) | 4 |

- **Upward violations (4):**
  - `lib/trade-result.ts → components/ds.tsx` (lib imports UI)
  - `hooks/use-trades-page.ts → components/trades/{trade-utils,review-presets}`
  - `components/ds/states.tsx → components/query-error.tsx`
- **Top cross-feature pairs:**
  - `playbook → playbook-sub` 15 (`playbook-sub` is a one-file folder that should be merged)
  - `watchlist → chart-engine` 10, `big7 → chart-engine` 7
  - `eod → journal` 9
  - `simulator → analytics-page` 7
  - `equity-chart → equity-candles` 7
  - `* → rules` about 40 in total
  - `* → people` about 30 in total
- **Hidden "shared" modules living inside features:**
  - `components/rules/constants.ts` has 56 importers, and 48 of them import only `pluralRu`.
  - `components/people/person-select.tsx` has 33 importers.
  - `components/chart-engine/*` is a charting library used by 6 features.
- **Cycles: 1** strongly connected component: `calculator/{ChainAdvisor, StrategyBuilder, OptionsSection, BlackScholes}`. Otherwise the graph is acyclic, which is good.
- **No lint tooling exists:** no ESLint, Biome or Oxlint config or package anywhere in the repo. Prettier is installed but not wired into a script. The only architectural guard is `scripts/check-z.mjs`, a z-index ratchet with a baseline. That ratchet pattern is the right model to copy for other rules. The **90 `// eslint-disable-next-line react-hooks/exhaustive-deps` comments are orphaned**, because nothing runs that rule.

### 1.3 Routing and code splitting
- wouter 3.9. Every route is `React.lazy` except Dashboard and Login.
- `shell/route-loaders.ts` gives hover/focus preload and an idle preload of `/trades`. It also waits for `i18nReady()` before resolving a page chunk.
- **The route table is declared three times:**
  1. `App.tsx`: 51 `lazy()` constants and 52 `<Route>`s
  2. `shell/route-loaders.ts`: `PAGE_IMPORTS`
  3. `shell/nav.ts`: titles, `EXTRA_TITLES`, `SEARCH_TITLES`
  
  Adding a page means editing three files. The `/rules` and `/error-tracker` alias appears only in `App.tsx`.
- No route-level access guard. Each page checks the role itself; there are 157 inline `role === "…"` comparisons next to the `lib/permissions.ts` capability matrix.
- **Bundle (production build, gzip):**
  - Main chunk `index-*.js`: **1,086 KB raw / 345 KB gz**.
  - Biggest libraries in it by source size: react-dom; framer-motion with motion-dom (~440 KB source, used by only ~22 `motion.*` elements in 21 files); tailwind-merge; lucide; vaul (the mobile drawer, loaded eagerly for every user); Radix select/menu/toast; the whole dashboard; `equity-chart`; `global-search`; `screenshot-fields`; `use-trades-page`; the login page.
  - recharts sits in its own 366 KB / 101 KB gz chunk; lightweight-charts in 175 KB.
  - Total JS across 206 chunks is 6.0 MB raw.

### 1.4 Data layer: how the app talks to the API
There are **three parallel mechanisms**:

1. **Orval-generated hooks** (`lib/api-client-react`, mutator `customFetch`). The spec covers **36 paths with 27 query hooks**, against **about 609 Express routes** on the server. 71 frontend files import the package, mostly the legacy CRUD for trades, events, research, daily-feed and discussions, plus `Trade` and other types.
2. **Hand-written fetch helpers**, one or more per feature:
   - **43 helper definitions**: `getJson` / `fetchJson` / `sendJson` / `postJson` / `req` / `api` / `pbRequest` / `jsonOrThrow`.
   - **21 separate `HttpError` / `ApiError` classes** (`behavior`, `benchmark`, `day-report`, `notes` ×2, `office-stats`, `propreports`, `risk`, `scaling`, `settings`, `weekly-review`, `academy` ×3, `playbook`, `chart-lab`…).
   - **11 `readError` variants**.
3. **Raw `fetch(`**: 316 call sites in 127 files, counting those inside the helpers.

Auth comes from a **global `fetch` monkey-patch** (`lib/install-fetch-auth.ts`) that adds `Authorization` to every same-origin `/api/*` call and fires `ws-auth-expired` on a 401. Every path goes through it, so auth is consistent. The i18n spec's `X-Lang` header can be added in one place there.

`customFetch` and its `ApiError` are **not exported** from `@workspace/api-client-react`; `index.ts` exports only `setBaseUrl` and `setAuthTokenGetter`. Feature code therefore cannot reuse them, which is why the 43 copies exist.

**The helpers behave differently.** This matters because `App.tsx` makes retry and toast decisions by parsing the error (`isClientError`, `isAuthError`, `humanizeApiError` in `lib/api-errors.ts`):

| Helper style | Status preserved? | Server `code` preserved? | Effect |
|---|---|---|---|
| `throw new Error(\`HTTP ${status}\`)` (35 sites; e.g. `dashboard/use-dashboard.ts:203`, `global-search.tsx:72`, `playbook-health-widget.tsx`) | parsed back from text | **no** | `CHECKLIST_REQUIRED`, `ai_not_configured` and similar codes are lost, so a generic toast is shown |
| `throw new Error(body.error ?? \`Ошибка ${status}\`)` (`analyst/api.ts:10`, `ratings/shared.tsx:6`, `pages/discussions.tsx:38`) | **no** | no | a 403 or 404 is **retried** (the `retry` predicate cannot see a 4xx) and `isAuthError` is false |
| `HttpError(status, msg)` per feature | yes | sometimes | works, but 21 incompatible classes |
| `getJson → null` on any error (`chart-engine/TradeSparkline.tsx:42`, `ticker-fundamentals-bar.tsx:33`) | swallowed | swallowed | silent failures |

**Query keys:**
- 266 inline literal keys with 130 distinct roots, plus 235 key references through variables.
- **22 per-feature key factories** with inconsistent naming: `riskKeys`, `prKeys`, `gpKeys`, `AN_KEYS`, `NOTIF_KEYS`, two different exports both named `academyKeys`.
- Orval keys look like `["/api/trades", params]`; hand-written ones like `["trades-page", …]`. Only 13 literal keys start with `/api`.
- `queryOptions()` is used **0 times**.
- **The same key gets different `queryFn`s, result types and options:**
  - `["watchlist"]` has 5 queryFns in 5 files (`analyst/api.ts:167`, `events/use-catalysts.ts:36`, `offerings/use-offerings-data.ts:126`, `watchlist/use-quick-add.tsx:16`, `pages/watchlist.tsx:123`), with 3 different row types (`WatchRow`, `WatchItem`, `WatchlistItem`) and different `staleTime`/`retry`.
  - `["playbook"]` (~300 KB response) has 3 queryFns (`playbook/api.ts`, `global-search.tsx`, `playbook-health-widget.tsx`).
  - This is harmless today only because they all hit the same URL without transforming the data.
- **The same endpoint is cached under different keys**, so it is fetched twice:
  - `/api/trades?result=open`: `["analyst-open-positions"]` and `["offerings","open-trades"]`
  - `/api/trade-ideas`: `IDEAS_KEY` and `["trade-ideas-search"]`

**Invalidation:**
- 194 `invalidateQueries` calls.
- A central list, `lib/query-keys.ts → TRADE_DEPENDENT_PREFIXES` (44 roots), drives `invalidateTradeDependents()`. It drifts:
  - `behavior`, `setups-auto`, `benchmark`, `day-report` and the `offerings` open-trades key are all trade-derived and **not listed**.
  - `/api/eod/status` and `/api/events/today` (dashboard) do not match `eod` because of the slash/prefix rule.
- Optimistic updates: 28 `onMutate`, 71 `setQueryData`, 11 `cancelQueries`, done by hand each time (e.g. `patchTradeInPages` in `use-trades-page.ts`, `setup-document.tsx`, `pages/watchlist.tsx:346`).
- `mutationKey` and `useMutationState` are not used.

**Global defaults (`App.tsx`)** are good: `staleTime 30s`, `gcTime 5m`, no refetch on window focus, one retry on non-4xx, a global `MutationCache.onError` Russian toast, and `queryClient.clear()` on logout. Per-query `staleTime` uses 15+ different literals (`60_000` ×74, `5*60_000` ×38, `5*60*1000` ×9, `30*60*1000` ×5…). There are 65 `refetchInterval` polls with 15 different literals.

**Large or "whole-book" responses:**
- `GET /api/playbook` (~300 KB, per the code comment) is loaded by global search and the health widget just to list names.
- `useTradesWindow` / `use-tagged-trades` still keep a fallback to the full `/api/trades` (one comment calls it "~60 MB").
- `settings/DataSection.tsx:329` falls back to the full legacy list.

**About 279 comment lines in 58 files are "older API build" compatibility code:** 404 → null, `NotDeployedError`, capability probing (`TradesApiCaps`/`capsCache` in `use-trades-page.ts`), and `select` re-applying server filters on the client. Production deploys the SPA and the API together (`api-server/src/app.ts:99` serves `dist/public`), so a new SPA never runs against an old API. This code is dead in production and doubles the paths to test.

### 1.5 State management
- Server state: TanStack Query. 414 `useQuery`, 14 `useQueries`, 6 `useInfiniteQuery`, 164 `useMutation`.
- Contexts: only auth and theme, plus local ones (sidebar, `plan-media`, `ds/virtual`). There is no global client store, which is appropriate.
- Local state: 1,452 `useState`, 1 `useReducer`, 589 `useEffect`, 979 `useMemo`, 383 `useCallback`, 23 `memo()`.
- **Persisted UI state:** 180 `localStorage.` references in 74 files and **4 competing hooks**: `ds.usePersistentState` (prefix `ws_lexx.`), `calculator/lib.usePersistedState`, and `useStoredState` ×3 (`ratings/shared`, `risk/primitives`, `widgets/widget-kit`). Keys are not scoped to the user, so on a shared desk PC filters and "selected trader" carry over to the next login.
- **URL state:** 126 `URLSearchParams` uses, 41 `useSearch`, and **19 direct `window.history.replaceState` calls** (`pages/admin`, `author-notes`, `behavior`, `day-report`, `analytics-pro`…), each with its own read/write helper (e.g. `pages/discussions.tsx readParam/writeParams`). wouter 3.9 already provides `useSearchParams()` with `{ replace }` ([wouter README](https://github.com/molefrog/wouter/blob/v3/README.md)).
- i18n plan interaction: switching language re-mounts the tree under the QueryClient (I18N_SPEC). Unsaved `useState` drafts are lost on switch; `usePersistentState` values survive.

### 1.6 Forms and validation
- react-hook-form plus zod in **one** form (`risk/limits-form.tsx`). Everything else uses `useState` with inline checks: 48 `<form>`, 96 `onSubmit`, 36 `aria-invalid`.
- `@workspace/api-zod`, the generated zod schemas, has 0 imports in the frontend.
- No shared form-error pattern. Server `VALIDATION` errors become a toast, not field errors.

### 1.7 Error, loading and empty states
- Primitives exist and are widely used: `EmptyState` (165 files), `Skeleton` (142), `QueryError` (29 files), `ErrorState` (15, a second error component wrapping the first), `QueryState` (7), plus several skeleton variants.
- There are 134 `Loader2` and 129 `animate-spin` ad-hoc spinners.
- 20 files call `useQuery` and never read `isError` / `error`.
- `RouteErrorBoundary` wraps each route and the shell (it resets on location change).
- The pattern is decent but there is **no single `<QueryState>` convention**: `isLoading ? … : isError ? … : !data.length ? …` is hand-rolled on 169 `isLoading` sites.

### 1.8 Types
- `any`: 56 (19 of them in `global-search.tsx`).
- `as unknown as`: 22. `as X` casts: about 1,057, most of them `res.json() as T`, meaning responses are never checked at runtime.
- `@ts-ignore`: 1 (a test). `@ts-expect-error`: 14, all deliberate in `i18n/__typecheck__.ts`.
- tsconfig gaps: `strictFunctionTypes: false`, `noUnusedLocals: false`, and **`**/*.test.ts` is excluded from tsc**, so 646 tests are never type-checked.
- Types shared with the API: only the 27 orval endpoints (`Trade`, etc.). Everything else is a hand-written type per feature, e.g. three watchlist row types.

### 1.9 Component size hot spots
- **43 functions are 300 lines or longer**:
  - `pages/playbook.tsx Playbook` 1,146
  - `pages/watchlist.tsx Watchlist` 880
  - `pages/trades.tsx Trades` 848
  - `chart-engine/WsChart.tsx WsChart` 821
  - `pages/author-notes.tsx` 793
  - `pages/dailyfeed.tsx` 671
  - `trade-chart.tsx` 591
  - `pages/discussions.tsx` 590
  - `pages/analyst-actions.tsx` 563
  - `notes/junior-editor.tsx` 546
  - `pages/trade-ideas.tsx` 535
  - `lib/ask/parse.ts buildRules` 493
  - and 31 more (full list in `fe_graph.json`)
- Largest files by bytes: `lib/ask/parse.ts` 73 KB, `pages/playbook.tsx` 68 KB, `WsChart.tsx` 63 KB, `lib/ask/aggregate.ts` 54 KB, `pages/watchlist.tsx` 52 KB, `components/ds.tsx` 49 KB.

### 1.10 Duplication of utilities
- **Pluralisation:** 28 local implementations (`plural` / `pluralRu` / `pluralTrades`), plus `rules/constants.pluralRu` imported by 48 files. The i18n `selectPlural` exists but is used only by that one.
- **Formatter functions:** 311 `fmt*` / `format*` / `usd*` definitions, including:
  - `fmtUsd` ×27, `fmtPct` ×25, `fmtR` ×22
  - `fmtMoney` ×12, `fmtDay` ×12, `fmtPrice` ×10
  - `usd` ×9, `fmtDayLong` ×7, `fmtMetric` ×7
  
  `lib/format.ts` (formatCurrency/Percent/Date) and the new `i18n/format.ts` (imported only by tests, per knip) are mostly ignored.
- **Hard-coded locale:** `"ru-RU"`/`"ru"` literals appear 318 times in 160 files. **22 module-level `new Intl.*("ru-…")` constants** (e.g. `chart-engine/lib/time.ts:13-18`, `academy/content/time.tsx:5-6`) are evaluated once at import and **will not follow a language switch, even after the planned re-mount**.
- Persisted-state hooks ×4, fetch helpers ×43, error classes ×21 (see 1.4–1.5).

### 1.11 Dead code and dependencies (knip, confirmed by my graph)
- **35 unused files:**
  - 28 shadcn `ui/*` files: accordion, alert, aspect-ratio, avatar, badge, breadcrumb, button-group, card, carousel, chart, context-menu, empty, field, hover-card, input-group, input-otp, item, menubar, navigation-menu, pagination, progress, radio-group, resizable, scroll-area, sonner, spinner, toggle-group, toggle
  - `components/earnings-watch.tsx` (516 lines)
  - `replay/ReplayChart.tsx` (a 428-line component)
  - `big7/visuals.tsx`
  - `weekly-review/overview.tsx`
  - `equity-candles/index.ts`
  - `scripts/i18n-report.mjs`
- **19 unused packages:**
  - `react-icons` (0 imports)
  - `sonner` and `next-themes` (used only by the dead `ui/sonner`; the app uses the Radix toast)
  - `embla-carousel-react`, `input-otp`, `react-resizable-panels`
  - 12 `@radix-ui/*` packages
  - `@radix-ui/react-visually-hidden`
- **225 unused exports** per knip; about 1,100 by my stricter count, which also counts exported-but-local types.
- Test-only modules: `i18n/format.ts`, `chart-engine/lib/training.ts`.

### 1.12 Tests
- 52 test files, 4.7k lines, all `environment: "node"`, all pure logic: `lib/*`, `lib/ask`, `chart-engine/lib`, `equity-chart`, `risk-math`, `game-plan`, etc.
- **No component, hook or MSW tests, and no DOM environment.**
- **26 feature folders have zero tests**, including `propreports`, `dashboard`, `settings`, `weekly-review`, `stats`, `analytics-page`, `behavior`, `eod`, `notifications` and `scaling`.
- `lib/api-errors.ts`, which drives retry and toast behaviour, has no test.

### 1.13 Accessibility basics
This is strong for an internal tool:
- 1,241 `aria-label`, 256 `htmlFor`, 135 `sr-only`, 51 `aria-live`, 55 `role="status"`, 42 `role="alert"`.
- A focus-to-main call on route change, `MotionConfig reducedMotion="user"`, and a skip link (`z-skip`).

Gaps found by single-line heuristics:
- 26 `size="icon"` Buttons without `aria-label`
- 13 clickable `div`/`span`/`tr` elements without a role
- about 340 of 588 single-line native `<button>`s with no `type` (inside `<form>` they submit by default)
- 1 `<img>` without `alt`

### 1.14 Performance patterns
- Code splitting per route plus preload is good. `@tanstack/react-virtual` is used via `ds/virtual.tsx` in 4 files.
- The trades list is server-paginated (`/api/trades/page`).
- Heavy `useMemo` use (979). The React Compiler is not enabled.
- Charts: recharts 2.15 in 22 files (async chunk), lightweight-charts 5 in `chart-engine`, plus custom SVG.
- Main chunk is 345 KB gz (see 1.3).

### 1.15 Styling
- Tailwind v4 with tokens in `index.css` (299 custom properties, `@theme inline`, z-scale and duration `@utility`s).
- Hard-coded palette is nearly absent: 3 palette classes, 19 hex values in 2 files.
- But **2,879 arbitrary values**, mostly tokens reached through brackets: `bg-[var(--glass-bg)]` 374, `bg-[var(--glass-hover-bg)]` 279, `border-[var(--glass-border)]` 142, `gap-[var(--grid-gap)]` 140, `text-[hsl(var(--chart-3))]` 97, `border-[var(--field-border)]` 78. These tokens are not registered in `@theme`, so there is no `bg-glass` or `text-chart-3` utility.
- 235 inline `style={{…}}` and 695 `rgb()`/`hsl()` literals in TS (mostly chart colours).

---

## 2. Problems ranked by impact

| # | Problem | Category | Evidence |
|---|---|---|---|
| P1 | **Inconsistent HTTP error contract.** 43 fetch helpers and 21 error classes. Some drop the HTTP status (4xx retried, 401 not seen as auth), others drop the server `code` (special toasts like `CHECKLIST_REQUIRED` / `ai_not_configured` never fire), and some swallow errors into `null` | correctness | §1.4 table; `analyst/api.ts:10`, `ratings/shared.tsx:6`, `pages/discussions.tsx:38`, 35 `throw new Error(\`HTTP …\`)` sites |
| P2 | **Invalidation by a hand-kept prefix list drifts.** Trade-derived screens are not refreshed after trade edits or imports (`behavior`, `setups-auto`, `benchmark`, `day-report`, offerings open trades, dashboard `/api/eod/status`) | data correctness (stale numbers) | `lib/query-keys.ts` vs key factories in `behavior/api.ts:288`, `benchmark/api.ts:115`, `day-report/api.ts:102`, `offerings/use-offerings-data.ts:120` |
| P3 | **Same cache key with different fetchers and types**, and **same endpoint under different keys**. Fragile (a future `select` or unwrapping on one site corrupts the others) and causes duplicate requests | correctness / perf | `["watchlist"]` ×5, `["playbook"]` ×3; `/api/trades?result=open` ×2 keys; `/api/trade-ideas` ×2 keys |
| P4 | **Locale baked in at module scope.** 22 module-level `Intl` constants and 318 `"ru-RU"` literals break the i18n language switch. 311 formatter copies and 28 plural copies mean the translation wave would translate the same thing 30 times | correctness for i18n / maintainability | §1.10; `chart-engine/lib/time.ts:13-18` |
| P5 | **No lint, no boundary enforcement.** The 90 `exhaustive-deps` disables are orphaned; nothing stops new cross-feature imports, raw `fetch`, or new `pluralRu` copies. Tests are not type-checked | maintainability | §1.2, §1.8 |
| P6 | **Dead "old API build" fallbacks** in 58 files (404 → null, capability probes, client re-filtering, whole-book fallbacks). Production deploys atomically, so these paths only hide real 404s and double the logic | maintainability / hides bugs | §1.4; `use-trades-page.ts` caps, `use-trades-window.ts`, `admin/console-api.ts NotDeployedError` |
| P7 | **Only about 6% of the API is typed from a contract** (36 of ~609 routes in the OpenAPI spec). The rest are hand-typed per feature, with ~1,000 `as T` casts and no runtime checks | maintainability / silent drift | §1.4, §1.8 |
| P8 | **God components and pages.** 43 functions ≥300 lines, `Playbook` 1,146. Hard to translate, test or review | maintainability | §1.9 |
| P9 | **Shared code hidden in feature folders, plus 31 loose root files.** `rules/constants` (pluralRu), `people/person-select`, `chart-engine`, `playbook-sub`; 393 feature→root-component edges | maintainability | §1.2 |
| P10 | **Route table in 3 places**, and no route-level role guard (157 inline role checks besides the capability matrix) | maintainability (security is enforced server-side) | §1.3 |
| P11 | **Main bundle 345 KB gz.** framer-motion for about 22 elements, the vaul drawer, login and the whole dashboard are eager | performance (internal desktop users, so moderate) | §1.3 |
| P12 | **Dead code**: 35 files, 19 packages, 225+ unused exports | maintainability / install size | §1.11 |
| P13 | **No component/hook tests.** Critical flows (PropReports status, risk desk, EOD) have no tests; `api-errors` is untested | maintainability | §1.12 |
| P14 | **Four persisted-state hooks, 19 hand-rolled URL-state writers**; localStorage not scoped to the user | maintainability / minor privacy on shared PCs | §1.5 |
| P15 | **Styling**: tokens used through 2.9k bracket arbitrary values instead of theme utilities; 588 native `<button>`, about 340 without `type` | style / a11y | §1.13, §1.15 |

---

## 3. Target principles (enforceable, sized for one product, ~5 developers or agents, ~170k lines)

Research basis:
- bulletproof-react: one-way shared → features → app, no feature-to-feature imports, direct imports instead of barrels, enforced with `import/no-restricted-paths` zones ([project-structure.md](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md)).
- TkDodo / TanStack v5: `queryOptions` factories instead of custom hooks wrapping one `useQuery`, keys hierarchical from general to specific ([Creating Query Abstractions](https://tkdodo.eu/blog/creating-query-abstractions), [The Query Options API](https://tkdodo.eu/blog/the-query-options-api), [queryOptions reference](https://tanstack.com/query/v5/docs/framework/react/reference/functions/queryOptions)).
- React Compiler 1.0 is stable (Oct 2025), and its lint rules now ship in `eslint-plugin-react-hooks` `recommended`; the linter does not need the compiler installed ([react.dev blog](https://react.dev/blog/2025/10/07/react-compiler-1)).
- dependency-cruiser checks the resolved graph, finds cycles and supports a known-violations baseline; eslint-plugin-boundaries gives in-editor feedback ([eslint-plugin-boundaries](https://github.com/javierbrea/eslint-plugin-boundaries)).
- wouter `useSearchParams` ([README](https://github.com/molefrog/wouter/blob/v3/README.md)).

Full Feature-Sliced Design (7 layers, slices, segments) is overkill for this team and would force moving all 771 files. I recommend a **bulletproof-style 4-layer model that keeps today's paths**, so most files never move.

### 3.1 Target structure (renames kept to a minimum)
```
src/
  app/                    App.tsx, providers.tsx, query-client.ts, routes.ts (ONE route table: path, loader, title, nav, roles)
  pages/<route>.tsx       thin: read URL params, compose feature components; ≤ 250 lines
  components/<feature>/   = feature modules (keep the path; renaming to features/ is optional and AFTER i18n)
      api.ts              queryOptions factories + mutations for this feature (no raw fetch elsewhere)
      model.ts / *-math.ts pure logic (unit-tested)
      *.tsx               UI
  components/shared/      cross-feature domain widgets promoted out of features:
      people/ (person-select, search, highlight), charts/ (chart-engine, equity-chart, equity-candles,
      trade-chart, trade-chart-parts), trade/ (trade-utils, review-presets, trade-result UI bits)
  components/ds/          design system: ds.tsx split into ds/{layout,panel,stat,table,pill,states,motion,virtual}.tsx + ds/index.ts
  components/ui/          shadcn primitives only (unused ones deleted)
  lib/                    pure, framework-free: format/, dates, trade-math, permissions, url-state
  lib/api/                http.ts (single client), errors.ts (= today's api-errors), keys.ts (domain registry), invalidate.ts
  hooks/                  generic hooks only (use-persistent-state, use-search-param, use-mobile, use-toast)
  contexts/  i18n/
```

### 3.2 Rules (each one has a check)
1. **Layer direction:** `lib` → nothing app-specific. `components/ui`, `components/ds` → `lib` only. `components/shared/*` → `ds`, `ui`, `lib`, `hooks`. `components/<feature>` → shared, ds, ui, lib, hooks, contexts, i18n, **never another feature**. `pages` → anything except other pages. `app` → anything. *Check:* dependency-cruiser rules with a known-violations baseline (ratchet, like `check-z.mjs`), plus `no-restricted-imports` in ESLint for editor feedback.
2. **One HTTP client.** Feature code never calls `fetch(` directly. It calls `http.get/post/put/patch/del` from `lib/api/http.ts`, which throws a single `ApiError {status, code, body, message}`. Better still, `@workspace/api-client-react` exports `customFetch` and `ApiError`, and `http.ts` wraps them, so generated and hand-written calls share one error type. Exceptions: streaming and blob downloads, via `http.raw()`. *Check:* ESLint `no-restricted-globals: fetch` outside `lib/api/**`.
3. **Every query is a `queryOptions` factory in the feature's `api.ts`.** Key shape is `[domain, ...scope, params?]`. `domain` comes from a closed union in `lib/api/keys.ts`. One endpoint has exactly one factory; other features import the factory (allowed through `components/shared` or a feature's public `api.ts`), never re-declare the key. *Check:* `@tanstack/eslint-plugin-query` (`exhaustive-deps`, `no-rest-destructuring`, `stable-query-client`), plus `no-restricted-syntax` banning `queryKey: [ "literal"` outside `api.ts`.
4. **Declarative invalidation.** Queries declare what they derive from: `meta: { deps: ["trades"] }`. Mutations call `invalidateDomain(qc, "trades")`, which uses the predicate `q.meta?.deps?.includes(...)`. This replaces `TRADE_DEPENDENT_PREFIXES`. *Check:* a unit test that every factory whose URL starts with a trade-derived endpoint declares `deps`.
5. **Shared defaults:** named constants `STALE.live` (15 s), `STALE.short` (60 s), `STALE.long` (5 min), `STALE.static` (30 min) and `POLL.*`. No magic numbers. *Check:* a grep ratchet script.
6. **No compatibility branches for old API builds.** A 404 is a bug and should show `ErrorState`. *Check:* review rule plus a grep ratchet for `NotDeployed|older API|predates`.
7. **Formatting and plurals only from `lib/format` and `i18n/format`**, i.e. `fmtUsd`, `fmtPct`, `fmtR`, `fmtPrice`, `fmtCount`, `fmtDate`, `fmtRelative` and namespace plural keys. No `new Intl.*` at module scope with a UI locale (money stays en-US by spec). *Check:* ESLint `no-restricted-syntax` on `NewExpression[callee.object.name='Intl']` outside `lib/format/**` / `i18n/**`, plus a ratchet on `"ru-RU"` literals.
8. **Size limits:** a component function ≤ 300 lines, a file ≤ 600 lines. Existing offenders sit in a baseline and may only shrink. *Check:* ESLint `max-lines-per-function` / `max-lines` with a baseline file, or the existing AST script turned into `scripts/check-size.mjs`.
9. **State placement:** server data in Query only. URL state through one `useSearchParam(key, {replace})` hook on wouter's `useSearchParams`. Persisted UI state through one `usePersistentState` (user-scoped key `ws_lexx.<userId>.<key>`). Never copy query data into `useState`.
10. **Async UI:** use `<QueryState query={q} empty={…} skeleton={…}>` (it exists in `ds/states.tsx`), or the three-branch pattern with `ErrorState`. No bare `Loader2` spinners for page sections.
11. **Validation at the edges:** forms with more than 3 fields use react-hook-form plus zod (schema next to the form). Optionally parse responses with zod for the 5 money-critical endpoints (trades page, risk desk, EOD, PropReports status, scaling) behind `import.meta.env.DEV`.
12. **Lint and type baseline:** ESLint flat config with `typescript-eslint` recommended-type-checked (warn-only at first), `react-hooks` recommended (includes the React Compiler rules; turns the 90 orphaned disables into real signals), `@tanstack/query`, and `jsx-a11y` recommended (warn). Include test files in a `tsconfig.test.json` checked in CI.

---

## 4. Migration plan

Ordering logic for the translation wave:
- **Before the wave**: anything that changes how text and numbers are formatted, so translators don't touch 30 copies; dead-file deletion, so they don't translate dead code; and any file move. Moves must happen while nobody else edits those files, or every translation PR conflicts.
- **After the wave**: large component splits and folder renames. They would otherwise conflict with every translation PR, and they are behaviour-preserving, so they can wait.

| Phase | What | Files | Effort | Risk | Verify | When |
|---|---|---|---|---|---|---|
| **0. Commit in-flight tree** | Land the 283 modified files (i18n foundation and leftovers) before any structural change | — | S | — | `tsc`, `vitest`, build | **First** |
| **1. Dead code purge** | Delete the 35 knip files (keep `i18n/__typecheck__.ts`, which knip lists only because tsc-only files have no importer; add it as a knip entry) and remove the 19 unused packages | ~35 files, `package.json` | S | low | `knip`, `tsc`, build, smoke-test 5 pages | **Before wave** |
| **2. Tooling baseline (non-blocking)** | Add ESLint flat config (rules in §3.2 #12, all `warn`), `dependency-cruiser` with `.dependency-cruiser-known-violations.json` baseline, `knip.json`, and `pnpm lint` in root `build`. `tsconfig.test.json` | config only | S–M | none (warn/baseline) | CI green; baseline counts recorded | **Before wave** (so translated code is linted) |
| **3. Formatting and plural consolidation** | Finish `i18n/format.ts`, create `lib/format/{money,number,date}.ts`, codemod the 27 `fmtUsd` / 25 `fmtPct` / 22 `fmtR` / 12 `fmtDay`… copies to imports, and turn the 22 module-level `Intl` constants into functions (or memoised per `getLang()`). Replace the 28 plural copies and `rules/constants.pluralRu` with namespace plural keys or the `common` units (`сделка/сделки/сделок`). **Owner decision:** which number/date shapes are canonical (e.g. `+$1,234` vs `$1,234.00`) | ~120 files | M–L | medium (visual changes in numbers) | Unit tests for every formatter in 3 languages; visual diff of dashboard, trades, risk, stats | **Before wave** (or as the wave's first step, one owner) |
| **4. Single HTTP client and error contract** | Export `customFetch` and `ApiError` from `api-client-react`. Add `lib/api/http.ts` and unit tests for `lib/api-errors`. Replace the 43 helpers feature by feature with `http.*` (signatures nearly identical, so a mechanical change), and delete the 21 error classes (keep `NotDeployedError` only until phase 6). Add `X-Lang` here or in `install-fetch-auth` | ~45 files | M | low–medium | New `http.test.ts` (status, code, network, 204, non-JSON); manually trigger a 403, a 404 and `CHECKLIST_REQUIRED` | Can run **in parallel with the wave** (touches `api.ts` files, which have little UI text) |
| **5. Query key and invalidation model** | Add `lib/api/keys.ts` (domain union) and `invalidateDomain`. Convert the 22 key factories to `queryOptions` factories with `meta.deps`. Merge duplicate keys (`watchlist` → one `watchlistQueries.list()` with one row type; `playbook` → `playbookQueries.list()` plus a light `playbookQueries.names()` endpoint for search and the health widget; open trades; trade ideas). Remove `TRADE_DEPENDENT_PREFIXES` once all trade-derived queries declare `deps` | ~60 files | M | medium | Unit test that all trade-derived factories declare `deps`; manual check: edit a trade's setup and confirm behaviour, setups-auto, benchmark, day-report and dashboard EOD refresh; Network tab shows no duplicate requests on dashboard and watchlist | **In parallel / after wave** |
| **6. Remove old-API fallbacks** | Delete capability probes, 404 → null branches, `NotDeployedError`, client-side re-filtering in `useTradesWindow`, and full-book fallbacks (58 files). Coordinate with the backend report so every endpoint the SPA calls exists | 58 files | M | medium (exposes real 404s, which is the point) | e2e smoke-test of every route against the current API; grep ratchet goes to 0 | **After phase 4**, before or after wave |
| **7. Promote shared modules, kill cross-feature edges** | Move `people/*`, `chart-engine`, `equity-*`, `trade-chart*`, `trades/trade-utils`, `review-presets`, `trade-result` into `components/shared/`. Merge `playbook-sub` into `playbook`. Move the 31 loose root files into their features. Fix the 4 upward imports and the calculator cycle. Codemod import paths (`git mv` plus `jscodeshift` or `ts-morph` rename) | ~120 moved files, ~400 import edits | M | low in behaviour, **high in merge conflicts** | `tsc`, depcruise baseline shrinks from 184 to ~20, build | **Before the wave in one atomic commit while nobody else is editing**, *or* after the wave. **Never during it.** Recommendation: do the small part (31 root files, `playbook-sub`, 4 upward imports) before; the `shared/` promotion after |
| **8. Single route table** | `app/routes.ts` with `{path, load, title, nav, roles}`. `App.tsx`, `route-loaders`, `nav.ts` and the sidebar all derive from it. Optionally add a role guard per route (UI only; the server stays authoritative) | 5 files | S–M | low | `nav.test.ts` extended: every nav item has a route and vice versa | After wave (titles become i18n keys during the wave, so do it then or right after) |
| **9. Split god components** | `Playbook`, `Watchlist`, `Trades`, `WsChart`, `AuthorNotes`, `DailyFeed`, `Discussions`, `AnalystActions`, `TradeIdeas`, `JuniorEditor`: extract data hooks (`use-<page>-data.ts`), toolbars, dialogs and tables. Baseline enforces ≤ 300-line functions | 43 functions | L (spread over time) | medium | Component tests with RTL plus MSW for the 3 biggest pages before splitting | **After wave** |
| **10. State and URL helpers** | One `usePersistentState` (user-scoped), delete the 3 `useStoredState` and `usePersistedState`; `useSearchParam` on wouter `useSearchParams`, replacing the 19 `history.replaceState` writers | ~30 files | S–M | low | Manual check: filters persist per user; back/forward works | After wave |
| **11. Bundle diet** | `LazyMotion` + `m` (or CSS) instead of full framer-motion in the shell and dashboard; lazy `vaul` drawer (mobile nav only); lazy login; lazy dashboard widgets below the fold; register glass, field and chart tokens in `@theme inline` (`bg-glass`, `text-chart-3`) via codemod | ~25 files + css | S–M | low | Main chunk gz from 345 KB to under 220 KB (measure with `vite build` plus sourcemap like this report); visual check | After wave (CSS token codemod touches every UI file, so not during it) |
| **12. Tests** | Add `vitest` jsdom project, `@testing-library/react`, MSW. First targets: `lib/api-errors`, `http.ts`, `invalidateDomain`, formatters ×3 languages, PropReports status hero, risk desk, EOD queue. Include tests in a typecheck | new files | M | none | Coverage report on `lib/` and feature `api.ts` files | Starts phase 2–4; continues |

**Owner and lead decisions needed:**
- **D1, API contract strategy.** The OpenAPI spec covers 36 of ~609 routes. Options:
  - (a) grow `openapi.yaml` domain by domain and let orval generate `queryOptions` and types (strong typing, heavy upkeep for a raw-SQL Express server);
  - (b) a shared `lib/api-contracts` package of zod schemas and TS types imported by both server and client, without codegen;
  - (c) keep hand-written types.
  
  I recommend **(b)** for new and changed endpoints and freezing orval at today's 36 paths. Coordinate with the backend report.
- **D2, canonical number and date formats** for phase 3.
- **D3, whether to rename `components/<feature>` to `features/<feature>`.** I recommend **not** doing it: it is high churn for low value. Enforce the rules on the existing paths instead.
- **D4, enabling the React Compiler** (babel-plugin-react-compiler with `@vitejs/plugin-react` 5). Recommended only after the `react-hooks` lint is clean, i.e. after phase 2 and the fixes it turns up. It would let us drop many of the 979 `useMemo` and 383 `useCallback`.
- **D5, recharts 3 upgrade.** v3 removed `Customized` state access and internal props ([3.0 release notes](https://newreleases.io/project/npm/recharts/release/3.0.0)). There are 22 files; schedule it after the wave.

---

## 5. Quick wins (≤ 1 h each)

1. Delete the 35 dead files and remove the 19 unused packages (`react-icons`, `sonner`, `next-themes`, `embla-carousel-react`, `input-otp`, `react-resizable-panels`, 12 `@radix-ui/*`, `@radix-ui/react-visually-hidden`). Verify with knip, tsc and build.
2. Export `customFetch`, `ApiError` and `ResponseParseError` from `lib/api-client-react/src/index.ts` (1 line, no codegen).
3. Fix the three status-dropping helpers (`analyst/api.ts:10`, `ratings/shared.tsx:6`, `pages/discussions.tsx:38`) so they throw an error with `status` and `code`. This stops 4xx retries and restores 401 handling.
4. Add `behavior`, `setups-auto`, `benchmark`, `day-report`, `offerings`, `/api/eod` and `/api/events` to `TRADE_DEPENDENT_PREFIXES`, as a stop-gap until phase 5.
5. Share one factory for `/api/trades?result=open` (analyst and offerings) and one for `/api/trade-ideas` (global search and `IDEAS_KEY`). Removes duplicate requests.
6. Merge `components/playbook-sub/bits.tsx` into `components/playbook/`, removing 15 cross-feature edges.
7. Move `pluralRu` from `rules/constants.ts` to `lib/format/plural.ts` (re-export it from `rules/constants` for compatibility). Removes 48 fake cross-feature edges.
8. Break the `calculator` 4-file cycle by moving shared types and math into `calculator/lib.ts`.
9. Fix the 4 upward imports (`lib/trade-result → ds`, `hooks/use-trades-page → trades/*`, `ds/states → query-error`, by moving `query-error.tsx` into `ds/`).
10. Add a `knip.json` (entries: `src/main.tsx`, `src/i18n/__typecheck__.ts`, `scripts/*.mjs`) and `"lint:dead": "knip"`.
11. Add `tsconfig.test.json` (includes `**/*.test.ts`) and a `typecheck:test` script, so tests get type-checked.
12. Lazy-load the `vaul` mobile drawer in `shell/mobile-nav.tsx` (it is in the main chunk for every desktop user).
13. Set `aria-label` on the ~26 `size="icon"` buttons without one, and `type="button"` on native buttons inside forms (grep list in the appendix command).

---

### Appendix: how to reproduce the numbers
- Graph, layering, cycles, long functions, unused exports: `node scratchpad/fe_analyze.cjs artifacts/edge-tracker/src <repo>/node_modules/typescript scratchpad/fe_graph.json`
- Dead code: `npx knip@5 --workspace artifacts/edge-tracker` (output in `scratchpad/fe_knip.txt`)
- Bundle: `vite build --outDir <scratch> --sourcemap`, then sum `sourcesContent` by package (source sizes overstate what survives tree-shaking; the gzip numbers are exact).
- Duplication counts: the `grep -rhoE` patterns in this report (e.g. `^(export )?(const|function) (fmt|format|money|usd|signed|pnl|compact)\w*`).
