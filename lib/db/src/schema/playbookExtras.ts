import { pgTable, text, serial, timestamp, integer, numeric, jsonb, index } from "drizzle-orm/pg-core";

export const playbookChecklistRunsTable = pgTable("playbook_checklist_runs", {
  id: serial("id").primaryKey(),
  playbookId: integer("playbook_id").notNull(),
  tradeId: integer("trade_id"),
  trader: text("trader"),
  checkedItems: jsonb("checked_items").notNull(),
  score: numeric("score", { precision: 5, scale: 2 }).notNull(),
  total: integer("total").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("playbook_checklist_runs_playbook_idx").on(t.playbookId),
  index("playbook_checklist_runs_trade_idx").on(t.tradeId),
]);

export const playbookRevisionsTable = pgTable("playbook_revisions", {
  id: serial("id").primaryKey(),
  playbookId: integer("playbook_id").notNull(),
  trader: text("trader"),
  snapshot: jsonb("snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("playbook_revisions_playbook_idx").on(t.playbookId),
]);

export type PlaybookChecklistRun = typeof playbookChecklistRunsTable.$inferSelect;
export type PlaybookRevision = typeof playbookRevisionsTable.$inferSelect;
