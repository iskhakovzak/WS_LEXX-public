import { pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";
import { tradesTable } from "./trades";

export const activityLogTable = pgTable("activity_log", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(),
  section: text("section").notNull(),
  entityId: text("entity_id"),
  entityTitle: text("entity_title"),
  trader: text("trader"),
  details: text("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("activity_log_trader_idx").on(table.trader),
  index("activity_log_created_at_idx").on(table.createdAt),
]);

export type ActivityLog = typeof activityLogTable.$inferSelect;

export const tradeReactionsTable = pgTable("trade_reactions", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id").notNull().references(() => tradesTable.id),
  trader: text("trader").notNull(),
  reactionType: text("reaction_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("trade_reactions_trade_id_idx").on(table.tradeId),
  index("trade_reactions_created_at_idx").on(table.createdAt),
]);

export type TradeReaction = typeof tradeReactionsTable.$inferSelect;

export const tradeReviewsTable = pgTable("trade_reviews", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id").notNull().references(() => tradesTable.id),
  curator: text("curator").notNull(),
  comment: text("comment").notNull(),
  rating: text("rating"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("trade_reviews_trade_id_idx").on(table.tradeId),
  index("trade_reviews_created_at_idx").on(table.createdAt),
]);

export type TradeReview = typeof tradeReviewsTable.$inferSelect;
