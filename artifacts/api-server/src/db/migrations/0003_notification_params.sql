-- Text as data (ARCHITECTURE.md §0.5, data.md Phase 7): notifications and activity store a type code + params;
-- the reader's language renders the text (server: lib/notificationText.ts renderNotification; UI: i18n).
-- title/message (Russian) stay as the fallback for rows written before this change and for unconverted producers.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS params jsonb;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS params jsonb;
