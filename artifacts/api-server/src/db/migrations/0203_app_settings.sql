-- Desk settings an admin changes on the site (owner decision 2026-10-18: «легко настраивать, всё на сайте»).
-- One row per changed setting of the typed registry (src/lib/settings/registry.ts SETTINGS); a key without a row, or
-- with value NULL («по умолчанию»: a reset keeps who / when), reads the registry default. The API validates every
-- value against its definition before writing (lib/settings/store.ts) and audits each change (audit_log
-- settings.update). Configuration, not user data.
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,                    -- registry key, e.g. "daily.focusWindowDays"
  value jsonb,                             -- number | boolean | "HH:MM" | option; NULL = back to the default
  updated_by text,                         -- users.name of the admin who saved it
  updated_at timestamptz NOT NULL DEFAULT now()
);
