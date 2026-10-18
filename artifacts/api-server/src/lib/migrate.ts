import { pool } from "@workspace/db";
import { logger } from "./logger";
import { config } from "../config";

export async function runMigrations() {
  logger.info("Running database migrations...");

  const createStatements = [
    `CREATE TABLE IF NOT EXISTS "trades" (
      "id" SERIAL PRIMARY KEY,
      "ticker" TEXT NOT NULL,
      "date" TEXT NOT NULL,
      "setup" TEXT,
      "side" TEXT,
      "event_type" TEXT,
      "entry" NUMERIC(12,4),
      "exit" NUMERIC(12,4),
      "stop" NUMERIC(12,4),
      "result" TEXT NOT NULL,
      "pnl" NUMERIC(12,2),
      "r_multiple" NUMERIC(8,2),
      "hold_time" TEXT,
      "slippage" NUMERIC(8,2),
      "market_cap" TEXT,
      "float" TEXT,
      "relative_volume" NUMERIC(8,2),
      "session" TEXT,
      "screenshot_url" TEXT,
      "notes" TEXT,
      "what_worked" TEXT,
      "what_failed" TEXT,
      "conclusion" TEXT,
      "trader" TEXT,
      "tags" TEXT,
      "event_id" INTEGER,
      "pattern_id" INTEGER,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "market_events" (
      "id" SERIAL PRIMARY KEY,
      "ticker" TEXT NOT NULL,
      "date" TEXT NOT NULL,
      "event_type" TEXT NOT NULL,
      "headline" TEXT NOT NULL,
      "reaction" TEXT,
      "percent_move" NUMERIC(8,2),
      "volume" TEXT,
      "summary" TEXT,
      "screenshot_url" TEXT,
      "screenshot_notes" TEXT,
      "tags" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "research" (
      "id" SERIAL PRIMARY KEY,
      "pattern_name" TEXT NOT NULL,
      "ticker" TEXT,
      "context" TEXT,
      "market_condition" TEXT,
      "what_worked" TEXT,
      "what_failed" TEXT,
      "repeat_count" INTEGER DEFAULT 1,
      "confidence_level" INTEGER DEFAULT 50,
      "screenshot_url" TEXT,
      "screenshot_notes" TEXT,
      "tags" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "daily_feed" (
      "id" SERIAL PRIMARY KEY,
      "date" TEXT NOT NULL,
      "what_works_now" TEXT,
      "what_doesnt_work" TEXT,
      "best_tickers" TEXT,
      "market_theme" TEXT,
      "notes" TEXT,
      "tags" TEXT,
      "screenshot_url" TEXT,
      "screenshot_notes" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "discussions" (
      "id" SERIAL PRIMARY KEY,
      "topic" TEXT NOT NULL,
      "type" TEXT,
      "trader" TEXT,
      "notes" TEXT,
      "tags" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "comments" (
      "id" SERIAL PRIMARY KEY,
      "discussion_id" INTEGER NOT NULL,
      "trader" TEXT,
      "text" TEXT NOT NULL,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "watchlist" (
      "id" SERIAL PRIMARY KEY,
      "ticker" TEXT NOT NULL,
      "catalyst" TEXT,
      "target_price" NUMERIC(12,4),
      "stop_price" NUMERIC(12,4),
      "status" TEXT NOT NULL DEFAULT 'watching',
      "notes" TEXT,
      "sector" TEXT,
      "tags" TEXT,
      "screenshot_url" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "playbook" (
      "id" SERIAL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "setup_type" TEXT,
      "conditions" TEXT,
      "checklist" TEXT,
      "notes" TEXT,
      "confidence_level" INTEGER,
      "screenshot_url" TEXT,
      "screenshot_notes" TEXT,
      "tags" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "activity_log" (
      "id" SERIAL PRIMARY KEY,
      "action" TEXT NOT NULL,
      "section" TEXT NOT NULL,
      "entity_id" TEXT,
      "entity_title" TEXT,
      "trader" TEXT,
      "details" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "trade_reactions" (
      "id" SERIAL PRIMARY KEY,
      "trade_id" INTEGER NOT NULL,
      "trader" TEXT NOT NULL,
      "reaction_type" TEXT NOT NULL,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "trading_errors" (
      "id" SERIAL PRIMARY KEY,
      "trader" TEXT NOT NULL,
      "error_type" TEXT NOT NULL,
      "description" TEXT NOT NULL,
      "ticker" TEXT,
      "trade_id" INTEGER,
      "severity" TEXT NOT NULL DEFAULT 'medium',
      "lesson" TEXT,
      "resolved" TEXT NOT NULL DEFAULT 'no',
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "trade_reviews" (
      "id" SERIAL PRIMARY KEY,
      "trade_id" INTEGER NOT NULL,
      "curator" TEXT NOT NULL,
      "comment" TEXT NOT NULL,
      "rating" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "big7_levels" (
      "id" SERIAL PRIMARY KEY,
      "ticker" TEXT NOT NULL,
      "label" TEXT NOT NULL,
      "price" NUMERIC(12,4) NOT NULL,
      "notes" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "big7_catalysts" (
      "id" SERIAL PRIMARY KEY,
      "ticker" TEXT NOT NULL,
      "date" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "description" TEXT,
      "impact" TEXT NOT NULL DEFAULT 'medium',
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "users" (
      "id" SERIAL PRIMARY KEY,
      "name" TEXT NOT NULL UNIQUE,
      "role" TEXT NOT NULL DEFAULT 'trader',
      "active" BOOLEAN NOT NULL DEFAULT true,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "banned" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "banned_at" TIMESTAMPTZ`,
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "banned_reason" TEXT`,
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" TEXT`,
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "token_version" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "users" DROP COLUMN IF EXISTS "password"`,
    `CREATE TABLE IF NOT EXISTS "audit_log" (
      "id" SERIAL PRIMARY KEY,
      "actor" TEXT NOT NULL,
      "action" TEXT NOT NULL,
      "target_type" TEXT,
      "target_id" TEXT,
      "details" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS "audit_log_actor_idx" ON "audit_log"("actor")`,
    `CREATE INDEX IF NOT EXISTS "audit_log_action_idx" ON "audit_log"("action")`,
    `CREATE INDEX IF NOT EXISTS "audit_log_created_at_idx" ON "audit_log"("created_at")`,
    `CREATE TABLE IF NOT EXISTS "content_reports" (
      "id" SERIAL PRIMARY KEY,
      "reporter" TEXT NOT NULL,
      "target_type" TEXT NOT NULL,
      "target_id" TEXT NOT NULL,
      "reason" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'open',
      "resolved_by" TEXT,
      "resolved_at" TIMESTAMPTZ,
      "resolution" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS "content_reports_status_idx" ON "content_reports"("status")`,
    `CREATE INDEX IF NOT EXISTS "content_reports_target_idx" ON "content_reports"("target_type", "target_id")`,
    `CREATE INDEX IF NOT EXISTS "content_reports_created_at_idx" ON "content_reports"("created_at")`,
    `CREATE TABLE IF NOT EXISTS "trader_ratings" (
      "id" SERIAL PRIMARY KEY,
      "trader" TEXT NOT NULL,
      "curator" TEXT NOT NULL,
      "week" TEXT NOT NULL,
      "discipline" INTEGER DEFAULT 5,
      "risk_management" INTEGER DEFAULT 5,
      "execution" INTEGER DEFAULT 5,
      "journaling" INTEGER DEFAULT 5,
      "improvement" INTEGER DEFAULT 5,
      "overall" INTEGER DEFAULT 5,
      "comment" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "war_room_sessions" (
      "id" SERIAL PRIMARY KEY,
      "trader" TEXT,
      "event_name" TEXT NOT NULL,
      "event_time" TIMESTAMPTZ NOT NULL,
      "notes" TEXT,
      "checklist" JSONB,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "ended_at" TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS "war_room_levels" (
      "id" SERIAL PRIMARY KEY,
      "session_id" INTEGER NOT NULL REFERENCES "war_room_sessions"("id") ON DELETE CASCADE,
      "ticker" TEXT NOT NULL,
      "price" NUMERIC(12,4) NOT NULL,
      "label" TEXT NOT NULL,
      "type" TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS "playbook_folder_settings" (
      "folder_name" TEXT PRIMARY KEY,
      "color_index" INTEGER,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "ticker_data_cache" (
      "ticker" TEXT PRIMARY KEY,
      "market_cap" TEXT,
      "float" TEXT,
      "shares_outstanding" TEXT,
      "short_interest" NUMERIC(8,2),
      "atr" NUMERIC(12,4),
      "relative_volume" NUMERIC(8,2),
      "beta" NUMERIC(8,4),
      "average_daily_volume" TEXT,
      "sector" TEXT,
      "industry" TEXT,
      "long_name" TEXT,
      "raw" JSONB,
      "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "news_cache" (
      "id" SERIAL PRIMARY KEY,
      "ticker" TEXT NOT NULL,
      "guid" TEXT,
      "title" TEXT NOT NULL,
      "source" TEXT,
      "url" TEXT,
      "category" TEXT,
      "summary" TEXT,
      "published_at" TIMESTAMPTZ,
      "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "candles_cache" (
      "id" SERIAL PRIMARY KEY,
      "ticker" TEXT NOT NULL,
      "date" TEXT NOT NULL,
      "interval" TEXT NOT NULL,
      "extended" BOOLEAN NOT NULL DEFAULT FALSE,
      "ohlcv" JSONB NOT NULL,
      "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "trade_executions" (
      "id" SERIAL PRIMARY KEY,
      "trade_id" INTEGER NOT NULL REFERENCES "trades"("id") ON DELETE CASCADE,
      "kind" TEXT NOT NULL,
      "price" NUMERIC(12,4) NOT NULL,
      "qty" NUMERIC(12,2),
      "executed_at" TIMESTAMPTZ,
      "note" TEXT,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT trade_executions_kind_enum CHECK (kind IN ('entry', 'add', 'trim', 'exit', 'stop'))
    )`,
    `CREATE TABLE IF NOT EXISTS "sector_strength_cache" (
      "symbol" TEXT PRIMARY KEY,
      "name" TEXT,
      "price" NUMERIC(12,4),
      "change_pct" NUMERIC(8,4),
      "prev_close" NUMERIC(12,4),
      "trend_5d" NUMERIC(8,4),
      "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "holiday_calendar" (
      "id" SERIAL PRIMARY KEY,
      "date" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "description" TEXT,
      "importance" TEXT NOT NULL DEFAULT 'medium'
    )`,
    `CREATE TABLE IF NOT EXISTS "market_open_brief_cache" (
      "id" SERIAL PRIMARY KEY,
      "date" TEXT NOT NULL UNIQUE,
      "data" JSONB NOT NULL,
      "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "analyst_actions_cache" (
      "id" SERIAL PRIMARY KEY,
      "ticker" TEXT NOT NULL,
      "graded_at" TIMESTAMPTZ NOT NULL,
      "firm" TEXT NOT NULL,
      "action" TEXT NOT NULL,
      "to_grade" TEXT,
      "from_grade" TEXT,
      "source" TEXT NOT NULL DEFAULT 'yahoo',
      "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "pre_trade_checklist_template" (
      "id" SERIAL PRIMARY KEY,
      "label" TEXT NOT NULL,
      "description" TEXT,
      "required" BOOLEAN NOT NULL DEFAULT TRUE,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "active" BOOLEAN NOT NULL DEFAULT TRUE,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "pre_trade_checklist_responses" (
      "id" SERIAL PRIMARY KEY,
      "ticker" TEXT NOT NULL,
      "trade_date" TEXT NOT NULL,
      "trader" TEXT,
      "trade_id" INTEGER,
      "responses" TEXT NOT NULL,
      "passed" BOOLEAN NOT NULL DEFAULT FALSE,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "trade_ideas" (
      "id" SERIAL PRIMARY KEY,
      "ticker" TEXT NOT NULL,
      "side" TEXT,
      "setup" TEXT,
      "entry_zone" TEXT,
      "target" TEXT,
      "stop" TEXT,
      "thesis" TEXT,
      "score" INTEGER,
      "score_breakdown" TEXT,
      "status" TEXT NOT NULL DEFAULT 'draft',
      "trader" TEXT,
      "playbook_id" INTEGER,
      "watchlist_id" INTEGER,
      "screenshot_url" TEXT,
      "tags" TEXT,
      "published_at" TIMESTAMPTZ,
      "converted_trade_id" INTEGER,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "deleted_at" TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS "trade_idea_reactions" (
      "id" SERIAL PRIMARY KEY,
      "trade_idea_id" INTEGER NOT NULL,
      "trader" TEXT NOT NULL,
      "reaction" TEXT NOT NULL,
      "comment" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "ai_trade_reviews" (
      "id" SERIAL PRIMARY KEY,
      "trade_id" INTEGER NOT NULL,
      "model" TEXT NOT NULL,
      "prompt_hash" TEXT NOT NULL,
      "review_text" TEXT NOT NULL,
      "sections" JSONB,
      "input_tokens" INTEGER,
      "output_tokens" INTEGER,
      "cost_usd" NUMERIC(10,6),
      "generated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "ai_review_rate_limit" (
      "id" SERIAL PRIMARY KEY,
      "user_key" TEXT NOT NULL,
      "trade_id" INTEGER,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "emotional_state_log" (
      "id" SERIAL PRIMARY KEY,
      "user_id" TEXT NOT NULL,
      "date" TEXT NOT NULL,
      "sleep_well" BOOLEAN NOT NULL DEFAULT false,
      "stressed" BOOLEAN NOT NULL DEFAULT false,
      "tilted" BOOLEAN NOT NULL DEFAULT false,
      "focused" BOOLEAN NOT NULL DEFAULT false,
      "anxious" BOOLEAN NOT NULL DEFAULT false,
      "revenge" BOOLEAN NOT NULL DEFAULT false,
      "free_text" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "voice_notes" (
      "id" SERIAL PRIMARY KEY,
      "user_id" TEXT NOT NULL,
      "trade_id" INTEGER,
      "daily_feed_id" INTEGER,
      "audio_url" TEXT NOT NULL,
      "transcript" TEXT,
      "duration_sec" INTEGER,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "digest_subscriptions" (
      "id" SERIAL PRIMARY KEY,
      "trader" TEXT NOT NULL UNIQUE,
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "channel" TEXT NOT NULL DEFAULT 'none',
      "telegram_chat_id" TEXT,
      "email" TEXT,
      "send_morning" BOOLEAN NOT NULL DEFAULT true,
      "send_evening" BOOLEAN NOT NULL DEFAULT true,
      "trades_window_hours" INTEGER NOT NULL DEFAULT 24,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS "weekly_psychology_reports" (
      "id" SERIAL PRIMARY KEY,
      "user_id" TEXT NOT NULL,
      "week_start" TEXT NOT NULL,
      "week_end" TEXT NOT NULL,
      "total_trades" INTEGER NOT NULL DEFAULT 0,
      "total_checkins" INTEGER NOT NULL DEFAULT 0,
      "emotional_breakdown" JSONB,
      "best_state" TEXT,
      "worst_state" TEXT,
      "total_pnl" TEXT NOT NULL DEFAULT '0',
      "avg_pnl_per_trade" TEXT NOT NULL DEFAULT '0',
      "win_rate" TEXT NOT NULL DEFAULT '0',
      "key_insights" JSONB,
      "raw_stats" JSONB,
      "generated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS "weekly_psych_reports_user_idx" ON "weekly_psychology_reports"("user_id")`,
    `CREATE INDEX IF NOT EXISTS "weekly_psych_reports_week_start_idx" ON "weekly_psychology_reports"("week_start")`,
    `CREATE INDEX IF NOT EXISTS "weekly_psych_reports_user_week_idx" ON "weekly_psychology_reports"("user_id", "week_start")`,
    `CREATE TABLE IF NOT EXISTS "big7_tickers" (
      "id" SERIAL PRIMARY KEY,
      "symbol" TEXT NOT NULL,
      "exchange" TEXT NOT NULL DEFAULT 'NASDAQ',
      "name" TEXT NOT NULL,
      "group_name" TEXT NOT NULL DEFAULT 'core',
      "position" INTEGER NOT NULL DEFAULT 0,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS "big7_tickers_group_idx" ON "big7_tickers"("group_name")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "big7_tickers_group_symbol_unique" ON "big7_tickers"("group_name", "symbol")`,
    `CREATE TABLE IF NOT EXISTS "daily_quotes" (
      "id" SERIAL PRIMARY KEY,
      "date" TEXT NOT NULL,
      "trading_ru" TEXT NOT NULL,
      "trading_uz" TEXT NOT NULL,
      "trading_uk" TEXT NOT NULL,
      "trading_author" TEXT,
      "psychology_ru" TEXT NOT NULL,
      "psychology_uz" TEXT NOT NULL,
      "psychology_uk" TEXT NOT NULL,
      "psychology_author" TEXT,
      "source" TEXT NOT NULL DEFAULT 'ai',
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `ALTER TABLE "daily_quotes" ADD COLUMN IF NOT EXISTS "trading_en" TEXT`,
    `ALTER TABLE "daily_quotes" ADD COLUMN IF NOT EXISTS "psychology_en" TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "daily_quotes_date_unique" ON "daily_quotes"("date")`,
    `CREATE TABLE IF NOT EXISTS "discussion_votes" (
      "id" SERIAL PRIMARY KEY,
      "discussion_id" INTEGER NOT NULL REFERENCES "discussions"("id") ON DELETE CASCADE,
      "trader" TEXT NOT NULL,
      "value" INTEGER NOT NULL,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "discussion_votes_unique" ON "discussion_votes"("discussion_id", "trader")`,
    `CREATE INDEX IF NOT EXISTS "discussion_votes_discussion_idx" ON "discussion_votes"("discussion_id")`,
    `CREATE TABLE IF NOT EXISTS "trading_rules" (
      "id" SERIAL PRIMARY KEY,
      "trader" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "threshold" JSONB NOT NULL,
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS "trading_rules_trader_idx" ON "trading_rules"("trader")`,
    `CREATE TABLE IF NOT EXISTS "rule_violations" (
      "id" SERIAL PRIMARY KEY,
      "trader" TEXT NOT NULL,
      "rule_id" INTEGER NOT NULL REFERENCES "trading_rules"("id") ON DELETE CASCADE,
      "trade_id" INTEGER,
      "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "severity" TEXT NOT NULL DEFAULT 'medium',
      "message" TEXT NOT NULL,
      "details" JSONB
    )`,
    `CREATE INDEX IF NOT EXISTS "rule_violations_trader_idx" ON "rule_violations"("trader")`,
    `CREATE INDEX IF NOT EXISTS "rule_violations_rule_idx" ON "rule_violations"("rule_id")`,
    `CREATE INDEX IF NOT EXISTS "rule_violations_occurred_idx" ON "rule_violations"("occurred_at")`,
    // Archive marker (lib/violationArchive): violations of disabled / deleted rules and stale ones with human input are
    // kept, not deleted. Also added by rulesEngine.ensureRulesSchema; here so every query sees the column at startup.
    `ALTER TABLE "rule_violations" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMPTZ`,
    `ALTER TABLE "rule_violations" ADD COLUMN IF NOT EXISTS "archived_reason" TEXT`,
    `CREATE INDEX IF NOT EXISTS "analyst_actions_ticker_idx" ON "analyst_actions_cache"("ticker")`,
    `CREATE INDEX IF NOT EXISTS "analyst_actions_graded_at_idx" ON "analyst_actions_cache"("graded_at")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "analyst_actions_unique" ON "analyst_actions_cache"("ticker", "graded_at", "firm", "action")`,
    `CREATE TABLE IF NOT EXISTS "author_notes" (
      "id" SERIAL PRIMARY KEY,
      "trader" TEXT NOT NULL,
      "note_date" DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'America/New_York')::date),
      "raw_text" TEXT NOT NULL DEFAULT '',
      "refined_text" TEXT,
      "mood" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE("trader", "note_date")
    )`,
    `CREATE INDEX IF NOT EXISTS "author_notes_trader_date_idx" ON "author_notes"("trader", "note_date")`,
    `CREATE TABLE IF NOT EXISTS "author_weekly_summaries" (
      "id" SERIAL PRIMARY KEY,
      "trader" TEXT NOT NULL,
      "week_start" DATE NOT NULL,
      "week_end" DATE NOT NULL,
      "summary" TEXT NOT NULL,
      "quote_of_week" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE("trader", "week_start")
    )`,

    `ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_chat_id_idx ON users(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_linked_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_curator TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_risk_manager TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_mentor TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS tg_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE`,

    `ALTER TABLE trade_ideas ADD COLUMN IF NOT EXISTS review_status TEXT`,
    `ALTER TABLE trade_ideas ADD COLUMN IF NOT EXISTS review_reason TEXT`,
    `ALTER TABLE trade_ideas ADD COLUMN IF NOT EXISTS reviewed_by TEXT`,
    `ALTER TABLE trade_ideas ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`,

    `CREATE TABLE IF NOT EXISTS "telegram_link_tokens" (
      "id" SERIAL PRIMARY KEY,
      "token" TEXT NOT NULL UNIQUE,
      "user_name" TEXT NOT NULL,
      "expires_at" TIMESTAMPTZ NOT NULL,
      "used" BOOLEAN NOT NULL DEFAULT FALSE,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS "telegram_pending_actions" (
      "id" SERIAL PRIMARY KEY,
      "telegram_chat_id" TEXT NOT NULL UNIQUE,
      "action" TEXT NOT NULL,
      "idea_id" INTEGER NOT NULL,
      "expires_at" TIMESTAMPTZ NOT NULL,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS "trade_idea_comments" (
      "id" SERIAL PRIMARY KEY,
      "idea_id" INTEGER NOT NULL,
      "author_name" TEXT NOT NULL,
      "text" TEXT NOT NULL,
      "is_private" BOOLEAN NOT NULL DEFAULT FALSE,
      "source" TEXT NOT NULL DEFAULT 'website',
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS "trade_idea_comments_idea_idx" ON "trade_idea_comments"("idea_id")`,

    `CREATE TABLE IF NOT EXISTS "notifications" (
      "id" SERIAL PRIMARY KEY,
      "user_name" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "idea_id" INTEGER,
      "message" TEXT NOT NULL,
      "is_read" BOOLEAN NOT NULL DEFAULT FALSE,
      "source" TEXT NOT NULL DEFAULT 'system',
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS "notifications_user_unread_idx" ON "notifications"("user_name", "is_read")`,
  ];

  for (const sql of createStatements) {
    try {
      await pool.query(sql);
      const tableName = sql.match(/"(\w+)"/)?.[1] || "unknown";
      logger.info(`Migration: table ${tableName} OK`);
    } catch (e: any) {
      logger.error({ error: e.message }, "Migration: table creation error");
    }
  }

  const addColumns = [
    { table: "trades", column: "screenshot_notes", type: "TEXT" },
    { table: "trades", column: "side", type: "TEXT" },
    { table: "trades", column: "tags", type: "TEXT" },
    { table: "market_events", column: "tags", type: "TEXT" },
    { table: "research", column: "tags", type: "TEXT" },
    { table: "daily_feed", column: "tags", type: "TEXT" },
    { table: "daily_feed", column: "screenshot_url", type: "TEXT" },
    { table: "discussions", column: "tags", type: "TEXT" },
    { table: "discussions", column: "type", type: "TEXT" },
    { table: "discussions", column: "trader", type: "TEXT" },
    { table: "discussions", column: "ticker", type: "TEXT" },
    { table: "watchlist", column: "tags", type: "TEXT" },
    { table: "watchlist", column: "sector", type: "TEXT" },
    { table: "watchlist", column: "screenshot_url", type: "TEXT" },
    { table: "playbook", column: "tags", type: "TEXT" },
    { table: "market_events", column: "screenshot_notes", type: "TEXT" },
    { table: "research", column: "screenshot_notes", type: "TEXT" },
    { table: "daily_feed", column: "screenshot_notes", type: "TEXT" },
    { table: "playbook", column: "screenshot_notes", type: "TEXT" },
    { table: "trades", column: "pattern_id", type: "INTEGER" },
    { table: "trades", column: "deleted_at", type: "TIMESTAMPTZ" },
    { table: "playbook", column: "folder", type: "TEXT" },
    { table: "playbook", column: "source_type", type: "TEXT" },
    { table: "playbook", column: "source_id", type: "INTEGER" },
    { table: "playbook", column: "deleted_at", type: "TIMESTAMPTZ" },
    { table: "watchlist", column: "deleted_at", type: "TIMESTAMPTZ" },
    { table: "market_events", column: "deleted_at", type: "TIMESTAMPTZ" },
    { table: "research", column: "deleted_at", type: "TIMESTAMPTZ" },
    { table: "daily_feed", column: "deleted_at", type: "TIMESTAMPTZ" },
    { table: "discussions", column: "deleted_at", type: "TIMESTAMPTZ" },
    // «Кому видна тема»: NULL = everyone (lib/discussionAudience).
    { table: "discussions", column: "audience", type: "TEXT[]" },
    { table: "trades", column: "playbook_id", type: "INTEGER" },
    { table: "playbook", column: "parent_id", type: "INTEGER" },
    { table: "users", column: "theme", type: "TEXT DEFAULT 'dark'" },
    { table: "trades", column: "atr", type: "NUMERIC(12,4)" },
    { table: "trades", column: "sector", type: "TEXT" },
    { table: "watchlist", column: "score", type: "INTEGER" },
    { table: "watchlist", column: "score_breakdown", type: "TEXT" },
    { table: "watchlist", column: "scored_at", type: "TIMESTAMPTZ" },
    { table: "trades", column: "context_snapshot", type: "JSONB" },
    { table: "trades", column: "conviction", type: "INTEGER" },
    { table: "trades", column: "confidence_grade", type: "TEXT" },
    { table: "trades", column: "beta", type: "NUMERIC(8,4)" },
    { table: "trades", column: "short_interest", type: "NUMERIC(8,4)" },
    { table: "trades", column: "adv", type: "TEXT" },
    { table: "trades", column: "long_name", type: "TEXT" },
    { table: "trade_ideas", column: "market_cap", type: "TEXT" },
    { table: "trade_ideas", column: "float", type: "TEXT" },
    { table: "trade_ideas", column: "adv", type: "TEXT" },
    { table: "trade_ideas", column: "atr", type: "NUMERIC(12,4)" },
    { table: "trade_ideas", column: "relative_volume", type: "NUMERIC(8,2)" },
    { table: "trade_ideas", column: "beta", type: "NUMERIC(8,4)" },
    { table: "trade_ideas", column: "short_interest", type: "NUMERIC(8,4)" },
    { table: "trade_ideas", column: "sector", type: "TEXT" },
    { table: "trade_ideas", column: "long_name", type: "TEXT" },
    { table: "trade_ideas", column: "notes", type: "TEXT" },
    { table: "trade_ideas", column: "idea_date", type: "TEXT" },
    { table: "trade_ideas", column: "risk_amount", type: "NUMERIC(12,2)" },
    { table: "trade_ideas", column: "setup_quality", type: "TEXT" },
    { table: "watchlist", column: "market_cap", type: "TEXT" },
    { table: "watchlist", column: "float", type: "TEXT" },
    { table: "watchlist", column: "adv", type: "TEXT" },
    { table: "watchlist", column: "atr", type: "NUMERIC(12,4)" },
    { table: "watchlist", column: "relative_volume", type: "NUMERIC(8,2)" },
    { table: "watchlist", column: "beta", type: "NUMERIC(8,4)" },
    { table: "watchlist", column: "short_interest", type: "NUMERIC(8,4)" },
    { table: "watchlist", column: "long_name", type: "TEXT" },
    // Team-shared «В игре» flag for the watchlist (additive).
    { table: "watchlist", column: "in_play", type: "BOOLEAN NOT NULL DEFAULT FALSE" },
    { table: "watchlist", column: "in_play_at", type: "TIMESTAMPTZ" },
    { table: "market_events", column: "market_cap", type: "TEXT" },
    { table: "market_events", column: "float", type: "TEXT" },
    { table: "market_events", column: "adv", type: "TEXT" },
    { table: "market_events", column: "atr", type: "NUMERIC(12,4)" },
    { table: "market_events", column: "relative_volume", type: "NUMERIC(8,2)" },
    { table: "market_events", column: "beta", type: "NUMERIC(8,4)" },
    { table: "market_events", column: "short_interest", type: "NUMERIC(8,4)" },
    { table: "market_events", column: "sector", type: "TEXT" },
    { table: "market_events", column: "long_name", type: "TEXT" },
    { table: "research", column: "market_cap", type: "TEXT" },
    { table: "research", column: "float", type: "TEXT" },
    { table: "research", column: "adv", type: "TEXT" },
    { table: "research", column: "atr", type: "NUMERIC(12,4)" },
    { table: "research", column: "relative_volume", type: "NUMERIC(8,2)" },
    { table: "research", column: "beta", type: "NUMERIC(8,4)" },
    { table: "research", column: "short_interest", type: "NUMERIC(8,4)" },
    { table: "research", column: "sector", type: "TEXT" },
    { table: "research", column: "long_name", type: "TEXT" },
    { table: "playbook", column: "ticker", type: "TEXT" },
    { table: "playbook", column: "market_cap", type: "TEXT" },
    { table: "playbook", column: "float", type: "TEXT" },
    { table: "playbook", column: "adv", type: "TEXT" },
    { table: "playbook", column: "atr", type: "NUMERIC(12,4)" },
    { table: "playbook", column: "relative_volume", type: "NUMERIC(8,2)" },
    { table: "playbook", column: "beta", type: "NUMERIC(8,4)" },
    { table: "playbook", column: "short_interest", type: "NUMERIC(8,4)" },
    { table: "playbook", column: "sector", type: "TEXT" },
    { table: "playbook", column: "long_name", type: "TEXT" },
    { table: "playbook", column: "checklist_items", type: "JSONB" },
    { table: "playbook", column: "screenshots", type: "JSONB" },
    { table: "news_cache", column: "is_ticker_specific", type: "BOOLEAN DEFAULT FALSE" },
    // Source URL for analyst actions: links back to news article (for source='news')
    // or Yahoo Finance analysis page (for source='yahoo'). Lets the user click
    // through to the original article / Yahoo page from the UI.
    { table: "analyst_actions_cache", column: "source_url", type: "TEXT" },
    { table: "analyst_actions_cache", column: "price_target", type: "TEXT" },
    { table: "analyst_actions_cache", column: "price_target_from", type: "TEXT" },
  ];

  for (const m of addColumns) {
    try {
      await pool.query(`ALTER TABLE "${m.table}" ADD COLUMN IF NOT EXISTS "${m.column}" ${m.type}`);
    } catch (e: any) {
      logger.warn({ error: e.message }, `Migration: column ${m.table}.${m.column}`);
    }
  }

  // Ариф → Ориф rename: src/db/migrations/0008_rename_arif_orif.sql (no longer re-run on every boot).

  await pool.query(`
    CREATE TABLE IF NOT EXISTS playbook_checklist_marks (
      playbook_id INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      trader TEXT NOT NULL DEFAULT '',
      done BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (playbook_id, item_id, scope, trader)
    )
  `).catch((e: any) => logger.warn({ error: e.message }, "Migration: create playbook_checklist_marks"));
  await pool.query(`CREATE INDEX IF NOT EXISTS playbook_checklist_marks_playbook_idx ON playbook_checklist_marks (playbook_id)`).catch(() => {});

  try {
    const { rows: legacy } = await pool.query<{ id: number; checklist: string | null; screenshot_url: string | null; screenshot_notes: string | null }>(
      `SELECT id, checklist, screenshot_url, screenshot_notes
       FROM playbook
       WHERE (checklist_items IS NULL AND checklist IS NOT NULL AND checklist != '')
          OR (screenshots IS NULL AND screenshot_url IS NOT NULL AND screenshot_url != '')`
    );
    let migratedChecklists = 0, migratedScreens = 0;
    for (const row of legacy) {
      if (row.checklist) {
        const items = row.checklist.split("\n")
          .map((l) => l.replace(/^[-•*]\s*/, "").trim())
          .filter(Boolean)
          .map((text) => {
            let h = 0;
            for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
            return { id: `t${(h >>> 0).toString(36)}`, text };
          });
        if (items.length > 0) {
          await pool.query(`UPDATE playbook SET checklist_items = $1::jsonb WHERE id = $2 AND checklist_items IS NULL`, [JSON.stringify(items), row.id]);
          migratedChecklists++;
        }
      }
      if (row.screenshot_url) {
        const urls = row.screenshot_url.split("\n").map((u) => u.trim()).filter(Boolean);
        let notes: string[] = [];
        if (row.screenshot_notes) {
          try {
            const parsed = JSON.parse(row.screenshot_notes);
            if (Array.isArray(parsed)) notes = parsed.map((n) => typeof n === "string" ? n : "");
          } catch {
            notes = row.screenshot_notes.split("\n");
          }
        }
        const items = urls.map((url, i) => ({ url, notes: notes[i] || "" }));
        if (items.length > 0) {
          await pool.query(`UPDATE playbook SET screenshots = $1::jsonb WHERE id = $2 AND screenshots IS NULL`, [JSON.stringify(items), row.id]);
          migratedScreens++;
        }
      }
    }
    if (migratedChecklists || migratedScreens) {
      logger.info(`Backfilled jsonb: ${migratedChecklists} checklists, ${migratedScreens} screenshot sets`);
    }

    const { rows: legacyIdRows } = await pool.query<{ id: number; checklist_items: any }>(
      `SELECT id, checklist_items FROM playbook
       WHERE checklist_items IS NOT NULL
         AND checklist_items::text LIKE '%"legacy-%'`
    );
    let reidCount = 0;
    for (const row of legacyIdRows) {
      if (!Array.isArray(row.checklist_items)) continue;
      const fixed = row.checklist_items.map((it: any) => {
        const text = String(it?.text ?? "").trim();
        if (!text) return null;
        let h = 0;
        for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
        return { id: `t${(h >>> 0).toString(36)}`, text };
      }).filter(Boolean);
      await pool.query(`UPDATE playbook SET checklist_items = $1::jsonb WHERE id = $2`, [JSON.stringify(fixed), row.id]);
      reidCount++;
    }
    if (reidCount) logger.info(`Re-IDed ${reidCount} playbook checklists to content-hash IDs`);
  } catch (e: any) {
    logger.warn({ error: e.message }, "Migration: backfill checklist_items/screenshots");
  }

  // Legacy playbook_trade_ideas: dropped when empty by src/db/migrations/0007_drop_playbook_trade_ideas.sql (the merge failed on every boot).

  // 2026-04-22 playbook restore window: src/db/migrations/0009_restore_playbook_20260422.sql.

  // Initial accounts come from SEED_USERS (JSON: [{"name","password","role"}]) — no PINs in the code.
  // Without it, a fresh dev DB gets the desk names with random 6-digit PINs that are NEVER logged (A1 security):
  // choose them with SEED_USERS, or set them later via an admin reset / POST /auth/init-passwords.
  const defaultUsers: { name: string; password: string; role: string }[] = (() => {
    try {
      const parsed = JSON.parse(config.seedUsers ?? "null");
      if (Array.isArray(parsed)) return parsed.filter((u) => u && typeof u.name === "string" && typeof u.password === "string");
    } catch (e: any) { logger.warn({ error: e.message }, "SEED_USERS is not valid JSON"); }
    if (config.isProduction) return [];
    const rand = () => String(Math.floor(100000 + Math.random() * 900000));
    return [
      { name: "Закир", role: "trader" }, { name: "Антон", role: "curator" }, { name: "Артур", role: "trader" },
      { name: "Рахматулло", role: "trader" }, { name: "Умид", role: "trader" }, { name: "Максат", role: "trader" },
      { name: "Тимур", role: "curator" }, { name: "Ориф", role: "curator" },
    ].map((u) => ({ ...u, password: rand(), generated: true }));
  })();
  const { rows: existingUsers } = await pool.query(`SELECT COUNT(*) as cnt FROM users`);
  if (Number(existingUsers[0]?.cnt) === 0) {
    logger.info("Seeding default users...");
    const bcrypt = (await import("bcryptjs")).default;
    for (const u of defaultUsers) {
      try {
        const hash = await bcrypt.hash(u.password, 10);
        await pool.query(`INSERT INTO users (name, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`, [u.name, hash, u.role]);
      } catch (e: any) { logger.warn({ error: e.message }, `Seed user ${u.name}`); }
    }
    if (defaultUsers.some((u: any) => u.generated)) {
      logger.info({ users: defaultUsers.map((u) => u.name) }, "Dev users seeded with random PINs (not logged; set SEED_USERS to choose them)");
    }
    logger.info("Default users seeded");
  } else {
    const { rows: nullHashUsers } = await pool.query(`SELECT name FROM users WHERE password_hash IS NULL`);
    if (nullHashUsers.length > 0) {
      logger.info({ count: nullHashUsers.length }, "Fixing users with NULL password_hash...");
      const bcrypt = (await import("bcryptjs")).default;
      for (const u of defaultUsers) {
        try {
          const hash = await bcrypt.hash(u.password, 10);
          await pool.query(
            `UPDATE users SET password_hash = $1 WHERE name = $2 AND password_hash IS NULL`,
            [hash, u.name]
          );
        } catch (e: any) { logger.warn({ error: e.message }, `Fix password for ${u.name}`); }
      }
      if (defaultUsers.some((u: any) => u.generated)) {
        const fixed = new Set(nullHashUsers.map((r: any) => r.name));
        logger.info({ users: defaultUsers.filter((u) => fixed.has(u.name)).map((u) => u.name) }, "Dev users got random PINs (not logged; set SEED_USERS to choose them)");
      }
      logger.info("NULL password_hash users fixed");
    }
  }

  const smbStrategies = [
    { name: "ATM Offering Play — Short", folder: "SMB Capital — Offering Plays", setupType: "other", confidenceLevel: 80, conditions: "Stock announces ATM offering (shelf registration). Price drops on dilution fear. Short into the bounce after initial panic selling.", checklist: "- ATM offering confirmed (SEC filing)\n- Price dropped >5% on news\n- Volume spike > 3x average\n- Wait for first bounce attempt\n- Entry on failed bounce / rejection at VWAP\n- Stop above pre-market high", notes: "One of SMB Capital's core plays. ATM offerings create sustained selling pressure as the company sells shares into the open market. Key: don't short the initial drop, wait for the bounce attempt and short the failure." },
    { name: "Pricing Play — Long Bounce", folder: "SMB Capital — Offering Plays", setupType: "Reversal", confidenceLevel: 65, conditions: "After offering is priced (usually after hours), stock often gaps down to or below offering price. Long bounce off offering price level.", checklist: "- Offering priced (press release confirms price)\n- Stock trades at or below offering price\n- Volume confirms capitulation\n- Entry near offering price with tight stop\n- Target: VWAP or prior support turned resistance", notes: "Offering price acts as strong support because institutions bought at that level. They defend their position. Key risk: if offering price breaks, there's no floor." },
    { name: "Gap and Go — Earnings Momentum", folder: "SMB Capital — Gap Plays", setupType: "Earnings Gap Up", confidenceLevel: 75, conditions: "Stock gaps up >5% on strong earnings. Follow-through buying in first 30 minutes. Long continuation above opening range.", checklist: "- Earnings beat expectations significantly\n- Gap > 5% with volume > 2x average\n- Stock holds above VWAP in first 15 min\n- Entry on first pullback to VWAP or opening range high break\n- Stop below VWAP or opening range low\n- Target: prior resistance levels", notes: "Classic SMB play. The key is waiting for the first pullback rather than chasing the gap. Quality of earnings matters — revenue growth > EPS beats." },
    { name: "IPO Day Trade — First Day Play", folder: "SMB Capital — IPO Plays", setupType: "IPO Day Trade", confidenceLevel: 60, conditions: "First day of trading for IPO. Wait for opening range to establish (first 5-15 min), then trade the breakout or breakdown.", checklist: "- IPO with significant hype/demand\n- Wait for opening print and first range\n- Don't trade first 5 minutes\n- Long above opening range high OR short below opening range low\n- Use half size (IPO = volatile)\n- Stop: middle of opening range", notes: "SMB teaches patience on IPO day 1. The opening range is key. Many traders get chopped trying to trade the first 5 minutes. Wait for the range, then trade the break." },
    { name: "Second Day Play — Momentum Continuation", folder: "SMB Capital — Gap Plays", setupType: "Second Day Play", confidenceLevel: 70, conditions: "Stock had a big move Day 1 (earnings, news, IPO). Day 2 continuation trade — long above Day 1 high or short below Day 1 low.", checklist: "- Day 1 move was >10% on catalyst\n- Pre-market shows continuation interest\n- Entry above Day 1 high (long) or below Day 1 low (short)\n- Volume confirmation needed\n- Stop: Day 1 close or VWAP\n- Target: measured move from Day 1 range", notes: "Second Day Play is one of SMB's signature setups. The idea: momentum from Day 1 carries into Day 2. Best when the catalyst is fundamental (earnings, FDA) rather than technical." },
    { name: "VWAP Trend Trade — Intraday", folder: "SMB Capital — Intraday Setups", setupType: "Intraday Momentum", confidenceLevel: 75, conditions: "Stock trends above/below VWAP all day. Trade pullbacks to VWAP in direction of the trend. Long if above, short if below.", checklist: "- Clear trend direction established by 10:00 AM\n- Stock respects VWAP as support (uptrend) or resistance (downtrend)\n- Entry on pullback to VWAP with volume dry-up\n- Stop: VWAP cross (close below for longs, above for shorts)\n- Trail stop using rising/falling VWAP", notes: "VWAP is the institutional benchmark. When a stock trends above VWAP, institutions are net buyers. When below, net sellers. This creates a self-reinforcing cycle." },
    { name: "Parabolic Short — Extended Stock", folder: "SMB Capital — Short Setups", setupType: "Reversal", confidenceLevel: 65, conditions: "Stock goes parabolic (vertical move up 30%+ intraday). Short the blow-off top when momentum exhausts.", checklist: "- Stock up >30% intraday on low/mid float\n- Parabolic arc visible on 1-min chart\n- Wait for first red candle after vertical move\n- Volume climax (highest volume candle of the day)\n- Entry on break of first red candle low\n- Stop above high of day\n- Target: VWAP or 50% retrace", notes: "High risk / high reward. SMB teaches strict rules: NEVER short into strength. Wait for the first crack. Use small size. The blow-off top often comes with a volume climax — that's your signal." },
    { name: "Opening Range Breakout (ORB)", folder: "SMB Capital — Intraday Setups", setupType: "Breakout", confidenceLevel: 72, conditions: "First 5/15/30 minute range establishes. Trade the breakout above the high or breakdown below the low of that range.", checklist: "- Define opening range (5min, 15min, or 30min)\n- Wait for range to complete\n- Long above range high / Short below range low\n- Volume must confirm breakout (> average)\n- Stop: opposite side of range or midpoint\n- Target: 1:1 then trail", notes: "ORB is a bread-and-butter SMB setup. The opening range captures the battle between buyers and sellers. When one side wins (breakout), the move can be powerful. Best on days with catalyst." },
    { name: "Low Float Momentum — Float Rotation", folder: "SMB Capital — Intraday Setups", setupType: "Intraday Momentum", confidenceLevel: 60, conditions: "Low float stock (<20M shares) with catalyst. When volume > float (float rotation), momentum can carry the stock much further than expected.", checklist: "- Float < 20M shares\n- Catalyst (earnings, news, FDA)\n- Volume approaching or exceeding float\n- Stock making new HOD with increasing volume\n- Entry on pullback or flag break\n- Small size (low float = volatile)\n- Stop: prior consolidation low", notes: "Float rotation = when the entire float has traded hands. At this point, there are no more 'trapped' sellers and the stock can run much further. Key metric: volume/float ratio." },
    { name: "Failed Follow Through — Bear Flag Short", folder: "SMB Capital — Short Setups", setupType: "Reversal", confidenceLevel: 73, conditions: "Stock had a big move up but fails to follow through. Forms a bear flag (weak bounce on low volume). Short the breakdown of the flag.", checklist: "- Prior move up on Day 1\n- Day 2/3: weak bounce, low volume\n- Bear flag pattern forms (lower highs)\n- Entry on break below flag support\n- Volume increases on breakdown\n- Stop above flag high\n- Target: measured move down (flag pole)", notes: "Failed follow-through is the opposite of the Second Day Play. When momentum should continue but doesn't, it's a powerful reversal signal. SMB uses this as one of their primary short setups." },
    { name: "Short Squeeze Play", folder: "SMB Capital — Momentum Setups", setupType: "Intraday Momentum", confidenceLevel: 55, conditions: "High short interest stock (>20%) gets a catalyst. Short sellers forced to cover, creating buying pressure and rapid price increase.", checklist: "- Short interest > 20% of float\n- Catalyst (earnings beat, news, upgrade)\n- Pre-market gap up with high volume\n- Entry on first pullback after initial squeeze\n- Monitor short interest data / borrow rates\n- Tight stop (if squeeze fails, reversal is sharp)\n- Target: prior resistance levels from weekly chart", notes: "Short squeezes are unpredictable. SMB teaches to trade them small and respect the volatility. The best squeezes happen when fundamental catalyst + high short interest + low float combine." },
    { name: "Sympathy Play — Sector Follower", folder: "SMB Capital — Momentum Setups", setupType: "Intraday Momentum", confidenceLevel: 60, conditions: "When a sector leader makes a big move, other stocks in the same sector often follow (sympathy move). Trade the follower.", checklist: "- Identify the sector leader making the move\n- Find related stocks in same sector/industry\n- Sympathy stock should have its own catalyst or setup\n- Entry on breakout or momentum confirmation\n- Don't chase — wait for your setup\n- Stop based on the sympathy stock's chart, not the leader\n- Target: proportional move to leader", notes: "Sympathy plays are a staple of prop trading. When NVDA moves, watch AMD, AVGO, MU. When one biotech gets FDA approval, watch similar pipeline companies. Key: the leader goes first, sympathies follow with a delay." },
    { name: "Halt & Resume Play", folder: "SMB Capital — Intraday Setups", setupType: "other", confidenceLevel: 65, conditions: "Stock gets halted (LULD halt or news halt). Trade the resume — either continuation or reversal depending on context.", checklist: "- Note halt type (LULD up/down, news pending)\n- During halt: assess catalyst, level 2, pre-halt momentum\n- On resume: wait 30 seconds for price discovery\n- If continuation: long above halt price (up halt) or short below (down halt)\n- If reversal: opposite direction after failed continuation\n- Use small size — halts = maximum volatility\n- Stop: opposite side of resume range", notes: "Halt resumes are some of the highest-volatility moments in trading. SMB teaches discipline: don't place orders during halt, wait for resume, let price discover, then act. Many traders get destroyed by blindly buying/shorting halts." },
    { name: "Anchored VWAP — Earnings / IPO Level", folder: "SMB Capital — Intraday Setups", setupType: "Breakout", confidenceLevel: 70, conditions: "Anchored VWAP from significant event (earnings, IPO, offering) acts as key support/resistance. Trade the reaction at this level.", checklist: "- Identify significant event date (earnings, IPO, offering)\n- Calculate anchored VWAP from that date\n- Wait for price to reach anchored VWAP level\n- Look for reaction (bounce or break)\n- Entry on confirmation of direction\n- Stop: other side of anchored VWAP\n- Target: next significant level", notes: "Anchored VWAP shows the average price paid by all participants since a significant event. Institutions track this level closely. It's especially powerful from earnings dates and IPO dates." },
    { name: "9 EMA Daily — Swing Entry на Trend", folder: "SMB Capital — Swing Setups", setupType: "Breakout", confidenceLevel: 74, conditions: "Stock in strong uptrend pulls back to 9 EMA on daily chart. This is the 'trend pullback' entry for swing traders.", checklist: "- Stock in clear uptrend (higher highs, higher lows)\n- Pullback to 9 EMA daily (within 1-2% of EMA)\n- Volume decreases on pullback\n- Entry on bounce off 9 EMA with volume\n- Stop: below 9 EMA or recent swing low\n- Target: prior high or measured move\n- Hold time: 2-10 days", notes: "The 9 EMA daily is SMB's favorite swing setup. It works because strong stocks rarely pull back more than 3-5 days before continuing. The 9 EMA captures this rhythm perfectly." },
    { name: "Dead Cat Bounce — Short the Recovery", folder: "SMB Capital — Short Setups", setupType: "Reversal", confidenceLevel: 68, conditions: "Stock drops sharply on bad news (earnings miss, downgrade). A weak bounce follows. Short the failed bounce.", checklist: "- Stock dropped >10% on negative catalyst\n- Weak bounce: low volume, doesn't reclaim VWAP\n- Bounce reaches resistance (prior support, moving average)\n- Entry on reversal from bounce high\n- Stop above bounce high\n- Target: retest of lows or new low", notes: "Dead cat bounces occur because: 1) Short covering, 2) Bottom fishers, 3) Algorithmic mean reversion. These bounces typically fail because the fundamental damage is real. SMB shorts these aggressively." },
    { name: "High of Day Break — Momentum Ignition", folder: "SMB Capital — Intraday Setups", setupType: "Breakout", confidenceLevel: 73, conditions: "Stock consolidates near HOD then breaks to new highs. This 'momentum ignition' triggers stops and algorithms, creating a powerful move.", checklist: "- Stock near HOD with tightening range\n- At least 2-3 tests of HOD level\n- Volume building on each test\n- Entry on break above HOD with volume surge\n- Stop below consolidation / last pullback low\n- Target: next resistance or measured move", notes: "HOD breaks are powerful because they trigger: 1) Buy stops from shorts, 2) Momentum algorithms, 3) Breakout traders. The combination creates a supply/demand imbalance that drives price higher quickly." },
    { name: "News Fade — Sell/Short the News", folder: "SMB Capital — Reversal Setups", setupType: "Reversal", confidenceLevel: 66, conditions: "Stock spikes on news but the news is already priced in or overhyped. Fade the initial move as it reverses.", checklist: "- News event causes spike (upgrade, product launch, partnership)\n- Assess if news is truly new or already expected\n- Wait for first signs of reversal (red candle, volume shift)\n- Entry on break of initial spike candle low\n- Stop above spike high\n- Target: pre-news price or VWAP", notes: "'Buy the rumor, sell the news' — one of the oldest market principles. SMB teaches to identify when news is already priced in by checking: pre-news price action, options activity, and whether the move is proportional to the catalyst." },
    { name: "In Play Stock Framework — Отбор акций", folder: "SMB Capital — Frameworks", setupType: "other", confidenceLevel: 90, conditions: "Framework for identifying 'In Play' stocks — stocks that will have the most opportunity for day traders on a given day.", checklist: "- Fresh catalyst (earnings, FDA, news) within 24 hours\n- Gap > 4% (up or down)\n- Pre-market volume > 500K shares\n- Relative volume > 2x average\n- ATR > $2 (enough range to trade)\n- Float < 100M preferred\n- Not in a halt or pending news\n- Check sector (is the whole sector moving?)", notes: "The In Play framework is the foundation of SMB Capital's methodology. Before trading any setup, the stock must be 'In Play' — meaning it has a catalyst, volume, and range to create opportunity. Without In Play status, setups have much lower probability." },
    { name: "Power Hour Momentum — 3:00–4:00 PM", folder: "SMB Capital — Intraday Setups", setupType: "Intraday Momentum", confidenceLevel: 68, conditions: "Last hour of trading (3:00-4:00 PM). Institutions execute large orders, creating momentum. Trade in direction of the day's trend.", checklist: "- Identify day's trend (above/below VWAP)\n- Wait until 3:00 PM\n- Look for volume increase (institutional activity)\n- Long if above VWAP all day, Short if below\n- Entry on pullback within the trend\n- Stop: VWAP cross\n- Target: close of day or trailing stop", notes: "Power hour is when institutions execute their remaining orders for the day. This creates volume and momentum. SMB teaches that the last hour often mirrors the first hour in terms of direction and opportunity." },
  ];

  const additionalStrategies: typeof smbStrategies = [];

  const opgImbxMocStrategies: typeof smbStrategies = [];

  const seedTags: Record<string, string> = {
    "ATM Offering Play — Short": "Offering Play,ATM Offering,Fade Trade,VWAP Rejection,Offering,ATM,S-1 Filing,High Relative Volume,Volume Spike",
    "Pricing Play — Long Bounce": "Offering Play,Post-Offering Bounce,Reversal,VWAP Bounce,Offering,Pricing,Offering Price",
    "Gap and Go — Earnings Momentum": "Gap and Go,Earnings Gap Up,ORB,Trend Continuation,Earnings Beat,Revenue Beat,VWAP,Opening Range High,High Relative Volume",
    "IPO Day Trade — First Day Play": "IPO Trade,ORB,Breakout,Opening Range High,Opening Range Low,IPO Stock,Recent IPO (<6mo),High Relative Volume",
    "Second Day Play — Momentum Continuation": "Second Day Play,Trend Continuation,Breakout,Gap Up,HOD,Yesterday High,High Relative Volume",
    "VWAP Trend Trade — Intraday": "VWAP Trend,VWAP Bounce,VWAP Hold Long,Pullback Trade,Intraday Momentum,VWAP,Trending Day",
    "Parabolic Short — Extended Stock": "Parabolic Short,Blow-Off Top Short,Exhaustion Short,Reversal,HOD,Low Float (<10M),High Relative Volume,Volume Spike",
    "Opening Range Breakout (ORB)": "ORB,ORB 5min,ORB 15min,Breakout,Opening Range High,Opening Range Low,First 15min,First 30min,Volume Spike",
    "Low Float Momentum — Float Rotation": "Intraday Momentum,Runner,Breakout,Bull Flag,Low Float (<10M),Extremely Low Float (<2M),High Relative Volume,Volume Spike",
    "Failed Follow Through — Bear Flag Short": "Failed Follow Through,Bear Flag,Reversal,Dead Cat Bounce,Short,Yesterday High,Low Volume",
    "Short Squeeze Play": "Short Squeeze,Intraday Momentum,Breakout,High Short Interest (>20%),High Relative Volume,Volume Spike,Gap Up",
    "Sympathy Play — Sector Follower": "Sympathy Play,Sector Rotation Play,Intraday Momentum,Breakout,Sector Leading,Sector Rotation",
    "Halt & Resume Play": "Halt & Resume,Breakout,Reversal,High Relative Volume,Volume Spike,High Volatility",
    "Anchored VWAP — Earnings / IPO Level": "VWAP Bounce,VWAP Rejection,Breakout,Anchored VWAP,Earnings Beat,IPO Stock,Daily Support,Daily Resistance",
    "9 EMA Daily — Swing Entry на Trend": "Pullback Trade,Swing Hold,Trend Continuation,EMA9,Daily Support,Trending Day",
    "Dead Cat Bounce — Short the Recovery": "Dead Cat Bounce,Reversal,Fade Trade,Short,Earnings Miss,Analyst Downgrade,VWAP,Daily Resistance",
    "High of Day Break — Momentum Ignition": "Breakout,Momentum Ignition,HOD,Flat Top Breakout,Volume Spike,High Relative Volume,Trending Day",
    "News Fade — Sell/Short the News": "Fade Trade,News Spike Fade,Reversal,Short,Breaking News,Analyst Upgrade,VWAP",
    "In Play Stock Framework — Отбор акций": "Gap Up,Gap Down,High Relative Volume,Volume Spike,Breaking News,Earnings Beat",
    "Power Hour Momentum — 3:00–4:00 PM": "Intraday Momentum,VWAP Trend,Trend Continuation,Power Hour,Last Hour,VWAP",
  };

  const allSeedStrategies = [...smbStrategies, ...additionalStrategies, ...opgImbxMocStrategies];
  let seeded = 0;
  for (const s of allSeedStrategies) {
    try {
      const tags = seedTags[s.name] || null;
      const { rowCount } = await pool.query(
        `INSERT INTO playbook (name, folder, setup_type, conditions, checklist, notes, confidence_level, tags)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8
         WHERE NOT EXISTS (SELECT 1 FROM playbook WHERE name = $1)`,
        [s.name, s.folder, s.setupType, s.conditions, s.checklist, s.notes, s.confidenceLevel, tags]
      );
      if (rowCount && rowCount > 0) seeded++;
    } catch (e: any) { logger.warn({ error: e.message }, `Seed playbook: ${s.name}`); }
  }

  if (seeded === 0) {
    let tagUpdated = 0;
    for (const s of allSeedStrategies) {
      const tags = seedTags[s.name];
      if (!tags) continue;
      try {
        const { rowCount } = await pool.query(
          `UPDATE playbook SET tags = $1 WHERE name = $2 AND (tags IS NULL OR tags = '') AND deleted_at IS NULL`,
          [tags, s.name]
        );
        if (rowCount && rowCount > 0) tagUpdated++;
      } catch (e: any) { logger.warn({ error: e.message }, `Update tags: ${s.name}`); }
    }
    if (tagUpdated > 0) logger.info(`Updated tags for ${tagUpdated} existing strategies`);
  }
  if (seeded > 0) {
    logger.info(`Seeded ${seeded} new playbook strategies (${allSeedStrategies.length - seeded} already existed)`);
  } else {
    logger.info(`All ${allSeedStrategies.length} playbook strategies already exist, skipping seed`);
  }

  await pool.query(
    `CREATE INDEX IF NOT EXISTS watchlist_score_idx ON watchlist(score)`
  ).catch(() => {});
  await pool.query(
    `CREATE INDEX IF NOT EXISTS checklist_template_active_idx ON pre_trade_checklist_template(active)`
  ).catch(() => {});
  await pool.query(
    `CREATE INDEX IF NOT EXISTS checklist_template_sort_idx ON pre_trade_checklist_template(sort_order)`
  ).catch(() => {});
  await pool.query(
    `CREATE INDEX IF NOT EXISTS checklist_responses_ticker_idx ON pre_trade_checklist_responses(ticker)`
  ).catch(() => {});
  await pool.query(
    `CREATE INDEX IF NOT EXISTS checklist_responses_trade_id_idx ON pre_trade_checklist_responses(trade_id)`
  ).catch(() => {});
  await pool.query(
    `CREATE INDEX IF NOT EXISTS trade_ideas_status_idx ON trade_ideas(status)`
  ).catch(() => {});
  await pool.query(
    `CREATE INDEX IF NOT EXISTS trade_ideas_ticker_idx ON trade_ideas(ticker)`
  ).catch(() => {});
  await pool.query(
    `CREATE INDEX IF NOT EXISTS trade_ideas_trader_idx ON trade_ideas(trader)`
  ).catch(() => {});
  await pool.query(
    `CREATE INDEX IF NOT EXISTS trade_idea_reactions_idea_idx ON trade_idea_reactions(trade_idea_id)`
  ).catch(() => {});

  // Seed default 6-item pre-trade checklist if empty
  try {
    const { rows: chkRows } = await pool.query(`SELECT COUNT(*) AS cnt FROM pre_trade_checklist_template`);
    if (Number(chkRows[0]?.cnt) === 0) {
      const defaults = [
        { label: "Есть катализатор", description: "Отчёт, новость, FDA, движение сектора или другой измеримый повод", sort: 1 },
        { label: "Объём выше среднего", description: "Относительный объём > 1.5x или премаркет-объём подтверждает интерес", sort: 2 },
        { label: "Сетап есть в плейбуке", description: "Сетап совпадает с описанной стратегией с подтверждённым edge", sort: 3 },
        { label: "Размер рассчитан от риска", description: "Позиция посчитана от заданного R. Место стопа понятно", sort: 4 },
        { label: "По направлению рынка", description: "Направление SPY/QQQ и сектора совпадает с идеей сделки", sort: 5 },
        { label: "Стоп — конкретный уровень", description: "Конкретная цена (не «по ощущениям»), не шире 1R", sort: 6 },
      ];
      for (const d of defaults) {
        await pool.query(
          `INSERT INTO pre_trade_checklist_template (label, description, required, sort_order, active) VALUES ($1, $2, TRUE, $3, TRUE)`,
          [d.label, d.description, d.sort]
        );
      }
      logger.info(`Seeded ${defaults.length} default pre-trade checklist items`);
    }
  } catch (e: any) {
    logger.warn({ error: e.message }, "Seed checklist defaults");
  }

  await pool.query(
    `CREATE INDEX IF NOT EXISTS candles_cache_ticker_idx ON candles_cache(ticker)`
  ).catch(() => {});
  await pool.query(
    `ALTER TABLE candles_cache ADD COLUMN IF NOT EXISTS extended BOOLEAN NOT NULL DEFAULT FALSE`
  ).catch(() => {});
  await pool.query(`DROP INDEX IF EXISTS candles_cache_unique`).catch(() => {});
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS candles_cache_unique ON candles_cache(ticker, date, interval, extended)`
  ).catch(() => {});

  await pool.query(
    `CREATE INDEX IF NOT EXISTS trade_executions_trade_idx ON trade_executions(trade_id)`
  ).catch(() => {});

  await pool.query(
    `CREATE INDEX IF NOT EXISTS news_cache_ticker_idx ON news_cache(ticker)`
  ).catch(() => {});
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS news_cache_ticker_guid_uniq ON news_cache(ticker, guid)`
  ).catch(() => {});
  await pool.query(
    `CREATE INDEX IF NOT EXISTS holiday_calendar_date_idx ON holiday_calendar(date)`
  ).catch(() => {});
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS holiday_calendar_unique ON holiday_calendar(date, type, name)`
  ).catch(() => {});

  await pool.query(`ALTER TABLE "playbook" ADD COLUMN IF NOT EXISTS "trader" TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE "trades" ADD COLUMN IF NOT EXISTS "setup_score" NUMERIC(5,2)`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "playbook_checklist_runs" (
      "id" SERIAL PRIMARY KEY,
      "playbook_id" INTEGER NOT NULL,
      "trade_id" INTEGER,
      "trader" TEXT,
      "checked_items" JSONB NOT NULL,
      "score" NUMERIC(5,2) NOT NULL,
      "total" INTEGER NOT NULL,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch((e: any) => logger.warn({ error: e.message }, "create playbook_checklist_runs"));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "playbook_revisions" (
      "id" SERIAL PRIMARY KEY,
      "playbook_id" INTEGER NOT NULL,
      "trader" TEXT,
      "snapshot" JSONB NOT NULL,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch((e: any) => logger.warn({ error: e.message }, "create playbook_revisions"));
  await pool.query(`CREATE INDEX IF NOT EXISTS playbook_checklist_runs_playbook_idx ON playbook_checklist_runs(playbook_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS playbook_checklist_runs_trade_idx ON playbook_checklist_runs(trade_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS playbook_revisions_playbook_idx ON playbook_revisions(playbook_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS playbook_parent_active_idx ON playbook(parent_id) WHERE deleted_at IS NULL`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS playbook_setup_type_idx ON playbook(setup_type)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS playbook_trader_idx ON playbook(trader)`).catch(() => {});

  // Prop-desk fields: holding horizon, position size, fees, planned $ risk, exit date for multi-day holds.
  for (const col of [
    `"horizon" TEXT`,
    `"exit_date" TEXT`,
    `"qty" NUMERIC(14,2)`,
    `"fees" NUMERIC(12,2)`,
    `"risk_usd" NUMERIC(12,2)`,
  ]) {
    await pool.query(`ALTER TABLE "trades" ADD COLUMN IF NOT EXISTS ${col}`).catch((e: any) => logger.warn({ error: e.message }, `trades ${col}`));
  }
  // Audit P0-1: PropReports fees go down to $0.0001 — cents per trade drifted Ориф's book by −$0.25 (64.74 vs 64.99).
  // Money columns keep 4 decimals; idempotent (only widens while the scale is still < 4).
  for (const col of ["pnl", "fees"]) {
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'trades' AND column_name = '${col}'
                      AND data_type = 'numeric' AND COALESCE(numeric_scale, 0) < 4) THEN
          ALTER TABLE "trades" ALTER COLUMN "${col}" TYPE NUMERIC(14,4);
        END IF;
      END $$;
    `).catch((e: any) => logger.warn({ error: e.message }, `trades ${col} precision`));
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "trader_risk_limits" (
      "trader" TEXT PRIMARY KEY,
      "account_size" NUMERIC(14,2),
      "daily_loss_limit" NUMERIC(12,2),
      "weekly_loss_limit" NUMERIC(12,2),
      "max_drawdown" NUMERIC(12,2),
      "max_risk_per_trade" NUMERIC(12,2),
      "max_position_usd" NUMERIC(14,2),
      "max_overnight_exposure" NUMERIC(14,2),
      "max_open_positions" INTEGER,
      "allow_overnight" BOOLEAN NOT NULL DEFAULT TRUE,
      "allow_swing" BOOLEAN NOT NULL DEFAULT TRUE,
      "tier" TEXT,
      "notes" TEXT,
      "updated_by" TEXT,
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch((e: any) => logger.warn({ error: e.message }, "create trader_risk_limits"));
  await pool.query(`CREATE INDEX IF NOT EXISTS trades_horizon_idx ON trades(horizon)`).catch(() => {});

  // ─── PropReports integration (phase 2) — additive only; owned by lib/propreports ───
  // trades: broker-sourced round trips are keyed by (source, external_id); trader-owned fields untouched on re-sync.
  for (const col of [
    `"source" TEXT`,
    `"external_id" TEXT`,
    `"broker_account" TEXT`,
    `"synced_at" TIMESTAMPTZ`,
  ]) {
    await pool.query(`ALTER TABLE "trades" ADD COLUMN IF NOT EXISTS ${col}`).catch((e: any) => logger.warn({ error: e.message }, `trades ${col}`));
  }
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS trades_source_external_id_uidx ON trades(source, external_id) WHERE external_id IS NOT NULL`).catch((e: any) => logger.warn({ error: e.message }, "trades_source_external_id_uidx"));
  await pool.query(`CREATE INDEX IF NOT EXISTS trades_broker_account_idx ON trades(broker_account) WHERE broker_account IS NOT NULL`).catch(() => {});
  // Account mapping: PropReports account (display name as in Fills CSV "Account") → users.name
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "propreports_accounts" (
      "id" SERIAL PRIMARY KEY,
      "account" TEXT NOT NULL UNIQUE,
      "account_id" TEXT,
      "account_name" TEXT,
      "trader" TEXT,
      "active" BOOLEAN NOT NULL DEFAULT TRUE,
      "notes" TEXT,
      "last_synced_at" TIMESTAMPTZ,
      "last_fill_at" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch((e: any) => logger.warn({ error: e.message }, "create propreports_accounts"));
  await pool.query(`CREATE INDEX IF NOT EXISTS propreports_accounts_trader_idx ON propreports_accounts(trader)`).catch(() => {});
  // Sync history (API pulls and file imports). Dry runs are never recorded.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "propreports_sync_runs" (
      "id" SERIAL PRIMARY KEY,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "finished_at" TIMESTAMPTZ,
      "source" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'running',
      "file_name" TEXT,
      "date_from" TEXT,
      "date_to" TEXT,
      "inserted" INTEGER NOT NULL DEFAULT 0,
      "updated" INTEGER NOT NULL DEFAULT 0,
      "unchanged" INTEGER NOT NULL DEFAULT 0,
      "skipped" INTEGER NOT NULL DEFAULT 0,
      "conflicts" INTEGER NOT NULL DEFAULT 0,
      "errors" INTEGER NOT NULL DEFAULT 0,
      "error_text" TEXT,
      "actor" TEXT,
      "details" JSONB
    )
  `).catch((e: any) => logger.warn({ error: e.message }, "create propreports_sync_runs"));
  await pool.query(`CREATE INDEX IF NOT EXISTS propreports_sync_runs_started_idx ON propreports_sync_runs(started_at DESC)`).catch(() => {});
  // Broker round trips that collide with a manual journal trade (same trader+ticker+date+side) wait here
  // until a curator merges them into the manual trade or keeps them as a separate trade.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "propreports_pending_trades" (
      "id" SERIAL PRIMARY KEY,
      "external_id" TEXT NOT NULL UNIQUE,
      "account" TEXT,
      "trader" TEXT NOT NULL,
      "ticker" TEXT NOT NULL,
      "date" TEXT NOT NULL,
      "side" TEXT,
      "payload" JSONB NOT NULL,
      "candidate_ids" INTEGER[] NOT NULL DEFAULT '{}',
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch((e: any) => logger.warn({ error: e.message }, "create propreports_pending_trades"));
  await pool.query(`CREATE INDEX IF NOT EXISTS propreports_pending_trader_idx ON propreports_pending_trades(trader)`).catch(() => {});
  // Legacy admin XLS import stored pnl = NET and kept gross/fees/qty only inside context_snapshot.
  // Contract: pnl = gross, fees = total fees, qty filled, source = 'propreports'. Repair once (marker in context_snapshot);
  // external_id / broker_account are assigned later by the sync engine when the same trade is re-imported (adoption).
  // Legacy PropReports pnl repair: src/db/migrations/0012_legacy_propreports_pnl_repair.sql.
  // Self-configuration: key/value settings (fee columns, groupId, unmatched accounts, connection check) + account aliases.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "propreports_settings" (
      "key" TEXT PRIMARY KEY,
      "value" JSONB NOT NULL,
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch((e: any) => logger.warn({ error: e.message }, "create propreports_settings"));
  await pool.query(`ALTER TABLE propreports_accounts ADD COLUMN IF NOT EXISTS "aliases" TEXT[] NOT NULL DEFAULT '{}'`).catch(() => {});
  // Aggregate "Trade Performance" reports (broker statistics; no individual trades). Re-upload of a period replaces the row.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "propreports_performance_reports" (
      "id" SERIAL PRIMARY KEY,
      "account" TEXT NOT NULL,
      "trader_name" TEXT,
      "period_from" TEXT NOT NULL,
      "period_to" TEXT NOT NULL,
      "file_name" TEXT,
      "data" JSONB NOT NULL,
      "uploaded_by" TEXT,
      "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE ("account", "period_from", "period_to")
    )
  `).catch((e: any) => logger.warn({ error: e.message }, "create propreports_performance_reports"));
  await pool.query(`CREATE INDEX IF NOT EXISTS propreports_perf_trader_idx ON propreports_performance_reports(trader_name)`).catch(() => {});
  // ─── end PropReports integration ───

  // Tier rename «Джуниор» → «Джун»: src/db/migrations/0013_scaling_tier_junior_rename.sql.

  // Interface language per user (RU / EN / UZ): server texts use X-Lang → users.locale → ru (src/i18n).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'ru'`).catch((e: any) => logger.warn({ error: e.message }, "users.locale"));

  // Optional Latin alias for cross-script people search (lib/peopleDirectory.ts, admin «Люди» → «Латинское имя»).
  // Names stay the identifiers (trades.trader, users.assigned_curator); this column is search-only. Idempotent.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name_latin TEXT`).catch((e: any) => logger.warn({ error: e.message }, "users.name_latin"));

  // 2026/2027 market calendars: src/db/migrations/0016_market_calendar_2026.sql, 0017_market_calendar_2027.sql.
  await ensureLateTables();

  logger.info("Database migrations completed");
}

/** DDL that used to sit at the end of the 2026 holiday seed (idempotent safety net; the tables are in 0001_baseline). */
async function ensureLateTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "junior_notes" (
      "id" SERIAL PRIMARY KEY,
      "trader" TEXT NOT NULL,
      "note_date" DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'America/New_York')::date),
      "raw_text" TEXT NOT NULL DEFAULT '',
      "refined_text" TEXT,
      "mood" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE("trader", "note_date")
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS "junior_notes_trader_date_idx" ON "junior_notes"("trader", "note_date")`);
  await pool.query(`CREATE INDEX IF NOT EXISTS "junior_notes_date_idx" ON "junior_notes"("note_date" DESC)`);

  await pool.query(`ALTER TABLE playbook ADD COLUMN IF NOT EXISTS reviewed BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE playbook ADD COLUMN IF NOT EXISTS reviewed_by TEXT`);
  await pool.query(`ALTER TABLE playbook ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`);

  // Author of shared desk rows (owner-or-staff edit/delete rule, lib/ownedRows). Existing rows stay NULL = staff-only.
  await pool.query(`ALTER TABLE big7_levels ADD COLUMN IF NOT EXISTS created_by TEXT`);
  await pool.query(`ALTER TABLE big7_catalysts ADD COLUMN IF NOT EXISTS created_by TEXT`);
  await pool.query(`ALTER TABLE big7_tickers ADD COLUMN IF NOT EXISTS created_by TEXT`);
  await pool.query(`ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS created_by TEXT`);
}
