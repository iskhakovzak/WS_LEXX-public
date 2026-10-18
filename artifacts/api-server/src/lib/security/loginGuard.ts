/**
 * Sign-in hardening (owner decision 2026-10-17, ARCHITECTURE.md «Решения владельца»):
 *
 *  1. No roster before sign-in. The user TYPES a name; `resolveLoginName` maps it to one active account:
 *     exact normalized match on `name` / `name_latin` first, then the unique best cross-script match from
 *     @workspace/text-search (RU / EN / UZ, layout slips, small typos). Ambiguous or unknown → null, and the route
 *     answers with the same generic «неверное имя или PIN» as a wrong PIN (no enumeration).
 *  2. Per-account lockout persisted in `login_lockouts`: 5 failures → 15 min, then 30, 60 … (cap 24 h). Failures
 *     for names that resolve to nobody are counted under the typed name, so an unknown name locks exactly like a
 *     real one (an attacker can't tell them apart by the lock). A successful sign-in clears the row.
 *  3. The IP + name limiter (express-rate-limit, skipSuccessfulRequests) lives in lib/security/http.ts.
 *
 * Schema: created idempotently by `ensureLoginLockoutSchema()` until B4's migration runner exists
 * (TODO(B4): move the CREATE TABLE into a numbered migration and delete the ensure).
 */
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { searchItems } from "@workspace/text-search";

// ─── Name resolution (pure) ─────────────────────────────────────────────────────────────────────────────

/** NFC, unify apostrophes and ё, collapse spaces, lower-case. */
export function normalizeLoginName(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/[ʻʼ’`']/g, "'")
    .replace(/ё/gi, "е") // i18n-ignore (input normalization, not UI text)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type LoginCandidate = { id: number; name: string; nameLatin?: string | null };

/** Score margin the best fuzzy hit needs over the runner-up to count as «unique». One match tier is 10 points. */
const UNIQUE_MARGIN = 2;

/**
 * The single active account the typed name refers to, or null (unknown or ambiguous).
 * Deterministic and independent of list order.
 */
export function resolveLoginName<T extends LoginCandidate>(users: readonly T[], typed: string): T | null {
  const n = normalizeLoginName(typed);
  if (n.length < 2) return null;
  const exact = users.filter((u) => normalizeLoginName(u.name) === n || (!!u.nameLatin && normalizeLoginName(u.nameLatin) === n));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const hits = searchItems(users, typed, (u) => [u.name, u.nameLatin]);
  if (hits.length === 0) return null;
  if (hits.length > 1 && hits[1].score > hits[0].score - UNIQUE_MARGIN) return null;
  return hits[0].item;
}

// ─── Lockout policy (pure) ──────────────────────────────────────────────────────────────────────────────

export const LOCK_THRESHOLD = 5;
export const LOCK_BASE_MIN = 15;
export const LOCK_MAX_MIN = 24 * 60;
/** Failures older than this start a fresh count. */
export const FAILURE_WINDOW_MIN = 60;
/** A lock level older than this decays back to 0 (the next lock is 15 min again). */
export const LEVEL_DECAY_HOURS = 24;

/** Lock length for the n-th lock in a row (0-based): 15, 30, 60, 120 … minutes, capped at 24 h. */
export function lockMinutes(level: number): number {
  return Math.min(LOCK_BASE_MIN * 2 ** Math.max(0, level), LOCK_MAX_MIN);
}

export function lockoutKey(user: { id: number } | null, typedName: string): string {
  if (user) return `u:${user.id}`;
  // Hash the typed text: it may be a mistyped secret, and it never needs to be read back.
  return `n:${createHash("sha256").update(normalizeLoginName(typedName)).digest("hex").slice(0, 32)}`;
}

// ─── Store ──────────────────────────────────────────────────────────────────────────────────────────────

export type LockState = { locked: false } | { locked: true; until: Date; retryAfterSec: number };
export type FailureResult = { locked: false; failures: number } | { locked: true; until: Date; retryAfterSec: number; level: number; minutes: number };

export interface LockoutStore {
  check(key: string, now?: Date): Promise<LockState>;
  fail(key: string, userId: number | null, now?: Date): Promise<FailureResult>;
  clear(key: string): Promise<void>;
  /** Admin reset of a member's secret also lifts their lock. */
  clearUser(userId: number): Promise<void>;
}

function lockedState(until: Date, now: Date): LockState {
  return until.getTime() > now.getTime()
    ? { locked: true, until, retryAfterSec: Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)) }
    : { locked: false };
}

type Row = { userId: number | null; failures: number; level: number; lockedUntil: Date | null; lastFailureAt: Date };

/** Shared state machine of both stores: one failure applied to a row. */
export function applyFailure(prev: Row | undefined, userId: number | null, now: Date): { row: Row; lock: { level: number; minutes: number } | null } {
  const stale = !prev || now.getTime() - prev.lastFailureAt.getTime() > FAILURE_WINDOW_MIN * 60_000;
  const decayed = !prev || now.getTime() - prev.lastFailureAt.getTime() > LEVEL_DECAY_HOURS * 3600_000;
  const row: Row = {
    userId: userId ?? prev?.userId ?? null,
    failures: stale ? 1 : prev!.failures + 1,
    level: decayed ? 0 : prev!.level,
    lockedUntil: prev?.lockedUntil ?? null,
    lastFailureAt: now,
  };
  if (row.failures < LOCK_THRESHOLD) return { row, lock: null };
  const minutes = lockMinutes(row.level);
  const lock = { level: row.level, minutes };
  row.lockedUntil = new Date(now.getTime() + minutes * 60_000);
  row.level += 1;
  row.failures = 0;
  return { row, lock };
}

/** In-process store (tests, and a fallback should the table be unavailable). */
export function memoryLockoutStore(): LockoutStore & { rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  return {
    rows,
    async check(key, now = new Date()) {
      const r = rows.get(key);
      return r?.lockedUntil ? lockedState(r.lockedUntil, now) : { locked: false };
    },
    async fail(key, userId, now = new Date()) {
      const { row, lock } = applyFailure(rows.get(key), userId, now);
      rows.set(key, row);
      if (!lock) return { locked: false, failures: row.failures };
      const st = lockedState(row.lockedUntil!, now) as Extract<LockState, { locked: true }>;
      return { locked: true, until: st.until, retryAfterSec: st.retryAfterSec, level: lock.level, minutes: lock.minutes };
    },
    async clear(key) { rows.delete(key); },
    async clearUser(userId) { rows.delete(`u:${userId}`); },
  };
}

let schemaReady: Promise<void> | null = null;
export function ensureLoginLockoutSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = pool
      .query(`CREATE TABLE IF NOT EXISTS login_lockouts (
        key             TEXT PRIMARY KEY,
        user_id         INTEGER NULL,
        failures        INTEGER NOT NULL DEFAULT 0,
        lock_level      INTEGER NOT NULL DEFAULT 0,
        locked_until    TIMESTAMPTZ NULL,
        last_failure_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
      .then(() => undefined)
      .catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

type DbRow = { user_id: number | null; failures: number; lock_level: number; locked_until: Date | null; last_failure_at: Date };
const toRow = (r: DbRow): Row => ({
  userId: r.user_id, failures: Number(r.failures), level: Number(r.lock_level),
  lockedUntil: r.locked_until ? new Date(r.locked_until) : null, lastFailureAt: new Date(r.last_failure_at),
});

/** Postgres store. Read-modify-write inside one transaction with a row lock (FOR UPDATE) so parallel failures count. */
export function pgLockoutStore(): LockoutStore {
  return {
    async check(key, now = new Date()) {
      await ensureLoginLockoutSchema();
      const { rows } = await pool.query<{ locked_until: Date | null }>(`SELECT locked_until FROM login_lockouts WHERE key = $1`, [key]);
      const until = rows[0]?.locked_until;
      return until ? lockedState(new Date(until), now) : { locked: false };
    },
    async fail(key, userId, now = new Date()) {
      await ensureLoginLockoutSchema();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`INSERT INTO login_lockouts (key, user_id, failures, last_failure_at) VALUES ($1, $2, 0, $3) ON CONFLICT (key) DO NOTHING`, [key, userId, now]);
        const { rows } = await client.query<DbRow>(`SELECT user_id, failures, lock_level, locked_until, last_failure_at FROM login_lockouts WHERE key = $1 FOR UPDATE`, [key]);
        // A row inserted just above (failures 0, level 0, last_failure_at = now) behaves exactly like «no history».
        const { row, lock } = applyFailure(rows[0] ? toRow(rows[0]) : undefined, userId, now);
        await client.query(
          `UPDATE login_lockouts SET user_id = $2, failures = $3, lock_level = $4, locked_until = $5, last_failure_at = $6 WHERE key = $1`,
          [key, row.userId, row.failures, row.level, row.lockedUntil, row.lastFailureAt],
        );
        // Unknown-name rows are only useful while they can still lock: prune the stale ones.
        if (lock) await client.query(`DELETE FROM login_lockouts WHERE key LIKE 'n:%' AND last_failure_at < $1`, [new Date(now.getTime() - 2 * LOCK_MAX_MIN * 60_000)]);
        await client.query("COMMIT");
        if (!lock) return { locked: false, failures: row.failures };
        const st = lockedState(row.lockedUntil!, now) as Extract<LockState, { locked: true }>;
        return { locked: true, until: st.until, retryAfterSec: st.retryAfterSec, level: lock.level, minutes: lock.minutes };
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async clear(key) {
      await ensureLoginLockoutSchema();
      await pool.query(`DELETE FROM login_lockouts WHERE key = $1`, [key]);
    },
    async clearUser(userId) {
      await ensureLoginLockoutSchema();
      await pool.query(`DELETE FROM login_lockouts WHERE key = $1`, [`u:${userId}`]);
    },
  };
}

let store: LockoutStore = pgLockoutStore();
export function lockoutStore(): LockoutStore { return store; }
/** Tests swap in memoryLockoutStore(). */
export function setLockoutStore(s: LockoutStore): void { store = s; }
