import { db, auditLogTable } from "@workspace/db";
import { logger } from "./logger";

export interface AuditEntry {
  actor: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  details?: unknown;
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogTable).values({
      actor: entry.actor,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      details: entry.details === undefined ? null : JSON.stringify(entry.details),
    });
  } catch (e: any) {
    logger.warn({ err: e?.message, entry }, "audit log write failed");
  }
}
