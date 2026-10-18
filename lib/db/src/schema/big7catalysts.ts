import { pgTable, text, serial, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const big7CatalystsTable = pgTable("big7_catalysts", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  date: text("date").notNull(),
  type: text("type").notNull(),
  description: text("description"),
  impact: text("impact").notNull().default("medium"),
  /** Member who created the row (owner-or-staff edit rule). NULL = legacy/seeded → staff-only. */
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("big7_catalysts_ticker_idx").on(table.ticker),
  index("big7_catalysts_date_idx").on(table.date),
]);

export const insertBig7CatalystSchema = createInsertSchema(big7CatalystsTable).omit({ id: true, createdAt: true, createdBy: true });
export type InsertBig7Catalyst = z.infer<typeof insertBig7CatalystSchema>;
export type Big7Catalyst = typeof big7CatalystsTable.$inferSelect;
