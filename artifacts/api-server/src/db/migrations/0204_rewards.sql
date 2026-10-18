-- Discipline rewards (owner 2026-10-18: progressive contract scale + badges; lib/daily/discipline.ts, badges.ts,
-- rewards.ts). Streak, points and level are NOT stored: they are recomputed from the evening snapshots
-- (daily_reviews.verdict.contract) and the personal plans with the current desk settings.
--
-- trader_badges: a badge is awarded once per trader (primary key = idempotent awarding: INSERT … ON CONFLICT DO
-- NOTHING); awarded_on = the NY trading day it was earned (e.g. the 5th kept-contract day in a row), target = the
-- number in its name at that moment (5 days, 3 games …) so a later settings change never rewrites history.
CREATE TABLE IF NOT EXISTS trader_badges (
  trader text NOT NULL,
  badge text NOT NULL,
  awarded_on text NOT NULL,                -- YYYY-MM-DD, New York trading day
  target integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trader, badge)
);
CREATE INDEX IF NOT EXISTS trader_badges_awarded_idx ON trader_badges (awarded_on);
