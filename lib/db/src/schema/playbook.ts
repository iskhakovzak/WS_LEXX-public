import { pgTable, text, serial, timestamp, integer, jsonb, boolean, index, primaryKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const playbookTable = pgTable("playbook", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  folder: text("folder"),
  setupType: text("setup_type"),
  conditions: text("conditions"),
  checklist: text("checklist"),
  checklistItems: jsonb("checklist_items"),
  notes: text("notes"),
  confidenceLevel: integer("confidence_level"),
  screenshotUrl: text("screenshot_url"),
  screenshotNotes: text("screenshot_notes"),
  screenshots: jsonb("screenshots"),
  tags: text("tags"),
  sourceType: text("source_type"),
  sourceId: integer("source_id"),
  trader: text("trader"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  index("playbook_created_at_idx").on(table.createdAt),
  index("playbook_folder_idx").on(table.folder),
  index("playbook_trader_idx").on(table.trader),
]);

export const insertPlaybookSchema = createInsertSchema(playbookTable).omit({ id: true, createdAt: true, deletedAt: true });
export type InsertPlaybook = z.infer<typeof insertPlaybookSchema>;
export type PlaybookEntry = typeof playbookTable.$inferSelect;

export const playbookChecklistMarksTable = pgTable("playbook_checklist_marks", {
  playbookId: integer("playbook_id").notNull(),
  itemId: text("item_id").notNull(),
  scope: text("scope").notNull(),
  trader: text("trader").notNull().default(""),
  done: boolean("done").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.playbookId, t.itemId, t.scope, t.trader] }),
  index("playbook_checklist_marks_playbook_idx").on(t.playbookId),
]);

export type PlaybookChecklistMark = typeof playbookChecklistMarksTable.$inferSelect;
