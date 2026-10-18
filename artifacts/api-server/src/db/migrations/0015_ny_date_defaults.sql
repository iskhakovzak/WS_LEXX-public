-- Time rule (ARCHITECTURE.md §0.6): a trading day is the New York date, never the session's CURRENT_DATE
-- (the pool now runs with TimeZone=UTC). Column defaults that used CURRENT_DATE take the NY date instead.
ALTER TABLE author_notes ALTER COLUMN note_date SET DEFAULT ((now() AT TIME ZONE 'America/New_York')::date);
ALTER TABLE junior_notes ALTER COLUMN note_date SET DEFAULT ((now() AT TIME ZONE 'America/New_York')::date);
DO $$
BEGIN
  IF to_regclass('public.academy_enrollments') IS NOT NULL THEN
    ALTER TABLE academy_enrollments ALTER COLUMN joined_on SET DEFAULT ((now() AT TIME ZONE 'America/New_York')::date);
  END IF;
END $$;
