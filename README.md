# WS_LEXX — Prop Trading Desk

Внутренняя операционная платформа для проп-трейдинг деска.

**v5.0** · Node.js 24 · pnpm monorepo · React 18 / Vite · Express 5 · PostgreSQL · Drizzle ORM · TypeScript 5.9

---

## Что включено

| Модуль | Описание |
|---|---|
| **Trade Journal** | Журнал сделок с multi-fill экзекуциями и intraday-графиком |
| **Playbook Engine** | База стратегий и edge компании |
| **Performance Analytics** | Win rate, expectancy, ошибки, рейтинги трейдеров |
| **Trade Ideas** | Pipeline: черновик → публикация → конвертация в сделку |
| **Pre-Trade Checklist** | Шаблонный чеклист перед входом в позицию |
| **AI Trade Review** | Claude Sonnet анализирует каждую сделку с рыночным контекстом |
| **Daily Feed** | Что работает прямо сейчас |
| **Watchlist** | Список акций с уровнями и автоматическим скорингом |
| **Research** | Паттерны и исследования |
| **Big7 / Hot Stocks** | Ключевые уровни по крупным тикерам + дневные hot stocks |
| **War Room** | Совместные торговые сессии в реальном времени |
| **Discussions** | Внутренние обсуждения и комментарии |
| **Options Calculator** | Black-Scholes, греки, диаграмма выплат, сценарии |
| **FX Calculator** | Живые курсы (Yahoo Finance) для 11 валют |
| **Psychology / Emotional State** | Еженедельные отчёты, трекер эмоций |
| **Analyst Actions** | Парсинг и отображение апгрейдов/даунгрейдов |
| **Digest** | Email-рассылка дайджеста (утро / вечер) |
| **DB Backups** | Автоматический pg_dump → Object Storage каждые 48h |
| **PropReports Import** | Импорт сделок из XLS PropReports через UI или CLI |

**Роли:** trader · curator · admin

---

## Быстрый старт на новом Replit

### 1. Клонируй репозиторий

```bash
git clone https://github.com/iskhakovzak/WS_LEXX.git .
pnpm install
```

### 2. Создай PostgreSQL базу данных

В Replit: **Database → Create PostgreSQL database**
Переменная `DATABASE_URL` выставится автоматически.

### 3. Добавь обязательные секреты

В Replit **Secrets** (`Tools → Secrets`):

| Секрет | Описание |
|---|---|
| `JWT_SECRET` | Случайная строка 32+ символов (обязательно — без неё сервер не стартует) |
| `PLAYBOOK_PASSWORD` | Пароль для просмотра плейбука |

Опционально:
- `DEFAULT_OBJECT_STORAGE_BUCKET_ID` — для автоматических pg_dump бекапов (Replit Object Storage)
- `GITHUB_PERSONAL_ACCESS_TOKEN` — для push в GitHub из Replit

### 4. Запусти оба workflow

Оба workflow уже прописаны в `.replit`. Нажми **Run** или запусти через Workflows.

Дождись в логах API сервера:
```
Server listening  port: 8080
Database migrations completed
dbBackup cron started  intervalH: 48, keepLast: 10, delayMin: 3
```

### 5. Готово

Миграции создают все 40+ таблиц автоматически.
Пользователи сидятся при первом старте (если таблица `users` пустая).

---

## Восстановление базы из бекапа

```bash
# Из .sql.gz (автоматический бекап из Object Storage):
gunzip backup-file.sql.gz
psql "$DATABASE_URL" < backup-file.sql

# Из .sql напрямую:
psql "$DATABASE_URL" < db_backup_v5.sql
```

Бекапы также доступны через **Админку → Инструменты → Бекапы БД** (скачать .sql.gz).

---

## Пользователи

Начальные учётки задаются переменной `SEED_USERS` (JSON `[{"name","password","role"}]`) при первом запуске на пустой БД. Без неё dev-сервер создаёт аккаунты деска со случайными 6-значными PIN и один раз пишет их в лог. Пароли в репозитории не хранятся; меняй их в «Админке».

---

## Структура проекта

```
artifacts/
  edge-tracker/              # React 18 + Vite + TailwindCSS v4 фронтенд
    src/
      pages/                 # 25+ страниц (dashboard, trades, playbook, ...)
      components/            # UI компоненты
      hooks/                 # Orval-сгенерированные React Query хуки
      contexts/              # AuthContext (JWT + роли), ThemeContext
  api-server/                # Express 5 API сервер
    src/
      routes/                # 40+ маршрутов
      lib/
        migrate.ts           # Автомиграции (CREATE TABLE IF NOT EXISTS)
        dbBackupCron.ts      # pg_dump → Object Storage каждые 48h
        dailyQuoteCron.ts    # Дневная цитата
        marketContext.ts     # Снэпшот рынка для AI
        objectStorage.ts     # Replit Object Storage client
        logger.ts            # pino логгер
        audit.ts             # Аудит лог
lib/
  db/                        # Drizzle ORM схемы и подключение к БД
  api-zod/                   # Zod схемы (Orval codegen)
  api-spec/                  # OpenAPI 3.0 спецификация
  api-client-react/          # React Query хуки (Orval codegen)
scripts/
  build-prod.sh              # Production build
  src/import-propreports.ts  # CLI импорт XLS PropReports
  src/lib/parse-propreports.ts
```

---

## Ключевые команды

```bash
pnpm install                                        # Установить зависимости
pnpm run typecheck                                  # Typecheck всех пакетов (включая тесты)
pnpm verify                                         # lint + typecheck + test + храповики + build (то же, что CI)
pnpm lint                                           # Biome (весь репо) + ESLint (edge-tracker: hooks deps, TanStack Query)
pnpm checks                                         # храповики: i18n, "ru-RU", тела ошибок API, размеры, lint, слои, z-index, права
pnpm checks:update                                  # зафиксировать уменьшившийся долг (только после зелёного pnpm checks)
pnpm --filter @workspace/scripts run local-db       # локальный Postgres (dev-база edge_tracker)
pnpm db:test:create                                 # один раз: тестовая база edge_tracker_test (API-тесты не трогают edge_tracker)
pnpm --filter @workspace/api-spec run codegen       # Regenerate API хуки из OpenAPI
bash scripts/build-prod.sh                          # Production build

# PropReports импорт (CLI):
npx tsx scripts/src/import-propreports.ts <path.xls> [--dry-run] [--trader=Закир]
```

---

## Промпт для AI-агента (быстрый старт / передача контекста)

Если нужно передать проект другому AI или поднять с нуля — скопируй этот промпт целиком:

```
Ты работаешь с проектом WS_LEXX Prop Trading Desk (v5.0).
GitHub: https://github.com/iskhakovzak/WS_LEXX

MONOREPO СТРУКТУРА:
- artifacts/edge-tracker — React 18 + Vite + TailwindCSS v4 + Wouter фронтенд
- artifacts/api-server — Express 5 API сервер (порт 8080, путь /api)

СТЕК:
- Node.js 24, pnpm workspaces, TypeScript 5.9
- PostgreSQL (Replit built-in) + Drizzle ORM + drizzle-zod
- Zod v4, Orval codegen из OpenAPI spec → React Query хуки
- esbuild (ESM bundle) для API сервера
- pino логгер (НИКОГДА console.log в серверном коде — только req.log / logger)
- TailwindCSS v4 на фронте

БАЗА ДАННЫХ (КРИТИЧЕСКИ ВАЖНО):
- Только Replit PostgreSQL через DATABASE_URL env var
- На Replit: создай built-in PostgreSQL через вкладку Database — DATABASE_URL выставится сам
- НИКАКИХ SQLite / Supabase / Prisma / lowdb / JSON файлов
- Миграции: raw SQL через runMigrations() в artifacts/api-server/src/lib/migrate.ts
  Запускаются при каждом старте. CREATE TABLE / ADD COLUMN IF NOT EXISTS — безопасно.
- НИКАКОГО drizzle-kit, db:push, migrate:generate
- НИКАКОГО автосида и reset/truncate при старте — данные сохраняются через рестарты
- Добавление новых таблиц: только через migrate.ts (новый блок IF NOT EXISTS)

АУТЕНТИФИКАЦИЯ:
- JWT HS256 30 дней, подписывается JWT_SECRET из env
- Без JWT_SECRET сервер не стартует
- Token revoke: claim "tv" + users.token_version. POST /api/auth/logout инкрементирует версию → все токены пользователя сразу невалидны
- Кэш token_version в памяти, TTL 30s
- Роли: trader / curator / admin (список в auth-context.tsx и в middleware)
- Пользователи: пароли только в bcrypt (users.password_hash); начальные — из SEED_USERS

API ПРАВИЛА:
- Все маршруты: app.use("/api", router) → /api/trades, /api/events и т.д.
- Soft delete: поле deleted_at, GET фильтруют WHERE deleted_at IS NULL
- В продакшене Express раздаёт фронтенд из dist/public/
- requireAuthOnMutation middleware на все POST/PATCH/PUT/DELETE (allowlist: /auth/login)
- requireAdmin / requireCurator для защищённых эндпоинтов
- getActor(req): ТОЛЬКО из JWT (req.authUser.name) — не из query/body
- Rate limit /api/auth/login: 10 попыток / 15 мин на IP

БЕЗОПАСНОСТЬ:
- helmet без CSP (Replit iframe), cors ограничен REPLIT_DOMAINS в prod
- Пароли: bcrypt в users.password_hash. Колонки users.password НЕТ.
- Тикеры/range/interval валидируются regex перед запросом к Yahoo Finance

OBJECT STORAGE (Replit):
- objectStorageClient из lib/objectStorage.ts (GCS через Replit sidecar http://127.0.0.1:1106)
- Bucket: DEFAULT_OBJECT_STORAGE_BUCKET_ID env var
- Автобекапы: ws-lexx-backups/ префикс, pg_dump | gzip, каждые 48h, хранится последних 10
- Первый бекап: через 3 минуты после старта сервера

ФРОНТЕНД:
- Токен в localStorage["ws_lexx_token"]
- installFetchAuth() перехватывает все fetch('/api/*') → добавляет Authorization: Bearer
- Orval хуки: setAuthTokenGetter для авто-auth
- isAdmin / isCurator / me — из useAuth() хука (auth-context.tsx)

DEV ЗАПУСК (НЕ запускай pnpm dev в корне — там нет такого скрипта):
- API: pnpm --filter @workspace/api-server run dev (порт 8080)
- Frontend: pnpm --filter @workspace/edge-tracker run dev (порт из PORT env)

PRODUCTION BUILD:
- bash scripts/build-prod.sh
- Собирает фронт → artifacts/api-server/dist/public/
- Запуск: node --enable-source-maps artifacts/api-server/dist/index.mjs

TYPECHECK:
- pnpm run typecheck (typecheck:libs + все пакеты)
- Доверяй CLI, не editor/LSP если они расходятся

ЗАПРЕЩЕНО:
- console.log в серверном коде
- Менять тип id колонок (SERIAL)
- Добавлять SQLite/Supabase/Prisma/Sequelize
- Seed/reset при старте
- Хардкодить DATABASE_URL
- CSP в helmet
- Редактировать artifact.toml и .replit напрямую (используй artifacts skill)
- Запускать pnpm dev в корне монорепо
```

---

## API маршруты

```
GET  /api/healthz

POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me

GET/POST/PATCH/DELETE  /api/trades
GET/POST/DELETE        /api/trades/:id/executions
POST/GET               /api/trades/:id/ai-review

GET/POST/PATCH/DELETE  /api/events
GET/POST/PATCH/DELETE  /api/watchlist
GET/POST/PATCH/DELETE  /api/playbook
GET/POST/PATCH/DELETE  /api/research
GET/POST/PATCH/DELETE  /api/daily-feed
GET/POST/PATCH/DELETE  /api/discussions · /api/comments

GET/POST/PATCH/DELETE  /api/trade-ideas
POST                   /api/trade-ideas/:id/publish
POST                   /api/trade-ideas/:id/convert
GET                    /api/trade-ideas/stats

GET/POST/PATCH/DELETE  /api/checklist-template
POST/GET               /api/checklist-responses

GET/POST/PATCH/DELETE  /api/big7/tickers · /api/big7/levels · /api/big7/catalysts
GET/POST/PATCH/DELETE  /api/trading-rules · /api/rule-violations
GET/POST/PATCH/DELETE  /api/war-room-sessions · /api/war-room-levels
GET/POST/PATCH/DELETE  /api/emotional-state-log
GET/POST               /api/voice-notes
GET/POST/PATCH/DELETE  /api/trade-reactions

GET  /api/candles/:ticker
GET  /api/stockdata/quote · /api/stockdata/chart
GET  /api/fx/rates
GET  /api/news · /api/analyst-actions
GET  /api/market-conditions/dna
GET  /api/market-brief
GET  /api/sectors/strength
GET  /api/leaderboard
GET  /api/dashboard/stats
GET  /api/daily-quotes

GET  /api/admin/backups
POST /api/admin/backups/trigger
GET  /api/admin/backups/:name/download
GET  /api/admin/db-export
POST /api/admin/import-propreports
GET  /api/admin/users · PATCH /api/admin/users/:id
GET  /api/admin/audit-log
GET  /api/admin/content-reports
```

---

## Таблицы базы данных

`trades` · `market_events` · `research` · `daily_feed` · `discussions` · `comments`
`watchlist` · `playbook` · `users` · `activity_log` · `audit_log` · `trade_reactions`
`trade_reviews` · `trading_errors` · `big7_levels` · `big7_catalysts` · `big7_tickers`
`trader_ratings` · `war_room_sessions` · `war_room_levels` · `playbook_folder_settings`
`ticker_data_cache` · `news_cache` · `candles_cache` · `trade_executions`
`sector_strength_cache` · `holiday_calendar` · `market_open_brief_cache`
`analyst_actions_cache` · `pre_trade_checklist_template` · `pre_trade_checklist_responses`
`trade_ideas` · `trade_idea_reactions` · `ai_trade_reviews` · `ai_review_rate_limit`
`emotional_state_log` · `voice_notes` · `digest_subscriptions`
`weekly_psychology_reports` · `daily_quotes` · `discussion_votes`
`trading_rules` · `rule_violations` · `content_reports`

---

## Changelog

### v5.0 (2026-05-05)
- **Автоматические бекапы БД** — `pg_dump | gzip` → Replit Object Storage каждые 48h
  - Первый бекап через 3 минуты после старта сервера
  - Хранится последних 10 (~20 дней покрытие), старые автоудаляются
  - Аудит каждого бекапа в `audit_log` (actor=system, action=db.backup)
  - Admin UI: список, ручной запуск (admin), скачать .sql.gz (admin, signed URL 15 мин)
  - Кураторы: видят список бекапов
- **PropReports XLS импорт** — импорт сделок из бинарных XLS
  - Через UI: Админка → Инструменты → «Импорт сделок из PropReports»
  - Через CLI: `npx tsx scripts/src/import-propreports.ts <file> [--dry-run] [--trader=Имя]`
  - Дедупликация идемпотентна по `source + dedupKey`
  - 383 сделки Закира (фев–апр 2026) уже импортированы

### v4.0 (2026-04-30)
- AI Trade Review (Claude Sonnet-4-6) с кэшем по input-hash и rate limit 30/час
- Market Context DNA snapshot при создании трейда (SPY/QQQ/VIX + режим рынка)
- Pre-Trade Checklist (шаблоны + ответы per-трейд)
- Trade Ideas pipeline + stats страница + OutcomeBadge
- JWT auth с token revocation (token_version)
- Security hardening: helmet, cors, rate-limit, bcrypt для всех паролей
- Intraday chart (Yahoo Finance candles) + multi-fill executions с маркерами

### v3.0 (2026-04-10)
- Переход на pnpm monorepo
- Express 5 + Drizzle ORM
- Replit PostgreSQL (Supabase полностью удалён)
- War Room, Psychology reports, Emotional State tracker, Digest
