-- Background job history (src/jobs/registry.ts): one row per run of a registered job.
-- status: running → ok | error | timeout; skipped = another process held the job's advisory lock.
CREATE TABLE IF NOT EXISTS job_runs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'startup', 'manual', 'event')),
  status text NOT NULL CHECK (status IN ('running', 'ok', 'error', 'timeout', 'skipped')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  error text,
  details jsonb,
  host text
);
CREATE INDEX IF NOT EXISTS job_runs_job_started_idx ON job_runs (job, started_at DESC);
