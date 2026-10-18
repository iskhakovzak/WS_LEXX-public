import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * Activity feed row. `entityTitle` is the entity's own name (user content: ticker, playbook name, topic) — never a
 * translated phrase. When the title or details are generated text, also pass `params` (text as data,
 * ARCHITECTURE.md §0.5): `{ titleKey, …values }` lets the UI render it in the reader's language; entityTitle/details
 * stay as the Russian fallback for older clients.
 */
export async function logActivity(params: {
  action: string;
  section: string;
  entityId?: string;
  entityTitle?: string;
  trader?: string;
  details?: string;
  params?: Record<string, string | number | boolean | null>;
}) {
  try {
    await pool.query(
      `INSERT INTO activity_log (action, section, entity_id, entity_title, trader, details, params) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [params.action, params.section, params.entityId ?? null, params.entityTitle ?? null, params.trader ?? null, params.details ?? null,
        params.params ? JSON.stringify(params.params) : null],
    );
  } catch (e: any) {
    logger.warn({ error: e.message }, "Failed to log activity");
  }
}
