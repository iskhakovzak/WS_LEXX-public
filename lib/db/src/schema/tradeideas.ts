import { pgTable, text, serial, timestamp, integer, numeric, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradeIdeasTable = pgTable("trade_ideas", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  side: text("side"),
  setup: text("setup"),
  entryZone: text("entry_zone"),
  target: text("target"),
  stop: text("stop"),
  thesis: text("thesis"),
  score: integer("score"),
  scoreBreakdown: text("score_breakdown"),
  status: text("status").notNull().default("draft"),
  trader: text("trader"),
  playbookId: integer("playbook_id"),
  watchlistId: integer("watchlist_id"),
  screenshotUrl: text("screenshot_url"),
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
  notes: text("notes"),
  ideaDate: text("idea_date"),
  riskAmount: numeric("risk_amount", { precision: 12, scale: 2 }),
  setupQuality: text("setup_quality"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  convertedTradeId: integer("converted_trade_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  index("trade_ideas_status_idx").on(t.status),
  index("trade_ideas_ticker_idx").on(t.ticker),
  index("trade_ideas_trader_idx").on(t.trader),
  index("trade_ideas_created_at_idx").on(t.createdAt),
]);

export const tradeIdeaReactionsTable = pgTable("trade_idea_reactions", {
  id: serial("id").primaryKey(),
  tradeIdeaId: integer("trade_idea_id").notNull(),
  trader: text("trader").notNull(),
  reaction: text("reaction").notNull(),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("trade_idea_reactions_idea_idx").on(t.tradeIdeaId),
  index("trade_idea_reactions_trader_idx").on(t.trader),
]);

export const insertTradeIdeaSchema = createInsertSchema(tradeIdeasTable).omit({ id: true, createdAt: true, deletedAt: true, publishedAt: true });
export type InsertTradeIdea = z.infer<typeof insertTradeIdeaSchema>;
export type TradeIdea = typeof tradeIdeasTable.$inferSelect;

export const insertTradeIdeaReactionSchema = createInsertSchema(tradeIdeaReactionsTable).omit({ id: true, createdAt: true });
export type InsertTradeIdeaReaction = z.infer<typeof insertTradeIdeaReactionSchema>;
export type TradeIdeaReaction = typeof tradeIdeaReactionsTable.$inferSelect;
