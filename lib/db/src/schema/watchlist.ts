import { pgTable, text, serial, timestamp, numeric, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const watchlistTable = pgTable("watchlist", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  catalyst: text("catalyst"),
  targetPrice: numeric("target_price", { precision: 12, scale: 4 }),
  stopPrice: numeric("stop_price", { precision: 12, scale: 4 }),
  status: text("status").notNull().default("watching"),
  notes: text("notes"),
  sector: text("sector"),
  screenshotUrl: text("screenshot_url"),
  tags: text("tags"),
  score: integer("score"),
  scoreBreakdown: text("score_breakdown"),
  scoredAt: timestamp("scored_at", { withTimezone: true }),
  marketCap: text("market_cap"),
  float: text("float"),
  adv: text("adv"),
  atr: numeric("atr", { precision: 12, scale: 4 }),
  relativeVolume: numeric("relative_volume", { precision: 8, scale: 2 }),
  beta: numeric("beta", { precision: 8, scale: 4 }),
  shortInterest: numeric("short_interest", { precision: 8, scale: 4 }),
  longName: text("long_name"),
  /** Member who created the row (owner-or-staff edit rule). NULL = legacy/seeded → staff-only. */
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  index("watchlist_ticker_idx").on(table.ticker),
  index("watchlist_created_at_idx").on(table.createdAt),
  index("watchlist_score_idx").on(table.score),
]);

export const insertWatchlistSchema = createInsertSchema(watchlistTable).omit({ id: true, createdAt: true, deletedAt: true, createdBy: true });
export type InsertWatchlist = z.infer<typeof insertWatchlistSchema>;
export type WatchlistItem = typeof watchlistTable.$inferSelect;
