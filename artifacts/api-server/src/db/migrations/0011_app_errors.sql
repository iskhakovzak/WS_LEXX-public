-- Internal error tracking (lib/errorTracking.ts, A1 security): grouped by fingerprint, plus the last occurrences.
CREATE TABLE IF NOT EXISTS app_errors (
  id              bigserial PRIMARY KEY,
  fingerprint     text NOT NULL UNIQUE,
  source          text NOT NULL CHECK (source IN ('server', 'client', 'csp')),
  kind            text NOT NULL,
  message         text NOT NULL,
  route           text NULL,
  status          integer NULL,
  stack           text NULL,
  count           integer NOT NULL DEFAULT 1,
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  last_request_id text NULL,
  last_user_id    integer NULL,
  user_agent      text NULL,
  release         text NULL,
  resolved_at     timestamptz NULL,
  resolved_by     text NULL,
  alerted_at      timestamptz NULL
);
CREATE INDEX IF NOT EXISTS app_errors_last_seen_idx ON app_errors (last_seen DESC);

CREATE TABLE IF NOT EXISTS app_error_occurrences (
  id         bigserial PRIMARY KEY,
  error_id   bigint NOT NULL REFERENCES app_errors(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  request_id text NULL,
  user_id    integer NULL,
  route      text NULL,
  status     integer NULL,
  context    jsonb NULL
);
CREATE INDEX IF NOT EXISTS app_error_occurrences_error_idx ON app_error_occurrences (error_id, at DESC);
