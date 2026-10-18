import { pgTable, text, serial, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const dailyFeedTable = pgTable("daily_feed", {
  id: serial("id").primaryKey(),
  date: text("date").notNull(),
  whatWorksNow: text("what_works_now"),
  whatDoesntWork: text("what_doesnt_work"),
  bestTickers: text("best_tickers"),
  marketTheme: text("market_theme"),
  notes: text("notes"),
  tags: text("tags"),
  screenshotUrl: text("screenshot_url"),
  screenshotNotes: text("screenshot_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  index("daily_feed_date_idx").on(table.date),
  index("daily_feed_created_at_idx").on(table.createdAt),
]);

export const insertDailyFeedSchema = createInsertSchema(dailyFeedTable).omit({
  id: true,
  createdAt: true,
  deletedAt: true,
});
export type InsertDailyFeed = z.infer<typeof insertDailyFeedSchema>;
export type DailyFeed = typeof dailyFeedTable.$inferSelect;
