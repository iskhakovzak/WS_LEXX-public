/**
 * DB-side helpers for event producers: background execution (a notification never blocks or breaks the main
 * operation), atomic "send once" claims, and staff recipient fallback. Pure text/recipient logic lives in
 * lib/notifyEventsCore.ts. Writes only through lib/notifyUtils (insertNotification honours user prefs).
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { assignedStaffOf } from "./notifyUtils";

/**
 * Run a notification side-effect after the current request finished its critical path. Never throws,
 * never delays the response; failures are logged with `label`.
 */
export function inBackground(label: string, fn: () => Promise<unknown>): void {
  setImmediate(() => {
    Promise.resolve()
      .then(fn)
      .catch((err) => logger.warn({ err, label }, "notification side-effect failed"));
  });
}

// ─── once-only claims (dedup) ───────────────────────────────────────────────

let dedupReady: Promise<void> | null = null;
function ensureDedupTable(): Promise<void> {
  if (!dedupReady) {
    dedupReady = pool
      .query(
        `CREATE TABLE IF NOT EXISTS notification_dedup (
           key TEXT PRIMARY KEY,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      )
      .then(() => undefined)
      .catch((err) => {
        dedupReady = null;
        throw err;
      });
  }
  return dedupReady;
}

/**
 * Atomically claims `key`: true for the first caller only (across processes / concurrent requests).
 * On a DB error returns false — better to miss one notification than to spam on every poll.
 */
export async function claimOnce(key: string): Promise<boolean> {
  try {
    await ensureDedupTable();
    const { rows } = await pool.query(
      `INSERT INTO notification_dedup (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key.slice(0, 300)],
    );
    return rows.length > 0;
  } catch (err) {
    logger.warn({ err, key }, "notification dedup claim failed");
    return false;
  }
}

// ─── recipients ─────────────────────────────────────────────────────────────

/** Assigned curator / risk manager / mentor of the trader; when none is assigned — every active curator/admin. */
export async function staffOrFallback(trader: string | null | undefined): Promise<string[]> {
  const assigned = await assignedStaffOf(trader);
  if (assigned.length) return assigned;
  try {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM users WHERE active = true AND role IN ('curator', 'admin') AND COALESCE(banned, false) = false`,
    );
    return rows.map((r) => r.name).filter((n) => n && n !== trader);
  } catch {
    return [];
  }
}

