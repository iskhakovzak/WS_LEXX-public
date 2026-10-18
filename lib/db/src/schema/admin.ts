import { pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";

export const auditLogTable = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  details: text("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("audit_log_actor_idx").on(t.actor),
  index("audit_log_action_idx").on(t.action),
  index("audit_log_created_at_idx").on(t.createdAt),
]);

export type AuditLogEntry = typeof auditLogTable.$inferSelect;

export const contentReportsTable = pgTable("content_reports", {
  id: serial("id").primaryKey(),
  reporter: text("reporter").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("open"),
  resolvedBy: text("resolved_by"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolution: text("resolution"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("content_reports_status_idx").on(t.status),
  index("content_reports_target_idx").on(t.targetType, t.targetId),
  index("content_reports_created_at_idx").on(t.createdAt),
]);

export type ContentReport = typeof contentReportsTable.$inferSelect;
