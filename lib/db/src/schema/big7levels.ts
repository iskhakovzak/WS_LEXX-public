import { pgTable, text, serial, timestamp, numeric, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const big7LevelsTable = pgTable("big7_levels", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  label: text("label").notNull(),
  price: numeric("price", { precision: 12, scale: 4 }).notNull(),
  notes: text("notes"),
  /** Member who created the row (owner-or-staff edit rule). NULL = legacy/seeded → staff-only. */
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("big7_levels_ticker_idx").on(table.ticker),
  index("big7_levels_created_at_idx").on(table.createdAt),
]);

export const insertBig7LevelSchema = createInsertSchema(big7LevelsTable).omit({ id: true, createdAt: true, createdBy: true });
export type InsertBig7Level = z.infer<typeof insertBig7LevelSchema>;
export type Big7Level = typeof big7LevelsTable.$inferSelect;
