#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Schema changes are applied by the API on boot (src/lib/migrate.ts, raw SQL, idempotent) — no drizzle push here:
# `drizzle-kit push` diffs against the live DB and can drop columns/tables that only migrate.ts knows about.
