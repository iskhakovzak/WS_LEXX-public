-- Sign-in lockout (lib/security/loginGuard.ts, A1 security): one row per account ('u:<user id>') or per typed
-- unknown name ('n:<sha256 prefix>'). 5 failures → locked_until = now + 15 min · 2^lock_level (cap 24 h).
-- A successful sign-in deletes the row; an admin secret reset deletes the account's row.
CREATE TABLE IF NOT EXISTS login_lockouts (
  key             text PRIMARY KEY,
  user_id         integer NULL,
  failures        integer NOT NULL DEFAULT 0,
  lock_level      integer NOT NULL DEFAULT 0,
  locked_until    timestamptz NULL,
  last_failure_at timestamptz NOT NULL DEFAULT now()
);
