import {
  pgTable,
  text,
  serial,
  timestamp,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const eventsTable = pgTable("market_events", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  date: text("date").notNull(),
  eventType: text("event_type").notNull(),
  headline: text("headline").notNull(),
  reaction: text("reaction"),
  percentMove: numeric("percent_move", { precision: 8, scale: 2 }),
  volume: text("volume"),
  summary: text("summary"),
  screenshotUrl: text("screenshot_url"),
  screenshotNotes: text("screenshot_notes"),
  tags: text("tags"),
  marketCap: text("market_cap"),
  float: text("float"),
  adv: text("adv"),
  atr: numeric("atr", { precision: 12, scale: 4 }),
  relativeVolume: numeric("relative_volume", { precision: 8, scale: 2 }),
  beta: numeric("beta", { precision: 8, scale: 4 }),
  shortInterest: numeric("short_interest", { precision: 8, scale: 4 }),
  sector: text("sector"),
  longName: text("long_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  index("events_ticker_idx").on(table.ticker),
  index("events_date_idx").on(table.date),
  index("events_created_at_idx").on(table.createdAt),
]);

export const insertEventSchema = createInsertSchema(eventsTable).omit({
  id: true,
  createdAt: true,
  deletedAt: true,
});
export type InsertEvent = z.infer<typeof insertEventSchema>;
export type MarketEvent = typeof eventsTable.$inferSelect;
