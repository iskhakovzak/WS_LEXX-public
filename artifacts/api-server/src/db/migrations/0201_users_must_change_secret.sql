-- Owner decision 2026-10-18: every account sets its own secret. Sign in once with the current PIN / password, then
-- the API allows only the secret change (pwc token) until a new one is saved. must_change_secret is also set again
-- whenever an admin issues someone a secret (PATCH /users/:id, init-passwords, db/tools/starting-secret.ts).
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_secret boolean NOT NULL DEFAULT false;
-- Everyone who can sign in today; token_version + 1 ends the open sessions so the change happens on the next sign-in.
UPDATE users SET must_change_secret = true, token_version = token_version + 1 WHERE password_hash IS NOT NULL;
