import { pgTable, text, serial, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const dailyQuotesTable = pgTable("daily_quotes", {
  id: serial("id").primaryKey(),
  date: text("date").notNull(),
  tradingRu: text("trading_ru").notNull(),
  tradingUz: text("trading_uz").notNull(),
  tradingUk: text("trading_uk").notNull(),
  tradingEn: text("trading_en"),
  tradingAuthor: text("trading_author"),
  psychologyRu: text("psychology_ru").notNull(),
  psychologyUz: text("psychology_uz").notNull(),
  psychologyUk: text("psychology_uk").notNull(),
  psychologyEn: text("psychology_en"),
  psychologyAuthor: text("psychology_author"),
  source: text("source").notNull().default("ai"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("daily_quotes_date_unique").on(table.date),
]);

export type DailyQuote = typeof dailyQuotesTable.$inferSelect;
