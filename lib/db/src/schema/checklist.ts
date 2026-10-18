import { pgTable, text, serial, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const preTradeChecklistTemplateTable = pgTable("pre_trade_checklist_template", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  description: text("description"),
  required: boolean("required").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("checklist_template_active_idx").on(t.active),
  index("checklist_template_sort_idx").on(t.sortOrder),
]);

export const preTradeChecklistResponsesTable = pgTable("pre_trade_checklist_responses", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  tradeDate: text("trade_date").notNull(),
  trader: text("trader"),
  tradeId: integer("trade_id"),
  responses: text("responses").notNull(),
  passed: boolean("passed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("checklist_responses_ticker_idx").on(t.ticker),
  index("checklist_responses_trade_id_idx").on(t.tradeId),
  index("checklist_responses_trader_date_idx").on(t.trader, t.tradeDate),
]);

export const insertChecklistTemplateSchema = createInsertSchema(preTradeChecklistTemplateTable).omit({ id: true, createdAt: true });
export type InsertChecklistTemplate = z.infer<typeof insertChecklistTemplateSchema>;
export type ChecklistTemplateItem = typeof preTradeChecklistTemplateTable.$inferSelect;

export const insertChecklistResponseSchema = createInsertSchema(preTradeChecklistResponsesTable).omit({ id: true, createdAt: true });
export type InsertChecklistResponse = z.infer<typeof insertChecklistResponseSchema>;
export type ChecklistResponse = typeof preTradeChecklistResponsesTable.$inferSelect;
