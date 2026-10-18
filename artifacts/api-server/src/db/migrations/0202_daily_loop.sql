-- Daily loop (owner goal 2026-10-18: every visit gives one useful thing; lib/daily/*).
--
-- daily_focus: the focus («one mistake a day») FOR a trading day, stored on the first request so the trader, the
-- curator and the Telegram bot see the same line all day. source: auto (engine) | curator (override, wins) | none
-- (nothing repeating). mistake = MistakeId (behavior:<key> | structure:<kind> | day:<kind> | rule:<kind>).
CREATE TABLE IF NOT EXISTS daily_focus (
  trader text NOT NULL,
  date text NOT NULL,                      -- NY trading day the focus is for (YYYY-MM-DD)
  mistake text,
  cost_net numeric(12, 2),
  count integer NOT NULL DEFAULT 0,       -- occurrences in the window
  days integer NOT NULL DEFAULT 0,        -- distinct days it happened on
  window_from text NOT NULL,
  window_to text NOT NULL,
  source text NOT NULL CHECK (source IN ('auto', 'curator', 'none')),
  set_by text,                             -- curator name for source = 'curator'
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trader, date)
);
CREATE INDEX IF NOT EXISTS daily_focus_date_idx ON daily_focus (date);

-- daily_reviews: one row per trader + finished trading day. verdict = EveningCard snapshot (focus verdict, own
-- contract, trade to review) written when the day is finished; the contract's disciplineDelta feeds the next-day
-- discipline score (lib/daily/discipline.ts → lib/behaviorEngine DisciplineDay.contract). reviewed_at / note: the
-- trader looked at the day; disputed + disputed_mistake: «this was not a mistake» (excluded from the next focus pick,
-- shown to the curator).
CREATE TABLE IF NOT EXISTS daily_reviews (
  trader text NOT NULL,
  date text NOT NULL,
  reviewed_at timestamptz,
  note text,
  disputed boolean NOT NULL DEFAULT false,
  disputed_mistake text,
  verdict jsonb,
  verdict_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trader, date)
);
CREATE INDEX IF NOT EXISTS daily_reviews_date_idx ON daily_reviews (date);
CREATE INDEX IF NOT EXISTS daily_reviews_disputed_idx ON daily_reviews (trader, date) WHERE disputed;
